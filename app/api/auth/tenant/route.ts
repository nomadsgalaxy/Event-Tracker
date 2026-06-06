import { type NextRequest } from 'next/server';
import { getSession, verifyStepupToken } from '@/lib/session';
import { resolveLiveRole } from '@/lib/auth';
import { rankOf } from '@/lib/rbac';
import { activeTenantId, getTenantOverride, saveTenantOverride } from '@/lib/settings-store';
import { tenantHash36 } from '@/lib/eitm';
import { writeAudit } from '@/lib/data';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// /api/auth/tenant — the Data-Matrix DEPLOYMENT TENANT id (Config > Admin). Mirrors the Python
// DeploymentTenantPanel: the tenant string prefixes (as a base36 hash) every printed Matrix code so a
// scan in another customer's app rejects it. Changing it INVALIDATES already-printed labels — the UI
// warns before saving.
//
// GET  — ADMIN: the active tenant (override || env EIT_TENANT_ID || MONGO_DB), its hash, the env
//        default, and whether an override is set.
// POST — ADMIN + STEP-UP: set/clear the override. The override (when set) wins over the env in
//        activeTenantId(), which feeds activeTenantHash36() on every print/scan path.

export async function GET() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  const liveRole = await resolveLiveRole(sess.sub);
  if (rankOf(liveRole) < rankOf('admin')) return jsonErr(403, 'admin session required');

  const [override, active] = await Promise.all([getTenantOverride({ fresh: true }), activeTenantId({ fresh: true })]);
  const envDefault = String(process.env.EIT_TENANT_ID || process.env.MONGO_DB || '').trim().toLowerCase();
  return jsonOk({
    override, // the persisted override ('' when unset)
    active, // what the app actually uses (override || env)
    envDefault, // the env fallback (read-only)
    hash: tenantHash36(active), // the base36 prefix embedded in codes
    hasOverride: override.length > 0,
  });
}

interface TenantBody {
  stepupToken?: string;
  tenantId?: string;
}

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  const liveRole = await resolveLiveRole(sess.sub);
  if (rankOf(liveRole) < rankOf('admin')) return jsonErr(403, 'admin session required');

  const body = (await readJson(req)) as TenantBody;
  if (!verifyStepupToken(body.stepupToken, sess.sub)) return jsonErr(403, 'step-up required');

  const res = await saveTenantOverride(String(body.tenantId ?? ''), sess.sub);
  if (!res.ok) return jsonErr(503, res.error || 'failed to save the tenant id');

  const [override, active] = await Promise.all([getTenantOverride({ fresh: true }), activeTenantId({ fresh: true })]);
  await writeAudit({ actor: sess.sub, action: 'config.tenant', detail: { override: override || null } });
  const envDefault = String(process.env.EIT_TENANT_ID || process.env.MONGO_DB || '').trim().toLowerCase();
  return jsonOk({ ok: true, override, active, envDefault, hash: tenantHash36(active), hasOverride: override.length > 0 });
}
