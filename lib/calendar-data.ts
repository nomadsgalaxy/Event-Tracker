import 'server-only';
import { getEvents, getTags, type TagDoc } from './data';
import { fetchVenueForecast } from './weather';
import type { CalEventInput } from '@/app/calendar/cal-utils';
import type { DashTag, WeatherForecastDay } from './types-dashboard';

// lib/calendar-data.ts — the ONE live read that powers the Calendar (Year / Month / Week).
//
// Faithful server-side port of the Python's useEnrichedEvents + displayShow (index.html ~L22631) +
// the per-view weather lookups (useEventWeather ~L22805). The Python enriches every event with
// parsed dates + venue.city + the manifest stats; the calendar specifically reads the LOGISTICS
// fields (doorsOpen/doorsClose, setup/teardown windows, outbound pickup, return arrival), the
// applied tag ids, and a per-event venue forecast. We project exactly those into CalEventInput so
// the client views render 1:1 with the Python — without the manifest cross-join the calendar never
// uses (kept lean: a single events+tags read, plus the weather fan-out which is a no-op until the
// Google Weather key is configured — see lib/weather.ts).
//
// LIVE-DB ONLY: every call is a real round-trip (events + tags). No cache, no localStorage.

/**
 * Resolve a tag doc to the client-safe <TagChip> shape — the SAME mapping the dashboard uses
 * (lib/dashboard-metrics toDashTag): the flair glyph travels denormalized on customEmoji, with a
 * legacy fallback for the old 'flag-us'/'flag-cz' flair ids. Hidden/deleted tags are filtered by the
 * caller so they never surface as a chip.
 */
function toDashTag(doc: TagDoc): DashTag {
  const p = doc.payload ?? {};
  const flairId = p.flair;
  let flair = typeof p.customEmoji === 'string' ? p.customEmoji : '';
  if (!flair && flairId === 'flag-us') flair = '🇺🇸';
  if (!flair && flairId === 'flag-cz') flair = '🇨🇿';
  return {
    id: doc._id,
    label: typeof p.label === 'string' ? p.label : '',
    flair,
    color: typeof p.color === 'string' && p.color ? p.color : null,
  };
}

export interface CalendarData {
  /** The rich, render-ready events for the calendar views. */
  events: CalEventInput[];
  /** The VISIBLE tag directory the chips resolve against (id → DashTag). Hidden tags excluded. */
  tags: DashTag[];
}

/**
 * Read every (non-deleted) event + the visible tag directory, projected to the calendar's rich
 * shape. Each event carries its logistics windows + applied (visible) tag ids + per-venue forecast,
 * so the Year/Month/Week views render the segment chips, travel ribbon, hour blocks, weather chips,
 * and tag chips exactly like the Python.
 *
 * Weather: the Python fetches per-event forecasts lazily in the client (useEventWeather). Here it's
 * resolved server-side via fetchVenueForecast, which dedups per coord pair + caches (so events
 * sharing a venue hit the network once) and returns null until GOOGLE_WEATHER_API_KEY is set — so in
 * the default config this stays a single events+tags read and the chips render nothing (matching the
 * Python with no key). Once a key lands, the parse path is already 1:1 and the chips light up.
 */
export async function getCalendarData(): Promise<CalendarData> {
  const [eventDocs, tagDocs] = await Promise.all([getEvents(), getTags()]);

  // Visible tag directory (hidden tags can be applied but never render a chip — same as the Python's
  // `.filter(t => t && !t.hidden)` in every calendar tag map).
  const tagById = new Map<string, DashTag>();
  for (const d of tagDocs) {
    if (d.payload?.hidden) continue;
    tagById.set(d._id, toDashTag(d));
  }

  const events: CalEventInput[] = await Promise.all(
    eventDocs.map(async (e): Promise<CalEventInput> => {
      const p = e.payload ?? {};
      const venue = (p.venue ?? {}) as {
        city?: unknown;
        name?: unknown;
        lat?: unknown;
        lng?: unknown;
      };
      const venueCity = typeof venue.city === 'string' ? venue.city : '';
      const venueName = typeof venue.name === 'string' ? venue.name : '';
      const startDate = p.startDate || '';
      const endDate = p.endDate || '';

      // Applied VISIBLE tag ids only (drop hidden/deleted ids so the chip lookups stay clean).
      const tagIds = (Array.isArray(p.tagIds) ? p.tagIds : []).filter(
        (id): id is string => typeof id === 'string' && tagById.has(id),
      );

      // Staff onsite ranges for the ✈ travel ribbon (Week header). Carry only the fields the
      // ribbon needs (name/email + onsite range + legacy travelDays) — NOT the PII hotel/travel
      // blobs, which the calendar never shows.
      const staff = (Array.isArray(p.staff) ? p.staff : []).map((m) => ({
        name: typeof m?.name === 'string' ? m.name : '',
        email: typeof m?.email === 'string' ? m.email : '',
        onsiteStart: typeof m?.onsiteStart === 'string' ? m.onsiteStart : undefined,
        onsiteEnd: typeof m?.onsiteEnd === 'string' ? m.onsiteEnd : undefined,
        travelDays: Array.isArray((m as { travelDays?: unknown })?.travelDays)
          ? ((m as { travelDays?: unknown[] }).travelDays!.filter(
              (d): d is string => typeof d === 'string',
            ))
          : undefined,
      }));

      // Per-venue forecast window (null/{} until the weather key is wired). The whole 10-day window
      // is fetched once per coord pair and the views index it by day key.
      const lat = typeof venue.lat === 'number' ? venue.lat : NaN;
      const lng = typeof venue.lng === 'number' ? venue.lng : NaN;
      let weather: Record<string, WeatherForecastDay> = {};
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const w = await fetchVenueForecast(lat, lng);
        if (w) weather = w;
      }

      return {
        id: e._id,
        name: p.name || '',
        state: p.state || 'draft',
        startDate,
        endDate,
        city: venueCity || p.city || '',
        lead: p.lead || '',
        venueName,
        tags: tagIds.map((id) => tagById.get(id)?.label ?? '').filter(Boolean),
        doorsOpen: typeof p.doorsOpen === 'string' ? p.doorsOpen : '',
        doorsClose: typeof p.doorsClose === 'string' ? p.doorsClose : '',
        setup: p.setup ?? undefined,
        teardown: p.teardown ?? undefined,
        outbound: p.outbound
          ? { pickupDate: p.outbound.pickupDate, arrivalDate: p.outbound.arrivalDate }
          : undefined,
        return: p.return
          ? { pickupDate: p.return.pickupDate, arrivalDate: p.return.arrivalDate }
          : undefined,
        staff,
        tagIds,
        weather,
      };
    }),
  );

  // Sort chronologically; undated sink last (mirrors getDashboardEvents + the Python timeline).
  events.sort((a, b) => {
    const da = a.startDate || '9999-12-31';
    const db = b.startDate || '9999-12-31';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  return { events, tags: Array.from(tagById.values()) };
}
