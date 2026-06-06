import { type NextRequest } from 'next/server';
import { verifyLoginTotp, finishFullLogin } from '@/lib/auth-store';
import { issueSessionToken, setSessionCookie, verifyStageToken } from '@/lib/session';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/totp/verify — the pending2fa interstitial (mirrors eit_auth._h_totp_verify).
// Requires the pendingToken from /api/auth/login (so the password was already verified server-side).
// Verifies the 6-digit code against the ACTIVE secret (±1 step, rate-limited with its own lockout),
// then mints the full session. A bad pendingToken (bad sig / wrong stage / expired) is a 401 — the
// client must restart from the password step.
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const sess = verifyStageToken(String(body.pendingToken ?? ''), 'pending2fa');
  if (!sess) return jsonErr(401, 'login first');
  const code = String(body.code ?? '');

  const res = await verifyLoginTotp(sess.sub, code);
  if (!res.ok) return jsonErr(res.code, res.error);

  const fin = await finishFullLogin(sess.sub, 'local');
  if (!fin.ok) return jsonErr(403, 'sign-in not permitted');

  const { token } = issueSessionToken(fin.email, fin.role, 'local');
  await setSessionCookie(token);
  return jsonOk({ ok: true, email: fin.email, role: fin.role });
}
