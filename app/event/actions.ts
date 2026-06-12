'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireRole, requireUser } from '@/lib/auth/auth';
import { getUserDisplayName } from '@/lib/db/data';
import { saveEvent, createEvent, softDeleteEvent, markEventOnsite, WriteForbiddenError, type EventPatch } from '@/lib/db/write';
import { parseIcs, icsLocationToVenue } from '@/lib/integrations/ics';
import type { EventState } from '@/lib/types/types';

// app/event/actions.ts — the event-editor Server Action.
//
// The client editor serializes its whole working draft to JSON and posts it here.
// We:
//   1. requireRole('authorized') — a coarse signed-in-writer gate (the FINE
//      event.edit / lead-of-event decision is enforced inside saveEvent against the
//      STORED doc, so a lead who is only 'authorized' still passes here and is then
//      allowed by the per-event check, while a non-lead authorized worker is refused).
//   2. zod-validate + normalize the payload into the editable allowlist.
//   3. saveEvent() — pin-to-stored authz + $set under payload.* + stamp updatedAt.
//   4. revalidatePath the detail + edit routes so the next render is live.
//
// Returns a typed FormResult the client renders (never throws across the wire for
// the expected failures — forbidden / not-found / validation become messages).

const EVENT_STATES: readonly EventState[] = [
  'draft',
  'upcoming',
  'packing',
  'ready',
  'in_transit',
  'onsite',
  'returning',
  'unpacking',
  'closed',
];

// Loose, defensive schemas — the nested PII/venue shapes are free-form in the
// source app, so we accept records of unknown and let the allowlist + $set govern
// what actually persists. The point of zod here is to reject a malformed top-level
// post (wrong types on the scalar fields), not to over-constrain the JSON blobs.
const shipLeg = z
  .object({
    carrier: z.string().optional(),
    tracking: z.string().optional(),
    pickupDate: z.string().optional(),
    pickupTime: z.string().optional(),
    arrivalDate: z.string().optional(),
    arrivalTime: z.string().optional(),
    notes: z.string().optional(),
  })
  .partial()
  .passthrough();

const staffer = z
  .object({
    email: z.string().optional(),
    name: z.string().optional(),
    role: z.string().optional(),
    onsiteStart: z.string().optional(),
    onsiteEnd: z.string().optional(),
    hotel: z.record(z.string(), z.unknown()).optional(),
    travel: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// Loose nested shapes for the #93 parity fields. Same posture as shipLeg/staffer: validate the
// top-level type (so a malformed post is rejected) but let the $set allowlist + the live detail
// renderer govern the free-form interiors (the source app stores these as plain blobs).
const setupWindow = z
  .object({ start: z.string().optional(), end: z.string().optional() })
  .partial()
  .passthrough();

const sideEvent = z
  .object({
    name: z.string().optional(),
    date: z.string().optional(),
    time: z.string().optional(),
    venue: z.string().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

const pallet = z
  .object({
    id: z.string(),
    label: z.string().optional(),
    caseIds: z.array(z.string()).optional(),
    tracking: z.string().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

const patchSchema = z
  .object({
    name: z.string().optional(),
    state: z.enum(EVENT_STATES as [EventState, ...EventState[]]).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    doorsOpen: z.string().optional(),
    doorsClose: z.string().optional(),
    city: z.string().optional(),
    venue: z.record(z.string(), z.unknown()).optional(),
    staff: z.array(staffer).optional(),
    cases: z.array(z.string()).optional(),
    lead: z.string().optional(),
    outbound: shipLeg.optional(),
    return: shipLeg.optional(),
    tags: z.array(z.string()).optional(),
    // #93 parity additions:
    website: z.string().optional(),
    setup: setupWindow.optional(),
    teardown: setupWindow.optional(),
    sideEvents: z.array(sideEvent).optional(),
    pallets: z.array(pallet).optional(),
    tagIds: z.array(z.string()).optional(),
    primaryTagId: z.string().nullable().optional(),
    roadKitIds: z.array(z.string()).optional(),
    powerDrop: z.boolean().optional(),
    powerNotes: z.string().optional(),
  })
  .strict();

export interface SaveEventState {
  ok?: boolean;
  error?: string;
  savedAt?: number;
}

export async function saveEventAction(id: string, rawJson: string): Promise<SaveEventState> {
  // Coarse gate: must be a signed-in writer. Throws/redirects for signed-out;
  // throws Forbidden for read-only. The per-event editor right is checked below.
  let user;
  try {
    user = await requireRole('authorized');
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authorized.' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch {
    return { ok: false, error: 'Could not read the submitted form (bad JSON).' };
  }

  const result = patchSchema.safeParse(parsedJson);
  if (!result.success) {
    return { ok: false, error: 'Some fields were invalid and could not be saved.' };
  }

  // Default a blank name so a draft is always saveable (mirrors the #91 fix:
  // doSave defaults a blank name to "Untitled event").
  const patch: EventPatch = { ...result.data };
  if (patch.name !== undefined && patch.name.trim() === '') patch.name = 'Untitled event';

  try {
    await saveEvent({ id, patch, actorEmail: user.email, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Save failed.' };
  }

  // Live-DB: bust the cached render of both the detail and edit routes.
  revalidatePath(`/event/${id}`);
  revalidatePath(`/event/${id}/edit`);
  return { ok: true, savedAt: Date.now() };
}

export interface CreateEventState {
  ok?: boolean;
  error?: string;
  /** The minted event id, on success — the client navigates to /event/<id>. */
  id?: string;
}

/**
 * Create a NEW event from the editor's "Create" action. Coarse gate: requireRole('authorized'); the
 * FINE event.create decision (manager+) is enforced inside createEvent against the LIVE role, so an
 * authorized-but-not-manager caller passes the coarse gate and is then refused with a message (never
 * a thrown error across the wire). The id is server-minted (a client id is never trusted). On success
 * we revalidate the dashboard so the new event appears in the list, and return the id to navigate to.
 */
export async function createEventAction(rawJson: string): Promise<CreateEventState> {
  let user;
  try {
    user = await requireRole('authorized');
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authorized.' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch {
    return { ok: false, error: 'Could not read the submitted form (bad JSON).' };
  }

  const result = patchSchema.safeParse(parsedJson);
  if (!result.success) {
    return { ok: false, error: 'Some fields were invalid and could not be saved.' };
  }

  const patch: EventPatch = { ...result.data };
  if (patch.name !== undefined && patch.name.trim() === '') patch.name = 'Untitled event';

  let id: string;
  try {
    const res = await createEvent({ patch, actorEmail: user.email, actorRole: user.role });
    id = res.id;
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Create failed.' };
  }

  revalidatePath('/');
  revalidatePath(`/event/${id}`);
  return { ok: true, id };
}

export interface DeleteEventState {
  ok?: boolean;
  error?: string;
}

/**
 * Soft-delete an event (the EventDetail "Delete" header action → confirm dialog → here). The FINE
 * event.delete decision (manager+ OR the lead of THIS event) is enforced inside softDeleteEvent
 * against the STORED doc; here we only require a signed-in session (requireUser re-resolves the LIVE
 * role). On success the tombstone replicates + we revalidate the dashboard/detail; the client
 * navigates to the dashboard (the Python onDelete behaviour). Returns a typed state — the expected
 * failures (forbidden / not authorized) become messages, never a thrown error across the wire.
 */
export async function deleteEventAction(id: string): Promise<DeleteEventState> {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authorized.' };
  }

  try {
    await softDeleteEvent({ id: String(id), actorEmail: user.email, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Delete failed.' };
  }

  revalidatePath('/');
  revalidatePath(`/event/${id}`);
  return { ok: true };
}

export interface MarkOnsiteState {
  ok?: boolean;
  error?: string;
}

/**
 * Lead marks an IN-TRANSIT event as arrived On Site (the shipment reached the venue). Coarse gate:
 * requireUser; the FINE signoff.commit decision (lead+ OR the lead of THIS event) + the in_transit
 * precondition are enforced inside markEventOnsite against the STORED doc. Revalidates the dashboard /
 * detail / manifest / sign-off so the live state re-reads.
 */
export async function markEventOnsiteAction(id: string): Promise<MarkOnsiteState> {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authorized.' };
  }
  const eventId = String(id ?? '').trim();
  if (!eventId) return { ok: false, error: 'Missing event.' };
  const name = await getUserDisplayName(user.email).catch(() => user.email);
  try {
    await markEventOnsite({ eventId, actor: { email: user.email, name: name || user.email, role: user.role } });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not mark on site.' };
  }
  revalidatePath('/');
  revalidatePath(`/event/${eventId}`);
  revalidatePath('/manifest');
  revalidatePath('/signoff');
  return { ok: true };
}

// ── Import events from an iCalendar (.ics) file ──────────────────────────────────────────────────
// The client previews the parsed VEVENTs (lib/integrations/ics is isomorphic) and posts the RAW file
// text + the selected event indexes; the server RE-PARSES (never trusts the client's parse) and
// creates one DRAFT event per selection through the same gated createEvent path as the editor
// (event.create, manager+, server-minted ids). Door times are deliberately not imported — only the
// show dates, venue guess, website, and GEO coordinates.

export interface ImportIcsState {
  ok?: boolean;
  error?: string;
  created?: { id: string; name: string }[];
}

const ICS_MAX_BYTES = 1_000_000; // a calendar file, not a media upload
const ICS_MAX_EVENTS = 25;

export async function importIcsEventsAction(icsText: string, selectedIndexes?: number[]): Promise<ImportIcsState> {
  let user;
  try {
    user = await requireRole('authorized');
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authorized.' };
  }

  const text = String(icsText ?? '');
  if (!text.trim()) return { ok: false, error: 'The file is empty.' };
  if (text.length > ICS_MAX_BYTES) return { ok: false, error: 'That .ics file is too large (max 1 MB).' };

  const all = parseIcs(text).filter((ev) => ev.startDate); // undated shells aren't importable
  if (all.length === 0) return { ok: false, error: 'No calendar events with dates were found in that file.' };

  const wanted = Array.isArray(selectedIndexes) && selectedIndexes.length > 0
    ? all.filter((_, i) => selectedIndexes.includes(i))
    : all;
  if (wanted.length === 0) return { ok: false, error: 'No events selected.' };
  if (wanted.length > ICS_MAX_EVENTS) return { ok: false, error: `Too many events (max ${ICS_MAX_EVENTS} per import).` };

  const created: { id: string; name: string }[] = [];
  for (const ev of wanted) {
    const guess = icsLocationToVenue(ev.location);
    const venue: Record<string, unknown> = {};
    if (guess.name) venue.name = guess.name;
    if (guess.address) venue.address = guess.address;
    if (guess.city) venue.city = guess.city;
    if (guess.state) venue.state = guess.state;
    if (guess.zip) venue.zip = guess.zip;
    if (ev.lat != null && ev.lng != null) {
      venue.lat = ev.lat;
      venue.lng = ev.lng;
    }
    const patch: EventPatch = {
      name: ev.summary || 'Untitled event',
      startDate: ev.startDate,
      endDate: ev.endDate || ev.startDate,
      ...(guess.city ? { city: guess.city } : {}),
      ...(Object.keys(venue).length ? { venue } : {}),
      ...(ev.url ? { website: ev.url } : {}),
    };
    try {
      const res = await createEvent({ patch, actorEmail: user.email, actorRole: user.role });
      created.push({ id: res.id, name: patch.name || 'Untitled event' });
    } catch (e) {
      if (e instanceof WriteForbiddenError) return { ok: false, error: e.message, created };
      return { ok: false, error: e instanceof Error ? e.message : 'Import failed.', created };
    }
  }

  revalidatePath('/');
  revalidatePath('/calendar');
  for (const c of created) revalidatePath(`/event/${c.id}`);
  return { ok: true, created };
}
