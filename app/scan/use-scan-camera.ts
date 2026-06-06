'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// app/scan/use-scan-camera.ts — the live CAMERA scanner hook. Faithful port of index.html
// useScanCamera (~L17719): native BarcodeDetector where available, a LAZY @zxing/browser fallback
// for Data Matrix / Aztec on iOS Safari (and any browser without a BarcodeDetector that exposes
// data_matrix). Decodes Data Matrix / Aztec / QR / 1D. Surfaces a tap-to-commit detection OVERLAY:
// each decode notes the code's corner geometry + raw payload and resets a 400ms debounce-clear, so
// the highlight tracks the code and disappears once it leaves the frame. The detection is NOT
// auto-fired in the source — but onScan IS called per decode (fireScan, throttled) so a steady read
// commits without a tap; commit() lets the UI also fire the last detection on a tap.
//
// SECURITY/ENV: getUserMedia requires a secure context (https OR localhost — both are dev-friendly).
// rear camera via facingMode 'environment' (ideal). Error states mirror the source:
//   permission-denied | no-camera | camera-unsupported | <generic message>.

const FORMATS = ['data_matrix', 'aztec', 'qr_code', 'code_128', 'code_39', 'ean_13', 'upc_a'];

export interface Detection {
  points: { x: number; y: number }[];
  videoW: number;
  videoH: number;
  at: number;
  decoded: { text: string; format: string } | null;
}

export interface ScanResult {
  text: string;
  format: string;
  at: number;
}

// Minimal structural types for the experimental BarcodeDetector + @zxing/browser so we don't pull
// `any` (and so the typecheck stays honest about what we touch).
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string; format: string; cornerPoints?: { x: number; y: number }[] }[]>;
}
interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

export interface UseScanCamera {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  active: boolean;
  error: string | null;
  usingFallback: boolean;
  start: () => Promise<void>;
  stop: () => void;
  detection: Detection | null;
  commit: () => boolean;
}

export function useScanCamera(opts: { onScan?: (r: ScanResult) => void; throttleMs?: number }): UseScanCamera {
  const onScan = opts.onScan;
  const throttleMs = opts.throttleMs || 1200;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  // @zxing/browser reader (typed loose — the lib has no first-party d.ts for this surface here).
  const zxingReaderRef = useRef<{ reset?: () => void } | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const lastTextRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const tickingRef = useRef(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [detection, setDetection] = useState<Detection | null>(null);
  const detectionRef = useRef<Detection | null>(null);
  const detectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(function stop() {
    tickingRef.current = false;
    if (controlsRef.current) {
      try {
        controlsRef.current.stop();
      } catch {
        /* ignore */
      }
      controlsRef.current = null;
    }
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      streamRef.current = null;
    }
    if (zxingReaderRef.current) {
      try {
        zxingReaderRef.current.reset?.();
      } catch {
        /* ignore */
      }
      zxingReaderRef.current = null;
    }
    if (videoRef.current) {
      try {
        videoRef.current.srcObject = null;
      } catch {
        /* ignore */
      }
    }
    if (detectionTimerRef.current) {
      clearTimeout(detectionTimerRef.current);
      detectionTimerRef.current = null;
    }
    detectionRef.current = null;
    setDetection(null);
    setActive(false);
  }, []);

  // Each decode replaces geometry + payload + resets a 400ms debounce-clear so the overlay tracks
  // the code and clears once it leaves the frame.
  const noteDetection = useCallback(function noteDetection(
    points: { x: number; y: number }[],
    videoW: number,
    videoH: number,
    decoded: { text: string; format: string } | null
  ) {
    if (!points || points.length < 3) return;
    const next: Detection = { points, videoW, videoH, at: Date.now(), decoded };
    detectionRef.current = next;
    setDetection(next);
    if (detectionTimerRef.current) clearTimeout(detectionTimerRef.current);
    detectionTimerRef.current = setTimeout(() => {
      detectionRef.current = null;
      setDetection(null);
      detectionTimerRef.current = null;
    }, 400);
  }, []);

  const fireScan = useCallback(
    function fireScan(text: string, format: string) {
      const now = Date.now();
      const prev = lastTextRef.current;
      if (text === prev.text && now - prev.at < throttleMs) return;
      lastTextRef.current = { text, at: now };
      if (typeof onScan === 'function') {
        try {
          onScan({ text, format: format || 'unknown', at: now });
        } catch (e) {
          console.warn('[scanner] onScan threw:', e);
        }
      }
    },
    [onScan, throttleMs]
  );

  // Commit the current detection on a tap (clears the highlight on success).
  const commit = useCallback(
    function commit(): boolean {
      const d = detectionRef.current;
      if (!d || !d.decoded || !d.decoded.text) return false;
      fireScan(d.decoded.text, d.decoded.format || 'unknown');
      detectionRef.current = null;
      setDetection(null);
      if (detectionTimerRef.current) {
        clearTimeout(detectionTimerRef.current);
        detectionTimerRef.current = null;
      }
      return true;
    },
    [fireScan]
  );

  const start = useCallback(
    async function start() {
      setError(null);
      try {
        let useNative = false;
        let nativeFormats = FORMATS.slice();
        const BD = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
        if (BD) {
          try {
            const supported = await BD.getSupportedFormats();
            nativeFormats = FORMATS.filter((f) => supported.indexOf(f) >= 0);
            if (nativeFormats.indexOf('data_matrix') >= 0) useNative = true;
          } catch {
            /* fall through to ZXing */
          }
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          const err = new Error('camera-unsupported');
          err.name = 'NotSupportedError';
          throw err;
        }
        // HD ideal so a 1" Data Matrix at arm's length has enough px/module; min keeps older devices.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920, min: 640 },
            height: { ideal: 1080, min: 480 },
          },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', 'true');
          videoRef.current.muted = true;
          await videoRef.current.play();
        }
        setActive(true);

        if (useNative && BD) {
          setUsingFallback(false);
          detectorRef.current = new BD({ formats: nativeFormats });
          tickingRef.current = true;
          const tick = async () => {
            if (!tickingRef.current || !streamRef.current || !videoRef.current || !detectorRef.current) return;
            try {
              const codes = await detectorRef.current.detect(videoRef.current);
              if (codes && codes.length > 0) {
                const v = videoRef.current;
                const c0 = codes[0];
                noteDetection(c0.cornerPoints || [], v.videoWidth || 0, v.videoHeight || 0, {
                  text: c0.rawValue,
                  format: c0.format,
                });
                fireScan(c0.rawValue, c0.format);
              }
            } catch {
              /* a single detect tick throwing is non-fatal */
            }
            if (tickingRef.current) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        } else {
          setUsingFallback(true);
          // LAZY-load @zxing/browser + @zxing/library so they're only fetched when actually needed
          // (iOS Safari + any browser whose BarcodeDetector lacks data_matrix).
          const { BrowserMultiFormatReader, BarcodeFormat } = await import('@zxing/browser');
          const { DecodeHintType } = await import('@zxing/library');
          // The hints map is keyed by the DecodeHintType enum VALUE (a number at runtime) — typing
          // it as Map<number, unknown> avoids using the dynamically-imported enum as a TS type.
          const hints = new Map<number, unknown>();
          // Hint ZXing to scan only the formats we care about + TRY_HARDER (better off-axis reads).
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.AZTEC,
            BarcodeFormat.QR_CODE,
            BarcodeFormat.DATA_MATRIX,
            BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39,
            BarcodeFormat.EAN_13,
            BarcodeFormat.UPC_A,
          ]);
          hints.set(DecodeHintType.TRY_HARDER, true);
          const reader = new BrowserMultiFormatReader(hints as never);
          zxingReaderRef.current = reader as unknown as { reset?: () => void };
          if (videoRef.current) {
            const controls = await reader.decodeFromVideoElement(videoRef.current, (result, err, ctrl) => {
              if (!controlsRef.current && ctrl) controlsRef.current = ctrl;
              if (result) {
                const text = result.getText ? result.getText() : '';
                const fmt = result.getBarcodeFormat ? String(result.getBarcodeFormat()).toLowerCase() : 'unknown';
                try {
                  const pts = result.getResultPoints ? result.getResultPoints() : null;
                  if (pts && pts.length >= 3 && videoRef.current && text) {
                    const mapped: { x: number; y: number }[] = [];
                    for (const p of pts) {
                      const pp = p as unknown as { getX?: () => number; getY?: () => number; x?: number; y?: number };
                      if (typeof pp.getX === 'function' && typeof pp.getY === 'function') mapped.push({ x: pp.getX(), y: pp.getY() });
                      else if (typeof pp.x === 'number' && typeof pp.y === 'number') mapped.push({ x: pp.x, y: pp.y });
                    }
                    noteDetection(mapped, videoRef.current.videoWidth || 0, videoRef.current.videoHeight || 0, {
                      text,
                      format: fmt,
                    });
                  }
                } catch {
                  /* geometry is best-effort */
                }
                if (text) fireScan(text, fmt);
              }
              void err;
            });
            controlsRef.current = controls;
          }
        }
      } catch (e) {
        const err = e as { name?: string; message?: string };
        const name = err?.name;
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') setError('permission-denied');
        else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') setError('no-camera');
        else if (name === 'NotSupportedError') setError('camera-unsupported');
        else setError(err?.message || 'camera-error');
        setActive(false);
        try {
          stop();
        } catch {
          /* ignore */
        }
      }
    },
    [fireScan, noteDetection, stop]
  );

  useEffect(() => () => stop(), [stop]);

  return { videoRef, active, error, usingFallback, start, stop, detection, commit };
}
