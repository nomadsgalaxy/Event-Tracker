// lib/views/manifest-view.ts — PURE, isomorphic EVENT-manifest builder.
//
// Faithful port of ManifestPool's per-event `useManMemo` (index.html ~L15976-16081): given an
// event and the live inventory, it derives the per-CASE groups, the LOOSE group (items attached
// directly to the event outside a roadcase), the per-KIND rollup, and the event TOTALS — packed /
// pending / flagged / total units. No I/O, no 'server-only': the Manifest Server Component computes
// this after the live DB read and the count never drifts from the logic that produced it (the same
// single-source rule lib/case-view / lib/inventory-shape follow).
//
// It reuses the ITEM primitives from lib/inventory-shape (itemIsSerial / itemUnits / itemCaseIds /
// itemRollupState) and the per-case quantity/state reads from lib/case-view (itemQtyInCase /
// itemStateInCase) so bulk vs. serial (#22) items and per-case packed/pending math read IDENTICALLY
// here, in the catalog, and in a case detail. The output rows are LEAN + serializable (no Mongo
// internals) so a Server Component can hand them straight to the client island.

import {
  itemIsSerial,
  itemUnits,
  itemCaseIds,
  itemRollupState,
  type InventoryPayload,
} from '@/lib/views/inventory-shape';
import { itemQtyInCase, itemStateInCase } from '@/lib/views/case-view';
import type { CasePayload, EventPayload } from '@/lib/types/types';

// The seven item kinds, in the rollup display order ManifestPool uses (KIND_ORDER, index.html
// ~L15780) — equipment & systems first, the consumables/tools/decor after. Unknown kinds append.
export const KIND_ORDER = [
  'equipment',
  'system',
  'peripheral',
  'consumable',
  'tool',
  'banner',
  'fixture',
] as const;

// The human kind labels for the rollup chips (KIND_LABEL, index.html ~L15762).
export const KIND_LABEL: Record<string, string> = {
  equipment: 'Equipment',
  peripheral: 'Peripherals',
  consumable: 'Consumables',
  tool: 'Tools',
  banner: 'Banners',
  fixture: 'Fixtures',
  system: 'Systems',
};

/** The per-case packed disposition of one item, threaded onto a manifest row. */
export type RowState = 'packed' | 'pending' | 'flagged';

/** One inventory item inside a case (or loose group) on the event manifest. LEAN + serializable. */
export interface ManifestItemRow {
  id: string;
  name: string;
  kind: string;
  /** Data-Matrix / QR code value (the scan code), if any. */
  qr: string;
  /** SKU / human code (falls back to the id in the row chip). */
  sku: string;
  qty: number;
  state: RowState;
  /** Serial numbers in THIS case for this row (serial item units, or a bulk row's serials[]). */
  serials: string[];
  /** True iff the item carries an open flag (drives the warning tint + the flag count). */
  flagged: boolean;
}

/** One roadcase group on the event manifest — the case + its item rows + the packed/total math. */
export interface ManifestCaseGroup {
  caseId: string;
  label: string;
  /** The case's human slug, when distinct from the id (else ''). */
  slug: string;
  /** The SKUs this case kits (kitFor), for the "kit for …" subline. */
  kitFor: string[];
  rows: ManifestItemRow[];
  total: number;
  packed: number;
  pending: number;
  flagged: number;
}

/** The loose-inventory group — items attached to the event with no case (carry-on / hand-carried). */
export interface ManifestLooseGroup {
  rows: ManifestItemRow[];
  total: number;
  packed: number;
  pending: number;
  flagged: number;
}

/** A per-kind rollup chip (Equipment 12/14, Consumables 3/3, …). */
export interface ManifestKindRollup {
  kind: string;
  label: string;
  total: number;
  packed: number;
  pending: number;
  flagged: number;
}

export interface ManifestTotals {
  total: number;
  packed: number;
  pending: number;
  flagged: number;
}

export interface EventManifest {
  caseGroups: ManifestCaseGroup[];
  looseGroup: ManifestLooseGroup | null;
  kindGroups: ManifestKindRollup[];
  totals: ManifestTotals;
}

// A bulk distribution row is LOOSE for this event iff it has no caseId and its eventId is the event.
// Mirrors ManifestPool's `matchesEventLoose` (index.html ~L15979).
function isLooseRow(
  d: { caseId?: string | null; eventId?: string | null },
  eventId: string
): boolean {
  return !d.caseId && d.eventId === eventId;
}

// Build one ManifestItemRow for an item inside a specific case. Reuses the shared per-case
// quantity/state reads so a serial item and a bulk item read identically.
function caseRow(item: InventoryPayload, caseId: string): ManifestItemRow {
  const qty = itemQtyInCase(item, caseId);
  const perCase = itemStateInCase(item, caseId); // 'packed' | 'pending' | null
  const flagged = itemRollupState(item) === 'flagged';
  const state: RowState = flagged ? 'flagged' : perCase === 'packed' ? 'packed' : 'pending';
  // Serials in THIS case: serial-item units routed here, or the bulk distribution row's serials[].
  const serials = itemIsSerial(item)
    ? itemUnits(item)
        .filter((u) => u.location === caseId)
        .map((u) => u.serial)
        .filter((s): s is string => !!s)
    : (item.distribution ?? [])
        .filter((d) => d.caseId === caseId)
        .flatMap((d) => d.serials ?? [])
        .filter((s): s is string => !!s);
  return {
    id: item.id ?? '',
    name: item.name ?? '(unnamed)',
    kind: item.kind ?? item.type ?? 'other',
    qr: item.qr ?? '',
    sku: item.sku ?? '',
    qty,
    state,
    serials,
    flagged,
  };
}

/**
 * Build the full event manifest from the live inventory + the event's roadcases. Mirrors
 * ManifestPool's `useManMemo` exactly:
 *   • caseGroups — one per event.cases[] id (even an empty case), with the per-case packed/total
 *     math and the contained item rows (case-routed only — loose items have their own group).
 *   • looseGroup — items with ≥1 (caseId:null, eventId:<event>) bulk row; the carry-on / hand-
 *     carried pool. null when there are none. Serial items don't loose-attach (no eventId on a
 *     unit), so the loose group is bulk-only — matching the source.
 *   • kindGroups — the per-kind packed/total rollup across BOTH case-routed and loose rows, serial
 *     units counted once each (location === a held case), in KIND_ORDER then unknowns.
 *   • totals — the event-wide packed / pending / flagged / total unit counts (same accumulation).
 *
 * `casesById` resolves each case id → its payload for the label / slug / kitFor subline; a missing
 * case degrades to a stub group keyed by the id (a case can be assigned then deleted).
 */
export function buildEventManifest(
  event: EventPayload,
  eventId: string,
  inventory: InventoryPayload[],
  casesById: Record<string, CasePayload>
): EventManifest {
  const caseIds = new Set(event.cases ?? []);

  // The items in play: routed into one of the event's cases OR loose-attached to the event.
  const items = inventory.filter(
    (it) =>
      itemCaseIds(it).some((cid) => caseIds.has(cid)) ||
      (it.distribution ?? []).some((d) => isLooseRow(d, eventId))
  );

  // ── By case (case-routed rows only) ─────────────────────────────────────────────────────
  const caseGroups: ManifestCaseGroup[] = (event.cases ?? []).map((cid) => {
    const c = casesById[cid];
    const rows = items.filter((it) => itemCaseIds(it).includes(cid)).map((it) => caseRow(it, cid));
    let total = 0;
    let packed = 0;
    let pending = 0;
    let flagged = 0;
    for (const r of rows) {
      total += r.qty;
      if (r.flagged) flagged += r.qty;
      // packed/pending track the per-case disposition (flagged rows still count toward packed/
      // pending by their underlying state — mirrors stateQtyInCase, which is flag-independent).
      const perCase = r.state === 'flagged' ? null : r.state;
      if (perCase === 'packed') packed += r.qty;
      else if (perCase === 'pending') pending += r.qty;
    }
    // Re-derive packed/pending flag-independently so a flagged-but-packed row still counts as packed
    // (matches stateQtyInCase, which keys on the raw per-case state, not the rollup).
    packed = 0;
    pending = 0;
    for (const it of items.filter((x) => itemCaseIds(x).includes(cid))) {
      const st = itemStateInCase(it, cid);
      const q = itemQtyInCase(it, cid);
      if (st === 'packed') packed += q;
      else if (st === 'pending') pending += q;
    }
    // Order rows: flagged first, then pending, then packed, then by name.
    const rank = { flagged: 0, pending: 1, packed: 2 } as const;
    rows.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
    return {
      caseId: cid,
      label: c?.label || c?.slug || cid,
      slug: c?.slug && c.slug !== cid ? c.slug : '',
      kitFor: Array.isArray(c?.kitFor) ? c.kitFor.filter((k): k is string => !!k) : [],
      rows,
      total,
      packed,
      pending,
      flagged,
    };
  });

  // ── Loose group (bulk rows with caseId:null, eventId:<event>) ───────────────────────────
  const looseItems = items.filter((it) => (it.distribution ?? []).some((d) => isLooseRow(d, eventId)));
  let looseGroup: ManifestLooseGroup | null = null;
  if (looseItems.length > 0) {
    const rows: ManifestItemRow[] = [];
    let total = 0;
    let packed = 0;
    let pending = 0;
    let flagged = 0;
    for (const it of looseItems) {
      const isFlagged = itemRollupState(it) === 'flagged';
      let qty = 0;
      let allPacked = true;
      const serials: string[] = [];
      for (const d of it.distribution ?? []) {
        if (!isLooseRow(d, eventId)) continue;
        const q = d.qty || 1;
        qty += q;
        total += q;
        if (d.state === 'packed') packed += q;
        else {
          pending += q;
          allPacked = false;
        }
        if (isFlagged) flagged += q;
        for (const s of d.serials ?? []) if (s) serials.push(s);
      }
      rows.push({
        id: it.id ?? '',
        name: it.name ?? '(unnamed)',
        kind: it.kind ?? it.type ?? 'other',
        qr: it.qr ?? '',
        sku: it.sku ?? '',
        qty,
        state: isFlagged ? 'flagged' : allPacked ? 'packed' : 'pending',
        serials,
        flagged: isFlagged,
      });
    }
    const rank = { flagged: 0, pending: 1, packed: 2 } as const;
    rows.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
    looseGroup = { rows, total, packed, pending, flagged };
  }

  // ── By kind (case-routed + loose; serial units counted once) ────────────────────────────
  const byKind: Record<string, { total: number; packed: number; pending: number; flagged: number }> = {};
  const bump = (k: string) => (byKind[k] ??= { total: 0, packed: 0, pending: 0, flagged: 0 });
  for (const it of items) {
    const k = it.kind || it.type || 'other';
    const g = bump(k);
    const isFlagged = itemRollupState(it) === 'flagged';
    if (itemIsSerial(it)) {
      for (const u of itemUnits(it)) {
        if (!u.location || u.location === 'storage' || !caseIds.has(u.location)) continue;
        g.total += 1;
        if (u.state === 'packed') g.packed += 1;
        else g.pending += 1;
        if (isFlagged) g.flagged += 1;
      }
      continue;
    }
    for (const d of it.distribution ?? []) {
      const matchesCase = d.caseId && caseIds.has(d.caseId);
      const matchesLoose = isLooseRow(d, eventId);
      if (!matchesCase && !matchesLoose) continue;
      const q = d.qty || 1;
      g.total += q;
      if (d.state === 'packed') g.packed += q;
      else g.pending += q;
      if (isFlagged) g.flagged += q;
    }
  }
  const orderedKinds = (KIND_ORDER as readonly string[])
    .filter((k) => byKind[k])
    .concat(Object.keys(byKind).filter((k) => !(KIND_ORDER as readonly string[]).includes(k)));
  const kindGroups: ManifestKindRollup[] = orderedKinds.map((k) => ({
    kind: k,
    label: KIND_LABEL[k] || k,
    ...byKind[k],
  }));

  // ── Event totals (same accumulation, across every held case + loose row) ────────────────
  const totals: ManifestTotals = { total: 0, packed: 0, pending: 0, flagged: 0 };
  for (const it of items) {
    const isFlagged = itemRollupState(it) === 'flagged';
    if (itemIsSerial(it)) {
      for (const u of itemUnits(it)) {
        if (!u.location || u.location === 'storage' || !caseIds.has(u.location)) continue;
        totals.total += 1;
        if (u.state === 'packed') totals.packed += 1;
        else totals.pending += 1;
        if (isFlagged) totals.flagged += 1;
      }
      continue;
    }
    for (const d of it.distribution ?? []) {
      const matchesCase = d.caseId && caseIds.has(d.caseId);
      const matchesLoose = isLooseRow(d, eventId);
      if (!matchesCase && !matchesLoose) continue;
      const q = d.qty || 1;
      totals.total += q;
      if (d.state === 'packed') totals.packed += q;
      else totals.pending += q;
      if (isFlagged) totals.flagged += q;
    }
  }

  return { caseGroups, looseGroup, kindGroups, totals };
}

// ── Sidebar event-list row (lean projection) ──────────────────────────────────────────────
/** A resolved, VISIBLE tag chip for the sidebar event row (hidden tags excluded server-side). */
export interface ManifestRowTag {
  id: string;
  label: string;
  flair: string;
  color: string | null;
}

/** One event row for the manifest sidebar list: date / name / state + scanned/total + flagged. */
export interface ManifestEventListRow {
  id: string;
  name: string;
  state: string;
  dates: string; // pre-formatted range (locale-stable, computed server-side)
  city: string;
  /** Resolved VISIBLE tags (hidden tags filtered out server-side) → clickable TagChips → /tag/:id. */
  tags: ManifestRowTag[];
  scanned: number;
  total: number;
  flagged: number;
  caseCount: number;
  looseTotal: number;
  lead: string;
}
