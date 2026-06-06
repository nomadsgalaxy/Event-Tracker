import { type NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getDb, NOT_DELETED } from '@/lib/mongo';
import { getEvents } from '@/lib/data';
import { can } from '@/lib/rbac';
import { buildItinerarySnapshot, renderItineraryHtml, type ItineraryTraveler } from '@/lib/itinerary';
import type { UserDoc, AccommodationsProfile } from '@/lib/types';

// GET /config/users/itinerary/print?email=<subject> — print ANOTHER staffer's all-events itinerary
// (the Users tab "Print itinerary"). Mirrors the source's manager+ "print someone else's travel".
//
// SECURITY (this is the cross-user PII print — gated tighter than the self route):
//   • requires a signed-in session (getCurrentUser) AND the itinerary.print.others capability on the
//     viewer's LIVE role (manager+). A lead/authorized/read-only caller is 403'd — they can print
//     ONLY their own (the /account/itinerary/print route). No subject param is honored without the cap.
//   • the subject email is a query param (this is the WHOLE point — printing someone else), but the
//     PII gate is the cap, not the param: buildItinerarySnapshot is called with isSelf:false so
//     accommodations are included ONLY when the viewer passes accommodations.view by ROLE (manager+).
//     staff travel/hotel itself flows through the same manager+ gate the source enforces.
//   • the subject is read from the directory (pinned to a scalar _id); a missing subject 404s.
export const dynamic = 'force-dynamic';

const USERS_COLLECTION = 'users';

interface SubjectPayload {
  name?: string;
  preferredName?: string;
  portOfCall?: { airport?: string; trainStation?: string } | null;
  accommodations?: AccommodationsProfile | null;
  role?: string;
}

function htmlError(status: number, msg: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:32px;color:#555">${msg}</body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export async function GET(req: NextRequest) {
  const viewer = await getCurrentUser();
  if (!viewer) return htmlError(401, 'Sign in to print an itinerary.');
  if (!can('itinerary.print.others', viewer.role)) {
    return htmlError(403, "You do not have permission to print another staffer's itinerary.");
  }

  const subjectEmail = String(req.nextUrl.searchParams.get('email') ?? '').trim().toLowerCase();
  if (!subjectEmail) return htmlError(400, 'A subject email is required.');

  const db = await getDb();
  const [subjectDoc, events] = await Promise.all([
    db.collection<UserDoc>(USERS_COLLECTION).findOne({ _id: subjectEmail, ...NOT_DELETED }),
    getEvents(),
  ]);
  if (!subjectDoc) return htmlError(404, 'That user is not in the directory.');
  const p = (subjectDoc.payload ?? {}) as SubjectPayload;

  const traveler: ItineraryTraveler = {
    email: subjectEmail,
    name: (p.preferredName || p.name || subjectEmail).trim(),
    role: p.role || 'read-only',
    portOfCall: p.portOfCall ?? null,
    accommodations: p.accommodations ?? null,
  };

  // isSelf:false ⇒ the accommodations gate is judged on the VIEWER's role (manager+), not the subject.
  const snap = buildItinerarySnapshot(traveler, events, viewer.role, false);
  const html = renderItineraryHtml(snap);
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
