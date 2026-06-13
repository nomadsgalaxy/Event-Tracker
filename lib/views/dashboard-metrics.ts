import 'server-only';
import { getEvents, getInventory, getTags, type TagDoc } from '@/lib/db/data';
import {
  itemCaseIds,
  itemRollupState,
  type InventoryPayload,
} from '@/lib/views/inventory-shape';
import { itemQtyInCase, buildCaseManifest } from '@/lib/views/case-view';
import { startDayForecast } from '@/lib/integrations/weather';
import { fetchSevereAlerts } from '@/lib/integrations/weather-alerts';
import type { EventDoc } from '@/lib/types/types';
import type {
  DashEvent,
  DashTimelineEvent,
  DashboardData,
  DashKpis,
  DashFilterCounts,
  DashTag,
} from '@/lib/types/types-dashboard';

// lib/views/dashboard-metrics.ts — the ONE live read that powers the re-cast Archetype-A Dashboard.
//
// Faithful port of the existing app's DashHybrid season-at-a-glance derivations
// (index.html ~L15145-15252): the "items in motion" / "open flags" KPIs, the per-event manifest
// progress (scanned/total/flagged), the flagged-event set, and the filter counts — computed
// SERVER-SIDE off a single live DB round-trip (events + inventory), no cache.
//
// WHY a dedicated reader (not getDashboardEvents): the timeline + KPIs need the event→case→
// inventory CROSS-JOIN, which getDashboardEvents deliberately omits (it projects only filterable
// event metadata). The join helpers (itemCaseIds / itemQtyInCase / buildCaseManifest) are the
// SAME ones the catalog + manifest screens use, so a count here can never drift from the manifest
// screen's own math (the single-source-of-truth rule).
//
// LIVE-DB ONLY: every call is two real round-trips (events + inventory). The page calls this once
// per request behind requireUser().

// States in which an event holds its cases "in motion" — #66 set, identical to the existing app's
// ACTIVE_STATES in DashHybrid (NOT the dash-utils filter set: that one also includes 'unpacking',
// which the existing app's KPI loop ALSO includes, so they match — see ACTIVE_STATES below).
const ACTIVE_STATES = new Set([
  'packing',
  'ready',
  'in_transit',
  'onsite',
  'returning',
  'unpacking',
]);

function midnightTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endMs(start: string, end: string): number {
  if (end) return new Date(end + 'T23:59:59').getTime();
  if (start) return new Date(start + 'T23:59:59').getTime();
  return Infinity;
}

function itemHasOpenFlag(item: InventoryPayload): boolean {
  return (
    (item.flags ?? []).some((f) => f && f.status === 'open') ||
    itemRollupState(item) === 'flagged'
  );
}

// The active states in their canonical breakdown order (= ACTIVE_STATES) + their display labels.
// Ported from index.html subActive (~L15523): every state is SEEDED so the breakdown sums to the
// headline count, and 'onsite'/'in_transit' get spaced labels.
const ACTIVE_STATE_ORDER = ['packing', 'ready', 'in_transit', 'onsite', 'returning', 'unpacking'] as const;
function activeStateLabel(k: string): string {
  if (k === 'onsite') return 'on site';
  if (k === 'in_transit') return 'in transit';
  return k;
}

/**
 * Resolve a tag doc to the client-safe <TagChip> shape. The flair glyph travels denormalized on
 * customEmoji (so a flag/emoji renders without the tag library); falls back to the legacy
 * flag-us/flag-cz `flair` ids by mapping them to the matching regional-indicator emoji.
 */
function toDashTag(doc: TagDoc): DashTag {
  const p = doc.payload ?? {};
  const flairId = p.flair;
  let flair = typeof p.customEmoji === 'string' ? p.customEmoji : '';
  // Legacy: older tags encoded the flag in `flair` ('flag-us'/'flag-cz') with no customEmoji.
  if (!flair && flairId === 'flag-us') flair = '🇺🇸';
  if (!flair && flairId === 'flag-cz') flair = '🇨🇿';
  return {
    id: doc._id,
    label: typeof p.label === 'string' ? p.label : '',
    flair,
    color: typeof p.color === 'string' && p.color ? p.color : null,
  };
}

/**
 * The effective PRIMARY tag for an event — a faithful port of index.html effectivePrimaryTagId
 * (~L2935): the explicit primaryTagId IF it still points at an existing VISIBLE tag, else the first
 * visible applied tag in alphabetical label order. Returns null when the event has no visible tags.
 * `tagById` maps id → resolved DashTag (visible tags only — hidden/deleted tags are absent).
 */
function effectivePrimaryTag(
  tagIds: string[],
  primaryTagId: string | null,
  tagById: Map<string, DashTag>
): DashTag | null {
  if (!Array.isArray(tagIds) || tagIds.length === 0) return null;
  if (primaryTagId) {
    const t = tagById.get(primaryTagId);
    if (t) return t;
  }
  const visible = tagIds
    .map((id) => tagById.get(id))
    .filter((t): t is DashTag => !!t)
    .sort((a, b) => a.label.localeCompare(b.label));
  return visible.length ? visible[0] : null;
}

/**
 * Compute the full Dashboard data set from a single live read.
 *
 * The cross-join (the load-bearing bit the task asks about — "how items in motion is computed"):
 *   1. Collect every case id that belongs to an ACTIVE-state event (event.cases[]). Because a
 *      case lives on exactly one event in this model, a unit is never double-counted.
 *   2. For each inventory item, sum itemQtyInCase(item, caseId) over the active case ids it's
 *      routed into. itemQtyInCase already branches bulk (distribution[] qty) vs serial (#22 units[]),
 *      so a bulk and a serialized item count identically. That sum is "items in motion".
 *   3. Open flags (KPI) = the same qty, summed only for items carrying an open flag (qty-weighted),
 *      matching the existing app's openFlags loop.
 *   4. Per-event progress (scanned/total/flagged) reuses buildCaseManifest over the event's own
 *      cases[] — the exact manifest math the Manifest/Case screens use.
 */
export async function getDashboardData(): Promise<DashboardData> {
  const [eventDocs, inventoryDocs, tagDocs] = await Promise.all([
    getEvents(),
    getInventory(),
    getTags(),
  ]);
  const inv: InventoryPayload[] = inventoryDocs.map((d) => d.payload);

  // Tag lookup for the per-event primary-tag resolution. Only VISIBLE tags are mapped (hidden tags
  // are skipped exactly like effectivePrimaryTagId does — a hidden tag can be applied but never wins
  // primary). Deleted tags are already excluded by getTags (NOT_DELETED).
  const tagById = new Map<string, DashTag>();
  for (const d of tagDocs) {
    if (d.payload?.hidden) continue;
    tagById.set(d._id, toDashTag(d));
  }

  const today = midnightTodayMs();
  const thisYear = new Date().getFullYear();

  // ── 1. active case ids (cases held by an in-motion event) ───────────────────────────────
  const activeCaseIds = new Set<string>();
  for (const e of eventDocs) {
    const state = e.payload.state ?? 'draft';
    if (!ACTIVE_STATES.has(state)) continue;
    for (const cid of e.payload.cases ?? []) activeCaseIds.add(cid);
  }

  // ── 2 + 3. items in motion + qty-weighted open flags ────────────────────────────────────
  let itemsInMotion = 0;
  let openFlagsQty = 0;
  for (const item of inv) {
    const matching = itemCaseIds(item).filter((cid) => activeCaseIds.has(cid));
    if (matching.length === 0) continue;
    let qtyInActive = 0;
    for (const cid of matching) qtyInActive += itemQtyInCase(item, cid);
    itemsInMotion += qtyInActive;
    if (itemHasOpenFlag(item)) openFlagsQty += qtyInActive;
  }

  // ── flagged-EVENT set: events with ≥1 flagged inventory row in their cases ───────────────
  // O(events × items) once via a case→event map, then folded into the timeline + the "Open
  // flags" sidebar filter count (a count of distinct EVENTS, distinct from the qty-weighted KPI).
  const caseToEvent = new Map<string, string>();
  for (const e of eventDocs) {
    for (const cid of e.payload.cases ?? []) caseToEvent.set(cid, e._id);
  }
  const flaggedEventIds = new Set<string>();
  for (const item of inv) {
    if (!itemHasOpenFlag(item)) continue;
    for (const cid of itemCaseIds(item)) {
      const eid = caseToEvent.get(cid);
      if (eid) flaggedEventIds.add(eid);
    }
  }

  // ── per-event manifest progress (scanned/total/flagged) via the shared manifest builder ──
  // One buildCaseManifest pass per event over its own cases[], summed. This is the SAME math the
  // Manifest + Case screens render, so the dashboard progress bars can't drift from them.
  function eventProgress(e: EventDoc): { scanned: number; total: number; flagged: number } {
    let scanned = 0;
    let total = 0;
    let flagged = 0;
    for (const cid of e.payload.cases ?? []) {
      const m = buildCaseManifest(cid, inv);
      scanned += m.scanned;
      total += m.total;
      flagged += m.flagged;
    }
    return { scanned, total, flagged };
  }

  // ── project to the client-safe timeline shape ───────────────────────────────────────────
  // Async per-event because the per-event START-day weather is an awaited venue-forecast lookup
  // (fetchVenueForecast caches per coord pair + dedups, so the events sharing a convention center
  // hit the network once). Weather is a NO-OP (null) until the Google Weather key is wired — see
  // lib/weather.ts — so this stays a single events+inventory+tags read in the default config.
  const timeline: DashTimelineEvent[] = await Promise.all(
    eventDocs.map(async (e): Promise<DashTimelineEvent> => {
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
      const prog = eventProgress(e);

      // Effective primary tag (the "Flair:" chip on the timeline card). Events reference tags by
      // payload.tagIds[] + payload.primaryTagId (NOT a flat tags[] of names).
      const tagIds = Array.isArray(p.tagIds)
        ? p.tagIds.filter((t): t is string => typeof t === 'string')
        : [];
      const primaryTagId =
        typeof p.primaryTagId === 'string' ? p.primaryTagId : null;
      const primaryTag = effectivePrimaryTag(tagIds, primaryTagId, tagById);

      // Per-event start-day forecast (null unless the Google Weather key is configured).
      const weather = await startDayForecast(startDate, venue.lat, venue.lng);

      // Severe weather for the card badge — only for an event happening soon / now (caps the NWS
      // calls to the few in-window events; fetchSevereAlerts caches per venue). null = none.
      let severeWeather: DashEvent['severeWeather'] = null;
      {
        const wlat = Number(venue.lat);
        const wlng = Number(venue.lng);
        const sMs = startDate ? new Date(startDate + 'T00:00:00').getTime() : NaN;
        const eMs = endDate ? new Date(endDate + 'T23:59:59').getTime() : sMs;
        const terminal = ['closed', 'complete', 'cancelled', 'canceled'].includes(String(p.state));
        const inWin = Number.isFinite(sMs) && eMs >= today - 86_400_000 && sMs <= today + 7 * 86_400_000;
        if (!terminal && inWin && Number.isFinite(wlat) && Number.isFinite(wlng)) {
          try {
            const active = await fetchSevereAlerts(wlat, wlng, { startDate, endDate });
            if (active.length) severeWeather = { official: active.some((a) => a.source === 'nws'), label: active[0].event };
          } catch {
            /* no badge on a fetch hiccup */
          }
        }
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
        // The flat tag-NAME haystack the Find palette searches: the visible applied tags' labels.
        tags: tagIds.map((id) => tagById.get(id)?.label).filter((l): l is string => !!l),
        primaryTag,
        weather,
        severeWeather,
        scanned: prog.scanned,
        total: prog.total,
        flagged: prog.flagged > 0 || flaggedEventIds.has(e._id),
        // countdown: days from midnight-today to the event start (negative = already started/past).
        // Undated => null. Computed server-side off a midnight baseline so it's locale-stable and the
        // client renders the same "IN N DAYS" label the server saw (no hydration drift on the number).
        daysToStart: startDate
          ? Math.round(
              (new Date(startDate + 'T00:00:00').getTime() - today) / 86_400_000
            )
          : null,
        daysToEnd: startDate
          ? Math.round((endMs(startDate, endDate) - today) / 86_400_000)
          : null,
      };
    })
  );

  // Sort chronologically; undated sink last (mirrors getDashboardEvents + the existing timeline).
  timeline.sort((a, b) => {
    const da = a.startDate || '9999-12-31';
    const db = b.startDate || '9999-12-31';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  // ── filter counts (the sidebar badges) ──────────────────────────────────────────────────
  const isDraft = (s: DashTimelineEvent) => s.state === 'draft';
  const isActive = (s: DashTimelineEvent) => ACTIVE_STATES.has(s.state);
  const isUpcoming = (s: DashTimelineEvent) => s.state === 'upcoming';
  const isPast = (s: DashTimelineEvent) =>
    s.state === 'closed' || (!!s.endDate && endMs(s.startDate, s.endDate) < today);

  const counts: DashFilterCounts = {
    overview: timeline.length,
    drafts: timeline.filter(isDraft).length,
    active: timeline.filter(isActive).length,
    upcoming: timeline.filter(isUpcoming).length,
    past: timeline.filter(isPast).length,
    flags: flaggedEventIds.size,
  };

  // KPIs. "Active showcases" = events currently in motion; "Items in motion" = the join sum;
  // "Open flags" = the qty-weighted in-motion open flags (the existing app's KPI number).
  const activeShows = timeline.filter(isActive);
  const activeShowcases = activeShows.length;

  // The per-state breakdown sub-note (e.g. "2 packing · 1 on site · 3 returning"). SEED every active
  // state so the breakdown sums to activeShowcases, then join the non-zero parts; "no active events"
  // when empty. Verbatim from index.html subActive (~L15519).
  const stateCounts: Record<string, number> = {
    packing: 0,
    ready: 0,
    in_transit: 0,
    onsite: 0,
    returning: 0,
    unpacking: 0,
  };
  for (const s of activeShows) {
    if (stateCounts[s.state] !== undefined) stateCounts[s.state] += 1;
  }
  const subActiveParts = ACTIVE_STATE_ORDER.filter((k) => stateCounts[k] > 0).map(
    (k) => `${stateCounts[k]} ${activeStateLabel(k)}`
  );
  const subActive = subActiveParts.length ? subActiveParts.join(' · ') : 'no active events';

  const kpis: DashKpis = {
    activeShowcases,
    activeCaseCount: activeCaseIds.size,
    itemsInMotion,
    openFlags: openFlagsQty,
    flaggedEventCount: flaggedEventIds.size,
    eventsThisYear: timeline.filter((s) => {
      if (!s.startDate) return false;
      return new Date(s.startDate + 'T00:00:00').getFullYear() === thisYear;
    }).length,
    subActive,
  };

  return { events: timeline, counts, kpis, year: thisYear };
}
