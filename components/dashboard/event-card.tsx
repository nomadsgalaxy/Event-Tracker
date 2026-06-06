import Link from 'next/link';
import { CalendarDays, MapPin, UserRound } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/util/utils';
import type { DashEvent } from '@/lib/types/types-dashboard';

// One dashboard event row, rendered as a shadcn Card. RSC-safe (no hooks/state) so it works
// in both the server page and the client list. Whole card is a single link to the detail page.
//
// Dates are rendered with a fixed, locale-stable en-CA (YYYY-MM-DD) format so server and client
// agree (no hydration mismatch) — the current app's canonical default. An undated event reads
// "No date" rather than being dropped.

function fmtRange(start: string, end: string): string {
  if (!start) return 'No date';
  if (!end || end === start) return start;
  return `${start} → ${end}`;
}

export function EventCard({ event, className }: { event: DashEvent; className?: string }) {
  const range = fmtRange(event.startDate, event.endDate);
  const undated = !event.startDate;

  return (
    <Link
      href={`/event/${encodeURIComponent(event.id)}`}
      className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Card
        size="sm"
        className={cn(
          'flex-row items-center gap-3 px-3 transition-colors hover:bg-accent',
          className
        )}
      >
        {/* Name + meta — min-w-0 lets the truncation work inside the flex row. */}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">
            {event.name || 'Untitled event'}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className={cn('inline-flex items-center gap-1', undated && 'italic')}>
              <CalendarDays size={12} aria-hidden />
              <span className="tabular-nums">{range}</span>
            </span>
            {event.city ? (
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} aria-hidden />
                <span className="truncate">{event.city}</span>
              </span>
            ) : null}
            {event.lead ? (
              <span className="inline-flex items-center gap-1">
                <UserRound size={12} aria-hidden />
                <span className="truncate">{event.lead}</span>
              </span>
            ) : null}
          </div>
          {event.tags.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {event.tags.slice(0, 4).map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {/* Status — the ONLY source of state color (StatusBadge → --st-* token). */}
        <StatusBadge state={event.state} className="shrink-0" />
      </Card>
    </Link>
  );
}
