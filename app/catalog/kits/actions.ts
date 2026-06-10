'use server';

import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth/auth';
import { createRoadKit, saveRoadKit, deleteRoadKit, WriteForbiddenError } from '@/lib/db/write';

// app/catalog/kits/actions.ts — gated Server Actions for the Road Kits library (the reusable case
// bundles). All gated by pallets.edit (authorized+) inside lib/write; the coarse requireRole here
// just rejects signed-out/read-only before the fine cap check.

export interface KitActionState {
  ok?: boolean;
  error?: string;
  id?: string;
}

function revalidateKits() {
  revalidatePath('/catalog/kits');
  revalidatePath('/catalog');
  revalidatePath('/manifest');
}

export async function createRoadKitAction(input: {
  name: string;
  caseIds?: string[];
  notes?: string;
  color?: string | null;
}): Promise<KitActionState> {
  let user;
  try {
    user = await requireRole('authorized');
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Not authorized.' };
  }
  try {
    const res = await createRoadKit({
      name: String(input?.name ?? ''),
      caseIds: Array.isArray(input?.caseIds) ? input.caseIds.map((c) => String(c)) : [],
      notes: String(input?.notes ?? ''),
      color: input?.color ?? null,
      actorRole: user.role,
    });
    revalidateKits();
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not create the kit.' };
  }
}

export async function saveRoadKitAction(
  id: string,
  patch: { name?: string; caseIds?: string[]; notes?: string; color?: string | null }
): Promise<KitActionState> {
  const kid = String(id ?? '').trim();
  if (!kid) return { error: 'Missing kit id.' };
  let user;
  try {
    user = await requireRole('authorized');
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Not authorized.' };
  }
  try {
    await saveRoadKit({ id: kid, patch, actorRole: user.role });
    revalidateKits();
    return { ok: true };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not save the kit.' };
  }
}

export async function deleteRoadKitAction(id: string): Promise<KitActionState> {
  const kid = String(id ?? '').trim();
  if (!kid) return { error: 'Missing kit id.' };
  let user;
  try {
    user = await requireRole('authorized');
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Not authorized.' };
  }
  try {
    await deleteRoadKit({ id: kid, actorRole: user.role });
    revalidateKits();
    return { ok: true };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not delete the kit.' };
  }
}
