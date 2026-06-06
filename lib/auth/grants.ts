import 'server-only';
import { getDb } from '@/lib/db/mongo';

// lib/auth/grants.ts — the #167 travel-data GRANT store + the active-grant resolver the event-PII gate
// consults.
//
// A GRANT is the approval artifact of a travel_request: when the subject (or a manager, or the lead
// of the event) APPROVES a request, a time-boxed pii_grant is written. The event read-strip then
// treats that grant as an extra, tightly-scoped grant of staff.pii.view — for EXACTLY one requester,
// one subject, one event — so the requester can see THAT staffer's travel/hotel on THAT event only.
//
// Faithful port of server/eit_auth.py:
//   • _active_grants_for(viewer)  -> the set of 'subjectEmail|eventId' the viewer currently holds an
//     ACTIVE grant for (granteeEmail == viewer, expiresAt > now). Fail-CLOSED on any DB error (empty
//     set => the PII stays stripped).
//   • _GRANT_DEFAULT_DAYS / _GRANT_TRAILING_DAYS -> a grant lasts until the event end + 7 days, or
//     30 days when the event has no end date.
//
// SECURITY: the `pii_grants` collection is OFF the app-collection allowlist (like notifications) — it
// is unreachable from the generic /db data plane and the REST API; only these server accessors and
// the gated decide Server Action touch it. Grants are READ-ONLY input to the PII gate — they never
// affect writes. Everything is pinned to the STORED grant doc + the unforgeable session email; no
// client value decides scope.

export const GRANTS_COLLECTION = 'pii_grants';

export const GRANT_DEFAULT_DAYS = 30; // fallback expiry when the event has no end date
export const GRANT_TRAILING_DAYS = 7; // an approved grant lasts until event end + this many days

export interface GrantPayload {
  id?: string;
  /** The viewer the grant is FOR (the requester) — lower-cased email. */
  granteeEmail: string;
  /** Whose travel/hotel becomes visible — lower-cased email. */
  subjectEmail: string;
  /** The single event the grant is scoped to. */
  eventId: string;
  /** Always 'travel' for #167 (the only grant kind today). */
  scope: 'travel' | string;
  /** Who approved (subject self, manager, or lead) — for the audit trail. */
  grantedBy: string;
  grantedAt: number;
  /** Epoch ms after which the grant is dead (the strip ignores it). */
  expiresAt: number;
  deletedAt?: number | null;
}

export interface GrantDoc {
  _id: string;
  payload: GrantPayload;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number | null;
}

function lc(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** A scoped grant key: 'subjectEmail|eventId' (both normalized). */
export function grantKey(subjectEmail: string, eventId: string): string {
  return `${lc(subjectEmail)}|${String(eventId ?? '').trim()}`;
}

/**
 * The set of 'subjectEmail|eventId' the viewer currently holds an ACTIVE travel-data grant for
 * (granteeEmail === viewer, not expired, not tombstoned). The event read-strip treats each member as
 * an extra grant of staff.pii.view for exactly that one staffer on that one event.
 *
 * Faithful to _active_grants_for: pins the query to payload.granteeEmail (a scalar — the viewer's
 * unforgeable session email), filters expiry in-process. Fail-CLOSED: an empty set on ANY error so a
 * store hiccup can never WIDEN visibility (the PII stays stripped).
 */
export async function activeGrantsFor(viewerEmail: string): Promise<Set<string>> {
  const ve = lc(viewerEmail);
  if (!ve) return new Set();
  const now = Date.now();
  let docs: GrantDoc[];
  try {
    const db = await getDb();
    docs = await db
      .collection<GrantDoc>(GRANTS_COLLECTION)
      .find({ 'payload.granteeEmail': ve })
      .toArray();
  } catch {
    return new Set(); // fail closed
  }
  const out = new Set<string>();
  for (const d of docs) {
    const pl = d?.payload;
    if (!pl || typeof pl !== 'object') continue;
    if (pl.deletedAt) continue;
    if (Number(pl.expiresAt || 0) <= now) continue;
    const subj = lc(pl.subjectEmail);
    const eid = String(pl.eventId ?? '').trim();
    if (subj && eid) out.add(`${subj}|${eid}`);
  }
  return out;
}

/**
 * Compute the expiry epoch for a NEW grant: the event's end date (ISO YYYY-MM-DD) + GRANT_TRAILING_DAYS,
 * else GRANT_DEFAULT_DAYS from now. Faithful to _h_notif_decide's expiry math (the event end is parsed
 * as a local date at midnight, matching the Python time.mktime/strptime).
 */
export function grantExpiry(eventEndDate: string | null | undefined, now = Date.now()): number {
  const end = String(eventEndDate ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    const [y, m, d] = end.split('-').map(Number);
    const ms = new Date(y, (m || 1) - 1, d || 1).getTime();
    if (!Number.isNaN(ms)) return ms + GRANT_TRAILING_DAYS * 86400000;
  }
  return now + GRANT_DEFAULT_DAYS * 86400000;
}
