import 'server-only';
import { getDb } from './mongo';
import { denyInDemo } from './demo';
import {
  AUTH_COLLECTION,
  LOCKOUT_THRESHOLD,
  LOCKOUT_SECONDS,
  hashPassword,
  verifyPassword,
  resolveLiveRole,
  type AuthDoc,
  type PwRecord,
} from './auth';
import { generateTotpSecret, totpUri, verifyTotp, encSecret, decSecret, generateRecoveryCodes } from './totp';
import { normalizeRole, VALID_ROLES } from './rbac';
import type { Role } from './types';

// lib/auth-store.ts — the server-authoritative credential-store mutators for the 2FA / recovery /
// password / step-up flows. Everything here writes the `auth` collection (OFF the data-plane
// allowlist) and is reachable ONLY from app/api/auth Route Handlers that have already verified the
// caller's session/stage/step-up. This module is the single owner of how each secret is stored +
// compared, faithful to server/eit_auth.py:
//   • TOTP secret: AES-GCM-wrapped (lib/totp.encSecret) on auth.totp.secretEnc; pending enroll on
//     auth.totpPending until confirmed. Verified ±1 step (lib/totp.verifyTotp). Never leaves the
//     server except the one-time enroll QR/secret to the enrolling user.
//   • Recovery codes: 8 codes, HASHED (PBKDF2 — the same record as the password) at rest on
//     auth.recovery[], single-use (the matched hash is removed). Plaintext shown ONCE at generation.
//   • Password: PBKDF2 (lib/auth.hashPassword/verifyPassword) on auth.pw, constant-time.
//   • Per-surface lockout (login / totp / recovery / stepup) — separate counters so a holder of only
//     the session cookie can't DoS the victim's password login by spamming a different surface.

const norm = (e: unknown): string => String(e ?? '').trim().toLowerCase();

export async function getAuthRecord(email: string): Promise<AuthDoc | null> {
  const db = await getDb();
  return db.collection<AuthDoc>(AUTH_COLLECTION).findOne({ _id: norm(email) });
}

/** Patch fields on an auth doc (no upsert by default — a missing record is a no-op unless asked). */
async function patchAuth(email: string, set: Partial<AuthDoc> & Record<string, unknown>, upsert = false): Promise<boolean> {
  const db = await getDb();
  set.updatedAt = Date.now();
  const res = await db
    .collection<AuthDoc>(AUTH_COLLECTION)
    .updateOne({ _id: norm(email) }, { $set: set }, { upsert });
  return res.matchedCount > 0 || res.upsertedCount > 0;
}

// ── Per-surface lockout (login / totp / recovery / stepup) ──────────────────────────────────────
export type LockSurface = 'failed' | 'totpFailed' | 'recoveryFailed' | 'stepupFailed';
const LOCKED_FIELD: Record<LockSurface, keyof AuthDoc> = {
  failed: 'lockedUntil',
  totpFailed: 'totpLockedUntil',
  recoveryFailed: 'recoveryLockedUntil',
  stepupFailed: 'stepupLockedUntil',
};

/** True if `rec`'s surface is currently locked (lockedUntil in the future). */
export function isLocked(rec: AuthDoc, surface: LockSurface): boolean {
  const nowS = Math.floor(Date.now() / 1000);
  return Number(rec[LOCKED_FIELD[surface]] ?? 0) > nowS;
}

/** Record a failed attempt on a surface; at the threshold stamp the lockout + reset the counter. */
async function recordFailure(email: string, rec: AuthDoc, surface: LockSurface): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000);
  const failed = Number(rec[surface] ?? 0) + 1;
  const set: Record<string, number> =
    failed >= LOCKOUT_THRESHOLD
      ? { [surface]: 0, [LOCKED_FIELD[surface] as string]: nowS + LOCKOUT_SECONDS }
      : { [surface]: failed };
  await patchAuth(email, set).catch(() => {});
}

/** Clear a surface's failure counter + lockout (on a successful attempt). */
async function clearFailure(email: string, surface: LockSurface): Promise<void> {
  await patchAuth(email, { [surface]: 0, [LOCKED_FIELD[surface] as string]: 0 }).catch(() => {});
}

// ── full-session role resolution (env-admin force-stamp + live directory role) ──────────────────
// Mirrors eit_auth._issue_full_session: an operator-designated admin (EIT_ADMIN_EMAILS) is ALWAYS
// admin on THIS site, regardless of the synced directory role. resolveLiveRole already applies the
// env-admin override + the soft-delete floor, so we delegate to it. Also stamps lastLoginAt on the
// directory record (best-effort), like touch_last_login.
export async function roleForFullSession(email: string): Promise<Role> {
  return resolveLiveRole(norm(email));
}

export async function touchLastLogin(email: string): Promise<void> {
  const e = norm(email);
  try {
    const db = await getDb();
    const now = Date.now();
    await db
      .collection<{ _id: string; payload?: Record<string, unknown> }>('users')
      .updateOne({ _id: e }, { $set: { 'payload.lastLoginAt': now, 'payload.updatedAt': now, updatedAt: now } });
  } catch {
    /* best-effort; never blocks login */
  }
}

// ── Finish a login → mint + set the full session cookie ─────────────────────────────────────────
// THE single boundary that mints a stage:'full' session after a credential step (password+2FA,
// recovery, passkey, forced-pw-change). It re-checks the cross-cutting safety nets the Python applies
// at EVERY passwordless/2FA entry point so none can become a bypass:
//   • a soft-deleted (offboarded) directory user is refused a NEW session (resolveLiveRole floors a
//     deleted user to read-only AND we hard-refuse below),
//   • a still-flagged mustChangePassword account is refused a full session (the forced-rotation flow
//     must complete first) — defense-in-depth for the passwordless paths.
// Returns { ok:false } so the route can 403 without leaking which gate tripped. The src is carried so
// a passkey login is src:'local' (step-up works) and an SSO finish stays its oidc:* source.
export type FinishLoginResult =
  | { ok: true; email: string; role: Role; src: string }
  | { ok: false; reason: 'offboarded' | 'must_change_password' | 'no_account' };

export async function finishFullLogin(email: string, src = 'local'): Promise<FinishLoginResult> {
  const e = norm(email);
  const rec = await getAuthRecord(e);
  if (!rec) return { ok: false, reason: 'no_account' };
  // A pending forced password change must not be bypassable via 2FA/recovery/passkey (#6B safety net).
  if (rec.mustChangePassword) return { ok: false, reason: 'must_change_password' };
  // Offboarded refusal (checked AFTER the credential step, so it's not an existence oracle).
  try {
    const db = await getDb();
    const dir = await db
      .collection<{ _id: string; payload?: { deletedAt?: number | null }; deletedAt?: number | null }>('users')
      .findOne({ _id: e });
    if (dir?.deletedAt || dir?.payload?.deletedAt) return { ok: false, reason: 'offboarded' };
  } catch {
    /* a transient store error must not strand a verified login — fall through to role resolution,
       which itself reads the directory and floors a missing/deleted record to read-only */
  }
  const role = await roleForFullSession(e);
  await touchLastLogin(e);
  return { ok: true, email: e, role, src };
}

// ── TOTP enrollment ──────────────────────────────────────────────────────────────────────────
export interface TotpSetupResult {
  otpauthUri: string;
  secret: string; // shown ONCE to the enrolling user (their QR/manual key)
}

/**
 * Begin (or replace) TOTP enrollment: generate a fresh secret, stash it ENCRYPTED as totpPending, and
 * return the otpauth URI + plaintext secret for a LOCAL QR render (qrcode-generator on the client —
 * never a 3rd-party QR service). The caller MUST have already verified the session (setup2fa stage OR
 * a full local session) AND, when REPLACING an existing authenticator from a full session, a fresh
 * step-up (the route enforces that — a stolen cookie must not silently rotate the victim's TOTP). The
 * plaintext secret is returned ONCE here; it is otherwise only ever stored encrypted.
 */
export async function beginTotpSetup(email: string): Promise<TotpSetupResult> {
  const e = norm(email);
  const secret = generateTotpSecret();
  await patchAuth(e, { totpPending: encSecret(secret) }); // wrapped at rest; plaintext never persisted
  return { otpauthUri: totpUri(e, secret), secret };
}

export type TotpConfirmResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; error: string; code: 400 | 401 };

/**
 * Confirm TOTP enrollment with a 6-digit code: verify against the PENDING secret, then promote it to
 * the active factor and issue 8 fresh HASHED recovery codes (the plaintext returned ONCE). Mirrors
 * _h_totp_confirm. The caller has verified the session/stage.
 */
export async function confirmTotpSetup(email: string, code: string): Promise<TotpConfirmResult> {
  const e = norm(email);
  const rec = await getAuthRecord(e);
  if (!rec || !rec.totpPending) {
    return { ok: false, error: 'no pending TOTP setup; start enrollment first', code: 400 };
  }
  const secret = decSecret(rec.totpPending);
  if (!secret || !verifyTotp(secret, code)) {
    return { ok: false, error: 'invalid code', code: 401 };
  }
  const recoveryPlain = generateRecoveryCodes(8);
  const recoveryHashes = recoveryPlain.map((c) => hashPassword(c));
  await patchAuth(e, {
    totp: { secretEnc: rec.totpPending, confirmedAt: Date.now() },
    totpPending: null,
    recovery: recoveryHashes,
  });
  return { ok: true, recoveryCodes: recoveryPlain };
}

export type TotpVerifyResult =
  | { ok: true }
  | { ok: false; error: string; code: 400 | 401 | 429 };

/**
 * Verify a login-time 2FA code against the ACTIVE secret (the pending2fa stage). Rate-limited with
 * its own lockout counter so the second factor can't be online-brute-forced within a code's window.
 * Mirrors _h_totp_verify. The caller has verified the pending2fa staging token.
 */
export async function verifyLoginTotp(email: string, code: string): Promise<TotpVerifyResult> {
  const e = norm(email);
  const rec = await getAuthRecord(e);
  if (!rec || !rec.totp) return { ok: false, error: 'TOTP not enrolled', code: 400 };
  if (isLocked(rec, 'totpFailed')) return { ok: false, error: 'too many codes; try again later', code: 429 };
  const secret = decSecret(rec.totp.secretEnc);
  if (!secret || !verifyTotp(secret, code)) {
    await recordFailure(e, rec, 'totpFailed');
    return { ok: false, error: 'invalid code', code: 401 };
  }
  if (rec.totpFailed) await clearFailure(e, 'totpFailed');
  return { ok: true };
}

// ── Recovery-code login ────────────────────────────────────────────────────────────────────────
export type RecoveryResult =
  | { ok: true; remaining: number }
  | { ok: false; error: string; code: 400 | 401 | 404 | 429 };

/**
 * Sign in with a single-use recovery code (lost authenticator). Constant-time scan of the HASHED
 * codes; the matched hash is REMOVED (one-time). Rate-limited with its own lockout. Mirrors
 * _h_recovery. The caller has verified the pending2fa staging token (password already passed).
 */
export async function consumeRecoveryCode(email: string, code: string): Promise<RecoveryResult> {
  const e = norm(email);
  const clean = String(code ?? '').trim();
  if (!clean) return { ok: false, error: 'recovery code required', code: 400 };
  const rec = await getAuthRecord(e);
  if (!rec) return { ok: false, error: 'account not found', code: 404 };
  if (isLocked(rec, 'recoveryFailed')) return { ok: false, error: 'too many attempts; try again later', code: 429 };

  const remaining: PwRecord[] = Array.isArray(rec.recovery) ? [...rec.recovery] : [];
  // Constant-time-ish: verify against every stored hash (PBKDF2 is the constant-time compare); don't
  // early-return on the FIRST match in a way that leaks timing about position — verifyPassword is the
  // dominant cost and uniform per code, so scanning all and remembering the index is acceptable.
  let matchedIndex = -1;
  for (let i = 0; i < remaining.length; i++) {
    if (verifyPassword(clean, remaining[i])) matchedIndex = i;
  }
  if (matchedIndex < 0) {
    await recordFailure(e, rec, 'recoveryFailed');
    return { ok: false, error: 'invalid recovery code', code: 401 };
  }
  remaining.splice(matchedIndex, 1); // single-use
  await patchAuth(e, { recovery: remaining, recoveryFailed: 0, recoveryLockedUntil: 0 });
  return { ok: true, remaining: remaining.length };
}

/** Regenerate a fresh set of recovery codes (shown once). Requires an enrolled authenticator. */
export type RegenResult = { ok: true; recoveryCodes: string[] } | { ok: false; error: string; code: 400 | 404 };
export async function regenerateRecoveryCodes(email: string): Promise<RegenResult> {
  const e = norm(email);
  const rec = await getAuthRecord(e);
  if (!rec) return { ok: false, error: 'account not found', code: 404 };
  if (!rec.totp) return { ok: false, error: 'enroll an authenticator before generating recovery codes', code: 400 };
  const recoveryPlain = generateRecoveryCodes(8);
  await patchAuth(e, {
    recovery: recoveryPlain.map((c) => hashPassword(c)),
    recoveryFailed: 0,
    recoveryLockedUntil: 0,
  });
  return { ok: true, recoveryCodes: recoveryPlain };
}

// ── Password change / set-initial / forced-initial ──────────────────────────────────────────────
export type PwResult = { ok: true } | { ok: false; error: string; code: 400 | 401 | 404 | 409 };

/** Change your own password: verify the current one (PBKDF2), then store a fresh hash. */
export async function changePassword(email: string, oldPassword: string, newPassword: string): Promise<PwResult> {
  const e = norm(email);
  if (String(newPassword ?? '').length < 8) return { ok: false, error: 'new password must be at least 8 characters', code: 400 };
  const rec = await getAuthRecord(e);
  if (!rec || !verifyPassword(oldPassword, rec.pw ?? null)) {
    return { ok: false, error: 'current password is incorrect', code: 401 };
  }
  await patchAuth(e, { pw: hashPassword(newPassword) });
  return { ok: true };
}

/**
 * Set an INITIAL local password for an account that has NONE (the SSO-only case, #53). Set-ONLY —
 * refuses if a pw already exists. Provisions a credential record if missing. Mirrors _h_password_set;
 * the route then mints a fresh src:'local' full session so step-up works immediately.
 */
export async function setInitialPassword(email: string, sessRole: Role, newPassword: string): Promise<PwResult> {
  const e = norm(email);
  if (String(newPassword ?? '').length < 8) return { ok: false, error: 'new password must be at least 8 characters', code: 400 };
  const rec = (await getAuthRecord(e)) ?? null;
  if (rec?.pw) return { ok: false, error: 'a password is already set; use change password', code: 409 };
  const role = rec?.role && VALID_ROLES.has(rec.role) ? rec.role : sessRole;
  const now = Date.now();
  await patchAuth(
    e,
    {
      pw: hashPassword(newPassword),
      role,
      source: rec?.source ?? 'oidc',
      createdAt: rec?.createdAt ?? now,
    },
    true // upsert: a self-serve SSO sign-in may have no auth record yet
  );
  return { ok: true };
}

/**
 * Forced first-login password change (admin temp password, the mustchangepw stage). No old password
 * required (it was verified during the login that produced the change token). Server is the source of
 * truth: the flag must STILL be set (a valid token can't be replayed after the first change), and the
 * new password must differ from the temp one. Mirrors _h_password_initial.
 */
export async function setForcedInitialPassword(email: string, newPassword: string): Promise<PwResult> {
  const e = norm(email);
  if (String(newPassword ?? '').length < 8) return { ok: false, error: 'new password must be at least 8 characters', code: 400 };
  const rec = await getAuthRecord(e);
  if (!rec) return { ok: false, error: 'account not found', code: 404 };
  if (!rec.mustChangePassword) return { ok: false, error: 'password already set; sign in normally', code: 409 };
  if (verifyPassword(newPassword, rec.pw ?? null)) {
    return { ok: false, error: 'choose a different password than the temporary one', code: 400 };
  }
  // $unset the flag so a returning login takes the normal path; $set the fresh hash.
  const db = await getDb();
  await db
    .collection<AuthDoc>(AUTH_COLLECTION)
    .updateOne({ _id: e }, { $set: { pw: hashPassword(newPassword), updatedAt: Date.now() }, $unset: { mustChangePassword: '' } });
  return { ok: true };
}

// ── Step-up (re-auth with the current password) ────────────────────────────────────────────────
export type StepupResult = { ok: true } | { ok: false; error: string; code: 401 | 404 | 429 };

/**
 * Verify the current password to authorize minting a step-up token. Own lockout counter (separate
 * from login) so a holder of only the session cookie can't DoS the victim's normal login by spamming
 * wrong step-up passwords. Mirrors _h_stepup's password-check half (the route mints the token).
 */
export async function checkStepupPassword(email: string, password: string): Promise<StepupResult> {
  const e = norm(email);
  const rec = await getAuthRecord(e);
  if (!rec) return { ok: false, error: 'account not found', code: 404 };
  if (isLocked(rec, 'stepupFailed')) return { ok: false, error: 'too many attempts; try again later', code: 429 };
  if (!verifyPassword(password, rec.pw ?? null)) {
    await recordFailure(e, rec, 'stepupFailed');
    return { ok: false, error: 'password is incorrect', code: 401 };
  }
  if (rec.stepupFailed) await clearFailure(e, 'stepupFailed');
  return { ok: true };
}

// ── 2FA status (drives the Account → Security tab) ──────────────────────────────────────────────
export interface TwoFactorStatus {
  email: string;
  src: string;
  isLocal: boolean;
  hasPassword: boolean;
  twofaRequired: boolean;
  totpEnrolled: boolean;
  passkeyCount: number;
  recoveryRemaining: number;
  identities: { provider: string; email?: string; linkedAt?: number }[];
}

/** Report the CALLER's OWN factors (keyed on session email — never a param, so no IDOR). Mirrors
 *  _h_2fa_status; a self-serve SSO session with no auth record yet reports a no-factor posture. */
export async function twoFactorStatus(email: string, src: string): Promise<TwoFactorStatus> {
  const e = norm(email);
  const rec = (await getAuthRecord(e)) ?? ({} as AuthDoc);
  return {
    email: e,
    src,
    isLocal: src === 'local',
    hasPassword: Boolean(rec.pw),
    twofaRequired: Boolean(rec.twofaRequired),
    totpEnrolled: Boolean(rec.totp),
    passkeyCount: (rec.passkeys ?? []).length,
    recoveryRemaining: (rec.recovery ?? []).length,
    identities: (rec.oauthIdentities ?? []).map((i) => ({ provider: i.provider, email: i.email, linkedAt: i.linkedAt })),
  };
}

// ── Linked OIDC identities (list / unlink) ──────────────────────────────────────────────────────
export type UnlinkResult = { ok: true; remaining: number } | { ok: false; error: string; code: 400 | 404 };

/** Unlink an OIDC provider. NEVER allowed to strip the last sign-in method: a LOCAL account always
 *  keeps its password, so the route gates unlink to src==='local' (a password remains). Mirrors
 *  _h_identity_unlink. */
export async function unlinkIdentity(email: string, provider: string): Promise<UnlinkResult> {
  const e = norm(email);
  const p = String(provider ?? '').trim();
  if (!p) return { ok: false, error: 'provider required', code: 400 };
  const rec = await getAuthRecord(e);
  if (!rec) return { ok: false, error: 'account not found', code: 404 };
  const ids = rec.oauthIdentities ?? [];
  const kept = ids.filter((i) => i.provider !== p);
  if (kept.length === ids.length) return { ok: false, error: 'no such linked provider', code: 404 };
  await patchAuth(e, { oauthIdentities: kept });
  return { ok: true, remaining: kept.length };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// ADMIN USER-PROVISIONING (Config > Users) — the privilege surface; explicitly red-teamed.
// ════════════════════════════════════════════════════════════════════════════════════════════
// Faithful port of eit_auth's _h_register / _h_admin_reset / _h_account_delete (the local-account
// CRUD half — role assignment is NOT here; it stays setUserRole-only in lib/write). Every helper:
//   1. RE-CHECKS admin.users.local on the caller's LIVE role (resolveLiveRole) — never trusts a
//      passed-in/baked role, so a just-demoted admin loses these immediately. admin.users.local is
//      an admin-rank (4) capability, so this is effectively admin-only by the seeded table.
//   2. PINS the actor to the caller's SESSION email (passed by the Route Handler from getSession) —
//      the self-target refusals (delete-self) compare against THIS, never a client-supplied value.
//   3. NEVER writes `role` (role stays setUserRole-only; these write only credentials/flags/tombstone).
//   4. Forces a created/reset password to be a TEMP the user must rotate (mustChangePassword) and
//      drops re-entry vectors (passkeys + linked OAuth) on a reset, so a temp truly re-establishes
//      control — mirrors _h_admin_reset.
//   5. Pins the Mongo filter to a scalar _id (String()-coerced email) — the NoSQL-operator defense.
// A non-admin can NEVER reach these: the Route Handler 403s pre-call AND each re-checks here.

import { hashPassword as hashPw } from './auth';
import { rankOf } from './rbac';
import { getDb as _getDb } from './mongo';

const USERS_COLLECTION = 'users';

class AdminActionError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'AdminActionError';
  }
}

/** Re-resolve the actor's LIVE role and require admin.users.local (admin rank). Throws 403 otherwise.
 *  This is the single authority gate every admin helper below calls FIRST — defense in depth on top
 *  of the Route Handler's own admin check. */
async function requireAdminActor(actorEmail: string): Promise<string> {
  const actor = norm(actorEmail);
  if (!actor) throw new AdminActionError(401, 'sign in required');
  const role = await resolveLiveRole(actor);
  // admin.users.local is rank 4 (admin). Gate on the live role's rank meeting admin — never trust a
  // passed-in role. (Equivalent to can('admin.users.local', role) since the cap is non-ctx admin-rank.)
  if (rankOf(role) < rankOf('admin')) {
    throw new AdminActionError(403, 'an admin session is required');
  }
  return actor;
}

/** Provision the `users` directory record for a local account (so it shows immediately, not only
 *  after first login). Best-effort upsert; NEVER overwrites a richer existing record's name. Mirrors
 *  provision_directory_user. Role is written here ONLY at account-creation time (the admin chose it)
 *  — this is the create flow, distinct from the immutable /db role rule. */
async function provisionDirectoryUser(email: string, role: Role, name: string): Promise<void> {
  try {
    const db = await _getDb();
    const now = Date.now();
    const set: Record<string, unknown> = {
      'payload.email': email,
      'payload.role': role,
      'payload.source': 'local',
      'payload.updatedAt': now,
      updatedAt: now,
    };
    if (name.trim()) set['payload.name'] = name.trim();
    await db.collection<{ _id: string }>(USERS_COLLECTION).updateOne(
      { _id: email },
      { $set: set, $setOnInsert: { _id: email, createdAt: now } },
      { upsert: true }
    );
  } catch {
    /* best-effort; never blocks account creation */
  }
}

export interface AdminCreateAccountResult {
  ok: true;
  email: string;
  role: Role;
  needsTotpSetup: boolean;
}

/**
 * Create a LOCAL sign-in account for a directory user (the OPTIONAL "create a local account with a
 * temp password" path on Add user). ADMIN-ONLY. The supplied password is a TEMP the user MUST rotate
 * at first sign-in (mustChangePassword + #6B). The account is force-flagged twofaRequired so the user
 * enrolls a second factor. Refuses if a credentialed account already exists (409). Mirrors _h_register's
 * admin-provisioned branch (NOT bootstrap — there is no bootstrap path here).
 *
 * SECURITY: never mints an admin via this path implicitly — the role defaults to least-privilege
 * ('read-only') and is clamped to VALID_ROLES; a higher role must be assigned separately via the
 * red-teamed setUserRole (which role-raise-guards). The temp password is the only secret and it's a
 * one-time credential; nothing is logged/returned beyond the email + role.
 */
export async function adminCreateLocalAccount({
  targetEmail,
  name,
  role,
  tempPassword,
  twofaRequired = true,
  actorEmail,
}: {
  targetEmail: string;
  name?: string;
  role?: string;
  tempPassword: string;
  twofaRequired?: boolean;
  actorEmail: string;
}): Promise<AdminCreateAccountResult> {
  denyInDemo('User provisioning');
  await requireAdminActor(actorEmail);
  const email = norm(targetEmail);
  if (!email || !email.includes('@')) throw new AdminActionError(400, 'a valid email is required');
  if (String(tempPassword ?? '').length < 8) throw new AdminActionError(400, 'the temporary password must be at least 8 characters');
  // Role defaults to least-privilege; an unknown role is clamped to read-only (NEVER silently admin).
  const r = String(role ?? '').trim().toLowerCase();
  const finalRole: Role = (VALID_ROLES.has(r) ? r : 'read-only') as Role;

  const existing = await getAuthRecord(email);
  if (existing?.pw) throw new AdminActionError(409, 'an account with that email already exists');

  const now = Date.now();
  // Provision (or upgrade a credential-less SSO record) WITHOUT touching unrelated fields. A fresh
  // create writes the full credential record; an existing credential-less record gets a pw + the
  // forced-rotation flag. We $set only credential/flag fields — never PII.
  await patchAuth(
    email,
    {
      pw: hashPw(tempPassword),
      role: finalRole,
      source: existing?.source ?? 'local',
      twofaRequired: Boolean(twofaRequired),
      mustChangePassword: true, // admin-set temp → forced rotation at first sign-in (#6B)
      failed: 0,
      lockedUntil: 0,
      createdAt: existing?.createdAt ?? now,
      createdBy: norm(actorEmail),
    } as Partial<AuthDoc> & Record<string, unknown>,
    true // upsert: a self-serve SSO sign-in may have no auth record yet
  );
  await provisionDirectoryUser(email, finalRole, name ?? '');
  return { ok: true, email, role: finalRole, needsTotpSetup: Boolean(twofaRequired) };
}

export interface AdminResetResult {
  ok: true;
  email: string;
  cleared2fa: boolean;
}

/**
 * Admin force-reset of ANOTHER account's password (also "Set local password" for an SSO/credential-less
 * user). ADMIN-ONLY. Sets a TEMP password (mustChangePassword) and, by default, CLEARS 2FA so the user
 * re-enrolls. Drops ALL non-password re-entry vectors (passkeys + linked OAuth identities) so the reset
 * truly re-establishes control via the admin-issued temp — neither a lingering passkey nor a federated
 * sign-in can bypass the forced change. Mirrors _h_admin_reset.
 *
 * For an SSO/credential-less directory user with NO auth record, this PROVISIONS one (so the admin can
 * set an initial local password) — but REFUSES a soft-deleted directory user (provisioning a credential
 * for an offboarded account would silently resurrect it as loginable — the Python red-team low finding).
 */
export async function adminResetPassword({
  targetEmail,
  tempPassword,
  clear2fa = true,
  actorEmail,
}: {
  targetEmail: string;
  tempPassword: string;
  clear2fa?: boolean;
  actorEmail: string;
}): Promise<AdminResetResult> {
  denyInDemo('User provisioning');
  await requireAdminActor(actorEmail);
  const email = norm(targetEmail);
  if (!email || String(tempPassword ?? '').length < 8) {
    throw new AdminActionError(400, 'email and a >= 8 character temp password are required');
  }

  const existing = await getAuthRecord(email);
  if (!existing) {
    // No credential record → provision one ONLY for a LIVE directory user (refuse a soft-deleted one).
    const db = await _getDb();
    const dir = await db
      .collection<{ _id: string; payload?: { deletedAt?: number | null }; deletedAt?: number | null }>(USERS_COLLECTION)
      .findOne({ _id: email });
    if (!dir || dir.deletedAt || dir.payload?.deletedAt) throw new AdminActionError(404, 'account not found');
  }

  const patch: Partial<AuthDoc> & Record<string, unknown> = {
    pw: hashPw(tempPassword),
    failed: 0,
    lockedUntil: 0,
    mustChangePassword: true,
    passkeys: [],
    oauthIdentities: [],
  };
  if (clear2fa) {
    patch.totp = null;
    patch.totpPending = null;
    patch.recovery = [];
    patch.totpFailed = 0;
    patch.totpLockedUntil = 0;
  }
  // upsert so the SSO-provisioned (no-record) case writes a fresh credential record.
  await patchAuth(email, patch, true);
  return { ok: true, email, cleared2fa: Boolean(clear2fa) };
}

/**
 * Clear an account's 2FA enrollment WITHOUT touching the password (the standalone "Clear 2FA" action).
 * ADMIN-ONLY. Removes the TOTP factor + pending enroll + recovery codes + the 2FA lockout counters, so
 * the user is prompted to re-enroll. A no-op success if there's no auth record. Never writes role/PII.
 */
export async function adminClear2fa({
  targetEmail,
  actorEmail,
}: {
  targetEmail: string;
  actorEmail: string;
}): Promise<{ ok: true; email: string }> {
  denyInDemo('User provisioning');
  await requireAdminActor(actorEmail);
  const email = norm(targetEmail);
  if (!email) throw new AdminActionError(400, 'email required');
  await patchAuth(email, {
    totp: null,
    totpPending: null,
    recovery: [],
    totpFailed: 0,
    totpLockedUntil: 0,
  } as Partial<AuthDoc> & Record<string, unknown>);
  return { ok: true, email };
}

/**
 * Delete a directory user (offboard). ADMIN-ONLY. SELF-DELETE is REFUSED (an admin can't lock
 * themselves out / be tricked into a self-delete — pinned to the SESSION email). We SOFT-DELETE
 * (stamp deletedAt on the directory record) so the tombstone REPLICATES to peers (the live-DB / sync
 * model — a hard row drop wouldn't), and we ALSO delete the local credential record (a hard delete of
 * the `auth` doc, mirroring _h_account_delete) so no stale password can authenticate. resolveLiveRole
 * already floors a tombstoned directory user to read-only AND login()/SSO refuse them — so any live
 * session is demoted + a new login refused on the next call.
 */
export async function deleteDirectoryUser({
  targetEmail,
  actorEmail,
}: {
  targetEmail: string;
  actorEmail: string;
}): Promise<{ ok: true; email: string }> {
  denyInDemo('User provisioning');
  const actor = await requireAdminActor(actorEmail);
  const email = norm(targetEmail);
  if (!email) throw new AdminActionError(400, 'email required');
  if (email === actor) throw new AdminActionError(400, "you can't delete your own account");

  const db = await _getDb();
  const now = Date.now();
  // Soft-delete the directory record (tombstone replicates). Pinned to a scalar _id.
  await db
    .collection<{ _id: string }>(USERS_COLLECTION)
    .updateOne({ _id: email }, { $set: { 'payload.deletedAt': now, 'payload.updatedAt': now, deletedAt: now, updatedAt: now } });
  // Hard-delete the credential record so a stale local password can't authenticate (mirrors the
  // Python deleteOne on the `auth` store). Best-effort — the directory tombstone is the real gate.
  try {
    await db.collection<AuthDoc>(AUTH_COLLECTION).deleteOne({ _id: email });
  } catch {
    /* best-effort */
  }
  return { ok: true, email };
}

// ── Local-account credential posture (Config > Users control labels) ────────────────────────────
// Faithful to _h_accounts: a per-account, SECRET-FREE projection so the Users panel can pick the
// right control label (SSO/credential-less "Set local password" vs local "Reset password + clear
// 2FA") and show the 2FA/lock posture. ONLY booleans cross the wire — never a hash. Settings docs
// (__policy__/__perms__/…) are excluded (they're not accounts). Admin-only — the caller (the config
// page) is already admin-gated; this is a pure read, no mutation.
export interface AccountPosture {
  email: string;
  hasPassword: boolean;
  twofaEnrolled: boolean;
  source: string;
  locked: boolean;
}

const SETTINGS_IDS = new Set(['__policy__', '__smtp__', '__appconfig__', '__perms__']);

export async function getAccountPostures(): Promise<Map<string, AccountPosture>> {
  const out = new Map<string, AccountPosture>();
  try {
    const db = await _getDb();
    const docs = await db
      .collection<AuthDoc>(AUTH_COLLECTION)
      .find({}, { projection: { _id: 1, pw: 1, totp: 1, source: 1, lockedUntil: 1 } })
      .toArray();
    const nowS = Math.floor(Date.now() / 1000);
    for (const d of docs) {
      if (SETTINGS_IDS.has(d._id)) continue;
      out.set(d._id, {
        email: d._id,
        hasPassword: d.pw != null,
        twofaEnrolled: Boolean(d.totp),
        source: d.source || 'local',
        locked: Number(d.lockedUntil ?? 0) > nowS,
      });
    }
  } catch {
    /* best-effort; an unreadable auth store just means no posture badges */
  }
  return out;
}

export { AdminActionError };

export { norm as normEmail };
export { normalizeRole };
