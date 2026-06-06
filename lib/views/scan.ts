// lib/views/scan.ts — PURE, isomorphic Scan-Pack resolution helpers.
//
// Faithful ports of the index.html Scan-Pack reads + light context resolution the ScanHybrid
// component needs CLIENT-SIDE to route a scan (no I/O, no 'server-only'). The WRITES (pack toggle,
// disposition, loose-add, adopt) all flow through the gated Server Actions in app/scan/actions.ts
// (which delegate to lib/write.ts) — this module only holds the READ-side logic the client uses to
// decide WHICH write to fire and to render the active-case context, so the decision logic can never
// drift from the math that produced the counts (the single-source-of-truth rule).
//
// Mirrors: rowDispositionKind (~L6868), itemCurrentOrLastCase (~L9510), isCodeAdopted (~L6671),
// caseEventContext (~L6887), deriveTagCategory (~L6920), and the scanPolicy role gate (~L6698).

import {
  itemIsSerial,
  itemUnits,
  unitIsDeployed,
  type InventoryPayload,
  type DistributionRow,
  type ItemUnit,
} from '@/lib/views/inventory-shape';
import { rankOf } from '@/lib/auth/rbac';
import type { EventPayload } from '@/lib/types/types';

// ── Disposition vocabulary (unified with Sign-Off, 2026-05-04) ─────────────────────────────────
// The canonical kind set; the scan-return flow cycles null → ok → damaged → consumed → null and
// the bulk "mark unscanned missing" stamps 'missing'.
export type DispositionKind = 'ok' | 'damaged' | 'missing' | 'consumed' | 'other';

/**
 * The disposition recorded on a distribution row (or a synthesized serial row). Reads d.signoff.kind
 * first (canonical), falls back to the legacy d.returnDisposition (mapping 'clean' → 'ok'). Mirrors
 * window.rowDispositionKind (index.html ~L6868). Returns null when nothing is recorded.
 */
export function rowDispositionKind(d: ScanDistRow | null | undefined): DispositionKind | null {
  if (!d) return null;
  if (d.signoff && d.signoff.kind) return d.signoff.kind as DispositionKind;
  if (d.returnDisposition) return (d.returnDisposition === 'clean' ? 'ok' : d.returnDisposition) as DispositionKind;
  return null;
}

// A distribution-row shape the disposition reader tolerates (the canonical signoff.kind + legacy
// flat returnDisposition). Extends the lean DistributionRow with the legacy fields the migration
// hasn't necessarily rewritten yet.
export interface ScanDistRow extends DistributionRow {
  signoff?: { at?: number; by?: string; kind?: string } | null;
  returnDisposition?: string | null;
}

// ── The active-case "expected contents" row (mirrors ScanHybrid.contents, index.html ~L16896) ──
// One row per inventory item routed into the active case. For a SERIAL item the in-case units are
// aggregated into ONE synthesized row (qty = unit count, serials = their S/Ns, state = packed iff
// every unit is packed, signoff = the first unit's signoff iff ALL are signed) so the contents list
// + return disposition keep working uniformly with bulk rows.
export interface ScanContentEntry {
  item: InventoryPayload;
  itemId: string;
  dist: ScanDistRow & { caseId: string; qty: number; serials: string[]; state: 'packed' | 'pending' };
}

/**
 * The expected contents of `caseId`, computed from the live inventory. Faithful to the ScanHybrid
 * `contents` memo: serial items aggregate their in-case units into one synthesized row; bulk items
 * surface their matching distribution row verbatim.
 */
export function caseContents(caseId: string | null, inventory: InventoryPayload[]): ScanContentEntry[] {
  if (!caseId) return [];
  const out: ScanContentEntry[] = [];
  for (const it of inventory || []) {
    const itemId = it.id ?? '';
    if (itemIsSerial(it)) {
      const us = itemUnits(it).filter((u) => u.location === caseId);
      if (!us.length) continue;
      const allSigned = us.every((u) => u.signoff);
      out.push({
        item: it,
        itemId,
        dist: {
          caseId,
          qty: us.length,
          serials: us.map((u) => u.serial).filter((s): s is string => !!s),
          state: us.every((u) => u.state === 'packed') ? 'packed' : 'pending',
          signoff: allSigned ? { ...(us[0].signoff as Record<string, unknown>) } : null,
        },
      });
      continue;
    }
    const d = (it.distribution || []).find((dr) => dr && dr.caseId === caseId) as ScanDistRow | undefined;
    if (d) {
      out.push({
        item: it,
        itemId,
        dist: {
          ...d,
          caseId,
          qty: d.qty ?? 0,
          serials: Array.isArray(d.serials) ? d.serials : [],
          state: d.state === 'packed' ? 'packed' : 'pending',
        },
      });
    }
  }
  return out;
}

// ── Disposition tallies for the unpack counters (mirrors ScanHybrid.dispCounts) ────────────────
export interface DispCounts {
  ok: number;
  damaged: number;
  missing: number;
  consumed: number;
  other: number;
  none: number;
}

export function dispositionCounts(contents: ScanContentEntry[]): DispCounts {
  const c: DispCounts = { ok: 0, damaged: 0, missing: 0, consumed: 0, other: 0, none: 0 };
  for (const r of contents) {
    const d = rowDispositionKind(r.dist);
    if (d && c[d] !== undefined) c[d]++;
    else c.none++;
  }
  return c;
}

// ── Active-context resolution (mirrors caseEventContext, index.html ~L6887) ────────────────────
export type ScanMode = 'pack' | 'unpack' | 'standalone';
export interface CaseContext {
  event: EventPayload | null;
  eventId: string | null;
  isAssigned: boolean;
  mode: ScanMode;
}

const PACK_STATES: ReadonlySet<string> = new Set(['packing', 'ready', 'in_transit', 'onsite']);
const UNPACK_STATES: ReadonlySet<string> = new Set(['returning', 'unpacking']);

/**
 * Resolve the holding event + scan mode for a case. A case held (in cases[]) by an event in a
 * PACK state → { mode:'pack' }; in an UNPACK state → { mode:'unpack' }; otherwise standalone.
 * Mirrors window.caseEventContext. `events` carry their envelope id so callers can navigate/sign-off.
 */
export function caseEventContext(
  caseId: string | null,
  events: { id: string; payload: EventPayload }[]
): CaseContext {
  if (!caseId || !Array.isArray(events)) return { event: null, eventId: null, isAssigned: false, mode: 'standalone' };
  for (const e of events) {
    const p = e.payload;
    // payload.deletedAt isn't on the EventPayload type (the envelope holds the tombstone) but a peer
    // / the /api path can stamp it inside payload — read it defensively via a local cast.
    if (!p || (p as { deletedAt?: number | null }).deletedAt) continue;
    if ((p.cases || []).includes(caseId)) {
      const st = String(p.state);
      if (PACK_STATES.has(st)) return { event: p, eventId: e.id, isAssigned: true, mode: 'pack' };
      if (UNPACK_STATES.has(st)) return { event: p, eventId: e.id, isAssigned: true, mode: 'unpack' };
    }
  }
  return { event: null, eventId: null, isAssigned: false, mode: 'standalone' };
}

// ── Code adoption guard (mirrors isCodeAdopted, index.html ~L6671) ─────────────────────────────
export interface AdoptInfo {
  adopted: boolean;
  by?: { itemId: string; kind: 'qr' | 'sku' | 'id' | 'serial' };
}

/**
 * Strict equality of `code` across qr / sku / skuOptions[] / id / serials[] (bulk + serial) over the
 * live inventory. Used by the UnknownScanModal adoption guard so a code already linked to an item
 * can't be re-adopted onto a different one. Faithful to window.isCodeAdopted.
 */
export function isCodeAdopted(items: { id: string; payload: InventoryPayload }[], code: string | null | undefined): AdoptInfo {
  if (!code || !Array.isArray(items)) return { adopted: false };
  const needle = String(code).trim().toLowerCase();
  if (!needle) return { adopted: false };
  for (const { id, payload: it } of items) {
    if (!it) continue;
    if (it.qr && String(it.qr).toLowerCase() === needle) return { adopted: true, by: { itemId: id, kind: 'qr' } };
    if (it.sku && String(it.sku).toLowerCase() === needle) return { adopted: true, by: { itemId: id, kind: 'sku' } };
    for (const o of Array.isArray(it.skuOptions) ? it.skuOptions : []) {
      if (o && o.sku && String(o.sku).trim().toLowerCase() === needle) return { adopted: true, by: { itemId: id, kind: 'sku' } };
    }
    if (id && String(id).toLowerCase() === needle) return { adopted: true, by: { itemId: id, kind: 'id' } };
    for (const d of it.distribution || []) {
      for (const s of d.serials || []) {
        if (String(s).toLowerCase() === needle) return { adopted: true, by: { itemId: id, kind: 'serial' } };
      }
    }
    for (const u of Array.isArray(it.units) ? it.units : []) {
      if (u && !u.deletedAt && u.serial && String(u.serial).toLowerCase() === needle)
        return { adopted: true, by: { itemId: id, kind: 'serial' } };
    }
  }
  return { adopted: false };
}

// ── Current/last case resolution (mirrors itemCurrentOrLastCase, index.html ~L9510) ─────────────
export interface ItemCaseResolution {
  caseId: string | null;
  status: 'current' | 'last' | 'none';
  at?: number;
}

/**
 * Where an item currently lives (a case it's deployed in) or where it was last seen (the most
 * recently signed-off case). Drives the "scan an item with no active case" route + the Last-scan
 * shortcut. Faithful to window.itemCurrentOrLastCase.
 */
export function itemCurrentOrLastCase(item: InventoryPayload): ItemCaseResolution {
  if (itemIsSerial(item)) {
    const deployed = itemUnits(item).filter(unitIsDeployed);
    if (deployed.length > 0) {
      const packed = deployed.find((u) => u.state === 'packed');
      return { caseId: ((packed || deployed[0]).location as string) ?? null, status: 'current' };
    }
    return { caseId: null, status: 'none' };
  }
  const dist = (Array.isArray(item.distribution) ? item.distribution : []).filter((d) => d && d.caseId) as ScanDistRow[];
  if (dist.length === 0) return { caseId: null, status: 'none' };
  const active = dist.filter((d) => !d.signoff);
  if (active.length > 0) {
    const packed = active.find((d) => d.state === 'packed');
    return { caseId: (packed || active[0]).caseId ?? null, status: 'current' };
  }
  const signed = dist
    .filter((d) => d.signoff && d.signoff.at)
    .sort((a, b) => (b.signoff?.at || 0) - (a.signoff?.at || 0));
  if (signed.length > 0) return { caseId: signed[0].caseId ?? null, status: 'last', at: signed[0].signoff?.at };
  return { caseId: dist[0].caseId ?? null, status: 'last' };
}

// ── Manual-picker search predicate (mirrors ManualItemPicker matches, index.html ~L17615) ───────
/**
 * Does an item match the Find-item query? name/sku/kind/qr substring OR any serial (bulk
 * distribution serials + serial-item unit serials). Faithful to the ManualItemPicker predicate.
 */
export function itemMatchesManualQuery(it: InventoryPayload, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = ((it.name || '') + ' ' + (it.sku || '') + ' ' + (it.kind || it.type || '') + ' ' + (it.qr || '')).toLowerCase();
  if (hay.indexOf(needle) >= 0) return true;
  const inSerials =
    (it.distribution || []).some((d) => (d.serials || []).some((s) => String(s).toLowerCase().indexOf(needle) >= 0)) ||
    (Array.isArray(it.units) ? it.units : []).some((u) => u && u.serial && String(u.serial).toLowerCase().indexOf(needle) >= 0);
  return inSerials;
}

// ── Tag category (mirrors deriveTagCategory, index.html ~L6920) ────────────────────────────────
export type TagCategory = 'filament' | 'resin' | 'generic';
export function deriveTagCategory(parsed: { material_class?: string | null } | null | undefined): TagCategory {
  if (!parsed) return 'generic';
  const cls = parsed.material_class;
  if (cls === 'FFF') return 'filament';
  if (cls === 'SLA') return 'resin';
  return 'generic';
}

// ── Scan auth gates (mirrors scanPolicy, index.html ~L6698) ────────────────────────────────────
// EXPRESSED THROUGH can()/rankOf so the client UI hides exactly what the server enforces. The gates:
//   • canPack / canReturn / canUnPack — scan.pack (authorized+, #65)
//   • canAdopt — scan.label (lead+) — associate a new code with an item
//   • canAddLoose — looseitem.manage (lead+)
export interface ScanPolicy {
  canPack: boolean;
  canReturn: boolean;
  canUnPack: boolean;
  canAdopt: boolean;
  canAddLoose: boolean;
}

export function scanPolicy(role: string | null | undefined): ScanPolicy {
  const rank = rankOf(role);
  return {
    canPack: rank >= 1,
    canReturn: rank >= 1,
    canUnPack: rank >= 1,
    canAdopt: rank >= 2,
    canAddLoose: rank >= 2,
  };
}

// ── Lean serializable shapes the Scan page hands the client island ─────────────────────────────
// The page projects the live Mongo docs to these (no Mongo internals cross the RSC boundary).
export interface ScanItemLean {
  id: string;
  payload: InventoryPayload;
}

export interface ScanCaseLean {
  id: string;
  slug: string; // human slug (or '' when === id)
  label: string;
  zone: string;
  retired: boolean;
}

export interface ScanEventLean {
  id: string;
  payload: EventPayload;
}

// Re-exports so the client island imports the unit/row types from one place.
export type { DistributionRow, ItemUnit };
