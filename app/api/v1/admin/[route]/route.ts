import { type NextRequest } from 'next/server';
import { withKey, apiErr, requireCap, auditKeyWrite } from '@/lib/api/api-v1';
import { runAsKeyOwner } from '@/lib/auth/session';
import * as accessPolicy from '@/app/api/auth/access-policy/route';
import * as branding from '@/app/api/auth/branding/route';
import * as integrationKeys from '@/app/api/auth/integration-keys/route';
import * as oidcProviders from '@/app/api/auth/oidc-providers/route';
import * as outboundWebhooks from '@/app/api/auth/outbound-webhooks/route';
import * as perms from '@/app/api/auth/perms/route';
import * as tenant from '@/app/api/auth/tenant/route';

export const dynamic = 'force-dynamic';

// /api/v1/admin/:route — the admin config surfaces (Config > …) for a full-access key (api.fullaccess).
// GET and POST forward to the same /api/auth/<route> handler the UI uses, running as the key's owner,
// so the handler's own live-admin check applies.
//
// Only these config routes are forwarded. API keys, passwords, passkeys, 2FA, recovery codes and
// sign-in identities have no key path on purpose.

const ROUTES: Record<string, { GET: () => Promise<Response>; POST: (req: NextRequest) => Promise<Response> }> = {
  'access-policy': accessPolicy,
  branding,
  'integration-keys': integrationKeys,
  'oidc-providers': oidcProviders,
  'outbound-webhooks': outboundWebhooks,
  perms,
  tenant,
};

async function forward(req: NextRequest, ctx: { params: Promise<{ route: string }> }, method: 'GET' | 'POST') {
  return withKey(req, async (vk) => {
    requireCap(vk, 'api.fullaccess');
    const { route } = await ctx.params;
    const h = Object.prototype.hasOwnProperty.call(ROUTES, route) ? ROUTES[route] : null;
    if (!h) return apiErr(404, `unknown admin route '${route}' (one of: ${Object.keys(ROUTES).join(', ')})`);
    const owner = { email: vk.ownerEmail, role: vk.role, keyId: vk.keyId };
    const res = await runAsKeyOwner(owner, () => (method === 'GET' ? h.GET() : h.POST(req)));
    if (method === 'POST') await auditKeyWrite(vk, req, `api.admin.${route}`, null, res.ok ? 'ok' : `http ${res.status}`);
    return res as ReturnType<typeof apiErr>;
  });
}

export function GET(req: NextRequest, ctx: { params: Promise<{ route: string }> }) {
  return forward(req, ctx, 'GET');
}

export function POST(req: NextRequest, ctx: { params: Promise<{ route: string }> }) {
  return forward(req, ctx, 'POST');
}
