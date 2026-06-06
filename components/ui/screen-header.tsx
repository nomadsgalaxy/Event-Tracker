import * as React from 'react';

import { cn } from '@/lib/utils';
import { Eyebrow } from '@/components/ui/eyebrow';

// ScreenHeader — the universal screen header pattern shared by BOTH layout archetypes
// (DESIGN_ALIGNMENT.md §3 "Shared header pattern" + §5). A tiny uppercase eyebrow line ABOVE a big
// bold headline, an optional subtitle, and primary actions right-aligned ON THE SAME ROW as the
// title (the existing app does not put actions in a toolbar below the header — they sit on the title
// row). Pure RSC; the caller supplies whatever interactive bits (buttons, links) it needs as
// `actions`.
//
// `as` lets the headline render as the correct heading level for the page (default <h1>; pass "h2"
// for a nested/peek header) so each page keeps exactly one logical <h1> (DESIGN_SYSTEM.md §4).

export interface ScreenHeaderProps
  extends Omit<React.ComponentProps<'div'>, 'title'> {
  /** The tiny uppercase context line (e.g. "OPERATIONS · 2026", "ROADCASES · 7 TOTAL"). */
  eyebrow?: React.ReactNode;
  /** The big bold headline. */
  title: React.ReactNode;
  /** Optional one-line subtitle under the headline. */
  subtitle?: React.ReactNode;
  /** Primary actions, right-aligned on the title row (New / Export / Edit / Save …). */
  actions?: React.ReactNode;
  /** Heading element for the title — keep exactly one <h1> per page. */
  as?: 'h1' | 'h2';
}

export function ScreenHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  as: Heading = 'h1',
  className,
  ...props
}: ScreenHeaderProps) {
  return (
    <div
      data-slot="screen-header"
      className={cn('flex flex-col gap-3', className)}
      {...props}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        {/* min-w-0 lets a long title truncate/wrap without shoving the actions off-row. */}
        <div className="flex min-w-0 flex-col gap-1">
          {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
          <Heading className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {title}
          </Heading>
          {subtitle ? (
            <p className="max-w-prose text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>

        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

export default ScreenHeader;
