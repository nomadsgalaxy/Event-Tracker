'use client';

import { useRouter } from 'next/navigation';
import { MapPin } from 'lucide-react';

import { cn } from '@/lib/util/utils';
import { Eyebrow } from '@/components/ui/eyebrow';
import { StatusBadge } from '@/components/ui/status-badge';
import { WeatherChip } from '@/components/ui/weather-chip';
import { TagChip } from '@/components/ui/tag-chip';
import { MONTHS_SHORT, eventTags, type CalEvent } from '@/app/calendar/cal-utils';
import type { DashTag } from '@/lib/types/types-dashboard';

// SchedulePanel — the right-side "<year> SCHEDULE · N SHOWS" list beside the Year view (faithful
// port of index.html CalYear's sidebar ~L22943). Each row: a small month/day date rail, the name +
// "city · lead" line, the START-day weather chip, up to 4 tag chips (+N overflow), and a StatusBadge.
// A whole-row click → event detail (the tag chips stop propagation → tag detail). The parent passes
// the already year-filtered + sorted events + the visible tag directory.
//
// The date is derived from the ISO 'YYYY-MM-DD' start STRING parts (split on '-'), never
// new Date('YYYY-MM-DD') (the UTC-midnight parse shifts a day in negative-offset timezones).

function dateRail(start: string): { mon: string; day: string } {
  const [, m, d] = start.split('-');
  const month0 = Number(m) - 1;
  const mon = (MONTHS_SHORT[month0] ?? '').toUpperCase();
  return { mon, day: String(Number(d)) };
}

export function SchedulePanel({
  year,
  events,
  tagById,
  className,
}: {
  year: number;
  events: CalEvent[];
  tagById: Map<string, DashTag>;
  className?: string;
}) {
  const router = useRouter();

  return (
    <aside aria-label={`${year} schedule`} className={cn('flex w-full flex-col gap-2.5', className)}>
      <Eyebrow>
        {year} schedule · {events.length} {events.length === 1 ? 'show' : 'shows'}
      </Eyebrow>

      {events.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
          No shows scheduled in {year}.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {events.map((ev) => {
            const { mon, day } = dateRail(ev.start);
            const w = ev.weather[ev.start];
            const tags = eventTags(ev, tagById);
            const goEvent = () => router.push(`/event/${encodeURIComponent(ev.id)}`);
            return (
              <li key={ev.id}>
                {/* role="button" div (NOT a <button>) so the navigating tag chips inside can be
                    real <button>s without nesting a button in a button (invalid HTML → the #
                    hydration error). Keyboard-reachable: tabIndex + Enter/Space → event detail. */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={goEvent}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      goEvent();
                    }
                  }}
                  aria-label={`${ev.name || 'Untitled event'} — open event`}
                  className="grid w-full cursor-pointer grid-cols-[2.5rem_1fr_auto] items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <div className="text-center">
                    <div className="font-mono text-[10px] uppercase text-muted-foreground tabular-nums">
                      {mon}
                    </div>
                    <div className="font-mono text-base font-semibold leading-none text-foreground tabular-nums">
                      {day}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {ev.name || 'Untitled event'}
                    </div>
                    {ev.city || ev.lead ? (
                      <div className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
                        {ev.city ? <MapPin size={11} aria-hidden /> : null}
                        <span className="truncate">
                          {ev.city}
                          {ev.lead ? `${ev.city ? ' · ' : ''}${ev.lead}` : ''}
                        </span>
                      </div>
                    ) : null}
                    {w ? (
                      <div className="mt-1">
                        <WeatherChip w={w} />
                      </div>
                    ) : null}
                    {tags.length > 0 ? (
                      <div className="mt-1 flex flex-wrap items-center gap-0.5">
                        {tags.slice(0, 4).map((tag) => (
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
                        {tags.length > 4 ? (
                          <span className="text-[9px] font-bold text-muted-foreground">
                            +{tags.length - 4}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <StatusBadge state={ev.state} className="shrink-0 self-start" />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

export default SchedulePanel;
