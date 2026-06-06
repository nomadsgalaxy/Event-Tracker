'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  CalendarDays,
  CalendarOff,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Grid3x3,
  MapPin,
  Plus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { SidebarRail, SidebarSection, SidebarItem } from '@/components/ui/sidebar-rail';
import { ScreenHeader } from '@/components/ui/screen-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { Eyebrow } from '@/components/ui/eyebrow';
import type { DashTag } from '@/lib/types/types-dashboard';
import { TagChip } from '@/components/ui/tag-chip';
import { MonthView } from '@/components/calendar/month-view';
import { YearView } from '@/components/calendar/year-view';
import { WeekView } from '@/components/calendar/week-view';
import { SchedulePanel } from '@/components/calendar/schedule-panel';
import { useCalViewport } from '@/components/calendar/use-cal-viewport';
import {
  activeEvents,
  addDaysYmd,
  addMonths,
  buildMonthGrid,
  buildWeekGrid,
  buildYearGrid,
  type CalEvent,
  type CalEventInput,
  type CalView,
  eventTags,
  MONTHS,
  MONTHS_SHORT,
  monthKey,
  startOfWeek,
  toCalEvent,
  todayKey,
  undatedEvents,
  yearScheduleEvents,
} from './cal-utils';

export interface CalendarClientProps {
  /** The full, live event list — rich projection (logistics + tags + weather), sorted server-side. */
  events: CalEventInput[];
  /** The VISIBLE tag directory the chips resolve against (id → DashTag). */
  tags: DashTag[];
  /** The month to render first (year, 0-based month) — resolved server-side from ?month= or now. */
  initialYear: number;
  initialMonth0: number;
  /** The view to render first — resolved server-side from ?view= (defaults to year). */
  initialView: CalView;
  /** Whether to surface the "New event" action (event.create capability). */
  canCreate: boolean;
}

const eventHref = (id: string) => `/event/${encodeURIComponent(id)}`;

const VIEW_OPTS: { id: CalView; label: string; icon: LucideIcon }[] = [
  { id: 'year', label: 'Year', icon: Grid3x3 },
  { id: 'month', label: 'Month', icon: CalendarDays },
  { id: 'week', label: 'Week', icon: CalendarRange },
];

/**
 * The interactive Year / Month / Week CALENDAR, re-cast to Archetype A (DESIGN_ALIGNMENT §4.2). A
 * contextual LEFT rail (VIEW switch · QUICK-JUMP active events · Jump to today), a ScreenHeader
 * (eyebrow "Calendar · <range>" → "Season schedule" → the prev/next range nav + New), and the
 * selected view in the main pane — Year (12 mini-months + a right-side "<year> SCHEDULE" panel),
 * Month (the existing 6×7 ARIA grid), or Week (a 7-day strip).
 *
 * The server fetches the live event list + the initial view/month; this island owns ALL view + range
 * navigation entirely client-side (a switch / prev / next never costs a round-trip) while keeping the
 * URL's ?view= and ?month= in sync (shallow replace) so the view is shareable and survives a refresh.
 */
export default function CalendarClient({
  events,
  tags,
  initialYear,
  initialMonth0,
  initialView,
  canCreate,
}: CalendarClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const vp = useCalViewport();

  const [view, setView] = useState<CalView>(initialView);
  // The cursor: the focused (year, month0, day). For a Week deep-link, snap day to that month's first
  // Sunday so the strip opens on a week boundary (matches the Python's startOfWeek seed); otherwise
  // the 1st seeds Month/Year (day is unused there).
  const [cursor, setCursor] = useState(() => {
    if (initialView === 'week') {
      const w = startOfWeek(initialYear, initialMonth0, 1);
      return { year: w.year, month0: w.month0, day: w.day };
    }
    return { year: initialYear, month0: initialMonth0, day: 1 };
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // 'today' is recomputed on mount so the highlighted cell is correct after hydration (the server
  // render used its own clock). A state value (not a render-time call) keeps it stable per session.
  const [today, setToday] = useState(() => todayKey());
  useEffect(() => setToday(todayKey()), []);

  const calEvents = useMemo<CalEvent[]>(() => events.map(toCalEvent), [events]);
  // The visible tag directory the chips resolve against (id → DashTag).
  const tagById = useMemo(() => {
    const m = new Map<string, DashTag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);
  const undated = useMemo(() => undatedEvents(calEvents), [calEvents]);
  const quickJump = useMemo(() => activeEvents(calEvents, 8), [calEvents]);

  // Per-view derived data — only the active view's structure is built.
  const monthGrid = useMemo(
    () => buildMonthGrid(cursor.year, cursor.month0, calEvents, today),
    [cursor.year, cursor.month0, calEvents, today],
  );
  const yearMonths = useMemo(
    () => buildYearGrid(cursor.year, calEvents, today),
    [cursor.year, calEvents, today],
  );
  const yearSchedule = useMemo(
    () => yearScheduleEvents(cursor.year, calEvents),
    [cursor.year, calEvents],
  );
  // Week strip: render exactly vp.dayCount days from the cursor (snap=false). The cursor is snapped
  // to a Sunday when ENTERING week view (pickDay / quick-jump / goToday); the ‹/› day-nav then slides
  // the visible window day-by-day — the Python's CalWeek weekStart-slide behavior on narrow widths.
  const weekGrid = useMemo(
    () => buildWeekGrid(cursor.year, cursor.month0, cursor.day, calEvents, today, vp.dayCount, false),
    [cursor.year, cursor.month0, cursor.day, calEvents, today, vp.dayCount],
  );

  // The header range label, per view (mirrors the existing app's rangeLabel).
  const rangeLabel = useMemo(() => {
    if (view === 'year') return String(cursor.year);
    if (view === 'month') return `${MONTHS[cursor.month0]} ${cursor.year}`;
    return weekGrid.label;
  }, [view, cursor.year, cursor.month0, weekGrid.label]);

  // Keep ?view= + ?month= in sync without a navigation/scroll (shallow replace). Skips the first run
  // so a deep-linked URL isn't clobbered on mount.
  const firstSync = useRef(true);
  useEffect(() => {
    if (firstSync.current) {
      firstSync.current = false;
      return;
    }
    const key = monthKey(cursor.year, cursor.month0);
    router.replace(`${pathname}?view=${view}&month=${key}`, { scroll: false });
  }, [view, cursor.year, cursor.month0, pathname, router]);

  // ── Navigation ──────────────────────────────────────────────────────────────────────────────
  const stepMonth = useCallback((delta: number) => {
    setCursor((c) => {
      const m = addMonths(c.year, c.month0, delta);
      return { ...c, year: m.year, month0: m.month0 };
    });
  }, []);

  const stepYear = useCallback((delta: number) => {
    setCursor((c) => ({ ...c, year: c.year + delta }));
  }, []);

  const stepDays = useCallback((delta: number) => {
    setCursor((c) => {
      const d = addDaysYmd(c.year, c.month0, c.day, delta);
      return { year: d.year, month0: d.month0, day: d.day };
    });
  }, []);

  // The active view's prev/next handlers (Year ±year, Month ±month, Week's inner ‹ › = ±1 day, like
  // the Python's navWeekDays(±1) — the window slides day-by-day; the outer ‹‹ ›› page ±7).
  const stepBack = useCallback(() => {
    if (view === 'year') stepYear(-1);
    else if (view === 'month') stepMonth(-1);
    else stepDays(-1);
  }, [view, stepYear, stepMonth, stepDays]);

  const stepFwd = useCallback(() => {
    if (view === 'year') stepYear(1);
    else if (view === 'month') stepMonth(1);
    else stepDays(1);
  }, [view, stepYear, stepMonth, stepDays]);

  // Jump to today. Snap the day to this week's Sunday so the Week view opens Sun..Sat (the Python's
  // goToday → startOfWeek(today)); year/month read only year/month0, so the snap is harmless there.
  const goToday = useCallback(() => {
    const now = new Date();
    const w = startOfWeek(now.getFullYear(), now.getMonth(), now.getDate());
    setCursor({ year: w.year, month0: w.month0, day: w.day });
  }, []);

  const isToday = useMemo(() => {
    if (view === 'year') return String(cursor.year) === today.slice(0, 4);
    if (view === 'month') return today.startsWith(monthKey(cursor.year, cursor.month0));
    return weekGrid.days.some((d) => d.key === today);
  }, [view, cursor.year, cursor.month0, today, weekGrid.days]);

  // Drill-downs from the Year view: a month → Month view, a day → Week view.
  const pickMonth = useCallback((month0: number) => {
    setCursor((c) => ({ ...c, month0, day: 1 }));
    setView('month');
  }, []);

  // Drill into Week view from a day click (Year mini-month / Month cell): snap the cursor to that
  // day's Sunday so the desktop week opens Sun..Sat (the Python's startOfWeek on day-click), then the
  // ‹/› day-nav can slide from there.
  const pickDay = useCallback((month0: number, day: number) => {
    setCursor((c) => {
      const w = startOfWeek(c.year, month0, day);
      return { year: w.year, month0: w.month0, day: w.day };
    });
    setView('week');
  }, []);

  // Quick-jump: focus the event's start week + open Week view.
  const jumpToEvent = useCallback((ev: CalEvent) => {
    if (!ev.start) return;
    const [y, m, d] = ev.start.split('-').map(Number);
    const w = startOfWeek(y, m - 1, d);
    setCursor({ year: w.year, month0: w.month0, day: w.day });
    setView('week');
    setMobileNavOpen(false);
  }, []);

  // The rail body — shared by the desktop SidebarRail and the mobile nav Sheet.
  function RailControls({ onPick }: { onPick?: () => void }) {
    return (
      <>
        <SidebarSection label="View">
          {VIEW_OPTS.map((v) => (
            <SidebarItem
              key={v.id}
              icon={v.icon}
              active={view === v.id}
              onClick={() => {
                setView(v.id);
                onPick?.();
              }}
            >
              {v.label}
            </SidebarItem>
          ))}
        </SidebarSection>

        <SidebarSection label="Quick jump">
          {quickJump.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">No active shows.</p>
          ) : (
            quickJump.map((ev) => {
              const token = `var(--st-${ev.state})`;
              const [, m, d] = (ev.start || '--').split('-');
              const dateLabel = ev.start
                ? `${MONTHS_SHORT[Number(m) - 1]} ${Number(d)}`
                : 'Undated';
              const qjTags = eventTags(ev, tagById);
              const disabled = !ev.start;
              // role="button" div (NOT a <button>) so the navigating tag chips inside are real
              // <button>s without nesting a button in a button (invalid HTML → the hydration error).
              // Keyboard-reachable: tabIndex + Enter/Space → jump to the event's week.
              return (
                <div
                  key={ev.id}
                  role="button"
                  tabIndex={disabled ? -1 : 0}
                  aria-disabled={disabled || undefined}
                  aria-label={`Jump to ${ev.name || 'Untitled event'}`}
                  onClick={disabled ? undefined : () => jumpToEvent(ev)}
                  onKeyDown={
                    disabled
                      ? undefined
                      : (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            jumpToEvent(ev);
                          }
                        }
                  }
                  className="group/qj flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 aria-disabled:cursor-default aria-disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-[10px] text-muted-foreground tabular-nums">
                      {dateLabel}
                    </span>
                    <span className="block truncate text-xs text-foreground">
                      {ev.name || 'Untitled event'}
                    </span>
                    {qjTags.length > 0 ? (
                      <span className="mt-1 flex flex-wrap items-center gap-0.5">
                        {qjTags.slice(0, 3).map((tag) => (
                          <TagChip
                            key={tag.id}
                            tag={tag}
                            compact
                            onClick={(e) => {
                              e.stopPropagation();
                              router.push(`/tag/${encodeURIComponent(tag.id)}`);
                            }}
                          />
                        ))}
                        {qjTags.length > 3 ? (
                          <span className="text-[9px] font-bold text-muted-foreground">
                            +{qjTags.length - 3}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className="mt-1 size-1.5 shrink-0 rounded-full"
                    style={{ background: token }}
                    aria-hidden
                  />
                </div>
              );
            })
          )}
        </SidebarSection>

        <div className="mt-auto pt-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => {
              goToday();
              onPick?.();
            }}
            disabled={isToday}
          >
            Jump to today
          </Button>
        </div>
      </>
    );
  }

  // The header range-nav cluster: Week gets ‹‹ ‹ › ›› (page ±week / ±day); Year/Month get ‹ ›.
  const navCluster = (
    <div className="flex items-center gap-1">
      {view === 'week' ? (
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => stepDays(-7)}
          aria-label="Previous week"
        >
          <ChevronsLeft aria-hidden />
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="icon-sm"
        onClick={stepBack}
        aria-label={view === 'year' ? 'Previous year' : view === 'month' ? 'Previous month' : 'Previous day'}
      >
        <ChevronLeft aria-hidden />
      </Button>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={stepFwd}
        aria-label={view === 'year' ? 'Next year' : view === 'month' ? 'Next month' : 'Next day'}
      >
        <ChevronRight aria-hidden />
      </Button>
      {view === 'week' ? (
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => stepDays(7)}
          aria-label="Next week"
        >
          <ChevronsRight aria-hidden />
        </Button>
      ) : null}
    </div>
  );

  const newEventAction = canCreate ? (
    <Button asChild size="sm">
      <Link href="/event/new">
        <Plus size={14} aria-hidden />
        <span>New event</span>
      </Link>
    </Button>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1">
      {/* DESKTOP rail (Archetype A). Hidden below md, where it collapses to a top bar + Sheet. */}
      <SidebarRail ariaLabel="Calendar views" className="hidden md:flex">
        <RailControls />
      </SidebarRail>

      {/* MAIN column — own padding + scroll (the shell is full-bleed). */}
      <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
        {/* DESKTOP header — eyebrow → "Season schedule" → range nav + New, all on the title row. */}
        <ScreenHeader
          className="hidden md:flex"
          eyebrow={`Calendar · ${rangeLabel}`}
          title="Season schedule"
          actions={
            <>
              {navCluster}
              {newEventAction}
            </>
          }
        />

        {/* MOBILE / TABLET top bar — view dropdown stand-in (a Sheet trigger) + centered range +
            nav arrows + New (mirrors the existing app's mobile top bar). */}
        <div className="flex items-center gap-2 md:hidden">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMobileNavOpen(true)}
            aria-haspopup="dialog"
            className="gap-1.5"
          >
            {(() => {
              const Icon = VIEW_OPTS.find((v) => v.id === view)?.icon ?? Grid3x3;
              return <Icon size={14} aria-hidden />;
            })()}
            <span>{VIEW_OPTS.find((v) => v.id === view)?.label}</span>
          </Button>
          <span
            className="min-w-0 flex-1 truncate text-center font-mono text-xs text-muted-foreground tabular-nums"
            aria-live="polite"
          >
            {rangeLabel}
          </span>
          {navCluster}
        </div>

        {/* The selected view. */}
        {view === 'year' ? (
          <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
            <YearView
              months={yearMonths}
              focusMonth0={cursor.month0}
              onPickMonth={pickMonth}
              onPickDay={pickDay}
            />
            <SchedulePanel year={cursor.year} events={yearSchedule} tagById={tagById} />
          </div>
        ) : view === 'month' ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <Eyebrow asChild>
                <h2 aria-live="polite">{monthGrid.label}</h2>
              </Eyebrow>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {monthGrid.monthEventCount}{' '}
                {monthGrid.monthEventCount === 1 ? 'event' : 'events'}
              </span>
            </div>
            <MonthView
              grid={monthGrid}
              month0={cursor.month0}
              events={calEvents}
              tagById={tagById}
              onStep={stepMonth}
              onPickWeek={pickDay}
            />
          </div>
        ) : (
          <WeekView
            grid={weekGrid}
            events={calEvents}
            tagById={tagById}
            dayCount={vp.dayCount}
            isPortraitMobile={vp.isPortraitMobile}
          />
        )}

        {/* Undated events — surfaced in their own list so a dateless event is never dropped (mirrors
            the dashboard's undated tail). Shown on every view. */}
        {undated.length > 0 ? (
          <section aria-labelledby="cal-undated" className="flex flex-col gap-2">
            <h3
              id="cal-undated"
              className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              <CalendarOff size={13} aria-hidden />
              {undated.length} undated {undated.length === 1 ? 'event' : 'events'}
            </h3>
            <div className="flex flex-wrap gap-2">
              {undated.map((ev) => (
                <Link
                  key={ev.id}
                  href={eventHref(ev.id)}
                  className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <Card
                    size="sm"
                    className="flex-row items-center gap-2 px-3 py-2 transition-colors hover:bg-accent"
                  >
                    <span className="truncate text-sm font-medium text-foreground">
                      {ev.name || 'Untitled event'}
                    </span>
                    {ev.city ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <MapPin size={12} aria-hidden />
                        <span className="truncate">{ev.city}</span>
                      </span>
                    ) : null}
                    <StatusBadge state={ev.state} className="ml-1 shrink-0" />
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {/* MOBILE nav Sheet — the Archetype-A rail (View · Quick jump · Jump to today) in a bottom
          sheet, opened from the mobile top bar's view button. */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="bottom" className="max-h-[80dvh] gap-0 p-0">
          <SheetHeader>
            <SheetTitle>Calendar</SheetTitle>
            <SheetDescription>Switch view or jump to an active show.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-6 overflow-y-auto px-3 pb-6">
            <RailControls onPick={() => setMobileNavOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      {/* MOBILE "New event" FAB — sits above the mobile tab bar (mirrors the dashboard FilterFab
          placement). */}
      {canCreate ? (
        <Button
          asChild
          size="icon"
          aria-label="New event"
          className="fixed right-4 bottom-20 z-40 size-12 rounded-full shadow-lg md:hidden"
        >
          <Link href="/event/new">
            <Plus size={18} aria-hidden />
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
