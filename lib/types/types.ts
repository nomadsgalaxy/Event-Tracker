// The Mongo envelope every collection uses — identical to the Python version's shape
// (so both stacks read the SAME data for a fair comparison).
export interface Envelope<P> {
  _id: string;
  payload: P;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number | null;
}

export type EventState =
  | 'draft'
  | 'upcoming'
  | 'packing'
  | 'ready'
  | 'in_transit'
  | 'onsite'
  | 'returning'
  | 'unpacking'
  | 'closed';

// ── Staffer hotel / travel / accommodations (PII — server-gated) ────────────────────────────
// Mirrors the per-staffer shapes the Python EventDetail/EventForm read/write. HotelInfo (the
// HotelEditor's fields, index.html ~L12509) carries the lodging + a front-desk phone; TravelInfo
// is { mode, outbound, return } where each leg is a TravelLeg. AccommodationsProfile mirrors the
// AccommodationsSummary/AccommodationsEditor shape (dietary/allergies/accessibility/medical/
// emergency contacts/notes). These are STRIPPED server-side for viewers without the matching cap.

export interface HotelInfo {
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  room?: string;
  phone?: string;
  checkInAt?: string;
  checkOutAt?: string;
  confirmation?: string;
  notes?: string;
  // 1–5 stay rating ("was this hotel good?"). Rated per staffer stay in the editor; the
  // /api/hotel-suggestions aggregate averages it across past stays so planning a new event in the
  // same city surfaces "we've stayed here before" with a verdict.
  rating?: number;
  [k: string]: unknown;
}

export interface TravelLeg {
  carrier?: string;
  number?: string;
  departLocation?: string;
  arriveLocation?: string;
  departAt?: string;
  arriveAt?: string;
  confirmation?: string;
  // Live flight tracking (stamped by the background auto-refresh, lib/integrations/flight-refresh):
  // the normalized status + departure delay from FlightAware. Additive + optional — manual legs and
  // non-flight modes never set them.
  status?: 'on_time' | 'delayed' | 'cancelled' | 'departed' | 'arrived' | 'diverted' | string;
  delayMin?: number; // minutes the revised departure runs past the scheduled time (0 when on time)
  lastCheckedAt?: number; // ms epoch of the last provider refresh for this leg
  // The SCHEDULED departure date (YYYY-MM-DD) + UTC instant, captured once from the lookup and then
  // IMMUTABLE — the auto-refresh queries by flightDate (so a delay across local midnight can't shift
  // the query date) and windows by departUtc (offset-clean, so a far-timezone leg isn't dropped early).
  flightDate?: string;
  departUtc?: number;
  // Live-progress anchors (FlightAware): the ATC/ICAO ident (the OpenSky callsign) + the best
  // actual/estimated departure + arrival instants, for the in-air progress display.
  identIcao?: string;
  departActualUtc?: number;
  arriveEstUtc?: number;
  [k: string]: unknown;
}

export interface TravelInfo {
  mode?: 'flight' | 'train' | 'drive' | string;
  outbound?: TravelLeg;
  return?: TravelLeg;
  // MULTI-LEG journeys: connection legs AFTER the primary outbound/return leg, in travel order —
  // e.g. outbound SFO→ORD (outbound) then ORD→ATW (outboundConnections[0]). The primary leg stays in
  // outbound/return so every single-leg reader keeps working; readers that understand connections
  // render the full chain ([outbound, ...outboundConnections]) with layovers between legs.
  outboundConnections?: TravelLeg[];
  returnConnections?: TravelLeg[];
  [k: string]: unknown;
}

export interface AccommodationAllergy {
  text?: string;
  severity?: 'mild' | 'severe' | 'epipen' | string;
}

export interface EmergencyContact {
  name?: string;
  relationship?: string;
  phone?: string;
  email?: string;
}

export interface AccommodationsProfile {
  dietary?: string[];
  accessibility?: string[];
  allergies?: AccommodationAllergy | null;
  medical?: string;
  notes?: string;
  emergencyContact?: EmergencyContact | null;
  emergencyContacts?: EmergencyContact[];
  updatedAt?: number;
  [k: string]: unknown;
}

/** Post-event feedback one staffer submitted about their own experience (the "How was your stay?"
 *  survey shown after an event ends). 1–5 ratings; the hotel rating is ALSO mirrored onto
 *  hotel.rating so it feeds the past-stay suggestions. Open shape — future data points (food,
 *  logistics, booth traffic…) ride as extra keys without a schema change. Stripped server-side
 *  with the same gate as hotel/travel (comments are personal opinions). */
export interface StafferFeedback {
  event?: number; // overall event, 1–5
  venue?: number; // 1–5
  hotel?: number; // 1–5 (mirrored to staffer.hotel.rating on submit)
  comments?: string;
  submittedAt?: number; // ms epoch of the LAST submit (resubmit allowed — updates in place)
  [k: string]: unknown;
}

export interface Staffer {
  email?: string;
  name?: string;
  role?: string;
  hotel?: HotelInfo; // PII — gated server-side, never sent to a non-privileged client
  travel?: TravelInfo; // PII — gated server-side
  feedback?: StafferFeedback; // post-event survey — gated like hotel/travel (see stripEventPii)
  onsiteStart?: string;
  onsiteEnd?: string;
  // Display fields resolved server-side from the directory (picture/display name) for the Team
  // cards. NOT persisted on the event doc — populated when the detail page hydrates staff rows.
  picture?: string;
  // The subject's accommodations profile (PII — manager+/self only), threaded onto the staffer
  // ONLY for a viewer who passed accommodations.view. Absent otherwise (never crosses the wire).
  accommodations?: AccommodationsProfile | null;
}

// ── Side events (after-parties / community events on an event) ──────────────────────────────
// Mirrors the EventForm side-event rows (index.html ~L12778): { name, date, time, venue, notes }.
export interface SideEvent {
  name?: string;
  date?: string;
  time?: string;
  venue?: string;
  notes?: string;
}

// ── Pallets (#24/#62) — the logistics overlay grouping an event's cases for shipment ────────
// Mirrors window.eventPallets shape (index.html ~L5458): { id, label, caseIds[], tracking, notes }.
export interface EventPallet {
  id: string;
  label?: string;
  caseIds?: string[];
  tracking?: string;
  notes?: string;
}

// ── Venue point-of-contact (exhibitor-services rep) ─────────────────────────────────────────
// Mirrors venue.contact (index.html EventForm ~L12990): { name, role, email, phone }.
export interface VenueContact {
  name?: string;
  role?: string;
  email?: string;
  phone?: string;
}

export interface ShipLeg {
  carrier?: string;
  tracking?: string;
  pickupDate?: string;
  pickupTime?: string;
  arrivalDate?: string;
  arrivalTime?: string;
  notes?: string;
}

// A booth setup / teardown WINDOW — a datetime-local range the Calendar renders as an hour-grid
// block (Week view) and a logistics segment chip (Month view). The live seed (events.payload.setup
// / .teardown) carries exactly { start, end } as datetime-local strings ("2026-06-12T12:00"); the
// Python Calendar (CalWeek / buildSegmentIndex ~index.html L22738) reads those two fields, so this
// is the minimal shape needed for 1:1 logistics parity. Absent from a draft event with no windows
// set → the chips/blocks simply don't render.
export interface SetupWindow {
  start?: string; // datetime-local "YYYY-MM-DDTHH:MM"
  end?: string; // datetime-local "YYYY-MM-DDTHH:MM"
}

// Per-roadcase OUTBOUND sign-off (#28). Outbound (packing) sign-off operates at the roadcase level:
// a lead attests "this case is boxed" once per case. Scoped to the EVENT (event.caseSignoffs[caseId])
// so it clears on close/reassign and can't leak to a later event reusing the case. Mirrors
// index.html signOffCase (~L3741): caseSignoffs[caseId] = { by:{email,name,role}, at }.
export interface CaseSignoffBy {
  email?: string;
  name?: string;
  role?: string;
}

export interface CaseSignoff {
  by?: CaseSignoffBy;
  at?: number;
}

// ── Manifest snapshot of record (#28 / sign-off) ───────────────────────────────────────────
// A static, self-contained freeze of an event's manifest captured at ship time, stored verbatim on
// event.signoff.manifestSnapshot so it can be re-rendered/printed/reconciled months later without
// depending on the live inventory. Mirrors buildManifestSnapshot (index.html ~L3778). Kept as a
// structural type so the print + check-in-sweep code is type-checked; unknown future fields are
// tolerated via the optional index-free shape (we never read keys we didn't write).
export interface ManifestSnapshotRow {
  itemId: string;
  itemName: string;
  itemSlug?: string;
  sku?: string;
  qr?: string;
  kind?: string;
  loose: boolean;
  caseId: string | null;
  caseLabel: string;
  caseSlug?: string;
  qty: number;
  serials: string[];
  state: string;
  flagsOpen: number;
  flags: { id?: string; severity?: string; note?: string; flaggedBy?: string; flaggedAt?: string | null }[];
  signoff: { kind?: string; at?: number; byName?: string; byEmail?: string } | null;
}

export interface ManifestSnapshot {
  capturedAt: number;
  capturedBy: { email?: string; name?: string; role?: string } | null;
  reason: string;
  eventId: string;
  eventName: string;
  eventSlug?: string;
  eventState: string;
  eventDates: { start: string; end: string };
  venue: { name: string; city: string; address: string; booth: string };
  shipping: { carrier: string; tracking: string; pickupDate: string; notes: string; custodyCapture?: CustodyCapture };
  cases: { id: string; label: string; slug: string }[];
  rows: ManifestSnapshotRow[];
  totals: { rows: number; qty: number; cases: number; looseQty: number };
}

// Optional chain-of-custody capture at the ship-kit handoff (typed name + a drawn signature and/or a
// photo, each a data URL). All fields optional — a missing or oversized capture never blocks the ship.
export interface CustodyCapture {
  typedName?: string;
  signatureDataUrl?: string;
  photoDataUrl?: string;
}

export interface ShipStamp {
  at?: number;
  byEmail?: string;
  byName?: string;
  role?: string;
  carrier?: string;
  tracking?: string;
  pickupDate?: string;
  custodyCapture?: CustodyCapture;
}

export interface CloseStamp {
  at?: number;
  byEmail?: string;
  byName?: string;
  role?: string;
}

// event.signoff — the sign-off envelope: the frozen manifest of record + the shipped/closed stamps.
export interface EventSignoff {
  manifestSnapshot?: ManifestSnapshot | null;
  shipped?: ShipStamp;
  closed?: CloseStamp;
}

// One flat event-audit row (mirrors logEventAudit, index.html ~L5317).
export interface EventAuditEntry {
  at: number;
  type: string;
  itemId?: string | null;
  itemLabel?: string | null;
  caseId?: string | null;
  kind?: string | null;
  byEmail?: string;
  byName?: string;
  note?: string;
}

// The known venue fields the EventDetail reads. Kept index-permissive (the source app stores a
// free-form venue object) so an unknown future key doesn't fail the type — we only NAME what the
// detail view renders: address/location, booth + size, amenities, the point-of-contact, lat/lng
// (for the weather lookup) + timezone, and the venue website.
export interface VenuePayload {
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  booth?: string;
  boothSize?: string;
  amenities?: string[];
  website?: string;
  contact?: VenueContact;
  lat?: number;
  lng?: number;
  timezone?: string;
  [k: string]: unknown;
}

/** Per-day hour overrides for a show day. `open`/`close` are the ATTENDEE doors (fall back to the
 *  event-level doorsOpen/doorsClose when absent); `exOpen`/`exClose` are the EXHIBITOR access window
 *  (typically earlier in / later out) — no fallback, shown only when set. All 'HH:MM'. EXACTLY these
 *  four fields: saveEvent normalizes every write to them (extension keys would be silently dropped
 *  by the editor round-trip, so the shape is closed on purpose). */
export interface EventDayHours {
  open?: string;
  close?: string;
  exOpen?: string;
  exClose?: string;
}

export interface EventPayload {
  id?: string;
  name?: string;
  state?: EventState;
  startDate?: string;
  endDate?: string;
  doorsOpen?: string;
  doorsClose?: string;
  // Per-day hour overrides keyed by 'YYYY-MM-DD' (multi-start days, exhibitor vs attendee hours).
  // A day with no entry uses doorsOpen/doorsClose. Edited by the editor's DayHoursEditor strip.
  hours?: Record<string, EventDayHours>;
  city?: string;
  venue?: VenuePayload;
  staff?: Staffer[];
  cases?: string[];
  // The Road Kits assigned to this event (ids into the `roadkits` collection). Assigning a kit
  // unions its caseIds into cases[] (which stays authoritative); roadKitIds drives the manifest's
  // per-kit grouping. A case can sit in cases[] without belonging to any assigned kit ("loose").
  roadKitIds?: string[];
  lead?: string; // email
  outbound?: ShipLeg;
  return?: ShipLeg;
  // The event WEBSITE (top-level in the live data — index.html stores event.website, EXPORTED in
  // EVENT_HEADERS). The detail's Venue card renders it as an external link; venue.website is also
  // honored as a fallback for older records.
  website?: string;
  // Booth power: whether the event/booth provides a power drop, the drop's detail (e.g.
  // "2× 20A 120V"), and the SELECTED receptacle types at the drop (canonical ids from
  // lib/power/connectors RECEPTACLES). The detail view warns when assigned equipment requires
  // power and this is off, or when a device's voltage has no compatible selected receptacle.
  powerDrop?: boolean;
  powerNotes?: string;
  powerReceptacles?: string[];
  // After-parties / community events tied to this event (the "Side events" tab).
  sideEvents?: SideEvent[];
  // The shipping-pallet overlay grouping the event's cases (read-only Pallets view on the Packing
  // tab). Written by the editor's PalletEditor via the pure pallet helpers.
  pallets?: EventPallet[];
  // Booth setup / teardown windows (datetime-local ranges) — drive the Calendar's hour-grid blocks
  // (Week) + logistics segment chips (Month). Present on the live seed events; optional on drafts.
  setup?: SetupWindow;
  teardown?: SetupWindow;
  // Tags are referenced by id: tagIds[] (applied) + primaryTagId (the explicit primary). The `tags`
  // name-array is a legacy field; the live model uses tagIds/primaryTagId (resolved against the
  // `tags` collection). See lib/dashboard-metrics effectivePrimaryTag.
  tags?: string[];
  tagIds?: string[];
  primaryTagId?: string | null;
  // Per-roadcase outbound sign-off map (#28), keyed by caseId. Present once a lead has boxed ≥1
  // case. Written only via lib/write.setCaseSignoff under the signoff.commit gate.
  caseSignoffs?: Record<string, CaseSignoff>;
  // The sign-off envelope: the frozen manifest of record + shipped/closed stamps. Written at Ship
  // Kit (commitEventReady) and Unpack Complete (commitEventClosed).
  signoff?: EventSignoff;
  // The flat event-audit trail (sign-off, ship, close, reconcile, loose moves). Append-only.
  audit?: EventAuditEntry[];
  slug?: string;
}

export type EventDoc = Envelope<EventPayload>;

export type Role = 'read-only' | 'authorized' | 'technician' | 'lead' | 'manager' | 'admin';

export interface UserPayload {
  email: string;
  name?: string;
  picture?: string;
  role?: Role; // the live, synced, authoritative session role (set only via the admin endpoint)
  preferredName?: string;
  lastLoginAt?: number | null;
  // OFFBOARDED (terminated employee): access is fully revoked — every sign-in path refuses, live
  // sessions are ended on the next request, API keys + calendar feeds go dead, and the user is dropped
  // from staffing pickers. Distinct from `deletedAt`: the directory RECORD is KEPT (still listed in
  // Config > Users with a badge) and event rosters/history are preserved. Reversible (Reactivate
  // clears this). ms epoch when offboarded, else absent/null.
  offboardedAt?: number | null;
}

export type UserDoc = Envelope<UserPayload>;

// ── Cases (road / flight cases) ───────────────────────────────────────────────────────────
// Mirrors the current app's CASES model (index.html ~L2580). A case typically carries one
// machine kit; a shared case (no kitFor) is a filament pool / tools / banners container.
export type CaseSize = 'small' | 'medium' | 'large' | 'xl';

export interface CaseRetiredBy {
  email?: string;
  name?: string;
  role?: string;
}

// #66 Warehouses — the per-case in-transit record. A case carries this while it moves between two
// warehouses; currentWarehouseId is null for the duration. Mirrors caseTransferTo's shape
// (index.html ~L6448): { status:'in_transit', from/to warehouse ids, startedAt, optional tracking,
// the mover's email }. Cleared back to null on caseMarkArrived.
export interface CaseTransitTracking {
  carrier?: string;
  number?: string;
  url?: string;
}

export interface CaseTransit {
  status?: 'in_transit' | string;
  fromWarehouseId?: string | null;
  toWarehouseId?: string | null;
  startedAt?: number;
  tracking?: CaseTransitTracking | null;
  byEmail?: string;
}

export interface CasePayload {
  id?: string;
  label?: string;
  slug?: string; // legacy human-readable id (e.g. CASE-MDM-A1); hidden once === id
  size?: CaseSize | string;
  zone?: string;
  kitFor?: string[] | null; // SKU codes this case kits; null/empty = shared-purpose
  weight?: number | string; // tare weight in kg ('' when unset)
  homeWarehouseId?: string | null;
  // #66: the case's CONFIRMED current location (defaults to home). null while in transit.
  currentWarehouseId?: string | null;
  // #66: the in-transit record (present iff the case is moving between warehouses). null = at rest.
  transit?: CaseTransit | null;
  // Retire triple (soft-retire — distinct from the envelope's deletedAt tombstone).
  retiredAt?: number | null;
  retiredReason?: string;
  retiredBy?: CaseRetiredBy | null;
}

export type CaseDoc = Envelope<CasePayload>;

// The inventory ITEM shape (InventoryPayload / InventoryDoc) + its pure read helpers live in
// lib/inventory-shape.ts (owned by the catalog work). The case manifest reuses those helpers so
// bulk vs. serial (#22) items count identically everywhere — a single source of truth.
