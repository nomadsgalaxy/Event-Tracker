'use server';

import { requireRole } from '@/lib/auth/auth';
import { rankOf } from '@/lib/auth/rbac';
import { writeAudit } from '@/lib/db/data';
import {
  addWebhookSubscription,
  updateWebhookSubscription,
  removeWebhookSubscription,
  getWebhookSubscriptions,
  type WebhookSubscription,
} from '@/lib/auth/settings-store';
import { testWebhookSubscription } from '@/lib/integrations/outbound';

// webhook-subscription-actions.ts — server actions behind the webhook cards. Webhooks are PER-USER
// (minted alongside API keys in Account > Security, authorized+): everyone manages their OWN; the
// Config > API oversight card lets an admin see and manage ALL of them. Every mutation lands in the
// audit log. The /api/v1/webhooks routes are the API-side twin — both funnel into the same
// settings-store functions.

export interface WebhookActionResult {
  ok: boolean;
  error?: string;
}

/** The client-safe row — the secret never leaves the server, only a set/unset flag. */
export interface WebhookRow {
  id: string;
  url: string;
  method: 'POST' | 'GET';
  events: string[];
  hasSecret: boolean;
  description: string;
  active: boolean;
  owner: string;
  lastFiredAt: number | null;
  lastStatus: number | null;
}

function toRow(s: WebhookSubscription): WebhookRow {
  return {
    id: s.id,
    url: s.url,
    method: s.method,
    events: s.events,
    hasSecret: !!s.secret,
    description: s.description,
    active: s.active,
    owner: s.createdBy,
    lastFiredAt: s.lastFiredAt ?? null,
    lastStatus: s.lastStatus ?? null,
  };
}

/** authorized+ for self-service; returns the acting user + whether they oversee ALL webhooks. */
async function actor(): Promise<{ email: string; isAdmin: boolean }> {
  const user = await requireRole('authorized');
  return { email: user.email.toLowerCase(), isAdmin: rankOf(user.role) >= rankOf('admin') };
}

export async function listWebhooksAction(
  scope: 'mine' | 'all'
): Promise<WebhookActionResult & { rows?: WebhookRow[] }> {
  try {
    const a = await actor();
    if (scope === 'all' && !a.isAdmin) return { ok: false, error: 'Only an admin can list all webhooks.' };
    const subs = await getWebhookSubscriptions({ fresh: true });
    const rows = (scope === 'all' ? subs : subs.filter((s) => s.createdBy === a.email)).map(toRow);
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not allowed.' };
  }
}

export interface WebhookMintInput {
  url: string;
  events: string[];
  method: string;
  secret: string;
  description: string;
}

export async function mintWebhookAction(input: WebhookMintInput): Promise<WebhookActionResult> {
  let a;
  try {
    a = await actor();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not allowed.' };
  }
  const res = await addWebhookSubscription({
    url: String(input?.url ?? ''),
    events: Array.isArray(input?.events) ? input.events.map(String) : [],
    method: String(input?.method ?? 'POST'),
    secret: String(input?.secret ?? ''),
    description: String(input?.description ?? ''),
    actorEmail: a.email,
  });
  if (!res.ok || !res.sub) return { ok: false, error: res.error || 'Could not create the webhook.' };
  await writeAudit({ actor: a.email, action: 'webhook.create', target: res.sub.id, result: 'ok', detail: { url: res.sub.url, events: res.sub.events, method: res.sub.method } });
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
  let a;
  try {
    a = await actor();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not allowed.' };
  }
  const res = await updateWebhookSubscription(
    String(id ?? ''),
    {
      url: typeof patch?.url === 'string' ? patch.url : undefined,
      events: Array.isArray(patch?.events) ? patch.events.map(String) : undefined,
      method: typeof patch?.method === 'string' ? patch.method : undefined,
      secret: typeof patch?.secret === 'string' ? patch.secret : undefined,
      description: typeof patch?.description === 'string' ? patch.description : undefined,
      active: typeof patch?.active === 'boolean' ? patch.active : undefined,
    },
    { owner: a.isAdmin ? undefined : a.email }
  );
  if (!res.ok) return { ok: false, error: res.error || 'Could not update the webhook.' };
  await writeAudit({ actor: a.email, action: 'webhook.update', target: String(id), result: 'ok', detail: { events: res.sub?.events, method: res.sub?.method, active: res.sub?.active } });
  return { ok: true };
}

export async function deleteWebhookAction(id: string): Promise<WebhookActionResult> {
  let a;
  try {
    a = await actor();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not allowed.' };
  }
  const res = await removeWebhookSubscription(String(id ?? ''), { owner: a.isAdmin ? undefined : a.email });
  if (!res.ok) return { ok: false, error: res.error || 'Could not delete the webhook.' };
  await writeAudit({ actor: a.email, action: 'webhook.delete', target: String(id), result: 'ok' });
  return { ok: true };
}

export async function testWebhookAction(id: string): Promise<WebhookActionResult & { receiverStatus?: number }> {
  let a;
  try {
    a = await actor();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not allowed.' };
  }
  const sub = (await getWebhookSubscriptions({ fresh: true })).find((s) => s.id === String(id ?? ''));
  if (!sub || (!a.isAdmin && sub.createdBy !== a.email)) return { ok: false, error: 'No such webhook.' };
  const status = await testWebhookSubscription(sub);
  return { ok: status > 0 && status < 400, receiverStatus: status, error: status === 0 ? 'The endpoint did not respond.' : undefined };
}
