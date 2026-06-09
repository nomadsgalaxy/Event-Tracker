import 'server-only';
import crypto from 'node:crypto';

// lib/auth/oidc-providers.ts — the PROTOCOL layer for admin-configured sign-in providers (generic
// OpenID Connect + GitHub). The CONFIG/secret storage lives in settings-store.ts; the account binding
// (signInWithOidc) lives in oidc.ts. This file only speaks the wire protocols.
//
// SECURITY RULES — read before editing:
//   • Discovery docs are fetched HTTPS-ONLY (http:// throws before any network call).
//   • JWKS caches are PER-URI (a Map), never one shared global cache — so one provider's kid can't
//     shadow another's. Issuer is pinned to the discovery doc's `issuer`, not a constant.
//   • alg is pinned to RS256; none / HS* are rejected at the header-decode step (no alg confusion).
//   • aud must contain our clientId (array-safe); azp must equal it on a multi-aud token; exp+skew; nonce.
//   • GitHub OAuth2 has NO id_token, NO PKCE, NO nonce — CSRF is the signed-state flow cookie alone
//     (enforced in the callback route). We require a VERIFIED PRIMARY email from /user/emails.
//   • Client secrets never appear here as literals — the route passes them in from the encrypted store.

const EXP_SKEW_SEC = 60;
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API = 'https://api.github.com';

// Profiles every provider normalizes to. Structurally assignable to oidc.ts's SsoProfile.
export interface OidcProfile {
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  sub?: string;
  iss?: string;
}
export interface GithubProfile {
  email: string;
  emailVerified: true;
  name?: string;
  picture?: string;
  sub?: string;
  iss: 'https://github.com';
}

// ── OIDC discovery (.well-known/openid-configuration), per-URL cache ──────────────────────────────
export interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
const _discoveryCache = new Map<string, { doc: DiscoveryDoc; exp: number }>();

export async function fetchDiscovery(url: string): Promise<DiscoveryDoc> {
  const u = String(url || '').trim();
  if (new URL(u).protocol !== 'https:') throw new Error('discovery URL must be https');
  const cached = _discoveryCache.get(u);
  if (cached && cached.exp > Date.now()) return cached.doc;
  const res = await fetch(u, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`discovery fetch failed (${res.status})`);
  const j = (await res.json()) as Partial<DiscoveryDoc>;
  if (
    typeof j.issuer !== 'string' ||
    typeof j.authorization_endpoint !== 'string' ||
    typeof j.token_endpoint !== 'string' ||
    typeof j.jwks_uri !== 'string'
  ) {
    throw new Error('discovery doc missing required fields');
  }
  // SSRF / downgrade guard: every endpoint we later FETCH (token, jwks) or redirect to (authorization)
  // must be HTTPS — a compromised or malicious discovery server otherwise points us at http:// or an
  // internal host (127.0.0.1 / 169.254.169.254 metadata), and a forged JWKS would forge tokens.
  const httpsOnly = (label: string, url: string) => {
    if (new URL(url).protocol !== 'https:') throw new Error(`discovery ${label} must be https`);
  };
  httpsOnly('authorization_endpoint', j.authorization_endpoint);
  httpsOnly('token_endpoint', j.token_endpoint);
  httpsOnly('jwks_uri', j.jwks_uri);
  const doc: DiscoveryDoc = {
    issuer: j.issuer,
    authorization_endpoint: j.authorization_endpoint,
    token_endpoint: j.token_endpoint,
    jwks_uri: j.jwks_uri,
  };
  _discoveryCache.set(u, { doc, exp: Date.now() + 4 * 3600_000 }); // 4h TTL
  return doc;
}

// ── Per-provider JWKS (keyed by jwks_uri — NOT a single global cache) ─────────────────────────────
interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
}
const _jwksCache = new Map<string, { keys: Jwk[]; exp: number }>();

async function fetchJwksForProvider(jwksUri: string): Promise<Jwk[]> {
  const cached = _jwksCache.get(jwksUri);
  if (cached && cached.exp > Date.now()) return cached.keys;
  const res = await fetch(jwksUri, { cache: 'no-store' });
  if (!res.ok) throw new Error('jwks fetch failed');
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys || [];
  _jwksCache.set(jwksUri, { keys, exp: Date.now() + 3600_000 }); // 1h TTL
  return keys;
}

function b64urlBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
const norm = (e: unknown): string => String(e ?? '').trim().toLowerCase();

/** Verify an id_token from a configured OIDC provider: RS256 (alg pinned) against the provider's JWKS,
 *  issuer, aud (+azp on multi-aud), exp+skew, nonce. Throws fail-closed on any failure. */
async function verifyOidcToken(
  jwt: string,
  jwksUri: string,
  expectedIss: string,
  expectedAud: string,
  expectedNonce: string
): Promise<OidcProfile> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('id_token: malformed');
  const header = JSON.parse(b64urlBuf(parts[0]).toString('utf-8')) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error('id_token: unexpected alg');
  const jwk = (await fetchJwksForProvider(jwksUri)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('id_token: unknown signing key');
  const pub = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), pub, b64urlBuf(parts[2]));
  if (!ok) throw new Error('id_token: bad signature');
  const c = JSON.parse(b64urlBuf(parts[1]).toString('utf-8')) as Record<string, unknown>;
  if (String(c.iss) !== expectedIss) throw new Error('id_token: bad issuer');
  const auds = Array.isArray(c.aud) ? c.aud.map(String) : [String(c.aud)];
  if (!auds.includes(expectedAud)) throw new Error('id_token: bad audience');
  if (auds.length > 1 && String(c.azp) !== expectedAud) throw new Error('id_token: bad azp');
  if (Number(c.exp ?? 0) < Math.floor(Date.now() / 1000) - EXP_SKEW_SEC) throw new Error('id_token: expired');
  if (String(c.nonce) !== expectedNonce) throw new Error('id_token: nonce mismatch');
  return {
    email: norm(c.email),
    emailVerified: c.email_verified === true || c.email_verified === 'true',
    name: typeof c.name === 'string' ? c.name : undefined,
    picture: typeof c.picture === 'string' ? c.picture : undefined,
    sub: c.sub != null ? String(c.sub) : undefined,
    iss: typeof c.iss === 'string' ? c.iss : undefined,
  };
}

export function buildOidcAuthUrl(
  discovery: DiscoveryDoc,
  clientId: string,
  redirectUri: string,
  state: string,
  nonce: string,
  codeChallenge: string,
  scopes: string
): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes || 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${discovery.authorization_endpoint}?${p.toString()}`;
}

export async function exchangeOidcCode(
  code: string,
  redirectUri: string,
  discovery: DiscoveryDoc,
  clientId: string,
  clientSecret: string,
  nonce: string,
  verifier: string
): Promise<OidcProfile> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('OIDC token exchange failed');
  const tok = (await res.json()) as { id_token?: string };
  if (!tok.id_token) throw new Error('no id_token in token response');
  return verifyOidcToken(tok.id_token, discovery.jwks_uri, discovery.issuer, clientId, nonce);
}

// ── GitHub (plain OAuth2 — no id_token, no PKCE/nonce) ────────────────────────────────────────────
export function buildGithubAuthUrl(clientId: string, redirectUri: string, state: string, scopes: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: scopes || 'read:user user:email',
    allow_signup: 'false',
  });
  return `${GITHUB_AUTH_URL}?${p.toString()}`;
}

export async function exchangeGithubCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<GithubProfile> {
  const tokRes = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    cache: 'no-store',
  });
  if (!tokRes.ok) throw new Error('GitHub token exchange failed');
  const tok = (await tokRes.json()) as { access_token?: string };
  const accessToken = String(tok.access_token || '');
  if (!accessToken) throw new Error('no GitHub access_token');

  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'EventTracker' };
  const [userRes, emailRes] = await Promise.all([
    fetch(`${GITHUB_API}/user`, { headers, cache: 'no-store' }),
    fetch(`${GITHUB_API}/user/emails`, { headers, cache: 'no-store' }),
  ]);
  if (!userRes.ok || !emailRes.ok) throw new Error('GitHub user fetch failed');
  const user = (await userRes.json()) as { id?: number; name?: string; login?: string; avatar_url?: string };
  const emails = (await emailRes.json()) as { email?: string; primary?: boolean; verified?: boolean }[];
  const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : undefined;
  const email = norm(primary?.email);
  if (!email) throw new Error('no verified primary email on GitHub account');
  return {
    email,
    emailVerified: true,
    name: typeof user.name === 'string' ? user.name : typeof user.login === 'string' ? user.login : undefined,
    picture: typeof user.avatar_url === 'string' ? user.avatar_url : undefined,
    sub: user.id != null ? String(user.id) : undefined,
    iss: 'https://github.com',
  };
}
