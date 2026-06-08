import { type NextRequest } from 'next/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { getSession } from '@/lib/auth/session';
import { passkeyRegisterFinish } from '@/lib/auth/passkeys';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/passkey/register/finish — verify the attestation (challenge + origin + RP ID +
// signature) and store the credential PUBLIC key + counter on the caller's LOCAL account. The private
// key never leaves the device. Full LOCAL session required. Mirrors eit_webauthn._reg_finish.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) {
    return jsonErr(401, 'sign in to add a passkey');
  }
  const body = await readJson(req);
  const state = String(body.state ?? '');
  const credential = body.credential as RegistrationResponseJSON | undefined;
  const label = typeof body.label === 'string' ? body.label : undefined;
  if (!credential || typeof credential !== 'object') return jsonErr(400, 'malformed credential');

  const origin = new URL(req.url).origin;
  const res = await passkeyRegisterFinish(sess.sub, state, credential, origin, label);
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ ok: true, count: res.count });
}
