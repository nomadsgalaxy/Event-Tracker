'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeNdef, type NdefRecordLike, type NfcTagEntry } from '@/lib/nfc-decoders';
import { deriveTagCategory } from '@/lib/scan';

// app/scan/use-nfc-reader.ts — the Web NFC reader hook. Faithful port of index.html useNfcReader
// (~L18190): NDEFReader.scan(), per-tap reading → decodeNdef (the OPT/OpenSpool/OpenTag3D/TigerTag/
// Prusa decoder chain) → an NfcTagEntry the screen routes through findInventoryByScan (UID match) +
// renders via TagDetailsSummary. Errors mirror the source: permission-denied | nfc-unsupported |
// <generic>. supported reflects 'NDEFReader' in window (Chrome Android only today).

// ── Minimal Web NFC structural types (no lib.dom.d.ts coverage) ────────────────────────────────
interface NdefRecord {
  recordType?: string;
  mediaType?: string;
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
interface NdefReaderLike {
  scan(): Promise<void>;
  onreading: ((ev: NdefReadingEvent) => void) | null;
  onreadingerror: (() => void) | null;
  abort?: () => void;
}
interface NdefReaderCtor {
  new (): NdefReaderLike;
}

// Pull text out of a live NDEFRecord (TextDecoder against its data view).
function recordText(rec: NdefRecord): string {
  try {
    if (rec && rec.data && typeof TextDecoder !== 'undefined') {
      const dec = new TextDecoder(rec.encoding || 'utf-8');
      const dv = rec.data as DataView;
      const buf = dv instanceof DataView ? new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength) : new Uint8Array(rec.data as ArrayBuffer);
      return dec.decode(buf);
    }
  } catch {
    /* ignore */
  }
  return '';
}

export interface UseNfcReader {
  supported: boolean;
  active: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
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
          // Normalize to the pure-decoder shape (pre-decode text so the JSON parsers work isomorphic).
          const records: NdefRecordLike[] = liveRecords.map((r) => ({
            recordType: r.recordType || null,
            mediaType: r.mediaType || null,
            encoding: r.encoding || null,
            lang: r.lang || null,
            text: recordText(r),
          }));
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
          const entry: NfcTagEntry = {
            tagUid,
            format: decoded.format,
            category,
            parsed,
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

  useEffect(() => () => stop(), [stop]);

  return { supported, active, error, start, stop };
}
