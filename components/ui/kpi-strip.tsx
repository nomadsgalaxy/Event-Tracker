import * as React from 'react';

import { cn } from '@/lib/utils';
import { Eyebrow } from '@/components/ui/eyebrow';

// KpiStrip + KpiCard — the horizontal stat cards of the Dashboard/Manifest headers
// (DESIGN_ALIGNMENT.md §4.1 "a 3-col KPI strip" + §5). One bordered card surface split into equal
// cells by hairline dividers: each cell is a tiny uppercase eyebrow LABEL over a big tabular NUMBER
// over an optional muted SUB-NOTE. Pure RSC.
//
// The cells are divided by borders (not gaps/shadows) per the flat-surface rule: a single bg-card
// panel with `divide-x` between cells (and `divide-y` when they wrap on mobile). Stack on the
// narrowest widths.

export function KpiStrip({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="kpi-strip"
      className={cn(
        'grid grid-cols-1 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card',
        'sm:grid-cols-2 sm:divide-x lg:grid-cols-3',
        // when 3-up on lg, the divide-y from the mobile stack must not draw between row-1 cells
        'sm:[&>*]:border-t-0',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface KpiCardProps extends React.ComponentProps<'div'> {
  /** Tiny uppercase label (e.g. "ACTIVE SHOWCASES"). */
  label: React.ReactNode;
  /** The big number (string or number). Rendered tabular for alignment. */
  value: React.ReactNode;
  /** Optional muted sub-note under the number (e.g. "3 this week"). */
  subnote?: React.ReactNode;
  /** Optional accent — paints the big number with the brand orange for the "active/accent" KPI. */
  accent?: boolean;
  /** Optional override class for the big number (e.g. a warning tint when a count is non-zero).
   *  Layered AFTER the accent/foreground default so a caller can recolor the value (Reports' OOS
   *  card paints the number warning when items are out of service). */
  valueClassName?: string;
}

export function KpiCard({
  label,
  value,
  subnote,
  accent = false,
  valueClassName,
  className,
  ...props
}: KpiCardProps) {
  return (
    <div
      data-slot="kpi-card"
      className={cn('flex flex-col gap-1 px-5 py-4', className)}
      {...props}
    >
      <Eyebrow>{label}</Eyebrow>
      <div
        className={cn(
          'text-3xl font-semibold tabular-nums leading-none',
          accent ? 'text-primary' : 'text-foreground',
          valueClassName
        )}
      >
        {value}
      </div>
      {subnote ? (
        <div className="text-xs text-muted-foreground">{subnote}</div>
      ) : null}
    </div>
  );
}

export default KpiStrip;
