// lib/integrations/eitm.ts — the `eitm:` payload codec. SINGLE SOURCE OF TRUTH, PURE + isomorphic (no I/O, no
// 'server-only'): the Scan screen imports parseEitm/decodeScanPayload to DECODE a typed-or-scanned
// code, and the label/manifest render path imports eitmCode to ENCODE the SAME payload onto a Data
// Matrix — so a code encoded here always decodes there.
//
// Faithful port of index.html's eitDeployment codec (~L6167-6241):
//   payload  = `eitm:<tenantHash36>:<kind>:<id>`
//   eitm     — fixed prefix identifying an Event-Inventory-Tracker code
//   tenantHash36 — DJB2 hash of the lowercased tenant name, base36 (gates cross-deployment scans)
//   kind     — 'c'(ase) / 'i'(tem) / 'e'(vent)
//   id       — the entity's RAW id, verbatim; last field so it may itself contain '-' (matched
//              greedily). ids never contain ':'.
// The text format round-trips ANY id losslessly (the old fixed-width binary codec truncated
// variable-length slugs). Data Matrix holds this comfortably (~22-30 chars at 1"x1").

export type EitmKind = 'c' | 'i' | 'e';
export type DecodedKind = 'case' | 'item' | 'event';

/** DJB2 (unsigned 32-bit) of a string — mirrors index.html eitDeployment.djb2. */
export function djb2(s: string): number {
  let h = 5381 >>> 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (((h * 33) >>> 0) ^ str.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * The deploy tenant hash (base36 DJB2 of the LOWERCASED tenant name) the `eitm:` payload embeds.
 * Mirrors index.html eitDeployment.tenantHash36 AND app/scan/page.tsx's inline tenantHash36, so a
 * code encoded with this hash decodes (and tenant-gates) identically on the scan side. Empty string
 * when no tenant is configured (the tenant check is then skipped — matches the source).
 */
export function tenantHash36(tenant: string | null | undefined): string {
  const t = String(tenant || '').toLowerCase();
  if (!t) return '';
  return djb2(t).toString(36);
}

/** Resolve the deploy tenant id from the environment (server-only call sites). Mirrors the scan
 *  page's `EIT_TENANT_ID || MONGO_DB` precedence so both planes embed the same hash. */
export function deployTenantHash36(): string {
  return tenantHash36(process.env.EIT_TENANT_ID || process.env.MONGO_DB || '');
}

/**
 * Build an `eitm:<hash>:<kind>:<id>` payload. `tenantHash` defaults to the deploy hash from the env
 * (server-side); pass it explicitly from a Server Component that already computed it (avoids
 * re-reading the env, and lets a client caller thread the hash down as a prop). Returns '' for an
 * empty id OR an empty tenant hash — mirrors index.html encodeCaseMatrix/encodeItemMatrix/
 * encodeEventMatrix ("no deployment tenant set; code not encoded"): a hash-less `eitm::…` payload
 * would NOT round-trip through parseEitm's regex (which requires ≥1 hash char), so we never emit one.
 */
export function eitmCode(kind: EitmKind, id: string, tenantHash?: string): string {
  if (!id) return '';
  const h = tenantHash ?? deployTenantHash36();
  if (!h) return '';
  return `eitm:${h}:${kind}:${String(id)}`;
}

// Convenience encoders matching index.html's encodeCaseMatrix / encodeItemMatrix / encodeEventMatrix.
export const caseCode = (id: string, tenantHash?: string) => eitmCode('c', id, tenantHash);
export const itemCode = (id: string, tenantHash?: string) => eitmCode('i', id, tenantHash);
export const eventCode = (id: string, tenantHash?: string) => eitmCode('e', id, tenantHash);

export interface ParsedEitm {
  kind: DecodedKind;
  id: string;
  /** base36 tenant hash from the payload (lowercased); compare to tenantHash36() to gate scans. */
  tenantHash: string;
}

/**
 * Parse an `eitm:<hash>:<kind>:<id>` payload. Returns null for any non-EIT text (which then falls
 * through to a free-text qr/sku/serial lookup on the scan side). Mirrors index.html
 * decodeScanPayload exactly (same regex, greedy id, case-insensitive kind).
 */
export function parseEitm(text: string | null | undefined): ParsedEitm | null {
  if (!text || typeof text !== 'string') return null;
  // eitm:<hash>:<kind>:<id...> — kind c(ase)/i(tem)/e(vent); id captured greedily (may contain '-').
  const m = text.trim().match(/^eitm:([0-9a-z]+):([cie]):(.+)$/i);
  if (!m) return null;
  const k = m[2].toLowerCase();
  return {
    kind: k === 'c' ? 'case' : k === 'e' ? 'event' : 'item',
    id: m[3],
    tenantHash: m[1].toLowerCase(),
  };
}
