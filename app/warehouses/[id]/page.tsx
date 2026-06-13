import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  MapPin,
  Phone,
  Mail,
  User,
  Briefcase,
  PackageOpen,
  Boxes,
} from 'lucide-react';
import { requireUser } from '@/lib/auth/auth';
import { can } from '@/lib/auth/rbac';
import { getCases, getEvents, getInventory } from '@/lib/db/data';
import { caseAssignment, caseStatusLabel } from '@/lib/views/case-view';
import { ConfigHeader } from '@/app/config/config-header';
import {
  getWarehouse,
  caseIdsAtWarehouse,
  inventoryItemsAtCases,
  formatWarehouseAddress,
} from '../warehouse-data';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardAction,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// app/warehouses/[id] — the warehouse DETAIL view (Server Component).
//
// LIVE-DB: reads the warehouse + cases + events + inventory straight from Mongo on every request
// (no cache). Mirrors the current app's warehouse config row (index.html ~L14099) for the address
// + per-warehouse contact (#71), then derives — via the case linkage (homeWarehouseId / #66
// currentWarehouseId) — the road cases homed here and the inventory routed into them. The cases
// table reuses lib/case-view (caseAssignment / caseStatusLabel) so a case's owning-event phrasing
// matches the Cases screen exactly (single source of truth).
export const dynamic = 'force-dynamic';

export default async function WarehouseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // requireUser() redirects a signed-out / forged-cookie request to /login before any data is read.
  const [doc, caseDocs, eventDocs, invDocs, user] = await Promise.all([
    getWarehouse(id),
    getCases(),
    getEvents(),
    getInventory(),
    requireUser(),
  ]);
  if (!doc) notFound();

  const w = doc.payload;
  const address = formatWarehouseAddress(w);
  const isHq = w.type === 'hq';

  // Cases homed/located here, then the inventory routed into those cases (transitive — inventory
  // has no warehouse field). Both derived from the live reads via the pure helpers.
  const caseIds = caseIdsAtWarehouse(id, caseDocs);
  const homedCases = caseDocs.filter((c) => caseIds.has(c._id));
  const items = inventoryItemsAtCases(caseIds, invDocs);

  const eventsForAssign = eventDocs.map((e) => ({ _id: e._id, payload: e.payload }));

  // Total units across the homed inventory (bulk: stockTotal/qty; serial: unit count) — a coarse
  // "how much is here" figure mirroring the catalog's per-item total.
  const totalUnits = items.reduce((sum, doc) => {
    const p = doc.payload as { stockTotal?: number; qty?: number; units?: unknown[] };
    if (Array.isArray(p.units) && p.units.length) return sum + p.units.length;
    const n = Number(p.stockTotal ?? p.qty ?? 0);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);

  return (
    <div className="space-y-6 px-6 py-6">
      {/* Admins stay in the Config chrome (Config → Warehouses → this warehouse). */}
      {can('admin.console', user.role) ? <ConfigHeader adminEmail={user.email} /> : null}
      {/* Back link */}
      <Link
        href="/warehouses"
        className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden />
        All warehouses
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {isHq ? 'Headquarters' : 'Sub-warehouse'} · Return address
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{w.name || 'Warehouse'}</h1>
            <Badge variant={isHq ? 'default' : 'secondary'} className="font-mono">
              {isHq ? 'HQ' : 'SUB'}
            </Badge>
          </div>
          {address && <p className="text-sm text-muted-foreground">{address}</p>}
        </div>
      </div>

      {/* Address + contact */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Address</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {w.street && (
              <p className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  {w.street}
                  <br />
                  {[w.city, w.region].filter(Boolean).join(', ')}
                  {w.postal ? ` ${w.postal}` : ''}
                  {w.country ? <span className="text-muted-foreground"> · {w.country}</span> : null}
                </span>
              </p>
            )}
            {!w.street && (
              <p className="text-muted-foreground">No street address recorded for this warehouse.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Primary contact</CardTitle>
            <CardAction className="text-xs text-muted-foreground">
              Printed on shipping labels
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {w.contactName || w.phone || w.contactEmail ? (
              <>
                {w.contactName && (
                  <p className="flex items-center gap-2">
                    <User className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{w.contactName}</span>
                    {w.contactRole ? (
                      <span className="text-muted-foreground">· {w.contactRole}</span>
                    ) : null}
                  </p>
                )}
                {w.phone && (
                  <p className="flex items-center gap-2">
                    <Phone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <a href={`tel:${w.phone}`} className="hover:text-foreground hover:underline">
                      {w.phone}
                    </a>
                  </p>
                )}
                {w.contactEmail && (
                  <p className="flex items-center gap-2">
                    <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <a
                      href={`mailto:${w.contactEmail}`}
                      className="break-all hover:text-foreground hover:underline"
                    >
                      {w.contactEmail}
                    </a>
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">
                No per-warehouse contact set — labels fall back to the global emergency contact.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cases homed here */}
      <Card>
        <CardHeader>
          <CardTitle>Cases homed here</CardTitle>
          <CardAction className="text-xs text-muted-foreground">
            {homedCases.length} {homedCases.length === 1 ? 'case' : 'cases'}
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          {homedCases.length === 0 ? (
            <div className="mx-4 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
              <Briefcase className="size-6 text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">No road cases home at this warehouse.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Case</TableHead>
                  <TableHead className="hidden sm:table-cell">Size · Zone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {homedCases.map((cdoc) => {
                  const c = cdoc.payload;
                  const assignment = caseAssignment(cdoc._id, eventsForAssign);
                  const owning = assignment?.event ?? null;
                  const sizeZone = [c.size ? String(c.size).toUpperCase() : 'CASE', c.zone]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <TableRow key={cdoc._id} className="hover:bg-muted/50">
                      <TableCell className="max-w-0 pl-4">
                        <Link
                          href={`/cases/${encodeURIComponent(cdoc._id)}`}
                          className="group/link flex items-center gap-2 outline-none"
                        >
                          <Briefcase className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="truncate font-medium text-foreground group-focus-visible/link:underline group-hover/link:underline">
                            {c.label || cdoc._id}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{sizeZone}</TableCell>
                      <TableCell className="text-sm">
                        {owning ? (
                          <span className="flex items-center gap-2">
                            <StatusBadge state={owning.state} />
                            <span className="truncate text-muted-foreground">
                              {caseStatusLabel(owning)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">In storage</span>
                        )}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Inventory at this warehouse (derived through the homed cases) */}
      <Card>
        <CardHeader>
          <CardTitle>Inventory here</CardTitle>
          <CardAction className="text-xs text-muted-foreground">
            {items.length} {items.length === 1 ? 'item' : 'items'}
            {totalUnits > 0 ? ` · ${totalUnits} units` : ''}
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          {items.length === 0 ? (
            <div className="mx-4 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
              <PackageOpen className="size-6 text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">
                {homedCases.length === 0
                  ? 'No inventory — nothing is cased here yet.'
                  : 'No inventory is currently routed into the cases at this warehouse.'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Item</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="font-mono">SKU</TableHead>
                  <TableHead className="pr-4 text-right">Stock</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((idoc) => {
                  const p = idoc.payload as {
                    name?: string;
                    kind?: string;
                    type?: string;
                    sku?: string;
                    qr?: string;
                    stockTotal?: number;
                    qty?: number;
                    units?: unknown[];
                  };
                  const stock = Array.isArray(p.units) && p.units.length
                    ? p.units.length
                    : Number(p.stockTotal ?? p.qty ?? 0) || 0;
                  return (
                    <TableRow key={idoc._id} className="hover:bg-muted/50">
                      <TableCell className="max-w-0 pl-4">
                        <Link
                          href={`/catalog/${encodeURIComponent(idoc._id)}`}
                          className="group/link flex items-center gap-2 outline-none"
                        >
                          <Boxes className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="truncate font-medium text-foreground group-focus-visible/link:underline group-hover/link:underline">
                            {p.name || '(unnamed item)'}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground capitalize">
                        {p.kind || p.type || '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {p.qr || p.sku || '—'}
                      </TableCell>
                      <TableCell className="pr-4 text-right font-mono text-sm tabular-nums">
                        {stock}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
