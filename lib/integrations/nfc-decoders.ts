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

// Open Print Tag (specs.openprinttag.org) — minimum-viable detector (the full spec is binary k/v).
export function parseOpenPrintTagNDEF(records: NdefRecordLike[]): DecodedTag | null {
  if (!records || !records.length) return null;
  for (const r of records) {
    if (!r) continue;
    const mt = (r.mediaType || r.type || '').toLowerCase();
    const ext = (r.externalType || '').toLowerCase();
    if (mt.indexOf('openprinttag') >= 0 || ext.indexOf('openprinttag') >= 0 || ext.indexOf('opt') === 0) {
      return { format: 'open-print-tag', parsed: { material_class: 'FFF' } };
    }
  }
  return null;
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
