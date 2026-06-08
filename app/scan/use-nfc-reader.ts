'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeNdef, deriveInstanceUuid, type NdefRecordLike, type NfcTagEntry } from '@/lib/integrations/nfc-decoders';
import { deriveTagCategory } from '@/lib/views/scan';

// app/scan/use-nfc-reader.ts — the Web NFC reader hook. Faithful port of index.html useNfcReader
// (~L18190): NDEFReader.scan(), per-tap reading → decodeNdef (the OPT/OpenSpool/OpenTag3D/TigerTag/
// Prusa decoder chain) → an NfcTagEntry the screen routes through findInventoryByScan (UID match) +
// renders via TagDetailsSummary. Errors mirror the source: permission-denied | nfc-unsupported |
// <generic>. supported reflects 'NDEFReader' in window (Chrome Android only today).

// ── Minimal Web NFC structural types (no lib.dom.d.ts coverage) ────────────────────────────────
interface NdefRecord {
  recordType?: string;
  mediaType?: string;
  externalType?: string;
  encoding?: string;
  lang?: string;
  data?: DataView | ArrayBuffer;
}
interface NdefMessage {
  records: NdefRecord[];
}
interface NdefReadingEvent {
  serialNumber?: string;
  message?: NdefMessage;
}
interface NdefWriteRecord {
  recordType: string;
  mediaType?: string;
  data?: Uint8Array | ArrayBuffer | string;
}
interface NdefReaderLike {
  scan(): Promise<void>;
  write?: (msg: { records: NdefWriteRecord[] }) => Promise<void>;
  onreading: ((ev: NdefReadingEvent) => void) | null;
  onreadingerror: (() => void) | null;
  abort?: () => void;
}
interface NdefReaderCtor {
  new (): NdefReaderLike;
}

// Copy a live NDEFRecord's payload into a standalone Uint8Array (the backing buffer may be reused).
function recordBytes(rec: NdefRecord): Uint8Array | null {
  const d = rec && rec.data;
  if (!d) return null;
  if (d instanceof DataView) return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
  if (d instanceof ArrayBuffer) return new Uint8Array(d.slice(0));
  return null;
}

// Pull text out of a live NDEFRecord (TextDecoder against its data view) — for the JSON decoders.
function recordText(rec: NdefRecord): string {
  try {
    const buf = recordBytes(rec);
    if (buf && typeof TextDecoder !== 'undefined') return new TextDecoder(rec.encoding || 'utf-8').decode(buf);
  } catch {
    /* ignore */
  }
  return '';
}

export interface NfcWriteResult {
  ok: boolean;
  error?: string;
}

export interface UseNfcReader {
  supported: boolean;
  active: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  writeTag: (rec: { mediaType: string; data: Uint8Array }) => Promise<NfcWriteResult>;
}

export function useNfcReader(opts: { onTag?: (entry: NfcTagEntry) => void }): UseNfcReader {
  const onTag = opts.onTag;
  const supported = typeof window !== 'undefined' && 'NDEFReader' in window;
  const readerRef = useRef<NdefReaderLike | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(function stop() {
    try {
      readerRef.current?.abort?.();
    } catch {
      /* ignore */
    }
    readerRef.current = null;
    setActive(false);
  }, []);

  const start = useCallback(
    async function start() {
      if (!supported) {
        setError('nfc-unsupported');
        return;
      }
      setError(null);
      try {
        const Ctor = (window as unknown as { NDEFReader: NdefReaderCtor }).NDEFReader;
        const reader = new Ctor();
        readerRef.current = reader;
        reader.onreadingerror = () => {
          /* swallow per-tap errors */
        };
        reader.onreading = (event: NdefReadingEvent) => {
          const tagUid = event.serialNumber || '';
          const liveRecords: NdefRecord[] = event.message && event.message.records ? Array.from(event.message.records) : [];
          // Normalize to the pure-decoder shape: forward the raw bytes (the binary OpenPrintTag/OpenTag3D
          // decoders need them) AND a pre-decoded text (the JSON decoders use that), isomorphic.
          const records: NdefRecordLike[] = liveRecords.map((r) => ({
            recordType: r.recordType || null,
            mediaType: r.mediaType || null,
            externalType: r.externalType || null,
            encoding: r.encoding || null,
            lang: r.lang || null,
            data: recordBytes(r),
            text: recordText(r),
          }));
          // Persisted raw is text only — never store the raw binary buffer on the record.
          const rawRecords = records.map((r) => ({
            recordType: r.recordType || null,
            mediaType: r.mediaType || null,
            encoding: r.encoding || null,
            lang: r.lang || null,
            text: r.text || '',
          }));
          const decoded = decodeNdef(records);
          const parsed = decoded.parsed || null;
          const category = deriveTagCategory(parsed);
          const fire = (p: typeof parsed) => {
            const entry: NfcTagEntry = {
              tagUid,
              format: decoded.format,
              category,
              parsed: p,
              raw: { records: rawRecords },
              lastReadAt: Date.now(),
            };
            if (typeof onTag === 'function') {
              try {
                onTag(entry);
              } catch (e) {
                console.warn('[nfc] onTag threw:', e);
              }
            }
          };
          // OpenPrintTag often omits instance_uuid and relies on deriving it from the tag UID. Do that
          // (async) before surfacing, so the spool has a stable identity; fall back to the bare read.
          if (decoded.format === 'open-print-tag' && tagUid && parsed && !parsed.instance_uuid) {
            deriveInstanceUuid(tagUid)
              .then((uuid) => fire(uuid ? { ...parsed, instance_uuid: uuid } : parsed))
              .catch(() => fire(parsed));
          } else {
            fire(parsed);
          }
        };
        await reader.scan();
        setActive(true);
      } catch (e) {
        const err = e as { name?: string; message?: string };
        const name = err?.name;
        if (name === 'NotAllowedError') setError('permission-denied');
        else if (name === 'NotSupportedError') setError('nfc-unsupported');
        else setError(err?.message || 'nfc-error');
        setActive(false);
      }
    },
    [supported, onTag]
  );

  // Program a blank (or rewritable) tag with a single MIME record. Web NFC's write() prompts for the tap
  // itself; it must be called from a user gesture. Returns a result instead of throwing.
  const writeTag = useCallback(
    async function writeTag(rec: { mediaType: string; data: Uint8Array }): Promise<NfcWriteResult> {
      if (!supported) return { ok: false, error: 'nfc-unsupported' };
      try {
        const Ctor = (window as unknown as { NDEFReader: NdefReaderCtor }).NDEFReader;
        const reader = new Ctor();
        if (!reader.write) return { ok: false, error: 'nfc-write-unsupported' };
        await reader.write({ records: [{ recordType: 'mime', mediaType: rec.mediaType, data: rec.data }] });
        return { ok: true };
      } catch (e) {
        const err = e as { name?: string; message?: string };
        if (err?.name === 'NotAllowedError') return { ok: false, error: 'permission-denied' };
        return { ok: false, error: err?.message || 'nfc-write-error' };
      }
    },
    [supported]
  );

  useEffect(() => () => stop(), [stop]);

  return { supported, active, error, start, stop, writeTag };
}
