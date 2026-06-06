import 'server-only';
import { MongoClient, type Db } from 'mongodb';
import { cookies } from 'next/headers';
import { DEMO_MODE, DEMO_SID_COOKIE, verifyDemoSid, ensureSandbox } from '@/lib/db/demo';

// LIVE-DB MODEL: there is no localStorage fallback. A missing/unreachable DB is fatal at
// REQUEST time — the app surfaces an error rather than silently serving stale data. The check
// is lazy (in getDb, not at import) so `next build` doesn't need a database.
const dbName = process.env.MONGO_DB || 'event_tracker';

// One pooled client per server process, cached across HMR reloads in dev.
declare global {
  // eslint-disable-next-line no-var
  var _etMongoClient: Promise<MongoClient> | undefined;
}

function connect(): Promise<MongoClient> {
  if (global._etMongoClient) return global._etMongoClient;
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error(
      'MONGO_URI is not set. Copy .env.example to .env.local and point it at the database.'
    );
  }
  // serverSelectionTimeoutMS makes an unreachable DB FAIL FAST (the live-DB hard error) instead of
  // hanging every request forever. On failure, clear the cached promise so the next request retries
  // — never cache a rejection/hung connect, which would wedge the whole process until a restart.
  const p = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }).connect();
  p.catch(() => {
    if (global._etMongoClient === p) global._etMongoClient = undefined;
  });
  global._etMongoClient = p;
  return p;
}

export async function getDb(): Promise<Db> {
  const client = await connect();
  if (!DEMO_MODE) return client.db(dbName);
  // DEMO MODE: route to THIS visitor's per-cookie sandbox (lazily cloned from the read-only seed).
  // The sid comes ONLY from the signed cookie — never a param — and is HMAC-verified here (the
  // authoritative check; middleware merely issues + shape-checks it). A missing/forged sid throws
  // rather than ever falling back to the shared seed (which must never be written).
  let token: string | undefined;
  try {
    token = (await cookies()).get(DEMO_SID_COOKIE)?.value;
  } catch {
    throw new Error('demo sandbox is unavailable outside a request');
  }
  const sid = verifyDemoSid(token);
  if (!sid) throw new Error('demo session not initialized');
  return ensureSandbox(client, sid);
}

/** The pooled Mongo client (for process-level jobs like the demo-sandbox GC). */
export async function mongoClient(): Promise<MongoClient> {
  return connect();
}

/** The configured database name (never the URI — that can carry credentials). */
export function dbNameForDisplay(): string {
  return dbName;
}

/**
 * A live connectivity probe for the Config > Databases & API "connection" card. Runs a cheap
 * `ping` admin command; returns { reachable, dbName } so the card can render a green/red dot. NEVER
 * exposes the URI/credentials. Reachable=false on any error (timeout / auth / down) — never throws.
 */
export async function dbStatus(): Promise<{ reachable: boolean; dbName: string }> {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return { reachable: true, dbName };
  } catch {
    return { reachable: false, dbName };
  }
}

// Excludes soft-deleted docs (the Python version stamps deletedAt at the top level / in payload).
export const NOT_DELETED = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
