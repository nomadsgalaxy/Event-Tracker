import 'server-only';
import crypto from 'node:crypto';
import { getDb } from '@/lib/db/mongo';
import { resolveLiveRole } from '@/lib/auth/auth';
import { getPolicyOverlay } from '@/lib/auth/settings-store';
import type { Role } from '@/lib/types/types';

// lib/auth/oidc.ts — Google OAuth (OIDC) sign-in + the local-account binding model.
//
// THE BINDING RULE (ported from the reviewed Python eit_oidc safe email-binding): the VERIFIED
// EMAIL is the identity key. A Google sign-in for an email that already has an account (local
// password OR a prior SSO record) binds to THAT account — same directory user, same role — so
// local accounts and Google are one identity from the start. A brand-new email gets a read-only
// directory user + a credential-less (pw=null) auth record an admin can promote. Security rules
// (every one of these was a finding in the OIDC red-team — all closed here to match the Python):
//   • id_token RS256 signature VERIFIED against Google's JWKS, alg pinned (no alg:none/HS confusion)
//   • a per-flow NONCE binds the id_token to the browser that began the flow + PKCE (S256) binds the
//     code; both ride a single HMAC-SIGNED flow cookie (state + nonce + verifier + next)
//   • aud membership (array-safe) + azp; iss; exp with 60s skew; email_verified required
//   • REFUSE a soft-deleted directory user — checking BOTH top-level and payload.deletedAt
//   • never write the role (no SSO self-elevation); never overwrite a local password ($setOnInsert)
//   • optional domain allowlist (EIT_OIDC_ALLOWED_DOMAINS); open by default → new users read-only

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const USERS = 'users';
const AUTH = 'auth';
const EXP_SKEW_SEC = 60;

export const OAUTH_FLOW_COOKIE = '_eit_oauth';

// The browser-facing origin used to build the OAuth redirect_uri. Behind a proxy (cloudflared),
// req.url resolves to the internal bind host (e.g. http://0.0.0.0:3100), which would produce an
// unregistered + unreachable redirect_uri and break Google sign-in. EIT_PUBLIC_URL pins it to the
// real canonical origin (e.g. https://events.example.com); fall back to the request origin only
// when it isn't set (local dev).
export function publicOrigin(req: { url: string }): string {
  const env = (process.env.EIT_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (env) return env;
  return new URL(req.url).origin;
}

function norm(e: unknown): string {
  return String(e ?? '').trim().toLowerCase();
}

function clientId(): string {
  return process.env.GOOGLE_CLIENT_ID || '';
}

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// ── Signed flow cookie (state + nonce + PKCE verifier + next) ──────────────────────────────────
// One HMAC-signed cookie carries the whole flow secret, so a tampered cookie is rejected
// structurally (no single unsigned value is load-bearing). Signed with ET_SESSION_SECRET.
export interface OAuthFlow {
  state: string;
  nonce: string;
  verifier: string; // PKCE code_verifier
  next: string;
  providerId: string; // 'google' | any configured provider id | 'github' — the callback cross-checks it
}

function flowSecret(): Buffer {
  const s = process.env.ET_SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('ET_SESSION_SECRET is required (>=16 chars) to sign the OAuth flow.');
  }
  return Buffer.from(s, 'utf-8');
}

export function signFlow(flow: OAuthFlow): string {
  const body = Buffer.from(JSON.stringify(flow), 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', flowSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyFlow(token: string | undefined | null): OAuthFlow | null {
  if (!token || !token.includes('.')) return null;
  const dot = token.indexOf('.');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expect: string;
  try {
    expect = crypto.createHmac('sha256', flowSecret()).update(body).digest('base64url');
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    if (obj && typeof obj.state === 'string' && typeof obj.nonce === 'string' && typeof obj.verifier === 'string') {
      return {
        state: obj.state,
        nonce: obj.nonce,
        verifier: obj.verifier,
        next: typeof obj.next === 'string' ? obj.next : '/',
        // Backward-compat: a cookie minted before this field existed is treated as a Google flow.
        providerId: typeof obj.providerId === 'string' ? obj.providerId : 'google',
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Mint a fresh flow (state + nonce + PKCE pair) for `providerId`. Returns the flow + the challenge. */
export function newFlow(next: string, providerId = 'google'): { flow: OAuthFlow; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return {
    flow: { state: crypto.randomBytes(16).toString('hex'), nonce: crypto.randomBytes(16).toString('hex'), verifier, next, providerId },
    challenge,
  };
}

export function buildGoogleAuthUrl(redirectUri: string, state: string, nonce: string, codeChallenge: string): string {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH}?${p.toString()}`;
}

// ── id_token signature verification (Google JWKS, RS256) ────────────────────────────────────────
interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}
let jwksCache: { keys: Jwk[]; exp: number } | null = null;

async function googleJwks(force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.exp > Date.now()) return jwksCache.keys;
  const res = await fetch(GOOGLE_JWKS, { cache: 'no-store' });
  if (!res.ok) throw new Error('JWKS fetch failed');
  const body = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { keys: body.keys || [], exp: Date.now() + 3600_000 }; // 1h TTL
  return jwksCache.keys;
}

function b64urlBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Verify an id_token's RS256 signature against Google's JWKS, alg pinned, then return the claims.
 *  Throws on any failure (bad signature, unknown kid, wrong alg) — fail-closed. */
async function verifyIdToken(jwt: string): Promise<Record<string, unknown>> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('id_token: malformed');
  const header = JSON.parse(b64urlBuf(parts[0]).toString('utf-8')) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error('id_token: unexpected alg'); // reject none / HS256 confusion
  let jwk = (await googleJwks()).find((k) => k.kid === header.kid);
  // Key rotation: an unknown kid usually means the cached JWKS is stale (1h TTL) — re-fetch once
  // before failing, so a Google key rotation doesn't black out sign-ins until the TTL expires.
  if (!jwk) jwk = (await googleJwks(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('id_token: unknown signing key');
  const pub = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), pub, b64urlBuf(parts[2]));
  if (!ok) throw new Error('id_token: bad signature');
  return JSON.parse(b64urlBuf(parts[1]).toString('utf-8')) as Record<string, unknown>;
}

export interface GoogleProfile {
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  /** The Google subject id (stable per-user) + issuer — recorded as the linked-identity key. */
  sub?: string;
  iss?: string;
}

/** Exchange the authorization code (with PKCE verifier) for tokens, verify the id_token signature
 *  + all claims (incl. the per-flow nonce), and return the verified identity. */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  expectedNonce: string,
  codeVerifier: string
): Promise<GoogleProfile> {
  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Google token exchange failed');
  const tok = (await res.json()) as { id_token?: string };
  if (!tok.id_token) throw new Error('No id_token in Google token response');

  const c = await verifyIdToken(tok.id_token); // signature-verified claims
  if (!ISSUERS.has(String(c.iss))) throw new Error('id_token: bad issuer');
  // aud may be a string OR an array — require membership, and if multi-aud, require azp == us.
  const auds = Array.isArray(c.aud) ? c.aud.map(String) : [String(c.aud)];
  if (!auds.includes(clientId())) throw new Error('id_token: bad audience');
  if (auds.length > 1 && String(c.azp) !== clientId()) throw new Error('id_token: bad azp');
  if (Number(c.exp ?? 0) < Math.floor(Date.now() / 1000) - EXP_SKEW_SEC) throw new Error('id_token: expired');
  if (String(c.nonce) !== expectedNonce) throw new Error('id_token: nonce mismatch'); // browser binding

  return {
    email: norm(c.email),
    emailVerified: c.email_verified === true || c.email_verified === 'true',
    name: typeof c.name === 'string' ? c.name : undefined,
    picture: typeof c.picture === 'string' ? c.picture : undefined,
    sub: c.sub != null ? String(c.sub) : undefined,
    iss: typeof c.iss === 'string' ? c.iss : undefined,
  };
}

/**
 * Verify a Google One Tap / GIS credential (an ID token JWT delivered by the gsi client, NOT a code
 * exchange). Same rigor as exchangeGoogleCode minus the per-flow nonce/PKCE (which only apply to the
 * redirect flow): RS256 signature against Google's JWKS (alg pinned), issuer, aud membership (+azp on
 * multi-aud), exp with skew, email_verified. The credential is origin-restricted by Google to the
 * client's Authorized JavaScript origins, so only our own pages can obtain one for our client_id.
 */
export async function verifyGoogleCredential(idToken: string): Promise<GoogleProfile> {
  const c = await verifyIdToken(idToken); // signature-verified claims (throws on bad sig/alg/kid)
  if (!ISSUERS.has(String(c.iss))) throw new Error('credential: bad issuer');
  const auds = Array.isArray(c.aud) ? c.aud.map(String) : [String(c.aud)];
  if (!auds.includes(clientId())) throw new Error('credential: bad audience');
  if (auds.length > 1 && String(c.azp) !== clientId()) throw new Error('credential: bad azp');
  if (Number(c.exp ?? 0) < Math.floor(Date.now() / 1000) - EXP_SKEW_SEC) throw new Error('credential: expired');
  return {
    email: norm(c.email),
    emailVerified: c.email_verified === true || c.email_verified === 'true',
    name: typeof c.name === 'string' ? c.name : undefined,
    picture: typeof c.picture === 'string' ? c.picture : undefined,
    sub: c.sub != null ? String(c.sub) : undefined,
    iss: typeof c.iss === 'string' ? c.iss : undefined,
  };
}

/** The public Google OAuth client id (safe to expose to the browser for GIS One Tap). '' if unset. */
export function googleClientId(): string {
  return clientId();
}

async function allowedDomain(email: string): Promise<boolean> {
  const domain = (email.split('@')[1] || '').toLowerCase();
  // Env allowlist (deploy-time) UNION the Access-policy overlay (admin-editable). Empty UNION ⇒ open
  // by default — a new email just lands read-only. A store-granted admin email is also let through
  // even if its domain isn't allowed, so the access policy can admit a specific outside admin.
  const envRaw = (process.env.EIT_OIDC_ALLOWED_DOMAINS || '').trim();
  const envDomains = envRaw
    ? envRaw.split(/[,\s]+/).map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
    : [];
  let overlay = { allowedDomains: [] as string[], adminEmails: [] as string[] };
  try {
    overlay = await getPolicyOverlay();
  } catch {
    /* a flaky store must not block sign-in; fall back to env-only */
  }
  const domains = new Set([...envDomains, ...overlay.allowedDomains]);
  if (domains.size === 0) return true; // open
  if (domains.has(domain)) return true;
  // An explicitly-granted admin email is admitted regardless of domain.
  return overlay.adminEmails.includes(norm(email));
}

export type OidcSignInResult =
  | { ok: true; email: string; role: Role; isNew: boolean }
  | { ok: false; reason: 'unverified' | 'offboarded' | 'not_allowed' | 'must_change_password' };

interface DirUser {
  _id: string;
  payload?: { email?: string; name?: string; picture?: string; role?: string; source?: string; lastLoginAt?: number; deletedAt?: number | null };
  deletedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

interface AuthRec {
  _id: string; // lower-cased email
  pw?: unknown; // PBKDF2 record, or null for a credential-less SSO account
  role?: string;
  source?: string;
  ssoProvisioned?: boolean;
  oauthIdentities?: { provider: string; sub: string; iss?: string; email?: string; linkedAt?: number }[];
  createdAt?: number;
  updatedAt?: number;
}

/** The verified SSO profile shape every provider normalizes to (Google, generic OIDC, GitHub). */
export type SsoProfile = GoogleProfile;

/**
 * Resolve a VERIFIED SSO profile (from ANY provider) to an Event Tracker identity, binding to an
 * existing account by email or creating a read-only one. `providerId` is 'google' | any configured
 * provider id | 'github'; it sets the account source ('github' or `oidc:<id>`) and the
 * oauthIdentities provider key. NEVER mints a session itself (the callback route does), NEVER writes
 * role, NEVER overwrites a local password ($setOnInsert), refuses a soft-deleted user, enforces the
 * domain allow-list. The caller must have already VERIFIED the profile (signature/claims) — this only
 * does the binding.
 */
export async function signInWithOidc(profile: SsoProfile, providerId: string): Promise<OidcSignInResult> {
  if (!profile.emailVerified) return { ok: false, reason: 'unverified' };
  const email = norm(profile.email);
  if (!email) return { ok: false, reason: 'unverified' };
  if (!(await allowedDomain(email))) return { ok: false, reason: 'not_allowed' };

  const pid = String(providerId || 'google');
  const source = pid === 'github' ? 'github' : `oidc:${pid}`;

  const db = await getDb();
  const users = db.collection<DirUser>(USERS);
  const dir = await users.findOne({ _id: email });

  // OFFBOARDED: a soft-deleted directory user is never resurrected — check BOTH the envelope and the
  // payload tombstone (a peer / the /api path can stamp deletedAt inside payload).
  if (dir && (dir.deletedAt || dir.payload?.deletedAt)) return { ok: false, reason: 'offboarded' };

  const now = Date.now();
  const isNew = !dir;

  if (isNew) {
    await users.insertOne({
      _id: email,
      payload: { email, name: profile.name || email, picture: profile.picture || '', role: 'read-only', source, lastLoginAt: now },
      createdAt: now,
      updatedAt: now,
    });
  } else {
    const set: Record<string, unknown> = { updatedAt: now, 'payload.lastLoginAt': now };
    // Picture precedence: the OAuth photo is the DEFAULT; a user-uploaded picture (a data: URL from
    // Account > Profile) always WINS and is never overwritten. A stored remote URL is refreshed from
    // the provider each login (Google photo URLs expire), and an empty slot is filled.
    const storedPic = String((dir.payload as { picture?: unknown })?.picture ?? '');
    if (profile.picture && !storedPic.startsWith('data:')) set['payload.picture'] = profile.picture;
    if (!dir.payload?.name && profile.name) set['payload.name'] = profile.name;
    // Heal a legacy/missing method so the Users list never mislabels a returning SSO user as "Local".
    // Fill-only: never overwrite an existing value (e.g. a deliberate adminConvertToLocal → 'local').
    if (!(dir.payload as { source?: unknown })?.source) set['payload.source'] = source;
    await users.updateOne({ _id: email }, { $set: set });
  }

  // Ensure an auth record exists (credential-less if none) WITHOUT overwriting a local password —
  // $setOnInsert only writes on a fresh insert; the role is never written by SSO.
  await db.collection<AuthRec>(AUTH).updateOne(
    { _id: email },
    {
      $setOnInsert: { _id: email, pw: null, role: 'read-only', source, ssoProvisioned: true, createdAt: now },
      $set: { updatedAt: now },
    },
    { upsert: true }
  );

  // Auto-heal: an SSO-provisioned account that somehow carries a stray password (e.g. a legacy reset
  // that converted it to local) is restored to OAuth-only on sign-in, so the password path can't
  // shadow SSO. Scoped to ssoProvisioned + a non-null pw, so a real local account is never touched.
  await db
    .collection(AUTH)
    .updateOne(
      { _id: email, ssoProvisioned: true, pw: { $ne: null } } as Record<string, unknown>,
      { $set: { pw: null, mustChangePassword: false, updatedAt: now } }
    );

  // Forced-rotation gate (checked AFTER the auto-heal so a legacy SSO reclaim still passes): a LOCAL
  // account with a pending admin-forced password change must complete it — SSO must not be a bypass
  // that leaves the admin believing a compromised credential was rotated when it wasn't.
  const authRec = await db.collection<AuthRec>(AUTH).findOne(
    { _id: email },
    { projection: { mustChangePassword: 1, pw: 1 } }
  );
  if (authRec && (authRec as { mustChangePassword?: boolean }).mustChangePassword && authRec.pw != null) {
    return { ok: false, reason: 'must_change_password' };
  }

  // Record the provider identity on the auth record (shows under Account → Security → linked logins).
  // The sign-in already succeeded for this verified email, so binding the user's OWN identity to their
  // OWN record is not an escalation. Guard against hijack: skip if this (provider, sub) is already
  // attached to a DIFFERENT account. Best-effort — a write hiccup must never block the sign-in.
  const sub = String(profile.sub || '').trim();
  if (sub) {
    try {
      const authCol = db.collection<AuthRec>(AUTH);
      const other = await authCol.findOne({ _id: { $ne: email }, oauthIdentities: { $elemMatch: { provider: pid, sub } } });
      if (!other) {
        // Atomic append-if-absent (a filtered $push, not read-modify-write) so two concurrent
        // sign-ins binding different providers can't overwrite each other's identity entry.
        await authCol.updateOne(
          { _id: email, oauthIdentities: { $not: { $elemMatch: { provider: pid, sub } } } } as Record<string, unknown>,
          { $push: { oauthIdentities: { provider: pid, sub, iss: profile.iss || '', email, linkedAt: now } }, $set: { updatedAt: now } } as never
        );
      }
    } catch {
      /* binding is best-effort; never block sign-in on it */
    }
  }

  const role = await resolveLiveRole(email); // LIVE role: env-admin > directory > read-only
  return { ok: true, email, role, isNew };
}

/** Resolve a verified Google profile (redirect flow + One Tap) — delegates to the shared binding. */
export async function signInWithGoogle(profile: GoogleProfile): Promise<OidcSignInResult> {
  return signInWithOidc(profile, 'google');
}
