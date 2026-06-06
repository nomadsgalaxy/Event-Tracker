import { type NextRequest } from 'next/server';
import { passkeyLoginBegin } from '@/lib/passkeys';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/passkey/login/begin — PUBLIC (passwordless sign-in starts while signed out). Returns
// the WebAuthn request options + a signed challenge token for `email`. 404 when no passkey is
// registered for that account (so the client can fall back to the password form). Mirrors
// eit_webauthn._login_begin.
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const res = await passkeyLoginBegin(String(body.email ?? ''));
  if ('error' in res) return jsonErr(res.code, res.error);
  return jsonOk({ options: res.options, state: res.state });
}
