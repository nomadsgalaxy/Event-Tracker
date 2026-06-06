'use server';

import { revalidatePath } from 'next/cache';
import { requireRole, type CurrentUser } from '@/lib/auth/auth';
import {
  createWarehouse,
  saveWarehouse,
  deleteWarehouse,
  saveEmergencyContact,
  WriteForbiddenError,
  type WarehousePatch,
  type EmergencyContactPayload,
} from '@/lib/db/write';

// app/warehouses/actions.ts — the warehouse CRUD + emergency-contact Server Actions.
//
// Every write re-resolves the caller's LIVE role via requireRole (a demotion takes effect
// immediately) and persists through lib/write.ts, which RE-GATES the precise capability against the
// live role — the caller NEVER writes Mongo directly. Warehouse writes need `pallets.edit`
// (authorized+ — the warehouse-worker tier that homes a case at a warehouse); the emergency contact
// needs `emergency_contact.write` (manager+ — the supervisor tier in eit_perms). On success we
// revalidate the warehouse + catalog paths (warehouses are a filter axis inside Catalog) so the next
// render reflects the write.

export interface WarehouseFormValues {
  name: string;
  type: 'hq' | 'sub';
  street: string;
  city: string;
  region: string;
  postal: string;
  country: string;
  phone: string;
  contactName: string;
  contactRole: string;
  contactEmail: string;
  lat?: number | null;
  lng?: number | null;
}

export interface WarehouseActionResult {
  ok?: boolean;
  error?: string;
  /** Set by createWarehouseAction — the new warehouse id. */
  id?: string;
}

function buildPatch(values: WarehouseFormValues): WarehousePatch {
  return {
    name: String(values.name ?? ''),
    type: values.type === 'hq' ? 'hq' : 'sub',
    street: String(values.street ?? ''),
    city: String(values.city ?? ''),
    region: String(values.region ?? ''),
    postal: String(values.postal ?? ''),
    country: String(values.country ?? ''),
    phone: String(values.phone ?? ''),
    contactName: String(values.contactName ?? ''),
    contactRole: String(values.contactRole ?? ''),
    contactEmail: String(values.contactEmail ?? ''),
    lat: values.lat ?? null,
    lng: values.lng ?? null,
  };
}

function revalidateWarehouses(id?: string) {
  revalidatePath('/warehouses');
  revalidatePath('/catalog');
  if (id) revalidatePath(`/warehouses/${id}`);
}

/** CREATE a warehouse (the "Add warehouse" form). pallets.edit (authorized+). */
export async function createWarehouseAction(values: WarehouseFormValues): Promise<WarehouseActionResult> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to manage warehouses.' };
  }
  if (!String(values.name ?? '').trim()) return { error: 'Warehouse name is required.' };
  try {
    const res = await createWarehouse({ patch: buildPatch(values), actorRole: user.role });
    revalidateWarehouses(res.id);
    return { ok: true, id: res.id };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Failed to create the warehouse.' };
  }
}

/** SAVE (update) a warehouse. pallets.edit (authorized+). */
export async function saveWarehouseAction(id: string, values: WarehouseFormValues): Promise<WarehouseActionResult> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to manage warehouses.' };
  }
  const wid = String(id ?? '').trim();
  if (!wid) return { error: 'Missing warehouse id.' };
  if (!String(values.name ?? '').trim()) return { error: 'Warehouse name is required.' };
  try {
    await saveWarehouse({ id: wid, patch: buildPatch(values), actorRole: user.role });
    revalidateWarehouses(wid);
    return { ok: true };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Failed to save the warehouse.' };
  }
}

/** DELETE a warehouse (soft tombstone). pallets.edit (authorized+). */
export async function deleteWarehouseAction(id: string): Promise<WarehouseActionResult> {
  let user: CurrentUser;
  try {
    user = await requireRole('authorized');
  } catch {
    return { error: 'You do not have permission to manage warehouses.' };
  }
  const wid = String(id ?? '').trim();
  if (!wid) return { error: 'Missing warehouse id.' };
  try {
    await deleteWarehouse({ id: wid, actorRole: user.role });
    revalidateWarehouses(wid);
    return { ok: true };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Failed to delete the warehouse.' };
  }
}

/** SAVE or CLEAR (rec=null) the single fleet-wide emergency contact. emergency_contact.write
 *  (manager+). */
export async function saveEmergencyContactAction(rec: EmergencyContactPayload | null): Promise<WarehouseActionResult> {
  let user: CurrentUser;
  try {
    user = await requireRole('manager');
  } catch {
    return { error: 'You do not have permission to set the emergency contact (manager or higher).' };
  }
  try {
    await saveEmergencyContact({ rec, actorRole: user.role });
    revalidateWarehouses();
    return { ok: true };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Failed to save the emergency contact.' };
  }
}
