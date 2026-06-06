import { requireUser } from '@/lib/auth/auth';
import { can } from '@/lib/auth/rbac';
import { getCases, getEvents, getInventory, getUserWeightUnit, getTags, getUserDisplayName } from '@/lib/db/data';
import { getCaseLabels, getEventNames } from '@/lib/views/inventory';
import { itemCode } from '@/lib/integrations/eitm';
import type { ItemDetailsCase, KitCandidateItem } from '@/components/inventory/item-details-modal';
import type { InventoryEventOption } from './inventory-view';
import type { DashTag } from '@/lib/types/types-dashboard';
import {
  getWarehouses,
  getEmergencyContact,
  caseReturnAndContact,
  caseWarehouseId,
  formatWarehouseAddress,
} from '@/app/warehouses/warehouse-data';
import {
  caseAssignment,
  caseListStatus,
  caseStatusLabel,
  caseLocationLabel,
  caseEffectiveTransit,
  caseInTransit,
  getCaseScheduleConflicts,
  classifyCaseDelete,
  buildCaseManifestSnapshot,
  isCaseRetired,
  buildCaseManifest,
} from '@/lib/views/case-view';
import { caseLoadedWeightKg } from '@/lib/util/weight';
import { caseCode } from '@/lib/integrations/eitm';
import { activeTenantHash36 } from '@/lib/auth/settings-store';
import { dataMatrixSvg } from '@/lib/integrations/data-matrix';
import { itemCaseIds } from '@/lib/views/inventory-shape';
import type { WarehouseLite } from '@/app/cases/case-editor';
import {
  CatalogScreen,
  type CatalogCaseRow,
  type CatalogCardExtras as CaseCardExtras,
  type CatalogItemRow,
  type WarehouseOption,
  type KitOption,
} from './catalog-screen';
import type { CatalogRow } from './catalog-list';

// app/catalog — the MERGED CATALOG screen (DESIGN_ALIGNMENT §2.2 / §4.6). ONE nav destination
// ('Catalog', /catalog) that internally splits into Roadcases + Inventory via a LEFT SIDEBAR, with
// Warehouse + Kit/filter rails. This folds the former /cases (card grid) and /catalog inventory
// (dense table) under one Archetype-A screen; Warehouses become a FILTER here (the /warehouses/:id
// detail stays).
//
// The view is URL-reflected via ?view=cases|inventory (NOT a /catalog/<seg> sub-route — that
// segment is already owned by the /catalog/[id] inventory-item detail, so a 'cases' segment would
// collide). Server Component: reads cases + events + inventory + warehouses LIVE from Mongo on every
// request (no cache, no localStorage). All status/assignment/manifest values are pre-computed here
// via the shared case-view helpers so a count never drifts from the logic that produced it.
//
// AUTH: requireUser gates the SESSION (redirects to /login when signed out) — the OWNER OVERRIDE
// keeps every screen auth-gated. Whether the edit/import affordances show is decided by
// can('db.write.app', role) and passed down (the real boundary stays the Server Action's
// requireRole). The page itself carries no PII (cases/inventory don't), so no finer gate applies.
export const dynamic = 'force-dynamic';

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; warehouse?: string; filter?: string }>;
}) {
  const [user, caseDocs, eventDocs, invDocs, warehouseDocs, fleetEmergency, caseLabels, eventNames, tagDocs] = await Promise.all([
    requireUser(),
    getCases(),
    getEvents(),
    getInventory(),
    getWarehouses(),
    getEmergencyContact(),
    getCaseLabels(),
    getEventNames(),
    getTags(),
  ]);

  const sp = await searchParams;
  const initialView = sp.view === 'inventory' ? 'inventory' : 'cases';

  const inventory = invDocs.map((d) => d.payload);
  const eventsForAssign = eventDocs.map((e) => ({ _id: e._id, payload: e.payload }));
  // pallets.edit is the case create/edit/delete/transfer gate; db.write.app the inventory gate. The
  // catalog header shows New/Import when EITHER applies; the card actions gate on pallets.edit.
  const canEditInventory = can('db.write.app', user.role);
  const canEditCases = can('pallets.edit', user.role);
  const canEdit = canEditInventory || canEditCases;
  // looseitem.manage (lead+) gates the bulk "Attach to event" action.
  const canAttachLoose = can('looseitem.manage', user.role);
  const weightUnit = await getUserWeightUnit(user.email);
  const actorName = await getUserDisplayName(user.email).catch(() => user.email);

  // Warehouse id -> name (the #66 location label).
  const warehouseNameById: Record<string, string> = {};
  for (const w of warehouseDocs) warehouseNameById[w._id] = w.payload.name || w._id;

  // ── Cases → the card-grid rows (every status/assignment/manifest value pre-computed) ──────
  const caseRows: CatalogCaseRow[] = caseDocs.map((doc) => {
    const c = doc.payload;
    const assignment = caseAssignment(doc._id, eventsForAssign);
    const owning = assignment?.event ?? null;
    const manifest = buildCaseManifest(doc._id, inventory);
    const kitFor = Array.isArray(c.kitFor) ? c.kitFor.filter(Boolean) : [];
    const eff = caseEffectiveTransit(c, eventsForAssign);
    const conflicts = getCaseScheduleConflicts(doc._id, eventsForAssign);
    return {
      id: doc._id,
      label: c.label || c.slug || doc._id,
      size: c.size ? String(c.size) : '',
      zone: c.zone || '',
      slug: c.slug && c.slug !== doc._id ? c.slug : '',
      kitFor,
      // Tare weight: '' / null / NaN -> null (unset); a real number (incl. 0) is kept.
      weight: (() => {
        if (c.weight === '' || c.weight == null) return null;
        const n = Number(c.weight);
        return Number.isFinite(n) ? n : null;
      })(),
      // #12 loaded weight (tare + packed contents) in canonical kg (formatted client-side in user unit).
      loadedKg: caseLoadedWeightKg({ id: doc._id, weight: c.weight }, inventory),
      warehouseId: caseWarehouseId({
        currentWarehouseId: c.currentWarehouseId,
        homeWarehouseId: c.homeWarehouseId,
      }),
      retired: isCaseRetired(c),
      status: caseListStatus(c, assignment),
      eventId: assignment?.eventId ?? null,
      eventName: owning?.name ?? null,
      eventState: owning?.state ?? null,
      held: assignment?.held ?? false,
      statusLabel: caseStatusLabel(owning),
      packed: manifest.scanned,
      total: manifest.total,
      flagged: manifest.flagged,
      // #66 location + transit + double-booked.
      locationLabel: caseLocationLabel(c, eventsForAssign, warehouseNameById),
      inTransit: caseInTransit(c) || eff?.kind === 'event',
      conflictCount: conflicts.length,
      conflictNames: conflicts.map((x) => `${x.name} (${x.start})`),
      // The full case payload for the edit/retire modals (lean — cases carry no PII).
      payload: c,
    };
  });

  // ── Inventory → the dense-table rows (reuses the existing CatalogRow shape) ────────────────
  // Plus a per-item warehouseIds[] (derived transitively: an item is "at" a warehouse if it
  // routes into a case homed/located there) so the warehouse filter narrows BOTH views.
  const caseWarehouseById: Record<string, string | null> = {};
  for (const doc of caseDocs) {
    caseWarehouseById[doc._id] = caseWarehouseId({
      currentWarehouseId: (doc.payload as { currentWarehouseId?: string | null }).currentWarehouseId,
      homeWarehouseId: doc.payload.homeWarehouseId,
    });
  }
  const itemRows: CatalogItemRow[] = invDocs.map((d) => {
    const whIds = new Set<string>();
    for (const cid of itemCaseIds(d.payload)) {
      const wid = caseWarehouseById[cid];
      if (wid) whIds.add(wid);
    }
    return {
      id: d._id,
      payload: d.payload,
      warehouseIds: Array.from(whIds),
    } satisfies CatalogRow & { warehouseIds: string[] };
  });

  // ── Warehouse filter options (a case is bucketed by current ?? home; unplaced cases pool into
  //    a synthetic "Unassigned" bucket so the rail count stays honest). ───────────────────────
  let unplacedCases = 0;
  const caseCountByWarehouse: Record<string, number> = {};
  for (const r of caseRows) {
    if (r.warehouseId) caseCountByWarehouse[r.warehouseId] = (caseCountByWarehouse[r.warehouseId] || 0) + 1;
    else unplacedCases++;
  }
  const warehouseOptions: WarehouseOption[] = warehouseDocs.map((w) => ({
    id: w._id,
    name: w.payload.name || w._id,
    type: w.payload.type === 'hq' ? 'hq' : 'sub',
    address: formatWarehouseAddress(w.payload),
    caseCount: caseCountByWarehouse[w._id] || 0,
  }));

  // ── Kit (SKU) filter options derived from the cases' kitFor[] (the per-kit SKU filters). ────
  const kitCount: Record<string, number> = {};
  for (const r of caseRows) {
    if (r.retired) continue;
    for (const sku of r.kitFor) kitCount[sku] = (kitCount[sku] || 0) + 1;
  }
  const kitOptions: KitOption[] = Object.entries(kitCount)
    .map(([sku, count]) => ({ sku, count }))
    .sort((a, b) => b.count - a.count || a.sku.localeCompare(b.sku));

  // ── Per-case EDIT/PRINT extras (cases view only) ─────────────────────────────────────────
  // Classification (FK check for Delete/Retire), the internal-manifest snapshot, the case + the
  // server-encoded Data Matrix — so the card's inline Edit/Delete/Print-manifest/Print-matrix work
  // without a round-trip. The catalog is bounded (a few hundred cases); the per-case Data-Matrix
  // encode is deterministic bwip-js. Keyed by case id.
  const tenant = await activeTenantHash36();
  const safeMatrix = (payload: string): string => {
    if (!payload) return '';
    try {
      return dataMatrixSvg(payload);
    } catch {
      return '';
    }
  };
  const caseExtras: Record<string, CaseCardExtras> = {};
  for (const doc of caseDocs) {
    const c = doc.payload;
    const code = caseCode(doc._id, tenant);
    caseExtras[doc._id] = {
      classification: classifyCaseDelete(doc._id, eventsForAssign, inventory),
      snapshot: buildCaseManifestSnapshot(c, inventory, eventsForAssign, warehouseNameById),
      code,
      matrixSvg: safeMatrix(code),
      returnContact: caseReturnAndContact(c, warehouseDocs, fleetEmergency),
    };
  }

  const warehousesLite: WarehouseLite[] = warehouseDocs.map((w) => ({
    id: w._id,
    name: w.payload.name || w._id,
    type: w.payload.type === 'hq' ? 'hq' : 'sub',
  }));
  // The existing-case ids for the CSV import update-by-id detection.
  const caseIds = caseDocs.map((d) => d._id);

  // ── Inventory-view extras (the parity surface) ─────────────────────────────────────────────
  // Per-item Data Matrix (the `eitm:…:i:<id>` code + the server-encoded SVG) for the Print-Matrix
  // tile — same deterministic bwip-js encode as the cases. Keyed by item id.
  const itemMatrix: Record<string, { code: string; matrixSvg: string }> = {};
  for (const d of invDocs) {
    const code = itemCode(d._id, tenant);
    itemMatrix[d._id] = { code, matrixSvg: safeMatrix(code) };
  }
  // Live, non-retired cases for the item editor + bulk-reassign picker (id + label).
  const caseOptions: ItemDetailsCase[] = caseDocs
    .filter((d) => !isCaseRetired(d.payload))
    .map((d) => ({ id: d._id, label: d.payload.label || d.payload.slug || d._id }));
  // Draft / upcoming / packing events accept fresh loose inventory (the bulk attach-to-event picker).
  const eventOptions: InventoryEventOption[] = eventDocs
    .filter((e) => ['draft', 'upcoming', 'packing'].includes(String(e.payload.state)))
    .map((e) => ({ id: e._id, name: e.payload.name || e._id, state: String(e.payload.state) }));
  // Tags (the inline row chips + the #27 kit-BOM tag picker).
  const tags: DashTag[] = tagDocs.map((t) => ({
    id: t._id,
    label: t.payload.label || t._id,
    flair: t.payload.customEmoji || '',
    color: t.payload.color ?? null,
  }));
  // The catalog candidate items for the #27 kit-BOM part picker + checklist (lean projection).
  const kitCandidates: KitCandidateItem[] = invDocs.map((d) => ({
    id: d._id,
    name: d.payload.name,
    sku: d.payload.sku,
    skuOptions: d.payload.skuOptions,
    tagIds: d.payload.tagIds,
  }));
  const itemIds = invDocs.map((d) => d._id);

  return (
    <CatalogScreen
      initialView={initialView}
      initialWarehouse={sp.warehouse ?? 'all'}
      initialFilter={sp.filter ?? 'all'}
      caseRows={caseRows}
      caseExtras={caseExtras}
      itemRows={itemRows}
      caseLabels={caseLabels}
      warehouseOptions={warehouseOptions}
      kitOptions={kitOptions}
      unplacedCases={unplacedCases}
      canEdit={canEdit}
      canEditCases={canEditCases}
      weightUnit={weightUnit}
      warehouses={warehousesLite}
      caseIds={caseIds}
      itemMatrix={itemMatrix}
      caseOptions={caseOptions}
      eventNames={eventNames}
      eventOptions={eventOptions}
      tags={tags}
      kitCandidates={kitCandidates}
      canAttachLoose={canAttachLoose}
      actorName={actorName}
      itemIds={itemIds}
    />
  );
}
