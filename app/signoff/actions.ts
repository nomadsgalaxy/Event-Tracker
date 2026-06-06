'use server';

import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth';
import { getUserDisplayName } from '@/lib/data';
import {
  setCaseSignoff,
  commitEventReady,
  commitEventClosed,
  signOffItemDisposition,
  boxAllCases,
  finalizeCheckInSweep,
  moveLooseToCase,
  sendLooseToEvent,
  upsertItem,
  WriteForbiddenError,
  type ItemPatch,
} from '@/lib/write';
import {
  addFlag as buildAddFlag,
  resolveFlag as buildResolveFlag,
  type InventoryPayload,
  type ItemFlag,
} from '@/lib/inventory-shape';
import type { ManifestSnapshot } from '@/lib/types';

// app/signoff/actions.ts — the Server Action boundary for the Sign-Off pool.
//
// Every write flows through lib/write.ts AND is gated by requireRole('lead') (the coarse lead+ floor
// that gates the screen itself), then lib/write RE-CHECKS the FINER capability with can() pinned to
// the STORED event (signoff.commit = lead+ OR lead-of-event; signoff.revert = manager+;
// looseitem.manage = lead+; db.write.app = authorized+), re-resolving the LIVE role each call. On
// success we revalidate /signoff (+ /manifest /event/<id> /catalog where the same data joins) so the
// live-DB readiness re-reads with no stale render. No thrown error leaks except the auth hard stop.

export interface SignoffActionState {
  ok: boolean;
  error?: string;
}

function revalidateAll(eventId?: string) {
  revalidatePath('/signoff');
  revalidatePath('/manifest');
  revalidatePath('/catalog');
  if (eventId) revalidatePath(`/event/${eventId}`);
}

// Resolve the actor (live role re-checked) + display name for the "by" stamp.
async function actor() {
  const user = await requireRole('lead');
  const name = await getUserDisplayName(user.email).catch(() => user.email);
  return { email: user.email, name: name || user.email, role: user.role };
}

/** Box / un-box a single roadcase (the per-case outbound sign-off). signoff.commit / signoff.revert. */
export async function setCaseSignoffAction(args: {
  eventId: string;
  caseId: string;
  boxed: boolean;
}): Promise<SignoffActionState> {
  const eventId = String(args?.eventId ?? '').trim();
  const caseId = String(args?.caseId ?? '').trim();
  const boxed = !!args?.boxed;
  if (!eventId || !caseId) return { ok: false, error: 'Missing event or case.' };

  const by = await actor();
  try {
    await setCaseSignoff({ eventId, caseId, boxed, actorEmail: by.email, actorRole: by.role, actorName: by.name });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not record the sign-off.' };
  }
  revalidateAll(eventId);
  return { ok: true };
}

/** Box every unflagged, unboxed case in one go ("Box all cases"). signoff.commit. */
export async function boxAllCasesAction(eventId: string): Promise<SignoffActionState & { boxed?: number }> {
  const id = String(eventId ?? '').trim();
  if (!id) return { ok: false, error: 'Missing event.' };
  const by = await actor();
  try {
    const res = await boxAllCases({ eventId: id, actor: by });
    revalidateAll(id);
    return { ok: true, boxed: res.boxed };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not box the cases.' };
  }
}

/** Ship Kit → record the shipment, freeze the manifest of record, set the event On Site. Returns the
 *  frozen snapshot so the client can print the manifest of record. signoff.commit. */
export async function shipKitAction(args: {
  eventId: string;
  carrier: string;
  tracking: string;
  pickupDate: string;
  notes: string;
}): Promise<SignoffActionState & { snapshot?: ManifestSnapshot | null }> {
  const id = String(args?.eventId ?? '').trim();
  if (!id) return { ok: false, error: 'Missing event.' };
  if (!String(args?.carrier ?? '').trim() || !String(args?.tracking ?? '').trim()) {
    return { ok: false, error: 'Carrier and tracking number are required.' };
  }
  const by = await actor();
  try {
    const res = await commitEventReady({
      eventId: id,
      shipping: {
        carrier: args.carrier,
        tracking: args.tracking,
        pickupDate: args.pickupDate,
        notes: args.notes,
      },
      actor: by,
    });
    revalidateAll(id);
    return { ok: true, snapshot: res.snapshot };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not ship the kit.' };
  }
}

/** Unpack Complete → close the event once every returned item is signed off. signoff.commit. */
export async function unpackCompleteAction(eventId: string): Promise<SignoffActionState> {
  const id = String(eventId ?? '').trim();
  if (!id) return { ok: false, error: 'Missing event.' };
  const by = await actor();
  try {
    await commitEventClosed({ eventId: id, actor: by });
    revalidateAll(id);
    return { ok: true };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not close the event.' };
  }
}

/** Sign / un-sign a single return row with a disposition. signoff.commit. */
export async function signOffItemAction(args: {
  eventId: string;
  itemId: string;
  caseId: string | null;
  looseDistIdx?: number;
  kind: string | null;
  bulk?: boolean;
}): Promise<SignoffActionState> {
  const eventId = String(args?.eventId ?? '').trim();
  const itemId = String(args?.itemId ?? '').trim();
  if (!eventId || !itemId) return { ok: false, error: 'Missing event or item.' };
  const by = await actor();
  try {
    await signOffItemDisposition({
      eventId,
      itemId,
      caseId: args.caseId == null ? null : String(args.caseId),
      looseDistIdx: args.looseDistIdx,
      kind: args.kind,
      auditType: args.bulk ? 'bulk-signoff' : args.kind == null ? 'unsignoff' : 'signoff',
      actor: by,
    });
    revalidateAll(eventId);
    return { ok: true };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not record the sign-off.' };
  }
}

/** Finalize the check-in sweep: raise flags on Missing/Damaged + write the reconcile audit. signoff.commit. */
export async function finalizeSweepAction(eventId: string): Promise<SignoffActionState & { flagsAdded?: number }> {
  const id = String(eventId ?? '').trim();
  if (!id) return { ok: false, error: 'Missing event.' };
  const by = await actor();
  try {
    const res = await finalizeCheckInSweep({ eventId: id, actor: by });
    revalidateAll(id);
    return { ok: true, flagsAdded: res.flagsAdded };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not finalize the sweep.' };
  }
}

/** Move a loose row into a case assigned to the event (absorb). looseitem.manage. */
export async function moveLooseAction(args: {
  eventId: string;
  itemId: string;
  distIdx: number;
  targetCaseId: string;
}): Promise<SignoffActionState> {
  const eventId = String(args?.eventId ?? '').trim();
  const itemId = String(args?.itemId ?? '').trim();
  const targetCaseId = String(args?.targetCaseId ?? '').trim();
  if (!eventId || !itemId || !targetCaseId) return { ok: false, error: 'Missing event, item or case.' };
  const by = await actor();
  try {
    await moveLooseToCase({ itemId, eventId, distIdx: Number(args.distIdx) || 0, targetCaseId, actor: by });
    revalidateAll(eventId);
    return { ok: true };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not move the item.' };
  }
}

/** Send a loose row to another event accepting transfers (draft|upcoming|packing). looseitem.manage. */
export async function sendLooseAction(args: {
  eventId: string;
  itemId: string;
  distIdx: number;
  targetEventId: string;
}): Promise<SignoffActionState> {
  const eventId = String(args?.eventId ?? '').trim();
  const itemId = String(args?.itemId ?? '').trim();
  const targetEventId = String(args?.targetEventId ?? '').trim();
  if (!eventId || !itemId || !targetEventId) return { ok: false, error: 'Missing event or item.' };
  const by = await actor();
  try {
    await sendLooseToEvent({ itemId, eventId, distIdx: Number(args.distIdx) || 0, targetEventId, actor: by });
    revalidateAll(eventId);
    revalidatePath(`/event/${targetEventId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not send the item.' };
  }
}

// ── Shared item modals (ItemDetailsModal / Flag / Resolve) — db.write.app (authorized+) ──────────
// Re-uses the SAME pattern as the Manifest actions: the patch is built client-side (the modal owns the
// form), validated/sanitized in lib/write.upsertItem; flag/resolve rebuild flags[] via the SAME
// builders the client uses, pinned to the actor's display name for the audit trail.

export async function saveItemAction(itemId: string, patch: ItemPatch): Promise<SignoffActionState> {
  const id = String(itemId ?? '').trim();
  if (!id) return { ok: false, error: 'Missing item id.' };
  if (!patch.name || !String(patch.name).trim()) return { ok: false, error: 'Name is required.' };
  const user = await requireRole('lead');
  try {
    await upsertItem({ id, patch, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not save the item.' };
  }
  revalidateAll();
  return { ok: true };
}

export async function flagItemAction(
  itemId: string,
  item: InventoryPayload,
  flag: { note: string; severity: string; category: string }
): Promise<SignoffActionState> {
  const id = String(itemId ?? '').trim();
  if (!id) return { ok: false, error: 'Missing item id.' };
  if (!flag?.note || !flag.note.trim()) return { ok: false, error: 'Please add a note describing the issue.' };
  const by = await actor();
  const nextFlags: ItemFlag[] = buildAddFlag(item || { flags: [] }, {
    note: flag.note.trim(),
    severity: flag.severity,
    category: flag.category,
    by: by.name,
  });
  try {
    await upsertItem({ id, patch: { flags: nextFlags }, actorRole: by.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not flag the item.' };
  }
  revalidateAll();
  return { ok: true };
}

/** Mark out-of-service / return-to-service (ServiceStatusPanel). db.write.app. The { status, flags }
 *  patch is built client-side via the shared pure builders; lib/write.upsertItem sanitizes both. */
export async function serviceChangeAction(
  itemId: string,
  patch: { status: 'out_of_service' | null; flags: ItemFlag[] }
): Promise<SignoffActionState> {
  const id = String(itemId ?? '').trim();
  if (!id) return { ok: false, error: 'Missing item id.' };
  const user = await requireRole('lead');
  try {
    await upsertItem({ id, patch: { status: patch.status, flags: patch.flags }, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not update service status.' };
  }
  revalidateAll();
  return { ok: true };
}

export async function resolveFlagAction(
  itemId: string,
  item: InventoryPayload,
  flagId: string,
  resolution: string
): Promise<SignoffActionState> {
  const id = String(itemId ?? '').trim();
  if (!id) return { ok: false, error: 'Missing item id.' };
  if (!flagId) return { ok: false, error: 'Missing flag.' };
  if (!resolution || !resolution.trim()) return { ok: false, error: 'Please describe how the issue was resolved.' };
  const by = await actor();
  const nextFlags: ItemFlag[] = buildResolveFlag(item || { flags: [] }, String(flagId), {
    resolution: resolution.trim(),
    by: by.name,
  });
  try {
    await upsertItem({ id, patch: { flags: nextFlags }, actorRole: by.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not resolve the flag.' };
  }
  revalidateAll();
  return { ok: true };
}
