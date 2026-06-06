// lib/util/id.ts — the entity-id generator. ONE scheme for events, cases, items, warehouses, and tags so
// every id is the SAME length + format (a 6-char string from a 64-char alphabet). A faithful port of
// the Python app's window.generateId (index.html ~L2636), which is what produced the existing 6-char
// ids (e.g. `1ch4MY`, `tS3khU`, `pVh1Dc`). The Next.js rebuild previously minted entity ids with
// node:crypto randomUUID() (36 chars), which made item ids — and their Data Matrix payloads — far
// longer than cases/events. This restores parity.
//
// The id segment of an `eitm:` Data-Matrix payload is parsed greedily, so the `-`/`_` in the alphabet
// round-trip through the scan decoder fine.

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A 6-char entity id. BigInt math (Date.now() × a large random) so the low bits aren't zeroed by
 *  53-bit float precision — verbatim from the Python generator, so ids match the existing data. */
export function generateId(): string {
  let n = BigInt(Date.now()) * BigInt(1 + Math.floor(Math.random() * 1e9));
  let id = '';
  for (let i = 0; i < 6; i++) {
    id = ID_ALPHABET[Number(n & 63n)] + id;
    n = n >> 6n;
  }
  return id;
}

/** Like generateId, but regenerates on collision against a caller-held set (use in bulk loops — CSV
 *  imports — where many ids are minted in the same millisecond). */
export function generateUniqueId(used?: Set<string>): string {
  let id = generateId();
  while (used && used.has(id)) id = generateId();
  return id;
}

/** True for one of our 6-char ids (mirrors the Python isUuidFormat). */
export function isEntityId(s: unknown): boolean {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{6}$/.test(s);
}
