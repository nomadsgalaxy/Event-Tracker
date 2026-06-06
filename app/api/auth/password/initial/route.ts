import { type NextRequest } from 'next/server';
import { setForcedInitialPassword, finishFullLogin } from '@/lib/auth-store';
import { issueSessionToken, setSessionCookie, verifyStageToken } from '@/lib/session';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/password/initial — forced first-login password change (#6B; mirrors
// _h_password_initial). Accepts the one-time mustchangepw STAGING token (minted by /api/auth/login
// after a correct temp password). No old password required — it was verified during that login. The
// server re-checks (in setForcedInitialPassword) that the flag is STILL set (a valid token can't be
// replayed after the first change) and that the new password DIFFERS from the temp one. On success it
// clears the flag and mints the full session, so the temp password is rotated before the app loads.
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const sess = verifyStageToken(String(body.changeToken ?? ''), 'mustchangepw');
  if (!sess) return jsonErr(401, 'log in again to set your password');

  const res = await setForcedInitialPassword(sess.sub, String(body.newPassword ?? ''));
  if (!res.ok) return jsonErr(res.code, res.error);

  // The flag is now cleared; finishFullLogin re-checks offboarded (and the now-cleared temp-pw flag).
  const fin = await finishFullLogin(sess.sub, 'local');
  if (!fin.ok) return jsonErr(403, 'sign-in not permitted');

  const { token } = issueSessionToken(fin.email, fin.role, 'local');
  await setSessionCookie(token);
  return jsonOk({ ok: true, email: fin.email, role: fin.role });
}
