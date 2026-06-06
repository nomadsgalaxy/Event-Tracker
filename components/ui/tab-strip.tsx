'use client';

import * as React from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/util/utils';

// TabStrip — the Archetype-B underline tab strip (DESIGN_ALIGNMENT.md §3 "Archetype B" + §4
// Event detail/editor, Reports, Account, Config). Visuals mirror app/config/config-nav.tsx: the
// active tab is border-b-2 border-primary, inactive are muted-foreground -> foreground on hover, the
// whole strip sits on a border-b hairline.
//
// CRITICAL — the #93-safe pattern: ALL panels stay MOUNTED (hidden, not unmounted) so a half-typed
// local-draft field in an inactive tab is never lost on a tab switch. We render every panel with
// Radix `forceMount` and let Radix toggle the `hidden` attribute (it sets hidden on the inactive
// content, which we additionally enforce in CSS). Inactive panels are display:none, still in the DOM.
//
// Controlled by design (`value` + `onValueChange`) so the parent owns the active tab (e.g. mirror it
// to a sessionStorage key or the URL, like the existing editor does). It is a real Radix tablist:
// roving focus, arrow-key nav, aria-selected, tab/panel wiring — all handled by Radix.

export interface TabStripItem {
  /** Stable id; also the Radix value. */
  id: string;
  /** Visible label. */
  label: React.ReactNode;
  /** Optional leading icon (lucide). */
  icon?: LucideIcon;
  /** Optional trailing count badge. */
  count?: number | string;
  /** The panel body for this tab. Stays mounted while hidden. */
  content: React.ReactNode;
}

export interface TabStripProps {
  /** The tabs, in order. */
  items: TabStripItem[];
  /** Active tab id (controlled). */
  value: string;
  /** Called with the next active tab id. */
  onValueChange: (value: string) => void;
  /** Accessible label for the tablist. */
  ariaLabel?: string;
  /** Extra classes on the outer Tabs root. */
  className?: string;
  /** Extra classes on the tablist row. */
  listClassName?: string;
  /** Extra classes applied to every panel. */
  contentClassName?: string;
}

export function TabStrip({
  items,
  value,
  onValueChange,
  ariaLabel,
  className,
  listClassName,
  contentClassName,
}: TabStripProps) {
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      data-slot="tab-strip"
      className={cn('flex flex-col gap-4', className)}
    >
      <TabsPrimitive.List
        aria-label={ariaLabel}
        className={cn(
          'flex gap-1 overflow-x-auto border-b border-border',
          listClassName
        )}
      >
        {items.map((t) => {
          const Icon = t.icon;
          return (
            <TabsPrimitive.Trigger
              key={t.id}
              value={t.id}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-t-md border-b-2 border-transparent px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors',
                'hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                'data-[state=active]:border-primary data-[state=active]:text-foreground'
              )}
            >
              {Icon ? <Icon size={16} aria-hidden /> : null}
              <span>{t.label}</span>
              {t.count !== undefined && t.count !== null ? (
                <span
                  className="ml-0.5 font-mono text-xs tabular-nums text-muted-foreground"
                  aria-hidden
                >
                  {t.count}
                </span>
              ) : null}
            </TabsPrimitive.Trigger>
          );
        })}
      </TabsPrimitive.List>

      {items.map((t) => (
        <TabsPrimitive.Content
          key={t.id}
          value={t.id}
          // forceMount keeps EVERY panel in the DOM; Radix sets `hidden` on the inactive ones,
          // and `data-[state=inactive]:hidden` enforces display:none. This is the #93 fix —
          // inactive tabs keep their uncommitted local state instead of remounting.
          forceMount
          className={cn(
            'text-sm outline-none data-[state=inactive]:hidden',
            contentClassName
          )}
        >
          {t.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}

export default TabStrip;
