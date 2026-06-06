import { getCurrentUser } from '@/lib/auth/auth';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import { getEvents } from '@/lib/db/data';
import { buildItinerarySnapshot, renderItineraryHtml, type ItineraryTraveler } from '@/lib/views/itinerary';
import type { UserDoc } from '@/lib/types/types';
import type { AccommodationsProfile } from '@/lib/types/types';

// GET /account/itinerary/print — "Print all my travel" (#34): a boarding-pass-styled HTML itinerary
// of the SIGNED-IN user's flights/hotels/event credentials across every show they're staffed on. The
// Preferences tab's "Print all my travel" opens this in a new tab; the document self-prints on load
// (the source's printItinerary popup behavior, ported to a server-rendered route).
//
// SECURITY: this is ALWAYS self (viewer === subject). getCurrentUser pins the traveler to the
// UNFORGEABLE session email + re-resolves the LIVE role; there is NO subject/email query param, so it
// can NEVER be pointed at another user's travel. Accommodations notes are gated by the self-context
// accommodations.view grant inside buildItinerarySnapshot (true for any signed-in role on their own
// record). Signed-out → a 401 page (never a redirect that would lose the print intent).
//
// LIVE-DB: reads the caller's own users doc + all events on every request (no cache).
export const dynamic = 'force-dynamic';

const USERS_COLLECTION = 'users';

interface SelfPayload {
  name?: string;
  preferredName?: string;
  portOfCall?: { airport?: string; trainStation?: string } | null;
  accommodations?: AccommodationsProfile | null;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:32px;color:#555">Sign in to print your itinerary.</body>',
      { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
  const id = user.email.trim().toLowerCase();

  const db = await getDb();
  const [selfDoc, events] = await Promise.all([
    db.collection<UserDoc>(USERS_COLLECTION).findOne({ _id: id, ...NOT_DELETED }),
    getEvents(),
  ]);
  const p = (selfDoc?.payload ?? {}) as SelfPayload;

  const traveler: ItineraryTraveler = {
    email: id,
    name: (p.preferredName || p.name || id).trim(),
    role: user.role,
    portOfCall: p.portOfCall ?? null,
    accommodations: p.accommodations ?? null,
  };

  const snap = buildItinerarySnapshot(traveler, events, user.role);
  const html = renderItineraryHtml(snap);
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
