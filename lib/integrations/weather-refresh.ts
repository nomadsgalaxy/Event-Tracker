import 'server-only';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import { fetchSevereAlerts } from '@/lib/integrations/weather-alerts';
import { createWeatherAlert } from '@/lib/views/notifications';
import type { EventDoc, EventPayload } from '@/lib/types/types';

// lib/integrations/weather-refresh.ts — the background SEVERE WEATHER sweep.
//
// Runs as the SYSTEM on a timer (instrumentation.ts). Each sweep scans live events that are happening
// SOON or NOW (a venue with coords, in the [now-1d … now+7d] window) and fetches the active severe
// alerts for the venue (NWS official for US, forecast-derived elsewhere). A NEW warning notifies the
// event LEAD + every assigned staffer via the bell. createWeatherAlert dedups per (recipient, event,
// alertId) for 24h, and fetchSevereAlerts caches per-venue for 10 min, so a frequent tick is cheap and
// a persistent warning never spams. NWS is free + keyless, so the only limiter is politeness: a
// per-sweep event cap + the shared fetch cache.

const TERMINAL = new Set(['closed', 'complete', 'cancelled', 'canceled']);
const AHEAD_DAYS = 7; // alert for events starting within a week
const BEHIND_DAYS = 1; // …and ones already underway (started up to a day ago)
const MAX_EVENTS = 40; // per-sweep backstop

const lc = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** Resolve the event LEAD's email (lead may be stored as an email or a staffer display name). */
function leadEmail(payload: EventPayload): string {
  const lead = String(payload.lead ?? '').trim();
  if (!lead) return '';
  if (lead.includes('@')) return lc(lead);
  for (const s of payload.staff ?? []) {
    if ((s?.name ?? '').trim() === lead || (s?.email ?? '').trim() === lead) return lc(s?.email);
  }
  return '';
}

/** Lead + every assigned staffer — severe weather is everyone's problem on site. */
function recipientsFor(payload: EventPayload): string[] {
  const set = new Set<string>();
  const l = leadEmail(payload);
  if (l) set.add(l);
  for (const s of payload.staff ?? []) {
    const e = lc(s?.email);
    if (e) set.add(e);
  }
  return [...set];
}

/** Does the event's [start-1d … end] span overlap the alerting window [now-1d … now+7d]? */
function inWindow(payload: EventPayload, now: number): boolean {
  const s = String(payload.startDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const e = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.endDate ?? '').trim()) ? String(payload.endDate).trim() : s;
  const [sy, sm, sd] = s.split('-').map(Number);
  const [ey, em, ed] = e.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd).getTime();
  const end = new Date(ey, em - 1, ed, 23, 59, 59).getTime();
  const from = now - BEHIND_DAYS * 86_400_000;
  const to = now + AHEAD_DAYS * 86_400_000;
  return end >= from && start <= to;
}

export interface WeatherAlertsResult {
  checked: number;
  alerts: number;
  reason?: string;
}

export async function runWeatherAlerts(opts: { now?: number; maxEvents?: number } = {}): Promise<WeatherAlertsResult> {
  const now = opts.now ?? Date.now();
  const maxEvents = opts.maxEvents ?? MAX_EVENTS;
  const db = await getDb();
  const events = await db.collection<EventDoc>('events').find(NOT_DELETED).toArray();

  // Candidates: non-terminal, in the alerting window, with venue coordinates. Soonest first.
  const cands = events
    .map((ev) => ({ ev, payload: ev.payload || ({} as EventPayload) }))
    .filter(({ payload }) => !TERMINAL.has(String(payload.state)) && inWindow(payload, now))
    .filter(({ payload }) => Number.isFinite(Number(payload.venue?.lat)) && Number.isFinite(Number(payload.venue?.lng)))
    .sort((a, b) => String(a.payload.startDate).localeCompare(String(b.payload.startDate)))
    .slice(0, maxEvents);

  if (cands.length === 0) return { checked: 0, alerts: 0, reason: 'none-due' };

  let checked = 0;
  let alerts = 0;
  for (const { ev, payload } of cands) {
    const lat = Number(payload.venue?.lat);
    const lng = Number(payload.venue?.lng);
    checked++;
    let active;
    try {
      active = await fetchSevereAlerts(lat, lng, { startDate: payload.startDate, endDate: payload.endDate });
    } catch {
      continue;
    }
    if (!active.length) continue;
    const tos = recipientsFor(payload);
    if (tos.length === 0) continue;
    for (const a of active) {
      for (const to of tos) {
        try {
          const r = await createWeatherAlert(to, {
            eventId: ev._id,
            eventName: payload.name,
            source: a.source,
            event: a.event,
            severity: a.severity,
            headline: a.headline,
            areaDesc: a.areaDesc,
            alertId: a.id,
            expires: a.expires ?? null,
          });
          if (r.ok && !r.duplicate) alerts++;
        } catch {
          /* best-effort per recipient */
        }
      }
    }
  }
  return { checked, alerts };
}
