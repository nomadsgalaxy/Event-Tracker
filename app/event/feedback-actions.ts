'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/auth';
import { rankOf } from '@/lib/auth/rbac';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import { dispatchOutbound } from '@/lib/integrations/outbound';
import type { EventDoc, StafferFeedback } from '@/lib/types/types';

// app/event/feedback-actions.ts — the post-event "How was your stay?" submit.
//
// STRICTLY SELF-SCOPED: the caller's session email must match a roster entry on the event; the
// write targets exactly that staffer's `feedback` sub-object (and mirrors the hotel rating onto
// hotel.rating so it feeds the past-stay suggestions). The update filter pins the staffer INDEX to
// the email we resolved it from, so a concurrent roster edit can never make us write someone
// else's row — a moved/removed staffer makes matchedCount 0 and we report "try again".
//
// Eligibility: staffed on the event AND the event has started (you can rate the hotel you're
// sleeping in; the bell reminder only nudges after the END). Resubmit allowed — it updates in
// place, stamping submittedAt.

const lc = (v: unknown): string => String(v ?? '').trim().toLowerCase();

export interface FeedbackInput {
  event?: number;
  venue?: number;
  hotel?: number;
  breakfast?: number;
  eventNotes?: string;
  venueNotes?: string;
  hotelNotes?: string;
  comments?: string;
}

export interface FeedbackResult {
  ok: boolean;
  error?: string;
}

function cleanRating(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) return undefined;
  return n;
}

export async function submitEventFeedbackAction(eventId: string, input: FeedbackInput): Promise<FeedbackResult> {
  const user = await requireUser();
  // The data-plane write floor (authorized+), consistent with every other events write. A rank-0
  // read-only account on a roster views but doesn't write.
  if (rankOf(user.role) < rankOf('authorized')) {
    return { ok: false, error: 'Your account is read-only — ask an admin for write access.' };
  }
  const me = lc(user.email);
  const id = String(eventId ?? '').trim();
  if (!id) return { ok: false, error: 'Missing event id.' };

  const fb: StafferFeedback = {};
  const ev = cleanRating(input?.event);
  const venue = cleanRating(input?.venue);
  const hotel = cleanRating(input?.hotel);
  const breakfast = cleanRating(input?.breakfast);
  if (ev) fb.event = ev;
  if (venue) fb.venue = venue;
  if (hotel) fb.hotel = hotel;
  if (breakfast) fb.breakfast = breakfast;
  // Slice by code units, then drop a bisected surrogate pair so an emoji straddling the limit
  // can't persist as a lone surrogate (U+FFFD in every export).
  const note = (v: unknown, max: number) => {
    let s = String(v ?? '').trim().slice(0, max);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
    return s;
  };
  const eventNotes = note(input?.eventNotes, 1000);
  const venueNotes = note(input?.venueNotes, 1000);
  const hotelNotes = note(input?.hotelNotes, 1000);
  const comments = note(input?.comments, 2000); // same helper — fixes the pre-existing comments slice too
  if (eventNotes) fb.eventNotes = eventNotes;
  if (venueNotes) fb.venueNotes = venueNotes;
  if (hotelNotes) fb.hotelNotes = hotelNotes;
  if (comments) fb.comments = comments;
  if (!fb.event && !fb.venue && !fb.hotel && !fb.breakfast && !fb.eventNotes && !fb.venueNotes && !fb.hotelNotes && !fb.comments) {
    return { ok: false, error: 'Rate at least one thing (or leave a note).' };
  }
  fb.submittedAt = Date.now();

  const db = await getDb();
  const doc = await db.collection<EventDoc>('events').findOne({ _id: id, ...NOT_DELETED });
  if (!doc?.payload) return { ok: false, error: 'Event not found.' };

  const staff = Array.isArray(doc.payload.staff) ? doc.payload.staff : [];
  const idx = staff.findIndex((s) => s && typeof s === 'object' && lc(s.email) === me);
  if (idx < 0) return { ok: false, error: 'Only staff on this event can leave feedback.' };

  // Started yet? (Local-date compare, same convention as the reminders.) A draft with no date
  // can't be rated.
  const sd = String(doc.payload.startDate ?? '').trim();
  const today = new Date();
  const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || sd > todayYmd) {
    return { ok: false, error: 'Feedback opens once the event starts.' };
  }

  const now = Date.now();
  const set: Record<string, unknown> = {
    [`payload.staff.${idx}.feedback`]: fb,
    updatedAt: now,
  };
  const unset: Record<string, ''> = {};
  // Mirror the hotel rating onto hotel.rating (the suggestions source) — but only when the
  // staffer actually HAS a hotel (a name), never fabricating a phantom `hotel: {rating}` object
  // that downstream code would treat as lodging data. When a resubmit CLEARS the star and the
  // current hotel.rating is the one this survey wrote earlier, clear the mirror too (an
  // editor-set rating that differs is left alone — we can't tell whose it is).
  const curHotel = staff[idx].hotel;
  const prevFb = staff[idx].feedback;
  if (fb.hotel && curHotel?.name) {
    set[`payload.staff.${idx}.hotel.rating`] = fb.hotel;
  } else if (!fb.hotel && prevFb?.hotel && curHotel && Number(curHotel.rating) === Number(prevFb.hotel)) {
    unset[`payload.staff.${idx}.hotel.rating`] = '';
  }
  // Breakfast QUALITY mirrors to hotel.breakfastRating with identical semantics.
  if (fb.breakfast && curHotel?.name) {
    set[`payload.staff.${idx}.hotel.breakfastRating`] = fb.breakfast;
  } else if (!fb.breakfast && prevFb?.breakfast && curHotel && Number(curHotel.breakfastRating) === Number(prevFb.breakfast)) {
    unset[`payload.staff.${idx}.hotel.breakfastRating`] = '';
  }

  // Pin the index to the email we resolved it from — a concurrent roster reorder makes this a
  // no-match rather than a write onto someone else's row.
  const res = await db.collection<EventDoc>('events').updateOne(
    { _id: id, [`payload.staff.${idx}.email`]: staff[idx].email, ...NOT_DELETED },
    Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set }
  );
  if (res.matchedCount === 0) {
    return { ok: false, error: 'The roster changed while you were typing — reload and try again.' };
  }

  // Outbound: notify subscribers a survey landed. Counts only — no names/emails/comments (the
  // same no-staff-PII rule every outbound payload follows). First-time submits only (an edit of an
  // existing survey shouldn't re-ping).
  if (!prevFb?.submittedAt) {
    const responded = staff.filter((s, i) => (i === idx ? true : typeof s?.feedback?.submittedAt === 'number')).length;
    void dispatchOutbound({
      type: 'feedback_submitted',
      summary: `Feedback submitted for ${doc.payload.name || id} (${responded}/${staff.length} responses)`,
      data: { eventId: id, eventName: doc.payload.name || '', responses: responded, rosterSize: staff.length },
    });
  }

  revalidatePath(`/event/${id}`);
  revalidatePath(`/event/${id}/report`);
  return { ok: true };
}
