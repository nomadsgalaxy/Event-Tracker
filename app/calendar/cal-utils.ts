// Pure, isomorphic calendar helpers — month-grid math + the per-day event projection. No
// 'server-only': the RSC page hands the client the raw DashEvent list, and the client grid uses
// these to lay out the month. Keeping the math here (not in the component) means it's testable and
// the same logic drives both the server-rendered initial month and client-side month navigation.
//
// All date handling is done on the ISO 'YYYY-MM-DD' string parts (the event payload's startDate /
// endDate are ISO date strings), NOT on Date objects parsed from those strings — a bare
// `new Date('2026-06-04')` is UTC-midnight and shifts a day in negative-offset timezones, which
// would land an event on the wrong cell. We build Date objects from explicit (y, m, d) integers
// (always LOCAL midnight) and compare by the integer day-key, so server and client agree regardless
// of timezone (no hydration drift) and a single-day event never bleeds into the neighbouring cell.

import type { DashEvent, DashTag, WeatherForecastDay } from '@/lib/types/types-dashboard';

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** Single-letter weekday headers — the mini-month grids in the Year view (matches CAL_DOW_S). */
export const CAL_DOW_S = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
/** Three-letter month abbreviations — the mini-month headers + schedule date rail (matches the
 *  existing app's CAL_M_SHORT). */
export const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** The three calendar views, in the existing app's order. */
export const CAL_VIEWS = ['year', 'month', 'week'] as const;
export type CalView = (typeof CAL_VIEWS)[number];

/** Narrow an arbitrary ?view= value to a CalView, falling back to null (caller defaults). */
export function parseView(v: string | null | undefined): CalView | null {
  return v && (CAL_VIEWS as readonly string[]).includes(v) ? (v as CalView) : null;
}

/** The states that count as "active / in-motion" — drives the sidebar Quick-jump list (mirrors the
 *  existing app's quick-jump filter). */
export const ACTIVE_STATES = [
  'packing', 'ready', 'in_transit', 'onsite', 'returning', 'unpacking',
] as const;

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** A month identity: 'YYYY-MM' (1-based month). The URL ?month= value + local state key. */
export function monthKey(year: number, month0: number): string {
  return `${year}-${pad2(month0 + 1)}`;
}

/** Parse a 'YYYY-MM' key to { year, month0 }. Returns null on anything malformed (fail to caller's
 *  fallback, never throw) — month is 1..12 in the string, 0..11 in the result. */
export function parseMonthKey(key: string | null | undefined): { year: number; month0: number } | null {
  if (!key) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month1 = Number(m[2]);
  if (!Number.isInteger(year) || month1 < 1 || month1 > 12) return null;
  return { year, month0: month1 - 1 };
}

/** Step a (year, month0) by ±N months, normalising the year rollover. */
export function addMonths(year: number, month0: number, delta: number): { year: number; month0: number } {
  const total = year * 12 + month0 + delta;
  return { year: Math.floor(total / 12), month0: ((total % 12) + 12) % 12 };
}

/** The ISO day-key for a LOCAL (y, m0, d). Comparable lexicographically === chronologically. */
export function dayKey(year: number, month0: number, day: number): string {
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}

/** Today's local day-key — computed fresh so "today" is correct on the client after hydration. */
export function todayKey(now: Date = new Date()): string {
  return dayKey(now.getFullYear(), now.getMonth(), now.getDate());
}

/** A staffer's onsite/travel range — the per-staffer dates that drive the ✈ travel-ribbon in the
 *  Week-view day header (index.html staffOnsiteRange ~L22664). New schema = onsiteStart/onsiteEnd
 *  (datetime-local); legacy = a travelDays[] array (min/max seed the range). */
export interface CalStaffer {
  name: string;
  email: string;
  onsiteStart?: string;
  onsiteEnd?: string;
  travelDays?: string[];
  /** Worst flight status across this staffer's legs — only set for PII-authorized viewers (manager+).
   *  Drives the travel ribbon's delay/cancel marker. Absent = on time / no flight / not authorized. */
  flightAlert?: 'delayed' | 'cancelled';
}

/** The shipping leg the calendar reads for pickup/return markers (index.html buildSegmentIndex). */
export interface CalShipLeg {
  pickupDate?: string;
  arrivalDate?: string;
}

/** A datetime-local setup/teardown window (index.html CalWeek dtSegs / segmentsTouchingDay). */
export interface CalWindow {
  start?: string;
  end?: string;
}

/** The RICH server projection the Calendar consumes — a DashEvent PLUS the logistics + tag + venue
 *  fields the Year/Month/Week views render (segments, travel ribbon, hour blocks, weather, chips).
 *  Built server-side in lib/calendar-data.ts (the Python's useEnrichedEvents + displayShow). */
/** Per-day hour overrides ('HH:MM'): open/close = attendee doors (fall back to doorsOpen/Close);
 *  exOpen/exClose = exhibitor access (explicit only). Keyed by 'YYYY-MM-DD' on the event. */
export interface CalDayHours {
  open?: string;
  close?: string;
  exOpen?: string;
  exClose?: string;
}

export interface CalEventInput extends DashEvent {
  doorsOpen?: string;
  doorsClose?: string;
  hours?: Record<string, CalDayHours>;
  setup?: CalWindow;
  teardown?: CalWindow;
  outbound?: CalShipLeg;
  return?: CalShipLeg;
  staff?: CalStaffer[];
  /** Applied VISIBLE tag ids (resolved against the tag list the page also passes). */
  tagIds?: string[];
  /** Per-day forecast for this event's venue, keyed 'YYYY-MM-DD'. {} until the weather key lands. */
  weather?: Record<string, WeatherForecastDay>;
}

export interface CalEvent {
  id: string;
  name: string;
  state: string;
  /** ISO 'YYYY-MM-DD' or '' when undated. */
  start: string;
  /** ISO 'YYYY-MM-DD'; defaults to `start` for a single-day event; '' when undated. */
  end: string;
  city: string;
  lead: string;
  // ── Logistics / chrome the rich views render (all optional — a lean event simply omits them) ──
  doorsOpen: string;
  doorsClose: string;
  /** Per-day hour overrides keyed 'YYYY-MM-DD' ({} when none). */
  hours: Record<string, CalDayHours>;
  setup: CalWindow | null;
  teardown: CalWindow | null;
  outbound: CalShipLeg | null;
  return: CalShipLeg | null;
  staff: CalStaffer[];
  /** Applied visible tag ids (for the chip lookups). */
  tagIds: string[];
  /** Per-day forecast keyed 'YYYY-MM-DD' ({} until the weather provider is wired). */
  weather: Record<string, WeatherForecastDay>;
}

/** Normalise a (rich or lean) event into the calendar's CalEvent shape. An event with an endDate
 *  before its startDate is clamped (end := start) so a data glitch can't produce a negative span.
 *  Accepts the lean DashEvent (logistics fields default empty) OR the rich CalEventInput. */
export function toCalEvent(e: DashEvent | CalEventInput): CalEvent {
  const start = e.startDate || '';
  let end = e.endDate || start;
  if (start && end && end < start) end = start;
  const rich = e as Partial<CalEventInput>;
  return {
    id: e.id,
    name: e.name,
    state: e.state,
    start,
    end,
    city: e.city,
    lead: e.lead || '',
    doorsOpen: rich.doorsOpen || '',
    doorsClose: rich.doorsClose || '',
    hours: rich.hours && typeof rich.hours === 'object' ? rich.hours : {},
    setup: rich.setup ?? null,
    teardown: rich.teardown ?? null,
    outbound: rich.outbound ?? null,
    return: rich.return ?? null,
    staff: Array.isArray(rich.staff) ? rich.staff : [],
    tagIds: Array.isArray(rich.tagIds) ? rich.tagIds : [],
    weather: rich.weather && typeof rich.weather === 'object' ? rich.weather : {},
  };
}

/** Resolve an event's applied VISIBLE tags to DashTag objects (in tagIds order), via a tag lookup.
 *  Mirrors the Python `(ev.tagIds||[]).map(id => allTags.find(...)).filter(t => t && !t.hidden)` —
 *  hidden/deleted tags are already absent from `tagById`. Used by the Year/Month/Week tag chips. */
export function eventTags(ev: CalEvent, tagById: Map<string, DashTag>): DashTag[] {
  return ev.tagIds
    .map((id) => tagById.get(id))
    .filter((t): t is DashTag => !!t);
}

export interface DayCell {
  /** null = a leading/trailing pad cell from the adjacent month (renders dimmed, no number). */
  day: number | null;
  key: string; // the ISO day-key, '' for pad cells
  inMonth: boolean;
  isToday: boolean;
  /** Events whose [start..end] span covers this day, sorted multi-day-first then by name so the
   *  longer bars sit on top and the list reads stably. */
  events: CalEvent[];
}

export interface MonthGrid {
  year: number;
  month0: number;
  label: string; // e.g. 'June 2026'
  /** 6 weeks × 7 days = 42 cells, always — a stable grid that never reflows between months. */
  cells: DayCell[];
  /** Events that fall (any day) within this month, for the count summary. */
  monthEventCount: number;
}

/**
 * Build the 6×7 month grid for (year, month0), placing each event on every day its span covers.
 * Events are matched by ISO day-key string comparison (timezone-safe). The grid is always 42 cells
 * (6 weeks) so navigating months never changes the grid height.
 */
export function buildMonthGrid(
  year: number,
  month0: number,
  events: CalEvent[],
  today: string = todayKey(),
): MonthGrid {
  const firstDow = new Date(year, month0, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();

  // Only consider dated events; an undated event is surfaced separately (the 'no date' list).
  const dated = events.filter((e) => e.start);

  const cells: DayCell[] = [];
  for (let i = 0; i < 42; i++) {
    const dayNum = i - firstDow + 1; // 1-based day within this month; <1 or >daysInMonth = pad
    const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
    if (!inMonth) {
      cells.push({ day: null, key: '', inMonth: false, isToday: false, events: [] });
      continue;
    }
    const key = dayKey(year, month0, dayNum);
    const dayEvents = dated
      .filter((e) => key >= e.start && key <= (e.end || e.start))
      .sort((a, b) => {
        const aSpan = spanDays(a);
        const bSpan = spanDays(b);
        if (aSpan !== bSpan) return bSpan - aSpan; // longer (multi-day) first
        return a.name.localeCompare(b.name);
      });
    cells.push({ day: dayNum, key, inMonth: true, isToday: key === today, events: dayEvents });
  }

  // Month event count: any event whose span intersects [firstDay..lastDay] of this month.
  const firstKey = dayKey(year, month0, 1);
  const lastKey = dayKey(year, month0, daysInMonth);
  const monthEventCount = dated.filter(
    (e) => e.start <= lastKey && (e.end || e.start) >= firstKey,
  ).length;

  return {
    year,
    month0,
    label: `${MONTHS[month0]} ${year}`,
    cells,
    monthEventCount,
  };
}

/** Whole-day span of an event (inclusive); 1 for a single/undated day. */
export function spanDays(e: CalEvent): number {
  if (!e.start) return 1;
  const end = e.end || e.start;
  // Parse the ISO parts into a UTC timestamp difference — both ends are pure dates, so UTC math
  // gives an exact whole-day count with no DST edge cases.
  const a = Date.parse(`${e.start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

/** The undated events (no startDate), sorted by name — surfaced in their own list so they're never
 *  silently dropped (mirrors the dashboard's undated tail). */
export function undatedEvents(events: CalEvent[]): CalEvent[] {
  return events.filter((e) => !e.start).sort((a, b) => a.name.localeCompare(b.name));
}

/** Active / in-motion events for the sidebar Quick-jump list — sorted by start date (undated last),
 *  capped to `limit`. State match is timezone-safe (no Date parsing). */
export function activeEvents(events: CalEvent[], limit = 8): CalEvent[] {
  const states = ACTIVE_STATES as readonly string[];
  return events
    .filter((e) => states.includes(e.state))
    .sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999') || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// ── YEAR view ─────────────────────────────────────────────────────────────────────────────────
// A grid of 12 mini-month calendars. Each mini-month is the same 42-cell math as the main grid but
// rendered tiny: a day number tinted/dotted in the first covering event's --st-<state> colour.

export interface MiniDay {
  /** null = a leading/trailing pad cell (renders blank). */
  day: number | null;
  isToday: boolean;
  /** The first covering event's state (drives the dot + tint colour); '' when no event. */
  state: string;
  /** How many events cover this day (for the title/aria). */
  count: number;
  /** All covering events' names (joined for the cell title). */
  names: string[];
  /** This day's month index 0..11 (so a click can jump to the right week). */
  month0: number;
  /** This day's day-of-month (for the week jump). */
  dayNum: number;
}

export interface MiniMonth {
  month0: number;
  label: string; // 'JAN'
  /** 42 cells (6 weeks). */
  cells: MiniDay[];
  /** Events intersecting this month (for an optional count). */
  eventCount: number;
}

/** Build the 12 mini-months for `year`. An event is placed on every day its span covers (same ISO
 *  day-key matching as the main grid). `today` is the current local day-key for the highlight. */
export function buildYearGrid(
  year: number,
  events: CalEvent[],
  today: string = todayKey(),
): MiniMonth[] {
  const dated = events.filter((e) => e.start);
  return MONTHS.map((_, month0) => {
    const firstDow = new Date(year, month0, 1).getDay();
    const daysInMonth = new Date(year, month0 + 1, 0).getDate();
    const cells: MiniDay[] = [];
    for (let i = 0; i < 42; i++) {
      const dayNum = i - firstDow + 1;
      if (dayNum < 1 || dayNum > daysInMonth) {
        cells.push({ day: null, isToday: false, state: '', count: 0, names: [], month0, dayNum: 1 });
        continue;
      }
      const key = dayKey(year, month0, dayNum);
      const covering = dated
        .filter((e) => key >= e.start && key <= (e.end || e.start))
        .sort((a, b) => {
          const aS = spanDays(a);
          const bS = spanDays(b);
          if (aS !== bS) return bS - aS;
          return a.name.localeCompare(b.name);
        });
      cells.push({
        day: dayNum,
        isToday: key === today,
        state: covering[0]?.state ?? '',
        count: covering.length,
        names: covering.map((e) => e.name || 'Untitled event'),
        month0,
        dayNum,
      });
    }
    const firstKey = dayKey(year, month0, 1);
    const lastKey = dayKey(year, month0, daysInMonth);
    const eventCount = dated.filter(
      (e) => e.start <= lastKey && (e.end || e.start) >= firstKey,
    ).length;
    return { month0, label: MONTHS_SHORT[month0].toUpperCase(), cells, eventCount };
  });
}

/** Events that touch `year` (their span intersects Jan 1 .. Dec 31), sorted by start date — the
 *  right-side "<year> SCHEDULE" panel. Undated events are excluded (they have no place on a year
 *  axis; the dashboard's undated tail covers them). */
export function yearScheduleEvents(year: number, events: CalEvent[]): CalEvent[] {
  const lo = `${year}-01-01`;
  const hi = `${year}-12-31`;
  return events
    .filter((e) => e.start && e.start <= hi && (e.end || e.start) >= lo)
    .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
}

// ── WEEK view ─────────────────────────────────────────────────────────────────────────────────
// A simple 7-day strip (Sun..Sat) of the week containing a cursor day. Each day lists the events
// covering it. All math on (y, m0, d) integers — never `new Date('YYYY-MM-DD')`.

/** The Sunday that starts the week containing local (year, month0, day). Returns {year, month0, day}
 *  integers (never a Date built from a string). */
export function startOfWeek(year: number, month0: number, day: number): { year: number; month0: number; day: number } {
  const d = new Date(year, month0, day);
  d.setDate(d.getDate() - d.getDay()); // back up to Sunday (local)
  return { year: d.getFullYear(), month0: d.getMonth(), day: d.getDate() };
}

/** Step a (year, month0, day) by ±N whole days, normalising month/year rollover via local Date math
 *  (DST-safe for whole-day steps). */
export function addDaysYmd(year: number, month0: number, day: number, delta: number): { year: number; month0: number; day: number } {
  const d = new Date(year, month0, day + delta);
  return { year: d.getFullYear(), month0: d.getMonth(), day: d.getDate() };
}

export interface WeekDay {
  year: number;
  month0: number;
  day: number;
  key: string; // ISO day-key
  weekday: string; // 'Sun'
  isToday: boolean;
  events: CalEvent[];
}

export interface WeekGrid {
  /** The 7 day columns, Sun..Sat. */
  days: WeekDay[];
  /** Human range label, e.g. 'Jun 1 – 7, 2026' or 'May 31 – Jun 6, 2026'. */
  label: string;
}

/**
 * Build the Week view's day strip. With `snap` (default), the window starts at the Sunday of
 * (year, month0, day) and renders a full 7-day Sun..Sat week — the desktop default. With `snap=false`
 * the window starts AT (year, month0, day) and renders `dayCount` days from there, NOT re-snapped to
 * Sunday — mirroring the Python's CalWeek, where the desktop enters the week on a Sunday but the
 * ‹/› day-nav slides the (responsive 3/5-col) window day-by-day through any date (navWeekDays ±1).
 * Events are placed on every day their span covers (ISO day-key matching). The label + weekday
 * headers reflect the ACTUAL visible window.
 */
export function buildWeekGrid(
  year: number,
  month0: number,
  day: number,
  events: CalEvent[],
  today: string = todayKey(),
  dayCount = 7,
  snap = true,
): WeekGrid {
  const start = snap ? startOfWeek(year, month0, day) : { year, month0, day };
  const n = snap ? 7 : Math.max(1, dayCount);
  const dated = events.filter((e) => e.start);
  const days: WeekDay[] = [];
  for (let i = 0; i < n; i++) {
    const d = addDaysYmd(start.year, start.month0, start.day, i);
    const key = dayKey(d.year, d.month0, d.day);
    // Weekday label from the actual calendar weekday (a non-Sunday start shifts the headers).
    const dow = new Date(d.year, d.month0, d.day).getDay();
    const dayEvents = dated
      .filter((e) => key >= e.start && key <= (e.end || e.start))
      .sort((a, b) => {
        const aS = spanDays(a);
        const bS = spanDays(b);
        if (aS !== bS) return bS - aS;
        return a.name.localeCompare(b.name);
      });
    days.push({
      ...d,
      key,
      weekday: WEEKDAYS[dow],
      isToday: key === today,
      events: dayEvents,
    });
  }
  const first = days[0];
  const last = days[days.length - 1];
  const fm = MONTHS_SHORT[first.month0];
  const tm = MONTHS_SHORT[last.month0];
  const label =
    first.month0 === last.month0
      ? `${fm} ${first.day} – ${last.day}, ${last.year}`
      : `${fm} ${first.day} – ${tm} ${last.day}, ${last.year}`;
  return { days, label };
}

// ── MONTH-VIEW BARS (multi-day, lane-packed, week-broken) ───────────────────────────────────────
// Each event's slice that falls into this month, broken across week-rows when it crosses a Saturday,
// then packed into non-overlapping lanes per row. Verbatim port of index.html CalMonth bar math
// (~L23011 build + ~L23044 lane-packing). Integer-tuple date math only.

export interface MonthBar {
  ev: CalEvent;
  /** 0..5 week row. */
  row: number;
  /** 0..6 column within the row (Sun=0). */
  col: number;
  /** Number of day-columns this bar spans within its row (1..7). */
  span: number;
  /** The lane index within the row (0 = top), assigned by the packer. */
  lane: number;
}

export interface MonthBarRow {
  /** The bars in this week row, lane-packed. */
  bars: MonthBar[];
  /** How many lanes this row needs (drives the row height). */
  laneCount: number;
}

/**
 * Build the lane-packed event bars for every week row of (year, month0). Returns 6 rows (one per
 * week of the 42-cell grid). A multi-day event is sliced to the month, then split at each week
 * boundary; within a row, each bar takes the lowest lane that doesn't horizontally overlap an
 * already-placed bar (the Python's greedy packer). Undated events are excluded (no place on a grid).
 */
export function buildMonthBars(
  year: number,
  month0: number,
  events: CalEvent[],
): MonthBarRow[] {
  const firstDow = new Date(year, month0, 1).getDay();
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const monthFirstKey = dayKey(year, month0, 1);
  const monthLastKey = dayKey(year, month0, daysInMonth);

  // Events whose span intersects this month.
  const monthEvents = events.filter(
    (e) => e.start && e.start <= monthLastKey && (e.end || e.start) >= monthFirstKey,
  );

  // Raw bars (pre-lane), one entry per (event, week-row slice).
  const rawBars: Omit<MonthBar, 'lane'>[] = [];
  for (const ev of monthEvents) {
    // Slice the event to the month's day range [1..daysInMonth].
    const startDay = ev.start <= monthFirstKey ? 1 : Number(ev.start.slice(8, 10));
    const evEnd = ev.end || ev.start;
    const endDay = evEnd >= monthLastKey ? daysInMonth : Number(evEnd.slice(8, 10));
    let d = startDay;
    while (d <= endDay) {
      const startCell = firstDow + (d - 1);
      const row = Math.floor(startCell / 7);
      const col = startCell % 7;
      const remainingInRow = 7 - col;
      const remainingInEvent = endDay - d + 1;
      const span = Math.min(remainingInRow, remainingInEvent);
      rawBars.push({ ev, row, col, span });
      d += span;
    }
  }

  // Pack per row.
  const rows: MonthBarRow[] = [];
  for (let row = 0; row < 6; row++) {
    const rowRaw = rawBars
      .filter((b) => b.row === row)
      .slice()
      .sort((a, b) => a.col - b.col || b.span - a.span);
    const lanes: { col: number; span: number }[][] = [];
    const packed: MonthBar[] = rowRaw.map((b) => {
      let lane = 0;
      while (
        lanes[lane] &&
        lanes[lane].some((o) => !(b.col >= o.col + o.span || o.col >= b.col + b.span))
      ) {
        lane++;
      }
      if (!lanes[lane]) lanes[lane] = [];
      lanes[lane].push({ col: b.col, span: b.span });
      return { ...b, lane };
    });
    rows.push({ bars: packed, laneCount: lanes.length });
  }
  return rows;
}

// ── LOGISTICS SEGMENTS (pickup / setup / teardown / return) ─────────────────────────────────────
// An event projects up to four "segments" onto the calendar (index.html SEGMENT_* ~L22719). Each is
// a distinct color so the day reads at a glance: pickup (amber), setup (blue), teardown (violet),
// return/arrival (emerald). The "show" itself is the doors-open→close bar, handled separately.

export type SegmentId = 'pickup' | 'setup' | 'teardown' | 'return';

/** Segment fill/border base colors — verbatim from index.html SEGMENT_COLORS (~L22719). These are
 *  intentional fixed brand-of-logistics hues (not status tokens): the legend is the same in both
 *  stacks, so a pickup is always amber and a return always emerald regardless of event state. */
export const SEGMENT_COLORS: Record<SegmentId, string> = {
  pickup: '#F59E0B', // amber — supply chain leaving
  setup: '#3B82F6', // blue — gearing up
  teardown: '#8B5CF6', // violet — winding down
  return: '#10B981', // emerald — back home safe
};
export const SEGMENT_SHORT: Record<SegmentId, string> = {
  pickup: 'P',
  setup: 'S',
  teardown: 'T',
  return: 'R',
};
export const SEGMENT_LABEL: Record<SegmentId, string> = {
  pickup: 'Pickup',
  setup: 'Setup',
  teardown: 'Teardown',
  return: 'Arrival',
};

export interface CalSegment {
  id: SegmentId;
  event: CalEvent;
}

/** Segments touching a given 'YYYY-MM-DD' across all events — verbatim port of index.html
 *  segmentsTouchingDay (~L22732). pickup/return are single-day markers (the pickup/arrival date);
 *  setup/teardown are datetime-local RANGES (any day inside [startDate..endDate] counts). The return
 *  marker prefers arrivalDate, falling back to the legacy return.pickupDate. */
export function segmentsTouchingDay(events: CalEvent[], dayYmd: string): CalSegment[] {
  const out: CalSegment[] = [];
  for (const ev of events) {
    if (ev.outbound && ev.outbound.pickupDate === dayYmd) {
      out.push({ id: 'pickup', event: ev });
    }
    const setupStart = ev.setup?.start ? ev.setup.start.slice(0, 10) : '';
    const setupEnd = (ev.setup?.end ? ev.setup.end.slice(0, 10) : '') || setupStart;
    if (setupStart && dayYmd >= setupStart && dayYmd <= setupEnd) {
      out.push({ id: 'setup', event: ev });
    }
    const tdStart = ev.teardown?.start ? ev.teardown.start.slice(0, 10) : '';
    const tdEnd = (ev.teardown?.end ? ev.teardown.end.slice(0, 10) : '') || tdStart;
    if (tdStart && dayYmd >= tdStart && dayYmd <= tdEnd) {
      out.push({ id: 'teardown', event: ev });
    }
    // Prefer arrivalDate (new schema); fall back to legacy pickupDate so pre-migration events still
    // show their return marker on the right day.
    const arr = (ev.return && (ev.return.arrivalDate || ev.return.pickupDate)) || '';
    if (arr === dayYmd) {
      out.push({ id: 'return', event: ev });
    }
  }
  return out;
}

/** Build a lookup map: 'YYYY-MM-DD' → segments, across the [from..to] inclusive date range. Mirrors
 *  index.html buildSegmentIndex (~L22759). Walks day-by-day on integer tuples (no Date-from-string).
 *  `from`/`to` are { year, month0, day }. */
export function buildSegmentIndex(
  events: CalEvent[],
  from: { year: number; month0: number; day: number },
  to: { year: number; month0: number; day: number },
): Map<string, CalSegment[]> {
  const map = new Map<string, CalSegment[]>();
  let cur = { year: from.year, month0: from.month0, day: from.day };
  const stopKey = dayKey(to.year, to.month0, to.day);
  // Inclusive walk; guard against an inverted range (≤ ~400 iterations for a year).
  for (let i = 0; i < 400; i++) {
    const key = dayKey(cur.year, cur.month0, cur.day);
    const segs = segmentsTouchingDay(events, key);
    if (segs.length) map.set(key, segs);
    if (key >= stopKey) break;
    cur = addDaysYmd(cur.year, cur.month0, cur.day, 1);
  }
  return map;
}

// ── TRAVEL RIBBON (staff onsite ranges → ✈ initials per day) ────────────────────────────────────

/** A staffer's onsite range as 'YYYY-MM-DD' bounds, or null. New schema = onsiteStart/onsiteEnd;
 *  legacy = travelDays[] (min/max). Verbatim from index.html staffOnsiteRange (~L22664). */
export function staffOnsiteRange(m: CalStaffer): { startY: string; endY: string } | null {
  if (!m) return null;
  if (m.onsiteStart || m.onsiteEnd) {
    return {
      startY: (m.onsiteStart || '').slice(0, 10),
      endY: (m.onsiteEnd || m.onsiteStart || '').slice(0, 10),
    };
  }
  const days = Array.isArray(m.travelDays) ? m.travelDays.filter(Boolean).slice().sort() : [];
  if (!days.length) return null;
  return { startY: days[0], endY: days[days.length - 1] };
}

export interface CalTraveler {
  event: CalEvent;
  staff: CalStaffer;
}

/** Travel-day index: 'YYYY-MM-DD' → [{ event, staff }] for every staffer onsite that day, across
 *  the [from..to] inclusive range. Verbatim from index.html buildTravelIndex (~L22678): walks each
 *  staffer's onsite range, swapping inverted bounds defensively. Integer-tuple date math only. */
export function buildTravelIndex(
  events: CalEvent[],
  from: { year: number; month0: number; day: number },
  to: { year: number; month0: number; day: number },
): Map<string, CalTraveler[]> {
  const map = new Map<string, CalTraveler[]>();
  const fromY = dayKey(from.year, from.month0, from.day);
  const toY = dayKey(to.year, to.month0, to.day);
  for (const ev of events) {
    for (const m of ev.staff) {
      const r = staffOnsiteRange(m);
      if (!r || !r.startY) continue;
      const a = r.startY;
      const b = r.endY && r.endY >= a ? r.endY : a;
      const aParts = a.split('-').map(Number);
      const bParts = b.split('-').map(Number);
      if (aParts.length !== 3 || bParts.length !== 3 || !aParts[0] || !bParts[0]) continue;
      let cur = { year: aParts[0], month0: aParts[1] - 1, day: aParts[2] };
      const stopKey = dayKey(bParts[0], bParts[1] - 1, bParts[2]);
      for (let i = 0; i < 400; i++) {
        const k = dayKey(cur.year, cur.month0, cur.day);
        if (k >= fromY && k <= toY) {
          if (!map.has(k)) map.set(k, []);
          map.get(k)!.push({ event: ev, staff: m });
        }
        if (k >= stopKey) break;
        cur = addDaysYmd(cur.year, cur.month0, cur.day, 1);
      }
    }
  }
  return map;
}

/** Staffer initials for the travel ribbon — up to 2 chars (index.html initialsOf ~L22705). */
export function initialsOf(m: CalStaffer): string {
  const n = (m?.name || m?.email || '?').trim();
  return n
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// ── HOUR-GRID helpers (Week view) ───────────────────────────────────────────────────────────────

/** The Week-view hour-grid bounds (index.html CalWeek HOUR_START/END/HEIGHT ~L23185). 7am–9pm. */
export const HOUR_START = 7;
export const HOUR_END = 21;
export const HOUR_HEIGHT = 26;
export const HOURS: number[] = Array.from(
  { length: HOUR_END - HOUR_START + 1 },
  (_, i) => HOUR_START + i,
);

/** Format an hour-of-day 0..23 as '12 AM' / '5 PM' (index.html fmtHour ~L22597). */
export function fmtHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

/** Parse 'HH:MM' (or 'HH') → decimal hour, falling back when empty (index.html CalWeek parseTime). */
export function parseTime(s: string | undefined | null, fallback: number): number {
  if (!s) return fallback;
  const [h, m] = String(s).split(':').map(Number);
  return (h || 0) + (m || 0) / 60;
}

/** A datetime-bound setup/teardown segment placed in a specific day's hour grid (Week view). The
 *  time-of-day is clamped to this day when the window spans midnight — verbatim from CalWeek dtSegs
 *  (~L23280). Returns the segments to draw as hour blocks on `dayY` ('YYYY-MM-DD'). */
export function dayHourSegments(events: CalEvent[], dayY: string): {
  id: 'setup' | 'teardown';
  event: CalEvent;
  startTime: string;
  endTime: string;
}[] {
  const out: { id: 'setup' | 'teardown'; event: CalEvent; startTime: string; endTime: string }[] = [];
  for (const ev of events) {
    const tryRange = (raw: CalWindow | null, kind: 'setup' | 'teardown') => {
      const s = (raw && raw.start) || '';
      const e = (raw && raw.end) || s;
      if (!s) return;
      const sD = s.slice(0, 10);
      const eD = e.slice(0, 10);
      if (dayY < sD || dayY > eD) return;
      // Clamp time-of-day to this calendar day.
      const sT = dayY === sD ? s.slice(11, 16) || '08:00' : '00:00';
      const eT = dayY === eD ? e.slice(11, 16) || (sT > '08:00' ? sT : '18:00') : '23:59';
      out.push({ id: kind, event: ev, startTime: sT, endTime: eT });
    };
    tryRange(ev.setup, 'setup');
    tryRange(ev.teardown, 'teardown');
  }
  return out;
}

/** The EFFECTIVE hours for one show day: the per-day override when set, else the event-level doors.
 *  Exhibitor times are explicit-only (no fallback). Used by the week view's show blocks + overlays. */
export function effectiveDayHours(
  ev: Pick<CalEvent, 'doorsOpen' | 'doorsClose' | 'hours'>,
  dayY: string
): { open: string; close: string; exOpen: string; exClose: string } {
  const d = ev.hours?.[dayY];
  return {
    open: d?.open || ev.doorsOpen || '',
    close: d?.close || ev.doorsClose || '',
    exOpen: d?.exOpen || '',
    exClose: d?.exClose || '',
  };
}

// ── Column-pack overlapping timed blocks (week view) ────────────────────────────────────────────
// A day column stacks show / setup / teardown blocks by their hour range. When two ranges overlap
// (a teardown that runs into the show hours) they used to paint full-width on top of each other and
// became unreadable. This is the standard interval-graph lane packer: blocks are grouped into
// clusters of transitive overlap, each cluster gets the fewest columns that keep its members from
// overlapping, and every block reports its `col` + the cluster's `cols` so the caller can lay them
// out side-by-side (left = col/cols, width = 1/cols). A block with no overlap gets cols = 1 (full
// width, unchanged). Pure + half-open intervals ([start, end), so touching ranges DON'T overlap).
export interface DayBlockPos {
  col: number;
  cols: number;
}
export function packDayBlocks<T extends { start: number; end: number }>(blocks: T[]): (T & DayBlockPos)[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: (T & DayBlockPos)[] = [];
  let group: (T & { col: number })[] = [];
  let colEnds: number[] = []; // end time of the last block placed in each column of the live cluster
  let groupEnd = -Infinity;
  const flush = () => {
    const cols = colEnds.length || 1;
    for (const g of group) out.push({ ...g, cols });
    group = [];
    colEnds = [];
    groupEnd = -Infinity;
  };
  for (const b of sorted) {
    if (group.length && b.start >= groupEnd) flush(); // disjoint from the running cluster → close it
    let col = colEnds.findIndex((e) => e <= b.start);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(b.end);
    } else {
      colEnds[col] = b.end;
    }
    group.push({ ...b, col });
    groupEnd = Math.max(groupEnd, b.end);
  }
  flush();
  return out;
}

/** First covering event's forecast for `dayY`, scanning events whose show window covers the day in
 *  start-date order (the caller passes events already filtered/sorted). Mirrors the Python's
 *  "first event whose show window covers this day AND has cached weather" (CalWeek/CalMonth). */
export function dayWeather(events: CalEvent[], dayY: string): WeatherForecastDay | null {
  for (const ev of events) {
    if (!ev.start) continue;
    if (dayY < ev.start || dayY > (ev.end || ev.start)) continue;
    const w = ev.weather[dayY];
    if (w) return w;
  }
  return null;
}
