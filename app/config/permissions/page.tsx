import { requireRole } from '@/lib/auth';
import { syncPerms } from '@/lib/perms-store';
import { PermissionsMatrix } from './permissions-matrix';

// app/config/permissions — the EDITABLE role × capability matrix (Config > Permissions). Server
// Component: admin-gated (re-asserted on top of the layout gate); syncPerms() installs the persisted
// __perms__ override first, so the table the admin edits reflects the LIVE saved state (the same table
// the server's can() evaluates). The matrix is handed to a client that toggles grants per role, adds/
// removes CUSTOM roles, and saves/resets behind a STEP-UP (POST /api/auth/perms — admin + a fresh
// re-auth token). Structural invariants (db.*/session.*) render LOCKED — the server validateOverride
// refuses any attempt to re-grant them, and the client mirrors that lock for UX.
export const dynamic = 'force-dynamic';

export default async function ConfigPermissionsPage() {
  const admin = await requireRole('admin');
  const table = await syncPerms();
  return <PermissionsMatrix initialTable={table} myRole={admin.role} />;
}
