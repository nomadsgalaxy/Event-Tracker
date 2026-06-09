import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveLiveRole } from '@/lib/auth/auth';
import { rankOf } from '@/lib/auth/rbac';
import {
  getOutboundWebhookConfig,
  saveOutboundWebhookConfig,
  OUTBOUND_EVENT_TYPES,
  type OutboundWebhookConfig,
} from '@/lib/auth/settings-store';
import { writeAudit } from '@/lib/db/data';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// /api/auth/outbound-webhooks — Config > Admin "Outbound notifications". Admin-gated (role re-resolved
// live). Non-secret URLs; saving is audited. The dispatcher (lib/integrations/outbound) reads the same
// config and fans out best-effort on enabled events.

export async function GET() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  if (rankOf(await resolveLiveRole(sess.sub)) < rankOf('admin')) return jsonErr(403, 'admin session required');
  return jsonOk({ ...(await getOutboundWebhookConfig({ fresh: true })), eventTypes: OUTBOUND_EVENT_TYPES });
}

interface Body {
  stepupToken?: string;
  webhookUrl?: string;
  slackWebhookUrl?: string;
  enabledEvents?: string[];
}

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  if (rankOf(await resolveLiveRole(sess.sub)) < rankOf('admin')) return jsonErr(403, 'admin session required');

  const body = (await readJson(req)) as Body;
  const input: OutboundWebhookConfig = {
    webhookUrl: String(body.webhookUrl ?? ''),
    slackWebhookUrl: String(body.slackWebhookUrl ?? ''),
    enabledEvents: Array.isArray(body.enabledEvents) ? body.enabledEvents.map(String) : [],
  };
  const res = await saveOutboundWebhookConfig(input, sess.sub);
  if (!res.ok) return jsonErr(400, res.error || 'failed to save outbound webhooks');
  await writeAudit({
    actor: sess.sub,
    action: 'config.outbound_webhooks',
    detail: { events: input.enabledEvents.length, webhook: !!input.webhookUrl, slack: !!input.slackWebhookUrl },
  });
  return jsonOk({ ok: true, ...(await getOutboundWebhookConfig({ fresh: true })) });
}
