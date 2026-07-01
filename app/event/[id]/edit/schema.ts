import { z } from 'zod';
import type { EventPayload, Staffer } from '@/lib/types/types';

// app/event/[id]/edit/schema.ts — the editor's zod schema (the react-hook-form contract).
//
// zod v3 (the pinned version). The nested PII/venue shapes are free-form in the source app, so we
// model them as loose records and let the editor's typed sub-fields drive what the user touches. The
// point of the schema is to (a) give react-hook-form a stable typed default-shaped form value,
// (b) coerce blanks to '' so controlled inputs never go undefined, and (c) validate the few fields
// that have real constraints (the state enum). The authoritative write-time validation + allowlist
// still lives in the Server Action + lib/write.ts — this is the CLIENT contract, not the trust
// boundary.
//
// FULL PARITY (this pass): the form value now carries EVERY field the Python EventForm edits —
// website, setup/teardown windows, the venue contact/amenities/boothSize/timezone/lat/lng, per-
// staffer hotel/travel (PII-gated), pallets, side events, and the live tagIds/primaryTagId model.

export const EVENT_STATES = [
  'draft',
  'upcoming',
  'packing',
  'ready',
  'in_transit',
  'onsite',
  'returning',
  'unpacking',
  'closed',
] as const;

const looseRecord = z.record(z.unknown());

const shipLegSchema = z.object({
  carrier: z.string(),
  tracking: z.string(),
  pickupDate: z.string(),
  pickupTime: z.string(),
  arrivalDate: z.string(),
  arrivalTime: z.string(),
  notes: z.string(),
});

const setupWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
});

// Per-day hour overrides, keyed by 'YYYY-MM-DD' (the DayHoursEditor strip). open/close = attendee
// doors (fall back to doorsOpen/doorsClose); exOpen/exClose = exhibitor access (no fallback).
const dayHoursSchema = z.object({
  open: z.string(),
  close: z.string(),
  exOpen: z.string(),
  exClose: z.string(),
});
export type DayHoursValue = z.infer<typeof dayHoursSchema>;

const sideEventSchema = z.object({
  name: z.string(),
  date: z.string(),
  time: z.string(),
  venue: z.string(),
  notes: z.string(),
});

const palletSchema = z.object({
  id: z.string(),
  label: z.string(),
  caseIds: z.array(z.string()),
  tracking: z.string(),
  notes: z.string(),
});

const venueContactSchema = z.object({
  name: z.string(),
  role: z.string(),
  email: z.string(),
  phone: z.string(),
});

// Venue keeps a permissive shape: the named typed sub-fields the editor drives, plus a passthrough
// for lat/lng (set by Places) and any future key. amenities is a plain string array (the row editor).
const venueSchema = z
  .object({
    name: z.string(),
    address: z.string(),
    city: z.string(),
    state: z.string(),
    zip: z.string(),
    booth: z.string(),
    boothSize: z.string(),
    timezone: z.string(),
    website: z.string(),
    amenities: z.array(z.string()),
    contact: venueContactSchema,
    lat: z.number().optional(),
    lng: z.number().optional(),
  })
  .passthrough();

const stafferSchema = z.object({
  name: z.string(),
  email: z.string(),
  role: z.string(),
  onsiteStart: z.string(),
  onsiteEnd: z.string(),
  // Free-form PII blobs — present in the form value only when the editor may see/edit them.
  hotel: looseRecord.optional(),
  travel: looseRecord.optional(),
});

export const eventFormSchema = z.object({
  name: z.string(),
  state: z.enum(EVENT_STATES),
  startDate: z.string(),
  endDate: z.string(),
  doorsOpen: z.string(),
  doorsClose: z.string(),
  hours: z.record(dayHoursSchema),
  city: z.string(),
  website: z.string(),
  powerDrop: z.boolean(),
  powerNotes: z.string(),
  powerReceptacles: z.array(z.string()),
  setup: setupWindowSchema,
  teardown: setupWindowSchema,
  venue: venueSchema,
  lead: z.string(),
  staff: z.array(stafferSchema),
  cases: z.array(z.string()),
  pallets: z.array(palletSchema),
  outbound: shipLegSchema,
  return: shipLegSchema,
  sideEvents: z.array(sideEventSchema),
  tagIds: z.array(z.string()),
  primaryTagId: z.string().nullable(),
});

export type EventFormValues = z.infer<typeof eventFormSchema>;

const EMPTY_SHIP_LEG = {
  carrier: '',
  tracking: '',
  pickupDate: '',
  pickupTime: '',
  arrivalDate: '',
  arrivalTime: '',
  notes: '',
};

function s(v: unknown): string {
  return v == null ? '' : String(v);
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(s) : [];
}

function venueFrom(raw: unknown): EventFormValues['venue'] {
  const v = rec(raw);
  const c = rec(v.contact);
  const out: EventFormValues['venue'] = {
    name: s(v.name),
    address: s(v.address),
    city: s(v.city),
    state: s(v.state),
    zip: s(v.zip),
    booth: s(v.booth),
    boothSize: s(v.boothSize),
    timezone: s(v.timezone),
    website: s(v.website),
    amenities: Array.isArray(v.amenities) ? v.amenities.map(s) : [],
    contact: { name: s(c.name), role: s(c.role), email: s(c.email), phone: s(c.phone) },
  };
  if (typeof v.lat === 'number') out.lat = v.lat;
  if (typeof v.lng === 'number') out.lng = v.lng;
  return out;
}

function legFrom(leg: EventPayload['outbound']): typeof EMPTY_SHIP_LEG {
  const l = (leg ?? {}) as Record<string, unknown>;
  return {
    carrier: s(l.carrier),
    tracking: s(l.tracking),
    pickupDate: s(l.pickupDate),
    pickupTime: s(l.pickupTime),
    arrivalDate: s(l.arrivalDate),
    arrivalTime: s(l.arrivalTime),
    notes: s(l.notes),
  };
}

function windowFrom(w: unknown): EventFormValues['setup'] {
  const x = rec(w);
  return { start: s(x.start), end: s(x.end) };
}

/** Normalize stored per-day hours to the fully-shaped form record — only 'YYYY-MM-DD' keys, every
 *  field a string (blank = "use default"), so the DayHoursEditor's inputs never go uncontrolled. */
function hoursFrom(h: unknown): EventFormValues['hours'] {
  const src = rec(h);
  const out: EventFormValues['hours'] = {};
  for (const key of Object.keys(src)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const d = rec(src[key]);
    out[key] = { open: s(d.open), close: s(d.close), exOpen: s(d.exOpen), exClose: s(d.exClose) };
  }
  return out;
}

/**
 * Normalize a stored EventPayload into the fully-shaped form value react-hook-form expects (every
 * controlled field defined, blanks as '' so no input is ever uncontrolled). When `piiEditable` is
 * false the per-staffer hotel/travel are dropped from the form value entirely — the editor literally
 * never holds PII it isn't allowed to edit, matching the server strip that produced `initial`
 * (defense in depth: even a tampered `initial` is scrubbed here before it reaches an input).
 *
 * Legacy migration (Python parity): a staffer with only legacy `travelDays[]` (no onsiteStart/End)
 * is migrated to the new onsite range (min day @ 09:00 → max day @ 17:00) on load, so the next save
 * persists the new shape.
 */
export function toFormValues(initial: EventPayload, piiEditable: boolean): EventFormValues {
  const rawStaff = Array.isArray(initial.staff) ? initial.staff : [];
  const staff = rawStaff.map((raw): EventFormValues['staff'][number] => {
    const st = (raw ?? {}) as Staffer & { travelDays?: unknown };
    // Legacy travelDays → onsite range migration (mirrors StaffEditor.readRange).
    let onsiteStart = s(st.onsiteStart);
    let onsiteEnd = s(st.onsiteEnd);
    if (!onsiteStart && !onsiteEnd && Array.isArray(st.travelDays)) {
      const days = (st.travelDays as unknown[]).map(s).filter(Boolean).sort();
      if (days.length) {
        onsiteStart = `${days[0]}T09:00`;
        onsiteEnd = `${days[days.length - 1]}T17:00`;
      }
    }
    const base = {
      name: s(st.name),
      email: s(st.email),
      role: s(st.role),
      onsiteStart,
      onsiteEnd,
    };
    return piiEditable ? { ...base, hotel: rec(st.hotel), travel: rec(st.travel) } : base;
  });

  return {
    name: s(initial.name),
    state: (EVENT_STATES as readonly string[]).includes(s(initial.state))
      ? (s(initial.state) as EventFormValues['state'])
      : 'draft',
    startDate: s(initial.startDate),
    endDate: s(initial.endDate),
    doorsOpen: s(initial.doorsOpen),
    doorsClose: s(initial.doorsClose),
    hours: hoursFrom(initial.hours),
    city: s(initial.city),
    website: s(initial.website),
    powerDrop: initial.powerDrop === true,
    powerNotes: s(initial.powerNotes),
    powerReceptacles: strArr(initial.powerReceptacles),
    setup: windowFrom(initial.setup),
    teardown: windowFrom(initial.teardown),
    venue: venueFrom(initial.venue),
    lead: s(initial.lead),
    staff,
    cases: strArr(initial.cases),
    pallets: (Array.isArray(initial.pallets) ? initial.pallets : []).map((p) => {
      const pr = rec(p);
      return {
        id: s(pr.id),
        label: s(pr.label),
        caseIds: strArr(pr.caseIds),
        tracking: s(pr.tracking),
        notes: s(pr.notes),
      };
    }),
    outbound: { ...EMPTY_SHIP_LEG, ...legFrom(initial.outbound) },
    return: { ...EMPTY_SHIP_LEG, ...legFrom(initial.return) },
    sideEvents: (Array.isArray(initial.sideEvents) ? initial.sideEvents : []).map((se) => {
      const x = rec(se);
      return { name: s(x.name), date: s(x.date), time: s(x.time), venue: s(x.venue), notes: s(x.notes) };
    }),
    tagIds: strArr(initial.tagIds),
    primaryTagId: initial.primaryTagId == null ? null : s(initial.primaryTagId),
  };
}

/**
 * Reduce a form value to the editable-allowlist patch the Server Action accepts (its zod schema is
 * `.strict()`). Blank name defaults to 'Untitled event' (the #91 rule, also enforced server-side).
 * PII keys flow through only when present in the form value. Empty staff hotel/travel objects are
 * dropped (Python parity — don't bloat records with `{}`).
 */
export function toPatch(values: EventFormValues): Record<string, unknown> {
  const staff = values.staff.map((st) => {
    const out: Record<string, unknown> = {
      name: st.name,
      email: st.email,
      role: st.role,
      onsiteStart: st.onsiteStart,
      onsiteEnd: st.onsiteEnd,
    };
    // Only thread PII when the form held it (piiEditable) AND it's non-empty.
    if (st.hotel && hasAnyValue(st.hotel)) out.hotel = st.hotel;
    if (st.travel && travelHasValue(st.travel)) out.travel = st.travel;
    return out;
  });

  // Per-day hours: emit only non-empty fields and drop empty days (shape normalization — keeps the
  // 3-way merge's canon compares stable). Range pruning is deliberately NOT done here: the client's
  // form range can be stale against a concurrent date edit, so the out-of-range prune is enforced
  // server-side in saveEvent against the EFFECTIVE range (the single write choke-point).
  const hours: Record<string, Record<string, string>> = {};
  for (const key of Object.keys(values.hours || {}).sort()) {
    const d = values.hours[key];
    const entry: Record<string, string> = {};
    if (d.open) entry.open = d.open;
    if (d.close) entry.close = d.close;
    if (d.exOpen) entry.exOpen = d.exOpen;
    if (d.exClose) entry.exClose = d.exClose;
    if (Object.keys(entry).length) hours[key] = entry;
  }

  return {
    name: values.name.trim() === '' ? 'Untitled event' : values.name,
    state: values.state,
    startDate: values.startDate,
    endDate: values.endDate,
    doorsOpen: values.doorsOpen,
    doorsClose: values.doorsClose,
    hours,
    city: values.city,
    website: values.website,
    powerDrop: values.powerDrop,
    powerNotes: values.powerNotes,
    powerReceptacles: values.powerReceptacles,
    setup: values.setup,
    teardown: values.teardown,
    venue: values.venue,
    lead: values.lead,
    staff,
    cases: values.cases,
    pallets: values.pallets,
    outbound: values.outbound,
    return: values.return,
    sideEvents: values.sideEvents,
    tagIds: values.tagIds,
    primaryTagId: values.primaryTagId,
  };
}

function hasAnyValue(obj: Record<string, unknown>): boolean {
  return Object.values(obj).some((v) => v != null && v !== '');
}

function travelHasValue(t: Record<string, unknown>): boolean {
  const conns = [
    ...(Array.isArray(t.outboundConnections) ? t.outboundConnections : []),
    ...(Array.isArray(t.returnConnections) ? t.returnConnections : []),
  ];
  return !!(
    t.mode ||
    (t.outbound && hasAnyValue(t.outbound as Record<string, unknown>)) ||
    (t.return && hasAnyValue(t.return as Record<string, unknown>)) ||
    conns.some((c) => c && hasAnyValue(c as Record<string, unknown>))
  );
}
