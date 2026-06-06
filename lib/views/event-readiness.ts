// lib/views/event-readiness.ts — PURE, isomorphic event-readiness + pallet read helpers.
//
// Faithful ports of the EventDetail support functions in index.html:
//   • computeEventReadiness (~L11256) — the Ready / Not-ready verdict + the blocker list the
//     <EventReadinessStrip> renders.
//   • eventPallets / palletForCase / eventLooseCaseIds / palletWeightKg (~L5458-5474) — the
//     read-only Pallets view on the Packing tab.
//   • getCaseDateConflicts (~L5548) — the per-case "also committed to an overlapping event"
//     advisory chip on the case tiles.
//
// No I/O, no 'server-only': the Server Component computes the manifest totals + pallet weights
// after the live DB read, and these pure functions derive the verdict/labels from them so the
// displayed readiness never drifts from the counts that produced it (the single-source rule
// lib/manifest-view / lib/case-view follow). The kit-shortfall blocker (#27) is NOT ported here —
// the catalog kit-BOM machinery isn't in this stack yet; readiness degrades gracefully without it
// (events without kit BOMs were unaffected by it in the Python anyway).

import type { CasePayload, EventPallet, EventPayload } from '@/lib/types/types';
import type { ManifestTotals } from '@/lib/views/manifest-view';
import { caseLoadedWeightKg } from '@/lib/util/weight';
import { getCaseScheduleConflicts, type CaseScheduleConflict } from '@/lib/views/case-view';
import type { InventoryPayload } from '@/lib/views/inventory-shape';

export interface EventReadiness {
  ready: boolean;
  blockers: string[];
}

/**
 * Compute the event readiness verdict from the manifest totals + the event's sign-off state.
 * Faithful to computeEventReadiness: an event is READY iff it has ≥1 manifest item, none unpacked,
 * none flagged, AND the per-state sign-off gate is met (packing/ready need signoff.ready|shipped;
 * unpacking/returning need signoff.closed). The blockers list is rendered verbatim in the strip.
 *
 * `totals` is the buildEventManifest(...).totals for this event (packed/total/flagged), computed
 * server-side — the Next.js equivalent of the Python eventManifestStats the source feeds in.
 */
export function computeEventReadiness(
  event: EventPayload | null | undefined,
  totals: Pick<ManifestTotals, 'total' | 'packed' | 'flagged'>
): EventReadiness {
  if (!event) return { ready: false, blockers: ['No event'] };
  const blockers: string[] = [];
  const manifest = totals.total || 0;
  const scanned = totals.packed || 0;
  const flagged = totals.flagged || 0;
  const unpacked = Math.max(0, manifest - scanned);
  if (manifest === 0) blockers.push('No items on the manifest');
  else if (unpacked > 0) blockers.push(unpacked + ' unpacked');
  if (flagged > 0) blockers.push(flagged + ' flagged');

  // Sign-off gate per state (the source's signoff.ready/shipped/closed check). `signoff` is loosely
  // typed (the rewrite owns shipped/closed; `ready` is a legacy flag the Python sets at Ship Kit) so
  // read it index-permissively.
  const so = (event.signoff ?? {}) as Record<string, unknown>;
  const st = event.state ?? '';
  if (st === 'packing' || st === 'ready') {
    if (!so.ready && !so.shipped) blockers.push('packing sign-off pending');
  } else if (st === 'unpacking' || st === 'returning') {
    if (!so.closed) blockers.push('return sign-off pending');
  }

  return { ready: blockers.length === 0 && manifest > 0, blockers };
}

// ── Pallets (read-only view) ──────────────────────────────────────────────────────────────────
/** The event's pallets (empty array when it uses none). Mirrors window.eventPallets. */
export function eventPallets(event: EventPayload | null | undefined): EventPallet[] {
  return event && Array.isArray(event.pallets) ? event.pallets : [];
}

/** The case ids assigned to this event that are NOT in any pallet (ship loose). Mirrors
 *  window.eventLooseCaseIds. */
export function eventLooseCaseIds(event: EventPayload | null | undefined): string[] {
  const assigned = new Set<string>();
  for (const p of eventPallets(event)) for (const cid of p.caseIds ?? []) assigned.add(cid);
  return (event?.cases ?? []).filter((cid) => !assigned.has(cid));
}

/** Σ loaded weight (kg) of every case in a pallet (tare + packed contents). Mirrors
 *  window.palletWeightKg — reuses caseLoadedWeightKg so the math matches the catalog/case detail. */
export function palletWeightKg(
  pallet: EventPallet,
  casesById: Record<string, CasePayload>,
  inventory: InventoryPayload[]
): number {
  return (pallet.caseIds ?? []).reduce((sum, cid) => {
    const c = casesById[cid];
    return sum + (c ? caseLoadedWeightKg({ id: c.id ?? cid, weight: c.weight }, inventory) : 0);
  }, 0);
}

// ── Case date conflicts (advisory) ──────────────────────────────────────────────────────────
/**
 * Other committing events whose [start,end] window OVERLAPS this event's window for the same case.
 * Faithful to getCaseDateConflicts: start from getCaseScheduleConflicts (every non-dead committing
 * event other than self), then filter to the date-overlap. With no window given, treats as
 * overlap-all. String compare is valid because dates are zero-padded YYYY-MM-DD.
 */
export function getCaseDateConflicts(
  caseId: string,
  events: { _id: string; payload: EventPayload }[],
  startDate: string | undefined,
  endDate: string | undefined,
  selfEventId: string | null | undefined
): CaseScheduleConflict[] {
  const all = getCaseScheduleConflicts(caseId, events, selfEventId);
  if (!startDate) return all;
  const aStart = startDate;
  const aEnd = endDate || startDate;
  return all.filter((c) => c.start <= aEnd && c.end >= aStart);
}
