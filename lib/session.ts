import 'server-only';
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import type { Role } from './types';

// lib/session.ts — signed-cookie session for the Next.js stack.
//
// SHAPE-COMPATIBLE with server/eit_auth.py's session so the two stacks can share one
// deployment seam where it's sensible. The Python token is:
//
//     token  = b64url(JSON(payload, sorted-keys, no-spaces)) + "." + b64url(HMAC_SHA256(secret, body))
//     payload= {"sub","role","src","stage","iat","exp"}   (sub=email; stage "full"; src "local")
//     cookie = _eit_auth=<token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=<ttl>; [Secure]
//
// We replicate the token format EXACTLY (same JSON canonicalization, same b64url alphabet,
// same HMAC) so a token minted here verifies in eit_auth.verify_session and vice-versa —
// PROVIDED both processes share ET_SESSION_SECRET / EIT_AUTH_SECRET (operator's choice to
// align them). The secret is read from process.env.ET_SESSION_SECRET.
//
// TOTP/SSO are a LATER wave: `stage` is kept in the payload (always "full" for now) and `src`
// ("local") so the 2FA staging tokens (pending2fa/setup2fa/mustchangepw) and OIDC sources slot
// in without a format change.

export const COOKIE_NAME = '_eit_auth';
export const SESSION_TTL_SECONDS = 12 * 3600; // 12h — matches eit_auth _CFG.session_ttl.
export const PENDING_TTL_SECONDS = 5 * 60; // 5m — matches eit_auth _CFG.pending_ttl (2FA staging + must-change).
export const STEPUP_TTL_SECONDS = 5 * 60; // 5m — matches eit_auth._STEPUP_TTL (sensitive-action re-auth).

export type SessionStage = 'full' | 'pending2fa' | 'setup2fa' | 'mustchangepw' | 'stepup';

/** The signed session payload. Mirrors the Python payload keys exactly. */
export interface SessionPayload {
  sub: string; // the user's email (lower-cased)
  role: Role; // the role baked at sign-in time (re-resolved live for authz — see lib/auth)
  src: string; // credential source: 'local' (password). 'oidc:<provider>' is a later wave.
  stage: SessionStage;
  iat: number; // issued-at (unix seconds)
  exp: number; // expiry (unix seconds)
}

function secretBytes(): Buffer {
  const s = process.env.ET_SESSION_SECRET;
  if (!s || s.length < 16) {
    // Fail LOUD, never fall back to a weak/empty key — an unsigned-equivalent session is a
    // full auth bypass. Mirrors eit_auth requiring >=16 bytes of entropy.
    throw new Error(
      'ET_SESSION_SECRET is not set (or shorter than 16 chars). Set a long random value in .env.local.'
    );
  }
  // eit_auth accepts the raw value as UTF-8 bytes (it tries base64 first, but a non-base64
  // string is used as-is). We mirror the common case: treat the env value as UTF-8 bytes.
  return Buffer.from(s, 'utf-8');
}

// ── b64url helpers (urlsafe base64, '=' padding stripped) — matches Python _b64u/_b64u_dec ──
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// Canonical JSON matching Python json.dumps(payload, separators=(",",":"), sort_keys=True).
// JSON.stringify with sorted keys + no whitespace produces the identical byte string for the
// flat scalar payload we use (no floats / NaN / unicode-escaping differences in play here).
function canonicalJson(payload: SessionPayload): string {
  const rec = payload as unknown as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + JSON.stringify(rec[k]));
  return '{' + parts.join(',') + '}';
}

function hmacB64url(bodyAscii: string): string {
  return b64url(crypto.createHmac('sha256', secretBytes()).update(bodyAscii, 'ascii').digest());
}

/** Sign a payload into the `body.sig` token (mirrors eit_auth.sign_session). */
export function signSession(payload: SessionPayload): string {
  const body = b64url(Buffer.from(canonicalJson(payload), 'utf-8'));
  return body + '.' + hmacB64url(body);
}

/** Verify a token: constant-time HMAC check + JSON parse + expiry. Returns the payload or
 *  null (mirrors eit_auth.verify_session). NEVER throws on bad input — a malformed/forged
 *  token is just null. */
export function verifySession(token: string | null | undefined): SessionPayload | null {
  if (!token || !token.includes('.')) return null;
  const dot = token.indexOf('.');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expect: string;
  try {
    expect = hmacB64url(body);
  } catch {
    return null; // missing secret etc. — fail closed
  }
  // Constant-time compare. timingSafeEqual throws on length mismatch, so guard it.
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expect);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf-8')) as SessionPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (Number(payload.exp ?? 0) < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** Mint a 12h full-session token for `email`+`role` (src defaults to 'local'). */
export function issueSessionToken(email: string, role: Role, src = 'local'): { token: string; payload: SessionPayload } {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: email,
    role,
    src,
    stage: 'full',
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  return { token: signSession(payload), payload };
}

/**
 * Mint a short-lived STAGING token (pending2fa / setup2fa / mustchangepw). It is NOT a signed-in
 * session — getSession() rejects any stage !== 'full'. It rides in the response BODY (not a cookie),
 * is presented back by the next step, and re-verified server-side. Mirrors the pendingToken /
 * setupToken / changeToken eit_auth mints (5-min pending_ttl). `role`/`src` are carried so the
 * finishing step can mint the full session with the same role+source without a re-read.
 */
export function issueStageToken(
  email: string,
  role: Role,
  stage: Exclude<SessionStage, 'full' | 'stepup'>,
  src = 'local'
): string {
  const now = Math.floor(Date.now() / 1000);
  return signSession({ sub: email, role, src, stage, iat: now, exp: now + PENDING_TTL_SECONDS });
}

/** Verify a staging token of an EXPECTED stage; null on any failure (bad sig / wrong stage / exp). */
export function verifyStageToken(
  token: string | null | undefined,
  expectStage: Exclude<SessionStage, 'full'>
): SessionPayload | null {
  const p = verifySession(token);
  if (!p || p.stage !== expectStage) return null;
  return p;
}

// ── Step-up token (re-auth for sensitive Security actions) ──────────────────────────────────────
// A short-lived, single-purpose token minted by the step-up action after a fresh password check. The
// sensitive action presents it; the server re-verifies stage==='stepup' AND sub===caller. Mirrors
// eit_auth._issue_stepup / verify_stepup. It rides the response body (the Python also sets a
// path-scoped cookie only for the OAuth-bind GET navigation; here every consumer is a POST action so
// the body token suffices — no broad-scope step-up cookie is ever set).
export function issueStepupToken(email: string): string {
  const now = Math.floor(Date.now() / 1000);
  // Stage-only payload (no role/src) — a step-up token confers no session, only re-auth proof.
  return signSession({
    sub: email,
    role: 'read-only',
    src: 'stepup',
    stage: 'stepup',
    iat: now,
    exp: now + STEPUP_TTL_SECONDS,
  });
}

/** True iff `token` is a valid step-up token issued for `email` (constant-time via verifySession). */
export function verifyStepupToken(token: string | null | undefined, email: string): boolean {
  const p = verifySession(token);
  return Boolean(p && p.stage === 'stepup' && p.sub === String(email ?? '').trim().toLowerCase());
}

// The cookie attributes mirror eit_auth._set_cookie: HttpOnly, SameSite=Strict, Path=/,
// Max-Age=ttl, Secure (we always set Secure; on http://localhost dev it's harmless because
// modern browsers still send Secure cookies to localhost). Next's cookies() applies them.
export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  path: '/',
  secure: true,
  maxAge: SESSION_TTL_SECONDS,
};

// SSO sets the SAME session cookie but SameSite=Lax so it survives the cross-site top-level redirect
// back from the IdP (a freshly-set Strict cookie can be dropped on that first hop). HttpOnly/Secure/
// maxAge stay in lockstep with the password flow via the spread — one source of truth.
export const SSO_COOKIE_OPTS = { ...COOKIE_OPTS, sameSite: 'lax' as const };

/** Set the session cookie (call from a Server Action / Route Handler). */
export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, COOKIE_OPTS);
}

/** Clear the session cookie (logout). Mirrors eit_auth._clear_cookie (Max-Age=0). */
export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, '', { ...COOKIE_OPTS, maxAge: 0 });
}

/**
 * Read + verify the current session from the request cookie. Returns the verified payload or
 * null. Only a `stage:'full'` token counts as a signed-in session for the app surface (the
 * 2FA-staging tokens are interstitial — they're never "signed in"). Mirrors the
 * _h_session / verify_session_cookie shape.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  const payload = verifySession(token);
  if (!payload || payload.stage !== 'full') return null;
  return payload;
}
