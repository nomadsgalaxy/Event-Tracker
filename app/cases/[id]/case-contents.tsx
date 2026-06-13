'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Flag,
  CheckCircle2,
  Trash2,
  PackageOpen,
  Loader2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  itemQtyInCase,
  itemStateInCase,
  caseOpenFlag,
  unitsInCase,
  type InventoryPayload,
  type ItemFlag,
} from '@/lib/views/inventory-shape';
import type { ItemPatch } from '@/lib/db/write';
import type { DashTag } from '@/lib/types/types-dashboard';
import { kindLucide } from '../kind-icon';
import { ItemDetailsModal } from '@/components/inventory/item-details-modal';
import { FlagItemModal, ResolveFlagModal } from '@/components/inventory/flag-modals';
import { AddItemToCaseModal, type PickerItem } from '@/components/inventory/add-item-to-case-modal';
import {
  cycleItemStateAction,
  addItemToCaseAction,
  createItemInCaseAction,
  saveCaseItemAction,
  flagCaseItemAction,
  resolveCaseFlagAction,
  removeItemFromCaseAction,
  deleteCaseItemAction,
} from '../actions';

// case-contents.tsx — the EDITABLE contents/manifest on the case detail (feature parity). A faithful
// port of the CaseDetail item rows (index.html ~L14306-14430): per-item per-case qty/state, a state
// pill that CYCLES packed ↔ pending on click (cycleItemState), serials + applied-tag chips, and a row
// menu (Edit → ItemDetailsModal · Flag/Resolve → Flag modals · Remove from case). An "Add item"
// button opens the SHARED AddItemToCaseModal picker. All writes flow through the gated Server Actions.

export interface CaseContentItem {
  id: string;
  payload: InventoryPayload;
  /** Server-built Data Matrix SVG for the item (ItemDetailsModal's Print Matrix tile). */
  matrixSvg?: string;
}

export function CaseContents({
  caseId,
  items,
  pickerItems,
  caseLabel,
  caseLabels,
  tagById,
  canEdit,
}: {
  caseId: string;
  /** The items routed INTO this case (full payloads for the modals). */
  items: CaseContentItem[];
  /** The full (non-deleted) inventory for the Add-item picker (lean {id, payload}). */
  pickerItems: PickerItem[];
  caseLabel: string;
  /** caseId -> label map for the ItemDetailsModal case picker. */
  caseLabels: Record<string, string>;
  tagById?: Map<string, DashTag>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<CaseContentItem | null>(null);
  const [flagItem, setFlagItem] = useState<InventoryPayload | null>(null);
  const [resolveItem, setResolveItem] = useState<{ item: InventoryPayload; flag: ItemFlag } | null>(null);
  const [deleteItem, setDeleteItem] = useState<InventoryPayload | null>(null);
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  // After "Create new item" mints + attaches a blank item, we open the editor on it once the refresh
  // brings the new row into `items` — mirroring the catalog's create-blank-then-edit flow.
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingEditId) return;
    const fresh = items.find((r) => r.id === pendingEditId);
    if (fresh) {
      setEditItem(fresh);
      setPendingEditId(null);
    }
  }, [items, pendingEditId]);

  const itemDetailsCases = Object.entries(caseLabels).map(([id, label]) => ({ id, label }));

  function cycle(it: InventoryPayload) {
    if (!it.id) return;
    setBusyId(it.id);
    startTransition(async () => {
      const res = await cycleItemStateAction(it.id!, caseId);
      setBusyId(null);
      if (res.error || !res.ok) toast.error(res.error || 'Could not update.');
      else router.refresh();
    });
  }

  function remove(it: InventoryPayload) {
    if (!it.id) return;
    setBusyId(it.id);
    startTransition(async () => {
      const res = await removeItemFromCaseAction(it.id!, it, caseId);
      setBusyId(null);
      if (res.error || !res.ok) toast.error(res.error || 'Could not remove.');
      else {
        toast.success('Removed from case.');
        router.refresh();
      }
    });
  }

  function confirmDelete() {
    const it = deleteItem;
    if (!it?.id) return;
    setBusyId(it.id);
    startTransition(async () => {
      const res = await deleteCaseItemAction(it.id!, caseId);
      setBusyId(null);
      setDeleteItem(null);
      if (res.error || !res.ok) toast.error(res.error || 'Could not delete.');
      else {
        toast.success('Item deleted.');
        router.refresh();
      }
    });
  }

  return (
    <div className="px-0">
      {canEdit ? (
        <div className="mb-3 flex justify-end px-4">
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus size={14} aria-hidden />
            Add item
          </Button>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="mx-4 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
          <PackageOpen className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">Nothing packed in this case yet.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Item</TableHead>
              <TableHead className="hidden md:table-cell">Kind</TableHead>
              <TableHead className="hidden font-mono md:table-cell">SKU</TableHead>
              <TableHead className="w-px text-right">Qty</TableHead>
              <TableHead className="w-px text-right">State</TableHead>
              {canEdit ? <TableHead className="w-px pr-4 text-right">Actions</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((row) => {
              const it = row.payload;
              const KindIcon = kindLucide(it.kind || it.type || '');
              const qty = itemQtyInCase(it, caseId);
              const open = caseOpenFlag(it, caseId);
              const perCase = itemStateInCase(it, caseId);
              const state: 'packed' | 'pending' | 'flagged' = open ? 'flagged' : perCase === 'packed' ? 'packed' : 'pending';
              const serials =
                it.tracking === 'serial'
                  ? (it.units || []).filter((u) => u && !u.deletedAt && u.location === caseId).map((u) => u.serial).filter(Boolean)
                  : (it.distribution || []).filter((d) => d.caseId === caseId).flatMap((d) => d.serials || []).filter(Boolean);
              const tags = (it.tagIds || [])
                .map((id) => tagById?.get(id))
                .filter((t): t is DashTag => !!t);
              const busy = busyId === it.id;
              return (
                <TableRow key={row.id} className="hover:bg-muted/50">
                  <TableCell className="pl-4 md:max-w-0">
                    <span className="flex items-center gap-2">
                      <KindIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0">
                        <span className="block font-medium text-foreground [overflow-wrap:anywhere] md:truncate">{it.name || '(unnamed)'}</span>
                        {(serials.length > 0 || tags.length > 0) && (
                          <span className="mt-0.5 flex flex-wrap items-center gap-1">
                            {serials.slice(0, 4).map((s) => (
                              <span key={s} className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                                {s}
                              </span>
                            ))}
                            {serials.length > 4 ? (
                              <span className="text-[10px] text-muted-foreground">+{serials.length - 4}</span>
                            ) : null}
                            {tags.map((t) => (
                              <span
                                key={t.id}
                                className="rounded px-1 text-[10px]"
                                style={{ color: t.color || 'var(--muted-foreground)', border: `1px solid ${t.color || 'var(--border)'}` }}
                              >
                                {t.flair ? `${t.flair} ` : ''}
                                {t.label}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground capitalize md:table-cell">{it.kind || it.type || '—'}</TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{it.qr || it.sku || '—'}</TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">×{qty}</TableCell>
                  <TableCell className="text-right">
                    {/* The state pill cycles packed ↔ pending on click (flagged is driven by the flag). */}
                    {canEdit && state !== 'flagged' ? (
                      <button
                        type="button"
                        onClick={() => cycle(it)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        title="Click to toggle packed / pending"
                      >
                        {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
                        <Badge variant={state === 'packed' ? 'default' : 'outline'}>
                          {state === 'packed' ? 'Packed' : 'Pending'}
                        </Badge>
                      </button>
                    ) : (
                      <Badge variant={state === 'flagged' ? 'destructive' : state === 'packed' ? 'default' : 'outline'}>
                        {state === 'flagged' ? 'Flagged' : state === 'packed' ? 'Packed' : 'Pending'}
                      </Badge>
                    )}
                  </TableCell>
                  {canEdit ? (
                    <TableCell className="pr-4 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${it.name || 'item'}`}>
                            <MoreHorizontal size={16} aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setEditItem(row)}>
                            <Pencil size={14} aria-hidden /> Edit item
                          </DropdownMenuItem>
                          {open ? (
                            <DropdownMenuItem onSelect={() => setResolveItem({ item: it, flag: open })}>
                              <CheckCircle2 size={14} aria-hidden /> Resolve flag
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onSelect={() => setFlagItem(it)}>
                              <Flag size={14} aria-hidden /> Flag item
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => remove(it)}>
                            <Trash2 size={14} aria-hidden /> Remove from case
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setDeleteItem(it)} variant="destructive">
                            <Trash2 size={14} aria-hidden /> Delete item
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {/* Add existing item (or create new) — the shared picker. */}
      {canEdit ? (
        <AddItemToCaseModal
          inventory={pickerItems}
          open={addOpen}
          onOpenChange={setAddOpen}
          onSelect={async (itemId) => {
            const res = await addItemToCaseAction(itemId, caseId);
            if (res.ok) router.refresh();
            return res;
          }}
          onCreateNew={async (name) => {
            const res = await createItemInCaseAction(name, caseId);
            if (res.ok) {
              router.refresh();
              if (res.id) setPendingEditId(res.id); // open the editor on the new item after refresh
            }
            return res;
          }}
        />
      ) : null}

      {/* Edit one item — the shared ItemDetailsModal. */}
      {editItem ? (
        <ItemDetailsModal
          item={editItem.payload}
          cases={itemDetailsCases}
          tagById={tagById}
          matrixSvg={editItem.matrixSvg}
          open={!!editItem}
          onOpenChange={(o) => !o && setEditItem(null)}
          onSave={async (patch: ItemPatch) => {
            const res = await saveCaseItemAction(editItem.id, patch, caseId);
            if (res.ok) router.refresh();
            return res;
          }}
        />
      ) : null}

      {/* Flag / Resolve — the shared flag modals. */}
      {flagItem ? (
        <FlagItemModal
          item={flagItem}
          open={!!flagItem}
          onOpenChange={(o) => !o && setFlagItem(null)}
          serialUnits={
            flagItem.tracking === 'serial'
              ? unitsInCase(flagItem, caseId).map((u) => ({ id: u.id || '', serial: u.serial || '' }))
              : undefined
          }
          onSubmit={async (data) => {
            const res = await flagCaseItemAction(flagItem.id || '', flagItem, data, caseId);
            if (res.ok) router.refresh();
            return res;
          }}
        />
      ) : null}
      {resolveItem ? (
        <ResolveFlagModal
          item={resolveItem.item}
          flag={resolveItem.flag}
          open={!!resolveItem}
          onOpenChange={(o) => !o && setResolveItem(null)}
          onSubmit={async (resolution) => {
            const res = await resolveCaseFlagAction(resolveItem.item.id || '', resolveItem.item, resolveItem.flag.id || '', resolution, caseId);
            if (res.ok) router.refresh();
            return res;
          }}
        />
      ) : null}

      {/* Delete-item confirm (matches the Python "removes the item everywhere, not just this case"). */}
      <Dialog open={!!deleteItem} onOpenChange={(o) => !o && setDeleteItem(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete item</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{deleteItem?.name || 'this item'}&rdquo; from inventory? This removes the
              item everywhere, not just from this case.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteItem(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default CaseContents;
