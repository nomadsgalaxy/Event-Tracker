import 'server-only';
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { getDb } from '@/lib/db/mongo';
import { AUTH_COLLECTION, type AuthDoc, type StoredPasskey } from '@/lib/auth/auth';

// lib/auth/passkeys.ts — WebAuthn passkeys (registration + passwordless assertion) via
// @simplewebauthn/server. Faithful to the intent of server/eit_webauthn.py, hardened by the library:
//
//   • The CHALLENGE is bound to the browser via a short-lived HMAC-SIGNED token (no server-side
//     session store), exactly like eit_webauthn._sign_challenge. The token carries {t, sub, challenge,
//     exp}; the finish step re-verifies the HMAC + the embedded challenge.
//   • verifyRegistrationResponse / verifyAuthenticationResponse enforce, server-side:
//       - the expected challenge (our signed token's challenge),
//       - the expected ORIGIN (EIT_PUBLIC_URL or the request origin),
//       - the expected RP ID (the registrable domain),
//       - the attestation/assertion SIGNATURE,
//       - and (on assertion) the signature COUNTER must advance (anti-clone) — requireUserVerification
//         is 'preferred' to match the Python's userVerification:'preferred'.
//   • Credentials are stored on the auth doc passkeys[] as { id (b64url), publicKey (b64url), counter }.
//     The secret material is the device's private key — it NEVER reaches the server. We store only the
//     PUBLIC key + counter.
//   • Registration requires a LOCAL full session (the route enforces src==='local'); login verifies an
//     assertion and the route mints the standard full session.

const RP_NAME = 'Event Tracker';

/** The Relying Party ID = the registrable domain. EIT_PUBLIC_URL host, else 'localhost' (dev). */
export function rpId(): string {
  const pub = (process.env.EIT_PUBLIC_URL || '').trim();
  if (pub) {
    try {
      const h = new URL(pub).hostname;
      if (h) return h;
    } catch {
      /* fall through */
    }
  }
  return 'localhost';
}

/** The expected WebAuthn origin: EIT_PUBLIC_URL (sans trailing slash), else the request origin. */
export function expectedOrigin(reqOrigin: string): string {
  const pub = (process.env.EIT_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return pub || reqOrigin.replace(/\/+$/, '');
}

// ── Short-lived HMAC-signed challenge token (no server-side store) ───────────────────────────────
function challengeSecret(): Buffer {
  const s = process.env.ET_SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('ET_SESSION_SECRET is required (>=16 chars) for passkeys.');
  return Buffer.from(s, 'utf-8');
}

interface ChallengePayload {
  t: 'reg' | 'login';
  sub: string; // the account email
  c: string; // base64url challenge
  exp: number;
}

function signChallenge(p: ChallengePayload): string {
  const body = Buffer.from(JSON.stringify(p), 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', challengeSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyChallenge(token: string | null | undefined): ChallengePayload | null {
  if (!token || !token.includes('.')) return null;
  const dot = token.indexOf('.');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expect: string;
  try {
    expect = crypto.createHmac('sha256', challengeSecret()).update(body).digest('base64url');
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as ChallengePayload;
    if (!p || (p.t !== 'reg' && p.t !== 'login') || typeof p.c !== 'string') return null;
    if (Number(p.exp ?? 0) < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch {
    return null;
  }
}

const norm = (e: unknown): string => String(e ?? '').trim().toLowerCase();

async function authRecord(email: string): Promise<AuthDoc | null> {
  const db = await getDb();
  return db.collection<AuthDoc>(AUTH_COLLECTION).findOne({ _id: norm(email) });
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────
export interface PasskeyRegisterBegin {
  options: PublicKeyCredentialCreationOptionsJSON;
  state: string; // the signed challenge token (echoed back at finish)
}

/** Begin passkey registration for a LOCAL full session. excludeCredentials prevents double-enroll. */
export async function passkeyRegisterBegin(email: string): Promise<PasskeyRegisterBegin> {
  const e = norm(email);
  const rec = await authRecord(e);
  const existing = (rec?.passkeys ?? []).map((k) => ({ id: k.id, transports: k.transports as never }));
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId(),
    userName: e,
    userDisplayName: e,
    attestationType: 'none',
    excludeCredentials: existing,
    authenticatorSelection: { userVerification: 'preferred', residentKey: 'preferred' },
    timeout: 120_000,
  });
  const state = signChallenge({ t: 'reg', sub: e, c: options.challenge, exp: Math.floor(Date.now() / 1000) + 300 });
  return { options, state };
}

export type PasskeyRegisterFinish =
  | { ok: true; count: number }
  | { ok: false; error: string; code: 400 | 401 | 404 | 409 };

/** Finish registration: verify the attestation against the signed challenge + origin + RP ID, then
 *  store the credential public key + counter on the auth doc. */
export async function passkeyRegisterFinish(
  email: string,
  state: string,
  credential: RegistrationResponseJSON,
  reqOrigin: string,
  label?: string
): Promise<PasskeyRegisterFinish> {
  const e = norm(email);
  const st = verifyChallenge(state);
  if (!st || st.t !== 'reg' || st.sub !== e) return { ok: false, error: 'invalid challenge', code: 400 };
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: st.c,
      expectedOrigin: expectedOrigin(reqOrigin),
      expectedRPID: rpId(),
      requireUserVerification: false, // 'preferred' UV (parity with eit_webauthn userPresent-only gate)
    });
  } catch {
    return { ok: false, error: 'attestation verification failed', code: 400 };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: 'attestation not verified', code: 400 };
  }
  const info = verification.registrationInfo;
  const cred = info.credential;
  const id = cred.id; // base64url credential id
  const publicKey = Buffer.from(cred.publicKey).toString('base64url');

  const rec = await authRecord(e);
  if (!rec) return { ok: false, error: 'no local account for this session', code: 404 };
  const keys: StoredPasskey[] = [...(rec.passkeys ?? [])];
  if (keys.some((k) => k.id === id)) return { ok: false, error: 'passkey already registered', code: 409 };
  keys.push({
    id,
    publicKey,
    counter: cred.counter,
    transports: cred.transports,
    addedAt: Date.now(),
    label: (label ?? '').trim().slice(0, 60) || undefined,
  });
  const db = await getDb();
  await db.collection<AuthDoc>(AUTH_COLLECTION).updateOne({ _id: e }, { $set: { passkeys: keys, updatedAt: Date.now() } });
  return { ok: true, count: keys.length };
}

// ── Authentication (passwordless login) ────────────────────────────────────────────────────────
export interface PasskeyLoginBegin {
  options: PublicKeyCredentialRequestOptionsJSON;
  state: string;
}
export type PasskeyLoginBeginResult = PasskeyLoginBegin | { error: string; code: 400 | 404 | 503 };

/** Begin assertion for `email`: 404 if no passkey is registered (so the client can fall back to pw). */
export async function passkeyLoginBegin(email: string): Promise<PasskeyLoginBeginResult> {
  const e = norm(email);
  if (!e) return { error: 'email required', code: 400 };
  let rec: AuthDoc | null;
  try {
    rec = await authRecord(e);
  } catch {
    return { error: 'auth store unreachable', code: 503 };
  }
  const keys = rec?.passkeys ?? [];
  if (!keys.length) return { error: 'no passkey registered for this account', code: 404 };
  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    userVerification: 'preferred',
    allowCredentials: keys.map((k) => ({ id: k.id, transports: k.transports as never })),
    timeout: 120_000,
  });
  const state = signChallenge({ t: 'login', sub: e, c: options.challenge, exp: Math.floor(Date.now() / 1000) + 300 });
  return { options, state };
}

export type PasskeyLoginFinish =
  | { ok: true; email: string }
  | { ok: false; error: string; code: 400 | 401 | 404 };

/** Finish assertion: verify the signature against the stored public key + the signed challenge +
 *  origin + RP ID, enforce the signature counter advances (anti-clone), then persist the new counter.
 *  Returns the verified email; the ROUTE applies can_sign_in / mustChangePassword / offboarded gates
 *  and mints the session (so this stays a pure crypto-verify boundary). */
export async function passkeyLoginFinish(
  state: string,
  credential: AuthenticationResponseJSON,
  reqOrigin: string
): Promise<PasskeyLoginFinish> {
  const st = verifyChallenge(state);
  if (!st || st.t !== 'login') return { ok: false, error: 'invalid challenge', code: 400 };
  const e = norm(st.sub);
  const rec = await authRecord(e);
  const keys = rec?.passkeys ?? [];
  const credId = credential.id || credential.rawId;
  const idx = keys.findIndex((k) => k.id === credId);
  if (idx < 0 || !rec) return { ok: false, error: 'unknown credential', code: 404 };
  const stored = keys[idx];

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: st.c,
      expectedOrigin: expectedOrigin(reqOrigin),
      expectedRPID: rpId(),
      requireUserVerification: false,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: stored.counter,
        transports: stored.transports as never,
      },
    });
  } catch {
    return { ok: false, error: 'assertion verification failed', code: 401 };
  }
  if (!verification.verified) return { ok: false, error: 'assertion verification failed', code: 401 };

  // Anti-replay: the library already rejects a non-advancing counter when the authenticator provides
  // one; persist the new counter so a future replay with the SAME counter is caught.
  const newCounter = verification.authenticationInfo.newCounter;
  if (newCounter && newCounter <= stored.counter) {
    return { ok: false, error: 'possible cloned authenticator (signCount)', code: 401 };
  }
  keys[idx] = { ...stored, counter: newCounter };
  const db = await getDb();
  await db.collection<AuthDoc>(AUTH_COLLECTION).updateOne({ _id: e }, { $set: { passkeys: keys, updatedAt: Date.now() } });
  return { ok: true, email: e };
}

// ── List / remove (self-service Security card) ───────────────────────────────────────────────────
export interface PublicPasskey {
  id: string;
  label?: string;
  addedAt?: number;
  counter: number;
}
export async function listPasskeys(email: string): Promise<PublicPasskey[]> {
  const rec = await authRecord(email);
  return (rec?.passkeys ?? []).map((k) => ({ id: k.id, label: k.label, addedAt: k.addedAt, counter: k.counter }));
}

export type RemovePasskeyResult = { ok: true; count: number } | { ok: false; error: string; code: 400 | 404 };
/** Remove a passkey by id. The ROUTE gates this on a step-up (removing a factor is sensitive); a LOCAL
 *  account keeps its password, so this can never lock anyone out. */
export async function removePasskey(email: string, id: string): Promise<RemovePasskeyResult> {
  const e = norm(email);
  if (!id) return { ok: false, error: 'passkey id required', code: 400 };
  const rec = await authRecord(e);
  const keys = rec?.passkeys ?? [];
  const kept = keys.filter((k) => k.id !== id);
  if (kept.length === keys.length) return { ok: false, error: 'no such passkey', code: 404 };
  const db = await getDb();
  await db.collection<AuthDoc>(AUTH_COLLECTION).updateOne({ _id: e }, { $set: { passkeys: kept, updatedAt: Date.now() } });
  return { ok: true, count: kept.length };
}
