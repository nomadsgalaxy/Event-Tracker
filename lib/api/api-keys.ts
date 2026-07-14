import 'server-only';
import crypto from 'node:crypto';
import { getDb } from '@/lib/db/mongo';
import { AUTH_COLLECTION, hashPassword, verifyPasswordAsync, resolveLiveRole, type AuthDoc, type PwRecord } from '@/lib/auth/auth';
import { effectiveGrants, CAPS, dangerousCaps } from '@/lib/auth/rbac';
import type { Role } from '@/lib/types/types';

// lib/api/api-keys.ts — caller-scoped, user-bound API keys (mirrors server/eit_api.py key management).
//
// A key is `eitk_<id>.<secret>`. ONLY the SECRET HALF is sensitive and it is stored HASHED (the SAME
// PBKDF2 record the password uses) on the auth doc apiKeys[]; the plaintext token is returned ONCE at
// creation and never again. Listing returns id/label/caps/timestamps — never the hash. Create requires
// a full LOCAL session + a fresh STEP-UP (the route enforces both).
//
// SCOPE MODEL (the security contract — red-team this):
//   • A key carries a SET of capability ids (caps[]) drawn from lib/rbac. At CREATE time the requested
//     set is CLAMPED to the owner's LIVE caps (a cap the owner lacks is silently dropped — fail closed),
//     so the persisted caps[] is always a subset of what the owner could do then.
//   • On EVERY request verifyApiKey RE-INTERSECTS the stored caps[] with the owner's LIVE role caps:
//     effective = caps[] ∩ liveCaps. Demote the owner (directory role lowered, or an admin __perms__
//     override narrowing a role) and every key they hold instantly narrows — the stored caps[] never
//     widen the key. A key can never exceed its owner.
//   • Context grants (self / lead-of-event) are NOT baked into caps[] — they're evaluated per-request
//     against the target record by the route's keyCan() helper, exactly as the UI's can() does.
//   • Back-compat: a key created before caps[] carries only a coarse scope:'read'|'write'; it maps to a
//     derived cap set on read (coarseScopeCaps) so old keys keep working (recreate for fine scoping).

export const TOKEN_PREFIX = 'eitk_';
export const MAX_KEYS_PER_USER = 25;

const norm = (e: unknown): string => String(e ?? '').trim().toLowerCase();

export interface StoredApiKey {
  id: string;
  label: string;
  /** Coarse legacy scope (kept as a display alias + back-compat for pre-caps keys). */
  scope: 'read' | 'write';
  /** The capability ids this key is scoped to (a subset of the owner's caps at creation). */
  caps?: string[];
  hash: PwRecord; // PBKDF2 of the secret half — never returned
  createdAt?: number;
  lastUsedAt?: number | null;
}

export interface PublicApiKey {
  id: string;
  label: string;
  scope: string;
  caps: string[];
  createdAt?: number;
  lastUsedAt?: number | null;
}

// Coarse legacy scope -> a capability set, for keys minted before caps[] existed. Conservative: 'read'
// is the data-plane read gate only; 'write' adds the general write caps. verifyApiKey ALWAYS re-
// intersects this with the owner's live caps, so an over-broad map can never exceed the owner.
const LEGACY_READ_CAPS: readonly string[] = ['db.read.session'];
const LEGACY_WRITE_CAPS: readonly string[] = [
  'db.read.session',
  'db.write.app',
  'event.create',
  'event.edit',
  'event.delete',
  'pallets.edit',
  'scan.pack',
  'scan.label',
  'signoff.view',
  'signoff.commit',
  'signoff.revert',
  'looseitem.manage',
  'tags.apply',
  'tags.edit',
  'tags.delete',
  'staff.pii.view',
  'accommodations.view',
  'accommodations.edit',
  'emergency_contact.read',
  'emergency_contact.write',
];

function coarseScopeCaps(scope: unknown): string[] {
  return scope === 'write' ? [...LEGACY_WRITE_CAPS] : [...LEGACY_READ_CAPS];
}

/** The capability ids a stored key is scoped to: its explicit caps[] when present, else the coarse-scope
 *  back-compat set. Filtered to KNOWN caps (a removed/renamed cap id is dropped — fail closed). */
function storedCapList(k: StoredApiKey): string[] {
  const raw = Array.isArray(k.caps) ? k.caps : coarseScopeCaps(k.scope);
  return [...new Set(raw.map((c) => String(c)).filter((c) => Object.prototype.hasOwnProperty.call(CAPS, c)))];
}

// A write cap (for the 'read'|'write' display alias only — enforcement is per-cap, never this label).
const WRITE_CAP_IDS: ReadonlySet<string> = new Set(LEGACY_WRITE_CAPS.filter((c) => c !== 'db.read.session'));
function scopeLabelFor(caps: string[]): 'read' | 'write' {
  return caps.some((c) => WRITE_CAP_IDS.has(c)) ? 'write' : 'read';
}

function publicKey(k: StoredApiKey): PublicApiKey {
  const caps = storedCapList(k);
  return { id: k.id, label: k.label, scope: scopeLabelFor(caps), caps, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt ?? null };
}

async function rec(email: string): Promise<AuthDoc | null> {
  const db = await getDb();
  return db.collection<AuthDoc>(AUTH_COLLECTION).findOne({ _id: norm(email) });
}

/** Resolve the owner's LIVE role + the full capability set that role currently holds (the ceiling a key
 *  can be scoped to). resolveLiveRole runs syncPermsOverride first, so effectiveGrants() is current. */
export async function ownerLiveCaps(email: string): Promise<{ role: Role; caps: string[] }> {
  const role = await resolveLiveRole(email);
  const set = effectiveGrants()[role] ?? new Set<string>();
  return { role, caps: [...set].sort() };
}

export async function listApiKeys(
  email: string
): Promise<{ keys: PublicApiKey[]; tokenPrefix: string; role: Role; ownerCaps: string[] }> {
  const r = await rec(email);
  const { role, caps } = await ownerLiveCaps(email);
  return {
    keys: ((r?.apiKeys as StoredApiKey[] | undefined) ?? []).map(publicKey),
    tokenPrefix: TOKEN_PREFIX,
    role,
    ownerCaps: caps,
  };
}

/** One row of the admin Config > API oversight table: a key + who owns (minted) it. Public shape
 *  only — never the hash. */
export interface AdminApiKeyRow extends PublicApiKey {
  owner: string;
}

/** Every API key on the deployment, newest first — the admin oversight read (Config > API). */
export async function listAllApiKeys(): Promise<AdminApiKeyRow[]> {
  const db = await getDb();
  const docs = await db
    .collection<AuthDoc>(AUTH_COLLECTION)
    .find({ 'apiKeys.0': { $exists: true } } as never)
    .toArray();
  const rows: AdminApiKeyRow[] = [];
  for (const d of docs) {
    for (const k of (d.apiKeys as StoredApiKey[] | undefined) ?? []) {
      rows.push({ owner: String(d._id), ...publicKey(k) });
    }
  }
  return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export type CreateKeyResult =
  | { ok: true; id: string; label: string; scope: string; caps: string[]; token: string }
  | { ok: false; error: string; code: 400 | 404 };

/** Create a new API key. The plaintext token is returned ONCE; only the secret's PBKDF2 hash is stored.
 *  The requested caps are CLAMPED to the owner's live caps (a cap the owner lacks is dropped). With no
 *  caps and no legacy scope the key defaults to READ-ONLY (least privilege). The ROUTE must have
 *  verified the full LOCAL session + a fresh step-up. */
export async function createApiKey(
  email: string,
  label: string,
  opts: { caps?: unknown; scope?: unknown; acknowledgeRisk?: boolean }
): Promise<CreateKeyResult> {
  const e = norm(email);
  const r = await rec(e);
  if (!r) return { ok: false, error: 'account not found', code: 404 };
  const keys: StoredApiKey[] = (r.apiKeys as StoredApiKey[] | undefined) ?? [];
  if (keys.length >= MAX_KEYS_PER_USER) {
    return { ok: false, error: `too many API keys (max ${MAX_KEYS_PER_USER}) — revoke one first`, code: 400 };
  }
  const cleanLabel = String(label ?? 'API key').trim().slice(0, 80) || 'API key';

  // The owner's live caps are the ceiling. Resolve them ONCE here for the clamp.
  const { caps: ownerCaps } = await ownerLiveCaps(e);
  const ownerSet = new Set(ownerCaps);

  // Requested caps: an explicit list wins; else a legacy coarse scope; else read-only.
  let requested: string[];
  if (Array.isArray(opts.caps)) {
    requested = opts.caps.map((c) => String(c));
  } else if (opts.scope === 'read' || opts.scope === 'write') {
    requested = coarseScopeCaps(opts.scope);
  } else {
    requested = [...LEGACY_READ_CAPS];
  }

  // Clamp: keep only KNOWN caps the owner actually holds (fail closed — never widen). Always fold in
  // db.read.session when the owner has it so the key can read what it can act on (whoami works regardless).
  const clamped = new Set(
    requested.filter((c) => Object.prototype.hasOwnProperty.call(CAPS, c) && ownerSet.has(c))
  );
  if (ownerSet.has('db.read.session')) clamped.add('db.read.session');
  const caps = [...clamped].sort();

  // ADMINISTRATIVE or DESTRUCTIVE caps require an EXPLICIT risk acknowledgement, even though step-up is
  // already enforced by the route. The UI shows the "are you sure / back up your DB" confirmation before
  // sending acknowledgeRisk:true; a direct API call to mint such a key must opt in the same way. This is
  // the server-side half of the gate, so the warning can't be bypassed by skipping the dialog.
  const danger = dangerousCaps(caps);
  if (danger.length > 0 && opts.acknowledgeRisk !== true) {
    return {
      ok: false,
      error: `this key would grant administrative or deletion access (${danger.join(', ')}) — confirm the risk to create it`,
      code: 400,
    };
  }

  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const scope = scopeLabelFor(caps);
  const entry: StoredApiKey = { id, label: cleanLabel, scope, caps, hash: hashPassword(secret), createdAt: Date.now(), lastUsedAt: null };

  // Atomic $push (not a whole-array $set) so a concurrent create/revoke can't silently undo this
  // write or resurrect a just-revoked key (the read-modify-write race).
  const db = await getDb();
  await db
    .collection<AuthDoc>(AUTH_COLLECTION)
    .updateOne({ _id: e }, { $push: { apiKeys: entry }, $set: { updatedAt: Date.now() } } as never);
  const token = `${TOKEN_PREFIX}${id}.${secret}`;
  return { ok: true, id, label: cleanLabel, scope, caps, token };
}

export type RevokeKeyResult = { ok: true; revoked: string; removed: number } | { ok: false; error: string; code: 400 | 404 };

/** Revoke a key by id (own session — no step-up needed, revocation is fail-safe). */
export async function revokeApiKey(email: string, id: string): Promise<RevokeKeyResult> {
  const e = norm(email);
  const keyId = String(id ?? '').trim();
  if (!keyId) return { ok: false, error: 'id required', code: 400 };
  const r = await rec(e);
  if (!r) return { ok: false, error: 'account not found', code: 404 };
  // Atomic $pull so a concurrent create's array write can't resurrect the revoked key.
  const db = await getDb();
  const res = await db
    .collection<AuthDoc>(AUTH_COLLECTION)
    .updateOne({ _id: e }, { $pull: { apiKeys: { id: keyId } }, $set: { updatedAt: Date.now() } } as never);
  return { ok: true, revoked: keyId, removed: res.modifiedCount > 0 ? 1 : 0 };
}

// ── Verification (the REST consumer path) ─────────────────────────────────────────────────────────
export interface VerifiedKey {
  ownerEmail: string;
  role: Role; // the owner's LIVE role (re-resolved this request)
  storedCaps: Set<string>; // the key's scoped caps (the subset chosen at creation)
  effectiveCaps: Set<string>; // storedCaps ∩ liveRoleCaps — the role-granted ceiling for display
  keyId: string;
  label: string;
}

// A fixed dummy PBKDF2 record so a "no such key" path spends comparable time to a real verify — closes
// the timing oracle that would otherwise distinguish an unknown id from a bad secret.
const DUMMY_HASH: PwRecord = hashPassword('eit-dummy-verify-constant');

// Ensure the multikey index on apiKeys.id ONCE per process (without it, the owner lookup is an O(n) scan
// of the auth collection on every API request — a DoS vector). Cached so verify never re-issues it.
let _indexPromise: Promise<void> | null = null;
async function ensureApiKeyIndex(): Promise<void> {
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      const db = await getDb();
      await db.collection<AuthDoc>(AUTH_COLLECTION).createIndex({ 'apiKeys.id': 1 }, { name: 'apiKeys_id' });
    } catch {
      _indexPromise = null; // let a later call retry if the index build failed
    }
  })();
  return _indexPromise;
}

/**
 * Verify an `eitk_<id>.<secret>` token. Returns the owner + the key's effective grant, or null on ANY
 * failure (malformed / unknown id / bad secret / collision) — all the SAME generic null, with a dummy
 * PBKDF2 on a miss so there's no timing oracle. NEVER throws. Updates lastUsedAt best-effort.
 */
export async function verifyApiKey(token: unknown): Promise<VerifiedKey | null> {
  const t = String(token ?? '');
  if (!t.startsWith(TOKEN_PREFIX)) return null;
  const rest = t.slice(TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const id = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!id || !secret) return null;

  let docs: AuthDoc[] = [];
  try {
    await ensureApiKeyIndex();
    const db = await getDb();
    // limit 2: a second match means an id collision across accounts -> fail closed (never guess an owner).
    docs = await db.collection<AuthDoc>(AUTH_COLLECTION).find({ 'apiKeys.id': id }).limit(2).toArray();
  } catch {
    return null;
  }

  // Resolve the single matching key entry (and reject id collisions).
  let owner: AuthDoc | null = null;
  let entry: StoredApiKey | null = null;
  if (docs.length === 1) {
    const matches = ((docs[0].apiKeys as StoredApiKey[] | undefined) ?? []).filter((k) => k.id === id);
    if (matches.length === 1) {
      owner = docs[0];
      entry = matches[0];
    }
  }

  if (!owner || !entry) {
    await verifyPasswordAsync(secret, DUMMY_HASH); // equalize timing on a miss (no oracle), non-blocking
    return null;
  }

  if (!(await verifyPasswordAsync(secret, entry.hash))) return null;

  const ownerEmail = norm(owner._id);

  // An OFFBOARDED (soft-deleted) owner's keys die with the account. The auth-doc hard-delete on
  // offboarding is best-effort, so the directory tombstone is the authority — resolveLiveRole only
  // FLOORS a deleted user to read-only, which would still leave read caps alive.
  try {
    const db = await getDb();
    const dir = await db
      .collection<{ _id: string; payload?: { deletedAt?: number | null; offboardedAt?: number | null }; deletedAt?: number | null }>('users')
      .findOne({ _id: ownerEmail }, { projection: { deletedAt: 1, 'payload.deletedAt': 1, 'payload.offboardedAt': 1 } });
    if (dir && (dir.deletedAt || dir.payload?.deletedAt || dir.payload?.offboardedAt)) return null;
  } catch {
    return null; // fail closed: can't prove the owner is live
  }

  const role = await resolveLiveRole(ownerEmail);
  const liveCaps = effectiveGrants()[role] ?? new Set<string>();
  const storedCaps = new Set(storedCapList(entry));
  const effectiveCaps = new Set([...storedCaps].filter((c) => liveCaps.has(c)));

  // Best-effort lastUsedAt — never block or fail the request on it.
  try {
    const db = await getDb();
    await db
      .collection<AuthDoc>(AUTH_COLLECTION)
      .updateOne({ _id: ownerEmail, 'apiKeys.id': id }, { $set: { 'apiKeys.$.lastUsedAt': Date.now() } });
  } catch {
    /* ignore */
  }

  return { ownerEmail, role, storedCaps, effectiveCaps, keyId: id, label: entry.label };
}
