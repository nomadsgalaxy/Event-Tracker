'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  CheckCircle2,
  CircleDashed,
  PackageCheck,
  TriangleAlert,
  Loader2,
  ClipboardCheck,
  ListFilter,
  Truck,
  Layers,
  Box as BoxIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SidebarRail, SidebarSection } from '@/components/ui/sidebar-rail';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusBadge } from '@/components/ui/status-badge';
import { Eyebrow } from '@/components/ui/eyebrow';
import { ManifestCaseCard, type ManifestRowActions } from '../manifest/manifest-case-card';
import { ItemDetailsModal } from '@/components/inventory/item-details-modal';
import { FlagItemModal, ResolveFlagModal } from '@/components/inventory/flag-modals';
import { itemOpenFlag, type ItemFlag } from '@/lib/inventory-shape';
import type { ManifestSnapshot } from '@/lib/types';
import type { SignoffDetailSeed } from './page';
import type {
  SignoffVariant,
  SignoffEventRow,
  SignoffCaseGroup,
  SignoffReturnRow,
} from './signoff-types';
import { PrintSignoffButton, PrintSignoffManifest } from './print-signoff-manifest';
import {
  setCaseSignoffAction,
  boxAllCasesAction,
  shipKitAction,
  unpackCompleteAction,
  signOffItemAction,
  finalizeSweepAction,
  moveLooseAction,
  sendLooseAction,
  saveItemAction,
  flagItemAction,
  resolveFlagAction,
  serviceChangeAction,
} from './actions';

// signoff-screen.tsx — the Archetype-A Sign-Off shell + the client island driving every sign-off
// WRITE through its gated Server Actions. A TRUE 1:1 port of SignOffPool + SignOffEvent (index.html
// ~L21223 / ~L21395). The LEFT SidebarRail toggles Packing | Unpacking and lists the pool events; the
// MAIN pane is the selected event's full sign-off surface (seeded by the page — no client data
// authority). Variant + selection URL-reflect to ?variant / ?event.

function pct(signed: number, total: number): number {
  return total > 0 ? Math.round((signed / total) * 100) : 0;
}

export function SignoffScreen({
  variant,
  eventRows,
  selectedId,
  detail,
}: {
  variant: SignoffVariant;
  eventRows: SignoffEventRow[];
  selectedId: string | null;
  detail: SignoffDetailSeed | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [mobilePoolOpen, setMobilePoolOpen] = useState(false);
  // After a Ship Kit commit, the event flips to 'onsite' and LEAVES the packing pool — so we stash the
  // JUST-FROZEN manifest of record here, render it into the print block, print it, then clear the
  // selection (mirrors submitShip → printManifestSnapshot → navigate('signoff', variant)).
  const [shippedSnapshot, setShippedSnapshot] = useState<ManifestSnapshot | null>(null);
  const isPacking = variant === 'packing';

  const go = useCallback(
    (next: { variant?: SignoffVariant; event?: string | null }) => {
      const usp = new URLSearchParams(params.toString());
      if (next.variant !== undefined) {
        if (next.variant === 'packing') usp.delete('variant');
        else usp.set('variant', next.variant);
        usp.delete('event'); // a variant switch clears the selection
      }
      if (next.event !== undefined) {
        if (next.event) usp.set('event', next.event);
        else usp.delete('event');
      }
      const qs = usp.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router]
  );

  function PoolControls({ onPick }: { onPick?: () => void }) {
    return (
      <>
        <SidebarSection label="Sign-off">
          <div
            role="tablist"
            aria-label="Sign-off variant"
            className="flex gap-1 rounded-md border border-border bg-background p-1"
          >
            {(['packing', 'unpacking'] as const).map((v) => {
              const active = v === variant;
              return (
                <button
                  key={v}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={() => {
                    go({ variant: v });
                    onPick?.();
                  }}
                  className={cn(
                    'flex-1 rounded px-2 py-1.5 text-xs font-medium capitalize transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {v}
                </button>
              );
            })}
          </div>
        </SidebarSection>

        <SidebarSection label={`${isPacking ? 'Packing' : 'Unpacking'} · ${eventRows.length}`}>
          {eventRows.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              No events are currently {variant}.
            </p>
          ) : (
            eventRows.map((r) => {
              const active = r.id === selectedId;
              const p = pct(r.headSigned, r.headTotal);
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    go({ event: r.id });
                    onPick?.();
                  }}
                  className={cn(
                    'group/pool flex w-full flex-col gap-1.5 rounded-md border-l-2 border-transparent px-2 py-2 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    active ? 'border-primary bg-accent' : 'hover:bg-accent'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-sm font-medium',
                        active ? 'text-primary' : 'text-foreground'
                      )}
                    >
                      {r.name}
                    </span>
                    {r.flagged > 0 ? (
                      <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warning" aria-label={`${r.flagged} open flag(s)`} />
                    ) : r.ready ? (
                      <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" aria-label="Ready" />
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <ProgressBar
                      value={r.headSigned}
                      total={r.headTotal}
                      size="sm"
                      label={`${isPacking ? 'Cases boxed' : 'Items signed'} ${r.headSigned} of ${r.headTotal}`}
                      fillColor={p === 100 ? 'var(--success)' : 'var(--primary)'}
                      className="flex-1"
                    />
                    <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {p}%
                    </span>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">{r.city || 'No city'}</span>
                </button>
              );
            })
          )}
        </SidebarSection>
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <SidebarRail ariaLabel="Sign-off events" className="hidden md:flex">
        <PoolControls />
      </SidebarRail>

      <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
        {detail ? (
          <SignoffDetail
            variant={variant}
            detail={detail}
            onRefresh={() => router.refresh()}
            onShipped={(snap) => {
              // Print the just-frozen manifest of record, then drop the (now-onsite) event selection.
              setShippedSnapshot(snap);
              setTimeout(() => {
                try {
                  window.print();
                } catch {
                  /* print unavailable — non-fatal */
                }
                setShippedSnapshot(null);
                go({ event: null });
                router.refresh();
              }, 150);
            }}
          />
        ) : (
          <EmptySelect variant={variant} hasEvents={eventRows.length > 0} />
        )}
      </div>

      {/* The just-shipped manifest of record — rendered only to be printed, then cleared. */}
      {shippedSnapshot ? <PrintSignoffManifest snapshot={shippedSnapshot} preview={false} shipped /> : null}

      <Sheet open={mobilePoolOpen} onOpenChange={setMobilePoolOpen}>
        <Button
          type="button"
          size="icon"
          onClick={() => setMobilePoolOpen(true)}
          aria-label="Sign-off events"
          className="fixed right-4 bottom-20 z-40 size-12 rounded-full shadow-lg md:hidden"
        >
          <ListFilter size={18} aria-hidden />
        </Button>
        <SheetContent side="bottom" className="max-h-[80dvh] gap-0 p-0">
          <SheetHeader>
            <SheetTitle>Sign-off</SheetTitle>
            <SheetDescription>
              {eventRows.length} event{eventRows.length === 1 ? '' : 's'} {variant}
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-6 overflow-y-auto px-3 pb-6">
            <PoolControls onPick={() => setMobilePoolOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function EmptySelect({ variant, hasEvents }: { variant: SignoffVariant; hasEvents: boolean }) {
  return (
    <>
      <ScreenHeader
        eyebrow="Operations · Sign-Off"
        title={variant === 'packing' ? 'Outbound sign-off' : 'Return sign-off'}
        subtitle={
          variant === 'packing'
            ? 'Lead attests each roadcase is boxed before the kit ships. Pick an event to review its readiness.'
            : 'Reconcile every returned item before the event closes. Pick an event to review its readiness.'
        }
      />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-20 text-center">
        <ClipboardCheck size={48} className="text-muted-foreground/40" aria-hidden />
        <p className="text-sm font-medium text-foreground">
          {hasEvents ? 'Select an event to start sign-off' : `No events are currently ${variant}`}
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {hasEvents
            ? `Events in the ${variant} phase appear in the list on the left.`
            : `An event enters this pool once it reaches the ${variant} phase.`}
        </p>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// The selected event's full sign-off surface
// ════════════════════════════════════════════════════════════════════════════════════════════
function SignoffDetail({
  variant,
  detail,
  onRefresh,
  onShipped,
}: {
  variant: SignoffVariant;
  detail: SignoffDetailSeed;
  onRefresh: () => void;
  onShipped: (snapshot: ManifestSnapshot) => void;
}) {
  const isPacking = variant === 'packing';
  const d = detail;
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null); // a row/case key being written
  const [shipOpen, setShipOpen] = useState(false);

  // Modal state
  const [detailsItemId, setDetailsItemId] = useState<string | null>(null);
  const [flagState, setFlagState] = useState<{ itemId: string; flag: ItemFlag | null } | null>(null);
  const [moveTarget, setMoveTarget] = useState<SignoffReturnRow | null>(null);
  const [sendTarget, setSendTarget] = useState<SignoffReturnRow | null>(null);

  const tagById = useMemo(() => new Map(Object.entries(d.tagsById)), [d.tagsById]);
  const detailsItem = detailsItemId ? d.itemsById[detailsItemId] : null;
  const flagItem = flagState ? d.itemsById[flagState.itemId] : null;

  // Shared row interactions (item name → details; flag/resolve), threaded into ManifestCaseCard.
  const rowActions: ManifestRowActions = {
    onOpenItem: (id) => setDetailsItemId(id),
    onFlag: (id) => {
      const it = d.itemsById[id];
      const open = it ? itemOpenFlag(it) : null;
      setFlagState({ itemId: id, flag: open });
    },
    openFlagByItemId: d.openFlagByItemId,
  };

  const run = (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string) => {
    setBusy(key);
    startTransition(async () => {
      const res = await fn();
      setBusy(null);
      if (res.ok) {
        if (okMsg) toast.success(okMsg);
        onRefresh();
      } else {
        toast.error(res.error || 'Could not complete that action.');
      }
    });
  };

  const printPreview = !d.hasSnapshot;

  return (
    <>
      <ScreenHeader
        eyebrow={`${d.city || d.venueName || 'No city'} · ${isPacking ? 'Outbound' : 'Return'} sign-off`}
        title={d.name}
        subtitle={d.lead ? `Lead: ${d.lead}` : d.venueName || undefined}
        actions={
          <div className="flex items-center gap-2">
            <PrintSignoffButton hasSnapshot={d.hasSnapshot} />
            {d.ready ? (
              <Badge
                variant="outline"
                className="gap-1.5 font-medium"
                style={{ color: 'var(--success)', borderColor: 'var(--success)' }}
              >
                <CheckCircle2 size={13} aria-hidden />
                {isPacking ? 'Ready to ship' : 'Ready to close'}
              </Badge>
            ) : (
              <StatusBadge state={d.state} />
            )}
          </div>
        }
      />

      {/* Readiness summary — the big progress bar + the gate button (Ship Kit / Unpack Complete). */}
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-6">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div className="flex items-baseline gap-3">
            <span className="text-lg font-bold text-foreground">
              {isPacking ? d.casesSigned : d.itemsSigned} / {isPacking ? d.casesTotal : d.itemsTotal}{' '}
              {isPacking ? 'cases' : 'items'}
            </span>
            <span className="text-sm text-muted-foreground">{isPacking ? 'boxed' : 'signed off'}</span>
            {d.hasSnapshot ? (
              <SnapshotBadge capturedAtLabel={d.snapshotCapturedAtLabel} byName={d.snapshotCapturedByName} />
            ) : null}
          </div>
          {isPacking ? <ShipKitGate detail={d} onOpen={() => setShipOpen(true)} /> : <UnpackGate detail={d} pending={pending} onClose={() => run('close', () => unpackCompleteAction(d.id), 'Event closed.')} />}
        </div>
        <ProgressBar
          value={isPacking ? d.casesSigned : d.itemsSigned}
          total={isPacking ? d.casesTotal : d.itemsTotal}
          label={`${isPacking ? 'Cases boxed' : 'Items signed'} ${isPacking ? d.casesSigned : d.itemsSigned} of ${isPacking ? d.casesTotal : d.itemsTotal}`}
          fillColor={
            (isPacking ? pct(d.casesSigned, d.casesTotal) : pct(d.itemsSigned, d.itemsTotal)) === 100
              ? 'var(--success)'
              : 'var(--primary)'
          }
        />
        {d.flagged > 0 ? (
          <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--warning)' }}>
            <TriangleAlert size={14} aria-hidden />
            <span>{d.flagged} item{d.flagged === 1 ? '' : 's'} have open flags that must be resolved</span>
          </div>
        ) : null}
      </div>

      {/* The gate explainer alert (green when ready / amber with the reason when not). */}
      {isPacking ? (
        d.ready ? (
          <Alert>
            <CheckCircle2 className="text-success" />
            <AlertTitle>Kit is ready to ship</AlertTitle>
            <AlertDescription>
              Every assigned case is boxed and there are no open flags. Ship the kit to set it On Site.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert className="border-[color:var(--warning)]/40">
            <TriangleAlert className="text-warning" />
            <AlertTitle>Not ready to ship yet</AlertTitle>
            <AlertDescription>{d.blockReason ?? 'Box every case and resolve open flags.'}</AlertDescription>
          </Alert>
        )
      ) : d.ready ? (
        <Alert>
          <CheckCircle2 className="text-success" />
          <AlertTitle>Every item accounted for</AlertTitle>
          <AlertDescription>All returned units are signed off — this event is ready to close.</AlertDescription>
        </Alert>
      ) : (
        <Alert className="border-[color:var(--warning)]/40">
          <CircleDashed className="text-warning" />
          <AlertTitle>Return reconciliation in progress</AlertTitle>
          <AlertDescription>
            {d.itemsTotal - d.itemsSigned} of {d.itemsTotal} item
            {d.itemsTotal - d.itemsSigned === 1 ? '' : 's'} still need a return sign-off.
          </AlertDescription>
        </Alert>
      )}

      {/* UNPACKING ONLY — the check-in sweep card. */}
      {!isPacking ? (
        <CheckinSweepCard
          detail={d}
          pending={pending && busy === 'sweep'}
          onFinalize={() =>
            run('sweep', async () => {
              const res = await finalizeSweepAction(d.id);
              if (res.ok) {
                toast.success(`Sweep finalized: ${res.flagsAdded ?? 0} flag${res.flagsAdded === 1 ? '' : 's'} raised`);
              }
              return res;
            })
          }
        />
      ) : null}

      {/* The manifest section: header (eyebrow + snapshot badge + bulk action). */}
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex flex-col gap-2 border-b border-border bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-baseline gap-2">
            <Eyebrow>
              {isPacking
                ? `Event manifest · ${d.caseGroups.length} cases`
                : `Event manifest · ${d.caseReturnRows.length + d.looseReturnRows.length} items`}
            </Eyebrow>
          </div>
          <div className="flex flex-wrap gap-2">
            {isPacking ? (
              d.canCommit ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  title="Mark every unflagged, unboxed case as boxed"
                  onClick={() =>
                    run('boxall', async () => {
                      const res = await boxAllCasesAction(d.id);
                      if (res.ok) toast.success(`${res.boxed ?? 0} case${res.boxed === 1 ? '' : 's'} boxed`);
                      return res;
                    })
                  }
                >
                  {pending && busy === 'boxall' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <PackageCheck size={14} aria-hidden />}
                  Box all cases
                </Button>
              ) : null
            ) : d.canCommit ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                title="Sign off every unflagged, unsigned item"
                onClick={() => bulkSignoff(d, run)}
              >
                {pending && busy === 'bulk' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
                Bulk Sign-off
              </Button>
            ) : null}
          </div>
        </div>

        {/* PACKING — per-case cards with a Mark-boxed action + boxed-by stamp. */}
        {isPacking ? (
          d.caseGroups.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm italic text-muted-foreground">
              No road cases assigned to this event yet.
            </p>
          ) : (
            <div className="flex flex-col gap-3 p-3.5">
              {d.caseGroups.map((g) => (
                <PackingCaseCard
                  key={g.group.caseId}
                  cg={g}
                  detail={d}
                  rowActions={rowActions}
                  busy={busy === `case-${g.group.caseId}`}
                  anyPending={pending}
                  onToggle={(boxed) =>
                    run(
                      `case-${g.group.caseId}`,
                      () => setCaseSignoffAction({ eventId: d.id, caseId: g.group.caseId, boxed }),
                      boxed ? 'Case boxed.' : 'Sign-off reverted.'
                    )
                  }
                />
              ))}
            </div>
          )
        ) : (
          // UNPACKING — the per-item return sign-off table + the loose section.
          <ReturnTable
            detail={d}
            busy={busy}
            anyPending={pending}
            onOpenItem={(id) => setDetailsItemId(id)}
            onToggle={(row, kind) => {
              const key = `row-${row.itemId}-${row.caseId ?? `loose-${row.distIdx}`}`;
              run(key, () =>
                signOffItemAction({
                  eventId: d.id,
                  itemId: row.itemId,
                  caseId: row.caseId,
                  looseDistIdx: row.loose ? row.distIdx : undefined,
                  kind,
                })
              );
            }}
            onMove={(row) => setMoveTarget(row)}
            onSend={(row) => setSendTarget(row)}
          />
        )}
      </section>

      {/* Hidden print section — the manifest of record (or live preview). */}
      <PrintSignoffManifest snapshot={d.printSnapshot} preview={printPreview} />

      {/* ── Ship Kit modal ── */}
      {isPacking ? (
        <ShipKitModal
          open={shipOpen}
          onOpenChange={setShipOpen}
          detail={d}
          onShipped={(snapshot) => {
            // Hand the frozen snapshot up so the screen prints it + clears the (now-onsite) selection.
            if (snapshot) onShipped(snapshot);
            else onRefresh();
          }}
        />
      ) : null}

      {/* ── Item details / flag / resolve modals (shared) ── */}
      {detailsItem ? (
        <ItemDetailsModal
          key={detailsItem.id}
          item={detailsItem}
          cases={d.casesForEditor}
          tagById={tagById}
          open={!!detailsItemId}
          onOpenChange={(o) => {
            if (!o) setDetailsItemId(null);
          }}
          onSave={async (patch) => {
            const res = await saveItemAction(detailsItem.id ?? '', patch);
            if (res.ok) onRefresh();
            return res;
          }}
          onServiceChange={async (patch) => {
            const res = await serviceChangeAction(detailsItem.id ?? '', patch);
            if (res.ok) onRefresh();
            return res;
          }}
          actorName={d.actorName}
          matrixSvg={d.itemMatrixSvgByItemId[detailsItem.id ?? '']}
          canEdit={d.canCommit || d.canManageLoose}
        />
      ) : null}
      {flagItem && flagState && !flagState.flag ? (
        <FlagItemModal
          key={`flag-${flagItem.id}`}
          item={flagItem}
          open
          onOpenChange={(o) => {
            if (!o) setFlagState(null);
          }}
          onSubmit={async (data) => {
            const res = await flagItemAction(flagItem.id ?? '', flagItem, data);
            if (res.ok) onRefresh();
            return res;
          }}
        />
      ) : null}
      {flagItem && flagState && flagState.flag ? (
        <ResolveFlagModal
          key={`resolve-${flagItem.id}-${flagState.flag.id}`}
          item={flagItem}
          flag={flagState.flag}
          open
          onOpenChange={(o) => {
            if (!o) setFlagState(null);
          }}
          onSubmit={async (resolution) => {
            const res = await resolveFlagAction(flagItem.id ?? '', flagItem, flagState.flag!.id ?? '', resolution);
            if (res.ok) onRefresh();
            return res;
          }}
        />
      ) : null}

      {/* ── Loose: Move to case / Send to event Sheets ── */}
      {moveTarget ? (
        <MovePickerSheet
          row={moveTarget}
          targets={d.looseTargetCases}
          onClose={() => setMoveTarget(null)}
          onPick={(caseId) => {
            const row = moveTarget;
            setMoveTarget(null);
            run(`move-${row.itemId}`, async () => {
              const res = await moveLooseAction({ eventId: d.id, itemId: row.itemId, distIdx: row.distIdx, targetCaseId: caseId });
              if (res.ok) toast.success('Moved to case.');
              return res;
            });
          }}
        />
      ) : null}
      {sendTarget ? (
        <SendPickerSheet
          row={sendTarget}
          targets={d.looseTargetEvents}
          onClose={() => setSendTarget(null)}
          onPick={(eventId, name) => {
            const row = sendTarget;
            setSendTarget(null);
            run(`send-${row.itemId}`, async () => {
              const res = await sendLooseAction({ eventId: d.id, itemId: row.itemId, distIdx: row.distIdx, targetEventId: eventId });
              if (res.ok) toast.success(`Sent to ${name}.`);
              return res;
            });
          }}
        />
      ) : null}
    </>
  );
}

// ── Snapshot-of-record badge ────────────────────────────────────────────────────────────────────
function SnapshotBadge({ capturedAtLabel, byName }: { capturedAtLabel: string; byName: string | null }) {
  const title = `Captured ${capturedAtLabel}${byName ? ` by ${byName}` : ''}`;
  return (
    <span
      title={title}
      className="rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
      style={{ color: 'var(--success)', borderColor: 'color-mix(in oklab, var(--success) 40%, transparent)', background: 'color-mix(in oklab, var(--success) 8%, transparent)' }}
    >
      Snapshot of record
    </span>
  );
}

// ── Ship Kit gate button (with WHY-disabled tooltip) ────────────────────────────────────────────
function ShipKitGate({ detail, onOpen }: { detail: SignoffDetailSeed; onOpen: () => void }) {
  const canShip = detail.ready && detail.canCommit;
  const reason = !detail.canCommit
    ? 'Lead or higher can ship the kit'
    : detail.ready
      ? 'Ship the kit and set the event On Site'
      : detail.blockReason ?? 'Box every case and resolve open flags';
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex w-full sm:w-auto">
            <Button
              type="button"
              size="sm"
              disabled={!canShip}
              onClick={onOpen}
              className="w-full sm:w-auto"
            >
              <Truck size={14} aria-hidden /> Ship Kit
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── Unpack Complete gate button ─────────────────────────────────────────────────────────────────
function UnpackGate({ detail, pending, onClose }: { detail: SignoffDetailSeed; pending: boolean; onClose: () => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canClose = detail.ready && detail.canCommit && detail.itemsTotal > 0;
  const reason = !detail.canCommit
    ? 'Lead or higher can close the event'
    : detail.itemsTotal === 0
      ? 'No items to reconcile yet'
      : detail.ready
        ? 'Close the event'
        : `${detail.itemsTotal - detail.itemsSigned} of ${detail.itemsTotal} items still need a return sign-off`;
  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex w-full sm:w-auto">
              <Button type="button" size="sm" disabled={!canClose} onClick={() => setConfirmOpen(true)} className="w-full sm:w-auto">
                <PackageCheck size={14} aria-hidden /> Unpack Complete
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{reason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Close this event?</DialogTitle>
            <DialogDescription>
              Mark “{detail.name}” fully unpacked and close it. {detail.itemsSigned} of {detail.itemsTotal} items
              signed off. This sets the event to Closed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                onClose();
              }}
              disabled={pending}
            >
              {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
              Close event
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── PACKING: one case card with the Mark-boxed action + boxed-by stamp ──────────────────────────
function PackingCaseCard({
  cg,
  detail,
  rowActions,
  busy,
  anyPending,
  onToggle,
}: {
  cg: SignoffCaseGroup;
  detail: SignoffDetailSeed;
  rowActions: ManifestRowActions;
  busy: boolean;
  anyPending: boolean;
  onToggle: (boxed: boolean) => void;
}) {
  const canBox = detail.canCommit && !cg.hasFlags;
  const action = cg.boxed ? (
    detail.canRevert ? (
      <Button type="button" variant="outline" size="sm" disabled={anyPending} onClick={() => onToggle(false)} className="shrink-0">
        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
        Revert
      </Button>
    ) : (
      <Badge variant="outline" className="shrink-0 gap-1.5 font-medium" style={{ color: 'var(--success)', borderColor: 'var(--success)' }}>
        <CheckCircle2 size={12} aria-hidden /> Boxed
      </Badge>
    )
  ) : detail.canCommit ? (
    <Button
      type="button"
      size="sm"
      disabled={anyPending || !canBox}
      onClick={() => onToggle(true)}
      title={cg.hasFlags ? 'Resolve the open flag before boxing this case' : 'Sign off — this case is boxed'}
      className="shrink-0"
    >
      {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <PackageCheck size={14} aria-hidden />}
      Mark boxed
    </Button>
  ) : (
    <span className="shrink-0 text-xs text-muted-foreground">Lead+ to sign off</span>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>{cg.group.label}</Eyebrow>
        {action}
      </div>
      {cg.hasFlags ? (
        <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--warning)' }}>
          <TriangleAlert size={12} aria-hidden /> open flag(s) — resolve before boxing
        </div>
      ) : null}
      {cg.boxed && cg.boxedByName ? (
        <div className="text-xs text-muted-foreground">
          Boxed by {cg.boxedByName}
          {cg.boxedAtLabel ? ` · ${cg.boxedAtLabel}` : ''}
        </div>
      ) : null}
      <div
        className={cn('overflow-hidden rounded-lg', cg.boxed && 'ring-1 ring-[color:var(--success)]/40')}
        style={cg.boxed ? { background: 'color-mix(in oklab, var(--success) 6%, transparent)' } : undefined}
      >
        <ManifestCaseCard group={cg.group} actions={rowActions} />
      </div>
    </div>
  );
}

// ── UNPACKING: the per-item return sign-off table + the loose section ───────────────────────────
const DISPOSITIONS: { k: string; short: string; full: string; color: string }[] = [
  { k: 'ok', short: 'OK', full: 'OK', color: 'var(--success)' },
  { k: 'damaged', short: 'DMG', full: 'Damaged', color: 'var(--destructive)' },
  { k: 'missing', short: 'MIS', full: 'Missing', color: 'var(--warning)' },
  { k: 'consumed', short: 'CON', full: 'Consumed', color: 'var(--muted-foreground)' },
  { k: 'other', short: 'OTH', full: 'Other', color: 'var(--muted-foreground)' },
];

function ReturnTable({
  detail,
  busy,
  anyPending,
  onOpenItem,
  onToggle,
  onMove,
  onSend,
}: {
  detail: SignoffDetailSeed;
  busy: string | null;
  anyPending: boolean;
  onOpenItem: (id: string) => void;
  onToggle: (row: SignoffReturnRow, kind: string | null) => void;
  onMove: (row: SignoffReturnRow) => void;
  onSend: (row: SignoffReturnRow) => void;
}) {
  if (detail.caseReturnRows.length === 0 && detail.looseReturnRows.length === 0) {
    return <p className="px-4 py-8 text-center text-sm italic text-muted-foreground">No inventory rows assigned to this event yet.</p>;
  }
  return (
    <div className="flex flex-col">
      {detail.caseReturnRows.map((r) => (
        <ReturnRow
          key={`${r.itemId}-${r.caseId}`}
          row={r}
          detail={detail}
          busy={busy === `row-${r.itemId}-${r.caseId}`}
          anyPending={anyPending}
          onOpenItem={onOpenItem}
          onToggle={onToggle}
          onMove={onMove}
          onSend={onSend}
        />
      ))}
      {detail.looseReturnRows.length > 0 ? (
        <div className="border-y border-border bg-muted/20 px-4 py-2 text-[10px] font-bold uppercase tracking-wide" style={{ color: 'var(--primary)' }}>
          Loose inventory · {detail.looseReturnRows.length}
        </div>
      ) : null}
      {detail.looseReturnRows.map((r) => (
        <ReturnRow
          key={`${r.itemId}-loose-${r.distIdx}`}
          row={r}
          detail={detail}
          busy={busy === `row-${r.itemId}-loose-${r.distIdx}`}
          anyPending={anyPending}
          onOpenItem={onOpenItem}
          onToggle={onToggle}
          onMove={onMove}
          onSend={onSend}
        />
      ))}
    </div>
  );
}

function ReturnRow({
  row,
  detail,
  busy,
  anyPending,
  onOpenItem,
  onToggle,
  onMove,
  onSend,
}: {
  row: SignoffReturnRow;
  detail: SignoffDetailSeed;
  busy: boolean;
  anyPending: boolean;
  onOpenItem: (id: string) => void;
  onToggle: (row: SignoffReturnRow, kind: string | null) => void;
  onMove: (row: SignoffReturnRow) => void;
  onSend: (row: SignoffReturnRow) => void;
}) {
  const signed = row.signed;
  const hasFlags = row.hasFlags;
  const canSign = detail.canCommit;

  return (
    <div
      className={cn(
        'flex flex-col gap-2 border-b border-border/60 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4',
        signed && 'bg-[color:var(--success)]/[0.06]'
      )}
    >
      {/* Checkbox + name (siblings — the checkbox is its own button; the name is its own button). */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <button
          type="button"
          aria-pressed={signed}
          aria-label={signed ? `Un-sign ${row.name}` : `Sign off ${row.name}`}
          disabled={!canSign || anyPending || (!signed && hasFlags)}
          onClick={() => onToggle(row, signed ? null : 'ok')}
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded border-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50',
            signed ? 'border-[color:var(--success)] bg-[color:var(--success)]' : 'border-border'
          )}
        >
          {signed ? <CheckCircle2 size={14} className="text-background" aria-hidden /> : null}
          {busy ? <Loader2 size={12} className="animate-spin text-muted-foreground" aria-hidden /> : null}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenItem(row.itemId)}
              title={`Open details for ${row.name}`}
              className={cn(
                'max-w-full truncate text-left text-sm font-semibold outline-none hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50',
                signed ? 'text-muted-foreground line-through' : 'text-foreground'
              )}
            >
              {row.name}
            </button>
            <span className={cn('font-mono text-[10px]', row.loose ? 'text-primary' : 'text-muted-foreground/70')}>
              {row.loose ? 'Loose' : row.caseLabel}
            </span>
          </div>
          {hasFlags ? (
            <div className="mt-0.5 flex items-center gap-1 text-[11px]" style={{ color: 'var(--warning)' }}>
              <TriangleAlert size={11} aria-hidden /> {row.openFlagCount} open flag(s)
            </div>
          ) : null}
        </div>
      </div>

      {/* Disposition picker + loose actions + status */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pl-8 text-[11px] text-muted-foreground sm:pl-0">
        {!hasFlags ? (
          <div className="flex gap-0.5 rounded-md bg-muted/40 p-0.5">
            {DISPOSITIONS.map((o) => {
              const active = row.dispositionKind === o.k;
              return (
                <button
                  key={o.k}
                  type="button"
                  disabled={!canSign || anyPending}
                  aria-pressed={active}
                  onClick={() => onToggle(row, active ? null : o.k)}
                  title={o.full}
                  className={cn(
                    'rounded px-2 py-1 text-[9px] font-bold uppercase tracking-wide transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 sm:px-1.5'
                  )}
                  style={active ? { background: o.color, color: 'var(--background)' } : undefined}
                >
                  <span className="sm:hidden">{o.full}</span>
                  <span className="hidden sm:inline">{o.short}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Loose-row actions — lead+ */}
        {row.loose && detail.canManageLoose ? (
          <>
            <Button type="button" variant="ghost" size="sm" disabled={anyPending} onClick={() => onMove(row)} title="Move to case">
              <BoxIcon size={11} aria-hidden /> Move to case
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={anyPending} onClick={() => onSend(row)} title="Send to event">
              <Layers size={11} aria-hidden /> Send to event
            </Button>
          </>
        ) : null}

        {signed ? (
          <span>
            By {row.signedByName || 'user'}
            {row.signedAtLabel ? ` · ${row.signedAtLabel}` : ''}
          </span>
        ) : hasFlags ? (
          <span style={{ color: 'var(--warning)' }}>Blocked by flags</span>
        ) : (
          <span>Pending</span>
        )}
      </div>
    </div>
  );
}

// ── Check-in sweep card ─────────────────────────────────────────────────────────────────────────
function CheckinSweepCard({
  detail,
  pending,
  onFinalize,
}: {
  detail: SignoffDetailSeed;
  pending: boolean;
  onFinalize: () => void;
}) {
  const sweep = detail.sweep;
  if (!sweep.hasSnapshot) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <Eyebrow>Check-in sweep</Eyebrow>
        <p className="mt-1.5 text-xs text-muted-foreground">
          No shipped manifest of record on this event yet, so there&apos;s nothing to reconcile against. The
          sweep becomes available once the kit has been shipped.
        </p>
      </div>
    );
  }
  const t = sweep.tally;
  const clean = sweep.discrepancies.length === 0;
  const stat = (label: string, value: number, color: string) => (
    <div className="flex-1 px-1.5 py-2 text-center">
      <div className="font-mono text-xl font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
      <div className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <Eyebrow>Check-in sweep</Eyebrow>
          <span className="text-[11px] text-muted-foreground">shipped {t.total} units vs current state</span>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={onFinalize}
          title="Raise flags on Missing + Damaged items and write a reconcile audit entry"
        >
          {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
          Finalize sweep
        </Button>
      </div>
      <div className={cn('flex', !clean && 'border-b border-border')}>
        {stat('Returned', t.returned, 'var(--success)')}
        {stat('Damaged', t.damaged, 'var(--destructive)')}
        {stat('Missing', t.missing, 'var(--warning)')}
      </div>
      {clean ? (
        <div className="px-4 py-2.5 text-xs" style={{ color: 'var(--success)' }}>
          All shipped items accounted for — no discrepancies. Finalizing writes a clean reconcile entry.
        </div>
      ) : (
        <div className="max-h-60 overflow-y-auto">
          {sweep.discrepancies.map((dd, i) => (
            <div
              key={`${dd.itemId}-${i}`}
              className={cn('flex items-center gap-2.5 px-4 py-2', i && 'border-t border-border/60')}
            >
              <span
                className="shrink-0 text-[9px] font-bold uppercase tracking-wide"
                style={{ color: dd.status === 'damaged' ? 'var(--destructive)' : 'var(--warning)' }}
              >
                {dd.status}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground">
                  {(dd.qty > 1 ? `×${dd.qty} ` : '') + dd.itemName}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {dd.caseLabel ? `${dd.caseLabel} · ` : ''}
                  {dd.reason}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-border/60 px-4 py-2 text-[10px] text-muted-foreground">
        Advisory. Finalizing is idempotent — it won&apos;t double-flag items that already carry an open
        damage/maintenance flag.
      </div>
    </div>
  );
}

// ── Ship Kit modal ──────────────────────────────────────────────────────────────────────────────
function ShipKitModal({
  open,
  onOpenChange,
  detail,
  onShipped,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  detail: SignoffDetailSeed;
  onShipped: (snapshot: ManifestSnapshot | null) => void;
}) {
  const [carrier, setCarrier] = useState(detail.shipDefaults.carrier);
  const [tracking, setTracking] = useState(detail.shipDefaults.tracking);
  const [pickupDate, setPickupDate] = useState(detail.shipDefaults.pickupDate);
  const [notes, setNotes] = useState(detail.shipDefaults.notes);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!carrier.trim() || !tracking.trim()) {
      toast.warning('Carrier and tracking number are required.');
      return;
    }
    startTransition(async () => {
      const res = await shipKitAction({ eventId: detail.id, carrier: carrier.trim(), tracking: tracking.trim(), pickupDate, notes: notes.trim() });
      if (res.ok) {
        toast.success('Kit shipped — event set On Site.');
        onOpenChange(false);
        onShipped(res.snapshot ?? null);
      } else {
        toast.error(res.error || 'Could not ship the kit.');
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ship Kit · {detail.name}</DialogTitle>
          <DialogDescription>
            Records the outbound carrier / tracking / pickup
            {detail.hasSnapshot ? '' : ' and freezes the manifest of record'}, then sets the event On Site.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-carrier">Carrier</Label>
            <Input id="ship-carrier" autoFocus value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="e.g. FedEx Freight, Yellow Freight, UPS" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-tracking">Tracking number</Label>
            <Input id="ship-tracking" value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Tracking ID from the carrier" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-pickup">Pickup date</Label>
            <Input id="ship-pickup" type="date" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} className="w-fit" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-notes">Notes (optional)</Label>
            <Textarea id="ship-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the receiving team should know — pallet count, dock requirements, etc." />
          </div>
          <div className="rounded-md border border-primary/25 bg-primary/[0.06] px-3 py-2.5 text-xs text-foreground">
            Shipping this kit sets <strong className="text-foreground">{detail.name}</strong> to{' '}
            <strong className="text-primary">On Site</strong> and keeps the assigned cases locked until return.
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !carrier.trim() || !tracking.trim()}>
            {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Truck size={14} aria-hidden />}
            Ship Kit · Set On Site
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Loose: Move-to-case picker Sheet ────────────────────────────────────────────────────────────
function MovePickerSheet({
  row,
  targets,
  onClose,
  onPick,
}: {
  row: SignoffReturnRow;
  targets: SignoffDetailSeed['looseTargetCases'];
  onClose: () => void;
  onPick: (caseId: string) => void;
}) {
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="max-h-[80dvh] gap-0 p-0 sm:mx-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Move loose item to case</SheetTitle>
          <SheetDescription>{row.name}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-1.5 overflow-y-auto px-4 pb-6">
          {targets.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">This event has no road cases assigned.</p>
          ) : (
            targets.map((c) => (
              <Button key={c.id} variant="outline" className="justify-start" onClick={() => onPick(c.id)}>
                <BoxIcon size={13} className="text-primary" aria-hidden /> {c.label}
              </Button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Loose: Send-to-event picker Sheet ───────────────────────────────────────────────────────────
function SendPickerSheet({
  row,
  targets,
  onClose,
  onPick,
}: {
  row: SignoffReturnRow;
  targets: SignoffDetailSeed['looseTargetEvents'];
  onClose: () => void;
  onPick: (eventId: string, name: string) => void;
}) {
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="max-h-[80dvh] gap-0 p-0 sm:mx-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Send loose item to another event</SheetTitle>
          <SheetDescription>{row.name}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-1.5 overflow-y-auto px-4 pb-6">
          {targets.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No upcoming events available to receive a transfer.</p>
          ) : (
            targets.map((e) => (
              <Button key={e.id} variant="outline" className="justify-start" onClick={() => onPick(e.id, e.name)}>
                <Layers size={13} className="text-primary" aria-hidden />
                <span className="flex-1 text-left">{e.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{e.state}</span>
              </Button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Bulk Sign-off (unpacking) — sign every unflagged, unsigned row 'ok' in sequence ─────────────
// Mirrors the source's "Bulk Sign-off" button: for each unsigned, unflagged row, write the disposition.
// We fire them via the shared action; the page revalidate + onRefresh reconciles the result.
async function bulkSignoff(
  detail: SignoffDetailSeed,
  run: (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string) => void
) {
  const rows = [...detail.caseReturnRows, ...detail.looseReturnRows].filter((r) => !r.signed && !r.hasFlags);
  if (rows.length === 0) {
    toast.info('Nothing to sign off — every unflagged item is already signed.');
    return;
  }
  run('bulk', async () => {
    let okCount = 0;
    let firstErr: string | undefined;
    for (const r of rows) {
      const res = await signOffItemAction({
        eventId: detail.id,
        itemId: r.itemId,
        caseId: r.caseId,
        looseDistIdx: r.loose ? r.distIdx : undefined,
        kind: 'ok',
        bulk: true,
      });
      if (res.ok) okCount++;
      else if (!firstErr) firstErr = res.error;
    }
    if (okCount > 0) toast.success(`${okCount} item${okCount === 1 ? '' : 's'} signed off.`);
    return { ok: okCount > 0, error: okCount === 0 ? firstErr : undefined };
  });
}

export default SignoffScreen;
