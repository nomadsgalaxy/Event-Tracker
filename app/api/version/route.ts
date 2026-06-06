export const dynamic = 'force-dynamic';

// GET /api/version — the RUNNING server's build id (stamped at build via next.config `env`). The client
// version-watcher polls this and reloads when it differs from the build the tab loaded with, so an open
// tab converges onto a freshly deployed build with no manual refresh. The Next.js port of the Python
// app's PWA reg.update() loop — minus the service worker / offline caching (per the chosen scope).
//
// Must never be cached: a stale response would hide a new deploy. force-dynamic + no-store.
export async function GET() {
  return Response.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev' },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
