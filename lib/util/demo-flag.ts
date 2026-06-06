// lib/util/demo-flag.ts — the CLIENT-safe demo flag (NOT server-only, so client islands can import it).
// Mirrors the server EIT_DEMO_MODE via NEXT_PUBLIC_DEMO_MODE (set in next.config). Used purely for UX
// — rendering admin/config controls visible-but-disabled + the demo banner. The real lock is enforced
// SERVER-SIDE (lib/demo denyInDemo / demoDenied); this never gates anything security-relevant.
export const IS_DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === '1';

/** Standard helper text shown next to a disabled admin/config control in the demo. */
export const DEMO_LOCK_NOTE = 'Read-only in the demo — you can set this on your own deployment.';
