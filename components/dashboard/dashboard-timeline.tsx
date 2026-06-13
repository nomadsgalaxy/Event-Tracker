'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { MapPin, UserRound, Flag, ChevronRight, CalendarRange, CloudLightning } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Eyebrow } from '@/components/ui/eyebrow';
import { WeatherChip } from '@/components/ui/weather-chip';
import { TagChip } from '@/components/ui/tag-chip';
import { cn } from '@/lib/util/utils';
import type { DashTimelineEvent } from '@/lib/types/types-dashboard';
import {
  buildTimelineAxis,
  countdownLabel,
  shortRange,
  relevantTimelineEvents,
  activeShowcaseEvents,
  notInTimelineEvents,
  pickVisibleTimeline,
  todayMidnightMs,
  type AxisEvent,
} from '@/app/_dashboard/timeline-axis';

// DashboardTimeline — the re-cast timeline (DESIGN_ALIGNMENT.md §4.1, matched 1:1 to the Python app).
//
// FAITHFUL to index.html DashHybrid (~L15270-15736):
//   • the "matters today" RELEVANCE filter (drop dateless + past/closed, keep returning) decides what
//     can appear on the axis;
//   • a RESPONSIVE visible-card cap (ResizeObserver) hides surplus cards behind a "+N more — see all
//     on the calendar" link rather than scrolling (the owner's scale-to-fit timeline is preserved);
//   • visible cards are chosen in PRIORITY order (current → next → closest-to-today) then laid out
//     chronologically; the active/packing-style highlight border is the running/next event;
//   • the TODAY line re-renders every 60s so it drifts without a manual refresh;
//   • each card carries a per-event START-day WEATHER chip + a "Flair:" label with the primary-tag
//     chip;
//   • the "N SHOWCASES" register lists the ACTIVE-state events (in motion), with weather on each row;
//   • a separate tail lists the events the timeline didn't surface (undated on Overview, otherwise
//     everything left out) so a filtered tab never shows a count with an empty body.
//
// All date math is the pure, isomorphic timeline-axis helper (explicit (y,m,d) Date — never bare
// new Date('YYYY-MM-DD'), so no UTC day-shift). This is a Client Component because it owns the
// instant filter-driven re-layout + the responsive cap + the 60s drift; the DATA is the server-
// computed DashTimelineEvent[] passed down.

export interface DashboardTimelineProps {
  /** Events in the CURRENT filtered view (already filtered upstream, chronologically sorted). */
  events: DashTimelineEvent[];
  /** Whether the active filter is the Overview catch-all (changes the not-on-timeline tail rule). */
  isOverview: boolean;
  /** The viewer's preferred temperature unit (C/F) for the venue weather chips. */
  tempUnit?: 'C' | 'F';
}

// Card layout constants — mirror the Python responsive calc (min card width 140px, 8px gap).
const CARD_MIN_W = 140;
const CARD_GAP = 8;

export function DashboardTimeline({ events, isOverview, tempUnit = 'F' }: DashboardTimelineProps) {
  // Re-render every 60s so the TODAY line drifts across the active card over the day without a manual
  // refresh (Python uses Date.now() in the line position; we bump a tick to re-run the axis math).
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const today = todayMidnightMs();

  // The "matters today" set that can appear on the axis (the same predicate the Python `relevant` uses).
  const relevant = useMemo(() => relevantTimelineEvents(events, today), [events, today]);

  // Responsive visible-card cap: measure the track + fit `floor((w+gap)/(cardMin+gap))` cards.
  const trackRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(relevant.length);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const calc = () => {
      const w = el.clientWidth || 800;
      const fits = Math.max(1, Math.floor((w + CARD_GAP) / (CARD_MIN_W + CARD_GAP)));
      setVisibleCount(Math.min(fits, relevant.length));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [relevant.length]);

  const { visible: visibleShows, hiddenCount } = useMemo(
    () => pickVisibleTimeline(relevant, visibleCount, today),
    [relevant, visibleCount, today]
  );

  const axis = useMemo(() => buildTimelineAxis(visibleShows, today), [visibleShows, today]);

  // The active-event register (in-motion events in the current filter) + the not-on-timeline tail.
  const showcases = useMemo(() => activeShowcaseEvents(events), [events]);
  const notInTimeline = useMemo(
    () => notInTimelineEvents(events, relevant, isOverview),
    [events, relevant, isOverview]
  );

  const hasAxis = axis.items.length > 0;

  return (
    <section className="flex flex-col gap-8">
      {/* ── TIMELINE: header (season range right-aligned) + the date axis ───────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          {/* Just "TIMELINE" — no active-filter suffix (matches the Python header). */}
          <Eyebrow>Timeline</Eyebrow>
          <div className="h-px flex-1 bg-border" aria-hidden />
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {axis.rangeLabel || '—'}
          </span>
        </div>

        {/* The track ref measures the available width for the responsive card cap. */}
        <div ref={trackRef}>
          {hasAxis ? (
            <TimelineAxisView axis={axis} tempUnit={tempUnit} />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
              <CalendarRange size={24} className="text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium text-foreground">No dated events in this view.</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Events without a start date are listed below; give an event a date to place it on the
                season timeline.
              </p>
            </div>
          )}
        </div>

        {/* "+N more — see all on the calendar" — the responsive overflow link (Python ~L15645). The
            surplus relevant cards are HIDDEN behind this link (no horizontal scroll). */}
        {hiddenCount > 0 ? (
          <div className="text-center text-xs text-muted-foreground">
            + {hiddenCount} more {hiddenCount === 1 ? 'event' : 'events'} —{' '}
            <Link href="/calendar" className="text-primary underline underline-offset-2">
              see all on the calendar
            </Link>
          </div>
        ) : null}

        {/* Not-on-timeline tail — undated (Overview) / everything-left-out (specific filter). */}
        <NotOnTimelineList rows={notInTimeline} isOverview={isOverview} />
      </div>

      {/* ── N SHOWCASES — the ACTIVE-event register table (in-motion events only) ─────────────── */}
      <ShowcasesTable rows={showcases} highlightId={axis.highlightId} tempUnit={tempUnit} />
    </section>
  );
}

// ── the equal-width card row, a thin axis line with a status dot above each card, + the TODAY line ──
function TimelineAxisView({ axis, tempUnit = 'F' }: { axis: ReturnType<typeof buildTimelineAxis>; tempUnit?: 'C' | 'F' }) {
  const { geometry } = axis;
  const { cardW, gapW, marginW, n } = geometry;

  // Build the grid template from the SHARED geometry so the card columns line up EXACTLY with the
  // 0..1 slot fractions the dots + TODAY line are placed by:
  //   [margin] card [gap] card … card [margin]
  // Every column is `minmax(0, weight fr)` — a ZERO minimum so columns can shrink below their content
  // and the whole track ALWAYS equals the container width (fit-to-window, NEVER a horizontal scroll;
  // matches the Python version's scale-to-fit cards). The fr weights stay in the card:gap:margin
  // ratio, so the rendered column edges still match the geometry fractions at any width — the TODAY
  // line + status dots keep lining up. The grid's own `gap` is 0; spacing is the explicit gap columns.
  const col = (weight: number) => `minmax(0, ${weight}fr)`;
  const cols: string[] = [col(marginW)];
  for (let i = 0; i < n; i++) {
    cols.push(col(cardW));
    if (i < n - 1) cols.push(col(gapW));
  }
  cols.push(col(marginW));
  const gridStyle: React.CSSProperties = { gridTemplateColumns: cols.join(' ') };

  const marker = axis.todayMarker;

  return (
    <div className="relative">
      {/* The axis line, the per-card dots, the TODAY line and the card row all share one relative
          track that always equals the container width (no horizontal scroll — the cards scale to fit),
          so the dots stay centered above their cards and the TODAY marker lands at the right zoned
          position against the real card slots. */}
      <div className="pb-2">
        <div className="relative w-full pt-7">
          {/* The thin horizontal axis line. */}
          <div className="absolute inset-x-0 top-7 h-px bg-border" aria-hidden />

          {/* A status-colored dot centered ON the axis above EACH card, with a short connector tick
              dropping from the dot toward the card. Positioned by the card's slot center. */}
          {axis.items.map((item) => (
            <span key={`dot-${item.event.id}`} aria-hidden>
              {/* Connector tick: from just below the axis down to the top of the card row (pt-4=16px). */}
              <span
                className="pointer-events-none absolute top-7 w-px -translate-x-1/2 bg-border"
                style={{ left: `${item.center * 100}%`, height: 16 }}
              />
              {/* The dot, centered on the axis line. */}
              <span
                className="pointer-events-none absolute top-7 -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${item.center * 100}%` }}
              >
                <span
                  className="block size-2.5 rounded-full ring-2 ring-background"
                  style={{ background: `var(--st-${item.event.state})` }}
                />
              </span>
            </span>
          ))}

          {/* TODAY line — zoned against the real card slots (before / during / gap / after). It only
              overlaps a card in the 'during' zone, where it sweeps the card by completion fraction.
              Always shown — the owner wants this season-progress marker. */}
          {marker ? (
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-10 w-px -translate-x-1/2 bg-primary"
              style={{ left: `${marker.pos * 100}%` }}
            >
              <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.12em] text-primary">
                Today
              </span>
              <span className="absolute top-7 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" />
              <span className="sr-only">{todayMarkerLabel(marker, axis.items)}</span>
            </div>
          ) : null}

          {/* The card columns + the margin/gap spacer columns (empty), filling the row in order.
              items-stretch (not items-start) so EVERY card is the same height as the tallest in the
              row — a card with a weather chip / extra line no longer stands taller than its peers. */}
          <div className="grid items-stretch pt-4" style={gridStyle}>
            <span aria-hidden /> {/* left pre-season margin spacer */}
            {axis.items.map((item, i) => (
              <Fragment key={item.event.id}>
                <AxisCard item={item} highlight={item.event.id === axis.highlightId} tempUnit={tempUnit} />
                {i < axis.items.length - 1 ? <span aria-hidden /> : null} {/* inter-card gap spacer */}
              </Fragment>
            ))}
            <span aria-hidden /> {/* right post-season margin spacer */}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Accessible description of where the TODAY line sits, by zone. */
function todayMarkerLabel(
  marker: NonNullable<ReturnType<typeof buildTimelineAxis>['todayMarker']>,
  items: ReturnType<typeof buildTimelineAxis>['items']
): string {
  const nameAt = (i: number) => items[i]?.event.name || 'an event';
  switch (marker.zone) {
    case 'before':
      return 'Today is before the first event of the season.';
    case 'during':
      return `Today is during ${nameAt(marker.index)} — ${Math.round(marker.fraction * 100)}% through it.`;
    case 'gap':
      return `Today is between ${nameAt(marker.index)} and ${nameAt(marker.index + 1)}.`;
    case 'after':
      return 'Today is after the last event of the season.';
  }
}

// One equal-width card in the timeline row. The status dot + connector live on the shared track above
// (positioned by the card's slot center); this is just the card body, a Link to the event.
//
// The highlight border (the running/next event) maps to the Python's active/packing-state border
// (index.html ~L15595: borderColor = accent when state is packing|onsite). highlightId resolves to
// the currently-running event else the soonest upcoming — i.e. the card a packer cares about now.
function AxisCard({
  item,
  highlight,
  tempUnit = 'F',
}: {
  item: AxisEvent;
  highlight: boolean;
  tempUnit?: 'C' | 'F';
}) {
  const { event } = item;
  const cd = countdownLabel(event);

  return (
    <Link
      href={`/event/${encodeURIComponent(event.id)}`}
      // min-w-0 lets this grid item shrink below its content's intrinsic width so the column never
      // grows past its fr share — the cards scale to fit the row instead of overflowing.
      className="group min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {/*
        Card internal order — 1:1 with the Python DashHybrid card (index.html ~L15597-15640),
        top → bottom:
          (a) event NAME (bold) at the TOP
          (b) city line
          (c) the WeatherChip
          (d) the countdown ("IN 8 DAYS", orange/accent)
          (e) a flex spacer (pushes the status/flair + progress to the card bottom)
          (f) ONE row: the status pill AND "FLAIR: <chip>" together
          (g) the progress bar
          (h) the "N/M" count
      */}
      <div
        className={cn(
          'flex h-full flex-col gap-1 rounded-lg border bg-card p-3 transition-colors group-hover:bg-accent',
          highlight ? 'border-primary' : 'border-border'
        )}
      >
        {/* (a) NAME — bold, at the top. */}
        <div className="truncate text-sm font-semibold text-foreground" title={event.name}>
          {event.name || 'Untitled event'}
        </div>

        {/* (b) city. */}
        {event.city ? (
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <MapPin size={11} aria-hidden className="shrink-0" />
            <span className="truncate">{event.city}</span>
          </div>
        ) : null}

        {/* severe weather warning at the venue (next 7d / now) — red for an official NWS warning. */}
        {event.severeWeather ? (
          <div
            className={cn(
              'flex min-w-0 items-center gap-1 text-[11px] font-medium',
              event.severeWeather.official ? 'text-destructive' : 'text-warning'
            )}
          >
            <CloudLightning size={11} aria-hidden className="shrink-0" />
            <span className="truncate">{event.severeWeather.label}</span>
          </div>
        ) : null}

        {/* (c) per-event START-day weather (null/no-op until the Google Weather key is wired). */}
        {event.weather ? <WeatherChip w={event.weather} unit={tempUnit} /> : null}

        {/* (d) countdown ("IN 8 DAYS") — orange/accent when now/imminent. */}
        {cd ? (
          <div
            className={cn(
              'text-[10px] font-bold uppercase tracking-wide tabular-nums',
              cd.accent ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            {cd.label}
          </div>
        ) : null}

        {/* (e) spacer — pin the status/flair row + progress to the bottom (Python's flex:1 minHeight). */}
        <div className="min-h-[8px] flex-1" />

        {/* (f) ONE row: the status pill AND "FLAIR: <chip>" together (index.html ~L15619-15631). */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <StatusBadge state={event.state} className="text-[10px]" />
          {event.primaryTag ? (
            <>
              {/* #49: label the flair so it reads independent of the status pill. Show the FULL tag
                  (flair glyph + label), not just the bare emoji, so the dashboard reads which flair an
                  event carries and what it means. The row wraps if the label needs the room. */}
              <span className="ml-1 shrink-0 text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
                Flair:
              </span>
              <TagChip tag={event.primaryTag} />
            </>
          ) : null}
        </div>

        {/* (g) progress bar + (h) "N/M" — orange (--primary) unless flagged (--warning); NEVER green
            (the Python bar is var(--accent), not the ready/state color — index.html ~L15636). */}
        {event.total > 0 ? (
          <div className="flex flex-col gap-1 pt-0.5">
            <ProgressBar
              size="sm"
              value={event.scanned}
              total={event.total}
              label={`Packed ${event.scanned} of ${event.total}`}
              fillColor={event.flagged ? 'var(--warning)' : 'var(--primary)'}
            />
            <div className="flex min-w-0 items-center justify-between gap-1 text-[10px] text-muted-foreground">
              <span className="font-mono tabular-nums">
                {event.scanned}/{event.total}
              </span>
              {event.flagged ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-warning">
                  <Flag size={10} aria-hidden />
                  flagged
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="pt-0.5 text-[10px] text-muted-foreground">Manifest not started</div>
        )}
      </div>
    </Link>
  );
}

// ── the "N SHOWCASES" compact CSS-grid pseudo-table (DESIGN_ALIGNMENT.md §5: app data = grid table
// with an eyebrow header row + hairline dividers). Lists the ACTIVE-state events (in motion) — the
// Python register (index.html ~L15672-15736). ───────────────────────────────────────────────────
function ShowcasesTable({
  rows,
  highlightId,
  tempUnit = 'F',
}: {
  rows: DashTimelineEvent[];
  highlightId: string | null;
  tempUnit?: 'C' | 'F';
}) {
  const cols =
    'minmax(0,2.4fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,0.9fr) minmax(0,1.6fr) 24px';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" aria-hidden />
        <span className="font-mono text-xs tabular-nums uppercase tracking-wide text-muted-foreground">
          {rows.length} {rows.length === 1 ? 'showcase' : 'showcases'}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-xs text-muted-foreground">
          No active showcases right now.
        </div>
      ) : (
        <div role="table" aria-label="Showcases" className="flex flex-col">
          {/* Eyebrow column-header row. */}
          <div
            role="row"
            className="hidden gap-3 border-b border-border px-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid"
            style={{ gridTemplateColumns: cols }}
          >
            <span role="columnheader">Event</span>
            <span role="columnheader">Dates</span>
            <span role="columnheader">Lead</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Packed</span>
            <span role="columnheader" className="sr-only">
              Open
            </span>
          </div>

          {rows.map((s) => (
            <ShowcaseRow key={s.id} event={s} cols={cols} highlight={s.id === highlightId} tempUnit={tempUnit} />
          ))}
        </div>
      )}
    </div>
  );
}

function ShowcaseRow({
  event,
  cols,
  highlight,
  tempUnit = 'F',
}: {
  event: DashTimelineEvent;
  cols: string;
  highlight: boolean;
  tempUnit?: 'C' | 'F';
}) {
  const pct = event.total > 0 ? Math.round((event.scanned / event.total) * 100) : 0;
  const fill = event.flagged
    ? 'var(--warning)'
    : pct >= 100
      ? 'var(--st-ready)'
      : 'var(--primary)';
  const range = event.startDate ? shortRange(event.startDate, event.endDate) : 'No date';

  return (
    <Link
      href={`/event/${encodeURIComponent(event.id)}`}
      role="row"
      aria-label={`${event.name || 'Untitled event'} — open event`}
      className={cn(
        // Mobile: a single stacked column. sm+: the shared grid-template (cols) from the header row.
        'grid grid-cols-1 items-center gap-x-3 gap-y-1.5 border-b border-border px-1 py-3 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 sm:gap-y-0 sm:[grid-template-columns:var(--cols)]',
        highlight && 'border-l-2 border-l-primary pl-2'
      )}
      style={{ ['--cols' as string]: cols } as React.CSSProperties}
    >
      {/* Event name + city + start-day weather. */}
      <div role="cell" className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-foreground">{event.name || 'Untitled event'}</span>
          {event.severeWeather ? (
            <span
              className={cn('inline-flex shrink-0 items-center', event.severeWeather.official ? 'text-destructive' : 'text-warning')}
              title={`${event.severeWeather.label} — ${event.severeWeather.official ? 'severe weather warning' : 'rough weather'}`}
            >
              <CloudLightning size={13} aria-hidden />
            </span>
          ) : null}
        </div>
        {event.city || event.weather ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {event.city ? (
              <span className="flex min-w-0 items-center gap-1">
                <MapPin size={11} aria-hidden className="shrink-0" />
                <span className="truncate">{event.city}</span>
              </span>
            ) : null}
            {event.weather ? <WeatherChip w={event.weather} unit={tempUnit} /> : null}
          </div>
        ) : null}
      </div>

      {/* Dates. */}
      <div role="cell" className="font-mono text-xs tabular-nums text-muted-foreground">
        {range}
      </div>

      {/* Lead. */}
      <div role="cell" className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        {event.lead ? (
          <>
            <UserRound size={11} aria-hidden className="shrink-0" />
            <span className="truncate">{event.lead}</span>
          </>
        ) : (
          <span aria-hidden>—</span>
        )}
      </div>

      {/* Status. */}
      <div role="cell">
        <StatusBadge state={event.state} />
      </div>

      {/* Progress. */}
      <div role="cell" className="flex items-center gap-2">
        {event.total > 0 ? (
          <>
            <ProgressBar
              size="sm"
              value={event.scanned}
              total={event.total}
              label={`Packed ${event.scanned} of ${event.total}`}
              fillColor={fill}
              className="flex-1"
            />
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              {event.scanned}/{event.total}
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground" aria-hidden>
            —
          </span>
        )}
      </div>

      {/* Open chevron (sm+ only — the whole row is the link on mobile). */}
      <div role="cell" className="hidden justify-end text-muted-foreground sm:flex">
        <ChevronRight size={16} aria-hidden />
      </div>
    </Link>
  );
}

// ── the "events not on the timeline" tail — undated (Overview) / everything-left-out (specific
// filter), so a filtered tab never shows a count with an empty body (Python ~L15651-15669). ───────
function NotOnTimelineList({
  rows,
  isOverview,
}: {
  rows: DashTimelineEvent[];
  isOverview: boolean;
}) {
  if (rows.length === 0) return null;
  const heading = `${rows.length} ${rows.length === 1 ? 'event' : 'events'} ${
    isOverview ? 'without a date' : 'not on the timeline'
  }`;

  return (
    <div className="flex flex-col gap-2">
      <Eyebrow>{heading}</Eyebrow>
      <div className="flex flex-col gap-1.5">
        {rows.map((s) => (
          <Link
            key={s.id}
            href={`/event/${encodeURIComponent(s.id)}`}
            className="flex items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {s.name || 'Untitled event'}
              {s.city ? <span className="font-normal text-muted-foreground"> · {s.city}</span> : null}
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {s.startDate ? shortRange(s.startDate, s.endDate) : 'no date'}
            </span>
            <StatusBadge state={s.state} className="shrink-0 text-[10px]" />
          </Link>
        ))}
      </div>
    </div>
  );
}

export default DashboardTimeline;
