import { type NextRequest } from 'next/server';
import { consumeRecoveryCode, finishFullLogin } from '@/lib/auth/auth-store';
import { issueSessionToken, setSessionCookie, verifyStageToken } from '@/lib/auth/session';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/recovery — sign in with a single-use recovery code when the authenticator is lost
// (mirrors eit_auth._h_recovery). Requires the pendingToken from /api/auth/login (password already
// verified). The code is matched against the HASHED codes (constant-time PBKDF2), CONSUMED (removed),
// then a full session is minted so the user can re-enroll TOTP. Rate-limited with its own lockout.
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const sess = verifyStageToken(String(body.pendingToken ?? ''), 'pending2fa');
  if (!sess) return jsonErr(401, 'login first');

  const res = await consumeRecoveryCode(sess.sub, String(body.code ?? ''));
  if (!res.ok) return jsonErr(res.code, res.error);

  const fin = await finishFullLogin(sess.sub, 'local');
  if (!fin.ok) return jsonErr(403, 'sign-in not permitted');

  const { token } = issueSessionToken(fin.email, fin.role, 'local');
  await setSessionCookie(token);
  return jsonOk({
    ok: true,
    email: fin.email,
    role: fin.role,
    recoveryRemaining: res.remaining,
    hint: 'Recovery code used. Re-enroll your authenticator in Account → Security to restore 2FA.',
  });
}
