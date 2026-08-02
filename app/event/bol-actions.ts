'use server';

import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth/auth';
import { saveEventBol, removeEventBol, WriteForbiddenError } from '@/lib/db/write';

// app/event/bol-actions.ts — the Shipping tab's Bill-of-Lading actions. Coarse gate here
// (authorized+), fine gate in the write fns (event.edit, lead-of-event judged on the stored doc) —
// the same two-layer shape as every event mutation.

export interface BolActionResult {
  ok: boolean;
  error?: string;
}

export async function saveBolAction(eventId: string, bol: Record<string, unknown>): Promise<BolActionResult> {
  let user;
  try {
    user = await requireRole('authorized');
  } catch {
    return { ok: false, error: 'Sign in with a writer account to record BOLs.' };
  }
  try {
    const res = await saveEventBol({ eventId: String(eventId ?? ''), bol: bol ?? {}, actorEmail: user.email, actorRole: user.role });
    if (res.ok) revalidatePath(`/event/${String(eventId)}`);
    return { ok: res.ok, error: res.error };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not save the BOL.' };
  }
}

export async function deleteBolAction(eventId: string, bolId: string): Promise<BolActionResult> {
  let user;
  try {
    user = await requireRole('authorized');
  } catch {
    return { ok: false, error: 'Sign in with a writer account to record BOLs.' };
  }
  try {
    const res = await removeEventBol({ eventId: String(eventId ?? ''), bolId: String(bolId ?? ''), actorEmail: user.email, actorRole: user.role });
    if (res.ok) revalidatePath(`/event/${String(eventId)}`);
    return { ok: res.ok, error: res.error };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not delete the BOL.' };
  }
}
