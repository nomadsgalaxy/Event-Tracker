import * as React from 'react';

import { cn } from '@/lib/utils';

// DetailRow — a label -> value row for the Archetype-B stacked sections (Event detail, Account,
// Config), the body of a FieldGroup/eit-card (DESIGN_ALIGNMENT.md §5 "DetailRow label/value pairs
// (~160px label column, value optionally mono)"). Pure RSC.
//
// Layout: a ~160px muted label column on the left, the value filling the rest. On the narrowest
// widths it stacks (label above value). An empty/nullish value renders a muted em dash so a row is
// never visually blank. Pass `mono` for IDs / dates / numerics (tabular-nums).

export interface DetailRowProps extends React.ComponentProps<'div'> {
  /** Left-hand label (muted). */
  label: React.ReactNode;
  /** Right-hand value. Falsy (undefined/null/'') renders an em dash. */
  value?: React.ReactNode;
  /** Render the value mono + tabular (IDs, dates, quantities). */
  mono?: boolean;
}

export function DetailRow({
  label,
  value,
  mono = false,
  className,
  children,
  ...props
}: DetailRowProps) {
  // Allow either a `value` prop or `children` as the value (children wins when present).
  const content = children ?? value;
  const isEmpty =
    content === undefined || content === null || content === '';

  return (
    <div
      data-slot="detail-row"
      className={cn(
        'flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-baseline sm:gap-4',
        className
      )}
      {...props}
    >
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:text-sm sm:normal-case sm:tracking-normal">
        {label}
      </dt>
      <dd
        className={cn(
          'min-w-0 flex-1 text-sm text-foreground',
          mono && 'font-mono tabular-nums',
          isEmpty && 'text-muted-foreground'
        )}
      >
        {isEmpty ? '—' : content}
      </dd>
    </div>
  );
}

export default DetailRow;
