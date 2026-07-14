import 'server-only';
import { createHmac } from 'node:crypto';
import {
  getOutboundWebhookConfig,
  getWebhookSubscriptions,
  recordWebhookDelivery,
  isSafeWebhookUrl,
  type OutboundEventType,
  type WebhookSubscription,
} from '@/lib/auth/settings-store';
import { DEMO_MODE } from '@/lib/db/demo';

// lib/integrations/outbound.ts — best-effort outbound notifications.
//
// TWO delivery surfaces, both admin-controlled:
//   • the LEGACY Config → Admin pair (one generic JSON webhook + one Slack incoming webhook), and
//   • API-managed SUBSCRIPTIONS (/api/v1/webhooks): multiple endpoints, each with its own event
//     filter, method (POST push / GET ping) and optional HMAC secret.
//
// Call it FIRE-AND-FORGET from a write path (`void dispatchOutbound(...)`): it never throws, never
// blocks the caller's response, and no-ops in demo mode / when nothing is configured. The app runs as
// a long-lived Node server, so deliveries complete after the response is sent.

export interface OutboundEvent {
  type: OutboundEventType;
  /** A one-line human summary (used as the Slack message + the webhook `summary`). */
  summary: string;
  data: Record<string, unknown>;
}

const TIMEOUT_MS = 5000;

/** POST push: JSON body; X-EIT-Signature: sha256=<hex hmac of the exact body> when a secret is set. */
async function deliverPost(sub: WebhookSubscription, body: string): Promise<number> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sub.secret) headers['x-eit-signature'] = 'sha256=' + createHmac('sha256', sub.secret).update(body).digest('hex');
  try {
    const r = await fetch(sub.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
    return r.status;
  } catch {
    return 0;
  }
}

/** GET ping: event/ts/summary/payload as query params (for simple receivers that only take GETs);
 *  sig=<hex hmac of the query string without sig> when a secret is set. Payload capped — GET URLs
 *  have practical length limits, and the receiver can always fetch details via the REST API. */
async function deliverGet(sub: WebhookSubscription, ev: OutboundEvent, ts: number): Promise<number> {
  const u = new URL(sub.url);
  u.searchParams.set('event', ev.type);
  u.searchParams.set('ts', String(ts));
  u.searchParams.set('summary', ev.summary.slice(0, 300));
  u.searchParams.set('payload', JSON.stringify(ev.data).slice(0, 1500));
  if (sub.secret) {
    u.searchParams.set('sig', createHmac('sha256', sub.secret).update(u.searchParams.toString()).digest('hex'));
  }
  try {
    const r = await fetch(u.toString(), { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
    return r.status;
  } catch {
    return 0;
  }
}

export async function dispatchOutbound(event: OutboundEvent): Promise<void> {
  if (DEMO_MODE) return;
  try {
    const ts = Date.now();
    const jobs: Promise<unknown>[] = [];

    // Legacy single-URL config (Config → Admin) — unchanged behavior.
    const cfg = await getOutboundWebhookConfig();
    if (cfg.enabledEvents.includes(event.type)) {
      const post = (url: string, body: unknown) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: 'no-store',
        }).catch(() => undefined);
      // Re-check at fire time (defence in depth vs a directly-injected DB value bypassing the save guard).
      if (cfg.webhookUrl && isSafeWebhookUrl(cfg.webhookUrl)) {
        jobs.push(post(cfg.webhookUrl, { event: event.type, ts, summary: event.summary, data: event.data }));
      }
      if (cfg.slackWebhookUrl && isSafeWebhookUrl(cfg.slackWebhookUrl)) {
        jobs.push(post(cfg.slackWebhookUrl, { text: `*Event Tracker* · ${event.summary}` }));
      }
    }

    // API-managed subscriptions — per-sub event filter, method, and signature.
    const subs = await getWebhookSubscriptions();
    for (const sub of subs) {
      if (!sub.active || !sub.events.includes(event.type)) continue;
      if (!isSafeWebhookUrl(sub.url)) continue; // fire-time re-check, same as legacy
      const job =
        sub.method === 'GET'
          ? deliverGet(sub, event, ts)
          : deliverPost(sub, JSON.stringify({ id: crypto.randomUUID(), event: event.type, ts, summary: event.summary, data: event.data }));
      jobs.push(job.then((status) => recordWebhookDelivery(sub.id, status)));
    }

    await Promise.allSettled(jobs);
  } catch {
    // best-effort: an outbound failure must never affect the caller
  }
}

/** A synchronous test delivery for /api/v1/webhooks/:id/test — returns the receiver's HTTP status. */
export async function testWebhookSubscription(sub: WebhookSubscription): Promise<number> {
  const ev: OutboundEvent = {
    type: 'event_created' as OutboundEventType,
    summary: 'Test delivery from Event Tracker',
    data: { test: true },
  };
  const ts = Date.now();
  const status =
    sub.method === 'GET'
      ? await deliverGet(sub, { ...ev, type: 'test' as OutboundEventType }, ts)
      : await deliverPost(sub, JSON.stringify({ id: crypto.randomUUID(), event: 'test', ts, summary: ev.summary, data: ev.data }));
  void recordWebhookDelivery(sub.id, status);
  return status;
}
