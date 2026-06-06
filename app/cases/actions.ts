'use server';

import { revalidatePath } from 'next/cache';
import { requireRole, requireUser, type CurrentUser } from '@/lib/auth/auth';
import { getUserDisplayName } from '@/lib/db/data';
import {
  saveCase,
  createCase,
  retireOrDeleteCase,
  caseTransfer,
  caseMarkArrived,
  cycleItemStateInCase,
  addExistingItemToCase,
  applyCaseCsvImport,
  upsertItem,
  deleteInventoryItem,
  WriteForbiddenError,
  type CasePatch,
  type ItemPatch,
  type CaseCsvRow,
} from '@/lib/db/write';
import {
  addFlag as buildAddFlag,
  resolveFlag as buildResolveFlag,
  type InventoryPayload,
  type ItemFlag,
} from '@/lib/views/inventory-shape';
import type { CaseSize } from '@/lib/types/types';
import { createItemAction } from '../catalog/actions';

// app/cases/actions.ts — the case CRUD + warehouse-transfer + contents-editing + CSV-import Server
// Actions. Every write re-resolves the caller's LIVE role via requireRole/requireUser (a demotion
// takes effect immediately) and persists through lib/write.ts, which RE-GATES the precise capability
// (pallets.edit for case writes, scan.pack for contents, db.write.app for item edit/flag) against the
// live role + the STORED doc — the caller NEVER writes Mongo directly. On success we revalidate the
// list/detail/catalog so the next render reflects the write.

export interface CaseFormValues {
  label: string;
  size: string;
  zone: string;
  kitFor: string; // comma-separated SKU codes (blank = shared-purpose)
  weight: string; // CANONICAL kg as a string ('' = unset) — the client converts from the user's unit
  homeWarehouseId?: string; // '' = use default HQ
}

export interface CaseActionResult {
  ok?: boolean;
  error?: string;
  /** Set by createCaseAction on success — the new case's id (the client navigates to it). */
  id?: string;
  /** Set by retire/delete — what actually happened ('delete' | 'retire'). */
  action?: 'delete' | 'retire' | 'blocked';
}

const VALID_SIZES = new Set<CaseSize>(['small', 'medium', 'large', 'xl']);

function buildCasePatch(values: CaseFormValues): CasePatch {
  const kitFor = String(values.kitFor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const rawSize = String(values.size ?? '').trim().toLowerCase();
  return {
    label: String(values.label ?? ''),
    size: (VALID_SIZES.has(rawSize as CaseSize) ? rawSize : 'medium') as CaseSize,
    zone: String(values.zone ?? ''),
    kitFor,
    weight: String(values.weight ?? ''),
    homeWarehouseId: values.homeWarehouseId ? String(values.homeWarehouseId) : null,
  };
}

function revalidateCases(id?: string) {
  revalidatePath('/cases');
  revalidatePath('/catalog');
  if (id) revalidatePath(`/cases/${id}`);
}

/** Save an existing case (CaseEditor). pallets.edit (authorized+). */
export async function saveCaseAction(id: string, values: CaseFormValues): Promise<CaseActionResult> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to edit cases.' };
  }
  const caseId = String(id ?? '').trim();
  if (!caseId) return { error: 'Missing case id.' };

  try {
    await saveCase({ id: caseId, patch: buildCasePatch(values), actorEmail: user.email, actorRole: user.role });
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Failed to save case.' };
  }
  revalidateCases(caseId);
  return { ok: true };
}

/** CREATE a new case (the "New case" → blank CaseEditor). pallets.edit (authorized+). Returns the
 *  minted id so the client can route to the new case detail. */
export async function createCaseAction(values: CaseFormValues): Promise<CaseActionResult> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to create cases.' };
  }
  try {
    const res = await createCase({ patch: buildCasePatch(values), actorEmail: user.email, actorRole: user.role });
    revalidateCases(res.id);
    return { ok: true, id: res.id };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Failed to create case.' };
  }
}

/** DELETE or RETIRE a case (RetireCaseModal). The server RE-CLASSIFIES the FK situation, so a
 *  'delete' that the live state can't support is downgraded to a retire (and a blocked case is
 *  refused). pallets.edit (authorized+). */
export async function retireOrDeleteCaseAction(
  id: string,
  action: 'delete' | 'retire',
  reason: string
): Promise<CaseActionResult> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to delete cases.' };
  }
  const caseId = String(id ?? '').trim();
  if (!caseId) return { error: 'Missing case id.' };
  const by = await getUserDisplayName(user.email).catch(() => user.email);
  try {
    const res = await retireOrDeleteCase({
      id: caseId,
      action,
      reason: String(reason ?? ''),
      actorEmail: user.email,
      actorName: by || user.email,
      actorRole: user.role,
    });
    revalidateCases(caseId);
    return { ok: true, action: res.action };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message, action: 'blocked' };
    return { error: err instanceof Error ? err.message : 'Failed to delete case.' };
  }
}

/** #66 Transfer a case to another warehouse (mark in transit). pallets.edit (authorized+). */
export async function caseTransferAction(
  id: string,
  toWarehouseId: string,
  carrier?: string,
  trackingNumber?: string
): Promise<CaseActionResult> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to move cases.' };
  }
  const caseId = String(id ?? '').trim();
  if (!caseId) return { error: 'Missing case id.' };
  try {
    await caseTransfer({
      id: caseId,
      toWarehouseId: String(toWarehouseId ?? ''),
      carrier,
      trackingNumber,
      actorEmail: user.email,
      actorRole: user.role,
    });
    revalidateCases(caseId);
    return { ok: true };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Failed to move case.' };
  }
}

/** #66 Mark a case ARRIVED at its in-transit destination. pallets.edit (authorized+). */
export async function caseMarkArrivedAction(id: string): Promise<CaseActionResult> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to move cases.' };
  }
  const caseId = String(id ?? '').trim();
  if (!caseId) return { error: 'Missing case id.' };
  try {
    await caseMarkArrived({ id: caseId, actorEmail: user.email, actorRole: user.role });
    revalidateCases(caseId);
    return { ok: true };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Failed to mark arrived.' };
  }
}

// ─── In-case CONTENTS editing (the case-detail manifest) ──────────────────────────────────────

/** Toggle an item's per-case packed ↔ pending by clicking the state pill (cycleItemState).
 *  scan.pack (authorized+). */
export async function cycleItemStateAction(itemId: string, caseId: string): Promise<CaseActionResult> {
  const iid = String(itemId ?? '').trim();
  const cid = String(caseId ?? '').trim();
  if (!iid || !cid) return { error: 'Missing item or case.' };
  const user = await requireUser();
  const by = await getUserDisplayName(user.email).catch(() => user.email);
  try {
    await cycleItemStateInCase({ itemId: iid, caseId: cid, actorRole: user.role, actor: { email: user.email, name: by || user.email } });
    revalidateCases(cid);
    return { ok: true };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Could not update the item state.' };
  }
}

/** Add an existing item to the case (AddItemToCaseModal). scan.pack (authorized+). */
export async function addItemToCaseAction(itemId: string, caseId: string): Promise<CaseActionResult> {
  const iid = String(itemId ?? '').trim();
  const cid = String(caseId ?? '').trim();
  if (!iid || !cid) return { error: 'Missing item or case.' };
  const user = await requireUser();
  const by = await getUserDisplayName(user.email).catch(() => user.email);
  try {
    await addExistingItemToCase({ itemId: iid, caseId: cid, actorRole: user.role, actor: { email: user.email, name: by || user.email } });
    revalidateCases(cid);
    revalidatePath(`/catalog/${iid}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Could not add the item.' };
  }
}

/** Create a brand-new item AND attach it to the case (AddItemToCaseModal "Create new item"). Mints a
 *  blank bulk item named from the search box (createItemAction — db.write.app), attaches it
 *  (addExistingItemToCase — scan.pack), and returns the new id so the client can open the editor to set
 *  tracking / distribution / stock — the same create-blank-then-edit flow the catalog "New item" uses. */
export async function createItemInCaseAction(name: string, caseId: string): Promise<CaseActionResult> {
  const cid = String(caseId ?? '').trim();
  if (!cid) return { error: 'Missing case.' };
  const user = await requireUser();
  const created = await createItemAction(name);
  if (!created.ok || !created.id) return { error: created.error || 'Could not create the item.' };
  const by = await getUserDisplayName(user.email).catch(() => user.email);
  try {
    await addExistingItemToCase({ itemId: created.id, caseId: cid, actorRole: user.role, actor: { email: user.email, name: by || user.email } });
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Could not add the new item to the case.' };
  }
  revalidateCases(cid);
  revalidatePath(`/catalog/${created.id}`);
  return { ok: true, id: created.id };
}

/** Save the full ItemDetailsModal editor (edit an item from the case detail). db.write.app
 *  (authorized+). */
export async function saveCaseItemAction(itemId: string, patch: ItemPatch, caseId: string): Promise<CaseActionResult> {
  const iid = String(itemId ?? '').trim();
  const cid = String(caseId ?? '').trim();
  if (!iid) return { error: 'Missing item id.' };
  if (!patch.name || !String(patch.name).trim()) return { error: 'Name is required.' };
  const user = await requireRole('authorized');
  try {
    await upsertItem({ id: iid, patch, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not save the item.' };
  }
  revalidateCases(cid);
  revalidatePath(`/catalog/${iid}`);
  return { ok: true };
}

/** Flag an item from the case detail (FlagItemModal). db.write.app (authorized+). */
export async function flagCaseItemAction(
  itemId: string,
  item: InventoryPayload,
  flag: { note: string; severity: string; category: string },
  caseId: string
): Promise<CaseActionResult> {
  const iid = String(itemId ?? '').trim();
  const cid = String(caseId ?? '').trim();
  if (!iid) return { error: 'Missing item id.' };
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
    await upsertItem({ id: iid, patch: { flags: nextFlags }, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not flag the item.' };
  }
  revalidateCases(cid);
  return { ok: true };
}

/** Resolve a flag from the case detail (ResolveFlagModal). db.write.app (authorized+). */
export async function resolveCaseFlagAction(
  itemId: string,
  item: InventoryPayload,
  flagId: string,
  resolution: string,
  caseId: string
): Promise<CaseActionResult> {
  const iid = String(itemId ?? '').trim();
  const cid = String(caseId ?? '').trim();
  if (!iid) return { error: 'Missing item id.' };
  if (!flagId) return { error: 'Missing flag.' };
  if (!resolution || !resolution.trim()) return { error: 'Please describe how the issue was resolved.' };
  const user = await requireRole('authorized');
  const by = await getUserDisplayName(user.email).catch(() => user.email);
  const nextFlags: ItemFlag[] = buildResolveFlag(item || { flags: [] }, String(flagId), {
    resolution: resolution.trim(),
    by: by || user.email,
  });
  try {
    await upsertItem({ id: iid, patch: { flags: nextFlags }, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not resolve the flag.' };
  }
  revalidateCases(cid);
  return { ok: true };
}

/** Remove an item's placement from THIS case only (the item stays in the catalog). bulk: drop the
 *  matching distribution rows; serial: relocate in-case units back to storage. db.write.app. */
export async function removeItemFromCaseAction(
  itemId: string,
  item: InventoryPayload,
  caseId: string
): Promise<CaseActionResult> {
  const iid = String(itemId ?? '').trim();
  const cid = String(caseId ?? '').trim();
  if (!iid || !cid) return { error: 'Missing item or case.' };
  const user = await requireRole('authorized');
  const patch: ItemPatch = {};
  if (item.tracking === 'serial') {
    patch.units = (Array.isArray(item.units) ? item.units : []).map((u) =>
      u && !u.deletedAt && u.location === cid ? { ...u, location: 'storage', state: 'draft' as const } : u
    );
  } else {
    patch.distribution = (Array.isArray(item.distribution) ? item.distribution : []).filter((d) => d.caseId !== cid);
  }
  try {
    await upsertItem({ id: iid, patch, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not remove the item.' };
  }
  revalidateCases(cid);
  revalidatePath(`/catalog/${iid}`);
  return { ok: true };
}

/** DELETE an item from inventory entirely (the Python CaseDetail "Delete" — removes it everywhere,
 *  not just from this case). Soft-deletes via a deletedAt tombstone so the removal replicates.
 *  db.write.app (authorized+). */
export async function deleteCaseItemAction(itemId: string, caseId: string): Promise<CaseActionResult> {
  const iid = String(itemId ?? '').trim();
  const cid = String(caseId ?? '').trim();
  if (!iid) return { error: 'Missing item id.' };
  const user = await requireRole('authorized');
  try {
    await deleteInventoryItem(iid, user.role);
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not delete the item.' };
  }
  revalidateCases(cid);
  revalidatePath(`/catalog/${iid}`);
  return { ok: true };
}

// ─── CSV import (cases) ───────────────────────────────────────────────────────────────────────

/** Commit a dry-run-validated CSV of case rows (create / update-by-id). pallets.edit (authorized+). */
export async function importCasesAction(rows: CaseCsvRow[]): Promise<CaseActionResult & { created?: number; updated?: number }> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to import cases.' };
  }
  try {
    const res = await applyCaseCsvImport({ rows: Array.isArray(rows) ? rows : [], actorRole: user.role });
    revalidateCases();
    return { ok: true, created: res.created, updated: res.updated };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Failed to import cases.' };
  }
}
