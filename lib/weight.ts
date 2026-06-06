// lib/weight.ts — PURE, isomorphic weight-unit helpers (#11/#12).
//
// Weight is STORED canonically in kilograms but ENTERED + SHOWN in the user's preferred unit
// (unitPrefs.weight = 'kg' | 'lbs'). Faithful ports of formatWeight / weightInUnit / parseWeightToKg
// / weightUnitLabel + the case loaded-weight math (index.html ~L3506-3576). No I/O, no 'server-only':
// a Server Component formats after the live DB read and a Client Component reuses the SAME logic so a
// displayed weight never drifts from the value that produced it.

import {
  itemIsSerial,
  itemQtyInCase,
  type InventoryPayload,
} from './inventory-shape';

export type WeightUnit = 'kg' | 'lbs';

const KG_PER_LB = 2.20462;

/** The user's weight-unit label ('kg' | 'lbs'); defaults to 'lbs' (the app default). */
export function weightUnitLabel(unit?: string | null): WeightUnit {
  return unit === 'kg' ? 'kg' : 'lbs';
}

/** Parse a number out of a number-or-string (e.g. "38.4 kg" -> 38.4). NaN-safe -> null. */
function num(v: number | string | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const m = v.match(/-?\d+(\.\d+)?/);
    const n = m ? parseFloat(m[0]) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Format a canonical-kg weight to the user's unit, with the suffix. e.g. "38.4 kg" / "84.7 lbs".
 *  Returns '—' for blank/invalid (mirrors formatWeight). */
export function formatWeight(kg: number | string | null | undefined, unit?: string | null): string {
  const n = num(kg ?? null);
  if (n == null) return '—';
  if (weightUnitLabel(unit) === 'lbs') {
    return (Math.round(n * KG_PER_LB * 10) / 10).toFixed(1) + ' lbs';
  }
  return (Math.round(n * 10) / 10).toFixed(1) + ' kg';
}

/** Canonical kg -> a bare number string in the user's unit (for pre-filling an input — no suffix).
 *  '' for blank/invalid (mirrors weightInUnit). */
export function weightInUnit(kg: number | string | null | undefined, unit?: string | null): string {
  const n = num(kg ?? null);
  if (n == null) return '';
  const v = weightUnitLabel(unit) === 'lbs' ? n * KG_PER_LB : n;
  return String(Math.round(v * 10) / 10);
}

/** Interpret a user-typed weight in their unit and return canonical KILOGRAMS. null for
 *  blank/invalid (mirrors parseWeightToKg). */
export function parseWeightToKg(input: number | string | null | undefined, unit?: string | null): number | null {
  const n = num(input ?? null);
  if (n == null) return null;
  return weightUnitLabel(unit) === 'lbs' ? n / KG_PER_LB : n;
}

/** Σ of packed CONTENTS weight for a case in kg (#12): each item's per-item weight × the qty
 *  routed into THIS case. Excludes the case's own tare. Faithful to caseContentsWeightKg. */
export function caseContentsWeightKg(caseId: string, inventory: InventoryPayload[]): number {
  if (!caseId || !Array.isArray(inventory)) return 0;
  let kg = 0;
  for (const it of inventory) {
    const w = num(it?.weight ?? null);
    if (!w) continue;
    if (itemIsSerial(it)) {
      kg += w * itemQtyInCase(it, caseId);
      continue;
    }
    for (const d of it.distribution || []) {
      if (d && d.caseId === caseId) kg += w * Number(d.qty || 0);
    }
  }
  return kg;
}

/** Loaded weight of a case in kg (#12): tare (case.weight) + packed contents. */
export function caseLoadedWeightKg(
  caseObj: { id?: string; weight?: number | string } | null | undefined,
  inventory: InventoryPayload[]
): number {
  if (!caseObj) return 0;
  const tare = num(caseObj.weight ?? null) || 0;
  return tare + caseContentsWeightKg(caseObj.id ?? '', inventory);
}
