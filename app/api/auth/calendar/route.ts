import { type NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth/auth';
import { getCalendarFeeds } from '@/lib/integrations/calendar-feed';
import { jsonOk } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// GET /api/auth/calendar — the caller's personal .ics URL (+ a global one if manager+). The LIVE role
// (requireUser) decides whether a global URL is issued. Mirrors eit_calendar._h_get.
export async function GET(req: NextRequest) {
  const user = await requireUser(); // redirects to /login when no full session
  const origin = new URL(req.url).origin;
  const feeds = await getCalendarFeeds(user.email, user.role, origin);
  return jsonOk(feeds as unknown as Record<string, unknown>);
}
