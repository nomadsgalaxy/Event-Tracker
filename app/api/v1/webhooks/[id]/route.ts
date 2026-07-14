import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, requireScope, readBody, auditKeyWrite } from '@/lib/api/api-v1';
import { rankOf } from '@/lib/auth/rbac';
import { removeWebhookSubscription, updateWebhookSubscription, type WebhookSubscription } from '@/lib/auth/settings-store';
import type { VerifiedKey } from '@/lib/api/api-keys';

// PATCH/POST /api/v1/webhooks/:id — edit a subscription in place (unlike API keys, webhooks are
// editable: url/events/method/secret/description/active). DELETE — remove it. Write-scoped key,
// own webhooks only — an admin-owned key can touch anyone's (see ../route.ts).
export const dynamic = 'force-dynamic';

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

function gate(vk: VerifiedKey): string | null {
  if (rankOf(vk.role) < rankOf('authorized')) return 'Webhook management requires an authorized-or-higher key owner.';
  return null;
}
function ownerFilter(vk: VerifiedKey): string | undefined {
  return rankOf(vk.role) >= rankOf('admin') ? undefined : vk.ownerEmail.toLowerCase();
}

async function update(req: NextRequest, id: string) {
  return withKey(req, async (vk) => {
    const err = gate(vk);
    if (err) return apiErr(403, err);
    requireScope(vk, 'db.write.app');
    const body = await readBody(req);
    const res = await updateWebhookSubscription(id, {
      url: typeof body.url === 'string' ? body.url : undefined,
      events: Array.isArray(body.events) ? body.events.map((e) => String(e)) : undefined,
      method: typeof body.method === 'string' ? body.method : undefined,
      secret: typeof body.secret === 'string' ? body.secret : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      active: typeof body.active === 'boolean' ? body.active : undefined,
    }, { owner: ownerFilter(vk) });
    if (!res.ok || !res.sub) return apiErr(res.error === 'No such subscription.' ? 404 : 400, res.error || 'Update failed.');
    await auditKeyWrite(vk, req, 'api.webhook.update', `webhooks/${id}`, 'ok', { events: res.sub.events, method: res.sub.method, active: res.sub.active });
    return apiOk({ webhook: publicSub(res.sub) });
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return update(req, id);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return update(req, id);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    const err = gate(vk);
    if (err) return apiErr(403, err);
    requireScope(vk, 'db.write.app');
    const res = await removeWebhookSubscription(id, { owner: ownerFilter(vk) });
    if (!res.ok) return apiErr(res.error === 'No such subscription.' ? 404 : 400, res.error || 'Delete failed.');
    await auditKeyWrite(vk, req, 'api.webhook.delete', `webhooks/${id}`, 'ok');
    return apiOk({ deleted: id });
  });
}
