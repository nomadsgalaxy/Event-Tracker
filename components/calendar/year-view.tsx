'use client';

import { cn } from '@/lib/util/utils';
import { CAL_DOW_S, type MiniMonth } from '@/app/calendar/cal-utils';

// YearView — the grid of 12 mini-month calendars (DESIGN_ALIGNMENT §4.2 "YEAR = a grid of 12 mini-
// month calendars … with event-day dots in --st-<state> colors, the current month highlighted").
// Client component because each mini-month / day is clickable: a month click drills into Month view,
// a day click drills into the Week containing that day (mirrors the existing app's CalYear).
//
// Pure render off the prebuilt MiniMonth[] (cal-utils.buildYearGrid) — all date math is done there on
// integer (y, m0, d) tuples, never `new Date('YYYY-MM-DD')`.

export interface YearViewProps {
  months: MiniMonth[];
  /** The month index the cursor is on (highlighted ring + accent header). */
  focusMonth0: number;
  /** Drill into Month view for month index m0. */
  onPickMonth: (month0: number) => void;
  /** Drill into Week view for (month0, day). */
  onPickDay: (month0: number, day: number) => void;
}

export function YearView({ months, focusMonth0, onPickMonth, onPickDay }: YearViewProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
      {months.map((mm) => {
        const isFocus = mm.month0 === focusMonth0;
        return (
          <div
            key={mm.month0}
            className={cn(
              'rounded-lg border bg-card p-3 transition-colors',
              isFocus ? 'border-primary' : 'border-border',
            )}
          >
            <div className="mb-2 flex items-baseline justify-between">
              <button
                type="button"
                onClick={() => onPickMonth(mm.month0)}
                className={cn(
                  'rounded text-[11px] font-semibold uppercase tracking-wider outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50',
                  isFocus ? 'text-primary' : 'text-muted-foreground',
                )}
                aria-label={`Open ${mm.label} in month view`}
              >
                {mm.label}
              </button>
              {mm.eventCount > 0 ? (
                <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                  {mm.eventCount}
                </span>
              ) : null}
            </div>

            <div className="grid grid-cols-7 gap-px font-mono text-[9px]">
              {CAL_DOW_S.map((d, i) => (
                <div key={i} className="py-0.5 text-center text-muted-foreground/60" aria-hidden>
                  {d}
                </div>
              ))}
              {mm.cells.map((cell, i) => {
                if (cell.day === null) return <div key={i} />;
                const token = cell.state ? `var(--st-${cell.state})` : undefined;
                const hasEvent = cell.count > 0;
                // A completed GHOST day: keep the tint/dot but muted (history at a glance).
                const tintPct = cell.dimmed ? 12 : 25;
                const title = cell.isToday
                  ? `Today${cell.names.length ? ` · ${cell.names.join(' · ')}` : ''}`
                  : cell.names.join(' · ');
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onPickDay(cell.month0, cell.dayNum)}
                    title={title || undefined}
                    aria-label={`${mm.label} ${cell.day}${
                      hasEvent ? `, ${cell.count} ${cell.count === 1 ? 'event' : 'events'}` : ''
                    }`}
                    className={cn(
                      'relative rounded-sm py-[2px] text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                      cell.isToday
                        ? 'font-bold text-primary ring-1 ring-inset ring-primary'
                        : hasEvent
                          ? cell.dimmed
                            ? 'font-medium text-muted-foreground'
                            : 'font-semibold text-foreground'
                          : 'text-muted-foreground/70 hover:text-foreground',
                    )}
                    style={
                      cell.isToday
                        ? { background: 'color-mix(in oklch, var(--primary) 18%, transparent)' }
                        : hasEvent && token
                          ? { background: `color-mix(in oklch, ${token} ${tintPct}%, transparent)` }
                          : undefined
                    }
                  >
                    {cell.day}
                    {hasEvent && token ? (
                      <span
                        className="absolute right-[2px] top-[1px] size-1 rounded-full"
                        style={{ background: token, opacity: cell.dimmed ? 0.5 : 1 }}
                        aria-hidden
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default YearView;
