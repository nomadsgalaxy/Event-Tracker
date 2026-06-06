import * as React from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/util/utils';
import { Eyebrow } from '@/components/ui/eyebrow';

// SidebarRail + SidebarSection + SidebarItem — the contextual LEFT sidebar of Archetype-A screens
// (DESIGN_ALIGNMENT.md §3 "Archetype A" + §4 Dashboard/Catalog/Manifest/Calendar/Sign-off).
//
// Shape: a ~w-56 (224px) rail (bg-card, border-r) of uppercase eyebrow section labels, each holding
// a list of borderless items. The active item gets the brand-orange treatment: a 2px left accent
// border + orange text + an optional mono count (per the "2px left accent border + mono count when
// active" spec). The active item carries aria-current.
//
// These are pure/RSC-safe. The active flag is passed IN by the caller (a small client island that
// reads usePathname, the same pattern as app/config/config-nav.tsx) so the rail itself needs no
// "use client". SidebarItem renders a real <Link> when `href` is set, else a <button> (controlled
// filter toggles) — both keyboard-reachable and semantic.

export interface SidebarRailProps extends React.ComponentProps<'aside'> {
  /** Accessible label for the rail's <nav>/landmark (e.g. "Dashboard filters"). */
  ariaLabel?: string;
}

export function SidebarRail({ className, children, ariaLabel, ...props }: SidebarRailProps) {
  return (
    <aside
      data-slot="sidebar-rail"
      aria-label={ariaLabel}
      className={cn(
        'flex w-56 shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-card px-3 py-4',
        className
      )}
      {...props}
    >
      {children}
    </aside>
  );
}

export interface SidebarSectionProps extends React.ComponentProps<'div'> {
  /** Uppercase eyebrow label for the group (e.g. "VIEWS", "WAREHOUSES"). Optional for a bare group. */
  label?: React.ReactNode;
}

export function SidebarSection({ label, className, children, ...props }: SidebarSectionProps) {
  return (
    <div
      data-slot="sidebar-section"
      className={cn('flex flex-col gap-1', className)}
      {...props}
    >
      {label ? <Eyebrow className="px-2 pb-1">{label}</Eyebrow> : null}
      {children}
    </div>
  );
}

export interface SidebarItemProps {
  /** Item label. */
  children: React.ReactNode;
  /** Optional leading icon (lucide). */
  icon?: LucideIcon;
  /** Optional trailing count, rendered mono/tabular and right-aligned. */
  count?: number | string;
  /** Active = the current view/filter. Drives the orange accent + aria-current. */
  active?: boolean;
  /** When set, renders a <Link> to this route; otherwise renders a <button>. */
  href?: string;
  /** Click handler for the <button> form (controlled filter toggles). */
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  /** Button type when rendered as a <button>. Defaults to "button". */
  type?: 'button' | 'submit';
  className?: string;
}

export function SidebarItem({
  children,
  icon: Icon,
  count,
  active = false,
  href,
  onClick,
  type = 'button',
  className,
}: SidebarItemProps) {
  const classes = cn(
    // borderless button + a 2px LEFT accent border that only colours when active
    'group/sidebar-item flex w-full items-center gap-2 rounded-md border-l-2 border-transparent px-2 py-1.5 text-left text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
    active
      ? 'border-primary bg-accent text-primary'
      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
    className
  );

  const inner = (
    <>
      {Icon ? <Icon size={16} aria-hidden className="shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && count !== null ? (
        <span
          className={cn(
            'shrink-0 font-mono text-xs tabular-nums',
            active ? 'text-primary' : 'text-muted-foreground'
          )}
          aria-hidden
        >
          {count}
        </span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        data-slot="sidebar-item"
        aria-current={active ? 'page' : undefined}
        className={classes}
      >
        {inner}
      </Link>
    );
  }

  return (
    <button
      type={type}
      data-slot="sidebar-item"
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      className={classes}
    >
      {inner}
    </button>
  );
}

export default SidebarRail;
