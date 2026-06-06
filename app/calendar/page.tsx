import { getCalendarData } from '@/lib/views/calendar-data';
import { requireUser } from '@/lib/auth/auth';
import { can } from '@/lib/auth/rbac';
import CalendarClient from './calendar-client';
import { parseMonthKey, parseView } from './cal-utils';

// app/calendar — the Year / Month / Week CALENDAR (Server Component), re-cast to Archetype A to
// match the existing Python app's organization (DESIGN_ALIGNMENT §4.2): a LEFT view/quick-jump rail
// + a ScreenHeader (eyebrow → "Season schedule" → range nav + New) + the selected view, with a
// right-side "<year> SCHEDULE · N SHOWS" panel on the Year view.
//
// Reads the live event list from Mongo on every request (no cache, no localStorage). The fetched
// list flows into CalendarClient, which owns instant client-side view/range navigation so a
// prev/next or view switch never costs a round-trip while the underlying data stays a real DB read.
//
// AUTH: requireUser() gates the session (redirects a signed-out / forged-cookie request to /login
// BEFORE any event data is shown — the Node-side gate the Edge middleware can't perform). The
// data-plane read needs a full session; the calendar carries no PII to gate per-field (it shows only
// name/city/state/dates, the same public projection the dashboard uses). Auth gating stays AS-IS.
export const dynamic = 'force-dynamic';

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; view?: string }>;
}) {
  // Parallel: the live read + the auth gate. requireUser redirects before render if signed out.
  const [calData, user, params] = await Promise.all([
    getCalendarData(),
    requireUser(),
    searchParams,
  ]);
  const { events, tags } = calData;

  // event.create is manager+ in the seeded matrix; gate the "New event" affordance on the live role.
  const canCreate = can('event.create', user.role);

  // Resolve the initial month from ?month=YYYY-MM, falling back to the current month on anything
  // missing/malformed (parseMonthKey returns null → fail to "now", never throw). The initial VIEW
  // comes from ?view= (year|month|week), defaulting to Year (the existing app's landing view).
  const parsed = parseMonthKey(params?.month);
  const now = new Date();
  const initialYear = parsed?.year ?? now.getFullYear();
  const initialMonth0 = parsed?.month0 ?? now.getMonth();
  const initialView = parseView(params?.view) ?? 'year';

  return (
    <CalendarClient
      events={events}
      tags={tags}
      initialYear={initialYear}
      initialMonth0={initialMonth0}
      initialView={initialView}
      canCreate={canCreate}
    />
  );
}
