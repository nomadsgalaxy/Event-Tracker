import 'server-only';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { redirect } from 'next/navigation';
import { getDb } from './mongo';
import { getSession, type SessionPayload } from './session';
import { normalizeRole, rankOf, DEFAULT_ROLE, applyOverride, type OverrideDoc } from './rbac';
import type { Role } from './types';

// lib/auth.ts — password login + live role resolution + server guards.
//
// Faithful to server/eit_auth.py:
//   • PASSWORD HASH (hash_password/verify_password): PBKDF2-HMAC-SHA256. Stored as
//       { algo:"pbkdf2-sha256", salt:<b64url(16 bytes)>, iters:<int>, hash:<b64url(dk)> }
//     on the `auth` collection doc, under field `pw`, keyed by _id == lower-cased email.
//     We REPLICATE VERIFICATION exactly: pbkdf2(sha256, password-utf8, salt, iters) and a
//     constant-time compare against the stored hash. (Mint isn't needed for this wave, but
//     hashPassword is provided so a created account is byte-compatible with the Python store.)
//   • LIVE AUTHORITATIVE ROLE: the session role is the SYNCED `users` directory payload.role
//     (eit_auth._effective_role_for / _live_session_role), NOT a value baked forever into the
//     token. Per the live-DB rewrite we re-resolve it from Mongo on every guard call so a
//     demotion takes effect immediately (the Python side caches ~15s; here every read is a
//     real DB call by design — LIVE-DB ONLY).
//
// SCOPE: password + session + RBAC. TOTP/SSO/passkeys/lockout-persistence are a LATER wave;
// the seams (stage tokens, src, the 2FA fields on the auth doc) are left intact.
//
// The `auth` collection is the CREDENTIAL store and is NEVER reachable from the data plane
// (it's off the app-collection allowlist). Only this module reads it, server-side.

// ── the stored PBKDF2 password record (matches eit_auth.hash_password output) ──
export interface PwRecord {
  algo: string; // "pbkdf2-sha256"
  salt: string; // b64url(16 random bytes)
  iters: number;
  hash: string; // b64url(derived key)
}

// A stored passkey (WebAuthn) credential on the auth doc. id is the base64url credential id; the
// public key lives as a base64url SPKI/COSE blob (lib/passkeys owns the exact encoding).
export interface StoredPasskey {
  id: string; // base64url credential id
  publicKey: string; // base64url public key (the @simplewebauthn-stored device key)
  counter: number; // signature counter (anti-clone)
  transports?: string[];
  addedAt?: number;
  label?: string;
}

// A linked OIDC identity (the join key is provider+sub, never the mutable email).
export interface OAuthIdentity {
  provider: string;
  sub: string;
  iss?: string;
  email?: string;
  linkedAt?: number;
}

// The `auth` collection credential doc. ALL secret material (pw / totp / recovery / passkeys /
// oauthIdentities) lives here — this collection is OFF the data-plane allowlist, so a /db caller can
// never read it. Only server-side code in lib/auth, lib/auth-store, lib/passkeys touches it.
export interface AuthDoc {
  _id: string; // lower-cased email
  pw?: PwRecord | null;
  role?: string;
  source?: string;
  ssoProvisioned?: boolean;
  // Lockout counters (one per attack surface so a holder of only the session cookie can't DoS the
  // victim's normal login by spamming a different surface).
  failed?: number;
  lockedUntil?: number;
  totpFailed?: number;
  totpLockedUntil?: number;
  recoveryFailed?: number;
  recoveryLockedUntil?: number;
  stepupFailed?: number;
  stepupLockedUntil?: number;
  mustChangePassword?: boolean;
  twofaRequired?: boolean;
  // TOTP: { secretEnc, confirmedAt } once enrolled; totpPending holds the unconfirmed wrapped secret.
  totp?: { secretEnc: string; confirmedAt?: number } | null;
  totpPending?: string | null;
  recovery?: PwRecord[]; // HASHED recovery codes (PBKDF2, single-use)
  passkeys?: StoredPasskey[];
  oauthIdentities?: OAuthIdentity[];
  // Personal/global iCal feed tokens — stored as { hash, enc } so the URL can be re-displayed.
  calFeed?: { hash: string; enc: string } | null;
  calFeedGlobal?: { hash: string; enc: string } | null;
  // Caller-scoped API keys (the secret is stored HASHED; only the prefix/label/scope are listable).
  apiKeys?: { id: string; label: string; scope: string; hash: PwRecord; createdAt?: number; lastUsedAt?: number | null }[];
  createdAt?: number;
  updatedAt?: number;
  createdBy?: string; // who provisioned this account (admin email or 'bootstrap')
}

export const AUTH_COLLECTION = 'auth';
const USERS_COLLECTION = 'users';
// The lockout policy — mirrors eit_auth _CFG.lockout_threshold / lockout_seconds.
export const LOCKOUT_THRESHOLD = 8;
export const LOCKOUT_SECONDS = 15 * 60;

function normEmail(e: unknown): string {
  // String()-coerce: a Server Action arg / cookie value could be a non-string (a NoSQL operator
  // object like {$ne:null}). Coercing here means email NEVER reaches a Mongo {_id} filter as an
  // object — the scalar-_id pin the Python original relied on.
  return String(e ?? '').trim().toLowerCase();
}

// Deploy-time admin allowlist (EIT_ADMIN_EMAILS, comma/space separated). These emails are ALWAYS
// admin and can never be demoted by a directory-role write — mirrors eit_auth's env/policy admin
// override (the deploy authority wins over the synced directory role).
function isEnvAdmin(email: string): boolean {
  const raw = process.env.EIT_ADMIN_EMAILS || '';
  if (!raw.trim()) return false;
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
}

// ── b64url decode (urlsafe, padding-tolerant) — matches Python _b64u_dec ──
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const DEFAULT_PBKDF2_ITERS = 600_000; // mirrors eit_auth _CFG.pbkdf2_iters

/**
 * Verify a plaintext password against a stored PBKDF2 record. Constant-time. Returns false on
 * ANY malformed input (mirrors verify_password's try/except -> False). Algo-pinned to
 * pbkdf2-sha256 — an unexpected algo fails closed rather than being silently trusted.
 */
export function verifyPassword(password: string, rec: PwRecord | null | undefined): boolean {
  if (!rec || typeof rec !== 'object') return false;
  try {
    if (rec.algo && rec.algo !== 'pbkdf2-sha256') return false;
    const salt = b64urlDecode(rec.salt);
    const iters = Number(rec.iters);
    if (!Number.isInteger(iters) || iters < 1) return false;
    const expect = b64urlDecode(rec.hash);
    const dk = crypto.pbkdf2Sync(Buffer.from(password, 'utf-8'), salt, iters, expect.length, 'sha256');
    return dk.length === expect.length && crypto.timingSafeEqual(dk, expect);
  } catch {
    return false;
  }
}

// Async (libuv-threadpool) PBKDF2 so a hot verification path never blocks the Node event loop. Used by
// the unauthenticated API-key verify path (lib/api-keys.verifyApiKey), where a flood of bad tokens
// would otherwise pin a core with synchronous derivations. Same algorithm + constant-time compare as
// verifyPassword — keep them in lockstep.
const pbkdf2Async = promisify(crypto.pbkdf2);
export async function verifyPasswordAsync(password: string, rec: PwRecord | null | undefined): Promise<boolean> {
  if (!rec || typeof rec !== 'object') return false;
  try {
    if (rec.algo && rec.algo !== 'pbkdf2-sha256') return false;
    const salt = b64urlDecode(rec.salt);
    const iters = Number(rec.iters);
    if (!Number.isInteger(iters) || iters < 1) return false;
    const expect = b64urlDecode(rec.hash);
    const dk = await pbkdf2Async(Buffer.from(password, 'utf-8'), salt, iters, expect.length, 'sha256');
    return dk.length === expect.length && crypto.timingSafeEqual(dk, expect);
  } catch {
    return false;
  }
}

/** Mint a PBKDF2 record byte-compatible with the Python store (so an account created here
 *  verifies under eit_auth and vice-versa). Not used by login; provided for account creation
 *  in a later wave + to keep the hash contract in ONE place. */
export function hashPassword(password: string, iters = DEFAULT_PBKDF2_ITERS): PwRecord {
  const salt = crypto.randomBytes(16);
  const dk = crypto.pbkdf2Sync(Buffer.from(password, 'utf-8'), salt, iters, 32, 'sha256');
  return { algo: 'pbkdf2-sha256', salt: b64url(salt), iters, hash: b64url(dk) };
}

/**
 * Resolve the LIVE authoritative role for an email from the `users` directory (payload.role),
 * falling back to the `auth` record role, then DEFAULT_ROLE. ALWAYS returns a valid Role
 * (normalizeRole clamps the legacy invalid 'member' etc.). Mirrors eit_auth._effective_role_for.
 *
 * NOTE on admin override: eit_auth force-stamps env/policy EIT_ADMIN_EMAILS to 'admin' per-site.
 * That admin allowlist is a deploy-time concern not yet wired in this rewrite; the seam is here
 * (apply it before returning once EIT_ADMIN_EMAILS is plumbed). For now the directory role is
 * authoritative, which is the live-DB model the rewrite targets.
 */
// ── Permission-override sync (the __perms__ doc → rbac, TTL-cached) ──────────────────────────────
// Faithful to eit_auth._sync_perms: read the persisted admin override from the `auth` collection and
// install it into rbac so the SAME table the admin Permissions screen edits is what the server's
// can()/rank decisions evaluate. Inlined here (not imported from perms-store) to avoid an auth↔perms-
// store import cycle; perms-store stays the WRITE authority + re-installs on save. TTL-cached to keep
// the hot path off the store; a StoreError leaves the current override untouched (a flaky store must
// never silently reset the matrix).
const PERMS_ID = '__perms__';
const PERMS_TTL_MS = 30_000;
let _permsSyncedAt = 0;

interface PermsSettingsDoc {
  _id: string;
  roles?: OverrideDoc['roles'];
  grants?: Record<string, string[]>;
  caps_seen?: string[];
  capsSeen?: string[];
  _reset?: boolean;
}

async function syncPermsOverride(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - _permsSyncedAt < PERMS_TTL_MS) return;
  try {
    const db = await getDb();
    const doc = await db.collection<PermsSettingsDoc>(AUTH_COLLECTION).findOne({ _id: PERMS_ID });
    if (!doc || doc._reset) {
      applyOverride(null);
    } else {
      applyOverride({
        roles: Array.isArray(doc.roles) ? doc.roles : undefined,
        grants: doc.grants && typeof doc.grants === 'object' ? doc.grants : undefined,
        capsSeen: Array.isArray(doc.capsSeen) ? doc.capsSeen : Array.isArray(doc.caps_seen) ? doc.caps_seen : undefined,
      });
    }
    _permsSyncedAt = now;
  } catch {
    // leave the current override in place
  }
}

// ── Access-policy admin overlay (the __settings__ doc's policy.adminEmails → 'admin') ────────────
// The Config > Admin "Access policy" card grants ADDITIVE admin emails (additive to EIT_ADMIN_EMAILS).
// Like an env admin, a policy admin can't be demoted by a directory-role write. We read the overlay
// INLINE here (not via settings-store) to avoid an auth↔settings-store import cycle — same rationale
// as syncPermsOverride above. TTL-cached (30s) so the hot path adds at most one read per 30s/process;
// a flaky store leaves the last snapshot in place (fail to the prior state, never crash the guard).
const SETTINGS_ID = '__settings__';
const POLICY_TTL_MS = 30_000;
let _policyAdminsAt = 0;
let _policyAdmins = new Set<string>();

async function policyAdminEmails(): Promise<Set<string>> {
  const now = Date.now();
  if (now - _policyAdminsAt < POLICY_TTL_MS) return _policyAdmins;
  try {
    const db = await getDb();
    const doc = await db
      .collection<{ _id: string; policy?: { adminEmails?: unknown } }>(AUTH_COLLECTION)
      .findOne({ _id: SETTINGS_ID }, { projection: { 'policy.adminEmails': 1 } });
    const list = doc?.policy?.adminEmails;
    _policyAdmins = new Set(
      Array.isArray(list)
        ? list.map((e) => String(e).trim().toLowerCase()).filter((e) => e && e.includes('@'))
        : []
    );
    _policyAdminsAt = now;
  } catch {
    // keep the previous snapshot
  }
  return _policyAdmins;
}

export async function resolveLiveRole(email: string): Promise<Role> {
  // Keep the permission OVERRIDE current before ANY rank/can() decision derived from this role takes
  // effect (mirrors eit_auth._sync_perms on the hot path) — so a customized __perms__ table that
  // remaps ranks/grants applies to live enforcement, not just the admin Permissions screen. TTL-cached
  // (30s) so this adds at most one extra read every 30s per process, never one per guard call.
  await syncPermsOverride();
  const e = normEmail(email);
  if (!e) return DEFAULT_ROLE;
  // Deploy-time admin override wins over everything (and can't be demoted by a directory write).
  if (isEnvAdmin(e)) return 'admin';
  // Access-policy admins (the editable __settings__ overlay) are admin the same way — additive to the
  // env allowlist, and also immune to a directory-role demotion (the policy is an admin authority).
  if ((await policyAdminEmails()).has(e)) return 'admin';
  const db = await getDb();
  // Directory (users) role is the authority. Type the collection with a string _id (the envelope
  // key is the email) so the driver doesn't default _id to ObjectId.
  const dir = await db
    .collection<{ _id: string; payload?: { role?: string; deletedAt?: number | null }; deletedAt?: number | null }>(USERS_COLLECTION)
    .findOne({ _id: e });
  if (dir) {
    // OFFBOARDED: a soft-deleted directory user is demoted to the floor role — NEVER fall through to
    // the auth-record role (that fallback let a deleted user keep elevated access; it was a HIGH in
    // the Python red-team too). Check BOTH the envelope and the payload tombstone (a peer / the /api
    // path can stamp deletedAt inside payload). A live session is demoted on its next guard call.
    if (dir.deletedAt || dir.payload?.deletedAt) return DEFAULT_ROLE;
    if (dir.payload?.role) return normalizeRole(dir.payload.role);
  }
  // Back-compat: the auth record's stored role (display snapshot for a pre-sync local account with
  // no directory entry yet).
  const auth = await db.collection<AuthDoc>(AUTH_COLLECTION).findOne({ _id: e });
  if (auth?.role) return normalizeRole(auth.role);
  return DEFAULT_ROLE;
}

// ── login result ──
export type LoginResult =
  | { ok: true; email: string; role: Role }
  | { ok: false; error: string; code: 401 | 429 | 503 | 400 }
  // The 2FA / forced-password seams (LATER wave). login() never returns these yet, but the
  // type documents where they slot in so the caller's switch is already exhaustive-ready.
  | { ok: false; pending: 'totp_required' | 'totp_setup_required' | 'must_change_password'; email: string };

/**
 * Verify email+password against the `auth` collection and resolve the live role.
 *
 * Faithful port of eit_auth._h_login's PASSWORD half:
 *   1. normalize email; require email+password.
 *   2. findOne auth by _id==email; a missing record OR a credential-less (pw==null) record =>
 *      generic 401 (no account-existence oracle; matches "invalid email or password").
 *   3. respect lockedUntil (=> 429). On a bad password we PERSIST the failure counter and, at the
 *      threshold (8), stamp lockedUntil (15 min) + reset the counter — the eit_auth lockout, ported.
 *   4. constant-time verifyPassword => 401 on mismatch.
 *   5. on success, the SESSION ROLE is the LIVE directory role (resolveLiveRole), NOT the auth
 *      doc's stored role — so a role set on any instance applies here (the live-DB model).
 *
 * The 2FA branch (rec.totp => pending2fa; rec.twofaRequired but no totp => setup2fa) and the
 * forced-password branch (rec.mustChangePassword) are surfaced as a `pending:` result so the caller
 * NEVER mints a full session past an enrolled second factor or forced rotation — the staging flow in
 * app/api/auth/* completes them. This is the security-critical seam: the server, not the client,
 * decides whether a full session is granted.
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  const e = normEmail(email);
  if (!e || !password) return { ok: false, error: 'email and password required', code: 400 };

  const db = await getDb().catch(() => null);
  if (!db) return { ok: false, error: 'auth store unreachable', code: 503 };
  const authCol = db.collection<AuthDoc>(AUTH_COLLECTION);

  let rec: AuthDoc | null;
  try {
    rec = await authCol.findOne({ _id: e });
  } catch {
    return { ok: false, error: 'auth store unreachable', code: 503 };
  }

  // No record OR no password set (SSO/credential-less) => generic invalid (no oracle).
  if (!rec || !rec.pw) return { ok: false, error: 'invalid email or password', code: 401 };

  const now = Math.floor(Date.now() / 1000);
  if (Number(rec.lockedUntil ?? 0) > now) {
    return { ok: false, error: 'account temporarily locked; try again later', code: 429 };
  }

  if (!verifyPassword(password, rec.pw)) {
    // Persist the failed-attempt counter; at the threshold stamp lockedUntil + reset (eit_auth port).
    const failed = Number(rec.failed ?? 0) + 1;
    const patch: Record<string, number> =
      failed >= LOCKOUT_THRESHOLD ? { failed: 0, lockedUntil: now + LOCKOUT_SECONDS } : { failed };
    try {
      await authCol.updateOne({ _id: e }, { $set: patch });
    } catch {
      /* best-effort; a write failure must not change the generic 401 below */
    }
    return { ok: false, error: 'invalid email or password', code: 401 };
  }

  // Password OK — clear any prior failure counter / lockout.
  if (rec.failed || rec.lockedUntil) {
    try {
      await authCol.updateOne({ _id: e }, { $set: { failed: 0, lockedUntil: 0 } });
    } catch {
      /* best-effort */
    }
  }

  // OFFBOARDED: refuse a soft-deleted directory user a NEW session (mirrors the Python's refusal of
  // a deleted user at sign-in). Checked only AFTER a correct password, so it's not an
  // account-existence oracle.
  try {
    const dirUser = await db
      .collection<{ _id: string; payload?: { deletedAt?: number | null }; deletedAt?: number | null }>(USERS_COLLECTION)
      .findOne({ _id: e });
    if (dirUser?.deletedAt || dirUser?.payload?.deletedAt) {
      return { ok: false, error: 'this account has been deactivated', code: 401 };
    }
  } catch {
    return { ok: false, error: 'auth store unreachable', code: 503 };
  }

  // Password OK. SECURITY SEAMS — never grant a full session past these (the staging flow completes
  // each one; we NEVER mint a full session here when any is set). ORDER matters: must-change first
  // (a temp password can't be bypassed by 2FA), then an enrolled second factor, then mandatory setup.
  if (rec.mustChangePassword) {
    return { ok: false, pending: 'must_change_password', email: e };
  }
  if (rec.totp) {
    return { ok: false, pending: 'totp_required', email: e };
  }
  // Mandatory TOTP enrollment applies to LOCAL-ONLY accounts. An account that can also sign in via
  // SSO/OIDC (it has a linked identity) gets its second factor from the IdP, so we don't force a TOTP
  // setup on its password path. (A pure-SSO account has no password and never reaches here.)
  const ssoLinked = (rec.oauthIdentities?.length ?? 0) > 0;
  if (rec.twofaRequired && !ssoLinked) {
    return { ok: false, pending: 'totp_setup_required', email: e };
  }

  // Full session: role = the LIVE directory role (the authoritative, synced session role).
  const role = await resolveLiveRole(e);
  return { ok: true, email: e, role };
}

// ── Server guards ────────────────────────────────────────────────────────────────────
// Use these in Server Components, Route Handlers, and Server Actions to enforce auth. They
// re-resolve the LIVE role on every call (no trust in the baked token's role) so a demotion
// takes effect immediately — the live-DB model.

export interface CurrentUser {
  email: string;
  role: Role; // the LIVE role (re-resolved), not the baked one
  session: SessionPayload;
}

/**
 * Require a signed-in user. Redirects to /login if there is no valid full session.
 * Returns the current user with the LIVE role re-resolved from the directory.
 */
export async function requireUser(): Promise<CurrentUser> {
  const session = await getSession();
  if (!session) redirect('/login');
  const role = await resolveLiveRole(session.sub);
  return { email: session.sub, role, session };
}

/**
 * Require AT LEAST `min` rank. Redirects unauthenticated users to /login and throws a
 * "Forbidden" error for an authenticated-but-under-ranked user (a 403 the route's error
 * boundary surfaces — distinct from the login redirect so an under-privileged user isn't
 * bounced to a login they're already past). Uses the LIVE role.
 */
export async function requireRole(min: Role): Promise<CurrentUser> {
  const user = await requireUser();
  if (rankOf(user.role) < rankOf(min)) {
    throw new Error(`Forbidden: requires role '${min}' or higher (you are '${user.role}')`);
  }
  return user;
}

/** Non-redirecting variant for Server Components that render a signed-out state inline
 *  (e.g. a nav that shows a Sign-in link). Returns null instead of redirecting. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getSession();
  if (!session) return null;
  const role = await resolveLiveRole(session.sub);
  return { email: session.sub, role, session };
}
