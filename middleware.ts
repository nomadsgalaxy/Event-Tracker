import { NextResponse, type NextRequest } from 'next/server';

// middleware.ts — the coarse front-door gate. Redirects an unauthenticated request to /login
// for EVERY route except /login itself and static assets.
//
// IMPORTANT SECURITY MODEL (read before changing):
//   Next middleware runs on the Edge runtime, where node:crypto's HMAC is not available, so
//   middleware CANNOT cryptographically verify the signed session here. It performs only a
//   CHEAP PRESENCE + EXPIRY pre-check on the cookie and bounces the obvious cases (no cookie,
//   malformed, or expired). The AUTHORITATIVE check — HMAC signature verification via
//   lib/session.verifySession in the Node runtime — happens in the page/layout/action guards
//   (requireUser / requireRole / getSession). A forged-signature cookie may slip PAST
//   middleware but is REJECTED the moment a guard runs, before any data is read. So:
//
//     middleware  = fast UX gate (don't render a protected shell for the signed-out)
//     guards      = the real authorization boundary (run in Node, verify the HMAC)
//
//   NEVER move a real authz decision into middleware on the assumption the signature was
//   checked here — it was not. Every data-reading Server Component/Action MUST call a guard.
//
// TOTP/SSO seam: we treat only a stage:'full', unexpired token as "looks signed in". The
// staging tokens (pending2fa/setup2fa/mustchangepw) are deliberately NOT enough to pass the
// gate, matching the app surface's "full session only" rule.

const COOKIE_NAME = '_eit_auth';

// ── DEMO sandbox sid (Edge) ──────────────────────────────────────────────────────────────────────
// In demo mode every visitor carries an unguessable, HMAC-signed `eit_demo_sid` cookie that keys their
// private data sandbox (see lib/demo + lib/mongo getDb). Middleware ISSUES it (CSPRNG + Web-Crypto
// HMAC, since node:crypto isn't on the Edge) and forwards it on the SAME request so the first render
// already routes to the sandbox. The AUTHORITATIVE HMAC verification is verifyDemoSid in the Node
// getDb — middleware only shape/HMAC-checks to decide whether to re-issue. The sid is NEVER read from
// a URL/param, so a visitor can only ever reach the sandbox the server signed for them.
const DEMO_MODE = process.env.EIT_DEMO_MODE === '1';
const DEMO_SECRET = process.env.ET_SESSION_SECRET || '';
// The demo runs ONLY with a real signing secret. Without one we NEVER issue/accept a sid — an
// empty-key HMAC would be forgeable — so getDb fails closed and the demo is simply inert until the
// operator sets ET_SESSION_SECRET. (Node-side verifyDemoSid throws on a short/empty secret too.)
const DEMO_ENABLED = DEMO_MODE && DEMO_SECRET.length >= 16;
const DEMO_SID_COOKIE = 'eit_demo_sid';
const DEMO_SID_TOKEN_RE = /^[0-9a-f]{32}\.[0-9a-f]{64}$/;
const DEMO_SID_OPTS = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 * 30 };

// Per-IP issuance rate-limit (in-process) so a bot deleting its cookie in a loop can't spam unbounded
// sandbox DBs. Generous enough for real visitors behind a shared NAT; the GC interval is the backstop.
const DEMO_ISSUE_MAX = 30;
const DEMO_ISSUE_WINDOW_MS = 10 * 60 * 1000;
const _demoIssue = new Map<string, { count: number; resetAt: number }>();
function demoIssueAllowed(req: NextRequest): boolean {
  // Client IP from the trusted edge. Behind Cloudflare (the demo's front), cf-connecting-ip is set by
  // CF and cannot be spoofed; the x-forwarded-for / x-real-ip fallbacks are only trustworthy when the
  // proxy strips client-supplied values. This is a per-IP throttle (anti-DoS), NOT an auth boundary —
  // isolation never depends on it.
  const ip =
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const now = Date.now();
  if (_demoIssue.size > 5000) {
    // Prune only EXPIRED buckets — never mass-clear (that would reset live counters and let a burst
    // through). Active in-window IPs keep their counts.
    for (const [k, v] of _demoIssue) if (now > v.resetAt) _demoIssue.delete(k);
  }
  const b = _demoIssue.get(ip);
  if (!b || now > b.resetAt) {
    _demoIssue.set(ip, { count: 1, resetAt: now + DEMO_ISSUE_WINDOW_MS });
    return true;
  }
  if (b.count >= DEMO_ISSUE_MAX) return false;
  b.count++;
  return true;
}

async function demoHmacHex(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(DEMO_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Edge HMAC shape+signature check (decides whether to re-issue). getDb does the authoritative verify. */
async function demoSidValid(token: string | undefined): Promise<boolean> {
  if (!token || !DEMO_SID_TOKEN_RE.test(token)) return false;
  const dot = token.indexOf('.');
  return (await demoHmacHex(token.slice(0, dot))) === token.slice(dot + 1);
}

/** Mint a fresh signed sid: 128 bits of CSPRNG randomness (hex) + its HMAC. */
async function issueDemoSidToken(): Promise<string> {
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  const sid = Array.from(rnd).map((b) => b.toString(16).padStart(2, '0')).join('');
  return sid + '.' + (await demoHmacHex(sid));
}

// Paths that are always reachable without a session. Everything else is gated.
//   • /login — the only unauthenticated PAGE.
//   • /api/auth/google — the OAuth dance (started + completed while signed out; CSRF-state + binding
//     enforced internally).
//   • The credential-flow API routes that run WHILE SIGNED OUT and enforce their own auth internally:
//       login (password), the pending2fa verify, recovery-code login, the forced-password-change
//       finish, and the passwordless passkey login (begin+finish). Each verifies a short-lived signed
//       staging token (or a WebAuthn assertion) server-side — middleware can't, and must not gate them.
//     NOTE: the SESSION-MANAGEMENT auth routes (stepup, totp setup/confirm, password change/set,
//     recovery/regenerate, passkey register/list/remove, identities, apikeys, calendar, 2fa/status)
//     are deliberately NOT here — they require a full session and re-check it in the handler, so they
//     stay behind the gate. Only the genuinely-signed-out flows are exempt.
const PUBLIC_PATHS = [
  '/login',
  '/api/auth/google',
  '/api/auth/oidc', // generic OIDC/GitHub provider start+callback (signed-out flow, like /api/auth/google)
  '/api/auth/login',
  '/api/auth/totp/verify',
  '/api/auth/recovery', // POST /api/auth/recovery (recovery-code login); /recovery/regenerate is gated below
  '/api/auth/password/initial',
  '/api/auth/passkey/login',
  '/api/version', // the build-id stamp (non-sensitive) — public so the version-watcher works pre-login too
  '/api/demo/enter', // DEMO auto-sign-in — public so a signed-out visitor can be bounced through it
  '/t', // the NFC tag viewer — renders material data from the URL FRAGMENT only (never sent to the
        // server, no DB read, no inventory exposure), so a tag tapped on any phone (iOS/Android) opens
        // a readable card without a login. Self-contained: the page shows only what the URL carries.
];

// The token-authenticated iCalendar feed: /calendar/<token>.ics. PUBLIC (calendar apps can't SSO; the
// unguessable token IS the credential). The route re-checks the token + the global-feed role itself.
// NOTE: /calendar (the app screen) stays GATED — only the .ics child path is exempt.
function isCalendarFeed(pathname: string): boolean {
  return /^\/calendar\/[^/]+\.ics$/.test(pathname);
}

// /api/auth/recovery/regenerate must STAY gated even though /api/auth/recovery is public (prefix
// match would otherwise leak the regenerate route to signed-out callers). Exclude it explicitly.
function isPublicAuthRecoveryException(pathname: string): boolean {
  return pathname === '/api/auth/recovery/regenerate' || pathname.startsWith('/api/auth/recovery/regenerate/');
}

// b64url decode of the token body's payload (no signature check — see the model note above).
function peekPayload(token: string): { exp?: number; stage?: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  try {
    const pad = body.length % 4 === 0 ? '' : '='.repeat(4 - (body.length % 4));
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/') + pad;
    // atob is available on the Edge runtime.
    const json = atob(b64);
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function looksSignedIn(req: NextRequest): boolean {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return false;
  const payload = peekPayload(token);
  if (!payload) return false;
  if (payload.stage !== 'full') return false;
  if (Number(payload.exp ?? 0) < Math.floor(Date.now() / 1000)) return false;
  return true;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;

  // DEMO: resolve the sandbox sid up front. If missing/invalid, mint a signed one and FORWARD it on
  // this request (so getDb routes to the sandbox on the first render). Whatever response we return
  // below is wrapped by withDemo() so the browser also stores it. Non-demo: all of this is inert.
  let newDemoToken: string | null = null;
  if (DEMO_ENABLED) {
    const existing = req.cookies.get(DEMO_SID_COOKIE)?.value;
    // Re-issue only when missing/invalid AND the IP is under its issuance budget (anti-DoS). If
    // rate-limited, we leave the cookie absent — getDb then fails closed for this request, throttling
    // the abuser without ever granting access to a foreign sandbox.
    if (!(await demoSidValid(existing)) && demoIssueAllowed(req)) {
      newDemoToken = await issueDemoSidToken();
      req.cookies.set(DEMO_SID_COOKIE, newDemoToken); // mutate the forwarded request's Cookie header
    }
  }
  const withDemo = (res: NextResponse): NextResponse => {
    if (newDemoToken) res.cookies.set(DEMO_SID_COOKIE, newDemoToken, DEMO_SID_OPTS);
    return res;
  };
  const passThrough = () => withDemo(NextResponse.next(newDemoToken ? { request: { headers: req.headers } } : undefined));

  // The token-authenticated .ics feed is always public (the route checks the token itself).
  if (isCalendarFeed(pathname)) return passThrough();

  // The /api/v1 REST surface authenticates with a Bearer / X-Api-Key TOKEN, not the session cookie.
  // A headless client (the MCP server, a CLI) carries no _eit_auth cookie, so don't bounce it at the
  // edge — pass it through and let lib/api-v1.withKey -> verifyApiKey be the authoritative Node-runtime
  // check (it verifies the key's PBKDF2 secret + re-resolves the owner's live caps). We only skip the
  // cookie gate when an API-key header is actually present; a /api/v1 request with NO key header still
  // falls through to the cookie gate below, so we never open an unauthenticated surface.
  if (pathname.startsWith('/api/v1/') && (req.headers.get('authorization') || req.headers.get('x-api-key'))) {
    return passThrough();
  }

  const isPublic =
    !isPublicAuthRecoveryException(pathname) &&
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));

  if (isPublic) {
    // A signed-in user hitting the /login PAGE is sent on to the app (avoids a flash of the form).
    // Do NOT redirect public API routes — a 302 would break an in-flight fetch; just pass through.
    if (pathname === '/login' && looksSignedIn(req)) {
      return withDemo(NextResponse.redirect(new URL('/', req.url)));
    }
    return passThrough();
  }

  if (!looksSignedIn(req)) {
    // API routes get a JSON 401 (a redirect to an HTML /login would corrupt a fetch); pages redirect.
    if (pathname.startsWith('/api/')) {
      return withDemo(
        new NextResponse(JSON.stringify({ error: 'sign in required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        }),
      );
    }
    // In the demo, a signed-out visitor is auto-entered (no credentials) via /api/demo/enter; the real
    // app sends them to /login. Either way, preserve where they were headed for the post-redirect.
    const dest = pathname + (search || '');
    const url = DEMO_ENABLED ? new URL('/api/demo/enter', req.url) : new URL('/login', req.url);
    if (dest && dest !== '/') url.searchParams.set('next', dest);
    return withDemo(NextResponse.redirect(url));
  }

  return passThrough();
}

// Run on everything EXCEPT Next internals and static files. The negative lookahead excludes
// /_next/* (build assets, HMR), the favicon, and common static file extensions, so the gate
// covers all app + API routes while never touching static delivery.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff2?)$).*)'],
};
