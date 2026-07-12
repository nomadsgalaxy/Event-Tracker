'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/auth';
import { rankOf } from '@/lib/auth/rbac';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
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
  if (ev) fb.event = ev;
  if (venue) fb.venue = venue;
  if (hotel) fb.hotel = hotel;
  const comments = String(input?.comments ?? '').trim().slice(0, 2000);
  if (comments) fb.comments = comments;
  if (!fb.event && !fb.venue && !fb.hotel && !fb.comments) {
    return { ok: false, error: 'Rate at least one thing (or leave a comment).' };
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

  // Pin the index to the email we resolved it from — a concurrent roster reorder makes this a
  // no-match rather than a write onto someone else's row.
  const res = await db.collection<EventDoc>('events').updateOne(
    { _id: id, [`payload.staff.${idx}.email`]: staff[idx].email, ...NOT_DELETED },
    Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set }
  );
  if (res.matchedCount === 0) {
    return { ok: false, error: 'The roster changed while you were typing — reload and try again.' };
  }

  revalidatePath(`/event/${id}`);
  revalidatePath(`/event/${id}/report`);
  return { ok: true };
}
