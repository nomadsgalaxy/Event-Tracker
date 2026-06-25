import { getCurrentUser } from '@/lib/auth/auth';
import { can } from '@/lib/auth/rbac';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import { getEvent, getUserDisplayName } from '@/lib/db/data';
import { buildTeamItinerary, renderTeamItineraryHtml } from '@/lib/views/itinerary';
import { canSeeStaffPii, viewerLeadsEvent } from '@/lib/views/event-view';
import { activeGrantsFor } from '@/lib/auth/grants';
import type { UserDoc } from '@/lib/types/types';

// GET /event/[id]/itinerary/team/print — the TEAM itinerary: one document grouping the roster by
// SHARED hotel and SHARED flight, then per traveler. Logistics only (flights + hotels) — NO
// accommodations/medical PII. Opens in a new tab; self-prints on load.
//
// SECURITY: server-authoritative. Allowed only for the EVENT LEAD or a manager+ (itinerary.print.others
// is manager+; viewerLeadsEvent covers the lead). Each staffer is then re-filtered through canSeeStaffPii
// for this event, so the team print can never surface a traveler the viewer couldn't already see.
export const dynamic = 'force-dynamic';
const USERS = 'users';

function page(status: number, body: string): Response {
  return new Response('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:32px;color:#555">' + body + '</body>', {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return page(401, 'Sign in to print the team itinerary.');

  const { id } = await params;
  const viewerEmail = user.email.trim().toLowerCase();

  const doc = await getEvent(id);
  if (!doc) return page(404, 'Event not found.');
  const ev = doc.payload;

  // Lead-of-event OR manager+ only.
  const allowed = can('itinerary.print.others', user.role) || viewerLeadsEvent(ev, viewerEmail);
  if (!allowed) return page(403, 'Only the event lead or a manager can print the team itinerary.');

  const grants = await activeGrantsFor(viewerEmail);
  const visible = (ev.staff ?? []).filter(
    (s) => s && String(s.email || '').trim() && canSeeStaffPii(s, ev, viewerEmail, user.role, grants, id)
  );
  if (visible.length === 0) return page(404, 'No travelers with visible itineraries on this event.');

  // Resolve directory display names for the roster in one read.
  const emails = [...new Set(visible.map((s) => String(s.email).trim().toLowerCase()))];
  const db = await getDb();
  const userDocs = await db
    .collection<UserDoc>(USERS)
    .find({ _id: { $in: emails }, ...NOT_DELETED })
    .toArray();
  const nameByEmail: Record<string, string> = {};
  for (const u of userDocs) {
    const p = (u.payload ?? {}) as { name?: string; preferredName?: string };
    nameByEmail[u._id] = (p.preferredName || p.name || '').trim();
  }

  const capturedBy = { name: (await getUserDisplayName(viewerEmail).catch(() => viewerEmail)) || viewerEmail, role: user.role };
  const team = buildTeamItinerary(ev, visible, nameByEmail, capturedBy, new Date().toISOString());
  return new Response(renderTeamItineraryHtml(team), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
