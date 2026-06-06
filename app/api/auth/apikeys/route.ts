import { getSession } from '@/lib/auth/session';
import { listApiKeys } from '@/lib/api/api-keys';
import { jsonOk, jsonErr } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// GET/POST /api/auth/apikeys — list the caller's OWN API keys (no secrets). Mirrors _h_list_keys.
async function handle() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in');
  const { keys, tokenPrefix, role, ownerCaps } = await listApiKeys(sess.sub);
  return jsonOk({ keys, role, tokenPrefix, ownerCaps });
}

export const GET = handle;
export const POST = handle;
