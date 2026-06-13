import 'server-only';
import { fetchVenueForecast, weatherEnabled } from '@/lib/integrations/weather';
import type { WeatherForecastDay } from '@/lib/types/types-dashboard';

// lib/integrations/weather-alerts.ts — SEVERE weather warnings for an event venue.
//
// Two sources, picked by where the venue is:
//   • US + territories: the US National Weather Service (api.weather.gov) ACTIVE ALERTS feed. Free,
//     no API key, authoritative — this is the real Tornado / Hurricane / Severe Thunderstorm / Flood /
//     Winter Storm WARNING. We keep only Severe + Extreme severities (the "warnings", not watches).
//   • Everywhere else (or when NWS is unreachable): a softer FORECAST-DERIVED "rough weather" heads-up
//     from the existing Google Weather forecast — only when that key is enabled, else nothing.
//
// Used by: the event-detail banner (live, on render), the dashboard card badge, and the background
// push sweep (lib/integrations/weather-refresh). A short in-process TTL cache keeps the (free) NWS
// calls polite and shared across all three — severe alerts move fast, so the TTL is minutes, not hours.

export interface SevereAlert {
  /** 'nws' = official warning; 'forecast' = derived heads-up (softer). */
  source: 'nws' | 'forecast';
  /** Stable dedup key (NWS alert id, or a forecast day signature). */
  id: string;
  /** The warning name, e.g. "Tornado Warning", "Severe Thunderstorm Warning", or "Rough weather". */
  event: string;
  severity: 'extreme' | 'severe' | 'moderate' | 'rough';
  /** One-line human headline. */
  headline: string;
  /** Affected area, e.g. "Wayne County, MI" (NWS only). */
  areaDesc?: string;
  /** ISO timestamps when known (NWS). */
  onset?: string | null;
  expires?: string | null;
}

// NWS covers the US + territories only. A coarse bbox gate avoids a wasted call for an obviously
// international venue (the feed itself returns nothing for points it doesn't cover, but we skip early).
export function isUsCoords(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat >= 24 && lat <= 50 && lng >= -125 && lng <= -66) return true; // CONUS
  if (lat >= 51 && lat <= 72 && lng >= -170 && lng <= -129) return true; // Alaska
  if (lat >= 18 && lat <= 23 && lng >= -161 && lng <= -154) return true; // Hawaii
  if (lat >= 17 && lat <= 19 && lng >= -68 && lng <= -64) return true; // Puerto Rico / USVI
  return false;
}

const NWS_ENDPOINT = 'https://api.weather.gov/alerts/active';
// NWS policy: a User-Agent identifying the app (+ a contact) is required.
const NWS_UA = 'EventTracker/1.0 (https://eventtracker.dev)';
const NWS_KEEP = new Set(['Extreme', 'Severe']); // the warnings; drop Moderate/Minor watches/advisories

// Severe alerts change minute-to-minute — a SHORT TTL keeps the banner honest while staying polite.
const TTL_MS = 10 * 60_000;
const CAP = 400;
const _cache = new Map<string, { at: number; data: SevereAlert[] }>();
const cacheKey = (lat: number, lng: number) => `${lat.toFixed(2)},${lng.toFixed(2)}`;

interface NwsProps {
  id?: string;
  '@id'?: string;
  event?: string;
  severity?: string;
  headline?: string;
  areaDesc?: string;
  onset?: string | null;
  effective?: string | null;
  expires?: string | null;
  ends?: string | null;
}

async function fetchNws(lat: number, lng: number): Promise<SevereAlert[] | null> {
  try {
    const url = `${NWS_ENDPOINT}?status=actual&message_type=alert&point=${lat.toFixed(4)},${lng.toFixed(4)}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': NWS_UA, Accept: 'application/geo+json' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!r.ok) return null; // 404 (uncovered point) / 5xx — let the caller fall back
    const j = (await r.json()) as { features?: Array<{ properties?: NwsProps }> };
    const out: SevereAlert[] = [];
    for (const f of j.features ?? []) {
      const p = f.properties ?? {};
      const sev = String(p.severity ?? '');
      if (!NWS_KEEP.has(sev)) continue;
      out.push({
        source: 'nws',
        id: String(p.id ?? p['@id'] ?? `${p.event}|${p.onset ?? ''}`),
        event: String(p.event ?? 'Weather Warning').slice(0, 80),
        severity: sev === 'Extreme' ? 'extreme' : 'severe',
        headline: String(p.headline ?? p.event ?? '').slice(0, 240),
        areaDesc: String(p.areaDesc ?? '').slice(0, 200) || undefined,
        onset: p.onset ?? p.effective ?? null,
        expires: p.expires ?? p.ends ?? null,
      });
    }
    return out;
  } catch {
    return null; // network/timeout — caller falls back to the forecast heads-up
  }
}

// Forecast-derived "rough weather": scan the venue forecast across the event window for days whose
// condition reads as genuinely rough. A SOFT signal (source 'forecast') — not an official warning.
const ROUGH_RE = /thunder|storm|tornado|hail|blizzard|snow|sleet|ice|icy|freezing|hurricane|tropical|cyclone|flood|gale|squall|severe/i;

function* eventDays(startDate?: string, endDate?: string): Generator<string> {
  const s = String(startDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // No window — check the next 3 calendar days from today (local).
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      yield `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return;
  }
  const e = /^\d{4}-\d{2}-\d{2}$/.test(String(endDate ?? '').trim()) ? String(endDate).trim() : s;
  const [sy, sm, sd] = s.split('-').map(Number);
  const [ey, em, ed] = e.split('-').map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  for (let guard = 0; cur <= end && guard < 14; guard++) {
    yield `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    cur.setDate(cur.getDate() + 1);
  }
}

async function deriveForecastSevere(
  lat: number,
  lng: number,
  window: { startDate?: string; endDate?: string } | undefined
): Promise<SevereAlert[]> {
  const forecast = await fetchVenueForecast(lat, lng);
  if (!forecast) return [];
  const out: SevereAlert[] = [];
  for (const day of eventDays(window?.startDate, window?.endDate)) {
    const w: WeatherForecastDay | undefined = forecast[day];
    if (!w) continue;
    if (ROUGH_RE.test(w.label || '')) {
      out.push({
        source: 'forecast',
        id: `forecast|${day}|${w.label}`,
        event: 'Rough weather',
        severity: 'rough',
        headline: `${w.emoji ? `${w.emoji} ` : ''}${w.label} forecast for ${day}`,
        onset: `${day}T00:00:00`,
        expires: `${day}T23:59:59`,
      });
    }
  }
  return out;
}

/**
 * Active SEVERE weather for a venue. US → official NWS warnings; otherwise → a forecast-derived
 * heads-up (only when the Google Weather key is enabled). Cached for {@link TTL_MS}. Never throws.
 *
 * @param window event date span — only used to scope the forecast fallback (NWS is "active now").
 */
export async function fetchSevereAlerts(
  lat: number,
  lng: number,
  window?: { startDate?: string; endDate?: string }
): Promise<SevereAlert[]> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const key = cacheKey(lat, lng);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  let alerts: SevereAlert[] | null = null;
  if (isUsCoords(lat, lng)) {
    alerts = await fetchNws(lat, lng);
  }
  // International, or NWS unreachable → the forecast heads-up (no-op unless weather is enabled).
  if (alerts == null) {
    alerts = (await weatherEnabled()) ? await deriveForecastSevere(lat, lng, window) : [];
  }

  // Bound the cache (simple FIFO trim).
  if (_cache.size >= CAP) {
    const oldest = _cache.keys().next().value;
    if (oldest) _cache.delete(oldest);
  }
  _cache.set(key, { at: Date.now(), data: alerts });
  return alerts;
}

/** The worst severity present (for the banner/badge tint), or null when there are none. */
export function topSeverity(alerts: SevereAlert[]): SevereAlert['severity'] | null {
  const order: SevereAlert['severity'][] = ['extreme', 'severe', 'moderate', 'rough'];
  for (const s of order) if (alerts.some((a) => a.severity === s)) return s;
  return null;
}
