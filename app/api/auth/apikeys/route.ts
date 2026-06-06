import { getSession } from '@/lib/session';
import { listApiKeys } from '@/lib/api-keys';
import { jsonOk, jsonErr } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// GET/POST /api/auth/apikeys — list the caller's OWN API keys (no secrets). Mirrors _h_list_keys.
async function handle() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in');
  const { keys, tokenPrefix } = await listApiKeys(sess.sub);
  return jsonOk({ keys, role: sess.role, tokenPrefix });
}

export const GET = handle;
export const POST = handle;
