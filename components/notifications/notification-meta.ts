import type { NotificationItem } from '@/lib/views/notifications';

// notification-meta.ts — client-safe (no `server-only`) render helpers shared by the bell and the
// full list. The lib/notifications module is server-only; the NotificationItem TYPE it exports is
// erased at compile time, so re-exporting it here is free and keeps the client imports off the
// server module. Mirrors the current app's NotifRow copy (index.html ~L30623) so the two stacks
// read the same way.

export type { NotificationItem, TravelReminder } from '@/lib/views/notifications';

/** Format an event start date (ISO 'YYYY-MM-DD') as a short local date for the reminder line. Pure,
 *  locale-light. Constructed as a LOCAL date (split + new Date(y,m,d)) so it never shifts a day across
 *  the UTC boundary. */
export function formatEventDate(iso: string): string {
  const s = String(iso ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  if (Number.isNaN(date.getTime())) return s;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A short relative timestamp ("just now", "3h", "2d", or a date). Pure, locale-light, no deps —
 *  the lib has no formatDate helper and the design system says dense meta in text-xs. */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return '';
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export interface RenderedNotification {
  /** The headline sentence (already personalized for the viewer). */
  title: string;
  /** True when the row is a PENDING travel request (copy + "Action needed" badge). NOTE: whether the
   *  viewer may actually Approve/Deny is `NotificationItem.canDecide`, checked separately + re-checked
   *  server-side — this flag only means "is a pending request". */
  actionable: boolean;
  /** When approved + linkable, the event id to deep-link "View" to. */
  eventId?: string;
  /** Whether to offer a "View event" affordance (approved result with an event). */
  canView: boolean;
}

/**
 * Turn a notification into render-ready copy from the VIEWER's perspective. Faithful to the
 * current app's NotifRow: a pending travel_request addressed to me reads "X wants to see your
 * travel…"; one I'm seeing as a manager reads "…their travel…"; a result reads "X approved/declined
 * your request…". Unknown types degrade to a generic line rather than rendering nothing.
 */
export function renderNotification(n: NotificationItem, viewerEmail: string): RenderedNotification {
  const me = (viewerEmail || '').trim().toLowerCase();
  const d = n.data || {};
  const eventName = (d.eventName as string) || 'an event';
  const requester = (d.requesterEmail as string) || 'Someone';
  const subject = (d.subjectEmail as string) || 'a staffer';

  if (n.type === 'travel_request' && d.status === 'pending') {
    const iAmSubject = (subject || '').toLowerCase() === me;
    const whose = iAmSubject ? 'your' : `${subject}'s`;
    return {
      title: `${requester} wants to see ${whose} travel for ${eventName}.`,
      actionable: true,
      eventId: d.eventId as string | undefined,
      canView: false,
    };
  }

  if (n.type === 'travel_request_result') {
    const approved = d.status === 'approved';
    return {
      title: `${subject} ${approved ? 'approved' : 'declined'} your travel request for ${eventName}.${
        approved ? ' You can see it now.' : ''
      }`,
      actionable: false,
      eventId: d.eventId as string | undefined,
      canView: approved && Boolean(d.eventId),
    };
  }

  if (n.type === 'travel_request') {
    return {
      title: `Travel request from ${requester} — ${d.status || 'updated'}.`,
      actionable: false,
      eventId: d.eventId as string | undefined,
      canView: false,
    };
  }

  if (n.type === 'flight_delay') {
    const flight = (d.flightNumber as string) || 'A flight';
    const leg = d.leg === 'return' ? 'return' : 'outbound';
    const iAmSubject = (subject || '').toLowerCase() === me;
    const whose = iAmSubject ? 'Your' : `${subject}'s`;
    const delayMin = Number(d.delayMin || 0);
    const what =
      d.status === 'cancelled'
        ? `${flight} (${leg}) is cancelled`
        : `${flight} (${leg}) is delayed${delayMin ? ` ${delayMin}m` : ''}`;
    return {
      title: `${whose} ${what} for ${eventName}.`,
      actionable: false,
      eventId: d.eventId as string | undefined,
      canView: Boolean(d.eventId),
    };
  }

  if (n.type === 'severe_weather') {
    const event = (d.event as string) || 'Severe weather';
    const area = (d.areaDesc as string) || '';
    return {
      title: `${event} for ${eventName}${area ? ` — ${area}` : ''}.`,
      actionable: false,
      eventId: d.eventId as string | undefined,
      canView: Boolean(d.eventId),
    };
  }

  return {
    title: 'You have a new notification.',
    actionable: false,
    canView: false,
  };
}
