import { type NextRequest } from 'next/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { passkeyLoginFinish } from '@/lib/passkeys';
import { finishFullLogin } from '@/lib/auth-store';
import { issueSessionToken, setSessionCookie } from '@/lib/session';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/passkey/login/finish — PUBLIC. Verifies the WebAuthn assertion (signature against the
// stored public key + the signed challenge + origin + RP ID + the signature COUNTER must advance) and,
// on success, mints the standard full session. The crypto verify lives in lib/passkeys; the
// cross-cutting sign-in gates (offboarded, pending temp-pw) are applied by finishFullLogin so this
// passwordless path can never bypass them. Mirrors eit_webauthn._login_finish.
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const state = String(body.state ?? '');
  const credential = body.credential as AuthenticationResponseJSON | undefined;
  if (!credential || typeof credential !== 'object') return jsonErr(400, 'malformed assertion');

  const origin = new URL(req.url).origin;
  const res = await passkeyLoginFinish(state, credential, origin);
  if (!res.ok) return jsonErr(res.code, res.error);

  const fin = await finishFullLogin(res.email, 'local');
  if (!fin.ok) {
    // offboarded / pending temp-pw — refuse the passwordless session without leaking which.
    return jsonErr(403, fin.reason === 'must_change_password' ? 'set your new password first' : 'sign-in not permitted');
  }

  const { token } = issueSessionToken(fin.email, fin.role, 'local');
  await setSessionCookie(token);
  return jsonOk({ ok: true, email: fin.email, role: fin.role });
}
