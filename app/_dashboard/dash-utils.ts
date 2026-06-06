// Pure, isomorphic dashboard helpers — the tab-filter predicates + counts, ported VERBATIM
// from the current app's DashHybrid (index.html ~L15184–15233). No 'server-only' so the
// client filter component shares the EXACT same membership logic as the server-computed counts
// (a single source of truth — drift between the badge count and the rendered list is the bug
// this avoids).

import type { DashEvent, DashTimelineEvent } from '@/lib/types-dashboard';

export type DashFilter = 'overview' | 'drafts' | 'active' | 'upcoming' | 'past' | 'flags';

// An event carrying the cross-join-derived `flagged` flag (DashTimelineEvent) — needed for the
// 'flags' filter, which can't be decided from event metadata alone. Anything WITHOUT it is treated
// as not-flagged (so the bare DashEvent filters still work for the Find palette haystack).
function isFlagged(s: DashEvent | DashTimelineEvent): boolean {
  return 'flagged' in s ? !!(s as DashTimelineEvent).flagged : false;
}

/**
 * Project the rich timeline events down to the flat DashEvent[] the Find palette (FindCommand)
 * expects, so Find searches the exact set the dashboard renders. Isomorphic (lives here, not in
 * the 'server-only' dashboard-metrics) so the client island can call it.
 */
export function toDashEvents(events: DashTimelineEvent[]): DashEvent[] {
  return events.map((e) => ({
    id: e.id,
    name: e.name,
    state: e.state,
    startDate: e.startDate,
    endDate: e.endDate,
    city: e.city,
    lead: e.lead,
    venueName: e.venueName,
    tags: e.tags,
  }));
}

// States considered "active" (in motion) — #66 set, identical to isActive() in the current app.
const ACTIVE_STATES = new Set(['packing', 'ready', 'in_transit', 'onsite', 'returning', 'unpacking']);

// Midnight today, so an intra-day comparison never false-positives.
function todayMidnightMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// End-of-event timestamp (end day inclusive); falls back to start, then +Infinity for undated.
function endMs(s: DashEvent): number {
  if (s.endDate) return new Date(s.endDate + 'T23:59:59').getTime();
  if (s.startDate) return new Date(s.startDate + 'T23:59:59').getTime();
  return Infinity;
}

export function isActive(s: DashEvent): boolean {
  return ACTIVE_STATES.has(s.state);
}
export function isUpcoming(s: DashEvent): boolean {
  return s.state === 'upcoming';
}
export function isDraft(s: DashEvent): boolean {
  return s.state === 'draft';
}
export function isPast(s: DashEvent, today = todayMidnightMs()): boolean {
  return s.state === 'closed' || (!!s.endDate && endMs(s) < today);
}

/**
 * Filter membership. `overview` is the CATCH-ALL (everything, including drafts) so a saved
 * draft is never a "black hole" — the exact #91/#101 fix. An unknown filter id also returns
 * everything (fail-open to overview), never an empty list.
 */
export function matchesFilter(
  s: DashEvent | DashTimelineEvent,
  filter: DashFilter,
  today = todayMidnightMs()
): boolean {
  switch (filter) {
    case 'overview':
      return true;
    case 'drafts':
      return isDraft(s);
    case 'active':
      return isActive(s);
    case 'upcoming':
      return isUpcoming(s);
    case 'past':
      return isPast(s, today);
    case 'flags':
      return isFlagged(s);
    default:
      return true;
  }
}

// NOTE: the filter COUNTS (incl. the flagged-event count, which needs the event→inventory join)
// are computed SERVER-SIDE in lib/dashboard-metrics.getDashboardData → DashFilterCounts. The old
// client-side computeCounts() was removed so there's exactly one source for the badge numbers.

/**
 * Find-search predicate — name / city / lead / venue name, lower-cased substring. Mirrors the
 * "Find an event" overlay haystack in the current app (index.html ~L15445). An empty query
 * matches everything.
 */
export function matchesQuery(s: DashEvent, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [s.name, s.city, s.lead, s.venueName, s.tags.join(' ')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

// Filter metadata — id + label. Order is PORTED VERBATIM from the existing app's DashHybrid
// sidebar (index.html ~L15232-15239): Overview (the CATCH-ALL, so a draft is never hidden), then
// Drafts, Active, Upcoming, Past, Open flags. The DashboardClient maps each id to its lucide icon
// (FILTER_ICONS) — the design system is lucide-only, so no icon-name strings here.
export const FILTER_TABS: { id: DashFilter; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'active', label: 'Active' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Past' },
  { id: 'flags', label: 'Open flags' },
];
