import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createApiKey } from '@/lib/api/api-keys';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/apikeys/create — create a user-bound API key. Any full session (local OR OAuth-only);
// the client confirms first, and the server independently requires acknowledgeRisk for admin/destructive
// caps. The plaintext token is returned ONCE (only the secret's hash is stored). Mirrors _h_create_key.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in to manage API keys');
  const body = await readJson(req);

  const res = await createApiKey(sess.sub, String(body.label ?? 'API key'), {
    caps: body.caps,
    scope: body.scope,
    acknowledgeRisk: body.acknowledgeRisk === true,
  });
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ ok: true, id: res.id, label: res.label, scope: res.scope, caps: res.caps, token: res.token });
}
