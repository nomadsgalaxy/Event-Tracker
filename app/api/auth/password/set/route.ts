import { type NextRequest } from 'next/server';
import { getSession, issueSessionToken, setSessionCookie } from '@/lib/session';
import { setInitialPassword } from '@/lib/auth-store';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/password/set — set an INITIAL local password for an account that has NONE (the
// SSO-only case, #53). The active full session authorizes it (no old password). Set-ONLY — refuses if
// a password already exists (use /password/change to rotate). On success a fresh src:'local' full
// session is minted so the user can immediately satisfy step-up (every step-up consumer requires
// src==='local'; an SSO session is src='oidc:*'). Mirrors eit_auth._h_password_set.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in first');
  const body = await readJson(req);
  const res = await setInitialPassword(sess.sub, sess.role, String(body.newPassword ?? ''));
  if (!res.ok) return jsonErr(res.code, res.error);

  // Mint a local-source session so step-up works right away (role carried from the current session).
  const { token } = issueSessionToken(sess.sub, sess.role, 'local');
  await setSessionCookie(token);
  return jsonOk({ ok: true, email: sess.sub, role: sess.role });
}
