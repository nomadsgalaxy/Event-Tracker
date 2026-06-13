import 'server-only';
import crypto from 'node:crypto';
import { getDb } from '@/lib/db/mongo';
import { AUTH_COLLECTION } from '@/lib/auth/auth';
import { tenantHash36 } from '@/lib/integrations/eitm';
import { DEMO_MODE, demoDenied } from '@/lib/db/demo';

// lib/auth/settings-store.ts — the server-authoritative deployment SETTINGS store.
//
// One doc keyed `__settings__` in the `auth` collection (the SAME credential store as
// __perms__/__policy__/accounts — OFF the data-plane allowlist, so a /db caller can never read or
// write it; only this module touches it, server-side). It holds the operator-set, set-once-for-
// everyone configuration the Python app kept in __appconfig__/__policy__/branding:
//
//   • INTEGRATION KEYS — Google API key, Weather key, the FlightAware/OpenSky flight keys, and the three
//     shipment-tracking keys (EasyPost / 17TRACK / AfterShip). Each is a BEARER SECRET: stored
//     AES-256-GCM-ENCRYPTED at rest in `secrets.<name>` (an `{iv,ct,tag}` blob), NEVER echoed back
//     to any client (the UI learns only a set/unset boolean + a masked hint). Plaintext is resolved
//     server-side ONLY via getIntegrationKey().
//   • BRANDING — default company name + a domain→company map (non-secret; surfaces on the wordmark).
//   • ACCESS POLICY — additive admin-email allowlist + allowed sign-in domains + IdP group→role map
//     (ADD to the deploy-time env allowlist; the env entries are read-only and can't be removed here).
//   • TENANT override — the Data-Matrix tenant id override (feeds lib/eitm's deployTenantHash36).
//
// RESOLUTION RULE for every keyed value: `process.env || the encrypted store`. The env wins (deploy-
// time authority), the store is the UI-set fallback — so a key can be set via the Config UI OR the
// env, and setting it here lights up weather/Places/flight/tracking WITHOUT a redeploy.
//
// ENCRYPTION KEY: AES-256-GCM under a 32-byte key derived (HKDF-SHA256) from ET_SESSION_SECRET — the
// same root secret the session/TOTP-at-rest wrap uses, so there's no new secret to provision. Losing
// ET_SESSION_SECRET makes the stored secrets unrecoverable (they fail-closed to env/unset), exactly
// like the TOTP-at-rest wrap. A tampered blob fails the GCM tag and decrypts to null (never throws).
//
// LIVE-DB: a 30s TTL cache on the hot read path (getIntegrationKey is called per weather/flight/Places
// request) so we don't round-trip Mongo on every fetch; writes bust it. The admin SCREEN reads always
// force a fresh round-trip (getSettingsDoc({fresh:true})).

export const SETTINGS_ID = '__settings__';

// The integration-key names this app understands. The UI + getIntegrationKey both key off these.
export type IntegrationKeyName =
  | 'googleApiKey' // Maps / Places / Geocoding (shared Google key)
  | 'weatherKey' // Google Weather API (often the same Google key)
  | 'flightAwareKey' // FlightAware AeroAPI (live delays — the flight-status source)
  | 'openskyClientId' // OpenSky Network OAuth2 client id (live aircraft positions)
  | 'openskyClientSecret' // OpenSky Network OAuth2 client secret
  | 'easypostKey' // EasyPost shipment tracking (parcel + LTL)
  | 'track17Key' // 17TRACK free-tier fallback
  | 'aftershipKey'; // AfterShip aggregator (UniShippers/LTL)

// Per-key ENV fallback precedence. The FIRST non-empty env var wins; the store is consulted only when
// every listed env var is empty. Mirrors the Python env names (GOOGLE_API_KEY, FLIGHT_RAPIDAPI_KEY,
// EASYPOST_API_KEY, SEVENTEENTRACK_API_KEY, AFTERSHIP_API_KEY) plus the names lib/weather +
// lib/integrations + flight-actions already read, so nothing regresses.
const ENV_FALLBACK: Record<IntegrationKeyName, string[]> = {
  googleApiKey: ['GOOGLE_PLACES_API_KEY', 'GOOGLE_API_KEY'],
  weatherKey: ['GOOGLE_WEATHER_API_KEY', 'GOOGLE_API_KEY'],
  flightAwareKey: ['FLIGHTAWARE_API_KEY', 'AEROAPI_KEY'],
  openskyClientId: ['OPENSKY_CLIENT_ID'],
  openskyClientSecret: ['OPENSKY_CLIENT_SECRET'],
  easypostKey: ['EASYPOST_API_KEY'],
  track17Key: ['SEVENTEENTRACK_API_KEY', 'TRACK17_API_KEY'],
  aftershipKey: ['AFTERSHIP_API_KEY'],
};

export const INTEGRATION_KEY_NAMES = Object.keys(ENV_FALLBACK) as IntegrationKeyName[];

interface EncBlob {
  iv: string; // base64url, 12 bytes (GCM nonce)
  ct: string; // base64url ciphertext
  tag: string; // base64url, 16 bytes (GCM auth tag)
}

export interface BrandingSettings {
  companyDefault: string;
  /** domain (lowercased) → company name. */
  companyMap: Record<string, string>;
}

// ── Outbound notifications (webhook + Slack) ──────────────────────────────────────────────────────
// Admin-configured: a generic JSON webhook URL and/or a Slack incoming-webhook URL, plus which event
// types fan out. URLs are the capability (a Slack incoming webhook IS a bearer URL), stored as-is.
export const OUTBOUND_EVENT_TYPES = ['item_flagged', 'flight_delay', 'severe_weather', 'ship_kit_signoff', 'low_stock'] as const;
export type OutboundEventType = (typeof OUTBOUND_EVENT_TYPES)[number];
export interface OutboundWebhookConfig {
  webhookUrl: string;
  slackWebhookUrl: string;
  enabledEvents: string[];
}

export interface AccessPolicySettings {
  /** ADDITIVE admin emails (added to EIT_ADMIN_EMAILS — never removes an env entry). */
  adminEmails: string[];
  /** ADDITIVE allowed sign-in domains (added to EIT_OIDC_ALLOWED_DOMAINS). */
  allowedDomains: string[];
  /** IdP group → role map (role must be a valid role id). */
  groupRoleMap: Record<string, string>;
}

// ── Admin-configurable sign-in providers (generic OIDC + GitHub) ──────────────────────────────────
// Google stays a built-in (env-configured) provider handled by lib/auth/oidc.ts; these are the EXTRA
// providers an admin adds. The clientSecret is NEVER stored here — it lives encrypted in
// oauthSecrets[id] (an EncBlob, same as the integration-key secrets). id is validated PROVIDER_ID_RE.
export interface ProviderConfig {
  id: string; // url-safe slug: 'microsoft' | 'github' | 'okta-prod' …
  type: 'oidc' | 'github';
  label: string; // "Continue with Microsoft"
  enabled: boolean;
  clientId: string; // non-secret (like GOOGLE_CLIENT_ID)
  discoveryUrl?: string; // required for type==='oidc' (the .well-known/openid-configuration URL)
  scopes?: string; // space-separated; defaults applied at the protocol layer
  order?: number; // login-page display order (lower = first)
}
export const PROVIDER_ID_RE = /^[a-z0-9_-]{1,40}$/;

interface SettingsDoc {
  _id: string;
  secrets?: Partial<Record<IntegrationKeyName, EncBlob>>;
  branding?: Partial<BrandingSettings>;
  policy?: Partial<AccessPolicySettings>;
  /** Data-Matrix tenant id override (lowercased); empty/absent ⇒ fall back to env. */
  tenantId?: string;
  /** Admin-configured extra sign-in providers (Google is a built-in, not stored here). */
  oauthProviders?: ProviderConfig[];
  /** Encrypted per-provider client secrets, keyed by ProviderConfig.id. */
  oauthSecrets?: Record<string, EncBlob>;
  /** Admin-configured outbound webhook / Slack notifications. */
  outboundWebhooks?: OutboundWebhookConfig;
  updatedBy?: string;
  updatedAt?: number;
}

// ── AES-256-GCM under an HKDF-derived key from ET_SESSION_SECRET ──────────────────────────────────
function encKey(): Buffer {
  const s = process.env.ET_SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('ET_SESSION_SECRET is not set (or shorter than 16 chars) — cannot encrypt settings.');
  }
  // HKDF-SHA256 with a fixed info label so this key is domain-separated from the session HMAC.
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(s, 'utf-8'), Buffer.alloc(0), Buffer.from('eit-settings-aesgcm'), 32));
}

const b64u = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function b64uDec(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function encSecret(plaintext: string): EncBlob {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf-8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: b64u(iv), ct: b64u(ct), tag: b64u(tag) };
}

/** Decrypt a stored blob; returns null on ANY error (tamper / wrong key / malformed) — never throws. */
function decSecret(blob: EncBlob | undefined | null): string | null {
  if (!blob || typeof blob !== 'object' || !blob.iv || !blob.ct || !blob.tag) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), b64uDec(blob.iv));
    decipher.setAuthTag(b64uDec(blob.tag));
    const pt = Buffer.concat([decipher.update(b64uDec(blob.ct)), decipher.final()]);
    return pt.toString('utf-8');
  } catch {
    return null;
  }
}

// ── doc read (30s TTL cache for the hot path; force-fresh for the admin screen) ──────────────────
let _docCache: { at: number; doc: SettingsDoc | null } | null = null;
const DOC_TTL_MS = 30_000;

async function getSettingsDoc(opts: { fresh?: boolean } = {}): Promise<SettingsDoc | null> {
  const now = Date.now();
  if (!opts.fresh && _docCache && now - _docCache.at < DOC_TTL_MS) return _docCache.doc;
  try {
    const db = await getDb();
    const doc = (await db.collection<SettingsDoc>(AUTH_COLLECTION).findOne({ _id: SETTINGS_ID })) ?? null;
    _docCache = { at: now, doc };
    return doc;
  } catch {
    // A flaky store must never wipe a cached value or crash the hot path — fall back to the last
    // cached doc (or null, which then resolves to env/unset everywhere).
    return _docCache?.doc ?? null;
  }
}

function bustCache(): void {
  _docCache = null;
}

const envValue = (names: string[]): string => {
  for (const n of names) {
    const v = (process.env[n] || '').trim();
    if (v) return v;
  }
  return '';
};

// ── The Python app's __appconfig__ doc (a THIRD source: the live DB) ──────────────────────────────
// The Python server keeps its operator-set integration keys in `__appconfig__` (same `auth` collection,
// off the data-plane allowlist). Reading it here lets a deployment whose DB the Python app populated —
// or a DB shared between the two — reuse those keys with nothing re-entered. googleApiKey/clientId/etc.
// are PLAINTEXT (public-by-design; the Python serves them to the browser). The flight/EasyPost/AfterShip
// keys are encrypted with eit_auth's HMAC-CTR cipher keyed off EIT_AUTH_SECRET, so they only decrypt
// here when this app's ET_SESSION_SECRET equals that secret — the same alignment the shared session
// token format already needs. A mismatch (or absent doc) simply yields '' and we fall through.
export const APPCONFIG_ID = '__appconfig__';

interface AppConfigDoc {
  _id: string;
  googleApiKey?: string; // plaintext (Maps / Places / Weather)
  flightAwareKeyEnc?: string; // enc_secret blob (FlightAware AeroAPI)
  shipKeyEnc?: string; // enc_secret blob (EasyPost)
  aftershipKeyEnc?: string; // enc_secret blob (AfterShip)
}

const hmac256 = (key: Buffer, data: Buffer): Buffer => crypto.createHmac('sha256', key).update(data).digest();

// HMAC-SHA256 CTR keystream — a byte-for-byte port of eit_auth._keystream.
function ctrKeystream(ek: Buffer, nonce: Buffer, n: number): Buffer {
  const parts: Buffer[] = [];
  let len = 0;
  let counter = 0n;
  while (len < n) {
    const ctr = Buffer.alloc(8);
    ctr.writeBigUInt64BE(counter);
    const block = hmac256(ek, Buffer.concat([nonce, ctr]));
    parts.push(block);
    len += block.length;
    counter += 1n;
  }
  return Buffer.concat(parts).subarray(0, n);
}

// Port of eit_auth.dec_secret: parse nonce(16)+ct+tag(32), verify HMAC, XOR-decrypt. Keys derived
// hmac(secret,'totp-enc'|'totp-mac') from ET_SESSION_SECRET treated as UTF-8 bytes (matching the
// session-token approach). Returns null on tamper / wrong secret / malformed — never throws.
function decAppConfigSecret(blob: string | undefined | null): string | null {
  if (!blob || typeof blob !== 'string') return null;
  const s = process.env.ET_SESSION_SECRET;
  if (!s || s.length < 16) return null;
  try {
    const secret = Buffer.from(s, 'utf-8');
    const raw = b64uDec(blob);
    if (raw.length < 16 + 32) return null;
    const nonce = raw.subarray(0, 16);
    const ct = raw.subarray(16, raw.length - 32);
    const tag = raw.subarray(raw.length - 32);
    const ek = hmac256(secret, Buffer.from('totp-enc'));
    const mk = hmac256(secret, Buffer.from('totp-mac'));
    const expect = hmac256(mk, Buffer.concat([nonce, ct]));
    if (expect.length !== tag.length || !crypto.timingSafeEqual(expect, tag)) return null;
    const ks = ctrKeystream(ek, nonce, ct.length);
    const out = Buffer.alloc(ct.length);
    for (let i = 0; i < ct.length; i++) out[i] = ct[i] ^ ks[i];
    return out.toString('utf-8');
  } catch {
    return null;
  }
}

let _appCfgCache: { at: number; doc: AppConfigDoc | null } | null = null;
async function getAppConfigDoc(): Promise<AppConfigDoc | null> {
  const now = Date.now();
  if (_appCfgCache && now - _appCfgCache.at < DOC_TTL_MS) return _appCfgCache.doc;
  try {
    const db = await getDb();
    const doc = (await db.collection<AppConfigDoc>(AUTH_COLLECTION).findOne({ _id: APPCONFIG_ID })) ?? null;
    _appCfgCache = { at: now, doc };
    return doc;
  } catch {
    return _appCfgCache?.doc ?? null;
  }
}

/** Resolve a key from the Python __appconfig__ doc (plaintext or decrypted), or '' when absent. */
function appConfigKey(name: IntegrationKeyName, doc: AppConfigDoc | null): string {
  if (!doc) return '';
  switch (name) {
    case 'googleApiKey':
    case 'weatherKey':
      return String(doc.googleApiKey || '').trim();
    case 'flightAwareKey':
      return decAppConfigSecret(doc.flightAwareKeyEnc) || '';
    case 'easypostKey':
      return decAppConfigSecret(doc.shipKeyEnc) || '';
    case 'aftershipKey':
      return decAppConfigSecret(doc.aftershipKeyEnc) || '';
    default:
      return ''; // 17TRACK has no __appconfig__ field
  }
}

// ── PUBLIC: resolve a key (env || store || the Python __appconfig__ in the live DB) ──────────────
/**
 * Resolve an integration key for SERVER-SIDE use. Precedence: the env var(s), then the AES-GCM Next.js
 * store, then the Python app's __appconfig__ doc in the live DB. Returns '' when none is set. This is
 * the ONE accessor the integration utils (weather/Places/flight/tracking) call — the plaintext NEVER
 * leaves the server through it.
 */
export async function getIntegrationKey(name: IntegrationKeyName): Promise<string> {
  const env = envValue(ENV_FALLBACK[name] ?? []);
  if (env) return env;
  const fromStore = decSecret((await getSettingsDoc())?.secrets?.[name]);
  if (fromStore) return fromStore;
  return appConfigKey(name, await getAppConfigDoc()) || '';
}

export interface IntegrationKeyStatus {
  name: IntegrationKeyName;
  /** A key is resolvable (set via env OR the store). */
  set: boolean;
  /** The key is provided by an env var (read-only; the store value is shadowed). */
  fromEnv: boolean;
  /** The key is present in the encrypted store (independent of env). */
  inStore: boolean;
}

/**
 * The set/unset provenance for EVERY integration key — what the admin screen renders. NEVER returns a
 * secret value (only booleans). Reads the doc fresh so the screen reflects a just-saved key.
 */
export async function integrationKeyStatuses(): Promise<IntegrationKeyStatus[]> {
  const doc = await getSettingsDoc({ fresh: true });
  return INTEGRATION_KEY_NAMES.map((name) => {
    const fromEnv = envValue(ENV_FALLBACK[name] ?? []).length > 0;
    const inStore = decSecret(doc?.secrets?.[name]) != null;
    return { name, set: fromEnv || inStore, fromEnv, inStore };
  });
}

// ── PUBLIC: WRITE integration keys (route gates admin + step-up before calling) ──────────────────
export interface IntegrationKeyPatch {
  /** Set a key to this plaintext (encrypted at rest). Ignored when the matching `clear` is true. */
  set?: Partial<Record<IntegrationKeyName, string>>;
  /** Remove these keys from the store entirely. */
  clear?: IntegrationKeyName[];
}

export async function saveIntegrationKeys(patch: IntegrationKeyPatch, actorEmail: string): Promise<{ ok: boolean; error?: string }> {
  if (DEMO_MODE) return demoDenied('Integration keys');
  const setOps: Record<string, EncBlob | number | string> = {};
  const unsetOps: Record<string, ''> = {};
  const clearSet = new Set(patch.clear ?? []);

  for (const name of INTEGRATION_KEY_NAMES) {
    if (clearSet.has(name)) {
      unsetOps[`secrets.${name}`] = '';
      continue;
    }
    const raw = patch.set?.[name];
    if (typeof raw === 'string' && raw.trim()) {
      setOps[`secrets.${name}`] = encSecret(raw.trim());
    }
  }

  if (Object.keys(setOps).length === 0 && Object.keys(unsetOps).length === 0) {
    return { ok: false, error: 'No key changes were supplied.' };
  }
  setOps.updatedBy = String(actorEmail || '').trim().toLowerCase();
  setOps.updatedAt = Date.now();

  try {
    const db = await getDb();
    const update: Record<string, unknown> = { $set: setOps };
    if (Object.keys(unsetOps).length) update.$unset = unsetOps;
    await db.collection<SettingsDoc>(AUTH_COLLECTION).updateOne({ _id: SETTINGS_ID }, update, { upsert: true });
    bustCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to persist the integration keys.' };
  }
}

// ── PUBLIC: BRANDING (non-secret) ────────────────────────────────────────────────────────────────
export async function getBranding(opts: { fresh?: boolean } = {}): Promise<BrandingSettings> {
  const doc = await getSettingsDoc(opts);
  const b = doc?.branding ?? {};
  const map: Record<string, string> = {};
  if (b.companyMap && typeof b.companyMap === 'object') {
    for (const [k, v] of Object.entries(b.companyMap)) {
      const dom = String(k || '').trim().toLowerCase().replace(/^@/, '');
      const name = String(v || '').trim();
      if (dom && name) map[dom] = name;
    }
  }
  return { companyDefault: String(b.companyDefault || '').trim(), companyMap: map };
}

/** Resolve the company label for a signed-in email (domain map → default). Empty ⇒ no label. */
export async function companyForEmail(email: string | null | undefined): Promise<string> {
  const b = await getBranding();
  const dom = String(email || '').toLowerCase().split('@')[1] || '';
  if (dom && b.companyMap[dom]) return b.companyMap[dom];
  return b.companyDefault;
}

export async function saveBranding(input: BrandingSettings, actorEmail: string): Promise<{ ok: boolean; error?: string }> {
  if (DEMO_MODE) return demoDenied('Branding');
  const companyDefault = String(input.companyDefault || '').trim().slice(0, 120);
  const companyMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.companyMap || {})) {
    const dom = String(k || '').trim().toLowerCase().replace(/^@/, '').slice(0, 120);
    const name = String(v || '').trim().slice(0, 120);
    if (dom && name) companyMap[dom] = name;
  }
  try {
    const db = await getDb();
    await db.collection<SettingsDoc>(AUTH_COLLECTION).updateOne(
      { _id: SETTINGS_ID },
      { $set: { branding: { companyDefault, companyMap }, updatedBy: String(actorEmail || '').trim().toLowerCase(), updatedAt: Date.now() } },
      { upsert: true }
    );
    bustCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to save branding.' };
  }
}

// ── PUBLIC: OUTBOUND WEBHOOKS (non-secret URLs) ──────────────────────────────────────────────────
// HTTPS + not pointed at a private/loopback/link-local host — a small SSRF guard so a configured
// webhook can't be aimed at the cloud metadata endpoint, Mongo's port, or other internal services.
// Exported so the dispatcher re-checks at fire time (a directly-injected DB value can't bypass save).
export const isSafeWebhookUrl = (u: string): boolean => {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return false;
  // IPv4 private / loopback / link-local ranges.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
      return false;
    }
  }
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10).
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
    return false;
  }
  return true;
};

export async function getOutboundWebhookConfig(opts: { fresh?: boolean } = {}): Promise<OutboundWebhookConfig> {
  const doc = await getSettingsDoc(opts);
  const o: Partial<OutboundWebhookConfig> = doc?.outboundWebhooks ?? {};
  const enabled = Array.isArray(o.enabledEvents)
    ? o.enabledEvents.filter((e): e is string => typeof e === 'string' && (OUTBOUND_EVENT_TYPES as readonly string[]).includes(e))
    : [];
  return {
    webhookUrl: String(o.webhookUrl || '').trim(),
    slackWebhookUrl: String(o.slackWebhookUrl || '').trim(),
    enabledEvents: enabled,
  };
}

export async function saveOutboundWebhookConfig(
  input: OutboundWebhookConfig,
  actorEmail: string
): Promise<{ ok: boolean; error?: string }> {
  if (DEMO_MODE) return demoDenied('Outbound notifications');
  const webhookUrl = String(input.webhookUrl || '').trim().slice(0, 500);
  const slackWebhookUrl = String(input.slackWebhookUrl || '').trim().slice(0, 500);
  if (webhookUrl && !isSafeWebhookUrl(webhookUrl)) return { ok: false, error: 'Webhook URL must be https and not a private/internal host.' };
  if (slackWebhookUrl && !isSafeWebhookUrl(slackWebhookUrl)) return { ok: false, error: 'Slack webhook URL must be https and not a private/internal host.' };
  const enabledEvents = Array.isArray(input.enabledEvents)
    ? [...new Set(input.enabledEvents.filter((e) => (OUTBOUND_EVENT_TYPES as readonly string[]).includes(e)))]
    : [];
  try {
    const db = await getDb();
    await db.collection<SettingsDoc>(AUTH_COLLECTION).updateOne(
      { _id: SETTINGS_ID },
      {
        $set: {
          outboundWebhooks: { webhookUrl, slackWebhookUrl, enabledEvents },
          updatedBy: String(actorEmail || '').trim().toLowerCase(),
          updatedAt: Date.now(),
        },
      },
      { upsert: true }
    );
    bustCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to save outbound webhooks.' };
  }
}

// ── PUBLIC: ACCESS POLICY (additive overlay) ─────────────────────────────────────────────────────
const splitEnvList = (raw: string | undefined): string[] =>
  String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** The deploy-time env allowlists (read-only — shown as locked chips; can't be removed via the UI). */
export function envAccessPolicy(): { adminEmails: string[]; allowedDomains: string[] } {
  return {
    adminEmails: Array.from(new Set(splitEnvList(process.env.EIT_ADMIN_EMAILS))),
    allowedDomains: Array.from(new Set(splitEnvList(process.env.EIT_OIDC_ALLOWED_DOMAINS).map((d) => d.replace(/^@/, '')))),
  };
}

/** The persisted (editable) policy overlay. */
export async function getPolicyOverlay(opts: { fresh?: boolean } = {}): Promise<AccessPolicySettings> {
  const doc = await getSettingsDoc(opts);
  const p = doc?.policy ?? {};
  const adminEmails = Array.isArray(p.adminEmails)
    ? Array.from(new Set(p.adminEmails.map((e) => String(e).trim().toLowerCase()).filter((e) => e && e.includes('@'))))
    : [];
  const allowedDomains = Array.isArray(p.allowedDomains)
    ? Array.from(new Set(p.allowedDomains.map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean)))
    : [];
  const groupRoleMap: Record<string, string> = {};
  if (p.groupRoleMap && typeof p.groupRoleMap === 'object') {
    for (const [g, r] of Object.entries(p.groupRoleMap)) {
      const grp = String(g || '').trim();
      const role = String(r || '').trim().toLowerCase();
      if (grp && role) groupRoleMap[grp] = role;
    }
  }
  return { adminEmails, allowedDomains, groupRoleMap };
}

/** True iff `email` is an additive (store-granted) admin. Consulted alongside the env allowlist. */
export async function isPolicyAdmin(email: string): Promise<boolean> {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  const p = await getPolicyOverlay();
  return p.adminEmails.includes(e);
}

export interface SavePolicyInput {
  adminEmails: string[];
  allowedDomains: string[];
  groupRoleMap: Record<string, string>;
  /** valid role ids (for groupRoleMap validation). */
  validRoles: string[];
}

export async function savePolicyOverlay(input: SavePolicyInput, actorEmail: string): Promise<{ ok: boolean; error?: string }> {
  if (DEMO_MODE) return demoDenied('Access policy');
  const validRoles = new Set(input.validRoles ?? []);
  const adminEmails = Array.from(
    new Set((input.adminEmails ?? []).map((e) => String(e).trim().toLowerCase()).filter((e) => e && e.includes('@')))
  );
  const allowedDomains = Array.from(
    new Set((input.allowedDomains ?? []).map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))
  );
  const groupRoleMap: Record<string, string> = {};
  for (const [g, r] of Object.entries(input.groupRoleMap ?? {})) {
    const grp = String(g || '').trim();
    const role = String(r || '').trim().toLowerCase();
    if (!grp) continue;
    if (!validRoles.has(role)) return { ok: false, error: `Invalid role '${role}' for group '${grp}'.` };
    groupRoleMap[grp] = role;
  }
  try {
    const db = await getDb();
    await db.collection<SettingsDoc>(AUTH_COLLECTION).updateOne(
      { _id: SETTINGS_ID },
      { $set: { policy: { adminEmails, allowedDomains, groupRoleMap }, updatedBy: String(actorEmail || '').trim().toLowerCase(), updatedAt: Date.now() } },
      { upsert: true }
    );
    bustCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to save the access policy.' };
  }
}

// ── PUBLIC: sign-in providers (generic OIDC + GitHub) ─────────────────────────────────────────────
function cleanProvider(p: ProviderConfig): ProviderConfig | null {
  const id = String(p?.id || '').trim().toLowerCase();
  if (!PROVIDER_ID_RE.test(id)) return null;
  const type = p?.type === 'github' ? 'github' : 'oidc';
  return {
    id,
    type,
    label: String(p?.label || '').trim().slice(0, 60) || (type === 'github' ? 'GitHub' : id),
    enabled: !!p?.enabled,
    clientId: String(p?.clientId || '').trim().slice(0, 200),
    discoveryUrl: type === 'oidc' ? String(p?.discoveryUrl || '').trim().slice(0, 400) : undefined,
    scopes: p?.scopes ? String(p.scopes).trim().slice(0, 200) : undefined,
    order: typeof p?.order === 'number' && Number.isFinite(p.order) ? p.order : undefined,
  };
}

/** All configured extra providers (NEVER includes secrets). 30s cache via getSettingsDoc. */
export async function getProviderConfigs(opts: { fresh?: boolean } = {}): Promise<ProviderConfig[]> {
  const doc = await getSettingsDoc(opts);
  const list = Array.isArray(doc?.oauthProviders) ? doc!.oauthProviders! : [];
  return list.map(cleanProvider).filter((p): p is ProviderConfig => !!p);
}

/** Enabled providers (for the login page), sorted by `order` then label. */
export async function getEnabledProviders(): Promise<ProviderConfig[]> {
  const all = await getProviderConfigs();
  return all
    .filter((p) => p.enabled && p.clientId && (p.type === 'github' || p.discoveryUrl))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
}

/** Decrypt a provider's client secret for SERVER-SIDE use (the callback). '' when absent/unset. */
export async function getProviderSecret(id: string): Promise<string> {
  const key = String(id || '').trim().toLowerCase();
  if (!PROVIDER_ID_RE.test(key)) return '';
  const doc = await getSettingsDoc();
  return decSecret(doc?.oauthSecrets?.[key]) || '';
}

/** True iff a provider currently has an encrypted secret stored (for the admin UI set/unset badge). */
export async function providerSecretStatus(): Promise<Record<string, boolean>> {
  const doc = await getSettingsDoc({ fresh: true });
  const out: Record<string, boolean> = {};
  for (const p of await getProviderConfigs({ fresh: true })) {
    out[p.id] = decSecret(doc?.oauthSecrets?.[p.id]) != null;
  }
  return out;
}

/**
 * Admin write: replace the provider list + set any newly-entered secrets (a blank/absent secret keeps
 * the existing encrypted blob — so the admin never has to re-enter it). Validates every id. Secrets are
 * encrypted at rest and NEVER returned. The route gates admin before calling.
 */
export async function saveProviderConfigs(
  providers: ProviderConfig[],
  secrets: Record<string, string>,
  actorEmail: string
): Promise<{ ok: boolean; error?: string }> {
  if (DEMO_MODE) return demoDenied('Sign-in providers');
  const cleaned: ProviderConfig[] = [];
  const seen = new Set<string>();
  for (const raw of providers ?? []) {
    const p = cleanProvider(raw);
    if (!p) return { ok: false, error: `Invalid provider id '${raw?.id}' (use a-z, 0-9, -, _).` };
    if (seen.has(p.id)) return { ok: false, error: `Duplicate provider id '${p.id}'.` };
    if (p.type === 'oidc' && !p.discoveryUrl) return { ok: false, error: `Provider '${p.id}' needs a discovery URL.` };
    seen.add(p.id);
    cleaned.push(p);
  }
  const setOps: Record<string, unknown> = {
    oauthProviders: cleaned,
    updatedBy: String(actorEmail || '').trim().toLowerCase(),
    updatedAt: Date.now(),
  };
  // Encrypt only the secrets that were actually entered, and only for a provider in the saved list.
  for (const [id, plaintext] of Object.entries(secrets ?? {})) {
    const key = String(id || '').trim().toLowerCase();
    if (!seen.has(key)) continue;
    const pt = String(plaintext ?? '').trim();
    if (pt) setOps[`oauthSecrets.${key}`] = encSecret(pt);
  }
  // Drop stored secrets for any provider no longer in the list.
  const unsetOps: Record<string, ''> = {};
  try {
    const doc = await getSettingsDoc({ fresh: true });
    for (const id of Object.keys(doc?.oauthSecrets ?? {})) {
      if (!seen.has(id)) unsetOps[`oauthSecrets.${id}`] = '';
    }
  } catch {
    /* best-effort cleanup */
  }
  try {
    const db = await getDb();
    const update: Record<string, unknown> = { $set: setOps };
    if (Object.keys(unsetOps).length) update.$unset = unsetOps;
    await db.collection<SettingsDoc>(AUTH_COLLECTION).updateOne({ _id: SETTINGS_ID }, update, { upsert: true });
    bustCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to save sign-in providers.' };
  }
}

// ── PUBLIC: DEPLOYMENT TENANT override ───────────────────────────────────────────────────────────
/** The tenant id override (store), or '' when unset. */
export async function getTenantOverride(opts: { fresh?: boolean } = {}): Promise<string> {
  const doc = await getSettingsDoc(opts);
  return String(doc?.tenantId || '').trim().toLowerCase();
}

// The email domain of the FIRST (earliest-created) directory user — the deployment's owning org. This
// is the auto-generated tenant id (#210): Data-Matrix codes get namespaced per deployment with no
// manual config. Cached (the earliest user is effectively immutable; soft-deletes stay in the DB so
// the value is stable). '' when there are no users yet → falls through to the env.
const FIRST_DOMAIN_TTL_MS = 5 * 60 * 1000;
let _firstDomainAt = 0;
let _firstDomain: string | null = null;
async function firstUserTenantDomain(fresh = false): Promise<string> {
  const now = Date.now();
  if (!fresh && _firstDomain !== null && now - _firstDomainAt < FIRST_DOMAIN_TTL_MS) return _firstDomain;
  try {
    const db = await getDb();
    const first = await db
      .collection<{ _id: string; createdAt?: number }>('users')
      .find({})
      .sort({ createdAt: 1 })
      .limit(1)
      .next();
    const email = String(first?._id || '').toLowerCase();
    const at = email.lastIndexOf('@');
    _firstDomain = at >= 0 ? email.slice(at + 1).trim() : '';
    _firstDomainAt = now;
    return _firstDomain;
  } catch {
    return _firstDomain || '';
  }
}

/**
 * Resolve the ACTIVE deployment tenant ID (the raw string, before hashing). Precedence:
 *   1. the store OVERRIDE (an explicit admin choice) — always wins;
 *   2. the FIRST user's email domain (#210) — the auto-generated default, so the tenant is derived
 *      from who owns the deployment rather than hand-configured;
 *   3. the env (EIT_TENANT_ID || MONGO_DB) — last-ditch fallback (e.g. before any user exists).
 * Empty ⇒ Print Matrix off. Both the code encoders and the scan decoder resolve the tenant through
 * here (via activeTenantHash36), so they always agree.
 */
export async function activeTenantId(opts: { fresh?: boolean } = {}): Promise<string> {
  const override = await getTenantOverride(opts);
  if (override) return override;
  const firstDomain = await firstUserTenantDomain(opts.fresh);
  if (firstDomain) return firstDomain;
  return String(process.env.EIT_TENANT_ID || process.env.MONGO_DB || '').trim().toLowerCase();
}

/**
 * The base36 DJB2 hash of the ACTIVE tenant (override || env), the prefix every `eitm:` Data-Matrix
 * payload embeds. The server-only, override-aware replacement for lib/eitm's env-only
 * deployTenantHash36() — call this from Server Components so an admin's tenant override actually feeds
 * the printed/scanned codes. Empty string when no tenant is configured (code not encoded).
 */
export async function activeTenantHash36(opts: { fresh?: boolean } = {}): Promise<string> {
  return tenantHash36(await activeTenantId(opts));
}

export async function saveTenantOverride(tenantId: string, actorEmail: string): Promise<{ ok: boolean; error?: string }> {
  if (DEMO_MODE) return demoDenied('Deployment tenant');
  const t = String(tenantId || '').trim().toLowerCase().slice(0, 120);
  try {
    const db = await getDb();
    const upd: Record<string, unknown> = t
      ? { $set: { tenantId: t, updatedBy: String(actorEmail || '').trim().toLowerCase(), updatedAt: Date.now() } }
      : { $unset: { tenantId: '' }, $set: { updatedBy: String(actorEmail || '').trim().toLowerCase(), updatedAt: Date.now() } };
    await db.collection<SettingsDoc>(AUTH_COLLECTION).updateOne({ _id: SETTINGS_ID }, upd, { upsert: true });
    bustCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to save the tenant id.' };
  }
}

export async function settingsMeta(): Promise<{ updatedBy?: string; updatedAt?: number }> {
  const doc = await getSettingsDoc({ fresh: true });
  return { updatedBy: doc?.updatedBy, updatedAt: doc?.updatedAt };
}
