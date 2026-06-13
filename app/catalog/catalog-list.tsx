'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Search,
  Box,
  Boxes,
  Plug,
  Wrench,
  Flag,
  Lamp,
  Cable,
  Disc3,
  AlertTriangle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/util/utils';
import {
  itemCaseIds,
  itemRollupState,
  itemTotalQty,
  itemInStorage,
  itemIsLowStock,
  itemIsOutOfService,
  itemMatchesQuery,
  itemPassesFilter,
  itemStateTone,
  itemIsSerial,
  ITEM_STATE_LABEL,
  kindIcon,
  ITEM_KINDS,
  type KindIconName,
  type ItemStateTone,
  type InventoryPayload,
} from '@/lib/views/inventory-shape';

// catalog-list.tsx — the interactive half of the catalog: live search + kind/status filter over
// the server-read rows in a dense shadcn Table. The server already excluded soft-deleted docs;
// this just narrows + renders. All match/qty/state logic comes from the isomorphic
// lib/inventory-shape helpers so a bulk item and a serialized item (#22) read identically here
// and in the detail page. Token-driven, hover rows, tabular-nums quantities, dashed empty state.

// The lean row shape the server hands us — no Mongo internals, fully serializable.
export interface CatalogRow {
  id: string;
  payload: InventoryPayload;
}

interface FilterChip {
  id: string;
  label: string;
}

const STATIC_FILTERS: FilterChip[] = [
  { id: 'all', label: 'All' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'has-storage', label: 'Has storage stock' },
  { id: 'restock', label: 'Restock' },
  { id: 'repair_queue', label: 'Repair queue' },
];

// The kind glyph name (from lib/inventory-shape.kindIcon) -> a lucide component. Single mapping
// so a bulk and serial item of the same kind share one glyph everywhere.
const KIND_ICONS: Record<KindIconName, typeof Box> = {
  box: Box,
  plug: Plug,
  spool: Disc3,
  wrench: Wrench,
  flag: Flag,
  fixture: Lamp,
  system: Boxes,
  cable: Cable,
};

function KindGlyph({ kind, className }: { kind: string | undefined; className?: string }) {
  const Glyph = KIND_ICONS[kindIcon(kind)];
  return <Glyph size={16} className={className} aria-hidden />;
}

// The rollup state isn't an event-lifecycle state, so it maps to a Badge variant (not a --st-*
// token). ok -> outline green-tinted via class, error -> destructive, neutral -> secondary.
const STATE_BADGE: Record<ItemStateTone, { variant: 'secondary' | 'destructive' | 'outline'; className?: string }> = {
  ok: { variant: 'outline', className: 'text-success border-success/50' },
  error: { variant: 'destructive' },
  neutral: { variant: 'secondary' },
};

export function CatalogList({
  rows,
  caseLabels,
  canEdit,
  totalCount,
  flaggedCount,
}: {
  rows: CatalogRow[];
  caseLabels: Record<string, string>;
  canEdit: boolean;
  /** The full inventory size (before the rail's warehouse/filter narrowing), for the count line.
   *  Falls back to rows.length when the list is used standalone. */
  totalCount?: number;
  /** Items in a flagged rollup state (whole collection), surfaced as a meta hint. */
  flaggedCount?: number;
}) {
  const grandTotal = totalCount ?? rows.length;
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');

  // Dynamic per-filter counts (restock / repair queue) so the chips are honest. Cheap — the
  // catalog is a few hundred rows at most.
  const counts = useMemo(() => {
    let restock = 0;
    let repair = 0;
    for (const r of rows) {
      if (itemIsLowStock(r.payload)) restock++;
      if (itemIsOutOfService(r.payload)) repair++;
    }
    return { restock, repair };
  }, [rows]);

  const filters: FilterChip[] = [
    ...STATIC_FILTERS.map((f) =>
      f.id === 'restock'
        ? { ...f, label: `Restock (${counts.restock})` }
        : f.id === 'repair_queue'
          ? { ...f, label: `Repair queue (${counts.repair})` }
          : f
    ),
    ...ITEM_KINDS.map((k) => ({ id: k, label: `${k[0].toUpperCase()}${k.slice(1)}s` })),
  ];

  const visible = useMemo(() => {
    return rows.filter(
      (r) => itemPassesFilter(r.payload, r.id, filter) && itemMatchesQuery(r.payload, r.id, search)
    );
  }, [rows, filter, search]);

  return (
    <div className="flex flex-col gap-4">
      {/* search + count */}
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
          {visible.length === rows.length
            ? `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`
            : `${visible.length} of ${rows.length}`}
          {rows.length !== grandTotal ? ` · ${grandTotal} total` : ''}
          {flaggedCount ? ` · ${flaggedCount} flagged` : ''}
          {canEdit ? ' · open a row to edit' : ''}
        </span>
      </div>

      {/* filter pills */}
      <div role="tablist" aria-label="Inventory filter" className="flex flex-wrap gap-2">
        {filters.map((f) => {
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

      {/* table */}
      <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-20 pl-4 text-right text-xs tracking-wide text-muted-foreground uppercase">
                Qty
              </TableHead>
              <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">
                Item
              </TableHead>
              <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">
                Kind
              </TableHead>
              <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">
                Case
              </TableHead>
              <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">
                Matrix / SKU
              </TableHead>
              <TableHead className="pr-4 text-right text-xs tracking-wide text-muted-foreground uppercase">
                State
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <div className="m-3 flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-10 text-center">
                    <Box size={20} className="text-muted-foreground" aria-hidden />
                    <p className="text-sm font-medium">No items match</p>
                    <p className="text-xs text-muted-foreground">
                      Adjust the search or filter to see inventory.
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              visible.map((r) => <CatalogRowView key={r.id} row={r} caseLabels={caseLabels} />)
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function CatalogRowView({
  row,
  caseLabels,
}: {
  row: CatalogRow;
  caseLabels: Record<string, string>;
}) {
  const it = row.payload;
  const qty = itemTotalQty(it) || 1;
  const inStorage = itemInStorage(it);
  const cids = itemCaseIds(it);
  const rollup = itemRollupState(it);
  const low = itemIsLowStock(it);
  const oos = itemIsOutOfService(it);
  const serial = itemIsSerial(it);

  const caseCell =
    cids.length === 0
      ? '—'
      : cids.length === 1
        ? caseLabels[cids[0]] || cids[0]
        : `${cids.length} cases`;

  const stateBadge = STATE_BADGE[itemStateTone(rollup)];
  const href = `/catalog/${encodeURIComponent(row.id)}`;
  const router = useRouter();

  // Whole-row navigation for mouse users, while the item name stays a REAL <a> (the keyboard +
  // screen-reader path). A row click that lands on another interactive element (a case link) is
  // ignored so nested links still win. The <tr> stays a real table row for a11y/semantics.
  function onRowClick(e: React.MouseEvent<HTMLTableRowElement>) {
    if ((e.target as HTMLElement).closest('a')) return;
    router.push(href);
  }

  return (
    <TableRow className="cursor-pointer" onClick={onRowClick}>
      <TableCell className="pl-4 text-right font-mono text-xs tabular-nums">
        <span className={cn(qty > 1 ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
          ×{qty}
        </span>
        {inStorage > 0 && (
          <span className="ml-1 text-[10px] text-primary" title={`${inStorage} in storage`}>
            +{inStorage}
          </span>
        )}
      </TableCell>

      <TableCell className="max-w-0">
        <div className="flex items-center gap-2">
          <KindGlyph kind={(it.kind || it.type) as string} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <Link
              href={href}
              className="block truncate font-medium text-foreground underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {it.name || '(unnamed item)'}
            </Link>
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
          </div>
        </div>
      </TableCell>

      <TableCell className="text-muted-foreground capitalize">{it.kind || it.type || '—'}</TableCell>

      <TableCell
        className={cn('max-w-40 truncate', cids.length ? 'text-foreground' : 'text-muted-foreground')}
        title={cids.map((c) => caseLabels[c] || c).join(', ')}
      >
        {caseCell}
      </TableCell>

      <TableCell className="max-w-40 truncate font-mono text-xs text-muted-foreground">
        {it.qr || it.sku || '—'}
      </TableCell>

      <TableCell className="pr-4 text-right">
        <Badge variant={stateBadge.variant} className={cn('tracking-wide', stateBadge.className)}>
          {ITEM_STATE_LABEL[rollup]}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

export default CatalogList;
