'use server';

import { requireUser } from '@/lib/auth';
import { flightApiKey } from '@/lib/integrations';

// app/event/flight-actions.ts — the server-side flight-lookup proxy (a faithful port of the Python
// POST /auth/flight-lookup, index.html ~L2392). The AeroDataBox / RapidAPI key NEVER reaches the
// browser: the editor's "Look up flight" button calls this Server Action with { number, date }, the
// server (which holds the key) calls AeroDataBox, and we hand back ONLY the normalized leg shape.
//
// STUB / KEY FLAG: until AERODATABOX_API_KEY (or FLIGHT_API_KEY / RAPIDAPI_KEY) is set in the Next.js
// server env, this returns { available:false } so the editor falls back to manual entry + flags the
// key needed (exactly like the Python hides the button when no key is advertised). Sign-in is
// required (requireUser) so an unauthenticated caller can't burn the shared rate limit.

const AERODATABOX_HOST = (process.env.AERODATABOX_API_HOST || 'aerodatabox.p.rapidapi.com').trim();

/** The normalized leg shape the editor consumes (matches index.html eitNormalizeFlight's output). */
export interface FlightLeg {
  carrier: string;
  number: string;
  confirmation: string;
  departLocation: string;
  departAt: string; // "YYYY-MM-DDTHH:MM"
  arriveLocation: string;
  arriveAt: string;
  notes: string;
}

export interface FlightLookupResult {
  /** False when the provider isn't wired (no key) — the editor flags the key needed. */
  available: boolean;
  /** The resolved leg, or null when no matching flight was found (provider wired but no hit). */
  leg?: FlightLeg | null;
  error?: string;
}

// Minimal structural types for the AeroDataBox response (only the fields eitNormalizeFlight reads).
interface AdbAirport {
  iata?: string;
  name?: string;
}
interface AdbTimeObj {
  local?: string;
  utc?: string;
}
interface AdbEndpoint {
  airport?: AdbAirport;
  scheduledTime?: string | AdbTimeObj;
  scheduledTimeLocal?: string;
}
interface AdbFlight {
  airline?: { name?: string; iata?: string };
  departure?: AdbEndpoint;
  arrival?: AdbEndpoint;
}

/** Reduce an AeroDataBox response to the editor's leg shape. Verbatim logic from the Python
 *  window.eitNormalizeFlight (index.html ~L2359) so the fill is byte-identical once the key lands. */
function normalizeFlight(data: unknown, number: string): FlightLeg | null {
  const arr: AdbFlight[] = Array.isArray(data)
    ? (data as AdbFlight[])
    : ((data as { flights?: AdbFlight[] })?.flights ?? []);
  const f = arr[0];
  if (!f) return null;
  const depAirport = (f.departure?.airport && (f.departure.airport.iata || f.departure.airport.name)) || '';
  const arrAirport = (f.arrival?.airport && (f.arrival.airport.iata || f.arrival.airport.name)) || '';
  const depTime = f.departure?.scheduledTime || f.departure?.scheduledTimeLocal || '';
  const arrTime = f.arrival?.scheduledTime || f.arrival?.scheduledTimeLocal || '';
  const toLocal = (s: string | AdbTimeObj): string => {
    let str: string = typeof s === 'object' && s ? s.local || s.utc || '' : (s as string) || '';
    const m = String(str).match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    return m ? `${m[1]}T${m[2]}` : '';
  };
  return {
    carrier: (f.airline && (f.airline.name || f.airline.iata)) || '',
    number,
    confirmation: '',
    departLocation: depAirport,
    departAt: toLocal(depTime),
    arriveLocation: arrAirport,
    arriveAt: toLocal(arrTime),
    notes: '',
  };
}

/**
 * Look up a flight by number + date through the server-side AeroDataBox proxy. The key stays on the
 * server (never crosses the wire). Returns { available:false } when no key is configured (the editor
 * then flags the key needed); { available:true, leg } on a hit; { available:true, leg:null } when the
 * provider is wired but no flight matched.
 */
export async function lookupFlightAction(rawNumber: string, rawDate: string): Promise<FlightLookupResult> {
  try {
    await requireUser(); // signed-in only (don't let anon burn the shared rate limit)
  } catch {
    return { available: false, error: 'Sign in to look up flights.' };
  }

  const key = await flightApiKey();
  if (!key) {
    // STUB: provider not wired — the editor degrades to manual entry + flags the key needed.
    return { available: false };
  }

  const number = String(rawNumber || '').trim().toUpperCase().replace(/\s+/g, '');
  const date = String(rawDate || '').trim().slice(0, 10);
  if (!number || !date) return { available: true, leg: null, error: 'Need a flight number and a date.' };

  const url =
    `https://${AERODATABOX_HOST}/flights/number/${encodeURIComponent(number)}/${encodeURIComponent(date)}` +
    `?withAircraftImage=false&withLocation=false`;

  try {
    const r = await fetch(url, {
      headers: {
        'x-rapidapi-host': AERODATABOX_HOST,
        'x-rapidapi-key': key,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });
    if (r.status === 404) return { available: true, leg: null }; // no flight found
    if (!r.ok) return { available: true, leg: null, error: `Flight lookup failed (${r.status}).` };
    const data = await r.json();
    return { available: true, leg: normalizeFlight(data, number) };
  } catch (e) {
    return { available: true, leg: null, error: e instanceof Error ? e.message : 'Flight lookup failed.' };
  }
}
