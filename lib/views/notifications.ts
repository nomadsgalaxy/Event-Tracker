import 'server-only';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db/mongo';
import { rankOf } from '@/lib/auth/rbac';
import { GRANTS_COLLECTION, grantExpiry, type GrantDoc } from '@/lib/auth/grants';
import { viewerLeadsEvent } from '@/lib/views/event-view';
import { dispatchOutbound } from '@/lib/integrations/outbound';
import type { Envelope, EventDoc, Role } from '@/lib/types/types';

// lib/views/notifications.ts — the server-side read/write path for the per-user notification feed.
//
// Faithful to server/eit_auth.py's _h_notifications_get / _h_notif_read. The `notifications`
// collection is NOT an app-plane collection (it's off APP_COLLECTIONS), so the generic /db path
// can never read or write it — the gating lives HERE, server-side, exactly as the Python handler
// does it. Every read is a real Mongo round-trip (no cache, the live-DB model). The collection is
// currently EMPTY in the seed, so getNotifications returns [] and the UI shows a clean caught-up
// state — but this is wired to the real shape so a replicated travel-request lights up the bell.
//
// SELF-SCOPED: a user sees their OWN notifications (payload.to === me). A manager ALSO sees
// PENDING travel-requests addressed to anyone, so they can approve on the subject's behalf — the
// same visibility rule as the Python _h_notifications_get. The mark-as-read path is strictly
// self-only (payload.to === me), mirroring _h_notif_read.

const NOTIFS_COLLECTION = 'notifications';

// The notification payload shape the Python handlers write/read. Loose `data` so the bell + list
// can render the known travel_request / travel_request_result variants without owning the full
// server-side request/grant machinery (that lives in eit_auth, off this rewrite's scope).
export interface NotificationData {
  status?: 'pending' | 'approved' | 'denied' | string;
  subjectEmail?: string;
  requesterEmail?: string;
  eventId?: string;
  eventName?: string;
  [k: string]: unknown;
}

export interface NotificationPayload {
  id?: string;
  to?: string; // recipient email (lower-cased)
  type?: 'travel_request' | 'travel_request_result' | string;
  data?: NotificationData;
  createdAt?: number;
  readAt?: number | null;
  deletedAt?: number | null;
}

export type NotificationDoc = Envelope<NotificationPayload>;

// The lean, fully-serializable shape the client components consume — no Mongo internals, the
// envelope _id folded in as a stable React key + the mark-read target. Mirrors the fields the
// current app's NotifRow reads off `n` (id, type, data, readAt).
export interface NotificationItem {
  /** Stable id: payload.id if present, else the envelope _id (the mark-read key). */
  id: string;
  /** The envelope _id — the document key the read action stamps readAt on. */
  docId: string;
  type: string;
  data: NotificationData;
  to: string;
  createdAt: number;
  readAt: number | null;
  /** True when this row is mine AND unread (drives the unread dot + the read action target). */
  mine: boolean;
  /** True iff this is a PENDING travel_request the viewer is authorized to Approve/Deny (subject self
   *  / manager+ / lead-of-event). Drives the inline Approve/Deny buttons — the action re-checks this
   *  server-side, so this is a UI hint, NOT the security boundary. */
  canDecide: boolean;
}

export interface NotificationsResult {
  items: NotificationItem[];
  /** Awaiting-action count for the bell badge: pending requests I (or, as a manager, anyone) can
   *  act on + my own unread notifications. Mirrors the Python `actionable`. */
  actionable: number;
}

/** A client-side travel REMINDER: an event the viewer is staffed on, starting within 14 days, for
 *  which they have no travel set yet → a ✈️ "add your travel" nudge with a "Go" deep-link. */
export interface TravelReminder {
  id: string;
  eventId: string;
  eventName: string;
  startDate: string;
}

/**
 * The viewer's travel reminders: every (non-deleted) event they're staffed on that starts within the
 * next 14 days and has NO travel (outbound/return) set. Faithful to the Python NotificationBell's
 * client `reminders` memo (index.html ~L30666) — computed SERVER-SIDE here so the bell needs no
 * client-only Date during its initial render (the mount-gate rule) and no client event fetch.
 *
 * Returns [] on any DB error (the bell is ambient chrome). The 14-day window is computed against the
 * server clock at request time; the bell's 60s poll re-reads it so the window stays fresh.
 */
export async function getTravelReminders(email: string): Promise<TravelReminder[]> {
  const me = lc(email);
  if (!me) return [];
  let docs: EventDoc[];
  try {
    const db = await getDb();
    docs = await db
      .collection<EventDoc>('events')
      .find({ $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] })
      .toArray();
  } catch {
    return [];
  }
  const now = Date.now();
  const soon = now + 14 * 86400000;
  const out: TravelReminder[] = [];
  for (const d of docs) {
    const ev = d?.payload;
    if (!ev) continue;
    const sd = String(ev.startDate ?? '').trim();
    // Parse the start as local midnight (matches the source's new Date(startDate + 'T00:00')).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sd)) continue;
    const [y, m, dd] = sd.split('-').map(Number);
    const start = new Date(y, (m || 1) - 1, dd || 1).getTime();
    if (!start || start < now || start > soon) continue;
    const staffer = (ev.staff ?? []).find((s) => lc(s?.email) === me);
    if (!staffer) continue;
    const hasTravel = !!(staffer.travel && (staffer.travel.outbound || staffer.travel.return));
    if (hasTravel) continue;
    out.push({ id: `rem_${d._id}`, eventId: d._id, eventName: ev.name || '', startDate: sd });
  }
  // Soonest first.
  out.sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
  return out;
}

function lc(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * The signed-in user's notifications (newest first) + the bell's actionable count. Faithful port
 * of _h_notifications_get: include a doc when it's mine (payload.to === me) OR it's a PENDING
 * travel-request and I'm a manager+ (so I can approve). Skips soft-deleted payloads. The
 * actionable count adds every pending request shown + every one of MY unread notifications.
 *
 * Returns an empty result on any DB error rather than throwing — the bell is ambient chrome and
 * must never take the page down; the page-level list surfaces a real empty/caught-up state.
 */
export async function getNotifications(email: string, role: Role | string): Promise<NotificationsResult> {
  const me = lc(email);
  if (!me) return { items: [], actionable: 0 };
  const isManager = rankOf(role) >= rankOf('manager');

  let db;
  let docs: NotificationDoc[];
  try {
    // Read the whole collection then filter in-process — same as the Python handler (find {} then
    // self/manager filter). The feed is small (capped at 100 below) so this is one cheap round-trip.
    // getDb() can throw (DB unreachable) — caught here so the bell (root-layout chrome) never crashes.
    db = await getDb();
    docs = await db.collection<NotificationDoc>(NOTIFS_COLLECTION).find({}).toArray();
  } catch {
    return { items: [], actionable: 0 };
  }

  // For the lead-of-event decide path: collect the event ids referenced by PENDING requests this
  // viewer is NOT already entitled to (not subject, not manager), then resolve which of those events
  // the viewer LEADS. One bounded extra round-trip; only when a non-manager has visible pending reqs.
  const leadCandidateEventIds = new Set<string>();
  if (!isManager) {
    for (const d of docs) {
      const pl = d?.payload;
      if (!pl || typeof pl !== 'object' || pl.deletedAt) continue;
      if (pl.type !== 'travel_request' || (pl.data?.status ?? '') !== 'pending') continue;
      const subj = lc(pl.data?.subjectEmail);
      if (subj === me) continue; // already the subject — handled below
      const eid = String(pl.data?.eventId ?? '').trim();
      if (eid) leadCandidateEventIds.add(eid);
    }
  }
  const ledEventIds = new Set<string>();
  if (leadCandidateEventIds.size > 0) {
    try {
      const evs = await db
        .collection<EventDoc>('events')
        .find({ _id: { $in: Array.from(leadCandidateEventIds) } })
        .toArray();
      for (const ev of evs) {
        if (viewerLeadsEvent(ev.payload, me)) ledEventIds.add(ev._id);
      }
    } catch {
      /* fail closed — no extra lead-decide entitlement */
    }
  }

  const items: NotificationItem[] = [];
  let actionable = 0;
  for (const d of docs) {
    const pl = d?.payload;
    if (!pl || typeof pl !== 'object' || pl.deletedAt) continue;
    const isMine = lc(pl.to) === me;
    const isPendingReq = pl.type === 'travel_request' && (pl.data?.status ?? '') === 'pending';
    const subj = lc(pl.data?.subjectEmail);
    const eid = String(pl.data?.eventId ?? '').trim();
    // canDecide: the SUBJECT (self) / a MANAGER+ / the LEAD of the request's event may approve/deny.
    const canDecide =
      isPendingReq && (subj === me || isManager || (!!eid && ledEventIds.has(eid)));
    // Visibility: it's mine (the subject sees it as `to`), OR it's a pending req I can decide
    // (manager sees all pending; a lead sees the ones for events they lead).
    if (!(isMine || (isPendingReq && canDecide))) continue;

    const readAt = typeof pl.readAt === 'number' ? pl.readAt : null;
    items.push({
      id: pl.id || d._id,
      docId: d._id,
      type: pl.type || 'unknown',
      data: pl.data || {},
      to: lc(pl.to),
      createdAt: typeof pl.createdAt === 'number' ? pl.createdAt : 0,
      readAt,
      mine: isMine && readAt == null,
      canDecide,
    });

    if (isPendingReq) actionable += 1;
    else if (isMine && readAt == null) actionable += 1;
  }

  items.sort((a, b) => b.createdAt - a.createdAt);
  return { items: items.slice(0, 100), actionable };
}

/**
 * Mark the caller's notifications read (all of mine, or only the given ids). Strictly self-scoped:
 * only docs whose payload.to === me are touched — a crafted id list can never flag another user's
 * row. Stamps payload.readAt + envelope updatedAt so the change replicates via eit_sync. Faithful
 * to _h_notif_read. Returns the number of rows newly marked read.
 *
 * `ids` filters by the notification's payload.id (the same id the client sees), matching the
 * Python handler which compares against pl.get("id").
 */
export async function markNotificationsRead(email: string, ids?: string[] | null): Promise<{ modified: number }> {
  const me = lc(email);
  if (!me) return { modified: 0 };
  const idSet = Array.isArray(ids) && ids.length ? new Set(ids.map((s) => String(s))) : null;

  const db = await getDb();
  const col = db.collection<NotificationDoc>(NOTIFS_COLLECTION);
  // Pin the recipient filter to payload.to (a scalar) so the write is self-scoped at the query
  // level — never a full-collection scan, never another user's row.
  const mine = await col.find({ 'payload.to': me }).toArray();

  const now = Date.now();
  let modified = 0;
  for (const d of mine) {
    const pl = d.payload || {};
    if (pl.readAt) continue; // already read
    if (idSet && !idSet.has(String(pl.id ?? d._id))) continue; // not in the requested subset
    const res = await col.updateOne(
      { _id: d._id, 'payload.to': me },
      { $set: { 'payload.readAt': now, updatedAt: now } }
    );
    if (res.modifiedCount > 0) modified += 1;
  }
  return { modified };
}

export interface TravelRequestResult {
  /** true = a request now exists for (requester, subject, event). */
  ok: boolean;
  /** true = an identical PENDING request already existed (no new doc written). */
  duplicate: boolean;
  error?: string;
}

/**
 * Create a #167 travel-data REQUEST: the requester (staffed on the event) asks the subject (or a
 * manager) to share their travel/hotel for this event. Faithful to the Python /auth/notify/request:
 * writes a `travel_request` notification ADDRESSED TO THE SUBJECT with data {status:'pending',
 * subjectEmail, requesterEmail, eventId, eventName}, so it lights the subject's bell (and any
 * manager's, via getNotifications's manager rule). Deduped: an existing PENDING request from the
 * SAME requester to the SAME subject for the SAME event is a no-op `duplicate:true` (the source's
 * "Already requested"). Stamps createdAt/updatedAt so it replicates via eit_sync.
 *
 * The requester email is the UNFORGEABLE session email (passed by the Server Action), never a
 * client-supplied value; the subject/event come from the (already-rendered) event roster.
 */
export async function createTravelRequest(
  requesterEmail: string,
  subjectEmail: string,
  eventId: string,
  eventName?: string
): Promise<TravelRequestResult> {
  const requester = lc(requesterEmail);
  const subject = lc(subjectEmail);
  const eid = String(eventId ?? '').trim();
  if (!requester || !subject || !eid) return { ok: false, duplicate: false, error: 'Missing request fields.' };
  if (requester === subject) return { ok: false, duplicate: false, error: 'You already have your own travel.' };

  const db = await getDb();
  const col = db.collection<NotificationDoc>(NOTIFS_COLLECTION);

  // Dedup: a PENDING request from this requester → this subject for this event already on file.
  const existing = await col.findOne({
    'payload.type': 'travel_request',
    'payload.to': subject,
    'payload.data.requesterEmail': requester,
    'payload.data.eventId': eid,
    'payload.data.status': 'pending',
    'payload.deletedAt': { $in: [null, undefined] },
  });
  if (existing) return { ok: true, duplicate: true };

  const now = Date.now();
  const id = randomUUID();
  const doc: NotificationDoc = {
    _id: id,
    payload: {
      id,
      to: subject,
      type: 'travel_request',
      data: {
        status: 'pending',
        subjectEmail: subject,
        requesterEmail: requester,
        eventId: eid,
        eventName: eventName || '',
      },
      createdAt: now,
      readAt: null,
      deletedAt: null,
    },
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await col.insertOne(doc);
  return { ok: true, duplicate: false };
}

// ── Flight delay / cancellation alert (written by the background flight auto-refresh) ─────────────
// A system-generated notification: a tracked flight for `to` newly delayed or cancelled. Self-scoped
// like every other notif (payload.to === recipient), so it shows in that person's bell. Deduped within
// 12h on event + flight + leg + status, BUT delay-aware: a 'delayed' alert is only suppressed when the
// delay hasn't grown by at least FLIGHT_ALERT_GROW_MIN since the last one — so a 20min→90min slip still
// reaches the traveler, while repeated sweeps re-observing the same delay don't pile up.
const FLIGHT_ALERT_GROW_MIN = 15;

export interface FlightAlertData {
  eventId: string;
  eventName?: string;
  subjectEmail: string; // whose flight (the traveler)
  flightNumber: string;
  leg: 'outbound' | 'return' | string;
  status: string; // 'delayed' | 'cancelled' | …
  delayMin: number;
}

export async function createFlightAlert(to: string, data: FlightAlertData): Promise<{ ok: boolean; duplicate?: boolean }> {
  const recipient = lc(to);
  if (!recipient || !data.eventId) return { ok: false };
  const db = await getDb();
  const col = db.collection<NotificationDoc>(NOTIFS_COLLECTION);

  const since = Date.now() - 12 * 60 * 60 * 1000;
  const existing = await col.findOne(
    {
      'payload.type': 'flight_delay',
      'payload.to': recipient,
      'payload.data.eventId': data.eventId,
      'payload.data.flightNumber': data.flightNumber,
      'payload.data.leg': data.leg,
      'payload.data.status': data.status,
      'payload.createdAt': { $gte: since },
      'payload.deletedAt': { $in: [null, undefined] },
    },
    { sort: { 'payload.createdAt': -1 } },
  );
  if (existing) {
    // A non-delay status (cancelled, diverted) is a one-shot — suppress the repeat. A 'delayed' repeat is
    // only suppressed while the delay hasn't materially grown since the last alert.
    if (data.status !== 'delayed') return { ok: true, duplicate: true };
    const prevDelay = Number(
      (existing.payload as { data?: { delayMin?: number } } | undefined)?.data?.delayMin ?? 0,
    );
    if (data.delayMin - prevDelay < FLIGHT_ALERT_GROW_MIN) return { ok: true, duplicate: true };
  }

  const now = Date.now();
  const id = randomUUID();
  const doc: NotificationDoc = {
    _id: id,
    payload: {
      id,
      to: recipient,
      type: 'flight_delay',
      data: { ...data, subjectEmail: lc(data.subjectEmail) },
      createdAt: now,
      readAt: null,
      deletedAt: null,
    },
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await col.insertOne(doc);
  void dispatchOutbound({
    type: 'flight_delay',
    summary: `Flight ${data.flightNumber} ${data.status}${data.delayMin ? ` (+${data.delayMin}m)` : ''} — ${data.eventName || data.eventId}, ${data.leg}`,
    // Allow-list — NO staff emails: a third-party webhook must not receive traveler PII (the app
    // gates staff travel PII to manager+ elsewhere). The summary carries the non-PII detail.
    data: {
      eventId: data.eventId,
      eventName: data.eventName,
      flightNumber: data.flightNumber,
      leg: data.leg,
      status: data.status,
      delayMin: data.delayMin,
    },
  });
  return { ok: true, duplicate: false };
}

// ── Severe weather alert (lib/integrations/weather-refresh sweep → bell) ───────────────────────────
// One-shot per (recipient, event, alertId): the same active warning sweeps repeatedly, so we dedup on
// the alert's stable id within 24h. A NEW warning (different id) for the same event still notifies.
export interface WeatherAlertData {
  eventId: string;
  eventName?: string;
  source: 'nws' | 'forecast' | string;
  event: string; // "Tornado Warning" / "Rough weather"
  severity: string; // 'extreme' | 'severe' | 'rough' | …
  headline: string;
  areaDesc?: string;
  alertId: string; // the source alert id — the dedup key
  expires?: string | null;
}

export async function createWeatherAlert(to: string, data: WeatherAlertData): Promise<{ ok: boolean; duplicate?: boolean }> {
  const recipient = lc(to);
  if (!recipient || !data.eventId || !data.alertId) return { ok: false };
  const db = await getDb();
  const col = db.collection<NotificationDoc>(NOTIFS_COLLECTION);

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const existing = await col.findOne({
    'payload.type': 'severe_weather',
    'payload.to': recipient,
    'payload.data.eventId': data.eventId,
    'payload.data.alertId': data.alertId,
    'payload.createdAt': { $gte: since },
    'payload.deletedAt': { $in: [null, undefined] },
  });
  if (existing) return { ok: true, duplicate: true };

  const now = Date.now();
  const id = randomUUID();
  const doc: NotificationDoc = {
    _id: id,
    payload: {
      id,
      to: recipient,
      type: 'severe_weather',
      data: { ...data },
      createdAt: now,
      readAt: null,
      deletedAt: null,
    },
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await col.insertOne(doc);
  // Weather warnings carry no staff PII, so the outbound webhook gets the full summary.
  void dispatchOutbound({
    type: 'severe_weather',
    summary: `${data.event} — ${data.eventName || data.eventId}${data.areaDesc ? ` (${data.areaDesc})` : ''}`,
    data: {
      eventId: data.eventId,
      eventName: data.eventName,
      event: data.event,
      severity: data.severity,
      headline: data.headline,
      areaDesc: data.areaDesc,
      source: data.source,
    },
  });
  return { ok: true, duplicate: false };
}

export interface DecideResult {
  ok: boolean;
  /** The resolved status when ok ('approved' | 'denied'), or the existing status if already decided. */
  status?: 'approved' | 'denied' | string;
  /** True when the request had already been decided (idempotent no-op). */
  already?: boolean;
  error?: string;
  /** HTTP-ish code for the caller to map (403 = not allowed to decide, 404 = no such request). */
  code?: number;
}

/**
 * Decide (approve | deny) a #167 travel-data request — the GRANT-APPROVAL path the event-detail
 * pass deferred. Faithful to server/eit_auth.py _h_notif_decide.
 *
 * SECURITY — this is the privileged half of the feature; everything is pinned to the STORED request
 * doc + the unforgeable session identity, never a client value:
 *   • The request is loaded by its id; requester/subject/event come from the STORED doc's data — the
 *     caller supplies ONLY the request id + the decision word.
 *   • WHO MAY DECIDE: the SUBJECT themselves (deciderEmail === data.subjectEmail), OR a MANAGER+,
 *     OR the LEAD of the request's event (re-resolved from the stored event roster). Anyone else is
 *     refused (code 403). The caller (the Server Action) passes the decider's session email + LIVE
 *     role; this never trusts a role/email from the request body.
 *   • Already-decided requests are an idempotent no-op (returns the existing status) — a denied
 *     request can't be flipped to approved by a re-submit.
 *   • ORDER: on approve we write the GRANT FIRST, then flip the request to 'approved'. If the grant
 *     write fails the request stays 'pending' and is retryable (no approved-with-no-grant stuck
 *     state) — the Python red-team fix.
 *   • The grant is scoped to exactly { granteeEmail: requester, subjectEmail: subject, eventId } and
 *     time-boxed (event end + 7d, or 30d). It is the ONLY thing the PII strip honors.
 *
 * Returns a structured result; the Server Action maps it to a toast/redirect.
 */
export async function decideTravelRequest(
  deciderEmail: string,
  deciderRole: Role | string,
  requestId: string,
  decision: 'approve' | 'deny'
): Promise<DecideResult> {
  const me = lc(deciderEmail);
  const rid = String(requestId ?? '').trim();
  if (!me) return { ok: false, error: 'You must be signed in to decide a request.', code: 401 };
  if (!rid) return { ok: false, error: 'Missing request id.', code: 400 };
  if (decision !== 'approve' && decision !== 'deny') {
    return { ok: false, error: 'Decision must be approve or deny.', code: 400 };
  }

  const db = await getDb();
  const col = db.collection<NotificationDoc>(NOTIFS_COLLECTION);

  // Load the STORED request by id (pinned to a scalar _id — the NoSQL-operator defense).
  const rec = await col.findOne({ _id: rid });
  const pl = rec?.payload;
  if (!rec || !pl || pl.type !== 'travel_request') {
    return { ok: false, error: 'Request not found.', code: 404 };
  }
  const data = pl.data || {};
  const subject = lc(data.subjectEmail);
  const requester = lc(data.requesterEmail);
  const eventId = String(data.eventId ?? '').trim();
  if (!subject || !requester || !eventId) {
    return { ok: false, error: 'Request is malformed.', code: 400 };
  }

  // Re-read the stored event so the lead check is on the AUTHORITATIVE roster, not anything supplied.
  let eventDoc: EventDoc | null = null;
  try {
    eventDoc = await db.collection<EventDoc>('events').findOne({ _id: eventId });
  } catch {
    eventDoc = null;
  }
  const isLeadOfEvent = eventDoc ? viewerLeadsEvent(eventDoc.payload, me) : false;
  const isManager = rankOf(deciderRole) >= rankOf('manager');
  const isSubject = me === subject;

  // WHO MAY GRANT: the subject (self), a manager+, or the lead of the event. No one else.
  if (!(isSubject || isManager || isLeadOfEvent)) {
    return { ok: false, error: 'Only the person asked, their event lead, or a manager can decide this.', code: 403 };
  }

  // Idempotent: already decided → no-op, return the existing status (a denied request can't be
  // silently re-approved by a re-submit).
  if (data.status && data.status !== 'pending') {
    return { ok: true, status: data.status, already: true };
  }

  const now = Date.now();
  const eventName = (data.eventName as string) || eventDoc?.payload?.name || '';

  if (decision === 'approve') {
    // GRANT FIRST: write the time-boxed pii_grant. If this fails we leave the request pending.
    const exp = grantExpiry(eventDoc?.payload?.endDate, now);
    const gid = randomUUID();
    const grant: GrantDoc = {
      _id: gid,
      payload: {
        id: gid,
        granteeEmail: requester,
        subjectEmail: subject,
        eventId,
        scope: 'travel',
        grantedBy: me,
        grantedAt: now,
        expiresAt: exp,
        deletedAt: null,
      },
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    try {
      await db
        .collection<GrantDoc>(GRANTS_COLLECTION)
        .updateOne({ _id: gid }, { $set: grant }, { upsert: true });
    } catch {
      return { ok: false, error: 'Could not write the access grant — try again.', code: 503 };
    }
  }

  // Flip the request status (pinned to _id + the unchanged type). Stamp the decider + time.
  const status = decision === 'approve' ? 'approved' : 'denied';
  const nextData = { ...data, status, decidedBy: me, decidedAt: now };
  try {
    const res = await col.updateOne(
      { _id: rid, 'payload.type': 'travel_request' },
      { $set: { 'payload.data': nextData, 'payload.readAt': pl.readAt ?? now, updatedAt: now } }
    );
    if (res.matchedCount === 0) {
      return { ok: false, error: 'Could not update the request — try again.', code: 503 };
    }
  } catch {
    return { ok: false, error: 'Could not update the request — try again.', code: 503 };
  }

  // Notify the requester of the result (best-effort — a failure here doesn't undo the decision).
  try {
    const nid = randomUUID();
    const resultDoc: NotificationDoc = {
      _id: nid,
      payload: {
        id: nid,
        to: requester,
        type: 'travel_request_result',
        data: { eventId, eventName, subjectEmail: subject, status },
        createdAt: now,
        readAt: null,
        deletedAt: null,
      },
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await col.insertOne(resultDoc);
  } catch {
    /* best-effort */
  }

  return { ok: true, status };
}
