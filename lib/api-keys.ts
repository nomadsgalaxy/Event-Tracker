import 'server-only';
import crypto from 'node:crypto';
import { getDb } from './mongo';
import { AUTH_COLLECTION, hashPassword, type AuthDoc, type PwRecord } from './auth';

// lib/api-keys.ts — caller-scoped, user-bound API keys (mirrors server/eit_api.py key management).
//
// A key is `eitk_<id>.<secret>`. ONLY the SECRET HALF is sensitive and it is stored HASHED (the SAME
// PBKDF2 record the password uses) on the auth doc apiKeys[]; the plaintext token is returned ONCE at
// creation and never again. Listing returns id/label/scope/timestamps — never the hash. Create
// requires a full LOCAL session + a fresh STEP-UP (the route enforces both). A key carries a scope
// ('read' | 'write') the data API checks alongside the user's live role.

export const TOKEN_PREFIX = 'eitk_';
export const MAX_KEYS_PER_USER = 25;

const norm = (e: unknown): string => String(e ?? '').trim().toLowerCase();

export interface StoredApiKey {
  id: string;
  label: string;
  scope: 'read' | 'write';
  hash: PwRecord; // PBKDF2 of the secret half — never returned
  createdAt?: number;
  lastUsedAt?: number | null;
}

export interface PublicApiKey {
  id: string;
  label: string;
  scope: string;
  createdAt?: number;
  lastUsedAt?: number | null;
}

function publicKey(k: StoredApiKey): PublicApiKey {
  return { id: k.id, label: k.label, scope: k.scope, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt ?? null };
}

async function rec(email: string): Promise<AuthDoc | null> {
  const db = await getDb();
  return db.collection<AuthDoc>(AUTH_COLLECTION).findOne({ _id: norm(email) });
}

export async function listApiKeys(email: string): Promise<{ keys: PublicApiKey[]; tokenPrefix: string }> {
  const r = await rec(email);
  return { keys: ((r?.apiKeys as StoredApiKey[] | undefined) ?? []).map(publicKey), tokenPrefix: TOKEN_PREFIX };
}

export type CreateKeyResult =
  | { ok: true; id: string; label: string; scope: string; token: string }
  | { ok: false; error: string; code: 400 | 404 };

/** Create a new API key. The plaintext token is returned ONCE; only the secret's PBKDF2 hash is
 *  stored. The ROUTE must have verified the full LOCAL session + a fresh step-up. */
export async function createApiKey(email: string, label: string, scope: unknown): Promise<CreateKeyResult> {
  const e = norm(email);
  const r = await rec(e);
  if (!r) return { ok: false, error: 'account not found', code: 404 };
  const keys: StoredApiKey[] = (r.apiKeys as StoredApiKey[] | undefined) ?? [];
  if (keys.length >= MAX_KEYS_PER_USER) {
    return { ok: false, error: `too many API keys (max ${MAX_KEYS_PER_USER}) — revoke one first`, code: 400 };
  }
  const cleanLabel = String(label ?? 'API key').trim().slice(0, 80) || 'API key';
  const cleanScope: 'read' | 'write' = scope === 'write' ? 'write' : 'read';
  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  keys.push({ id, label: cleanLabel, scope: cleanScope, hash: hashPassword(secret), createdAt: Date.now(), lastUsedAt: null });

  const db = await getDb();
  await db.collection<AuthDoc>(AUTH_COLLECTION).updateOne({ _id: e }, { $set: { apiKeys: keys, updatedAt: Date.now() } });
  const token = `${TOKEN_PREFIX}${id}.${secret}`;
  return { ok: true, id, label: cleanLabel, scope: cleanScope, token };
}

export type RevokeKeyResult = { ok: true; revoked: string; removed: number } | { ok: false; error: string; code: 400 | 404 };

/** Revoke a key by id (own session — no step-up needed, revocation is fail-safe). */
export async function revokeApiKey(email: string, id: string): Promise<RevokeKeyResult> {
  const e = norm(email);
  const keyId = String(id ?? '').trim();
  if (!keyId) return { ok: false, error: 'id required', code: 400 };
  const r = await rec(e);
  if (!r) return { ok: false, error: 'account not found', code: 404 };
  const before: StoredApiKey[] = (r.apiKeys as StoredApiKey[] | undefined) ?? [];
  const after = before.filter((k) => k.id !== keyId);
  const db = await getDb();
  await db.collection<AuthDoc>(AUTH_COLLECTION).updateOne({ _id: e }, { $set: { apiKeys: after, updatedAt: Date.now() } });
  return { ok: true, revoked: keyId, removed: before.length - after.length };
}
