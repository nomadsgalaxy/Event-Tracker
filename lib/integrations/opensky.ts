import 'server-only';
import { openskyCreds } from '@/lib/integrations/integrations';

// lib/integrations/opensky.ts — OpenSky Network live aircraft state (the flight-progress feature).
//
// OpenSky is community ADS-B: it knows an aircraft only while it's physically transmitting (taxi /
// airborne), so it can't predict delays — that's FlightAware's job. What it IS good for: once a leg
// has departed, the live position / altitude / speed of the plane, looked up by its ATC callsign
// (the FlightAware `ident`, e.g. AAL1691, stamped on the leg as identIcao by the refresh sweep).
//
// AUTH: OAuth2 client-credentials (the user's API client) → a short-lived bearer (~30 min), cached
// module-level and refreshed ~60s early. Authenticated accounts get 4000 req-credits/day; a full
// /states/all pull costs 4 — at the progress widget's on-demand + slow-poll cadence that's nowhere
// near the cap. /states/all has no callsign filter, so we pull and match (callsigns are 8-char
// padded). The response is large (~2 MB) — acceptable at this frequency, server-side only.

const OSK_AUTH_URL =
  process.env.OPENSKY_AUTH_URL ||
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OSK_API = (process.env.OPENSKY_API_HOST || 'https://opensky-network.org/api').replace(/\/$/, '');

let _token: { value: string; expAt: number } | null = null;

// Spend control: /states/all costs 4 req-credits (free tier = 4000/day ≈ 1000 pulls). The widget's
// 2-min poll is client-side only, so the server enforces its own bounds: a short per-callsign result
// cache (many viewers of one flight — or a spammed action — share a single pull) + a daily pull cap.
const RESULT_TTL_MS = 60_000;
const DAILY_PULL_CAP = 600;
const _resultCache = new Map<string, { at: number; state: AircraftState | null }>();
let _pullDayKey = '';
let _pullsToday = 0;
function spendDailyPull(now: number): boolean {
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== _pullDayKey) {
    _pullDayKey = day;
    _pullsToday = 0;
  }
  if (_pullsToday >= DAILY_PULL_CAP) return false;
  _pullsToday++;
  return true;
}

async function bearerToken(): Promise<string | null> {
  const { clientId, clientSecret } = await openskyCreds();
  if (!clientId || !clientSecret) return null;
  const now = Date.now();
  if (_token && _token.expAt - 60_000 > now) return _token.value;
  try {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    const r = await fetch(OSK_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    _token = { value: j.access_token, expAt: now + Math.max(60, Number(j.expires_in ?? 1800)) * 1000 };
    return _token.value;
  } catch {
    return null;
  }
}

/** A live aircraft state, decoded from the OpenSky state vector. */
export interface AircraftState {
  callsign: string;
  lat: number | null;
  lng: number | null;
  /** Barometric altitude in meters (null on the ground / unknown). */
  altitudeM: number | null;
  /** Ground speed in m/s (null unknown). */
  velocityMs: number | null;
  onGround: boolean;
  /** Seconds since OpenSky last heard this aircraft. */
  lastContactAgeS: number;
}

export async function openskyConfigured(): Promise<boolean> {
  const { clientId, clientSecret } = await openskyCreds();
  return clientId.length > 0 && clientSecret.length > 0;
}

/**
 * Find the live state of an aircraft by ATC callsign (e.g. "AAL1691"). Returns null when OpenSky
 * isn't configured, the token fails, or no transmitting aircraft matches (not flying / out of
 * coverage). Never throws.
 */
export async function fetchAircraftState(rawCallsign: string): Promise<AircraftState | null> {
  const callsign = String(rawCallsign ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!callsign) return null;

  // Debounce: a fresh result for this callsign is reused (bounds spam + dedupes concurrent viewers).
  const now = Date.now();
  const cached = _resultCache.get(callsign);
  if (cached && now - cached.at < RESULT_TTL_MS) return cached.state;
  if (!spendDailyPull(now)) return cached?.state ?? null; // cap reached — serve stale or nothing

  const token = await bearerToken();
  if (!token) return null;

  const remember = (state: AircraftState | null): AircraftState | null => {
    _resultCache.set(callsign, { at: now, state });
    // Bound the cache (a sweep of distinct callsigns can't grow it unbounded).
    if (_resultCache.size > 200) {
      const oldest = [..._resultCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) _resultCache.delete(oldest[0]);
    }
    return state;
  };

  try {
    const r = await fetch(`${OSK_API}/states/all`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!r.ok) return remember(null);
    const j = (await r.json()) as { time?: number; states?: unknown[][] };
    const states = Array.isArray(j.states) ? j.states : [];
    // State vector: [0]=icao24 [1]=callsign(8-char padded) [3]=time_position [4]=last_contact
    // [5]=lon [6]=lat [7]=baro_alt_m [8]=on_ground [9]=velocity_m/s
    const hit = states.find((s) => String(s?.[1] ?? '').trim().toUpperCase() === callsign);
    if (!hit) return remember(null);
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const lastContact = num(hit[4]);
    return remember({
      callsign,
      lat: num(hit[6]),
      lng: num(hit[5]),
      altitudeM: num(hit[7]),
      velocityMs: num(hit[9]),
      onGround: hit[8] === true,
      lastContactAgeS: lastContact != null ? Math.max(0, Math.round((j.time ?? Date.now() / 1000) - lastContact)) : 0,
    });
  } catch {
    return remember(null);
  }
}
