import 'server-only';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import { rankOf } from '@/lib/auth/rbac';
import { keyCan, requireScope } from '@/lib/api/api-v1';
import { stripEventForKey } from '@/lib/api/api-v1-serialize';
import type { VerifiedKey } from '@/lib/api/api-keys';
import {
  createEvent,
  saveEvent,
  softDeleteEvent,
  createCase,
  saveCase,
  retireOrDeleteCase,
  createInventoryItem,
  upsertItem,
  deleteInventoryItem,
  createTag,
  saveTag,
  deleteTag,
  createWarehouse,
  saveWarehouse,
  deleteWarehouse,
  saveEmergencyContact,
  setUserRole,
  type EventPatch,
  type CasePatch,
  type ItemPatch,
  type WarehousePatch,
} from '@/lib/db/write';

// lib/api/api-v1-db.ts — the generic /api/v1/db/<collection> CRUD mirror.
//
// The contract the MCP's list/get/create/update/delete_record tools call. It is the highest-risk
// surface, so it is locked down:
//   • STRICT collection allowlist — `auth`, `audit_log`, and any `__settings__`/`__perms__`/`_demo`-class
//     doc are NEVER reachable (the data.collection.allowlist invariant). The collection name is an
//     attacker-controlled path segment; nothing outside the allowlist is touched.
//   • EVERY write routes through the typed lib/write.ts helper for that collection (the same field
//     allowlists, sanitization, and can() gates the UI uses) — NEVER a raw Mongo write.
//   • PII collections: `events` reads are PII-stripped to the key's scope; `users` reads return only
//     non-PII directory fields (accommodations never crosses the generic mirror); `emergency_contact`
//     is gated by the emergency_contact.read/write caps. `users` writes are role-assignment only.

const READ_COLLECTIONS = new Set([
  'events',
  'cases',
  'inventory',
  'tags',
  'warehouses',
  'users',
  'emergency_contact',
  'metadata',
  'sync_meta',
]);

export class DbMirrorError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'DbMirrorError';
  }
}

interface Envelope {
  _id: string;
  payload?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number | null;
}

const USER_SAFE_FIELDS = ['email', 'name', 'preferredName', 'role', 'picture', 'unitPrefs', 'createdAt', 'updatedAt'] as const;

// Require the read gate for a collection (and the per-collection PII gate). Throws DbMirrorError.
function gateRead(vk: VerifiedKey, collection: string): void {
  if (!READ_COLLECTIONS.has(collection)) throw new DbMirrorError(404, `collection '${collection}' is not accessible`);
  if (!keyCan(vk, 'db.read.session')) throw new DbMirrorError(403, 'this key cannot read');
  if (collection === 'users' && rankOf(vk.role) < rankOf('manager')) {
    throw new DbMirrorError(403, "'users' holds personal data — a manager or admin role is required");
  }
  if (collection === 'emergency_contact' && !keyCan(vk, 'emergency_contact.read')) {
    throw new DbMirrorError(403, "reading 'emergency_contact' requires the emergency_contact.read capability");
  }
}

// Shape one envelope to the wire, applying the per-collection PII rule.
function shapeRecord(collection: string, doc: Envelope, vk: VerifiedKey): Record<string, unknown> {
  const payload = doc.payload || {};
  if (collection === 'events') {
    return { id: doc._id, ...stripEventForKey(payload as never, vk) };
  }
  if (collection === 'users') {
    const safe: Record<string, unknown> = { id: doc._id };
    for (const f of USER_SAFE_FIELDS) if (payload[f] !== undefined) safe[f] = payload[f];
    // Accommodations only when the key is scoped to view them (manager+/self via the cap).
    if (keyCan(vk, 'accommodations.view') && payload.accommodations !== undefined) safe.accommodations = payload.accommodations;
    return safe;
  }
  return { id: doc._id, ...payload };
}

function matchq(doc: Envelope, q: string): boolean {
  if (!q) return true;
  const p = doc.payload || {};
  const hay = [doc._id, p.name, p.label, p.email, p.slug].map((x) => String(x ?? '').toLowerCase());
  return hay.some((h) => h.includes(q.toLowerCase()));
}

export async function listRecords(
  vk: VerifiedKey,
  collection: string,
  q: string,
  limit: number,
  offset: number
): Promise<{ records: Record<string, unknown>[]; total: number; limit: number; offset: number }> {
  gateRead(vk, collection);
  const db = await getDb();
  const docs = (await db.collection<Envelope>(collection).find(NOT_DELETED).limit(5000).toArray()) as Envelope[];
  const filtered = docs.filter((d) => matchq(d, q));
  const records = filtered.slice(offset, offset + limit).map((d) => shapeRecord(collection, d, vk));
  return { records, total: filtered.length, limit, offset };
}

export async function getRecord(vk: VerifiedKey, collection: string, id: string): Promise<Record<string, unknown>> {
  gateRead(vk, collection);
  const db = await getDb();
  const doc = (await db.collection<Envelope>(collection).findOne({ _id: String(id), ...NOT_DELETED })) as Envelope | null;
  if (!doc) throw new DbMirrorError(404, 'record not found');
  return { record: shapeRecord(collection, doc, vk) };
}

// Re-read + shape a single record after a write (best-effort; returns just the id when unreadable).
async function reread(vk: VerifiedKey, collection: string, id: string): Promise<Record<string, unknown>> {
  try {
    const db = await getDb();
    const doc = (await db.collection<Envelope>(collection).findOne({ _id: String(id) })) as Envelope | null;
    if (doc) return shapeRecord(collection, doc, vk);
  } catch {
    /* fall through */
  }
  return { id };
}

const lc = (v: unknown) => String(v ?? '').trim().toLowerCase();
function stripEventWrite(record: Record<string, unknown>): EventPatch {
  const { staff, cases, ...rest } = record;
  void staff;
  void cases;
  return rest as EventPatch;
}

export async function createRecord(
  vk: VerifiedKey,
  collection: string,
  record: Record<string, unknown>
): Promise<{ record: Record<string, unknown>; status: number }> {
  if (!READ_COLLECTIONS.has(collection)) throw new DbMirrorError(404, `collection '${collection}' is not accessible`);
  switch (collection) {
    case 'events': {
      requireScope(vk, 'event.create');
      const res = await createEvent({ patch: stripEventWrite(record), actorEmail: vk.ownerEmail, actorRole: vk.role });
      return { record: await reread(vk, 'events', res.id), status: 201 };
    }
    case 'cases': {
      requireScope(vk, 'pallets.edit');
      const res = await createCase({ patch: record as CasePatch, actorEmail: vk.ownerEmail, actorRole: vk.role });
      return { record: await reread(vk, 'cases', res.id), status: 201 };
    }
    case 'inventory': {
      requireScope(vk, 'db.write.app');
      const res = await createInventoryItem({ patch: record as ItemPatch, actorRole: vk.role });
      return { record: await reread(vk, 'inventory', res.id), status: 201 };
    }
    case 'tags': {
      requireScope(vk, 'tags.edit');
      const res = await createTag({
        label: String(record.label ?? ''),
        hidden: Boolean(record.hidden),
        color: (record.color as string | null) ?? null,
        flair: (record.flair as string | null) ?? null,
        customEmoji: typeof record.customEmoji === 'string' ? record.customEmoji : '',
        actorEmail: vk.ownerEmail,
        actorRole: vk.role,
      });
      return { record: await reread(vk, 'tags', res.id), status: res.duplicate ? 200 : 201 };
    }
    case 'warehouses': {
      requireScope(vk, 'pallets.edit');
      const res = await createWarehouse({ patch: record as WarehousePatch, actorRole: vk.role });
      return { record: await reread(vk, 'warehouses', res.id), status: 201 };
    }
    case 'emergency_contact': {
      requireScope(vk, 'emergency_contact.write');
      await saveEmergencyContact({ rec: record as never, actorRole: vk.role });
      return { record: await reread(vk, 'emergency_contact', 'main'), status: 201 };
    }
    default:
      throw new DbMirrorError(403, `creating '${collection}' records is not allowed via the API`);
  }
}

export async function updateRecord(
  vk: VerifiedKey,
  collection: string,
  id: string,
  fields: Record<string, unknown>
): Promise<{ record: Record<string, unknown> }> {
  if (!READ_COLLECTIONS.has(collection)) throw new DbMirrorError(404, `collection '${collection}' is not accessible`);
  switch (collection) {
    case 'events':
      requireScope(vk, 'event.edit');
      await saveEvent({ id, patch: stripEventWrite(fields), actorEmail: vk.ownerEmail, actorRole: vk.role });
      break;
    case 'cases':
      requireScope(vk, 'pallets.edit');
      await saveCase({ id, patch: fields as CasePatch, actorEmail: vk.ownerEmail, actorRole: vk.role });
      break;
    case 'inventory':
      requireScope(vk, 'db.write.app');
      await upsertItem({ id, patch: fields as ItemPatch, actorRole: vk.role });
      break;
    case 'tags':
      requireScope(vk, 'tags.edit');
      await saveTag({ id, patch: fields as never, actorEmail: vk.ownerEmail, actorRole: vk.role });
      break;
    case 'warehouses':
      requireScope(vk, 'pallets.edit');
      await saveWarehouse({ id, patch: fields as WarehousePatch, actorRole: vk.role });
      break;
    case 'emergency_contact':
      requireScope(vk, 'emergency_contact.write');
      await saveEmergencyContact({ rec: { ...(fields as object) } as never, actorRole: vk.role });
      break;
    case 'users': {
      // The ONLY user write the API permits is a role assignment (setUserRole enforces admin + the
      // role-raise + own-role guards). No generic PII/profile write, no user creation/deletion via the API.
      if (lc(fields.role)) {
        requireScope(vk, 'users.role.assign');
        await setUserRole({ targetEmail: id, newRole: String(fields.role), actorEmail: vk.ownerEmail });
        break;
      }
      throw new DbMirrorError(403, "the only permitted 'users' write via the API is { role } (role assignment)");
    }
    default:
      throw new DbMirrorError(403, `updating '${collection}' records is not allowed via the API`);
  }
  return { record: await reread(vk, collection, id) };
}

export async function deleteRecord(vk: VerifiedKey, collection: string, id: string): Promise<{ deleted: string; action?: string }> {
  if (!READ_COLLECTIONS.has(collection)) throw new DbMirrorError(404, `collection '${collection}' is not accessible`);
  switch (collection) {
    case 'events':
      requireScope(vk, 'event.delete');
      await softDeleteEvent({ id, actorEmail: vk.ownerEmail, actorRole: vk.role });
      return { deleted: id };
    case 'cases': {
      requireScope(vk, 'pallets.edit');
      const res = await retireOrDeleteCase({ id, action: 'delete', reason: '', actorEmail: vk.ownerEmail, actorName: vk.ownerEmail, actorRole: vk.role });
      return { deleted: id, action: res.action };
    }
    case 'inventory':
      requireScope(vk, 'db.write.app');
      await deleteInventoryItem(id, vk.role);
      return { deleted: id };
    case 'tags':
      requireScope(vk, 'tags.delete');
      await deleteTag({ id, actorEmail: vk.ownerEmail, actorRole: vk.role });
      return { deleted: id };
    case 'warehouses':
      requireScope(vk, 'pallets.edit');
      await deleteWarehouse({ id, actorRole: vk.role });
      return { deleted: id };
    case 'emergency_contact':
      requireScope(vk, 'emergency_contact.write');
      await saveEmergencyContact({ rec: null, actorRole: vk.role });
      return { deleted: 'main' };
    default:
      throw new DbMirrorError(403, `deleting '${collection}' records is not allowed via the API`);
  }
}
