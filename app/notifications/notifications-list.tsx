'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Bell, CheckCheck, Loader2, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/util/utils';
import { markReadAction, clearNotificationsAction, decideTravelRequestAction } from './actions';
import { renderNotification, relativeTime, type NotificationItem } from '@/components/notifications/notification-meta';

// notifications-list.tsx — the interactive half of the full Notifications page: a "Mark all read"
// action + the per-row list. The server already filtered to the viewer's feed (self + manager
// pending requests) and stripped soft-deleted rows; this renders + owns the mark-read gesture.
// All copy comes from the isomorphic renderNotification helper so a row reads identically here and
// in the header bell. Token-driven, dashed empty state, tabular-nums timestamps — per the design
// system. When the feed is empty (the current seed state) this is a clean caught-up panel.

interface NotificationsListProps {
  items: NotificationItem[];
  viewerEmail: string;
}

export function NotificationsList({ items, viewerEmail }: NotificationsListProps) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const unreadCount = items.filter((n) => n.mine).length;

  const markAll = () => {
    startTransition(async () => {
      const res = await markReadAction();
      if (res.ok) {
        toast.success(res.modified ? `Marked ${res.modified} read.` : 'Nothing to mark.');
        router.refresh(); // re-read live from Mongo so the dots + the bell badge clear
      } else {
        toast.error(res.error || 'Could not update notifications.');
      }
    });
  };

  // Clear (soft-delete). With no ids → all of mine; with an id → one row. Re-reads live after.
  const clear = (ids?: string[]) => {
    startTransition(async () => {
      const res = await clearNotificationsAction(ids);
      if (res.ok) {
        if (!ids) toast.success(res.modified ? `Cleared ${res.modified}.` : 'Nothing to clear.');
        router.refresh();
      } else {
        toast.error(res.error || 'Could not clear notifications.');
      }
    });
  };

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-16 text-center">
        <Bell size={28} className="text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-foreground">You&rsquo;re all caught up</p>
        <p className="max-w-prose text-sm text-muted-foreground">
          Travel-data requests and approvals will show up here. There&rsquo;s nothing waiting on you
          right now.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          <span className="tabular-nums">{unreadCount}</span> unread
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={markAll}
            disabled={isPending || unreadCount === 0}
          >
            {isPending ? <Loader2 className="animate-spin" aria-hidden /> : <CheckCheck aria-hidden />}
            Mark all read
          </Button>
          <Button variant="ghost" size="sm" onClick={() => clear()} disabled={isPending}>
            <Trash2 aria-hidden />
            Clear all
          </Button>
        </div>
      </div>

      <Card className="p-0">
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {items.map((n) => (
              <NotificationRow key={n.docId} n={n} viewerEmail={viewerEmail} onDismiss={() => clear([n.id])} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function NotificationRow({ n, viewerEmail, onDismiss }: { n: NotificationItem; viewerEmail: string; onDismiss: () => void }) {
  const router = useRouter();
  const r = renderNotification(n, viewerEmail);
  const unread = n.mine;
  const [busy, setBusy] = React.useState(false);

  // Inline Approve / Deny — only when this is a PENDING request the viewer may decide. The action
  // re-checks who-may-grant server-side (subject self / manager+ / lead-of-event); this is a UI hint.
  const decide = (decision: 'approve' | 'deny') => {
    setBusy(true);
    decideTravelRequestAction(n.docId, decision)
      .then((res) => {
        if (res.ok) {
          toast.success(decision === 'approve' ? 'Travel access granted.' : 'Request denied.');
          router.refresh(); // re-read the feed live (the row flips out of pending)
        } else {
          toast.error(res.error || 'Could not update the request.');
        }
      })
      .catch(() => toast.error('Could not update the request — check your connection.'))
      .finally(() => setBusy(false));
  };

  return (
    <li className={cn('flex gap-3 px-4 py-3.5', unread && 'bg-muted/40')}>
      <span
        aria-hidden
        className={cn('mt-1.5 size-2 shrink-0 rounded-full', unread ? 'bg-primary' : 'bg-transparent')}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm leading-snug text-foreground">{r.title}</p>
          {r.actionable && (
            <Badge variant="outline" className="shrink-0 border-warning/50 text-warning">
              Action needed
            </Badge>
          )}
        </div>
        {r.actionable && n.canDecide ? (
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => decide('approve')}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Approve
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('deny')}>
              Deny
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">
              {relativeTime(n.createdAt)}
            </span>
          </div>
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">{relativeTime(n.createdAt)}</span>
            {r.canView && r.eventId && (
              <Link
                href={`/event/${encodeURIComponent(r.eventId)}`}
                className="rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                View event
              </Link>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="-mr-1 mt-0.5 shrink-0 self-start rounded-sm p-1 text-muted-foreground/50 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X size={16} aria-hidden />
      </button>
    </li>
  );
}
