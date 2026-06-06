import { requireUser } from '@/lib/auth';
import { getNotifications } from '@/lib/notifications';
import { NotificationsList } from './notifications-list';

// app/notifications — the full notification feed. Server Component: reads the signed-in user's
// notifications LIVE from Mongo on every request (no cache, no localStorage), the realtime-DB
// model the rewrite proves out.
//
// AUTH: requireUser gates the session (redirects to /login when signed out) + re-resolves the LIVE
// role, which getNotifications uses so a manager also sees pending travel-requests they can act on.
// The notifications collection is OFF the app-plane allowlist — this read goes through the
// dedicated lib/notifications accessor (the server-managed gate), never the generic /db path.
//
// The collection is currently EMPTY in the seed, so the common render is the clean caught-up empty
// state; the data path is wired to the real shape so a replicated travel-request shows up here.
export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const user = await requireUser();
  const { items, actionable } = await getNotifications(user.email, user.role);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {actionable > 0 ? (
            <>
              <span className="tabular-nums">{actionable}</span> awaiting you
            </>
          ) : (
            'Inbox'
          )}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Notifications</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Travel-data requests, approvals, and reminders — read live from the database.
        </p>
      </header>

      <NotificationsList items={items} viewerEmail={user.email} />
    </div>
  );
}
