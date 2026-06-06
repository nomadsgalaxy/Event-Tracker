import { requireUser } from '@/lib/auth';
import { can } from '@/lib/rbac';
import { getCases } from '@/lib/data';
import { integrationStatus } from '@/lib/integrations';
import {
  getWarehouses,
  getEmergencyContact,
  casesPerWarehouse,
  formatWarehouseAddress,
} from './warehouse-data';
import { WarehousesList, type WarehouseRow } from './warehouses-list';
import { EmergencyContactPanel } from './emergency-contact-panel';
import { ConfigHeader } from '@/app/config/config-header';

// app/warehouses — the WAREHOUSES (return-address) surface. Server Component: reads warehouses +
// cases + the fleet emergency contact LIVE from Mongo on every request (no cache, no localStorage) —
// the realtime-DB model. The case cross-join powers the per-warehouse "N cases homed here" count.
// Mirrors the Python WarehousesPanel + EmergencyContactPanel (index.html ~L14055/14180): the warehouse
// list with add/edit/delete (gated by pallets.edit / authorized+) + the single fleet-wide emergency
// contact (gated by emergency_contact.write / manager+). The interactive search + management is
// delegated to <WarehousesList> (a Client Component) so a keystroke never costs a round-trip.
export const dynamic = 'force-dynamic';

export default async function WarehousesPage() {
  // requireUser() redirects a signed-out / forged-cookie request to /login before any data is read
  // (the Node-side gate; middleware can't verify the session HMAC on the Edge runtime).
  const [user, warehouseDocs, caseDocs, emergencyContact] = await Promise.all([
    requireUser(),
    getWarehouses(),
    getCases(),
    getEmergencyContact(),
  ]);

  // pallets.edit (authorized+) — the warehouse-worker tier that homes a case at a warehouse — gates
  // the warehouse CRUD; emergency_contact.write (manager+) gates the global contact.
  const canManageWarehouses = can('pallets.edit', user.role);
  const canManageEmergency = can('emergency_contact.write', user.role);
  const { placesAvailable } = await integrationStatus();

  const caseCounts = casesPerWarehouse(caseDocs);

  // Project to the lean, serializable row shape — the address + case count pre-computed server-side
  // so the count never drifts from its source; the raw parts are kept so the edit form can seed them.
  const rows: WarehouseRow[] = warehouseDocs.map((doc) => {
    const w = doc.payload;
    return {
      id: doc._id,
      name: w.name || '(unnamed warehouse)',
      type: w.type === 'hq' ? 'hq' : 'sub',
      street: w.street || '',
      city: w.city || '',
      region: w.region || '',
      postal: w.postal || '',
      country: w.country || '',
      address: formatWarehouseAddress(w),
      contactName: w.contactName || '',
      contactRole: w.contactRole || '',
      contactEmail: w.contactEmail || '',
      phone: w.phone || '',
      caseCount: caseCounts[doc._id] || 0,
    };
  });

  return (
    <div className="space-y-6 px-6 py-6">
      {/* Warehouses is a Config-area page: admins (who reach it via Config → Warehouses) get the SAME
          chrome as every other config page — the "Configuration" header + the sub-nav tab strip. A
          non-admin who lands here from elsewhere gets the standalone Warehouses header instead. */}
      {can('admin.console', user.role) ? (
        <ConfigHeader adminEmail={user.email} />
      ) : (
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Warehouses</h1>
          <p className="text-sm text-muted-foreground">
            Return-address locations — each road case can home at one of these, and its 4×6 shipping
            label prints that address. Read live from Mongo in a Server Component.
          </p>
        </header>
      )}

      <WarehousesList rows={rows} canManage={canManageWarehouses} placesAvailable={placesAvailable} />

      <EmergencyContactPanel initial={emergencyContact} canManage={canManageEmergency} />
    </div>
  );
}
