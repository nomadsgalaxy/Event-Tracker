import 'server-only';
import crypto from 'node:crypto';
import { getDb } from '@/lib/db/mongo';
import { AUTH_COLLECTION, resolveLiveRole, type AuthDoc } from '@/lib/auth/auth';
import { encSecret, decSecret } from '@/lib/auth/totp';
import { rankOf } from '@/lib/auth/rbac';

// lib/integrations/calendar-feed.ts — per-user iCalendar (.ics) subscription tokens (mirrors server/eit_calendar.py).
//
// Each user gets an unguessable personal feed token; manager/admin also get a GLOBAL one. The token is
// stored as { hash, enc }: hash = HMAC-SHA256(ET_SESSION_SECRET, "cal:"+token) for O(1) lookup, enc =
// the AES-wrapped token so the Account page can re-display the URL. The .ics endpoint is token-
// authenticated (the unguessable token IS the credential — calendar apps can't do SSO), and the GLOBAL
// feed re-checks the owner's LIVE role on every fetch so a demoted manager's global feed stops working.

const MGR_MIN_RANK = rankOf('manager');
const norm = (e: unknown): string => String(e ?? '').trim().toLowerCase();

function feedSecret(): Buffer {
  const s = process.env.ET_SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('ET_SESSION_SECRET is required (>=16 chars) for calendar feeds.');
  return Buffer.from(s, 'utf-8');
}

function hashToken(token: string): string {
  return crypto.createHmac('sha256', feedSecret()).update(`cal:${token}`).digest('hex');
}

function newToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function baseUrl(reqOrigin: string): string {
  const env = (process.env.EIT_PUBLIC_URL || '').trim();
  return (env || reqOrigin).replace(/\/+$/, '');
}

async function rec(email: string): Promise<AuthDoc | null> {
  const db = await getDb();
  return db.collection<AuthDoc>(AUTH_COLLECTION).findOne({ _id: norm(email) });
}

async function save(email: string, set: Partial<AuthDoc>): Promise<void> {
  const db = await getDb();
  await db.collection<AuthDoc>(AUTH_COLLECTION).updateOne(
    { _id: norm(email) },
    { $set: { ...set, updatedAt: Date.now() } },
    { upsert: true } // a self-serve SSO user may have no auth record yet — provision one for the token
  );
}

export interface CalendarFeeds {
  personalUrl: string;
  globalUrl?: string;
}

/** Ensure the caller has a personal feed token (and a global one if manager+), then return the URLs.
 *  Role is the LIVE session role passed by the route (so a demoted manager loses the global URL). */
export async function getCalendarFeeds(email: string, role: string, reqOrigin: string): Promise<CalendarFeeds> {
  const e = norm(email);
  const r = (await rec(e)) ?? null;
  const isMgr = rankOf(role) >= MGR_MIN_RANK;

  // Personal token (decrypt if present, else mint + persist).
  let pTok = r?.calFeed?.enc ? decSecret(r.calFeed.enc) : null;
  const set: Partial<AuthDoc> = {};
  if (!pTok) {
    pTok = newToken();
    set.calFeed = { hash: hashToken(pTok), enc: encSecret(pTok) };
  }
  let gTok: string | null = null;
  if (isMgr) {
    gTok = r?.calFeedGlobal?.enc ? decSecret(r.calFeedGlobal.enc) : null;
    if (!gTok) {
      gTok = newToken();
      set.calFeedGlobal = { hash: hashToken(gTok), enc: encSecret(gTok) };
    }
  }
  if (Object.keys(set).length) await save(e, set);

  const base = baseUrl(reqOrigin);
  const out: CalendarFeeds = { personalUrl: `${base}/calendar/${pTok}.ics` };
  if (gTok) out.globalUrl = `${base}/calendar/${gTok}.ics`;
  return out;
}

export type RegenFeedResult = { ok: true; which: 'personal' | 'global'; url: string } | { ok: false; error: string; code: 403 };

/** Regenerate (rotate) one feed token. The global feed requires manager+ (the LIVE role from the
 *  route). Mirrors eit_calendar._h_regenerate. */
export async function regenerateFeed(
  email: string,
  role: string,
  which: string,
  reqOrigin: string
): Promise<RegenFeedResult> {
  const e = norm(email);
  const tok = newToken();
  const base = baseUrl(reqOrigin);
  if (which === 'global') {
    if (rankOf(role) < MGR_MIN_RANK) return { ok: false, error: 'manager or admin role required for the global feed', code: 403 };
    await save(e, { calFeedGlobal: { hash: hashToken(tok), enc: encSecret(tok) } });
    return { ok: true, which: 'global', url: `${base}/calendar/${tok}.ics` };
  }
  await save(e, { calFeed: { hash: hashToken(tok), enc: encSecret(tok) } });
  return { ok: true, which: 'personal', url: `${base}/calendar/${tok}.ics` };
}

// ── Feed serving (PUBLIC; the unguessable token IS the credential) ───────────────────────────────
export interface FeedOwner {
  email: string;
  scope: 'personal' | 'global';
  role: string;
}

/** Resolve a feed token (sans .ics) to its owner + scope, re-checking the GLOBAL role gate. Returns
 *  null for an unknown token (404) and { forbidden:true } when a demoted owner's global token is
 *  presented (403). Mirrors the lookup in eit_calendar.serve_feed. */
export async function resolveFeedToken(
  tokenWithExt: string
): Promise<{ email: string; scope: 'personal' | 'global'; role: string } | { forbidden: true } | null> {
  let token = tokenWithExt;
  if (token.endsWith('.ics')) token = token.slice(0, -4);
  token = token.trim();
  if (!token) return null;
  const h = hashToken(token);
  const db = await getDb();
  const doc = await db
    .collection<AuthDoc>(AUTH_COLLECTION)
    .findOne({ $or: [{ 'calFeed.hash': h }, { 'calFeedGlobal.hash': h }] });
  if (!doc) return null;
  const email = doc._id;

  // An OFFBOARDED (soft-deleted) user's feed tokens die with the account — the auth-doc hard-delete
  // is best-effort, so the tombstone is the authority here (same rule as every session/key mint).
  const dir = await db
    .collection<{ _id: string; payload?: { deletedAt?: number | null }; deletedAt?: number | null }>('users')
    .findOne({ _id: email }, { projection: { deletedAt: 1, 'payload.deletedAt': 1 } });
  if (dir && (dir.deletedAt || dir.payload?.deletedAt)) return null;

  // The GLOBAL feed gate re-checks the LIVE directory role (not the auth-doc snapshot, which can go
  // stale — e.g. a manager demoted in the directory must lose the global feed immediately).
  const liveRole = await resolveLiveRole(email);
  if (doc.calFeedGlobal?.hash === h) {
    if (rankOf(liveRole) < MGR_MIN_RANK) return { forbidden: true };
    return { email, scope: 'global', role: liveRole };
  }
  if (doc.calFeed?.hash !== h) return null;
  return { email, scope: 'personal', role: liveRole };
}
