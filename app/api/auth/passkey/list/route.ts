import { getSession } from '@/lib/auth/session';
import { listPasskeys } from '@/lib/auth/passkeys';
import { jsonOk, jsonErr } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/passkey/list — the caller's OWN registered passkeys (keyed on session, no secrets).
export async function POST() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in first');
  const passkeys = await listPasskeys(sess.sub);
  return jsonOk({ passkeys });
}
