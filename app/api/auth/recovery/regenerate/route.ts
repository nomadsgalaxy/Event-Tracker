import { type NextRequest } from 'next/server';
import { getSession, verifyStepupToken } from '@/lib/auth/session';
import { regenerateRecoveryCodes } from '@/lib/auth/auth-store';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/recovery/regenerate — generate a fresh set of recovery codes (shown ONCE). STEP-UP
// required (rotating recovery codes is sensitive). Requires an enrolled authenticator. Mirrors
// eit_auth._h_recovery_regenerate.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess || sess.src !== 'local') return jsonErr(401, 'sign in with your password first');
  const body = await readJson(req);
  if (!verifyStepupToken(String(body.stepupToken ?? ''), sess.sub)) return jsonErr(403, 'step-up required');

  const res = await regenerateRecoveryCodes(sess.sub);
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ ok: true, recoveryCodes: res.recoveryCodes });
}
