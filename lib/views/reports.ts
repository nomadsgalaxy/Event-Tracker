// lib/views/reports.ts — PURE, isomorphic report builders for the Reports screen (DESIGN_ALIGNMENT §4.9).
//
// A faithful TypeScript port of the current app's report builders (index.html ~L29925-30152:
// buildReports / buildInventoryReport / buildEventsReport / buildConditionReport /
// buildPeopleReport). No I/O, no `server-only`: the page computes these after its LIVE Mongo read,
// and the resulting plain rows serialize straight down to the client table island. The ITEM/CASE
// primitives are reused from lib/inventory-shape + lib/case-view so a count never drifts from the
// catalog / manifest math that produced it (one source of truth, the #22 serial/bulk branch
// included).
//
// SHIPPING WEIGHT NOTE: the current app rolls a LOADED case weight (tare + contents). The Next.js
// inventory payload carries no per-item weight field, so we honestly roll the per-event CASE TARE
// weight (case.payload.weight, kg) and label it "Case weight" — no invented item masses. People &
// travel PII (accommodations) is GATED by the caller via lib/rbac `can()` and surfaced as a
// summary count only; raw travel legs are itinerary metadata the existing report already lists.

import {
  itemUnits,
  itemTotalQty,
  itemInStorage,
  itemStockTotal,
  itemCaseIds,
  itemIsOutOfService,
  type InventoryPayload,
  type ItemFlag,
} from '@/lib/views/inventory-shape';
import { itemQtyInCase } from '@/lib/views/case-view';
import { caseLoadedWeightKg } from '@/lib/util/weight';
import { canSeeStaffPii, canSeeAccommodations } from '@/lib/views/event-view';
import type { CasePayload, EventPayload, EventState, Staffer } from '@/lib/types/types';

// ── shared inputs ─────────────────────────────────────────────────────────────────────────
// The page hands the builders the live payloads keyed by id (envelope _id is the stable id the
// app uses everywhere — payload.id may be unset on older docs, so we always carry the _id).
export interface ItemEntry {
  id: string;
  payload: InventoryPayload;
}
export interface EventEntry {
  id: string;
  payload: EventPayload;
}
export interface CaseEntry {
  id: string;
  payload: CasePayload;
}

const itemName = (id: string, it: InventoryPayload) => it.name || it.slug || id;
const itemKind = (it: InventoryPayload) => it.kind || it.type || '—';
const weightKg = (w: number | string | null | undefined): number => {
  const n = parseFloat(String(w ?? ''));
  return !n || Number.isNaN(n) ? 0 : n;
};

// The return-disposition of a distribution row / serial unit (mirrors window.rowDispositionKind,
// index.html ~L6868): the explicit signoff.kind wins, else a returnDisposition ('clean' → 'ok',
// else the value verbatim — 'damaged' / 'missing' / 'returned_*'). null when neither is set.
function dispositionKind(rec: unknown): string | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as { signoff?: { kind?: unknown } | null; returnDisposition?: unknown };
  if (r.signoff && typeof r.signoff.kind === 'string' && r.signoff.kind) return r.signoff.kind;
  if (typeof r.returnDisposition === 'string' && r.returnDisposition) {
    return r.returnDisposition === 'clean' ? 'ok' : r.returnDisposition;
  }
  return null;
}

// ── 1. INVENTORY & STOCK ────────────────────────────────────────────────────────────────────
export interface InvKindRow {
  kind: string;
  rows: number;
  deployed: number;
  storage: number;
  total: number;
  weightKg: number;
  assetValue: number; // sum of (units) * purchasePrice across items in this kind (USD; 0 when unpriced)
}
export interface LowStockRow {
  name: string;
  kind: string;
  storage: number;
  reorderPoint: number;
  deficit: number;
}
export interface IdleRow {
  name: string;
  kind: string;
  storage: number;
}
export interface InventoryReport {
  kinds: InvKindRow[];
  totalDeployed: number;
  totalStorage: number;
  totalStock: number;
  totalWeightKg: number;
  totalAssetValue: number; // sum of (units) * purchasePrice across all items (USD; 0 when unpriced)
  utilizationPct: number;
  oosCount: number;
  itemCount: number;
  lowStock: LowStockRow[];
  idle: IdleRow[];
}

export function buildInventoryReport(items: ItemEntry[]): InventoryReport {
  const byKind = new Map<string, InvKindRow>();
  let totalDeployed = 0;
  let totalStorage = 0;
  let totalWeightKg = 0;
  let totalAssetValue = 0;
  let oosCount = 0;

  for (const { payload: it } of items) {
    const kind = String(itemKind(it));
    const dep = itemTotalQty(it);
    const sto = itemInStorage(it);
    // Per-kind weight rollup, faithful to _itemWeightKg * _itemTotal (index.html ~L30007-30012):
    // the item's per-unit tare weight (kg) times its total units (deployed + in storage).
    const wRoll = weightKg(it.weight) * (dep + sto);
    // Asset value: per-unit purchase price times total units (deployed + storage); 0 when unpriced.
    const price = it.purchasePrice != null && Number.isFinite(Number(it.purchasePrice)) ? Number(it.purchasePrice) : 0;
    const vRoll = price * (dep + sto);
    const b =
      byKind.get(kind) ?? { kind, rows: 0, deployed: 0, storage: 0, total: 0, weightKg: 0, assetValue: 0 };
    b.rows += 1;
    b.deployed += dep;
    b.storage += sto;
    b.total += dep + sto;
    b.weightKg += wRoll;
    b.assetValue += vRoll;
    byKind.set(kind, b);
    totalDeployed += dep;
    totalStorage += sto;
    totalWeightKg += wRoll;
    totalAssetValue += vRoll;
    if (itemIsOutOfService(it)) oosCount += 1;
  }

  const kinds = Array.from(byKind.values()).sort((a, b) => b.total - a.total);
  const totalStock = totalDeployed + totalStorage;
  const utilizationPct = totalStock > 0 ? Math.round((totalDeployed / totalStock) * 100) : 0;

  // Low stock: a reorderPoint is set and in-storage is below it.
  const lowStock: LowStockRow[] = items
    .filter(({ payload: it }) => it.reorderPoint != null && (it.reorderPoint as unknown) !== '' && itemInStorage(it) < Number(it.reorderPoint))
    .map(({ id, payload: it }) => {
      const storage = itemInStorage(it);
      const reorderPoint = Number(it.reorderPoint);
      return { name: itemName(id, it), kind: String(itemKind(it)), storage, reorderPoint, deficit: reorderPoint - storage };
    })
    .sort((a, b) => b.deficit - a.deficit);

  // Idle: never routed to a case and not currently deployed (all stock sits in storage).
  const idle: IdleRow[] = items
    .filter(({ payload: it }) => itemCaseIds(it).length === 0 && itemTotalQty(it) === 0 && itemStockTotal(it) > 0)
    .map(({ id, payload: it }) => ({ name: itemName(id, it), kind: String(itemKind(it)), storage: itemInStorage(it) }))
    .sort((a, b) => b.storage - a.storage);

  return {
    kinds,
    totalDeployed,
    totalStorage,
    totalStock,
    totalWeightKg,
    totalAssetValue,
    utilizationPct,
    oosCount,
    itemCount: items.length,
    lowStock,
    idle,
  };
}

// ── 2. EVENTS & CASES ─────────────────────────────────────────────────────────────────────
export interface StateCount {
  state: EventState | string;
  count: number;
}
export interface PerEventRow {
  id: string;
  name: string;
  state: EventState | string;
  startDate: string;
  items: number;
  cases: number;
  shippingKg: number;
}
export interface CaseUtilRow {
  id: string;
  label: string;
  events: number;
  contentsQty: number;
  deployed: boolean;
}
export interface EventsReport {
  byState: StateCount[];
  perEvent: PerEventRow[];
  caseUtil: CaseUtilRow[];
  eventCount: number;
  caseCount: number;
}

/** Total units routed into a case across all inventory (mirrors the case header's contents math). */
function caseContentsQty(caseId: string, items: ItemEntry[]): number {
  let n = 0;
  for (const { payload: it } of items) n += itemQtyInCase(it, caseId);
  return n;
}

/** Manifest item count for an event: every inventory unit packed into one of the event's cases,
 *  PLUS any bulk loose qty pegged to the event. Mirrors eventManifestStats' manifest total. */
function eventManifestItems(event: EventPayload, eventId: string, items: ItemEntry[]): number {
  const caseSet = new Set(event.cases ?? []);
  let n = 0;
  for (const { payload: it } of items) {
    for (const cid of caseSet) n += itemQtyInCase(it, cid);
    // Bulk loose rows pegged directly to the event (caseId null, eventId === this event).
    for (const d of it.distribution ?? []) {
      if (!d.caseId && d.eventId === eventId) n += d.qty ?? 0;
    }
  }
  return n;
}

export function buildEventsReport(items: ItemEntry[], events: EventEntry[], cases: CaseEntry[]): EventsReport {
  // Events by state.
  const stateMap = new Map<string, number>();
  for (const { payload: e } of events) {
    const s = String(e.state || 'draft');
    stateMap.set(s, (stateMap.get(s) || 0) + 1);
  }
  const byState: StateCount[] = Array.from(stateMap.entries())
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count);

  // Per-event summary: items / cases / total LOADED shipping weight. Faithful to the Python
  // (index.html ~L30043-30049): each assigned case contributes caseLoadedWeightKg = its tare
  // (case.weight) + the per-item weight of every unit routed into it. The item weights come from
  // the live inventory payloads (it.weight, kg), so the rollup is the real shipping mass — not a
  // tare-only figure.
  const caseById = new Map<string, CasePayload & { id: string }>();
  for (const { id, payload: c } of cases) caseById.set(id, { ...c, id });
  const invPayloads = items.map(({ payload }) => payload);

  const perEvent: PerEventRow[] = events
    .map(({ id, payload: e }) => {
      const caseIds = e.cases ?? [];
      let shippingKg = 0;
      for (const cid of caseIds) {
        const c = caseById.get(cid);
        if (c) shippingKg += caseLoadedWeightKg(c, invPayloads);
      }
      return {
        id,
        name: e.name || id,
        state: e.state || 'draft',
        startDate: e.startDate || '',
        items: eventManifestItems(e, id, items),
        cases: caseIds.length,
        shippingKg,
      };
    })
    .sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0));

  // Case utilization: how many events each case is assigned to + whether it currently holds stock.
  const useCount = new Map<string, number>();
  for (const { payload: e } of events) for (const cid of e.cases ?? []) useCount.set(cid, (useCount.get(cid) || 0) + 1);

  const caseUtil: CaseUtilRow[] = cases
    .map(({ id, payload: c }) => {
      const contentsQty = caseContentsQty(id, items);
      return {
        id,
        label: c.label || c.slug || id,
        events: useCount.get(id) || 0,
        contentsQty,
        deployed: contentsQty > 0,
      };
    })
    .sort((a, b) => b.events - a.events || b.contentsQty - a.contentsQty);

  return { byState, perEvent, caseUtil, eventCount: events.length, caseCount: cases.length };
}

// ── 3. CONDITION & LOSS ─────────────────────────────────────────────────────────────────────
export interface FlagCategoryRow {
  category: string;
  count: number;
}
export interface DamageRow {
  name: string;
  kind: string;
  openFlags: number;
  damaged: number;
  missing: number;
  incidents: number;
}
export interface ShrinkRow {
  itemName: string;
  qty: number;
  eventName: string;
  reason: string;
  dollarsLost: number; // qty * (replacementCost ?? purchasePrice ?? 0); 0 when the item is unpriced
}
export interface ConditionReport {
  flagsByCategory: FlagCategoryRow[];
  openFlagTotal: number;
  perItem: DamageRow[];
  shrink: ShrinkRow[];
  shrinkUnits: number;
  shrinkDollars: number; // sum of dollarsLost across all shrink rows (USD)
  closedCount: number;
}

const openFlags = (flags: ItemFlag[] | undefined): ItemFlag[] =>
  (flags ?? []).filter((f) => f && f.status === 'open');

export function buildConditionReport(items: ItemEntry[], events: EventEntry[]): ConditionReport {
  const flagCats = new Map<string, number>();
  let openFlagTotal = 0;
  const collect = (flags: ItemFlag[] | undefined) => {
    for (const f of openFlags(flags)) {
      const cat = f.category || 'general';
      flagCats.set(cat, (flagCats.get(cat) || 0) + 1);
      openFlagTotal += 1;
    }
  };

  // Damage/loss per item: open flags + return dispositions signed damaged/missing across rows/units.
  const perItem: DamageRow[] = [];
  for (const { id, payload: it } of items) {
    collect(it.flags);
    let openCount = openFlags(it.flags).length;
    let damaged = 0;
    let missing = 0;
    if (it.tracking === 'serial') {
      for (const u of itemUnits(it)) {
        if (u.flags) {
          collect(u.flags);
          openCount += openFlags(u.flags).length;
        }
        const k = dispositionKind(u);
        if (k === 'damaged' || k === 'returned_damaged') damaged += 1;
        if (k === 'missing' || k === 'returned_missing') missing += 1;
      }
    } else {
      for (const d of it.distribution ?? []) {
        const k = dispositionKind(d);
        const q = Number(d.qty || 0) || 0;
        if (k === 'damaged' || k === 'returned_damaged') damaged += q;
        if (k === 'missing' || k === 'returned_missing') missing += q;
      }
    }
    const incidents = openCount + damaged + missing;
    if (incidents > 0) {
      perItem.push({ name: itemName(id, it), kind: String(itemKind(it)), openFlags: openCount, damaged, missing, incidents });
    }
  }
  perItem.sort((a, b) => b.incidents - a.incidents);

  const flagsByCategory: FlagCategoryRow[] = Array.from(flagCats.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  // Shrinkage: for CLOSED events, every unit/row still 'packed' or signed missing in the event's
  // cases (or loose-pegged to the event) — inventory that never properly came back.
  const closed = events.filter(({ payload: e }) => e.state === 'closed');
  const shrink: ShrinkRow[] = [];
  let shrinkUnits = 0;
  let shrinkDollars = 0;
  // Value a lost unit at replacementCost, else purchasePrice, else 0 (uses the CURRENT price, not a
  // historical snapshot — fine for a running loss figure).
  const unitLossPrice = (it: ItemEntry['payload']): number => {
    const p = it.replacementCost ?? it.purchasePrice;
    return p != null && Number.isFinite(Number(p)) ? Number(p) : 0;
  };
  for (const { id: eventId, payload: e } of closed) {
    const eventCases = new Set(e.cases ?? []);
    const eventName = e.name || eventId;
    for (const { id, payload: it } of items) {
      const price = unitLossPrice(it);
      if (it.tracking === 'serial') {
        for (const u of itemUnits(it)) {
          if (!u.location || u.location === 'storage' || !eventCases.has(u.location)) continue;
          const k = dispositionKind(u);
          const isMissing = k === 'missing' || k === 'returned_missing';
          const stillPacked = u.state === 'packed' && !k;
          if (isMissing || stillPacked) {
            shrinkUnits += 1;
            shrinkDollars += price;
            shrink.push({ itemName: itemName(id, it), qty: 1, eventName, reason: isMissing ? 'Signed missing' : 'Never returned (still packed)', dollarsLost: price });
          }
        }
        continue;
      }
      for (const d of it.distribution ?? []) {
        const matchedByCase = d.caseId && eventCases.has(d.caseId);
        const matchedByEvent = !d.caseId && d.eventId === eventId;
        if (!matchedByCase && !matchedByEvent) continue;
        const k = dispositionKind(d);
        const isMissing = k === 'missing' || k === 'returned_missing';
        const stillPacked = d.state === 'packed' && !k;
        if (isMissing || stillPacked) {
          const qty = Number(d.qty || 0) || 0;
          shrinkUnits += qty;
          shrinkDollars += qty * price;
          shrink.push({ itemName: itemName(id, it), qty, eventName, reason: isMissing ? 'Signed missing' : 'Never returned (still packed)', dollarsLost: qty * price });
        }
      }
    }
  }

  return { flagsByCategory, openFlagTotal, perItem, shrink, shrinkUnits, shrinkDollars, closedCount: closed.length };
}

// ── 4. PEOPLE & TRAVEL ────────────────────────────────────────────────────────────────────
export interface LeadGapRow {
  id: string;
  name: string;
  state: EventState | string;
  staffCount: number;
}
export interface AssignmentRow {
  name: string;
  email: string;
  events: number;
}
export interface TravelRow {
  eventName: string;
  startDate: string;
  person: string;
  mode: string;
  outbound: string;
  return: string;
}
export interface PeopleReport {
  leadGaps: LeadGapRow[];
  assignments: AssignmentRow[];
  travel: TravelRow[];
  eventCount: number;
  // Accommodations / PII summary (index.html ~L30141-30151). The viewer can see the accommodations
  // profile for `accVisible` assigned staffers; `accGated` are hidden by the stricter
  // accommodations.view gate (manager+/self — NOT lead). `accGateActive` is whether a viewer is
  // signed in at all (here it is always true — the page is auth-gated — but kept for parity with the
  // Python wording branch).
  accVisible: number;
  accGated: number;
  accGateActive: boolean;
}

// One staffer's travel leg formatted to a single line (route · carrier · departAt). The leg shape
// is loose (Record) on the Next.js Staffer type — we read the known fields defensively.
function fmtLeg(leg: unknown): string {
  if (!leg || typeof leg !== 'object') return '';
  const lg = leg as Record<string, unknown>;
  const depart = typeof lg.departLocation === 'string' ? lg.departLocation : '';
  const arrive = typeof lg.arriveLocation === 'string' ? lg.arriveLocation : '';
  const route = depart || arrive ? `${depart || '?'} → ${arrive || '?'}` : '';
  const carrier = [lg.carrier, lg.number].filter((x) => typeof x === 'string' && x).join(' ');
  const at = typeof lg.departAt === 'string' ? lg.departAt : '';
  return [route, carrier, at].filter(Boolean).join(' · ');
}

/**
 * People & travel report. The lead-gap and assignment-count summaries carry NO PII and always build.
 * The two PII surfaces are gated INDEPENDENTLY, per-event + per-staffer, by the server-side gates in
 * lib/event-view (the SAME gates the EventDetail read-strip uses) — never a single coarse display flag:
 *
 *   • TRAVEL ROSTER (flights/hotel logistics) — `canSeeStaffPii(staffer, event, viewer, role, grants,
 *     eventId)`: manager+ sees ALL, otherwise only events the viewer LEADS, themselves, or an approved
 *     #167 travel-data grant for that exact (subject, event). A staffer the viewer can't see is NEVER
 *     pushed into the roster, so their flights never serialize to the client.
 *
 *   • ACCOMMODATIONS / PII SUMMARY — `canSeeAccommodations(staffer, viewer, role)`: the STRICTER gate,
 *     manager+ OR self ONLY — NOT a lead, NOT a travel grant (medical/dietary is more sensitive than
 *     travel logistics). We only emit visible/gated COUNTS here (no profile data crosses the wire);
 *     the actual profiles are shown per-event on EventDetail to permitted viewers.
 *
 * `viewerEmail`/`role` are the AUTHORITATIVE session values (requireUser); `grantsSet` is the viewer's
 * active #167 grant set (lib/grants.activeGrantsFor). The event id passed to canSeeStaffPii is the
 * envelope `_id` (the id the grant was written against) — never a client value.
 */
export function buildPeopleReport(
  events: EventEntry[],
  viewerEmail: string,
  role: string | null | undefined,
  grantsSet?: ReadonlySet<string> | null
): PeopleReport {
  // Lead-coverage gaps: events with no lead assigned.
  const leadGaps: LeadGapRow[] = events
    .filter(({ payload: e }) => !(e.lead && String(e.lead).trim()))
    .map(({ id, payload: e }) => ({ id, name: e.name || id, state: e.state || 'draft', staffCount: (e.staff ?? []).length }));

  // Staff assignment counts per person (keyed by email||name).
  const assignMap = new Map<string, AssignmentRow>();
  for (const { payload: e } of events) {
    for (const s of e.staff ?? []) {
      const key = (s.email || s.name || '').toLowerCase();
      if (!key) continue;
      const cur = assignMap.get(key) ?? { name: s.name || s.email || key, email: s.email || '', events: 0 };
      cur.events += 1;
      assignMap.set(key, cur);
    }
  }
  const assignments = Array.from(assignMap.values()).sort((a, b) => b.events - a.events);

  // Travel roster — one row per staffer-with-travel per event, gated PER (event, staffer) by
  // canSeeStaffPii. A row is emitted ONLY when the viewer may see THAT staffer on THAT event; a
  // staffer the viewer can't see contributes nothing (their PII never reaches the wire).
  const travel: TravelRow[] = [];
  for (const { id, payload: e } of events) {
    for (const s of e.staff ?? []) {
      const t = s.travel as Record<string, unknown> | undefined;
      if (!t || !(t.outbound || t.return)) continue;
      if (!canSeeStaffPii(s as Staffer, e, viewerEmail, role, grantsSet, id)) continue;
      travel.push({
        eventName: e.name || id,
        startDate: e.startDate || '',
        person: s.name || s.email || '(unknown)',
        mode: typeof t.mode === 'string' ? t.mode : 'travel',
        outbound: fmtLeg(t.outbound),
        return: fmtLeg(t.return),
      });
    }
  }
  travel.sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));

  // Accommodations / PII summary — count staff occurrences (one per staffer-per-event, faithful to
  // the Python's per-occurrence loop) whose accommodations profile this viewer MAY see vs is gated.
  // Faithful to index.html ~L30145-30150: only staffers WITH AN EMAIL are counted (the Python builds
  // a directory `rec` only when s.email is present, else skips the row). The gate is the STRICTER
  // canSeeAccommodations (manager+/self only) — independent of the travel gate above. Only COUNTS are
  // surfaced; no accommodations data is emitted.
  let accVisible = 0;
  let accGated = 0;
  for (const { payload: e } of events) {
    for (const s of e.staff ?? []) {
      if (!s || !s.email) continue;
      if (canSeeAccommodations(s as Staffer, viewerEmail, role)) accVisible += 1;
      else accGated += 1;
    }
  }

  return { leadGaps, assignments, travel, eventCount: events.length, accVisible, accGated, accGateActive: true };
}
