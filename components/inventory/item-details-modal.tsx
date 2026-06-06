'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Check, ChevronsUpDown, Loader2, Plus, Printer, ScanLine, X } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Eyebrow } from '@/components/ui/eyebrow';
import { TagChip } from '@/components/ui/tag-chip';
import { ItemMatrixModal } from './item-matrix-modal';
import { cn } from '@/lib/util/utils';
import {
  itemTotalQty,
  itemInStorage,
  itemCaseIds,
  itemRollupState,
  itemIsOutOfService,
  itemTotalQty as itemDeployedQty,
  markItemOutOfService,
  returnItemToService,
  evaluateModelRequirements,
  partRefLabel,
  ITEM_KINDS,
  type InventoryPayload,
  type DistributionRow,
  type ItemUnit,
  type ItemFlag,
  type KitRequirement,
  type PartRefTag,
} from '@/lib/views/inventory-shape';
import type { ItemPatch } from '@/lib/db/write';
import type { DashTag } from '@/lib/types/types-dashboard';

// components/inventory/item-details-modal.tsx — the SHARED ItemDetailsModal (the full item
// detail/editor), reused by Manifest, Catalog, Inventory, Sign-off. A faithful port of index.html
// ItemDetailsModal (~L20531): a read-only summary header (deployed / in-storage / cases + Print
// Matrix) leading into the editable form — name, kind, sku, weight, Matrix code, #43 SKU variants,
// #22 bulk-vs-serial tracking (distribution rows OR serial units), stock/reorder/storage, the
// applied-tag chips, and the open-flag list. Save builds an ItemPatch and hands it to onSave (the
// host wires the gated upsertItem Server Action).
//
// REUSABLE API: `item` (live payload), `cases` (id+label for the case picker), `tagById` (resolve
// applied tag chips), controlled `open`/`onOpenChange`, `onSave(patch) => {ok?,error?}`, and an
// optional pre-built `matrixSvg` (server-encoded Data Matrix; the encoder is server-only). The
// modal owns the form state + pending UI + toast and closes on a clean save.

const STATES = ['draft', 'pending', 'packed'] as const;

// One editable bulk distribution row (CSV serials in the form, parsed on save).
interface DistFormRow {
  caseId: string;
  qty: number | string;
  serialsCsv: string;
  variantSku: string;
  state: string;
}

interface UnitFormRow {
  id: string;
  serial: string;
  location: string;
  sku: string;
  state: string;
}

function uid(): string {
  return 'unit-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export interface ItemDetailsCase {
  id: string;
  label: string;
}

// A lean candidate-item shape for the kit-BOM part picker (id + name + sku + the SKU-list inputs).
export interface KitCandidateItem {
  id: string;
  name?: string;
  sku?: string;
  skuOptions?: { sku: string; label?: string }[];
  tagIds?: string[];
}

// A searchable item picker for kit-requirement rows — the same "search bar + filtered list" feel as
// the roadcase Add-item modal, but inline (Popover + cmdk Command) so it fits a compact grid row and
// scales to a large catalog (a long <select> didn't). Module scope so it's never re-created per render.
function ReqItemCombobox({
  value,
  options,
  disabled,
  onSelect,
}: {
  value: string;
  options: KitCandidateItem[];
  disabled?: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value) || null;
  const labelOf = (o: KitCandidateItem) => (o.name || '(unnamed)') + (o.sku ? ` (${o.sku})` : '');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Pick the required item"
          className="flex h-7 w-full items-center justify-between gap-1 rounded-md border border-input bg-transparent px-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 dark:bg-input/30"
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? labelOf(selected) : 'Pick an item…'}
          </span>
          <ChevronsUpDown size={12} className="shrink-0 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search items by name or SKU…" className="text-xs" />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">No items match.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.id}
                  value={labelOf(o) + ' ' + o.id}
                  onSelect={() => {
                    onSelect(o.id);
                    setOpen(false);
                  }}
                  className="text-xs"
                >
                  <Check size={12} className={cn('mr-1.5 shrink-0', value === o.id ? 'opacity-100' : 'opacity-0')} aria-hidden />
                  <span className="truncate">{labelOf(o)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function ItemDetailsModal({
  item,
  cases,
  tagById,
  open,
  onOpenChange,
  onSave,
  onServiceChange,
  actorName,
  matrixSvg,
  canEdit = true,
  allInventory,
  allTags,
}: {
  item: InventoryPayload;
  cases: ItemDetailsCase[];
  tagById?: Map<string, DashTag>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: ItemPatch) => Promise<{ ok?: boolean; error?: string }>;
  /** When provided, renders the ServiceStatusPanel (mark out-of-service / log repair) + the
   *  RepairHistoryPanel. Flows a { status, flags } patch through this gated write. Omit to hide them
   *  (e.g. read-only / hosts that don't expose the service lifecycle). */
  onServiceChange?: (patch: { status: 'out_of_service' | null; flags: ItemFlag[] }) => Promise<{ ok?: boolean; error?: string }>;
  /** The acting user's display name, stamped on the service flag / resolution (the "by"). */
  actorName?: string;
  /** Server-built Data Matrix SVG for this item's `eitm:` code (Print Matrix tile). */
  matrixSvg?: string;
  canEdit?: boolean;
  /** The full live inventory (the #27 kit-BOM part picker + checklist draw from it). Omit to hide
   *  the Requirements editor / Kit checklist (e.g. a host that doesn't carry the catalog). */
  allInventory?: KitCandidateItem[];
  /** All tags (id + label) — the #27 kit-BOM part picker offers tag groups + labels checklist lines. */
  allTags?: PartRefTag[];
}) {
  // ── Form state (seeded from the item; mirrors the Python initDist/initUnits) ────────────────
  const [name, setName] = useState(item.name || '');
  const [kind, setKind] = useState((item.kind || item.type || 'peripheral') as string);
  const [sku, setSku] = useState(item.sku || '');
  // qr (the legacy manual code) is preserved on save but no longer editable — the Data Matrix is now
  // auto-generated from the item UUID (see the Data Matrix section + /api/item/[id]/matrix).
  const [qr] = useState(item.qr || '');
  // The item's AUTO-GENERATED Data Matrix (eitm code from the UUID + active tenant). Fetched on open so
  // the SAME code shows + prints no matter which screen opened the modal — universal, no caller threads
  // it. Seeded with the optional `matrixSvg` prop for an instant paint; the fetch adds the code string.
  const [matrix, setMatrix] = useState<{ code: string; svg: string }>(() => ({ code: '', svg: matrixSvg || '' }));
  const [matrixPrintOpen, setMatrixPrintOpen] = useState(false);
  useEffect(() => {
    if (!open || !item.id) return;
    let cancelled = false;
    fetch(`/api/item/${encodeURIComponent(item.id)}/matrix`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.svg === 'string') setMatrix({ code: d.code || '', svg: d.svg || matrixSvg || '' });
      })
      .catch(() => {
        /* offline / transient — keep the prop fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [open, item.id, matrixSvg]);
  const dmSvg = matrix.svg || matrixSvg || '';
  const dmCode = matrix.code || '';
  const [weight, setWeight] = useState(item.weight == null ? '' : String(item.weight));
  const [tracking, setTracking] = useState<'bulk' | 'serial'>(item.tracking === 'serial' ? 'serial' : 'bulk');
  const [stockTotal, setStockTotal] = useState(item.stockTotal == null ? '' : String(item.stockTotal));
  const [reorderPoint, setReorderPoint] = useState(item.reorderPoint == null ? '' : String(item.reorderPoint));
  const [storageNotes, setStorageNotes] = useState(item.storageNotes || '');
  const [skuOptions, setSkuOptions] = useState(
    (Array.isArray(item.skuOptions) ? item.skuOptions : []).map((o) => ({ sku: o.sku || '', label: o.label || '' }))
  );
  const [dist, setDist] = useState<DistFormRow[]>(() =>
    Array.isArray(item.distribution) && item.distribution.length > 0
      ? item.distribution.map((d) => ({
          caseId: d.caseId || '',
          qty: d.qty != null ? d.qty : 1,
          serialsCsv: Array.isArray(d.serials) ? d.serials.join(', ') : '',
          variantSku: d.variantSku || '',
          state: d.state || 'pending',
        }))
      : [{ caseId: '', qty: 1, serialsCsv: '', variantSku: '', state: 'pending' }]
  );
  const [units, setUnits] = useState<UnitFormRow[]>(() =>
    (Array.isArray(item.units) ? item.units : []).map((u) => ({
      id: u.id || uid(),
      serial: u.serial || '',
      location: u.location || 'storage',
      sku: u.sku || '',
      state: u.state || 'draft',
    }))
  );
  // #27 kit BOM — per-model requirements[] rows. Edited only when allInventory is supplied (the
  // host carries the catalog) AND the kind is 'equipment'.
  const [requirements, setRequirements] = useState<KitRequirement[]>(() =>
    (Array.isArray(item.requirements) ? item.requirements : []).map((r) => ({
      partRef: { kind: r.partRef?.kind === 'tag' ? 'tag' : 'item', ref: r.partRef?.ref || '' },
      qty: r.qty != null ? r.qty : 1,
      mode: r.mode === 'exact' ? 'exact' : 'atLeast',
      consumable: !!r.consumable,
      note: r.note || '',
    }))
  );
  const [pending, startTransition] = useTransition();
  // UNIVERSAL editor: callers that don't supply the kit-BOM catalog / tags / actor name (everything
  // except the catalog) let the modal FETCH them, so it renders the SAME full editor everywhere — one
  // editor, not a stripped-down roadcase/manifest variant. The fetch runs only when allInventory was
  // omitted (the catalog passes it and skips the round-trip).
  const [editorData, setEditorData] = useState<{ candidates: KitCandidateItem[]; tags: PartRefTag[]; actorName: string } | null>(null);
  useEffect(() => {
    if (!open || allInventory !== undefined) return;
    let cancelled = false;
    fetch('/api/item/editor-data', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && Array.isArray(d.candidates)) {
          setEditorData({ candidates: d.candidates, tags: Array.isArray(d.tags) ? d.tags : [], actorName: d.actorName || '' });
        }
      })
      .catch(() => {
        /* fetch failed → the kit-BOM section simply stays hidden, never a crash */
      });
    return () => {
      cancelled = true;
    };
  }, [open, allInventory]);
  const effCandidates = allInventory ?? editorData?.candidates;
  const effTags = allTags ?? editorData?.tags ?? [];
  const effActorName = actorName ?? editorData?.actorName;
  // Service write: use the caller's onServiceChange when given, else route through the universal
  // /api/item/[id]/service endpoint so the out-of-service / repair panel works everywhere.
  const serviceFallback = useCallback(
    async (patch: { status: 'out_of_service' | null; flags: ItemFlag[] }) => {
      try {
        const r = await fetch(`/api/item/${encodeURIComponent(item.id || '')}/service`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
          cache: 'no-store',
        });
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        return r.ok ? { ok: true } : { error: d.error || 'Could not update service status.' };
      } catch {
        return { error: 'Network error — please try again.' };
      }
    },
    [item.id]
  );
  const effServiceChange = onServiceChange ?? serviceFallback;
  const kitEnabled = Array.isArray(effCandidates);
  // Candidate satisfier items = everything except this model itself.
  const reqItemOptions = useMemo(
    () => (effCandidates || []).filter((it) => it && it.id !== item.id),
    [effCandidates, item.id]
  );
  const reqTagOptions = useMemo(() => (effTags || []).filter((t) => t && t.id), [effTags]);
  const addReq = () =>
    setRequirements((s) => [...s, { partRef: { kind: 'item', ref: '' }, qty: 1, mode: 'atLeast', consumable: false, note: '' }]);
  const updateReq = (i: number, patch: { partRef?: { kind?: 'item' | 'tag'; ref?: string }; qty?: number; mode?: KitRequirement['mode']; consumable?: boolean; note?: string }) =>
    setRequirements((s) =>
      s.map((r, j) => {
        if (j !== i) return r;
        const next: KitRequirement = { ...r };
        if (patch.partRef) next.partRef = { ...r.partRef, ...patch.partRef };
        if ('qty' in patch) next.qty = patch.qty as number;
        if ('mode' in patch) next.mode = patch.mode as KitRequirement['mode'];
        if ('consumable' in patch) next.consumable = !!patch.consumable;
        if ('note' in patch) next.note = patch.note as string;
        return next;
      })
    );
  const removeReq = (i: number) => setRequirements((s) => s.filter((_, j) => j !== i));

  // ── Read-only summary (deployed / in-storage / cases / flags) ──────────────────────────────
  const total = itemTotalQty(item);
  const storage = itemInStorage(item);
  const cids = itemCaseIds(item);
  const rollup = itemRollupState(item);
  const flags = Array.isArray(item.flags) ? item.flags : [];
  const openFlags = flags.filter((f) => f.status !== 'resolved');
  const caseLabelById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of cases) m[c.id] = c.label;
    return m;
  }, [cases]);

  const variantOpts = skuOptions.filter((o) => (o.sku || '').trim());
  const hasVariants = variantOpts.length > 0;
  const totalQty = dist.reduce((s, d) => s + (parseInt(String(d.qty), 10) || 0), 0);

  // ── Tag chips (applied tags, resolved + visible) ───────────────────────────────────────────
  const appliedTags = useMemo(() => {
    if (!tagById) return [];
    return (item.tagIds || []).map((id) => tagById.get(id)).filter((t): t is DashTag => !!t);
  }, [item.tagIds, tagById]);

  // ── Save: build the ItemPatch (mirrors the Python submit) ──────────────────────────────────
  function buildPatch(): ItemPatch {
    const base: ItemPatch = {
      name: name.trim() || '(unnamed)',
      kind,
      sku: sku.trim(),
      qr: qr.trim(),
      skuOptions: skuOptions
        .filter((o) => (o.sku || '').trim())
        .map((o) => ({ sku: o.sku.trim(), label: (o.label || '').trim() })),
      weight: weight === '' ? '' : Number(weight),
      reorderPoint: reorderPoint === '' ? null : Math.max(0, Number(reorderPoint)),
      // tagIds are passed through unchanged (the picker is a later wave; we never drop them).
      tagIds: Array.isArray(item.tagIds) ? item.tagIds : [],
      // #27 kit BOM — drop rows with no target; the server re-sanitizes too. Only sent when the
      // kit editor is enabled (host carries the catalog), else the stored requirements are untouched.
      ...(kitEnabled
        ? {
            requirements: requirements
              .filter((r) => r.partRef && (r.partRef.ref || '').trim())
              .map((r) => ({
                partRef: { kind: r.partRef.kind === 'tag' ? 'tag' : 'item', ref: r.partRef.ref.trim() },
                qty: Math.max(1, parseInt(String(r.qty), 10) || 1),
                mode: r.mode === 'exact' ? 'exact' : 'atLeast',
                consumable: !!r.consumable,
                note: (r.note || '').trim(),
              })),
          }
        : {}),
    };
    if (tracking === 'serial') {
      return {
        ...base,
        tracking: 'serial',
        units: units.map<ItemUnit>((u) => ({
          id: u.id || uid(),
          serial: (u.serial || '').trim(),
          location: u.location || 'storage',
          sku: (u.sku || '').trim(),
          state: (u.state as ItemUnit['state']) || 'draft',
          flags: [],
        })),
        distribution: [],
        stockTotal: null,
        storageNotes: '',
      };
    }
    const distribution: DistributionRow[] = dist.map((d) => ({
      caseId: d.caseId || null,
      qty: parseInt(String(d.qty), 10) || 1,
      serials: d.serialsCsv.trim() ? d.serialsCsv.split(',').map((s) => s.trim()).filter(Boolean) : [],
      variantSku: (d.variantSku || '').trim(),
      state: (d.state as DistributionRow['state']) || 'pending',
    }));
    const rawStock = stockTotal === '' ? null : Math.max(Number(stockTotal), totalQty);
    return {
      ...base,
      tracking: 'bulk',
      units: [],
      distribution,
      stockTotal: rawStock,
      storageNotes: storageNotes || '',
    };
  }

  function submit() {
    if (!name.trim()) {
      toast.warning('Name is required.');
      return;
    }
    if (tracking === 'bulk' && dist.length === 0) {
      toast.warning('Add at least one case/unassigned row.');
      return;
    }
    startTransition(async () => {
      const res = await onSave(buildPatch());
      if (res.error && !res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Saved ${name.trim() || 'item'}`);
      onOpenChange(false);
    });
  }

  const stockClamp = stockTotal !== '' && Number(stockTotal) < totalQty;

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>Item details · {item.name || item.sku || 'item'}</DialogTitle>
          <DialogDescription className="sr-only">
            View and edit this inventory item — identity, tracking, stock, tags and flags.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
          {/* Read-only summary header. */}
          <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
            <div className="flex items-center gap-3 border-b border-border bg-card px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">{item.name || '(unnamed)'}</div>
                <div className="mt-0.5 flex items-baseline gap-2">
                  <span className="text-[10px] capitalize text-muted-foreground">
                    {item.kind || item.type || '—'}
                  </span>
                  {(item.sku || item.qr) && (
                    <span className="font-mono text-[10px] text-muted-foreground/70">{item.qr || item.sku}</span>
                  )}
                </div>
              </div>
              <span
                className="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                style={{
                  color:
                    rollup === 'flagged'
                      ? 'var(--warning)'
                      : rollup === 'packed'
                        ? 'var(--st-ready)'
                        : 'var(--muted-foreground)',
                  borderColor:
                    rollup === 'flagged'
                      ? 'var(--warning)'
                      : rollup === 'packed'
                        ? 'var(--st-ready)'
                        : 'var(--border)',
                }}
              >
                {rollup}
              </span>
              {dmSvg ? (
                <span
                  role="img"
                  aria-label={`Data Matrix code for ${item.name || 'item'}`}
                  title="Item Data Matrix"
                  className="grid size-11 shrink-0 place-items-center rounded border border-border bg-white p-0.5 [&>svg]:block [&>svg]:size-full"
                  // Server-built, deterministic bwip-js SVG (no user HTML).
                  dangerouslySetInnerHTML={{ __html: dmSvg }}
                />
              ) : null}
            </div>
            <div className="flex flex-wrap divide-x divide-border">
              <SummaryStat label="Deployed" value={`× ${total}`} />
              {storage > 0 ? <SummaryStat label="In storage" value={`+ ${storage}`} accent="var(--primary)" /> : null}
              <SummaryStat label="Cases" value={cids.length || '—'} />
              <SummaryStat
                label="Flags"
                value={openFlags.length > 0 ? `${openFlags.length} open / ${flags.length}` : flags.length || '—'}
                accent={openFlags.length > 0 ? 'var(--warning)' : undefined}
              />
            </div>
            {cids.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
                <Eyebrow className="mr-1">In</Eyebrow>
                {cids.map((cid) => (
                  <a
                    key={cid}
                    href={`/cases/${encodeURIComponent(cid)}`}
                    className="text-[11px] text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                  >
                    {caseLabelById[cid] || cid}
                  </a>
                ))}
              </div>
            ) : null}
          </div>

          {/* Identity */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="item-name">Name</Label>
            <Input id="item-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="item-kind">Kind</Label>
              <select
                id="item-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                disabled={!canEdit}
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
              >
                {ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="item-sku">SKU</Label>
              <Input id="item-sku" value={sku} onChange={(e) => setSku(e.target.value)} disabled={!canEdit} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="item-weight">Weight ea. (kg)</Label>
              <Input
                id="item-weight"
                value={weight}
                inputMode="decimal"
                placeholder="e.g. 1.4"
                onChange={(e) => setWeight(e.target.value)}
                disabled={!canEdit}
              />
            </div>
          </div>
          {/* Data Matrix — AUTO-GENERATED from the item UUID + the active deployment tenant (eitm code).
              Read-only (there's no manual matrix to type); print it, or scan it from the Scan screen. */}
          <div className="flex flex-col gap-1.5">
            <Eyebrow>Data Matrix</Eyebrow>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
              {dmSvg ? (
                <span
                  role="img"
                  aria-label={`Data Matrix code for ${item.name || 'item'}`}
                  className="grid size-16 shrink-0 place-items-center rounded border border-border bg-white p-1 [&>svg]:block [&>svg]:size-full"
                  dangerouslySetInnerHTML={{ __html: dmSvg }}
                />
              ) : (
                <span className="grid size-16 shrink-0 place-items-center rounded border border-dashed border-border text-center text-[9px] text-muted-foreground">
                  No tenant set
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[11px] text-muted-foreground" title={dmCode || undefined}>
                  {dmCode || 'Set a deployment tenant to generate codes.'}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!dmSvg}
                    onClick={() => setMatrixPrintOpen(true)}
                  >
                    <Printer size={13} aria-hidden /> Print Matrix
                  </Button>
                  <Button type="button" variant="ghost" size="sm" asChild>
                    <Link href="/scan">
                      <ScanLine size={13} aria-hidden /> Scan
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* #43 SKU variants */}
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <Eyebrow>SKU variants · optional</Eyebrow>
              {canEdit ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSkuOptions((s) => [...s, { sku: '', label: '' }])}
                >
                  <Plus size={12} aria-hidden /> Add SKU
                </Button>
              ) : null}
            </div>
            {skuOptions.length === 0 ? (
              <p className="text-xs italic text-muted-foreground">
                One listing, one SKU. Add variants if this part ships under several model-branded SKUs.
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                {skuOptions.map((o, i) => (
                  <div
                    key={i}
                    className={cn('grid grid-cols-[1fr_1.4fr_28px] items-center gap-2 px-2.5 py-2', i && 'border-t border-border')}
                  >
                    <Input
                      value={o.sku}
                      placeholder="SKU code"
                      className="h-7 text-xs"
                      onChange={(e) =>
                        setSkuOptions((s) => s.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))
                      }
                      disabled={!canEdit}
                    />
                    <Input
                      value={o.label}
                      placeholder="Label (e.g. for CORE One)"
                      className="h-7 text-xs"
                      onChange={(e) =>
                        setSkuOptions((s) => s.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                      }
                      disabled={!canEdit}
                    />
                    {canEdit ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove SKU"
                        onClick={() => setSkuOptions((s) => s.filter((_, j) => j !== i))}
                      >
                        <X size={12} className="text-destructive" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* #22 Tracking toggle */}
          <div className="flex flex-wrap items-center gap-3">
            <Eyebrow>Tracking</Eyebrow>
            <div className="inline-flex overflow-hidden rounded-md border border-border">
              {(['bulk', 'serial'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => setTracking(t)}
                  className={cn(
                    'px-3.5 py-1 text-xs font-medium capitalize transition-colors',
                    tracking === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                  )}
                >
                  {t === 'bulk' ? 'Bulk qty' : 'Serialized'}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              {tracking === 'serial' ? 'Each unit tracked individually by serial + location.' : 'Counted quantities per case.'}
            </span>
          </div>

          {tracking === 'bulk' ? (
            <>
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                  <Eyebrow>Distribution · {totalQty} total</Eyebrow>
                  {canEdit ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setDist((d) => [...d, { caseId: '', qty: 1, serialsCsv: '', variantSku: '', state: 'pending' }])
                      }
                    >
                      <Plus size={12} aria-hidden /> Add row
                    </Button>
                  ) : null}
                </div>
                <div className="overflow-hidden rounded-lg border border-border">
                  <div
                    className={cn(
                      'grid gap-2 border-b border-border bg-muted/40 px-2.5 py-1.5',
                      hasVariants
                        ? 'grid-cols-[1.3fr_56px_1fr_92px_84px_28px]'
                        : 'grid-cols-[1.5fr_64px_1fr_100px_28px]'
                    )}
                  >
                    {(hasVariants
                      ? ['Case', 'Qty', 'Serials', 'Variant', 'State', '']
                      : ['Case', 'Qty', 'Serials', 'State', '']
                    ).map((h, i) => (
                      <span key={i} className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {h}
                      </span>
                    ))}
                  </div>
                  {dist.map((d, i) => (
                    <div
                      key={i}
                      className={cn(
                        'grid items-center gap-2 px-2.5 py-2',
                        i && 'border-t border-border',
                        hasVariants
                          ? 'grid-cols-[1.3fr_56px_1fr_92px_84px_28px]'
                          : 'grid-cols-[1.5fr_64px_1fr_100px_28px]'
                      )}
                    >
                      <select
                        value={d.caseId}
                        disabled={!canEdit}
                        onChange={(e) => setDist((s) => s.map((x, j) => (j === i ? { ...x, caseId: e.target.value } : x)))}
                        className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"
                      >
                        <option value="">— Unassigned —</option>
                        {cases.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <Input
                        type="number"
                        min={1}
                        value={d.qty}
                        className="h-7 text-xs"
                        disabled={!canEdit}
                        onChange={(e) => setDist((s) => s.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                      />
                      <Input
                        value={d.serialsCsv}
                        placeholder="S/N, …"
                        className="h-7 text-xs"
                        disabled={!canEdit}
                        onChange={(e) => setDist((s) => s.map((x, j) => (j === i ? { ...x, serialsCsv: e.target.value } : x)))}
                      />
                      {hasVariants ? (
                        <select
                          value={d.variantSku || ''}
                          disabled={!canEdit}
                          onChange={(e) => setDist((s) => s.map((x, j) => (j === i ? { ...x, variantSku: e.target.value } : x)))}
                          className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none dark:bg-input/30"
                        >
                          <option value="">{sku ? `${sku} (primary)` : '(primary)'}</option>
                          {variantOpts.map((o) => (
                            <option key={o.sku} value={o.sku}>
                              {o.sku}
                              {o.label ? ` · ${o.label}` : ''}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <select
                        value={d.state}
                        disabled={!canEdit}
                        onChange={(e) => setDist((s) => s.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))}
                        className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none dark:bg-input/30"
                      >
                        {STATES.map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                      {canEdit ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove row"
                          disabled={dist.length === 1}
                          onClick={() => setDist((s) => s.filter((_, j) => j !== i))}
                        >
                          <X size={12} className="text-destructive" aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              <div className={cn('grid gap-3', kind === 'consumable' ? 'grid-cols-[1fr_1fr_2fr]' : 'grid-cols-[1fr_2fr]')}>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="item-stock">Stock total</Label>
                  <Input
                    id="item-stock"
                    type="number"
                    min={totalQty}
                    value={stockTotal}
                    placeholder={`≥ ${totalQty}`}
                    onChange={(e) => setStockTotal(e.target.value)}
                    disabled={!canEdit}
                  />
                </div>
                {/* Reorder point is a low-stock threshold — only meaningful for consumables. */}
                {kind === 'consumable' ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="item-reorder">Reorder point</Label>
                    <Input
                      id="item-reorder"
                      type="number"
                      min={0}
                      value={reorderPoint}
                      placeholder="low-stock at"
                      onChange={(e) => setReorderPoint(e.target.value)}
                      disabled={!canEdit}
                    />
                  </div>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="item-storage">Storage notes</Label>
                  <Input
                    id="item-storage"
                    value={storageNotes}
                    placeholder="e.g. Shelf A-3, top drawer"
                    onChange={(e) => setStorageNotes(e.target.value)}
                    disabled={!canEdit}
                  />
                </div>
              </div>
              {stockClamp ? (
                <p className="rounded-md border border-warning/25 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                  Stock total can&apos;t be less than deployed ({totalQty}). It will be clamped on save.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                  <Eyebrow>Units · {units.length} total</Eyebrow>
                  {canEdit ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setUnits((u) => [...u, { id: uid(), serial: '', location: 'storage', sku: '', state: 'draft' }])
                      }
                    >
                      <Plus size={12} aria-hidden /> Add unit
                    </Button>
                  ) : null}
                </div>
                <div className="overflow-hidden rounded-lg border border-border">
                  <div
                    className={cn(
                      'grid gap-2 border-b border-border bg-muted/40 px-2.5 py-1.5',
                      hasVariants ? 'grid-cols-[1.2fr_1.3fr_96px_96px_28px]' : 'grid-cols-[1.4fr_1.4fr_110px_28px]'
                    )}
                  >
                    {(hasVariants
                      ? ['Serial / asset tag', 'Location', 'SKU', 'State', '']
                      : ['Serial / asset tag', 'Location', 'State', '']
                    ).map((h, i) => (
                      <span key={i} className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {h}
                      </span>
                    ))}
                  </div>
                  {units.length === 0 ? (
                    <p className="px-2.5 py-3 text-xs italic text-muted-foreground">
                      No units yet — &ldquo;Add unit&rdquo; to register one, or switch from Bulk to carry quantities over.
                    </p>
                  ) : (
                    units.map((u, i) => (
                      <div
                        key={u.id}
                        className={cn(
                          'grid items-center gap-2 px-2.5 py-2',
                          i && 'border-t border-border',
                          hasVariants ? 'grid-cols-[1.2fr_1.3fr_96px_96px_28px]' : 'grid-cols-[1.4fr_1.4fr_110px_28px]'
                        )}
                      >
                        <Input
                          value={u.serial}
                          placeholder="S/N or asset tag"
                          className="h-7 text-xs"
                          disabled={!canEdit}
                          onChange={(e) => setUnits((s) => s.map((x, j) => (j === i ? { ...x, serial: e.target.value } : x)))}
                        />
                        <select
                          value={u.location}
                          disabled={!canEdit}
                          onChange={(e) => setUnits((s) => s.map((x, j) => (j === i ? { ...x, location: e.target.value } : x)))}
                          className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none dark:bg-input/30"
                        >
                          <option value="storage">— In storage —</option>
                          {cases.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                        {hasVariants ? (
                          <select
                            value={u.sku || ''}
                            disabled={!canEdit}
                            onChange={(e) => setUnits((s) => s.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))}
                            className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none dark:bg-input/30"
                          >
                            <option value="">{sku ? `${sku} (primary)` : '(primary)'}</option>
                            {variantOpts.map((o) => (
                              <option key={o.sku} value={o.sku}>
                                {o.sku}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        <select
                          value={u.state}
                          disabled={!canEdit}
                          onChange={(e) => setUnits((s) => s.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))}
                          className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none dark:bg-input/30"
                        >
                          {STATES.map((st) => (
                            <option key={st} value={st}>
                              {st}
                            </option>
                          ))}
                        </select>
                        {canEdit ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove unit"
                            onClick={() => setUnits((s) => s.filter((_, j) => j !== i))}
                          >
                            <X size={12} className="text-destructive" aria-hidden />
                          </Button>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
              {kind === 'consumable' ? (
                <div className="flex flex-col gap-1.5 sm:w-1/3">
                  <Label htmlFor="item-reorder-s">Reorder point</Label>
                  <Input
                    id="item-reorder-s"
                    type="number"
                    min={0}
                    value={reorderPoint}
                    placeholder="low-stock at"
                    onChange={(e) => setReorderPoint(e.target.value)}
                    disabled={!canEdit}
                  />
                </div>
              ) : null}
            </>
          )}

          {/* Applied tags */}
          <div className="flex flex-col gap-2">
            <Eyebrow>Tags</Eyebrow>
            {appliedTags.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {appliedTags.map((t) => (
                  <TagChip key={t.id} tag={t} onClick={() => (window.location.href = `/tag/${t.id}`)} />
                ))}
              </div>
            ) : (
              <span className="text-xs italic text-muted-foreground">No tags applied.</span>
            )}
          </div>

          {/* #27 Requirements (kit BOM) — declares the peripherals/consumables a unit of this model
              needs to be field-ready. Each line targets a specific item OR a tag (any tagged item
              satisfies it). Equipment-only; opt-in (no rows ⇒ no readiness change). Shown only when
              the host supplies the catalog (allInventory). */}
          {kitEnabled ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <Eyebrow>Requirements · kit BOM</Eyebrow>
                {canEdit && kind === 'equipment' ? (
                  <Button type="button" variant="outline" size="sm" onClick={addReq}>
                    <Plus size={12} aria-hidden /> Add requirement
                  </Button>
                ) : null}
              </div>
              {kind !== 'equipment' ? (
                <p className="text-xs italic text-muted-foreground">
                  Available for Equipment items — set Kind to &ldquo;equipment&rdquo; to declare a kit BOM.
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    The peripherals / consumables a unit of this model needs to be field-ready. Target a specific
                    item, or a tag (any item carrying that tag satisfies it).
                  </p>
                  <div className="overflow-hidden rounded-lg border border-border">
                    <div className="grid grid-cols-[64px_1.5fr_52px_88px_56px_1.2fr_28px] gap-1.5 border-b border-border bg-muted/40 px-2.5 py-1.5">
                      {['Type', 'Part', 'Qty', 'Mode', 'Consum.', 'Note', ''].map((h, i) => (
                        <span key={i} className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {h}
                        </span>
                      ))}
                    </div>
                    {requirements.length === 0 ? (
                      <p className="px-2.5 py-3 text-xs italic text-muted-foreground">
                        No requirements — &ldquo;Add requirement&rdquo; to start a kit BOM for this model.
                      </p>
                    ) : (
                      requirements.map((r, i) => (
                        <div
                          key={i}
                          className={cn(
                            'grid grid-cols-[64px_1.5fr_52px_88px_56px_1.2fr_28px] items-center gap-1.5 px-2.5 py-2',
                            i && 'border-t border-border'
                          )}
                        >
                          <select
                            value={r.partRef.kind}
                            disabled={!canEdit}
                            onChange={(e) => updateReq(i, { partRef: { kind: e.target.value as 'item' | 'tag', ref: '' } })}
                            className="h-7 rounded-md border border-input bg-transparent px-1 text-xs outline-none dark:bg-input/30"
                          >
                            <option value="item">Item</option>
                            <option value="tag">Tag</option>
                          </select>
                          {r.partRef.kind === 'tag' ? (
                            <select
                              value={r.partRef.ref}
                              disabled={!canEdit}
                              onChange={(e) => updateReq(i, { partRef: { ref: e.target.value } })}
                              className="h-7 rounded-md border border-input bg-transparent px-1 text-xs outline-none dark:bg-input/30"
                            >
                              <option value="">— pick a tag —</option>
                              {reqTagOptions.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.label || t.id}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <ReqItemCombobox
                              value={r.partRef.ref}
                              options={reqItemOptions}
                              disabled={!canEdit}
                              onSelect={(id) => updateReq(i, { partRef: { ref: id } })}
                            />
                          )}
                          <Input
                            type="number"
                            min={1}
                            value={r.qty}
                            className="h-7 text-xs"
                            disabled={!canEdit}
                            onChange={(e) => updateReq(i, { qty: Number(e.target.value) })}
                          />
                          <select
                            value={r.mode}
                            disabled={!canEdit}
                            onChange={(e) => updateReq(i, { mode: e.target.value as KitRequirement['mode'] })}
                            className="h-7 rounded-md border border-input bg-transparent px-1 text-xs outline-none dark:bg-input/30"
                          >
                            <option value="atLeast">at least</option>
                            <option value="exact">exact</option>
                          </select>
                          <label className="flex items-center justify-center" title="consumed in the field — not flagged missing on return">
                            <input
                              type="checkbox"
                              checked={!!r.consumable}
                              disabled={!canEdit}
                              onChange={(e) => updateReq(i, { consumable: e.target.checked })}
                            />
                          </label>
                          <Input
                            value={r.note}
                            placeholder="optional"
                            className="h-7 text-xs"
                            disabled={!canEdit}
                            onChange={(e) => updateReq(i, { note: e.target.value })}
                          />
                          {canEdit ? (
                            <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove requirement" onClick={() => removeReq(i)}>
                              <X size={12} className="text-destructive" aria-hidden />
                            </Button>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>
                  {/* Kit checklist (read-only) — global "do we own enough of each required part" view
                      across the full inventory. Reflects the CURRENTLY-edited requirements. */}
                  {requirements.some((r) => r.partRef.ref) ? (
                    <KitChecklist
                      item={item}
                      requirements={requirements.filter((r) => r.partRef.ref)}
                      allInventory={effCandidates || []}
                      allTags={effTags}
                    />
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {/* Service status lifecycle (mark out-of-service / log repair) — universal (caller's handler
              or the /api/item/[id]/service fallback), so it shows everywhere the editor opens. */}
          {item.id ? (
            <ServiceStatusPanel item={item} actorName={effActorName} onServiceChange={effServiceChange} onDone={() => onOpenChange(false)} />
          ) : null}

          {/* Flag / repair history (rich — shows the resolution text). Universal, like the service panel. */}
          {flags.length > 0 ? <RepairHistoryPanel flags={flags} /> : null}
        </div>

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {canEdit ? 'Cancel' : 'Close'}
          </Button>
          {canEdit ? (
            <Button onClick={submit} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Save
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>

      {/* Print the item's auto-generated Data Matrix (1″ / 2″ / 4×6 label) — shared with the catalog. */}
      <ItemMatrixModal
        itemLabel={item.name || '(unnamed)'}
        itemSub={item.sku || dmCode}
        code={dmCode}
        matrixSvg={dmSvg}
        open={matrixPrintOpen}
        onOpenChange={setMatrixPrintOpen}
      />
    </>
  );
}

function SummaryStat({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="min-w-[70px] flex-1 px-3 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-bold" style={{ color: accent || 'var(--foreground)' }}>
        {value}
      </div>
    </div>
  );
}

// ── ServiceStatusPanel — out-of-service lifecycle control ─────────────────────────────────────
// A faithful port of index.html ServiceStatusPanel (~L22160): mark an item out of service (category +
// optional reason) or log a repair / return-to-service (resolution note → clears status + resolves
// open damage/maintenance flags). The next { status, flags } patch flows through the host's gated
// onServiceChange write. The pure markItemOutOfService / returnItemToService builders are shared.
function ServiceStatusPanel({
  item,
  actorName,
  onServiceChange,
  onDone,
}: {
  item: InventoryPayload;
  actorName?: string;
  onServiceChange: (patch: { status: 'out_of_service' | null; flags: ItemFlag[] }) => Promise<{ ok?: boolean; error?: string }>;
  onDone: () => void;
}) {
  const oos = itemIsOutOfService(item);
  const [mode, setMode] = useState<null | 'oos' | 'repair'>(null);
  const [note, setNote] = useState('');
  const [category, setCategory] = useState<'damage' | 'maintenance'>('damage');
  const [pending, startTransition] = useTransition();
  const by = actorName || 'user';

  const openServiceFlags = (item.flags || []).filter(
    (f) => f && f.status === 'open' && (f.category === 'damage' || f.category === 'maintenance')
  );

  function doMarkOos() {
    startTransition(async () => {
      const patch = markItemOutOfService(item, { note: note.trim(), severity: 'high', category, by });
      const res = await onServiceChange(patch);
      if (res.error && !res.ok) {
        toast.error(res.error);
        return;
      }
      toast.warning('Item marked out of service');
      setMode(null);
      setNote('');
      onDone();
    });
  }
  function doRepair() {
    if (!note.trim()) {
      toast.warning('Describe the repair / why it can return to service.');
      return;
    }
    startTransition(async () => {
      const patch = returnItemToService(item, { resolution: note.trim(), by });
      const res = await onServiceChange(patch);
      if (res.error && !res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Returned to service');
      setMode(null);
      setNote('');
      onDone();
    });
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Eyebrow>Service status</Eyebrow>
          {oos ? (
            <span className="rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide" style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}>
              Out of service
            </span>
          ) : (
            <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: 'var(--success)' }}>
              In service
            </span>
          )}
        </div>
        <div className="flex gap-1.5">
          {!oos && mode !== 'oos' ? (
            <Button type="button" variant="outline" size="sm" onClick={() => { setMode('oos'); setNote(''); }} style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}>
              Mark out of service
            </Button>
          ) : null}
          {oos && mode !== 'repair' ? (
            <Button type="button" variant="outline" size="sm" onClick={() => { setMode('repair'); setNote(''); }} style={{ color: 'var(--success)', borderColor: 'var(--success)' }}>
              Log repair / return to service
            </Button>
          ) : null}
        </div>
      </div>
      {oos && openServiceFlags.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {openServiceFlags.length} open service flag{openServiceFlags.length === 1 ? '' : 's'} will be resolved on return to service.
        </p>
      ) : null}
      {mode === 'oos' ? (
        <div className="flex flex-col gap-2 rounded-md border border-warning/60 bg-warning/[0.06] p-3">
          <Eyebrow>Category</Eyebrow>
          <div className="grid grid-cols-2 gap-2">
            {(['damage', 'maintenance'] as const).map((c) => (
              <Button
                key={c}
                type="button"
                variant={category === c ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={category === c}
                className="uppercase tracking-wide text-[11px]"
                style={category === c ? { color: 'var(--warning)', borderColor: 'var(--warning)' } : undefined}
                onClick={() => setCategory(c)}
              >
                {c}
              </Button>
            ))}
          </div>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (optional) — what's wrong with this item?" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setMode(null); setNote(''); }} disabled={pending}>Cancel</Button>
            <Button type="button" size="sm" onClick={doMarkOos} disabled={pending} style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}>
              {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
              Confirm out of service
            </Button>
          </div>
        </div>
      ) : null}
      {mode === 'repair' ? (
        <div className="flex flex-col gap-2 rounded-md border border-[color:var(--success)]/60 bg-[color:var(--success)]/[0.06] p-3">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done? Replaced part, recalibrated, returned to stock, etc." />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setMode(null); setNote(''); }} disabled={pending}>Cancel</Button>
            <Button type="button" size="sm" onClick={doRepair} disabled={pending} style={{ color: 'var(--success)', borderColor: 'var(--success)' }}>
              {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
              Return to service
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── RepairHistoryPanel — the flag/repair history (rich; shows the resolution text) ─────────────
// A faithful port of index.html RepairHistoryPanel (~L22251): every flag newest-first, with its
// status / severity / by / date and (for resolved flags) the resolution note.
function RepairHistoryPanel({ flags }: { flags: ItemFlag[] }) {
  const sorted = flags.slice().sort((a, b) => (b.flaggedAt || '').localeCompare(a.flaggedAt || ''));
  const fmt = (iso?: string) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }) : '—';
  return (
    <div className="flex flex-col gap-2">
      <Eyebrow>Flag history · {flags.length}</Eyebrow>
      <div className="flex flex-col gap-1.5">
        {sorted.map((f, i) => {
          const open = f.status === 'open';
          return (
            <div
              key={f.id || i}
              className={cn('rounded-md border p-2.5 text-xs', open ? 'border-destructive/30 bg-destructive/5' : 'border-border bg-muted/30')}
            >
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: open ? 'var(--warning)' : 'var(--success)' }}>
                  {f.status || 'open'}
                </span>
                <span
                  className="text-[9px] font-bold uppercase tracking-wide"
                  style={{ color: f.severity === 'high' ? 'var(--destructive)' : f.severity === 'med' ? 'var(--warning)' : 'var(--muted-foreground)' }}
                >
                  {f.severity || 'med'}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {f.flaggedBy || f.by || '—'} · {fmt(f.flaggedAt)}
                </span>
              </div>
              <div className="text-foreground">{f.note || '(no description)'}</div>
              {f.status === 'resolved' && f.resolution ? (
                <div className="mt-1.5 border-t border-border pt-1.5 text-muted-foreground">
                  Resolved{f.resolvedBy ? ` by ${f.resolvedBy}` : ''}: {f.resolution}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── KitChecklist — read-only stock-coverage view (#27) ─────────────────────────────────────────
// A faithful port of the ItemDetailsModal "Kit checklist" block (index.html ~L21001): for the
// model's saved/edited requirements, count how many of each required part the WHOLE inventory owns
// (deployed-qty, excluding out-of-service) and show ✓ / ✗ have N / need M per line. Global view; the
// per-event shortfalls surface separately on the event readiness strip.
function KitChecklist({
  item,
  requirements,
  allInventory,
  allTags,
}: {
  item: InventoryPayload;
  requirements: KitRequirement[];
  allInventory: KitCandidateItem[];
  allTags: PartRefTag[];
}) {
  const lines = useMemo(() => {
    // The candidate pool is the live inventory cast to the InventoryPayload shape the evaluator reads.
    const pool = allInventory as unknown as InventoryPayload[];
    return evaluateModelRequirements(
      { ...item, requirements },
      pool,
      (it) => itemDeployedQty(it),
      pool,
      allTags,
      1
    );
  }, [item, requirements, allInventory, allTags]);
  const shortN = lines.filter((l) => !l.met).length;
  if (lines.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <Eyebrow>Kit checklist</Eyebrow>
        <span className={cn('text-[11px]', shortN ? 'text-warning' : 'text-success')}>
          {shortN ? `${shortN} part group(s) short` : 'all parts in stock'}
        </span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        {lines.map((l, i) => (
          <div key={i} className={cn('flex items-center gap-2.5 px-2.5 py-2', i && 'border-t border-border')}>
            <span
              className="w-3.5 text-center text-sm font-bold"
              style={{ color: l.met ? 'var(--success)' : 'var(--warning)' }}
            >
              {l.met ? '✓' : '✗'}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {l.label || partRefLabel(l.req.partRef, allInventory, allTags)}
            </span>
            {l.consumable ? (
              <span className="rounded border border-border px-1.5 text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
                consumable
              </span>
            ) : null}
            <span className={cn('font-mono text-[11px]', l.met ? 'text-muted-foreground' : 'text-warning')}>
              have {l.have} / need {l.needed}
            </span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground">
        Global stock view (counts all deployed units, excludes out-of-service). Per-event shortfalls appear on the
        event readiness strip.
      </p>
    </div>
  );
}

export default ItemDetailsModal;
