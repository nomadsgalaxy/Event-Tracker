import { NextResponse, type NextRequest } from 'next/server';
import { verifyFlow, OAUTH_FLOW_COOKIE, publicOrigin, signInWithOidc } from '@/lib/auth/oidc';
import { getProviderConfigs, getProviderSecret } from '@/lib/auth/settings-store';
import { fetchDiscovery, exchangeOidcCode, exchangeGithubCode } from '@/lib/auth/oidc-providers';
import { issueSessionToken, COOKIE_NAME, SSO_COOKIE_OPTS } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

function safeNext(n: string | null | undefined): string {
  if (typeof n !== 'string' || !n.startsWith('/') || n.startsWith('//') || n.startsWith('/\\')) return '/';
  if (n === '/login' || n.startsWith('/login/')) return '/';
  return n;
}

// GET /api/auth/oidc/[provider]/callback — finish the dance for a configured provider. Verifies the
// signed flow cookie (state match + the cookie's providerId MUST equal this route's provider, so a
// cookie can't be replayed across providers), exchanges the code (OIDC: id_token verified incl. nonce;
// GitHub: token + verified-primary-email), runs the shared signInWithOidc binding, mints the session.
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const origin = publicOrigin(req);
  const fail = (reason: string) => {
    const r = NextResponse.redirect(new URL(`/login?sso=${encodeURIComponent(reason)}`, origin));
    r.cookies.delete(OAUTH_FLOW_COOKIE);
    return r;
  };

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerErr = url.searchParams.get('error');
  const flow = verifyFlow(req.cookies.get(OAUTH_FLOW_COOKIE)?.value);

  if (providerErr) return fail('cancelled');
  // The flow cookie must verify, match state, AND belong to THIS provider (no cross-provider replay).
  if (!flow || flow.providerId !== provider) return fail('state');
  if (!code || !state || state !== flow.state) return fail('state');

  const cfg = (await getProviderConfigs()).find((p) => p.id === provider && p.enabled);
  if (!cfg || !cfg.clientId) return fail('unconfigured');
  const secret = await getProviderSecret(cfg.id);
  if (!secret) return fail('unconfigured');

  const redirectUri = `${origin}/api/auth/oidc/${cfg.id}/callback`;

  let profile;
  try {
    if (cfg.type === 'github') {
      profile = await exchangeGithubCode(code, redirectUri, cfg.clientId, secret);
    } else {
      if (!cfg.discoveryUrl) return fail('unconfigured');
      const discovery = await fetchDiscovery(cfg.discoveryUrl);
      profile = await exchangeOidcCode(code, redirectUri, discovery, cfg.clientId, secret, flow.nonce, flow.verifier);
    }
  } catch {
    return fail('exchange');
  }

  const result = await signInWithOidc(profile, cfg.id);
  if (!result.ok) return fail(result.reason);

  const src = cfg.type === 'github' ? 'github' : `oidc:${cfg.id}`;
  const { token } = issueSessionToken(result.email, result.role, src);
  const res = NextResponse.redirect(new URL(safeNext(flow.next), origin));
  res.cookies.set(COOKIE_NAME, token, SSO_COOKIE_OPTS);
  res.cookies.delete(OAUTH_FLOW_COOKIE);
  return res;
}
