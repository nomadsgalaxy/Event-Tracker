import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { getCurrentUser } from '@/lib/auth/auth';
import { getUserChrome } from '@/lib/db/data';
import { companyForEmail } from '@/lib/auth/settings-store';
import { getNotifications, getTravelReminders } from '@/lib/views/notifications';
import { rankOf, DEFAULT_ROLES } from '@/lib/auth/rbac';
import { TopNav } from './top-nav';
import { UserMenu } from './user-menu';
import { DbStatus } from './db-status';
import { InstallButton } from './install-button';

// top-bar.tsx — the sticky h-14 desktop app bar (Server Component). It resolves the live auth state
// once and lays out the three zones:
//   LEFT   wordmark "EVENT TRACKER" (EVENT white, TRACKER orange) → Home (/)
//   CENTER the workflow nav (client TopNav: orange-pill active + ⋯ overflow), md+ only
//   RIGHT  [Read-only badge when signed out] · DbStatus · NotificationBell · Install · UserMenu / Sign in
//
// Auth wiring is intentionally read HERE (not in the root layout) so the bar owns its own data and
// the layout stays a thin frame. getCurrentUser is the non-redirecting guard (the bar renders over
// /login too, which must stay reachable signed-out). Config is added to the nav for admins only;
// the real gate is requireRole('admin') on the /config layout.

const ROLE_BY_ID = Object.fromEntries(DEFAULT_ROLES.map((r) => [r.id, r]));

export async function TopBar() {
  const user = await getCurrentUser();
  const isAdmin = !!user && rankOf(user.role) >= rankOf('admin');

  // Notifications are signed-in-only chrome; fail-soft to null (getNotifications already swallows).
  // Travel reminders (events <14d out with no travel) are computed server-side too, so the bell needs
  // no client-only Date during its initial render (the mount-gate rule); the bell re-polls both.
  const notif = user ? await getNotifications(user.email, user.role) : null;
  const reminders = user ? await getTravelReminders(user.email) : [];

  const roleDef = user ? ROLE_BY_ID[user.role] : undefined;

  // Directory identity for the avatar + display name (preferredName/name + the profile picture —
  // an Account upload or the OAuth photo). Best-effort: a store hiccup falls back to email-derived.
  const chrome = user ? await getUserChrome(user.email).catch(() => ({ displayName: '', picture: '' })) : null;

  // The company chip label comes from the admin-set branding store (default name, or the per-domain
  // override mapped from the signed-in email). Empty ⇒ the DbStatus default 'EVENT TRACKER'. Read
  // server-side here so the chip needs no client-only fetch (the mount-gate rule).
  const company = (await companyForEmail(user?.email)) || undefined;

  return (
    <header className="sticky top-0 z-50 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur md:px-6">
      {/* LEFT — wordmark / Home */}
      <Link
        href="/"
        className="shrink-0 rounded-sm text-base font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Event Tracker — Dashboard"
      >
        EVENT <span className="text-primary">TRACKER</span>
      </Link>

      {/* CENTER — primary workflow nav (desktop). On mobile this collapses to the MobileTabBar; the
          spacer keeps the right cluster pinned right when the nav is hidden. */}
      <TopNav isAdmin={isAdmin} />
      <div className="flex-1 md:hidden" />

      {/* RIGHT cluster */}
      <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
        {!user && (
          <span className="hidden rounded-full border border-border px-2 py-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase sm:inline">
            Read-only
          </span>
        )}

        <DbStatus company={company} />

        {user && notif && (
          <NotificationBell
            items={notif.items}
            actionable={notif.actionable}
            reminders={reminders}
            viewerEmail={user.email}
          />
        )}

        <InstallButton />

        {user ? (
          <UserMenu
            email={user.email}
            role={user.role}
            roleLabel={roleDef?.label ?? user.role}
            roleColor={roleDef?.color ?? 'var(--primary)'}
            displayName={chrome?.displayName || undefined}
            picture={chrome?.picture || undefined}
          />
        ) : (
          <Button asChild size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
        )}
      </div>
    </header>
  );
}

export default TopBar;
