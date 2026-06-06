// lib/types/types-event-detail.ts — the CLIENT-SAFE view shapes for the Event DETAIL page.
//
// These live OUTSIDE lib/event-detail-view.ts (which is 'server-only' — it reaches Mongo-derived
// helpers) so the client tab shell can import the types without pulling the server module. The
// assembler in lib/event-detail-view re-exports these for the page's convenience. Same split rule
// the rest of the rewrite follows (types-dashboard for the client, the *-view/data modules for the
// server-only logic).

import type { ManifestTotals } from '@/lib/views/manifest-view';
import type { HotelInfo, TravelInfo, AccommodationsProfile } from '@/lib/types/types';

/** A resolved, VISIBLE applied-tag chip (hidden tags excluded server-side). */
export interface ResolvedTag {
  id: string;
  label: string;
  flair: string;
  color: string | null;
}

/** One Team-card row: directory-resolved identity + the (already-gated) PII. */
export interface StaffCardView {
  email: string;
  name: string;
  role: string;
  picture: string;
  isLead: boolean;
  /** True iff this staffer IS the viewer (drives the "Print my itinerary" self affordance). */
  isSelf: boolean;
  onsiteStart: string;
  onsiteEnd: string;
  /** PII (already gated server-side): present iff the viewer was allowed to see this staffer's PII. */
  hotel: HotelInfo | null;
  travel: TravelInfo | null;
  /** Accommodations (PII, manager+/self gate): present iff the viewer passed accommodations.view. */
  accommodations: AccommodationsProfile | null;
  /** True iff this viewer may NOT see this staffer's travel — drives the "Request travel info" CTA. */
  canRequest: boolean;
}

/** One Packing-tab case tile: label/slug + per-case packed math + weight + date-conflict advisories. */
export interface CaseTileView {
  id: string;
  label: string;
  slug: string;
  total: number;
  packed: number;
  flagged: number;
  /** Pre-formatted loaded weight in the viewer's unit, or '' when the case has no tare. */
  weight: string;
  conflicts: { eventId: string; name: string; start: string; end: string }[];
}

/** One read-only Pallet: label, case chips, resolved weight, tracking number. */
export interface PalletView {
  id: string;
  label: string;
  caseChips: { id: string; label: string }[];
  weight: string; // pre-formatted loaded weight
  tracking: string;
}

/** One loose-inventory row (display only). */
export interface LooseItemView {
  id: string;
  name: string;
  kind: string;
  qty: number;
  serials: string[];
}

/** One flat Manifest-CSV export row. */
export interface CsvRow {
  itemId: string;
  itemName: string;
  sku: string;
  qr: string;
  caseLabel: string;
  qty: number | '';
  serials: string;
  state: string;
  flags: number;
  signoff: string;
}

/** The whole assembled Event-detail view the client renders. */
export interface EventDetailView {
  staff: StaffCardView[];
  totals: ManifestTotals;
  readiness: { ready: boolean; blockers: string[] };
  caseTiles: CaseTileView[];
  pallets: PalletView[];
  palletLooseChips: { id: string; label: string }[];
  loose: LooseItemView[];
  tags: ResolvedTag[];
  /** Server-built Manifest CSV rows (the "Manifest CSV" header export). */
  csvRows: CsvRow[];
}
