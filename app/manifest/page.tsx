import { requireUser } from '@/lib/auth/auth';
import { can } from '@/lib/auth/rbac';
import { getEvents, getCases, getInventory, getTags, type TagDoc } from '@/lib/db/data';
import {
  buildEventManifest,
  type EventManifest,
  type ManifestEventListRow,
  type ManifestRowTag,
} from '@/lib/views/manifest-view';
import { itemQtyLooseAtEvent, itemOpenFlag, type InventoryPayload } from '@/lib/views/inventory-shape';
import { viewerLeadsEvent } from '@/lib/views/event-view';
import { getCaseAvailability, caseStatusLabel, isCaseRetired } from '@/lib/views/case-view';
import { caseCode, itemCode, eventCode } from '@/lib/integrations/eitm';
import { activeTenantHash36 } from '@/lib/auth/settings-store';
import { dataMatrixSvg } from '@/lib/integrations/data-matrix';
import type { CasePayload, EventPayload } from '@/lib/types/types';
import type { DashTag } from '@/lib/types/types-dashboard';
import { getWarehouses, getEmergencyContact, caseReturnAndContact } from '../warehouses/warehouse-data';
import { ManifestScreen } from './manifest-screen';
import type { ManifestCodes } from './print-manifest';
import type { ShippingLabelExtras } from './print-shipping-labels';
import type { AssignCaseRow } from './assign-cases-modal';
import type { ItemDetailsCase } from '@/components/inventory/item-details-modal';

// app/manifest — the EVENT MANIFEST POOL (DESIGN_ALIGNMENT §4.3, Archetype A). The contextual LEFT
// rail is the EVENTS list (date / name / VISIBLE tags / state pill + scanned-of-total); the MAIN pane
// is the chosen event's manifest — overall progress + per-kind rollup, the per-CASE manifest cards
// (built via lib/manifest-view, reusing the shared case/inventory primitives so a count never
// drifts), the LOOSE-inventory card, and a print section + Print button. The selected event is
// reflected to ?event=<id> (a deep link / the EventDetail "Manifest" button lands on the same event).
//
// WRITES (gated Server Actions in ./actions.ts): Assign-cases (pallets.edit), the ItemDetailsModal
// editor + Flag/Resolve (db.write.app), the loose-add picker (looseitem.manage). The screen is the
// client island that opens those modals; the page seeds everything they need server-side (the full
// item payloads for the modals, the case list + availability for Assign-cases, the loose inventory
// for the picker, the resolved tags for the chips) so the client never reads/decides data itself.
//
// AUTH: requireUser gates the SESSION (a signed-out caller is redirected to /login). The lean,
// PII-free manifest rows + the lead display string cross the wire; staffer hotel/travel never does.
export const dynamic = 'force-dynamic';

// Locale-stable date range (en-CA YYYY-MM-DD), matching the dashboard EventCard.
function fmtRange(start?: string, end?: string): string {
  if (!start) return '';
  if (!end || end === start) return start;
  return `${start} → ${end}`;
}

// Resolve the event's lead to a display string (the lead's NAME, already on the roster — no PII).
function resolveLeadDisplay(p: EventPayload): string {
  const lead = p.lead;
  if (!lead) return '';
  const s = (p.staff ?? []).find((x) => x && (x.email === lead || x.name === lead));
  return (s?.name || s?.email || lead) ?? '';
}

// Resolve a tag doc → the client-safe DashTag chip shape (flair denormalized on customEmoji, with the
// legacy flag-us/flag-cz fallback). Mirrors dashboard-metrics.toDashTag / calendar-data.toDashTag.
function toDashTag(doc: TagDoc): DashTag {
  const p = doc.payload ?? {};
  let flair = typeof p.customEmoji === 'string' ? p.customEmoji : '';
  if (!flair && p.flair === 'flag-us') flair = '🇺🇸';
  if (!flair && p.flair === 'flag-cz') flair = '🇨🇿';
  return {
    id: doc._id,
    label: typeof p.label === 'string' ? p.label : '',
    flair,
    color: typeof p.color === 'string' && p.color ? p.color : null,
  };
}

export default async function ManifestPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const [user, eventDocs, caseDocs, invDocs, tagDocs, warehouseDocs, fleetEmergency] = await Promise.all([
    requireUser(),
    getEvents(),
    getCases(),
    getInventory(),
    getTags(),
    getWarehouses(),
    getEmergencyContact(),
  ]);
  const sp = await searchParams;

  const inventory = invDocs.map((d) => d.payload);
  const canEdit = can('pallets.edit', user.role); // the Assign-cases gate (authorized+)
  const canManageLoose = can('looseitem.manage', user.role); // the loose-add gate (lead+)
  const signedIn = true; // requireUser guarantees a session; the row interactions are session-gated.

  // Visible tag directory (hidden tags can be applied but never render a chip) for the sidebar chips.
  const tagById = new Map<string, DashTag>();
  for (const d of tagDocs) {
    if (d.payload?.hidden) continue;
    tagById.set(d._id, toDashTag(d));
  }

  // case id -> payload (label / slug / kitFor / retired for the headers + the Assign-cases grid).
  const casesById: Record<string, CasePayload> = {};
  for (const c of caseDocs) casesById[c._id] = c.payload;

  // Events sorted chronologically (undated sink to the bottom), mirroring ManifestPool's sort.
  const sorted = eventDocs.slice().sort((a, b) => {
    const ad = a.payload.startDate || '';
    const bd = b.payload.startDate || '';
    if (!ad && !bd) return 0;
    if (!ad) return 1;
    if (!bd) return -1;
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });

  // The selected event: ?event=<id> when valid, else the first event.
  const requested = sp.event;
  const selected =
    (requested && sorted.find((e) => e._id === requested)) || sorted[0] || null;

  // Precompute every event's manifest so the sidebar shows honest scanned/total/flagged.
  const manifestById: Record<string, EventManifest> = {};
  const listRows: ManifestEventListRow[] = sorted.map((e) => {
    const m = buildEventManifest(e.payload, e._id, inventory, casesById);
    manifestById[e._id] = m;
    const loose = inventory.reduce((s, it) => s + itemQtyLooseAtEvent(it, e._id), 0);
    // Resolve applied tagIds → VISIBLE chips (hidden tags filtered out via tagById).
    const tagIds = Array.isArray(e.payload.tagIds) ? e.payload.tagIds : [];
    const tags: ManifestRowTag[] = tagIds
      .map((id) => tagById.get(id))
      .filter((t): t is DashTag => !!t)
      .map((t) => ({ id: t.id, label: t.label, flair: t.flair, color: t.color }));
    return {
      id: e._id,
      name: e.payload.name || '',
      state: e.payload.state || 'draft',
      dates: fmtRange(e.payload.startDate, e.payload.endDate),
      city:
        (typeof e.payload.venue === 'object' &&
        e.payload.venue &&
        typeof (e.payload.venue as { city?: unknown }).city === 'string'
          ? ((e.payload.venue as { city?: string }).city as string)
          : '') || e.payload.city || '',
      tags,
      scanned: m.totals.packed,
      total: m.totals.total,
      flagged: m.totals.flagged,
      caseCount: (e.payload.cases ?? []).length,
      looseTotal: loose,
      lead: resolveLeadDisplay(e.payload),
    };
  });

  const selectedManifest = selected ? manifestById[selected._id] : null;
  const selectedRow = selected ? listRows.find((r) => r.id === selected._id) ?? null : null;

  // ── Data Matrix codes for the SELECTED event's manifest (the only one that renders / prints) ──
  const tenantHash = await activeTenantHash36();
  const encode = (payload: string): string => {
    if (!payload) return '';
    try {
      return dataMatrixSvg(payload);
    } catch {
      return '';
    }
  };
  const caseSvgByCaseId: Record<string, string> = {};
  const itemSvgByItemId: Record<string, string> = {};
  let eventSvg = '';
  if (selectedManifest) {
    if (selected?._id) eventSvg = encode(eventCode(selected._id, tenantHash));
    for (const g of selectedManifest.caseGroups) {
      caseSvgByCaseId[g.caseId] = encode(caseCode(g.caseId, tenantHash));
      for (const r of g.rows) {
        if (r.id && !(r.id in itemSvgByItemId)) itemSvgByItemId[r.id] = encode(itemCode(r.id, tenantHash));
      }
    }
    for (const r of selectedManifest.looseGroup?.rows ?? []) {
      if (r.id && !(r.id in itemSvgByItemId)) itemSvgByItemId[r.id] = encode(itemCode(r.id, tenantHash));
    }
  }
  const codes: ManifestCodes = { caseSvgByCaseId, itemSvgByItemId, eventSvg };

  // ── 4×6 shipping-label extras: per case, the RETURN address (its home warehouse, HQ as fallback) and
  // the IF-FOUND contact (the warehouse's primary contact #71, else the fleet emergency contact). Built
  // server-side and threaded to the printable labels — without this the return/contact blocks have no
  // data and silently don't render (the bug: a homed case printed a label with no return info).
  const extrasByCaseId: Record<string, ShippingLabelExtras> = {};
  if (selectedManifest) {
    for (const g of selectedManifest.caseGroups) {
      const cp = casesById[g.caseId] as
        | (CasePayload & { homeWarehouseId?: string | null; currentWarehouseId?: string | null })
        | undefined;
      extrasByCaseId[g.caseId] = caseReturnAndContact(cp, warehouseDocs, fleetEmergency);
    }
  }

  // ── Data the client modals need (seeded server-side; the client never reads/decides data) ─────
  // 1. Full item payloads for the rows in the selected event's manifest (ItemDetailsModal/Flag/Resolve).
  // 2. The open-flag id per item (the flag button's resolve-vs-flag decision).
  const itemsById: Record<string, InventoryPayload> = {};
  const openFlagByItemId: Record<string, string> = {};
  if (selectedManifest) {
    const rowIds = new Set<string>();
    for (const g of selectedManifest.caseGroups) for (const r of g.rows) if (r.id) rowIds.add(r.id);
    for (const r of selectedManifest.looseGroup?.rows ?? []) if (r.id) rowIds.add(r.id);
    for (const it of inventory) {
      const id = it.id ?? '';
      if (!id || !rowIds.has(id)) continue;
      itemsById[id] = it;
      const of = itemOpenFlag(it);
      if (of?.id) openFlagByItemId[id] = of.id;
    }
  }

  // 3. The case list (id + label) for the ItemDetailsModal location pickers.
  const casesForEditor: ItemDetailsCase[] = caseDocs
    .filter((c) => !isCaseRetired(c.payload))
    .map((c) => ({ id: c._id, label: c.payload.label || c.payload.slug || c._id }));

  // 4. The Assign-cases grid: every case (retired excluded UNLESS already on the event), each with its
  //    availability LOCK (held by ANOTHER in-flight event) + the status phrase + the slug-when-distinct.
  const assignedIds = selected ? (selected.payload.cases ?? []) : [];
  const assignedSet = new Set(assignedIds);
  const eventsForAvail = eventDocs.map((e) => ({ _id: e._id, payload: e.payload }));
  const assignCaseRows: AssignCaseRow[] = caseDocs
    .filter((c) => !isCaseRetired(c.payload) || assignedSet.has(c._id))
    .map((c) => {
      const avail = getCaseAvailability(c._id, eventsForAvail);
      // Unavailable iff held by a DIFFERENT event than the one being edited.
      const unavailable = avail.status === 'unavailable' && avail.eventId !== selected?._id;
      return {
        id: c._id,
        slug: c.payload.slug && c.payload.slug !== c._id ? c.payload.slug : '',
        label: c.payload.label || c.payload.slug || c._id,
        unavailable,
        statusLabel: unavailable ? caseStatusLabel(avail.event) : '',
      };
    });

  // 5. The loose-add picker inventory: every live item (lean {id, payload}).
  const looseInventory = invDocs.map((d) => ({ id: d._id, payload: d.payload }));

  // Whether THIS viewer leads the selected event (UX seam only — mirrors the source's lead-aware copy).
  const viewerLeads = selected ? viewerLeadsEvent(selected.payload, user.email) : false;
  void viewerLeads;

  return (
    <ManifestScreen
      events={listRows}
      selectedId={selected?._id ?? null}
      manifest={selectedManifest}
      selectedRow={selectedRow}
      canEdit={canEdit}
      canManageLoose={canManageLoose}
      signedIn={signedIn}
      codes={codes}
      caseCodeSvgByCaseId={caseSvgByCaseId}
      itemMatrixSvgByItemId={itemSvgByItemId}
      extrasByCaseId={extrasByCaseId}
      itemsById={itemsById}
      openFlagByItemId={openFlagByItemId}
      casesForEditor={casesForEditor}
      assignCaseRows={assignCaseRows}
      assignedIds={assignedIds}
      looseInventory={looseInventory}
      tagsById={Object.fromEntries(tagById)}
    />
  );
}
