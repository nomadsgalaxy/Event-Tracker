// lib/views/event-view.ts — server-side event PII gate + lead resolution.
//
// Faithful port of the eit_auth.py read-strip (_strip_event_entity_pii) and the
// lead resolver (_viewer_leads_event). The DETAIL page must NEVER send a
// staffer's hotel/travel to a client that isn't allowed to see it — the strip
// runs server-side, on the Server Component, before the data crosses the wire.
// This mirrors the Python /db read strip so both stacks gate PII identically.
//
// PURE (no I/O) so it can run in a Server Component after the live DB read.

import { can } from '@/lib/auth/rbac';
import type { EventPayload, Staffer } from '@/lib/types/types';

function lc(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * True iff `viewerEmail` is the LEAD of this event, resolved to an email.
 * `event.lead` is stored as a staffer DISPLAY NAME (legacy) or an email; either
 * way we resolve it to the matching staffer's email via the event's OWN roster
 * and compare to the (unforgeable) session email. Mirrors _viewer_leads_event.
 */
export function viewerLeadsEvent(payload: EventPayload | null | undefined, viewerEmail: string): boolean {
  const ve = lc(viewerEmail);
  if (!payload || !ve) return false;
  const lead = payload.lead;
  if (!lead) return false;
  const ls = String(lead).trim();
  if (ls.includes('@')) return ls.toLowerCase() === ve; // lead already an email
  for (const s of payload.staff ?? []) {
    if (!s || typeof s !== 'object') continue;
    if ((s.name ?? '').trim() === ls || (s.email ?? '').trim() === ls) {
      const se = lc(s.email);
      return !!se && se === ve;
    }
  }
  return false;
}

/**
 * Whether the viewer may see THIS staffer's hotel/travel on THIS event. Mirrors
 * the can('staff.pii.view', role, {isSelf, isLeadOfEvent}) check in
 * _strip_event_entity_pii: manager+ outright, OR self, OR the lead of this event,
 * OR an APPROVED #167 travel-data grant.
 *
 * `grantsSet` (optional) is the viewer's set of active 'subjectEmail|eventId' grants
 * (see lib/grants.activeGrantsFor). When the role/context check fails, a matching grant
 * — keyed by THIS staffer's email + THIS event's id — keeps the PII visible. This is the
 * ONLY widening path beyond role/self/lead, and it is scoped to exactly one (subject,
 * event): faithful to the Python strip's `grants_set and (se + "|" + eid) in grants_set`.
 */
export function canSeeStaffPii(
  staffer: Staffer,
  payload: EventPayload | null | undefined,
  viewerEmail: string,
  role: string | null | undefined,
  grantsSet?: ReadonlySet<string> | null,
  /** The AUTHORITATIVE event id for the grant key — pass the envelope `_id` (the id the request/grant
   *  was written against). Falls back to payload.id when omitted. */
  eventId?: string
): boolean {
  const ve = lc(viewerEmail);
  const se = lc(staffer.email);
  const leads = viewerLeadsEvent(payload, ve);
  if (can('staff.pii.view', role, { isSelf: !!se && se === ve, isLeadOfEvent: leads })) {
    return true;
  }
  // An approved travel-data grant keeps THIS staffer on THIS event visible — scoped to one
  // subject+event. The event id is the AUTHORITATIVE envelope id (never a client value); the grant key
  // it must match was written against that same id.
  if (grantsSet && se) {
    const eid = String(eventId ?? payload?.id ?? '').trim();
    if (eid && grantsSet.has(`${se}|${eid}`)) return true;
  }
  return false;
}

/**
 * Whether the viewer may see THIS staffer's ACCOMMODATIONS profile (dietary / allergies /
 * accessibility / medical / emergency contact). Mirrors can('accommodations.view', role,
 * {isSelf}) — manager+ OR self, and crucially NOT the lead (medical/dietary is more sensitive
 * than the travel logistics a lead needs). This is a STRICTER gate than canSeeStaffPii.
 *
 * Faithful to the Python canSeeAccommodations(viewer, subject, [event]): for the per-event
 * EventDetail the subject is always staffed here, so the only ctx that matters is isSelf — the
 * role grant covers manager+ and self is the lone context grant on accommodations.view.
 */
export function canSeeAccommodations(
  staffer: Staffer,
  viewerEmail: string,
  role: string | null | undefined
): boolean {
  const ve = lc(viewerEmail);
  const se = lc(staffer.email);
  return can('accommodations.view', role, { isSelf: !!se && se === ve });
}

/**
 * Return a SHALLOW-CLONED event payload with each staffer's hotel/travel removed
 * for staffers this viewer may not see. The original is never mutated (the Server
 * Component's DB doc stays intact for any subsequent server-side use). This is the
 * authoritative read gate: a non-privileged client literally never receives the PII.
 */
export function stripEventPii(
  payload: EventPayload,
  viewerEmail: string,
  role: string | null | undefined,
  grantsSet?: ReadonlySet<string> | null,
  /** The AUTHORITATIVE event id (the envelope `_id`) for grant matching — see canSeeStaffPii. */
  eventId?: string
): EventPayload {
  const staff = payload.staff;
  if (!Array.isArray(staff)) return payload;
  // Fast path: manager+ (or anyone the cap grants regardless of staffer) sees all —
  // but we still must evaluate per-staffer for self/lead/grant, so just map every row.
  const next: EventPayload = { ...payload };
  next.staff = staff.map((s) => {
    if (!s || typeof s !== 'object') return s;
    // The two PII tiers are gated INDEPENDENTLY: hotel/travel by canSeeStaffPii (role/self/lead/grant),
    // and accommodations by the STRICTER canSeeAccommodations (manager+/self — NOT a lead, NOT a travel
    // grant). A travel grant or a lead must never widen accommodations, so we can't piggyback both
    // tiers on canSeeStaffPii's single verdict.
    const seePii = canSeeStaffPii(s, payload, viewerEmail, role, grantsSet, eventId);
    // feedback (the post-event survey) carries personal opinions/comments. Role/self/lead tier —
    // but NOT the #167 grant path: a travel-data grant is scoped to flights/lodging and must not
    // quietly widen to survey opinions (same reasoning that keeps accommodations off the grant).
    const seeFeedback = canSeeStaffPii(s, payload, viewerEmail, role, null, eventId);
    const seeAcc = canSeeAccommodations(s, viewerEmail, role);
    if (seePii && seeFeedback && seeAcc) return s;
    const { hotel, travel, accommodations, feedback, ...base } = s;
    const out = { ...base } as typeof s;
    if (seePii) {
      if (hotel !== undefined) out.hotel = hotel;
      if (travel !== undefined) out.travel = travel;
    }
    if (seeFeedback && feedback !== undefined) out.feedback = feedback;
    if (seeAcc && accommodations !== undefined) out.accommodations = accommodations;
    return out;
  });
  return next;
}
