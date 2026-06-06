import 'server-only';
import { NextResponse } from 'next/server';
import { verifyApiKey, type VerifiedKey } from './api-keys';
import { can, type AuthzCtx, type Capability } from './rbac';
import { WriteForbiddenError } from './write';
import { DemoReadOnlyError } from './demo';
import { writeAudit } from './data';

// lib/api-v1.ts — the shared plumbing for the /api/v1 REST surface (the scoped key consumer).
//
// Every handler runs through withKey(): authenticate the bearer key, rate-limit per key, then run the
// route, mapping thrown WriteForbidden/DemoReadOnly/not-found errors to clean status codes. The cap gate
// is keyCan(): a key may do X iff it was SCOPED to X (storedCaps) AND the owner can do X right now
// (can(X, liveRole, ctx)). That single check enforces "never exceeds the owner" + honors self/lead ctx.

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function apiOk(body: Record<string, unknown> = {}, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}
export function apiErr(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** Parse a JSON body defensively (never throws — a bad/absent body is {}). */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The request's client IP for the audit trail + the per-IP throttle. Prefers the PROXY-SET headers
 *  (cf-connecting-ip, then x-real-ip) over the client-controllable leftmost X-Forwarded-For hop, so the
 *  rate-limit key can't be rotated by a spoofed XFF behind Cloudflare. */
export function clientIp(req: Request): string | null {
  const h = req.headers;
  return h.get('cf-connecting-ip') || h.get('x-real-ip') || h.get('x-forwarded-for')?.split(',')[0].trim() || null;
}

// ── Bearer extraction + auth ──────────────────────────────────────────────────────────────────────
function bearerToken(req: Request): string | null {
  const auth = req.headers.get('authorization') || '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim() || null;
  // Also accept X-Api-Key for non-OAuth clients (the token value, no scheme).
  return req.headers.get('x-api-key')?.trim() || null;
}

export async function authenticate(req: Request): Promise<VerifiedKey | null> {
  const token = bearerToken(req);
  if (!token) return null;
  return verifyApiKey(token);
}

// ── Capability gate ─────────────────────────────────────────────────────────────────────────────
/**
 * Whether THIS key may exercise `cap` in this context. The load-bearing control: the key must have been
 * SCOPED to the cap (storedCaps), AND the owner's live role/ctx must currently grant it (can()). Stored
 * caps can never widen what the owner can do; ctx grants (self/lead) are evaluated here, per-request.
 * Never let a route read vk.storedCaps directly for a decision — always go through keyCan().
 */
export function keyCan(vk: VerifiedKey, cap: Capability | string, ctx: AuthzCtx = {}): boolean {
  return vk.storedCaps.has(cap) && can(cap, vk.role, ctx);
}

/** Throwing form — for routes that gate before doing work. */
export function requireCap(vk: VerifiedKey, cap: Capability | string, ctx: AuthzCtx = {}): void {
  if (!keyCan(vk, cap, ctx)) {
    throw new WriteForbiddenError(`This key is not permitted to '${cap}'.`);
  }
}

/**
 * Gate the SCOPE half only — the key must have been scoped to `cap`. Use this on write routes that call
 * a lib/write.ts helper: the helper re-applies the OWNER half (can(cap, liveRole, ctx), including self/
 * lead context judged on the STORED record), so the route only needs to confirm the key carries the
 * cap. Together that's the full keyCan invariant (scope ∩ owner) without the route re-loading the doc
 * to compute ctx. For a cap with NO write helper behind it (a pure read gate), use keyCan/requireCap.
 */
export function requireScope(vk: VerifiedKey, cap: Capability | string): void {
  if (!vk.storedCaps.has(cap)) {
    throw new WriteForbiddenError(`This key is not scoped for '${cap}'.`);
  }
}

// ── Rate limits (in-memory sliding window) ──────────────────────────────────────────────────────
// Two layers, both per-process (good enough — keys are low-volume; a multi-instance deploy gets N×
// the budget, still bounded):
//   • PER-IP, applied BEFORE the key is verified — bounds the unauthenticated work (the PBKDF2 verify)
//     so a flood of forged tokens can't pin the box. This is the load-bearing DoS guard now that the
//     verify itself is async/non-blocking.
//   • PER-KEY, applied after verify — the normal abuse backstop for a valid key.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = (() => {
  const n = parseInt(process.env.EIT_API_RATE_LIMIT || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 600;
})();
// The per-IP budget is more generous (shared NAT / many keys behind one IP) but still finite.
const IP_RATE_MAX = (() => {
  const n = parseInt(process.env.EIT_API_IP_RATE_LIMIT || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1200;
})();

function slidingWindow(store: Map<string, number[]>, key: string, max: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const arr = (store.get(key) || []).filter((t) => t > cutoff);
  if (store.size > 20_000) {
    // Bound memory: drop fully-expired buckets (never mass-clear live counters).
    for (const [k, v] of store) if (v.length === 0 || v[v.length - 1] <= cutoff) store.delete(k);
  }
  if (arr.length >= max) {
    store.set(key, arr);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((arr[0] + RATE_WINDOW_MS - now) / 1000)) };
  }
  arr.push(now);
  store.set(key, arr);
  return { ok: true, retryAfter: 0 };
}

const _keyHits = new Map<string, number[]>();
const _ipHits = new Map<string, number[]>();
const rateLimit = (keyId: string) => slidingWindow(_keyHits, keyId, RATE_MAX);
const ipRateLimit = (ip: string) => slidingWindow(_ipHits, ip, IP_RATE_MAX);

function tooMany(retryAfter: number): NextResponse {
  return NextResponse.json({ error: 'rate limit exceeded' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(retryAfter) } });
}

// ── Error mapping ─────────────────────────────────────────────────────────────────────────────
// Echo ONLY the app's own controlled messages (the WriteForbidden/Demo classes + the short
// not-found/validation strings the write helpers throw). Anything else — a raw Mongo driver error
// (which embeds the db/collection namespace + index detail), the getDb env-config string, an
// unexpected throw — is replaced by a generic message and logged server-side, never echoed to the
// wire. The length gate is a second guard: real validation messages are short; driver dumps are not.
function mapError(e: unknown): NextResponse {
  if (e instanceof WriteForbiddenError) return apiErr(403, e.message);
  if (e instanceof DemoReadOnlyError) return apiErr(403, e.message);
  const raw = e instanceof Error ? e.message : '';
  const msg = raw.length <= 160 ? raw : '';
  if (msg && /\b(not found|no longer exists|not assigned to|not routed into|not in transit|not on this event)\b/i.test(msg)) {
    return apiErr(404, msg);
  }
  if (msg && /\b(is required|are required|must be|must include|invalid|not a valid|valid role|direction must|already uses|no editable fields|hotel name)\b/i.test(msg)) {
    return apiErr(400, msg);
  }
  // Internal / unexpected — don't leak it.
  console.error('[api/v1] unhandled error:', raw);
  return apiErr(500, 'request failed');
}

/** Per-IP throttle + authenticate + per-key rate-limit + run + error-map. The single entry every
 *  /api/v1 handler uses. The IP throttle runs FIRST, before the (now async, non-blocking) key verify,
 *  so a flood of forged tokens is bounded before it does any PBKDF2 work. */
export async function withKey(
  req: Request,
  run: (vk: VerifiedKey) => Promise<NextResponse>
): Promise<NextResponse> {
  const ipRl = ipRateLimit(clientIp(req) || 'unknown');
  if (!ipRl.ok) return tooMany(ipRl.retryAfter);

  const vk = await authenticate(req);
  if (!vk) return apiErr(401, 'invalid or missing API key');

  const rl = rateLimit(vk.keyId);
  if (!rl.ok) return tooMany(rl.retryAfter);

  try {
    return await run(vk);
  } catch (e) {
    return mapError(e);
  }
}

/** Append a key-driven write to the same audit trail UI writes land in (best-effort). */
export async function auditKeyWrite(
  vk: VerifiedKey,
  req: Request,
  action: string,
  target: string | null,
  result = 'ok',
  detail?: unknown
): Promise<void> {
  await writeAudit({
    actor: vk.ownerEmail,
    action,
    target,
    result,
    ip: clientIp(req),
    detail: { via: 'api', keyId: vk.keyId, ...(detail && typeof detail === 'object' ? detail : detail != null ? { detail } : {}) },
  });
}

// ── Small shared query helpers ──────────────────────────────────────────────────────────────────
export function qParam(req: Request, name: string): string {
  return new URL(req.url).searchParams.get(name)?.trim() || '';
}
export function intParam(req: Request, name: string, def: number, max: number): number {
  const raw = new URL(req.url).searchParams.get(name);
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}
/** Case-insensitive substring match used by the list/search endpoints. */
export function matches(haystack: unknown, q: string): boolean {
  if (!q) return true;
  return String(haystack ?? '').toLowerCase().includes(q.toLowerCase());
}
