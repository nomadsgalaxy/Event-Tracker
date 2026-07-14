import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, auditKeyWrite } from '@/lib/api/api-v1';
import { rankOf } from '@/lib/auth/rbac';
import { getWebhookSubscriptions } from '@/lib/auth/settings-store';
import { testWebhookSubscription } from '@/lib/integrations/outbound';

// POST /api/v1/webhooks/:id/test — fire a test delivery ({event:'test', data:{test:true}}) at the
// subscription and report the receiver's HTTP status. Own webhooks only — an admin-owned key can
// test anyone's (read scope is enough — a test ping mutates nothing but the delivery stamp).
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    if (rankOf(vk.role) < rankOf('authorized')) return apiErr(403, 'Webhook management requires an authorized-or-higher key owner.');
    const sub = (await getWebhookSubscriptions({ fresh: true })).find((s) => s.id === id);
    if (!sub || (rankOf(vk.role) < rankOf('admin') && sub.createdBy !== vk.ownerEmail.toLowerCase())) {
      return apiErr(404, 'No such subscription.');
    }
    const status = await testWebhookSubscription(sub);
    await auditKeyWrite(vk, req, 'api.webhook.test', `webhooks/${id}`, status > 0 && status < 400 ? 'ok' : `status ${status}`);
    return apiOk({ id, delivered: status > 0 && status < 400, receiverStatus: status });
  });
}
