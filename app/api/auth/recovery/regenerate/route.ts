import { getSession } from '@/lib/auth/session';
import { regenerateRecoveryCodes } from '@/lib/auth/auth-store';
import { jsonOk, jsonErr } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/recovery/regenerate — generate a fresh set of recovery codes (shown ONCE). Local
// account only (recovery codes back up TOTP); the client confirms first. Requires an enrolled
// authenticator. Mirrors eit_auth._h_recovery_regenerate.
export async function POST() {
  const sess = await getSession();
  if (!sess || sess.src !== 'local') return jsonErr(401, 'sign in with your password first');

  const res = await regenerateRecoveryCodes(sess.sub);
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ ok: true, recoveryCodes: res.recoveryCodes });
}
