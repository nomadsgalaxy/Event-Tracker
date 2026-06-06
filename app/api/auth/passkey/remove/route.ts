import { type NextRequest } from 'next/server';
import { getSession, verifyStepupToken } from '@/lib/auth/session';
import { removePasskey } from '@/lib/auth/passkeys';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/passkey/remove — remove a passkey by id. STEP-UP required (removing a factor is
// sensitive). A LOCAL account keeps its password, so this can never lock anyone out. Mirrors
// eit_webauthn._remove.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess || sess.src !== 'local') return jsonErr(401, 'sign in with your password first');
  const body = await readJson(req);
  if (!verifyStepupToken(String(body.stepupToken ?? ''), sess.sub)) return jsonErr(403, 'step-up required');

  const res = await removePasskey(sess.sub, String(body.id ?? ''));
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ ok: true, count: res.count });
}
