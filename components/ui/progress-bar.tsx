import * as React from 'react';

import { cn } from '@/lib/util/utils';

// ProgressBar — the thin packed/total bar shown on event/case cards and manifest rollups
// (DESIGN_ALIGNMENT.md §5 "A thin progress bar shows packed/total"). The fill uses --primary (brand
// orange = the active/accent meaning) by default; pass a token CSS var via `fillColor` to tint a
// specific state (e.g. 'var(--st-ready)'). Pure RSC.
//
// A11y: it is a real ARIA progressbar (role + aria-valuenow/min/max). `label` feeds aria-label so a
// screen reader reads e.g. "Packing 12 of 20". The bar is never the ONLY signal — callers pair it
// with the visible count text.

export interface ProgressBarProps extends React.ComponentProps<'div'> {
  /** Completed count. */
  value: number;
  /** Total count. A total of 0 renders an empty (0%) bar without dividing by zero. */
  total: number;
  /** Accessible name for the progressbar (e.g. "Packed cases"). */
  label?: string;
  /** Bar thickness. Defaults to "default" (h-1.5); "sm" = h-1. */
  size?: 'sm' | 'default';
  /** Override the fill colour with a token CSS var, e.g. 'var(--st-ready)'. Defaults to --primary. */
  fillColor?: string;
}

export function ProgressBar({
  value,
  total,
  label,
  size = 'default',
  fillColor,
  className,
  ...props
}: ProgressBarProps) {
  const safeTotal = total > 0 ? total : 0;
  const clamped = Math.max(0, Math.min(value, safeTotal || value));
  const pct = safeTotal > 0 ? Math.round((clamped / safeTotal) * 100) : 0;

  return (
    <div
      data-slot="progress-bar"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={safeTotal}
      aria-label={label}
      className={cn(
        'w-full overflow-hidden rounded-full bg-muted',
        size === 'sm' ? 'h-1' : 'h-1.5',
        className
      )}
      {...props}
    >
      <div
        className="h-full rounded-full transition-[width] duration-200"
        style={{ width: `${pct}%`, background: fillColor ?? 'var(--primary)' }}
      />
    </div>
  );
}

export default ProgressBar;
