'use client';

import { useRouter } from 'next/navigation';

import {
  SEGMENT_COLORS,
  SEGMENT_SHORT,
  SEGMENT_LABEL,
  type CalSegment,
} from '@/app/calendar/cal-utils';

// SegmentChip — the compact logistics pill (pickup / setup / teardown / arrival) shown in Month-day
// cells + the Week-view day header (DESIGN_ALIGNMENT §4.2 logistics chips). A faithful port of
// index.html SegmentChip (~L22775): a colored letter pill (compact) or letter + truncated event
// name (full), tinted by the segment's fixed color, with a "Label — Event" tooltip. Clicking jumps
// to the event detail and stops propagation so a parent day-cell's own click (→ Week view) doesn't
// also fire.
//
// The colors are the segment legend's fixed hues (amber/blue/violet/emerald — NOT status tokens), so
// they're applied inline; everything else is token/utility-driven.

export function SegmentChip({ seg, compact }: { seg: CalSegment; compact: boolean }) {
  const router = useRouter();
  const color = SEGMENT_COLORS[seg.id];
  const short = SEGMENT_SHORT[seg.id];
  const label = SEGMENT_LABEL[seg.id];

  return (
    <button
      type="button"
      title={`${label} — ${seg.event.name}`}
      onClick={(e) => {
        e.stopPropagation();
        router.push(`/event/${encodeURIComponent(seg.event.id)}`);
      }}
      className="inline-flex select-none items-center whitespace-nowrap rounded-[2px] font-bold leading-none text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      style={{
        background: color,
        gap: compact ? 0 : 3,
        fontSize: compact ? 8 : 9,
        padding: compact ? '2px 3px' : '2px 4px',
      }}
    >
      {short}
      {!compact ? (
        <span className="font-medium opacity-90">{seg.event.name.slice(0, 14)}</span>
      ) : null}
      <span className="sr-only">
        {label} for {seg.event.name}
      </span>
    </button>
  );
}

export default SegmentChip;
