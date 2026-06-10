// lib/integrations/ics.ts — a small, dependency-free iCalendar (RFC 5545) EVENT parser for the
// "Import .ics" flow. Pure + isomorphic (no server-only): the client uses it to PREVIEW a picked
// file before upload, and the Server Action re-parses the same text server-side (never trust the
// client's parse).
//
// Scope: VEVENT extraction only — SUMMARY, DTSTART/DTEND (DATE and DATE-TIME forms), LOCATION,
// DESCRIPTION, URL, GEO, UID, STATUS. Recurrence (RRULE) is NOT expanded — a recurring event
// imports as its first occurrence.
//
// DATE SEMANTICS (what the app stores): events carry startDate/endDate as inclusive 'YYYY-MM-DD'
// show days; door TIMES are operator-set and deliberately NOT imported. Two wrinkles handled:
//   • An all-day DTEND (VALUE=DATE) is EXCLUSIVE per RFC → minus one day for the inclusive end.
//   • A UTC timestamp (...Z) can land on the wrong LOCAL date (an evening end in California is
//     the small hours UTC of the next day). With a GEO coordinate we estimate the venue's offset
//     from its longitude (≈ lng/15 hours — solar time, within ~1h of civil time almost everywhere)
//     before extracting the date. Without GEO, the UTC date is used as-is.

export interface IcsEvent {
  uid: string;
  summary: string;
  /** Inclusive show days, 'YYYY-MM-DD' ('' when the file had no parseable date). */
  startDate: string;
  endDate: string;
  /** The published wall-clock times (display/preview only — door times are not imported). */
  startTime: string;
  endTime: string;
  allDay: boolean;
  location: string;
  description: string;
  url: string;
  lat: number | null;
  lng: number | null;
  status: string;
}

export interface IcsVenueGuess {
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}

// ── line handling ─────────────────────────────────────────────────────────────────────────────
/** RFC 5545 §3.1 unfolding: a line starting with SPACE/HTAB continues the previous line. */
function unfold(text: string): string[] {
  const raw = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      out.push(line);
    }
  }
  return out;
}

/** RFC 5545 §3.3.11 TEXT unescaping: \\n -> newline, \\, \\; \\\\ literal. */
function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Split 'NAME;PARAM=V;PARAM2=V2:value' (the ':' inside a quoted param is honored). */
function parseProp(line: string): Prop | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs = head.split(';');
  const name = (segs[0] || '').trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq > 0) params[seg.slice(0, eq).trim().toUpperCase()] = seg.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

// ── date handling ─────────────────────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');

/** Resolve a DTSTART/DTEND value to { date:'YYYY-MM-DD', time:'HH:MM', allDay, utc }. */
function parseIcsDate(
  prop: Prop,
  lng: number | null
): { date: string; time: string; allDay: boolean } | null {
  const v = prop.value.trim();
  const isDateOnly = prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v);
  if (isDateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (!m) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: '', allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d, hh, mm] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (m[7] === 'Z') {
    // UTC: shift toward the venue's local wall clock when we have a longitude (solar estimate),
    // so the DATE comes out right; the displayed time keeps an explicit UTC marker otherwise.
    const offsetH = lng != null && Number.isFinite(lng) ? Math.round(lng / 15) : 0;
    const t = Date.UTC(y, mo - 1, d, hh, mm) + offsetH * 3600_000;
    const dt = new Date(t);
    return {
      date: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`,
      time: `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}${offsetH === 0 ? ' UTC' : ''}`,
      allDay: false,
    };
  }
  // Floating / TZID-local: take the wall clock literally (no tz database here).
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, allDay: false };
}

/** 'YYYY-MM-DD' minus one day (for the RFC-exclusive all-day DTEND). */
function minusOneDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// ── the parser ────────────────────────────────────────────────────────────────────────────────
export function parseIcs(text: string): IcsEvent[] {
  const lines = unfold(String(text ?? ''));
  const events: IcsEvent[] = [];
  let cur: Record<string, Prop> | null = null;

  for (const line of lines) {
    const up = line.trim().toUpperCase();
    if (up === 'BEGIN:VEVENT') {
      cur = {};
      continue;
    }
    if (up === 'END:VEVENT') {
      if (cur) {
        const ev = buildEvent(cur);
        if (ev) events.push(ev);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const prop = parseProp(line);
    // First instance wins (a well-formed VEVENT has one of each; RRULE overrides aren't expanded).
    if (prop && !(prop.name in cur)) cur[prop.name] = prop;
  }
  return events;
}

function buildEvent(props: Record<string, Prop>): IcsEvent | null {
  const text = (n: string) => (props[n] ? unescapeText(props[n].value).trim() : '');

  // GEO first — the longitude feeds the UTC→local date estimate.
  let lat: number | null = null;
  let lng: number | null = null;
  const geo = props.GEO?.value?.split(/[;,]/) ?? [];
  if (geo.length === 2) {
    const [a, b] = [Number(geo[0]), Number(geo[1])];
    if (Number.isFinite(a) && Number.isFinite(b)) {
      lat = a;
      lng = b;
    }
  }

  const start = props.DTSTART ? parseIcsDate(props.DTSTART, lng) : null;
  const endRaw = props.DTEND ? parseIcsDate(props.DTEND, lng) : null;

  let endDate = endRaw?.date ?? '';
  if (endRaw?.allDay && endDate) endDate = minusOneDay(endDate); // RFC: all-day DTEND is exclusive
  if (start?.date && endDate && endDate < start.date) endDate = start.date; // never end before start

  const summary = text('SUMMARY');
  if (!summary && !start) return null; // an empty shell isn't importable

  return {
    uid: text('UID'),
    summary,
    startDate: start?.date ?? '',
    endDate: endDate || (start?.date ?? ''),
    startTime: start?.time ?? '',
    endTime: endRaw?.time ?? '',
    allDay: start?.allDay ?? false,
    location: text('LOCATION'),
    description: text('DESCRIPTION'),
    url: text('URL'),
    lat,
    lng,
    status: text('STATUS'),
  };
}

// ── venue heuristic ───────────────────────────────────────────────────────────────────────────
/** Split a LOCATION string ("Venue, 1 Street Rd, City, ST 12345, Country") into venue fields.
 *  Best-effort: the first segment is the venue name; a "ST 12345" segment anchors state/zip with
 *  the city just before it; everything between name and city is the street address. */
export function icsLocationToVenue(location: string): IcsVenueGuess {
  const parts = String(location ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: IcsVenueGuess = { name: parts[0] ?? '', address: '', city: '', state: '', zip: '' };
  if (parts.length <= 1) return out;

  let stateIdx = -1;
  for (let i = 1; i < parts.length; i++) {
    const m = /^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(parts[i]);
    if (m) {
      stateIdx = i;
      out.state = m[1];
      out.zip = m[2];
      break;
    }
  }
  if (stateIdx > 1) {
    out.city = parts[stateIdx - 1] ?? '';
    out.address = parts.slice(1, Math.max(1, stateIdx - 1)).join(', ');
  } else {
    // No US-style anchor — keep the remainder as the address, last segment as a city guess.
    out.address = parts.slice(1, -1).join(', ') || parts.slice(1).join(', ');
    if (parts.length >= 3) out.city = parts[parts.length - 2] ?? '';
  }
  return out;
}
