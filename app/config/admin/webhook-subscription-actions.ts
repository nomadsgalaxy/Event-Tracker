'use server';

import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth/auth';
import { writeAudit } from '@/lib/db/data';
import {
  addWebhookSubscription,
  updateWebhookSubscription,
  removeWebhookSubscription,
  getWebhookSubscriptions,
} from '@/lib/auth/settings-store';
import { testWebhookSubscription } from '@/lib/integrations/outbound';

// webhook-subscription-actions.ts — the Config → Admin webhook card's server actions. Admin-only
// (same plane as the legacy outbound card); every mutation lands in the audit log. The /api/v1
// routes are the API-side twin of these — both funnel into the same settings-store functions.

export interface WebhookActionResult {
  ok: boolean;
  error?: string;
}

export interface WebhookMintInput {
  url: string;
  events: string[];
  method: string;
  secret: string;
  description: string;
}

export async function mintWebhookAction(input: WebhookMintInput): Promise<WebhookActionResult> {
  const user = await requireRole('admin');
  const res = await addWebhookSubscription({
    url: String(input?.url ?? ''),
    events: Array.isArray(input?.events) ? input.events.map(String) : [],
    method: String(input?.method ?? 'POST'),
    secret: String(input?.secret ?? ''),
    description: String(input?.description ?? ''),
    actorEmail: user.email,
  });
  if (!res.ok || !res.sub) return { ok: false, error: res.error || 'Could not create the webhook.' };
  await writeAudit({ actor: user.email, action: 'webhook.create', target: res.sub.id, result: 'ok', detail: { url: res.sub.url, events: res.sub.events, method: res.sub.method } });
  revalidatePath('/config/admin');
  return { ok: true };
}

export interface WebhookEditInput {
  url?: string;
  events?: string[];
  method?: string;
  /** undefined = keep the current secret; '' = clear; value = replace. */
  secret?: string;
  description?: string;
  active?: boolean;
}

export async function editWebhookAction(id: string, patch: WebhookEditInput): Promise<WebhookActionResult> {
  const user = await requireRole('admin');
  const res = await updateWebhookSubscription(String(id ?? ''), {
    url: typeof patch?.url === 'string' ? patch.url : undefined,
    events: Array.isArray(patch?.events) ? patch.events.map(String) : undefined,
    method: typeof patch?.method === 'string' ? patch.method : undefined,
    secret: typeof patch?.secret === 'string' ? patch.secret : undefined,
    description: typeof patch?.description === 'string' ? patch.description : undefined,
    active: typeof patch?.active === 'boolean' ? patch.active : undefined,
  });
  if (!res.ok) return { ok: false, error: res.error || 'Could not update the webhook.' };
  await writeAudit({ actor: user.email, action: 'webhook.update', target: String(id), result: 'ok', detail: { events: res.sub?.events, method: res.sub?.method, active: res.sub?.active } });
  revalidatePath('/config/admin');
  return { ok: true };
}

export async function deleteWebhookAction(id: string): Promise<WebhookActionResult> {
  const user = await requireRole('admin');
  const res = await removeWebhookSubscription(String(id ?? ''));
  if (!res.ok) return { ok: false, error: res.error || 'Could not delete the webhook.' };
  await writeAudit({ actor: user.email, action: 'webhook.delete', target: String(id), result: 'ok' });
  revalidatePath('/config/admin');
  return { ok: true };
}

export async function testWebhookAction(id: string): Promise<WebhookActionResult & { receiverStatus?: number }> {
  await requireRole('admin');
  const sub = (await getWebhookSubscriptions({ fresh: true })).find((s) => s.id === String(id ?? ''));
  if (!sub) return { ok: false, error: 'No such webhook.' };
  const status = await testWebhookSubscription(sub);
  return { ok: status > 0 && status < 400, receiverStatus: status, error: status === 0 ? 'The endpoint did not respond.' : undefined };
}
