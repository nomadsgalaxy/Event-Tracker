import 'server-only';
import crypto from 'node:crypto';
import { getDb } from '@/lib/db/mongo';
import type { EventDoc, EventPayload, Staffer, TravelInfo, TravelLeg, HotelInfo } from '@/lib/types/types';

// lib/integrations/ical.ts — RFC 5545 .ics generation for the subscription feed (faithful to eit_calendar.gen_ics).
//   • PERSONAL scope: events the owner is staffed on (by email) + their OWN travel/hotel.
//   • GLOBAL scope: every event's show + setup/teardown windows (no per-person PII).
// Pure string building; the only I/O is loading non-deleted events.

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n');
}

function nowUtc(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '').replace(/Z$/, 'Z');
}

const digits = (s: unknown): string => String(s ?? '').replace(/\D/g, '');

function dateCompact(s: unknown): string | null {
  if (!s) return null;
  const head = String(s).split('T')[0];
  const d = digits(head);
  return d.length >= 8 ? d.slice(0, 8) : null;
}

function dtCompact(s: unknown): string | null {
  if (!s || !String(s).includes('T')) return null;
  const [datePart, timePart] = String(s).split('T', 2);
  const dd = digits(datePart);
  const tt = digits(timePart.replace('Z', ''));
  if (dd.length < 8 || tt.length < 3) return null;
  return dd.slice(0, 8) + 'T' + (tt + '0000').slice(0, 6);
}

function addDay(yyyymmdd: string): string {
  try {
    const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  } catch {
    return yyyymmdd;
  }
}

function fold(line: string): string {
  if (line.length <= 74) return line;
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ' ' + rest.slice(74);
  }
  out.push(rest);
  return out.join('\r\n');
}

const join = (parts: unknown[], sep = ', '): string => parts.filter(Boolean).map(String).join(sep);

function venueLoc(venue: Record<string, unknown> | undefined): string {
  const v = venue ?? {};
  return join([v.name, v.address, v.city, v.state, v.zip]);
}

function veventAllDay(lines: string[], uid: string, summary: string, start: string, end: string, location: string, desc: string) {
  lines.push('BEGIN:VEVENT', `UID:${uid}@eventtracker`, `DTSTAMP:${nowUtc()}`, `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${addDay(end)}`, `SUMMARY:${esc(summary)}`);
  if (location) lines.push(`LOCATION:${esc(location)}`);
  if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
  lines.push('END:VEVENT');
}

function veventTimed(lines: string[], uid: string, summary: string, startDt: string, endDt: string | null, location: string, desc: string) {
  lines.push('BEGIN:VEVENT', `UID:${uid}@eventtracker`, `DTSTAMP:${nowUtc()}`, `DTSTART:${startDt}`);
  if (endDt) lines.push(`DTEND:${endDt}`);
  lines.push(`SUMMARY:${esc(summary)}`);
  if (location) lines.push(`LOCATION:${esc(location)}`);
  if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
  lines.push('END:VEVENT');
}

function travelVevents(lines: string[], eid: string, ename: string, travel: TravelInfo) {
  const mode = travel.mode || 'flight';
  for (const legName of ['outbound', 'return'] as const) {
    const leg = travel[legName] as TravelLeg | undefined;
    if (!leg || typeof leg !== 'object') continue;
    const dep = dtCompact(leg.departAt);
    if (!dep) continue;
    const arr = dtCompact(leg.arriveAt);
    const ident = join([leg.carrier, leg.number], ' ');
    const prefix = mode === 'flight' ? 'Flight ' : `${String(mode).charAt(0).toUpperCase()}${String(mode).slice(1)} `;
    const summ = `${prefix}${ident || legName} — ${ename}`;
    const loc = join([leg.departLocation, leg.arriveLocation], ' -> ');
    const desc = join([leg.confirmation ? `Confirmation ${leg.confirmation}` : null, (leg as Record<string, unknown>).notes], ' | ');
    veventTimed(lines, `${eid}-travel-${legName}`, summ, dep, arr, loc, desc);
  }
}

function hotelVevent(lines: string[], eid: string, ename: string, hotel: HotelInfo) {
  if (!(hotel.name || hotel.address)) return;
  const ci = dateCompact(hotel.checkInAt);
  if (!ci) return;
  const co = dateCompact(hotel.checkOutAt) || ci;
  const loc = join([hotel.name, hotel.address, hotel.city, hotel.state, hotel.zip]);
  const desc = join([hotel.room ? `Room ${hotel.room}` : null, hotel.confirmation ? `Confirmation ${hotel.confirmation}` : null, hotel.phone ? `Phone ${hotel.phone}` : null], ' | ');
  veventAllDay(lines, `${eid}-hotel`, `Hotel: ${hotel.name || 'Lodging'} — ${ename}`, ci, co, loc, desc);
}

function eventVevents(lines: string[], e: EventPayload & { id?: string }, ownerEmail: string, scope: 'personal' | 'global') {
  const eid = String(e.id || crypto.randomBytes(4).toString('hex'));
  const name = e.name || 'Event';
  const venue = (e.venue && typeof e.venue === 'object' ? e.venue : {}) as Record<string, unknown>;
  const loc = venueLoc(venue);
  const desc = join([venue.booth ? `Booth ${venue.booth}` : null, e.state ? `Status: ${e.state}` : null], ' | ');
  const sd = dateCompact(e.startDate);
  const ed = dateCompact(e.endDate) || sd;
  if (sd) veventAllDay(lines, `${eid}-show`, name, sd, ed!, loc, desc);
  for (const [key, label] of [['setup', 'Setup'], ['teardown', 'Teardown']] as const) {
    const win = e[key] && typeof e[key] === 'object' ? (e[key] as { start?: string; end?: string }) : null;
    if (!win) continue;
    const s = dtCompact(win.start);
    if (s) veventTimed(lines, `${eid}-${key}`, `${label} — ${name}`, s, dtCompact(win.end), loc, '');
  }
  if (scope !== 'personal') return;
  const el = ownerEmail.trim().toLowerCase();
  const staffer = (e.staff || []).find((s: Staffer) => (s.email || '').trim().toLowerCase() === el);
  if (!staffer) return;
  travelVevents(lines, eid, name, (staffer.travel && typeof staffer.travel === 'object' ? staffer.travel : {}) as TravelInfo);
  hotelVevent(lines, eid, name, (staffer.hotel && typeof staffer.hotel === 'object' ? staffer.hotel : {}) as HotelInfo);
}

async function loadEvents(): Promise<(EventPayload & { id: string })[]> {
  const db = await getDb();
  const docs = await db.collection<EventDoc>('events').find({}).toArray();
  const out: (EventPayload & { id: string })[] = [];
  for (const d of docs) {
    const p = d.payload;
    if (!p || typeof p !== 'object') continue;
    // Soft-delete tombstone lives on the envelope (d.deletedAt); some peers also stamp it inside the
    // payload, so honor both (the payload field is index-permissive on EventPayload).
    if (d.deletedAt || (p as { deletedAt?: number | null }).deletedAt) continue;
    out.push({ ...p, id: d._id });
  }
  return out;
}

/** Generate the .ics body for an owner + scope (mirrors eit_calendar.gen_ics). */
export async function generateIcs(ownerEmail: string, scope: 'personal' | 'global'): Promise<string> {
  let events = await loadEvents();
  if (scope === 'personal') {
    const el = ownerEmail.trim().toLowerCase();
    events = events.filter((e) => (e.staff || []).some((s: Staffer) => (s.email || '').trim().toLowerCase() === el));
  }
  const calname = `Event Tracker — ${scope === 'global' ? 'All events' : ownerEmail || 'My events'}`;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Event Tracker//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calname)}`,
    `X-WR-CALDESC:${esc('Read-only feed from Event Tracker')}`,
  ];
  for (const e of events) eventVevents(lines, e, ownerEmail, scope);
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
