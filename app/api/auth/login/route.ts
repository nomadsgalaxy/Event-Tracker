import { type NextRequest } from 'next/server';
import { login } from '@/lib/auth';
import { finishFullLogin } from '@/lib/auth-store';
import {
  issueSessionToken,
  issueStageToken,
  setSessionCookie,
} from '@/lib/session';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/login — the password gate (mirrors eit_auth._h_login).
//
// Server is the SOLE authority over what session is granted. The response NEVER carries a full
// session unless 2FA is satisfied / not required and no forced rotation is pending:
//   • password OK, no 2FA, no temp-pw  → set the stage:'full' cookie, { ok:true }.
//   • password OK, TOTP enrolled        → { twofa:'totp_required', pendingToken } (no cookie).
//   • password OK, 2FA required, none   → { twofa:'totp_setup_required', setupToken } (no cookie).
//   • password OK, temp pw (#6B)        → { mustChangePassword:true, changeToken } (no cookie).
// The staging tokens are short-lived (5 min), carry the verified email+role, ride the BODY (not a
// cookie), and are re-verified server-side at the finishing step. A bad password is a generic 401
// (no account-existence oracle); repeated failures lock the account (429) — both handled in login().
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const email = String(body.email ?? '').trim();
  const password = String(body.password ?? '');
  if (!email || !password) return jsonErr(400, 'email and password required');

  const result = await login(email, password);

  if (!result.ok && 'pending' in result) {
    // Password verified; a second factor / forced rotation stands between here and a full session.
    if (result.pending === 'must_change_password') {
      const token = issueStageToken(result.email, 'read-only', 'mustchangepw');
      return jsonOk({ mustChangePassword: true, changeToken: token, email: result.email });
    }
    if (result.pending === 'totp_required') {
      const token = issueStageToken(result.email, 'read-only', 'pending2fa');
      return jsonOk({ twofa: 'totp_required', pendingToken: token, email: result.email });
    }
    // totp_setup_required
    const token = issueStageToken(result.email, 'read-only', 'setup2fa');
    return jsonOk({ twofa: 'totp_setup_required', setupToken: token, email: result.email });
  }

  if (!result.ok) {
    return jsonErr(result.code, result.error);
  }

  // No second factor, no forced rotation → mint the full session now.
  const { token } = issueSessionToken(result.email, result.role, 'local');
  await setSessionCookie(token);
  return jsonOk({ ok: true, email: result.email, role: result.role });
}
