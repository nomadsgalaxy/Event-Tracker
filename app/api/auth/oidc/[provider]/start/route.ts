import { NextResponse, type NextRequest } from 'next/server';
import { newFlow, signFlow, OAUTH_FLOW_COOKIE, publicOrigin } from '@/lib/auth/oidc';
import { getProviderConfigs } from '@/lib/auth/settings-store';
import { fetchDiscovery, buildGithubAuthUrl, buildOidcAuthUrl } from '@/lib/auth/oidc-providers';

export const dynamic = 'force-dynamic';

function safeNext(n: string | null | undefined): string {
  if (typeof n !== 'string' || !n.startsWith('/') || n.startsWith('//') || n.startsWith('/\\')) return '/';
  if (n === '/login' || n.startsWith('/login/')) return '/';
  return n;
}

// GET /api/auth/oidc/[provider]/start — begin the OAuth dance for an admin-configured provider. Mints
// a flow (state + nonce + PKCE) tagged with the provider id in ONE signed HttpOnly cookie, then
// redirects to the IdP. OIDC providers use discovery + PKCE + nonce; GitHub uses state-only (no PKCE).
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const origin = publicOrigin(req);
  const cfg = (await getProviderConfigs()).find((p) => p.id === provider && p.enabled);
  if (!cfg || !cfg.clientId) return NextResponse.redirect(new URL('/login?sso=unconfigured', origin));

  const url = new URL(req.url);
  const redirectUri = `${origin}/api/auth/oidc/${cfg.id}/callback`;
  const { flow, challenge } = newFlow(safeNext(url.searchParams.get('next')), cfg.id);

  let authUrl: string;
  try {
    if (cfg.type === 'github') {
      authUrl = buildGithubAuthUrl(cfg.clientId, redirectUri, flow.state, cfg.scopes || 'read:user user:email');
    } else {
      if (!cfg.discoveryUrl) return NextResponse.redirect(new URL('/login?sso=unconfigured', origin));
      const discovery = await fetchDiscovery(cfg.discoveryUrl);
      authUrl = buildOidcAuthUrl(discovery, cfg.clientId, redirectUri, flow.state, flow.nonce, challenge, cfg.scopes || 'openid email profile');
    }
  } catch {
    return NextResponse.redirect(new URL('/login?sso=unconfigured', origin));
  }

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(OAUTH_FLOW_COOKIE, signFlow(flow), { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 600 });
  return res;
}
