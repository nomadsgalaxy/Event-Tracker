import { type NextRequest } from 'next/server';
import { getSession, issueStepupToken, STEPUP_TTL_SECONDS } from '@/lib/session';
import { checkStepupPassword, getAuthRecord } from '@/lib/auth-store';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/stepup — mint a short-lived (5 min), single-purpose step-up token for sensitive
// actions (config writes: integration keys / branding / access policy / tenant / permissions; and the
// Security actions: replace TOTP, regenerate recovery, remove a passkey, unlink an identity, create an
// API key). Step-up is a real "are you sure?" re-auth, so it ALWAYS requires the account's local
// PASSWORD — but it no longer requires a LOCAL session: a Google/SSO-session admin who has set a
// password confirms with that password (the old `src === 'local'` gate wrongly turned them away).
// A pure-SSO admin with no password is asked to set one once (Account → Security) — forcing a local
// password for step-up is the intended posture. The token rides the response body.
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in to change settings');

  const rec = await getAuthRecord(sess.sub);
  if (!rec?.pw) {
    return jsonErr(400, 'Set a local password in Account → Security to confirm sensitive changes.');
  }
  const body = await readJson(req);
  const res = await checkStepupPassword(sess.sub, String(body.password ?? ''));
  if (!res.ok) return jsonErr(res.code, res.error);

  const token = issueStepupToken(sess.sub);
  return jsonOk({ stepupToken: token, expiresIn: STEPUP_TTL_SECONDS });
}
