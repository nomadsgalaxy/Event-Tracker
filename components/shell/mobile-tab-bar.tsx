'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/util/utils';
import { isNavActive, mobileNav } from './nav-model';

// mobile-tab-bar.tsx — the fixed bottom navigation shown BELOW the md breakpoint (it replaces the
// hidden center TopNav on phones; the TopBar's wordmark + right cluster stay). DESIGN_ALIGNMENT §1.4:
// the high-traffic "floor" surfaces only — Home · Calendar · Manifest · Scan · Sign-Off · Catalog
// (the mobile-flagged subset of PRIMARY_NAV). Reports / Config / Account / Activity are deep-link /
// user-menu only and never appear here.
//
// Each tab is an icon over a tiny label; the active one is ORANGE (aria-current="page"). Targets are
// the full 44px+ height for thumb reach, and the bar respects the iOS home-indicator safe area.

// Like TopNav, this Client Component derives its item list from the serializable `isAdmin` boolean
// rather than receiving NavItem[] as a prop — a NavItem's lucide `icon` is a function and React
// can't serialize a function across the server→client boundary (it 500s the route). nav-model.ts is
// client-safe (no `server-only`), so mobileNav runs fine here.
export function MobileTabBar({ isAdmin }: { isAdmin: boolean }) {
  const items = mobileNav({ isAdmin });
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur md:hidden',
        'pb-[env(safe-area-inset-bottom)]'
      )}
    >
      <ul className="flex items-stretch justify-around">
        {items.map((item) => {
          const active = isNavActive(item, pathname);
          const Icon = item.icon;
          return (
            <li key={item.id} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-[52px] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[10px] font-medium',
                  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon size={20} aria-hidden />
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default MobileTabBar;
