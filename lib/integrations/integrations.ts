import 'server-only';
import { getIntegrationKey } from '@/lib/auth/settings-store';

// lib/integrations/integrations.ts — server-side "is this keyed provider wired?" probes.
//
// Faithful to the Python /eit-status.json model (index.html ~L8746): the server advertises which
// optional, KEYED integrations are configured (Google Places/Maps, the AeroDataBox flight lookup)
// WITHOUT ever shipping the key to the browser. The Next.js port mirrors that: the editor page is a
// Server Component, so it reads these booleans server-side and threads them to the client island,
// which only ever learns "available: true/false" — never the secret.
//
// KEY RESOLUTION: `process.env || the encrypted settings store` (getIntegrationKey). A key set in
// Config > Databases & API lights up Places/flight WITHOUT a redeploy; an env var still wins. Each
// probe is false until a key is resolvable, so every dependent control degrades to the plain-input +
// FLAG-the-key fallback exactly like the Python app does when the key is absent.

/** The shared Google API key (Maps/Places/Geocoding all use one key in the Python app). env || store. */
async function googleApiKey(): Promise<string> {
  return getIntegrationKey('googleApiKey');
}

/** The AeroDataBox / RapidAPI flight-lookup key (server-side proxy; never sent to the browser). */
async function flightApiKey(): Promise<string> {
  return getIntegrationKey('flightKey');
}

/** The FlightAware AeroAPI key — the PRIMARY flight-status source (live delays). */
async function flightAwareKey(): Promise<string> {
  return getIntegrationKey('flightAwareKey');
}

/**
 * The optional-integration availability flags the editor (a Server Component → client island) needs.
 * Mirrors the `auth.flightLookup` / Maps-key advertisement in /eit-status.json: the client learns
 * ONLY whether each provider is wired, so it can show the live control (Places autocomplete / flight
 * Look-up button) vs. the FLAGGED plain-input fallback — without the key ever crossing the wire.
 */
export interface IntegrationStatus {
  /** Google Places autocomplete is wired (a Google API key is configured). */
  placesAvailable: boolean;
  /** Flight lookup is wired (the AeroDataBox/RapidAPI key is configured, used server-side). */
  flightLookupAvailable: boolean;
}

export async function integrationStatus(): Promise<IntegrationStatus> {
  const [g, f, fa] = await Promise.all([googleApiKey(), flightApiKey(), flightAwareKey()]);
  return {
    placesAvailable: g.length > 0,
    // Flight lookup is wired when EITHER provider has a key (FlightAware is preferred; AeroDataBox is
    // the free fallback). The auto-refresh sweep also no-ops only when BOTH are unconfigured.
    flightLookupAvailable: f.length > 0 || fa.length > 0,
  };
}

export { googleApiKey, flightApiKey, flightAwareKey };
