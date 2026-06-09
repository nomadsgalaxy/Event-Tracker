import { type NextRequest, NextResponse } from 'next/server';
import { issueSessionToken, COOKIE_NAME, SSO_COOKIE_OPTS } from '@/lib/auth/session';
import { DEMO_MODE } from '@/lib/db/demo';
import type { Role } from '@/lib/types/types';

export const dynamic = 'force-dynamic';

// GET /api/demo/enter?next=<path> — auto-sign-in for the DEMO build. A public demo has no credentials,
// so the demo middleware sends a signed-out visitor here instead of /login: we mint a full session for
// a synthetic demo user and bounce them into the app. Their DATA is isolated in their own cookie-keyed
// sandbox (see lib/demo); admin/config writes are blocked (demoDenied). The baked role is cosmetic —
// guards re-resolve the LIVE role, so make the demo user admin by listing it in EIT_ADMIN_EMAILS (then
// they see the full, read-only Config console). Outside demo mode this route just forwards to /login.
const DEMO_USER = (process.env.EIT_DEMO_USER || 'demo@eventtracker.dev').trim().toLowerCase();

export async function GET(req: NextRequest) {
  // RELATIVE redirects only: behind the proxy, req.url resolves to the bind host (0.0.0.0:3100), so an
  // absolute redirect would bounce the visitor to an unreachable address. A relative Location lets the
  // browser resolve against the real URL (the demo's public hostname).
  const redirectTo = (dest: string) => new NextResponse(null, { status: 307, headers: { Location: dest } });

  if (!DEMO_MODE) return redirectTo('/login');

  // Only same-origin paths (no open redirect): must start with a single '/'.
  const raw = req.nextUrl.searchParams.get('next') || '/';
  const dest = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';

  // Baked 'admin' so the demo showcases the Config console; the live re-resolve (EIT_ADMIN_EMAILS)
  // is the real authority. If the env doesn't grant admin, guards floor it — the demo still works,
  // just without the admin screens.
  const { token } = issueSessionToken(DEMO_USER, 'admin' as Role, 'demo');
  const res = redirectTo(dest);
  // SameSite=Lax (SSO_COOKIE_OPTS), NOT Strict: this cookie is set during a REDIRECT into the app, and
  // a freshly-set Strict cookie is dropped by stricter browsers (Safari/WebKit) when the visitor
  // arrived via a cross-site navigation — the dropped cookie made middleware bounce back here forever
  // ("too many redirects"). Lax survives the redirect, same as the SSO callback.
  res.cookies.set(COOKIE_NAME, token, SSO_COOKIE_OPTS);
  return res;
}
