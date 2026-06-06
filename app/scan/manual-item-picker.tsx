'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { itemCaseIds, type InventoryPayload } from '@/lib/inventory-shape';
import { itemMatchesManualQuery, type ScanItemLean } from '@/lib/scan';

// app/scan/manual-item-picker.tsx — the "Find item" picker. Faithful port of index.html
// ManualItemPicker (~L17610): a full-screen search over name / SKU / kind / serial, with All /
// In-this-case / Not-in-case filter pills (the case filters only show when a case is open). Tapping
// an item fires onPick(item). The match predicate (name/sku/kind/qr + bulk + serial-unit serials)
// is the shared lib/scan helper.

export function ManualItemPicker({
  items,
  activeCaseId,
  open,
  onOpenChange,
  onPick,
}: {
  items: ScanItemLean[];
  activeCaseId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (item: InventoryPayload, id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'incase' | 'notincase'>('all');

  const matches = useMemo(() => {
    let pool = items;
    if (filter === 'incase' && activeCaseId) {
      pool = pool.filter((x) => itemCaseIds(x.payload).indexOf(activeCaseId) >= 0);
    } else if (filter === 'notincase' && activeCaseId) {
      pool = pool.filter((x) => itemCaseIds(x.payload).indexOf(activeCaseId) < 0);
    }
    const q = search.trim();
    if (!q) return pool.slice(0, 100);
    return pool.filter((x) => itemMatchesManualQuery(x.payload, q)).slice(0, 100);
  }, [items, search, filter, activeCaseId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[90dvh] gap-0 p-0">
        <SheetHeader className="border-b border-border">
          <SheetTitle>Find item</SheetTitle>
          <SheetDescription className="sr-only">Search inventory by name, SKU, kind or serial.</SheetDescription>
          <div className="relative mt-2">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name / SKU / kind / serial…"
              aria-label="Search inventory"
              className="h-10 pl-9"
            />
          </div>
          {activeCaseId && (
            <div className="mt-2 flex gap-1.5">
              {(
                [
                  { k: 'all', l: 'All' },
                  { k: 'incase', l: 'In this case' },
                  { k: 'notincase', l: 'Not in case' },
                ] as const
              ).map((b) => {
                const active = filter === b.k;
                return (
                  <button
                    key={b.k}
                    type="button"
                    onClick={() => setFilter(b.k)}
                    aria-pressed={active}
                    className={cn(
                      'flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                      active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {b.l}
                  </button>
                );
              })}
            </div>
          )}
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {matches.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No items match.</p>
          ) : (
            matches.map((x) => {
              const it = x.payload;
              const inCase = !!activeCaseId && itemCaseIds(it).indexOf(activeCaseId) >= 0;
              return (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => onPick(it, x.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors',
                    'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-xs font-medium text-foreground">
                      {it.name}
                      {inCase ? ' · in case' : ''}
                    </span>
                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                      {(it.kind || it.type || '') + ' · ' + (it.qr || it.sku || x.id)}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default ManualItemPicker;
