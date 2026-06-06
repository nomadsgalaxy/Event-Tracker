import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';

// app/cases — the standalone Cases list is now FOLDED into the merged Catalog (DESIGN_ALIGNMENT §4.6:
// one nav destination, Roadcases | Inventory split via the left rail). The canonical roadcases surface
// is /catalog?view=cases — which now carries the full feature set (search, New/Import, inline
// edit/delete/print, location chip, double-booked badge, weight-in-unit). This route redirects there
// so there's a single source of truth; /cases/[id] (the case detail) is unaffected.
//
// requireUser keeps the redirect itself auth-gated (a signed-out request bounces to /login first).
export default async function CasesPage() {
  await requireUser();
  redirect('/catalog?view=cases');
}
