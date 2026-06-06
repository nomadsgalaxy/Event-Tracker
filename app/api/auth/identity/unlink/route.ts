import { type NextRequest } from 'next/server';
import { getSession, verifyStepupToken } from '@/lib/auth/session';
import { unlinkIdentity } from '@/lib/auth/auth-store';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/identity/unlink — unlink an OIDC provider from the caller's account. STEP-UP required.
// NEVER strips the last sign-in method: this is gated to a full LOCAL session (src==='local'), so a
// password always remains after unlinking — you cannot remove your only way in. Mirrors
// eit_auth._h_identity_unlink.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess || sess.src !== 'local') return jsonErr(401, 'sign in with your password first');
  const body = await readJson(req);
  if (!verifyStepupToken(String(body.stepupToken ?? ''), sess.sub)) return jsonErr(403, 'step-up required');

  const res = await unlinkIdentity(sess.sub, String(body.provider ?? ''));
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ ok: true, provider: String(body.provider ?? ''), remaining: res.remaining });
}
