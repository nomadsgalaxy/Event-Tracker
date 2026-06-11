'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw } from 'lucide-react';

import { cn } from '@/lib/util/utils';
import { WeatherChip } from '@/components/ui/weather-chip';
import { TagChip } from '@/components/ui/tag-chip';
import { SegmentChip } from '@/components/calendar/segment-chip';
import {
  buildSegmentIndex,
  buildTravelIndex,
  dayHourSegments,
  eventTags,
  fmtHour,
  HOURS,
  HOUR_HEIGHT,
  HOUR_START,
  HOUR_END,
  initialsOf,
  parseTime,
  SEGMENT_COLORS,
  SEGMENT_LABEL,
  type CalEvent,
  type WeekGrid,
} from '@/app/calendar/cal-utils';
import type { DashTag } from '@/lib/types/types-dashboard';

// WeekView — the HOUR GRID (7am–9pm) with timed event/setup/teardown blocks (DESIGN_ALIGNMENT §4.2;
// faithful port of index.html CalWeek ~L23161). Each day column is a relative hour grid: the show
// runs doorsOpen→doorsClose, setup runs before, teardown after — stacked vertically full-width (they
// never run in parallel). The per-day header carries a ✈ travel ribbon (staff initials), all-day
// pickup/arrival segment chips, and a weather chip. Event blocks show the time range + name + city +
// weather + up to 3 tag chips and link to the event.
//
// Responsive: the visible day-column count is 3 (mobile) / 5 (tablet) / 7 (desktop) via
// useCalViewport (threaded down from the client); the « ‹ › » header cluster pages by ±day / ±week
// so any day is still reachable. In mobile portrait the parent shows a "Rotate for week view" hint.
//
// Date math is on integer (y, m0, d) tuples + 'YYYY-MM-DD' day keys, never new Date('YYYY-MM-DD').

const eventHref = (id: string) => `/event/${encodeURIComponent(id)}`;

export interface WeekViewProps {
  grid: WeekGrid;
  /** All calendar events (segments/travel can land outside the week's show windows). */
  events: CalEvent[];
  /** Visible tag directory (id → DashTag) for the event-block tag chips. */
  tagById: Map<string, DashTag>;
  /** Visible day-column count: 3 mobile / 5 tablet / 7 desktop. */
  dayCount: number;
  /** True in mobile portrait → render the "rotate" hint card above the grid. */
  isPortraitMobile: boolean;
}

export function WeekView({ grid, events, tagById, dayCount, isPortraitMobile }: WeekViewProps) {
  const router = useRouter();

  // grid.days is already the visible window (built with the responsive dayCount + snap=false in the
  // client), so render it directly. The header nav (‹‹ ‹ › ››) slides the window by day/week.
  const days = grid.days;
  const first = days[0];
  const last = days[days.length - 1];

  // Segment + travel indexes over the visible window (inclusive bounds).
  const fromTuple = { year: first.year, month0: first.month0, day: first.day };
  const toTuple = { year: last.year, month0: last.month0, day: last.day };
  const travelIdx = useMemo(
    () => buildTravelIndex(events, fromTuple, toTuple),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, first.key, last.key],
  );
  const segIdx = useMemo(
    () => buildSegmentIndex(events, fromTuple, toTuple),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, first.key, last.key],
  );

  // Events whose show window intersects this week (for the per-day weather pick).
  const weekEvents = useMemo(
    () => events.filter((e) => e.start && e.start <= last.key && (e.end || e.start) >= first.key),
    [events, first.key, last.key],
  );

  const totalHeight = (HOUR_END - HOUR_START) * HOUR_HEIGHT;
  const gridCols = `70px repeat(${dayCount}, minmax(0, 1fr))`;
  // On mobile, keep each column legible by enforcing a min total width (horizontal scroll).
  const minWidth = isPortraitMobile ? 700 : undefined;

  return (
    <div>
      {isPortraitMobile ? (
        <div
          className="mb-3 flex items-center gap-2.5 rounded-lg border bg-card px-3.5 py-3"
          style={{ borderColor: 'var(--primary)' }}
        >
          <RotateCcw size={18} className="text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-foreground">Rotate for week view</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              The hour grid is best in landscape. Scroll horizontally for now, or pick Year / Month
              from the top.
            </div>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        {/* Header row: dates + weather + pickup/arrival chips + travel ribbon. */}
        <div
          className="grid border-b border-border bg-muted/30"
          style={{ gridTemplateColumns: gridCols, minWidth }}
        >
          <div />
          {days.map((d) => {
            const travelers = travelIdx.get(d.key) ?? [];
            // Only pickup + arrival render as all-day header chips; setup/teardown are hour blocks.
            const headerSegs = (segIdx.get(d.key) ?? []).filter(
              (s) => s.id === 'pickup' || s.id === 'return',
            );
            // First event covering this day that has cached weather.
            let dayW = null;
            for (const ev of weekEvents) {
              if (d.key < ev.start || d.key > (ev.end || ev.start)) continue;
              const w = ev.weather[d.key];
              if (w) {
                dayW = w;
                break;
              }
            }
            return (
              <div
                key={d.key}
                className={cn('border-l border-border px-3 pb-1.5 pt-2.5', d.isToday && 'bg-primary/15')}
              >
                <div className="flex items-baseline justify-between">
                  <span
                    className={cn(
                      'text-[11px] font-medium uppercase tracking-wide',
                      d.isToday ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {d.weekday}
                  </span>
                  <span
                    className={cn(
                      'font-mono text-lg font-semibold tabular-nums',
                      d.isToday ? 'text-primary' : 'text-foreground',
                    )}
                  >
                    {d.day}
                  </span>
                </div>
                {dayW ? (
                  <div className="mt-1">
                    <WeatherChip w={dayW} />
                  </div>
                ) : null}
                {headerSegs.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-0.5">
                    {headerSegs.map((seg, si) => (
                      <SegmentChip key={si} seg={seg} compact={false} />
                    ))}
                  </div>
                ) : null}
                {travelers.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-0.5">
                    {travelers.map((t, ti) => {
                      const alert = t.staff.flightAlert;
                      const bg = alert === 'cancelled' ? 'var(--destructive)' : alert === 'delayed' ? 'var(--st-packing)' : 'var(--st-upcoming)';
                      const who = t.staff.name || t.staff.email;
                      const title = alert
                        ? `${who}: flight ${alert} — ${t.event.name}`
                        : `${who} traveling for ${t.event.name}`;
                      return (
                        <span
                          key={ti}
                          title={title}
                          className="inline-flex cursor-help items-center gap-0.5 rounded-[2px] px-1 text-[8px] font-bold leading-3 text-white"
                          style={{ background: bg }}
                        >
                          {alert ? '⚠' : '✈'} {initialsOf(t.staff)}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Hour grid. */}
        <div className="grid" style={{ gridTemplateColumns: gridCols, minWidth }}>
          {/* Hour rail. */}
          <div className="relative">
            {HOURS.slice(0, -1).map((h) => (
              <div
                key={h}
                className="border-b border-border/60 bg-muted/20 px-2 pt-0.5 text-right font-mono text-[10px] text-muted-foreground"
                style={{ height: HOUR_HEIGHT }}
              >
                {fmtHour(h)}
              </div>
            ))}
          </div>

          {days.map((d) => {
            const evs = d.events;
            const dtSegs = dayHourSegments(events, d.key);
            return (
              <div
                key={d.key}
                className={cn(
                  'relative border-l border-border',
                  d.isToday && 'border-l-2 border-l-primary bg-primary/10',
                )}
                style={{ height: totalHeight }}
              >
                {HOURS.slice(0, -1).map((h) => (
                  <div key={h} className="border-b border-border/60" style={{ height: HOUR_HEIGHT }} />
                ))}

                {/* Setup / teardown hour blocks. */}
                {dtSegs.map((seg, si) => {
                  const start = parseTime(seg.startTime, HOUR_START);
                  const end = parseTime(seg.endTime, HOUR_END);
                  const top = (Math.max(start, HOUR_START) - HOUR_START) * HOUR_HEIGHT;
                  const height =
                    (Math.min(end, HOUR_END) - Math.max(start, HOUR_START)) * HOUR_HEIGHT - 2;
                  if (height <= 0) return null;
                  const color = SEGMENT_COLORS[seg.id];
                  const label = SEGMENT_LABEL[seg.id];
                  const isCompact = height < 36;
                  return (
                    <button
                      key={`seg-${si}`}
                      type="button"
                      onClick={() => router.push(eventHref(seg.event.id))}
                      title={`${label} · ${seg.event.name}`}
                      className={cn(
                        'absolute overflow-hidden rounded-[3px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                        isCompact ? 'flex items-center gap-1.5' : 'flex flex-col',
                      )}
                      style={{
                        top,
                        left: 4,
                        right: 4,
                        height,
                        background: `${color}22`,
                        border: `1px solid ${color}`,
                        borderLeft: `3px solid ${color}`,
                        padding: isCompact ? '0 6px' : '4px 6px',
                      }}
                    >
                      <span
                        className="shrink-0 font-mono font-bold uppercase tracking-wider"
                        style={{ fontSize: 9, color }}
                      >
                        {label}
                      </span>
                      <span
                        className={cn(
                          'min-w-0 truncate font-medium text-foreground',
                          isCompact ? 'flex-1' : 'mt-px',
                        )}
                        style={{ fontSize: 10, lineHeight: isCompact ? '14px' : 1.2 }}
                      >
                        {seg.event.name}
                      </span>
                    </button>
                  );
                })}

                {/* Show blocks (doorsOpen → doorsClose). */}
                {evs.map((ev, ei) => {
                  const start = parseTime(ev.doorsOpen, 9);
                  const end = parseTime(ev.doorsClose, 17);
                  const top = (start - HOUR_START) * HOUR_HEIGHT;
                  const height = (end - start) * HOUR_HEIGHT - 2;
                  const fg = `var(--st-${ev.state})`;
                  const w = ev.weather[d.key];
                  const tags = eventTags(ev, tagById);
                  const goEvent = () => router.push(eventHref(ev.id));
                  // role="button" div (NOT a <button>) so the navigating tag chips inside are real
                  // <button>s without a button-in-button (invalid HTML → the hydration error).
                  return (
                    <div
                      key={ev.id + '-' + ei}
                      role="button"
                      tabIndex={0}
                      aria-label={`${ev.name || 'Untitled event'} — open event`}
                      onClick={goEvent}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          goEvent();
                        }
                      }}
                      className="absolute cursor-pointer overflow-hidden rounded-[3px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      style={{
                        top,
                        left: 4,
                        right: 4,
                        height: Math.max(height, 0),
                        background: `color-mix(in oklch, ${fg} 14%, transparent)`,
                        border: `1px solid ${fg}`,
                        borderLeft: `3px solid ${fg}`,
                        padding: '5px 8px',
                      }}
                    >
                      <div className="font-mono text-muted-foreground" style={{ fontSize: 9, letterSpacing: '.04em' }}>
                        {fmtHour(Math.floor(start))} – {fmtHour(Math.floor(end))}
                      </div>
                      <div className="mt-0.5 text-[11px] font-semibold leading-tight text-foreground">
                        {ev.name}
                      </div>
                      {ev.city ? (
                        <div className="mt-px text-[10px] text-muted-foreground">{ev.city}</div>
                      ) : null}
                      {w ? (
                        <div className="mt-0.5">
                          <WeatherChip w={w} />
                        </div>
                      ) : null}
                      {tags.length > 0 ? (
                        <div className="mt-0.5 flex flex-wrap gap-0.5">
                          {tags.slice(0, 3).map((tag) => (
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
                          {tags.length > 3 ? (
                            <span className="text-[9px] font-bold text-muted-foreground">
                              +{tags.length - 3}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default WeekView;
