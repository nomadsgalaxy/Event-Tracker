import { type NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { regenerateFeed } from '@/lib/calendar-feed';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/auth/calendar/regenerate — rotate a feed token (invalidates the old URL). The global feed
// requires manager+ (the LIVE role). Mirrors eit_calendar._h_regenerate.
export async function POST(req: NextRequest) {
  const user = await requireUser();
  const body = await readJson(req);
  const which = String(body.which ?? 'personal').trim().toLowerCase();
  const origin = new URL(req.url).origin;
  const res = await regenerateFeed(user.email, user.role, which, origin);
  if (!res.ok) return jsonErr(res.code, res.error);
  return jsonOk({ which: res.which, url: res.url });
}
