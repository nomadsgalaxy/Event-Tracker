'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Boxes,
  CalendarRange,
  ShieldAlert,
  Users,
  Download,
  Star,
} from 'lucide-react';
import { StarRating } from '@/components/ui/star-rating';

import { cn } from '@/lib/util/utils';
import { Button } from '@/components/ui/button';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Eyebrow } from '@/components/ui/eyebrow';
import { KpiStrip, KpiCard } from '@/components/ui/kpi-strip';
import { StatusBadge } from '@/components/ui/status-badge';
import { TabStrip, type TabStripItem } from '@/components/ui/tab-strip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatWeight, type WeightUnit } from '@/lib/util/weight';
import type {
  InventoryReport,
  InvKindRow,
  EventsReport,
  ConditionReport,
  PeopleReport,
  FeedbackReport,
} from '@/lib/views/reports';
import { formatMoney } from '@/lib/util/money';

// reports-screen.tsx — the client island for the Reports screen. Owns the active tab (controlled
// TabStrip, the #93-safe all-panels-mounted pattern) mirrored to a sessionStorage key + the global
// "Export CSV" header action (exports the active tab's PRIMARY table) and every per-section CSV
// button. Every section renders a real compact <table> (Reports is THE real-table screen — §5):
// dense, text-sm body / text-xs meta, tabular-nums on every number, hairline row dividers, hover.
//
// All data is computed on the server (lib/reports) and handed down as plain rows — this island is
// presentation + export only (no business logic, no fetching), so the numbers can never drift from
// the catalog/manifest math that produced them.

const TAB_STORAGE_KEY = 'eit:reportsTab';

// ── A compact, reusable report table (the §5 "one real <table>" role) ───────────────────────
// Generic over the row type R; `key` is a real key of R (typo-checked at compile time) used both as
// the React key and the default cell accessor. Cells with non-primitive content supply `render`.
interface Col<R> {
  key: keyof R & string;
  label: string;
  /** Right-align + mono tabular (quantities/dates). */
  num?: boolean;
  /** Emphasize as the row's primary cell (foreground, medium). */
  strong?: boolean;
  /** Capitalize the value (kind / mode). */
  cap?: boolean;
  /** Custom cell renderer. */
  render?: (row: R) => React.ReactNode;
}

// A row value rendered without a custom `render`: only primitive (string/number) cells use the
// default path, so coerce safely to a ReactNode (null/undefined -> em dash).
function defaultCell(v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  return typeof v === 'number' ? v : String(v);
}

function ReportTable<R>({
  cols,
  rows,
  empty,
  caption,
}: {
  cols: Col<R>[];
  rows: R[];
  empty: string;
  caption?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="grid place-items-center rounded-lg border border-dashed border-border px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">{empty}</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <Table className="text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {cols.map((c) => (
              <TableHead
                key={c.key}
                className={cn(
                  'h-9 bg-muted/40 text-xs font-medium uppercase tracking-wide text-muted-foreground',
                  c.num && 'text-right'
                )}
                scope="col"
              >
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {cols.map((c) => {
                const raw = c.render ? c.render(row) : defaultCell(row[c.key]);
                return (
                  <TableCell
                    key={c.key}
                    className={cn(
                      'py-2',
                      c.num && 'text-right font-mono tabular-nums',
                      c.strong && 'font-medium text-foreground',
                      c.cap && 'capitalize'
                    )}
                  >
                    {raw}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── A section header: eyebrow + optional sub + a right-aligned per-section CSV export ───────
function SectionHead({
  label,
  sub,
  onExport,
}: {
  label: string;
  sub?: string;
  onExport?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
      <div className="flex flex-col gap-0.5">
        <Eyebrow asChild>
          <h2>{label}</h2>
        </Eyebrow>
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      </div>
      {onExport ? (
        <Button variant="ghost" size="sm" onClick={onExport}>
          <Download size={14} aria-hidden />
          CSV
        </Button>
      ) : null}
    </div>
  );
}

// A small stat chip (events-by-state / flags-by-category) — eyebrow over a big tabular number.
function StatChip({
  label,
  value,
  tone,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-2.5">
      <Eyebrow>{label}</Eyebrow>
      <div
        className="mt-0.5 font-mono text-xl font-semibold tabular-nums leading-none text-foreground"
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

// ── CSV download (RFC-4180 quoting + a UTF-8 BOM so Excel reads it right) ────────────────────
function downloadCsv(name: string, headers: string[], rows: (string | number)[][]): void {
  const esc = (v: string | number): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type TabId = 'inventory' | 'events' | 'condition' | 'people' | 'feedback';

export function ReportsScreen({
  inventory,
  events,
  condition,
  people,
  feedback,
  weightUnit,
}: {
  inventory: InventoryReport;
  events: EventsReport;
  condition: ConditionReport;
  people: PeopleReport;
  feedback: FeedbackReport;
  /** The viewer's preferred weight unit (unitPrefs.weight) — every mass is rendered through
   *  formatWeight() so it honors kg/lbs instead of a hardcoded unit (#11/#12). */
  weightUnit: WeightUnit;
}) {
  const [tab, setTab] = React.useState<TabId>('inventory');

  // Format a canonical-kg weight in the viewer's unit (kg|lbs) — the one mass formatter the whole
  // screen uses, so a displayed weight never drifts from the value that produced it.
  const fmtWt = React.useCallback((kg: number) => formatWeight(kg, weightUnit), [weightUnit]);

  // Restore the last-viewed tab from sessionStorage (mirrors the existing editor's evTab key) so a
  // refresh / nav-back lands on the same section. A ?tab= query param wins over the saved tab so
  // other screens can deep-link a section (e.g. the Event Report's "All scorecards" →
  // /reports?tab=feedback). Read in an effect to stay SSR-safe.
  React.useEffect(() => {
    const valid = ['inventory', 'events', 'condition', 'people', 'feedback'];
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('tab');
      if (fromUrl && valid.includes(fromUrl)) {
        setTab(fromUrl as TabId);
        sessionStorage.setItem(TAB_STORAGE_KEY, fromUrl);
        return;
      }
      const saved = sessionStorage.getItem(TAB_STORAGE_KEY) as TabId | null;
      if (saved && valid.includes(saved)) setTab(saved);
    } catch {
      /* sessionStorage unavailable — keep the default */
    }
  }, []);

  const pickTab = React.useCallback((id: string) => {
    const t = id as TabId;
    setTab(t);
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  }, []);

  // The global header "Export CSV" exports the ACTIVE tab's primary table, so the one button always
  // does the obvious thing for whatever section is on screen.
  const exportActive = React.useCallback(() => {
    switch (tab) {
      case 'inventory':
        return downloadCsv(
          'inventory-by-kind',
          ['Kind', 'Rows', 'Deployed', 'In storage', 'Total', 'Weight (kg)'],
          inventory.kinds.map((k) => [k.kind, k.rows, k.deployed, k.storage, k.total, Math.round(k.weightKg * 10) / 10])
        );
      case 'events':
        return downloadCsv(
          'events-summary',
          ['Event', 'State', 'Start', 'Items', 'Cases', 'Ship wt (kg)'],
          events.perEvent.map((e) => [e.name, e.state, e.startDate, e.items, e.cases, Math.round(e.shippingKg * 10) / 10])
        );
      case 'condition':
        return downloadCsv(
          'damage-by-item',
          ['Item', 'Kind', 'Open flags', 'Damaged', 'Missing', 'Incidents'],
          condition.perItem.map((r) => [r.name, r.kind, r.openFlags, r.damaged, r.missing, r.incidents])
        );
      case 'people':
        return downloadCsv(
          'staff-assignments',
          ['Name', 'Email', 'Events'],
          people.assignments.map((a) => [a.name, a.email, a.events])
        );
      case 'feedback':
        return downloadCsv(
          'event-feedback',
          ['Event', 'Start', 'City', 'Responses', 'Roster', 'Rate %', 'Event ★', 'Venue ★', 'Hotel ★'],
          feedback.perEvent.map((r) => [r.name, r.startDate, r.city, r.responses, r.rosterSize, r.responseRate, r.event ?? '', r.venue ?? '', r.hotel ?? ''])
        );
    }
  }, [tab, inventory, events, condition, people, feedback]);

  // ── Tab panels ────────────────────────────────────────────────────────────────────────────
  const inventoryPanel = (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <SectionHead
          label="Utilization"
          sub={`${inventory.totalStock.toLocaleString()} units · ${fmtWt(inventory.totalWeightKg)} total inventory weight${
            inventory.totalAssetValue > 0 ? ` · ${formatMoney(inventory.totalAssetValue)} asset value` : ''
          }`}
        />
        <KpiStrip>
          <KpiCard
            label="Deployed"
            value={`${inventory.utilizationPct}%`}
            subnote={`${inventory.totalDeployed.toLocaleString()} of ${inventory.totalStock.toLocaleString()} units in the field`}
            accent
          />
          <KpiCard
            label="In storage"
            value={inventory.totalStorage.toLocaleString()}
            subnote="units available to deploy"
          />
          <KpiCard
            label="Out of service"
            value={inventory.oosCount.toLocaleString()}
            subnote={`${inventory.itemCount.toLocaleString()} inventory rows`}
            valueClassName={inventory.oosCount ? 'text-warning' : undefined}
          />
        </KpiStrip>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead
          label="Deployed vs in-storage by kind"
          onExport={() =>
            downloadCsv(
              'inventory-by-kind',
              ['Kind', 'Rows', 'Deployed', 'In storage', 'Total', 'Weight (kg)', 'Asset value ($)'],
              inventory.kinds.map((k) => [k.kind, k.rows, k.deployed, k.storage, k.total, Math.round(k.weightKg * 10) / 10, Math.round(k.assetValue * 100) / 100])
            )
          }
        />
        <ReportTable
          empty="No inventory."
          rows={inventory.kinds}
          cols={[
            { key: 'kind', label: 'Kind', strong: true, cap: true },
            { key: 'rows', label: 'Rows', num: true },
            { key: 'deployed', label: 'Deployed', num: true },
            { key: 'storage', label: 'In storage', num: true },
            { key: 'total', label: 'Total', num: true },
            { key: 'weightKg', label: 'Weight', num: true, render: (r) => fmtWt(r.weightKg) },
            ...(inventory.totalAssetValue > 0
              ? [{ key: 'assetValue' as const, label: 'Value', num: true, render: (r: InvKindRow) => (r.assetValue > 0 ? formatMoney(r.assetValue) : '—') }]
              : []),
          ]}
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead
          label={`Low stock · ${inventory.lowStock.length}`}
          sub="In-storage quantity below the reorder point."
          onExport={
            inventory.lowStock.length
              ? () =>
                  downloadCsv(
                    'low-stock',
                    ['Item', 'Kind', 'In storage', 'Reorder point', 'Short by'],
                    inventory.lowStock.map((r) => [r.name, r.kind, r.storage, r.reorderPoint, r.deficit])
                  )
              : undefined
          }
        />
        <ReportTable
          empty="All items at or above their reorder point."
          rows={inventory.lowStock}
          cols={[
            { key: 'name', label: 'Item', strong: true },
            { key: 'kind', label: 'Kind', cap: true },
            { key: 'storage', label: 'In storage', num: true },
            { key: 'reorderPoint', label: 'Reorder pt', num: true },
            {
              key: 'deficit',
              label: 'Short by',
              num: true,
              render: (r) => <span style={{ color: 'var(--warning)' }}>{r.deficit}</span>,
            },
          ]}
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead
          label={`Idle items · ${inventory.idle.length}`}
          sub="Never routed to a case and not currently deployed."
          onExport={
            inventory.idle.length
              ? () =>
                  downloadCsv(
                    'idle-items',
                    ['Item', 'Kind', 'In storage'],
                    inventory.idle.map((r) => [r.name, r.kind, r.storage])
                  )
              : undefined
          }
        />
        <ReportTable
          empty="Every item has been cased at least once."
          rows={inventory.idle}
          cols={[
            { key: 'name', label: 'Item', strong: true },
            { key: 'kind', label: 'Kind', cap: true },
            { key: 'storage', label: 'In storage', num: true },
          ]}
        />
      </div>
    </div>
  );

  const eventsPanel = (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <SectionHead label={`Events by state · ${events.eventCount} total`} />
        {events.byState.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {events.byState.map((s) => (
              <StatChip
                key={s.state}
                label={<StatusBadge state={s.state} className="border-0 px-0 py-0" />}
                value={s.count}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead
          label="Per-event summary"
          sub="Items, cases and total shipping weight per event."
          onExport={() =>
            downloadCsv(
              'events-summary',
              ['Event', 'State', 'Start', 'Items', 'Cases', 'Ship wt (kg)'],
              events.perEvent.map((e) => [e.name, e.state, e.startDate, e.items, e.cases, Math.round(e.shippingKg * 10) / 10])
            )
          }
        />
        <ReportTable
          empty="No events."
          rows={events.perEvent}
          cols={[
            { key: 'name', label: 'Event', strong: true },
            { key: 'state', label: 'State', render: (r) => <StatusBadge state={r.state} /> },
            { key: 'startDate', label: 'Start', num: true, render: (r) => r.startDate || '—' },
            { key: 'items', label: 'Items', num: true },
            { key: 'cases', label: 'Cases', num: true },
            { key: 'shippingKg', label: 'Ship wt', num: true, render: (r) => (r.shippingKg ? fmtWt(r.shippingKg) : '—') },
          ]}
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead
          label="Case utilization"
          sub="Most-to-least assigned road cases."
          onExport={() =>
            downloadCsv(
              'case-utilization',
              ['Case', 'Events used', 'Items inside', 'Deployed now'],
              events.caseUtil.map((c) => [c.label, c.events, c.contentsQty, c.deployed ? 'yes' : 'no'])
            )
          }
        />
        <ReportTable
          empty="No cases."
          rows={events.caseUtil}
          cols={[
            { key: 'label', label: 'Case', strong: true },
            { key: 'events', label: 'Events used', num: true },
            { key: 'contentsQty', label: 'Items inside', num: true },
            {
              key: 'deployed',
              label: 'Status',
              render: (r) =>
                r.deployed ? (
                  <span className="text-primary">Deployed</span>
                ) : (
                  <span className="text-muted-foreground">In storage</span>
                ),
            },
          ]}
        />
      </div>

      <p className="text-xs italic text-muted-foreground">
        On-time-return / avg-days-to-reconcile omitted: events don&rsquo;t carry per-event
        close/reconcile timestamps, so it can&rsquo;t be computed cleanly.
      </p>
    </div>
  );

  const conditionPanel = (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <SectionHead label={`Open flags by category · ${condition.openFlagTotal} total`} />
        {condition.flagsByCategory.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm" style={{ color: 'var(--success)' }}>
            No open flags.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {condition.flagsByCategory.map((f) => (
              <StatChip key={f.category} label={<span className="capitalize">{f.category}</span>} value={f.count} tone="var(--warning)" />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead
          label="Damage & loss by item"
          sub="Open flags plus return dispositions signed damaged / missing."
          onExport={
            condition.perItem.length
              ? () =>
                  downloadCsv(
                    'damage-by-item',
                    ['Item', 'Kind', 'Open flags', 'Damaged', 'Missing', 'Incidents'],
                    condition.perItem.map((r) => [r.name, r.kind, r.openFlags, r.damaged, r.missing, r.incidents])
                  )
              : undefined
          }
        />
        <ReportTable
          empty="No damage, loss or open flags on record."
          rows={condition.perItem}
          cols={[
            { key: 'name', label: 'Item', strong: true },
            { key: 'kind', label: 'Kind', cap: true },
            { key: 'openFlags', label: 'Open flags', num: true },
            { key: 'damaged', label: 'Damaged', num: true },
            { key: 'missing', label: 'Missing', num: true },
            { key: 'incidents', label: 'Total', num: true, render: (r) => <span style={{ color: 'var(--warning)' }}>{r.incidents}</span> },
          ]}
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead
          label={`Never-returned / shrinkage · ${condition.closedCount} closed event${condition.closedCount === 1 ? '' : 's'}`}
          sub="Units still packed or signed missing on events that are already closed."
          onExport={
            condition.shrink.length
              ? () =>
                  downloadCsv(
                    'shrinkage',
                    ['Item', 'Qty', 'Event', 'Reason', 'Est. loss ($)'],
                    condition.shrink.map((r) => [r.itemName, r.qty, r.eventName, r.reason, r.dollarsLost || 0])
                  )
              : undefined
          }
        />
        {condition.shrink.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm" style={{ color: 'var(--success)' }}>
            No shrinkage — every closed event reconciled cleanly.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {/* Line / unit summary header — N lines (left) vs total units lost + estimated $ (right). */}
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2.5">
              <Eyebrow>
                {condition.shrink.length} line{condition.shrink.length === 1 ? '' : 's'}
              </Eyebrow>
              <span className="flex items-baseline gap-2 font-mono text-xs tabular-nums" style={{ color: 'var(--warning)' }}>
                {condition.shrinkDollars > 0 ? <span className="font-semibold">{formatMoney(condition.shrinkDollars)}</span> : null}
                <span>{condition.shrinkUnits} unit{condition.shrinkUnits === 1 ? '' : 's'}</span>
              </span>
            </div>
            {condition.shrink.map((s, i) => (
              <div
                key={i}
                className={cn(
                  'flex items-center gap-2.5 px-4 py-2',
                  i ? 'border-t border-border' : ''
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">
                    {s.qty > 1 ? `×${s.qty} ${s.itemName}` : s.itemName}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {s.eventName} · {s.reason}
                  </div>
                </div>
                {s.dollarsLost > 0 ? (
                  <span className="shrink-0 font-mono text-xs tabular-nums" style={{ color: 'var(--warning)' }}>
                    {formatMoney(s.dollarsLost)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const peoplePanel = (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <SectionHead label="Accommodations / PII" />
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
          {people.accGateActive ? (
            <span>
              You can view accommodation profiles for{' '}
              <strong className="text-foreground">{people.accVisible.toLocaleString()}</strong> assigned
              staffer{people.accVisible === 1 ? '' : 's'};{' '}
              <strong>{people.accGated.toLocaleString()}</strong> {people.accGated === 1 ? 'is' : 'are'}{' '}
              hidden by privacy rules. Open an event to view permitted profiles.
            </span>
          ) : (
            <span>
              Accommodation/medical details are private and shown per-event only to permitted viewers.
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead label={`Lead-coverage gaps · ${people.leadGaps.length}`} sub="Events with no lead assigned."
          onExport={
            people.leadGaps.length
              ? () =>
                  downloadCsv(
                    'lead-gaps',
                    ['Event', 'State', 'Staff'],
                    people.leadGaps.map((r) => [r.name, r.state, r.staffCount])
                  )
              : undefined
          }
        />
        <ReportTable
          empty="Every event has a lead assigned."
          rows={people.leadGaps}
          cols={[
            { key: 'name', label: 'Event', strong: true },
            { key: 'state', label: 'State', render: (r) => <StatusBadge state={r.state} /> },
            { key: 'staffCount', label: 'Staff', num: true },
          ]}
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead
          label="Staff assignments"
          sub="How many events each person is assigned to."
          onExport={
            people.assignments.length
              ? () =>
                  downloadCsv(
                    'staff-assignments',
                    ['Name', 'Email', 'Events'],
                    people.assignments.map((a) => [a.name, a.email, a.events])
                  )
              : undefined
          }
        />
        <ReportTable
          empty="No staff assigned to any event."
          rows={people.assignments}
          cols={[
            { key: 'name', label: 'Name', strong: true },
            { key: 'email', label: 'Email', render: (r) => r.email || '—' },
            { key: 'events', label: 'Events', num: true },
          ]}
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead
          label={`Travel roster · ${people.travel.length}`}
          sub="Who is going where and when (accommodations excluded)."
          onExport={
            people.travel.length
              ? () =>
                  downloadCsv(
                    'travel-roster',
                    ['Event', 'Start', 'Person', 'Mode', 'Outbound', 'Return'],
                    people.travel.map((t) => [t.eventName, t.startDate, t.person, t.mode, t.outbound, t.return])
                  )
              : undefined
          }
        />
        {/* The roster rows are gated PER (event, staffer) server-side (lib/reports → canSeeStaffPii):
            a staffer the viewer can't see is never serialized here, so this list already contains
            ONLY visible itineraries — no client-side hiding of withheld PII. */}
        <ReportTable
          empty="No travel itineraries on file."
          rows={people.travel}
          cols={[
            { key: 'eventName', label: 'Event', strong: true },
            { key: 'startDate', label: 'Start', num: true, render: (r) => r.startDate || '—' },
            { key: 'person', label: 'Person' },
            { key: 'mode', label: 'Mode', cap: true },
            { key: 'outbound', label: 'Outbound', render: (r) => r.outbound || '—' },
            { key: 'return', label: 'Return', render: (r) => r.return || '—' },
          ]}
        />
      </div>
    </div>
  );

  // ── Feedback / event reviews panel ─────────────────────────────────────────────────────────
  // The cross-event rollup of the post-event surveys. Rows are pre-gated server-side (manager+ or
  // lead-of-event only — the same verdict as the per-event Event Report this deep-links to);
  // comments/notes stay on the per-event page.
  const stars = (v: number | null, label: string) =>
    v != null ? (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono tabular-nums">{v}</span>
        <StarRating value={Math.round(v)} size={12} label={label} />
      </span>
    ) : (
      '—'
    );
  const feedbackPanel = (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <SectionHead
          label="Survey topline"
          sub={`${feedback.responses.toLocaleString()} responses across ${feedback.perEvent.length.toLocaleString()} reviewed event${feedback.perEvent.length === 1 ? '' : 's'}${
            feedback.gatedEvents ? ` · ${feedback.gatedEvents} more visible only to their leads/managers` : ''
          }`}
        />
        <KpiStrip>
          <KpiCard
            label="Response rate"
            value={`${feedback.responseRate}%`}
            subnote={`${feedback.responses.toLocaleString()} of ${feedback.rosterTotal.toLocaleString()} staffed spots`}
            accent
          />
          <KpiCard label="Event avg" value={feedback.avg.event != null ? `${feedback.avg.event} ★` : '—'} subnote="all ratings, all events" />
          <KpiCard label="Venue avg" value={feedback.avg.venue != null ? `${feedback.avg.venue} ★` : '—'} subnote="all ratings, all events" />
          <KpiCard label="Hotel avg" value={feedback.avg.hotel != null ? `${feedback.avg.hotel} ★` : '—'} subnote="survey + editor-set stay ratings" />
        </KpiStrip>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead
          label={`Event scorecards · ${feedback.perEvent.length}`}
          sub="Every ended or reviewed event you may see — open one for comments, exports and the AI summary."
          onExport={
            feedback.perEvent.length
              ? () =>
                  downloadCsv(
                    'event-feedback',
                    ['Event', 'Start', 'City', 'Responses', 'Roster', 'Rate %', 'Event ★', 'Venue ★', 'Hotel ★'],
                    feedback.perEvent.map((r) => [r.name, r.startDate, r.city, r.responses, r.rosterSize, r.responseRate, r.event ?? '', r.venue ?? '', r.hotel ?? ''])
                  )
              : undefined
          }
        />
        <ReportTable
          empty={
            feedback.gatedEvents
              ? 'No reviewed events visible to you — event reports are visible to their leads and managers.'
              : 'No ended events yet. Scorecards appear here once events wrap and the team submits feedback.'
          }
          rows={feedback.perEvent}
          cols={[
            {
              key: 'name',
              label: 'Event',
              strong: true,
              render: (r) => (
                <Link href={`/event/${encodeURIComponent(r.id)}/report`} className="text-primary underline-offset-4 hover:underline">
                  {r.name}
                </Link>
              ),
            },
            { key: 'startDate', label: 'Start', num: true, render: (r) => r.startDate || '—' },
            { key: 'city', label: 'City' },
            {
              key: 'responses',
              label: 'Responses',
              num: true,
              render: (r) => (
                <span>
                  {r.responses}/{r.rosterSize}
                  <span className="ml-1 text-xs text-muted-foreground">({r.responseRate}%)</span>
                </span>
              ),
            },
            { key: 'event', label: 'Event', num: true, render: (r) => stars(r.event, `${r.name} event rating`) },
            { key: 'venue', label: 'Venue', num: true, render: (r) => stars(r.venue, `${r.name} venue rating`) },
            { key: 'hotel', label: 'Hotel', num: true, render: (r) => stars(r.hotel, `${r.name} hotel rating`) },
          ]}
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionHead
          label={`Hotels · ${feedback.hotels.length}`}
          sub="Every hotel the team has stayed at, ranked by stay rating — the same history that powers the booking suggestions in the event editor."
          onExport={
            feedback.hotels.length
              ? () =>
                  downloadCsv(
                    'hotel-leaderboard',
                    ['Hotel', 'City', 'Rating', 'Raters', 'Stays', 'Last stay'],
                    feedback.hotels.map((h) => [h.name, h.city, h.rating ?? '', h.raters, h.stays, h.lastStay])
                  )
              : undefined
          }
        />
        <ReportTable
          empty="No hotel stays on file yet."
          rows={feedback.hotels}
          cols={[
            { key: 'name', label: 'Hotel', strong: true },
            { key: 'city', label: 'City' },
            { key: 'rating', label: 'Rating', num: true, render: (r) => stars(r.rating, `${r.name} rating`) },
            { key: 'raters', label: 'Raters', num: true },
            { key: 'stays', label: 'Stays', num: true },
            { key: 'lastStay', label: 'Last stay', num: true, render: (r) => r.lastStay || '—' },
          ]}
        />
      </div>
    </div>
  );

  const tabs: TabStripItem[] = [
    { id: 'inventory', label: 'Inventory & stock', icon: Boxes, content: inventoryPanel },
    { id: 'events', label: 'Events & cases', icon: CalendarRange, content: eventsPanel },
    { id: 'condition', label: 'Condition & loss', icon: ShieldAlert, content: conditionPanel },
    { id: 'people', label: 'People & travel', icon: Users, content: peoplePanel },
    { id: 'feedback', label: 'Feedback & reviews', icon: Star, content: feedbackPanel },
  ];

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
      <ScreenHeader
        eyebrow="Operations · Reports"
        title="Reports"
        subtitle="Live operational reports across inventory, events, condition and people. Export any section to CSV."
        actions={
          <Button variant="outline" size="sm" onClick={exportActive}>
            <Download size={16} aria-hidden />
            Export CSV
          </Button>
        }
      />

      <TabStrip
        items={tabs}
        value={tab}
        onValueChange={pickTab}
        ariaLabel="Report sections"
        contentClassName="pt-1"
      />
    </div>
  );
}

export default ReportsScreen;
