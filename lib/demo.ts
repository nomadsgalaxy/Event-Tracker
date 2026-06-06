import 'server-only';
import crypto from 'node:crypto';
import type { MongoClient, Db } from 'mongodb';

// lib/demo.ts — DEMO MODE: a public, self-resetting sandbox build of the app.
//
// Each visitor gets their OWN isolated copy of the data, keyed by an unguessable, HMAC-SIGNED cookie
// (eit_demo_sid). getDb() transparently routes that visitor to a Mongo database `demo_<sid>`, lazily
// CLONED from a read-only seed DB on first write. The shared seed is NEVER mutated, so the demo data
// is always retained; clearing the browser (deleting the cookie) yields a fresh sid -> a fresh clone =
// reset. Admin/config writes are blocked separately (see the write guard) so settings stay visible
// but inert.
//
// ISOLATION (the security contract — red-team this):
//   • The sid is the ONLY key to a sandbox and comes ONLY from the signed cookie — never a URL/param,
//     so there is no IDOR. A handler cannot be told which sandbox to use.
//   • The sid is 128 bits of CSPRNG randomness (unguessable) AND HMAC-SHA256-signed with
//     ET_SESSION_SECRET, so a forged or attacker-chosen value is rejected (verifyDemoSid -> null):
//     a visitor can only ever reach a sandbox the server issued to THEM.
//   • The sid is validated to exactly 32 lowercase-hex chars BEFORE it is interpolated into a DB
//     name, so it can never inject a different/again-existing database name.
//   • The seed DB is only ever READ (by the clone). No request path writes to it.

export const DEMO_MODE = process.env.EIT_DEMO_MODE === '1';

// In demo mode the DEPLOYMENT/ADMIN settings (integration keys, access policy, permissions, tenant,
// branding, sync, user provisioning + roles, accommodations PII) are SHOWN but inert — visitors see
// what they could configure on their own deployment, but can't change the live demo. Operational app
// data (events, cases, inventory, scan, sign-off) stays editable in the visitor's own sandbox. This
// is the SERVER-SIDE, tamper-proof half: denyInDemo() throws from the admin/config write chokepoints
// regardless of the UI (which also disables the controls + shows a banner).
export class DemoReadOnlyError extends Error {
  constructor(what = 'This setting') {
    super(`${what} is read-only in the demo. Configure it on your own deployment.`);
    this.name = 'DemoReadOnlyError';
  }
}

/** Refuse an admin/config write when running as the demo (THROW form — for throw-based helpers). */
export function denyInDemo(what: string): void {
  if (DEMO_MODE) throw new DemoReadOnlyError(what);
}

/** The demo-denied result for `{ ok, error }`-returning helpers (clean UX, no 500). */
export function demoDenied(what: string): { ok: false; error: string } {
  return { ok: false, error: `${what} is read-only in the demo. Configure it on your own deployment.` };
}
export const DEMO_SEED_DB = (process.env.EIT_DEMO_SEED_DB || 'demo_seed').trim();
export const DEMO_SID_COOKIE = 'eit_demo_sid';

// A sandbox is idle-collected after this long with no access (a cron/route calls gcDemoSandboxes).
const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000;
const META_ID = '__demo_meta__';

function secretBytes(): Buffer {
  const s = process.env.ET_SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('ET_SESSION_SECRET is required (>=16 chars) for demo session signing.');
  return Buffer.from(s, 'utf-8');
}

/** The exact, validating shape of a sid token: 32 hex (the id) + '.' + 64 hex (the HMAC). */
const SID_TOKEN_RE = /^[0-9a-f]{32}\.[0-9a-f]{64}$/;
/** A bare sid (no signature) — used to validate before forming a DB name. */
const SID_RE = /^[0-9a-f]{32}$/;

/** Cheap, NON-cryptographic shape check for the Edge middleware (mirrors its session pre-check model):
 *  is this a well-formed `<sid>.<sig>` token? The authoritative HMAC check is verifyDemoSid (Node). */
export function looksLikeDemoSidToken(token: string | null | undefined): boolean {
  return !!token && SID_TOKEN_RE.test(token);
}

/** Authoritatively verify a sid token: strict format + constant-time HMAC. Returns the bare sid (32
 *  hex) or null. NEVER throws on bad input — a forged/malformed token is just null (fail closed). */
export function verifyDemoSid(token: string | null | undefined): string | null {
  if (!token || !SID_TOKEN_RE.test(token)) return null;
  const dot = token.indexOf('.');
  const sid = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expect: string;
  try {
    expect = crypto.createHmac('sha256', secretBytes()).update(sid, 'ascii').digest('hex');
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return SID_RE.test(sid) ? sid : null;
}

/** The per-visitor sandbox DB name. Caller MUST pass a sid that passed verifyDemoSid (32-hex). */
export function demoSandboxDbName(sid: string): string {
  if (!SID_RE.test(sid)) throw new Error('invalid demo sid'); // defence-in-depth against name injection
  return `demo_${sid}`;
}

interface DemoMeta {
  _id: string;
  ready?: boolean; // true ONLY after the clone fully completed
  seededAt?: number;
  claimedAt?: number;
  lastAccessAt?: number;
}

// In-process caches: sandboxes confirmed-ready (skip the findOne) + de-dupe of the clone job + a
// throttle on the lastAccess GC touch.
const _ready = new Set<string>();
const _cloning = new Map<string, Promise<void>>();
const _lastTouch = new Map<string, number>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function touch(db: Db, sid: string): void {
  const now = Date.now();
  if (now - (_lastTouch.get(sid) || 0) < 60 * 60 * 1000) return; // at most hourly per sid per process
  _lastTouch.set(sid, now);
  void db.collection<DemoMeta>('_demo').updateOne({ _id: META_ID }, { $set: { lastAccessAt: now } }).catch(() => {});
}

/**
 * Lazily clone the read-only seed DB into the visitor's sandbox. CROSS-PROCESS-SAFE: the clone is
 * CLAIMED with an atomic upsert-insert of the meta marker (only one caller, across ALL processes,
 * wins the insert). The winner copies the seed and only THEN flips `ready:true`; everyone else waits
 * (bounded) for `ready` before using the sandbox — so a half-cloned DB is never served as complete.
 * Idempotent: a ready sandbox is a no-op.
 */
export async function ensureSandbox(client: MongoClient, sid: string): Promise<Db> {
  const name = demoSandboxDbName(sid);
  const db = client.db(name);
  if (_ready.has(sid)) {
    touch(db, sid);
    return db;
  }
  const meta = db.collection<DemoMeta>('_demo');
  const existing = await meta.findOne({ _id: META_ID });
  if (existing?.ready) {
    _ready.add(sid);
    touch(db, sid);
    return db;
  }

  let job = _cloning.get(sid);
  if (!job) {
    job = (async () => {
      const now = Date.now();
      let won = false;
      try {
        // Atomic claim: inserts the marker iff it doesn't exist. Exactly one caller's upsert inserts.
        const r = await meta.updateOne({ _id: META_ID }, { $setOnInsert: { ready: false, claimedAt: now } }, { upsert: true });
        won = (r.upsertedCount ?? 0) > 0;
      } catch {
        won = false; // a concurrent insert raced us to the unique _id — we lost the claim
      }
      if (won) {
        try {
          const seed = client.db(DEMO_SEED_DB);
          const cols = await seed.listCollections({}, { nameOnly: true }).toArray();
          for (const c of cols) {
            if (c.name.startsWith('system.') || c.name === '_demo') continue;
            const docs = await seed.collection(c.name).find({}).toArray();
            // No .catch here — a real copy failure must propagate so we DON'T mark a partial clone
            // ready. (We own a fresh DB, so there are no duplicate-key collisions to swallow.)
            if (docs.length) await db.collection(c.name).insertMany(docs, { ordered: false });
          }
          await meta.updateOne({ _id: META_ID }, { $set: { ready: true, seededAt: now, lastAccessAt: now } });
        } catch (e) {
          // Clone failed → RELEASE the claim so a later request re-clones (never leave a stuck,
          // permanently-not-ready marker). The error propagates → getDb throws → fail closed.
          await meta.deleteOne({ _id: META_ID }).catch(() => {});
          throw e;
        }
      } else {
        // Lost the claim → another process is cloning. Wait (bounded ~15s) for it to flip ready.
        for (let i = 0; i < 150; i++) {
          const m = await meta.findOne({ _id: META_ID }, { projection: { ready: 1 } });
          if (m?.ready) break;
          await sleep(100);
        }
      }
    })();
    _cloning.set(sid, job);
    job.finally(() => _cloning.delete(sid));
  }
  await job;

  // Serve ONLY once the clone is confirmed complete — never a half-cloned sandbox. A loser that timed
  // out, or a winner whose clone failed (claim released), lands here not-ready and FAILS CLOSED; the
  // visitor's retry then finds it ready or re-clones.
  const final = await meta.findOne({ _id: META_ID }, { projection: { ready: 1 } });
  if (!final?.ready) throw new Error('demo sandbox is initializing — please retry');
  _ready.add(sid);
  return db;
}

/** Drop sandbox DBs idle longer than the TTL (called by a cron/route — keeps Mongo from growing
 *  unbounded as visitors come and go). Returns the number dropped. Never touches the seed or the
 *  app DB. */
export async function gcDemoSandboxes(client: MongoClient): Promise<number> {
  const admin = client.db().admin();
  const { databases } = await admin.listDatabases({ nameOnly: true });
  const cutoff = Date.now() - SANDBOX_TTL_MS;
  let dropped = 0;
  for (const d of databases) {
    if (!/^demo_[0-9a-f]{32}$/.test(d.name)) continue; // only OUR per-visitor sandboxes
    const db = client.db(d.name);
    const meta = await db.collection<{ _id: string; lastAccessAt?: number }>('_demo').findOne({ _id: META_ID });
    if (!meta || (meta.lastAccessAt ?? 0) < cutoff) {
      await db.dropDatabase().catch(() => {});
      dropped++;
    }
  }
  return dropped;
}
