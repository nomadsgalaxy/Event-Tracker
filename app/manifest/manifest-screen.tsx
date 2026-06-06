'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Layers, Boxes, ChevronDown, Plus, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { SidebarRail, SidebarSection } from '@/components/ui/sidebar-rail';
import { ScreenHeader } from '@/components/ui/screen-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { Eyebrow } from '@/components/ui/eyebrow';
import { ProgressBar } from '@/components/ui/progress-bar';
import { TagChip } from '@/components/ui/tag-chip';
import { cn } from '@/lib/utils';
import type { EventManifest, ManifestEventListRow } from '@/lib/manifest-view';
import { itemOpenFlag, type InventoryPayload, type ItemFlag } from '@/lib/inventory-shape';
import type { DashTag } from '@/lib/types-dashboard';
import type { ItemPatch } from '@/lib/write';
import { ManifestCaseCard, ManifestLooseCard, type ManifestRowActions } from './manifest-case-card';
import { PrintButton, PrintManifest, type ManifestCodes } from './print-manifest';
import { PrintShippingLabelsButton, PrintShippingLabels, type ShippingLabelExtras } from './print-shipping-labels';
import { AssignCasesModal, type AssignCaseRow } from './assign-cases-modal';
import { ItemDetailsModal, type ItemDetailsCase } from '@/components/inventory/item-details-modal';
import { FlagItemModal, ResolveFlagModal } from '@/components/inventory/flag-modals';
import { AddItemToCaseModal } from '@/components/inventory/add-item-to-case-modal';
import {
  setEventCasesAction,
  saveItemAction,
  flagItemAction,
  resolveFlagAction,
  addLooseItemAction,
  createLooseItemAction,
} from './actions';

// manifest-screen.tsx — the Archetype-A shell of the EVENT MANIFEST POOL (DESIGN_ALIGNMENT §4.3) +
// the client island that drives every Manifest WRITE through its modals (each gated by a Server
// Action in ./actions.ts; see the file header there for the gate matrix). The contextual LEFT rail is
// the EVENTS list (date / name / clickable visible-tag chips / state pill + scanned-of-total); the
// MAIN pane is the selected event's manifest — header + actions, overall progress + per-kind rollup,
// the per-CASE ManifestCaseCard list (rows now clickable when signed in), the LOOSE-inventory card,
// and the print section.
//
// MODALS: Assign-cases (checkbox grid + availability lock + "or add a loose item"), the shared
// ItemDetailsModal (item NAME click), FlagItemModal/ResolveFlagModal (the row flag button), and the
// AddItemToCaseModal loose picker. The full data each modal needs is seeded server-side (page.tsx);
// the client only opens them + relays the result through the gated action + revalidate.

function EventRow({
  row,
  selected,
  onPick,
}: {
  row: ManifestEventListRow;
  selected: boolean;
  onPick: (id: string) => void;
}) {
  const router = useRouter();
  const tags = row.tags;
  // a11y: the whole-row event-pick is a STRETCHED button (absolute overlay) so the row stays
  // clickable WITHOUT nesting the tag chip buttons inside it. The tag chips sit above the overlay
  // (relative z-10) and navigate to /tag/:id on their own — two sibling interactive layers, never
  // nested (the DESIGN_SYSTEM "no nested interactive" rule). Hidden tags were already filtered out
  // server-side (page.tsx tagById excludes payload.hidden).
  return (
    <div
      className={cn(
        'relative flex flex-col gap-1 rounded-md border-l-2 px-3 py-2.5 transition-colors',
        selected ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/60'
      )}
    >
      <button
        type="button"
        onClick={() => onPick(row.id)}
        aria-current={selected ? 'true' : undefined}
        aria-label={`View manifest for ${row.name || 'unnamed event'}`}
        className="absolute inset-0 z-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <span className="pointer-events-none relative z-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {row.dates || '—'}
      </span>
      <span
        className={cn(
          'pointer-events-none relative z-0 truncate text-xs font-semibold leading-tight',
          selected ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {row.name || '(unnamed)'}
      </span>
      {tags.length > 0 ? (
        <span className="relative z-10 flex flex-wrap gap-1">
          {tags.slice(0, 4).map((t) => (
            <TagChip
              key={t.id}
              tag={t as DashTag}
              compact
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/tag/${t.id}`);
              }}
            />
          ))}
          {tags.length > 4 ? (
            <span className="text-[9px] font-bold text-muted-foreground">+{tags.length - 4}</span>
          ) : null}
        </span>
      ) : null}
      <span className="pointer-events-none relative z-0 mt-0.5 flex items-center justify-between gap-2">
        <StatusBadge state={row.state} className="px-1.5 py-0 text-[10px]" />
        <span
          className="font-mono text-[10px] tabular-nums"
          style={{ color: row.flagged > 0 ? 'var(--warning)' : 'var(--muted-foreground)' }}
        >
          {row.scanned}/{row.total}
          {row.flagged > 0 ? ` · ${row.flagged}!` : ''}
        </span>
      </span>
    </div>
  );
}

export function ManifestScreen({
  events,
  selectedId,
  manifest,
  selectedRow,
  canEdit,
  canManageLoose,
  signedIn,
  codes,
  caseCodeSvgByCaseId,
  itemMatrixSvgByItemId,
  extrasByCaseId,
  itemsById,
  openFlagByItemId,
  casesForEditor,
  assignCaseRows,
  assignedIds,
  looseInventory,
  tagsById,
}: {
  events: ManifestEventListRow[];
  selectedId: string | null;
  manifest: EventManifest | null;
  selectedRow: ManifestEventListRow | null;
  /** can('pallets.edit') — the Assign-cases write gate (authorized+). */
  canEdit: boolean;
  /** can('looseitem.manage') — the loose-add gate (lead+). */
  canManageLoose: boolean;
  /** A signed-in session — enables the row interactions (open item / flag). */
  signedIn: boolean;
  codes?: ManifestCodes;
  caseCodeSvgByCaseId?: Record<string, string>;
  /** itemId -> server-built Data Matrix SVG for the ItemDetailsModal Print-Matrix tile. */
  itemMatrixSvgByItemId?: Record<string, string>;
  /** caseId -> the 4×6 shipping label's return address + if-found contact (built server-side). */
  extrasByCaseId?: Record<string, ShippingLabelExtras>;
  /** itemId -> the FULL item payload (for ItemDetailsModal / Flag / Resolve). */
  itemsById: Record<string, InventoryPayload>;
  /** itemId -> open flag id (the row flag button's resolve-vs-flag decision). */
  openFlagByItemId: Record<string, string>;
  /** The case list (id + label) for the ItemDetailsModal location pickers. */
  casesForEditor: ItemDetailsCase[];
  /** The Assign-cases grid rows (with availability). */
  assignCaseRows: AssignCaseRow[];
  /** The event's currently-assigned case ids (seeds the Assign-cases selection). */
  assignedIds: string[];
  /** The loose-add picker inventory (lean {id, payload}). */
  looseInventory: { id: string; payload: InventoryPayload }[];
  /** tagId -> resolved DashTag (for the ItemDetailsModal applied-tag chips). */
  tagsById: Record<string, DashTag>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pickerOpen, setPickerOpen] = useState(false);

  // ── Modal open state ────────────────────────────────────────────────────────────────────
  const [assignOpen, setAssignOpen] = useState(false);
  const [looseOpen, setLooseOpen] = useState(false);
  const [detailsItemId, setDetailsItemId] = useState<string | null>(null);
  const [flagState, setFlagState] = useState<{ itemId: string; flag: ItemFlag | null } | null>(null);

  const tagById = useMemo(() => new Map(Object.entries(tagsById)), [tagsById]);

  // Reflect the selected event to ?event=<id> (shallow replace — every event's manifest is already
  // loaded server-side, so a click never blocks on a refetch). A deep link restores the selection.
  const pick = useCallback(
    (id: string) => {
      const usp = new URLSearchParams(params.toString());
      usp.set('event', id);
      router.replace(`${pathname}?${usp.toString()}`, { scroll: false });
      setPickerOpen(false);
    },
    [params, pathname, router]
  );

  // ── EMPTY: no events at all ───────────────────────────────────────────────────────────────
  if (!selectedRow || !manifest || !selectedId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-16">
        <div className="flex max-w-sm flex-col items-center gap-3 rounded-lg border border-dashed border-border p-8 text-center">
          <Boxes size={28} aria-hidden className="text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No events yet</p>
          <p className="text-sm text-muted-foreground">
            Create an event from the dashboard, then assign roadcases to populate its manifest.
          </p>
          <Button asChild size="sm" className="mt-1">
            <Link href="/">Go to dashboard</Link>
          </Button>
        </div>
      </div>
    );
  }

  const { caseGroups, looseGroup, kindGroups, totals } = manifest;
  const pct = totals.total > 0 ? Math.round((totals.packed / totals.total) * 100) : 0;
  const progressColor =
    totals.flagged > 0 ? 'var(--warning)' : pct === 100 ? 'var(--st-ready)' : 'var(--primary)';
  const hasContent = caseGroups.length > 0 || !!looseGroup;

  // The detail item currently open (resolved from the seeded payloads).
  const detailsItem = detailsItemId ? itemsById[detailsItemId] : null;
  const flagItem = flagState ? itemsById[flagState.itemId] : null;

  // Row interactions — wired only when signed in (matching the Python onOpenItem/onFlag gating).
  const rowActions: ManifestRowActions | undefined = signedIn
    ? {
        onOpenItem: (id) => setDetailsItemId(id),
        onFlag: (id) => {
          const it = itemsById[id];
          const open = it ? itemOpenFlag(it) : null;
          setFlagState({ itemId: id, flag: open });
        },
        openFlagByItemId,
      }
    : undefined;

  const headerActions = (
    <>
      <Button variant="outline" size="sm" asChild>
        <Link href={`/event/${encodeURIComponent(selectedId)}`}>
          <Layers size={14} aria-hidden />
          <span className="hidden sm:inline">Event details</span>
        </Link>
      </Button>
      <Button variant="outline" size="sm" asChild>
        <Link href="/catalog?view=inventory">
          <Boxes size={14} aria-hidden />
          <span className="hidden sm:inline">Inventory</span>
        </Link>
      </Button>
      <PrintButton />
      {/* 4×6 per-case shipping labels — enabled only when the event has roadcases. */}
      <PrintShippingLabelsButton disabled={caseGroups.length === 0} />
      {canEdit ? (
        <Button size="sm" onClick={() => setAssignOpen(true)}>
          <Plus size={14} aria-hidden />
          <span>Assign cases</span>
        </Button>
      ) : null}
    </>
  );

  const EventList = (
    <SidebarSection label={`Events · ${events.length}`}>
      <div className="flex flex-col gap-1">
        {events.map((e) => (
          <EventRow key={e.id} row={e} selected={e.id === selectedId} onPick={pick} />
        ))}
      </div>
    </SidebarSection>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <SidebarRail ariaLabel="Events" className="hidden md:flex">
        {EventList}
      </SidebarRail>

      <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
        {/* MOBILE sticky event-picker button. */}
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left md:hidden"
          aria-label="Switch event"
        >
          <StatusBadge state={selectedRow.state} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-foreground">
              {selectedRow.name || '(unnamed)'}
            </span>
            <span className="block truncate font-mono text-[10px] text-muted-foreground">
              {selectedRow.dates || '—'}
              {selectedRow.city ? ` · ${selectedRow.city}` : ''}
            </span>
          </span>
          <ChevronDown size={16} aria-hidden className="shrink-0 text-muted-foreground" />
        </button>

        <ScreenHeader
          eyebrow={[selectedRow.dates, selectedRow.city].filter(Boolean).join(' · ') || 'No date'}
          title={
            <Link
              href={`/event/${encodeURIComponent(selectedId)}`}
              className="outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {selectedRow.name || '(unnamed)'}
            </Link>
          }
          actions={headerActions}
        />

        <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <StatusBadge state={selectedRow.state} />
          <span>
            Lead: <span className="text-foreground">{selectedRow.lead || '—'}</span>
          </span>
          <span>
            Cases:{' '}
            <span className="font-mono tabular-nums text-foreground">{selectedRow.caseCount}</span>
          </span>
          {looseGroup ? (
            <span>
              Loose:{' '}
              <span className="font-mono tabular-nums text-primary">{looseGroup.total}</span>
            </span>
          ) : null}
          <span>
            Items:{' '}
            <span className="font-mono tabular-nums text-foreground">
              {totals.packed} / {totals.total}
            </span>
          </span>
          {totals.flagged > 0 ? (
            <span className="inline-flex items-center gap-1" style={{ color: 'var(--warning)' }}>
              <TriangleAlert size={12} aria-hidden /> {totals.flagged} flagged
            </span>
          ) : null}
        </div>

        {totals.total > 0 ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-baseline justify-between gap-3">
              <Eyebrow>Overall</Eyebrow>
              <span
                className="font-mono text-xs tabular-nums"
                style={{ color: totals.flagged > 0 ? 'var(--warning)' : 'var(--muted-foreground)' }}
              >
                {totals.packed} packed · {totals.pending} pending
                {totals.flagged > 0 ? ` · ${totals.flagged} flagged` : ''} · {pct}%
              </span>
            </div>
            <ProgressBar
              value={totals.packed}
              total={totals.total}
              label={`Packed ${totals.packed} of ${totals.total}`}
              fillColor={progressColor}
            />
            {kindGroups.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {kindGroups.map((g) => (
                  <span
                    key={g.kind}
                    className="rounded border border-border bg-muted/40 px-2.5 py-1 text-[11px]"
                    style={g.flagged > 0 ? { color: 'var(--warning)' } : undefined}
                  >
                    <span className="mr-1 text-muted-foreground">{g.label}:</span>
                    <span className="font-mono tabular-nums">
                      {g.packed}/{g.total}
                    </span>
                    {g.flagged > 0 ? (
                      <span className="ml-1" style={{ color: 'var(--warning)' }}>
                        ({g.flagged}!)
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {hasContent ? (
          <div className="flex flex-col gap-3">
            {caseGroups.map((g) => (
              <ManifestCaseCard
                key={g.caseId}
                group={g}
                codeSvg={caseCodeSvgByCaseId?.[g.caseId]}
                actions={rowActions}
              />
            ))}
            {looseGroup ? <ManifestLooseCard group={looseGroup} actions={rowActions} /> : null}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center">
            <Boxes size={28} aria-hidden className="text-muted-foreground" />
            <p className="text-sm text-foreground">No roadcases or loose items assigned to this event yet.</p>
            <p className="max-w-md text-xs text-muted-foreground">
              {canEdit
                ? 'Click Assign cases to add roadcases and populate the manifest. Loose attachments (carry-on / hand-carried inventory) can be added from the Assign-cases dialog.'
                : 'An editor can assign cases to populate this manifest.'}
            </p>
            {canEdit ? (
              <div className="mt-1 flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => setAssignOpen(true)}>
                  <Plus size={14} aria-hidden /> Assign cases
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/catalog">Browse cases</Link>
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* MOBILE event picker. */}
      <Sheet open={pickerOpen} onOpenChange={setPickerOpen}>
        <SheetContent side="bottom" className="max-h-[80dvh] gap-0 p-0">
          <SheetHeader>
            <SheetTitle>Events</SheetTitle>
            <SheetDescription>Pick an event to view its manifest.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-1 overflow-y-auto px-3 pb-6">
            {events.map((e) => (
              <EventRow key={e.id} row={e} selected={e.id === selectedId} onPick={pick} />
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {/* Hidden print sections — the manifest (default) + the per-case 4×6 shipping labels. */}
      <PrintManifest manifest={manifest} row={selectedRow} codes={codes} />
      <PrintShippingLabels
        manifest={manifest}
        row={selectedRow}
        caseSvgByCaseId={caseCodeSvgByCaseId}
        extrasByCaseId={extrasByCaseId}
      />

      {/* ── Assign-cases modal (pallets.edit gated by setEventCasesAction) ── */}
      {canEdit ? (
        <AssignCasesModal
          open={assignOpen}
          onOpenChange={setAssignOpen}
          eventName={selectedRow.name || 'this event'}
          assignedIds={assignedIds}
          cases={assignCaseRows}
          canAddLoose={canManageLoose}
          onSave={(ids) => setEventCasesAction(selectedId, ids)}
          onAddLoose={() => setLooseOpen(true)}
        />
      ) : null}

      {/* ── Loose-add picker (looseitem.manage gated by addLooseItemAction) ── */}
      {canManageLoose ? (
        <AddItemToCaseModal
          open={looseOpen}
          onOpenChange={setLooseOpen}
          inventory={looseInventory}
          targetEventId={selectedId}
          eventLabel={selectedRow.name || 'event'}
          onSelect={(itemId) => addLooseItemAction(itemId, selectedId, 'via manifest add-cases modal')}
          onCreateNew={(name) => createLooseItemAction(name, selectedId)}
        />
      ) : null}

      {/* ── ItemDetailsModal (db.write.app gated by saveItemAction) ── */}
      {detailsItem ? (
        <ItemDetailsModal
          key={detailsItem.id}
          item={detailsItem}
          cases={casesForEditor}
          tagById={tagById}
          open={!!detailsItemId}
          onOpenChange={(o) => !o && setDetailsItemId(null)}
          onSave={(patch: ItemPatch) => saveItemAction(detailsItem.id ?? '', patch)}
          matrixSvg={itemMatrixSvgByItemId?.[detailsItem.id ?? '']}
          canEdit={canEdit || canManageLoose}
        />
      ) : null}

      {/* ── Flag / Resolve modals (db.write.app gated by flagItemAction / resolveFlagAction) ── */}
      {flagItem && flagState && !flagState.flag ? (
        <FlagItemModal
          key={`flag-${flagItem.id}`}
          item={flagItem}
          open
          onOpenChange={(o) => !o && setFlagState(null)}
          onSubmit={(data) => flagItemAction(flagItem.id ?? '', flagItem, data)}
        />
      ) : null}
      {flagItem && flagState && flagState.flag ? (
        <ResolveFlagModal
          key={`resolve-${flagItem.id}-${flagState.flag.id}`}
          item={flagItem}
          flag={flagState.flag}
          open
          onOpenChange={(o) => !o && setFlagState(null)}
          onSubmit={(resolution) =>
            resolveFlagAction(flagItem.id ?? '', flagItem, flagState.flag!.id ?? '', resolution)
          }
        />
      ) : null}
    </div>
  );
}

export default ManifestScreen;
