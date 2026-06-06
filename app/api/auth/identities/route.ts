import { getSession } from '@/lib/auth/session';
import { twoFactorStatus } from '@/lib/auth/auth-store';
import { jsonOk, jsonErr } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// GET/POST /api/auth/identities — list the CALLER's linked OIDC providers (own session). Reuses the
// 2FA-status read (which already projects identities) so there's one source. Mirrors _h_identities.
async function handle() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in first');
  const status = await twoFactorStatus(sess.sub, sess.src);
  return jsonOk({ identities: status.identities });
}

export const GET = handle;
export const POST = handle;
