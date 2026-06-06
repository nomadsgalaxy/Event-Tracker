import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { revokeApiKey } from '@/lib/api-keys';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/apikeys/revoke — revoke a key by id (own session; revocation is fail-safe so no
// step-up). Mirrors _h_revoke_key.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in');
  const body = await readJson(req);
  const res = await revokeApiKey(sess.sub, String(body.id ?? ''));
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ ok: true, revoked: res.revoked, removed: res.removed });
}
