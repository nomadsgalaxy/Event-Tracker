'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Boxes,
  Briefcase,
  Download,
  Search,
  Warehouse,
  SlidersHorizontal,
  Layers,
  PackageOpen,
  ArchiveX,
  Share2,
  Package,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  SidebarRail,
  SidebarSection,
  SidebarItem,
} from '@/components/ui/sidebar-rail';
import { ScreenHeader } from '@/components/ui/screen-header';
import { CaseGrid } from './case-grid';
import { InventoryView, type InventoryItemRow, type InventoryEventOption } from './inventory-view';
import { RoadKitsManager, type KitRow, type KitCaseOption } from './kits/kits-manager';
import { InventoryCsvImportButton } from './inventory-csv-import';
import type { CatalogRow } from './catalog-list';
import type { ItemDetailsCase, KitCandidateItem } from '@/components/inventory/item-details-modal';
import type { DashTag } from '@/lib/types/types-dashboard';
import type { CaseListStatus, CaseDeleteClassification, CaseManifestSnapshot } from '@/lib/views/case-view';
import type { EventState, CasePayload } from '@/lib/types/types';
import type { WarehouseLite } from '@/app/cases/case-editor';
import { NewCaseButton } from '@/app/cases/case-editor';
import { CaseCsvImportButton } from '@/app/cases/case-csv-import';
import {
  itemCaseIds,
  itemRollupState,
  type InventoryPayload,
} from '@/lib/views/inventory-shape';

// catalog-screen.tsx — the Archetype-A shell of the MERGED Catalog (DESIGN_ALIGNMENT §4.6). The
// contextual LEFT SidebarRail carries three sections — CATALOG (Roadcases | Inventory toggle, the
// active one orange) · WAREHOUSE (All + each warehouse, a filter) · FILTER (All / Assigned /
// Unassigned / Shared-no-kit / Retired + the per-kit SKU filters) — and the MAIN pane renders a
// ScreenHeader over either the road-case CARD GRID (Roadcases) or the dense inventory TABLE
// (Inventory). The warehouse + kit/state filters narrow the grid CLIENT-SIDE (instant; no
// round-trip), exactly like the existing app's catalog rails.
//
// The active VIEW is reflected to ?view=cases|inventory (so a link / refresh / back lands on the
// same sub-section) while the warehouse + filter selections stay client state (they also push to
// ?warehouse / ?filter so a deep link restores them, but a click never blocks on navigation). The
// rail items are real <button>s (controlled toggles) so they're keyboard-reachable and semantic.

// ── Row shapes the server hands down (lean, serializable — no Mongo internals) ───────────────
export interface CatalogCaseRow {
  id: string;
  label: string;
  size: string;
  zone: string;
  slug: string;
  kitFor: string[];
  weight: number | null;
  /** #12 loaded weight (tare + packed contents) in canonical kg; formatted client-side in user unit. */
  loadedKg: number;
  warehouseId: string | null;
  retired: boolean;
  status: CaseListStatus;
  eventId: string | null;
  eventName: string | null;
  eventState: EventState | null;
  held: boolean;
  statusLabel: string; // "Packing for X" / "In transit to X" / "At X" / "In storage"
  packed: number;
  total: number;
  flagged: number;
  // #66 location + transit + double-booked.
  locationLabel: string;
  inTransit: boolean;
  conflictCount: number;
  conflictNames: string[];
  /** The full case payload for the inline Edit/Retire modals (cases carry no PII). */
  payload: CasePayload;
}

// Heavier per-case extras (FK classification + internal-manifest snapshot + the Data Matrix) used by
// the card's inline Edit/Delete/Print actions. Keyed by case id; passed alongside the rows.
export interface CatalogCardExtras {
  classification: CaseDeleteClassification;
  snapshot: CaseManifestSnapshot | null;
  code: string;
  matrixSvg: string;
  // 4×6 shipping-label extras (Return-to + If-found) for the Print-Matrix modal — case-static.
  returnContact?: {
    returnTo?: { name?: string; address?: string; phone?: string } | null;
    emergency?: { name?: string; phone?: string } | null;
  } | null;
}

export type CatalogItemRow = CatalogRow & { warehouseIds: string[] };

export interface WarehouseOption {
  id: string;
  name: string;
  type: 'hq' | 'sub';
  address: string;
  caseCount: number;
}

export interface KitOption {
  sku: string;
  count: number;
}

type CatalogView = 'cases' | 'inventory' | 'kits';

// The CATALOG-section filter ids (the cross-view "FILTER" rail). These narrow the CASES grid in
// full; for INVENTORY the ones that don't apply to an item degrade gracefully (assigned/unassigned
// map to "is the item in any case", shared/retired are case-only and become no-ops there).
type CaseFilterId =
  | 'all'
  | 'assigned'
  | 'unassigned'
  | 'shared'
  | 'retired'
  | string; // a kit: prefix for per-SKU filters

const STATE_FILTERS: { id: CaseFilterId; label: string; icon: LucideIcon }[] = [
  { id: 'all', label: 'All', icon: Layers },
  { id: 'assigned', label: 'Assigned', icon: PackageOpen },
  { id: 'unassigned', label: 'Unassigned', icon: Boxes },
  { id: 'shared', label: 'Shared (no kit)', icon: Share2 },
  { id: 'retired', label: 'Retired', icon: ArchiveX },
];

// Does a case row pass the cross-view FILTER selection? Mirrors the existing app's catalog Cases
// filter (index.html ~L19178): every non-retired filter HIDES retired cases; 'retired' is the only
// path that surfaces them. 'shared' = a non-retired case with no kitFor (a filament/tools/banner
// pool). A kit:<SKU> filter narrows to cases that kit that SKU.
function casevPassesFilter(r: CatalogCaseRow, filter: CaseFilterId): boolean {
  if (filter.startsWith('kit:')) {
    if (r.retired) return false;
    return r.kitFor.includes(filter.slice(4));
  }
  switch (filter) {
    case 'retired':
      return r.retired;
    case 'assigned':
      return !r.retired && r.status === 'assigned';
    case 'unassigned':
      return !r.retired && r.status !== 'assigned';
    case 'shared':
      return !r.retired && r.kitFor.length === 0;
    case 'all':
    default:
      return !r.retired;
  }
}

// Does an inventory item pass the cross-view FILTER? The case-centric ids degrade sensibly:
//   assigned   -> the item is routed into ≥1 case
//   unassigned -> the item is in NO case
//   shared / retired / kit:<SKU> -> case-only concepts; no-op for items (don't hide everything).
function itemvPassesFilter(it: InventoryPayload, filter: CaseFilterId): boolean {
  if (filter === 'assigned') return itemCaseIds(it).length > 0;
  if (filter === 'unassigned') return itemCaseIds(it).length === 0;
  return true; // all / shared / retired / kit:* -> no narrowing for items
}

export function CatalogScreen({
  initialView,
  initialWarehouse,
  initialFilter,
  caseRows,
  caseExtras,
  itemRows,
  caseLabels,
  warehouseOptions,
  kitOptions,
  unplacedCases,
  roadKitCount,
  roadKitRows,
  roadKitCaseOptions,
  canEdit,
  canEditCases,
  weightUnit,
  warehouses,
  caseIds,
  itemMatrix,
  caseOptions,
  eventNames,
  eventOptions,
  tags,
  kitCandidates,
  canAttachLoose,
  actorName,
  itemIds,
}: {
  initialView: CatalogView;
  initialWarehouse: string;
  initialFilter: string;
  caseRows: CatalogCaseRow[];
  caseExtras: Record<string, CatalogCardExtras>;
  itemRows: CatalogItemRow[];
  caseLabels: Record<string, string>;
  warehouseOptions: WarehouseOption[];
  kitOptions: KitOption[];
  unplacedCases: number;
  /** Live Road Kit count for the sidebar nav entry. */
  roadKitCount: number;
  /** Road Kit rows (the kits view content) + the case picker options for the kit editor. */
  roadKitRows: KitRow[];
  roadKitCaseOptions: KitCaseOption[];
  canEdit: boolean;
  /** pallets.edit — gates the case create/edit/delete/transfer + the card action menu. */
  canEditCases: boolean;
  /** The user's weight unit ('kg'|'lbs') — the grid + editor enter/show weight in it (#11). */
  weightUnit: 'kg' | 'lbs';
  warehouses: WarehouseLite[];
  /** Existing case ids (for the CSV import update-by-id detection). */
  caseIds: string[];
  /** itemId -> { code, matrixSvg } for the per-row Print-Matrix tile (server-encoded). */
  itemMatrix: Record<string, { code: string; matrixSvg: string }>;
  /** Live, non-retired cases for the item editor + bulk-reassign picker. */
  caseOptions: ItemDetailsCase[];
  /** eventId -> name for the loose-at-event badges. */
  eventNames: Record<string, string>;
  /** Draft/upcoming/packing events for the bulk attach-to-event picker. */
  eventOptions: InventoryEventOption[];
  /** All tags (id + label + flair + color) — the inline row chips + the #27 kit-BOM tag picker. */
  tags: DashTag[];
  /** Catalog candidate items for the #27 kit-BOM part picker + checklist. */
  kitCandidates: KitCandidateItem[];
  /** Lead+ — gates the bulk "Attach to event" action. */
  canAttachLoose: boolean;
  /** The acting user's display name (stamped on service flags). */
  actorName?: string;
  /** Existing inventory ids (for the CSV import update-by-id detection). */
  itemIds: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [view, setView] = useState<CatalogView>(initialView);
  const [warehouse, setWarehouse] = useState<string>(initialWarehouse); // 'all' | warehouseId | 'unassigned'
  const [filter, setFilter] = useState<CaseFilterId>(initialFilter);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  // Search box over the merged cases grid (the standalone /cases list has search; the primary
  // catalog grid lacked it). Narrows label/slug/zone/kit/event client-side, no round-trip.
  const [caseSearch, setCaseSearch] = useState('');

  // Reflect a selection to the URL without forcing a navigation/refetch — the data is already in
  // hand, so we replace the querystring shallowly (scroll:false). A deep link still restores state
  // (the server reads ?view/?warehouse/?filter and seeds the initial* props).
  const syncUrl = useCallback(
    (next: { view?: CatalogView; warehouse?: string; filter?: string }) => {
      const usp = new URLSearchParams(params.toString());
      const v = next.view ?? view;
      const w = next.warehouse ?? warehouse;
      const f = next.filter ?? filter;
      v === 'cases' ? usp.delete('view') : usp.set('view', v);
      w === 'all' ? usp.delete('warehouse') : usp.set('warehouse', w);
      f === 'all' ? usp.delete('filter') : usp.set('filter', f);
      const qs = usp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router, view, warehouse, filter]
  );

  const pickView = (v: CatalogView) => {
    setView(v);
    syncUrl({ view: v });
  };
  // Warehouse + filter are grid (cases/inventory) concepts. Picking one from the kits view drops you
  // onto the Roadcases grid with that filter applied, rather than leaving an invisible no-op.
  const pickWarehouse = (w: string) => {
    setWarehouse(w);
    if (view === 'kits') {
      setView('cases');
      syncUrl({ warehouse: w, view: 'cases' });
    } else {
      syncUrl({ warehouse: w });
    }
  };
  const pickFilter = (f: CaseFilterId) => {
    setFilter(f);
    if (view === 'kits') {
      setView('cases');
      syncUrl({ filter: f, view: 'cases' });
    } else {
      syncUrl({ filter: f });
    }
  };

  // ── Warehouse narrowing (shared by both views) ──────────────────────────────────────────
  const caseInWarehouse = useCallback(
    (r: CatalogCaseRow) => {
      if (warehouse === 'all') return true;
      if (warehouse === 'unassigned') return r.warehouseId == null;
      return r.warehouseId === warehouse;
    },
    [warehouse]
  );
  const itemInWarehouse = useCallback(
    (r: CatalogItemRow) => {
      if (warehouse === 'all') return true;
      if (warehouse === 'unassigned') return r.warehouseIds.length === 0;
      return r.warehouseIds.includes(warehouse);
    },
    [warehouse]
  );

  // ── The visible rows for the active view (warehouse + filter + search narrow CLIENT-SIDE) ───
  const visibleCases = useMemo(() => {
    const q = caseSearch.trim().toLowerCase();
    return caseRows.filter((r) => {
      if (!(caseInWarehouse(r) && casevPassesFilter(r, filter))) return false;
      if (!q) return true;
      const hay = [r.label, r.slug, r.zone, r.size, r.eventName ?? '', r.locationLabel, ...r.kitFor]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [caseRows, caseInWarehouse, filter, caseSearch]);
  const visibleItems = useMemo(
    () => itemRows.filter((r) => itemInWarehouse(r) && itemvPassesFilter(r.payload, filter)),
    [itemRows, itemInWarehouse, filter]
  );

  // Per-state counts for the FILTER rail (honest, after the warehouse narrowing, case view only).
  const filterCounts = useMemo(() => {
    const whCases = caseRows.filter(caseInWarehouse);
    let assigned = 0;
    let unassigned = 0;
    let shared = 0;
    let retired = 0;
    for (const r of whCases) {
      if (r.retired) {
        retired++;
        continue;
      }
      if (r.status === 'assigned') assigned++;
      else unassigned++;
      if (r.kitFor.length === 0) shared++;
    }
    return { all: whCases.length - retired, assigned, unassigned, shared, retired };
  }, [caseRows, caseInWarehouse]);

  // Per-kit counts respect the warehouse narrowing too (a kit filter is case-centric).
  const kitCounts = useMemo(() => {
    const whCases = caseRows.filter((r) => caseInWarehouse(r) && !r.retired);
    const m: Record<string, number> = {};
    for (const r of whCases) for (const sku of r.kitFor) m[sku] = (m[sku] || 0) + 1;
    return m;
  }, [caseRows, caseInWarehouse]);

  // KPI / header numbers reflect the active view's TOTAL (the whole collection), the eyebrow shows
  // it; the headline shows the filtered count so the header tracks the rail like the dashboard does.
  const caseTotal = caseRows.length;
  const itemTotal = itemRows.length;
  const isCases = view === 'cases';
  const isKits = view === 'kits';

  // The header right-actions — Export CSV / Import CSV / New. Export builds a CSV CLIENT-SIDE from
  // the rows already in hand (the data is loaded; no dead API link / no round-trip) and downloads
  // the CURRENTLY-VISIBLE set so the export honours the active warehouse/filter. Import / New gate
  // on canEdit (the real boundary stays the Server Action's requireRole). New routes to the per-view
  // create surface; Import is a stubbed affordance (kept in the header per the blueprint) the
  // catalog-edit wave fills in.
  const exportCsv = useCallback(() => {
    if (isCases) {
      downloadCsv(
        'roadcases',
        ['ID', 'Label', 'Size', 'Zone', 'Kit', 'Weight (kg)', 'Status', 'Assignment', 'Packed', 'Total', 'Flagged'],
        visibleCases.map((r) => [
          r.id,
          r.label,
          r.size,
          r.zone,
          r.kitFor.join(' '),
          r.weight ?? '',
          r.retired ? 'retired' : r.status,
          r.eventState ? r.statusLabel : 'In storage',
          r.packed,
          r.total,
          r.flagged,
        ])
      );
    } else {
      downloadCsv(
        'inventory',
        ['ID', 'Name', 'Kind', 'Tracking', 'Matrix/SKU', 'State', 'Cases'],
        visibleItems.map((r) => [
          r.id,
          r.payload.name ?? '',
          r.payload.kind ?? r.payload.type ?? '',
          r.payload.tracking ?? 'bulk',
          r.payload.qr ?? r.payload.sku ?? '',
          itemRollupState(r.payload),
          itemCaseIds(r.payload).length,
        ])
      );
    }
  }, [isCases, visibleCases, visibleItems]);

  // Header actions. Export CSV always; Import + New gate on the relevant capability. In the CASES
  // view New/Import are the real CaseEditor/CsvImport flows (no longer stubs); the inventory view
  // keeps its New-item link + (deferred) import stub.
  const headerActions = (
    <>
      <Button variant="outline" size="sm" onClick={exportCsv}>
        <Download size={14} aria-hidden />
        <span className="hidden sm:inline">Export CSV</span>
      </Button>
      {isCases ? (
        <>
          {canEditCases ? <CaseCsvImportButton existingIds={caseIds} /> : null}
          {canEditCases ? <NewCaseButton weightUnit={weightUnit} warehouses={warehouses} /> : null}
        </>
      ) : (
        <>{canEdit ? <InventoryCsvImportButton existingIds={itemIds} /> : null}</>
      )}
    </>
  );

  // ── The rail body — shared by the desktop SidebarRail and the mobile FilterFab Sheet ───────
  function RailControls({ onPick }: { onPick?: () => void }) {
    const after = () => onPick?.();
    return (
      <>
        {/* CATALOG — the Roadcases | Inventory section toggle (the active one orange). */}
        <SidebarSection label="Catalog">
          <SidebarItem
            icon={Briefcase}
            count={caseTotal}
            active={isCases}
            onClick={() => {
              pickView('cases');
              after();
            }}
          >
            Roadcases
          </SidebarItem>
          <SidebarItem
            icon={Boxes}
            count={itemTotal}
            active={!isCases}
            onClick={() => {
              pickView('inventory');
              after();
            }}
          >
            Inventory
          </SidebarItem>
          {/* Road Kits — a third VIEW of the catalog (peer to Roadcases/Inventory), so the sidebar
              is retained on the kits content. */}
          <SidebarItem
            icon={Package}
            count={roadKitCount}
            active={isKits}
            onClick={() => {
              pickView('kits');
              after();
            }}
          >
            Road Kits
          </SidebarItem>
        </SidebarSection>

        {/* WAREHOUSE — All + each warehouse + an Unassigned bucket (a filter, not a destination). */}
        <SidebarSection label="Warehouse">
          <SidebarItem
            icon={Warehouse}
            count={caseTotal}
            active={warehouse === 'all'}
            onClick={() => {
              pickWarehouse('all');
              after();
            }}
          >
            All warehouses
          </SidebarItem>
          {warehouseOptions.map((w) => (
            <SidebarItem
              key={w.id}
              count={w.caseCount}
              active={warehouse === w.id}
              onClick={() => {
                pickWarehouse(w.id);
                after();
              }}
            >
              {w.name}
            </SidebarItem>
          ))}
          {unplacedCases > 0 ? (
            <SidebarItem
              count={unplacedCases}
              active={warehouse === 'unassigned'}
              onClick={() => {
                pickWarehouse('unassigned');
                after();
              }}
            >
              Unassigned
            </SidebarItem>
          ) : null}
        </SidebarSection>

        {/* FILTER — the cross-view state filter + the per-kit SKU filters (derived from the data). */}
        <SidebarSection label="Filter">
          {STATE_FILTERS.map((f) => (
            <SidebarItem
              key={f.id}
              icon={f.icon}
              count={
                f.id === 'all'
                  ? filterCounts.all
                  : f.id === 'assigned'
                    ? filterCounts.assigned
                    : f.id === 'unassigned'
                      ? filterCounts.unassigned
                      : f.id === 'shared'
                        ? filterCounts.shared
                        : filterCounts.retired
              }
              active={filter === f.id}
              onClick={() => {
                pickFilter(f.id);
                after();
              }}
            >
              {f.label}
            </SidebarItem>
          ))}
        </SidebarSection>

        {kitOptions.length > 0 ? (
          <SidebarSection label="Equipment">
            {kitOptions.map((k) => {
              const id = `kit:${k.sku}`;
              return (
                <SidebarItem
                  key={k.sku}
                  count={kitCounts[k.sku] ?? 0}
                  active={filter === id}
                  onClick={() => {
                    pickFilter(id);
                    after();
                  }}
                >
                  {k.sku}
                </SidebarItem>
              );
            })}
          </SidebarSection>
        ) : null}

        <p className="px-2 pt-2 text-xs leading-relaxed text-muted-foreground">
          Roadcases and Inventory are two views of one catalog. Warehouse and equipment filters narrow
          both — pick a warehouse to scope to its return-address pool.
        </p>
      </>
    );
  }

  const activeFilterLabel =
    filter === 'all'
      ? 'All'
      : filter.startsWith('kit:')
        ? `Kit ${filter.slice(4)}`
        : (STATE_FILTERS.find((f) => f.id === filter)?.label ?? 'All');
  const activeWarehouseLabel =
    warehouse === 'all'
      ? null
      : warehouse === 'unassigned'
        ? 'Unassigned'
        : (warehouseOptions.find((w) => w.id === warehouse)?.name ?? null);

  return (
    <div className="flex min-h-0 flex-1">
      {/* DESKTOP rail (Archetype A). Hidden below md, where it collapses to the FilterFab. */}
      <SidebarRail ariaLabel="Catalog views and filters" className="hidden md:flex">
        <RailControls />
      </SidebarRail>

      {/* MAIN — owns its padding + scroll (the shell is full-bleed). */}
      <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
        <ScreenHeader
          eyebrow={
            isKits
              ? `Road Kits · ${roadKitRows.length} total`
              : isCases
                ? `Roadcases · ${caseTotal} total`
                : `Inventory · ${itemTotal} total`
          }
          title={
            isKits
              ? `${roadKitRows.length} ${roadKitRows.length === 1 ? 'kit' : 'kits'}`
              : isCases
                ? `${visibleCases.length} ${visibleCases.length === 1 ? 'case' : 'cases'}`
                : `${visibleItems.length} ${visibleItems.length === 1 ? 'item' : 'items'}`
          }
          subtitle={
            isKits
              ? 'Reusable bundles of cases that travel together. Assign a whole kit to an event from Manifest, and the manifest groups its cases under the kit.'
              : isCases
                ? `Road & flight cases — which event holds each, and what's packed inside.${
                    activeWarehouseLabel ? ` · ${activeWarehouseLabel}` : ''
                  }${filter !== 'all' ? ` · ${activeFilterLabel}` : ''}`
                : `All inventory across every case — bulk and serialized items read live from the database.${
                    activeWarehouseLabel ? ` · ${activeWarehouseLabel}` : ''
                  }`
          }
          actions={isKits ? undefined : headerActions}
        />

        {isKits ? (
          <RoadKitsManager kits={roadKitRows} caseOptions={roadKitCaseOptions} canEdit={canEditCases} />
        ) : isCases ? (
          <>
            <div className="relative w-full sm:max-w-xs">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                type="search"
                value={caseSearch}
                onChange={(e) => setCaseSearch(e.target.value)}
                placeholder="Search label, zone, event, kit…"
                aria-label="Search cases"
                className="h-9 w-full rounded-md border border-input bg-transparent pr-3 pl-8 text-sm shadow-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>
            <CaseGrid
              rows={visibleCases}
              extras={caseExtras}
              totalCount={caseTotal}
              canEdit={canEditCases}
              weightUnit={weightUnit}
              warehouses={warehouses}
              onShowAll={
                warehouse !== 'all' || filter !== 'all'
                  ? () => {
                      pickWarehouse('all');
                      pickFilter('all');
                      setCaseSearch('');
                    }
                  : undefined
              }
            />
          </>
        ) : (
          <InventoryView
            rows={visibleItems.map((r) => ({
              id: r.id,
              payload: r.payload,
              code: itemMatrix[r.id]?.code ?? '',
              matrixSvg: itemMatrix[r.id]?.matrixSvg ?? '',
            }))}
            caseLabels={caseLabels}
            caseOptions={caseOptions}
            eventNames={eventNames}
            eventOptions={eventOptions}
            allTags={tags}
            kitCandidates={kitCandidates}
            canEdit={canEdit}
            canAttachLoose={canAttachLoose}
            actorName={actorName}
            totalCount={itemTotal}
          />
        )}
      </div>

      {/* MOBILE FilterFab — the rail collapses to a bottom-right button → bottom Sheet of the SAME
          controls (DESIGN_ALIGNMENT §3 / §5). Sits above the mobile tab bar. */}
      <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
        <Button
          type="button"
          size="icon"
          onClick={() => setMobileFiltersOpen(true)}
          aria-label="Catalog views and filters"
          className="fixed right-4 bottom-20 z-40 size-12 rounded-full shadow-lg md:hidden"
        >
          <SlidersHorizontal size={18} aria-hidden />
        </Button>
        <SheetContent side="bottom" className="max-h-[80dvh] gap-0 p-0">
          <SheetHeader>
            <SheetTitle>Catalog</SheetTitle>
            <SheetDescription>
              {isCases
                ? `${visibleCases.length} of ${caseTotal} cases`
                : `${visibleItems.length} of ${itemTotal} items`}
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-6 overflow-y-auto px-3 pb-6">
            <RailControls onPick={() => setMobileFiltersOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// Build a CSV from a header row + value rows and trigger a browser download. RFC-4180 quoting:
// any cell containing a comma, quote, or newline is double-quoted with embedded quotes doubled.
// A leading BOM keeps Excel honest about UTF-8. Client-only (uses Blob + a transient <a>).
function downloadCsv(
  name: string,
  headers: string[],
  rows: (string | number)[][]
): void {
  const esc = (v: string | number): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default CatalogScreen;
