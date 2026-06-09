import 'server-only';
import { getOutboundWebhookConfig, isSafeWebhookUrl, type OutboundEventType } from '@/lib/auth/settings-store';
import { DEMO_MODE } from '@/lib/db/demo';

// lib/integrations/outbound.ts — best-effort outbound notifications. Fires a generic JSON webhook
// and/or a Slack incoming webhook when an admin has configured them and enabled the event type.
//
// Call it FIRE-AND-FORGET from a write path (`void dispatchOutbound(...)`): it never throws, never
// blocks the caller's response, and no-ops in demo mode / when nothing is configured. The app runs as
// a long-lived Node server, so the POST completes after the response is sent.

export interface OutboundEvent {
  type: OutboundEventType;
  /** A one-line human summary (used as the Slack message + the webhook `summary`). */
  summary: string;
  data: Record<string, unknown>;
}

const TIMEOUT_MS = 5000;

export async function dispatchOutbound(event: OutboundEvent): Promise<void> {
  if (DEMO_MODE) return;
  try {
    const cfg = await getOutboundWebhookConfig();
    if (!cfg.enabledEvents.includes(event.type)) return;
    if (!cfg.webhookUrl && !cfg.slackWebhookUrl) return;

    const post = (url: string, body: unknown) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      }).catch(() => undefined);

    const jobs: Promise<unknown>[] = [];
    // Re-check at fire time (defence in depth vs a directly-injected DB value bypassing the save guard).
    if (cfg.webhookUrl && isSafeWebhookUrl(cfg.webhookUrl)) {
      jobs.push(post(cfg.webhookUrl, { event: event.type, ts: Date.now(), summary: event.summary, data: event.data }));
    }
    if (cfg.slackWebhookUrl && isSafeWebhookUrl(cfg.slackWebhookUrl)) {
      jobs.push(post(cfg.slackWebhookUrl, { text: `*Event Tracker* · ${event.summary}` }));
    }
    await Promise.allSettled(jobs);
  } catch {
    // best-effort: an outbound failure must never affect the caller
  }
}
