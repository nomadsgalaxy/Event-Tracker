// app/signoff/signoff-types.ts — the lean, serializable shapes the Sign-Off page seeds and the
// client screen renders. Kept separate from the page (a Server Component) so the client island can
// import the TYPES without dragging server-only code across the boundary.

import type { ManifestCaseGroup } from '@/lib/manifest-view';

export type SignoffVariant = 'packing' | 'unpacking';

/** One row in the LEFT pool list (the variant-specific mini progress bar). */
export interface SignoffEventRow {
  id: string;
  name: string;
  city: string;
  state: string;
  headSigned: number; // cases boxed (packing) | items signed (unpacking)
  headTotal: number;
  flagged: number;
  ready: boolean;
}

/** PACKING: one assigned roadcase group — the shared ManifestCaseCard data + the box state. */
export interface SignoffCaseGroup {
  group: ManifestCaseGroup;
  boxed: boolean;
  boxedByName: string | null;
  /** Pre-formatted "Mon D" boxed date (server-side, to avoid a hydration mismatch). '' when unboxed. */
  boxedAtLabel: string;
  hasFlags: boolean;
}

/** UNPACKING: one per-item return sign-off row (a case route, a serial-in-case, or a loose row). */
export interface SignoffReturnRow {
  itemId: string;
  name: string;
  caseId: string | null; // null => loose row
  caseLabel: string;
  loose: boolean;
  distIdx: number; // the distribution index (loose rows pin by this)
  signed: boolean;
  dispositionKind: string | null; // ok|damaged|missing|consumed|other when signed
  signedByName: string | null;
  /** Pre-formatted "Mon D" sign-off date (server-side). '' when unsigned. */
  signedAtLabel: string;
  hasFlags: boolean;
  openFlagCount: number;
}

/** A case the loose item can be MOVED into (the event's own assigned cases). */
export interface LooseTargetCase {
  id: string;
  label: string;
}

/** An event the loose item can be SENT to (draft|upcoming|packing). */
export interface LooseTargetEvent {
  id: string;
  name: string;
  state: string;
}
