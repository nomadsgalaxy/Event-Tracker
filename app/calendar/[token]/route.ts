import { type NextRequest } from 'next/server';
import { resolveFeedToken } from '@/lib/calendar-feed';
import { generateIcs } from '@/lib/ical';

export const dynamic = 'force-dynamic';

// GET /calendar/<token>.ics — the PUBLIC, token-authenticated iCalendar feed (calendar apps poll it;
// they can't do SSO, so the unguessable token IS the credential). This route is exempted from the
// middleware session gate (see middleware.ts PUBLIC_PATHS). A bad token is a flat 404 (no oracle); a
// demoted owner's GLOBAL token is 403 — the role is re-checked here on EVERY fetch. Mirrors
// eit_calendar.serve_feed + serve.py's /calendar/* handler.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let resolved;
  try {
    resolved = await resolveFeedToken(token);
  } catch {
    return new Response('temporarily unavailable', { status: 503 });
  }
  if (!resolved) return new Response('not found', { status: 404 });
  if ('forbidden' in resolved) return new Response('forbidden', { status: 403 });

  let ics: string;
  try {
    ics = await generateIcs(resolved.email, resolved.scope);
  } catch {
    return new Response('feed error', { status: 500 });
  }
  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="event-tracker.ics"',
      'Cache-Control': 'no-store',
    },
  });
}
