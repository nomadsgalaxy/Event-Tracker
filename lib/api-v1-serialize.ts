import 'server-only';
import { viewerLeadsEvent } from './event-view';
import { keyCan } from './api-v1';
import type { VerifiedKey } from './api-keys';
import { buildCaseManifest } from './case-view';
import { itemInStorage, itemStockTotal, itemTotalQty, itemRollupState, type InventoryPayload } from './inventory-shape';
import type { EventPayload, CasePayload } from './types';

// lib/api-v1-serialize.ts — wire shapes for the /api/v1 surface.
//
// The PII strip here is gated by THE KEY's scope, not just the owner's role: a key that wasn't scoped
// to staff.pii.view never sees staff travel/hotel even if its owner could in the UI. Same per-staffer
// self/lead logic as lib/event-view.stripEventPii, but every gate runs through keyCan(vk, …) so the
// scope ∩ owner-caps invariant holds for reads too.

const lc = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** Strip each staffer's hotel/travel/accommodations for the staffers THIS KEY may not see. Never
 *  mutates the input. Identical tiering to stripEventPii but gated by keyCan (scope ∩ owner-caps). */
export function stripEventForKey(payload: EventPayload, vk: VerifiedKey): EventPayload {
  const staff = payload.staff;
  if (!Array.isArray(staff)) return payload;
  const leads = viewerLeadsEvent(payload, vk.ownerEmail);
  const me = lc(vk.ownerEmail);
  const next: EventPayload = { ...payload };
  next.staff = staff.map((s) => {
    if (!s || typeof s !== 'object') return s;
    const se = lc(s.email);
    const isSelf = !!se && se === me;
    const seePii = keyCan(vk, 'staff.pii.view', { isSelf, isLeadOfEvent: leads });
    const seeAcc = keyCan(vk, 'accommodations.view', { isSelf });
    if (seePii && seeAcc) return s;
    const { hotel, travel, accommodations, ...base } = s;
    const out = { ...base } as typeof s;
    if (seePii) {
      if (hotel !== undefined) out.hotel = hotel;
      if (travel !== undefined) out.travel = travel;
    }
    if (seeAcc && accommodations !== undefined) out.accommodations = accommodations;
    return out;
  });
  return next;
}

/** A flat inventory item with resolved stock figures (the shape the MCP get_item expects). */
export function serializeItem(id: string, it: InventoryPayload): Record<string, unknown> {
  return {
    ...it,
    id: it.id ?? id,
    inStorage: itemInStorage(it),
    stockTotal_resolved: itemStockTotal(it),
    totalDeployed: itemTotalQty(it),
    rollupState: itemRollupState(it),
  };
}

/** A case plus its packed manifest rows + summary counts (the shape the MCP get_case expects). */
export function serializeCase(id: string, c: CasePayload, inventory: InventoryPayload[]): Record<string, unknown> {
  const manifest = buildCaseManifest(id, inventory);
  return {
    case: { ...c, id: c.id ?? id },
    items: manifest.rows,
    summary: { total: manifest.total, scanned: manifest.scanned, pending: manifest.pending, flagged: manifest.flagged },
  };
}

/** The per-case manifest list for an event (the shape the MCP get_event expects). */
export function eventManifest(payload: EventPayload, inventory: InventoryPayload[]): { caseId: string; items: unknown[] }[] {
  const caseIds = Array.isArray(payload.cases) ? payload.cases : [];
  return caseIds.map((cid) => ({ caseId: String(cid), items: buildCaseManifest(String(cid), inventory).rows }));
}
