// Pure, isomorphic timeline-axis math for the Dashboard timeline
// (DESIGN_ALIGNMENT.md §4.1 + the Python-app match: events are laid out as EQUAL-WIDTH COLUMNS that
// FILL the row in chronological order — NOT date-positioned with big gaps. The horizontal axis is
// just a thin line with a status dot centered above each card; the vertical TODAY line is
// INTERPOLATED among the evenly-spaced card slots, not placed by raw date fraction). No 'server-only'
// so the client timeline island shares the EXACT same date math the season-range header + the TODAY
// line use — one source of truth for where everything sits on the axis.
//
// DATE SAFETY (the load-bearing rule): we NEVER call `new Date('YYYY-MM-DD')`. The bare-string form
// is parsed as UTC midnight, then rendered in local time — west-of-UTC that shifts the day backward
// (the classic "event shows up one day early" bug). Every parse here goes through `ymdToLocalMs`,
// which splits the ISO string and builds an EXPLICIT local `new Date(y, m-1, d)` so the timestamp is
// local midnight of exactly that calendar day. ISO 'YYYY-MM-DD' strings also compare correctly as
// plain lexicographic strings (they're zero-padded + big-endian), so chronological SORTING uses
// string compare and only the AXIS positioning needs real timestamps.

import type { DashTimelineEvent } from '@/lib/types-dashboard';

const DAY_MS = 86_400_000;

/** Parse an ISO 'YYYY-MM-DD' to LOCAL-midnight ms via an explicit (y, m, d) Date (no UTC shift). */
export function ymdToLocalMs(iso: string): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // new Date(y, monthIndex, day) → local midnight of that exact calendar day.
  return new Date(y, mo - 1, d).getTime();
}

/** End-of-day (23:59:59.999 local) ms for an ISO date, inclusive of the whole end day. */
function endOfDayMs(iso: string): number | null {
  const ms = ymdToLocalMs(iso);
  return ms === null ? null : ms + DAY_MS - 1;
}

/** Local-midnight ms for "today". */
export function todayMidnightMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// States considered "active" (in motion) — #66 set, identical to the existing app's ACTIVE_STATES.
const ACTIVE_STATES = new Set([
  'packing',
  'ready',
  'in_transit',
  'onsite',
  'returning',
  'unpacking',
]);

/**
 * The "matters today" RELEVANCE filter for the timeline — a faithful port of index.html `relevant`
 * (~L15280): from the dated events, keep current + future, and keep PAST events only while they
 * haven't closed out (still returning / unreconciled). i.e. an event whose end is before today is
 * dropped UNLESS its state isn't 'closed'. Undated events are already excluded (they're the
 * notInTimeline tail). Input must already be chronologically sorted; output preserves that order.
 */
export function relevantTimelineEvents(
  events: DashTimelineEvent[],
  today = todayMidnightMs()
): DashTimelineEvent[] {
  return events.filter((s) => {
    if (!s.startDate) return false;
    const end = endOfDayMs(s.endDate || s.startDate);
    if (end !== null && end < today) return s.state !== 'closed';
    return true;
  });
}

/**
 * The active-event REGISTER rows (the "N SHOWCASES" table) — index.html `active` (~L15257): the
 * events in the CURRENT FILTER that are in an active (in-motion) state. Independent of the timeline
 * relevance filter (so a showcase can list even if the timeline capped it). Preserves input order.
 */
export function activeShowcaseEvents(events: DashTimelineEvent[]): DashTimelineEvent[] {
  return events.filter((s) => ACTIVE_STATES.has(s.state));
}

/**
 * The events the today-centric timeline does NOT surface, listed separately so a tab never shows a
 * count with an empty body — a faithful port of index.html `notInTimeline` (~L15291). The timeline
 * drops (a) dateless events and (b) past/closed events (the relevance filter). On OVERVIEW (the
 * catch-all, which intentionally hides closed/past), we list ONLY the dateless (drafts — the
 * #black-hole fix); on a SPECIFIC filter we list everything the timeline left out. Relevant-but-
 * overflow events stay in `relevant` → handled by the "+N more" link, never duplicated here.
 */
export function notInTimelineEvents(
  sortedFiltered: DashTimelineEvent[],
  relevant: DashTimelineEvent[],
  isOverview: boolean
): DashTimelineEvent[] {
  if (isOverview) return sortedFiltered.filter((s) => !s.startDate);
  const relevantIds = new Set(relevant.map((s) => s.id));
  return sortedFiltered.filter((s) => !relevantIds.has(s.id));
}

/**
 * Pick the responsive VISIBLE slice of the relevant timeline events, capped to `visibleCount`, in
 * PRIORITY order (current → next → closest-to-today) but RENDERED in the input (chronological) order.
 * Faithful to index.html priorityOrder + visibleShows (~L15326-15337): we choose WHICH events to
 * keep by priority, then preserve chronological order for layout so the axis still reads left→right
 * in time. Returns the kept events (chronological) + how many were hidden.
 */
export function pickVisibleTimeline(
  relevant: DashTimelineEvent[],
  visibleCount: number,
  today = todayMidnightMs()
): { visible: DashTimelineEvent[]; hiddenCount: number } {
  const n = relevant.length;
  const cap = Math.max(0, Math.min(visibleCount, n));
  if (cap >= n) return { visible: relevant.slice(), hiddenCount: 0 };

  const startMs = (s: DashTimelineEvent) => ymdToLocalMs(s.startDate) ?? Infinity;
  const isCurrent = (s: DashTimelineEvent) => {
    const ss = ymdToLocalMs(s.startDate);
    const ee = endOfDayMs(s.endDate || s.startDate);
    return ss !== null && ee !== null && ss <= today && today <= ee;
  };
  const current = relevant.find(isCurrent) ?? null;
  const next = relevant.find((s) => startMs(s) > today) ?? null;

  const priority = relevant.slice().sort((a, b) => {
    if (current && a.id === current.id) return -1;
    if (current && b.id === current.id) return 1;
    if (next && a.id === next.id) return -1;
    if (next && b.id === next.id) return 1;
    return Math.abs(startMs(a) - today) - Math.abs(startMs(b) - today);
  });
  const keptIds = new Set(priority.slice(0, cap).map((s) => s.id));
  const visible = relevant.filter((s) => keptIds.has(s.id)); // back to chronological order
  return { visible, hiddenCount: n - visible.length };
}

export interface AxisEvent {
  event: DashTimelineEvent;
  /**
   * Fractional left/center/right edges of this card's slot along the track, 0..1 — derived from the
   * SHARED slot+gap+margin geometry (see `trackGeometry`), so they line up EXACTLY with the CSS grid
   * the view renders. `center` places the status dot above the card middle; `left`/`right` bound the
   * in-card sweep zone the TODAY line uses while an event is in progress.
   */
  left: number;
  center: number;
  right: number;
}

/**
 * Where the TODAY line sits, as an explicit zone + a fraction within that zone — so the view can place
 * it against the REAL card slots and never overlap a card unless an event is in progress. The four
 * zones match the owner's spec exactly:
 *   • 'before'  — today < the first event's start → in the pre-season LEFT margin (not over card 1).
 *   • 'during'  — start ≤ today ≤ end of event[index] → INSIDE that card, swept by `fraction` (0..1)
 *                 of completion: 0 = card left edge, 1 = card right edge.
 *   • 'gap'     — today is after event[index] ends but before event[index+1] starts → in the GAP
 *                 between card[index] and card[index+1] (over neither).
 *   • 'after'   — today > the last event's end → in the post-season RIGHT margin (not over the last
 *                 card).
 * `pos` is the resolved 0..1 track fraction the view uses for `left:`; the zone/index/fraction are
 * exposed for clarity + the accessible label. Null when there are no dated events.
 */
export interface TodayMarker {
  zone: 'before' | 'during' | 'gap' | 'after';
  /** The event index this marker relates to: the 'during' card, or the LEFT card of a 'gap'. -1 for
   *  'before' (no left card); the last index for 'after'. */
  index: number;
  /** Completion fraction within a 'during' card (0..1). 0 otherwise. */
  fraction: number;
  /** Resolved track position, 0..1, for the line's `left:`. */
  pos: number;
}

export interface TimelineAxis {
  /** Dated events in chronological order, each with its slot edges on the shared track geometry. */
  items: AxisEvent[];
  /** Range start (earliest start) as local-midnight ms. */
  minMs: number;
  /** Range end (latest end) as local-end-of-day ms. */
  maxMs: number;
  /** The season-range label, e.g. "MAR — AUG 2026" (or spanning years). '' when no dated events. */
  rangeLabel: string;
  /** The TODAY marker descriptor (zone + resolved track position). Null only when no dated events. */
  todayMarker: TodayMarker | null;
  /** The id of the next upcoming/active event (gets the highlighted border + leads the table). */
  highlightId: string | null;
  /**
   * The shared track geometry (in `fr`-weight units) the view turns into a CSS grid template, so the
   * grid's card/gap/margin columns line up EXACTLY with the fraction math here. The line + dots are
   * placed by the 0..1 fractions in `items`/`todayMarker`, which are computed from THIS geometry. The
   * view sizes every column `minmax(0, weight fr)` so the track always fits the container width — the
   * cards scale to fit, never overflow/scroll.
   */
  geometry: TrackGeometry;
}

/**
 * Track layout in `fr`-weight units. The track is, left→right:
 *   [margin] card [gap] card [gap] … card [margin]
 * with every card the same weight, every inter-card gap the same weight, and the two end margins the
 * same weight. The view builds a grid template from these weights; the 0..1 edge fractions in
 * `items`/`todayMarker` come from the SAME weights, so geometry and grid agree at any width.
 */
export interface TrackGeometry {
  /** Weight of one card column. */
  cardW: number;
  /** Weight of one inter-card gap column (0 when there's a single card → no gaps). */
  gapW: number;
  /** Weight of each end (pre/post-season) margin column. */
  marginW: number;
  /** Number of cards. */
  n: number;
}

// Relative weights for the shared track geometry. A card is the unit (1); a gap and each end margin
// are a fraction of a card so the cards stay dominant while the TODAY line still has a pre-season
// margin, inter-card gaps, and a post-season margin to sit in when no event is in progress.
const CARD_WEIGHT = 1;
const GAP_WEIGHT = 0.22;
const MARGIN_WEIGHT = 0.4;

/**
 * Build the per-card slot edges (0..1 of the track) from the shared geometry. Card i occupies, in
 * weight units, the span starting after [margin + i cards + i gaps]. We normalize by the total weight
 * so the edges are 0..1 fractions the view's grid (built from the same weights) matches exactly.
 */
function slotEdges(g: TrackGeometry): { left: number; center: number; right: number }[] {
  const total = 2 * g.marginW + g.n * g.cardW + Math.max(0, g.n - 1) * g.gapW;
  const out: { left: number; center: number; right: number }[] = [];
  for (let i = 0; i < g.n; i++) {
    const startW = g.marginW + i * g.cardW + i * g.gapW;
    const left = startW / total;
    const right = (startW + g.cardW) / total;
    out.push({ left, center: (left + right) / 2, right });
  }
  return out;
}

/** The 0..1 track fraction at the LEFT edge of inter-card gap after card i (i in [0, n-2]). */
function gapBounds(g: TrackGeometry, i: number): { left: number; right: number } {
  const total = 2 * g.marginW + g.n * g.cardW + Math.max(0, g.n - 1) * g.gapW;
  const cardRightW = g.marginW + (i + 1) * g.cardW + i * g.gapW;
  return { left: cardRightW / total, right: (cardRightW + g.gapW) / total };
}

const MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

/** Month-abbrev + year for an ISO date, via the safe explicit-Date parse. */
function monthYear(iso: string): { month: string; year: number } | null {
  const ms = ymdToLocalMs(iso);
  if (ms === null) return null;
  const d = new Date(ms);
  return { month: MONTHS[d.getMonth()], year: d.getFullYear() };
}

/** Month-abbrev + year from a ms timestamp (used for the EXTENDED range label that includes today). */
function monthYearFromMs(ms: number): { month: string; year: number } | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return { month: MONTHS[d.getMonth()], year: d.getFullYear() };
}

/**
 * Build the timeline axis from the (already-filtered) dashboard events. Dateless events are dropped
 * here — the caller lists them separately.
 *
 * Layout model (matches the Python app): the dated events are laid out as EQUAL-WIDTH COLUMNS in
 * chronological order. The track also reserves a pre-season LEFT margin, inter-card GAPS, and a
 * post-season RIGHT margin (the shared `TrackGeometry`) so the TODAY line has somewhere to sit when
 * no event is in progress — it never overlaps a card unless that event is currently running. The
 * `minMs`/`maxMs`/`rangeLabel` describe the real date span for the header.
 */
export function buildTimelineAxis(
  events: DashTimelineEvent[],
  today = todayMidnightMs()
): TimelineAxis {
  const dated = events.filter((e) => !!e.startDate);

  if (dated.length === 0) {
    return {
      items: [],
      minMs: 0,
      maxMs: 0,
      rangeLabel: '',
      todayMarker: null,
      highlightId: null,
      geometry: { cardW: CARD_WEIGHT, gapW: 0, marginW: MARGIN_WEIGHT, n: 0 },
    };
  }

  // Chronological order by ISO string compare (correct for zero-padded big-endian dates).
  const sorted = dated
    .slice()
    .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));

  // Real date span = earliest start → latest end (inclusive end-of-day), EXTENDED to include today.
  // This drives ONLY the TODAY-line positioning (so the line always has somewhere to sit relative to
  // "now") — NOT the header label, which is computed from the events' START months below.
  let eventMin = Infinity;
  let eventMax = -Infinity;
  for (const e of sorted) {
    const s = ymdToLocalMs(e.startDate);
    if (s === null) continue;
    if (s < eventMin) eventMin = s;
    const end = endOfDayMs(e.endDate || e.startDate);
    if (end !== null && end > eventMax) eventMax = end;
  }
  const minMs = Math.min(eventMin, today);
  const maxMs = Math.max(eventMax, today);

  const n = sorted.length;
  // Shared geometry: a single card has no gaps; ≥2 cards get inter-card gaps. Both ends get a margin.
  const geometry: TrackGeometry = {
    cardW: CARD_WEIGHT,
    gapW: n > 1 ? GAP_WEIGHT : 0,
    marginW: MARGIN_WEIGHT,
    n,
  };
  const edges = slotEdges(geometry);
  const items: AxisEvent[] = sorted.map((event, i) => ({
    event,
    left: edges[i].left,
    center: edges[i].center,
    right: edges[i].right,
  }));

  // Season-range label from the events' START months ONLY — earliest start → latest start (NOT end
  // dates, NOT the today-extension). 1:1 with the Python dateRange (index.html ~L15299): e.g. a
  // single June event reads "JUN — JUN 2026", not "JUN — JUL". `sorted` is chronological by start, so
  // sorted[0] is the earliest start and sorted[n-1] the latest. Falls back to the ms span only if a
  // start somehow fails to parse (it won't — every event here has a startDate).
  const first = monthYear(sorted[0].startDate) ?? monthYearFromMs(minMs);
  const last = monthYear(sorted[n - 1].startDate) ?? monthYearFromMs(maxMs);
  let rangeLabel = '';
  if (first && last) {
    rangeLabel =
      first.year === last.year
        ? `${first.month} — ${last.month} ${last.year}`
        : `${first.month} ${first.year} — ${last.month} ${last.year}`;
  }

  // TODAY marker — zoned against the REAL card slots (never over a card unless an event is running).
  const todayMarker = resolveTodayMarker(sorted, items, geometry, today);

  // Highlight the next upcoming/active event: prefer a currently-running event (start ≤ today ≤ end),
  // else the soonest future start, else (all past) the most recent — so a card is always called out.
  const highlightId = pickHighlight(sorted, today);

  return { items, minMs, maxMs, rangeLabel, todayMarker, highlightId, geometry };
}

/**
 * Resolve the TODAY marker into one of the four exact zones (before / during / gap / after), each with
 * a resolved 0..1 track position that NEVER overlaps a card unless an event is in progress:
 *   • DURING (start ≤ today ≤ end): inside that card, swept across its width by completion fraction
 *     = (today_midnight − start_midnight) / (end_endOfDay − start_midnight), clamped 0..1. So 1 day
 *     into a 3-day show ≈ 1/3 across the card.
 *   • BEFORE (today < first start): in the pre-season LEFT margin (left of card 1), centered in it.
 *   • GAP (after event i ends, before event i+1 starts): centered in the gap between card i and i+1.
 *   • AFTER (today > last end): in the post-season RIGHT margin (right of the last card), centered.
 * `sorted`/`items` are index-aligned (both chronological).
 */
function resolveTodayMarker(
  sorted: DashTimelineEvent[],
  items: AxisEvent[],
  geometry: TrackGeometry,
  today: number
): TodayMarker {
  const n = items.length;
  const startMs = (i: number) => ymdToLocalMs(sorted[i].startDate);
  const endMs = (i: number) => endOfDayMs(sorted[i].endDate || sorted[i].startDate);

  // 1) DURING — today inside any event's [start, end]. Sweep across that card by completion fraction.
  for (let i = 0; i < n; i++) {
    const s = startMs(i);
    const e = endMs(i);
    if (s === null || e === null) continue;
    if (today >= s && today <= e) {
      const span = e - s;
      const fraction = span > 0 ? Math.min(1, Math.max(0, (today - s) / span)) : 0;
      const pos = items[i].left + fraction * (items[i].right - items[i].left);
      return { zone: 'during', index: i, fraction, pos };
    }
  }

  // 2) BEFORE — today is before the first event's start → centered in the left margin.
  const firstStart = startMs(0);
  if (firstStart === null || today < firstStart) {
    // Left margin spans [0, items[0].left]; sit the line in its middle.
    return { zone: 'before', index: -1, fraction: 0, pos: items[0].left / 2 };
  }

  // 3) GAP — today is past event i's end but before event i+1's start → centered in that gap.
  for (let i = 0; i < n - 1; i++) {
    const eEnd = endMs(i);
    const nextStart = startMs(i + 1);
    if (eEnd === null || nextStart === null) continue;
    if (today > eEnd && today < nextStart) {
      const g = gapBounds(geometry, i);
      return { zone: 'gap', index: i, fraction: 0, pos: (g.left + g.right) / 2 };
    }
  }

  // 4) AFTER — today is past the last event's end → centered in the right margin.
  // Right margin spans [items[n-1].right, 1].
  const lastRight = items[n - 1].right;
  return { zone: 'after', index: n - 1, fraction: 0, pos: (lastRight + 1) / 2 };
}

function pickHighlight(sortedDated: DashTimelineEvent[], today: number): string | null {
  if (sortedDated.length === 0) return null;
  // 1. currently running.
  for (const e of sortedDated) {
    const s = ymdToLocalMs(e.startDate);
    const end = endOfDayMs(e.endDate || e.startDate);
    if (s !== null && end !== null && s <= today && today <= end) return e.id;
  }
  // 2. soonest future start (sorted asc → first one strictly after today).
  for (const e of sortedDated) {
    const s = ymdToLocalMs(e.startDate);
    if (s !== null && s > today) return e.id;
  }
  // 3. everything is past → the most recent (last in chronological order).
  return sortedDated[sortedDated.length - 1].id;
}

/**
 * The per-card relative countdown, phrased off the precomputed day deltas (locale-stable: the deltas
 * are computed server-side off a midnight baseline, so server and client agree on the NUMBER). The
 * `accent` flag tells the card to tint the chip orange for "now / imminent".
 */
export function countdownLabel(
  e: DashTimelineEvent
): { label: string; accent: boolean } | null {
  if (e.daysToStart === null || e.daysToEnd === null) return null;
  const ds = e.daysToStart;
  const de = e.daysToEnd;
  if (ds <= 0 && de >= 0) return { label: 'TODAY', accent: true }; // running now
  if (ds > 0) {
    if (ds === 1) return { label: 'IN 1 DAY', accent: true };
    return { label: `IN ${ds} DAYS`, accent: ds <= 7 };
  }
  const ago = Math.abs(de);
  if (ago === 0) return { label: 'TODAY', accent: true };
  if (ago === 1) return { label: '1 DAY AGO', accent: false };
  return { label: `${ago} DAYS AGO`, accent: false };
}

/** Compact ISO range for the table date column, e.g. "Mar 3 – Mar 6". Safe parse, no UTC shift. */
export function shortRange(start: string, end: string): string {
  const s = monthYear(start);
  const sMs = ymdToLocalMs(start);
  if (!s || sMs === null) return 'No date';
  const sd = new Date(sMs);
  const startLabel = `${cap(s.month)} ${sd.getDate()}`;
  if (!end || end === start) return startLabel;
  const eMs = ymdToLocalMs(end);
  const e = monthYear(end);
  if (eMs === null || !e) return startLabel;
  const ed = new Date(eMs);
  // Same month → "Mar 3 – 6"; cross-month → "Mar 30 – Apr 2".
  const endLabel = s.month === e.month && s.year === e.year
    ? `${ed.getDate()}`
    : `${cap(e.month)} ${ed.getDate()}`;
  return `${startLabel} – ${endLabel}`;
}

function cap(month: string): string {
  return month.charAt(0) + month.slice(1).toLowerCase();
}
