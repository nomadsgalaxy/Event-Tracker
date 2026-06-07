'use server';

import { requireUser } from '@/lib/auth/auth';
import { fetchFlight, type FlightFetchResult } from '@/lib/integrations/flight';

// app/event/flight-actions.ts — the editor's "Look up flight" Server Action. The AeroDataBox call +
// normalization live in lib/integrations/flight (shared with the background auto-refresh); this wrapper
// only adds the sign-in gate so an unauthenticated caller can't burn the shared RapidAPI rate limit.
// The key never reaches the browser (the fetch is server-side).

// Re-exported so the editor keeps importing the leg type from here (back-compat).
export type { FlightLeg } from '@/lib/integrations/flight';

export async function lookupFlightAction(rawNumber: string, rawDate: string): Promise<FlightFetchResult> {
  try {
    await requireUser(); // signed-in only — don't let anon burn the shared rate limit
  } catch {
    return { available: false, error: 'Sign in to look up flights.' };
  }
  return fetchFlight(rawNumber, rawDate);
}
