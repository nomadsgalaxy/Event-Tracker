import { type NextRequest } from 'next/server';
import { getSession, verifyStepupToken } from '@/lib/session';
import { createApiKey } from '@/lib/api-keys';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/apikeys/create — create a user-bound API key. Full LOCAL session + a fresh STEP-UP
// required. The plaintext token is returned ONCE (only the secret's hash is stored). Mirrors
// _h_create_key.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess || sess.src !== 'local') return jsonErr(401, 'sign in with your password to manage API keys');
  const body = await readJson(req);
  if (!verifyStepupToken(String(body.stepupToken ?? ''), sess.sub)) return jsonErr(403, 'step-up required');

  const res = await createApiKey(sess.sub, String(body.label ?? 'API key'), body.scope);
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ ok: true, id: res.id, label: res.label, scope: res.scope, token: res.token });
}
