'use client';

import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Search } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import {
  itemMatchesQuery,
  itemTotalQty,
  itemCaseIds,
  itemIsOutOfService,
  type InventoryPayload,
} from '@/lib/inventory-shape';

// components/inventory/add-item-to-case-modal.tsx — the SHARED searchable item picker (AddItemToCaseModal),
// reused by the Manifest loose-add path + (later) the Case "+ Add item" flow. A faithful port of
// index.html AddItemToCaseModal (~L22437): search by name/SKU/Matrix/kind/serial, items already in
// the target shown disabled, an empty-result Create-new CTA, and a footer "Create new item instead".
//
// LOOSE MODE: when `targetEventId` is set the picker attaches an item LOOSE to that event — the
// "already in target" test checks for an existing loose row at the event, the title reads "Add loose
// item to <event>". The modal stays OPEN after each add (multi-add in one pass) and closes on Done.
//
// REUSABLE API: `inventory` (live, non-deleted items as {id, payload}), `targetEventId`/`eventLabel`,
// `open`/`onOpenChange`, `onSelect(itemId) => {ok?,error?}` (the gated loose-add Server Action), and
// `onCreateNew(name)` (create-then-attach). The modal owns search + pending UI + toasts.

export interface PickerItem {
  id: string;
  payload: InventoryPayload;
}

export function AddItemToCaseModal({
  inventory,
  targetEventId,
  eventLabel,
  open,
  onOpenChange,
  onSelect,
  onCreateNew,
}: {
  inventory: PickerItem[];
  targetEventId?: string;
  eventLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (itemId: string) => Promise<{ ok?: boolean; error?: string }>;
  onCreateNew?: (name: string) => Promise<{ ok?: boolean; error?: string }>;
}) {
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const isLooseMode = !!targetEventId;

  const isInTarget = useMemo(
    () => (it: InventoryPayload) =>
      isLooseMode
        ? (it.distribution || []).some((d) => !d.caseId && d.eventId === targetEventId)
        : false,
    [isLooseMode, targetEventId]
  );

  const sorted = useMemo(() => {
    const filtered = inventory.filter((r) => itemMatchesQuery(r.payload, r.id, query));
    return filtered.slice().sort((a, b) => {
      const aIn = isInTarget(a.payload);
      const bIn = isInTarget(b.payload);
      if (aIn !== bIn) return aIn ? 1 : -1;
      return (a.payload.name || '').localeCompare(b.payload.name || '');
    });
  }, [inventory, query, isInTarget]);

  const addable = sorted.filter((r) => !isInTarget(r.payload)).length;
  const inTargetCopy = isLooseMode ? 'already loose at this event' : 'already in this case';

  function pick(itemId: string) {
    setPendingId(itemId);
    startTransition(async () => {
      const res = await onSelect(itemId);
      setPendingId(null);
      if (res.error && !res.ok) {
        toast.error(res.error);
        return;
      }
      // Stay open (multi-add). The host revalidates so the row flips to "already loose" on the next render.
    });
  }

  function create() {
    if (!onCreateNew) return;
    const name = query.trim();
    setPendingId('__new__');
    startTransition(async () => {
      const res = await onCreateNew(name);
      setPendingId(null);
      if (res.error && !res.ok) {
        toast.error(res.error);
        return;
      }
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setQuery('');
        onOpenChange(o);
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Add item {isLooseMode ? `loose to ${eventLabel || 'event'}` : 'to case'}
          </DialogTitle>
          <DialogDescription>
            Search the catalog and attach an existing item, or create a new one.
          </DialogDescription>
        </DialogHeader>

        <div>
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, SKU, Matrix, kind, or serial…"
              aria-label="Search inventory"
            />
          </InputGroup>
          <p className="mt-1.5 text-xs text-muted-foreground" aria-live="polite">
            {sorted.length} match{sorted.length === 1 ? '' : 'es'}
            {sorted.length !== addable ? ` · ${sorted.length - addable} ${inTargetCopy}` : ''}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
              <p className="text-sm text-muted-foreground">No items match &ldquo;{query}&rdquo;.</p>
              {onCreateNew ? (
                <Button size="sm" onClick={create} disabled={pendingId === '__new__'}>
                  {pendingId === '__new__' ? <Loader2 className="animate-spin" aria-hidden /> : <Plus size={12} aria-hidden />}
                  Create new item
                </Button>
              ) : null}
            </div>
          ) : (
            sorted.map((r, i) => {
              const it = r.payload;
              const inTarget = isInTarget(it);
              const oos = itemIsOutOfService(it);
              const qty = itemTotalQty(it) || 1;
              const cidCount = itemCaseIds(it).length;
              const disabled = inTarget || oos;
              return (
                <div
                  key={r.id}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5',
                    i && 'border-t border-border/60',
                    disabled && 'opacity-55'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{it.name || '(unnamed)'}</div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {it.kind || '—'}
                      {it.sku ? ` · ${it.sku}` : ''}
                      {it.qr ? ` · ${it.qr}` : ''}
                      {qty > 1 ? ` · ×${qty} deployed` : ''}
                      {cidCount > 1 ? ` · in ${cidCount} cases` : ''}
                    </div>
                  </div>
                  {oos ? (
                    <span
                      className="shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                      style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}
                      title="Out of service — not assignable"
                    >
                      Out of service
                    </span>
                  ) : inTarget ? (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                      {isLooseMode ? 'Loose at event' : 'In this case'}
                    </span>
                  ) : (
                    <Button size="sm" className="shrink-0" onClick={() => pick(r.id)} disabled={pendingId === r.id}>
                      {pendingId === r.id ? <Loader2 className="animate-spin" aria-hidden /> : <Plus size={12} aria-hidden />}
                      Add
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          {onCreateNew ? (
            <Button variant="ghost" size="sm" onClick={create} disabled={pendingId === '__new__'}>
              <Plus size={12} aria-hidden /> Create new item instead
            </Button>
          ) : (
            <span />
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AddItemToCaseModal;
