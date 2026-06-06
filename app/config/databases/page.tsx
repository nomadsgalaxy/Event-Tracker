import { requireRole } from '@/lib/auth';
import { integrationKeyStatuses, settingsMeta } from '@/lib/settings-store';
import { dbStatus } from '@/lib/mongo';
import { IntegrationKeysCard } from './integration-keys-card';
import { StorageCard } from './storage-card';

// app/config/databases — Config > Databases & API. The genuinely-applicable card (Integration keys)
// is built FULLY; the storage-adapter card is an HONEST read-only note that this deployment is
// Mongo-direct (no Primary/Replica/SheetsAdapter multi-adapter editor — that's a Python-only model).
//
// MOUNT-GATE: this is a Server Component; it reads the per-key set/unset provenance + a live Mongo
// ping server-side and hands the booleans (never a secret) to the client islands. The whole /config
// area is requireRole('admin')-gated by the layout; we re-resolve here to thread the admin email.
export const dynamic = 'force-dynamic';

export default async function ConfigDatabasesPage() {
  await requireRole('admin');
  const [keys, meta, db] = await Promise.all([integrationKeyStatuses(), settingsMeta(), dbStatus()]);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <IntegrationKeysCard initialKeys={keys} meta={meta} />
      <StorageCard reachable={db.reachable} dbName={db.dbName} />
    </div>
  );
}
