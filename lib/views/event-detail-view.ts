import 'server-only';
import { buildEventManifest } from '@/lib/views/manifest-view';
import { computeEventReadiness, eventPallets, eventLooseCaseIds, palletWeightKg, getCaseDateConflicts } from '@/lib/views/event-readiness';
import { canSeeAccommodations } from '@/lib/views/event-view';
import { itemRollupState, itemQtyLooseAtEvent, type InventoryPayload } from '@/lib/views/inventory-shape';
import { itemQtyInCase, itemStateInCase } from '@/lib/views/case-view';
import { formatWeight } from '@/lib/util/weight';
import { receptacleById, inferEventRegion, regionPower, REGION_LABEL, isFixedCordInlet } from '@/lib/power/connectors';
import type {
  AccommodationsProfile,
  CasePayload,
  EventPayload,
  EventDoc,
  Staffer,
} from '@/lib/types/types';
import type {
  EventDetailView,
  StaffCardView,
  CaseTileView,
  PalletView,
  LooseItemView,
  CsvRow,
  ResolvedTag,
} from '@/lib/types/types-event-detail';

// Re-export the client-safe view shapes so the page can import them from one place.
export type {
  EventDetailView,
  StaffCardView,
  CaseTileView,
  PalletView,
  LooseItemView,
  CsvRow,
  ResolvedTag,
} from '@/lib/types/types-event-detail';

// lib/views/event-detail-view.ts — the SERVER-SIDE assembler for the Event DETAIL view.
//
// The Event detail page (a Server Component) reads the live event + the supporting collections,
// then composes EVERYTHING the client tab shell renders into one lean, serializable shape. The PII
// strip already ran on the payload BEFORE this; here we additionally:
//   • resolve each staffer's directory PICTURE + display name (the Team cards),
//   • attach the gated ACCOMMODATIONS profile ONLY for a viewer who passes accommodations.view
//     (manager+/self — the canSeeAccommodations gate; never crosses the wire otherwise),
//   • derive the manifest stats + readiness verdict (the header counts + the readiness strip),
//   • build the per-CASE tile data (label/slug/weight/packed counts/date-conflict advisories),
//   • build the read-only PALLETS view (labels, case chips, resolved weight, tracking number),
//   • build the LOOSE-inventory list,
//   • resolve the applied VISIBLE tags into chip shapes,
//   • build the Manifest CSV rows server-side (the "Manifest CSV" export).
//
// Everything here is PII-safe by construction: the page passes the ALREADY-STRIPPED staff list, and
// the only PII this adds (accommodations) is gated per-staffer. The output is a plain object a
// Server Component hands straight to the client island.

function lc(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** Resolve the lead flag for a staffer (the event lead may be stored as email or display name). */
function staffIsLead(event: EventPayload, s: Staffer, displayName: string): boolean {
  const lead = event.lead;
  if (!lead) return false;
  const ls = String(lead).trim();
  return ls === (s.email ?? '').trim() || ls === (s.name ?? '').trim() || (!!displayName && ls === displayName);
}

/** Normalize the directory user's accommodations profile shape (defensive). */
function normAccommodations(raw: unknown): AccommodationsProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  return raw as AccommodationsProfile;
}

export interface AssembleArgs {
  /** The event envelope (for the id). */
  doc: EventDoc;
  /** The ALREADY-PII-STRIPPED payload (stripEventPii ran upstream). */
  safePayload: EventPayload;
  /** The viewer's unforgeable session email + live role. */
  viewerEmail: string;
  viewerRole: string;
  /** Whether the viewer is staffed on THIS event (drives the request-travel CTA visibility). */
  viewerIsStaffed: boolean;
  inventory: InventoryPayload[];
  casesById: Record<string, CasePayload>;
  /** Every event (for the case date-conflict advisory). */
  allEvents: { _id: string; payload: EventPayload }[];
  /** Directory: email -> { name, picture, accommodations } for the Team cards + accommodations gate. */
  directoryByEmail: Record<string, { name?: string; picture?: string; accommodations?: unknown }>;
  /** Visible tag directory: tagId -> chip (hidden tags excluded by the caller). */
  tagById: Record<string, ResolvedTag>;
  /** The viewer's weight unit for the case/pallet weight formatting. */
  weightUnit: 'kg' | 'lbs';
}

export function assembleEventDetailView(args: AssembleArgs): EventDetailView {
  const {
    doc,
    safePayload,
    viewerEmail,
    viewerRole,
    viewerIsStaffed,
    inventory,
    casesById,
    allEvents,
    directoryByEmail,
    tagById,
    weightUnit,
  } = args;
  const eventId = doc._id;
  const ve = lc(viewerEmail);

  // ── Manifest (totals + per-case/loose groups reused from the shared builder) ───────────────
  const manifest = buildEventManifest(safePayload, eventId, inventory, casesById);
  const totals = manifest.totals;
  const readiness = computeEventReadiness(safePayload, totals);

  // ── Booth power budget — Σ over the manifest's rows (case-routed + loose), qty-weighted ─────
  // requiresPower/powerWatts/plugType live on the ITEM; powerDrop/powerNotes on the EVENT. The
  // Overview strip warns when requiredUnits > 0 and the event provides no drop.
  const itemById = new Map(inventory.map((it) => [it.id ?? '', it]));
  let powerUnits = 0;
  let powerWattsTotal = 0;
  const plugTypes: string[] = [];
  const deviceVolts = new Map<string, string[]>(); // volt class -> item names needing it
  const powerRows = [
    ...manifest.caseGroups.flatMap((g) => g.rows),
    ...(manifest.looseGroup?.rows ?? []),
  ];
  for (const r of powerRows) {
    const it = r.id ? itemById.get(r.id) : undefined;
    if (!it?.requiresPower) continue;
    const qty = Number(r.qty) || 0;
    powerUnits += qty;
    powerWattsTotal += qty * Math.max(0, Number(it.powerWatts) || 0);
    const plug = isFixedCordInlet(it.plugType)
      ? `${String(it.fixedPlug ?? '').trim() || 'NEMA 5-15P'} (fixed)`
      : String(it.plugType ?? '').trim();
    if (plug && !plugTypes.some((p) => p.toLowerCase() === plug.toLowerCase())) plugTypes.push(plug);
    const volts = it.powerVolts === '120' || it.powerVolts === '240' ? it.powerVolts : 'auto';
    const names = deviceVolts.get(volts) ?? [];
    if (it.name && !names.includes(it.name)) names.push(it.name);
    deviceVolts.set(volts, names);
  }

  // Voltage compatibility vs the SELECTED receptacles (only checkable when some were picked):
  // a fixed-voltage device with no matching-voltage receptacle is a warning.
  const receptacles = (Array.isArray(safePayload.powerReceptacles) ? safePayload.powerReceptacles : [])
    .map((id) => String(id))
    .filter(Boolean);
  const voltWarnings: string[] = [];
  if (safePayload.powerDrop === true && receptacles.length > 0) {
    const families = new Set(receptacles.map((id) => receptacleById(id)?.volts).filter(Boolean));
    for (const fixed of ['120', '240'] as const) {
      const names = deviceVolts.get(fixed);
      if (!names?.length) continue;
      const fam = fixed === '120' ? '120' : '230';
      if (!families.has(fam)) {
        voltWarnings.push(
          `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3} more` : ''} need${names.length === 1 ? 's' : ''} ${fixed} V — no ${fixed === '120' ? '120 V' : '230/240 V'} receptacle selected at the drop`
        );
      }
    }
  }

  // The destination's power standard — inferred from the venue coordinates (Places stamps lat/lng)
  // with a text fallback. A 120 V-only device headed to a 230 V region is flagged proactively (the
  // classic forgot-the-transformer problem); NA destinations carry both families, so no flag there.
  const destRegion = inferEventRegion(safePayload.venue, safePayload.city);
  const destPower = regionPower(destRegion);
  if (destRegion !== 'NA') {
    const fixed120 = deviceVolts.get('120');
    if (fixed120?.length) {
      voltWarnings.push(
        `${fixed120.slice(0, 3).join(', ')}${fixed120.length > 3 ? ` +${fixed120.length - 3} more` : ''} ${fixed120.length === 1 ? 'is' : 'are'} 120 V-only — the destination's mains is 230 V (plan transformers or check the PSUs)`
      );
    }
  }

  const power: EventDetailView['power'] = {
    requiredUnits: powerUnits,
    totalWatts: Math.round(powerWattsTotal),
    amps120: powerWattsTotal > 0 ? Math.ceil(powerWattsTotal / 120) : 0,
    plugTypes,
    provided: safePayload.powerDrop === true,
    notes: String(safePayload.powerNotes ?? '').trim(),
    receptacles,
    voltWarnings,
    destination: {
      region: destRegion,
      label: REGION_LABEL[destRegion],
      mains: destPower.mains,
      receptacles: destPower.receptacles.map((r) => r.label),
    },
  };

  // ── Team cards (directory picture + display name + gated accommodations) ───────────────────
  const staff: StaffCardView[] = (safePayload.staff ?? []).map((s) => {
    const email = s.email ?? '';
    const dir = email ? directoryByEmail[lc(email)] : undefined;
    const name = dir?.name || s.name || '';
    const picture = dir?.picture || '';
    const isLead = staffIsLead(safePayload, s, name);
    // PII present iff the upstream strip KEPT it (hotel/travel) for this viewer.
    const hotel = s.hotel ?? null;
    const travel = s.travel ?? null;
    // Accommodations: gated independently (manager+/self), sourced from the directory record.
    const accAllowed = canSeeAccommodations(s, ve, viewerRole);
    const accommodations = accAllowed ? normAccommodations(dir?.accommodations) : null;
    // The request-travel CTA shows when: the viewer is staffed here, this isn't the viewer's own
    // row, and the viewer can't see this staffer's travel (no hotel AND no travel present after the
    // strip = the server withheld it). Mirrors the Python `!canSeeAcc && s.email && not-self && iAmStaffed`.
    const canRequest =
      viewerIsStaffed && !!email && lc(email) !== ve && !hotel && !travel;
    return {
      email,
      name,
      role: s.role ?? '',
      picture,
      isLead,
      isSelf: !!email && lc(email) === ve,
      onsiteStart: s.onsiteStart ?? '',
      onsiteEnd: s.onsiteEnd ?? '',
      hotel,
      travel,
      accommodations,
      canRequest,
    };
  });

  // ── Case tiles (per-case packed/total/flagged + weight + date conflicts) ───────────────────
  const caseTiles: CaseTileView[] = (safePayload.cases ?? []).map((cid) => {
    const c = casesById[cid];
    const label = c?.label || c?.slug || cid;
    const slug = c?.slug && c.slug !== cid ? c.slug : '';
    let total = 0;
    let packed = 0;
    let flagged = 0;
    for (const it of inventory) {
      const q = itemQtyInCase(it, cid);
      if (q <= 0) continue;
      total += q;
      if (itemStateInCase(it, cid) === 'packed') packed += q;
      if (itemRollupState(it) === 'flagged') flagged += q;
    }
    const weight = c?.weight ? formatWeight(c.weight, weightUnit) : '';
    const conflicts = getCaseDateConflicts(
      cid,
      allEvents,
      safePayload.startDate,
      safePayload.endDate,
      eventId
    ).map((cf) => ({ eventId: cf.eventId, name: cf.name, start: cf.start, end: cf.end }));
    return { id: cid, label, slug, total, packed, flagged, weight, conflicts };
  });

  // ── Pallets (read-only) — labels, case chips, resolved weight, tracking ────────────────────
  const palletList = eventPallets(safePayload);
  const caseLabelOf = (cid: string) => casesById[cid]?.label || cid;
  const pallets: PalletView[] = palletList.map((p) => ({
    id: p.id,
    label: p.label || 'Pallet',
    caseChips: (p.caseIds ?? []).map((cid) => ({ id: cid, label: caseLabelOf(cid) })),
    weight: formatWeight(palletWeightKg(p, casesById, inventory), weightUnit),
    tracking: p.tracking || '',
  }));
  const palletLooseChips =
    palletList.length > 0
      ? eventLooseCaseIds(safePayload).map((cid) => ({ id: cid, label: caseLabelOf(cid) }))
      : [];

  // ── Loose inventory (bulk loose rows at this event) ────────────────────────────────────────
  const loose: LooseItemView[] = [];
  for (const it of inventory) {
    const qty = itemQtyLooseAtEvent(it, eventId);
    if (qty <= 0) continue;
    const serials: string[] = [];
    for (const d of it.distribution ?? []) {
      if (d.caseId || d.eventId !== eventId) continue;
      for (const sn of d.serials ?? []) if (sn) serials.push(sn);
    }
    loose.push({
      id: it.id ?? '',
      name: it.name ?? '',
      kind: it.kind ?? it.type ?? '',
      qty,
      serials,
    });
  }
  loose.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // ── Applied VISIBLE tags → chips ───────────────────────────────────────────────────────────
  const tagIds = Array.isArray(safePayload.tagIds) ? safePayload.tagIds : [];
  const tags: ResolvedTag[] = tagIds
    .map((id) => tagById[id])
    .filter((t): t is ResolvedTag => !!t);

  // ── Manifest CSV rows (the "Manifest CSV" export — flat one-row-per-manifest-item) ──────────
  const csvRows: CsvRow[] = [];
  for (const g of manifest.caseGroups) {
    for (const r of g.rows) {
      csvRows.push({
        itemId: r.id,
        itemName: r.name,
        sku: r.sku,
        qr: r.qr,
        caseLabel: g.label,
        qty: r.qty,
        serials: r.serials.join('; '),
        state: r.state,
        flags: r.flagged ? 1 : 0,
        signoff: r.state === 'packed' ? 'packed' : '',
      });
    }
  }
  for (const r of manifest.looseGroup?.rows ?? []) {
    csvRows.push({
      itemId: r.id,
      itemName: r.name,
      sku: r.sku,
      qr: r.qr,
      caseLabel: '(loose)',
      qty: r.qty,
      serials: r.serials.join('; '),
      state: r.state,
      flags: r.flagged ? 1 : 0,
      signoff: r.state === 'packed' ? 'packed' : '',
    });
  }

  return {
    staff,
    totals,
    readiness,
    caseTiles,
    pallets,
    palletLooseChips,
    loose,
    tags,
    csvRows,
    power,
  };
}
