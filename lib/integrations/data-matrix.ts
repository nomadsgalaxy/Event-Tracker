import 'server-only';
import { toSVG } from 'bwip-js/node';

// lib/integrations/data-matrix.ts — the Data Matrix ENCODER (server-only). Mirrors index.html's bwip-js label
// builder (~L18432): bwip-js, bcid:'datamatrix', no human-readable text, deterministic. The Python
// app loaded bwip-js v3 in the browser (only toCanvas) and transcribed canvas pixels into <rect>s;
// bwip-js v4 (installed here) exposes toSVG directly, so we get a crisp, path-based, deterministic
// SVG with no canvas/DOM dependency — ideal for server-side render-and-print.
//
// Data Matrix was chosen over QR/Aztec for the same reason the source documents: at the ~22-30 char
// `eitm:` payload it auto-sizes to a compact symbol with bigger modules-per-inch than QR Type 1.
// Reed-Solomon ECC is built into the symbol-size table (no configurable percent — symbol size is
// picked automatically to fit payload + ECC), so there's no ecc option to thread.
//
// These labels PRINT: the output must render server-side (RSC) and be byte-stable for a given
// payload. bwip-js is deterministic, so the same payload always yields the same SVG.

export interface DataMatrixOpts {
  /** bwip-js `scale` (device units per module). Default 2 (bwip's default) — the SVG is sized by the
   *  consumer via CSS width/height, so this only affects path coordinate granularity, not crispness. */
  module?: number;
}

/**
 * Encode `payload` to an inline Data Matrix SVG string (black modules on a transparent background,
 * no human-readable text, a 1-module quiet zone per the DM spec). Returns '' for an empty payload.
 * Throws if bwip-js fails to encode — the caller (RSC / component) catches and falls back to the
 * plain-text code so a render never crashes.
 */
export function dataMatrixSvg(payload: string, opts?: DataMatrixOpts): string {
  if (!payload) return '';
  const svg = toSVG({
    bcid: 'datamatrix',
    text: String(payload),
    includetext: false,
    // 1-module quiet zone on each side (DM spec) — bwip pads in modules here.
    paddingwidth: 1,
    paddingheight: 1,
    // Black modules; the background stays transparent so the consumer's white tile shows through
    // (a Data Matrix scans as dark-on-light — the component supplies the light tile).
    barcolor: '000000',
    ...(opts?.module ? { scale: opts.module } : {}),
  });
  if (!svg || typeof svg !== 'string') throw new Error('datamatrix encode produced no SVG');
  return svg;
}

/** True iff bwip-js produced a non-empty SVG for `payload` (used by the roundtrip self-check). */
export function canEncode(payload: string): boolean {
  try {
    return dataMatrixSvg(payload).length > 0;
  } catch {
    return false;
  }
}
