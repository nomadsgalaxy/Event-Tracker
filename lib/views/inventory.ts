import 'server-only';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import type { InventoryDoc } from '@/lib/views/inventory-shape';

// lib/views/inventory.ts — LIVE inventory reads straight from Mongo (no cache, no localStorage),
// the same model as lib/data.ts for events. Every call is a real DB round-trip so the catalog
// always reflects current database state.
//
// AUTHZ: these are raw reads. The catalog route guards the SESSION (requireUser) before calling
// them; finer per-collection gating (db.read.session) lives in the route/guard layer. No PII
// lives on the inventory doc, so there's nothing to strip here (unlike events/staff).

const INVENTORY = 'inventory';
const CASES = 'cases';

/** All non-deleted inventory items, sorted by name (then id) for a stable list. */
export async function getInventory(): Promise<InventoryDoc[]> {
  const db = await getDb();
  return db
    .collection<InventoryDoc>(INVENTORY)
    .find(NOT_DELETED)
    .sort({ 'payload.name': 1, _id: 1 })
    .toArray();
}

/** One inventory item by _id (envelope key). Null if missing or soft-deleted. */
export async function getInventoryItem(id: string): Promise<InventoryDoc | null> {
  const db = await getDb();
  return db.collection<InventoryDoc>(INVENTORY).findOne({ _id: id, ...NOT_DELETED });
}

/** A { caseId -> label } map for resolving the case chips on rows/detail. One query, all
 *  non-deleted cases. The case payload carries `label` (falls back to the id). */
export async function getCaseLabels(): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db
    .collection<{ _id: string; payload?: { label?: string; id?: string } }>(CASES)
    .find(NOT_DELETED)
    .project({ 'payload.label': 1 })
    .toArray();
  const map: Record<string, string> = {};
  for (const c of rows) {
    map[c._id] = (c.payload && c.payload.label) || c._id;
  }
  return map;
}

/** A { eventId -> name } map for resolving loose-attachment summaries. */
export async function getEventNames(): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db
    .collection<{ _id: string; payload?: { name?: string } }>('events')
    .find(NOT_DELETED)
    .project({ 'payload.name': 1 })
    .toArray();
  const map: Record<string, string> = {};
  for (const e of rows) {
    map[e._id] = (e.payload && e.payload.name) || e._id;
  }
  return map;
}
