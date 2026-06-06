import 'server-only';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import type { Envelope, CaseDoc } from '@/lib/types/types';
import { itemCaseIds, type InventoryDoc } from '@/lib/views/inventory-shape';

// app/warehouses/warehouse-data.ts — LIVE warehouse reads + the homed-here derivation.
//
// The warehouses collection has no accessor in lib/ yet (events/cases/inventory do); this feature
// OWNS its reads, so they live here, but they go through the SAME live-DB spine (lib/mongo:
// getDb + NOT_DELETED) — a real Mongo round-trip per request, no cache, no localStorage. The
// record shape mirrors the current app's warehouse config (index.html ~L6252): a return-address
// entity with an optional per-warehouse primary contact (#71).
//
// A case is "homed" at a warehouse via case.payload.homeWarehouseId (the return address). The
// current app also tracks a case's CURRENT location (currentWarehouseId, #66) which defaults to
// home; we resolve current ?? home so a case placed elsewhere still groups correctly. Inventory
// carries no warehouse field, so the items "at" a warehouse are derived transitively: the items
// routed into a case that is homed/currently there (case-view's caseId linkage).

const WAREHOUSES = 'warehouses';

// ── Warehouse record (mirrors the current app's config shape) ──────────────────────────
export interface WarehousePayload {
  id?: string;
  name?: string;
  type?: 'hq' | 'sub' | string;
  street?: string;
  city?: string;
  region?: string;
  postal?: string;
  country?: string;
  phone?: string;
  contactName?: string;
  contactRole?: string; // #71 per-warehouse primary contact
  contactEmail?: string;
  lat?: number | null;
  lng?: number | null;
}

export type WarehouseDoc = Envelope<WarehousePayload>;

/** All non-deleted warehouses. HQ sorts before sub-warehouses, then by name — the same
 *  "HQ is the default return address" emphasis the current app's list uses. */
export async function getWarehouses(): Promise<WarehouseDoc[]> {
  const db = await getDb();
  const rows = await db.collection<WarehouseDoc>(WAREHOUSES).find(NOT_DELETED).toArray();
  rows.sort((a, b) => {
    const at = a.payload?.type === 'hq' ? 0 : 1;
    const bt = b.payload?.type === 'hq' ? 0 : 1;
    if (at !== bt) return at - bt;
    return (a.payload?.name || '').localeCompare(b.payload?.name || '');
  });
  return rows;
}

/** One warehouse by _id (envelope key). Null if missing or soft-deleted. */
export async function getWarehouse(id: string): Promise<WarehouseDoc | null> {
  const db = await getDb();
  // String()-coerce the _id so a crafted param can't reach the filter as a NoSQL operator object
  // (the scalar-_id pin the lib write helpers use).
  return db.collection<WarehouseDoc>(WAREHOUSES).findOne({ _id: String(id), ...NOT_DELETED });
}

// ── Emergency contact (single fleet-wide record on every shipping label) ──────────────────
export interface EmergencyContact {
  name: string;
  role: string;
  phone: string;
  email: string;
}

/** The single fleet-wide emergency contact (the 'main' row on the emergency_contact collection),
 *  or null when unset/cleared. Mirrors eitConfig.getEmergencyContact (index.html ~L6337). */
export async function getEmergencyContact(): Promise<EmergencyContact | null> {
  const db = await getDb();
  const doc = await db
    .collection<{ _id: string; payload?: EmergencyContact; deletedAt?: number | null }>('emergency_contact')
    .findOne({ _id: 'main', ...NOT_DELETED });
  if (!doc || !doc.payload) return null;
  const p = doc.payload;
  // A cleared contact is an empty row — surface null so the panel shows the empty state.
  if (!p.name && !p.role && !p.phone && !p.email) return null;
  return { name: p.name || '', role: p.role || '', phone: p.phone || '', email: p.email || '' };
}

// ── Pure derivation helpers (no I/O) ────────────────────────────────────────────────────

/** The warehouse a case is associated with: its CURRENT location if set, else its HOME
 *  (return address), else null. Mirrors the current app's caseCurrentWarehouseId (index.html
 *  ~L6400): currentWarehouseId ?? homeWarehouseId. A truly-unplaced case yields null. */
export function caseWarehouseId(c: { currentWarehouseId?: string | null; homeWarehouseId?: string | null }): string | null {
  return c.currentWarehouseId || c.homeWarehouseId || null;
}

/** Build a { warehouseId -> count } map of cases homed/located at each warehouse, from the live
 *  case list. One pass; a case with no warehouse link is skipped (not bucketed to HQ — the page
 *  shows the honest "0 cases" rather than asserting a placement). */
export function casesPerWarehouse(cases: CaseDoc[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const doc of cases) {
    const wid = caseWarehouseId({
      currentWarehouseId: (doc.payload as { currentWarehouseId?: string | null }).currentWarehouseId,
      homeWarehouseId: doc.payload.homeWarehouseId,
    });
    if (wid) out[wid] = (out[wid] || 0) + 1;
  }
  return out;
}

/** The case ids associated with a single warehouse (current ?? home === id). */
export function caseIdsAtWarehouse(warehouseId: string, cases: CaseDoc[]): Set<string> {
  const ids = new Set<string>();
  for (const doc of cases) {
    const wid = caseWarehouseId({
      currentWarehouseId: (doc.payload as { currentWarehouseId?: string | null }).currentWarehouseId,
      homeWarehouseId: doc.payload.homeWarehouseId,
    });
    if (wid === warehouseId) ids.add(doc._id);
  }
  return ids;
}

/** A one-line formatted address from the warehouse parts, in the same order the current app's
 *  warehouse row prints (street · city, region · postal country). Empty parts are dropped. */
export function formatWarehouseAddress(w: WarehousePayload): string {
  return [
    w.street,
    [w.city, w.region].filter(Boolean).join(', '),
    [w.postal, w.country].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(' · ');
}

// ── 4×6 shipping-label extras (the case-static return + if-found blocks) ──────────────────────────
/** The Return-to address and If-found contact a 4×6 shipping label prints for a case. Both optional
 *  (omitted blocks just don't render). Shared by the Manifest screen's bulk labels AND the per-case
 *  Print-Matrix modal so the two label paths stay identical. */
export interface CaseShippingExtras {
  returnTo?: { name?: string; address?: string; phone?: string } | null;
  emergency?: { name?: string; phone?: string } | null;
}

/** Resolve a case's RETURN address (its home warehouse, HQ as fallback) and IF-FOUND contact (the
 *  warehouse's own primary contact #71, else the single fleet emergency contact). Pure — the caller
 *  passes the live warehouse list + fleet contact. A case with no warehouse link and no HQ yields
 *  empty blocks (the label still prints its code + name). */
export function caseReturnAndContact(
  casePayload: { homeWarehouseId?: string | null; currentWarehouseId?: string | null } | null | undefined,
  warehouses: WarehouseDoc[],
  fleetEmergency: EmergencyContact | null,
): CaseShippingExtras {
  const whById = new Map(warehouses.map((d) => [d._id, d.payload]));
  const hqWh = warehouses.find((d) => d.payload?.type === 'hq')?.payload ?? null;
  const homeId = casePayload?.homeWarehouseId || casePayload?.currentWarehouseId || '';
  const wh = (homeId && whById.get(homeId)) || hqWh || null;
  const returnTo = wh
    ? { name: wh.name || '', address: formatWarehouseAddress(wh), phone: wh.phone || '' }
    : null;
  const emergency = wh?.contactName
    ? { name: [wh.contactName, wh.contactRole].filter(Boolean).join(' · '), phone: wh.phone || '' }
    : fleetEmergency
      ? { name: [fleetEmergency.name, fleetEmergency.role].filter(Boolean).join(' · '), phone: fleetEmergency.phone || '' }
      : null;
  return { returnTo, emergency };
}

/** The inventory items routed into any of the given case ids — the items "at" a warehouse,
 *  derived transitively (inventory has no warehouse field). Uses the authoritative itemCaseIds
 *  helper (bulk: distribution[].caseId; serial #22: deployed units[].location) so the membership
 *  test matches how lib/case-view cross-joins a case to its contents — one source of truth, the
 *  count can't drift from the Cases screen. */
export function inventoryItemsAtCases(caseIds: Set<string>, inventory: InventoryDoc[]): InventoryDoc[] {
  if (caseIds.size === 0) return [];
  return inventory.filter((doc) => itemCaseIds(doc.payload).some((cid) => caseIds.has(cid)));
}
