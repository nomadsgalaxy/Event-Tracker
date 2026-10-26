'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/auth';
import { getUserDisplayName } from '@/lib/db/data';
import { placeItemOnPallet, removeItemFromPallet, setPalletItemPacked, WriteForbiddenError } from '@/lib/db/write';

// app/event/pallet-actions.ts — load, unload and pack the items riding an event's pallets directly.
// pallets.edit and the event-state window are re-checked inside lib/db/write; here we only resolve the
// live user for the actor stamp and refresh the pages that show pallet contents.

export interface PalletActionState {
  ok?: boolean;
  error?: string;
}

async function actor() {
  const user = await requireUser();
  const name = await getUserDisplayName(user.email).catch(() => user.email);
  return { email: user.email, name: name || user.email, role: user.role };
}

function refresh(eventId: string) {
  revalidatePath(`/event/${eventId}`);
  revalidatePath('/manifest');
  revalidatePath('/signoff');
  revalidatePath('/catalog');
}

async function run(eventId: string, fn: () => Promise<unknown>, fallback: string): Promise<PalletActionState> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : fallback };
  }
  refresh(eventId);
  return { ok: true };
}

/** Put an item from storage onto a pallet. Bulk: `qty` (default 1). Serial: `unitId`, or the first free unit. */
export async function placeOnPalletAction(
  eventId: string,
  palletId: string,
  itemId: string,
  opts: { qty?: number; unitId?: string } = {}
): Promise<PalletActionState> {
  const a = await actor();
  return run(eventId, () => placeItemOnPallet({ eventId, palletId, itemId, qty: opts.qty, unitId: opts.unitId, actor: a }), 'Could not load the pallet.');
}

/** Take an item off a pallet, back to storage. Bulk: `qty` (default the whole line). Serial: `unitId`, or every unit. */
export async function removeFromPalletAction(
  eventId: string,
  palletId: string,
  itemId: string,
  opts: { qty?: number; unitId?: string } = {}
): Promise<PalletActionState> {
  const a = await actor();
  return run(eventId, () => removeItemFromPallet({ eventId, palletId, itemId, qty: opts.qty, unitId: opts.unitId, actor: a }), 'Could not unload the pallet.');
}

/** Mark a pallet line packed (or back to pending). */
export async function setPalletItemPackedAction(
  eventId: string,
  palletId: string,
  itemId: string,
  packed: boolean,
  unitId?: string | null
): Promise<PalletActionState> {
  const a = await actor();
  return run(eventId, () => setPalletItemPacked({ eventId, palletId, itemId, unitId: unitId || undefined, packed: !!packed, actor: a }), 'Could not update the pallet.');
}
