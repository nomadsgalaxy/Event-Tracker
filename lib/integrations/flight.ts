import 'server-only';
import { flightApiKey } from '@/lib/integrations/integrations';

// lib/integrations/flight.ts — the shared, NON-auth AeroDataBox fetch + normalize. Both the editor's
// "Look up flight" Server Action (app/event/flight-actions, which adds requireUser) AND the background
// auto-refresh (lib/integrations/flight-refresh, which runs as the system, no session) call this. The
// RapidAPI key stays server-side. Beyond the original normalize this also: reads the REVISED time +
// status (→ live delay/status), returns the SCHEDULED date + UTC instant (so the refresh can query by
// an immutable date and window offset-clean), and records the live RapidAPI rate-limit headers into a
// shared quota state the refresh's governor reads to self-throttle.
//
// withLocation=true so the times come back as LOCAL airport time (what the datetime-local leg fields
// mean); the delay + the window instant are computed from the UTC fields (offset-clean). A small
// revision is noise, so a leg only reads "delayed" past DELAY_BADGE_MIN minutes.

const AERODATABOX_HOST = (process.env.AERODATABOX_API_HOST || 'aerodatabox.p.rapidapi.com').trim();

/** Minimum revised-past-scheduled minutes before a leg is flagged "delayed" (smaller = noise). */
export const DELAY_BADGE_MIN = 5;

/** The enriched leg shape both callers consume. */
export interface FlightLeg {
  carrier: string;
  number: string;
  confirmation: string;
  departLocation: string;
  departAt: string; // "YYYY-MM-DDTHH:MM" local — the REVISED time when changed, else scheduled
  arriveLocation: string;
  arriveAt: string;
  notes: string;
  status: string; // on_time | delayed | cancelled | departed | arrived | diverted
  delayMin: number; // departure delay in minutes (revised − scheduled), >= 0
  scheduledDate: string; // "YYYY-MM-DD" of the SCHEDULED departure (the AeroDataBox query date)
  departUtc: number | null; // SCHEDULED departure epoch ms (offset-clean window anchor), null if unknown
}

export interface FlightFetchResult {
  available: boolean; // false when no key is configured (caller degrades to manual entry)
  leg?: FlightLeg | null; // null = provider wired but no matching flight for that number + date
  error?: string;
}

// ── Live RapidAPI quota (shared with the refresh governor) ───────────────────────────────────────
export interface QuotaState {
  limit: number; // x-ratelimit-api-units-limit (the binding AeroDataBox unit budget)
  remaining: number; // x-ratelimit-api-units-remaining
  resetAt: number; // ms epoch when the unit budget resets
  unitsPerCall: number; // observed cost of one flights/number call (refined from header deltas)
  updatedAt: number;
}
let _quota: QuotaState | null = null;

/** The last-seen RapidAPI quota for AeroDataBox (null until the first call). Read by the governor. */
export function getFlightQuota(): QuotaState | null {
  return _quota;
}

function intHeader(h: Headers, name: string): number | null {
  const v = h.get(name);
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Record the api-units rate-limit headers after a call. The api-units quota is the binding one for the
// free tier (e.g. 600 units / ~month); each flights/number call costs a few units — we observe the
// actual cost from the remaining-delta so the governor's pacing matches reality.
function recordQuota(h: Headers): void {
  const remaining = intHeader(h, 'x-ratelimit-api-units-remaining');
  if (remaining == null) return; // header absent (e.g. a network error response) — keep prior state
  const limit = intHeader(h, 'x-ratelimit-api-units-limit');
  const resetSec = intHeader(h, 'x-ratelimit-api-units-reset');
  const now = Date.now();
  let unitsPerCall = _quota?.unitsPerCall ?? 4;
  if (_quota && _quota.remaining > remaining) {
    const delta = _quota.remaining - remaining;
    if (delta >= 1 && delta <= 50) unitsPerCall = delta; // refine from the observed cost, clamp outliers
  }
  _quota = {
    limit: limit ?? _quota?.limit ?? 0,
    remaining,
    resetAt: resetSec != null ? now + resetSec * 1000 : (_quota?.resetAt ?? now + 23 * 86_400_000),
    unitsPerCall,
    updatedAt: now,
  };
}

interface AdbTimeObj {
  local?: string;
  utc?: string;
}
interface AdbEndpoint {
  airport?: { iata?: string; name?: string };
  scheduledTime?: string | AdbTimeObj;
  scheduledTimeLocal?: string;
  revisedTime?: string | AdbTimeObj;
}
interface AdbFlight {
  airline?: { name?: string; iata?: string };
  status?: string;
  departure?: AdbEndpoint;
  arrival?: AdbEndpoint;
}

// "YYYY-MM-DD HH:MM±..." / ISO → "YYYY-MM-DDTHH:MM" (the datetime-local shape). Prefers LOCAL.
function localStamp(s: string | AdbTimeObj | undefined): string {
  const str = typeof s === 'object' && s ? s.local || s.utc || '' : (s as string) || '';
  const m = String(str).match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : '';
}

// Parse the UTC field to epoch ms (offset-clean — for the delay calc + the window anchor).
function utcMs(s: string | AdbTimeObj | undefined): number | null {
  const str = typeof s === 'object' && s ? s.utc || s.local || '' : (s as string) || '';
  const ms = Date.parse(String(str).trim().replace(' ', 'T'));
  return Number.isNaN(ms) ? null : ms;
}

// The SCHEDULED local date (YYYY-MM-DD) — the AeroDataBox query date, captured immutably by the leg.
function localDate(s: string | AdbTimeObj | undefined): string {
  const str = typeof s === 'object' && s ? s.local || s.utc || '' : (s as string) || '';
  const m = String(str).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function delayMinutes(scheduled: string | AdbTimeObj | undefined, revised: string | AdbTimeObj | undefined): number {
  const a = utcMs(scheduled);
  const b = utcMs(revised);
  if (a == null || b == null) return 0;
  return Math.max(0, Math.round((b - a) / 60000));
}

function normStatus(raw: string | undefined, delayMin: number): FlightLeg['status'] {
  const s = String(raw || '').toLowerCase();
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('divert')) return 'diverted';
  if (s.includes('arriv') || s.includes('land')) return 'arrived';
  if (s.includes('depart') || s.includes('enroute') || s.includes('en route') || s.includes('approach')) return 'departed';
  return delayMin >= DELAY_BADGE_MIN ? 'delayed' : 'on_time';
}

function normalize(data: unknown, number: string): FlightLeg | null {
  const arr: AdbFlight[] = Array.isArray(data) ? (data as AdbFlight[]) : ((data as { flights?: AdbFlight[] })?.flights ?? []);
  const f = arr[0];
  if (!f) return null;
  const dep = f.departure ?? {};
  const arrEp = f.arrival ?? {};
  const depSched = dep.scheduledTime ?? dep.scheduledTimeLocal ?? '';
  const depRevised = dep.revisedTime ?? '';
  const arrSched = arrEp.scheduledTime ?? '';
  const arrRevised = arrEp.revisedTime ?? '';
  const delayMin = delayMinutes(depSched, depRevised || depSched);
  return {
    carrier: (f.airline && (f.airline.name || f.airline.iata)) || '',
    number,
    confirmation: '',
    departLocation: (dep.airport && (dep.airport.iata || dep.airport.name)) || '',
    departAt: localStamp(depRevised || depSched),
    arriveLocation: (arrEp.airport && (arrEp.airport.iata || arrEp.airport.name)) || '',
    arriveAt: localStamp(arrRevised || arrSched),
    notes: '',
    status: normStatus(f.status, delayMin),
    delayMin,
    scheduledDate: localDate(depSched),
    departUtc: utcMs(depSched),
  };
}

/**
 * Look up a flight by number + date — the single accessor the sweep + manual lookup call. PROVIDER
 * ORDER: FlightAware AeroAPI first (it carries the live estimated/actual times, so it catches real
 * delays the AeroDataBox free tier returns as "Basic"/on-time). When FlightAware is CONFIGURED it is
 * authoritative — AeroDataBox is not consulted at all (it's a pure no-key fallback now). NEVER throws.
 */
export async function fetchFlight(rawNumber: string, rawDate: string): Promise<FlightFetchResult> {
  const { fetchFlightAware } = await import('@/lib/integrations/flightaware');
  const fa = await fetchFlightAware(rawNumber, rawDate);
  if (fa.available) return fa; // FlightAware keyed → authoritative (incl. leg:null = it looked, no match)
  return fetchFlightAeroDataBox(rawNumber, rawDate);
}

/**
 * AeroDataBox lookup (the legacy/free fallback — schedule-only on the free tier, so it misses delays).
 * Only reached when FlightAware has no key. Records the RapidAPI quota headers for the sweep's governor.
 */
export async function fetchFlightAeroDataBox(rawNumber: string, rawDate: string): Promise<FlightFetchResult> {
  const key = await flightApiKey();
  if (!key) return { available: false };

  const number = String(rawNumber || '').trim().toUpperCase().replace(/\s+/g, '');
  const date = String(rawDate || '').trim().slice(0, 10);
  if (!number || !date) return { available: true, leg: null, error: 'Need a flight number and a date.' };

  const url =
    `https://${AERODATABOX_HOST}/flights/number/${encodeURIComponent(number)}/${encodeURIComponent(date)}` +
    `?withAircraftImage=false&withLocation=true`;

  try {
    const r = await fetch(url, {
      headers: { 'x-rapidapi-host': AERODATABOX_HOST, 'x-rapidapi-key': key, 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    recordQuota(r.headers);
    if (r.status === 404) return { available: true, leg: null };
    if (!r.ok) return { available: true, leg: null, error: `Flight lookup failed (${r.status}).` };
    const data = await r.json();
    return { available: true, leg: normalize(data, number) };
  } catch (e) {
    return { available: true, leg: null, error: e instanceof Error ? e.message : 'Flight lookup failed.' };
  }
}
