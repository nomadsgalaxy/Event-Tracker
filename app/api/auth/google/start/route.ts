import { NextResponse, type NextRequest } from 'next/server';
import { buildGoogleAuthUrl, googleConfigured, newFlow, signFlow, OAUTH_FLOW_COOKIE, publicOrigin } from '@/lib/auth/oidc';

export const dynamic = 'force-dynamic';

// Same-origin, absolute-path redirect targets only (no open redirect / protocol-relative).
function safeNext(n: string | null | undefined): string {
  if (typeof n !== 'string' || !n.startsWith('/') || n.startsWith('//') || n.startsWith('/\\')) return '/';
  if (n === '/login' || n.startsWith('/login/')) return '/';
  return n;
}

// GET /api/auth/google/start — begin the OAuth dance: mint a flow (CSRF state + id_token nonce +
// PKCE pair), stash it in ONE HMAC-signed HttpOnly cookie, and redirect to Google's consent.
export async function GET(req: NextRequest) {
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL('/login?sso=unconfigured', req.url));
  }
  const url = new URL(req.url);
  const redirectUri = `${publicOrigin(req)}/api/auth/google/callback`;
  const { flow, challenge } = newFlow(safeNext(url.searchParams.get('next')));

  const res = NextResponse.redirect(buildGoogleAuthUrl(redirectUri, flow.state, flow.nonce, challenge));
  // SameSite=Lax (NOT Strict): the signed flow cookie must survive the top-level redirect BACK from
  // Google (a cross-site navigation) — Strict would drop it and break the callback's checks.
  res.cookies.set(OAUTH_FLOW_COOKIE, signFlow(flow), {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: 600,
  });
  return res;
}
