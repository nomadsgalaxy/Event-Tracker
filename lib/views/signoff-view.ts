// lib/views/signoff-view.ts — PURE, isomorphic sign-off readiness helpers.
//
// A faithful port of the existing app's sign-off math (index.html ~L3661–3772):
//   • eventCaseSignoffProgress — outbound (packing) progress: how many assigned roadcases are BOXED.
//   • eventSignoffProgress     — return (unpacking) progress: how many deployed item-rows are SIGNED,
//                                 plus the open-flag / damaged / missing tallies.
//   • eventCanCommitReady       — packing readiness gate: every case boxed + zero open flags.
//   • eventCanCommitClosed      — unpacking readiness gate: every item row signed.
//
// No I/O, no 'server-only' — the page computes readiness after the live DB read AND the client screen
// reuses the SAME logic, so a count never drifts from the logic that produced it (the single-source
// rule the dashboard/catalog ports use). The item primitives are reused from lib/inventory-shape so
// bulk vs. serial (#22) items count identically here and everywhere.

import {
  itemIsSerial,
  itemUnits,
  unitIsDeployed,
  itemIsOutOfService,
  itemHasOpenServiceFlag,
  rowDispositionKind,
  type InventoryPayload,
} from '@/lib/views/inventory-shape';
import type {
  EventPayload,
  ManifestSnapshot,
  ManifestSnapshotRow,
} from '@/lib/types/types';

// ── Per-roadcase outbound progress (#28) ──────────────────────────────────────────────────
export interface CaseSignoffProgress {
  total: number; // assigned cases
  signed: number; // boxed cases
  byCase: Record<string, boolean>; // caseId -> boxed?
}

/**
 * Outbound (packing) progress: count of the event's assigned roadcases that are BOXED
 * (event.caseSignoffs[caseId] present). Mirrors eventCaseSignoffProgress (index.html ~L3730).
 */
export function eventCaseSignoffProgress(event: EventPayload | null | undefined): CaseSignoffProgress {
  const cases = (event && event.cases) || [];
  const signoffs = (event && event.caseSignoffs) || {};
  const byCase: Record<string, boolean> = {};
  let signed = 0;
  for (const cid of cases) {
    const boxed = !!signoffs[cid];
    byCase[cid] = boxed;
    if (boxed) signed++;
  }
  return { total: cases.length, signed, byCase };
}

/** True iff this case is currently boxed for this event. Mirrors eventCaseIsBoxed. */
export function eventCaseIsBoxed(event: EventPayload | null | undefined, caseId: string): boolean {
  return !!(event && event.caseSignoffs && event.caseSignoffs[caseId]);
}

// ── Per-item return progress (unpacking) ──────────────────────────────────────────────────
export interface ItemSignoffProgress {
  total: number; // deployed item-rows on the event's cases (+ loose)
  signed: number; // rows carrying a sign-off
  flagged: number; // rows whose item carries an open flag
  damaged: number;
  missing: number;
  consumed: number;
  sold: number;
  looseTotal: number;
  looseSigned: number;
  byCase: Record<string, { total: number; signed: number }>;
}

/**
 * Return (unpacking) progress for an event across the live inventory. One unit per deployed
 * serial unit / per bulk distribution row whose case belongs to event.cases (plus loose rows
 * matched by eventId). Counts signed rows + the open-flag / disposition tallies. Faithful port of
 * eventSignoffProgress (index.html ~L3661). The disposition kind lives on the row's signoff (the
 * existing app stores { kind, at, ... }); this stack's lean DistributionRow.signoff only types
 * { at, by }, so the kind tallies read defensively off a loose cast and default to 0 — they stay
 * correct once the scan flow writes the richer shape.
 */
export function eventSignoffProgress(
  event: EventPayload | null | undefined,
  items: InventoryPayload[] | null | undefined
): ItemSignoffProgress {
  const empty: ItemSignoffProgress = {
    total: 0,
    signed: 0,
    flagged: 0,
    damaged: 0,
    missing: 0,
    consumed: 0,
    sold: 0,
    looseTotal: 0,
    looseSigned: 0,
    byCase: {},
  };
  if (!event) return empty;
  const eventCases = new Set(event.cases || []);
  const eventId = event.id;
  let total = 0;
  let signed = 0;
  let flagged = 0;
  let damaged = 0;
  let missing = 0;
  let consumed = 0;
  let sold = 0;
  let looseTotal = 0;
  let looseSigned = 0;
  const byCase: Record<string, { total: number; signed: number }> = {};
  for (const cid of event.cases || []) byCase[cid] = { total: 0, signed: 0 };

  // Read a disposition kind off a sign-off shape that may carry it (the existing app's richer row).
  const kindOf = (s: unknown): string => {
    if (s && typeof s === 'object' && 'kind' in s) return String((s as { kind?: unknown }).kind ?? '');
    return '';
  };

  for (const it of items || []) {
    const itFlagged = (it.flags || []).some((f) => f && f.status === 'open');
    if (itemIsSerial(it)) {
      for (const u of itemUnits(it)) {
        if (!u || !u.location || u.location === 'storage' || !eventCases.has(u.location)) continue;
        total++;
        if (byCase[u.location]) byCase[u.location].total++;
        const s = u.signoff;
        if (s) {
          signed++;
          if (byCase[u.location]) byCase[u.location].signed++;
          const k = kindOf(s);
          if (k === 'damaged') damaged++;
          if (k === 'missing') missing++;
          if (k === 'consumed') consumed++;
          if (k === 'sold') sold++;
        }
        if (itFlagged || (u.flags || []).some((f) => f && f.status === 'open')) flagged++;
      }
      continue;
    }
    for (const d of it.distribution || []) {
      const matchedByCase = !!d.caseId && eventCases.has(d.caseId);
      const matchedByEvent = !d.caseId && !!eventId && d.eventId === eventId;
      if (!matchedByCase && !matchedByEvent) continue;
      total++;
      if (matchedByCase && d.caseId) {
        byCase[d.caseId].total++;
      } else {
        looseTotal++;
      }
      const s = d.signoff;
      if (s) {
        signed++;
        if (matchedByCase && d.caseId) byCase[d.caseId].signed++;
        else looseSigned++;
        const k = kindOf(s);
        if (k === 'damaged') damaged++;
        if (k === 'missing') missing++;
        if (k === 'consumed') consumed++;
        if (k === 'sold') sold++;
      }
      if (itFlagged) flagged++;
    }
  }

  return { total, signed, flagged, damaged, missing, consumed, sold, byCase, looseTotal, looseSigned };
}

// ── Per-case manifest group for the checklist (packing + unpacking) ──────────────────────
export interface CaseSignoffGroup {
  caseId: string;
  label: string;
  boxed: boolean; // packing: caseSignoffs present
  hasFlags: boolean; // any open flag on a contained item
  packed: number; // rows in 'packed' state
  signed: number; // rows carrying a sign-off (unpacking)
  total: number; // rows routed into this case
}

/**
 * One readiness group per assigned case, with its contained-row counts + boxed/flag state. Mirrors
 * the caseBoxGroups memo in SignOffEvent (index.html ~L21486). `label` is resolved by the caller
 * (it owns the case-label map); this helper does the per-case row math from the live inventory.
 */
export function buildCaseGroups(
  event: EventPayload | null | undefined,
  items: InventoryPayload[] | null | undefined,
  caseLabels: Record<string, string>
): CaseSignoffGroup[] {
  if (!event) return [];
  const signoffs = event.caseSignoffs || {};
  const inv = items || [];
  return (event.cases || []).map((cid) => {
    let total = 0;
    let packed = 0;
    let signed = 0;
    let hasFlags = false;
    for (const it of inv) {
      const itFlagged = (it.flags || []).some((f) => f && f.status === 'open');
      if (itemIsSerial(it)) {
        for (const u of itemUnits(it)) {
          if (!unitIsDeployed(u) || u.location !== cid) continue;
          total++;
          if (u.state === 'packed') packed++;
          if (u.signoff) signed++;
          if (itFlagged || (u.flags || []).some((f) => f && f.status === 'open')) hasFlags = true;
        }
        continue;
      }
      for (const d of it.distribution || []) {
        if (d.caseId !== cid) continue;
        total++;
        if (d.state === 'packed') packed++;
        if (d.signoff) signed++;
        if (itFlagged) hasFlags = true;
      }
    }
    return {
      caseId: cid,
      label: caseLabels[cid] || cid,
      boxed: !!signoffs[cid],
      hasFlags,
      packed,
      signed,
      total,
    };
  });
}

// ── Readiness gates (the "can ship / can close" tests) ────────────────────────────────────
/**
 * Outbound readiness (#28): the event is in 'packing', EVERY assigned case is boxed, and there are
 * ZERO open flags on the event's items. Per-item scan state stays advisory. Mirrors
 * eventCanCommitReady (index.html ~L3758).
 */
export function eventCanCommitReady(
  event: EventPayload | null | undefined,
  items: InventoryPayload[] | null | undefined
): boolean {
  if (!event || event.state !== 'packing') return false;
  const cp = eventCaseSignoffProgress(event);
  if (cp.total === 0 || cp.signed !== cp.total) return false;
  const ip = eventSignoffProgress(event, items);
  return (ip.flagged || 0) === 0;
}

/**
 * Return readiness: the event is in 'unpacking' and EVERY deployed item row is signed.
 * Mirrors eventCanCommitClosed (index.html ~L3768).
 */
export function eventCanCommitClosed(
  event: EventPayload | null | undefined,
  items: InventoryPayload[] | null | undefined
): boolean {
  if (!event || event.state !== 'unpacking') return false;
  const prog = eventSignoffProgress(event, items);
  return prog.total > 0 && prog.signed === prog.total;
}

// ── The reason a sign-off can't be committed (so the UI explains WHY) ─────────────────────
// Mirrors the shipReason string in SignOffEvent (index.html ~L21513).
export function packingBlockReason(
  event: EventPayload | null | undefined,
  items: InventoryPayload[] | null | undefined
): string | null {
  if (!event) return 'Select an event.';
  if (eventCanCommitReady(event, items)) return null;
  if (event.state !== 'packing') {
    return 'Outbound sign-off is only available while the event is in Packing.';
  }
  const cp = eventCaseSignoffProgress(event);
  if (cp.total === 0) return 'Assign cases to this event first.';
  if (cp.signed !== cp.total) {
    const left = cp.total - cp.signed;
    return `${left} of ${cp.total} case${cp.total === 1 ? '' : 's'} still need boxing.`;
  }
  return 'Resolve the open flag(s) before this kit is ready.';
}

// ── Manifest snapshot of record (#28) ───────────────────────────────────────────────────────
// A static, self-contained freeze of an event's manifest at THIS moment — stored on
// event.signoff.manifestSnapshot so it can be re-rendered / re-printed / reconciled months later
// without depending on the live inventory. Faithful port of buildManifestSnapshot (index.html
// ~L3778). PURE — never mutates inputs. Out-of-service items are excluded (they shouldn't ship).
// The bulk-vs-serial (#22) row synthesis matches the source exactly so a snapshot is identical
// regardless of tracking.
export interface SnapshotCaseLite {
  id: string;
  label?: string;
  slug?: string;
}

export function buildManifestSnapshot(
  event: EventPayload,
  items: InventoryPayload[] | null | undefined,
  cases: SnapshotCaseLite[] | null | undefined,
  by: { email?: string; name?: string; role?: string } | null,
  opts?: { reason?: string; eventState?: string; shipping?: Record<string, unknown> }
): ManifestSnapshot {
  const o = opts || {};
  const eventCases = new Set(event.cases || []);
  const caseById: Record<string, SnapshotCaseLite> = {};
  for (const c of cases || []) caseById[c.id] = c;
  const ship = (o.shipping || event.outbound || {}) as Record<string, unknown>;
  const sStr = (k: string): string => {
    const v = ship[k];
    return typeof v === 'string' ? v : '';
  };

  const rows: ManifestSnapshotRow[] = [];
  let totalQty = 0;
  let looseQty = 0;

  for (const item of items || []) {
    if (itemIsOutOfService(item)) continue; // don't ship OOS items
    const openFlags = (item.flags || []).filter((f) => f && f.status === 'open');
    const flagsLite = openFlags.map((f) => ({
      id: f.id || '',
      severity: f.severity || 'med',
      note: f.note || '',
      flaggedBy: f.flaggedBy || '',
      flaggedAt: f.flaggedAt || null,
    }));

    if (itemIsSerial(item)) {
      // SERIAL (#22): group deployed units by the case carrying them; one row per event case.
      const groups: Record<string, NonNullable<typeof item.units>> = {};
      for (const u of Array.isArray(item.units) ? item.units : []) {
        if (!u || u.deletedAt || !u.location || u.location === 'storage') continue;
        if (!eventCases.has(u.location)) continue;
        (groups[u.location] = groups[u.location] || []).push(u);
      }
      for (const cid of Object.keys(groups)) {
        const c: SnapshotCaseLite = caseById[cid] || { id: cid };
        const us = groups[cid];
        const qty = us.length;
        totalQty += qty;
        const sig = us.map((u) => u.signoff).filter(Boolean)[0] || null;
        rows.push({
          itemId: item.id || '',
          itemName: item.name || item.slug || item.id || '',
          itemSlug: item.slug || '',
          sku: item.sku || '',
          qr: item.qr || '',
          kind: item.kind || '',
          loose: false,
          caseId: cid,
          caseLabel: c.label || c.slug || cid,
          caseSlug: c.slug || '',
          qty,
          serials: us.map((u) => u.serial).filter(Boolean) as string[],
          state: us.every((u) => u.state === 'packed') ? 'packed' : 'pending',
          flagsOpen: openFlags.length,
          flags: flagsLite,
          signoff: sig
            ? { kind: sig.kind, at: sig.at, byName: sig.byName || '', byEmail: sig.byEmail || '' }
            : null,
        });
      }
      continue;
    }

    for (const d of item.distribution || []) {
      const matchedByCase = !!d.caseId && eventCases.has(d.caseId);
      const matchedByEvent = !d.caseId && d.eventId === event.id;
      if (!matchedByCase && !matchedByEvent) continue;
      const c: SnapshotCaseLite = matchedByCase ? caseById[d.caseId as string] || { id: d.caseId as string } : { id: '' };
      const qty = Number(d.qty || 0);
      totalQty += qty;
      if (matchedByEvent) looseQty += qty;
      rows.push({
        itemId: item.id || '',
        itemName: item.name || item.slug || item.id || '',
        itemSlug: item.slug || '',
        sku: item.sku || '',
        qr: item.qr || '',
        kind: item.kind || '',
        loose: matchedByEvent,
        caseId: matchedByCase ? (d.caseId as string) : null,
        caseLabel: matchedByCase ? c.label || c.slug || (d.caseId as string) : 'Loose',
        caseSlug: matchedByCase ? c.slug || '' : '',
        qty,
        serials: Array.isArray(d.serials) ? d.serials.slice() : [],
        state: d.state || '',
        flagsOpen: openFlags.length,
        flags: flagsLite,
        signoff: d.signoff
          ? { kind: d.signoff.kind, at: d.signoff.at, byName: d.signoff.byName || '', byEmail: d.signoff.byEmail || '' }
          : null,
      });
    }
  }

  rows.sort((a, b) => {
    if (!!a.loose !== !!b.loose) return a.loose ? 1 : -1;
    const c = (a.caseLabel || '').localeCompare(b.caseLabel || '');
    if (c !== 0) return c;
    return (a.itemName || '').localeCompare(b.itemName || '');
  });

  const caseList = (event.cases || []).map((cid) => {
    const c = caseById[cid] || {};
    return { id: cid, label: c.label || c.slug || cid, slug: c.slug || '' };
  });

  const venue = (event.venue || {}) as Record<string, unknown>;
  const vStr = (k: string): string => {
    const v = venue[k];
    return typeof v === 'string' ? v : '';
  };

  return {
    capturedAt: Date.now(),
    capturedBy: by ? { email: by.email || '', name: by.name || '', role: by.role || '' } : null,
    reason: o.reason || 'ship-kit',
    eventId: event.id || '',
    eventName: event.name || '',
    eventSlug: event.slug || '',
    eventState: o.eventState || event.state || '',
    eventDates: { start: event.startDate || '', end: event.endDate || '' },
    venue: { name: vStr('name'), city: vStr('city'), address: vStr('address'), booth: vStr('booth') },
    shipping: {
      carrier: sStr('carrier'),
      tracking: sStr('tracking'),
      pickupDate: sStr('pickupDate'),
      notes: sStr('notes'),
      ...(o.shipping?.custodyCapture && typeof o.shipping.custodyCapture === 'object'
        ? { custodyCapture: o.shipping.custodyCapture as import('@/lib/types/types').CustodyCapture }
        : {}),
    },
    cases: caseList,
    rows,
    totals: { rows: rows.length, qty: totalQty, cases: caseList.length, looseQty },
  };
}

// ── Check-in sweep (return reconciliation) ──────────────────────────────────────────────────
// Diffs what SHIPPED (event.signoff.manifestSnapshot.rows) against the CURRENT per-item disposition
// (signoff.kind + open flags) and classifies each shipped line Returned / Damaged / Missing.
// Advisory + read-only. Faithful port of buildCheckinSweep (index.html ~L3987).
export interface CheckinDiscrepancy {
  itemId: string;
  itemName: string;
  caseLabel: string;
  qty: number;
  status: 'damaged' | 'missing';
  reason: string;
}

export interface CheckinSweep {
  hasSnapshot: boolean;
  tally: { returned: number; damaged: number; missing: number; total: number };
  discrepancies: CheckinDiscrepancy[];
  capturedAt?: number | null;
}

const DAMAGED_KINDS = new Set(['returned_damaged', 'damaged']);
const MISSING_KINDS = new Set(['returned_missing', 'missing']);
// 'consumed' + 'sold' are accounted-for dispositions (the item is legitimately gone, not lost/damaged)
// so the reconcile sweep treats them like a clean return — no discrepancy.
const RETURNED_KINDS = new Set(['ok', 'returned', 'consumed', 'sold']);

export function buildCheckinSweep(
  event: EventPayload | null | undefined,
  items: InventoryPayload[] | null | undefined
): CheckinSweep {
  const snap = event && event.signoff && event.signoff.manifestSnapshot;
  const tally = { returned: 0, damaged: 0, missing: 0, total: 0 };
  const discrepancies: CheckinDiscrepancy[] = [];
  if (!snap || !Array.isArray(snap.rows)) {
    return { hasSnapshot: false, tally, discrepancies };
  }
  const itemById: Record<string, InventoryPayload> = {};
  for (const it of items || []) if (it && it.id) itemById[it.id] = it;

  for (const row of snap.rows) {
    const qty = Number(row.qty || 0) || 0;
    tally.total += qty;
    const item = itemById[row.itemId];
    let dist = null as ReturnType<typeof findDist>;
    if (item && Array.isArray(item.distribution)) dist = findDist(item, row.caseId, !!row.loose, event!.id);
    const dispKind = rowDispositionKind(dist);
    const openDamageFlag = item ? (item.flags || []).some((f) => f && f.status === 'open' && f.category === 'damage') : false;
    const openServiceFlag = item ? itemHasOpenServiceFlag(item) : false;

    let status: 'returned' | 'damaged' | 'missing';
    let reason: string;
    if ((dispKind && DAMAGED_KINDS.has(dispKind)) || openDamageFlag) {
      status = 'damaged';
      reason = dispKind && DAMAGED_KINDS.has(dispKind) ? 'Returned damaged' : 'Open damage flag';
    } else if (dispKind && MISSING_KINDS.has(dispKind)) {
      status = 'missing';
      reason = 'Signed missing on return';
    } else if (dispKind && RETURNED_KINDS.has(dispKind)) {
      status = 'returned';
      reason = 'Returned ' + dispKind;
    } else if (dist && dist.state === 'packed') {
      status = 'returned';
      reason = 'In case, not yet reconciled';
    } else {
      status = 'missing';
      reason = 'Shipped but not scanned/returned';
    }
    if (status === 'returned' && openServiceFlag && !openDamageFlag) reason += ' (open service flag)';

    tally[status] += qty;
    if (status !== 'returned') {
      discrepancies.push({
        itemId: row.itemId,
        itemName: row.itemName || (item && item.name) || row.itemId,
        caseLabel: row.caseLabel || (row.loose ? 'Loose' : ''),
        qty,
        status,
        reason,
      });
    }
  }
  return { hasSnapshot: true, tally, discrepancies, capturedAt: snap.capturedAt || null };
}

// Locate the live distribution row a snapshot line maps to (case match, then loose, then case again).
function findDist(item: InventoryPayload, caseId: string | null, loose: boolean, eventId?: string) {
  const dist = Array.isArray(item.distribution) ? item.distribution : [];
  let d: (typeof dist)[number] | null = null;
  if (caseId) d = dist.find((x) => x && x.caseId === caseId) || null;
  if (!d && loose) d = dist.find((x) => x && !x.caseId && x.eventId === eventId) || null;
  if (!d) d = dist.find((x) => x && x.caseId === caseId) || null;
  return d;
}
