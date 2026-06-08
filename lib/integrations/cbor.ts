// lib/integrations/cbor.ts — a tiny, pure CBOR (RFC 8949) codec, just the subset OpenPrintTag uses.
//
// OpenPrintTag tags carry their sections as CBOR maps with INTEGER keys (see lib/integrations/
// nfc-decoders.ts). This is intentionally minimal — no tags-as-dates, no bignums, no streaming — but it
// handles everything the spec emits: unsigned/negative ints, half/single/double floats, byte strings,
// UTF-8 text strings, arrays, and maps, in BOTH definite and indefinite-length forms (the spec SHOULD-
// encodes containers as indefinite, but real tags also use definite maps, so we accept both).
//
// No DOM, no Node APIs beyond TextDecoder/TextEncoder (both standard in the browser and Node), so it is
// isomorphic and unit-testable.

export type CborValue =
  | number
  | bigint
  | string
  | boolean
  | null
  | Uint8Array
  | CborValue[]
  | Map<CborKey, CborValue>;
export type CborKey = number | string;

const BREAK = Symbol('cbor-break');

interface Reader {
  buf: Uint8Array;
  view: DataView;
  pos: number;
}

function u8(r: Reader): number {
  if (r.pos >= r.buf.length) throw new RangeError('cbor: unexpected end of input');
  return r.buf[r.pos++];
}

// Read the argument that follows the initial byte for additional-info `ai`. Returns the value as a
// number (or bigint for 64-bit values that exceed Number range). `ai` 24/25/26/27 = 1/2/4/8 trailing
// bytes; 0..23 are the value itself; 31 is the indefinite-length marker (caller handles).
function readArg(r: Reader, ai: number): number | bigint {
  if (ai < 24) return ai;
  if (ai === 24) return u8(r);
  if (ai === 25) {
    const v = r.view.getUint16(r.pos);
    r.pos += 2;
    return v;
  }
  if (ai === 26) {
    const v = r.view.getUint32(r.pos);
    r.pos += 4;
    return v;
  }
  if (ai === 27) {
    const v = r.view.getBigUint64(r.pos);
    r.pos += 8;
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  throw new RangeError(`cbor: bad additional info ${ai}`);
}

function asLen(v: number | bigint): number {
  const n = typeof v === 'bigint' ? Number(v) : v;
  if (!Number.isFinite(n) || n < 0) throw new RangeError('cbor: bad length');
  return n;
}

// IEEE-754 half-precision (16-bit) → number. Used for compact floats (the spec emits these to save tag
// space, e.g. a 1.24 density).
function halfToFloat(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  let val: number;
  if (exp === 0) val = frac * 2 ** -24;
  else if (exp === 0x1f) val = frac ? NaN : Infinity;
  else val = (1 + frac / 1024) * 2 ** (exp - 15);
  return sign ? -val : val;
}

function readItem(r: Reader): CborValue | typeof BREAK {
  const ib = u8(r);
  const major = ib >> 5;
  const ai = ib & 0x1f;

  switch (major) {
    case 0: // unsigned int
      return readArg(r, ai);
    case 1: { // negative int = -1 - n
      const n = readArg(r, ai);
      return typeof n === 'bigint' ? -1n - n : -1 - n;
    }
    case 2: { // byte string
      if (ai === 31) return concatChunks(r, true) as Uint8Array;
      const len = asLen(readArg(r, ai));
      const out = r.buf.slice(r.pos, r.pos + len);
      if (out.length !== len) throw new RangeError('cbor: truncated byte string');
      r.pos += len;
      return out;
    }
    case 3: { // text string (UTF-8)
      if (ai === 31) return new TextDecoder('utf-8').decode(concatChunks(r, true) as Uint8Array);
      const len = asLen(readArg(r, ai));
      const slice = r.buf.subarray(r.pos, r.pos + len);
      if (slice.length !== len) throw new RangeError('cbor: truncated text string');
      r.pos += len;
      return new TextDecoder('utf-8').decode(slice);
    }
    case 4: { // array
      const out: CborValue[] = [];
      if (ai === 31) {
        for (;;) {
          const it = readItem(r);
          if (it === BREAK) break;
          out.push(it);
        }
        return out;
      }
      const len = asLen(readArg(r, ai));
      for (let i = 0; i < len; i++) out.push(readItem(r) as CborValue);
      return out;
    }
    case 5: { // map
      const out = new Map<CborKey, CborValue>();
      if (ai === 31) {
        for (;;) {
          const k = readItem(r);
          if (k === BREAK) break;
          out.set(mapKey(k), readItem(r) as CborValue);
        }
        return out;
      }
      const len = asLen(readArg(r, ai));
      for (let i = 0; i < len; i++) {
        const k = readItem(r) as CborValue;
        out.set(mapKey(k), readItem(r) as CborValue);
      }
      return out;
    }
    case 6: // tag — skip the tag number, return the tagged content as-is
      readArg(r, ai);
      return readItem(r) as CborValue;
    case 7: // simple / float / break
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return null; // undefined → null
      if (ai === 25) {
        const v = halfToFloat(r.view.getUint16(r.pos));
        r.pos += 2;
        return v;
      }
      if (ai === 26) {
        const v = r.view.getFloat32(r.pos);
        r.pos += 4;
        return v;
      }
      if (ai === 27) {
        const v = r.view.getFloat64(r.pos);
        r.pos += 8;
        return v;
      }
      if (ai === 31) return BREAK; // indefinite-length break
      return readArg(r, ai) as number; // simple value
    default:
      throw new RangeError(`cbor: bad major type ${major}`);
  }
}

function concatChunks(r: Reader, bytes: boolean): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const it = readItem(r);
    if (it === BREAK) break;
    if (!(it instanceof Uint8Array)) throw new RangeError('cbor: bad indefinite chunk');
    parts.push(it);
    total += it.length;
  }
  void bytes;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function mapKey(k: CborValue | typeof BREAK): CborKey {
  if (typeof k === 'number') return k;
  if (typeof k === 'string') return k;
  if (typeof k === 'bigint') return Number(k);
  throw new RangeError('cbor: unsupported map key type');
}

/** Decode one CBOR item from `buf` starting at `offset`. Returns the value and the byte offset just
 *  past it (so a caller can find where the next region begins). Throws on malformed input. */
export function decodeCbor(buf: Uint8Array, offset = 0): { value: CborValue; end: number } {
  const r: Reader = { buf, view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength), pos: offset };
  const value = readItem(r);
  if (value === BREAK) throw new RangeError('cbor: unexpected break');
  return { value, end: r.pos };
}

// ── Encoder (just what the OpenPrintTag writer needs) ────────────────────────────────────────────

class Writer {
  private parts: number[] = [];
  push(...b: number[]): void {
    for (const x of b) this.parts.push(x & 0xff);
  }
  pushBytes(b: Uint8Array): void {
    for (const x of b) this.parts.push(x);
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
  get length(): number {
    return this.parts.length;
  }
}

function writeHead(w: Writer, major: number, arg: number): void {
  const m = major << 5;
  if (arg < 24) w.push(m | arg);
  else if (arg < 0x100) w.push(m | 24, arg);
  else if (arg < 0x10000) w.push(m | 25, arg >> 8, arg & 0xff);
  else w.push(m | 26, (arg >>> 24) & 0xff, (arg >> 16) & 0xff, (arg >> 8) & 0xff, arg & 0xff);
}

function writeValue(w: Writer, v: CborValue): void {
  if (v === null) {
    w.push(0xf6);
    return;
  }
  if (typeof v === 'boolean') {
    w.push(v ? 0xf5 : 0xf4);
    return;
  }
  if (typeof v === 'bigint') {
    if (v < 0n) {
      writeHead(w, 1, Number(-1n - v));
    } else {
      writeHead(w, 0, Number(v));
    }
    return;
  }
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < 0x100000000) {
      if (v < 0) writeHead(w, 1, -1 - v);
      else writeHead(w, 0, v);
    } else {
      // Non-integer (or very large) → IEEE-754 single. Big tag budget; precision is plenty for the
      // spec's number fields (density, viscosity, color L*a*b*, transmission distance).
      w.push(0xfa);
      const dv = new DataView(new ArrayBuffer(4));
      dv.setFloat32(0, v);
      w.push(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    }
    return;
  }
  if (typeof v === 'string') {
    const enc = new TextEncoder().encode(v);
    writeHead(w, 3, enc.length);
    w.pushBytes(enc);
    return;
  }
  if (v instanceof Uint8Array) {
    writeHead(w, 2, v.length);
    w.pushBytes(v);
    return;
  }
  if (Array.isArray(v)) {
    writeHead(w, 4, v.length);
    for (const el of v) writeValue(w, el);
    return;
  }
  if (v instanceof Map) {
    writeHead(w, 5, v.size);
    for (const [k, val] of v) {
      if (typeof k === 'number') writeHead(w, 0, k);
      else {
        const enc = new TextEncoder().encode(String(k));
        writeHead(w, 3, enc.length);
        w.pushBytes(enc);
      }
      writeValue(w, val);
    }
    return;
  }
  throw new TypeError('cbor: cannot encode value');
}

/** Encode a CBOR map with integer keys (the OpenPrintTag section shape) as a definite-length map. */
export function encodeCborMap(entries: Array<[number, CborValue]>): Uint8Array {
  const w = new Writer();
  writeHead(w, 5, entries.length);
  for (const [k, val] of entries) {
    writeHead(w, 0, k);
    writeValue(w, val);
  }
  return w.bytes();
}
