// lib/views/inventory-shape.ts — the inventory ITEM data shape + PURE read helpers.
//
// ISOMORPHIC (no 'server-only', no I/O): a faithful TypeScript port of the item
// primitives in index.html (~L9477-9567 + the bulk/serial branch helpers). The catalog
// list AND the item detail — both server-rendered and client-interactive — evaluate the
// SAME helpers so a bulk item and a serialized item (#22) read identically everywhere.
//
// DATA CONTRACT: every inventory doc is the shared Mongo envelope
//   { _id, payload:{...}, createdAt, updatedAt, deletedAt }
// The payload is the item. Two shapes share one schema, distinguished by `tracking`:
//   • BULK   (tracking 'bulk' / unset): distribution[] rows + an optional stockTotal.
//   • SERIAL (tracking 'serial', #22) : a top-level units[]; qty is implicit (1/unit),
//     deployed = units whose location is a caseId, in-storage = the rest.
// The helpers below branch on tracking so every consumer works for both shapes.

import type { Envelope } from '@/lib/types/types';
import type { ParsedTag } from '@/lib/integrations/nfc-decoders';

// ── Distribution row (BULK) ────────────────────────────────────────────────────────────
// Row shapes (from the loose-items plan):
//   { caseId:'CASE-X', eventId:null,    qty, serials, state }              — packed in a case
//   { caseId:null,     eventId:'evt-Y', qty, serials, state, looseAttach } — loose at an event
//   { caseId:null,     eventId:null,    qty, serials, state }              — pure inventory
// The canonical return / pack sign-off stamp on a row or a serial unit. The scan/return + sign-off
// flows write { kind, at, byEmail, byName, role, note } (the disposition); an older outbound code
// path wrote a leaner { at, by }. The union covers both so a count never mis-reads either shape.
export interface RowSignoff {
  kind?: string; // ok | damaged | missing | consumed | other | packing
  at?: number;
  by?: string;
  byEmail?: string;
  byName?: string;
  role?: string;
  note?: string;
}

export interface DistributionRow {
  caseId?: string | null;
  eventId?: string | null;
  qty?: number;
  serials?: string[];
  state?: ItemState;
  variantSku?: string;
  signoff?: RowSignoff | null;
  looseAttach?: { by?: string; at?: number; reason?: string } | null;
  // Legacy flat return disposition (cleared alongside signoff on un-sign). rowDispositionKind reads it.
  returnDisposition?: string | null;
  returnedBy?: string | null;
  returnedAt?: number | null;
  // Stamped when a loose row is absorbed into a case (lib/write.moveLooseToCase).
  absorbedBy?: string | null;
  absorbedAt?: number | null;
  // Stamped by the scan-pack flow (lib/write.packItemIntoCase) — who/when last packed this row.
  packedBy?: { email?: string; name?: string } | null;
  packedAt?: number | null;
}

// ── Unit (SERIAL, #22) ───────────────────────────────────────────────────────────────
// location: caseId | 'storage'. A deployed unit has a caseId location; the rest are storage.
export interface ItemUnit {
  id?: string;
  serial?: string;
  location?: string | null; // caseId | 'storage'
  storageNote?: string;
  state?: ItemState;
  sku?: string;
  flags?: ItemFlag[];
  // Per-unit service (serial items): each physical unit is tracked individually, so one unit can be
  // out of service without taking the whole item type down. Mirrors the item-level fields.
  status?: 'out_of_service' | null;
  nextServiceDate?: string | null; // ISO 'YYYY-MM-DD'
  serviceIntervalDays?: number | null;
  // NFC spool tracking: a consumable's physical spool is a serial unit linked to its tag by UID, with
  // the grams remaining read from the tag (OpenPrintTag actual − consumed). See [[nfc-consumable-tags]].
  tagUid?: string;
  remainingWeight?: number | null;
  // Per-unit return sign-off (#22 serial parity with DistributionRow.signoff). Written by the scan
  // flow when a deployed unit is signed back in; read by the sign-off readiness math.
  signoff?: RowSignoff | null;
  deletedAt?: number | null;
  // Stamped by the scan-pack flow (lib/write.packItemIntoCase) for a serial unit in a case.
  packedBy?: { email?: string; name?: string } | null;
  packedAt?: number | null;
}

export interface ItemFlag {
  id?: string;
  status?: 'open' | 'resolved';
  category?: 'damage' | 'maintenance' | string;
  severity?: 'low' | 'med' | 'high' | string;
  note?: string;
  by?: string;
  flaggedAt?: string;
  flaggedBy?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  // Light service workflow (no work-order system): the repair cost + the tech who handled it.
  repairCost?: number | null;
  assignedTech?: string;
}

export interface SkuOption {
  sku: string;
  label?: string;
}

// ── Kit requirements / BOM (#27) ────────────────────────────────────────────────────────
// An equipment "model" item may declare requirements[] — the peripherals/consumables a unit
// of it needs to be field-ready. A requirement's partRef targets either a specific item
// (kind:'item', by id or any SKU variant) OR a TAG (kind:'tag' — any item carrying that tag
// satisfies it: the interchangeable "part group"). Opt-in: an empty list => no shortfalls.
export interface PartRef {
  kind: 'item' | 'tag';
  ref: string;
}
export interface KitRequirement {
  partRef: PartRef;
  qty: number;
  mode: 'atLeast' | 'exact';
  consumable: boolean;
  note: string;
}

// An NFC tag bound to an item, keyed by the physical tag UID. Written by the scan + consumable read
// flows (lib/db/write.updateItemTagData). `parsed` is the decoded material data (OpenPrintTag/OpenSpool).
export interface ItemTagData {
  tagUid: string;
  format?: string;
  category?: 'filament' | 'resin' | 'generic' | string;
  parsed?: ParsedTag | null;
  raw?: unknown;
  lastReadAt?: number;
  lastReadBy?: { email?: string; name?: string } | null;
}

// The per-item rollup state — NOT an event lifecycle state. Mirrors index.html STATES.
export type ItemState = 'packed' | 'pending' | 'flagged' | 'draft';

// The item kinds (index.html KINDS). Drives the kind filter + the row glyph.
export const ITEM_KINDS = [
  'equipment',
  'peripheral',
  'consumable',
  'tool',
  'banner',
  'fixture',
  'system',
  'cable',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface InventoryPayload {
  id?: string;
  name?: string;
  slug?: string;
  sku?: string;
  skuOptions?: SkuOption[]; // #43 multi-SKU listing
  qr?: string; // Data-Matrix / QR code value
  kind?: ItemKind | string;
  type?: string; // legacy alias for kind
  tracking?: 'bulk' | 'serial';
  weight?: number | string; // per-unit tare weight in kg ('' when unset)
  stockTotal?: number | null;
  reorderPoint?: number | null;
  storageNotes?: string;
  status?: 'out_of_service' | null;
  // Maintenance scheduling (light): next due date (ISO 'YYYY-MM-DD') + a recurring interval in days.
  nextServiceDate?: string | null;
  serviceIntervalDays?: number | null;
  // Asset value (per-unit, USD for now). replacementCost wins over purchasePrice for loss valuation.
  purchasePrice?: number | null;
  purchaseDate?: string | null; // ISO date 'YYYY-MM-DD' ('' / null when unset)
  replacementCost?: number | null;
  // Booth power: this equipment needs a power feed at the booth — its draw in watts (per unit, the
  // nameplate spec) + the plug it presents (e.g. 'NEMA 5-15', 'L5-30', 'IEC C14'). The event view
  // sums watts → amps @120V and lists distinct plug types, and warns when a powered item lands at an
  // event without a power drop.
  requiresPower?: boolean;
  powerWatts?: number | null;
  /** The power INLET this equipment presents — a canonical id from lib/power/connectors INLETS
   *  (e.g. 'C14', 'NEMA 5-15P'). Legacy free-text survives (renders as a plain label). */
  plugType?: string;
  /** Input voltage class: '120' (NA-only PSU), '240' (230/240-only), 'auto' (universal). Drives the
   *  event receptacle grid's greying + the compatibility warning. */
  powerVolts?: '120' | '240' | 'auto';
  /** Cable spec (kind === 'cable'): the power subtypes — a power strip (one male, many female
   *  outlets), an extension cord, an adapter (e.g. a 20 A male to a 10 A female), or a Custom
   *  cursed combo (any male × any female — electricians do crazy things). Ends are canonical ids
   *  from lib/power/connectors CABLE_MALE_ENDS / CABLE_FEMALE_ENDS. Category is extensible (data /
   *  audio variants later). */
  cable?: {
    category: 'power-strip' | 'extension' | 'adapter' | 'custom' | string;
    maleEnd?: string;
    femaleEnd?: string;
    femaleCount?: number;
    lengthFt?: number | null;
    notes?: string;
  } | null;
  distribution?: DistributionRow[]; // BULK
  units?: ItemUnit[]; // SERIAL (#22)
  flags?: ItemFlag[];
  tagIds?: string[];
  requirements?: KitRequirement[]; // #27 kit BOM (equipment models only)
  tagData?: Record<string, ItemTagData>; // NFC tags bound to this item, keyed by tag UID
}

export type InventoryDoc = Envelope<InventoryPayload>;

// ── Tracking branch ─────────────────────────────────────────────────────────────────
export function itemIsSerial(item: InventoryPayload): boolean {
  return item?.tracking === 'serial';
}

/** Live (non-tombstoned) units of a SERIAL item. */
export function itemUnits(item: InventoryPayload): ItemUnit[] {
  return Array.isArray(item?.units) ? item.units.filter((u) => u && !u.deletedAt) : [];
}

export function unitIsDeployed(u: ItemUnit | null | undefined): boolean {
  return !!(u && u.location && u.location !== 'storage');
}

// ── Quantity / placement (mirrors itemTotalQty / itemCaseIds) ─────────────────────────
/** Deployed quantity: serial = count of deployed units; bulk = sum of distribution qty. */
export function itemTotalQty(item: InventoryPayload): number {
  if (itemIsSerial(item)) return itemUnits(item).filter(unitIsDeployed).length;
  return (item.distribution || []).reduce((s, d) => s + (d.qty || 0), 0);
}

/** The distinct case ids this item is currently deployed into. */
export function itemCaseIds(item: InventoryPayload): string[] {
  if (itemIsSerial(item)) {
    return Array.from(
      new Set(itemUnits(item).filter(unitIsDeployed).map((u) => u.location as string))
    );
  }
  return Array.from(new Set((item.distribution || []).map((d) => d.caseId).filter(Boolean) as string[]));
}

/** Event ids this item is loose-attached to (bulk loose rows). */
export function itemEventIds(item: InventoryPayload): string[] {
  return Array.from(new Set((item.distribution || []).map((d) => d.eventId).filter(Boolean) as string[]));
}

/** Loose quantity at one event (bulk loose rows, caseId null). */
export function itemQtyLooseAtEvent(item: InventoryPayload, eventId: string | null | undefined): number {
  if (!eventId) return 0;
  return (item.distribution || [])
    .filter((d) => !d.caseId && d.eventId === eventId)
    .reduce((s, d) => s + (d.qty || 0), 0);
}

/** Deployed quantity in one case. serial = count of in-case units; bulk = sum of matching-row qty.
 *  Mirrors itemQtyInCase (index.html ~L9499). */
export function itemQtyInCase(item: InventoryPayload, caseId: string): number {
  if (itemIsSerial(item)) return itemUnits(item).filter((u) => u.location === caseId).length;
  return (item.distribution || []).filter((d) => d.caseId === caseId).reduce((s, d) => s + (d.qty || 0), 0);
}

/** The item's state IN one case ('packed' iff every in-case row/unit is packed, else 'pending'),
 *  or null when the item isn't in that case. Mirrors itemStateInCase (index.html ~L9531). */
export function itemStateInCase(item: InventoryPayload, caseId: string): ItemState | null {
  if (itemIsSerial(item)) {
    const u = itemUnits(item).filter((x) => x.location === caseId);
    if (u.length === 0) return null;
    return u.every((x) => x.state === 'packed') ? 'packed' : 'pending';
  }
  const d = (item.distribution || []).find((x) => x.caseId === caseId);
  return d ? (d.state ?? null) : null;
}

/** The disposition kind on a distribution row (the canonical signoff.kind, else the legacy flat
 *  returnDisposition with 'clean'->'ok'). Mirrors rowDispositionKind (index.html ~L6868). */
export function rowDispositionKind(d: DistributionRow | null | undefined): string | null {
  if (!d) return null;
  if (d.signoff && d.signoff.kind) return d.signoff.kind;
  if (d.returnDisposition) return d.returnDisposition === 'clean' ? 'ok' : d.returnDisposition;
  return null;
}

// ── Rollup state (mirrors itemRollupState) ────────────────────────────────────────────
/** The item's overall state: 'flagged' (any open flag) > 'packed' (all deployed packed)
 *  > 'pending'. Used for the row chip color. */
export function itemRollupState(item: InventoryPayload): ItemState {
  if ((item.flags || []).some((f) => f && f.status === 'open')) return 'flagged';
  if (itemIsSerial(item)) {
    const units = itemUnits(item);
    if (units.some((u) => (u.flags || []).some((f) => f && f.status === 'open'))) return 'flagged';
    const deployed = units.filter(unitIsDeployed);
    if (deployed.length === 0) return 'pending';
    return deployed.every((u) => u.state === 'packed') ? 'packed' : 'pending';
  }
  const dist = item.distribution || [];
  if (dist.length === 0) return 'pending';
  if (dist.every((d) => d.state === 'packed')) return 'packed';
  return 'pending';
}

// ── Out-of-service (mirrors itemIsOutOfService / itemHasOpenServiceFlag) ───────────────
export function itemHasOpenServiceFlag(item: InventoryPayload): boolean {
  return (item?.flags || []).some(
    (f) => f && f.status === 'open' && (f.category === 'damage' || f.category === 'maintenance')
  );
}

// ── Per-unit service (serial items) ───────────────────────────────────────────────────
const isDuePast = (due: string | null | undefined, todayIso?: string): boolean => {
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return false;
  return due <= (todayIso || new Date().toISOString().slice(0, 10));
};

export function unitHasOpenServiceFlag(u: ItemUnit): boolean {
  return (u?.flags || []).some((f) => f && f.status === 'open' && (f.category === 'damage' || f.category === 'maintenance'));
}
/** A single physical unit is out of service: its own status, or an open damage/maintenance flag. */
export function unitIsOutOfService(u: ItemUnit): boolean {
  if (!u) return false;
  return u.status === 'out_of_service' || unitHasOpenServiceFlag(u);
}
export function unitIsDueForService(u: ItemUnit, todayIso?: string): boolean {
  return isDuePast(u?.nextServiceDate, todayIso);
}
/** Count of live units currently out of service (serial items). */
export function unitsOutOfServiceCount(item: InventoryPayload): number {
  if (!itemIsSerial(item)) return 0;
  return itemUnits(item).filter(unitIsOutOfService).length;
}

export function itemIsOutOfService(item: InventoryPayload): boolean {
  if (!item) return false;
  if (item.status === 'out_of_service') return true;
  if (itemHasOpenServiceFlag(item)) return true;
  // Serial: the type is "out of service" (for the catalog repair-queue filter/badge) when ANY of its
  // physical units is — but the whole type is never force-marked; that happens per unit.
  if (itemIsSerial(item)) return itemUnits(item).some(unitIsOutOfService);
  return false;
}

/** Due (or overdue) for scheduled service: a nextServiceDate (ISO date) is set and is today or past.
 *  For serial items, ANY unit being due counts (so the catalog filter surfaces the item). */
export function itemIsDueForService(item: InventoryPayload, todayIso?: string): boolean {
  if (isDuePast(item?.nextServiceDate, todayIso)) return true;
  if (itemIsSerial(item)) return itemUnits(item).some((u) => unitIsDueForService(u, todayIso));
  return false;
}

// ── Flag mutators (pure; mirror index.html addFlag / resolveFlag ~L9423) ────────────────────
/** Build the next flags[] for ADDING an open flag (addFlag). Returns a NEW array (never mutates). */
export function addFlag(
  item: InventoryPayload,
  { note, severity, category, by }: { note?: string; severity?: string; category?: string; by?: string }
): ItemFlag[] {
  const cat = ['damage', 'maintenance', 'general'].includes(String(category)) ? String(category) : 'general';
  const entry: ItemFlag = {
    id: 'flag-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
    note: note || '',
    severity: severity || 'med',
    category: cat,
    flaggedAt: new Date().toISOString(),
    flaggedBy: by || 'unknown',
    status: 'open',
    resolvedAt: undefined,
    resolvedBy: undefined,
    resolution: undefined,
  };
  return [...(item.flags || []), entry];
}

/** Build the next flags[] for RESOLVING a flag (resolveFlag). Returns a NEW array (never mutates). */
export function resolveFlag(
  item: InventoryPayload,
  flagId: string,
  { resolution, by }: { resolution?: string; by?: string }
): ItemFlag[] {
  return (item.flags || []).map((f) =>
    f.id === flagId
      ? {
          ...f,
          status: 'resolved' as const,
          resolvedAt: new Date().toISOString(),
          resolvedBy: by || 'unknown',
          resolution: resolution || '',
        }
      : f
  );
}

/** The first OPEN flag on an item, or null. Mirrors `(it.flags||[]).find(f => f.status === 'open')`. */
export function itemOpenFlag(item: InventoryPayload): ItemFlag | null {
  return (item.flags || []).find((f) => f && f.status === 'open') ?? null;
}

// ── Out-of-service lifecycle (pure; mirror markItemOutOfService / returnItemToService ~L9462) ─────
/** Mark an item out of service: set status + optionally raise a damage/maintenance flag. Returns the
 *  next patch shape { status, flags } (the caller persists via upsertItem). */
export function markItemOutOfService(
  item: InventoryPayload,
  { note, severity, category, by }: { note?: string; severity?: string; category?: string; by?: string }
): { status: 'out_of_service'; flags: ItemFlag[] } {
  let flags = item.flags || [];
  if (note && note.trim()) {
    flags = addFlag({ ...item, flags }, { note: note.trim(), severity: severity || 'med', category: category || 'damage', by });
  }
  return { status: 'out_of_service', flags };
}

/** Return an item to service: clear status + resolve every open damage/maintenance flag with the
 *  resolution text. Returns the next patch shape { status, flags }. */
export function returnItemToService(
  item: InventoryPayload,
  { resolution, by, repairCost, assignedTech }: { resolution?: string; by?: string; repairCost?: number | null; assignedTech?: string }
): { status: null; flags: ItemFlag[] } {
  const cost = repairCost != null && Number.isFinite(Number(repairCost)) ? Number(repairCost) : undefined;
  const tech = assignedTech && assignedTech.trim() ? assignedTech.trim() : undefined;
  const flags = (item.flags || []).map((f) =>
    f && f.status === 'open' && (f.category === 'damage' || f.category === 'maintenance')
      ? {
          ...f,
          status: 'resolved' as const,
          resolvedAt: new Date().toISOString(),
          resolvedBy: by || 'unknown',
          resolution: resolution || 'Returned to service',
          ...(cost != null ? { repairCost: cost } : {}),
          ...(tech ? { assignedTech: tech } : {}),
        }
      : f
  );
  return { status: null, flags };
}

// ── Per-unit service mutators (serial items; mirror the item-level builders but for one unit) ──────
/** Mark ONE unit out of service: set its status + raise a damage/maintenance flag on the unit.
 *  Returns a NEW units[] (never mutates). Other units are untouched. */
export function markUnitOutOfService(
  units: ItemUnit[],
  unitId: string,
  { note, severity, category, by }: { note?: string; severity?: string; category?: string; by?: string }
): ItemUnit[] {
  return (units || []).map((u) => {
    if (u.id !== unitId) return u;
    const flags = note && note.trim() ? addFlag({ flags: u.flags }, { note: note.trim(), severity: severity || 'high', category: category || 'damage', by }) : u.flags || [];
    return { ...u, status: 'out_of_service', flags };
  });
}

/** Return ONE unit to service: clear its status + resolve its open damage/maintenance flags. */
export function returnUnitToService(
  units: ItemUnit[],
  unitId: string,
  { resolution, by, repairCost, assignedTech }: { resolution?: string; by?: string; repairCost?: number | null; assignedTech?: string }
): ItemUnit[] {
  const cost = repairCost != null && Number.isFinite(Number(repairCost)) ? Number(repairCost) : undefined;
  const tech = assignedTech && assignedTech.trim() ? assignedTech.trim() : undefined;
  return (units || []).map((u) => {
    if (u.id !== unitId) return u;
    const flags = (u.flags || []).map((f) =>
      f && f.status === 'open' && (f.category === 'damage' || f.category === 'maintenance')
        ? {
            ...f,
            status: 'resolved' as const,
            resolvedAt: new Date().toISOString(),
            resolvedBy: by || 'unknown',
            resolution: resolution || 'Returned to service',
            ...(cost != null ? { repairCost: cost } : {}),
            ...(tech ? { assignedTech: tech } : {}),
          }
        : f
    );
    return { ...u, status: null, flags };
  });
}

// ── Per-case flagging (a flag from a road case targets the serial(s) physically in that case) ──────
/** Live units of a serial item currently located in the given case. */
export function unitsInCase(item: InventoryPayload, caseId: string): ItemUnit[] {
  return itemUnits(item).filter((u) => u.location === caseId);
}

/** The OPEN flag relevant to this case: for a serial item, an open flag on a unit IN this case (else
 *  a type-level open flag if any); for bulk, the item-level open flag. Drives the case row's
 *  "flagged" state + the Resolve action so a flag added to one serial shows on that case row. */
export function caseOpenFlag(item: InventoryPayload, caseId: string): ItemFlag | null {
  if (itemIsSerial(item)) {
    for (const u of unitsInCase(item, caseId)) {
      const f = (u.flags || []).find((x) => x && x.status === 'open');
      if (f) return f;
    }
  }
  return itemOpenFlag(item);
}

/** True iff the flag id lives on one of the item's units (vs the item-level flags). */
export function flagIsOnUnit(item: InventoryPayload, flagId: string): boolean {
  return (item.units || []).some((u) => u && (u.flags || []).some((f) => f && f.id === flagId));
}

/** Add a flag to the named units (by id). Returns a NEW units[] (deleted/other units untouched). */
export function addFlagToUnits(
  item: InventoryPayload,
  unitIds: string[],
  flag: { note?: string; severity?: string; category?: string; by?: string }
): ItemUnit[] {
  const set = new Set(unitIds);
  return (item.units || []).map((u) =>
    u && !u.deletedAt && u.id && set.has(u.id) ? { ...u, flags: addFlag({ flags: u.flags } as InventoryPayload, flag) } : u
  );
}

/** Resolve a flag by id wherever it lives on the units. Returns a NEW units[]. */
export function resolveUnitFlagById(
  item: InventoryPayload,
  flagId: string,
  { resolution, by }: { resolution?: string; by?: string }
): ItemUnit[] {
  return (item.units || []).map((u) => {
    if (!u || !(u.flags || []).some((f) => f && f.id === flagId)) return u;
    return {
      ...u,
      flags: (u.flags || []).map((f) =>
        f && f.id === flagId
          ? { ...f, status: 'resolved' as const, resolvedAt: new Date().toISOString(), resolvedBy: by || 'unknown', resolution: resolution || '' }
          : f
      ),
    };
  });
}

// ── Storage stock (mirrors itemStockTotal / itemInStorage / itemHasStorage) ────────────
export function itemStockTotal(item: InventoryPayload): number {
  if (itemIsSerial(item)) return itemUnits(item).length; // serial: total known units
  const deployed = itemTotalQty(item);
  const raw = item && item.stockTotal != null && (item.stockTotal as unknown) !== '' ? Number(item.stockTotal) : null;
  if (raw == null || Number.isNaN(raw)) return deployed;
  return Math.max(raw, deployed);
}

export function itemInStorage(item: InventoryPayload): number {
  if (itemIsSerial(item)) return itemUnits(item).filter((u) => !unitIsDeployed(u)).length;
  return Math.max(0, itemStockTotal(item) - itemTotalQty(item));
}

export function itemHasStorage(item: InventoryPayload): boolean {
  if (itemInStorage(item) > 0) return true;
  if (itemIsSerial(item)) return itemUnits(item).some((u) => !unitIsDeployed(u) && !!u.storageNote && u.storageNote.trim() !== '');
  if (item && typeof item.storageNotes === 'string' && item.storageNotes.trim() !== '') return true;
  return false;
}

/** Low on stock: a reorderPoint is set and the in-storage surplus is below it. */
export function itemIsLowStock(item: InventoryPayload): boolean {
  return item.reorderPoint != null && itemInStorage(item) < item.reorderPoint;
}

// ── Kind glyph (mirrors KIND_ICON) — returns an Icon name from the shared set ───────────
export type KindIconName = 'box' | 'bolt' | 'spool' | 'layers' | 'case';
export function kindIcon(kind: string | undefined): KindIconName {
  switch (kind) {
    case 'equipment':
      return 'box';
    case 'peripheral':
      return 'bolt';
    case 'consumable':
      return 'spool';
    case 'tool':
      return 'bolt';
    case 'banner':
      return 'layers';
    case 'fixture':
      return 'case';
    case 'system':
      return 'box';
    default:
      return 'case';
  }
}

// ── Search match (mirrors the InventoryPanel search predicate) ─────────────────────────
/** Does an item match a free-text query? Matches name, id, sku, qr, AND any serial
 *  (bulk distribution serials + serial-item unit serials). Case-insensitive. */
export function itemMatchesQuery(item: InventoryPayload, id: string, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (item.name && item.name.toLowerCase().includes(needle)) return true;
  if (id && id.toLowerCase().includes(needle)) return true;
  if (item.sku && item.sku.toLowerCase().includes(needle)) return true;
  if (item.qr && item.qr.toLowerCase().includes(needle)) return true;
  if ((item.skuOptions || []).some((o) => o.sku && o.sku.toLowerCase().includes(needle))) return true;
  if (
    (item.distribution || []).some((d) =>
      (d.serials || []).some((s) => String(s).toLowerCase().includes(needle))
    )
  )
    return true;
  if ((Array.isArray(item.units) ? item.units : []).some((u) => u && u.serial && String(u.serial).toLowerCase().includes(needle)))
    return true;
  return false;
}

// ── Filter ids (mirrors invFilterChips) ────────────────────────────────────────────────
export const INVENTORY_FILTERS = [
  'all',
  'unassigned',
  'has-storage',
  'restock',
  'repair_queue',
  'due_for_service',
  ...ITEM_KINDS,
] as const;
export type InventoryFilter = (typeof INVENTORY_FILTERS)[number];

/** Does an item pass a (non-search) filter id? Mirrors the InventoryPanel `visible` memo. */
export function itemPassesFilter(item: InventoryPayload, id: string, filter: string): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'unassigned':
      return itemCaseIds(item).length === 0;
    case 'has-storage':
      return itemHasStorage(item);
    case 'restock':
      return itemIsLowStock(item);
    case 'repair_queue':
      return itemIsOutOfService(item);
    case 'due_for_service':
      return itemIsDueForService(item);
    default:
      if ((ITEM_KINDS as readonly string[]).includes(filter)) {
        return (item.kind || item.type) === filter;
      }
      return true; // unknown filter => no-op (don't hide everything)
  }
}

// ── Display tone for the rollup state chip ─────────────────────────────────────────────
// The inventory rollup states aren't event-lifecycle states, so they don't map to the
// --st-<state> tokens. Map them to the Badge tones instead.
export type ItemStateTone = 'ok' | 'neutral' | 'error';
export function itemStateTone(state: ItemState): ItemStateTone {
  if (state === 'packed') return 'ok';
  if (state === 'flagged') return 'error';
  return 'neutral'; // pending / draft
}

export const ITEM_STATE_LABEL: Record<ItemState, string> = {
  packed: 'PACKED',
  pending: 'PENDING',
  flagged: 'FLAGGED',
  draft: 'DRAFT',
};

// ── #43 multi-SKU + #27 kit-requirement matching (pure; mirror index.html ~L11164-11254) ───────
/** Every SKU the listing covers (primary item.sku first, then skuOptions[].sku), deduped. */
export function itemSkuList(item: InventoryPayload): string[] {
  if (!item) return [];
  const raw: string[] = [];
  if (item.sku) raw.push(String(item.sku));
  for (const o of Array.isArray(item.skuOptions) ? item.skuOptions : []) {
    if (o && o.sku) raw.push(String(o.sku));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw) {
    const k = s.trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/** Does the listing carry this SKU (any variant)? Case-insensitive. */
export function itemHasSku(item: InventoryPayload, sku: string | null | undefined): boolean {
  if (!item || sku == null || sku === '') return false;
  const needle = String(sku).trim().toLowerCase();
  return itemSkuList(item).some((s) => s.trim().toLowerCase() === needle);
}

/** Does an item satisfy a partRef? A 'tag' ref matches when the item carries that tag id; an
 *  'item' ref matches by id OR any variant SKU (#43). Mirrors itemMatchesPartRef. */
export function itemMatchesPartRef(item: InventoryPayload, partRef: PartRef | null | undefined): boolean {
  if (!item || !partRef || !partRef.ref) return false;
  if (partRef.kind === 'tag') return Array.isArray(item.tagIds) && item.tagIds.indexOf(partRef.ref) >= 0;
  return item.id === partRef.ref || itemHasSku(item, partRef.ref);
}

/** A minimal tag shape for partRef labels (id + label) — avoids importing the full DashTag here. */
export interface PartRefTag {
  id: string;
  label?: string;
}
/** Human label for a partRef — "any <tag>" for a tag group, else the target item's name/SKU. */
export function partRefLabel(
  partRef: PartRef | null | undefined,
  allInv: { id?: string; name?: string; sku?: string; skuOptions?: SkuOption[]; tagIds?: string[] }[],
  allTags: PartRefTag[]
): string {
  if (!partRef || !partRef.ref) return '(unset)';
  if (partRef.kind === 'tag') {
    const t = (allTags || []).find((x) => x && x.id === partRef.ref);
    return 'any ' + (t ? t.label || t.id : partRef.ref);
  }
  const it = (allInv || []).find((x) => x && (x.id === partRef.ref || itemHasSku(x as InventoryPayload, partRef.ref)));
  return it ? it.name || it.sku || (it.id as string) : partRef.ref;
}

export interface KitChecklistLine {
  req: KitRequirement;
  label: string;
  needed: number;
  have: number;
  met: boolean;
  consumable: boolean;
  mode: 'atLeast' | 'exact';
  note: string;
}

/** Evaluate a model's requirements against a candidate satisfier pool (the global stock view).
 *  contextCount(it) returns how many of `it` are available in scope. Mirrors
 *  evaluateModelRequirements (index.html ~L11235): excludes the model itself + out-of-service. */
export function evaluateModelRequirements(
  model: InventoryPayload,
  contextItems: InventoryPayload[],
  contextCount: (it: InventoryPayload) => number,
  allInv: InventoryPayload[],
  allTags: PartRefTag[],
  modelUnits = 1
): KitChecklistLine[] {
  const reqs = model && Array.isArray(model.requirements) ? model.requirements : [];
  const units = modelUnits && modelUnits > 0 ? modelUnits : 1;
  return reqs.map((req) => {
    let have = 0;
    for (const it of contextItems || []) {
      if (!it || it.id === model.id) continue;
      if (itemIsOutOfService(it)) continue;
      if (itemMatchesPartRef(it, req.partRef)) have += contextCount(it);
    }
    const needed = (Number(req.qty) || 1) * units;
    return {
      req,
      label: partRefLabel(req.partRef, allInv || contextItems, allTags),
      needed,
      have,
      met: have >= needed,
      consumable: !!req.consumable,
      mode: req.mode === 'exact' ? 'exact' : 'atLeast',
      note: req.note || '',
    };
  });
}
