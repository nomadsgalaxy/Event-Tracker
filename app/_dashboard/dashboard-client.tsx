'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  List,
  Pencil,
  Zap,
  Bell,
  Check,
  Flag,
  Plus,
  BarChart3,
  CalendarX2,
  SearchX,
  SlidersHorizontal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  SidebarRail,
  SidebarSection,
  SidebarItem,
} from '@/components/ui/sidebar-rail';
import { ScreenHeader } from '@/components/ui/screen-header';
import { KpiStrip, KpiCard } from '@/components/ui/kpi-strip';
import { FindCommand } from '@/components/dashboard/find-command';
import { DashboardHero } from '@/components/dashboard/dashboard-hero';
import { DashboardTimeline } from '@/components/dashboard/dashboard-timeline';
import type { DashboardData } from '@/lib/types/types-dashboard';
import { FILTER_TABS, matchesFilter, toDashEvents, type DashFilter } from './dash-utils';

export interface DashboardClientProps {
  /** The full live dashboard payload (events + counts + KPIs), computed server-side. */
  data: DashboardData;
  /** Whether to surface the "New event" quick action (event.create capability). */
  canCreate: boolean;
  /** The viewer's preferred temperature unit (C/F) for the venue weather chips. */
  tempUnit?: 'C' | 'F';
}

// Map each filter id to its lucide icon (the design system is lucide-only; the icon-name strings
// from dash-utils stay data, the mapping lives here). Order mirrors FILTER_TABS / the existing app.
const FILTER_ICONS: Record<DashFilter, LucideIcon> = {
  overview: List,
  drafts: Pencil,
  active: Zap,
  upcoming: Bell,
  past: Check,
  flags: Flag,
};

// Centered empty state in a dashed block (DESIGN_SYSTEM §3 / §5: never a blank list).
function Empty({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <Icon size={28} className="text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * The re-cast Archetype-A Dashboard (DESIGN_ALIGNMENT §4.1). A contextual LEFT SidebarRail of
 * filters + quick actions, and a MAIN column: ScreenHeader → editorial hero → KPI strip → the
 * TODAY-line timeline of rich event cards.
 *
 * The server computes everything (events + counts + KPIs) off the live event→case→inventory join
 * and hands it down; this island only owns the (instant, client-side) ACTIVE FILTER + the Find
 * palette, so a keystroke / filter click never costs a round-trip while the underlying data stays
 * a real DB read. The filter logic + the catch-all/undated handling are ported from dash-utils
 * (the existing app's #91/#101 black-hole fix lives there).
 */
export default function DashboardClient({ data, canCreate, tempUnit = 'F' }: DashboardClientProps) {
  const { events, counts, kpis, year } = data;
  const [filter, setFilter] = useState<DashFilter>('overview');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  // The Find palette searches the full set (a flat DashEvent[] derived from the same timeline).
  const findEvents = useMemo(() => toDashEvents(events), [events]);

  // The active filter's membership (instant, over the already-fetched list).
  const filtered = useMemo(
    () => events.filter((e) => matchesFilter(e, filter)),
    [events, filter]
  );

  // The filter rail body — shared by the desktop SidebarRail and the mobile FilterFab Sheet.
  function FilterControls({ onPick }: { onPick?: () => void }) {
    return (
      <>
        <SidebarSection label="Filter">
          {FILTER_TABS.map((t) => (
            <SidebarItem
              key={t.id}
              icon={FILTER_ICONS[t.id]}
              count={counts[t.id]}
              active={filter === t.id}
              onClick={() => {
                setFilter(t.id);
                onPick?.();
              }}
            >
              {t.label}
            </SidebarItem>
          ))}
        </SidebarSection>

        <SidebarSection label="Quick actions">
          {canCreate ? (
            <SidebarItem icon={Plus} href="/event/new">
              New event
            </SidebarItem>
          ) : null}
          <SidebarItem icon={BarChart3} href="/reports">
            Reports
          </SidebarItem>
        </SidebarSection>
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* DESKTOP rail (Archetype A). Hidden below md, where it collapses to the FilterFab. */}
      <SidebarRail ariaLabel="Dashboard filters" className="hidden md:flex">
        <FilterControls />
      </SidebarRail>

      {/* MAIN column — own padding + scroll (the shell is full-bleed). */}
      <div className="flex min-w-0 flex-1 flex-col gap-8 overflow-y-auto px-6 py-6">
        <ScreenHeader
          eyebrow={`Operations · ${year}`}
          title={
            <span className="sr-only">Dashboard — operations {year}</span>
          }
          as="h1"
          actions={
            <>
              <FindCommand events={findEvents} />
              {canCreate ? (
                <Button asChild size="sm">
                  <Link href="/event/new">
                    <Plus size={14} aria-hidden />
                    <span>New event</span>
                  </Link>
                </Button>
              ) : null}
            </>
          }
          // The big visible headline is the editorial hero below — keep the page's <h1> as the
          // screen-reader-only context line so the heading order stays valid without a second
          // giant title competing with the hero.
          className="-mb-2"
        />

        {/* Editorial hero — "SEASON AT A GLANCE" over the two-line headline. Line 1 = the THIS-YEAR
            show count (a stable season number, NOT the filtered view size — matching the Python). */}
        <DashboardHero kpis={kpis} year={year} />

        {/* KPI strip — Active showcases / Items in motion / Open flags, each with the Python's exact
            sub-note wiring (index.html ~L15530-15533):
              • Active showcases → the per-state breakdown ("2 packing · 1 on site · …" / "no active events")
              • Items in motion  → "across N road cases" (the active road-case count)
              • Open flags       → "all clear" (0) or "N flagged item(s)" (qty-weighted), accent when >0 */}
        <KpiStrip>
          <KpiCard
            label="Active showcases"
            value={kpis.activeShowcases}
            subnote={kpis.subActive}
          />
          <KpiCard
            label="Items in motion"
            value={kpis.itemsInMotion}
            accent
            subnote={`across ${kpis.activeCaseCount} road ${
              kpis.activeCaseCount === 1 ? 'case' : 'cases'
            }`}
          />
          <KpiCard
            label="Open flags"
            value={kpis.openFlags}
            accent={kpis.openFlags > 0}
            subnote={
              kpis.openFlags === 0
                ? 'all clear'
                : `${kpis.openFlags} flagged ${kpis.openFlags === 1 ? 'item' : 'items'}`
            }
          />
        </KpiStrip>

        {/* TIMELINE — the season axis (TODAY line + responsive card cap + "+N more" overflow) + the
            not-on-timeline tail + the N-SHOWCASES active register (DESIGN_ALIGNMENT §4.1, matched 1:1
            to the Python). The component owns the relevance/visible-cap/tail math; the wholly-empty
            view (no events at all / nothing in this filter) stays here so it reads with the filter the
            sidebar set. */}
        {filtered.length === 0 ? (
          events.length === 0 ? (
            <Empty icon={CalendarX2} title="No events yet.">
              Nothing is in the database. Is MONGO_URI pointing at a database with data?
            </Empty>
          ) : (
            <Empty icon={SearchX} title="Nothing in this view.">
              Switch to Overview to see every event, including drafts. Or use Find to search across
              all {events.length} events.
            </Empty>
          )
        ) : (
          <DashboardTimeline events={filtered} isOverview={filter === 'overview'} tempUnit={tempUnit} />
        )}
      </div>

      {/* MOBILE FilterFab — the Archetype-A rail collapses to a bottom-right button → bottom Sheet
          of the SAME controls (DESIGN_ALIGNMENT §3 / §5 "Mobile filter collapse"). Sits above the
          mobile tab bar. */}
      <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
        <Button
          type="button"
          size="icon"
          onClick={() => setMobileFiltersOpen(true)}
          aria-label="Filter events"
          className="fixed right-4 bottom-20 z-40 size-12 rounded-full shadow-lg md:hidden"
        >
          <SlidersHorizontal size={18} aria-hidden />
        </Button>
        <SheetContent side="bottom" className="max-h-[80dvh] gap-0 p-0">
          <SheetHeader>
            <SheetTitle>Filter events</SheetTitle>
            <SheetDescription>
              Showing {filtered.length} of {events.length} events.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-6 overflow-y-auto px-3 pb-6">
            <FilterControls onPick={() => setMobileFiltersOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
