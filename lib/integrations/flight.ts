import 'server-only';
import { fetchFlightAware } from '@/lib/integrations/flightaware';

// lib/integrations/flight.ts — the shared, NON-auth flight lookup both callers consume: the editor's
// "Look up flight" Server Action (app/event/flight-actions, which adds requireUser) AND the background
// auto-refresh (lib/integrations/flight-refresh, which runs as the system, no session). The provider
// is FlightAware AeroAPI (lib/integrations/flightaware) — it carries live estimated/actual times, so
// real delays and cancellations are detected. The key stays server-side.
//
// (AeroDataBox was removed: its free tier returned schedule-only "Basic" data that missed real
// delays — see the AA1691 incident — making it redundant once FlightAware landed.)

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
  scheduledDate: string; // "YYYY-MM-DD" of the SCHEDULED departure (the provider query date)
  departUtc: number | null; // SCHEDULED departure epoch ms (offset-clean window anchor), null if unknown
  // Live-progress anchors (FlightAware): the ATC/ICAO ident (e.g. AAL1691 — the OpenSky callsign),
  // the best-known actual/estimated departure + arrival instants. Optional — older stored legs and
  // pre-refresh manual entries won't have them.
  identIcao?: string;
  departActualUtc?: number | null; // actual_out || estimated_out (epoch ms)
  arriveEstUtc?: number | null; // actual_in || estimated_in || scheduled_in (epoch ms)
}

export interface FlightFetchResult {
  available: boolean; // false when no key is configured (caller degrades to manual entry)
  leg?: FlightLeg | null; // null = provider wired but no matching flight for that number + date
  error?: string;
}

/**
 * Look up a flight by number + date. Returns { available:false } when no FlightAware key is
 * configured (the caller degrades to manual entry); { available:true, leg } on a date match;
 * { available:true, leg:null } when the provider is wired but no instance matched. NEVER throws.
 */
export async function fetchFlight(rawNumber: string, rawDate: string): Promise<FlightFetchResult> {
  return fetchFlightAware(rawNumber, rawDate);
}
