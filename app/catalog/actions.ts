'use server';

import { revalidatePath } from 'next/cache';
import { requireRole, requireUser, type CurrentUser } from '@/lib/auth';
import { getUserDisplayName } from '@/lib/data';
import {
  saveInventoryItem,
  deleteInventoryItem,
  upsertItem,
  createLooseItem,
  bulkReassignToCase,
  bulkSetState,
  bulkDeleteItems,
  bulkAttachToEvent,
  saveKitBom,
  applyInventoryCsvImport,
  WriteForbiddenError,
  type InventoryPatch,
  type ItemPatch,
  type InventoryCsvRowInput,
} from '@/lib/write';
import type { SkuOption } from '@/lib/inventory-shape';
import {
  ITEM_KINDS,
  addFlag as buildAddFlag,
  resolveFlag as buildResolveFlag,
  type InventoryPayload,
  type ItemFlag,
  type KitRequirement,
} from '@/lib/inventory-shape';
import { generateId } from '@/lib/id';
import { getDb } from '@/lib/mongo';
import type { InventoryDoc } from '@/lib/inventory-shape';

// app/catalog/actions.ts — the Server Action boundary for catalog edits.
//
// Per the task contract every edit flows through lib/write.ts AND is gated by requireRole. We
// gate here at 'authorized' (the db.write.app warehouse-worker tier) which:
//   • redirects an unauthenticated caller to /login (requireUser inside requireRole), and
//   • throws Forbidden for an authenticated-but-read-only caller,
// re-resolving the LIVE directory role on every call (a demotion takes effect immediately).
// lib/write.ts then RE-CHECKS the same capability with can() as defence-in-depth, so the gate
// holds even if a future caller forgets to guard. On success we revalidate the catalog paths so
// the live-DB list/detail re-read immediately (no stale render).

export interface CatalogActionState {
  ok?: boolean;
  error?: string;
}

const KIND_SET = new Set<string>(ITEM_KINDS);

/** Coerce a numeric form field to a number, '' / absent => null (clears the value), a
 *  non-numeric string => undefined so we can reject it. */
function numOrNull(v: FormDataEntryValue | null): number | null | undefined {
  if (v == null) return undefined; // field absent => leave untouched (handled by caller)
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Save the catalog item editor. Reads the editable fields off the FormData, validates, then
 * persists via lib/write.saveInventoryItem under the live-role gate. Returns a form-state
 * object the client surfaces — no thrown errors leak to the user (except the auth
 * redirect/forbidden, which is the intended hard stop).
 */
export async function saveItemAction(
  _prev: CatalogActionState,
  formData: FormData
): Promise<CatalogActionState> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing item id.' };

  // requireRole re-resolves the LIVE role and redirects/forbids before any write.
  const user = await requireRole('authorized');

  const name = String(formData.get('name') ?? '').trim();
  if (!name) return { error: 'Name is required.' };

  const kindRaw = String(formData.get('kind') ?? '').trim().toLowerCase();
  if (kindRaw && !KIND_SET.has(kindRaw)) {
    return { error: `Unknown kind "${kindRaw}".` };
  }

  const stockTotal = numOrNull(formData.get('stockTotal'));
  if (stockTotal === undefined) return { error: 'Stock total must be a number.' };
  const reorderPoint = numOrNull(formData.get('reorderPoint'));
  if (reorderPoint === undefined) return { error: 'Reorder point must be a number.' };

  const patch: InventoryPatch = {
    name,
    sku: String(formData.get('sku') ?? '').trim(),
    qr: String(formData.get('qr') ?? '').trim(),
    kind: kindRaw || undefined,
    stockTotal,
    reorderPoint,
    storageNotes: String(formData.get('storageNotes') ?? ''),
  };

  try {
    await saveInventoryItem({ id, patch, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not save the item.' };
  }

  revalidatePath('/catalog');
  revalidatePath(`/catalog/${id}`);
  return { ok: true };
}

// ─── Full item editor (the SHARED ItemDetailsModal save path) ──────────────────────────────────
// Persists a fully-built ItemPatch (tracking/distribution/units/skuOptions/tags/flags/requirements)
// through the gated upsertItem. db.write.app (authorized+). Mirrors app/cases saveCaseItemAction so
// the modal behaves identically whether opened from the catalog or a case.
export async function saveItemDetailsAction(itemId: string, patch: ItemPatch): Promise<CatalogActionState> {
  const id = String(itemId ?? '').trim();
  if (!id) return { error: 'Missing item id.' };
  if (!patch.name || !String(patch.name).trim()) return { error: 'Name is required.' };
  const user = await requireRole('authorized');
  try {
    await upsertItem({ id, patch, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not save the item.' };
  }
  revalidatePath('/catalog');
  revalidatePath(`/catalog/${id}`);
  return { ok: true };
}

// ─── Service status (mark out-of-service / return to service) ──────────────────────────────────
export async function saveItemServiceAction(
  itemId: string,
  patch: { status: 'out_of_service' | null; flags: ItemFlag[] }
): Promise<CatalogActionState> {
  const id = String(itemId ?? '').trim();
  if (!id) return { error: 'Missing item id.' };
  const user = await requireRole('authorized');
  try {
    await upsertItem({ id, patch: { status: patch.status, flags: patch.flags }, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not update service status.' };
  }
  revalidatePath('/catalog');
  revalidatePath(`/catalog/${id}`);
  return { ok: true };
}

// ─── Flag / resolve an item (shared Flag/Resolve modals) ───────────────────────────────────────
export async function flagItemAction(
  itemId: string,
  item: InventoryPayload,
  flag: { note: string; severity: string; category: string }
): Promise<CatalogActionState> {
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
  revalidatePath('/catalog');
  revalidatePath(`/catalog/${id}`);
  return { ok: true };
}

export async function resolveItemFlagAction(
  itemId: string,
  item: InventoryPayload,
  flagId: string,
  resolution: string
): Promise<CatalogActionState> {
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
  revalidatePath('/catalog');
  revalidatePath(`/catalog/${id}`);
  return { ok: true };
}

// ─── Kit BOM (#27) — save an equipment model's requirements[] ──────────────────────────────────
export async function saveKitBomAction(itemId: string, requirements: KitRequirement[]): Promise<CatalogActionState> {
  const id = String(itemId ?? '').trim();
  if (!id) return { error: 'Missing item id.' };
  const user = await requireRole('authorized');
  try {
    await saveKitBom({ id, requirements: Array.isArray(requirements) ? requirements : [], actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not save the kit BOM.' };
  }
  revalidatePath('/catalog');
  revalidatePath(`/catalog/${id}`);
  return { ok: true };
}

// ─── CREATE a new inventory item (the inventory "New item" flow) ───────────────────────────────
// Mints a blank bulk item (server-side UUID — a client id is never trusted), names it, inserts it.
// db.write.app (authorized+). Returns the new id so the client can open the editor on it.
export async function createItemAction(name: string): Promise<CatalogActionState & { id?: string }> {
  const user = await requireRole('authorized');
  const cleanName = String(name ?? '').trim() || 'New item';
  try {
    const db = await getDb();
    const col = db.collection<InventoryDoc>('inventory');
    const id = generateId();
    const now = Date.now();
    const payload: InventoryPayload = {
      id,
      slug: id,
      kind: 'peripheral',
      name: cleanName,
      sku: '',
      skuOptions: [],
      qr: '',
      status: null,
      weight: '',
      tracking: 'bulk',
      flags: [],
      units: [],
      distribution: [{ caseId: null, qty: 1, serials: [], state: 'pending' }],
      stockTotal: null,
      reorderPoint: null,
      storageNotes: '',
      tagIds: [],
      requirements: [],
    };
    await col.insertOne({ _id: id, payload, createdAt: now, updatedAt: now, deletedAt: null } as InventoryDoc);
    revalidatePath('/catalog');
    return { ok: true, id };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not create the item.' };
  }
}

// ─── BULK inventory toolbar actions ────────────────────────────────────────────────────────────
export interface BulkActionState extends CatalogActionState {
  count?: number;
  attached?: number;
  refused?: number;
}

/** Bulk reassign the selected items to a case (or detach when caseId is null). db.write.app. */
export async function bulkReassignAction(ids: string[], caseId: string | null): Promise<BulkActionState> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to edit inventory.' };
  }
  try {
    const res = await bulkReassignToCase({ ids, caseId: caseId || null, actorRole: user.role });
    revalidatePath('/catalog');
    return { ok: true, count: res.count };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not reassign the items.' };
  }
}

/** Bulk set the per-case state on the selected items. db.write.app. */
export async function bulkSetStateAction(ids: string[], state: string): Promise<BulkActionState> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to edit inventory.' };
  }
  try {
    const res = await bulkSetState({ ids, state, actorRole: user.role });
    revalidatePath('/catalog');
    return { ok: true, count: res.count };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not set the state.' };
  }
}

/** Bulk soft-delete the selected items. db.write.app. */
export async function bulkDeleteAction(ids: string[]): Promise<BulkActionState> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to delete inventory.' };
  }
  try {
    const res = await bulkDeleteItems({ ids, actorRole: user.role });
    revalidatePath('/catalog');
    return { ok: true, count: res.count };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not delete the items.' };
  }
}

/** Bulk attach the selected items LOOSE to an event. Lead+ (looseitem.manage). */
export async function bulkAttachToEventAction(ids: string[], eventId: string): Promise<BulkActionState> {
  let user: CurrentUser;
  try {
    user = await requireRole('lead');
  } catch {
    return { error: 'You do not have permission to attach loose inventory (lead or higher).' };
  }
  const by = await getUserDisplayName(user.email).catch(() => user.email);
  try {
    const res = await bulkAttachToEvent({ ids, eventId, actorEmail: user.email, actorRole: user.role, actorName: by || user.email });
    revalidatePath('/catalog');
    return { ok: true, attached: res.attached, refused: res.refused };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not attach the items.' };
  }
}

// ─── CSV import (inventory) ────────────────────────────────────────────────────────────────────
export interface InventoryCsvRow {
  id?: string;
  name?: string;
  sku?: string;
  qr?: string;
  kind?: string;
  stockTotal?: number | null;
  reorderPoint?: number | null;
  storageNotes?: string;
  skuOptions?: SkuOption[];
}

/** Commit a dry-run-validated CSV of inventory rows (create / update-by-id). db.write.app (authorized+). */
export async function importInventoryAction(
  rows: InventoryCsvRow[]
): Promise<CatalogActionState & { created?: number; updated?: number }> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to import inventory.' };
  }
  try {
    const res = await applyInventoryCsvImport({
      rows: (Array.isArray(rows) ? rows : []) as InventoryCsvRowInput[],
      actorRole: user.role,
    });
    revalidatePath('/catalog');
    return { ok: true, created: res.created, updated: res.updated };
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Failed to import inventory.' };
  }
}

// createLooseItem is exported by lib/write for the manifest loose-add path; the catalog's create
// flow uses createItemAction (a plain inventory item, not loose-attached). Keep the import live.
void createLooseItem;

/**
 * Soft-delete a catalog item. Same live-role gate. Returns a form-state object; on success the
 * detail page is revalidated and the client redirects back to the list.
 */
export async function deleteItemAction(
  _prev: CatalogActionState,
  formData: FormData
): Promise<CatalogActionState> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing item id.' };

  const user = await requireRole('authorized');

  try {
    await deleteInventoryItem(id, user.role);
  } catch (e) {
    if (e instanceof WriteForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not delete the item.' };
  }

  revalidatePath('/catalog');
  revalidatePath(`/catalog/${id}`);
  return { ok: true };
}
