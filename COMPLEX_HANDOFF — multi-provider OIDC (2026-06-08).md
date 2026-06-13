# COMPLEX_HANDOFF — multi-provider OIDC (2026-06-08)

## Goal

Add admin-configurable multi-provider OAuth/OIDC sign-in to the Next.js Event Tracker. Any admin can
register an OpenID Connect provider (Entra/Okta/Auth0/Keycloak) via a discovery URL + client
credentials, or enable the built-in GitHub provider (plain OAuth2). Google stays the existing
default and must not regress — its routes, One Tap, and all existing bindings keep working.
The feature generalizes `lib/auth/oidc.ts` into a shared engine, adds dynamic
`/api/auth/oidc/[provider]/start` and `/callback` routes, stores provider configs encrypted in
`settings-store`, adds a "Sign-in providers" admin card, and renders per-provider login buttons.

---

## Schemas

### ProviderConfig (stored in `__settings__` doc, field `oauthProviders: ProviderConfig[]`)

```ts
interface ProviderConfig {
  id: string;            // url-safe slug, e.g. "microsoft", "github", "okta-prod"
  type: 'oidc' | 'github';
  label: string;         // display: "Continue with Microsoft"
  enabled: boolean;
  clientId: string;      // plaintext (non-secret; same as GOOGLE_CLIENT_ID treatment)
  // clientSecret is NEVER stored here — it lives encrypted in secrets.oauthProvider_<id>
  // (an EncBlob, same shape as the integration-key secrets already in the doc)
  discoveryUrl?: string; // required for type==='oidc'; e.g. https://login.microsoftonline.com/{tenant}/v2.0
  // GitHub: no discoveryUrl; uses fixed endpoints (see lib/auth/oidc-providers.ts)
  scopes?: string;       // space-separated; defaults: oidc='openid email profile', github='read:user user:email'
  order?: number;        // display order on the login page; lower = first
}
```

`SettingsDoc` (in `settings-store.ts`) gains two new fields:
```ts
oauthProviders?: ProviderConfig[];        // array of non-Google configs
secrets?: { ..., oauthProvider_<id>: EncBlob };  // one slot per provider id
```

The `<id>` in the secret key is validated against `/^[a-z0-9_-]{1,40}$/` before read/write.

Migration: no migration needed. On first read `oauthProviders` is absent → treated as `[]`.
Existing Google env vars (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) are UNCHANGED and are never
stored in `oauthProviders` — Google is a built-in handled by the existing flow.

### OAuthFlow (existing, extended)

Add field `providerId: string` to the existing `OAuthFlow` interface in `lib/auth/oidc.ts`:

```ts
export interface OAuthFlow {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  providerId: string;   // NEW: 'google' | any ProviderConfig.id
}
```

The `verifyFlow` parser (oidc.ts:97-103) must accept the new field (already tolerates unknown
fields; just add `typeof obj.providerId === 'string'` to the validity check and default to
`'google'` when absent, for backward compat with any in-flight cookies).

### OidcDiscoveryCache (new, in lib/auth/oidc-providers.ts)

```ts
interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  // optional extras ignored
}
interface DiscoveryCacheEntry {
  doc: DiscoveryDoc;
  exp: number;   // Date.now() + 4h
}
```

Per-discovery-URL cache (`Map<string, DiscoveryCacheEntry>`) — one entry per provider, not one
global. The Google JWKS cache in the existing `googleJwks()` (oidc.ts:143-150) is the model.

---

## Helpers

All new helpers live in **`lib/auth/oidc-providers.ts`** (new file, `'use server-only'`).

| Signature | Description |
|---|---|
| `getProviderConfigs(): Promise<ProviderConfig[]>` | Read `oauthProviders` from settings doc (30s cache). Returns `[]` when absent. |
| `getEnabledProviders(): Promise<ProviderConfig[]>` | Filters to `enabled === true`, sorted by `order`. Used by the login page. |
| `saveProviderConfigs(providers: ProviderConfig[], secret: Record<string,string>, actor: string): Promise<{ok,error?}>` | Admin write: validates ids, encrypts per-provider secrets via the existing `encSecret` helper (re-exported or inlined from settings-store), writes `oauthProviders` array + `secrets.oauthProvider_<id>` blobs. Calls `bustCache()`. |
| `getProviderSecret(id: string): Promise<string>` | Decrypt `secrets.oauthProvider_<id>` via `decSecret`. Returns `''` when absent. |
| `fetchDiscovery(url: string): Promise<DiscoveryDoc>` | GET `url` over HTTPS (rejects http://). Validates `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri` are present strings. Caches 4h per URL. Throws on fetch failure or missing fields. |
| `fetchJwksForProvider(jwksUri: string): Promise<Jwk[]>` | Per-provider JWKS fetch with a 1h TTL, keyed by URI (NOT a single global cache). |
| `verifyOidcToken(jwt: string, jwksUri: string, expectedIss: string, expectedAud: string, expectedNonce: string): Promise<OidcProfile>` | RS256 signature (alg pinned) against the provider's JWKS, issuer == expectedIss, aud membership + azp if multi-aud, exp+skew, nonce. Returns `OidcProfile`. Throws fail-closed on any check failure. |
| `exchangeOidcCode(code: string, redirectUri: string, discovery: DiscoveryDoc, clientId: string, clientSecret: string, nonce: string, verifier: string): Promise<OidcProfile>` | POST to `discovery.token_endpoint` (form-encoded, PKCE), call `verifyOidcToken`. |
| `exchangeGithubCode(code: string, redirectUri: string, clientId: string, clientSecret: string): Promise<GithubProfile>` | POST to GitHub token endpoint (form-encoded, `Accept: application/json`), then GET `/user` + `/user/emails` with the bearer token. Extracts the verified primary email. Throws if no verified email found. |
| `buildOidcAuthUrl(discovery: DiscoveryDoc, clientId: string, redirectUri: string, state: string, nonce: string, codeChallenge: string, scopes: string): string` | Builds the IdP authorization URL from the discovery endpoints. |
| `buildGithubAuthUrl(clientId: string, redirectUri: string, state: string, scopes: string): string` | GitHub authorize URL (`https://github.com/login/oauth/authorize`). Note: GitHub does NOT support PKCE or nonce. |
| `signInWithOidc(profile: OidcProfile \| GithubProfile, providerId: string): Promise<OidcSignInResult>` | Generalized version of the existing `signInWithGoogle`. Email-binding + domain allowlist + soft-delete refusal + `$setOnInsert` credential-less auth record + oauthIdentities binding. NEVER writes role. |

**Interfaces:**

```ts
export interface OidcProfile {
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  sub?: string;
  iss?: string;
}

export interface GithubProfile {
  email: string;           // verified primary email from /user/emails
  emailVerified: true;     // always true (we only accept verified)
  name?: string;
  picture?: string;        // avatar_url
  sub?: string;            // string(user.id) from /user
  iss: 'https://github.com';
}
```

**Existing helpers to keep in `lib/auth/oidc.ts` unchanged:**
- `publicOrigin`, `signFlow`, `verifyFlow`, `newFlow`, `OAUTH_FLOW_COOKIE`
- `OAuthFlow` (extended with `providerId`)
- `googleConfigured`, `googleClientId`, `buildGoogleAuthUrl`, `exchangeGoogleCode`, `verifyGoogleCredential`, `signInWithGoogle`
- The Google JWKS cache (`googleJwks`, `verifyIdToken`) — stays Google-only; the generic flow uses `fetchJwksForProvider`

---

## Execution order

### Step 1 — Extend `OAuthFlow` + `verifyFlow` in `lib/auth/oidc.ts` (15 min)

File: `C:\Users\Anthony\et-main-wt\lib\auth\oidc.ts`

1. Add `providerId: string` to the `OAuthFlow` interface (line 60-65). Default `''` is fine; the
   routes always set it.
2. In `newFlow` (line 107-114): add `providerId: string` parameter and include it in the returned
   `flow` object.
3. In `verifyFlow` (line 97-103): add `typeof obj.providerId === 'string'` to the validity check.
   Add `providerId: typeof obj.providerId === 'string' ? obj.providerId : 'google'` to the return
   object (backward-compat default).
4. Update `buildGoogleAuthUrl`'s call-sites (only
   `app/api/auth/google/start/route.ts`) to pass `providerId: 'google'` to `newFlow`.

Verify: `cd C:\Users\Anthony\et-main-wt && node_modules\.bin\tsc --noEmit` — 0 errors.

---

### Step 2 — Create `lib/auth/oidc-providers.ts` (45 min)

Create: `C:\Users\Anthony\et-main-wt\lib\auth\oidc-providers.ts`

This is the largest new file. Full shape:

```
'use server-only';
import 'server-only';
import crypto from 'node:crypto';
import { getDb } from '@/lib/db/mongo';
import { AUTH_COLLECTION } from '@/lib/auth/auth';
import { getPolicyOverlay } from '@/lib/auth/settings-store';
import { resolveLiveRole } from '@/lib/auth/auth';
import { SETTINGS_ID } from '@/lib/auth/settings-store';
import type { OidcSignInResult } from '@/lib/auth/oidc';
```

**Section A: ProviderConfig type + CRUD** (mirrors the `IntegrationKeyName` / `encSecret` /
`decSecret` pattern from `settings-store.ts:64-131`)

- Define `ProviderConfig` interface.
- `PROVIDER_ID_RE = /^[a-z0-9_-]{1,40}$/` for validation.
- `encSecret` / `decSecret` — copy the AES-256-GCM helpers verbatim from `settings-store.ts:97-131`
  (same `encKey()` derivation from `ET_SESSION_SECRET` via HKDF). Do NOT re-export from
  settings-store; duplicate the 35-line block here so settings-store has no new public exports.
- `SettingsDocProviders` interface — partial view of `__settings__` with `oauthProviders` and
  `secrets` fields.
- Cache: `let _providerCache: { at: number; list: ProviderConfig[] } | null = null; const TTL = 30_000;`
- `getProviderConfigs()` — reads from Mongo, populates cache. Never returns clientSecret.
- `getEnabledProviders()` — filters + sorts.
- `getProviderSecret(id)` — reads and decrypts `secrets['oauthProvider_' + id]`.
- `saveProviderConfigs(providers, secrets, actor)` — admin write. Validates each id against
  `PROVIDER_ID_RE`. Encrypts each provided secret. Writes `$set: { oauthProviders: ..., secrets.oauthProvider_<id>: blob, updatedBy, updatedAt }`. Busts cache.
- `deleteProvider(id, actor)` — sets `enabled: false` AND `$unset: { secrets.oauthProvider_<id>: '' }`.

**Section B: OIDC discovery + JWKS**

- Per-provider JWKS map: `const _jwksCache = new Map<string, { keys: Jwk[]; exp: number }>()`.
- `fetchJwksForProvider(uri: string): Promise<Jwk[]>` — same pattern as `googleJwks()` in
  `oidc.ts:143-150` but keyed by `uri`.
- `fetchDiscovery(url: string): Promise<DiscoveryDoc>` — validate HTTPS scheme (`new
  URL(url).protocol === 'https:'`), fetch with `cache: 'no-store'`, validate required fields,
  cache 4h. Throws on any failure.

**Section C: Token verification**

`verifyOidcToken(jwt, jwksUri, expectedIss, expectedAud, expectedNonce)`:
- Decode header, pin `alg === 'RS256'` (throw on none/HS).
- `fetchJwksForProvider(jwksUri)` to get keys; match `kid`.
- `crypto.verify('RSA-SHA256', ...)` — same as `oidc.ts:165-168`.
- Check `iss === expectedIss`, `aud` membership (array-safe), `azp` on multi-aud, `exp + 60s
  skew`, `nonce === expectedNonce`.
- Return `OidcProfile`.

`exchangeOidcCode(code, redirectUri, discovery, clientId, clientSecret, nonce, verifier)`:
- POST to `discovery.token_endpoint` form-encoded (same shape as `exchangeGoogleCode` in
  `oidc.ts:188-224`).
- Call `verifyOidcToken` with `discovery.jwks_uri`, `discovery.issuer`, `clientId`, `nonce`.

**Section D: GitHub flow**

```
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_BASE = 'https://api.github.com';
```

`buildGithubAuthUrl(clientId, redirectUri, state, scopes)`:
- URLSearchParams: `client_id`, `redirect_uri`, `state`, `scope`.
- NOTE: GitHub OAuth does NOT support PKCE or nonce. The CSRF protection is the signed flow
  cookie's `state` field alone. Document this clearly with a comment.

`exchangeGithubCode(code, redirectUri, clientId, clientSecret)`:
- POST to `GITHUB_TOKEN_URL` form-encoded, `Accept: application/json`.
- Extract `access_token` from response.
- GET `GITHUB_API_BASE/user` with `Authorization: Bearer <token>`, `User-Agent: EventTracker`.
- GET `GITHUB_API_BASE/user/emails` with same auth header.
- Find the primary+verified email: `emails.find(e => e.primary && e.verified)?.email`.
- Throw `'No verified primary email found on GitHub account'` if absent.
- Return `GithubProfile`.

**Section E: Shared sign-in binding**

`signInWithOidc(profile: OidcProfile | GithubProfile, providerId: string): Promise<OidcSignInResult>`:

This is a direct generalization of `signInWithGoogle` (oidc.ts:302-379). Copy the full function,
replacing:
- `'oidc:google'` with `` `oidc:${providerId}` `` (or `'github'` when `providerId === 'github'`).
- `profile.emailVerified` check — same; for GitHub this is always `true` (enforced in
  `exchangeGithubCode`).
- The `allowedDomain` helper is the one in `oidc.ts:255-275` — import and reuse it directly (or
  export it from `oidc.ts` so `oidc-providers.ts` can import it without duplicating the policy
  read).
- The `oauthIdentities` binding uses `providerId` as the `provider` field.

---

### Step 3 — Extend `settings-store.ts` with provider-secret helpers (10 min)

File: `C:\Users\Anthony\et-main-wt\lib\auth\settings-store.ts`

Export `encSecret` and `decSecret` (currently unexported private functions at lines 112-131) so
`oidc-providers.ts` can use them, OR (preferred, no public API change) keep them private and
duplicate the 35-line block in `oidc-providers.ts` as noted in Step 2 Section A. The duplication
approach is safer (no accidental surface change) — choose it.

Also add `oauthProviders?: ProviderConfig[]` to the `SettingsDoc` interface (line 85-94) so the
TypeScript type covers the new field. Import `ProviderConfig` from `./oidc-providers`.

Verify: `tsc --noEmit`.

---

### Step 4 — Dynamic route: `/api/auth/oidc/[provider]/start` and `/callback` (35 min)

Create two new route files. The existing Google routes at
`app/api/auth/google/start/route.ts` and `app/api/auth/google/callback/route.ts` are **kept
unchanged** — they continue to serve Google sign-in with zero modifications. The new dynamic
routes are additive.

**`app/api/auth/oidc/[provider]/start/route.ts`:**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { newFlow, signFlow, OAUTH_FLOW_COOKIE, publicOrigin } from '@/lib/auth/oidc';
import { getProviderConfigs, fetchDiscovery, buildGithubAuthUrl, buildOidcAuthUrl } from '@/lib/auth/oidc-providers';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const providers = await getProviderConfigs();
  const cfg = providers.find(p => p.id === provider && p.enabled);
  if (!cfg) return NextResponse.redirect(new URL('/login?sso=unconfigured', req.url));

  const safeNext = (n: string | null) => { /* same safeNext helper as existing routes */ };
  const url = new URL(req.url);
  const origin = publicOrigin(req);
  const redirectUri = `${origin}/api/auth/oidc/${provider}/callback`;
  const { flow, challenge } = newFlow(safeNext(url.searchParams.get('next')), provider);
  // 'provider' param is the new providerId field on the flow

  let authUrl: string;
  if (cfg.type === 'github') {
    authUrl = buildGithubAuthUrl(cfg.clientId, redirectUri, flow.state, cfg.scopes || 'read:user user:email');
  } else {
    const discovery = await fetchDiscovery(cfg.discoveryUrl!);
    authUrl = buildOidcAuthUrl(discovery, cfg.clientId, redirectUri, flow.state, flow.nonce, challenge, cfg.scopes || 'openid email profile');
  }

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(OAUTH_FLOW_COOKIE, signFlow(flow), { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 600 });
  return res;
}
```

**`app/api/auth/oidc/[provider]/callback/route.ts`:**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { verifyFlow, OAUTH_FLOW_COOKIE, publicOrigin } from '@/lib/auth/oidc';
import { getProviderConfigs, getProviderSecret, fetchDiscovery, exchangeOidcCode, exchangeGithubCode, signInWithOidc } from '@/lib/auth/oidc-providers';
import { issueSessionToken, COOKIE_NAME, SSO_COOKIE_OPTS } from '@/lib/auth/session';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const origin = publicOrigin(req);
  const fail = (reason: string) => {
    const r = NextResponse.redirect(new URL(`/login?sso=${encodeURIComponent(reason)}`, origin));
    r.cookies.delete(OAUTH_FLOW_COOKIE);
    return r;
  };

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerErr = url.searchParams.get('error');
  const flow = verifyFlow(req.cookies.get(OAUTH_FLOW_COOKIE)?.value);

  if (providerErr) return fail('cancelled');
  // Verify the flow cookie belongs to THIS provider (prevents cookie substitution across providers)
  if (!flow || flow.providerId !== provider) return fail('state');
  if (!code || !state || state !== flow.state) return fail('state');

  const providers = await getProviderConfigs();
  const cfg = providers.find(p => p.id === provider && p.enabled);
  if (!cfg) return fail('unconfigured');

  const secret = await getProviderSecret(provider);
  if (!secret) return fail('unconfigured');

  const redirectUri = `${origin}/api/auth/oidc/${provider}/callback`;

  let profile;
  try {
    if (cfg.type === 'github') {
      profile = await exchangeGithubCode(code, redirectUri, cfg.clientId, secret);
    } else {
      const discovery = await fetchDiscovery(cfg.discoveryUrl!);
      profile = await exchangeOidcCode(code, redirectUri, discovery, cfg.clientId, secret, flow.nonce, flow.verifier);
    }
  } catch {
    return fail('exchange');
  }

  const result = await signInWithOidc(profile, provider);
  if (!result.ok) return fail(result.reason);

  const src = cfg.type === 'github' ? 'github' : `oidc:${provider}`;
  const { token } = issueSessionToken(result.email, result.role, src);
  const res = NextResponse.redirect(new URL(safeNext(flow.next), origin));
  res.cookies.set(COOKIE_NAME, token, SSO_COOKIE_OPTS);
  res.cookies.delete(OAUTH_FLOW_COOKIE);
  return res;
}
```

Verify: `tsc --noEmit`.

---

### Step 5 — Middleware: add `/api/auth/oidc` to `PUBLIC_PATHS` (5 min)

File: `C:\Users\Anthony\et-main-wt\middleware.ts`

Grep anchor: `'/api/auth/google',`

Add the new entry immediately after it:
```ts
'/api/auth/oidc',
```

This covers both `/api/auth/oidc/[provider]/start` and `/api/auth/oidc/[provider]/callback` via
the `pathname.startsWith(p + '/')` check already in place (middleware.ts:204-206).

Verify: `tsc --noEmit`. Then check the middleware matcher comment is not broken.

---

### Step 6 — Admin API route: `/api/auth/oidc-providers/route.ts` (25 min)

Create: `C:\Users\Anthony\et-main-wt\app\api\auth\oidc-providers\route.ts`

```ts
import { requireRole } from '@/lib/auth/auth';
import { verifyStepupToken } from '@/lib/auth/session';
import { saveProviderConfigs, deleteProvider } from '@/lib/auth/oidc-providers';
import { readJson, jsonErr } from '@/lib/api/api-response';
import { getSession } from '@/lib/auth/session';
import { writeAudit } from '@/lib/auth/grants';  // use whichever audit writer already exists
import { NextResponse, type NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';
```

`POST /api/auth/oidc-providers` — save provider configs. Required body:
- `stepupToken: string` — re-verified server-side against caller's session sub.
- `providers: ProviderConfig[]` — the full array (overwrite).
- `secrets: Record<string, string>` — map of `id -> plaintext secret` (only newly-entered ones;
  absent keys keep their existing encrypted blob). Secrets must NEVER be returned in any response.

Guards:
1. `await requireRole('admin')` — throws/redirects if not admin.
2. `verifyStepupToken(body.stepupToken, session.sub)` — must be valid.
3. Validate each `provider.id` matches `PROVIDER_ID_RE`.
4. Call `saveProviderConfigs(providers, secrets, session.sub)`.
5. Return `{ ok: true }` — never echo secrets back.

`DELETE /api/auth/oidc-providers` — disable + scrub a provider. Body: `{ stepupToken, id }`.
Same guards. Call `deleteProvider(id, session.sub)`.

Use `writeAudit` (check what the existing routes like `app/api/auth/access-policy/route.ts` call
for auditing) with action `'oidc_provider_save'` / `'oidc_provider_delete'`.

This route is BEHIND the auth gate (not in `PUBLIC_PATHS`) — only a signed-in admin can reach it.

Verify: `tsc --noEmit`.

---

### Step 7 — Admin UI card: `app/config/admin/sign-in-providers-card.tsx` (40 min)

Create: `C:\Users\Anthony\et-main-wt\app\config\admin\sign-in-providers-card.tsx`

`'use client'` island. Pattern mirrors `IntegrationKeysCard` (integration-keys-card.tsx) and
`AccessPolicyCard` (access-policy-card.tsx).

Props:
```ts
interface SignInProvidersCardProps {
  initialProviders: ProviderConfig[];  // from server — NO secrets included
}
```

State: `providers` (array), `drafts` (map of id → plaintext secret, write-only), `busy`.

UI structure:
1. Card header: "Sign-in providers" with a `LogIn` icon.
2. Card description: "Admins can add any OpenID Connect provider (Entra, Okta, Auth0, Keycloak) or
   GitHub. Client secrets are stored encrypted and never shown."
3. Google row (always first, read-only): shows a green "Configured" badge if
   `GOOGLE_CLIENT_ID` env is set (pass a `googleConfigured: boolean` prop from the server), or
   an amber "Not configured" badge. Label "Google (built-in)". No edit fields — configure via env.
4. Per-provider rows from `providers` array:
   - Toggle `enabled` (a PillToggle or simple checkbox).
   - `label` text input.
   - `type` select: `oidc | github`.
   - `clientId` text input.
   - Secret input: `<Input type="password" placeholder="•••••• (blank keeps existing)" />`. Value
     stored only in `drafts` state, never pre-filled from the server.
   - `discoveryUrl` text input (shown only when `type === 'oidc'`).
   - `scopes` text input (optional; leave blank for defaults).
   - Remove button (sets `enabled: false` + marks for secret scrub via DELETE).
5. "Add provider" button — appends a blank `ProviderConfig` row with a generated id slug.
6. Save button + step-up gate (same `useStepUp()` pattern as `IntegrationKeysCard`).

Save path: `POST /api/auth/oidc-providers` with `{ stepupToken, providers, secrets: draftsMap }`.

The `id` for a new provider is auto-derived from `label.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0,40)`.
The engineer must add a UI check that warns if two providers share the same id.

Verify: card renders in `app/config/admin/page.tsx` (see Step 8), no TypeScript errors.

---

### Step 8 — Wire the card into `app/config/admin/page.tsx` (15 min)

File: `C:\Users\Anthony\et-main-wt\app\config\admin\page.tsx`

Grep anchor: `<AccessPolicyCard initial={{ env, policy: overlay, validRoles }} />`

Add below it:
```tsx
<SignInProvidersCard
  initialProviders={providers}
  googleConfigured={Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)}
/>
```

Add the data fetch to the `Promise.all` at the top:
```ts
import { getProviderConfigs } from '@/lib/auth/oidc-providers';
import { SignInProvidersCard } from './sign-in-providers-card';
// ...
const [branding, env, overlay, tenantOverride, activeTenant, db, providers] = await Promise.all([
  // ...existing...,
  getProviderConfigs(),
]);
```

Verify: `tsc --noEmit`. Visit `/config/admin` in dev — card renders.

---

### Step 9 — Login page: render provider buttons (20 min)

File: `C:\Users\Anthony\et-main-wt\app\login\page.tsx`

Grep anchor: `const gClientId = googleClientId();`

Add below it:
```ts
import { getEnabledProviders } from '@/lib/auth/oidc-providers';
// ...
const enabledProviders = await getEnabledProviders();
```

Pass `enabledProviders` to `LoginForm`:
```tsx
<LoginForm next={dest !== '/' ? dest : undefined} enabledProviders={enabledProviders} />
```

File: `C:\Users\Anthony\et-main-wt\app\login\login-form.tsx`

Grep anchor: `export default function LoginForm({ next }: { next?: string })`

Add `enabledProviders?: ProviderConfig[]` to props.

Grep anchor: `<a href={`/api/auth/google/start${next ? ...`}>`

Add below the Google button, within the same `<div className="grid gap-4">` wrapper:
```tsx
{(enabledProviders ?? []).map(p => (
  <Button key={p.id} asChild variant="outline" className="w-full">
    <a href={`/api/auth/oidc/${p.id}/start${next ? `?next=${encodeURIComponent(next)}` : ''}`}>
      {p.label}
    </a>
  </Button>
))}
```

File: `app/login/login-form.tsx` — also update the `sso` error map in the `useEffect` (grep
anchor: `const MSG: Record<string, string> = {`). Add entries for new error reasons:
```ts
unconfigured: 'That sign-in provider isn\'t configured.',
exchange: 'Could not complete sign-in. Please try again.',
```

(The existing `offboarded` / `not_allowed` / `unverified` / `state` / `cancelled` entries already
cover all states that `signInWithOidc` returns — no changes needed there.)

Verify: `tsc --noEmit`. With no providers configured, the login page is visually identical to
today. Adding a test provider (Step 11) adds its button.

---

### Step 10 — Secret-scan + deploy rules (document in the file itself)

Add a comment block to `lib/auth/oidc-providers.ts` at the top (after the 'use server-only' import):

```ts
// SECURITY RULES — read before editing:
// • Client secrets are NEVER returned to the browser; the admin UI learns only set/unset.
// • Discovery docs are fetched HTTPS-only (http:// throws before any network call).
// • JWKS caches are PER-URI — never one shared global cache (per-provider issuer pinning).
// • alg is pinned to RS256; none/HS* are rejected at the header-decode step.
// • GitHub: no PKCE/nonce (not supported); CSRF is the signed state cookie only.
// • Secrets must NEVER be committed; run `git diff --staged | grep -E 'secret|client.*key'` before push.
```

Forbidden tokens to scan for before any commit (add to the existing `git secret` workflow or note
explicitly for the engineer):
- `GOOGLE_CLIENT_ID` number pattern (`[0-9]{12}-[a-z0-9]{32}`)
- Any string `GOCSPX-` (Google client secret prefix)
- `ghp_`, `github_pat_` (GitHub tokens)
- `client_secret` as a key with a non-empty string value in staged JSON/TS

Command to run before push:
```
git diff --staged | grep -iE "(client_secret|GOCSPX-|ghp_|github_pat_)"
```

---

### Step 11 — Verification (15 min, manual + tsc)

1. `cd C:\Users\Anthony\et-main-wt && node_modules\.bin\tsc --noEmit` — must be 0 errors.
2. Start dev: `node_modules\.bin\next dev -p 3100` (from the worktree).
3. Sign in as admin. Navigate to Config > Admin. Confirm the "Sign-in providers" card renders with
   the Google (built-in) row.
4. Add a test OIDC provider (use any public OIDC provider, e.g. Okta dev tenant). Set a dummy
   clientId/secret. Click Save (step-up required). Confirm the card reflects "Set" status for the
   secret.
5. Visit `/login` — confirm the provider button appears below the Google button.
6. Click the provider button — confirm redirect to the IdP's authorization URL with correct
   `client_id`, `redirect_uri`, `state`, `scope`, `nonce`, `code_challenge` params.
7. Complete a real sign-in (use a real configured provider or GitHub). Confirm:
   - The callback sets the session cookie and redirects to `/`.
   - `auth` collection has the new `oauthIdentities` entry with correct `provider` and `sub`.
   - The session `src` field is `oidc:<id>` or `github`.
8. Confirm Google One Tap still works (visit `/login` with an active Google session in the
   browser, confirm the One Tap UI appears and signs in).
9. Confirm a non-allowed-domain email is refused: configure `allowedDomains` to a specific domain,
   attempt sign-in with a different-domain account, confirm `/login?sso=not_allowed`.
10. Confirm the existing `/api/auth/google/start` and `/api/auth/google/callback` routes still
    work (the old Google button must still function).

---

## Acceptance criteria

- `tsc --noEmit` reports 0 errors after all changes.
- Visiting `/login` with no additional providers configured: page is visually identical to today
  (no extra buttons).
- After adding a GitHub provider in Config > Admin: a "Continue with GitHub" button appears on the
  login page; clicking it begins the GitHub OAuth dance with correct parameters.
- After adding a generic OIDC provider (e.g. Microsoft Entra): a provider-labeled button appears;
  the full PKCE+nonce flow completes and a session is issued with `src: 'oidc:microsoft'`.
- Signing in via a new provider with a non-allowed domain returns `/login?sso=not_allowed`.
- A soft-deleted user attempting sign-in via any new provider returns `/login?sso=offboarded`.
- The admin card never echoes a client secret back in any API response (check Network tab).
- Google + One Tap sign-in still work unchanged.
- The flow cookie carries `providerId`; a callback with a mismatched `providerId` in the cookie
  returns `fail('state')`, not a 500.
- GitHub sign-in is refused when the GitHub account has NO verified primary email.
- The `__settings__` doc in Mongo has `oauthProviders` array and per-provider encrypted
  `secrets.oauthProvider_<id>` blobs after saving.

---

## Deploy flow

Same as all prod deploys (see `nextjs-vm-deploy` memory):

1. **Verify branch**: `git -C C:\Users\Anthony\et-main-wt branch --show-current` must show `main`.
2. **Secret scan**: `git diff HEAD | grep -iE "(client_secret|GOCSPX-|ghp_|github_pat_)"` — must
   be empty. Verify no provider configs are hardcoded.
3. **Type-check**: `node_modules\.bin\tsc --noEmit` — 0 errors.
4. **Commit + push** to `main` (release repo `nomadsgalaxy/Event-Tracker`).
5. On **VM105** (`ssh debian@10.1.4.2`):
   ```
   cd /home/debian/event-tracker
   git pull origin main
   docker build -t et-nextapp:$(git rev-parse --short HEAD) .
   docker save et-nextapp:$(git rev-parse --short HEAD) | gzip > /tmp/et-build.tar.gz
   scp /tmp/et-build.tar.gz debian@10.1.4.1:/tmp/et-build.tar.gz
   ```
6. On **VM104** (`ssh debian@10.1.4.1`):
   ```
   docker load < /tmp/et-build.tar.gz
   cd /home/debian/event-tracker
   # Tag the running image as rollback BEFORE overwriting:
   docker tag et-nextapp:current et-nextapp:rollback-pre-oidc || true
   docker compose up --force-recreate -d
   ```
7. **Demo rebuild** on VM105 under `-p nextjs`:
   ```
   docker compose -p nextjs up --build --force-recreate -d
   ```
8. Smoke-test prod at `prusa.eventtracker.dev`: Google sign-in + any newly configured provider.
9. Rollback if needed: `docker tag et-nextapp:rollback-pre-oidc et-nextapp:current && docker compose up --force-recreate -d`

**BUILD_ID** = `git rev-parse --short HEAD` of the commit being deployed.
**Never run `next build` while `next dev` is live** (corrupts `.next`).

---

## Design alternatives

**Fold Google into the generic `/api/auth/oidc/google` path:** Considered. Rejected because the
existing Google routes are tested and deployed, Google One Tap uses a separate `/onetap` endpoint
that calls `signInWithGoogle` directly, and migrating Google would require touching three proven
routes + the login page `href` + any bookmarks, for no user-visible gain. Additive is safer.

**Store discovery URLs in env vars only (no DB):** Rejected. The whole point is admin-configurable
without a redeploy. The encrypted-store pattern already used for integration keys is the correct
model.

**Use a single global JWKS cache:** Rejected. A global cache allows one provider's compromised key
to shadow another provider's kid (if they share a kid value). Per-URI caches give per-provider
isolation — this was called out as a security requirement.

**Store provider configs in a separate Mongo collection:** Rejected. The `__settings__` doc is
already the encrypted-secrets store with the right isolation properties (off the data-plane
allowlist). Adding a new collection would need a new allowlist exclusion and new access controls.

**Support PKCE for GitHub:** GitHub's OAuth 2.0 implementation does not support PKCE. The signed
flow cookie's `state` parameter provides CSRF protection for the GitHub path.

---

## Files touched

| File | Change |
|---|---|
| `lib/auth/oidc.ts` | Extend `OAuthFlow` + `verifyFlow` + `newFlow` signature |
| `lib/auth/oidc-providers.ts` | **NEW** — all generic provider logic |
| `lib/auth/settings-store.ts` | Add `oauthProviders?` to `SettingsDoc` interface; import `ProviderConfig` |
| `middleware.ts` | Add `'/api/auth/oidc'` to `PUBLIC_PATHS` |
| `app/api/auth/oidc/[provider]/start/route.ts` | **NEW** |
| `app/api/auth/oidc/[provider]/callback/route.ts` | **NEW** |
| `app/api/auth/oidc-providers/route.ts` | **NEW** — admin API |
| `app/config/admin/sign-in-providers-card.tsx` | **NEW** — client island |
| `app/config/admin/page.tsx` | Wire in `SignInProvidersCard`, fetch `getProviderConfigs()` |
| `app/login/page.tsx` | Fetch `getEnabledProviders()`, pass to `LoginForm` |
| `app/login/login-form.tsx` | Accept + render `enabledProviders` prop; extend sso error map |

**No large HTML files touched** (this is a Next.js app; no html-splicer needed).

**Existing routes NOT touched:**
- `app/api/auth/google/start/route.ts`
- `app/api/auth/google/callback/route.ts`
- `app/api/auth/google/onetap/route.ts`

---

## Security requirements checklist (for review before merging)

- [ ] Per-provider JWKS cache (not one global cache): `_jwksCache` is a `Map<uri, ...>`
- [ ] alg pinned to RS256 in `verifyOidcToken` — rejects `none`, `HS256`, `HS384`, `HS512`
- [ ] `aud == provider's clientId` (array-safe), `azp` check on multi-aud
- [ ] `iss == discovery.issuer` (from the fetched discovery doc, not a constant)
- [ ] Discovery doc fetched HTTPS-only; `http://` throws before any network call
- [ ] Discovery doc validated: `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri` all present strings
- [ ] `nonce` verified in `verifyOidcToken` (OIDC providers); GitHub flow skips nonce (documented)
- [ ] PKCE S256 used for all OIDC providers; NOT used for GitHub (documented)
- [ ] Flow cookie carries `providerId`; callback rejects if `flow.providerId !== provider`
- [ ] Client secrets stored AES-256-GCM encrypted (`encSecret`), never returned in any API response
- [ ] `getProviderSecret` never reaches the client; admin UI shows only set/unset
- [ ] GitHub: requires verified primary email (`primary === true && verified === true`)
- [ ] `signInWithOidc` enforces domain allowlist (`allowedDomain`) for all providers
- [ ] `signInWithOidc` refuses soft-deleted users (`deletedAt` on envelope AND payload)
- [ ] `signInWithOidc` uses `$setOnInsert` on the auth record — never overwrites a local password
- [ ] `signInWithOidc` NEVER writes `role` on a new or existing user
- [ ] `oauthIdentities` binding checks for sub collision across accounts before binding
- [ ] Admin write route is `requireRole('admin')` + step-up gated
- [ ] `PROVIDER_ID_RE` validated on every write (prevents `../` or injection in the secret key name)
- [ ] Secret scan before push (`git diff HEAD | grep -iE "(client_secret|GOCSPX-|ghp_)"`)

---

## Hindsight retain

After shipping, add to MEMORY.md under a new `[multi-provider OIDC]` entry:

```
[multi-provider OIDC] — lib/auth/oidc-providers.ts holds all generic provider logic (discovery
fetch, per-URI JWKS cache, verifyOidcToken, exchangeGithubCode, signInWithOidc). Provider configs
+ encrypted secrets live in __settings__.oauthProviders + secrets.oauthProvider_<id>. Routes:
/api/auth/oidc/[provider]/start + /callback (dynamic). Google stays on its own /api/auth/google/*
routes (unchanged). GitHub flow has NO PKCE/nonce — CSRF via signed state cookie only (documented).
Admin card at Config > Admin > Sign-in providers (step-up gated). OAuthFlow now carries providerId;
callback enforces flow.providerId === params.provider.
```

Tags: `auth`, `oidc`, `oauth`, `multi-provider`, `settings-store`
