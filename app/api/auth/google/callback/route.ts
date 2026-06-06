import { NextResponse, type NextRequest } from 'next/server';
import {
  exchangeGoogleCode,
  signInWithGoogle,
  googleConfigured,
  verifyFlow,
  OAUTH_FLOW_COOKIE,
  publicOrigin,
  type GoogleProfile,
} from '@/lib/oidc';
import { issueSessionToken, COOKIE_NAME, SSO_COOKIE_OPTS } from '@/lib/session';

export const dynamic = 'force-dynamic';

function safeNext(n: string | null | undefined): string {
  if (typeof n !== 'string' || !n.startsWith('/') || n.startsWith('//') || n.startsWith('/\\')) return '/';
  if (n === '/login' || n.startsWith('/login/')) return '/';
  return n;
}

// GET /api/auth/google/callback — Google redirects here with ?code&state. We verify the SIGNED flow
// cookie (HMAC + state match), exchange the code with the PKCE verifier, verify the id_token
// signature + nonce (in lib/oidc), run the binding, and on success mint the session cookie. Any
// failure redirects to /login?sso=<reason> (coarse, self-scoped — no oracle, no PII).
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  // MUST match the redirect_uri the start route registered with Google (EIT_PUBLIC_URL-pinned),
  // both for the token exchange and the post-login navigation back into the app.
  const origin = publicOrigin(req);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerErr = url.searchParams.get('error');
  const flow = verifyFlow(req.cookies.get(OAUTH_FLOW_COOKIE)?.value);

  const fail = (reason: string) => {
    const r = NextResponse.redirect(new URL(`/login?sso=${encodeURIComponent(reason)}`, origin));
    r.cookies.delete(OAUTH_FLOW_COOKIE);
    return r;
  };

  if (providerErr) return fail('cancelled');
  if (!googleConfigured()) return fail('unconfigured');
  // CSRF: the signed flow cookie must verify (HMAC) AND its state must equal the returned state.
  if (!code || !state || !flow || state !== flow.state) return fail('state');

  let profile: GoogleProfile;
  try {
    // PKCE verifier + the per-flow nonce are enforced inside exchangeGoogleCode (signature + nonce).
    profile = await exchangeGoogleCode(code, `${origin}/api/auth/google/callback`, flow.nonce, flow.verifier);
  } catch {
    return fail('exchange');
  }

  const result = await signInWithGoogle(profile);
  if (!result.ok) return fail(result.reason);

  const { token } = issueSessionToken(result.email, result.role, 'oidc:google');
  const res = NextResponse.redirect(new URL(safeNext(flow.next), origin));
  res.cookies.set(COOKIE_NAME, token, SSO_COOKIE_OPTS); // same session cookie, Lax for the redirect
  res.cookies.delete(OAUTH_FLOW_COOKIE);
  return res;
}
