'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Box,
  Zap,
  Layers,
  Briefcase,
  Disc3,
  AlertTriangle,
  Pencil,
  Plus,
  Trash2,
  QrCode,
  Briefcase as CaseIcon,
  Settings2,
  MoreHorizontal,
  Share2,
  X,
  Loader2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Eyebrow } from '@/components/ui/eyebrow';
import { TagChip } from '@/components/ui/tag-chip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/util/utils';
import { Search } from 'lucide-react';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  itemCaseIds,
  itemEventIds,
  itemQtyLooseAtEvent,
  itemRollupState,
  itemTotalQty,
  itemInStorage,
  itemIsLowStock,
  itemIsOutOfService,
  itemIsDueForService,
  itemStateTone,
  itemIsSerial,
  itemMatchesQuery,
  itemPassesFilter,
  ITEM_STATE_LABEL,
  ITEM_KINDS,
  kindIcon,
  type KindIconName,
  type ItemStateTone,
  type InventoryPayload,
  type ItemFlag,
  type PartRefTag,
} from '@/lib/views/inventory-shape';
import type { ItemPatch } from '@/lib/db/write';
import type { DashTag } from '@/lib/types/types-dashboard';
import { ItemDetailsModal, type ItemDetailsCase, type KitCandidateItem } from '@/components/inventory/item-details-modal';
import { ItemMatrixModal } from '@/components/inventory/item-matrix-modal';
import {
  saveItemDetailsAction,
  saveItemServiceAction,
  deleteItemAction,
  createItemAction,
  bulkReassignAction,
  bulkSetStateAction,
  bulkDeleteAction,
  bulkAttachToEventAction,
} from './actions';

// app/catalog/inventory-view.tsx — the dense Inventory surface of the merged Catalog (the
// ?view=inventory sub-section), brought to TRUE parity with the Python InventoryPanel (index.html
// ~L20021). Over the warehouse/filter-narrowed rows handed down by CatalogScreen this adds:
//   • BULK multi-select — a checkbox per row + a select-all header + a bulk TOOLBAR (Reassign to
//     case · Set state · ⋯ More → Attach to event (lead+) / Delete-with-preview-confirm).
//   • Item TAG chips inline on each row (reuses <TagChip>) + a loose-at-event badge (×N loose at E).
//   • Per-row Edit (opens the shared ItemDetailsModal) + Delete + a Print-Matrix affordance.
//   • A New-item create flow, a read-only summary header (deployed / in-storage / cases / flags),
//     a mobile condensed card + mobile select-all.
// All match/qty/state logic is the isomorphic lib/inventory-shape helpers (one source of truth with
// the Python). Writes flow through the gated Server Actions; reads are the live-DB props.

// ── The enriched row shape the server hands us ──────────────────────────────────────────────────
export interface InventoryItemRow {
  id: string;
  payload: InventoryPayload;
  /** The `eitm:…:i:<id>` code + server-encoded Data Matrix SVG for the Print-Matrix tile. */
  code: string;
  matrixSvg: string;
}

export interface InventoryEventOption {
  id: string;
  name: string;
  state: string;
}

const KIND_ICONS: Record<KindIconName, typeof Box> = {
  box: Box,
  bolt: Zap,
  spool: Disc3,
  layers: Layers,
  case: Briefcase,
};

function KindGlyph({ kind, className }: { kind: string | undefined; className?: string }) {
  const Glyph = KIND_ICONS[kindIcon(kind)];
  return <Glyph size={16} className={className} aria-hidden />;
}

const STATE_BADGE: Record<ItemStateTone, { variant: 'secondary' | 'destructive' | 'outline'; className?: string }> = {
  ok: { variant: 'outline', className: 'text-success border-success/50' },
  error: { variant: 'destructive' },
  neutral: { variant: 'secondary' },
};

const STATES = ['draft', 'pending', 'packed'] as const;

// A compact summary of an item's loose attachments (matches the Python looseSummary).
function looseSummary(it: InventoryPayload, eventNames: Record<string, string>): string {
  const eids = itemEventIds(it);
  const parts: string[] = [];
  for (const eid of eids) {
    const q = itemQtyLooseAtEvent(it, eid);
    if (q > 0) parts.push(`×${q} loose at ${eventNames[eid] || eid}`);
  }
  return parts.join(' · ');
}

export function InventoryView({
  rows,
  caseLabels,
  caseOptions,
  eventNames,
  eventOptions,
  tagById,
  allTags,
  kitCandidates,
  canEdit,
  canAttachLoose,
  actorName,
  totalCount,
}: {
  rows: InventoryItemRow[];
  /** caseId -> label, for the row case chips. */
  caseLabels: Record<string, string>;
  /** Live, non-retired cases for the editor + reassign picker. */
  caseOptions: ItemDetailsCase[];
  /** eventId -> name, for the loose-at-event badges. */
  eventNames: Record<string, string>;
  /** Draft/upcoming/packing events for the bulk attach-to-event picker. */
  eventOptions: InventoryEventOption[];
  /** Resolve applied-tag chips in the editor. */
  tagById?: Map<string, DashTag>;
  /** All tags (id + label) for the #27 kit-BOM picker + the inline row chips. */
  allTags: DashTag[];
  /** The catalog candidate items for the #27 kit-BOM part picker + checklist. */
  kitCandidates: KitCandidateItem[];
  canEdit: boolean;
  /** Lead+ — gates the bulk "Attach to event" action. */
  canAttachLoose: boolean;
  actorName?: string;
  totalCount: number;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<InventoryItemRow | null>(null);
  const [matrixFor, setMatrixFor] = useState<InventoryItemRow | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<InventoryItemRow | null>(null);
  const [bulkOp, setBulkOp] = useState<null | 'reassign' | 'state' | 'attach-event' | 'delete'>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const tagPartRefTags: PartRefTag[] = useMemo(() => allTags.map((t) => ({ id: t.id, label: t.label })), [allTags]);
  const tagMap = useMemo(() => {
    if (tagById) return tagById;
    const m = new Map<string, DashTag>();
    for (const t of allTags) m.set(t.id, t);
    return m;
  }, [tagById, allTags]);

  // Search + the per-kind / restock / repair-queue filter pills (the Python InventoryPanel's own
  // narrowing, on top of the warehouse/cross-view narrowing CatalogScreen already applied to `rows`).
  const counts = useMemo(() => {
    let restock = 0;
    let repair = 0;
    let due = 0;
    for (const r of rows) {
      if (itemIsLowStock(r.payload)) restock++;
      if (itemIsOutOfService(r.payload)) repair++;
      if (itemIsDueForService(r.payload)) due++;
    }
    return { restock, repair, due };
  }, [rows]);
  const filterChips = useMemo(
    () => [
      { id: 'all', label: 'All' },
      { id: 'unassigned', label: 'Unassigned' },
      { id: 'has-storage', label: 'Has storage stock' },
      { id: 'restock', label: `Restock (${counts.restock})` },
      { id: 'repair_queue', label: `Repair queue (${counts.repair})` },
      ...(counts.due > 0 ? [{ id: 'due_for_service', label: `Due for service (${counts.due})` }] : []),
      ...ITEM_KINDS.map((k) => ({ id: k, label: `${k[0].toUpperCase()}${k.slice(1)}s` })),
    ],
    [counts]
  );
  const visibleRows = useMemo(
    () => rows.filter((r) => itemPassesFilter(r.payload, r.id, filter) && itemMatchesQuery(r.payload, r.id, search)),
    [rows, filter, search]
  );

  const visibleIds = useMemo(() => visibleRows.map((r) => r.id), [visibleRows]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const selCount = selected.size;

  const toggleOne = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((s) => {
      if (allVisibleSelected) {
        const next = new Set(s);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      return new Set([...s, ...visibleIds]);
    });
  const clearSelection = () => setSelected(new Set());

  // Stable selected-id snapshot for a bulk action (only ids still visible).
  const selectedIds = useMemo(() => visibleIds.filter((id) => selected.has(id)), [visibleIds, selected]);

  // ── Editor save / service / delete (gated Server Actions) ──────────────────────────────────
  const onSaveItem = useCallback(async (id: string, patch: ItemPatch) => {
    const res = await saveItemDetailsAction(id, patch);
    if (res.ok) router.refresh();
    return res;
  }, [router]);
  const onServiceChange = useCallback(async (id: string, patch: { status: 'out_of_service' | null; flags: ItemFlag[] }) => {
    const res = await saveItemServiceAction(id, patch);
    if (res.ok) router.refresh();
    return res;
  }, [router]);

  function confirmDelete() {
    if (!deleteConfirm) return;
    const id = deleteConfirm.id;
    const fd = new FormData();
    fd.set('id', id);
    startTransition(async () => {
      const res = await deleteItemAction({}, fd);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success('Item deleted.');
      setDeleteConfirm(null);
      setSelected((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      router.refresh();
    });
  }

  // ── Summary header (deployed / in-storage / cases / flags across the whole narrowed collection,
  //    before the in-view search/filter — the "what's in this warehouse/filter" rollup). ─────────
  const summary = useMemo(() => {
    let deployed = 0;
    let storage = 0;
    let openFlags = 0;
    const caseSet = new Set<string>();
    for (const r of rows) {
      deployed += itemTotalQty(r.payload);
      storage += itemInStorage(r.payload);
      for (const c of itemCaseIds(r.payload)) caseSet.add(c);
      openFlags += (r.payload.flags || []).filter((f) => f && f.status === 'open').length;
    }
    return { deployed, storage, cases: caseSet.size, flags: openFlags };
  }, [rows]);

  return (
    <div className="flex flex-col gap-4">
      {/* Read-only summary header: deployed / in-storage / cases / flags. */}
      <div className="flex flex-wrap items-stretch gap-px overflow-hidden rounded-lg border border-border bg-border">
        <SummaryStat label="Deployed" value={summary.deployed} />
        <SummaryStat label="In storage" value={summary.storage} accent={summary.storage > 0 ? 'var(--primary)' : undefined} />
        <SummaryStat label="Cases" value={summary.cases || '—'} />
        <SummaryStat
          label="Open flags"
          value={summary.flags || '—'}
          accent={summary.flags > 0 ? 'var(--warning)' : undefined}
        />
        <div className="ml-auto flex items-center gap-2 bg-card px-3">
          {canEdit ? (
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus size={14} aria-hidden />
              New item
            </Button>
          ) : null}
        </div>
      </div>

      {/* Search + count */}
      <div className="flex flex-wrap items-center gap-3">
        <InputGroup className="max-w-sm flex-1 basis-60">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, SKU, Matrix, serial…"
            aria-label="Search inventory"
          />
        </InputGroup>
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          {visibleRows.length === rows.length
            ? `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`
            : `${visibleRows.length} of ${rows.length}`}
          {rows.length !== totalCount ? ` · ${totalCount} total` : ''}
        </span>
      </div>

      {/* Filter pills */}
      <div role="tablist" aria-label="Inventory filter" className="flex flex-wrap gap-2">
        {filterChips.map((f) => {
          const active = f.id === filter;
          return (
            <Button
              key={f.id}
              role="tab"
              aria-selected={active}
              variant={active ? 'secondary' : 'ghost'}
              size="sm"
              className={cn('rounded-full', active && 'ring-1 ring-border')}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </Button>
          );
        })}
      </div>

      {/* Bulk toolbar (shown when ≥1 row selected). */}
      {selCount > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-primary/60 bg-primary/[0.06] p-2.5">
          <span className="font-mono text-xs text-primary">{selCount} selected</span>
          <div className="flex-1" />
          {canEdit ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setBulkOp('reassign')}>
                <CaseIcon size={13} aria-hidden />
                <span className="hidden sm:inline">Reassign to case</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => setBulkOp('state')}>
                <Settings2 size={13} aria-hidden />
                <span className="hidden sm:inline">Set state</span>
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" aria-label="More bulk actions">
                    <MoreHorizontal size={15} aria-hidden />
                    <span className="ml-1 hidden sm:inline">More</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-1">
                  {canAttachLoose ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => setBulkOp('attach-event')}
                      className="block w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent"
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <Share2 size={13} aria-hidden className="text-muted-foreground" />
                        Attach to event
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        Attach loose to a future event (no case routing). For carry-on or hand-carried items.
                      </span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setBulkOp('delete')}
                    className="block w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-destructive/10"
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-destructive">
                      <X size={13} aria-hidden />
                      Delete
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      Permanently remove the selected inventory rows. Cannot be undone.
                    </span>
                  </button>
                </PopoverContent>
              </Popover>
            </>
          ) : null}
          <Button variant="ghost" size="sm" onClick={clearSelection}>
            Clear
          </Button>
        </div>
      ) : null}

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-xl ring-1 ring-foreground/10 md:block">
        {/* Header row */}
        <div className="grid grid-cols-[40px_72px_1fr_120px_1.2fr_160px_120px_80px] items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
          <Checkbox
            checked={allVisibleSelected}
            onCheckedChange={toggleAll}
            aria-label="Select all visible items"
            disabled={visibleIds.length === 0}
          />
          {['Qty', 'Item', 'Kind', 'Case', 'Matrix / SKU', 'State', ''].map((h, i) => (
            <Eyebrow key={i}>{h}</Eyebrow>
          ))}
        </div>
        {visibleRows.length === 0 ? (
          <div className="m-3 flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-10 text-center">
            <Box size={20} className="text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">No items match</p>
            <p className="text-xs text-muted-foreground">Adjust the search or filter to see inventory.</p>
          </div>
        ) : (
          visibleRows.map((r, i) => (
            <DesktopRow
              key={r.id}
              row={r}
              caseLabels={caseLabels}
              eventNames={eventNames}
              tagMap={tagMap}
              selected={selected.has(r.id)}
              onToggle={() => toggleOne(r.id)}
              onEdit={() => setEditing(r)}
              onMatrix={() => setMatrixFor(r)}
              onDelete={() => setDeleteConfirm(r)}
              canEdit={canEdit}
              first={i === 0}
            />
          ))
        )}
      </div>

      {/* Mobile card list */}
      <div className="flex flex-col overflow-hidden rounded-xl ring-1 ring-foreground/10 md:hidden">
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
          <Checkbox checked={allVisibleSelected} onCheckedChange={toggleAll} aria-label="Select all visible items" disabled={visibleIds.length === 0} />
          <Eyebrow>Select all · {visibleRows.length}</Eyebrow>
        </div>
        {visibleRows.length === 0 ? (
          <div className="m-3 flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <Box size={20} className="text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">No items match</p>
          </div>
        ) : (
          visibleRows.map((r, i) => (
            <MobileCard
              key={r.id}
              row={r}
              caseLabels={caseLabels}
              eventNames={eventNames}
              tagMap={tagMap}
              selected={selected.has(r.id)}
              onToggle={() => toggleOne(r.id)}
              onEdit={() => setEditing(r)}
              canEdit={canEdit}
              first={i === 0}
            />
          ))
        )}
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────────────────────── */}
      {editing ? (
        <ItemDetailsModal
          item={editing.payload}
          cases={caseOptions}
          tagById={tagMap}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          onSave={(patch) => onSaveItem(editing.id, patch)}
          onServiceChange={(patch) => onServiceChange(editing.id, patch)}
          actorName={actorName}
          matrixSvg={editing.matrixSvg}
          canEdit={canEdit}
          allInventory={kitCandidates}
          allTags={tagPartRefTags}
        />
      ) : null}

      {matrixFor ? (
        <ItemMatrixModal
          itemLabel={matrixFor.payload.name || matrixFor.payload.sku || 'item'}
          itemSub={matrixFor.payload.qr || matrixFor.payload.sku || ''}
          code={matrixFor.code}
          matrixSvg={matrixFor.matrixSvg}
          open
          onOpenChange={(o) => !o && setMatrixFor(null)}
        />
      ) : null}

      {/* New-item create flow. */}
      <NewItemDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(id) => {
          setNewOpen(false);
          router.refresh();
          // Open the editor on the new item once the refreshed list carries it.
          toast.success('Item created.');
          void id;
        }}
      />

      {/* Per-row delete confirm. */}
      <Dialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete item</DialogTitle>
            <DialogDescription>
              Permanently remove{' '}
              <strong className="text-foreground">{deleteConfirm?.payload.name || 'this item'}</strong> from
              inventory? This soft-deletes the record — it stops showing in the catalog and the tombstone
              replicates to peers.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Delete item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk operation modal. */}
      {bulkOp ? (
        <BulkActionModal
          op={bulkOp}
          ids={selectedIds}
          rows={visibleRows}
          caseOptions={caseOptions}
          eventOptions={eventOptions}
          onClose={() => setBulkOp(null)}
          onDone={() => {
            setBulkOp(null);
            clearSelection();
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function SummaryStat({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="min-w-[88px] flex-1 bg-card px-3 py-2.5">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-lg font-bold tabular-nums" style={{ color: accent || 'var(--foreground)' }}>
        {value}
      </div>
    </div>
  );
}

// ── Desktop row ─────────────────────────────────────────────────────────────────────────────────
function DesktopRow({
  row,
  caseLabels,
  eventNames,
  tagMap,
  selected,
  onToggle,
  onEdit,
  onMatrix,
  onDelete,
  canEdit,
  first,
}: {
  row: InventoryItemRow;
  caseLabels: Record<string, string>;
  eventNames: Record<string, string>;
  tagMap: Map<string, DashTag>;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onMatrix: () => void;
  onDelete: () => void;
  canEdit: boolean;
  first: boolean;
}) {
  const it = row.payload;
  const qty = itemTotalQty(it) || 1;
  const inStorage = itemInStorage(it);
  const cids = itemCaseIds(it);
  const rollup = itemRollupState(it);
  const low = itemIsLowStock(it);
  const oos = itemIsOutOfService(it);
  const serial = itemIsSerial(it);
  const loose = looseSummary(it, eventNames);
  const stateBadge = STATE_BADGE[itemStateTone(rollup)];
  const appliedTags = (it.tagIds || []).map((id) => tagMap.get(id)).filter((t): t is DashTag => !!t && !(t as { hidden?: boolean }).hidden);

  return (
    <div
      className={cn(
        'grid grid-cols-[40px_72px_1fr_120px_1.2fr_160px_120px_80px] items-center gap-2 px-4 py-2.5',
        !first && 'border-t border-border',
        selected && 'bg-primary/[0.05]'
      )}
    >
      <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${it.name || 'item'}`} />
      <span className="font-mono text-xs tabular-nums">
        <span className={cn(qty > 1 ? 'font-semibold text-foreground' : 'text-muted-foreground')}>×{qty}</span>
        {inStorage > 0 ? (
          <span className="ml-1 text-[10px] text-primary" title={`${inStorage} in storage`}>
            +{inStorage}
          </span>
        ) : null}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <KindGlyph kind={(it.kind || it.type) as string} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <button
            type="button"
            onClick={onEdit}
            className="block max-w-full truncate text-left text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={`Edit ${it.name || 'item'}`}
          >
            {it.name || '(unnamed item)'}
          </button>
          {(low || oos || serial) && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {serial && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  Serialized
                </Badge>
              )}
              {low && (
                <Badge variant="outline" className="gap-1 text-[10px] text-warning border-warning/50">
                  <AlertTriangle size={10} aria-hidden />
                  Low stock
                </Badge>
              )}
              {oos && (
                <Badge variant="outline" className="text-[10px] text-warning border-warning/50">
                  Out of service
                </Badge>
              )}
            </div>
          )}
          {appliedTags.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {appliedTags.slice(0, 5).map((t) => (
                <TagChip key={t.id} tag={t} compact onClick={() => (window.location.href = `/tag/${t.id}`)} />
              ))}
              {appliedTags.length > 5 ? (
                <span className="text-[9px] font-bold tracking-wide text-muted-foreground">+{appliedTags.length - 5}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <span className="truncate text-sm capitalize text-muted-foreground">{it.kind || it.type || '—'}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {cids.length === 0 && !loose ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <>
            {(cids.length > 3 ? cids.slice(0, 2) : cids).map((cid) => (
              <a
                key={cid}
                href={`/cases/${encodeURIComponent(cid)}`}
                className="max-w-full truncate text-xs text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                title={caseLabels[cid] || cid}
              >
                {caseLabels[cid] || cid}
              </a>
            ))}
            {cids.length > 3 ? (
              <span className="font-mono text-xs text-muted-foreground">+{cids.length - 2}</span>
            ) : null}
          </>
        )}
      </div>
      <span className="truncate font-mono text-xs text-muted-foreground" title={it.qr || it.sku || ''}>
        {it.qr || it.sku || '—'}
      </span>
      <div className="flex flex-col items-start gap-1">
        <Badge variant={stateBadge.variant} className={cn('tracking-wide', stateBadge.className)}>
          {ITEM_STATE_LABEL[rollup]}
        </Badge>
        {loose ? (
          <span className="block max-w-full truncate rounded bg-accent px-1.5 text-[10px] text-primary" title={loose}>
            {loose}
          </span>
        ) : null}
      </div>
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="icon-sm" aria-label="Print Matrix" title="Print Matrix" onClick={onMatrix}>
          <QrCode size={13} aria-hidden className="text-muted-foreground" />
        </Button>
        {canEdit ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label="Edit" title="Edit" onClick={onEdit}>
              <Settings2 size={13} aria-hidden className="text-muted-foreground" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Delete" title="Delete" onClick={onDelete}>
              <Trash2 size={13} aria-hidden className="text-destructive" />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Mobile card ─────────────────────────────────────────────────────────────────────────────────
function MobileCard({
  row,
  caseLabels,
  eventNames,
  tagMap,
  selected,
  onToggle,
  onEdit,
  canEdit,
  first,
}: {
  row: InventoryItemRow;
  caseLabels: Record<string, string>;
  eventNames: Record<string, string>;
  tagMap: Map<string, DashTag>;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  canEdit: boolean;
  first: boolean;
}) {
  const it = row.payload;
  const qty = itemTotalQty(it) || 1;
  const inStorage = itemInStorage(it);
  const cids = itemCaseIds(it);
  const rollup = itemRollupState(it);
  const low = itemIsLowStock(it);
  const oos = itemIsOutOfService(it);
  const loose = looseSummary(it, eventNames);
  const stateBadge = STATE_BADGE[itemStateTone(rollup)];
  const caseInline = cids.length === 0 ? 'unassigned' : cids.length === 1 ? caseLabels[cids[0]] || cids[0] : `${cids.length} cases`;
  const appliedTags = (it.tagIds || []).map((id) => tagMap.get(id)).filter((t): t is DashTag => !!t && !(t as { hidden?: boolean }).hidden);

  return (
    <div className={cn('relative px-3 py-2.5 pr-10', !first && 'border-t border-border', selected && 'bg-primary/[0.05]')}>
      {canEdit ? (
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit item"
          className="absolute right-2 top-2 rounded p-1.5 text-muted-foreground hover:text-foreground"
        >
          <Pencil size={14} aria-hidden />
        </button>
      ) : null}
      <div className="flex items-center gap-2">
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${it.name || 'item'}`} />
        <span className="font-mono text-xs">
          <span className={cn(qty > 1 ? 'font-semibold text-foreground' : 'text-muted-foreground')}>×{qty}</span>
          {inStorage > 0 ? <span className="ml-0.5 text-[10px] text-primary">+{inStorage}</span> : null}
        </span>
        <KindGlyph kind={(it.kind || it.type) as string} className="shrink-0 text-muted-foreground" />
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground">
          {it.name || '(unnamed)'}
        </button>
        <Badge variant={stateBadge.variant} className={cn('shrink-0 text-[10px]', stateBadge.className)}>
          {ITEM_STATE_LABEL[rollup]}
        </Badge>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 overflow-hidden pl-6 text-[10px]">
        <span className="capitalize text-muted-foreground">{it.kind || it.type || '—'}</span>
        <span className="text-muted-foreground/50">·</span>
        {cids.length > 0 ? (
          <a href={`/cases/${encodeURIComponent(cids[0])}`} className="truncate text-primary underline decoration-primary/40">
            {caseInline}
          </a>
        ) : (
          <span className="text-muted-foreground">unassigned</span>
        )}
        {loose ? <span className="shrink-0 text-primary">· {loose}</span> : null}
        {low ? (
          <span className="shrink-0 rounded border border-warning/50 bg-warning/10 px-1 font-bold text-warning">Low</span>
        ) : null}
        {oos ? (
          <span className="shrink-0 rounded border border-warning/50 bg-warning/10 px-1 font-bold text-warning">OOS</span>
        ) : null}
        {(it.qr || it.sku) && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="truncate font-mono text-muted-foreground">{it.qr || it.sku}</span>
          </>
        )}
        {appliedTags.length > 0 ? (
          <span className="flex shrink-0 items-center gap-0.5">
            {appliedTags.slice(0, 3).map((t) => (
              <TagChip key={t.id} tag={t} compact />
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ── New-item dialog ──────────────────────────────────────────────────────────────────────────────
function NewItemDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [pending, startTransition] = useTransition();
  function create() {
    startTransition(async () => {
      const res = await createItemAction(name.trim());
      if (res.error || !res.ok) {
        toast.error(res.error || 'Could not create the item.');
        return;
      }
      setName('');
      onCreated(res.id || '');
    });
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setName('');
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New inventory item</DialogTitle>
          <DialogDescription>Create a blank bulk item, then open it to set tracking, distribution and stock.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-item-name">Name</Label>
          <input
            id="new-item-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder="e.g. HDMI cable 2m"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={create} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Create item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Bulk action modal ─────────────────────────────────────────────────────────────────────────────
function BulkActionModal({
  op,
  ids,
  rows,
  caseOptions,
  eventOptions,
  onClose,
  onDone,
}: {
  op: 'reassign' | 'state' | 'attach-event' | 'delete';
  ids: string[];
  rows: InventoryItemRow[];
  caseOptions: ItemDetailsCase[];
  eventOptions: InventoryEventOption[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [caseId, setCaseId] = useState('');
  const [state, setState] = useState('packed');
  const [eventId, setEventId] = useState('');
  const [pending, startTransition] = useTransition();
  const byId = useMemo(() => {
    const m = new Map<string, InventoryItemRow>();
    for (const r of rows) m.set(r.id, r);
    return m;
  }, [rows]);
  const sample = ids.slice(0, 4).map((id) => byId.get(id)?.payload.name || id);

  function run() {
    startTransition(async () => {
      if (op === 'reassign') {
        const res = await bulkReassignAction(ids, caseId || null);
        if (res.error || !res.ok) {
          toast.error(res.error || 'Reassign failed.');
          return;
        }
        toast.success(`Reassigned ${res.count ?? ids.length} item(s).`);
      } else if (op === 'state') {
        const res = await bulkSetStateAction(ids, state);
        if (res.error || !res.ok) {
          toast.error(res.error || 'Set state failed.');
          return;
        }
        toast.success(`Set state on ${res.count ?? ids.length} item(s).`);
      } else if (op === 'delete') {
        const res = await bulkDeleteAction(ids);
        if (res.error || !res.ok) {
          toast.error(res.error || 'Delete failed.');
          return;
        }
        toast.success(`Deleted ${res.count ?? ids.length} item(s).`);
      } else if (op === 'attach-event') {
        if (!eventId) return;
        const res = await bulkAttachToEventAction(ids, eventId);
        if (res.error || !res.ok) {
          toast.error(res.error || 'Attach failed.');
          return;
        }
        const attached = res.attached ?? 0;
        const refused = res.refused ?? 0;
        const ev = eventOptions.find((e) => e.id === eventId);
        toast[refused ? 'warning' : 'success'](
          `Attached ${attached} item${attached === 1 ? '' : 's'} to ${ev?.name || 'event'}${refused ? ` · ${refused} refused` : ''}`
        );
      }
      onDone();
    });
  }

  const title =
    op === 'reassign'
      ? `Reassign ${ids.length} item${ids.length === 1 ? '' : 's'}`
      : op === 'state'
        ? `Set state on ${ids.length} item${ids.length === 1 ? '' : 's'}`
        : op === 'delete'
          ? `Delete ${ids.length} item${ids.length === 1 ? '' : 's'}?`
          : `Attach ${ids.length} item${ids.length === 1 ? '' : 's'} loose to an event`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Bulk action on the selected inventory rows.</DialogDescription>
        </DialogHeader>

        {op === 'reassign' ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Move all selected items into a different case. Choose <em>Unassigned</em> to detach without a destination.
            </p>
            <Label htmlFor="bulk-case">Destination case</Label>
            <select
              id="bulk-case"
              value={caseId}
              onChange={(e) => setCaseId(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none dark:bg-input/30"
            >
              <option value="">— Unassigned —</option>
              {caseOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {op === 'state' ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="bulk-state">New state</Label>
            <select
              id="bulk-state"
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none dark:bg-input/30"
            >
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {op === 'attach-event' ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5 rounded-md border border-warning/50 bg-warning/10 p-3 text-xs">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
              <div>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-warning">Use roadcases when possible</div>
                <p className="leading-relaxed text-muted-foreground">
                  Inventory should normally be added to a road case, then the case assigned to the event. Loose attachment
                  is for carry-on, hand-carried, or show-floor items. Each selected item gets a loose distribution row on
                  the chosen event with no case routing.
                </p>
              </div>
            </div>
            <Label htmlFor="bulk-event">Target event (draft / upcoming / packing)</Label>
            <select
              id="bulk-event"
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none dark:bg-input/30"
            >
              <option value="">— Pick an event —</option>
              {eventOptions.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} · {e.state}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">Lead+ only. Serial items are refused; bulk siblings still land.</p>
          </div>
        ) : null}

        {op === 'delete' ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              You&apos;re about to permanently delete <strong className="text-destructive">{ids.length}</strong> inventory
              rows. This cannot be undone.
            </p>
            <div className="rounded-md border border-border bg-card p-2.5 text-xs text-muted-foreground">
              {sample.map((s, i) => (
                <div key={i} className="py-0.5">
                  · {s}
                </div>
              ))}
              {ids.length > sample.length ? (
                <div className="mt-1 italic text-muted-foreground/70">and {ids.length - sample.length} more…</div>
              ) : null}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={op === 'delete' ? 'destructive' : 'default'}
            onClick={run}
            disabled={pending || (op === 'attach-event' && !eventId)}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {op === 'reassign'
              ? `Reassign ${ids.length}`
              : op === 'state'
                ? `Apply to ${ids.length}`
                : op === 'delete'
                  ? `Yes, delete ${ids.length}`
                  : `Attach ${ids.length} loose`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default InventoryView;
