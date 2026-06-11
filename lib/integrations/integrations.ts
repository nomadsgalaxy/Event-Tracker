import 'server-only';
import { getIntegrationKey } from '@/lib/auth/settings-store';

// lib/integrations/integrations.ts — server-side "is this keyed provider wired?" probes.
//
// Faithful to the Python /eit-status.json model (index.html ~L8746): the server advertises which
// optional, KEYED integrations are configured (Google Places/Maps, the FlightAware flight lookup)
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

/** The FlightAware AeroAPI key — the flight-status source (live delays). Server-side only. */
async function flightAwareKey(): Promise<string> {
  return getIntegrationKey('flightAwareKey');
}

/** The OpenSky Network OAuth2 client credentials — live aircraft positions (flight progress). */
async function openskyCreds(): Promise<{ clientId: string; clientSecret: string }> {
  const [clientId, clientSecret] = await Promise.all([
    getIntegrationKey('openskyClientId'),
    getIntegrationKey('openskyClientSecret'),
  ]);
  return { clientId, clientSecret };
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
  /** Flight lookup is wired (the FlightAware AeroAPI key is configured, used server-side). */
  flightLookupAvailable: boolean;
}

export async function integrationStatus(): Promise<IntegrationStatus> {
  const [g, fa] = await Promise.all([googleApiKey(), flightAwareKey()]);
  return {
    placesAvailable: g.length > 0,
    flightLookupAvailable: fa.length > 0,
  };
}

export { googleApiKey, flightAwareKey, openskyCreds };
