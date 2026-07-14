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
// GATE: webhooks are PER-USER — any authorized-or-higher key owner manages their OWN (writes need
// a write-scoped key); an ADMIN-owned key sees and manages ALL of them (the Config > API view).
export const dynamic = 'force-dynamic';

function gate(vk: VerifiedKey): string | null {
  if (rankOf(vk.role) < rankOf('authorized')) return 'Webhook management requires an authorized-or-higher key owner.';
  return null;
}
function isAdmin(vk: VerifiedKey): boolean {
  return rankOf(vk.role) >= rankOf('admin');
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
    const err = gate(vk);
    if (err) return apiErr(403, err);
    const all = await getWebhookSubscriptions({ fresh: true });
    const subs = isAdmin(vk) ? all : all.filter((s) => s.createdBy === vk.ownerEmail.toLowerCase());
    return apiOk({ webhooks: subs.map(publicSub), eventTypes: OUTBOUND_EVENT_TYPES });
  });
}

export async function POST(req: NextRequest) {
  return withKey(req, async (vk) => {
    const err = gate(vk);
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
