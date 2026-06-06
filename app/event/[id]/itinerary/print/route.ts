import { getCurrentUser } from '@/lib/auth';
import { getDb, NOT_DELETED } from '@/lib/mongo';
import { getEvent } from '@/lib/data';
import { buildItinerarySnapshot, renderItineraryHtml, type ItineraryTraveler } from '@/lib/itinerary';
import { canSeeStaffPii } from '@/lib/event-view';
import { activeGrantsFor } from '@/lib/grants';
import type { UserDoc, AccommodationsProfile } from '@/lib/types';

// GET /event/[id]/itinerary/print?staff=<email> — the EVENT-VIEW "Print my itinerary" (#86), now the
// SAME rich, boarding-pass-styled, Data-Matrix-coded document as "Print all my travel", scoped to ONE
// event + ONE traveler. The event detail opens this in a new tab; it self-prints on load.
//
// SECURITY: server-authoritative PII gate. The `staff` param is only honored for a staffer the viewer
// is allowed to see on THIS event — self always; otherwise canSeeStaffPii (manager+, lead-of-event, or
// an approved #167 travel grant). A viewer who can't see the staffer's travel gets a 403, never the
// data. Accommodations are gated independently inside buildItinerarySnapshot (isSelf ⇒ self-context;
// others ⇒ manager+ by role — a lead does NOT see accommodations), mirroring the detail read-strip.
export const dynamic = 'force-dynamic';
const USERS = 'users';

function page(status: number, body: string): Response {
  return new Response('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:32px;color:#555">' + body + '</body>', {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return page(401, 'Sign in to print this itinerary.');

  const { id } = await params;
  const viewerEmail = user.email.trim().toLowerCase();
  const target = (new URL(req.url).searchParams.get('staff') || '').trim().toLowerCase() || viewerEmail;
  const isSelf = target === viewerEmail;

  const doc = await getEvent(id);
  if (!doc) return page(404, 'Event not found.');
  const ev = doc.payload;

  const staffer = (ev.staff ?? []).find((s) => s && String(s.email || '').trim().toLowerCase() === target);
  if (!staffer) return page(404, 'That person is not staffed on this event.');

  // Non-self: the viewer must be permitted to see this staffer's hotel/travel on this event.
  if (!isSelf) {
    const grants = await activeGrantsFor(viewerEmail);
    if (!canSeeStaffPii(staffer, ev, viewerEmail, user.role, grants, id)) {
      return page(403, 'You don’t have permission to print this traveler’s itinerary.');
    }
  }

  // Resolve the traveler's directory record for name / port-of-call / accommodations.
  const db = await getDb();
  const tDoc = await db.collection<UserDoc>(USERS).findOne({ _id: target, ...NOT_DELETED });
  const p = (tDoc?.payload ?? {}) as {
    name?: string;
    preferredName?: string;
    role?: string;
    portOfCall?: { airport?: string; trainStation?: string } | null;
    accommodations?: AccommodationsProfile | null;
  };
  const traveler: ItineraryTraveler = {
    email: target,
    name: (p.preferredName || p.name || staffer.name || target).trim(),
    role: p.role || '',
    portOfCall: p.portOfCall ?? null,
    accommodations: p.accommodations ?? null,
  };

  // Scoped to THIS event only (buildItinerarySnapshot filters to events the staffer is rostered on).
  const snap = buildItinerarySnapshot(traveler, [doc], user.role, isSelf);
  const html = renderItineraryHtml(snap);
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
