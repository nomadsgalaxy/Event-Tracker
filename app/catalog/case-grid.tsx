'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Briefcase,
  TriangleAlert,
  Weight as WeightIcon,
  Truck,
  MapPin,
  PackageCheck,
  MoreHorizontal,
  Pencil,
  Trash2,
  Printer,
  QrCode,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Eyebrow } from '@/components/ui/eyebrow';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatWeight } from '@/lib/weight';
import type { CatalogCaseRow, CatalogCardExtras } from './catalog-screen';
import type { WarehouseLite } from '@/app/cases/case-editor';
import { CaseEditorDialog } from '@/app/cases/case-editor';
import { RetireCaseModal } from '@/app/cases/retire-case-modal';
import { CaseManifestPrint } from '@/app/cases/case-manifest-print';
import { CaseMatrixModal } from '@/app/cases/case-matrix-modal';

// case-grid.tsx — the Roadcases CARD GRID. A responsive auto-fill grid of road-case tiles: a kind
// icon + SIZE badge, the case name (+ slug/zone subline), kit + loaded-weight (in the user's unit,
// #11), the #66 location chip + double-booked badge, a packed/total ProgressBar, an assignment chip,
// and a Committed/Available/Retired state pill. Retired cases get amber bordered/dimmed styling. The
// tile body is a clickable link to /cases/:id; the inline Edit/Delete/Print action menu is a SIBLING
// (never nested inside the link — no nested interactive elements). Each card prints its OWN internal
// manifest (off-screen block) on demand.

const SIZE_LABEL: Record<string, string> = { small: 'S', medium: 'M', large: 'L', xl: 'XL' };

function sizeBadge(size: string): string {
  if (!size) return 'CASE';
  return SIZE_LABEL[size] ?? size.toUpperCase();
}

function assignmentIcon(state: string | null): typeof Truck {
  switch (state) {
    case 'in_transit':
    case 'returning':
      return Truck;
    case 'onsite':
      return MapPin;
    default:
      return PackageCheck;
  }
}

export function CaseGrid({
  rows,
  extras,
  totalCount,
  canEdit,
  weightUnit,
  warehouses,
  onShowAll,
}: {
  rows: CatalogCaseRow[];
  extras: Record<string, CatalogCardExtras>;
  totalCount: number;
  canEdit: boolean;
  weightUnit: 'kg' | 'lbs';
  warehouses: WarehouseLite[];
  /** Shown in the empty state to reset a narrowing filter ("Show all warehouses"). */
  onShowAll?: () => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-12 text-center">
        <Briefcase className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">No cases match</p>
        <p className="text-xs text-muted-foreground">
          {totalCount === 0
            ? 'Nothing in the cases collection yet.'
            : 'Adjust the warehouse or filter to see road cases.'}
        </p>
        {onShowAll ? (
          <Button variant="link" size="sm" onClick={onShowAll} className="mt-1 h-auto p-0">
            Show all warehouses
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Road cases">
      {rows.map((r) => (
        <CaseCard
          key={r.id}
          row={r}
          extras={extras[r.id]}
          canEdit={canEdit}
          weightUnit={weightUnit}
          warehouses={warehouses}
        />
      ))}
    </ul>
  );
}

function CaseCard({
  row: r,
  extras,
  canEdit,
  weightUnit,
  warehouses,
}: {
  row: CatalogCaseRow;
  extras?: CatalogCardExtras;
  canEdit: boolean;
  weightUnit: 'kg' | 'lbs';
  warehouses: WarehouseLite[];
}) {
  const router = useRouter();
  const assigned = r.status === 'assigned';
  const AssignIcon = assignmentIcon(r.eventState);
  const [editOpen, setEditOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);
  // The internal-manifest print block uses a SHARED dom id (#eit-case-manifest-print), so it must be
  // mounted only for the ONE card being printed (else multiple blocks collide). We mount it on demand,
  // print once the block is in the DOM, then unmount on afterprint.
  const [printingManifest, setPrintingManifest] = useState(false);

  useEffect(() => {
    if (!printingManifest) return;
    document.body.setAttribute('data-print', 'case-manifest');
    const restore = () => {
      document.body.removeAttribute('data-print');
      setPrintingManifest(false);
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    // Defer to ensure the block is painted before the print dialog opens.
    const t = window.setTimeout(() => window.print(), 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('afterprint', restore);
      document.body.removeAttribute('data-print');
    };
  }, [printingManifest]);

  return (
    <li className="relative">
      {/* The whole tile is a clickable link. The action menu is a SIBLING positioned over the top-
          right corner (NOT inside the link) so there's no nested interactive element. */}
      <Link
        href={`/cases/${encodeURIComponent(r.id)}`}
        className={cn(
          'group/case flex h-full flex-col gap-3 rounded-lg border bg-card p-4 transition-colors',
          'hover:border-primary/40 hover:bg-accent',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          r.retired ? 'border-[color:var(--warning)]/60 bg-[color:var(--warning)]/5 opacity-80' : 'border-border'
        )}
      >
        {/* Identity row */}
        <div className="flex items-start gap-3">
          <span className="relative grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Briefcase className="size-5" aria-hidden />
            <span
              className="absolute -right-1.5 -bottom-1.5 rounded bg-background px-1 font-mono text-[10px] font-semibold text-foreground ring-1 ring-border"
              aria-hidden
            >
              {sizeBadge(r.size)}
            </span>
          </span>

          <div className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium text-foreground group-hover/case:underline">{r.label}</span>
              {r.flagged > 0 ? (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 text-xs"
                  style={{ color: 'var(--warning)' }}
                  title={`${r.flagged} flagged`}
                >
                  <TriangleAlert className="size-3" aria-hidden />
                  {r.flagged}
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {sizeBadge(r.size) === 'CASE' ? 'Case' : `Size ${sizeBadge(r.size)}`}
              {r.zone ? ` · ${r.zone}` : ''}
              {r.slug ? ` · ${r.slug}` : ''}
            </span>
          </div>

          {/* State pill (keeps a slot for the corner menu via pr). */}
          <span className={cn('shrink-0', canEdit && 'pr-7')}>
            {r.retired ? (
              <Badge variant="secondary">Retired</Badge>
            ) : assigned ? (
              <Badge variant="default" className="font-medium">
                Committed
              </Badge>
            ) : (
              <Badge variant="outline">Available</Badge>
            )}
          </span>
        </div>

        {/* Location + double-booked. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            {r.inTransit ? <Truck className="size-3.5" aria-hidden /> : <MapPin className="size-3.5" aria-hidden />}
            <span className="truncate">{r.locationLabel}</span>
          </span>
          {r.conflictCount >= 2 ? (
            <span
              className="inline-flex items-center gap-1 rounded px-1 py-0.5"
              style={{ color: 'var(--destructive)', border: '1px solid var(--destructive)' }}
              title={`Double-booked across ${r.conflictCount} events: ${r.conflictNames.join(', ')}`}
            >
              <TriangleAlert className="size-3" aria-hidden />
              Double-booked
            </span>
          ) : null}
        </div>

        {/* Kit + loaded weight (in the user's unit). */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {r.kitFor.length > 0 ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <span className="text-muted-foreground/70">Kit</span>
              <span className="truncate font-mono text-foreground">{r.kitFor.join(', ')}</span>
            </span>
          ) : (
            <span className="text-muted-foreground/70">Shared (no kit)</span>
          )}
          {r.loadedKg > 0 ? (
            <span
              className="inline-flex items-center gap-1"
              title={`Loaded ${formatWeight(r.loadedKg, weightUnit)} = case ${formatWeight(r.weight ?? 0, weightUnit)} + contents`}
            >
              <WeightIcon className="size-3.5" aria-hidden />
              <span className="font-mono tabular-nums">{formatWeight(r.loadedKg, weightUnit)}</span>
            </span>
          ) : r.weight != null ? (
            <span className="inline-flex items-center gap-1">
              <WeightIcon className="size-3.5" aria-hidden />
              <span className="font-mono tabular-nums">{formatWeight(r.weight, weightUnit)}</span>
            </span>
          ) : null}
        </div>

        {/* Packed/total progress. */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs">
            <Eyebrow>Packed</Eyebrow>
            <span className="font-mono tabular-nums text-muted-foreground">
              {r.packed}/{r.total}
            </span>
          </div>
          <ProgressBar
            value={r.packed}
            total={r.total}
            size="sm"
            label={`Packed ${r.packed} of ${r.total} units`}
            fillColor={r.flagged > 0 ? 'var(--warning)' : undefined}
          />
        </div>

        {/* Assignment chip. */}
        <div className="mt-auto flex items-center gap-2 border-t border-border pt-3">
          {r.eventState ? (
            <>
              <AssignIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{r.statusLabel}</span>
              <StatusBadge state={r.eventState} className="shrink-0" />
            </>
          ) : (
            <>
              <Briefcase className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="text-xs text-muted-foreground">In storage</span>
            </>
          )}
        </div>
      </Link>

      {/* Inline action menu — a SIBLING over the top-right corner (no nested interactive). */}
      {canEdit ? (
        <div className="absolute top-3 right-3 z-10">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 bg-card/80" aria-label={`Actions for ${r.label}`}>
                <MoreHorizontal size={16} aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!r.retired ? (
                <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                  <Pencil size={14} aria-hidden /> Edit case
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => setPrintingManifest(true)}>
                <Printer size={14} aria-hidden /> Print manifest
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setMatrixOpen(true)}>
                <QrCode size={14} aria-hidden /> Print Matrix
              </DropdownMenuItem>
              {!r.retired && extras ? (
                <DropdownMenuItem onSelect={() => setRetireOpen(true)} variant="destructive">
                  <Trash2 size={14} aria-hidden /> Delete / Retire
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      {/* Per-card modals + the off-screen manifest print block. */}
      {canEdit && extras ? (
        <>
          <CaseEditorDialog
            id={r.id}
            payload={r.payload}
            weightUnit={weightUnit}
            warehouses={warehouses}
            locationLabel={r.locationLabel}
            inTransit={r.inTransit}
            classification={extras.classification}
            open={editOpen}
            onOpenChange={setEditOpen}
          />
          <RetireCaseModal
            caseId={r.id}
            caseLabel={r.label}
            classification={extras.classification}
            open={retireOpen}
            onOpenChange={setRetireOpen}
            onDone={() => router.refresh()}
          />
        </>
      ) : null}
      {extras ? (
        <CaseMatrixModal
          caseLabel={r.label}
          caseSlug={r.slug}
          code={extras.code}
          matrixSvg={extras.matrixSvg}
          extras={extras.returnContact}
          open={matrixOpen}
          onOpenChange={setMatrixOpen}
        />
      ) : null}
      {/* Internal-manifest print block — mounted only for the card actively printing (shared id). */}
      {printingManifest && extras ? (
        <CaseManifestPrint snapshot={extras.snapshot} matrixSvg={extras.matrixSvg} />
      ) : null}
    </li>
  );
}

export default CaseGrid;
