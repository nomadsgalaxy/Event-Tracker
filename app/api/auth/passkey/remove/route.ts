import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { removePasskey } from '@/lib/auth/passkeys';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/passkey/remove — remove a passkey by id. Any full session (local OR OAuth-only); the
// client confirms first. Mirrors eit_webauthn._remove.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in to manage passkeys');
  const body = await readJson(req);

  const res = await removePasskey(sess.sub, String(body.id ?? ''));
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ ok: true, count: res.count });
}
