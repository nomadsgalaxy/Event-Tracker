// lib/integrations/nfc-encoders.ts — PURE encoders that turn an item's material data into a writable
// NDEF record payload, so a blank NFC tag can be programmed from Event Tracker.
//
// Two formats, matching the decoders in nfc-decoders.ts:
//   • OpenPrintTag — MIME application/vnd.openprinttag, payload = Meta + Main (+ Aux) CBOR sections.
//   • OpenSpool    — MIME application/json, a single { protocol:"openspool", ... } object.
//
// Pure + isomorphic (TextEncoder + the cbor codec only). The Web NFC write itself lives in the client
// hook (use-nfc-reader.ts); these just build the bytes. NOTE: Web NFC writes the NDEF payload but can't
// set OpenPrintTag's SLIX2 hardware write-protection, so tags written from a browser stay rewritable.

import { encodeCborMap, type CborValue } from '@/lib/integrations/cbor';

const OPT_MATERIAL_TYPE = [
  'PLA', 'PETG', 'TPU', 'ABS', 'ASA', 'PC', 'PCTG', 'PP', 'PA6', 'PA11', 'PA12', 'PA66', 'CPE', 'TPE',
  'HIPS', 'PHA', 'PET', 'PEI', 'PBT', 'PVB', 'PVA', 'PEKK', 'PEEK', 'BVOH', 'TPC', 'PPS', 'PPSU', 'PVC',
  'PEBA', 'PVDF', 'PPA', 'PCL', 'PES', 'PMMA', 'POM', 'PPE', 'PS', 'PSU', 'TPI', 'SBS', 'OBC', 'EVA',
];

export interface TagEncodeInput {
  material_class?: string | null; // 'FFF' | 'SLA'
  material_type?: string | null; // abbreviation, e.g. 'PLA'
  material_name?: string | null;
  brand_name?: string | null;
  primary_color?: string | null; // '#rrggbb' or '#rrggbbaa'
  nominal_netto_full_weight?: number | null; // g
  actual_netto_full_weight?: number | null; // g
  filament_diameter?: number | null; // mm
  min_print_temperature?: number | null;
  max_print_temperature?: number | null;
  min_bed_temperature?: number | null;
  max_bed_temperature?: number | null;
  density?: number | null;
  manufactured_date?: number | null; // unix seconds
  expiration_date?: number | null; // unix seconds
  consumed_weight?: number | null; // g (aux)
  storage_location?: string | null; // aux
}

export interface EncodedTagRecord {
  mediaType: string;
  data: Uint8Array;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// '#rrggbb' / '#rrggbbaa' → 3 or 4 raw bytes. Drops a fully-opaque alpha.
function colorBytes(hex: string | null | undefined): Uint8Array | null {
  if (!hex) return null;
  const h = hex.replace(/^#/, '');
  if (h.length !== 6 && h.length !== 8) return null;
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) {
    const b = parseInt(h.slice(i, i + 2), 16);
    if (Number.isNaN(b)) return null;
    out.push(b);
  }
  if (out.length === 4 && out[3] === 0xff) out.pop();
  return Uint8Array.from(out);
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/**
 * Build an OpenPrintTag NDEF-record payload from material data. Returns { mediaType, data } ready for
 * NDEFReader.write. Always writes a Main section; adds an Aux section (with the meta region offset) only
 * when there's dynamic data (consumed weight / storage location) to store.
 */
export function encodeOpenPrintTag(input: TagEncodeInput): EncodedTagRecord {
  const main: Array<[number, CborValue]> = [];
  const cls = (input.material_class || 'FFF').toUpperCase() === 'SLA' ? 1 : 0;
  main.push([8, cls]); // material_class (required)
  if (input.material_type) {
    const idx = OPT_MATERIAL_TYPE.indexOf(input.material_type.toUpperCase());
    if (idx >= 0) main.push([9, idx]);
  }
  if (input.material_name) main.push([10, input.material_name]);
  if (input.brand_name) main.push([11, input.brand_name]);
  // ParsedTag carries dates in ms (app-wide); OPT stores unix seconds.
  if (isNum(input.manufactured_date)) main.push([14, Math.round(input.manufactured_date / 1000)]);
  if (isNum(input.expiration_date)) main.push([15, Math.round(input.expiration_date / 1000)]);
  if (isNum(input.nominal_netto_full_weight)) main.push([16, Math.round(input.nominal_netto_full_weight)]);
  if (isNum(input.actual_netto_full_weight)) main.push([17, Math.round(input.actual_netto_full_weight)]);
  const color = colorBytes(input.primary_color);
  if (color) main.push([19, color]);
  if (isNum(input.density)) main.push([29, input.density]);
  if (isNum(input.filament_diameter)) main.push([30, input.filament_diameter]);
  if (isNum(input.min_print_temperature)) main.push([34, Math.round(input.min_print_temperature)]);
  if (isNum(input.max_print_temperature)) main.push([35, Math.round(input.max_print_temperature)]);
  if (isNum(input.min_bed_temperature)) main.push([37, Math.round(input.min_bed_temperature)]);
  if (isNum(input.max_bed_temperature)) main.push([38, Math.round(input.max_bed_temperature)]);

  const aux: Array<[number, CborValue]> = [];
  if (isNum(input.consumed_weight)) aux.push([0, Math.round(input.consumed_weight)]);
  if (input.storage_location) aux.push([4, input.storage_location.slice(0, 8)]);

  const mainBytes = encodeCborMap(main);
  let data: Uint8Array;
  if (aux.length === 0) {
    // Empty meta map → main region defaults to right after it. No aux region.
    data = concat(encodeCborMap([]), mainBytes);
  } else {
    const auxBytes = encodeCborMap(aux);
    // The aux offset's own encoded width changes the meta length; iterate to a fixed point.
    let off = mainBytes.length + 4;
    let metaBytes = encodeCborMap([[2, off]]);
    for (let i = 0; i < 6; i++) {
      const next = metaBytes.length + mainBytes.length;
      if (next === off) break;
      off = next;
      metaBytes = encodeCborMap([[2, off]]);
    }
    data = concat(metaBytes, mainBytes, auxBytes);
  }
  return { mediaType: 'application/vnd.openprinttag', data };
}

/**
 * Build an OpenSpool NDEF-record payload (a single application/json record). OpenSpool is deliberately
 * minimal: material type, color, brand, and nozzle temp range. Returns { mediaType, data }.
 */
export function encodeOpenSpool(input: TagEncodeInput): EncodedTagRecord {
  const colorHex = (input.primary_color || '').replace(/^#/, '').slice(0, 6).toUpperCase();
  const obj: Record<string, string> = {
    protocol: 'openspool',
    version: '1.0',
    type: input.material_type || 'PLA',
    color_hex: colorHex || 'FFFFFF',
    brand: input.brand_name || 'Generic',
    min_temp: isNum(input.min_print_temperature) ? String(Math.round(input.min_print_temperature)) : '',
    max_temp: isNum(input.max_print_temperature) ? String(Math.round(input.max_print_temperature)) : '',
  };
  return { mediaType: 'application/json', data: new TextEncoder().encode(JSON.stringify(obj)) };
}
