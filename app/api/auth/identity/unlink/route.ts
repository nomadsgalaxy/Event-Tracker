import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { unlinkIdentity } from '@/lib/auth/auth-store';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/identity/unlink — unlink an OIDC provider from the caller's account. NEVER strips the
// last sign-in method: gated to a full LOCAL session (src==='local'), so a password always remains
// after unlinking — you cannot remove your only way in. The client confirms first. Mirrors
// eit_auth._h_identity_unlink.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess || sess.src !== 'local') return jsonErr(401, 'sign in with your password first');
  const body = await readJson(req);

  const res = await unlinkIdentity(sess.sub, String(body.provider ?? ''));
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ ok: true, provider: String(body.provider ?? ''), remaining: res.remaining });
}
