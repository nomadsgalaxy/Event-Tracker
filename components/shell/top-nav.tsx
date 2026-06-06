'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/util/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isNavActive, visibleNav } from './nav-model';

// top-nav.tsx — the CENTER workflow nav of the TopBar (desktop only; the mobile floor is the
// MobileTabBar). It is a small client island so it can:
//   • mark the active item with usePathname → a solid ORANGE PILL (aria-current="page"), and
//   • COLLAPSE trailing items into a ⋯ DropdownMenu when the bar is too narrow to fit them all.
//
// The overflow is measurement-driven (ResizeObserver on the row): we render every item, measure how
// many fit, and move the rest into ⋯. On a wide desktop everything fits and ⋯ is hidden — the menu
// is the responsive fallback, not a permanent control (DESIGN_ALIGNMENT §1.2). The nav itself is
// hidden below md (the MobileTabBar takes over there).

const pillBase =
  'inline-flex h-8 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors ' +
  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

function navClass(active: boolean) {
  return cn(
    pillBase,
    active
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
  );
}

// NOTE: this is a Client Component, so the nav items must NOT be passed down from the RSC TopBar as
// props — a NavItem carries a lucide `icon` (a function/forwardRef object), and React refuses to
// serialize a function across the server→client boundary ("Functions cannot be passed directly to
// Client Components"), which 500s every route. Instead we take the serializable `isAdmin` boolean
// and derive the item list HERE on the client via visibleNav (nav-model.ts is client-safe — no
// `server-only`). The PRIMARY_NAV order + admin filter stay the single source of truth.
export function TopNav({ isAdmin }: { isAdmin: boolean }) {
  const items = React.useMemo(() => visibleNav({ isAdmin }), [isAdmin]);
  const pathname = usePathname();
  const containerRef = React.useRef<HTMLElement | null>(null);
  // How many leading items fit; the rest go to ⋯. Start with all visible (SSR + first paint), then
  // the ResizeObserver narrows it on the client. Avoids a flash of a needless ⋯ on a wide screen.
  const [visibleCount, setVisibleCount] = React.useState(items.length);

  // Measure: lay every item out invisibly once, cache each width, then on every resize compute how
  // many fit (reserving room for the ⋯ trigger when we actually overflow).
  const itemWidths = React.useRef<number[]>([]);
  const overflowWidth = React.useRef<number>(44);

  const measure = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const total = el.clientWidth;
    const gap = 4; // matches gap-1
    const widths = itemWidths.current;
    if (widths.length !== items.length) return;

    // First, does EVERYTHING fit without a ⋯?
    let sum = 0;
    for (let i = 0; i < items.length; i++) {
      sum += widths[i] + (i > 0 ? gap : 0);
    }
    if (sum <= total) {
      setVisibleCount(items.length);
      return;
    }

    // Otherwise fit as many as possible while leaving room for the ⋯ trigger.
    let used = overflowWidth.current + gap;
    let count = 0;
    for (let i = 0; i < items.length; i++) {
      const w = widths[i] + (i > 0 ? gap : 0);
      if (used + w > total) break;
      used += w;
      count++;
    }
    setVisibleCount(Math.max(1, count));
  }, [items.length]);

  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Cache each rendered item's width from the live DOM (one-time per item set).
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-nav-item]'));
    itemWidths.current = nodes.map((n) => n.getBoundingClientRect().width);
    const ov = el.querySelector<HTMLElement>('[data-nav-overflow]');
    if (ov) overflowWidth.current = ov.getBoundingClientRect().width || 44;
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
    // Re-cache when the item set changes (e.g. admin gains/loses Config).
  }, [items, measure]);

  const shown = items.slice(0, visibleCount);
  const overflow = items.slice(visibleCount);

  return (
    <nav
      ref={containerRef as React.RefObject<HTMLElement>}
      aria-label="Primary"
      className="hidden min-w-0 flex-1 items-center gap-1 md:flex"
    >
      {shown.map((item) => {
        const active = isNavActive(item, pathname);
        return (
          <Link
            key={item.id}
            data-nav-item
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={navClass(active)}
          >
            {item.label}
          </Link>
        );
      })}

      {/* The ⋯ overflow — rendered (visually) only when something spilled, but always present in the
          DOM (visibility:hidden when empty) so its width is measurable for the fit calculation. */}
      <div
        data-nav-overflow
        className={cn('shrink-0', overflow.length === 0 && 'invisible w-0 overflow-hidden')}
      >
        {overflow.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="More navigation"
              className={cn(
                navClass(overflow.some((i) => isNavActive(i, pathname))),
                'px-2'
              )}
            >
              <MoreHorizontal size={18} aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {overflow.map((item) => {
                const active = isNavActive(item, pathname);
                const Icon = item.icon;
                return (
                  <DropdownMenuItem key={item.id} asChild>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn('gap-2', active && 'text-primary')}
                    >
                      <Icon size={16} aria-hidden />
                      {item.label}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </nav>
  );
}

export default TopNav;
