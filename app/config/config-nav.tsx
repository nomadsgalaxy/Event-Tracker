'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Users, ShieldCheck, ScrollText, UserCog, Tags, Database, RefreshCw, Settings2, Warehouse, KeyRound } from 'lucide-react';
import { cn } from '@/lib/util/utils';

// config-nav.tsx — the Config sub-navigation (Users / Permissions / Audit) + the current admin's
// identity chip. Client Component only so it can mark the active tab via usePathname (aria-current
// for a11y; the visual underline mirrors the line-variant tab strip used elsewhere). The links are
// real <a> (Next <Link>) so they're keyboard reachable and semantic — not a JS-only tab switcher.

const TABS = [
  { href: '/config', label: 'Users', icon: Users, exact: true },
  { href: '/config/tags', label: 'Tags', icon: Tags, exact: false },
  // Warehouses live at the top-level /warehouses route (also reached from the Catalog rail), but the
  // management entry point belongs in Config — matching the Python app's Config -> Warehouses tab.
  { href: '/warehouses', label: 'Warehouses', icon: Warehouse, exact: false },
  { href: '/config/permissions', label: 'Permissions', icon: ShieldCheck, exact: false },
  { href: '/config/databases', label: 'Databases', icon: Database, exact: false },
  // Oversight of the programmatic surface — every user-minted API key + webhook, and who minted them.
  { href: '/config/api', label: 'API', icon: KeyRound, exact: false },
  { href: '/config/sync', label: 'Sync', icon: RefreshCw, exact: false },
  { href: '/config/admin', label: 'Admin', icon: Settings2, exact: false },
  { href: '/config/audit', label: 'Audit log', icon: ScrollText, exact: false },
] as const;

export function ConfigNav({ adminEmail }: { adminEmail: string }) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col gap-3 border-b border-border pb-px sm:flex-row sm:items-end sm:justify-between">
      <nav className="flex flex-wrap gap-1" aria-label="Configuration sections">
        {TABS.map((t) => {
          const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-t-md',
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="size-4" aria-hidden />
              {t.label}
            </Link>
          );
        })}
      </nav>

      {/* The signed-in admin's identity — makes the "can't change your own role" rule legible on
          the Users page (their own row is the one that's locked). */}
      <span
        className="mb-2 inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground"
        title="You are signed in as this admin"
      >
        <UserCog className="size-3.5 text-primary" aria-hidden />
        <span className="text-muted-foreground">Signed in as</span>
        <span className="font-mono text-foreground">{adminEmail}</span>
      </span>
    </div>
  );
}

export default ConfigNav;
