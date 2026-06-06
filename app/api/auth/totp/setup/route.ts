import { type NextRequest } from 'next/server';
import { getSession, verifyStageToken, verifyStepupToken } from '@/lib/session';
import { beginTotpSetup, getAuthRecord } from '@/lib/auth-store';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/totp/setup — issue a fresh enrollment secret + otpauth URI (mirrors _h_totp_setup).
// Auth: a setup2fa STAGING token (login-time mandatory enrollment) OR a full LOCAL session (re-enroll
// from the Security tab). REPLACING an existing authenticator from a full session requires a fresh
// STEP-UP — so a stolen session cookie can't silently rotate the victim's TOTP + recovery codes;
// first-time enrollment (setup2fa stage, or no TOTP yet) does not. The plaintext secret is returned
// ONCE here for a LOCAL qrcode-generator QR render; it is stored only encrypted (totpPending).
export async function POST(req: NextRequest) {
  const body = await readJson(req);

  // Resolve the authorizing principal: a setup2fa stage token, else a full session.
  let email: string | null = null;
  let viaFullSession = false;
  const stage = verifyStageToken(String(body.setupToken ?? ''), 'setup2fa');
  if (stage) {
    email = stage.sub;
  } else {
    const sess = await getSession();
    if (sess && sess.src === 'local') {
      email = sess.sub;
      viaFullSession = true;
    } else if (sess) {
      // A full but non-local (SSO) session can't manage 2FA in v1 — set a local password first.
      return jsonErr(403, 'sign in with your password to set up 2FA');
    }
  }
  if (!email) return jsonErr(401, 'auth required to set up TOTP');

  const rec = await getAuthRecord(email);
  if (!rec) return jsonErr(404, 'account not found');

  // Replacing an EXISTING authenticator from a full session ⇒ require step-up.
  if (rec.totp && viaFullSession) {
    if (!verifyStepupToken(String(body.stepupToken ?? ''), email)) {
      return jsonErr(403, 'step-up required');
    }
  }

  const { otpauthUri, secret } = await beginTotpSetup(email);
  return jsonOk({ otpauthUri, secret });
}
