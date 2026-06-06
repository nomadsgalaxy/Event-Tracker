'use server';

import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth';
import { getUserDisplayName } from '@/lib/data';
import {
  packItemIntoCase,
  addItemToCase,
  setRowDisposition,
  markUnscannedMissing,
  looseAddViaScan,
  attachSerialToItem,
  bumpItemQtyInCase,
  adoptProductCode,
  updateItemTagData,
  WriteForbiddenError,
} from '@/lib/write';

// app/scan/actions.ts — the Server Action boundary for the Scan-Pack screen (DESIGN_ALIGNMENT.md
// §4.4). Every action re-resolves the LIVE directory role via requireRole BEFORE any write (a
// demotion takes effect immediately), and the underlying lib/write helper RE-CHECKS the capability
// with can() as defence-in-depth, pins ids to scalars, and verifies the case actually contains the
// item. On success we revalidate /scan so the live-DB read reflects the change immediately.
//
// GATES (mirror the Python scanPolicy + the eit_perms caps):
//   • pack / un-pack / disposition / mark-missing / add-to-case / tag-data → scan.pack (authorized+)
//   • loose-add                                                            → looseitem.manage (lead+)
//   • adopt (attach-serial / count-only / product-code)                    → scan.label (lead+)

function fail(e: unknown): { error: string } {
  if (e instanceof WriteForbiddenError) return { error: e.message };
  return { error: e instanceof Error ? e.message : 'Could not complete the action.' };
}

export interface ScanActionState {
  ok?: boolean;
  error?: string;
  itemId?: string;
  state?: 'packed' | 'pending';
}

/** Toggle one item packed/pending inside a case (the row tap + a steady scan into an open case). */
export async function packItemAction(_prev: ScanActionState, formData: FormData): Promise<ScanActionState> {
  const itemId = String(formData.get('itemId') ?? '').trim();
  const caseId = String(formData.get('caseId') ?? '').trim();
  const packed = String(formData.get('packed') ?? 'true') !== 'false';
  if (!itemId) return { error: 'Missing item id.' };
  if (!caseId) return { error: 'Missing case id.' };

  const user = await requireRole('authorized');
  try {
    const name = await getUserDisplayName(user.email);
    const res = await packItemIntoCase({ itemId, caseId, packed, actorRole: user.role, actor: { email: user.email, name } });
    revalidatePath('/scan');
    return { ok: true, itemId, state: res.state };
  } catch (e) {
    return { ...fail(e), itemId };
  }
}

/** Add a matched item to the active case (Pending prompt → Add / Add+pack). */
export async function addToCaseAction(input: { itemId: string; caseId: string; alsoPack: boolean }): Promise<ScanActionState> {
  const itemId = String(input.itemId ?? '').trim();
  const caseId = String(input.caseId ?? '').trim();
  if (!itemId || !caseId) return { error: 'Missing item or case.' };
  const user = await requireRole('authorized');
  try {
    const name = await getUserDisplayName(user.email);
    const res = await addItemToCase({ itemId, caseId, alsoPack: !!input.alsoPack, actorRole: user.role, actor: { email: user.email, name } });
    revalidatePath('/scan');
    return { ok: true, itemId, state: res.state };
  } catch (e) {
    return { ...fail(e), itemId };
  }
}

/** Set / cycle / clear a row's return disposition (unpack mode row tap). */
export async function dispositionAction(input: { itemId: string; caseId: string; disposition: string | null }): Promise<ScanActionState> {
  const itemId = String(input.itemId ?? '').trim();
  const caseId = String(input.caseId ?? '').trim();
  if (!itemId || !caseId) return { error: 'Missing item or case.' };
  const user = await requireRole('authorized');
  try {
    const name = await getUserDisplayName(user.email);
    await setRowDisposition({
      itemId,
      caseId,
      disposition: input.disposition ?? null,
      actorRole: user.role,
      actor: { email: user.email, name, role: user.role },
    });
    revalidatePath('/scan');
    return { ok: true, itemId };
  } catch (e) {
    return { ...fail(e), itemId };
  }
}

/** Mark every unscanned (no-disposition) row in the active case MISSING (unpack bulk action). */
export async function markMissingAction(input: { caseId: string }): Promise<{ ok?: boolean; error?: string; marked?: number }> {
  const caseId = String(input.caseId ?? '').trim();
  if (!caseId) return { error: 'Missing case.' };
  const user = await requireRole('authorized');
  try {
    const name = await getUserDisplayName(user.email);
    const res = await markUnscannedMissing({ caseId, actorRole: user.role, actor: { email: user.email, name, role: user.role } });
    revalidatePath('/scan');
    return { ok: true, marked: res.marked };
  } catch (e) {
    return fail(e);
  }
}

/** Loose-add an item to an event via a scan (loose mode). Gated lead+ (looseitem.manage). */
export async function looseAddAction(input: { itemId: string; eventId: string }): Promise<ScanActionState> {
  const itemId = String(input.itemId ?? '').trim();
  const eventId = String(input.eventId ?? '').trim();
  if (!itemId || !eventId) return { error: 'Missing item or event.' };
  // The lib helper gates looseitem.manage (lead+); the role gate here is the authorized+ floor (the
  // page already requires authorized to even reach this), the fine lead+ check is in the write.
  const user = await requireRole('authorized');
  try {
    const name = await getUserDisplayName(user.email);
    await looseAddViaScan({ itemId, eventId, actorEmail: user.email, actorRole: user.role, actorName: name });
    revalidatePath('/scan');
    return { ok: true, itemId };
  } catch (e) {
    return { ...fail(e), itemId };
  }
}

/** Attach the scanned text as a serial to an existing item, in the active case (adopt). lead+. */
export async function attachSerialAction(input: { itemId: string; caseId: string; serial: string }): Promise<ScanActionState> {
  const itemId = String(input.itemId ?? '').trim();
  const caseId = String(input.caseId ?? '').trim();
  const serial = String(input.serial ?? '').trim();
  if (!itemId || !caseId || !serial) return { error: 'Missing item, case or serial.' };
  const user = await requireRole('authorized');
  try {
    await attachSerialToItem({ itemId, caseId, serial, actorRole: user.role });
    revalidatePath('/scan');
    return { ok: true, itemId };
  } catch (e) {
    return { ...fail(e), itemId };
  }
}

/** Count-only +1 of an existing item into the active case (adopt). lead+. */
export async function countOnlyAction(input: { itemId: string; caseId: string }): Promise<ScanActionState> {
  const itemId = String(input.itemId ?? '').trim();
  const caseId = String(input.caseId ?? '').trim();
  if (!itemId || !caseId) return { error: 'Missing item or case.' };
  const user = await requireRole('authorized');
  try {
    await bumpItemQtyInCase({ itemId, caseId, actorRole: user.role });
    revalidatePath('/scan');
    return { ok: true, itemId };
  } catch (e) {
    return { ...fail(e), itemId };
  }
}

/** Set the scanned text as an item's product code (qr), optionally route it to the active case. lead+. */
export async function adoptProductCodeAction(input: { itemId: string; code: string; caseId: string | null }): Promise<ScanActionState> {
  const itemId = String(input.itemId ?? '').trim();
  const code = String(input.code ?? '').trim();
  if (!itemId || !code) return { error: 'Missing item or code.' };
  const user = await requireRole('authorized');
  try {
    const name = await getUserDisplayName(user.email);
    await adoptProductCode({ itemId, code, caseId: input.caseId ?? null, actorRole: user.role, actor: { email: user.email, name } });
    revalidatePath('/scan');
    return { ok: true, itemId };
  } catch (e) {
    return { ...fail(e), itemId };
  }
}

/** Refresh an item's tagData from an NFC read (UID-matched item). authorized+. */
export async function tagDataAction(input: {
  itemId: string;
  entry: {
    tagUid: string;
    format?: string;
    category?: string;
    parsed?: Record<string, unknown> | null;
    raw?: unknown;
    lastReadAt?: number;
  };
}): Promise<ScanActionState> {
  const itemId = String(input.itemId ?? '').trim();
  const uid = String(input.entry?.tagUid ?? '').trim();
  if (!itemId || !uid) return { error: 'Missing item or tag UID.' };
  const user = await requireRole('authorized');
  try {
    const name = await getUserDisplayName(user.email);
    await updateItemTagData({
      itemId,
      entry: { ...input.entry, lastReadBy: { email: user.email, name } },
      actorRole: user.role,
    });
    revalidatePath('/scan');
    return { ok: true, itemId };
  } catch (e) {
    return { ...fail(e), itemId };
  }
}
