// lib/util/money.ts — tiny isomorphic money formatter. Inventory items store a plain per-unit USD
// amount (purchasePrice / replacementCost); the Condition & Loss report values shrinkage from them.
// There is no per-org currency preference yet, so USD is the default — pass a code to override.
// Mirrors lib/util/weight.ts: pure, no I/O, safe on both server and client.

const DEFAULT_CURRENCY = 'USD';

/** Format an amount as currency. null/NaN -> em dash. Falls back to a bare $ string if Intl throws. */
export function formatMoney(amount: number | null | undefined, currency: string = DEFAULT_CURRENCY): string {
  if (amount == null) return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}
