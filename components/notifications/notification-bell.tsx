'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Bell, Plane, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/util/utils';
import { markReadAction, decideTravelRequestAction } from '@/app/notifications/actions';
import {
  renderNotification,
  relativeTime,
  formatEventDate,
  type NotificationItem,
  type TravelReminder,
} from './notification-meta';

// NotificationBell — the header bell. An icon Button with an actionable-count Badge, opening a shadcn
// Popover that lists, in order: the viewer's TRAVEL REMINDERS (✈️ "add your travel" for events <14d
// out with no travel + a "Go" deep-link), then their NOTIFICATIONS — pending travel_requests with
// inline Approve/Deny (only when the viewer may decide), and approve/deny results with a "View event".
// Faithful to the Python NotificationBell (index.html ~L30653): open => mark-all-read, a 60s poll
// refresh, decide error toasts.
//
// DATA: seeded from server props (the SSR render in top-bar) for an instant first paint, then a 60s
// POLL of GET /api/notifications keeps it live (the Python setInterval(load, 60000)). All client-only
// reads (Date for relative time, the poll) are mount-gated — the FIRST render uses ONLY the server
// props, so SSR and the client's first paint match.

interface NotificationBellProps {
  items: NotificationItem[];
  actionable: number;
  reminders: TravelReminder[];
  viewerEmail: string;
}

interface PollPayload {
  items: NotificationItem[];
  actionable: number;
  reminders: TravelReminder[];
}

export function NotificationBell({
  items: itemsProp,
  actionable: actionableProp,
  reminders: remindersProp,
  viewerEmail,
}: NotificationBellProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();

  // Live state: seeded from props, replaced by the 60s poll. A re-navigation re-runs the server props
  // (the parent re-renders), so we also re-seed when the props change identity.
  const [data, setData] = React.useState<PollPayload>({
    items: itemsProp,
    actionable: actionableProp,
    reminders: remindersProp,
  });
  React.useEffect(() => {
    setData({ items: itemsProp, actionable: actionableProp, reminders: remindersProp });
  }, [itemsProp, actionableProp, remindersProp]);

  // 60s poll — MOUNT-GATED (no fetch during SSR / the first render). Mirrors the Python load() loop.
  const load = React.useCallback(async () => {
    try {
      const r = await fetch('/api/notifications', { cache: 'no-store' });
      if (!r.ok) return;
      const next = (await r.json()) as PollPayload;
      setData({
        items: Array.isArray(next.items) ? next.items : [],
        actionable: typeof next.actionable === 'number' ? next.actionable : 0,
        reminders: Array.isArray(next.reminders) ? next.reminders : [],
      });
    } catch {
      /* poll is best-effort */
    }
  }, []);
  React.useEffect(() => {
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  // The badge = actionable notifications + travel reminders (the Python badge = actionable + reminders
  // .length). Opening the bell optimistically zeroes the notif portion (the open gesture marks read);
  // reminders persist until the user adds travel (re-polled).
  const [marked, setMarked] = React.useState(false);
  const reminderCount = data.reminders.length;
  const badge = (marked ? 0 : data.actionable) + reminderCount;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && data.actionable > 0 && !marked) {
      setMarked(true);
      startTransition(async () => {
        await markReadAction(); // no ids => mark all of mine read (self-scoped server-side)
        load();
      });
    }
  };
  // Re-arm the "mark on open" once a fresh batch arrives.
  React.useEffect(() => {
    if (data.actionable > 0) setMarked(false);
  }, [data.actionable]);

  const empty = data.items.length === 0 && reminderCount === 0;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={badge > 0 ? `Notifications, ${badge} awaiting you` : 'Notifications'}
          className="relative size-11 md:size-8"
        >
          <Bell size={18} aria-hidden />
          {badge > 0 && (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular-nums"
            >
              {badge > 9 ? '9+' : badge}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[22rem] max-w-[92vw] gap-0 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Notifications
          </p>
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="rounded-sm text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            See all
          </Link>
        </div>

        {empty ? (
          <div className="px-4 py-8 text-center" aria-live="polite">
            <Bell size={20} className="mx-auto mb-2 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">You&rsquo;re all caught up.</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[72vh]">
            <ul className="divide-y divide-border">
              {data.reminders.map((r) => (
                <ReminderRow key={r.id} r={r} onNavigate={() => setOpen(false)} />
              ))}
              {data.items.slice(0, 12).map((n) => (
                <BellRow
                  key={n.docId}
                  n={n}
                  viewerEmail={viewerEmail}
                  onNavigate={() => setOpen(false)}
                  onDecided={load}
                />
              ))}
            </ul>
            {data.items.length > 12 && (
              <div className="border-t border-border px-3 py-2 text-center">
                <Link
                  href="/notifications"
                  onClick={() => setOpen(false)}
                  className="rounded-sm text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  View {data.items.length - 12} more
                </Link>
              </div>
            )}
          </ScrollArea>
        )}
        {isPending && <span className="sr-only" aria-live="polite">Marking read…</span>}
      </PopoverContent>
    </Popover>
  );
}

// A travel reminder row — ✈️ "Add your travel for <event> — it starts <date>." + a "Go" link.
function ReminderRow({ r, onNavigate }: { r: TravelReminder; onNavigate: () => void }) {
  return (
    <li className="flex items-start gap-2.5 px-3 py-2.5">
      <Plane size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-foreground">
          Add your travel for <span className="font-medium">{r.eventName || 'an event'}</span> — it
          starts {formatEventDate(r.startDate)}.
        </p>
      </div>
      <Link
        href={`/event/${encodeURIComponent(r.eventId)}`}
        onClick={onNavigate}
        className="shrink-0 rounded-sm text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        Go
      </Link>
    </li>
  );
}

function BellRow({
  n,
  viewerEmail,
  onNavigate,
  onDecided,
}: {
  n: NotificationItem;
  viewerEmail: string;
  onNavigate: () => void;
  onDecided: () => void;
}) {
  const r = renderNotification(n, viewerEmail);
  const unread = n.mine;
  const [busy, setBusy] = React.useState(false);

  const decide = (decision: 'approve' | 'deny') => {
    setBusy(true);
    decideTravelRequestAction(n.docId, decision)
      .then((res) => {
        if (res.ok) {
          toast.success(decision === 'approve' ? 'Travel access granted.' : 'Request denied.');
          onDecided();
        } else {
          toast.error(res.error || 'Could not update the request.');
        }
      })
      .catch(() => toast.error('Could not update the request — check your connection.'))
      .finally(() => setBusy(false));
  };

  return (
    <li className={cn('flex gap-2.5 px-3 py-2.5', unread && 'bg-muted/40')}>
      <span
        aria-hidden
        className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', unread ? 'bg-primary' : 'bg-transparent')}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-foreground">{r.title}</p>
        {/* Pending request I can act on → inline Approve / Deny (gated on canDecide; re-checked server-side). */}
        {r.actionable && n.canDecide ? (
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => decide('approve')}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Approve
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('deny')}>
              Deny
            </Button>
          </div>
        ) : (
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{relativeTime(n.createdAt)}</span>
            {r.canView && r.eventId && (
              <Link
                href={`/event/${encodeURIComponent(r.eventId)}`}
                onClick={onNavigate}
                className="rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                View event
              </Link>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
