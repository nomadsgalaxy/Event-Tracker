'use server';

import { revalidatePath } from 'next/cache';
import { requireRole, requireUser } from '@/lib/auth';
import { getUserDisplayName } from '@/lib/data';
import {
  setEventCases,
  upsertItem,
  addLooseDistribution,
  createLooseItem,
  WriteForbiddenError,
  type ItemPatch,
} from '@/lib/write';
import {
  addFlag as buildAddFlag,
  resolveFlag as buildResolveFlag,
  type InventoryPayload,
  type ItemFlag,
} from '@/lib/inventory-shape';

// app/manifest/actions.ts — the Server Action boundary for the Manifest pool's writes.
//
// Every write flows through lib/write.ts AND is gated by requireRole/requireUser, mirroring the
// catalog actions pattern: requireRole re-resolves the LIVE directory role on every call (a
// demotion takes effect immediately) and lib/write RE-CHECKS the same can() capability as
// defence-in-depth. On success we revalidate /manifest (+ the event/catalog reads it cross-joins)
// so the live-DB render reflects the write with no stale data.
//
// GATES (matching the Python ManifestPool):
//   • setEventCasesAction  — pallets.edit (authorized+): the Assign-cases "Save assignments".
//   • saveItemAction       — db.write.app (authorized+): the ItemDetailsModal editor.
//   • flagItemAction       — db.write.app: FlagItemModal (adds an open flag).
//   • resolveFlagAction    — db.write.app: ResolveFlagModal (resolves a flag).
//   • addLooseItemAction   — looseitem.manage (lead+): the "or add a loose item" picker.

export interface ManifestActionState {
  ok?: boolean;
  error?: string;
}

function revalidateManifest() {
  revalidatePath('/manifest');
  revalidatePath('/catalog');
}

/** Save the Assign-cases modal selection → event.cases. pallets.edit (authorized+). */
export async function setEventCasesAction(
  eventId: string,
  caseIds: string[]
): Promise<ManifestActionState> {
  const id = String(eventId ?? '').trim();
  if (!id) return { error: 'Missing event id.' };
  const ids = Array.isArray(caseIds) ? caseIds.map((c) => String(c)) : [];

  const user = await requireRole('authorized');
  try {
    const res = await setEventCases({ eventId: id, caseIds: ids, actorEmail: user.email, actorRole: user.role });
    revalidateManifest();
    revalidatePath(`/event/${id}`);
    if (res.rejected.length > 0) {
      // Some cases couldn't be assigned (retired / held elsewhere) — the assignment still saved the
      // valid ones; surface the partial result so the modal can toast it.
      return { ok: true, error: `${res.rejected.length} case(s) skipped (retired or held by another event).` };
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not save assignments.' };
  }
}

/** Save the full ItemDetailsModal editor. db.write.app (authorized+). The patch is built client-side
 *  (the modal owns the form) and validated/sanitized inside lib/write.upsertItem. */
export async function saveItemAction(
  itemId: string,
  patch: ItemPatch
): Promise<ManifestActionState> {
  const id = String(itemId ?? '').trim();
  if (!id) return { error: 'Missing item id.' };
  if (!patch.name || !String(patch.name).trim()) {
    // upsertItem falls back to '(unnamed)', but the editor requires a name — surface it as a field error.
    return { error: 'Name is required.' };
  }

  const user = await requireRole('authorized');
  try {
    await upsertItem({ id, patch, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not save the item.' };
  }
  revalidateManifest();
  revalidatePath(`/catalog/${id}`);
  return { ok: true };
}

/** Add an OPEN flag to an item (FlagItemModal). db.write.app. The flags[] is rebuilt server-side via
 *  the SAME addFlag builder the client uses, pinned to the actor's display name for the audit trail. */
export async function flagItemAction(
  itemId: string,
  item: InventoryPayload,
  flag: { note: string; severity: string; category: string }
): Promise<ManifestActionState> {
  const id = String(itemId ?? '').trim();
  if (!id) return { error: 'Missing item id.' };
  if (!flag?.note || !flag.note.trim()) return { error: 'Please add a note describing the issue.' };

  const user = await requireRole('authorized');
  const by = await getUserDisplayName(user.email).catch(() => user.email);
  const nextFlags: ItemFlag[] = buildAddFlag(item || { flags: [] }, {
    note: flag.note.trim(),
    severity: flag.severity,
    category: flag.category,
    by: by || user.email,
  });
  try {
    await upsertItem({ id, patch: { flags: nextFlags }, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not flag the item.' };
  }
  revalidateManifest();
  return { ok: true };
}

/** Resolve a flag (ResolveFlagModal). db.write.app. Rebuilds flags[] via the resolveFlag builder. */
export async function resolveFlagAction(
  itemId: string,
  item: InventoryPayload,
  flagId: string,
  resolution: string
): Promise<ManifestActionState> {
  const id = String(itemId ?? '').trim();
  if (!id) return { error: 'Missing item id.' };
  if (!flagId) return { error: 'Missing flag.' };
  if (!resolution || !resolution.trim()) return { error: 'Please describe how the issue was resolved.' };

  const user = await requireRole('authorized');
  const by = await getUserDisplayName(user.email).catch(() => user.email);
  const nextFlags: ItemFlag[] = buildResolveFlag(item || { flags: [] }, String(flagId), {
    resolution: resolution.trim(),
    by: by || user.email,
  });
  try {
    await upsertItem({ id, patch: { flags: nextFlags }, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not resolve the flag.' };
  }
  revalidateManifest();
  return { ok: true };
}

/** Attach an item LOOSE to the selected event ("or add a loose item"). looseitem.manage (lead+).
 *  `note` lets the create-new path distinguish itself in the audit log. */
export async function addLooseItemAction(
  itemId: string,
  eventId: string,
  note?: string
): Promise<ManifestActionState> {
  const iid = String(itemId ?? '').trim();
  const eid = String(eventId ?? '').trim();
  if (!iid || !eid) return { error: 'Missing item or event.' };

  // requireUser (not requireRole) — looseitem.manage is re-checked inside addLooseDistribution; we
  // resolve the live user here for the actor stamp.
  const user = await requireUser();
  const by = await getUserDisplayName(user.email).catch(() => user.email);
  try {
    await addLooseDistribution({
      itemId: iid,
      eventId: eid,
      actorEmail: user.email,
      actorRole: user.role,
      actorName: by || user.email,
      note,
    });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not attach the loose item.' };
  }
  revalidateManifest();
  revalidatePath(`/event/${eid}`);
  return { ok: true };
}

/** CREATE a new (pre-named) item then attach it loose to the event ("Create new item" in the picker).
 *  looseitem.manage (lead+). */
export async function createLooseItemAction(
  name: string,
  eventId: string
): Promise<ManifestActionState> {
  const eid = String(eventId ?? '').trim();
  if (!eid) return { error: 'Missing event.' };

  const user = await requireUser();
  const by = await getUserDisplayName(user.email).catch(() => user.email);
  try {
    await createLooseItem({
      name: String(name ?? ''),
      eventId: eid,
      actorEmail: user.email,
      actorRole: user.role,
      actorName: by || user.email,
    });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not create the loose item.' };
  }
  revalidateManifest();
  revalidatePath(`/event/${eid}`);
  return { ok: true };
}
