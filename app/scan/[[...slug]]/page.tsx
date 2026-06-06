import { requireRole } from '@/lib/auth';
import { getCases, getEvents, getInventory } from '@/lib/data';
import { isCaseRetired } from '@/lib/case-view';
import { activeTenantHash36 } from '@/lib/settings-store';
import { scanPolicy, type ScanCaseLean, type ScanEventLean, type ScanItemLean } from '@/lib/scan';
import { ScanScreen } from '../scan-screen';

// /scan[/{pack|return}[/<caseId>]] + /scan/event/<eventId> — Scan-Pack (DESIGN_ALIGNMENT.md §4.4).
// A faithful port of the Python ScanHybrid surface, served as a CATCH-ALL so the deep-links match
// the source's routing:
//   /scan                       → no case open (pick or scan a case)
//   /scan/pack                  → same (pack variant)
//   /scan/return                → same (return variant; mode is derived from the case's event anyway)
//   /scan/pack/<caseId|slug>    → opens straight onto that case (CaseDetail "Pack this case")
//   /scan/event/<eventId>       → LOOSE MODE (scans add loose distribution rows to the event)
// (the legacy ?case=<id> query is still honored too).
//
// Server Component: LIVE reads of cases + events + inventory from Mongo on every request (no cache,
// no localStorage). The interactive scan loop + camera/NFC delegate to <ScanScreen> (a Client
// Component); the writes persist via the gated Server Actions in app/scan/actions.ts.
//
// GATE: scan.pack is authorized+ (#65), so the page requires the 'authorized' role. requireRole
// redirects a signed-out request to /login and 403s a read-only user before any data is read.
export const dynamic = 'force-dynamic';

interface ScanPageProps {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<{ case?: string }>;
}

export default async function ScanPage({ params, searchParams }: ScanPageProps) {
  const [user, { slug }, { case: caseQuery }, caseDocs, eventDocs, invDocs] = await Promise.all([
    requireRole('authorized'),
    params,
    searchParams,
    getCases(),
    getEvents(),
    getInventory(),
  ]);

  // ── Route parsing — mirrors the Python route { variant, eventId } third-segment shape ──────────
  // slug[0] = variant ('pack' | 'return' | 'event'); slug[1] = the third id (caseId or eventId).
  const segs = Array.isArray(slug) ? slug : [];
  const variant = (segs[0] || 'pack').toLowerCase();
  const thirdId = segs[1] || null;
  const routeIsLoose = variant === 'event';
  const routeLooseEventId = routeIsLoose ? thirdId : null;
  const routeCaseId = routeIsLoose ? null : thirdId || caseQuery || null;

  // ── Lean, serializable projections (no Mongo internals cross the RSC boundary) ─────────────────
  const cases: ScanCaseLean[] = caseDocs.map((doc) => {
    const c = doc.payload;
    return {
      id: doc._id,
      slug: c.slug && c.slug !== doc._id ? c.slug : '',
      label: c.label || c.slug || doc._id,
      zone: c.zone || '',
      retired: isCaseRetired(c),
    };
  });

  const events: ScanEventLean[] = eventDocs.map((e) => ({ id: e._id, payload: e.payload }));

  // The full scan index (every live item's id + payload) so the client resolves a scanned code +
  // renders the active-case contents WITHOUT another round-trip. Payload.id is forced to the
  // envelope _id so the row id the client packs against is ALWAYS the canonical key.
  const items: ScanItemLean[] = invDocs.map((d) => ({ id: d._id, payload: { ...d.payload, id: d._id } }));

  const tenantHash = await activeTenantHash36();
  const policy = scanPolicy(user.role);

  return (
    <ScanScreen
      cases={cases}
      events={events}
      items={items}
      role={user.role}
      policy={policy}
      tenantHash={tenantHash}
      routeVariant={routeIsLoose ? 'event' : variant === 'return' ? 'return' : 'pack'}
      routeCaseId={routeCaseId}
      routeLooseEventId={routeLooseEventId}
    />
  );
}
