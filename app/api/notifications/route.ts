import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/auth';
import { getNotifications, getTravelReminders } from '@/lib/views/notifications';

// GET /api/notifications — the bell's POLL endpoint (60s refresh, mirrors the Python
// NotificationBell's setInterval(load, 60000) hitting /auth/notifications).
//
// Returns the signed-in viewer's feed { items, actionable, reminders } LIVE from Mongo. Read-only.
//
// AUTH: getCurrentUser is the NON-redirecting guard — a signed-out poller gets an empty payload (the
// bell only renders signed-in, but a session that expires mid-poll must degrade, not 302 a fetch).
// getNotifications applies the SAME self/manager/lead visibility + canDecide gate as the SSR render,
// and re-resolves the LIVE role via getCurrentUser, so a demotion takes effect on the next poll.
// No cache — every poll is a real round-trip (the live-DB model).
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ items: [], actionable: 0, reminders: [] }, { status: 200 });
  }
  const [{ items, actionable }, reminders] = await Promise.all([
    getNotifications(user.email, user.role),
    getTravelReminders(user.email),
  ]);
  return NextResponse.json(
    { items, actionable, reminders },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
