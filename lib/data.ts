import 'server-only';
import { getDb, NOT_DELETED } from './mongo';
import type { EventDoc, CaseDoc, UserDoc, Envelope } from './types';
import type { InventoryDoc } from './inventory-shape';
import type { DashEvent } from './types-dashboard';

export type { DashEvent } from './types-dashboard';

// Every read goes straight to Mongo — no client cache, no localStorage. This is the
// "realtime DB" model: a request always reflects the current database state.
// (Authz/PII gating gets layered in here in the auth phase — see NEXTJS_ARCHITECTURE.md.)

export async function getEvents(): Promise<EventDoc[]> {
  const db = await getDb();
  return db
    .collection<EventDoc>('events')
    .find(NOT_DELETED)
    .sort({ 'payload.startDate': 1 })
    .toArray();
}

export async function getEvent(id: string): Promise<EventDoc | null> {
  const db = await getDb();
  return db.collection<EventDoc>('events').findOne({ _id: id, ...NOT_DELETED });
}

// ── Tags ──────────────────────────────────────────────────────────────────────────────────
// Live read off the `tags` collection (same envelope as events). Each tag doc:
//   { _id, payload: { id, label, hidden, flair, customEmoji, color, deletedAt, … } }
// Events reference tags by id via payload.tagIds[] + payload.primaryTagId. Soft-deleted tags are
// excluded by NOT_DELETED (the top-level tombstone); hidden tags ARE returned (the caller decides
// — effectivePrimaryTagId skips hidden, but a tag can still be hidden-but-applied). One real
// round-trip; no cache (the live-DB model), mirroring the existing app's tagStore.
export type TagDoc = Envelope<TagPayload>;
export interface TagPayload {
  id?: string;
  label?: string;
  hidden?: boolean;
  flair?: string | null; // library flair id ('flag-us'/'flag-cz' legacy, or a preset id) or null
  customEmoji?: string; // the denormalized emoji/flag glyph that travels with the tag
  color?: string | null; // hex tint (e.g. '#FD5000')
  deletedAt?: number | null;
}

export async function getTags(): Promise<TagDoc[]> {
  const db = await getDb();
  return db
    .collection<TagDoc>('tags')
    .find(NOT_DELETED)
    .sort({ 'payload.label': 1 })
    .toArray();
}

// ── Cases (road / flight cases) ───────────────────────────────────────────────────────────
// Live reads off the `cases` collection (same envelope as events). Sorted by label so the
// catalog list is stable. Retired cases are NOT excluded here — they're tombstone-free
// (retiredAt is a soft-retire, distinct from the envelope's deletedAt); the page decides
// whether to show them, mirroring the catalog's explicit "retired" filter.

export async function getCases(): Promise<CaseDoc[]> {
  const db = await getDb();
  return db
    .collection<CaseDoc>('cases')
    .find(NOT_DELETED)
    .sort({ 'payload.label': 1 })
    .toArray();
}

export async function getCase(id: string): Promise<CaseDoc | null> {
  const db = await getDb();
  return db.collection<CaseDoc>('cases').findOne({ _id: id, ...NOT_DELETED });
}

// Live read of the inventory collection — the case manifest cross-joins these to count what's
// inside a case (an item's distribution[]/units[] reference caseId). One real round-trip; no
// cache. The case pages read the WHOLE collection because an item can route into any case;
// this matches the current app, which holds all of window.ASSETS in memory for the same reason.
export async function getInventory(): Promise<InventoryDoc[]> {
  const db = await getDb();
  return db.collection<InventoryDoc>('inventory').find(NOT_DELETED).toArray();
}

// Flat, render-ready event projection for the dashboard list. Mirrors the current app's
// `window.displayShow` (index.html ~L9684): venue.city wins over a bare `city`, and the
// envelope's _id is the stable key the row links by. Manifest/scan progress is intentionally
// NOT projected here — those derive from a cross-join into the inventory collection in the
// current app; the dashboard list ports the filterable event metadata, not the per-event
// scan math. The DashEvent shape lives in lib/types-dashboard (client-safe, re-exported above).
function toDashEvent(e: EventDoc): DashEvent {
  const p = e.payload || {};
  const venue = (p.venue ?? {}) as { city?: unknown; name?: unknown };
  const venueCity = typeof venue.city === 'string' ? venue.city : '';
  const venueName = typeof venue.name === 'string' ? venue.name : '';
  return {
    id: e._id,
    name: p.name || '',
    state: p.state || 'draft',
    startDate: p.startDate || '',
    endDate: p.endDate || '',
    city: venueCity || p.city || '',
    lead: p.lead || '',
    venueName,
    tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

/**
 * Live read of every (non-deleted) event, projected to the flat DashEvent shape the dashboard
 * renders. Sorted by startDate ascending; undated events sort LAST (their empty startDate would
 * otherwise sort first) so the timeline section and the "undated" tail stay in sync. Every call
 * is a real DB round-trip — no cache, the live-DB model.
 */
export async function getDashboardEvents(): Promise<DashEvent[]> {
  const docs = await getEvents();
  const mapped = docs.map(toDashEvent);
  mapped.sort((a, b) => {
    const da = a.startDate || '9999-12-31';
    const db = b.startDate || '9999-12-31';
    return da < db ? -1 : da > db ? 1 : 0;
  });
  return mapped;
}

// ── Directory users (Config > Users) ──────────────────────────────────────────────────────
// The synced `users` directory — the authoritative session-role store (lib/auth resolveLiveRole
// reads payload.role from here). Excludes soft-deleted (offboarded) users via NOT_DELETED so the
// admin console lists only live accounts (a tombstoned user is demoted + hidden, matching
// resolveLiveRole's refusal to honor a deleted user's role). Sorted by email for a stable list.
// LIVE read — every call is a real round-trip (no cache). Admin-gated by the caller (the
// config area requireRole('admin')s before reading this).
export async function getUsers(): Promise<UserDoc[]> {
  const db = await getDb();
  return db
    .collection<UserDoc>('users')
    .find(NOT_DELETED)
    .sort({ _id: 1 })
    .toArray();
}

// Resolve a directory user's display name (preferredName -> name -> the email) for a sign-off
// "by" stamp. Mirrors displayNameForSession in the existing app (preferredName wins, else the
// directory name, else the email). One lean projected read; pins the _id to a scalar.
export async function getUserDisplayName(email: string): Promise<string> {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return '';
  const db = await getDb();
  const doc = await db
    .collection<UserDoc>('users')
    .findOne({ _id: e }, { projection: { 'payload.preferredName': 1, 'payload.name': 1 } });
  const p = doc?.payload;
  return (p?.preferredName || p?.name || e).trim() || e;
}

// Resolve a user's preferred WEIGHT unit ('kg' | 'lbs') from their directory unitPrefs (#11). Used
// so the catalog/case grid + detail + editor enter/show weight in the user's unit. Defaults to 'lbs'
// (the app default) when unset/unknown. One lean projected read; pins the _id to a scalar.
export async function getUserWeightUnit(email: string): Promise<'kg' | 'lbs'> {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return 'lbs';
  const db = await getDb();
  const doc = await db
    .collection<UserDoc & { payload: { unitPrefs?: { weight?: string } } }>('users')
    .findOne({ _id: e }, { projection: { 'payload.unitPrefs.weight': 1 } });
  const w = (doc?.payload as { unitPrefs?: { weight?: string } } | undefined)?.unitPrefs?.weight;
  return w === 'kg' ? 'kg' : 'lbs';
}

// Resolve a user's preferred TEMPERATURE unit ('C' | 'F') from their directory unitPrefs, for the
// venue weather chips. Defaults to 'F' (the app default); treats any value starting with 'c'
// (C / celsius) as Celsius. One lean projected read; pins the _id to a scalar.
export async function getUserTempUnit(email: string): Promise<'C' | 'F'> {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return 'F';
  const db = await getDb();
  const doc = await db
    .collection<UserDoc & { payload: { unitPrefs?: { temperature?: string } } }>('users')
    .findOne({ _id: e }, { projection: { 'payload.unitPrefs.temperature': 1 } });
  const t = (doc?.payload as { unitPrefs?: { temperature?: string } } | undefined)?.unitPrefs?.temperature;
  return String(t || '').toLowerCase().startsWith('c') ? 'C' : 'F';
}

// ── Admin audit log (Config > Audit) ──────────────────────────────────────────────────────
// The server-WRITTEN security/admin trail (eit_audit.py): logins, role changes, account
// create/delete, sync drops, etc. The `audit_log` collection is OFF the app-collection allowlist
// — unreachable from the /db data plane and the /api REST surface; only an admin session may read
// it (this stack enforces that via requireRole('admin') in the config route before calling here).
//
// Entries are NOT enveloped like app docs — each row is a flat record:
//   { _id, ts, actor, action, target, result, ip, detail }
// We read newest-first and cap the result (the seed has 151 rows; the cap keeps the page bounded
// and matches eit_audit's MAX_LIMIT discipline). No tombstone filter — audit rows are immutable
// and never soft-deleted.
export interface AuditEntry {
  _id: string;
  ts: number;
  actor: string | null;
  action: string;
  target: string | null;
  result: string;
  ip: string | null;
  detail?: unknown;
}

export const AUDIT_MAX_LIMIT = 500;

// ── Audit WRITE (server-only security trail) ────────────────────────────────────────────────
// Faithful port of eit_audit.log: append ONE immutable security/admin record. Best-effort — a
// failed audit write must NEVER break the action being audited (it's wrapped + swallows all errors).
// There is no client write path; the `audit_log` collection is off the data-plane allowlist, so only
// server code (here) can insert. detail is coerced to a JSON-safe value. ip is optional (the Next
// Route Handlers can pass the request IP; absent ⇒ null).
export async function writeAudit(entry: {
  actor: string | null;
  action: string;
  target?: string | null;
  result?: string;
  detail?: unknown;
  ip?: string | null;
}): Promise<void> {
  try {
    const now = Date.now();
    let detail = entry.detail;
    if (detail != null && typeof detail !== 'string' && typeof detail !== 'number' && typeof detail !== 'boolean' && typeof detail !== 'object') {
      detail = String(detail);
    }
    const rid = Math.random().toString(16).slice(2, 10);
    const row: AuditEntry = {
      _id: `${now}-${rid}`,
      ts: now,
      actor: entry.actor ? String(entry.actor).trim().toLowerCase() || null : null,
      action: String(entry.action),
      target: entry.target != null ? String(entry.target) : null,
      result: String(entry.result || 'ok'),
      ip: entry.ip ?? null,
      detail,
    };
    const db = await getDb();
    await db.collection<AuditEntry>('audit_log').insertOne(row);
  } catch {
    /* best-effort; never throws */
  }
}

export async function getAuditLog(limit = AUDIT_MAX_LIMIT): Promise<AuditEntry[]> {
  const db = await getDb();
  const lim = Math.max(1, Math.min(AUDIT_MAX_LIMIT, Math.floor(limit) || AUDIT_MAX_LIMIT));
  return db
    .collection<AuditEntry>('audit_log')
    .find({})
    .sort({ ts: -1 })
    .limit(lim)
    .toArray();
}

// ── Filtered + paginated audit read (Config > Audit advanced filters) ──────────────────────────
// Faithful port of eit_audit.handle's _build_filter + the limit/offset/total/facets contract:
//   • action / actor / result equality filters; a ts range (from/to, inclusive); a free-text `q`
//     across action/target/actor (regex-ESCAPED to avoid ReDoS — a literal, case-insensitive match).
//   • limit (default 100, cap 500) + offset; the matching `total` so the UI can page (Prev/Next).
//   • facets: distinct actions + actors over the most-recent rows, for the filter dropdowns.
// Admin-only — the route already requireRole('admin')s before calling. No PII (security rows carry
// actor email + a short note, never staff travel/hotel).
export const AUDIT_DEFAULT_LIMIT = 100;

export interface AuditQuery {
  action?: string;
  actor?: string;
  result?: string;
  from?: number;
  to?: number;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
  actions: string[];
  actors: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AUDIT_FACET_SCAN = 2000;

export async function getAuditPage(query: AuditQuery): Promise<AuditPage> {
  const db = await getDb();
  const col = db.collection<AuditEntry>('audit_log');

  const filt: Record<string, unknown> = {};
  if (query.action) filt.action = query.action;
  if (query.actor) filt.actor = String(query.actor).trim().toLowerCase();
  if (query.result) filt.result = query.result;
  const ts: Record<string, number> = {};
  if (typeof query.from === 'number' && Number.isFinite(query.from)) ts.$gte = query.from;
  if (typeof query.to === 'number' && Number.isFinite(query.to)) ts.$lte = query.to;
  if (Object.keys(ts).length) filt.ts = ts;
  const q = String(query.q ?? '').trim();
  if (q) {
    const rx = { $regex: escapeRegex(q), $options: 'i' };
    filt.$or = [{ action: rx }, { target: rx }, { actor: rx }];
  }

  const limit = Math.max(1, Math.min(AUDIT_MAX_LIMIT, Math.floor(query.limit || AUDIT_DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(query.offset || 0));

  const [entries, total, facetRows] = await Promise.all([
    col.find(filt).sort({ ts: -1 }).skip(offset).limit(limit).toArray(),
    col.countDocuments(filt),
    col.find({}).sort({ ts: -1 }).limit(AUDIT_FACET_SCAN).project({ action: 1, actor: 1 }).toArray(),
  ]);

  const actions = new Set<string>();
  const actors = new Set<string>();
  for (const d of facetRows as { action?: string; actor?: string }[]) {
    if (d.action) actions.add(d.action);
    if (d.actor) actors.add(d.actor);
  }

  return {
    entries,
    total,
    limit,
    offset,
    actions: [...actions].sort(),
    actors: [...actors].sort(),
  };
}

// ── My activity (Account > Activity) ──────────────────────────────────────────────────────
// The CURRENT user's own slice of the same server-written trail, SELF-SCOPED to actor==me. This
// powers the user-menu-only /activity screen — distinct from Config > Audit (admin-only, the FULL
// trail). Same immutable `audit_log` collection, same flat row shape, same newest-first cap; the
// ONLY difference is the `{ actor: <me> }` predicate, so a non-admin can read THEIR OWN history
// without the admin gate. `actor` is stored lower-cased email (eit_audit.log:
// str(actor).strip().lower()), so we match on the normalized email — never an object/operator
// (String()-coerce + lowercase, the same scalar pin lib/auth uses). An empty email matches
// nothing (returns []) rather than leaking the whole log.
export async function getMyActivity(
  email: string,
  limit = AUDIT_MAX_LIMIT
): Promise<AuditEntry[]> {
  const me = String(email ?? '').trim().toLowerCase();
  if (!me) return [];
  const db = await getDb();
  const lim = Math.max(1, Math.min(AUDIT_MAX_LIMIT, Math.floor(limit) || AUDIT_MAX_LIMIT));
  return db
    .collection<AuditEntry>('audit_log')
    .find({ actor: me })
    .sort({ ts: -1 })
    .limit(lim)
    .toArray();
}
