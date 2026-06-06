import { type NextRequest } from 'next/server';
import { getSession, verifyStageToken, issueSessionToken, setSessionCookie } from '@/lib/auth/session';
import { confirmTotpSetup, finishFullLogin } from '@/lib/auth/auth-store';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/totp/confirm — confirm enrollment with a 6-digit code (mirrors _h_totp_confirm).
// Auth: the setup2fa STAGING token (login-time) OR a full session (Security-tab re-enroll). On the
// LOGIN-TIME path it promotes the pending secret to active, mints the recovery codes (shown ONCE),
// and — since this completes a mandatory login-time enrollment — mints the full session. On the
// Security-tab path the caller already HAS a full session, so we just return the recovery codes.
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const code = String(body.code ?? '');

  const stage = verifyStageToken(String(body.setupToken ?? ''), 'setup2fa');
  const sess = stage ? null : await getSession();
  const email = stage?.sub ?? sess?.sub ?? null;
  if (!email) return jsonErr(401, 'auth required to confirm TOTP');

  const res = await confirmTotpSetup(email, code);
  if (!res.ok) return jsonErr(res.code, res.error);

  if (stage) {
    // Login-time mandatory enrollment → finish into a full session now (re-checks offboarded/temp-pw).
    const fin = await finishFullLogin(email, 'local');
    if (!fin.ok) return jsonErr(403, 'sign-in not permitted');
    const { token } = issueSessionToken(fin.email, fin.role, 'local');
    await setSessionCookie(token);
    return jsonOk({ ok: true, email: fin.email, role: fin.role, recoveryCodes: res.recoveryCodes });
  }

  // Security-tab re-enroll: the caller already holds a full session.
  return jsonOk({ ok: true, recoveryCodes: res.recoveryCodes });
}
