import { requireUser } from '@/lib/auth/auth';
import { getEvents, getCases, getInventory, getUserWeightUnit } from '@/lib/db/data';
import { activeGrantsFor } from '@/lib/auth/grants';
import {
  buildInventoryReport,
  buildEventsReport,
  buildConditionReport,
  buildPeopleReport,
  buildFeedbackReport,
  type ItemEntry,
  type EventEntry,
  type CaseEntry,
} from '@/lib/views/reports';
import { ReportsScreen } from './reports-screen';

// app/reports — the REPORTS screen (DESIGN_ALIGNMENT §4.9). Archetype B: a ScreenHeader
// (eyebrow "OPERATIONS · REPORTS" → "Reports" → Export CSV) over an underline TAB STRIP of the four
// report sections the existing Python ReportsScreen organizes (index.html ~L30154): Inventory &
// stock · Events & cases · Condition & loss · People & travel. Each section is one or more compact
// real <table>s (Reports is THE one screen that uses a real table, not a grid-pseudo-table — §5) +
// per-section CSV export of the visible rows.
//
// Server Component: reads events + cases + inventory LIVE from Mongo on every request (no cache, no
// localStorage) and computes every report row here via the shared, isomorphic lib/reports builders
// (which reuse the catalog/manifest item helpers — a count never drifts). The lean, serializable
// rows pass down to the client table island for tab switching + the client-side CSV download.
//
// AUTH: requireUser gates the SESSION (OWNER OVERRIDE — every screen stays auth-gated; signed-out →
// /login). The People & travel PII is gated PER (event, staffer) on the server, with the SAME gates
// the EventDetail read-strip uses (lib/event-view):
//   • the TRAVEL ROSTER respects canSeeStaffPii — manager+ sees all, others only events they LEAD /
//     themselves / an approved #167 travel grant; a staffer the viewer can't see is never emitted, so
//     their flights never serialize to the client.
//   • the ACCOMMODATIONS summary uses the STRICTER canSeeAccommodations — manager+/self ONLY (not a
//     lead) — and surfaces visible/gated COUNTS only (no profile data crosses the wire).
export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const user = await requireUser();
  const [eventDocs, caseDocs, invDocs, weightUnit, grants] = await Promise.all([
    getEvents(),
    getCases(),
    getInventory(),
    getUserWeightUnit(user.email),
    activeGrantsFor(user.email),
  ]);

  const items: ItemEntry[] = invDocs.map((d) => ({ id: d._id, payload: d.payload }));
  const events: EventEntry[] = eventDocs.map((d) => ({ id: d._id, payload: d.payload }));
  const cases: CaseEntry[] = caseDocs.map((d) => ({ id: d._id, payload: d.payload }));

  const inventory = buildInventoryReport(items);
  const eventsReport = buildEventsReport(items, events, cases);
  const condition = buildConditionReport(items, events);
  // People PII is gated per (event, staffer) inside the builder using the AUTHORITATIVE session email
  // + live role + the viewer's active grant set + the envelope event id — never a client value.
  const people = buildPeopleReport(events, user.email, user.role, grants);
  // Post-event survey rollup — per-event rows are included only where the viewer passes the same
  // manager+/lead gate as the per-event Event Report page (comments never cross to this screen).
  const feedback = buildFeedbackReport(events, user.email, user.role);

  return (
    <ReportsScreen
      inventory={inventory}
      events={eventsReport}
      condition={condition}
      people={people}
      feedback={feedback}
      weightUnit={weightUnit}
    />
  );
}
