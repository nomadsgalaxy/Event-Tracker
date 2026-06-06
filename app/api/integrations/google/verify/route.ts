import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { resolveLiveRole } from '@/lib/auth';
import { rankOf } from '@/lib/rbac';
import { getIntegrationKey } from '@/lib/settings-store';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/integrations/google/verify — probe a Google API key to learn WHICH Google APIs it can
// reach, so the Config card can show the owner exactly what's live (and why weather/autofill may be
// dead — e.g. the key is valid for Maps but the Weather API isn't enabled on the GCP project). Tests
// the ENTERED draft key when one is supplied, else the stored/env key. Admin only; read-only (no
// step-up — it writes nothing, just makes three tiny test calls server-side).
//
// One Google key powers all three (the UI now exposes a single field): Geocoding + Places (venue
// autocomplete) + the Google Weather API (forecast chips). Each must be enabled on the GCP project.

interface ProbeResult {
  ok: boolean;
  message: string;
}

async function probe(url: string, kind: 'maps' | 'weather', init?: RequestInit): Promise<ProbeResult> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    const data = (await r.json().catch(() => ({}))) as {
      status?: string;
      error_message?: string;
      error?: { message?: string };
    };
    if (kind === 'maps') {
      // The Maps web services return HTTP 200 even on denial — the verdict is in `status`.
      const status = String(data.status || '');
      if (status === 'OK' || status === 'ZERO_RESULTS') return { ok: true, message: 'OK' };
      return { ok: false, message: data.error_message || status || `HTTP ${r.status}` };
    }
    // The Weather API returns a non-2xx + an { error: { message } } envelope on denial.
    if (r.ok) return { ok: true, message: 'OK' };
    return { ok: false, message: data.error?.message || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error && e.name === 'AbortError' ? 'timed out' : 'network error' };
  }
}

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  const liveRole = await resolveLiveRole(sess.sub);
  if (rankOf(liveRole) < rankOf('admin')) return jsonErr(403, 'admin session required');

  const body = (await readJson(req)) as { key?: string };
  const draft = String(body.key ?? '').trim();
  const key = draft || (await getIntegrationKey('googleApiKey'));
  if (!key) return jsonErr(400, 'No Google API key to verify — enter one above (or save it) first.');

  const k = encodeURIComponent(key);
  const [geocoding, places, weather] = await Promise.all([
    probe(`https://maps.googleapis.com/maps/api/geocode/json?address=Googleplex&key=${k}`, 'maps'),
    probe(`https://maps.googleapis.com/maps/api/place/autocomplete/json?input=coffee&key=${k}`, 'maps'),
    probe(
      `https://weather.googleapis.com/v1/forecast/days:lookup?key=${k}&location.latitude=37.42&location.longitude=-122.08&pageSize=1`,
      'weather',
    ),
  ]);

  return jsonOk({ source: draft ? 'entered' : 'stored', results: { places, weather, geocoding } });
}
