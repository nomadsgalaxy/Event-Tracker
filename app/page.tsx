import { getDashboardData } from '@/lib/dashboard-metrics';
import { requireUser } from '@/lib/auth';
import { can } from '@/lib/rbac';
import { getUserTempUnit } from '@/lib/data';
import DashboardClient from './_dashboard/dashboard-client';

// Dashboard (/) — Archetype A (DESIGN_ALIGNMENT §4.1): a contextual LEFT filter rail + a main
// column with the editorial hero, the KPI strip, and the TODAY-line timeline.
//
// Server Component: reads the live dashboard payload (events + the event→case→inventory cross-join
// for the "items in motion" / open-flags KPIs + per-event manifest progress) straight from Mongo on
// every request — no cache, no localStorage. The payload flows into the client DashboardClient,
// which owns the instant client-side filter + Find search so a keystroke never costs a round-trip
// while the data stays a real DB read.
export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  // requireUser() redirects a signed-out / forged-cookie request to /login BEFORE any data is
  // shown (the Node guard is the real gate — the Edge middleware can't verify the session HMAC).
  // Parallel with the read for the authed path. Auth gating stays AS-IS for this wave.
  const [data, user] = await Promise.all([getDashboardData(), requireUser()]);

  // event.create is manager+ in the seeded matrix; gate the New-event affordance on the live role.
  const canCreate = can('event.create', user.role);
  const tempUnit = await getUserTempUnit(user.email);

  return <DashboardClient data={data} canCreate={canCreate} tempUnit={tempUnit} />;
}
