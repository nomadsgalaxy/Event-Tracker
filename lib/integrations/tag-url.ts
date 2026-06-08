// lib/integrations/tag-url.ts — the universal-read tag URL. When we WRITE an NFC tag, we add an NDEF
// URI record alongside the OpenPrintTag/OpenSpool data record. iOS and Android both open a URI record
// natively on tap (Web NFC reading is Android-only), so this is how EVERY platform can read the tag.
//
// The URL points at the app's public /t viewer and carries the material data in the FRAGMENT (after
// '#'): the fragment is never sent to the server, so there is no DB read, no auth, and no inventory
// exposure — the page renders only what the tag itself carries. Pure + isomorphic (used by the writer
// in the browser and by the /t page).

import type { ParsedTag } from '@/lib/integrations/nfc-decoders';
import type { TagEncodeInput } from '@/lib/integrations/nfc-encoders';

// Compact wire object (short keys to keep the URL small enough to sit beside the data record on a tag).
interface TagWire {
  n?: string; // material name
  b?: string; // brand
  t?: string; // material type abbreviation
  c?: 'FFF' | 'SLA' | string; // material class
  k?: string; // primary color hex
  w?: number; // nominal net weight (g)
  aw?: number; // actual net weight (g)
  np?: number; // min print temp
  xp?: number; // max print temp
  nb?: number; // min bed temp
  xb?: number; // max bed temp
  di?: number; // filament diameter
  de?: number; // density
  mf?: number; // manufactured date (ms)
  ex?: number; // expiration date (ms)
  rm?: number; // remaining weight (g)
  sl?: string; // storage location
}

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const numOrU = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const strOrU = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Build the `/t#…` viewer URL for a tag's material data. `input` is the same shape the encoders take
 *  (plus optional remaining/storage from a read). Returns origin + '/t#' + base64url(JSON). */
export function buildTagViewerUrl(
  input: TagEncodeInput & { remaining_weight?: number | null; storage_location?: string | null },
  origin: string,
): string {
  const w: TagWire = {};
  const setS = (k: keyof TagWire, v: unknown) => {
    const s = strOrU(v);
    if (s) (w[k] as unknown) = s;
  };
  const setN = (k: keyof TagWire, v: unknown) => {
    const n = numOrU(v);
    if (n != null) (w[k] as unknown) = n;
  };
  setS('n', input.material_name);
  setS('b', input.brand_name);
  setS('t', input.material_type);
  setS('c', input.material_class);
  setS('k', input.primary_color);
  setN('w', input.nominal_netto_full_weight);
  setN('aw', input.actual_netto_full_weight);
  setN('np', input.min_print_temperature);
  setN('xp', input.max_print_temperature);
  setN('nb', input.min_bed_temperature);
  setN('xb', input.max_bed_temperature);
  setN('di', input.filament_diameter);
  setN('de', input.density);
  setN('mf', input.manufactured_date);
  setN('ex', input.expiration_date);
  setN('rm', input.remaining_weight);
  setS('sl', input.storage_location);
  const base = (origin || '').replace(/\/+$/, '');
  return `${base}/t#${b64urlEncode(JSON.stringify(w))}`;
}

/** Decode a `/t` fragment (with or without the leading '#') back into a ParsedTag for display. Returns
 *  null if the fragment is missing or unparseable. */
export function decodeTagViewerFragment(hash: string): ParsedTag | null {
  const frag = (hash || '').replace(/^#/, '').trim();
  if (!frag) return null;
  let w: TagWire;
  try {
    w = JSON.parse(b64urlDecode(frag)) as TagWire;
  } catch {
    return null;
  }
  if (!w || typeof w !== 'object') return null;
  const actual = numOrU(w.aw) ?? numOrU(w.w) ?? null;
  return {
    instance_uuid: null,
    material_class: w.c ?? null,
    material_type: w.t ?? null,
    material_name: w.n ?? null,
    brand_name: w.b ?? null,
    manufactured_date: numOrU(w.mf) ?? null,
    expiration_date: numOrU(w.ex) ?? null,
    nominal_netto_full_weight: numOrU(w.w) ?? null,
    actual_netto_full_weight: actual,
    primary_color: w.k ?? null,
    filament_diameter: numOrU(w.di) ?? null,
    min_print_temperature: numOrU(w.np) ?? null,
    max_print_temperature: numOrU(w.xp) ?? null,
    min_bed_temperature: numOrU(w.nb) ?? null,
    max_bed_temperature: numOrU(w.xb) ?? null,
    density: numOrU(w.de) ?? null,
    consumed_weight: null,
    remaining_weight: numOrU(w.rm) ?? null,
    storage_location: w.sl ?? null,
  };
}
