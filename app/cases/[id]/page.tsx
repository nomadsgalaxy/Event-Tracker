import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  TriangleAlert,
  Weight as WeightIcon,
  Truck,
  MapPin,
  ScanLine,
} from 'lucide-react';
import { getCase, getEvents, getInventory, getTags, getUserWeightUnit, type TagDoc } from '@/lib/db/data';
import { getInventory as getInventoryDocs, getCaseLabels } from '@/lib/views/inventory';
import { getWarehouses, getEmergencyContact, caseReturnAndContact } from '@/app/warehouses/warehouse-data';
import { requireUser } from '@/lib/auth/auth';
import { can } from '@/lib/auth/rbac';
import {
  buildCaseManifest,
  buildCaseManifestSnapshot,
  caseAssignment,
  caseStatusLabel,
  caseLocationLabel,
  caseEffectiveTransit,
  caseInTransit,
  getCaseScheduleConflicts,
  classifyCaseDelete,
  isCaseRetired,
} from '@/lib/views/case-view';
import { itemCaseIds } from '@/lib/views/inventory-shape';
import type { DashTag } from '@/lib/types/types-dashboard';
import { formatWeight, caseLoadedWeightKg, caseContentsWeightKg } from '@/lib/util/weight';
import { caseCode, itemCode } from '@/lib/integrations/eitm';
import { activeTenantHash36 } from '@/lib/auth/settings-store';
import { dataMatrixSvg } from '@/lib/integrations/data-matrix';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardAction,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { DataMatrix } from '@/components/ui/data-matrix';
import { CaseEditButton, type WarehouseLite } from '../case-editor';
import { CaseContents, type CaseContentItem } from './case-contents';
import { CaseManifestPrint, CaseManifestPrintButton } from '../case-manifest-print';
import { PrintMatrixButton } from '../case-matrix-modal';

// app/cases/[id] — the case DETAIL view (Server Component). LIVE-DB: reads the case + events +
// inventory + warehouses + tags from Mongo on every request. Mirrors the Python CaseDetail
// (index.html ~L14230): the owning-event assignment card, the editable contents/manifest (lib/
// case-view cross-join), the retired banner, the legacy-slug line, the #66 location chip, the
// double-booked badge (getCaseScheduleConflicts), the loaded-weight breakdown (#12), the case's own
// Data Matrix tile (+ Print Matrix), the internal manifest print, and "Pack this case". Every
// edit/print affordance is gated on the live role server-side.
export const dynamic = 'force-dynamic';

function toDashTag(doc: TagDoc): DashTag {
  const p = doc.payload ?? {};
  let flair = typeof p.customEmoji === 'string' ? p.customEmoji : '';
  if (!flair && p.flair === 'flag-us') flair = '🇺🇸';
  if (!flair && p.flair === 'flag-cz') flair = '🇨🇿';
  return {
    id: doc._id,
    label: typeof p.label === 'string' ? p.label : '',
    flair,
    color: typeof p.color === 'string' && p.color ? p.color : null,
  };
}

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [doc, eventDocs, invDocs, invFullDocs, warehouseDocs, fleetEmergency, tagDocs, allCaseLabels, user] = await Promise.all([
    getCase(id),
    getEvents(),
    getInventory(),
    getInventoryDocs(),
    getWarehouses(),
    getEmergencyContact(),
    getTags(),
    getCaseLabels(),
    requireUser(),
  ]);
  if (!doc) notFound();

  const c = doc.payload;
  const canEdit = can('pallets.edit', user.role);
  const weightUnit = await getUserWeightUnit(user.email);

  const inventory = invDocs.map((d) => d.payload);
  const eventsForView = eventDocs.map((e) => ({ _id: e._id, payload: e.payload }));
  const assignment = caseAssignment(id, eventsForView);
  const owning = assignment?.event ?? null;
  const manifest = buildCaseManifest(id, inventory);
  const retired = isCaseRetired(c);

  // Warehouse name map + the #66 location label.
  const warehouseNameById: Record<string, string> = {};
  for (const w of warehouseDocs) warehouseNameById[w._id] = w.payload.name || w._id;
  const locationLabel = caseLocationLabel(c, eventsForView, warehouseNameById);
  const eff = caseEffectiveTransit(c, eventsForView);
  const inTransit = caseInTransit(c);
  const transitToName = c.transit?.toWarehouseId ? warehouseNameById[c.transit.toWarehouseId] : '';

  // Double-booked (committed to ≥2 overlapping events).
  const conflicts = getCaseScheduleConflicts(id, eventsForView);
  const doubleBooked = conflicts.length >= 2;

  // FK classification for the Delete/Retire footer.
  const classification = classifyCaseDelete(id, eventsForView, inventory);

  // Loaded weight (#12): tare + packed contents.
  const tareKg = c.weight === '' || c.weight == null ? null : Number(c.weight);
  const contentsKg = caseContentsWeightKg(id, inventory);
  const loadedKg = caseLoadedWeightKg({ id, weight: c.weight }, inventory);

  // Tag directory for the contents chips (hidden tags excluded).
  const tagById = new Map<string, DashTag>();
  for (const d of tagDocs) {
    if (d.payload?.hidden) continue;
    tagById.set(d._id, toDashTag(d));
  }

  // The in-case items (full payloads for the editing modals) + their server-encoded Data Matrices.
  const tenant = await activeTenantHash36();
  const safeMatrix = (payload: string): string => {
    if (!payload) return '';
    try {
      return dataMatrixSvg(payload);
    } catch {
      return '';
    }
  };
  const inCaseDocs = invFullDocs.filter((d) => !d.deletedAt && itemCaseIds(d.payload).includes(id));
  const contentItems: CaseContentItem[] = inCaseDocs.map((d) => ({
    id: d._id,
    payload: d.payload,
    matrixSvg: safeMatrix(itemCode(d._id, tenant)),
  }));
  // The Add-item picker needs every non-deleted item (lean {id, payload}).
  const pickerItems = invFullDocs.filter((d) => !d.deletedAt).map((d) => ({ id: d._id, payload: d.payload }));

  // Case label map for the ItemDetailsModal case picker (all live cases, so an item can be moved to
  // any case from the editor — matching the Python picker).
  const caseLabels = allCaseLabels;

  // The case's own Data Matrix payload + server-encoded SVG (for the Print Matrix modal).
  const code = caseCode(id, tenant);
  const caseMatrixSvg = safeMatrix(code);
  // 4×6 shipping-label extras (Return-to + If-found) — case-static, same data as the Manifest labels.
  const matrixExtras = caseReturnAndContact(c, warehouseDocs, fleetEmergency);

  // The internal-manifest snapshot (the packing list).
  const snapshot = buildCaseManifestSnapshot(c, inventory, eventsForView, warehouseNameById);

  const warehousesLite: WarehouseLite[] = warehouseDocs.map((w) => ({
    id: w._id,
    name: w.payload.name || w._id,
    type: w.payload.type === 'hq' ? 'hq' : 'sub',
  }));

  const sizeLabel = c.size ? String(c.size).toUpperCase() : 'CASE';
  const kitFor = Array.isArray(c.kitFor) ? c.kitFor.filter(Boolean) : [];
  const slug = c.slug && c.slug !== id ? c.slug : '';

  return (
    <div className="space-y-6 px-6 py-6">
      {/* Back link → the owning event if assigned, else the catalog. */}
      <Link
        href={assignment ? `/event/${assignment.eventId}` : '/catalog'}
        className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden />
        {owning ? owning.name || 'Event' : 'All cases'}
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Road case · {sizeLabel}
            {c.zone ? ` · ${c.zone}` : ''}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{c.label || slug || id}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            {slug && <span className="font-mono">{slug}</span>}
            {/* #66 location chip */}
            <span className="inline-flex items-center gap-1">
              {inTransit || eff?.kind === 'event' ? (
                <Truck className="size-3.5" aria-hidden />
              ) : (
                <MapPin className="size-3.5" aria-hidden />
              )}
              {locationLabel}
            </span>
            {/* #12 loaded weight + breakdown tooltip */}
            {loadedKg > 0 && (
              <span
                title={`Loaded ${formatWeight(loadedKg, weightUnit)} = case ${formatWeight(tareKg ?? 0, weightUnit)} + contents ${formatWeight(contentsKg, weightUnit)}`}
                className="inline-flex items-center gap-1"
              >
                <WeightIcon className="size-3.5" aria-hidden />
                <span className="font-mono tabular-nums">{formatWeight(loadedKg, weightUnit)}</span> loaded
              </span>
            )}
            <span>
              Contents:{' '}
              <span className="font-mono tabular-nums">
                {manifest.scanned} / {manifest.total}
              </span>
            </span>
            {manifest.flagged > 0 && (
              <span className="inline-flex items-center gap-1" style={{ color: 'var(--warning)' }}>
                <TriangleAlert className="size-3.5" aria-hidden />
                {manifest.flagged} flagged
              </span>
            )}
            {doubleBooked && (
              <span
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5"
                style={{ color: 'var(--destructive)', border: '1px solid var(--destructive)' }}
                title={`Double-booked across ${conflicts.length} events: ${conflicts.map((x) => `${x.name} (${x.start})`).join(', ')}`}
              >
                <TriangleAlert className="size-3.5" aria-hidden />
                Double-booked ({conflicts.length})
              </span>
            )}
          </div>
        </div>
        {/* The QR + action buttons. On mobile the actions' max-content (~480px) made this shrink-0
            column overflow the page; let it span the row and left-align below the title instead. */}
        <div className="flex w-full shrink-0 flex-col items-start gap-3 sm:w-auto sm:items-end">
          <DataMatrix
            kind="c"
            id={id}
            size={104}
            label={`Data Matrix code for case ${c.label || slug || id}`}
          />
          <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
            {/* Pack this case */}
            <Button asChild variant="outline" size="sm">
              <Link href={`/scan/pack/${encodeURIComponent(id)}`}>
                <ScanLine size={14} aria-hidden />
                Pack this case
              </Link>
            </Button>
            <PrintMatrixButton caseLabel={c.label || slug || id} caseSlug={slug} code={code} matrixSvg={caseMatrixSvg} extras={matrixExtras} />
            <CaseManifestPrintButton />
            {canEdit && !retired && (
              <CaseEditButton
                id={id}
                payload={c}
                weightUnit={weightUnit}
                warehouses={warehousesLite}
                locationLabel={locationLabel}
                inTransit={inTransit}
                transitToName={transitToName || undefined}
                effectiveTransit={eff}
                classification={classification}
              />
            )}
          </div>
        </div>
      </div>

      {/* Retired banner */}
      {retired && (
        <Alert>
          <TriangleAlert className="size-4" style={{ color: 'var(--warning)' }} aria-hidden />
          <AlertTitle>Retired</AlertTitle>
          <AlertDescription>{c.retiredReason || '(no reason recorded)'}</AlertDescription>
        </Alert>
      )}

      {/* Assignment */}
      <Card>
        <CardHeader>
          <CardTitle>Assignment</CardTitle>
        </CardHeader>
        <CardContent>
          {owning ? (
            <Link
              href={`/event/${assignment!.eventId}`}
              className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
            >
              <StatusBadge state={owning.state} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {caseStatusLabel(owning)}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[owning.startDate, owning.city].filter(Boolean).join(' · ') || '—'}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not assigned to any event yet — in storage.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Kit-for */}
      {kitFor.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Kits for</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            {kitFor.map((sku) => (
              <Badge key={sku} variant="secondary" className="font-mono">
                {sku}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Contents / manifest — editable */}
      <Card>
        <CardHeader>
          <CardTitle>Contents</CardTitle>
          <CardAction className="text-xs text-muted-foreground">
            {manifest.rows.length} {manifest.rows.length === 1 ? 'line' : 'lines'} · {manifest.total} units
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          <CaseContents
            caseId={id}
            items={contentItems}
            pickerItems={pickerItems}
            caseLabel={c.label || slug || id}
            caseLabels={caseLabels}
            tagById={tagById}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>

      {/* Off-screen print block (the internal packing list). */}
      <CaseManifestPrint snapshot={snapshot} matrixSvg={caseMatrixSvg} />
    </div>
  );
}
