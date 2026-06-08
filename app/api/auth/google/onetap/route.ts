import { NextResponse, type NextRequest } from 'next/server';
import { signInWithGoogle, verifyGoogleCredential, googleConfigured } from '@/lib/auth/oidc';
import { issueSessionToken, COOKIE_NAME, SSO_COOKIE_OPTS } from '@/lib/auth/session';
import { jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/google/onetap — sign in from a Google One Tap (GIS) credential. The gsi client
// delivers a verified ID token (JWT) to the page; we verify it (signature + claims, lib/oidc.
// verifyGoogleCredential), run the same email-binding signInWithGoogle as the redirect callback, and
// mint the full session cookie. PUBLIC (the caller is signed out) — it's under /api/auth/google so the
// middleware allowlist already covers it. The domain allow-list + soft-delete refusal still apply
// inside signInWithGoogle, so One Tap can't widen who may sign in.
export async function POST(req: NextRequest) {
  if (!googleConfigured()) return jsonErr(503, 'Google sign-in is not configured.');
  const body = await readJson(req);
  const credential = String(body.credential ?? '');
  if (!credential) return jsonErr(400, 'Missing credential.');

  let profile;
  try {
    profile = await verifyGoogleCredential(credential);
  } catch {
    return jsonErr(401, 'Could not verify the Google credential.');
  }

  const result = await signInWithGoogle(profile);
  if (!result.ok) return jsonErr(401, result.reason);

  const { token } = issueSessionToken(result.email, result.role, 'oidc:google');
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, SSO_COOKIE_OPTS);
  return res;
}
