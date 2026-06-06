import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { passkeyRegisterBegin } from '@/lib/passkeys';
import { jsonOk, jsonErr } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/passkey/register/begin — add a passkey to the caller's LOCAL account. Requires a full
// LOCAL session (src==='local') so an OAuth-only session can't forge a credential-less record. Returns
// the WebAuthn creation options (excludeCredentials prevents double-enroll) + a signed challenge token.
// Mirrors eit_webauthn._reg_begin.
export async function POST(_req: NextRequest) {
  const sess = await getSession();
  if (!sess || sess.src !== 'local') {
    return jsonErr(401, 'sign in with your password to add a passkey');
  }
  const { options, state } = await passkeyRegisterBegin(sess.sub);
  return jsonOk({ options, state });
}
