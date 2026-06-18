'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/auth';
import { markNotificationsRead, clearNotifications, createTravelRequest, decideTravelRequest } from '@/lib/views/notifications';
import { getEvent } from '@/lib/db/data';

// app/notifications/actions.ts — the Server Action boundary for the notification feed.
//
// Per the task contract the only write here is mark-as-read, and it flows through
// lib/notifications.markNotificationsRead under a requireUser gate. requireUser:
//   • redirects an unauthenticated caller to /login, and
//   • re-resolves the LIVE directory role on every call (not the baked token role).
// The write itself is STRICTLY self-scoped inside lib/notifications (it filters by
// payload.to === the caller's email), so the action never needs a role rank — any
// signed-in user may mark THEIR OWN notifications read, and can never touch another's
// (a crafted id list is intersected with payload.to === me). After the write we
// revalidate so the bell badge + the list re-read live from Mongo.

export interface NotificationsActionState {
  ok?: boolean;
  error?: string;
  modified?: number;
}

/**
 * Mark notifications read. With no ids, marks ALL of the caller's unread notifications read
 * (the "open the bell" / "mark all read" gesture). With ids, marks only that subset — both are
 * self-scoped in the lib write. Returns a form-state object; the auth redirect is the only hard
 * stop that escapes.
 */
export async function markReadAction(ids?: string[]): Promise<NotificationsActionState> {
  const user = await requireUser();
  try {
    // String()-coerce each id defensively — a Server Action arg is untyped at runtime; this keeps
    // a forged non-string out of the id set the lib compares against.
    const clean = Array.isArray(ids) ? ids.map((s) => String(s)).filter(Boolean) : undefined;
    const { modified } = await markNotificationsRead(user.email, clean && clean.length ? clean : undefined);
    revalidatePath('/notifications');
    revalidatePath('/'); // the bell lives in the root layout — refresh its badge everywhere
    return { ok: true, modified };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not update notifications.' };
  }
}

/**
 * Clear (soft-delete) notifications. With no ids, clears ALL of the caller's notifications ("Clear
 * all"); with ids, clears only that subset (a per-row dismiss). Self-scoped in the lib write exactly
 * like markReadAction. Returns a form-state object.
 */
export async function clearNotificationsAction(ids?: string[]): Promise<NotificationsActionState> {
  const user = await requireUser();
  try {
    const clean = Array.isArray(ids) ? ids.map((s) => String(s)).filter(Boolean) : undefined;
    const { modified } = await clearNotifications(user.email, clean && clean.length ? clean : undefined);
    revalidatePath('/notifications');
    revalidatePath('/');
    return { ok: true, modified };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not clear notifications.' };
  }
}

export interface TravelRequestActionState {
  ok?: boolean;
  duplicate?: boolean;
  error?: string;
}

/**
 * #167 "Request travel info" — the EventDetail Team-tab button a viewer who can't see a staffer's
 * travel taps to ask that staffer (or a manager) to share it for this event. requireUser gates the
 * session; the requester email is the UNFORGEABLE session email. We re-read the STORED event and
 * verify BOTH that the requester is on its roster AND that the subject is too — so the action can't
 * be abused to spam arbitrary users or fabricate a request the UI wouldn't have offered. The
 * notification create is deduped server-side. Revalidates the bell.
 */
export async function requestTravelInfoAction(
  eventId: string,
  subjectEmail: string
): Promise<TravelRequestActionState> {
  const user = await requireUser();
  const eid = String(eventId ?? '');
  const subject = String(subjectEmail ?? '').trim().toLowerCase();
  if (!eid || !subject) return { ok: false, error: 'Missing request fields.' };

  const doc = await getEvent(eid);
  if (!doc) return { ok: false, error: 'Event not found.' };
  const roster = (doc.payload.staff ?? []).map((s) => String(s?.email ?? '').trim().toLowerCase());
  const me = user.email.toLowerCase();
  // The requester must be staffed here (the source only shows the button to a staffed viewer), and
  // the subject must be on the roster (no fabricating a request for someone not on the event).
  if (!roster.includes(me) || !roster.includes(subject)) {
    return { ok: false, error: 'You can only request travel for a teammate on this event.' };
  }

  const r = await createTravelRequest(user.email, subject, eid, doc.payload.name);
  if (!r.ok) return { ok: false, error: r.error || 'Request failed.' };
  revalidatePath('/');
  revalidatePath('/notifications');
  return { ok: true, duplicate: r.duplicate };
}

export interface DecideTravelActionState {
  ok?: boolean;
  status?: string;
  already?: boolean;
  error?: string;
}

/**
 * #167 GRANT-APPROVAL — approve or deny a pending travel_request from the notification feed.
 *
 * SECURITY (this is the privileged write — the lib gates WHO may grant; the action gates the
 * SESSION + sanitizes the input):
 *   • requireUser() gates the session AND re-resolves the LIVE directory role on every call (never
 *     the baked token role) — so a demotion takes effect immediately and a manager-rank decide can't
 *     be made by a freshly-demoted user.
 *   • The decider's email + role are the UNFORGEABLE session values passed to decideTravelRequest;
 *     the client supplies ONLY the request id + the decision word. The request's requester/subject/
 *     event all come from the STORED doc, and the lead-of-event check re-reads the stored event.
 *   • decideTravelRequest itself enforces who-may-grant (subject self / manager+ / lead-of-event) and
 *     pins the grant scope to the stored (requester, subject, event). We never pass a requester or
 *     subject here.
 *   • The `decision` arg is clamped to the two allowed words; anything else is rejected before the
 *     lib call. We revalidate the bell + the feed so the badge + rows update.
 */
export async function decideTravelRequestAction(
  requestId: string,
  decision: 'approve' | 'deny'
): Promise<DecideTravelActionState> {
  const user = await requireUser();
  const rid = String(requestId ?? '').trim();
  const dec = decision === 'approve' ? 'approve' : decision === 'deny' ? 'deny' : null;
  if (!rid) return { ok: false, error: 'Missing request id.' };
  if (!dec) return { ok: false, error: 'Invalid decision.' };

  let r;
  try {
    r = await decideTravelRequest(user.email, user.role, rid, dec);
  } catch {
    return { ok: false, error: 'Could not reach the database — try again.' };
  }
  if (!r.ok) return { ok: false, error: r.error || 'Could not update the request.' };
  revalidatePath('/');
  revalidatePath('/notifications');
  // The event detail's PII strip now honors the new grant — refresh it too.
  revalidatePath('/event', 'layout');
  return { ok: true, status: r.status, already: r.already };
}
