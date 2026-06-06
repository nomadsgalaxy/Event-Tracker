import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { changePassword } from '@/lib/auth/auth-store';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/password/change — change your own password. Full LOCAL session + the current password
// (PBKDF2-verified) required; the new one must be ≥8 chars. Mirrors eit_auth._h_password_change.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess || sess.src !== 'local') return jsonErr(401, 'sign in with a local account first');
  const body = await readJson(req);
  const res = await changePassword(sess.sub, String(body.oldPassword ?? ''), String(body.newPassword ?? ''));
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ ok: true });
}
