import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { googleApiKey } from '@/lib/integrations';

// GET /api/maps-key — hand the Google Maps/Places BROWSER key to a signed-in client.
//
// Places autocomplete runs in the browser and needs the Maps JS key there. Our key lives in the
// server-side encrypted settings store (set via Config -> Databases & API) and getIntegrationKey is
// server-only, so the client could never see it — leaving address autofill dead even after a key was
// saved. This mirrors the Python app serving the key to the browser via /eit-google-config.json: a
// Maps browser key is meant to be public (you restrict it by HTTP referrer in the GCP console), so
// returning it to an authenticated session is the intended exposure. Gated to a full session; returns
// an empty key (not 404) when none is configured so the field cleanly falls back to a plain input.
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'sign in required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const key = await googleApiKey();
  return NextResponse.json({ key }, { headers: { 'Cache-Control': 'private, max-age=300' } });
}
