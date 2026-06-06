import { requireRole } from '@/lib/auth';
import { getBranding, envAccessPolicy, getPolicyOverlay, getTenantOverride, activeTenantId } from '@/lib/settings-store';
import { tenantHash36 } from '@/lib/eitm';
import { dbStatus } from '@/lib/mongo';
import { effectiveRoles } from '@/lib/rbac';
import { BrandingCard } from './branding-card';
import { TenantCard } from './tenant-card';
import { AccessPolicyCard } from './access-policy-card';
import { ServerInfraShells } from './server-infra-shells';

// app/config/admin — Config > Admin. The genuinely-applicable cards are built FULLY (Company
// branding, Deployment tenant, Access policy); the server-infra ones (ID rotation, System status,
// Backup/Restore, SMTP, local TLS) are HONEST SHELLS with a one-line "managed by the server infra"
// note each — never faked.
//
// MOUNT-GATE: Server Component. It reads the current branding + tenant + access policy + a live DB
// ping server-side and hands them to the client islands (no client-only read during initial render).
// The whole /config area is admin-gated by the layout; re-resolved here.
export const dynamic = 'force-dynamic';

export default async function ConfigAdminPage() {
  await requireRole('admin');
  const [branding, env, overlay, tenantOverride, activeTenant, db] = await Promise.all([
    getBranding({ fresh: true }),
    Promise.resolve(envAccessPolicy()),
    getPolicyOverlay({ fresh: true }),
    getTenantOverride({ fresh: true }),
    activeTenantId({ fresh: true }),
    dbStatus(),
  ]);

  const envTenantDefault = String(process.env.EIT_TENANT_ID || process.env.MONGO_DB || '').trim().toLowerCase();
  const validRoles = effectiveRoles()
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((r) => ({ id: r.id, label: r.label }));

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <BrandingCard initial={branding} />
      <TenantCard
        initial={{
          override: tenantOverride,
          active: activeTenant,
          envDefault: envTenantDefault,
          hash: tenantHash36(activeTenant),
        }}
      />
      <AccessPolicyCard initial={{ env, policy: overlay, validRoles }} />
      <ServerInfraShells dbReachable={db.reachable} dbName={db.dbName} />
    </div>
  );
}
