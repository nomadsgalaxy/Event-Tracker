import { getSession } from '@/lib/session';
import { twoFactorStatus } from '@/lib/auth-store';
import { jsonOk, jsonErr } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// GET/POST /api/auth/2fa/status — report the CALLER's OWN factors (keyed on session email — never a
// param, so no IDOR/enumeration). Drives the Account → Security tab. Mirrors eit_auth._h_2fa_status.
async function handle() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in first');
  const status = await twoFactorStatus(sess.sub, sess.src);
  return jsonOk(status as unknown as Record<string, unknown>);
}

export const GET = handle;
export const POST = handle;
