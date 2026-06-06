import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Box,
  Zap,
  Layers,
  Briefcase,
  Disc3,
  AlertTriangle,
  Flag,
} from 'lucide-react';
import { requireUser } from '@/lib/auth';
import { can } from '@/lib/rbac';
import { getInventoryItem, getCaseLabels, getEventNames } from '@/lib/inventory';
import { getCases, getInventory, getTags, getUserDisplayName } from '@/lib/data';
import { isCaseRetired } from '@/lib/case-view';
import { itemCode } from '@/lib/eitm';
import { activeTenantHash36 } from '@/lib/settings-store';
import { dataMatrixSvg } from '@/lib/data-matrix';
import { ItemDetailActions } from './item-detail-actions';
import type { ItemDetailsCase, KitCandidateItem } from '@/components/inventory/item-details-modal';
import type { DashTag } from '@/lib/types-dashboard';
import type { PartRefTag } from '@/lib/inventory-shape';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  itemIsSerial,
  itemUnits,
  unitIsDeployed,
  itemTotalQty,
  itemStockTotal,
  itemInStorage,
  itemCaseIds,
  itemEventIds,
  itemQtyLooseAtEvent,
  itemRollupState,
  itemIsLowStock,
  itemIsOutOfService,
  itemStateTone,
  ITEM_STATE_LABEL,
  kindIcon,
  type KindIconName,
  type InventoryPayload,
  type DistributionRow,
} from '@/lib/inventory-shape';

// app/catalog/[id] — the inventory item DETAIL. Server Component: reads the item LIVE on every
// request. Renders BOTH item shapes faithfully — a bulk item's distribution[] rows and a serial
// item's units[] (#22) — plus stock, placements, flags, and the gated inline editor. Token-driven
// shadcn Cards + a dense placement Table.
export const dynamic = 'force-dynamic';

const KIND_ICONS: Record<KindIconName, typeof Box> = {
  box: Box,
  bolt: Zap,
  spool: Disc3,
  layers: Layers,
  case: Briefcase,
};

function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className={cn('text-xl font-semibold tabular-nums', accent && 'text-primary')}>{value}</span>
    </div>
  );
}

const STATE_BADGE = {
  ok: { variant: 'outline' as const, className: 'text-success border-success/50' },
  error: { variant: 'destructive' as const, className: undefined },
  neutral: { variant: 'secondary' as const, className: undefined },
};

export default async function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const doc = await getInventoryItem(id);
  if (!doc) notFound();

  const it: InventoryPayload = doc.payload;
  const [caseLabels, eventNames, allCaseDocs, allInvDocs, tagDocs, actorName] = await Promise.all([
    getCaseLabels(),
    getEventNames(),
    getCases(),
    getInventory(),
    getTags(),
    getUserDisplayName(user.email).catch(() => user.email),
  ]);

  const canEdit = can('db.write.app', user.role);
  // Shared-editor data: live cases (picker), the tag map (chips), kit candidates (#27 part picker),
  // and the server-encoded item Data Matrix for the Print-Matrix tile.
  const caseOptions: ItemDetailsCase[] = allCaseDocs
    .filter((d) => !isCaseRetired(d.payload))
    .map((d) => ({ id: d._id, label: d.payload.label || d.payload.slug || d._id }));
  const tagList: DashTag[] = tagDocs.map((t) => ({
    id: t._id,
    label: t.payload.label || t._id,
    flair: t.payload.customEmoji || '',
    color: t.payload.color ?? null,
  }));
  const tagById = new Map<string, DashTag>(tagList.map((t) => [t.id, t]));
  const partRefTags: PartRefTag[] = tagList.map((t) => ({ id: t.id, label: t.label }));
  const kitCandidates: KitCandidateItem[] = allInvDocs.map((d) => ({
    id: d._id,
    name: d.payload.name,
    sku: d.payload.sku,
    skuOptions: d.payload.skuOptions,
    tagIds: d.payload.tagIds,
  }));
  const matrixCode = itemCode(doc._id, await activeTenantHash36());
  let matrixSvg = '';
  try {
    matrixSvg = matrixCode ? dataMatrixSvg(matrixCode) : '';
  } catch {
    matrixSvg = '';
  }
  const serial = itemIsSerial(it);
  const rollup = itemRollupState(it);
  const deployed = itemTotalQty(it);
  const stock = itemStockTotal(it);
  const inStorage = itemInStorage(it);
  const cids = itemCaseIds(it);
  const eids = itemEventIds(it);
  const low = itemIsLowStock(it);
  const oos = itemIsOutOfService(it);
  const units = itemUnits(it);

  // bulk: only the distribution rows that actually carry a placement (caseId or eventId).
  const distRows: DistributionRow[] = serial
    ? []
    : (it.distribution || []).filter((d) => d.caseId || d.eventId);
  const looseRows = eids
    .map((eid) => ({ eid, qty: itemQtyLooseAtEvent(it, eid) }))
    .filter((r) => r.qty > 0);

  const openFlags = (it.flags || []).filter((f) => f && f.status === 'open');
  const KindGlyph = KIND_ICONS[kindIcon((it.kind || it.type) as string)];
  const stateBadge = STATE_BADGE[itemStateTone(rollup)];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground">
        <Link href="/catalog">
          <ArrowLeft aria-hidden />
          All inventory
        </Link>
      </Button>

      {/* header */}
      <div className="flex items-start gap-3">
        <span className="mt-1 text-muted-foreground">
          <KindGlyph size={24} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{it.name || '(unnamed item)'}</h1>
            <ItemDetailActions
              item={it}
              cases={caseOptions}
              tagById={tagById}
              allTags={partRefTags}
              kitCandidates={kitCandidates}
              matrixSvg={matrixSvg}
              code={matrixCode}
              actorName={actorName}
              canEdit={canEdit}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={stateBadge.variant} className={cn('tracking-wide', stateBadge.className)}>
              {ITEM_STATE_LABEL[rollup]}
            </Badge>
            <Badge variant={serial ? 'default' : 'outline'}>{serial ? 'Serialized' : 'Bulk'}</Badge>
            {(it.kind || it.type) && (
              <span className="text-sm text-muted-foreground capitalize">{it.kind || it.type}</span>
            )}
            {low && (
              <Badge variant="outline" className="gap-1 text-warning border-warning/50">
                <AlertTriangle size={12} aria-hidden />
                Low stock
              </Badge>
            )}
            {oos && (
              <Badge variant="outline" className="text-warning border-warning/50">
                Out of service
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* stats */}
      <Card>
        <CardContent>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Stat label="Deployed" value={deployed} />
            <Stat label="In storage" value={inStorage} accent={inStorage > 0} />
            <Stat label={serial ? 'Total units' : 'Stock total'} value={stock} />
            <Stat label="Cases" value={cids.length} />
            {it.reorderPoint != null && <Stat label="Reorder point" value={it.reorderPoint} />}
          </div>
          {it.storageNotes && (
            <>
              <Separator className="my-4" />
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Storage notes
              </p>
              <p className="mt-1 text-sm text-foreground">{it.storageNotes}</p>
            </>
          )}
        </CardContent>
      </Card>

      {/* identifiers */}
      <Card>
        <CardHeader>
          <CardTitle>Identifiers</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Item ID</dt>
            <dd className="font-mono text-foreground">{doc._id}</dd>
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Data Matrix / QR
            </dt>
            <dd className={cn('font-mono', it.qr ? 'text-foreground' : 'text-muted-foreground')}>
              {it.qr || '—'}
            </dd>
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">SKU</dt>
            <dd className={cn('font-mono', it.sku ? 'text-foreground' : 'text-muted-foreground')}>
              {it.sku || '—'}
            </dd>
            {Array.isArray(it.skuOptions) && it.skuOptions.length > 0 && (
              <>
                <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  SKU options
                </dt>
                <dd className="flex flex-wrap gap-1.5">
                  {it.skuOptions.map((o) => (
                    <Badge key={o.sku} variant="secondary" className="font-mono">
                      {o.sku}
                      {o.label ? ` · ${o.label}` : ''}
                    </Badge>
                  ))}
                </dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* placements — serial units OR bulk distribution */}
      <Card className="pb-0">
        <CardHeader>
          <CardTitle>{serial ? `Units · ${units.length}` : 'Placements'}</CardTitle>
        </CardHeader>
        {serial ? (
          units.length === 0 ? (
            <CardContent className="pb-4">
              <EmptyBlock>No units recorded.</EmptyBlock>
            </CardContent>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4 text-xs tracking-wide text-muted-foreground uppercase">
                    Serial
                  </TableHead>
                  <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">
                    Location
                  </TableHead>
                  <TableHead className="pr-4 text-right text-xs tracking-wide text-muted-foreground uppercase">
                    State
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {units.map((u, i) => {
                  const dep = unitIsDeployed(u);
                  const loc = dep ? caseLabels[u.location as string] || u.location : 'Storage';
                  const uOpen = (u.flags || []).some((f) => f && f.status === 'open');
                  return (
                    <TableRow key={u.id || u.serial || i} className="hover:bg-muted/40">
                      <TableCell className="pl-4 font-mono text-xs text-foreground">
                        {u.serial || '(no serial)'}
                      </TableCell>
                      <TableCell className="text-sm">
                        {dep ? (
                          <Link
                            href={`/cases/${encodeURIComponent(u.location as string)}`}
                            className="text-primary underline-offset-2 hover:underline"
                          >
                            {loc}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">
                            Storage{u.storageNote ? ` · ${u.storageNote}` : ''}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <span className="inline-flex gap-1.5">
                          {u.state && (
                            <Badge variant={u.state === 'packed' ? 'outline' : 'secondary'} className={cn(u.state === 'packed' && 'text-success border-success/50')}>
                              {u.state}
                            </Badge>
                          )}
                          {uOpen && (
                            <Badge variant="destructive" className="gap-1">
                              <Flag size={10} aria-hidden />
                              Flagged
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )
        ) : distRows.length === 0 && looseRows.length === 0 ? (
          <CardContent className="pb-4">
            <EmptyBlock>Unassigned — not in any case or event.</EmptyBlock>
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-20 pl-4 text-right text-xs tracking-wide text-muted-foreground uppercase">
                  Qty
                </TableHead>
                <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">
                  Location
                </TableHead>
                <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">
                  Serials
                </TableHead>
                <TableHead className="pr-4 text-right text-xs tracking-wide text-muted-foreground uppercase">
                  State
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {distRows.map((d, i) => {
                const where = d.caseId
                  ? caseLabels[d.caseId] || d.caseId
                  : d.eventId
                    ? `Loose @ ${eventNames[d.eventId] || d.eventId}`
                    : 'Inventory';
                const href = d.caseId ? `/cases/${encodeURIComponent(d.caseId)}` : null;
                return (
                  <TableRow key={i} className="hover:bg-muted/40">
                    <TableCell className="pl-4 text-right font-mono text-xs tabular-nums text-foreground">
                      ×{d.qty ?? 0}
                    </TableCell>
                    <TableCell className="text-sm">
                      {href ? (
                        <Link href={href} className="text-primary underline-offset-2 hover:underline">
                          {where}
                        </Link>
                      ) : (
                        <span className="text-foreground">{where}</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="max-w-48 truncate font-mono text-xs text-muted-foreground"
                      title={Array.isArray(d.serials) ? d.serials.join(', ') : undefined}
                    >
                      {Array.isArray(d.serials) && d.serials.length > 0 ? d.serials.join(', ') : '—'}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {d.state && (
                        <Badge variant={d.state === 'packed' ? 'outline' : 'secondary'} className={cn(d.state === 'packed' && 'text-success border-success/50')}>
                          {d.state}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {looseRows.map(({ eid, qty }) => (
                <TableRow key={`loose-${eid}`} className="hover:bg-muted/40">
                  <TableCell className="pl-4 text-right font-mono text-xs tabular-nums text-foreground">
                    ×{qty}
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    Loose @ {eventNames[eid] || eid}
                  </TableCell>
                  <TableCell className="text-muted-foreground">—</TableCell>
                  <TableCell />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* open flags */}
      {openFlags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Open flags · {openFlags.length}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              {openFlags.map((f, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Flag size={14} className="mt-0.5 text-destructive" aria-hidden />
                  <div>
                    <div className="flex items-center gap-2">
                      {f.category && <Badge variant="destructive">{f.category}</Badge>}
                      {f.severity && (
                        <span className="text-xs text-muted-foreground">{f.severity}</span>
                      )}
                    </div>
                    {f.note && <p className="mt-1 text-sm text-foreground">{f.note}</p>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Editing is via the shared ItemDetailsModal launched from the header (full tracking / SKU /
          distribution / units / tags / flags / service / kit-BOM editor). Read-only users see why. */}
      {!canEdit ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              You have read-only access. Editing inventory needs the{' '}
              <strong className="text-foreground">Authorized</strong> role or higher.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function EmptyBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
