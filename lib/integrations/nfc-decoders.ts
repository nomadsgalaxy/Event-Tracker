// lib/integrations/nfc-decoders.ts — PURE, isomorphic NDEF tag decoders for the Scan-Pack NFC reader.
//
// Faithful port of the index.html NFC decoder set (~L18058-18290): the parsers run in order
//   OPT → OpenTag3D → OpenSpool → TigerTag (stub) → Prusa Spool legacy → plain
// and the FIRST non-null wins. Each returns { format, parsed } | null. `parsed` follows the
// OPT-shaped schema (a subset of the Open Print Tag fields the TagDetailsSummary card reads). The
// tag UID is captured separately by the reader regardless of which decoder hits.
//
// These are pure (no Web NFC, no DOM) so they're unit-testable + reused by the client hook
// (use-nfc-reader.ts) which feeds them the live NDEFMessage records.

import { decodeCbor, type CborValue } from '@/lib/integrations/cbor';

// ── The OPT-shaped parsed schema (subset) ──────────────────────────────────────────────────────
export interface ParsedTag {
  instance_uuid?: string | null;
  material_class?: 'FFF' | 'SLA' | string | null;
  material_type?: string | null;
  material_name?: string | null;
  brand_name?: string | null;
  manufactured_date?: string | number | null;
  expiration_date?: string | number | null;
  nominal_netto_full_weight?: number | null;
  actual_netto_full_weight?: number | null;
  primary_color?: string | null;
  filament_diameter?: number | null;
  min_print_temperature?: number | null;
  max_print_temperature?: number | null;
  min_bed_temperature?: number | null;
  max_bed_temperature?: number | null;
  // OpenPrintTag extras: density (g/cm³) + the dynamic aux-region usage fields (consumed/remaining
  // grams + free-form storage location) that make spool-consumption tracking possible.
  density?: number | null;
  consumed_weight?: number | null;
  remaining_weight?: number | null;
  storage_location?: string | null;
}

export type TagFormat =
  | 'open-print-tag'
  | 'opentag3d'
  | 'openspool'
  | 'tigertag'
  | 'prusa-spool'
  | 'plain'
  | 'unknown';

export interface DecodedTag {
  format: TagFormat;
  parsed: ParsedTag | null;
}

// A normalized NDEF record shape (the fields the decoders read). The client hook maps the live
// NDEFRecord into this; tests can pass plain objects.
export interface NdefRecordLike {
  recordType?: string | null;
  mediaType?: string | null;
  type?: string | null;
  externalType?: string | null;
  encoding?: string | null;
  lang?: string | null;
  data?: ArrayBuffer | DataView | Uint8Array | null;
  text?: string | null; // pre-decoded text (the hook supplies this for the JSON parsers)
}

// Helper: pull text out of an NDEF record (handles a pre-decoded `text` OR a raw data buffer).
function ndefRecordText(rec: NdefRecordLike): string {
  if (rec && typeof rec.text === 'string' && rec.text) return rec.text;
  try {
    if (rec && rec.data && typeof TextDecoder !== 'undefined') {
      const dec = new TextDecoder(rec.encoding || 'utf-8');
      const buf =
        rec.data instanceof Uint8Array
          ? rec.data
          : rec.data instanceof ArrayBuffer
            ? new Uint8Array(rec.data)
            : rec.data instanceof DataView
              ? new Uint8Array(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength)
              : null;
      if (buf) return dec.decode(buf);
    }
  } catch {
    /* ignore */
  }
  return '';
}

// Helper: pull the raw payload bytes out of an NDEF record (handles Uint8Array / ArrayBuffer / DataView).
// The binary decoders (OpenPrintTag CBOR, OpenTag3D struct) need this; the JSON ones use the text helper.
function ndefRecordBytes(rec: NdefRecordLike): Uint8Array | null {
  const d = rec && rec.data;
  if (!d) return null;
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (d instanceof DataView) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return null;
}

// OpenSpool (https://openspool.io) — single application/json record.
export function parseOpenSpoolNDEF(records: NdefRecordLike[]): DecodedTag | null {
  if (!records || !records.length) return null;
  for (const r of records) {
    if (!r) continue;
    const mt = (r.mediaType || r.type || '').toLowerCase();
    if (mt.indexOf('json') < 0) continue;
    const txt = ndefRecordText(r);
    if (!txt) continue;
    try {
      const obj = JSON.parse(txt) as Record<string, unknown>;
      if (!obj || typeof obj !== 'object') continue;
      if (String(obj.protocol ?? '').toLowerCase() !== 'openspool') continue;
      const colorHex = obj.color_hex != null ? String(obj.color_hex) : '';
      const color = colorHex ? '#' + colorHex.replace(/^#/, '') : null;
      const type = obj.type != null ? String(obj.type) : null;
      const brand = obj.brand != null ? String(obj.brand) : null;
      return {
        format: 'openspool',
        parsed: {
          instance_uuid: null,
          material_class: 'FFF',
          material_type: type,
          material_name: type ? (brand ? brand + ' ' + type : type) : null,
          brand_name: brand,
          manufactured_date: null,
          expiration_date: null,
          nominal_netto_full_weight: null,
          actual_netto_full_weight: null,
          primary_color: color,
          filament_diameter: null,
          min_print_temperature: obj.min_temp != null ? Number(obj.min_temp) : null,
          max_print_temperature: obj.max_temp != null ? Number(obj.max_temp) : null,
          min_bed_temperature: null,
          max_bed_temperature: null,
        },
      };
    } catch {
      /* not valid JSON — try next decoder */
    }
  }
  return null;
}

// ── Open Print Tag (specs.openprinttag.org, MIT, by Prusa) ───────────────────────────────────────
// The OPT NDEF record (MIME application/vnd.openprinttag) carries three concatenated CBOR maps with
// INTEGER keys: a Meta section (at offset 0, declares the region offsets), a Main section (static
// material data), and an optional Aux section (dynamic usage data). Field keys + enums are from the
// canonical spec repo (OpenPrintTag/openprinttag-specification, data/*.yaml). Validated against the
// repo's own encode_decode test vectors.

const OPT_MIME = 'application/vnd.openprinttag';

// material_type enum (key 9) → abbreviation. Index = enum value.
const OPT_MATERIAL_TYPE = [
  'PLA', 'PETG', 'TPU', 'ABS', 'ASA', 'PC', 'PCTG', 'PP', 'PA6', 'PA11', 'PA12', 'PA66', 'CPE', 'TPE',
  'HIPS', 'PHA', 'PET', 'PEI', 'PBT', 'PVB', 'PVA', 'PEKK', 'PEEK', 'BVOH', 'TPC', 'PPS', 'PPSU', 'PVC',
  'PEBA', 'PVDF', 'PPA', 'PCL', 'PES', 'PMMA', 'POM', 'PPE', 'PS', 'PSU', 'TPI', 'SBS', 'OBC', 'EVA',
];

const optNum = (v: CborValue | undefined): number | null =>
  typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null;
const optStr = (v: CborValue | undefined): string | null => (typeof v === 'string' && v ? v : null);

// color_rgba byte string → CSS hex. Drops a fully-opaque alpha; keeps a real alpha as #rrggbbaa.
function optColor(v: CborValue | undefined): string | null {
  if (!(v instanceof Uint8Array) || v.length < 3) return null;
  const h = (n: number) => n.toString(16).padStart(2, '0');
  const base = `#${h(v[0])}${h(v[1])}${h(v[2])}`;
  return v.length >= 4 && v[3] !== 0xff ? `${base}${h(v[3])}` : base;
}

// 16 raw bytes → canonical UUID string.
function uuidFromBytes(v: CborValue | undefined): string | null {
  if (!(v instanceof Uint8Array) || v.length !== 16) return null;
  const h = Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Decode a raw OpenPrintTag NDEF-record payload (the concatenated CBOR sections) into the OPT-shaped
 * ParsedTag. Returns null if the payload isn't a parseable OPT structure. Pure + sync; the optional
 * instance_uuid derivation from the tag UID is async and done by the caller (deriveInstanceUuid).
 */
export function decodeOpenPrintTagPayload(payload: Uint8Array | null): ParsedTag | null {
  if (!payload || payload.length < 1) return null;
  let metaR: { value: CborValue; end: number };
  try {
    metaR = decodeCbor(payload, 0);
  } catch {
    return null;
  }
  if (!(metaR.value instanceof Map)) return null;
  const meta = metaR.value as Map<number, CborValue>;
  const mainOffset = optNum(meta.get(0)) ?? metaR.end; // key 0 = main_region_offset; default after meta
  const auxOffset = optNum(meta.get(2)); // key 2 = aux_region_offset; absent ⇒ no aux region

  let main: Map<number, CborValue> | null = null;
  try {
    const m = decodeCbor(payload, mainOffset).value;
    if (m instanceof Map) main = m as Map<number, CborValue>;
  } catch {
    /* main unreadable */
  }
  if (!main) return null;

  let aux: Map<number, CborValue> | null = null;
  if (auxOffset != null) {
    try {
      const a = decodeCbor(payload, auxOffset).value;
      if (a instanceof Map) aux = a as Map<number, CborValue>;
    } catch {
      /* aux optional */
    }
  }

  const cls = optNum(main.get(8));
  const typeIdx = optNum(main.get(9));
  const actual = optNum(main.get(17)) ?? optNum(main.get(16));
  const consumed = aux ? optNum(aux.get(0)) : null;

  return {
    instance_uuid: uuidFromBytes(main.get(0)),
    material_class: cls === 0 ? 'FFF' : cls === 1 ? 'SLA' : null,
    material_type: typeIdx != null ? (OPT_MATERIAL_TYPE[typeIdx] ?? null) : null,
    material_name: optStr(main.get(10)),
    brand_name: optStr(main.get(11)),
    // OPT timestamps are unix SECONDS; normalize to ms (what new Date()/formatDate expect app-wide).
    manufactured_date: optNum(main.get(14)) != null ? (optNum(main.get(14)) as number) * 1000 : null,
    expiration_date: optNum(main.get(15)) != null ? (optNum(main.get(15)) as number) * 1000 : null,
    nominal_netto_full_weight: optNum(main.get(16)),
    actual_netto_full_weight: optNum(main.get(17)),
    primary_color: optColor(main.get(19)),
    filament_diameter: optNum(main.get(30)) ?? (cls === 0 ? 1.75 : null), // spec default 1.75mm for FFF
    min_print_temperature: optNum(main.get(34)),
    max_print_temperature: optNum(main.get(35)),
    min_bed_temperature: optNum(main.get(37)),
    max_bed_temperature: optNum(main.get(38)),
    density: optNum(main.get(29)),
    consumed_weight: consumed,
    remaining_weight: actual != null && consumed != null ? Math.max(0, actual - consumed) : null,
    storage_location: aux ? optStr(aux.get(4)) : null,
  };
}

export function parseOpenPrintTagNDEF(records: NdefRecordLike[]): DecodedTag | null {
  if (!records || !records.length) return null;
  for (const r of records) {
    if (!r) continue;
    const mt = (r.mediaType || r.type || '').toLowerCase();
    const ext = (r.externalType || '').toLowerCase();
    if (mt.indexOf('openprinttag') >= 0 || ext.indexOf('openprinttag') >= 0 || ext.indexOf('opt') === 0) {
      const parsed = decodeOpenPrintTagPayload(ndefRecordBytes(r));
      // Claim the tag on a MIME match even if the CBOR is unreadable — surfaces "OpenPrintTag, couldn't
      // read" instead of falling through to 'unknown'.
      return { format: 'open-print-tag', parsed: parsed ?? { material_class: 'FFF' } };
    }
  }
  return null;
}

// instance_uuid derivation (spec §3.2.1): UUIDv5 (SHA-1) of the namespace + the 8-byte NFC-V tag UID,
// MSB-first with 0xE0 as the first byte. Async (Web Crypto). The caller uses it only when the tag does
// not carry an explicit instance_uuid. crypto.subtle is available in the browser and in Node 20+.
const OPT_INSTANCE_NS = '31062f81-b5bd-4f86-a5f8-46367e841508';

function uuidStringToBytes(u: string): Uint8Array {
  const h = u.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hexUidToBytes(uid: string): Uint8Array | null {
  const h = uid.replace(/[^0-9a-fA-F]/g, '');
  if (h.length < 2) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Derive the OpenPrintTag instance_uuid from a tag UID hex string (e.g. "E0040108662F6FBC"). */
export async function deriveInstanceUuid(uidHex: string): Promise<string | null> {
  try {
    const uid = hexUidToBytes(uidHex);
    if (!uid || typeof crypto === 'undefined' || !crypto.subtle) return null;
    const ns = uuidStringToBytes(OPT_INSTANCE_NS);
    const name = new Uint8Array(ns.length + uid.length);
    name.set(ns, 0);
    name.set(uid, ns.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', name));
    const b = digest.slice(0, 16);
    b[6] = (b[6] & 0x0f) | 0x50; // version 5
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  } catch {
    return null;
  }
}

// OpenTag3D (opentag3d.info) — detector stub.
export function parseOpenTag3DNDEF(records: NdefRecordLike[]): DecodedTag | null {
  if (!records || !records.length) return null;
  for (const r of records) {
    if (!r) continue;
    const mt = (r.mediaType || r.type || '').toLowerCase();
    const ext = (r.externalType || '').toLowerCase();
    if (mt.indexOf('opentag3d') >= 0 || ext.indexOf('opentag3d') >= 0) {
      return { format: 'opentag3d', parsed: { material_class: 'FFF' } };
    }
  }
  return null;
}

// TigerTag — detector stub (spec stabilizing as of 2026-05).
export function parseTigerTagNDEF(records: NdefRecordLike[]): DecodedTag | null {
  if (!records || !records.length) return null;
  for (const r of records) {
    if (!r) continue;
    const mt = (r.mediaType || r.type || '').toLowerCase();
    const ext = (r.externalType || '').toLowerCase();
    if (mt.indexOf('tigertag') >= 0 || ext.indexOf('tigertag') >= 0) {
      return { format: 'tigertag', parsed: null };
    }
  }
  return null;
}

// Prusa Spool legacy — detector stub.
export function parsePrusaSpoolNDEF(records: NdefRecordLike[]): DecodedTag | null {
  if (!records || !records.length) return null;
  for (const r of records) {
    if (!r) continue;
    const mt = (r.mediaType || r.type || '').toLowerCase();
    const ext = (r.externalType || '').toLowerCase();
    if (mt.indexOf('prusa') >= 0 || ext.indexOf('prusa') >= 0) {
      return { format: 'prusa-spool', parsed: { material_class: 'FFF' } };
    }
  }
  return null;
}

/**
 * Decode an NDEF message's records via the ordered decoder chain. First non-null wins; a plain
 * text/uri record falls back to 'plain'; anything else is 'unknown'. Faithful to _decodeNdef.
 */
export function decodeNdef(records: NdefRecordLike[]): DecodedTag {
  const decoders = [
    parseOpenPrintTagNDEF,
    parseOpenTag3DNDEF,
    parseOpenSpoolNDEF,
    parseTigerTagNDEF,
    parsePrusaSpoolNDEF,
  ];
  for (const d of decoders) {
    try {
      const out = d(records);
      if (out) return out;
    } catch {
      /* ignore a single decoder throwing */
    }
  }
  if (records && records.length) {
    for (const r of records) {
      if (r && (r.recordType === 'text' || r.recordType === 'url' || r.recordType === 'uri')) {
        return { format: 'plain', parsed: null };
      }
    }
  }
  return { format: 'unknown', parsed: null };
}

// A captured tag entry (what the reader hands the screen). Mirrors the index.html `entry` shape.
export interface NfcTagEntry {
  tagUid: string;
  format: TagFormat;
  category: 'filament' | 'resin' | 'generic';
  parsed: ParsedTag | null;
  raw: { records: { recordType: string | null; mediaType: string | null; encoding: string | null; lang: string | null; text: string }[] };
  lastReadAt: number;
}
