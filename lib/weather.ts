import 'server-only';
import type { WeatherForecastDay, EventForecastRow } from './types-dashboard';
import { getIntegrationKey } from './settings-store';
export type { EventForecastRow } from './types-dashboard';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Per-venue weather forecast — a faithful port of the existing app's Google Weather API helper
// (index.html eitWeatherForecast / eitParseForecastResponse / eitWeatherEmoji ~L1955-2180).
//
// ⚠️ PROVIDER & KEY (TELL-THE-OWNER): the existing app fetches the forecast from the GOOGLE
//    WEATHER API — `https://weather.googleapis.com/v1/forecast/days:lookup` — authenticated with
//    the SAME shared Google API key the app already uses for Maps/Places (the Weather API + the
//    Geocoding API must both be enabled on that GCP project). This is a KEYED provider, NOT a
//    keyless one (Open-Meteo is NOT what the Python uses), so per the task this fetch is left a
//    CLEARLY-FLAGGED STUB and surfaces no live data until a key is provided.
//
//    TO ACTIVATE: set `GOOGLE_WEATHER_API_KEY` (or reuse the existing Google key) in the Next.js
//    server env, then flip the guard in `fetchVenueForecast` below. The parse + emoji mapping are
//    already ported 1:1, so once the key lands the <WeatherChip> renders identically to the Python
//    app. Forecasts are capped at 10 days by the API, so only events ≤10 days out get a chip.
//
//    No key is read here yet — `fetchVenueForecast` returns null so the Dashboard renders exactly
//    as today (no chips) without throwing, and the data SHAPE (WeatherForecastDay) + the shared
//    <WeatherChip> are in place for the later wire-up.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const GOOGLE_WEATHER_ENDPOINT = 'https://weather.googleapis.com/v1/forecast/days:lookup';

// Map Google's many weatherCondition.type strings to a small emoji family (substring match, so a
// new/unfamiliar type still gets a sensible glyph). Ported verbatim from index.html
// window.eitWeatherEmoji (~L1976).
export function weatherEmoji(type: string | undefined | null): string {
  const t = String(type || '').toUpperCase();
  if (!t || t === 'TYPE_UNSPECIFIED') return '';
  if (t.includes('THUNDER')) return '⛈️';
  if (t.includes('SNOW') || t.includes('HAIL') || t.includes('SLEET')) return '❄️';
  if (t.includes('RAIN') || t.includes('SHOWER') || t.includes('DRIZZLE')) return '🌧️';
  if (t.includes('FOG') || t.includes('HAZE') || t.includes('MIST') || t.includes('SMOKE')) return '🌫️';
  if (t.includes('WIND')) return '💨';
  if (t.includes('PARTLY_CLOUDY')) return '⛅';
  if (t.includes('MOSTLY_CLOUDY') || t === 'CLOUDY') return '☁️';
  if (t.includes('MOSTLY_CLEAR')) return '🌤️';
  if (t === 'CLEAR') return '☀️';
  return '';
}

// Minimal structural types for the Google Weather API response (only the fields we read).
interface GoogleTemp {
  degrees?: number;
  unit?: string;
}
interface GoogleForecastDay {
  displayDate?: { year?: number; month?: number; day?: number };
  daytimeForecast?: {
    weatherCondition?: { type?: string; description?: { text?: string } };
    feelsLikeTemperature?: GoogleTemp;
    temperature?: GoogleTemp;
  };
  feelsLikeMaxTemperature?: GoogleTemp;
  maxTemperature?: GoogleTemp;
}

/**
 * Parse a Google Weather API `forecast/days:lookup` response into a { 'YYYY-MM-DD' → forecast }
 * map. Ported verbatim from index.html eitParseForecastResponse (~L1991): the feels-like / max temp
 * lives at the FORECAST-DAY level (not inside daytimeForecast); we normalize to BOTH °F and °C
 * regardless of the API's response unit so the chip can honor the user's pref.
 */
export function parseGoogleForecast(data: unknown): Record<string, WeatherForecastDay> {
  const out: Record<string, WeatherForecastDay> = {};
  const days = (data as { forecastDays?: GoogleForecastDay[] })?.forecastDays ?? [];
  for (const d of days) {
    const date = d.displayDate;
    if (!date || !date.year) continue;
    const ymd = `${date.year}-${String(date.month ?? 1).padStart(2, '0')}-${String(date.day ?? 1).padStart(2, '0')}`;
    const day = d.daytimeForecast ?? {};
    const cond = day.weatherCondition ?? {};
    const type = String(cond.type || '').toUpperCase();
    // Prefer feels-like-max (daytime); fall back to actual max, then the day-forecast temps.
    const fl: GoogleTemp =
      d.feelsLikeMaxTemperature ||
      d.maxTemperature ||
      day.feelsLikeTemperature ||
      day.temperature ||
      {};
    const isFahrenheit = String(fl.unit || '').toUpperCase() === 'FAHRENHEIT';
    const raw = typeof fl.degrees === 'number' ? fl.degrees : null;
    let cTemp: number | null = null;
    let fTemp: number | null = null;
    if (raw != null) {
      if (isFahrenheit) {
        fTemp = Math.round(raw);
        cTemp = Math.round(((raw - 32) * 5) / 9);
      } else {
        cTemp = Math.round(raw);
        fTemp = Math.round((raw * 9) / 5 + 32);
      }
    }
    out[ymd] = {
      emoji: weatherEmoji(type),
      label: cond.description?.text || type.replace(/_/g, ' ').toLowerCase(),
      feelsLikeF: fTemp,
      feelsLikeC: cTemp,
    };
  }
  return out;
}

/** The configured Weather API key. The Python app uses ONE shared Google key for Maps/Places AND the
 *  Weather API, so an explicit `weatherKey` is optional — fall back to the shared `googleApiKey` the
 *  user set in Config (env || encrypted settings store for either name). Without this fallback, setting
 *  only the Google key left weather dead because the store lookup is exact-name. */
async function googleWeatherKey(): Promise<string> {
  return (await getIntegrationKey('weatherKey')) || (await getIntegrationKey('googleApiKey'));
}

/** True when the weather provider is wired (a key is resolvable). The Dashboard shows chips only then. */
export async function weatherEnabled(): Promise<boolean> {
  return (await googleWeatherKey()).length > 0;
}

// In-process forecast cache, keyed by rounded coord pair (~1km), 6h TTL — mirrors the existing
// app's localStorage cache (EIT_WEATHER_TTL_MS). Per server process (fine for the live-DB model;
// the Python cached per browser). Capacity-bounded so a long-lived process can't grow unbounded.
const FORECAST_TTL_MS = 6 * 60 * 60 * 1000;
const FORECAST_CACHE = new Map<string, { at: number; forecast: Record<string, WeatherForecastDay> }>();
const FORECAST_CACHE_MAX = 500;

/**
 * Fetch the 10-day forecast for a venue (by lat/lng) → { 'YYYY-MM-DD' → forecast }. Returns null when
 * the provider is not wired (no Google key — the current default) or on any error, so the caller
 * just renders no chip. Once `GOOGLE_WEATHER_API_KEY` is set, the parse path is already 1:1 with the
 * Python app.
 *
 * The owner only needs the START-day forecast per event, but the API returns the whole 10-day window
 * in one call, so we cache the window and the caller indexes by the event's start date.
 */
export async function fetchVenueForecast(
  lat: number,
  lng: number
): Promise<Record<string, WeatherForecastDay> | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const key = await googleWeatherKey();
  if (!key) {
    // STUB: provider not wired. See the file header — set GOOGLE_WEATHER_API_KEY to activate.
    return null;
  }

  const k = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const now = Date.now();
  const hit = FORECAST_CACHE.get(k);
  if (hit && now - hit.at < FORECAST_TTL_MS) return hit.forecast;

  // pageSize (max 10), NOT days — Google's default is 5 and `days=10` silently falls back to 5.
  const url =
    `${GOOGLE_WEATHER_ENDPOINT}?key=${encodeURIComponent(key)}` +
    `&location.latitude=${encodeURIComponent(lat)}` +
    `&location.longitude=${encodeURIComponent(lng)}` +
    `&pageSize=10`;

  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    const data = await r.json();
    const forecast = parseGoogleForecast(data);
    if (FORECAST_CACHE.size >= FORECAST_CACHE_MAX) {
      // Evict the oldest entry (insertion order) to keep the cache bounded.
      const oldest = FORECAST_CACHE.keys().next().value;
      if (oldest !== undefined) FORECAST_CACHE.delete(oldest);
    }
    FORECAST_CACHE.set(k, { at: now, forecast });
    return forecast;
  } catch {
    return null;
  }
}

/**
 * The per-event START-day forecast (or null). Reads the event's venue lat/lng, fetches the window,
 * and indexes by the event's start date. Returns null when the provider isn't wired, the venue has
 * no coords, or the start day is outside the 10-day forecast horizon — exactly the cases the Python
 * app shows no chip for.
 */
export async function startDayForecast(
  startDate: string,
  lat: unknown,
  lng: unknown
): Promise<WeatherForecastDay | null> {
  if (!startDate) return null;
  const la = typeof lat === 'number' ? lat : NaN;
  const ln = typeof lng === 'number' ? lng : NaN;
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  const window = await fetchVenueForecast(la, ln);
  if (!window) return null;
  return window[startDate] ?? null;
}

const _WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Build the per-event-day forecast strip rows across the WHOLE start..end window (#67): one row per
 * calendar day, each carrying the cached forecast when present, else a status placeholder ('beyond'
 * the 10-day horizon / 'past' / 'pending'). Faithful to the Python forecastRows memo (~L11590) — the
 * section always spans the full event, not only the days that happen to have data. Returns [] when
 * there's no forecast window or no start date (the cases the Python shows no strip for). PURE-ish:
 * uses UTC Date math on the YMD strings, so the label is deterministic (no locale/timezone read).
 */
export function buildEventForecastRows(
  startDate: string | undefined,
  endDate: string | undefined,
  forecastWindow: Record<string, WeatherForecastDay> | null | undefined
): EventForecastRow[] {
  if (!forecastWindow || !Object.keys(forecastWindow).length || !startDate) return [];
  const start = new Date(startDate + 'T00:00:00Z');
  if (isNaN(start.getTime())) return [];
  const end = new Date((endDate || startDate) + 'T00:00:00Z');
  const wk = Object.keys(forecastWindow).sort(); // YYYY-MM-DD sorts lexically
  const firstW = wk[0];
  const lastW = wk[wk.length - 1];
  const out: EventForecastRow[] = [];
  const cur = new Date(start);
  let guard = 0;
  while (cur.getTime() <= end.getTime() && guard++ < 90) {
    const ymd = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}-${String(cur.getUTCDate()).padStart(2, '0')}`;
    const w = forecastWindow[ymd];
    let status: EventForecastRow['status'] = 'pending';
    if (w) status = 'data';
    else if (lastW && ymd > lastW) status = 'beyond';
    else if (firstW && ymd < firstW) status = 'past';
    const label = `${_WD[cur.getUTCDay()]} ${_MO[cur.getUTCMonth()]} ${cur.getUTCDate()}`;
    out.push({ ymd, label, w: w || null, status });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}
