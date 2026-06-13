'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Search, Warehouse, MapPin, Phone, User, Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { WarehouseForm, type WarehouseEditValues } from './warehouse-form';
import { deleteWarehouseAction } from './actions';

// warehouses-list.tsx — the interactive Warehouses list + management (add / edit / delete). Live
// search + type filter over the server-read rows (the address + per-warehouse case count are
// pre-computed server-side, single source of truth). Gated write actions (canManage = pallets.edit /
// authorized+): an "Add warehouse" header button + per-row Edit / Delete, all through the
// WarehouseForm modal + deleteWarehouseAction. A faithful port of the Python WarehousesPanel.

export interface WarehouseRow {
  id: string;
  name: string;
  type: 'hq' | 'sub';
  street: string;
  city: string;
  region: string;
  postal: string;
  country: string;
  address: string;
  contactName: string;
  contactRole: string;
  contactEmail: string;
  phone: string;
  caseCount: number;
}

type FilterId = 'all' | 'hq' | 'sub';

export function WarehousesList({
  rows,
  canManage,
  placesAvailable,
}: {
  rows: WarehouseRow[];
  canManage: boolean;
  placesAvailable: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterId>('all');
  const [formFor, setFormFor] = useState<WarehouseEditValues | 'new' | null>(null);
  const [deleteFor, setDeleteFor] = useState<WarehouseRow | null>(null);
  const [pending, startTransition] = useTransition();

  const counts = useMemo(() => {
    let hq = 0;
    let sub = 0;
    for (const r of rows) {
      if (r.type === 'hq') hq++;
      else sub++;
    }
    return { all: rows.length, hq, sub };
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== 'all' && r.type !== filter) return false;
      if (!q) return true;
      const hay = [r.name, r.city, r.region, r.address, r.contactName, r.contactRole, r.contactEmail]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, filter, query]);

  const toEditValues = (r: WarehouseRow): WarehouseEditValues => ({
    id: r.id,
    name: r.name,
    type: r.type,
    street: r.street,
    city: r.city,
    region: r.region,
    postal: r.postal,
    country: r.country,
    phone: r.phone,
    contactName: r.contactName,
    contactRole: r.contactRole,
    contactEmail: r.contactEmail,
    lat: null,
    lng: null,
  });

  function confirmDelete() {
    if (!deleteFor) return;
    const id = deleteFor.id;
    startTransition(async () => {
      const res = await deleteWarehouseAction(id);
      if (res.error || !res.ok) {
        toast.error(res.error || 'Could not delete the warehouse.');
        return;
      }
      toast.success('Warehouse deleted.');
      setDeleteFor(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as FilterId)}>
          <TabsList>
            <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
            <TabsTrigger value="hq">HQ ({counts.hq})</TabsTrigger>
            <TabsTrigger value="sub">Sub ({counts.sub})</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, city, contact…"
              aria-label="Search warehouses"
              className="pl-8"
            />
          </div>
          {canManage ? (
            <Button size="sm" onClick={() => setFormFor('new')}>
              <Plus size={14} aria-hidden />
              <span className="hidden sm:inline">Add warehouse</span>
            </Button>
          ) : null}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
          <Warehouse className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">No warehouses match</p>
          <p className="text-xs text-muted-foreground">
            {rows.length === 0
              ? 'No warehouses configured yet. Add at least one HQ — every case uses it as the default return address.'
              : 'Adjust the search or filter to see return-address locations.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-card hover:bg-card">
                <TableHead>Warehouse</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="hidden md:table-cell">Contact</TableHead>
                <TableHead className="text-right">Cases</TableHead>
                {canManage ? <TableHead className="w-20 text-right" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => (
                <WarehouseRowView
                  key={r.id}
                  row={r}
                  canManage={canManage}
                  onEdit={() => setFormFor(toEditValues(r))}
                  onDelete={() => setDeleteFor(r)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Add / Edit form modal. */}
      {formFor ? (
        <WarehouseForm
          initial={formFor === 'new' ? undefined : formFor}
          placesAvailable={placesAvailable}
          open
          onOpenChange={(o) => !o && setFormFor(null)}
          onSaved={() => {
            setFormFor(null);
            router.refresh();
          }}
        />
      ) : null}

      {/* Delete confirm. */}
      <Dialog open={!!deleteFor} onOpenChange={(o) => !o && setDeleteFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete warehouse</DialogTitle>
            <DialogDescription>
              Delete <strong className="text-foreground">{deleteFor?.name || 'this warehouse'}</strong>? Cases pointing
              at it fall back to HQ on their next print. This soft-deletes the record; the tombstone replicates to peers.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteFor(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Delete warehouse
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WarehouseRowView({
  row: r,
  canManage,
  onEdit,
  onDelete,
}: {
  row: WarehouseRow;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const cityRegion = [r.city, r.region].filter(Boolean).join(', ');
  return (
    <TableRow>
      <TableCell className="max-w-0">
        <Link
          href={`/warehouses/${encodeURIComponent(r.id)}`}
          className="group/link flex items-center gap-3 outline-none"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Warehouse className="size-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium text-foreground group-focus-visible/link:underline group-hover/link:underline">
                {r.name}
              </span>
              <Badge variant={r.type === 'hq' ? 'default' : 'secondary'} className="font-mono text-[10px]">
                {r.type === 'hq' ? 'HQ' : 'SUB'}
              </Badge>
            </span>
            {r.address && <span className="block truncate text-xs text-muted-foreground">{r.address}</span>}
          </span>
        </Link>
      </TableCell>

      <TableCell className="text-sm">
        {cityRegion ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            {cityRegion}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>

      <TableCell className="hidden text-sm md:table-cell">
        {r.contactName || r.phone ? (
          <span className="min-w-0">
            {r.contactName && (
              <span className="flex items-center gap-1.5 truncate text-foreground">
                <User className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                {r.contactName}
                {r.contactRole ? <span className="text-muted-foreground">· {r.contactRole}</span> : null}
              </span>
            )}
            {r.phone && (
              <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                <Phone className="size-3 shrink-0" aria-hidden />
                {r.phone}
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>

      <TableCell className="text-right">
        <span
          className="font-mono text-sm tabular-nums text-muted-foreground"
          title="Road cases homed at / currently located at this warehouse"
        >
          {r.caseCount}
        </span>
      </TableCell>

      {canManage ? (
        <TableCell className="text-right">
          <span className="inline-flex gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${r.name}`} onClick={onEdit}>
              <Pencil size={13} className="text-muted-foreground" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${r.name}`} onClick={onDelete}>
              <Trash2 size={13} className="text-destructive" aria-hidden />
            </Button>
          </span>
        </TableCell>
      ) : null}
    </TableRow>
  );
}

export default WarehousesList;
