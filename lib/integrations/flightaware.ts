import 'server-only';
import { getIntegrationKey } from '@/lib/auth/settings-store';
import type { FlightLeg, FlightFetchResult } from '@/lib/integrations/flight';

// Matches flight.ts DELAY_BADGE_MIN (inlined to keep this a TYPE-only dep on flight.ts — flight.ts
// imports fetchFlightAware from here, so a runtime value import would form a cycle).
const DELAY_BADGE_MIN = 5;

// lib/integrations/flightaware.ts — FlightAware AeroAPI flight-status adapter.
//
// AeroDataBox's free tier returns schedule-only ("Basic") data, so it misses real airline delays.
// FlightAware AeroAPI carries the live estimated/actual times — a 37-min delay on AA1691 shows as
// estimated_out 37 min past scheduled_out. This adapter fetches by ident, picks the instance matching
// the requested LOCAL date, and normalizes to the SAME FlightLeg shape the AeroDataBox path returns,
// so the rest of the app (the auto-refresh sweep, the manual lookup) is provider-agnostic.
//
// AeroAPI accepts the IATA ident directly (AA1691 resolves to AAL1691) and returns the origin/dest
// IANA timezones, which we use to render the stored datetime-local wall-clock + match the date.

const FA_HOST = (process.env.FLIGHTAWARE_API_HOST || 'aeroapi.flightaware.com').trim();

interface FaTime {
  scheduled?: string;
  estimated?: string;
  actual?: string;
}
interface FaAirport {
  code_iata?: string;
  code_icao?: string;
  code?: string;
  timezone?: string;
}
interface FaFlight {
  ident?: string;
  ident_iata?: string;
  operator_iata?: string;
  operator?: string;
  scheduled_out?: string;
  estimated_out?: string;
  actual_out?: string;
  scheduled_in?: string;
  estimated_in?: string;
  actual_in?: string;
  cancelled?: boolean;
  diverted?: boolean;
  origin?: FaAirport;
  destination?: FaAirport;
}

/** Format a UTC ISO instant as 'YYYY-MM-DDTHH:MM' wall-clock in an IANA timezone (falls back to the
 *  raw UTC slice when the tz is missing/invalid). */
function localStamp(utcIso: string | undefined, tz: string | undefined): string {
  const s = String(utcIso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  if (!tz) return s.replace(' ', 'T').slice(0, 16);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    const hh = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')}T${hh}:${get('minute')}`;
  } catch {
    return s.replace(' ', 'T').slice(0, 16);
  }
}

function diffMin(fromIso: string | undefined, toIso: string | undefined): number {
  const a = Date.parse(String(fromIso ?? ''));
  const b = Date.parse(String(toIso ?? ''));
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 60000);
}

function normalize(f: FaFlight, number: string): FlightLeg {
  const originTz = f.origin?.timezone;
  const destTz = f.destination?.timezone;
  // Departure delay: estimated (or actual) out vs scheduled out. Clamp negatives (early) to 0.
  const bestOut = f.actual_out || f.estimated_out || f.scheduled_out;
  const delayMin = Math.max(0, diffMin(f.scheduled_out, bestOut));
  const bestIn = f.actual_in || f.estimated_in || f.scheduled_in;

  let status: FlightLeg['status'];
  if (f.cancelled) status = 'cancelled';
  else if (f.diverted) status = 'diverted';
  else if (f.actual_in) status = 'arrived';
  else if (f.actual_out) status = 'departed';
  else status = delayMin >= DELAY_BADGE_MIN ? 'delayed' : 'on_time';

  return {
    carrier: f.operator_iata || f.operator || '',
    number,
    confirmation: '',
    departLocation: f.origin?.code_iata || f.origin?.code || f.origin?.code_icao || '',
    departAt: localStamp(bestOut, originTz),
    arriveLocation: f.destination?.code_iata || f.destination?.code || f.destination?.code_icao || '',
    arriveAt: localStamp(bestIn, destTz),
    notes: '',
    status,
    delayMin,
    scheduledDate: localStamp(f.scheduled_out, originTz).slice(0, 10),
    departUtc: Number.isNaN(Date.parse(String(f.scheduled_out ?? ''))) ? null : Date.parse(String(f.scheduled_out)),
  };
}

/**
 * Look up a flight by number + date through FlightAware AeroAPI. Returns { available:false } when no
 * key is configured (so the caller falls back to AeroDataBox); { available:true, leg } on a date match;
 * { available:true, leg:null } when the provider is wired but no instance matched the date. Never throws.
 */
export async function fetchFlightAware(rawNumber: string, rawDate: string): Promise<FlightFetchResult> {
  const key = (await getIntegrationKey('flightAwareKey')).trim();
  if (!key) return { available: false };

  const number = String(rawNumber || '').trim().toUpperCase().replace(/\s+/g, '');
  const date = String(rawDate || '').trim().slice(0, 10);
  if (!number || !date) return { available: true, leg: null, error: 'Need a flight number and a date.' };

  const url = `https://${FA_HOST}/aeroapi/flights/${encodeURIComponent(number)}`;
  try {
    const r = await fetch(url, { headers: { 'x-apikey': key, Accept: 'application/json' }, cache: 'no-store' });
    if (r.status === 401 || r.status === 403) return { available: true, leg: null, error: 'FlightAware key rejected.' };
    if (!r.ok) return { available: true, leg: null, error: `FlightAware lookup failed (${r.status}).` };
    const data = (await r.json()) as { flights?: FaFlight[] };
    const flights = Array.isArray(data.flights) ? data.flights : [];
    // Pick the instance whose scheduled-out LOCAL date matches the requested date (the leg's flightDate).
    const match =
      flights.find((f) => localStamp(f.scheduled_out, f.origin?.timezone).slice(0, 10) === date) ?? null;
    if (!match) return { available: true, leg: null };
    return { available: true, leg: normalize(match, number) };
  } catch (e) {
    return { available: true, leg: null, error: e instanceof Error ? e.message : 'FlightAware lookup failed.' };
  }
}

/** Is FlightAware configured? (the orchestrator + status probe). */
export async function flightAwareConfigured(): Promise<boolean> {
  return (await getIntegrationKey('flightAwareKey')).trim().length > 0;
}
