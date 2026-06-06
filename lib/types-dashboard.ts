// Client-safe dashboard types. Kept OUT of lib/data.ts (which is 'server-only', so importing
// its types into a Client Component would pull in the Mongo driver). lib/data.ts re-exports
// DashEvent from here, so the projection shape lives in exactly one place.

export interface DashEvent {
  id: string;
  name: string;
  state: string;
  startDate: string; // '' when undated
  endDate: string;
  city: string;
  lead: string;
  venueName: string;
  tags: string[];
}

// A tag/flair primitive — the client-safe projection of a `tags` collection doc the shared
// <TagChip> renders (label + optional flair glyph + color tint). Mirrors the existing app's tag
// shape (index.html tagStore ~L9290): a flag/emoji flair travels denormalized on `customEmoji`,
// the `color` tints the chip, `hidden` tags never surface as a primary. The full doc has more
// fields; the chip only needs these.
export interface DashTag {
  id: string;
  label: string;
  /** The flair emoji/flag glyph (denormalized onto customEmoji so it travels with the tag). '' = none. */
  flair: string;
  /** Hex color used to tint the chip background/border (e.g. '#FD5000'). null/'' = default surface. */
  color: string | null;
}

// ── Re-cast Archetype-A dashboard shapes (client-safe — computed in lib/dashboard-metrics.ts) ──
// The timeline event extends DashEvent with the cross-join-derived progress + countdown the rich
// timeline cards render. All numbers are computed SERVER-SIDE (off the live event→case→inventory
// join) so the client never re-derives them — it just renders. Kept here (not in dashboard-metrics,
// which is 'server-only') so the client timeline/hero components can import the type.
export interface DashTimelineEvent extends DashEvent {
  /** Packed units across this event's cases (buildCaseManifest scanned). */
  scanned: number;
  /** Total units across this event's cases (buildCaseManifest total). */
  total: number;
  /** True iff the event has any flagged inventory in its cases. */
  flagged: boolean;
  /** Whole days from midnight-today to the event start. Negative = started/past. null = undated. */
  daysToStart: number | null;
  /** Whole days from midnight-today to the (inclusive) event end. null = undated. */
  daysToEnd: number | null;
  /**
   * The event's effective PRIMARY tag (the explicit primaryTagId if it still points at a visible
   * tag, else the first visible applied tag alphabetically — index.html effectivePrimaryTagId
   * ~L2935). null when the event has no visible tags. The shared <TagChip> renders it as "Flair:".
   */
  primaryTag: DashTag | null;
  /**
   * Per-event forecast for the event's START day, keyed off the venue lat/lng. null until/unless
   * the weather provider is wired (see lib/weather.ts — Google Weather API, KEYED). The shape is
   * the WeatherChip contract so the chip renders identically once a key lands.
   */
  weather: WeatherForecastDay | null;
}

// A single day's forecast — the <WeatherChip> data contract. Mirrors the existing app's per-day
// forecast object (index.html eitParseForecastResponse ~L2020): a condition emoji + label and the
// feels-like temperature in BOTH scales (the chip honors the user's unit pref, defaulting °F).
export interface WeatherForecastDay {
  /** Condition emoji (☀️ ⛅ 🌧️ …). '' when the provider returns an unknown/unspecified type. */
  emoji: string;
  /** Human condition label for the tooltip (e.g. "partly cloudy"). */
  label: string;
  /** Feels-like temperature, Fahrenheit (rounded). null when the provider omits it. */
  feelsLikeF: number | null;
  /** Feels-like temperature, Celsius (rounded). null when the provider omits it. */
  feelsLikeC: number | null;
}

// One row of the EventDetail per-day venue-forecast strip (#67). Client-safe (lives here, not in
// the 'server-only' lib/weather) so the client OverviewPanel can import the type. status: 'data' = a
// forecast is in the window; 'beyond' = past the 10-day horizon; 'past' = already happened;
// 'pending' = no data yet. The label is a deterministic, locale-independent string built server-side.
export interface EventForecastRow {
  ymd: string;
  label: string;
  w: WeatherForecastDay | null;
  status: 'data' | 'beyond' | 'past' | 'pending';
}

// The season-at-a-glance KPI numbers (the editorial hero + the 3-up KPI strip).
export interface DashKpis {
  /** Events currently in an in-motion state. */
  activeShowcases: number;
  /** Distinct cases held by an in-motion event (the "across N road cases" sub-note). */
  activeCaseCount: number;
  /** Sum of unit qty bound to active-event cases — the headline "ITEMS IN MOTION". */
  itemsInMotion: number;
  /** Qty-weighted in-motion open flags (the KPI number). */
  openFlags: number;
  /** Distinct events carrying ≥1 flagged inventory row (the sub-note + sidebar filter count). */
  flaggedEventCount: number;
  /** Events whose startDate falls in the current calendar year. */
  eventsThisYear: number;
  /**
   * The per-active-state breakdown sub-note for the "Active showcases" KPI, e.g.
   * "2 packing · 1 on site · 3 returning". Seeds EVERY active state, joins the non-zero parts,
   * "no active events" when empty. Sums to activeShowcases. (index.html subActive ~L15519.)
   */
  subActive: string;
}

// The sidebar filter badge counts (Overview / Drafts / Active / Upcoming / Past / Open-flags).
export interface DashFilterCounts {
  overview: number;
  drafts: number;
  active: number;
  upcoming: number;
  past: number;
  flags: number;
}

// The whole payload the Dashboard page hands its client island.
export interface DashboardData {
  events: DashTimelineEvent[];
  counts: DashFilterCounts;
  kpis: DashKpis;
  year: number;
}
