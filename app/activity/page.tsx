import { requireUser } from '@/lib/auth/auth';
import { getActivityFeed } from '@/lib/views/activity';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ActivityFeed } from './activity-feed';

// /activity — the OPERATIONAL activity log (Archetype B: eyebrow -> headline -> a reverse-chronological
// feed grouped by day, with a search + a type filter + an actor filter). Reachable ONLY from the user
// menu, never the primary nav (NAV_EXCLUDED = {account, activity}). DESIGN_ALIGNMENT.md §4.12.
//
// DATA SOURCE — the SHARED operational feed (faithful to the Python ActivityScreen / eitActivityFeed):
// every event's audit[] entries + every live inventory item's flags, across ALL actors. This is NOT
// the per-user security audit_log (Config > Audit, admin-only); the operational feed is the cross-actor
// logistics trail. Built server-side from the live events + inventory (no cache, the live-DB model).
//
// AUTH (owner override §0): EVERY screen is auth-gated. requireUser() (any signed-in role) — the feed
// carries no staff travel/hotel PII (audit/flag rows are actor + a short note), so no per-staffer strip
// is needed; the events themselves are auth-gated reads.
export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  await requireUser();
  const rows = await getActivityFeed();

  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <ScreenHeader
        eyebrow="Activity"
        title="Activity log"
        subtitle="Sign-off, shipping, reconciliation, and inventory-flag activity across every show — newest first."
      />
      <ActivityFeed rows={rows} />
    </div>
  );
}
