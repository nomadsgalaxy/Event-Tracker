import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, requireScope, readBody, auditKeyWrite } from '@/lib/api/api-v1';
import { rankOf } from '@/lib/auth/rbac';
import {
  getWebhookSubscriptions,
  addWebhookSubscription,
  OUTBOUND_EVENT_TYPES,
  type WebhookSubscription,
} from '@/lib/auth/settings-store';
import type { VerifiedKey } from '@/lib/api/api-keys';

// /api/v1/webhooks — API-managed outbound webhook subscriptions ("Push and Get").
//
// GET  — list subscriptions (secrets are reported as set/unset only, never echoed).
// POST — create: { url, events[], method?: 'POST'|'GET', secret?, description? }.
//         POST deliveries: JSON {id,event,ts,summary,data} + X-EIT-Signature sha256 HMAC when a
//         secret is set. GET deliveries: ?event&ts&summary&payload(+sig) for simple receivers.
//
// GATE: the key OWNER must be an ADMIN (live role — instance-wide notification config is
// admin-plane, like the Config → Admin card) and the key must carry a write scope. There's no
// self-service here on purpose: a webhook receives events about the whole workspace.
export const dynamic = 'force-dynamic';

function requireAdmin(vk: VerifiedKey): string | null {
  if (rankOf(vk.role) < rankOf('admin')) return 'Webhook management requires an admin-owned key.';
  return null;
}

function publicSub(s: WebhookSubscription): Record<string, unknown> {
  return {
    id: s.id,
    url: s.url,
    method: s.method,
    events: s.events,
    hasSecret: !!s.secret,
    description: s.description,
    active: s.active,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    lastFiredAt: s.lastFiredAt ?? null,
    lastStatus: s.lastStatus ?? null,
  };
}

export async function GET(req: NextRequest) {
  return withKey(req, async (vk) => {
    const err = requireAdmin(vk);
    if (err) return apiErr(403, err);
    const subs = await getWebhookSubscriptions({ fresh: true });
    return apiOk({ webhooks: subs.map(publicSub), eventTypes: OUTBOUND_EVENT_TYPES });
  });
}

export async function POST(req: NextRequest) {
  return withKey(req, async (vk) => {
    const err = requireAdmin(vk);
    if (err) return apiErr(403, err);
    requireScope(vk, 'db.write.app');
    const body = await readBody(req);
    const res = await addWebhookSubscription({
      url: String(body.url ?? ''),
      events: Array.isArray(body.events) ? body.events.map((e) => String(e)) : [],
      method: typeof body.method === 'string' ? body.method : undefined,
      secret: typeof body.secret === 'string' ? body.secret : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      actorEmail: vk.ownerEmail,
    });
    if (!res.ok || !res.sub) return apiErr(400, res.error || 'Could not create the subscription.');
    await auditKeyWrite(vk, req, 'api.webhook.create', `webhooks/${res.sub.id}`, 'ok', { url: res.sub.url, events: res.sub.events, method: res.sub.method });
    return apiOk({ webhook: publicSub(res.sub) }, 201);
  });
}
