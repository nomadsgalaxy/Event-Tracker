import 'server-only';
import { generateId } from '@/lib/util/id';
import { denyInDemo } from '@/lib/db/demo';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import { can, VALID_ROLES, rankOf, canGrantRole } from '@/lib/auth/rbac';
import { dispatchOutbound } from '@/lib/integrations/outbound';
import { viewerLeadsEvent } from '@/lib/views/event-view';
import { resolveLiveRole } from '@/lib/auth/auth';
import type { EventPayload, EventDoc, CasePayload, CaseDoc, CaseSize, UserDoc, Role, CaseSignoff, EventAuditEntry } from '@/lib/types/types';
import type { InventoryDoc, InventoryPayload, DistributionRow, ItemUnit, ItemFlag, SkuOption, KitRequirement } from '@/lib/views/inventory-shape';
import { addFlag as buildAddFlag } from '@/lib/views/inventory-shape';
import { buildManifestSnapshot, buildCheckinSweep, type SnapshotCaseLite } from '@/lib/views/signoff-view';
import type { TagDoc, TagPayload, RoadKitDoc, RoadKitPayload } from '@/lib/db/data';

// lib/db/write.ts — the single server-side write path for the Next.js stack.
//
// LIVE-DB ONLY: every write is a real Mongo updateOne against the envelope
// ({_id, payload, createdAt, updatedAt, deletedAt}). We $set INTO payload.* so we
// never clobber sibling fields a different writer touched, and we always stamp
// updatedAt (the LWW clock the sync engine reads). No cache, no optimistic local
// copy — the next read reflects exactly what we wrote.
//
// AUTHZ: writes are gated with the SAME can() table the client UI uses, evaluated
// against the caller's LIVE role + the STORED event (so an editable-field decision,
// and especially the lead-of-event context, is judged on the real document, never
// on the incoming payload a caller could forge). This mirrors the Python
// _guard_event_write / authorize_event_payload pin-to-stored rule.

export class WriteForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteForbiddenError';
  }
}

// The fields the event editor owns. A patch may only touch these keys — anything
// else is ignored so a crafted form post can't write arbitrary payload paths.
//
// SECURITY — what is DELIBERATELY off this list: `role`/`owner` (no such event field; the session
// role lives in the users directory + is force-immutable on its own path), and the server-owned
// `audit`/`signoff`/`caseSignoffs`/`slug`/`id` (written ONLY by the sign-off + create paths, never
// the editor). `tagIds`/`primaryTagId` are ON (the live tag model the detail view reads); `tags`
// (the legacy name-array) stays for back-compat. The #93 parity additions
// (website/setup/teardown/sideEvents/pallets) don't widen the trust surface — each is a $set of a
// plain payload field, and the staff-PII re-merge below still guards hotel/travel INDEPENDENT of
// which other fields a save touches.
const EDITABLE_FIELDS = [
  'name',
  'state',
  'startDate',
  'endDate',
  'doorsOpen',
  'doorsClose',
  'hours', // per-day hour overrides keyed 'YYYY-MM-DD' (attendee + exhibitor windows)
  'city',
  'venue',
  'staff',
  'cases',
  'lead',
  'outbound',
  'return',
  'tags',
  'brief', // the Event Brief / planning notes (also API/MCP-writable for AI agents)
  // #93 parity additions (the detail view already reads these; the editor now writes them):
  'website',
  'setup',
  'teardown',
  'sideEvents',
  'pallets',
  'tagIds',
  'primaryTagId',
  'roadKitIds',
  'powerDrop',
  'powerNotes',
  'powerReceptacles',
] as const;

export type EventPatch = Partial<Pick<EventPayload, (typeof EDITABLE_FIELDS)[number]>>;

interface SaveEventArgs {
  id: string;
  patch: EventPatch;
  /** The caller's LIVE role (from requireUser/requireRole). */
  actorEmail: string;
  actorRole: string;
}

export interface SaveEventResult {
  ok: boolean;
  matched: number;
  modified: number;
}

/**
 * Persist an event-editor patch. Loads the STORED event, authorizes event.edit
 * against it (manager+ OR the lead of THIS event — judged on the stored lead, not
 * the incoming one), filters the patch to the editable allowlist, then $sets the
 * fields under `payload.` and stamps updatedAt. Returns the update counts.
 *
 * Throws WriteForbiddenError when the caller may not edit this event, or a plain
 * Error when the event is missing — the Server Action surfaces these as form state.
 */
export async function saveEvent({ id, patch, actorEmail, actorRole }: SaveEventArgs): Promise<SaveEventResult> {
  // String()-coerce the _id — TS types are erased at runtime, so a crafted Server Action call
  // could pass an object ({$ne:…}); coercing pins the Mongo filter to a scalar (the Python
  // scalar-_id pin). Done in every write helper below.
  const _id = String(id);
  const db = await getDb();
  const col = db.collection<EventDoc>('events');

  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Event not found (or deleted).');

  // Pin the authz decision to the STORED event: lead-of-event is resolved from the
  // doc on disk so a caller can't grant themselves edit rights by forging payload.lead.
  const isLead = viewerLeadsEvent(stored.payload, actorEmail);
  if (!can('event.edit', actorRole, { isLeadOfEvent: isLead })) {
    throw new WriteForbiddenError('You do not have permission to edit this event.');
  }

  // Build the $set from the editable allowlist only.
  const set: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      set[`payload.${key}`] = patch[key];
    }
  }
  // PII RE-MERGE — preserve per-staffer hotel/travel by DEFAULT, for EVERY editor. A staff patch only
  // carries hotel/travel when the submitter both may see PII *and* explicitly included the sub-object;
  // a non-PII editor (the form drops it), a roster-only API/MCP update, and a stale or untouched form
  // (toPatch omits an empty sub-object) all OMIT the key. An omitted key means "leave it as set", NOT
  // "clear it" — so we merge the STORED hotel/travel back in whenever the incoming staffer doesn't
  // carry its own key. This is what stops a routine Save (or a /lodging-then-Save round-trip, or a
  // partial /api PATCH that only edits the roster) from silently destroying booking info that was set
  // out-of-band. A PII editor who DID submit hotel/travel still sets/edits them verbatim. (Trade-off:
  // lodging can't be cleared by blanking it in the main editor — remove the staffer, or write an empty
  // value through the dedicated /lodging|/travel path, to clear. Preserve-by-default is the safe rule.)
  if (set['payload.staff'] !== undefined) {
    const incoming = Array.isArray(set['payload.staff']) ? (set['payload.staff'] as Record<string, unknown>[]) : [];
    const storedStaff = Array.isArray(stored.payload.staff) ? stored.payload.staff : [];
    const mayEditPii = can('staff.pii.view', actorRole, { isLeadOfEvent: isLead });
    const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
    const lcMerge = (v: unknown) => String(v ?? '').trim().toLowerCase();
    set['payload.staff'] = incoming.map((s, i) => {
      const sEmail = lcMerge(s?.email);
      // Match the stored row by CASE-INSENSITIVE email (like every other email compare). The
      // positional storedStaff[i] fallback is ONLY for legacy email-less rows, where position is
      // the best key — an email-carrying staffer with no email match is genuinely NEW, and falling
      // back positionally would graft a REMOVED staffer's hotel/travel/feedback onto them (and the
      // self-gate downstream would then show the wrong person's PII as "theirs").
      const orig = sEmail
        ? storedStaff.find((o) => lcMerge(o?.email) === sEmail)
        : storedStaff[i];
      const out: Record<string, unknown> = { ...s };
      // feedback (the post-event survey) is written ONLY via its dedicated self-scoped action —
      // the editor NEVER supplies it. Always restore the stored value (or drop a crafted key), or
      // an editor save would silently wipe / seed the team's survey answers.
      if (orig?.feedback != null) out.feedback = orig.feedback;
      else delete out.feedback;
      if (!orig) return out; // a newly-added staffer has no stored PII to preserve
      // Keep the submitted hotel/travel only when this editor may set PII AND explicitly sent the key;
      // otherwise restore the stored value (and drop a stray key rather than write `undefined`).
      if (!(mayEditPii && has(s, 'hotel'))) {
        if (orig.hotel != null) out.hotel = orig.hotel;
        else delete out.hotel;
      }
      if (!(mayEditPii && has(s, 'travel'))) {
        if (orig.travel != null) out.travel = orig.travel;
        else delete out.travel;
      }
      return out;
    });
  }

  // PALLET FK CLEANUP (#24 — the Python prunePallets): a pallet must never reference a case that
  // isn't on the event. The effective case set after this save is the incoming `cases` when the
  // patch sets them, else the stored cases. Drop any pallet caseId outside that set so a save can't
  // leave a dangling case→pallet ref (and so a crafted pallets payload can't smuggle an arbitrary
  // caseId onto the event). Only runs when pallets are actually being written.
  if (set['payload.pallets'] !== undefined) {
    const effectiveCases = new Set(
      (set['payload.cases'] !== undefined
        ? (Array.isArray(set['payload.cases']) ? (set['payload.cases'] as unknown[]) : [])
        : Array.isArray(stored.payload.cases)
          ? stored.payload.cases
          : []
      ).map((c) => String(c))
    );
    const incomingPallets = Array.isArray(set['payload.pallets']) ? (set['payload.pallets'] as Record<string, unknown>[]) : [];
    set['payload.pallets'] = incomingPallets.map((p) => {
      const caseIds = Array.isArray(p?.caseIds) ? (p.caseIds as unknown[]).map((c) => String(c)).filter((c) => effectiveCases.has(c)) : [];
      return { ...p, caseIds };
    });
  }

  // PER-DAY HOURS INVARIANT (server-authoritative): payload.hours carries only 'YYYY-MM-DD' keys
  // inside the EFFECTIVE show range, each entry only the four 'HH:MM' fields. Enforced HERE (the
  // single write choke-point — editor, /api/v1, MCP) because client-side pruning can't see a
  // CONCURRENT range change: the 3-way merge treats dates and hours as independent keys, so a stale
  // form could otherwise strand an out-of-range override (silently resurrected if the range later
  // re-extends). Runs when hours OR the range is being written; the effective range is incoming-else-
  // stored per field.
  {
    const touchesHours = set['payload.hours'] !== undefined;
    const touchesRange = set['payload.startDate'] !== undefined || set['payload.endDate'] !== undefined;
    const src = (touchesHours ? set['payload.hours'] : stored.payload.hours) as Record<string, unknown> | null | undefined;
    if ((touchesHours || touchesRange) && src && typeof src === 'object') {
      const effStart = String(set['payload.startDate'] ?? stored.payload.startDate ?? '');
      const effEnd = String(set['payload.endDate'] ?? stored.payload.endDate ?? '');
      const rangeOk = /^\d{4}-\d{2}-\d{2}$/.test(effStart) && /^\d{4}-\d{2}-\d{2}$/.test(effEnd) && effStart <= effEnd;
      const pruned: Record<string, Record<string, string>> = {};
      for (const key of Object.keys(src).sort()) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
        if (rangeOk && (key < effStart || key > effEnd)) continue;
        const d = (src[key] ?? {}) as Record<string, unknown>;
        const entry: Record<string, string> = {};
        for (const f of ['open', 'close', 'exOpen', 'exClose'] as const) {
          if (typeof d[f] === 'string' && d[f]) entry[f] = d[f];
        }
        if (Object.keys(entry).length) pruned[key] = entry;
      }
      set['payload.hours'] = pruned;
    }
  }

  // Keep payload.id consistent with the envelope _id (the flat shape carries its own id).
  set['payload.id'] = _id;
  set.updatedAt = Date.now();

  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Events: CREATE (mint a UUID + insert a blank event) ─────────────────────────────────────
// Faithful to the Python "New event" flow (EventForm isNew → onSave inserts a fresh event). The
// server mints the _id (a client-supplied id is NEVER trusted, so a crafted id can't clobber/alias an
// existing or tombstoned event). Gated by event.create (manager+, the same cap that shows the "New
// event" button). The first-pass fields come from the SAME editable allowlist + the SAME staff-PII
// re-merge discipline as saveEvent — but on create there's no stored PII to protect, and the creator
// is manager+ (who always passes staff.pii.view), so the merge is a no-op here by construction.
interface CreateEventArgs {
  patch: EventPatch;
  actorEmail: string;
  actorRole: string;
}
export interface CreateEventResult extends SaveEventResult {
  id: string;
}
export async function createEvent({ patch, actorRole }: CreateEventArgs): Promise<CreateEventResult> {
  if (!can('event.create', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to create events.');
  }
  const db = await getDb();
  const col = db.collection<EventDoc>('events');

  const id = generateId();
  const now = Date.now();

  // Build the payload from the editable allowlist only (anything else is ignored). Default a blank
  // name (the #91 rule) + a draft state so a fresh event is always valid.
  const payload: Record<string, unknown> = { id, state: 'draft' };
  for (const key of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) payload[key] = patch[key];
  }
  if (typeof payload.name !== 'string' || (payload.name as string).trim() === '') payload.name = 'Untitled event';

  // Pallet FK cleanup on create too (a crafted create can't reference cases it didn't assign).
  if (Array.isArray(payload.pallets)) {
    const effectiveCases = new Set((Array.isArray(payload.cases) ? (payload.cases as unknown[]) : []).map((c) => String(c)));
    payload.pallets = (payload.pallets as Record<string, unknown>[]).map((p) => ({
      ...p,
      caseIds: Array.isArray(p?.caseIds) ? (p.caseIds as unknown[]).map((c) => String(c)).filter((c) => effectiveCases.has(c)) : [],
    }));
  }

  await col.insertOne({ _id: id, payload: payload as EventDoc['payload'], createdAt: now, updatedAt: now, deletedAt: null } as EventDoc);
  return { ok: true, matched: 1, modified: 1, id };
}

/**
 * Soft-delete an event — stamp deletedAt + updatedAt so the tombstone replicates to peers (the
 * Python onDelete path). Authorization is PINNED TO THE STORED event: event.delete = manager+ OR
 * the lead of THIS event, judged on the doc on disk (never the incoming payload). Idempotent: a
 * missing/already-tombstoned event is a no-op success. Throws WriteForbiddenError when the caller
 * may not delete this event. $set-only (deletedAt), so it can't clobber any payload field.
 */
export async function softDeleteEvent({
  id,
  actorEmail,
  actorRole,
}: {
  id: string;
  actorEmail: string;
  actorRole: string;
}): Promise<SaveEventResult> {
  const _id = String(id);
  const db = await getDb();
  const col = db.collection<EventDoc>('events');

  const stored = await col.findOne({ _id, ...NOT_DELETED });
  // Already gone (or never existed) → idempotent no-op success (mirrors the catalog delete).
  if (!stored) return { ok: true, matched: 0, modified: 0 };

  const isLead = viewerLeadsEvent(stored.payload, actorEmail);
  if (!can('event.delete', actorRole, { isLeadOfEvent: isLead })) {
    throw new WriteForbiddenError('You do not have permission to delete this event.');
  }

  const now = Date.now();
  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: { deletedAt: now, updatedAt: now } });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Sign-off: per-roadcase outbound box/un-box (#28) ─────────────────────────────────
// Faithful to signOffCase / unsignCase (index.html ~L3741) + the lead+/manager+ split in
// signoffPolicy (~L3613): BOXING a case requires signoff.commit (lead+); UN-BOXING requires
// signoff.revert (manager+). The decision is pinned to the STORED event (lead-of-event resolved
// from the doc on disk, never the incoming payload) and we VALIDATE that the target case is
// actually assigned to the event — a crafted caseId can't write an arbitrary key into the map.
// We $set / $unset ONLY the single caseSignoffs.<caseId> key, so this path can never touch any
// other event field. updatedAt is stamped on both planes (the LWW clock the sync engine reads).

interface SetCaseSignoffArgs {
  eventId: string;
  caseId: string;
  /** true = box (sign off the case); false = un-box (revert). */
  boxed: boolean;
  /** The caller's LIVE role + email + display name (from requireRole). */
  actorEmail: string;
  actorRole: string;
  actorName?: string;
}

export interface SetCaseSignoffResult {
  ok: boolean;
  boxed: boolean;
  caseId: string;
}

export async function setCaseSignoff({
  eventId,
  caseId,
  boxed,
  actorEmail,
  actorRole,
  actorName,
}: SetCaseSignoffArgs): Promise<SetCaseSignoffResult> {
  const _id = String(eventId);
  const cid = String(caseId);
  const db = await getDb();
  const col = db.collection<EventDoc>('events');

  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Event not found (or deleted).');

  // The case must actually be assigned to THIS event — never write an arbitrary map key.
  const assigned = Array.isArray(stored.payload.cases) ? stored.payload.cases : [];
  if (!assigned.includes(cid)) {
    throw new Error('That case is not assigned to this event.');
  }

  // Pin the authz decision to the STORED event (lead resolved from disk). BOX = signoff.commit
  // (lead+ OR the lead of this event); UN-BOX = signoff.revert (manager+, no lead ctx — reverting
  // a sign-off is a supervisor action, matching signoffPolicy.canUnSignOff = manager+).
  const isLead = viewerLeadsEvent(stored.payload, actorEmail);
  if (boxed) {
    if (!can('signoff.commit', actorRole, { isLeadOfEvent: isLead })) {
      throw new WriteForbiddenError('You do not have permission to sign off (lead or higher).');
    }
  } else {
    if (!can('signoff.revert', actorRole)) {
      throw new WriteForbiddenError('You do not have permission to revert a sign-off (manager or higher).');
    }
  }

  const now = Date.now();
  // Append the case-box / case-unbox audit entry (mirrors toggleCaseBoxed, index.html ~L21494).
  const caseLabel = await caseLabelFor(cid);
  const audit = appendAudit(stored.payload, {
    type: boxed ? 'case-box' : 'case-unbox',
    caseId: cid,
    note: 'Case ' + caseLabel + (boxed ? ' boxed' : ' un-boxed'),
    byEmail: actorEmail,
    byName: actorName || actorEmail,
  });
  let res;
  if (boxed) {
    const signoff: CaseSignoff = {
      by: { email: actorEmail, name: actorName || actorEmail, role: actorRole },
      at: now,
    };
    res = await col.updateOne(
      { _id, ...NOT_DELETED },
      { $set: { [`payload.caseSignoffs.${cid}`]: signoff, 'payload.audit': audit, updatedAt: now } }
    );
  } else {
    res = await col.updateOne(
      { _id, ...NOT_DELETED },
      { $unset: { [`payload.caseSignoffs.${cid}`]: '' }, $set: { 'payload.audit': audit, updatedAt: now } }
    );
  }
  return { ok: res.matchedCount > 0, boxed, caseId: cid };
}

// ─── Shared: append a flat event-audit row (mirrors logEventAudit, index.html ~L5317) ────────────
// Returns the NEXT audit array (the caller $sets payload.audit). Append-only, never mutates input.
function appendAudit(
  payload: EventPayload,
  entry: { type: string; itemId?: string | null; itemLabel?: string | null; caseId?: string | null; kind?: string | null; byEmail?: string; byName?: string; note?: string }
): EventAuditEntry[] {
  const prior = Array.isArray(payload.audit) ? payload.audit.slice() : [];
  prior.push({
    at: Date.now(),
    type: entry.type,
    itemId: entry.itemId ?? null,
    itemLabel: entry.itemLabel ?? null,
    caseId: entry.caseId ?? null,
    kind: entry.kind ?? null,
    byEmail: entry.byEmail || 'system',
    byName: entry.byName || entry.byEmail || 'System',
    note: entry.note || '',
  });
  return prior;
}

// Resolve a case's display label from the live cases collection (for an audit note). Best-effort —
// falls back to the id when the case doc is unreadable.
async function caseLabelFor(caseId: string): Promise<string> {
  try {
    const db = await getDb();
    const c = await db.collection<CaseDoc>('cases').findOne({ _id: String(caseId) });
    return (c && (c.payload.label || c.payload.slug)) || caseId;
  } catch {
    return caseId;
  }
}

// ─── Inventory (catalog) writes ──────────────────────────────────────────────────────
// The catalog item editor + delete. Inventory carries NO PII, so the gate is the coarse
// data-plane write capability db.write.app (authorized+ — the warehouse-worker tier from
// eit_perms): warehouse workers maintain stock, not just managers. Same envelope discipline
// as saveEvent — $set INTO payload.* over an editable allowlist, stamp updatedAt, soft-delete
// via a deletedAt tombstone so the change replicates to peers.

// The fields the catalog item editor owns. Anything outside this list is ignored so a crafted
// form post can't write arbitrary payload paths (and so distribution/units — maintained by the
// scan/pack flows, not the catalog editor — are left untouched on an edit).
const INVENTORY_EDITABLE_FIELDS = [
  'name',
  'sku',
  'qr',
  'kind',
  'stockTotal',
  'reorderPoint',
  'storageNotes',
] as const;

export type InventoryPatch = Partial<Pick<InventoryPayload, (typeof INVENTORY_EDITABLE_FIELDS)[number]>>;

interface SaveInventoryArgs {
  id: string;
  patch: InventoryPatch;
  actorRole: string;
}

/**
 * Persist a catalog item-editor patch. Authorizes the coarse data-plane write (authorized+),
 * filters the patch to the editable allowlist, $sets the fields under `payload.` and stamps
 * updatedAt. Throws WriteForbiddenError when the caller may not write, or a plain Error when
 * the item is missing.
 */
export async function saveInventoryItem({ id, patch, actorRole }: SaveInventoryArgs): Promise<SaveEventResult> {
  if (!can('db.write.app', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to edit inventory.');
  }
  const _id = String(id);
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');

  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');

  const set: Record<string, unknown> = {};
  for (const key of INVENTORY_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      set[`payload.${key}`] = patch[key];
    }
  }
  set['payload.id'] = _id; // keep payload.id in lockstep with the envelope key
  set.updatedAt = Date.now();

  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

/**
 * Soft-delete a catalog item — stamp deletedAt + updatedAt so the tombstone replicates and the
 * catalog drops it from render. Authorized+. Idempotent (deleting a gone item is a no-op
 * success). Throws WriteForbiddenError when the caller may not write.
 */
export async function deleteInventoryItem(id: string, actorRole: string): Promise<SaveEventResult> {
  if (!can('db.write.app', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to delete inventory.');
  }
  const _id = String(id);
  const db = await getDb();
  const now = Date.now();
  const res = await db
    .collection<InventoryDoc>('inventory')
    .updateOne({ _id }, { $set: { deletedAt: now, updatedAt: now } });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Scan-pack (mark an item packed/pending in a case) ───────────────────────────────────────
// The functional core of the Scan-Pack screen (DESIGN_ALIGNMENT.md §4.4). A faithful port of
// ScanHybrid.toggleRowPacked (index.html ~L17083): toggle ONE item's per-case packed state inside
// the case it's routed into — for a BULK item that's the matching distribution[].state, for a
// SERIAL item (#22) it's the units[] whose location === caseId. We stamp packedBy/packedAt on a
// pack and clear them on an un-pack (mirroring the source), then $set the whole array back +
// updatedAt (the LWW clock). distribution/units are NOT in the catalog editor's allowlist, so this
// is the ONLY write path that touches them — the scan flow owns them.
//
// AUTHZ: gated by scan.pack (authorized+ — the warehouse-worker pack tier, #65), re-checked here
// with can() as defence-in-depth even though the Server Action already requireRole'd. The item is
// pinned to its STORED doc (scalar _id) and the caseId is verified to actually contain the item, so
// a crafted call can't pack an item into a case it was never routed into.

export interface PackByActor {
  email?: string;
  name?: string;
}

interface PackItemArgs {
  itemId: string;
  caseId: string;
  /** true => mark packed; false => mark pending (un-pack). */
  packed: boolean;
  actorRole: string;
  actor: PackByActor;
}

export interface PackItemResult extends SaveEventResult {
  /** The item's resulting per-case state, for an optimistic client reconcile. */
  state: 'packed' | 'pending';
}

export async function packItemIntoCase({
  itemId,
  caseId,
  packed,
  actorRole,
  actor,
}: PackItemArgs): Promise<PackItemResult> {
  if (!can('scan.pack', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to pack cases.');
  }

  const _id = String(itemId);
  const cId = String(caseId);
  if (!cId) throw new Error('A case is required to pack into.');

  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');

  const item = stored.payload || {};
  const now = Date.now();
  const by: PackByActor | null = actor?.email || actor?.name ? { email: actor.email, name: actor.name } : null;
  const set: Record<string, unknown> = {};

  if (item.tracking === 'serial') {
    // SERIAL (#22): pack/un-pack every live unit routed to this case.
    const units = Array.isArray(item.units) ? item.units : [];
    const inCase = units.filter((u) => u && !u.deletedAt && u.location === cId);
    if (inCase.length === 0) throw new Error('That item is not routed into this case.');
    const nextUnits = units.map((u) => {
      if (!u || u.deletedAt || u.location !== cId) return u;
      return packed
        ? { ...u, state: 'packed' as const, packedBy: by, packedAt: now }
        : { ...u, state: 'pending' as const, packedBy: null, packedAt: null };
    });
    set['payload.units'] = nextUnits;
  } else {
    // BULK: toggle the matching distribution row's state.
    const dist = Array.isArray(item.distribution) ? item.distribution : [];
    const idx = dist.findIndex((d) => d && d.caseId === cId);
    if (idx === -1) throw new Error('That item is not routed into this case.');
    const nextDist = dist.map((d, i) => {
      if (i !== idx) return d;
      return packed
        ? { ...d, state: 'packed' as const, packedBy: by, packedAt: now }
        : { ...d, state: 'pending' as const, packedBy: null, packedAt: null };
    });
    set['payload.distribution'] = nextDist;
  }

  set['payload.id'] = _id; // keep the flat id in lockstep with the envelope _id
  set.updatedAt = now;

  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return {
    ok: res.matchedCount > 0,
    matched: res.matchedCount,
    modified: res.modifiedCount,
    state: packed ? 'packed' : 'pending',
  };
}

// ─── Cases (road / flight cases) writes ──────────────────────────────────────────────────
// The case editor owns these fields (mirrors CaseEditor.buildFormCase, index.html ~L19476).
// id/slug are LOCKED at creation in the current app, so they're not in the patch surface; a
// crafted post that includes them is simply ignored (only allowlisted keys are $set).
const CASE_EDITABLE_FIELDS = [
  'label',
  'size',
  'zone',
  'kitFor',
  'weight',
  'homeWarehouseId',
] as const;

export type CasePatch = Partial<Pick<CasePayload, (typeof CASE_EDITABLE_FIELDS)[number]>>;

const VALID_CASE_SIZES: ReadonlySet<string> = new Set(['small', 'medium', 'large', 'xl']);

interface SaveCaseArgs {
  id: string;
  patch: CasePatch;
  /** The caller's LIVE role + email (from requireUser/requireRole). */
  actorEmail: string;
  actorRole: string;
}

/**
 * Persist a case-editor patch. Gated by `pallets.edit` (authorized+) — the same capability the
 * current app uses for the case-assignment / pallet-edit path warehouse workers run from OUTSIDE
 * the event editor (#165). Loads + pins to the STORED case, filters the patch to the editable
 * allowlist, sanitizes each field (never blanks the label; clamps size; normalizes an empty
 * kitFor to null = shared-purpose; coerces weight to a non-negative number or ''), $sets under
 * `payload.` and stamps updatedAt. Throws WriteForbiddenError when the caller lacks the cap, a
 * plain Error when the case is missing.
 *
 * actorEmail is threaded for parity with saveEvent + a future per-record context; pallets.edit
 * is a flat role gate today (no ctx), so it isn't consulted in the decision — but keeping the
 * signature uniform means the call sites don't change if a ctx grant is added later.
 */
export async function saveCase({ id, patch, actorEmail, actorRole }: SaveCaseArgs): Promise<SaveEventResult> {
  void actorEmail;
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to edit cases.');
  }

  const _id = String(id);
  const db = await getDb();
  const col = db.collection<CaseDoc>('cases');

  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Case not found (or deleted).');

  const set: Record<string, unknown> = {};
  for (const key of CASE_EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const raw = patch[key];
    switch (key) {
      case 'label':
        // Never blank the label — the catalog/detail header reads it. Fall back to a default.
        set['payload.label'] = String(raw ?? '').trim() || 'Roadcase';
        break;
      case 'size': {
        const s = String(raw ?? '').trim().toLowerCase();
        set['payload.size'] = (VALID_CASE_SIZES.has(s) ? s : 'medium') as CaseSize;
        break;
      }
      case 'zone':
        set['payload.zone'] = String(raw ?? '').trim();
        break;
      case 'kitFor': {
        // Array of SKU codes; an empty array normalizes to null (= shared-purpose case), the
        // same convention as buildFormCase (blank "Kit for" csv => null).
        const arr = Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean) : [];
        set['payload.kitFor'] = arr.length ? arr : null;
        break;
      }
      case 'weight': {
        // Canonical kg as a number; blank stays '' (unset). NaN/negative -> ''.
        if (raw === '' || raw == null) {
          set['payload.weight'] = '';
        } else {
          const n = Number(raw);
          set['payload.weight'] = Number.isFinite(n) && n >= 0 ? n : '';
        }
        break;
      }
      case 'homeWarehouseId':
        set['payload.homeWarehouseId'] = raw ? String(raw) : null;
        break;
    }
  }

  set['payload.id'] = _id; // keep the flat id in lockstep with the envelope _id
  set.updatedAt = Date.now();

  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Cases: CREATE (mint a UUID + insert a blank case) ───────────────────────────────────────
// Faithful to blankCase + the editor's create path (index.html ~L19462): mint a server-side UUID
// (the client never supplies the id — a crafted id can't clobber/alias an existing or tombstoned
// case), insert the envelope with the editor's first-pass fields. Gated by pallets.edit (authorized+).
interface CreateCaseArgs {
  patch: CasePatch;
  actorEmail: string;
  actorRole: string;
}
export interface CreateCaseResult extends SaveEventResult {
  id: string;
}
export async function createCase({ patch, actorEmail, actorRole }: CreateCaseArgs): Promise<CreateCaseResult> {
  void actorEmail;
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to create cases.');
  }
  const db = await getDb();
  const col = db.collection<CaseDoc>('cases');

  const id = generateId();
  const now = Date.now();

  // Seed from the blankCase defaults, then layer the editor's first-pass fields (sanitized to the
  // same rules saveCase uses).
  const label = String(patch.label ?? '').trim() || 'Roadcase';
  const sizeRaw = String(patch.size ?? '').trim().toLowerCase();
  const size = (VALID_CASE_SIZES.has(sizeRaw) ? sizeRaw : 'medium') as CaseSize;
  const zone = String(patch.zone ?? '').trim();
  const kitArr = Array.isArray(patch.kitFor) ? patch.kitFor.map((s) => String(s).trim()).filter(Boolean) : [];
  const kitFor = kitArr.length ? kitArr : null;
  let weight: number | string = '';
  if (!(patch.weight === '' || patch.weight == null)) {
    const n = Number(patch.weight);
    weight = Number.isFinite(n) && n >= 0 ? n : '';
  }
  const homeWarehouseId = patch.homeWarehouseId ? String(patch.homeWarehouseId) : null;

  const payload: CasePayload = {
    id,
    slug: id,
    label,
    size,
    zone,
    kitFor,
    weight,
    homeWarehouseId,
    currentWarehouseId: homeWarehouseId,
    transit: null,
    retiredAt: null,
    retiredReason: '',
    retiredBy: null,
  };
  await col.insertOne({ _id: id, payload, createdAt: now, updatedAt: now, deletedAt: null } as CaseDoc);
  return { ok: true, matched: 1, modified: 1, id };
}

// ─── Cases: DELETE / RETIRE (FK-classified) ──────────────────────────────────────────────────
// Faithful to classifyCaseDelete + retireCase + hardDeleteCase (index.html ~L5591/5613/5629). The
// caller chooses 'delete' or 'retire'; we RE-CLASSIFY server-side against the live events+inventory
// so a crafted request can't hard-delete a case held by a non-closed event (blocked) or skip the
// historical-ref check. 'delete' tombstones (deletedAt — NOT a row drop, so the deletion replicates
// to peers, #69); 'retire' stamps the retire triple. Gated by pallets.edit (authorized+).
interface RetireOrDeleteCaseArgs {
  id: string;
  action: 'delete' | 'retire';
  reason: string;
  actorEmail: string;
  actorName?: string;
  actorRole: string;
}
export interface RetireOrDeleteCaseResult {
  ok: boolean;
  /** What actually happened (may differ from the requested action if the live state forces it). */
  action: 'delete' | 'retire' | 'blocked';
}
export async function retireOrDeleteCase({
  id,
  action,
  reason,
  actorEmail,
  actorName,
  actorRole,
}: RetireOrDeleteCaseArgs): Promise<RetireOrDeleteCaseResult> {
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to delete cases.');
  }
  const _id = String(id);
  const db = await getDb();
  const col = db.collection<CaseDoc>('cases');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Case not found (or deleted).');

  // RE-CLASSIFY on the live data (the real authority — never trust the requested action alone).
  const [eventDocs, invDocs] = await Promise.all([
    db.collection<EventDoc>('events').find(NOT_DELETED).toArray(),
    db.collection<InventoryDoc>('inventory').find(NOT_DELETED).toArray(),
  ]);
  const { classifyCaseDelete } = await import('@/lib/views/case-view');
  const cls = classifyCaseDelete(
    _id,
    eventDocs.map((e) => ({ _id: e._id, payload: e.payload })),
    invDocs.map((d) => d.payload)
  );

  if (cls.action === 'blocked') {
    throw new WriteForbiddenError('This case is held by a non-closed event — remove it from that event first.');
  }

  const now = Date.now();
  // A hard delete is only allowed when the live classification AGREES it has no FK refs; otherwise
  // we fall through to a retire (matching the modal, which never offers delete when refs exist).
  if (action === 'delete' && cls.action === 'delete') {
    await col.updateOne({ _id }, { $set: { deletedAt: now, updatedAt: now } });
    return { ok: true, action: 'delete' };
  }

  // Retire (the live state forces this when refs exist, or the caller asked for it).
  const retiredBy = {
    email: String(actorEmail || ''),
    name: String(actorName || actorEmail || ''),
    role: String(actorRole || ''),
  };
  await col.updateOne(
    { _id, ...NOT_DELETED },
    {
      $set: {
        'payload.retiredAt': now,
        'payload.retiredReason': String(reason || '').trim(),
        'payload.retiredBy': retiredBy,
        'payload.id': _id,
        updatedAt: now,
      },
    }
  );
  return { ok: true, action: 'retire' };
}

// ─── Cases: WAREHOUSE TRANSFER / IN-TRANSIT / ARRIVED (#66) ──────────────────────────────────
// Faithful to caseTransferTo / caseMarkArrived (index.html ~L6448/6461). Transfer flips the case to
// in-transit (currentWarehouseId=null + a transit record carrying from/to + optional carrier/tracking
// + the mover's email); Mark-arrived clears the transit and sets currentWarehouseId to the destination.
// Both stamp updatedAt. Gated by pallets.edit (authorized+). The destination is validated to exist as
// a live warehouse so a crafted id can't strand a case at a non-warehouse.
interface CaseTransferArgs {
  id: string;
  toWarehouseId: string;
  carrier?: string;
  trackingNumber?: string;
  actorEmail: string;
  actorRole: string;
}
export async function caseTransfer({
  id,
  toWarehouseId,
  carrier,
  trackingNumber,
  actorEmail,
  actorRole,
}: CaseTransferArgs): Promise<SaveEventResult> {
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to move cases.');
  }
  const _id = String(id);
  const toId = String(toWarehouseId ?? '').trim();
  if (!toId) throw new Error('A destination warehouse is required.');

  const db = await getDb();
  const col = db.collection<CaseDoc>('cases');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Case not found (or deleted).');

  // Validate the destination is a real, live warehouse.
  const wh = await db.collection<{ _id: string }>('warehouses').findOne({ _id: toId, ...NOT_DELETED });
  if (!wh) throw new Error('That warehouse no longer exists.');

  const c = stored.payload;
  const from = c.currentWarehouseId || c.homeWarehouseId || null;
  const tk =
    (carrier && carrier.trim()) || (trackingNumber && trackingNumber.trim())
      ? { carrier: String(carrier || '').trim(), number: String(trackingNumber || '').trim(), url: '' }
      : null;
  const now = Date.now();
  const transit = {
    status: 'in_transit' as const,
    fromWarehouseId: from,
    toWarehouseId: toId,
    startedAt: now,
    tracking: tk,
    byEmail: String(actorEmail || ''),
  };
  const res = await col.updateOne(
    { _id, ...NOT_DELETED },
    { $set: { 'payload.currentWarehouseId': null, 'payload.transit': transit, 'payload.id': _id, updatedAt: now } }
  );
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

export async function caseMarkArrived({
  id,
  actorEmail,
  actorRole,
}: {
  id: string;
  actorEmail: string;
  actorRole: string;
}): Promise<SaveEventResult> {
  void actorEmail;
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to move cases.');
  }
  const _id = String(id);
  const db = await getDb();
  const col = db.collection<CaseDoc>('cases');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Case not found (or deleted).');
  const c = stored.payload;
  if (!c.transit) throw new Error('This case is not in transit.');
  const now = Date.now();
  const dest = c.transit.toWarehouseId || c.currentWarehouseId || c.homeWarehouseId || null;
  const res = await col.updateOne(
    { _id, ...NOT_DELETED },
    { $set: { 'payload.currentWarehouseId': dest, 'payload.transit': null, 'payload.id': _id, updatedAt: now } }
  );
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Cases: cycle an item's per-case packed state (the contents pill) ─────────────────────────
// Faithful to cycleItemState (index.html ~L4327): clicking the per-case state pill flips packed ↔
// pending in place. A thin wrapper over packItemIntoCase (which owns distribution/units) so the
// catalog/case-detail toggle and the scan-pack flow agree exactly. Gated by scan.pack (authorized+).
export async function cycleItemStateInCase({
  itemId,
  caseId,
  actorRole,
  actor,
}: {
  itemId: string;
  caseId: string;
  actorRole: string;
  actor: PackByActor;
}): Promise<PackItemResult> {
  const _id = String(itemId);
  const cId = String(caseId);
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');
  // Determine the CURRENT per-case state, then flip it. packItemIntoCase re-checks the gate + the
  // routing, so this read is only to pick the target state.
  const { itemStateInCase } = await import('@/lib/views/inventory-shape');
  const cur = itemStateInCase(stored.payload, cId);
  const nextPacked = cur !== 'packed'; // pending/null -> packed; packed -> pending
  return packItemIntoCase({ itemId: _id, caseId: cId, packed: nextPacked, actorRole, actor });
}

// ─── Cases: CSV import commit (create / update-by-id) ────────────────────────────────────────
// Faithful to the CsvImportModal commit (index.html ~L19719) — but the DRY-RUN mapping/validation +
// the #43 skuOptions parsing live client-side; this commit just persists the already-validated rows.
// Each row carries an OPTIONAL id: a blank/unknown id INSERTS a new case (server mints a fresh UUID —
// the client-supplied id is NEVER trusted as the _id, so a crafted id can't clobber an existing case);
// a known id UPDATEs by $set into payload.* over the case allowlist. Gated by pallets.edit (authorized+).
export interface CaseCsvRow {
  id?: string;
  label?: string;
  size?: string;
  zone?: string;
  kitFor?: string[];
  weight?: number | string;
}
export interface CsvImportResult {
  ok: boolean;
  created: number;
  updated: number;
}
export async function applyCaseCsvImport({
  rows,
  actorRole,
}: {
  rows: CaseCsvRow[];
  actorRole: string;
}): Promise<CsvImportResult> {
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to import cases.');
  }
  const db = await getDb();
  const col = db.collection<CaseDoc>('cases');
  // The set of ids that ACTUALLY exist (a row claiming an unknown id becomes a create, never an
  // update of a forged id).
  const existing = await col.find(NOT_DELETED).project({ _id: 1 }).toArray();
  const known = new Set(existing.map((d) => d._id));

  let created = 0;
  let updated = 0;
  const now = Date.now();

  const clean = (row: CaseCsvRow) => {
    const label = String(row.label ?? '').trim() || 'Roadcase';
    const sizeRaw = String(row.size ?? '').trim().toLowerCase();
    const size = (VALID_CASE_SIZES.has(sizeRaw) ? sizeRaw : 'medium') as CaseSize;
    const zone = String(row.zone ?? '').trim();
    const kitArr = Array.isArray(row.kitFor) ? row.kitFor.map((s) => String(s).trim()).filter(Boolean) : [];
    const kitFor = kitArr.length ? kitArr : null;
    let weight: number | string = '';
    if (!(row.weight === '' || row.weight == null)) {
      const n = Number(row.weight);
      weight = Number.isFinite(n) && n >= 0 ? n : '';
    }
    return { label, size, zone, kitFor, weight };
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    const claimedId = String(row.id ?? '').trim();
    const fields = clean(row);
    if (claimedId && known.has(claimedId)) {
      await col.updateOne(
        { _id: claimedId, ...NOT_DELETED },
        {
          $set: {
            'payload.label': fields.label,
            'payload.size': fields.size,
            'payload.zone': fields.zone,
            'payload.kitFor': fields.kitFor,
            'payload.weight': fields.weight,
            'payload.id': claimedId,
            updatedAt: now,
          },
        }
      );
      updated++;
    } else {
      const id = generateId();
      const payload: CasePayload = {
        id,
        slug: id,
        label: fields.label,
        size: fields.size,
        zone: fields.zone,
        kitFor: fields.kitFor,
        weight: fields.weight,
        homeWarehouseId: null,
        currentWarehouseId: null,
        transit: null,
        retiredAt: null,
        retiredReason: '',
        retiredBy: null,
      };
      await col.insertOne({ _id: id, payload, createdAt: now, updatedAt: now, deletedAt: null } as CaseDoc);
      created++;
    }
  }
  return { ok: true, created, updated };
}

// ─── Cases: ADD an existing item to a case (the case-detail "+ Add item") ─────────────────────
// Faithful to handleAddExistingItem (index.html ~L14319): append a { caseId, qty:1, serials:[],
// state:'pending' } distribution row (bulk) / relocate a free unit (serial) for an item not already
// in the case. Re-uses addItemToCase (which owns the routing + the gate). Gated by scan.pack.
export async function addExistingItemToCase({
  itemId,
  caseId,
  actorRole,
  actor,
}: {
  itemId: string;
  caseId: string;
  actorRole: string;
  actor: PackByActor;
}): Promise<PackItemResult> {
  return addItemToCase({ itemId, caseId, alsoPack: false, actorRole, actor });
}

// ─── Directory user role assignment (Config > Users) ─────────────────────────────────────────
// THE single place a session role is set. Faithful port of eit_auth._h_users_role — this is
// privilege management and is red-teamed, so the gate is layered and pinned:
//
//   1. ADMIN-ONLY on the LIVE role. The caller's role is re-resolved from the directory
//      (resolveLiveRole) inside this helper, NOT trusted from the passed-in token role — a
//      just-demoted admin can't keep assigning roles for the rest of their session.
//   2. VALID ROLE. The new role must be in VALID_ROLES (lib/rbac); anything else => 400-class
//      Error (fail closed — never write an invalid/forged role).
//   3. ROLE-RAISE GUARD. You may not grant a role ABOVE your own rank (canGrantRole). Admin is
//      top rank so an admin may grant any valid role; the guard is the invariant that survives
//      a future non-admin grant of users.role.assign.
//   4. REFUSE OWN ROLE. The target email is compared to the caller's session email — you can
//      NEVER change your own role (an admin can't demote/lock themselves out, and can't be
//      tricked into a self-edit). Emails are normalized identically before the compare.
//   5. PIN BY EMAIL. The _id filter is String()-coerced to a scalar (the Mongo NoSQL-operator
//      defense) so a crafted object email can never become a {$ne:…} filter.
//   6. NARROW WRITE. We $set ONLY payload.role + payload.updatedAt (+ payload.email when the doc
//      lacks one, matching the Python) + the envelope updatedAt — never any other field, so this
//      path can't be abused to overwrite name/picture/accommodations/PII.
//
// The target MUST already exist in the directory (no upsert here): the Next config Users panel
// only ever assigns roles to listed users, so a missing target is a 404-class Error rather than a
// silent account creation.
function normEmailW(e: unknown): string {
  return String(e ?? '').trim().toLowerCase();
}

interface SetUserRoleArgs {
  targetEmail: string;
  newRole: string;
  /** The caller's session email (from requireUser/requireRole). The own-role compare pins to this. */
  actorEmail: string;
}

export interface SetUserRoleResult {
  ok: boolean;
  email: string;
  role: Role;
}

export async function setUserRole({ targetEmail, newRole, actorEmail }: SetUserRoleArgs): Promise<SetUserRoleResult> {
  denyInDemo('User roles');
  const actor = normEmailW(actorEmail);
  const target = normEmailW(targetEmail);
  const role = String(newRole ?? '').trim().toLowerCase();

  // (1) ADMIN-ONLY on the LIVE role — re-resolve, never trust a passed-in role.
  const actorRole = await resolveLiveRole(actor);
  if (rankOf(actorRole) < rankOf('admin')) {
    throw new WriteForbiddenError('An admin role is required to assign roles.');
  }

  // (2) VALID ROLE — fail closed on anything outside the built-in set.
  if (!target || !VALID_ROLES.has(role)) {
    throw new Error('A target email and a valid role are required.');
  }

  // (3) ROLE-RAISE GUARD — never grant above your own rank.
  if (!canGrantRole(actorRole, role)) {
    throw new WriteForbiddenError("You can't grant a role above your own.");
  }

  // (4) REFUSE OWN ROLE — the security-critical self-edit refusal.
  if (target === actor) {
    throw new WriteForbiddenError("You can't change your own role.");
  }

  // (5) PIN BY EMAIL (scalar _id) + require the directory user to exist (no upsert).
  const _id = String(target);
  const db = await getDb();
  const col = db.collection<UserDoc>('users');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('That user is not in the directory.');

  // (6) NARROW WRITE — only the role + timestamps. payload.email is backfilled if the stored doc
  // somehow lacks it (matches the Python), but no other payload field is ever touched.
  const now = Date.now();
  const set: Record<string, unknown> = {
    'payload.role': role,
    'payload.updatedAt': now,
    updatedAt: now,
  };
  if (!stored.payload?.email) set['payload.email'] = target;

  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, email: target, role: role as Role };
}

// ─── Manifest: assign roadcases to an event (Assign-cases modal) ─────────────────────────────
// Faithful to ManifestPool's "Save assignments" (index.html ~L16498): the modal collects a Set of
// case ids and writes event.cases = [...]. The write gate is `pallets.edit` (authorized+) — the
// SAME case-assignment capability warehouse workers use from outside the event editor (#165); it's
// deliberately a coarser gate than event.edit so packers can route cases without the full editor.
//
// Server-side we VALIDATE the requested ids against the live `cases` collection, pinning to the
// SAME availability + retired rules the modal renders client-side so a crafted post can't:
//   • assign a non-existent case id,
//   • assign a RETIRED case that wasn't already on the event (a retired case may stay if it was
//     already assigned — matching the modal's "keep already-assigned" rule), or
//   • assign a case currently HELD by another in-flight event (the availability lock).
// The set is de-duped + order-stable. We $set ONLY payload.cases (+ id/updatedAt) — never any other
// field — so this path can't be abused to touch staff/PII/etc.

const HELD_EVENT_STATES: ReadonlySet<string> = new Set([
  'packing',
  'ready',
  'in_transit',
  'onsite',
  'returning',
]);

interface SetEventCasesArgs {
  eventId: string;
  /** The requested case ids (the modal's selected Set, as an array). */
  caseIds: string[];
  /** The Road Kits assigned to this event (for manifest grouping). Validated against live kits. */
  roadKitIds?: string[];
  actorEmail: string;
  actorRole: string;
}

export interface SetEventCasesResult extends SaveEventResult {
  /** The cases actually persisted (after validation/de-dupe). */
  cases: string[];
  /** ids the caller requested that were rejected (missing / retired-not-prior / held elsewhere). */
  rejected: string[];
}

export async function setEventCases({
  eventId,
  caseIds,
  roadKitIds,
  actorEmail,
  actorRole,
}: SetEventCasesArgs): Promise<SetEventCasesResult> {
  void actorEmail; // pallets.edit is a flat role gate today (kept for a future per-record ctx).
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to assign cases.');
  }

  const _id = String(eventId);
  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const stored = await events.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Event not found (or deleted).');

  // The cases ALREADY on this event (a retired/held case may stay if it was already assigned).
  const prior = new Set(
    Array.isArray(stored.payload.cases) ? stored.payload.cases.map((c) => String(c)) : []
  );

  // De-dupe + coerce the requested ids to scalars, preserving first-seen order.
  const requested: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(caseIds) ? caseIds : []) {
    const cid = String(raw);
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    requested.push(cid);
  }

  // Live cases (for existence + retired check) and the in-flight holders (for the availability lock).
  const [caseDocs, eventDocs] = await Promise.all([
    db.collection<CaseDoc>('cases').find(NOT_DELETED).toArray(),
    events.find(NOT_DELETED).toArray(),
  ]);
  const caseById = new Map<string, CasePayload>();
  for (const c of caseDocs) caseById.set(c._id, c.payload);
  // caseId -> the OTHER event id currently holding it in an in-flight state (excludes THIS event).
  const heldElsewhere = new Map<string, string>();
  for (const e of eventDocs) {
    if (e._id === _id) continue;
    if (!HELD_EVENT_STATES.has(String(e.payload.state))) continue;
    for (const cid of e.payload.cases ?? []) heldElsewhere.set(String(cid), e._id);
  }

  const cases: string[] = [];
  const rejected: string[] = [];
  for (const cid of requested) {
    const wasPrior = prior.has(cid);
    const c = caseById.get(cid);
    // Missing case → reject (unless it was already assigned, in which case we keep the stub id so a
    // save doesn't silently drop a case whose doc is momentarily unreadable — matches the modal,
    // which still renders an already-assigned id even when its doc is gone).
    if (!c) {
      if (wasPrior) cases.push(cid);
      else rejected.push(cid);
      continue;
    }
    // Retired case the event didn't already hold → reject (the modal excludes these).
    if (c.retiredAt && !wasPrior) {
      rejected.push(cid);
      continue;
    }
    // Held by another in-flight event → reject (the availability lock; a case it already held is
    // fine, and re-saving the same set is idempotent because heldElsewhere excludes THIS event).
    if (heldElsewhere.has(cid) && !wasPrior) {
      rejected.push(cid);
      continue;
    }
    cases.push(cid);
  }

  // Road Kit assignments: keep only ids of LIVE kits (deduped, scalar). Only persisted when the
  // caller passes the field, so a plain case-only save leaves any existing groupings untouched.
  const set: Record<string, unknown> = { 'payload.cases': cases, 'payload.id': _id, updatedAt: Date.now() };
  if (Array.isArray(roadKitIds)) {
    const liveKitIds = new Set(
      (await db.collection<RoadKitDoc>('roadkits').find(NOT_DELETED).toArray()).map((k) => k._id)
    );
    const kits: string[] = [];
    const kseen = new Set<string>();
    for (const raw of roadKitIds) {
      const kid = String(raw);
      if (!kid || kseen.has(kid) || !liveKitIds.has(kid)) continue;
      kseen.add(kid);
      kits.push(kid);
    }
    set['payload.roadKitIds'] = kits;
  }

  const res = await events.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount, cases, rejected };
}

// ─── Inventory: upsert an item (detail editor / flag / resolve) ──────────────────────────────
// The single write path the SHARED ItemDetailsModal / FlagItemModal / ResolveFlagModal flow through
// (reused later by Catalog / Sign-off). A faithful port of the client `upsertItem` + the item-editor
// `submit` (index.html ~L20668) + addFlag/resolveFlag (~L9423): the caller hands a fully-built next
// item payload; we authorize, filter to the editable allowlist, sanitize, then $set under payload.*.
//
// AUTHZ: gated by db.write.app (authorized+ — the warehouse-worker tier; flagging/editing inventory
// is a stock-maintenance action, same as saveInventoryItem). Re-checked here with can() as
// defence-in-depth. The _id is String()-pinned (the NoSQL-operator defense). We $set ONLY the
// allowlisted item fields — never role/PII/envelope internals.
//
// SCALE of allowlist: unlike saveInventoryItem (which only writes the catalog's scalar fields and
// deliberately leaves distribution/units alone), this path is the FULL item editor + the flag
// mutators, so it owns the richer surface: tracking + distribution/units (#22), skuOptions (#43),
// tagIds, flags, weight, reorderPoint, storageNotes, status. distribution/units are still
// sanitized to lean shapes so a crafted post can't smuggle arbitrary keys onto a row/unit.

const ITEM_EDITABLE_FIELDS = [
  'name',
  'kind',
  'sku',
  'qr',
  'skuOptions',
  'weight',
  'tracking',
  'distribution',
  'units',
  'stockTotal',
  'reorderPoint',
  'storageNotes',
  'tagIds',
  'flags',
  'status',
  'requirements',
  'nextServiceDate',
  'serviceIntervalDays',
  'purchasePrice',
  'purchaseDate',
  'replacementCost',
  'requiresPower',
  'powerWatts',
  'plugType',
  'powerVolts',
  'fixedPlug',
  'cable',
] as const;

export type ItemPatch = Partial<Pick<InventoryPayload, (typeof ITEM_EDITABLE_FIELDS)[number]>>;

// Sanitize one bulk distribution row to the known lean shape (drops unknown keys).
function cleanDistRow(d: DistributionRow): DistributionRow {
  const row: DistributionRow = {
    caseId: d.caseId ? String(d.caseId) : null,
    eventId: d.eventId ? String(d.eventId) : null,
    qty: Math.max(0, Math.floor(Number(d.qty) || 0)),
    serials: Array.isArray(d.serials) ? d.serials.map((s) => String(s)).filter(Boolean) : [],
    state: d.state === 'packed' ? 'packed' : 'pending',
  };
  if (d.variantSku) row.variantSku = String(d.variantSku);
  if (d.looseAttach) row.looseAttach = d.looseAttach;
  if (d.signoff) row.signoff = d.signoff;
  if (d.packedBy) row.packedBy = d.packedBy;
  if (d.packedAt != null) row.packedAt = d.packedAt;
  return row;
}

// A real ISO 'YYYY-MM-DD' calendar date (rejects 2024-13-45 etc.). Used for purchase + service dates.
function isIsoDate(v: unknown): v is string {
  const s = String(v ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Sanitize one serial unit (#22) to the known lean shape.
function cleanUnit(u: ItemUnit): ItemUnit {
  const loc = u.location ? String(u.location) : 'storage';
  return {
    id: u.id ? String(u.id) : undefined,
    serial: String(u.serial ?? '').trim(),
    location: loc,
    storageNote: loc === 'storage' ? String(u.storageNote ?? '') : '',
    state: (['packed', 'pending', 'flagged', 'draft'] as const).includes(u.state as never)
      ? u.state
      : 'draft',
    sku: u.sku ? String(u.sku).trim() : '',
    flags: Array.isArray(u.flags) ? u.flags.map(cleanFlag) : [],
    // Per-unit service (serial items): the out-of-service status + the per-unit service schedule.
    status: u.status === 'out_of_service' ? 'out_of_service' : null,
    ...(isIsoDate(u.nextServiceDate) ? { nextServiceDate: u.nextServiceDate } : { nextServiceDate: null }),
    ...(u.serviceIntervalDays != null && Number.isFinite(Number(u.serviceIntervalDays))
      ? { serviceIntervalDays: Math.max(0, Number(u.serviceIntervalDays)) }
      : {}),
    ...(u.fixedPlug ? { fixedPlug: String(u.fixedPlug).trim().slice(0, 40) } : {}),
    // Preserve the NFC spool link + remaining weight through the full editor save (auto-set by the tag
    // read flow; the editor never authors them, but it must not strip them either).
    ...(u.tagUid ? { tagUid: String(u.tagUid) } : {}),
    ...(typeof u.remainingWeight === 'number' ? { remainingWeight: u.remainingWeight } : {}),
  };
}

// Sanitize one flag entry (addFlag's shape) — pins category/severity/status to known values.
function cleanFlag(f: ItemFlag): ItemFlag {
  const cat = (['damage', 'maintenance', 'general'] as const).includes(f.category as never)
    ? f.category
    : 'general';
  const sev = (['low', 'med', 'high'] as const).includes(f.severity as never) ? f.severity : 'med';
  const out: ItemFlag = {
    status: f.status === 'resolved' ? 'resolved' : 'open',
    category: cat,
    severity: sev,
    note: String(f.note ?? ''),
  };
  // Preserve the id + the timestamps/by/resolution stamps so an open->resolved transition keeps its
  // history (the modal builds these via addFlag/resolveFlag; we keep them verbatim).
  const anyF = f as Record<string, unknown>;
  if (typeof anyF.id === 'string') (out as Record<string, unknown>).id = anyF.id;
  if (typeof anyF.flaggedAt === 'string') (out as Record<string, unknown>).flaggedAt = anyF.flaggedAt;
  if (typeof anyF.flaggedBy === 'string') (out as Record<string, unknown>).flaggedBy = anyF.flaggedBy;
  if (typeof f.by === 'string') out.by = f.by;
  if (typeof f.resolvedAt === 'string') out.resolvedAt = f.resolvedAt;
  if (typeof f.resolvedBy === 'string') out.resolvedBy = f.resolvedBy;
  if (typeof f.resolution === 'string') out.resolution = f.resolution;
  // Light service workflow: keep the repair cost (number|null) + the tech who handled it.
  if (f.repairCost != null && f.repairCost !== ('' as unknown)) {
    const c = Number(f.repairCost);
    if (Number.isFinite(c) && c >= 0) out.repairCost = c;
  }
  if (typeof f.assignedTech === 'string' && f.assignedTech.trim()) out.assignedTech = f.assignedTech.trim();
  return out;
}

interface UpsertItemArgs {
  id: string;
  patch: ItemPatch;
  actorRole: string;
}

/**
 * Persist an item-editor / flag / resolve patch. Authorizes db.write.app (authorized+), filters the
 * patch to the editable allowlist, sanitizes each field, then $sets under payload.* + stamps
 * updatedAt. Throws WriteForbiddenError when the caller may not write, a plain Error when the item is
 * missing. This is the shared write the FlagItemModal/ResolveFlagModal/ItemDetailsModal use.
 */
export async function upsertItem({ id, patch, actorRole }: UpsertItemArgs): Promise<SaveEventResult> {
  if (!can('db.write.app', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to edit inventory.');
  }
  const _id = String(id);
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');

  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');

  const set: Record<string, unknown> = {};
  for (const key of ITEM_EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const raw = patch[key];
    switch (key) {
      case 'name':
        set['payload.name'] = String(raw ?? '').trim() || '(unnamed)';
        break;
      case 'kind':
        set['payload.kind'] = String(raw ?? '').trim() || 'peripheral';
        break;
      case 'sku':
      case 'qr':
      case 'storageNotes':
        set[`payload.${key}`] = String(raw ?? '').trim();
        break;
      case 'status':
        set['payload.status'] = raw === 'out_of_service' ? 'out_of_service' : null;
        break;
      case 'tracking':
        set['payload.tracking'] = raw === 'serial' ? 'serial' : 'bulk';
        break;
      case 'weight': {
        if (raw === '' || raw == null) set['payload.weight'] = '';
        else {
          const n = Number(raw);
          set['payload.weight'] = Number.isFinite(n) && n >= 0 ? n : '';
        }
        break;
      }
      case 'reorderPoint':
      case 'stockTotal':
      case 'serviceIntervalDays':
      case 'purchasePrice':
      case 'replacementCost':
      case 'powerWatts': {
        if (raw == null || raw === ('' as unknown)) set[`payload.${key}`] = null;
        else {
          const n = Number(raw);
          set[`payload.${key}`] = Number.isFinite(n) ? Math.max(0, n) : null;
        }
        break;
      }
      case 'requiresPower': {
        set[`payload.${key}`] = raw === true;
        break;
      }
      case 'plugType':
      case 'fixedPlug': {
        set[`payload.${key}`] = String(raw ?? '').trim().slice(0, 60);
        break;
      }
      case 'powerVolts': {
        set[`payload.${key}`] = raw === '120' || raw === '240' ? raw : 'auto';
        break;
      }
      case 'cable': {
        // Sanitize the cable spec to the known lean shape (kind === 'cable'); null clears it.
        if (raw == null) {
          set[`payload.${key}`] = null;
          break;
        }
        const c = raw as Record<string, unknown>;
        const cat = String(c.category ?? '').trim();
        const category = ['cable', 'power-strip', 'extension', 'adapter', 'custom'].includes(cat) ? cat : 'custom';
        // Extension cords are ALWAYS one female (count pinned to 1); other single-female categories
        // honor the count.
        const count = Number(c.femaleCount);
        const len = Number(c.lengthFt);
        // Per-end genders are a CUSTOM-only concept (only custom may be male→male / female→female);
        // the standard categories stay structurally male→female via maleEnd/femaleEnd.
        const ends =
          category === 'custom' && Array.isArray(c.ends)
            ? (c.ends as Record<string, unknown>[]).slice(0, 2).map((e) => ({
                id: String(e?.id ?? '').trim().slice(0, 40),
                gender: e?.gender === 'female' ? ('female' as const) : ('male' as const),
              }))
            : undefined;
        // POWER STRIP only: the female-outlet MIX — distinct types each with a count (8× C13 + 2× C19).
        const femaleEnds =
          category === 'power-strip' && Array.isArray(c.femaleEnds)
            ? (c.femaleEnds as Record<string, unknown>[])
                .slice(0, 12)
                .map((r) => ({
                  end: String(r?.end ?? '').trim().slice(0, 40),
                  count: Math.min(48, Math.max(1, Math.round(Number(r?.count)) || 1)),
                }))
                .filter((r) => r.end)
            : undefined;
        set[`payload.${key}`] = {
          category,
          maleEnd: String(c.maleEnd ?? '').trim().slice(0, 40),
          femaleEnd: String(c.femaleEnd ?? '').trim().slice(0, 40),
          femaleCount: category === 'extension' ? 1 : Number.isFinite(count) ? Math.min(24, Math.max(1, Math.round(count))) : 1,
          lengthFt: Number.isFinite(len) && len > 0 ? Math.min(500, len) : null,
          notes: String(c.notes ?? '').trim().slice(0, 200),
          ...(ends ? { ends } : {}),
          ...(femaleEnds ? { femaleEnds } : {}),
        };
        break;
      }
      case 'purchaseDate':
      case 'nextServiceDate': {
        const s = String(raw ?? '').trim();
        set[`payload.${key}`] = isIsoDate(s) ? s : null;
        break;
      }
      case 'skuOptions': {
        const arr = Array.isArray(raw) ? (raw as SkuOption[]) : [];
        set['payload.skuOptions'] = arr
          .filter((o) => o && String(o.sku ?? '').trim())
          .map((o) => ({ sku: String(o.sku).trim(), label: String(o.label ?? '').trim() }));
        break;
      }
      case 'tagIds': {
        const arr = Array.isArray(raw) ? raw.map((t) => String(t)).filter(Boolean) : [];
        set['payload.tagIds'] = arr;
        break;
      }
      case 'distribution': {
        const arr = Array.isArray(raw) ? (raw as DistributionRow[]) : [];
        set['payload.distribution'] = arr.map(cleanDistRow);
        break;
      }
      case 'units': {
        const arr = Array.isArray(raw) ? (raw as ItemUnit[]) : [];
        set['payload.units'] = arr.map(cleanUnit);
        break;
      }
      case 'flags': {
        const arr = Array.isArray(raw) ? (raw as ItemFlag[]) : [];
        set['payload.flags'] = arr.map(cleanFlag);
        break;
      }
      case 'requirements': {
        // #27 kit BOM — drop rows with no target; pin kind/mode; coerce qty to a positive int so a
        // crafted post can't smuggle arbitrary keys or a negative quantity onto a requirement line.
        const arr = Array.isArray(raw) ? (raw as KitRequirement[]) : [];
        set['payload.requirements'] = arr
          .filter((r) => r && r.partRef && String(r.partRef.ref ?? '').trim())
          .map<KitRequirement>((r) => ({
            partRef: { kind: r.partRef.kind === 'tag' ? 'tag' : 'item', ref: String(r.partRef.ref).trim() },
            qty: Math.max(1, Math.floor(Number(r.qty) || 1)),
            mode: r.mode === 'exact' ? 'exact' : 'atLeast',
            consumable: !!r.consumable,
            note: String(r.note ?? '').trim(),
          }));
        break;
      }
    }
  }

  set['payload.id'] = _id; // keep the flat id in lockstep with the envelope _id
  set.updatedAt = Date.now();

  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Manifest: attach an item LOOSE to an event ("or add a loose item" → AddItemToCaseModal) ─────
// Faithful to window.addLooseDistribution (index.html ~L5730) + the manifest loose-add call site
// (~L16522): append a { caseId:null, eventId, qty, serials:[], state:'pending', looseAttach } row to
// the item's distribution, then log a 'loose-add' audit entry on the event. The manifest call site
// always uses qty 1 + no serials, so we don't run the serial-exclusivity graph check here (it only
// matters when attaching serialed quantities — not this path).
//
// AUTHZ: gated by `looseitem.manage` (lead+ — the loose-item management tier; mirrors
// looseItemPolicy.canAdd = rank>=2). Re-checked here with can(). The event is loaded + the eventId is
// pinned to a scalar; we $set ONLY payload.distribution on the item + payload.audit on the event.

interface AddLooseArgs {
  itemId: string;
  eventId: string;
  actorEmail: string;
  actorRole: string;
  actorName?: string;
  /** Optional audit note (e.g. "via manifest add-cases modal"). */
  note?: string;
}

export interface AddLooseResult {
  ok: boolean;
  itemId: string;
  eventId: string;
}

export async function addLooseDistribution({
  itemId,
  eventId,
  actorEmail,
  actorRole,
  actorName,
  note,
}: AddLooseArgs): Promise<AddLooseResult> {
  if (!can('looseitem.manage', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to manage loose inventory (lead or higher).');
  }
  const _id = String(itemId);
  const evId = String(eventId);
  if (!evId) throw new Error('An event is required to attach a loose item.');

  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const inv = db.collection<InventoryDoc>('inventory');

  // Both targets must exist (and not be tombstoned).
  const [storedEvent, storedItem] = await Promise.all([
    events.findOne({ _id: evId, ...NOT_DELETED }),
    inv.findOne({ _id, ...NOT_DELETED }),
  ]);
  if (!storedEvent) throw new Error('Event not found (or deleted).');
  if (!storedItem) throw new Error('Inventory item not found (or deleted).');

  const now = Date.now();
  const item = storedItem.payload || {};
  const dist = Array.isArray(item.distribution) ? item.distribution.slice() : [];
  // Append the loose row (matches addLooseDistribution's shape exactly).
  dist.push({
    caseId: null,
    eventId: evId,
    qty: 1,
    serials: [],
    state: 'pending',
    looseAttach: { by: actorEmail || actorName || 'unknown', at: now, reason: 'manual' },
  });

  // Append the audit entry on the event (logEventAudit's flat row).
  const audit = Array.isArray((storedEvent.payload as Record<string, unknown>).audit)
    ? ((storedEvent.payload as Record<string, unknown>).audit as Record<string, unknown>[]).slice()
    : [];
  audit.push({
    at: now,
    type: 'loose-add',
    itemId: _id,
    itemLabel: item.name || item.slug || _id,
    caseId: null,
    kind: null,
    byEmail: actorEmail || 'system',
    byName: actorName || actorEmail || 'System',
    note: note || 'via manifest add-cases modal',
  });

  await Promise.all([
    inv.updateOne(
      { _id, ...NOT_DELETED },
      { $set: { 'payload.distribution': dist, 'payload.id': _id, updatedAt: now } }
    ),
    events.updateOne(
      { _id: evId, ...NOT_DELETED },
      { $set: { 'payload.audit': audit, 'payload.id': evId, updatedAt: now } }
    ),
  ]);

  return { ok: true, itemId: _id, eventId: evId };
}

// ─── Manifest: CREATE a fresh item then attach it loose (the picker's "Create new item") ─────────
// Faithful to the manifest add-cases modal's onCreateNew (index.html ~L16547): mint a blank item via
// the blankItem factory (a locked UUID, tracking 'bulk', one empty distribution row), name it, insert
// it, then loose-attach it to the event (+ the audit entry). Same `looseitem.manage` (lead+) gate as
// addLooseDistribution. Inserts ONE new inventory doc with a server-minted UUID (the client never
// supplies the id — a crafted id can't clobber an existing item).
interface CreateLooseItemArgs {
  name: string;
  eventId: string;
  actorEmail: string;
  actorRole: string;
  actorName?: string;
}

export async function createLooseItem({
  name,
  eventId,
  actorEmail,
  actorRole,
  actorName,
}: CreateLooseItemArgs): Promise<AddLooseResult> {
  if (!can('looseitem.manage', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to manage loose inventory (lead or higher).');
  }
  const evId = String(eventId);
  if (!evId) throw new Error('An event is required to attach a loose item.');

  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const inv = db.collection<InventoryDoc>('inventory');

  const storedEvent = await events.findOne({ _id: evId, ...NOT_DELETED });
  if (!storedEvent) throw new Error('Event not found (or deleted).');

  const id = generateId();
  const now = Date.now();
  const cleanName = String(name ?? '').trim() || 'New loose item';

  // The blankItem factory shape (index.html ~L20389) — bulk, one empty distribution row, then the
  // loose row appended below.
  const payload: InventoryPayload = {
    id,
    slug: id,
    kind: 'peripheral',
    name: cleanName,
    sku: '',
    skuOptions: [],
    qr: '',
    status: null,
    weight: '',
    tracking: 'bulk',
    flags: [],
    units: [],
    distribution: [
      {
        caseId: null,
        eventId: evId,
        qty: 1,
        serials: [],
        state: 'pending',
        looseAttach: { by: actorEmail || actorName || 'unknown', at: now, reason: 'manual' },
      },
    ],
    stockTotal: null,
    reorderPoint: null,
    storageNotes: '',
    tagIds: [],
  };
  await inv.insertOne({ _id: id, payload, createdAt: now, updatedAt: now, deletedAt: null } as InventoryDoc);

  // Audit on the event (the new-item variant note).
  const audit = Array.isArray((storedEvent.payload as Record<string, unknown>).audit)
    ? ((storedEvent.payload as Record<string, unknown>).audit as Record<string, unknown>[]).slice()
    : [];
  audit.push({
    at: now,
    type: 'loose-add',
    itemId: id,
    itemLabel: cleanName,
    caseId: null,
    kind: null,
    byEmail: actorEmail || 'system',
    byName: actorName || actorEmail || 'System',
    note: 'new item via manifest add-cases modal',
  });
  await events.updateOne(
    { _id: evId, ...NOT_DELETED },
    { $set: { 'payload.audit': audit, 'payload.id': evId, updatedAt: now } }
  );

  return { ok: true, itemId: id, eventId: evId };
}

// ─── Scan-pack: shared audit helper ────────────────────────────────────────────────────────────
// Faithful to window.logEventAudit (index.html ~L5317): append ONE flat row to event.payload.audit
// + stamp updatedAt. Only logs when the case has a holding EVENT (standalone scans skip the trail —
// per-row packedBy/packedAt is the standalone record). Pins the event _id to a scalar; loads the
// stored event so a missing/deleted event is a quiet no-op (the pack already succeeded).
interface ScanAuditEntry {
  type: string;
  kind?: string | null;
  caseId?: string | null;
  itemId?: string | null;
  itemLabel?: string | null;
  note?: string;
}
async function logScanAudit(
  eventId: string | null,
  entry: ScanAuditEntry,
  actor: { email?: string; name?: string }
): Promise<void> {
  if (!eventId) return;
  const evId = String(eventId);
  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const stored = await events.findOne({ _id: evId, ...NOT_DELETED });
  if (!stored) return;
  const now = Date.now();
  const audit = Array.isArray((stored.payload as Record<string, unknown>).audit)
    ? ((stored.payload as Record<string, unknown>).audit as Record<string, unknown>[]).slice()
    : [];
  audit.push({
    at: now,
    type: entry.type,
    itemId: entry.itemId ?? null,
    itemLabel: entry.itemLabel ?? null,
    caseId: entry.caseId ?? null,
    kind: entry.kind ?? null,
    byEmail: actor.email || 'system',
    byName: actor.name || actor.email || 'System',
    note: entry.note || '',
  });
  await events.updateOne({ _id: evId, ...NOT_DELETED }, { $set: { 'payload.audit': audit, 'payload.id': evId, updatedAt: now } });
}

// Resolve the holding event for a case (the FIRST event in a pack/unpack state holding it). Mirrors
// caseEventContext's event resolution — used so the scan writes can log the audit on the right event
// + verify the loose/disposition gates. Returns null for a standalone (no holder).
const HELD_PACK_STATES: ReadonlySet<string> = new Set(['packing', 'ready', 'in_transit', 'onsite', 'returning', 'unpacking']);
async function holdingEventForCase(caseId: string): Promise<{ id: string; payload: EventPayload } | null> {
  const cId = String(caseId);
  const db = await getDb();
  const events = await db.collection<EventDoc>('events').find(NOT_DELETED).toArray();
  for (const e of events) {
    if (!HELD_PACK_STATES.has(String(e.payload.state))) continue;
    if ((e.payload.cases || []).includes(cId)) return { id: e._id, payload: e.payload };
  }
  return null;
}

// ─── Scan-pack: ADD an item to the active case (+ optionally mark packed) ───────────────────────
// The pending "Add to <case>?" prompt's Add / Add+pack. Faithful to assignItemToCase + markRowPacked
// (index.html ~L6728/6802): a BULK add bumps (or creates) the matching distribution row's qty; a
// SERIAL add relocates one in-storage unit into the case (or registers a blank-serial unit there).
// Add+pack then stamps the row/units packed. Gated by scan.pack (authorized+) — re-checked here.
interface AddToCaseArgs {
  itemId: string;
  caseId: string;
  alsoPack: boolean;
  actorRole: string;
  actor: PackByActor;
}
export async function addItemToCase({ itemId, caseId, alsoPack, actorRole, actor }: AddToCaseArgs): Promise<PackItemResult> {
  if (!can('scan.pack', actorRole)) throw new WriteForbiddenError('You do not have permission to pack cases.');
  const _id = String(itemId);
  const cId = String(caseId);
  if (!cId) throw new Error('A case is required to add into.');
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');
  const item = stored.payload || {};
  const now = Date.now();
  const by: PackByActor | null = actor?.email || actor?.name ? { email: actor.email, name: actor.name } : null;
  const set: Record<string, unknown> = {};

  if (item.tracking === 'serial') {
    const units = Array.isArray(item.units) ? item.units.slice() : [];
    // Relocate a free in-storage unit into the case; else register a new blank-serial unit there.
    const freeIdx = units.findIndex((u) => u && !u.deletedAt && (!u.location || u.location === 'storage'));
    if (freeIdx >= 0) {
      units[freeIdx] = { ...units[freeIdx], location: cId, state: 'pending', storageNote: '' };
    } else {
      units.push({ id: 'unit-' + now.toString(36) + Math.random().toString(36).slice(2, 6), serial: '', location: cId, storageNote: '', state: 'pending', flags: [] });
    }
    if (alsoPack) {
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u && !u.deletedAt && u.location === cId) units[i] = { ...u, state: 'packed', packedBy: by, packedAt: now };
      }
    }
    set['payload.units'] = units;
  } else {
    const dist = Array.isArray(item.distribution) ? item.distribution.slice() : [];
    let idx = dist.findIndex((d) => d && d.caseId === cId);
    if (idx === -1) {
      dist.push({ caseId: cId, qty: 0, serials: [], state: 'pending' });
      idx = dist.length - 1;
    }
    const row = { ...dist[idx] };
    row.qty = (Number(row.qty) || 0) + 1;
    if (alsoPack) {
      row.state = 'packed';
      row.packedBy = by;
      row.packedAt = now;
    }
    dist[idx] = row;
    set['payload.distribution'] = dist;
  }

  set['payload.id'] = _id;
  set.updatedAt = now;
  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });

  // Audit on the holding event (add / add-and-pack).
  const holder = await holdingEventForCase(cId);
  await logScanAudit(holder?.id ?? null, {
    type: 'scan-pack',
    kind: alsoPack ? 'add-and-pack' : 'add',
    caseId: cId,
    itemId: _id,
    itemLabel: item.name || item.sku || _id,
  }, actor);

  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount, state: alsoPack ? 'packed' : 'pending' };
}

// ─── Scan-pack a SPECIFIC spool: relocate the serial unit linked to a tag UID into the case ──────
// The NFC-spool flow: each consumable spool is a serial unit linked by tag UID (see updateItemTagData).
// Scanning that spool in scan-pack packs THAT unit (not just any free unit, the way addItemToCase does).
// If no unit carries the UID yet (e.g. a never-read tag), register one in the case. Gated scan.pack.
interface PackTaggedUnitArgs {
  itemId: string;
  caseId: string;
  tagUid: string;
  actorRole: string;
  actor: { email?: string; name?: string };
}
export async function packTaggedUnitIntoCase({ itemId, caseId, tagUid, actorRole, actor }: PackTaggedUnitArgs): Promise<PackItemResult> {
  if (!can('scan.pack', actorRole)) throw new WriteForbiddenError('You do not have permission to pack cases.');
  const _id = String(itemId);
  const cId = String(caseId);
  const uid = String(tagUid ?? '').trim();
  if (!cId) throw new Error('A case is required to pack into.');
  if (!uid) throw new Error('A tag UID is required.');
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');
  const item = stored.payload || {};
  const now = Date.now();
  const by: PackByActor | null = actor?.email || actor?.name ? { email: actor.email, name: actor.name } : null;
  const units: ItemUnit[] = Array.isArray(item.units) ? item.units.slice() : [];
  const idx = units.findIndex((u) => u && !u.deletedAt && u.tagUid === uid);
  if (idx >= 0) {
    units[idx] = { ...units[idx], location: cId, state: 'packed', storageNote: '', packedBy: by, packedAt: now };
  } else {
    units.push({
      id: 'unit-' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      serial: uid,
      tagUid: uid,
      location: cId,
      state: 'packed',
      storageNote: '',
      flags: [],
      packedBy: by,
      packedAt: now,
    });
  }
  const res = await col.updateOne(
    { _id, ...NOT_DELETED },
    { $set: { 'payload.units': units, 'payload.tracking': 'serial', 'payload.id': _id, updatedAt: now } }
  );
  const holder = await holdingEventForCase(cId);
  await logScanAudit(
    holder?.id ?? null,
    { type: 'scan-pack', kind: 'add-and-pack', caseId: cId, itemId: _id, itemLabel: item.name || item.sku || _id },
    actor
  );
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount, state: 'packed' };
}

// ─── Scan-return: set / cycle / clear a row's disposition (unpack mode) ─────────────────────────
// Faithful to cycleRowDisposition + markRowReturned + unsignOffItemRow (index.html ~L6832/3643): a
// disposition of 'ok'|'damaged'|'consumed'|'missing' writes the canonical d.signoff = { kind, at,
// byEmail, byName, role } on the case's distribution row (or every in-case serial unit); a null
// disposition CLEARS the signoff (+ the legacy flat fields). Gated by scan.pack (authorized+).
const VALID_DISPOSITIONS: ReadonlySet<string> = new Set(['ok', 'damaged', 'missing', 'consumed', 'sold', 'other']);
interface SetDispositionArgs {
  itemId: string;
  caseId: string;
  /** null clears; else one of ok|damaged|consumed|missing|other. */
  disposition: string | null;
  actorRole: string;
  actor: { email?: string; name?: string; role?: string };
}
export async function setRowDisposition({ itemId, caseId, disposition, actorRole, actor }: SetDispositionArgs): Promise<SaveEventResult> {
  if (!can('scan.pack', actorRole)) throw new WriteForbiddenError('You do not have permission to reconcile returns.');
  const _id = String(itemId);
  const cId = String(caseId);
  if (!cId) throw new Error('A case is required.');
  const disp = disposition == null ? null : (disposition === 'clean' ? 'ok' : String(disposition));
  if (disp != null && !VALID_DISPOSITIONS.has(disp)) throw new Error('Invalid disposition.');

  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');
  const item = stored.payload || {};
  const now = Date.now();
  const signoff =
    disp == null
      ? null
      : { kind: disp, at: now, byEmail: actor.email || '', byName: actor.name || '', role: actor.role || '', note: '' };
  const set: Record<string, unknown> = {};

  if (item.tracking === 'serial') {
    const units = Array.isArray(item.units) ? item.units : [];
    const inCase = units.filter((u) => u && !u.deletedAt && u.location === cId);
    if (inCase.length === 0) throw new Error('That item is not routed into this case.');
    set['payload.units'] = units.map((u) =>
      u && !u.deletedAt && u.location === cId ? { ...u, signoff: signoff ? { ...signoff } : null } : u
    );
  } else {
    const dist = Array.isArray(item.distribution) ? item.distribution : [];
    const idx = dist.findIndex((d) => d && d.caseId === cId);
    if (idx === -1) throw new Error('That item is not routed into this case.');
    set['payload.distribution'] = dist.map((d, i) => {
      if (i !== idx) return d;
      // Clear nulls the canonical signoff + the legacy flat fields (returnDisposition/returnedBy/At).
      const next: Record<string, unknown> = { ...d, signoff };
      if (disp == null) {
        next.returnDisposition = null;
        next.returnedBy = null;
        next.returnedAt = null;
      }
      return next;
    });
  }

  set['payload.id'] = _id;
  set.updatedAt = now;
  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });

  const holder = await holdingEventForCase(cId);
  await logScanAudit(holder?.id ?? null, {
    type: 'scan-pack',
    kind: 'disposition-' + (disp || 'clear'),
    caseId: cId,
    itemId: _id,
    itemLabel: item.name || item.sku || _id,
  }, actor);

  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Scan-return: mark every UNSCANNED (no-disposition) row in a case MISSING ───────────────────
// Faithful to markUnscannedMissing (index.html ~L17008): for the active case, every routed item whose
// row carries NO disposition gets stamped 'missing'. One write per affected item (each row is on its
// own item doc). Gated by scan.pack (authorized+). Returns the count touched.
interface MarkMissingArgs {
  caseId: string;
  actorRole: string;
  actor: { email?: string; name?: string; role?: string };
}
export async function markUnscannedMissing({ caseId, actorRole, actor }: MarkMissingArgs): Promise<{ ok: boolean; marked: number }> {
  if (!can('scan.pack', actorRole)) throw new WriteForbiddenError('You do not have permission to reconcile returns.');
  const cId = String(caseId);
  if (!cId) throw new Error('A case is required.');
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const all = await col.find(NOT_DELETED).toArray();
  const now = Date.now();
  const signoff = { kind: 'missing', at: now, byEmail: actor.email || '', byName: actor.name || '', role: actor.role || '', note: '' };
  let marked = 0;

  for (const doc of all) {
    const item = doc.payload || {};
    const set: Record<string, unknown> = {};
    if (item.tracking === 'serial') {
      const units = Array.isArray(item.units) ? item.units : [];
      const inCase = units.filter((u) => u && !u.deletedAt && u.location === cId);
      if (inCase.length === 0) continue;
      // The synthesized serial row's disposition is null UNLESS every in-case unit is signed
      // (matches caseContents). A null-disposition row is "unscanned" → mark every in-case unit
      // missing (markRowReturned for serial overwrites them all, mirroring the Python).
      const allSigned = inCase.every((u) => u.signoff);
      if (allSigned) continue;
      set['payload.units'] = units.map((u) =>
        u && !u.deletedAt && u.location === cId ? { ...u, signoff: { ...signoff } } : u
      );
    } else {
      const dist = Array.isArray(item.distribution) ? item.distribution : [];
      const idx = dist.findIndex((d) => d && d.caseId === cId);
      if (idx === -1) continue;
      const row = dist[idx] as Record<string, unknown>;
      const hasDisp = !!(row.signoff && (row.signoff as Record<string, unknown>).kind) || !!row.returnDisposition;
      if (hasDisp) continue;
      set['payload.distribution'] = dist.map((d, i) => (i === idx ? { ...d, signoff: { ...signoff } } : d));
    }
    set['payload.id'] = doc._id;
    set.updatedAt = now;
    await col.updateOne({ _id: doc._id, ...NOT_DELETED }, { $set: set });
    marked++;
  }

  const holder = await holdingEventForCase(cId);
  await logScanAudit(holder?.id ?? null, { type: 'scan-pack', kind: 'mark-unscanned-missing', caseId: cId }, actor);
  return { ok: true, marked };
}

// ─── Inventory: BULK operations (the inventory bulk toolbar) ───────────────────────────────────
// Faithful ports of reassignItems / patchItems / removeItemsByIds + the bulk attach-event loop
// (index.html ~L9348-9387 + ~L20340-20379). Each is gated by db.write.app (authorized+ — the
// warehouse-worker stock-maintenance tier; the SAME gate as the per-item editor) and re-checked
// here with can(). Every target _id is String()-pinned (the NoSQL-operator defense) and loaded so a
// crafted/missing id is a quiet skip, never a clobber. We $set ONLY the touched payload fields
// (distribution|units for reassign; the per-row/unit state for set-state) + the tombstone for delete.

/** Bulk REASSIGN: move every selected item into one target case (or detach to storage/unassigned).
 *  Serial → relocate every unit to the case (or storage); bulk → collapse to one distribution row
 *  on the target case carrying the summed qty + pooled serials. */
export async function bulkReassignToCase({
  ids,
  caseId,
  actorRole,
}: {
  ids: string[];
  caseId: string | null;
  actorRole: string;
}): Promise<{ ok: boolean; count: number }> {
  if (!can('db.write.app', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to edit inventory.');
  }
  const cId = caseId ? String(caseId) : null;
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  // If a destination case is given, validate it exists + is not retired (parity with the modal,
  // which only lists live, non-retired cases). A null caseId is always allowed (detach).
  if (cId) {
    const c = await db.collection<CaseDoc>('cases').findOne({ _id: cId, ...NOT_DELETED });
    if (!c) throw new Error('That case no longer exists.');
    if (c.payload?.retiredAt) throw new Error('You cannot reassign into a retired case.');
  }
  const now = Date.now();
  let count = 0;
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const _id = String(rawId);
    const stored = await col.findOne({ _id, ...NOT_DELETED });
    if (!stored) continue;
    const item = stored.payload || {};
    const set: Record<string, unknown> = {};
    if (item.tracking === 'serial') {
      const loc = cId || 'storage';
      const units = (Array.isArray(item.units) ? item.units : []).map((u) => ({
        ...u,
        location: loc,
        storageNote: loc === 'storage' ? u.storageNote || '' : '',
        state: (loc === 'storage' ? 'draft' : 'pending') as ItemUnit['state'],
      }));
      set['payload.units'] = units;
    } else {
      const dist = Array.isArray(item.distribution) ? item.distribution : [];
      const totalQty = dist.reduce((s, d) => s + (d.qty || 0), 0) || 1;
      const allSerials = dist.flatMap((d) => (Array.isArray(d.serials) ? d.serials : []));
      const prevState = (dist[0]?.state || 'pending') as DistributionRow['state'];
      set['payload.distribution'] = [{ caseId: cId, qty: totalQty, serials: allSerials, state: prevState }];
    }
    set['payload.id'] = _id;
    set.updatedAt = now;
    const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
    if (res.matchedCount > 0) count++;
  }
  return { ok: true, count };
}

/** Bulk SET STATE: stamp every selected item's per-case rows/units to one state. */
export async function bulkSetState({
  ids,
  state,
  actorRole,
}: {
  ids: string[];
  state: string;
  actorRole: string;
}): Promise<{ ok: boolean; count: number }> {
  if (!can('db.write.app', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to edit inventory.');
  }
  const st = (['draft', 'pending', 'packed', 'flagged'] as const).includes(state as never)
    ? (state as ItemUnit['state'])
    : 'pending';
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const now = Date.now();
  let count = 0;
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const _id = String(rawId);
    const stored = await col.findOne({ _id, ...NOT_DELETED });
    if (!stored) continue;
    const item = stored.payload || {};
    const set: Record<string, unknown> = {};
    if (item.tracking === 'serial') {
      set['payload.units'] = (Array.isArray(item.units) ? item.units : []).map((u) => ({ ...u, state: st }));
    } else {
      set['payload.distribution'] = (Array.isArray(item.distribution) ? item.distribution : []).map((d) => ({ ...d, state: st }));
    }
    set['payload.id'] = _id;
    set.updatedAt = now;
    const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
    if (res.matchedCount > 0) count++;
  }
  return { ok: true, count };
}

/** Bulk DELETE: soft-delete every selected item (deletedAt tombstone replicates). */
export async function bulkDeleteItems({
  ids,
  actorRole,
}: {
  ids: string[];
  actorRole: string;
}): Promise<{ ok: boolean; count: number }> {
  if (!can('db.write.app', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to delete inventory.');
  }
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const now = Date.now();
  let count = 0;
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const _id = String(rawId);
    const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: { deletedAt: now, updatedAt: now } });
    if (res.matchedCount > 0) count++;
  }
  return { ok: true, count };
}

/** Bulk ATTACH TO EVENT (loose): append a loose distribution row on each selected item + log ONE
 *  summary audit entry on the target event. Lead+ (looseitem.manage). A serial item is refused
 *  (the manifest loose-add path is bulk-row-only — matches the Python, which skips serial conflicts
 *  but lands the siblings). Returns the attached/refused counts so the toast can summarise. */
export async function bulkAttachToEvent({
  ids,
  eventId,
  actorEmail,
  actorRole,
  actorName,
}: {
  ids: string[];
  eventId: string;
  actorEmail: string;
  actorRole: string;
  actorName?: string;
}): Promise<{ ok: boolean; attached: number; refused: number }> {
  if (!can('looseitem.manage', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to manage loose inventory (lead or higher).');
  }
  const evId = String(eventId);
  if (!evId) throw new Error('An event is required to attach loose items.');
  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const inv = db.collection<InventoryDoc>('inventory');

  const storedEvent = await events.findOne({ _id: evId, ...NOT_DELETED });
  if (!storedEvent) throw new Error('Event not found (or deleted).');
  // Only future events accept fresh loose inventory (the modal filters to draft/upcoming/packing).
  const ELIGIBLE = new Set(['draft', 'upcoming', 'packing']);
  if (!ELIGIBLE.has(String(storedEvent.payload.state))) {
    throw new Error('You can only attach loose inventory to a draft, upcoming, or packing event.');
  }

  const now = Date.now();
  let attached = 0;
  let refused = 0;
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const _id = String(rawId);
    const stored = await inv.findOne({ _id, ...NOT_DELETED });
    if (!stored) continue;
    const item = stored.payload || {};
    // Serial conflict: the loose-add path is bulk-row only (the Python refuses serial here).
    if (item.tracking === 'serial') {
      refused++;
      continue;
    }
    const dist = Array.isArray(item.distribution) ? item.distribution.slice() : [];
    dist.push({
      caseId: null,
      eventId: evId,
      qty: 1,
      serials: [],
      state: 'pending',
      looseAttach: { by: actorEmail || actorName || 'unknown', at: now, reason: 'manual' },
    });
    await inv.updateOne({ _id, ...NOT_DELETED }, { $set: { 'payload.distribution': dist, 'payload.id': _id, updatedAt: now } });
    attached++;
  }

  // One summary audit entry on the event (mirrors the Python's single bulk-attach audit row).
  if (attached > 0) {
    const audit = Array.isArray((storedEvent.payload as Record<string, unknown>).audit)
      ? ((storedEvent.payload as Record<string, unknown>).audit as Record<string, unknown>[]).slice()
      : [];
    audit.push({
      at: now,
      type: 'loose-add',
      itemId: null,
      itemLabel: attached + ' inventory item' + (attached === 1 ? '' : 's'),
      caseId: null,
      kind: null,
      byEmail: actorEmail || 'system',
      byName: actorName || actorEmail || 'System',
      note: 'bulk attach via inventory tab',
    });
    await events.updateOne({ _id: evId, ...NOT_DELETED }, { $set: { 'payload.audit': audit, 'payload.id': evId, updatedAt: now } });
  }
  return { ok: true, attached, refused };
}

// ─── Inventory: CSV import commit (create / update-by-id) ──────────────────────────────────────
// Faithful to the InventoryPanel CSV commit (index.html ~L19994/20013): the DRY-RUN mapping +
// validation + the #43 skuOptions parsing live client-side; this just persists the validated rows.
// A blank/unknown id INSERTS a blank bulk item (server mints a fresh UUID — a client id is NEVER
// trusted as the _id, so a crafted id can't clobber an existing item); a known id UPDATEs by $set
// into payload.* over the catalog field allowlist. distribution/units are NOT touched on an update
// (the scan/pack flows own them) — only an INSERT seeds an empty distribution row. Gated by
// db.write.app (authorized+).
export interface InventoryCsvRowInput {
  id?: string;
  name?: string;
  sku?: string;
  qr?: string;
  kind?: string;
  stockTotal?: number | null;
  reorderPoint?: number | null;
  storageNotes?: string;
  skuOptions?: SkuOption[];
}
export async function applyInventoryCsvImport({
  rows,
  actorRole,
}: {
  rows: InventoryCsvRowInput[];
  actorRole: string;
}): Promise<CsvImportResult> {
  if (!can('db.write.app', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to import inventory.');
  }
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const existing = await col.find(NOT_DELETED).project({ _id: 1 }).toArray();
  const known = new Set(existing.map((d) => d._id));

  let created = 0;
  let updated = 0;
  const now = Date.now();
  const KIND_OK = new Set<string>(['equipment', 'peripheral', 'consumable', 'tool', 'banner', 'fixture', 'system']);

  const cleanSkuOptions = (raw: SkuOption[] | undefined): SkuOption[] =>
    (Array.isArray(raw) ? raw : [])
      .filter((o) => o && String(o.sku ?? '').trim())
      .map((o) => ({ sku: String(o.sku).trim(), label: String(o.label ?? '').trim() }));
  const cleanNum = (v: number | null | undefined): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, n) : null;
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    const claimedId = String(row.id ?? '').trim();
    const name = String(row.name ?? '').trim() || '(unnamed)';
    const kindRaw = String(row.kind ?? '').trim().toLowerCase();
    const kind = KIND_OK.has(kindRaw) ? kindRaw : 'peripheral';
    const fields = {
      name,
      sku: String(row.sku ?? '').trim(),
      qr: String(row.qr ?? '').trim(),
      kind,
      stockTotal: cleanNum(row.stockTotal),
      reorderPoint: cleanNum(row.reorderPoint),
      storageNotes: String(row.storageNotes ?? '').trim(),
      skuOptions: cleanSkuOptions(row.skuOptions),
    };
    if (claimedId && known.has(claimedId)) {
      await col.updateOne(
        { _id: claimedId, ...NOT_DELETED },
        {
          $set: {
            'payload.name': fields.name,
            'payload.sku': fields.sku,
            'payload.qr': fields.qr,
            'payload.kind': fields.kind,
            'payload.stockTotal': fields.stockTotal,
            'payload.reorderPoint': fields.reorderPoint,
            'payload.storageNotes': fields.storageNotes,
            'payload.skuOptions': fields.skuOptions,
            'payload.id': claimedId,
            updatedAt: now,
          },
        }
      );
      updated++;
    } else {
      const id = generateId();
      const payload: InventoryPayload = {
        id,
        slug: id,
        kind: fields.kind,
        name: fields.name,
        sku: fields.sku,
        skuOptions: fields.skuOptions,
        qr: fields.qr,
        status: null,
        weight: '',
        tracking: 'bulk',
        flags: [],
        units: [],
        distribution: [{ caseId: null, qty: 1, serials: [], state: 'pending' }],
        stockTotal: fields.stockTotal,
        reorderPoint: fields.reorderPoint,
        storageNotes: fields.storageNotes,
        tagIds: [],
        requirements: [],
      };
      await col.insertOne({ _id: id, payload, createdAt: now, updatedAt: now, deletedAt: null } as InventoryDoc);
      created++;
    }
  }
  return { ok: true, created, updated };
}

// ─── Warehouses (return-address config) CRUD ───────────────────────────────────────────────────
// Faithful port of eitConfig.upsertWarehouse / deleteWarehouse (index.html ~L6311-6334). A warehouse
// is the return-address entity a roadcase homes at; its 4×6 shipping label prints that address + the
// per-warehouse #71 contact. Gated by `pallets.edit` (authorized+ — the SAME warehouse-worker tier
// that homes a case at a warehouse). The envelope discipline matches the rest of lib/write: $set INTO
// payload.* over an editable allowlist, stamp updatedAt; create mints a server-side UUID (a
// client-supplied id is NEVER trusted as the _id); delete is a deletedAt tombstone so it replicates.

const WAREHOUSE_EDITABLE_FIELDS = [
  'name',
  'type',
  'street',
  'city',
  'region',
  'postal',
  'country',
  'phone',
  'contactName',
  'contactRole',
  'contactEmail',
  'lat',
  'lng',
] as const;

export interface WarehouseWritePayload {
  id?: string;
  name?: string;
  type?: 'hq' | 'sub';
  street?: string;
  city?: string;
  region?: string;
  postal?: string;
  country?: string;
  phone?: string;
  contactName?: string;
  contactRole?: string;
  contactEmail?: string;
  lat?: number | null;
  lng?: number | null;
}
export type WarehousePatch = Partial<WarehouseWritePayload>;

// Coerce one warehouse patch to a clean $set bag over the allowlist (never blanks the name; pins type).
function buildWarehouseSet(patch: WarehousePatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const key of WAREHOUSE_EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const raw = (patch as Record<string, unknown>)[key];
    if (key === 'type') {
      set['payload.type'] = raw === 'hq' ? 'hq' : 'sub';
    } else if (key === 'lat' || key === 'lng') {
      const n = Number(raw);
      set[`payload.${key}`] = raw == null || raw === '' || !Number.isFinite(n) ? null : n;
    } else {
      set[`payload.${key}`] = String(raw ?? '').trim();
    }
  }
  return set;
}

interface WarehouseDocLite {
  _id: string;
  payload: WarehouseWritePayload;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number | null;
}

/** CREATE a warehouse. pallets.edit (authorized+). Returns the minted id. */
export async function createWarehouse({ patch, actorRole }: { patch: WarehousePatch; actorRole: string }): Promise<{ ok: boolean; id: string }> {
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to manage warehouses.');
  }
  const name = String(patch.name ?? '').trim();
  if (!name) throw new Error('Warehouse name is required.');
  const db = await getDb();
  const col = db.collection<WarehouseDocLite>('warehouses');
  const id = generateId();
  const now = Date.now();
  const set = buildWarehouseSet(patch);
  const payload: WarehouseWritePayload = { id };
  for (const [k, v] of Object.entries(set)) payload[k.replace(/^payload\./, '') as keyof WarehouseWritePayload] = v as never;
  payload.name = name;
  payload.type = patch.type === 'hq' ? 'hq' : 'sub';
  await col.insertOne({ _id: id, payload, createdAt: now, updatedAt: now, deletedAt: null });
  return { ok: true, id };
}

/** SAVE (update) a warehouse by id. pallets.edit (authorized+). */
export async function saveWarehouse({ id, patch, actorRole }: { id: string; patch: WarehousePatch; actorRole: string }): Promise<SaveEventResult> {
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to manage warehouses.');
  }
  const _id = String(id);
  const db = await getDb();
  const col = db.collection<WarehouseDocLite>('warehouses');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Warehouse not found (or deleted).');
  const set = buildWarehouseSet(patch);
  // Never blank the name (the catalog/detail header reads it).
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    const nm = String(patch.name ?? '').trim();
    if (!nm) throw new Error('Warehouse name is required.');
    set['payload.name'] = nm;
  }
  set['payload.id'] = _id;
  set.updatedAt = Date.now();
  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

/** DELETE a warehouse (soft tombstone). pallets.edit (authorized+). Idempotent. */
export async function deleteWarehouse({ id, actorRole }: { id: string; actorRole: string }): Promise<SaveEventResult> {
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to manage warehouses.');
  }
  const _id = String(id);
  const db = await getDb();
  const now = Date.now();
  const res = await db.collection<WarehouseDocLite>('warehouses').updateOne({ _id, ...NOT_DELETED }, { $set: { deletedAt: now, updatedAt: now } });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Emergency contact (single fleet-wide record on every shipping label) ──────────────────────
// Faithful port of eitConfig.setEmergencyContact (index.html ~L6341): a single-record entity keyed
// 'main' on the `emergency_contact` collection. Gated by `emergency_contact.write` (manager+ — the
// supervisor PII tier; the SAME cap eit_perms assigns to writing the global contact). Save upserts;
// `clear` (rec=null) soft-deletes the row so the removal replicates to peers.
export interface EmergencyContactPayload {
  id?: string;
  name?: string;
  role?: string;
  phone?: string;
  email?: string;
}
interface EmergencyDocLite {
  _id: string;
  payload: EmergencyContactPayload;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number | null;
}

export async function saveEmergencyContact({
  rec,
  actorRole,
}: {
  rec: EmergencyContactPayload | null;
  actorRole: string;
}): Promise<{ ok: boolean; cleared: boolean }> {
  if (!can('emergency_contact.write', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to set the emergency contact (manager or higher).');
  }
  const db = await getDb();
  const col = db.collection<EmergencyDocLite>('emergency_contact');
  const now = Date.now();
  if (!rec) {
    // Clear → soft-delete the 'main' row (keep the tombstone so the clear replicates).
    await col.updateOne({ _id: 'main' }, { $set: { 'payload.id': 'main', deletedAt: now, updatedAt: now } }, { upsert: true });
    return { ok: true, cleared: true };
  }
  const payload: EmergencyContactPayload = {
    id: 'main',
    name: String(rec.name ?? '').trim(),
    role: String(rec.role ?? '').trim(),
    phone: String(rec.phone ?? '').trim(),
    email: String(rec.email ?? '').trim(),
  };
  await col.updateOne(
    { _id: 'main' },
    { $set: { payload, updatedAt: now, deletedAt: null }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  return { ok: true, cleared: false };
}

// ─── Kit BOM (#27) — save the requirements[] on an equipment model ─────────────────────────────
// A thin, named wrapper over upsertItem that writes ONLY the requirements[] (the kit-BOM editor's
// save path). Same db.write.app (authorized+) gate + sanitization as the full editor; provided as a
// distinct entry point so the kit-BOM Server Action reads clearly + can't accidentally touch other
// fields. The requirements are sanitized inside upsertItem's 'requirements' case.
export async function saveKitBom({
  id,
  requirements,
  actorRole,
}: {
  id: string;
  requirements: KitRequirement[];
  actorRole: string;
}): Promise<SaveEventResult> {
  return upsertItem({ id, patch: { requirements: Array.isArray(requirements) ? requirements : [] }, actorRole });
}

// ─── Scan-pack: loose-add an item to an event via a scan (qty 1, no serials) ────────────────────
// Faithful to handleAddLoose (index.html ~L16755): append a loose distribution row pegged to the URL
// event id + log a 'loose-add' audit entry. Gated by looseitem.manage (lead+). This is the
// scan-flow variant of the manifest addLooseDistribution above (a thin wrapper with the scan note).
export async function looseAddViaScan({
  itemId,
  eventId,
  actorEmail,
  actorRole,
  actorName,
}: AddLooseArgs): Promise<AddLooseResult> {
  return addLooseDistribution({ itemId, eventId, actorEmail, actorRole, actorName, note: 'via scan-pack' });
}

// ─── Scan adoption: attach a serial to an item (in a case) ──────────────────────────────────────
// Faithful to attachSerialToItem (index.html ~L6776): for a SERIAL item, locate the unit by serial
// and route it into the case (or register it there); for a BULK item, append the serial to the
// case's distribution row (creating the row if needed) and bump qty to cover it. Gated by scan.label
// (lead+ — adoption). Pins ids to scalars.
interface AttachSerialArgs {
  itemId: string;
  caseId: string;
  serial: string;
  actorRole: string;
}
export async function attachSerialToItem({ itemId, caseId, serial, actorRole }: AttachSerialArgs): Promise<SaveEventResult> {
  if (!can('scan.label', actorRole)) throw new WriteForbiddenError('You do not have permission to adopt codes (lead or higher).');
  const _id = String(itemId);
  const cId = String(caseId);
  const sn = String(serial ?? '').trim();
  if (!cId || !sn) throw new Error('A case and a serial are required.');
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');
  const item = stored.payload || {};
  const now = Date.now();
  const lower = sn.toLowerCase();
  const set: Record<string, unknown> = {};

  if (item.tracking === 'serial') {
    const units = Array.isArray(item.units) ? item.units.slice() : [];
    const idx = units.findIndex((u) => u && !u.deletedAt && String(u.serial || '').toLowerCase() === lower);
    if (idx >= 0) units[idx] = { ...units[idx], location: cId, state: 'pending', storageNote: '' };
    else units.push({ id: 'unit-' + now.toString(36) + Math.random().toString(36).slice(2, 6), serial: sn, location: cId, storageNote: '', state: 'pending', flags: [] });
    set['payload.units'] = units;
  } else {
    const dist = Array.isArray(item.distribution) ? item.distribution.slice() : [];
    let idx = dist.findIndex((d) => d && d.caseId === cId);
    if (idx === -1) {
      dist.push({ caseId: cId, qty: 0, serials: [], state: 'pending' });
      idx = dist.length - 1;
    }
    const row = { ...dist[idx] };
    const serials = Array.isArray(row.serials) ? row.serials.slice() : [];
    if (!serials.some((s) => String(s).toLowerCase() === lower)) {
      serials.push(sn);
      if ((Number(row.qty) || 0) < serials.length) row.qty = serials.length;
    }
    row.serials = serials;
    dist[idx] = row;
    set['payload.distribution'] = dist;
  }

  set['payload.id'] = _id;
  set.updatedAt = now;
  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Scan adoption: bump an item's qty in a case (count-only +1) ────────────────────────────────
// Faithful to bumpItemQtyInCase (index.html ~L6747) at delta +1: BULK bumps the case row's qty;
// SERIAL moves one in-storage unit into the case. Gated by scan.label (lead+).
interface BumpQtyArgs {
  itemId: string;
  caseId: string;
  actorRole: string;
}
export async function bumpItemQtyInCase({ itemId, caseId, actorRole }: BumpQtyArgs): Promise<SaveEventResult> {
  if (!can('scan.label', actorRole)) throw new WriteForbiddenError('You do not have permission to adopt codes (lead or higher).');
  const _id = String(itemId);
  const cId = String(caseId);
  if (!cId) throw new Error('A case is required.');
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');
  const item = stored.payload || {};
  const now = Date.now();
  const set: Record<string, unknown> = {};

  if (item.tracking === 'serial') {
    const units = Array.isArray(item.units) ? item.units.slice() : [];
    const freeIdx = units.findIndex((u) => u && !u.deletedAt && (!u.location || u.location === 'storage'));
    if (freeIdx >= 0) units[freeIdx] = { ...units[freeIdx], location: cId, state: 'pending', storageNote: '' };
    else units.push({ id: 'unit-' + now.toString(36) + Math.random().toString(36).slice(2, 6), serial: '', location: cId, storageNote: '', state: 'pending', flags: [] });
    set['payload.units'] = units;
  } else {
    const dist = Array.isArray(item.distribution) ? item.distribution.slice() : [];
    let idx = dist.findIndex((d) => d && d.caseId === cId);
    if (idx === -1) {
      dist.push({ caseId: cId, qty: 0, serials: [], state: 'pending' });
      idx = dist.length - 1;
    }
    dist[idx] = { ...dist[idx], qty: (Number(dist[idx].qty) || 0) + 1 };
    set['payload.distribution'] = dist;
  }

  set['payload.id'] = _id;
  set.updatedAt = now;
  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Scan adoption: set the canonical product code (qr) on an item, optionally route it to a case ─
// Faithful to adoptCodeAsProductCode + the assignItemToCase follow-up (index.html ~L6876/17358):
// REFUSES if the item already has a qr (never clobber a product code). On success sets qr; if a case
// is given, also adds the item to that case (qty bump). Gated by scan.label (lead+).
interface AdoptProductCodeArgs {
  itemId: string;
  code: string;
  caseId: string | null;
  actorRole: string;
  actor: PackByActor;
}
export async function adoptProductCode({ itemId, code, caseId, actorRole, actor }: AdoptProductCodeArgs): Promise<SaveEventResult> {
  if (!can('scan.label', actorRole)) throw new WriteForbiddenError('You do not have permission to adopt codes (lead or higher).');
  const _id = String(itemId);
  const c = String(code ?? '').trim();
  if (!c) throw new Error('A code is required.');
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');
  const item = stored.payload || {};
  if (item.qr && String(item.qr).trim() !== '') throw new WriteForbiddenError('Item already has a product code.');
  const now = Date.now();
  const set: Record<string, unknown> = { 'payload.qr': c };

  // Optionally route into the case (qty bump on a BULK row / a unit relocate on SERIAL).
  const cId = caseId ? String(caseId) : '';
  if (cId) {
    if (item.tracking === 'serial') {
      const units = Array.isArray(item.units) ? item.units.slice() : [];
      const freeIdx = units.findIndex((u) => u && !u.deletedAt && (!u.location || u.location === 'storage'));
      if (freeIdx >= 0) units[freeIdx] = { ...units[freeIdx], location: cId, state: 'pending', storageNote: '' };
      else units.push({ id: 'unit-' + now.toString(36) + Math.random().toString(36).slice(2, 6), serial: '', location: cId, storageNote: '', state: 'pending', flags: [] });
      set['payload.units'] = units;
    } else {
      const dist = Array.isArray(item.distribution) ? item.distribution.slice() : [];
      let idx = dist.findIndex((d) => d && d.caseId === cId);
      if (idx === -1) {
        dist.push({ caseId: cId, qty: 0, serials: [], state: 'pending' });
        idx = dist.length - 1;
      }
      dist[idx] = { ...dist[idx], qty: (Number(dist[idx].qty) || 0) + 1 };
      set['payload.distribution'] = dist;
    }
  }

  set['payload.id'] = _id;
  set.updatedAt = now;
  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  void actor;
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── NFC: refresh an item's tagData from a read ─────────────────────────────────────────────────
// Faithful to updateItemTagData (index.html ~L6927): merge the read entry into item.tagData[uid],
// preserving previously-populated parsed fields (read-and-update). Gated by scan.pack (authorized+ —
// a packer scanning a tag refreshes its data, same tier as the pack). The entry is sanitized to the
// known shape so a crafted call can't smuggle arbitrary keys onto the item.
interface TagDataEntry {
  tagUid: string;
  format?: string;
  category?: string;
  parsed?: Record<string, unknown> | null;
  raw?: unknown;
  lastReadAt?: number;
  lastReadBy?: { email?: string; name?: string } | null;
}
interface UpdateTagDataArgs {
  itemId: string;
  entry: TagDataEntry;
  actorRole: string;
}
export async function updateItemTagData({ itemId, entry, actorRole }: UpdateTagDataArgs): Promise<SaveEventResult> {
  if (!can('scan.pack', actorRole)) throw new WriteForbiddenError('You do not have permission to update tag data.');
  const _id = String(itemId);
  const uid = String(entry?.tagUid ?? '').trim();
  if (!uid) throw new Error('A tag UID is required.');
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');
  const item = stored.payload || {};
  const now = Date.now();
  const tagData = (item as Record<string, unknown>).tagData && typeof (item as Record<string, unknown>).tagData === 'object'
    ? { ...((item as Record<string, unknown>).tagData as Record<string, unknown>) }
    : {};
  const existing = (tagData[uid] as Record<string, unknown>) || {};
  // Read-and-update: never lose a previously-populated parsed field.
  let mergedParsed: Record<string, unknown> | null = null;
  if (existing.parsed || entry.parsed) {
    mergedParsed = { ...((existing.parsed as Record<string, unknown>) || {}) };
    const incoming = entry.parsed || {};
    for (const k of Object.keys(incoming)) if (incoming[k] != null) mergedParsed[k] = incoming[k];
  }
  tagData[uid] = {
    tagUid: uid,
    format: entry.format ?? (existing.format as string) ?? 'unknown',
    category: entry.category ?? (existing.category as string) ?? 'generic',
    parsed: mergedParsed,
    raw: entry.raw ?? existing.raw ?? null,
    lastReadAt: entry.lastReadAt || now,
    lastReadBy: entry.lastReadBy || (existing.lastReadBy as unknown) || null,
  };
  const set: Record<string, unknown> = { 'payload.tagData': tagData, 'payload.id': _id, updatedAt: now };

  // Spool-as-unit: a consumable's filament/resin tag is registered as an individually tracked SERIAL
  // unit (linked by tag UID). Reading a NEW tag adds a unit; a known tag refreshes its grams remaining.
  // The item flips to serial tracking (reversible — distribution[] is kept but ignored while serial).
  const cat = entry.category ?? (existing.category as string) ?? '';
  const isSpool =
    (item.kind === 'consumable' || item.type === 'consumable') &&
    (cat === 'filament' || cat === 'resin' || !!(mergedParsed && mergedParsed.material_class));
  if (isSpool) {
    const p = mergedParsed || {};
    const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const remaining = numOf(p.remaining_weight) ?? numOf(p.actual_netto_full_weight) ?? numOf(p.nominal_netto_full_weight);
    const units: ItemUnit[] = Array.isArray(item.units) ? item.units.slice() : [];
    const idx = units.findIndex((u) => u && !u.deletedAt && u.tagUid === uid);
    if (idx >= 0) {
      units[idx] = { ...units[idx], remainingWeight: remaining, serial: units[idx].serial || uid };
    } else {
      units.push({
        id: 'unit-' + now.toString(36) + Math.random().toString(36).slice(2, 6),
        serial: uid,
        tagUid: uid,
        location: 'storage',
        state: 'draft',
        remainingWeight: remaining,
        flags: [],
      });
    }
    set['payload.units'] = units;
    set['payload.tracking'] = 'serial';
  }

  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// SIGN-OFF COMMITS (Ship Kit / Unpack Complete) + per-item return sign-off + the loose moves
// ════════════════════════════════════════════════════════════════════════════════════════════
// The functional core of the Sign-Off screen. Each write is gated by the SAME can() the client UI
// uses, re-resolved against the caller's LIVE role + pinned to the STORED event (lead-of-event from
// disk, never the incoming payload), and stamps an event-audit row. Narrow $set into payload.* over
// the envelope so a sibling field a different writer touched is never clobbered.

interface ActorBy {
  email: string;
  name: string;
  role: string;
}

/** Resolve the SnapshotCaseLite[] the snapshot builder needs (id+label+slug) from the live cases. */
async function snapshotCaseList(): Promise<SnapshotCaseLite[]> {
  const db = await getDb();
  const docs = await db.collection<CaseDoc>('cases').find(NOT_DELETED).toArray();
  return docs.map((c) => ({ id: c._id, label: c.payload.label, slug: c.payload.slug }));
}

// ─── Ship Kit → commitEventReady ──────────────────────────────────────────────────────────────
// Faithful to submitShip + commitEventReady (index.html ~L21530 / ~L3972): record the outbound
// shipment, FREEZE the manifest of record (buildManifestSnapshot, stored verbatim on
// event.signoff.manifestSnapshot), flip a PACKING event straight to 'onsite', and log the commit +
// snapshot audit entries. Gated by signoff.commit (lead+ OR the lead of THIS event), AND only
// allowed when the event is actually shippable (eventCanCommitReady pinned to the stored event +
// live inventory) so a crafted call can't ship an unready kit.
interface CommitReadyArgs {
  eventId: string;
  shipping: {
    carrier?: string;
    tracking?: string;
    pickupDate?: string;
    notes?: string;
    custodyCapture?: { typedName?: string; signatureDataUrl?: string; photoDataUrl?: string };
  };
  actor: ActorBy;
}

// Sanitize an optional chain-of-custody capture: a trimmed name + size-bounded image data URLs.
// Anything malformed/oversized is dropped to undefined (never throws), so a bad capture can't block
// or bloat the ship write. Caps keep the event doc modest (the snapshot is also stored on the event).
function sanitizeCustodyCapture(
  c: CommitReadyArgs['shipping']['custodyCapture']
): import('@/lib/types/types').CustodyCapture | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const okUrl = (u: unknown, maxLen: number): string | undefined =>
    typeof u === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(u) && u.length <= maxLen ? u : undefined;
  const out: import('@/lib/types/types').CustodyCapture = {};
  const name = String(c.typedName ?? '').trim().slice(0, 120);
  if (name) out.typedName = name;
  const sig = okUrl(c.signatureDataUrl, 200_000); // ~150 KB signature PNG
  if (sig) out.signatureDataUrl = sig;
  const photo = okUrl(c.photoDataUrl, 700_000); // ~525 KB photo JPEG
  if (photo) out.photoDataUrl = photo;
  return out.typedName || out.signatureDataUrl || out.photoDataUrl ? out : undefined;
}
export interface CommitReadyResult {
  ok: boolean;
  /** The frozen snapshot (so the client can print the manifest of record right after). */
  snapshot: import('@/lib/types/types').ManifestSnapshot | null;
}
export async function commitEventReady({ eventId, shipping, actor }: CommitReadyArgs): Promise<CommitReadyResult> {
  const _id = String(eventId);
  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const stored = await events.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Event not found (or deleted).');

  const isLead = viewerLeadsEvent(stored.payload, actor.email);
  if (!can('signoff.commit', actor.role, { isLeadOfEvent: isLead })) {
    throw new WriteForbiddenError('You do not have permission to ship this kit (lead or higher).');
  }
  if (String(stored.payload.state) !== 'packing') {
    throw new WriteForbiddenError('Ship Kit is only available while the event is in Packing.');
  }

  // Re-validate readiness on the STORED event + LIVE inventory (the same gate the UI shows).
  const inv = (await db.collection<InventoryDoc>('inventory').find(NOT_DELETED).toArray()).map((d) => d.payload);
  const { eventCanCommitReady } = await import('@/lib/views/signoff-view');
  if (!eventCanCommitReady(stored.payload, inv)) {
    throw new WriteForbiddenError('This kit is not ready to ship — box every case and resolve open flags.');
  }

  const cases = await snapshotCaseList();
  const custody = sanitizeCustodyCapture(shipping?.custodyCapture);
  const ship = {
    carrier: String(shipping?.carrier ?? '').trim(),
    tracking: String(shipping?.tracking ?? '').trim(),
    pickupDate: String(shipping?.pickupDate ?? '').trim(),
    notes: String(shipping?.notes ?? '').trim(),
  };
  const now = Date.now();
  const snapshot = buildManifestSnapshot(stored.payload, inv, cases, actor, {
    reason: 'ship-kit',
    shipping: { ...ship, ...(custody ? { custodyCapture: custody } : {}) },
    eventState: 'in_transit',
  });

  // Build the next signoff envelope + outbound leg (mirrors recordEventShipment, index.html ~L3939).
  const nextOutbound = {
    ...(stored.payload.outbound || {}),
    carrier: ship.carrier || stored.payload.outbound?.carrier || '',
    tracking: ship.tracking || stored.payload.outbound?.tracking || '',
    pickupDate: ship.pickupDate || stored.payload.outbound?.pickupDate || '',
    notes: ship.notes || stored.payload.outbound?.notes || '',
  };
  const nextSignoff = {
    ...(stored.payload.signoff || {}),
    // custodyCapture is stored ONCE — on manifestSnapshot.shipping (what the print reads) — not also
    // here, so the (up to ~900 KB) image blobs aren't duplicated inside the same event document.
    shipped: {
      at: now,
      byEmail: actor.email,
      byName: actor.name,
      role: actor.role,
      carrier: ship.carrier,
      tracking: ship.tracking,
      pickupDate: ship.pickupDate,
    },
    manifestSnapshot: snapshot,
  };

  let audit = appendAudit(stored.payload, {
    type: 'commit',
    note: `Shipped via ${ship.carrier} (${ship.tracking}) — set In Transit`,
    byEmail: actor.email,
    byName: actor.name,
  });
  audit = appendAudit({ ...stored.payload, audit }, {
    type: 'manifest-snapshot',
    note: `Manifest of record captured (${snapshot.totals.rows} rows, ${snapshot.totals.qty} units)`,
    byEmail: actor.email,
    byName: actor.name,
  });

  const res = await events.updateOne(
    { _id, ...NOT_DELETED },
    {
      $set: {
        'payload.state': 'in_transit',
        'payload.outbound': nextOutbound,
        'payload.signoff': nextSignoff,
        'payload.audit': audit,
        'payload.id': _id,
        updatedAt: now,
      },
    }
  );
  const eventName = stored.payload.name || _id;
  void dispatchOutbound({
    type: 'ship_kit_signoff',
    summary: `Kit shipped: ${eventName} via ${ship.carrier || 'carrier'}${ship.tracking ? ` (${ship.tracking})` : ''} — set In Transit`,
    data: { eventId: _id, eventName, carrier: ship.carrier, tracking: ship.tracking, byEmail: actor.email },
  });
  return { ok: res.matchedCount > 0, snapshot };
}

// ─── Lead marks the shipment ARRIVED → markEventOnsite ──────────────────────────────────────────
// After Ship Kit sets an event In Transit, the lead (or manager+) marks it On Site when they're at
// the venue. Gated by signoff.commit (lead+ OR lead-of-event); only an in_transit event qualifies.
export interface MarkOnsiteArgs {
  eventId: string;
  actor: { email: string; name: string; role: string };
}
export async function markEventOnsite({ eventId, actor }: MarkOnsiteArgs): Promise<{ ok: boolean }> {
  const _id = String(eventId);
  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const stored = await events.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Event not found (or deleted).');

  const isLead = viewerLeadsEvent(stored.payload, actor.email);
  if (!can('signoff.commit', actor.role, { isLeadOfEvent: isLead })) {
    throw new WriteForbiddenError('You do not have permission to mark this event on site (lead or higher).');
  }
  if (String(stored.payload.state) !== 'in_transit') {
    throw new WriteForbiddenError('Only an in-transit event can be marked on site.');
  }

  const now = Date.now();
  const audit = appendAudit(stored.payload, {
    type: 'commit',
    note: 'Shipment arrived at the venue — set On Site',
    byEmail: actor.email,
    byName: actor.name,
  });
  const res = await events.updateOne(
    { _id, ...NOT_DELETED },
    { $set: { 'payload.state': 'onsite', 'payload.audit': audit, 'payload.id': _id, updatedAt: now } }
  );
  return { ok: res.matchedCount > 0 };
}

// ─── Unpack Complete → commitEventClosed ────────────────────────────────────────────────────────
// Faithful to submitClose + commitEventClosed (index.html ~L21569 / ~L5300): close an UNPACKING
// event once every deployed item row is signed off, stamping signoff.closed + the commit audit.
// Gated by signoff.commit (lead+ OR lead of this event). Readiness re-validated server-side.
interface CommitClosedArgs {
  eventId: string;
  actor: ActorBy;
}
export async function commitEventClosed({ eventId, actor }: CommitClosedArgs): Promise<{ ok: boolean }> {
  const _id = String(eventId);
  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const stored = await events.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Event not found (or deleted).');

  const isLead = viewerLeadsEvent(stored.payload, actor.email);
  if (!can('signoff.commit', actor.role, { isLeadOfEvent: isLead })) {
    throw new WriteForbiddenError('You do not have permission to close this event (lead or higher).');
  }

  const inv = (await db.collection<InventoryDoc>('inventory').find(NOT_DELETED).toArray()).map((d) => d.payload);
  const { eventCanCommitClosed } = await import('@/lib/views/signoff-view');
  if (!eventCanCommitClosed(stored.payload, inv)) {
    throw new WriteForbiddenError('Every returned item must be signed off before closing.');
  }

  const now = Date.now();
  const nextSignoff = {
    ...(stored.payload.signoff || {}),
    closed: { at: now, byEmail: actor.email, byName: actor.name, role: actor.role },
  };
  const audit = appendAudit(stored.payload, {
    type: 'commit',
    note: 'Unpack complete — event closed',
    byEmail: actor.email,
    byName: actor.name,
  });
  const res = await events.updateOne(
    { _id, ...NOT_DELETED },
    { $set: { 'payload.state': 'closed', 'payload.signoff': nextSignoff, 'payload.audit': audit, 'payload.id': _id, updatedAt: now } }
  );
  return { ok: res.matchedCount > 0 };
}

// ─── Per-item RETURN sign-off (unpacking) ───────────────────────────────────────────────────────
// Faithful to the renderRow toggle + signOffItemRow / unsignOffItemRow (index.html ~L21688/3623):
// sign a deployed row OFF with a disposition (ok|damaged|missing|consumed|other) or UN-sign it,
// stamping the canonical signoff on the case row (or every in-case serial unit) / on the loose row by
// distIdx, AND logging a signoff / unsignoff / bulk-signoff audit entry on the HOLDING event. Refuses
// when the item carries an OPEN flag (mirrors the toggle's hasFlags guard). Gated by signoff.commit
// (lead+ OR lead of the holding event), re-checked server-side; the item + case are pinned to disk.
const SIGNOFF_KINDS: ReadonlySet<string> = new Set(['ok', 'damaged', 'missing', 'consumed', 'sold', 'other', 'packing']);
interface SignOffItemArgs {
  eventId: string;
  itemId: string;
  /** caseId for a case row; null for a LOOSE row (then looseDistIdx pins the row). */
  caseId: string | null;
  /** For a loose row: the distribution index to stamp (mirrors the JSON-mutated writeSignoff). */
  looseDistIdx?: number;
  /** The disposition kind to sign; null UN-signs. */
  kind: string | null;
  /** 'signoff' | 'unsignoff' | 'bulk-signoff' (the audit type). */
  auditType?: 'signoff' | 'unsignoff' | 'bulk-signoff';
  actor: ActorBy;
}
export async function signOffItemDisposition({
  eventId,
  itemId,
  caseId,
  looseDistIdx,
  kind,
  auditType,
  actor,
}: SignOffItemArgs): Promise<SaveEventResult> {
  const evId = String(eventId);
  const _id = String(itemId);
  const cId = caseId == null ? null : String(caseId);
  const disp = kind == null ? null : String(kind);
  if (disp != null && !SIGNOFF_KINDS.has(disp)) throw new Error('Invalid disposition.');

  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const inv = db.collection<InventoryDoc>('inventory');
  const [storedEvent, storedItem] = await Promise.all([
    events.findOne({ _id: evId, ...NOT_DELETED }),
    inv.findOne({ _id, ...NOT_DELETED }),
  ]);
  if (!storedEvent) throw new Error('Event not found (or deleted).');
  if (!storedItem) throw new Error('Inventory item not found (or deleted).');

  // Pin authz to the STORED event (lead-of-event from disk). signoff.commit = lead+ OR lead-of-event.
  const isLead = viewerLeadsEvent(storedEvent.payload, actor.email);
  if (!can('signoff.commit', actor.role, { isLeadOfEvent: isLead })) {
    throw new WriteForbiddenError('You do not have permission to sign off (lead or higher).');
  }

  const item = storedItem.payload || {};
  // Refuse a sign-OFF on an item with an open flag (the toggle's hasFlags guard). Un-sign is allowed.
  const hasOpenFlag = (item.flags || []).some((f) => f && f.status === 'open');
  if (disp != null && hasOpenFlag) {
    throw new WriteForbiddenError('Resolve the open flag(s) before signing this item off.');
  }

  const now = Date.now();
  const signoff = disp == null ? null : { kind: disp, at: now, byEmail: actor.email, byName: actor.name, role: actor.role, note: '' };
  const set: Record<string, unknown> = {};

  if (cId === null) {
    // LOOSE row — stamp the specific distribution index (the row has no caseId).
    const dist = Array.isArray(item.distribution) ? item.distribution.slice() : [];
    const idx = typeof looseDistIdx === 'number' ? looseDistIdx : dist.findIndex((d) => d && !d.caseId && d.eventId === evId);
    if (idx < 0 || idx >= dist.length) throw new Error('Loose row not found.');
    const row = dist[idx];
    if (row.caseId || row.eventId !== evId) throw new Error('Not a loose row for this event.');
    dist[idx] = { ...row, signoff };
    set['payload.distribution'] = dist;
  } else if (item.tracking === 'serial') {
    const units = Array.isArray(item.units) ? item.units : [];
    const inCase = units.filter((u) => u && !u.deletedAt && u.location === cId);
    if (inCase.length === 0) throw new Error('That item is not routed into this case.');
    set['payload.units'] = units.map((u) =>
      u && !u.deletedAt && u.location === cId ? { ...u, signoff: signoff ? { ...signoff } : null } : u
    );
  } else {
    const dist = Array.isArray(item.distribution) ? item.distribution : [];
    const idx = dist.findIndex((d) => d && d.caseId === cId);
    if (idx === -1) throw new Error('That item is not routed into this case.');
    set['payload.distribution'] = dist.map((d, i) => (i === idx ? { ...d, signoff } : d));
  }

  set['payload.id'] = _id;
  set.updatedAt = now;
  const res = await inv.updateOne({ _id, ...NOT_DELETED }, { $set: set });

  // Audit on the event (signoff / unsignoff / bulk-signoff).
  const type = auditType || (disp == null ? 'unsignoff' : 'signoff');
  const audit = appendAudit(storedEvent.payload, {
    type,
    itemId: _id,
    itemLabel: item.name || item.slug || _id,
    kind: disp,
    byEmail: actor.email,
    byName: actor.name,
  });
  await events.updateOne(
    { _id: evId, ...NOT_DELETED },
    { $set: { 'payload.audit': audit, 'payload.id': evId, updatedAt: now } }
  );

  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Box ALL cases (packing bulk action) ────────────────────────────────────────────────────────
// Faithful to the "Box all cases" button (index.html ~L21656): sign off every UNFLAGGED, unboxed
// assigned case in one write + one batched audit. Gated by signoff.commit (lead+ OR lead-of-event).
// Flagged cases are skipped (the source's `if (g.boxed || g.hasFlags) return`).
interface BoxAllArgs {
  eventId: string;
  actor: ActorBy;
}
export async function boxAllCases({ eventId, actor }: BoxAllArgs): Promise<{ ok: boolean; boxed: number }> {
  const _id = String(eventId);
  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const stored = await events.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Event not found (or deleted).');
  const isLead = viewerLeadsEvent(stored.payload, actor.email);
  if (!can('signoff.commit', actor.role, { isLeadOfEvent: isLead })) {
    throw new WriteForbiddenError('You do not have permission to sign off (lead or higher).');
  }

  const inv = (await db.collection<InventoryDoc>('inventory').find(NOT_DELETED).toArray()).map((d) => d.payload);
  const assigned = Array.isArray(stored.payload.cases) ? stored.payload.cases : [];
  const signoffs = { ...(stored.payload.caseSignoffs || {}) };
  const now = Date.now();
  let boxed = 0;
  let audit = Array.isArray(stored.payload.audit) ? stored.payload.audit.slice() : [];

  for (const cid of assigned) {
    if (signoffs[cid]) continue; // already boxed
    // Skip a case with any open flag on a contained item (the hasFlags guard).
    const hasFlags = inv.some((it) => {
      if ((it.flags || []).every((f) => f.status !== 'open')) return false;
      // Does THIS flagged item route into the case?
      if (it.tracking === 'serial') return (it.units || []).some((u) => u && !u.deletedAt && u.location === cid);
      return (it.distribution || []).some((d) => d && d.caseId === cid);
    });
    if (hasFlags) continue;
    signoffs[cid] = { by: { email: actor.email, name: actor.name, role: actor.role }, at: now };
    const caseLabel = await caseLabelFor(cid);
    audit = appendAudit({ ...stored.payload, audit }, {
      type: 'case-box',
      caseId: cid,
      note: 'Case ' + caseLabel + ' boxed',
      byEmail: actor.email,
      byName: actor.name,
    });
    boxed++;
  }
  if (boxed === 0) return { ok: true, boxed: 0 };

  await events.updateOne(
    { _id, ...NOT_DELETED },
    { $set: { 'payload.caseSignoffs': signoffs, 'payload.audit': audit, 'payload.id': _id, updatedAt: now } }
  );
  return { ok: true, boxed };
}

// ─── Finalize the check-in sweep (return reconciliation) ────────────────────────────────────────
// Faithful to finalizeCheckinSweep (index.html ~L4056): raise advisory flags on Missing + Damaged
// items (IDEMPOTENT — skips an item that already carries an open flag of the relevant category) and
// write ONE 'reconcile' audit entry with the tally. Gated by signoff.commit (lead+ OR lead-of-event).
interface FinalizeSweepArgs {
  eventId: string;
  actor: ActorBy;
}
export async function finalizeCheckInSweep({ eventId, actor }: FinalizeSweepArgs): Promise<{ ok: boolean; flagsAdded: number }> {
  const _id = String(eventId);
  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const inv = db.collection<InventoryDoc>('inventory');
  const stored = await events.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Event not found (or deleted).');
  const isLead = viewerLeadsEvent(stored.payload, actor.email);
  if (!can('signoff.commit', actor.role, { isLeadOfEvent: isLead })) {
    throw new WriteForbiddenError('You do not have permission to finalize the sweep (lead or higher).');
  }

  const items = (await inv.find(NOT_DELETED).toArray()).map((d) => d.payload);
  const sweep = buildCheckinSweep(stored.payload, items);
  const itemById = new Map<string, InventoryPayload>();
  for (const it of items) if (it.id) itemById.set(it.id, it);

  const now = Date.now();
  let flagsAdded = 0;
  for (const d of sweep.discrepancies) {
    const it = itemById.get(d.itemId);
    if (!it) continue;
    const cat = d.status === 'damaged' ? 'damage' : 'maintenance';
    // Idempotency: skip when an open flag of this category already exists.
    if ((it.flags || []).some((f) => f && f.status === 'open' && f.category === cat)) continue;
    const note =
      d.status === 'damaged'
        ? 'Return reconciliation: damaged on return from ' + (stored.payload.name || _id)
        : 'Return reconciliation: missing on return from ' + (stored.payload.name || _id);
    const nextFlags = buildAddFlag(it, { note, severity: 'high', category: cat, by: actor.name || actor.email || 'reconcile' });
    await inv.updateOne(
      { _id: String(it.id), ...NOT_DELETED },
      { $set: { 'payload.flags': nextFlags, 'payload.id': String(it.id), updatedAt: now } }
    );
    flagsAdded++;
  }

  const t = sweep.tally;
  const noteStr =
    'Check-in sweep: Returned ' + t.returned + ' / Damaged ' + t.damaged + ' / Missing ' + t.missing +
    ' (of ' + t.total + '). ' + flagsAdded + ' flag' + (flagsAdded === 1 ? '' : 's') + ' raised.';
  const audit = appendAudit(stored.payload, { type: 'reconcile', note: noteStr, byEmail: actor.email, byName: actor.name });
  await events.updateOne(
    { _id, ...NOT_DELETED },
    { $set: { 'payload.audit': audit, 'payload.id': _id, updatedAt: now } }
  );
  return { ok: true, flagsAdded };
}

// ─── Loose: MOVE to case (absorb) ───────────────────────────────────────────────────────────────
// Faithful to absorbLooseToCaseDistribution + the onPick (index.html ~L5805/21906): re-home a loose
// distribution row onto a case ASSIGNED TO THE LOOSE ROW'S EVENT, clearing the loose attach + stamping
// absorbedBy/At, then log a 'loose-absorb' audit on the event. Gated by looseitem.manage (lead+),
// re-checked. The case must be on the source event's cases[] (validated server-side).
interface MoveLooseArgs {
  itemId: string;
  eventId: string;
  /** The loose distribution index to absorb (the row whose eventId === eventId & caseId null). */
  distIdx: number;
  targetCaseId: string;
  actor: ActorBy;
}
export async function moveLooseToCase({ itemId, eventId, distIdx, targetCaseId, actor }: MoveLooseArgs): Promise<SaveEventResult> {
  if (!can('looseitem.manage', actor.role)) {
    throw new WriteForbiddenError('You do not have permission to manage loose inventory (lead or higher).');
  }
  const _id = String(itemId);
  const evId = String(eventId);
  const cId = String(targetCaseId);
  if (!cId) throw new Error('A target case is required.');

  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const inv = db.collection<InventoryDoc>('inventory');
  const [storedEvent, storedItem] = await Promise.all([
    events.findOne({ _id: evId, ...NOT_DELETED }),
    inv.findOne({ _id, ...NOT_DELETED }),
  ]);
  if (!storedEvent) throw new Error('Event not found (or deleted).');
  if (!storedItem) throw new Error('Inventory item not found (or deleted).');

  // The target case must be assigned to the loose row's event (the source's absorb rule).
  if (!(storedEvent.payload.cases || []).includes(cId)) {
    throw new Error('That case is not assigned to this event.');
  }
  const item = storedItem.payload || {};
  const dist = Array.isArray(item.distribution) ? item.distribution.slice() : [];
  if (distIdx < 0 || distIdx >= dist.length) throw new Error('Loose row not found.');
  const row = dist[distIdx];
  if (row.caseId || row.eventId !== evId) throw new Error('Not a loose row for this event.');

  const now = Date.now();
  dist[distIdx] = { ...row, caseId: cId, eventId: null, looseAttach: null, absorbedBy: actor.email || actor.name || 'unknown', absorbedAt: now };
  const res = await inv.updateOne(
    { _id, ...NOT_DELETED },
    { $set: { 'payload.distribution': dist, 'payload.id': _id, updatedAt: now } }
  );

  const audit = appendAudit(storedEvent.payload, {
    type: 'loose-absorb',
    itemId: _id,
    itemLabel: item.name || item.slug || _id,
    caseId: cId,
    byEmail: actor.email,
    byName: actor.name,
  });
  await events.updateOne({ _id: evId, ...NOT_DELETED }, { $set: { 'payload.audit': audit, 'payload.id': evId, updatedAt: now } });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Loose: SEND to another event (transfer) ────────────────────────────────────────────────────
// Faithful to transferLooseDistribution + the onPick (index.html ~L5772/21958): re-peg a loose row to
// a TARGET event accepting transfers (draft|upcoming|packing), updating the looseAttach, and log a
// 'loose-transfer' audit on BOTH the source + target events. Gated by looseitem.manage (lead+). The
// target must exist + be in an accepting state (validated server-side).
const TRANSFER_TARGET_STATES: ReadonlySet<string> = new Set(['draft', 'upcoming', 'packing']);
interface SendLooseArgs {
  itemId: string;
  eventId: string; // source
  distIdx: number;
  targetEventId: string;
  actor: ActorBy;
}
export async function sendLooseToEvent({ itemId, eventId, distIdx, targetEventId, actor }: SendLooseArgs): Promise<SaveEventResult> {
  if (!can('looseitem.manage', actor.role)) {
    throw new WriteForbiddenError('You do not have permission to manage loose inventory (lead or higher).');
  }
  const _id = String(itemId);
  const srcId = String(eventId);
  const tgtId = String(targetEventId);
  if (!tgtId) throw new Error('A target event is required.');
  if (tgtId === srcId) throw new Error('Already at this event.');

  const db = await getDb();
  const events = db.collection<EventDoc>('events');
  const inv = db.collection<InventoryDoc>('inventory');
  const [storedSrc, storedTgt, storedItem] = await Promise.all([
    events.findOne({ _id: srcId, ...NOT_DELETED }),
    events.findOne({ _id: tgtId, ...NOT_DELETED }),
    inv.findOne({ _id, ...NOT_DELETED }),
  ]);
  if (!storedSrc) throw new Error('Source event not found (or deleted).');
  if (!storedTgt) throw new Error('Target event not found (or deleted).');
  if (!storedItem) throw new Error('Inventory item not found (or deleted).');
  if (!TRANSFER_TARGET_STATES.has(String(storedTgt.payload.state))) {
    throw new Error('That event is not accepting transfers.');
  }

  const item = storedItem.payload || {};
  const dist = Array.isArray(item.distribution) ? item.distribution.slice() : [];
  if (distIdx < 0 || distIdx >= dist.length) throw new Error('Loose row not found.');
  const row = dist[distIdx];
  if (row.caseId || row.eventId !== srcId) throw new Error('Not a loose row for this event.');

  const now = Date.now();
  dist[distIdx] = { ...row, eventId: tgtId, looseAttach: { by: actor.email || actor.name || 'unknown', at: now, reason: 'transfer' } };
  const res = await inv.updateOne(
    { _id, ...NOT_DELETED },
    { $set: { 'payload.distribution': dist, 'payload.id': _id, updatedAt: now } }
  );

  const label = item.name || item.slug || _id;
  const srcAudit = appendAudit(storedSrc.payload, { type: 'loose-transfer', itemId: _id, itemLabel: label, byEmail: actor.email, byName: actor.name, note: `→ ${storedTgt.payload.name || tgtId}` });
  const tgtAudit = appendAudit(storedTgt.payload, { type: 'loose-transfer', itemId: _id, itemLabel: label, byEmail: actor.email, byName: actor.name, note: `← ${storedSrc.payload.name || srcId}` });
  await Promise.all([
    events.updateOne({ _id: srcId, ...NOT_DELETED }, { $set: { 'payload.audit': srcAudit, 'payload.id': srcId, updatedAt: now } }),
    events.updateOne({ _id: tgtId, ...NOT_DELETED }, { $set: { 'payload.audit': tgtAudit, 'payload.id': tgtId, updatedAt: now } }),
  ]);
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Tag library (Config > Tags) — CRUD over the universal tag library ─────────────────────────
// Faithful port of the existing app's tagStore + the TagsConfigPanel auth model (index.html
// ~L9237 / ~L25931). Tags are universal (apply to events OR inventory items via tagIds[]). Same
// envelope discipline as every other write: $set INTO payload.* over a small allowlist, stamp
// updatedAt, soft-delete via a payload.deletedAt + envelope deletedAt tombstone (replicates to
// peers — the live-DB model, NOT a row drop).
//
// AUTHZ (the centralized cap table, lib/rbac):
//   • create / rename / hidden / color / flair  -> tags.edit  (manager+, rank 3)
//   • delete                                     -> tags.delete (manager+, rank 3) PLUS the legacy
//       client refinement: a tag with > 3 uses is admin-only. The server enforces that refinement
//       by RE-COUNTING uses against the live events+inventory (never trusting a client count) and
//       requiring admin rank when uses > 3 — so the rule can't be bypassed.
// Each helper re-checks with can() as defense-in-depth even though the Server Action requireRole'd.

const TAG_EDITABLE_FIELDS = ['label', 'hidden', 'color', 'flair', 'customEmoji'] as const;
export type TagPatch = Partial<Pick<TagPayload, (typeof TAG_EDITABLE_FIELDS)[number]>>;

/** Sanitize one tag field to the stored shape (mirrors tagStore.add/update coercions). */
function cleanTagField(key: (typeof TAG_EDITABLE_FIELDS)[number], raw: unknown): unknown {
  switch (key) {
    case 'label':
      return String(raw ?? '').trim() || 'New tag';
    case 'hidden':
      return Boolean(raw);
    case 'color':
      return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    case 'flair':
      return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    case 'customEmoji':
      return typeof raw === 'string' ? raw : '';
  }
}

interface CreateTagArgs {
  label: string;
  hidden?: boolean;
  color?: string | null;
  flair?: string | null;
  customEmoji?: string;
  actorEmail: string;
  actorRole: string;
}
export interface CreateTagResult extends SaveEventResult {
  id: string;
  duplicate?: boolean;
}

/**
 * Create a tag. Gated by tags.edit (manager+). The server mints the _id (a client id is never
 * trusted). Duplicate-by-label detection lives in the UI (it pulses the existing row instead of
 * creating); the server ALSO guards a crafted duplicate by refusing a create whose trimmed,
 * lower-cased label matches a LIVE tag — returning that tag's id (duplicate:true) so the caller can
 * highlight it, matching the panel's "highlight existing" behavior.
 */
export async function createTag({
  label,
  hidden,
  color,
  flair,
  customEmoji,
  actorEmail,
  actorRole,
}: CreateTagArgs): Promise<CreateTagResult> {
  void actorEmail;
  if (!can('tags.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to create tags.');
  }
  const db = await getDb();
  const col = db.collection<TagDoc>('tags');

  const trimmed = String(label ?? '').trim();
  if (!trimmed) throw new Error('A tag label is required.');

  const lower = trimmed.toLowerCase();
  const live = await col.find(NOT_DELETED).toArray();
  const dupe = live.find((t) => String(t.payload?.label ?? '').trim().toLowerCase() === lower);
  if (dupe) return { ok: true, matched: 0, modified: 0, id: dupe._id, duplicate: true };

  const id = generateId();
  const now = Date.now();
  const payload: TagPayload = {
    id,
    label: trimmed,
    hidden: Boolean(hidden),
    color: cleanTagField('color', color) as string | null,
    flair: cleanTagField('flair', flair) as string | null,
    customEmoji: cleanTagField('customEmoji', customEmoji) as string,
    deletedAt: null,
  };
  await col.insertOne({ _id: id, payload, createdAt: now, updatedAt: now, deletedAt: null } as TagDoc);
  return { ok: true, matched: 1, modified: 1, id };
}

interface SaveTagArgs {
  id: string;
  patch: TagPatch;
  actorEmail: string;
  actorRole: string;
}

/**
 * Patch a tag (rename / hidden / color / flair). Gated by tags.edit (manager+). On a RENAME, the
 * trimmed label is checked against the other LIVE tags (case-insensitive); a collision throws so the
 * caller can pulse the conflicting row rather than create two tags sharing a label. $set only the
 * allowlisted fields under payload.*, stamp updatedAt. The >3-uses RENAME confirm is a UI affordance
 * (a rename updates references in place — no data risk), so it's not re-gated server-side.
 */
export async function saveTag({ id, patch, actorEmail, actorRole }: SaveTagArgs): Promise<SaveEventResult> {
  void actorEmail;
  if (!can('tags.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to edit tags.');
  }
  const _id = String(id);
  const db = await getDb();
  const col = db.collection<TagDoc>('tags');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Tag not found (or deleted).');

  if (Object.prototype.hasOwnProperty.call(patch, 'label')) {
    const next = String(patch.label ?? '').trim().toLowerCase();
    if (next) {
      const live = await col.find(NOT_DELETED).toArray();
      const clash = live.find((t) => t._id !== _id && String(t.payload?.label ?? '').trim().toLowerCase() === next);
      if (clash) throw new Error('Another tag already uses that name.');
    }
  }

  const set: Record<string, unknown> = {};
  for (const key of TAG_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      set[`payload.${key}`] = cleanTagField(key, patch[key]);
    }
  }
  set['payload.id'] = _id;
  set.updatedAt = Date.now();
  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

export interface DeleteTagResult extends SaveEventResult {
  eventUses: number;
  itemUses: number;
}

/**
 * Soft-delete a tag + PRUNE its references off every event (tagIds[] + primaryTagId) and inventory
 * item (tagIds[]). Faithful to the panel's confirmDelete (index.html ~L26026).
 *
 * AUTHZ: tags.delete (manager+) PLUS the legacy graduation — a tag in > 3 places is admin-only. We
 * RE-COUNT uses server-side against the LIVE events+inventory (never a client count), so the
 * ">3 uses ⇒ admin" rule can't be bypassed. References are pruned via $pull; the tag is tombstoned.
 */
export async function deleteTag({
  id,
  actorRole,
}: {
  id: string;
  actorEmail: string;
  actorRole: string;
}): Promise<DeleteTagResult> {
  if (!can('tags.delete', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to delete tags.');
  }
  const _id = String(id);
  const db = await getDb();
  const tags = db.collection<TagDoc>('tags');
  const stored = await tags.findOne({ _id, ...NOT_DELETED });
  if (!stored) return { ok: true, matched: 0, modified: 0, eventUses: 0, itemUses: 0 };

  const eventsCol = db.collection<EventDoc>('events');
  const invCol = db.collection<InventoryDoc>('inventory');
  const [eventDocs, invDocs] = await Promise.all([
    eventsCol.find({ ...NOT_DELETED, 'payload.tagIds': _id }).toArray(),
    invCol.find({ ...NOT_DELETED, 'payload.tagIds': _id }).toArray(),
  ]);
  const eventUses = eventDocs.length;
  const itemUses = invDocs.length;
  if (eventUses + itemUses > 3 && rankOf(actorRole) < rankOf('admin')) {
    throw new WriteForbiddenError('Deleting a tag in more than 3 places requires admin authority.');
  }

  const now = Date.now();
  await Promise.all([
    eventsCol.updateMany({ 'payload.tagIds': _id }, { $pull: { 'payload.tagIds': _id }, $set: { updatedAt: now } } as never),
    eventsCol.updateMany({ 'payload.primaryTagId': _id }, { $set: { 'payload.primaryTagId': null, updatedAt: now } }),
    invCol.updateMany({ 'payload.tagIds': _id }, { $pull: { 'payload.tagIds': _id }, $set: { updatedAt: now } } as never),
  ]);
  const res = await tags.updateOne(
    { _id, ...NOT_DELETED },
    { $set: { 'payload.deletedAt': now, deletedAt: now, updatedAt: now } }
  );
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount, eventUses, itemUses };
}

// ─── Road Kits: CRUD for the reusable case bundles ───────────────────────────────────────────────
// A Road Kit is a named set of cases (lib/db/data RoadKitPayload). Gated by pallets.edit (authorized+,
// the case-assignment tier — the warehouse people who build + assign cases own kits too). Same
// envelope + soft-delete discipline as tags. caseIds are kept as scalars (no existence check here:
// a case can be deleted after being added; the manifest/library degrade gracefully).

function cleanKitCaseIds(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of Array.isArray(raw) ? raw : []) {
    const cid = String(v ?? '').trim();
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    out.push(cid);
  }
  return out;
}

export interface RoadKitWriteResult extends SaveEventResult {
  id: string;
}

export async function createRoadKit({
  name,
  caseIds,
  notes,
  color,
  actorRole,
}: {
  name: string;
  caseIds?: string[];
  notes?: string;
  color?: string | null;
  actorRole: string;
}): Promise<RoadKitWriteResult> {
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to manage road kits.');
  }
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('A kit name is required.');
  const db = await getDb();
  const col = db.collection<RoadKitDoc>('roadkits');

  const lower = trimmed.toLowerCase();
  const live = await col.find(NOT_DELETED).toArray();
  const dupe = live.find((k) => String(k.payload?.name ?? '').trim().toLowerCase() === lower);
  if (dupe) return { ok: true, matched: 0, modified: 0, id: dupe._id };

  const id = generateId();
  const now = Date.now();
  const payload: RoadKitPayload = {
    id,
    name: trimmed,
    caseIds: cleanKitCaseIds(caseIds),
    notes: String(notes ?? '').trim().slice(0, 500),
    color: typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null,
    deletedAt: null,
  };
  await col.insertOne({ _id: id, payload, createdAt: now, updatedAt: now, deletedAt: null } as RoadKitDoc);
  return { ok: true, matched: 1, modified: 1, id };
}

export async function saveRoadKit({
  id,
  patch,
  actorRole,
}: {
  id: string;
  patch: { name?: string; caseIds?: string[]; notes?: string; color?: string | null };
  actorRole: string;
}): Promise<SaveEventResult> {
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to manage road kits.');
  }
  const _id = String(id);
  const db = await getDb();
  const col = db.collection<RoadKitDoc>('roadkits');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Road kit not found (or deleted).');

  const set: Record<string, unknown> = { 'payload.id': _id, updatedAt: Date.now() };
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    const next = String(patch.name ?? '').trim();
    if (!next) throw new Error('A kit name is required.');
    const live = await col.find(NOT_DELETED).toArray();
    const clash = live.find((k) => k._id !== _id && String(k.payload?.name ?? '').trim().toLowerCase() === next.toLowerCase());
    if (clash) throw new Error('Another road kit already uses that name.');
    set['payload.name'] = next;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'caseIds')) set['payload.caseIds'] = cleanKitCaseIds(patch.caseIds);
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) set['payload.notes'] = String(patch.notes ?? '').trim().slice(0, 500);
  if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
    const c = patch.color;
    set['payload.color'] = typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null;
  }
  const res = await col.updateOne({ _id, ...NOT_DELETED }, { $set: set });
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

/** Soft-delete a kit + prune its id off every event's roadKitIds[]. The event's cases[] is left
 *  intact (deleting the bundle doesn't unpack the show — the cases just stop being grouped). */
export async function deleteRoadKit({
  id,
  actorRole,
}: {
  id: string;
  actorRole: string;
}): Promise<SaveEventResult> {
  if (!can('pallets.edit', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to manage road kits.');
  }
  const _id = String(id);
  const db = await getDb();
  const col = db.collection<RoadKitDoc>('roadkits');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) return { ok: true, matched: 0, modified: 0 };

  const now = Date.now();
  await db
    .collection<EventDoc>('events')
    .updateMany({ 'payload.roadKitIds': _id }, { $pull: { 'payload.roadKitIds': _id }, $set: { updatedAt: now } } as never);
  const res = await col.updateOne(
    { _id, ...NOT_DELETED },
    { $set: { 'payload.deletedAt': now, deletedAt: now, updatedAt: now } }
  );
  return { ok: res.matchedCount > 0, matched: res.matchedCount, modified: res.modifiedCount };
}

// ─── Inventory: flag an item (condition / loss note) ─────────────────────────────────────────────
// Append an OPEN flag to a catalog item — the condition/loss affordance + the REST flag_item tool. The
// gate is db.write.app (authorized+, the warehouse-worker write tier — matches the catalog write gate).
// Reuses addFlag (the pure builder), then $sets only payload.flags + updatedAt (envelope discipline).
export async function flagInventoryItem({
  itemId,
  note,
  severity,
  category,
  actorRole,
  actor,
}: {
  itemId: string;
  note: string;
  severity?: string;
  category?: string;
  actorRole: string;
  actor: PackByActor;
}): Promise<{ ok: boolean; itemId: string; flag: ItemFlag }> {
  if (!can('db.write.app', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to flag inventory.');
  }
  const _id = String(itemId);
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Inventory item not found (or deleted).');
  const by = actor?.name || actor?.email || 'api';
  const flags = buildAddFlag(stored.payload, { note: String(note ?? ''), severity, category, by });
  const now = Date.now();
  await col.updateOne({ _id, ...NOT_DELETED }, { $set: { 'payload.flags': flags, 'payload.id': _id, updatedAt: now } });
  const name = stored.payload.name || _id;
  void dispatchOutbound({
    type: 'item_flagged',
    summary: `Item flagged: ${name}${category ? ` (${category})` : ''}${note ? ` — ${String(note).slice(0, 120)}` : ''}`,
    data: { itemId: _id, name, note: String(note ?? ''), severity, category, by },
  });
  return { ok: true, itemId: _id, flag: flags[flags.length - 1] };
}

// ─── Event: set a staffer's travel or lodging (per-event PII write) ──────────────────────────────
// The "set my flight / my hotel" path (the REST set_flight/set_lodging tools). Gated by staff.pii.view
// with self/lead/manager context: a user can set THEIR OWN travel (isSelf), the lead of the event can
// set any staffer's (isLeadOfEvent), manager+ can set anyone's. Merges the patch into the matched
// staffer's travel|hotel object and $sets ONLY payload.staff + updatedAt — never any other field, and
// it can only touch a person already on the roster (no arbitrary staffer insertion). The target
// defaults to the actor when staffEmail is omitted.
export async function setStaffPii({
  eventId,
  staffEmail,
  kind,
  patch,
  actorEmail,
  actorRole,
}: {
  eventId: string;
  staffEmail?: string;
  kind: 'travel' | 'hotel';
  patch: Record<string, unknown>;
  actorEmail: string;
  actorRole: string;
}): Promise<{ ok: boolean; staffEmail: string; travel?: unknown; hotel?: unknown }> {
  const _id = String(eventId);
  const db = await getDb();
  const col = db.collection<EventDoc>('events');
  const stored = await col.findOne({ _id, ...NOT_DELETED });
  if (!stored) throw new Error('Event not found (or deleted).');

  const lc = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const target = lc(staffEmail) || lc(actorEmail);
  if (!target) throw new Error('A staff email is required.');
  const isSelf = target === lc(actorEmail);
  const isLead = viewerLeadsEvent(stored.payload, actorEmail);
  if (!can('staff.pii.view', actorRole, { isSelf, isLeadOfEvent: isLead })) {
    throw new WriteForbiddenError('You do not have permission to set travel/lodging for this person.');
  }

  const staff = (Array.isArray(stored.payload.staff) ? stored.payload.staff.slice() : []) as unknown as Record<string, unknown>[];
  const idx = staff.findIndex((s) => lc(s?.email) === target);
  if (idx === -1) throw new Error('That person is not on this event roster.');
  const cur = staff[idx] || {};
  const clean = patch && typeof patch === 'object' ? patch : {};
  const merged: Record<string, unknown> =
    kind === 'hotel'
      ? { ...cur, hotel: { ...((cur.hotel as object) || {}), ...clean } }
      : { ...cur, travel: { ...((cur.travel as object) || {}), ...clean } };
  staff[idx] = merged;

  const now = Date.now();
  await col.updateOne({ _id, ...NOT_DELETED }, { $set: { 'payload.staff': staff, updatedAt: now } });
  return {
    ok: true,
    staffEmail: target,
    ...(kind === 'hotel' ? { hotel: merged.hotel } : { travel: merged.travel }),
  };
}

// ─── Inventory: CREATE (mint id + insert, then apply the editor patch) ──────────────────────────
// The catalog "new item" path for the REST API + the generic /db mirror. Mints a server-side id (a
// client id is never trusted), inserts a minimal bulk envelope, then applies the patch via upsertItem
// (which re-gates db.write.app + sanitizes every field). Gated by db.write.app (authorized+).
export async function createInventoryItem({
  patch,
  actorRole,
}: {
  patch: ItemPatch;
  actorRole: string;
}): Promise<CreateEventResult> {
  if (!can('db.write.app', actorRole)) {
    throw new WriteForbiddenError('You do not have permission to create inventory.');
  }
  const db = await getDb();
  const col = db.collection<InventoryDoc>('inventory');
  const id = generateId();
  const now = Date.now();
  const base = { id, tracking: 'bulk', distribution: [], units: [], flags: [] } as unknown as InventoryDoc['payload'];
  await col.insertOne({ _id: id, payload: base, createdAt: now, updatedAt: now, deletedAt: null } as InventoryDoc);
  if (patch && Object.keys(patch).length) {
    await upsertItem({ id, patch, actorRole });
  }
  return { ok: true, matched: 1, modified: 1, id };
}

