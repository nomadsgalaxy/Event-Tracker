'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { cn } from '@/lib/utils';
import { WeatherChip } from '@/components/ui/weather-chip';
import { TagChip } from '@/components/ui/tag-chip';
import { SegmentChip } from '@/components/calendar/segment-chip';
import {
  buildMonthBars,
  buildSegmentIndex,
  dayWeather,
  eventTags,
  MONTHS,
  type CalEvent,
  type MonthGrid,
  WEEKDAYS,
} from '@/app/calendar/cal-utils';
import type { DashTag } from '@/lib/types-dashboard';

// MonthView — the 6×7 ARIA month grid, upgraded to 1:1 parity with index.html CalMonth (~L22990):
//   • multi-day event BARS, lane-packed, spanning days + broken at week boundaries (buildMonthBars),
//     rendered as an absolute overlay per week row with inline tag chips (heuristic cap by span);
//   • per-day logistics SEGMENT chips (pickup/setup/teardown/return, colored, +N overflow);
//   • a per-day weather chip (first covering event);
//   • dynamic row height + bar vertical offset when a row carries logistics chips;
//   • day-cell click → Week view at that week (onPickWeek).
//
// Accessibility is preserved from the original: role="grid"/"gridcell", roving tabindex (one tabbable
// cell), arrow keys move between cells, Home/End jump to row ends, PageUp/PageDown change month, and
// Enter/Space opens the focused day's Week view. The bars are an aria-hidden visual overlay (their
// events are reachable via the day cell → Week view, and via the schedule/quick-jump lists) so the
// grid keeps a clean cell-by-cell reading order.
//
// Date math is on integer (y, m0, d) tuples + day keys (never new Date('YYYY-MM-DD')).

const eventHref = (id: string) => `/event/${encodeURIComponent(id)}`;

export interface MonthViewProps {
  grid: MonthGrid;
  /** The cursor month (for cell aria-labels). */
  month0: number;
  /** All calendar events (segments/bars can extend outside this month). */
  events: CalEvent[];
  /** Visible tag directory (id → DashTag) for the bar tag chips. */
  tagById: Map<string, DashTag>;
  /** Change month by ±1 (PageUp / PageDown inside the grid). */
  onStep: (delta: number) => void;
  /** Drill into Week view for (month0, day) — a day-cell click / Enter. */
  onPickWeek: (month0: number, day: number) => void;
}

export function MonthView({ grid, month0, events, tagById, onStep, onPickWeek }: MonthViewProps) {
  const router = useRouter();
  const gridRef = useRef<HTMLDivElement>(null);
  const { year } = grid;

  // Lane-packed bars per week row + the segment index over the whole visible month.
  const barRows = useMemo(() => buildMonthBars(year, month0, events), [year, month0, events]);
  const monthFirstDow = new Date(year, month0, 1).getDay();
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const segIdx = useMemo(
    () =>
      buildSegmentIndex(
        events,
        { year, month0, day: 1 },
        { year, month0, day: daysInMonth },
      ),
    [events, year, month0, daysInMonth],
  );
  // Events whose show window intersects this month (for the per-day weather pick).
  const monthEvents = useMemo(() => {
    const lo = grid.cells.find((c) => c.inMonth)?.key ?? '';
    const hiCell = [...grid.cells].reverse().find((c) => c.inMonth);
    const hi = hiCell?.key ?? '';
    return events.filter((e) => e.start && (!lo || e.start <= hi) && (!hi || (e.end || e.start) >= lo));
  }, [events, grid.cells]);

  // Roving focus — one tabbable cell. Reset to today (if visible) or the 1st on month change.
  const [focusIdx, setFocusIdx] = useState<number>(() => {
    const i = grid.cells.findIndex((c) => c.isToday);
    return i >= 0 ? i : grid.cells.findIndex((c) => c.inMonth);
  });
  useEffect(() => {
    const i = grid.cells.findIndex((c) => c.isToday);
    setFocusIdx(i >= 0 ? i : grid.cells.findIndex((c) => c.inMonth));
  }, [grid]);

  const focusCell = useCallback((idx: number) => {
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-cell-idx="${idx}"]`);
    el?.focus();
  }, []);

  const onCellKeyDown = useCallback(
    (e: React.KeyboardEvent, idx: number, cellDay: number | null) => {
      let next = idx;
      switch (e.key) {
        case 'ArrowRight':
          next = Math.min(41, idx + 1);
          break;
        case 'ArrowLeft':
          next = Math.max(0, idx - 1);
          break;
        case 'ArrowDown':
          next = Math.min(41, idx + 7);
          break;
        case 'ArrowUp':
          next = Math.max(0, idx - 7);
          break;
        case 'Home':
          next = idx - (idx % 7);
          break;
        case 'End':
          next = idx - (idx % 7) + 6;
          break;
        case 'PageUp':
          e.preventDefault();
          onStep(-1);
          return;
        case 'PageDown':
          e.preventDefault();
          onStep(1);
          return;
        case 'Enter':
        case ' ':
          if (cellDay) {
            e.preventDefault();
            onPickWeek(month0, cellDay);
          }
          return;
        default:
          return;
      }
      e.preventDefault();
      setFocusIdx(next);
      focusCell(next);
    },
    [focusCell, onStep, onPickWeek, month0],
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div role="grid" aria-label={`Calendar for ${grid.label}`} ref={gridRef}>
        {/* Weekday header row. */}
        <div role="row" className="grid grid-cols-7 border-b border-border bg-muted/30">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              role="columnheader"
              className="border-r border-border px-2 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground last:border-r-0"
            >
              <span className="hidden sm:inline">{d}</span>
              <span className="sm:hidden" aria-hidden>
                {d.slice(0, 1)}
              </span>
              <span className="sr-only sm:hidden">{d}</span>
            </div>
          ))}
        </div>

        {/* 6 week rows. Each row is a relative grid (the day cells) with an absolute bar overlay. */}
        {Array.from({ length: 6 }).map((_, row) => {
          const rowCells = grid.cells.slice(row * 7, row * 7 + 7);
          if (rowCells.every((c) => !c.inMonth)) return null;

          const { bars, laneCount } = barRows[row];
          // Push bars down when any cell in this row has a logistics chip strip (the strip adds
          // height below the day number) — mirrors the Python's rowHasChips offset.
          const rowHasChips = rowCells.some((c) => c.inMonth && segIdx.has(c.key));
          const barOffset = rowHasChips ? 44 : 28;
          const rowMinHeight = Math.max(96, (rowHasChips ? 48 : 32) + laneCount * 22 + 8);

          return (
            <div
              role="row"
              key={row}
              className={cn('relative grid grid-cols-7', row < 5 && 'border-b border-border')}
              style={{ minHeight: rowMinHeight }}
            >
              {rowCells.map((cell, col) => {
                const idx = row * 7 + col;
                const isPad = !cell.inMonth;
                if (isPad) {
                  return (
                    <div
                      key={idx}
                      role="gridcell"
                      aria-disabled
                      className="border-r border-border bg-muted/20 last:border-r-0"
                    />
                  );
                }
                const cellSegs = segIdx.get(cell.key) ?? [];
                const cellWeather = dayWeather(monthEvents, cell.key);
                return (
                  <div
                    key={idx}
                    role="gridcell"
                    data-cell-idx={idx}
                    tabIndex={focusIdx === idx ? 0 : -1}
                    aria-current={cell.isToday ? 'date' : undefined}
                    aria-label={`${MONTHS[month0]} ${cell.day}${
                      cell.events.length
                        ? `, ${cell.events.length} ${cell.events.length === 1 ? 'event' : 'events'}`
                        : ', no events'
                    }`}
                    onKeyDown={(e) => onCellKeyDown(e, idx, cell.day)}
                    onFocus={() => setFocusIdx(idx)}
                    onClick={() => cell.day && onPickWeek(month0, cell.day)}
                    className={cn(
                      'cursor-pointer border-r border-border p-1.5 outline-none last:border-r-0',
                      'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
                      cell.isToday && 'bg-primary/15 ring-2 ring-inset ring-primary',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-1">
                      <span
                        className={cn(
                          'font-mono text-xs leading-4 tabular-nums',
                          cell.isToday ? 'font-bold text-primary' : 'font-medium text-muted-foreground',
                        )}
                      >
                        {cell.day}
                      </span>
                      {cellWeather ? <WeatherChip w={cellWeather} /> : null}
                    </div>
                    {cellSegs.length > 0 ? (
                      <span className="relative z-[2] mt-0.5 flex flex-wrap gap-0.5">
                        {cellSegs.slice(0, 6).map((seg, si) => (
                          <SegmentChip key={si} seg={seg} compact />
                        ))}
                        {cellSegs.length > 6 ? (
                          <span className="text-[9px] font-bold text-muted-foreground">
                            +{cellSegs.length - 6}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                );
              })}

              {/* Event bar overlay (aria-hidden — the day cells + schedule/quick-jump carry the
                  accessible event entry points). */}
              {bars.map((b, i) => {
                const fg = `var(--st-${b.ev.state})`;
                const tags = eventTags(b.ev, tagById);
                // Heuristic chip cap: 1-day = 0, 2-day = 1, 3-day = 2, … hard cap 4.
                const chipCap = Math.min(4, Math.max(0, b.span - 1));
                const chips = tags.slice(0, chipCap);
                const barH = 20;
                const barTop = barOffset + b.lane * 22;
                // aria-hidden VISUAL overlay (a <div>, NOT a <button>, so the navigating tag chips
                // inside can be real <button>s without a button-in-button — invalid HTML → the
                // hydration error). The accessible event entry point is the day cell (→ Week view) +
                // the schedule/quick-jump lists, so the bar is skipped in the a11y tree like the
                // Python's decorative-redundant bars; it stays mouse-interactive (click → event,
                // chip → tag, matching CalMonth).
                return (
                  <div
                    key={`${b.ev.id}-${row}-${i}`}
                    aria-hidden
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(eventHref(b.ev.id));
                    }}
                    title={`${b.ev.name}${b.ev.city ? ` · ${b.ev.city}` : ''}`}
                    className="absolute flex cursor-pointer items-center gap-1 overflow-hidden rounded-[3px] text-[11px] font-medium text-foreground outline-none"
                    style={{
                      top: barTop,
                      left: `calc(${(b.col / 7) * 100}% + 2px)`,
                      width: `calc(${(b.span / 7) * 100}% - 4px)`,
                      height: barH,
                      lineHeight: `${barH - 2}px`,
                      background: `color-mix(in oklch, ${fg} 14%, transparent)`,
                      border: `1px solid ${fg}`,
                      padding: '0 8px',
                    }}
                  >
                    <span className="shrink-0 text-[8px]" style={{ color: fg }}>
                      ●
                    </span>
                    <span className="min-w-0 flex-1 truncate">{b.ev.name}</span>
                    {chips.length > 0 ? (
                      // DISPLAY-ONLY (no onClick → <span>, non-focusable): the bar is an aria-hidden
                      // decorative overlay, so a focusable <button> here would be both focusable-
                      // content-inside-aria-hidden (an a11y violation) AND redundant. Tag → /tag
                      // navigation stays on the schedule/quick-jump/week-block/event-detail surfaces.
                      <span className="flex shrink-0 gap-0.5">
                        {chips.map((tag) => (
                          <TagChip key={tag.id} tag={tag} compact />
                        ))}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default MonthView;
