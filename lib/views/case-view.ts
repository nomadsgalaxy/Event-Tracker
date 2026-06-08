// lib/views/case-view.ts — PURE, isomorphic case/manifest helpers.
//
// Ported faithfully from the current app's inventory→case helpers (index.html
// ~L9486–9548) and the case-status/availability helpers (~L5399–5422). No I/O,
// no 'server-only' — a Server Component computes the manifest after the live DB
// read AND a Client Component can reuse the exact same logic, so a count never
// drifts from the logic that produced it (the single-source-of-truth rule the
// dashboard agent used for dash-utils, and the catalog agent for inventory-shape).
//
// The ITEM primitives (itemIsSerial / itemUnits / unitIsDeployed / itemCaseIds /
// itemRollupState) are reused from lib/inventory-shape (the catalog's authoritative
// port) so bulk vs. serial (#22) items count identically here and in the catalog.
// This module only adds the CASE-scoped reads the manifest needs.

import {
  itemIsSerial,
  itemUnits,
  itemCaseIds,
  type InventoryPayload,
} from '@/lib/views/inventory-shape';
import { parseEitm, type ParsedEitm } from '@/lib/integrations/eitm';
import type { CasePayload, EventPayload, EventState } from '@/lib/types/types';

// ── Scan payload codec + resolution (mirrors decodeScanPayload + findInventoryByScan) ──────────
// PURE, isomorphic — the Scan-Pack screen uses these client-side to turn a typed-or-scanned code
// into the inventory item to mark packed. findInventoryByScan is a faithful port of index.html
// ~L6630, trimmed to the item/case kinds the pack flow needs. The `eitm:` codec itself now lives in
// lib/eitm (the single source of truth shared with the ENCODE path); decodeScanPayload is kept as a
// thin re-export so existing scan imports + the DecodedScan type stay stable.

export type DecodedScan = ParsedEitm;

/** Decode an `eitm:<hash>:<kind>:<id>` Data-Matrix payload. Returns null for any non-EIT text
 *  (which then falls through to a free-text qr/sku/serial lookup). Delegates to lib/eitm.parseEitm
 *  so the DECODE path here and the ENCODE path on labels/manifests share one codec. */
export function decodeScanPayload(text: string | null | undefined): DecodedScan | null {
  return parseEitm(text);
}

export type ScanMatchTier = 'none' | 'exact' | 'substring';

export interface ScanMatch {
  tier: ScanMatchTier;
  /** A single unambiguous exact hit. */
  itemId?: string;
  matchField?: string;
  /** Ambiguous (>1 exact, or substring) — the caller disambiguates. */
  itemIds?: string[];
}

interface ScanItem {
  id: string;
  payload: InventoryPayload;
}

/**
 * Resolve a free-text code (qr / sku / id / serial) to inventory item(s). Mirrors
 * findInventoryByScan: an exact match on any field wins; else a substring match (≥4-char overlap on
 * the shorter side, so a 2-char SKU can't false-positive). Returns the item ids (the page already
 * has the payloads). The caller resolves an EIT `eitm:…:i:<id>` payload by id directly before
 * falling back to this.
 */
export function findInventoryByScan(items: ScanItem[], raw: string | null | undefined): ScanMatch {
  if (!raw || typeof raw !== 'string' || !Array.isArray(items)) return { tier: 'none' };
  const needle = raw.trim().toLowerCase();
  if (!needle) return { tier: 'none' };
  const exact: { id: string; field: string }[] = [];
  const substr: string[] = [];
  for (const { id, payload: it } of items) {
    if (!it) continue;
    const fields: { field: string; value: string }[] = [];
    if (it.qr) fields.push({ field: 'qr', value: String(it.qr).toLowerCase() });
    if (it.sku) fields.push({ field: 'sku', value: String(it.sku).toLowerCase() });
    if (id) fields.push({ field: 'id', value: String(id).toLowerCase() });
    // Bound NFC tags: an item carries the physical tag UIDs as keys of tagData (written by the scan +
    // consumable read flows). Scanning a bound tag therefore resolves to its item by an exact UID match.
    for (const uid of Object.keys(it.tagData || {})) {
      if (uid) fields.push({ field: 'nfc', value: uid.toLowerCase() });
    }
    for (const d of it.distribution || []) {
      for (const s of d.serials || []) fields.push({ field: 'serial', value: String(s).toLowerCase() });
    }
    for (const u of Array.isArray(it.units) ? it.units : []) {
      if (u && !u.deletedAt && u.serial) fields.push({ field: 'serial', value: String(u.serial).toLowerCase() });
    }
    let exactHit: string | null = null;
    let substrHit = false;
    for (const f of fields) {
      if (f.value === needle) {
        exactHit = f.field;
        break;
      }
      if (!substrHit && f.value.length >= 4 && needle.length >= 4) {
        if (f.value.includes(needle) || needle.includes(f.value)) substrHit = true;
      }
    }
    if (exactHit) exact.push({ id, field: exactHit });
    else if (substrHit) substr.push(id);
  }
  if (exact.length === 1) return { tier: 'exact', itemId: exact[0].id, matchField: exact[0].field };
  if (exact.length > 1) return { tier: 'exact', itemIds: exact.map((x) => x.id) };
  if (substr.length > 0) return { tier: 'substring', itemIds: substr };
  return { tier: 'none' };
}

// ── Per-case quantity / state (mirrors itemQtyInCase / itemStateInCase) ─────────────────
/** Quantity of `item` currently routed into `caseId`. Serial: count of units there;
 *  bulk: sum of matching distribution-row qty. */
export function itemQtyInCase(item: InventoryPayload, caseId: string): number {
  if (itemIsSerial(item)) return itemUnits(item).filter((u) => u.location === caseId).length;
  return (item.distribution ?? [])
    .filter((d) => d.caseId === caseId)
    .reduce((s, d) => s + (d.qty ?? 0), 0);
}

/** The item's per-case packed state: 'packed' iff every unit/row in the case is packed,
 *  else 'pending'; null when the item isn't in the case. */
export function itemStateInCase(item: InventoryPayload, caseId: string): 'packed' | 'pending' | null {
  if (itemIsSerial(item)) {
    const u = itemUnits(item).filter((x) => x.location === caseId);
    if (u.length === 0) return null;
    return u.every((x) => x.state === 'packed') ? 'packed' : 'pending';
  }
  const d = (item.distribution ?? []).find((x) => x.caseId === caseId);
  if (!d) return null;
  return d.state === 'packed' ? 'packed' : 'pending';
}

/** True iff the item (or any of its serial units) carries an open flag. */
function itemHasOpenFlag(item: InventoryPayload): boolean {
  if ((item.flags ?? []).some((f) => f && f.status === 'open')) return true;
  if (itemIsSerial(item)) {
    return itemUnits(item).some((u) => (u.flags ?? []).some((f) => f && f.status === 'open'));
  }
  return false;
}

// ── Manifest summary for one case ───────────────────────────────────────────────────────
export interface CaseManifestRow {
  itemId: string;
  name: string;
  kind: string;
  sku: string;
  qty: number;
  state: 'packed' | 'pending' | 'flagged';
}

export interface CaseManifestSummary {
  rows: CaseManifestRow[];
  total: number; // total units in the case
  scanned: number; // units in 'packed' state
  pending: number; // units in 'pending' state
  flagged: number; // units belonging to a flagged item
}

/**
 * Build the contents/manifest summary for a single case from the live inventory.
 * One row per inventory item that routes into the case, with the per-case qty and
 * the per-case packed/pending/flagged disposition. Counts mirror the CaseDetail
 * header math (index.html ~L14252–14260): scanned/pending by per-case state,
 * flagged by item open-flag. Tombstoned items are excluded by the caller's read
 * (NOT_DELETED), so this just trusts the live list.
 */
export function buildCaseManifest(
  caseId: string,
  inventory: InventoryPayload[]
): CaseManifestSummary {
  const rows: CaseManifestRow[] = [];
  let total = 0;
  let scanned = 0;
  let pending = 0;
  let flagged = 0;

  for (const item of inventory) {
    if (!itemCaseIds(item).includes(caseId)) continue;
    const qty = itemQtyInCase(item, caseId);
    if (qty <= 0) continue;
    const perCase = itemStateInCase(item, caseId); // 'packed' | 'pending' | null
    const isFlagged = itemHasOpenFlag(item);
    const rowState: CaseManifestRow['state'] = isFlagged
      ? 'flagged'
      : perCase === 'packed'
        ? 'packed'
        : 'pending';

    total += qty;
    if (perCase === 'packed') scanned += qty;
    if (perCase === 'pending') pending += qty;
    if (isFlagged) flagged += qty;

    rows.push({
      itemId: item.id ?? '',
      name: item.name ?? '(unnamed)',
      kind: item.kind ?? item.type ?? '',
      sku: item.qr ?? item.sku ?? '',
      qty,
      state: rowState,
    });
  }

  // Stable, useful ordering: flagged first, then pending, then packed, then by name.
  const rank = { flagged: 0, pending: 1, packed: 2 } as const;
  rows.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));

  return { rows, total, scanned, pending, flagged };
}

// ── Event assignment + status phrasing ──────────────────────────────────────────────────
// States in which an event HOLDS its cases (a held case can't be double-booked). Mirrors the
// activeStates list in getCaseAvailability (index.html ~L5402).
const HELD_STATES: ReadonlySet<string> = new Set([
  'packing',
  'ready',
  'in_transit',
  'onsite',
  'returning',
]);

export interface CaseAssignment {
  event: EventPayload;
  eventId: string;
  /** True iff the owning event is in a HELD state (the case is in-flight, not free). */
  held: boolean;
}

/**
 * Find the event this case is assigned to. CaseDetail uses the first event whose cases[]
 * includes the id (index.html ~L14248) — not only the held ones — so a case assigned to an
 * upcoming/closed event still shows its owner. `held` reflects getCaseAvailability's stricter
 * "currently in-flight" test.
 */
export function caseAssignment(
  caseId: string,
  events: { _id: string; payload: EventPayload }[]
): CaseAssignment | null {
  for (const e of events) {
    if ((e.payload.cases ?? []).includes(caseId)) {
      return { event: e.payload, eventId: e._id, held: HELD_STATES.has(String(e.payload.state)) };
    }
  }
  return null;
}

/** True iff this case is retired (the explicit retiredAt triple). Mirrors isCaseRetired. */
export function isCaseRetired(c: CasePayload): boolean {
  return !!c.retiredAt;
}

/** The availability of a case — free, or held by a specific in-flight event. */
export interface CaseAvailability {
  status: 'available' | 'unavailable';
  /** The HELD-state event holding the case (only present when status === 'unavailable'). */
  event?: EventPayload;
  eventId?: string;
}

/**
 * Find whether a case is free or HELD by an in-flight event (the availability LOCK the
 * Assign-cases modal renders). A faithful port of getCaseAvailability (index.html ~L5399): a case is
 * 'unavailable' iff some event in a HELD state (packing/ready/in_transit/onsite/returning) has it in
 * cases[]. Returns the FIRST such holder. `available` otherwise.
 */
export function getCaseAvailability(
  caseId: string,
  events: { _id: string; payload: EventPayload }[]
): CaseAvailability {
  for (const e of events) {
    if ((e.payload.cases ?? []).includes(caseId) && HELD_STATES.has(String(e.payload.state))) {
      return { status: 'unavailable', event: e.payload, eventId: e._id };
    }
  }
  return { status: 'available' };
}

/**
 * Phrase a held case's status from the owning event's phase (#32). Mirrors caseStatusLabel.
 * Returns 'In storage' when there's no owning event.
 */
export function caseStatusLabel(event: EventPayload | null | undefined): string {
  if (!event) return 'In storage';
  const name = event.name ?? 'event';
  switch (event.state as EventState) {
    case 'packing':
    case 'ready':
      return 'Packing for ' + name;
    case 'in_transit':
      return 'In transit to ' + name;
    case 'returning':
      return 'Returning from ' + name;
    default:
      return 'At ' + name; // onsite or any other held/active state
  }
}

/** The list-row status used by the catalog: retired | assigned (held) | available. */
export type CaseListStatus = 'retired' | 'assigned' | 'available';
export function caseListStatus(c: CasePayload, assignment: CaseAssignment | null): CaseListStatus {
  if (isCaseRetired(c)) return 'retired';
  if (assignment?.held) return 'assigned';
  return 'available';
}

// ── #66 Warehouses: per-case current location + in-transit ──────────────────────────────────
// Faithful ports of caseInTransit / caseCurrentWarehouseId / caseEffectiveTransit / caseLocationLabel
// (index.html ~L6397-6446). A case's HOME warehouse (homeWarehouseId) is its return address; its
// CURRENT location is currentWarehouseId (defaults to home). While moving it carries a `transit`
// record and currentWarehouseId is null. An event in the `in_transit` state derives in-transit onto
// its assigned cases.

/** True iff the case carries its OWN in-transit record. */
export function caseInTransit(c: CasePayload | null | undefined): boolean {
  return !!(c && c.transit && c.transit.status === 'in_transit');
}

/** The case's CONFIRMED current warehouse: explicit currentWarehouseId, else home, else null.
 *  null while in transit (the case is between warehouses). Mirrors caseCurrentWarehouseId. */
export function caseCurrentWarehouseId(c: CasePayload | null | undefined): string | null {
  if (!c || caseInTransit(c)) return null;
  return c.currentWarehouseId || c.homeWarehouseId || null;
}

/** Effectively in transit — by the case's own record OR because an event it's assigned to is
 *  in_transit. Returns {kind} or null. Mirrors caseEffectiveTransit. */
export type CaseEffectiveTransit =
  | { kind: 'case'; transit: NonNullable<CasePayload['transit']> }
  | { kind: 'event'; eventId: string; eventName: string }
  | null;

export function caseEffectiveTransit(
  c: CasePayload | null | undefined,
  events: { _id: string; payload: EventPayload }[]
): CaseEffectiveTransit {
  if (caseInTransit(c) && c!.transit) return { kind: 'case', transit: c!.transit };
  const cid = c?.id;
  if (cid) {
    for (const e of events || []) {
      if (e.payload.state === 'in_transit' && (e.payload.cases || []).includes(cid)) {
        return { kind: 'event', eventId: e._id, eventName: e.payload.name || 'event' };
      }
    }
  }
  return null;
}

/**
 * Human label for where a case is right now. '⇆ In transit to X' / 'In transit (Event)' / the
 * current warehouse name / '—'. Mirrors caseLocationLabel (index.html ~L6436) — the warehouse name
 * is resolved from a passed-in id->name map (the page reads warehouses once, server-side).
 */
export function caseLocationLabel(
  c: CasePayload | null | undefined,
  events: { _id: string; payload: EventPayload }[],
  warehouseNameById: Record<string, string>
): string {
  const eff = caseEffectiveTransit(c, events);
  if (eff && eff.kind === 'event') return 'In transit (' + eff.eventName + ')';
  if (eff && eff.kind === 'case') {
    const to = eff.transit.toWarehouseId ? warehouseNameById[eff.transit.toWarehouseId] : '';
    return 'In transit' + (to ? ' → ' + to : '');
  }
  const wid = caseCurrentWarehouseId(c);
  const name = wid ? warehouseNameById[wid] : '';
  return name || '—';
}

// ── Schedule conflicts (#double-booked) ─────────────────────────────────────────────────────
// Faithful to getCaseScheduleConflicts (index.html ~L5535): events (other than selfEventId) that
// COMMIT this case (cases[] includes it), aren't dead (closed/cancelled), and have a startDate. The
// caller treats ≥2 as a double-booking and lists them.
export interface CaseScheduleConflict {
  eventId: string;
  name: string;
  start: string;
  end: string;
  state: string;
}

export function getCaseScheduleConflicts(
  caseId: string,
  events: { _id: string; payload: EventPayload }[],
  selfEventId?: string | null
): CaseScheduleConflict[] {
  const dead = new Set(['closed', 'cancelled', 'canceled']);
  const out: CaseScheduleConflict[] = [];
  for (const e of events || []) {
    if (!e || e._id === selfEventId) continue;
    if (!(e.payload.cases || []).includes(caseId)) continue;
    if (dead.has(String(e.payload.state))) continue;
    if (!e.payload.startDate) continue;
    out.push({
      eventId: e._id,
      name: e.payload.name || e._id,
      start: e.payload.startDate,
      end: e.payload.endDate || e.payload.startDate,
      state: String(e.payload.state),
    });
  }
  return out;
}

// ── Case DELETE / RETIRE classification (FK check) ──────────────────────────────────────────
// Faithful to caseEventReferences / caseItemReferences / classifyCaseDelete (index.html ~L5571-5609):
//   - blocked : held by ≥1 NON-closed event (clean up first; cancel-only)
//   - retire  : only historical refs (closed events / inventory rows) — soft-retire
//   - delete  : zero FK refs anywhere — hard delete (tombstone)
export interface CaseDeleteClassification {
  action: 'blocked' | 'retire' | 'delete';
  blockers: { events: { id: string; name: string; state: string }[] };
  historical: {
    closedEvents: { id: string; name: string }[];
    items: { id: string; name: string }[];
  };
}

export function classifyCaseDelete(
  caseId: string,
  events: { _id: string; payload: EventPayload }[],
  inventory: InventoryPayload[]
): CaseDeleteClassification {
  const nonClosed: { id: string; name: string; state: string }[] = [];
  const closed: { id: string; name: string }[] = [];
  for (const e of events || []) {
    if (!e || !(e.payload.cases || []).includes(caseId)) continue;
    if (e.payload.state === 'closed') closed.push({ id: e._id, name: e.payload.name || e._id });
    else nonClosed.push({ id: e._id, name: e.payload.name || e._id, state: String(e.payload.state) });
  }
  const items: { id: string; name: string }[] = [];
  for (const it of inventory || []) {
    if (!it) continue;
    if (itemCaseIds(it).includes(caseId)) items.push({ id: it.id || '', name: it.name || it.id || '(unnamed)' });
  }

  if (nonClosed.length) {
    return { action: 'blocked', blockers: { events: nonClosed }, historical: { closedEvents: closed, items } };
  }
  if (closed.length || items.length) {
    return { action: 'retire', blockers: { events: [] }, historical: { closedEvents: closed, items } };
  }
  return { action: 'delete', blockers: { events: [] }, historical: { closedEvents: [], items: [] } };
}

// ── Per-case internal manifest SNAPSHOT (the packing list inside the case) ───────────────────
// Faithful to buildCaseManifestSnapshot (index.html ~L4566): one row per inventory item routed into
// the case (serial items aggregate their in-case units + list serials), the assigned active event
// (via the held availability rule), and the home-warehouse name. Pure — the print path renders it.
export interface CaseManifestSnapshotRow {
  itemId: string;
  itemName: string;
  sku: string;
  qr: string;
  qty: number;
  serials: string[];
  state: string;
  flagsOpen: number;
  flags: { severity: string; note: string }[];
}

export interface CaseManifestSnapshot {
  caseId: string;
  caseLabel: string;
  caseSlug: string;
  caseSize: string;
  homeWarehouse: string;
  assignedEvent: {
    name: string;
    state: string;
    dates: { start: string; end: string };
    venue: { name: string; city: string; booth: string };
  } | null;
  capturedAt: number;
  rows: CaseManifestSnapshotRow[];
  totals: { rows: number; qty: number };
}

export function buildCaseManifestSnapshot(
  roadcase: CasePayload,
  inventory: InventoryPayload[],
  events: { _id: string; payload: EventPayload }[],
  warehouseNameById: Record<string, string>
): CaseManifestSnapshot | null {
  if (!roadcase) return null;
  const caseId = roadcase.id ?? '';
  const rows: CaseManifestSnapshotRow[] = [];
  let totalQty = 0;

  for (const item of inventory) {
    if (!item) continue;
    const openFlags = (item.flags || []).filter((f) => f && f.status === 'open');
    const flagRows = openFlags.map((f) => ({ severity: f.severity || 'med', note: f.note || '' }));
    if (itemIsSerial(item)) {
      const us = itemUnits(item).filter((u) => u.location === caseId);
      if (us.length === 0) continue;
      const qty = us.length;
      totalQty += qty;
      rows.push({
        itemId: item.id ?? '',
        itemName: item.name || item.slug || item.id || '(unnamed)',
        sku: item.sku || '',
        qr: item.qr || '',
        qty,
        serials: us.map((u) => u.serial).filter((s): s is string => !!s),
        state: us.every((u) => u.state === 'packed') ? 'packed' : 'pending',
        flagsOpen: openFlags.length,
        flags: flagRows,
      });
      continue;
    }
    for (const d of item.distribution || []) {
      if (!d || d.caseId !== caseId) continue;
      const qty = Number(d.qty || 0);
      totalQty += qty;
      rows.push({
        itemId: item.id ?? '',
        itemName: item.name || item.slug || item.id || '(unnamed)',
        sku: item.sku || '',
        qr: item.qr || '',
        qty,
        serials: Array.isArray(d.serials) ? d.serials.slice() : [],
        state: d.state || '',
        flagsOpen: openFlags.length,
        flags: flagRows,
      });
    }
  }
  rows.sort((a, b) => a.itemName.localeCompare(b.itemName));

  // Assigned active event (held availability rule).
  let assignedEvent: CaseManifestSnapshot['assignedEvent'] = null;
  const avail = getCaseAvailability(caseId, events);
  if (avail.status === 'unavailable' && avail.event) {
    const e = avail.event;
    const venue = (e.venue || {}) as Record<string, unknown>;
    assignedEvent = {
      name: e.name || '',
      state: String(e.state || ''),
      dates: { start: e.startDate || '', end: e.endDate || '' },
      venue: {
        name: String(venue.name || ''),
        city: String(venue.city || e.city || ''),
        booth: String(venue.booth || ''),
      },
    };
  }

  const homeWarehouse = roadcase.homeWarehouseId ? warehouseNameById[roadcase.homeWarehouseId] || '' : '';

  return {
    caseId,
    caseLabel: roadcase.label || roadcase.slug || caseId,
    caseSlug: roadcase.slug && roadcase.slug !== caseId ? roadcase.slug : '',
    caseSize: roadcase.size ? String(roadcase.size) : '',
    homeWarehouse,
    assignedEvent,
    capturedAt: Date.now(),
    rows,
    totals: { rows: rows.length, qty: totalQty },
  };
}
