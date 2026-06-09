import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveLiveRole } from '@/lib/auth/auth';
import { rankOf, effectiveRoles } from '@/lib/auth/rbac';
import { envAccessPolicy, getPolicyOverlay, savePolicyOverlay } from '@/lib/auth/settings-store';
import { writeAudit } from '@/lib/db/data';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// /api/auth/access-policy — the access-policy store (Config > Admin "Access policy" card).
//
// Mirrors eit_auth._h_policy_get/_set. The persisted overlay is ADDITIVE: it ADDS to the deploy-time
// env allowlist (EIT_ADMIN_EMAILS / EIT_OIDC_ALLOWED_DOMAINS), which is reported READ-ONLY (envLocked)
// so the UI renders the env entries as locked chips and can never remove them — a POST only ever
// touches the editable overlay doc.
//
// GET  — ADMIN: env (read-only) + overlay (editable) + the effective union + validRoles.
// POST — ADMIN + STEP-UP: validate (roles in groupRoleMap must be valid) + persist the overlay.

function validRoleIds(): string[] {
  return effectiveRoles().map((r) => r.id);
}

export async function GET() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  const liveRole = await resolveLiveRole(sess.sub);
  if (rankOf(liveRole) < rankOf('admin')) return jsonErr(403, 'admin session required');

  const env = envAccessPolicy();
  const overlay = await getPolicyOverlay({ fresh: true });
  return jsonOk({
    env, // read-only deploy-time allowlist (envLocked)
    policy: overlay, // editable overlay
    // The effective union the server actually enforces.
    effective: {
      adminEmails: Array.from(new Set([...env.adminEmails, ...overlay.adminEmails])).sort(),
      allowedDomains: Array.from(new Set([...env.allowedDomains, ...overlay.allowedDomains])).sort(),
      groupRoleMap: overlay.groupRoleMap,
    },
    validRoles: validRoleIds(),
  });
}

interface PolicyBody {
  stepupToken?: string;
  adminEmails?: string[];
  allowedDomains?: string[];
  groupRoleMap?: Record<string, string>;
}

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  const liveRole = await resolveLiveRole(sess.sub);
  if (rankOf(liveRole) < rankOf('admin')) return jsonErr(403, 'admin session required');

  const body = (await readJson(req)) as PolicyBody;

  if (
    (body.adminEmails && !Array.isArray(body.adminEmails)) ||
    (body.allowedDomains && !Array.isArray(body.allowedDomains)) ||
    (body.groupRoleMap && typeof body.groupRoleMap !== 'object')
  ) {
    return jsonErr(400, 'adminEmails + allowedDomains must be arrays and groupRoleMap an object');
  }

  const res = await savePolicyOverlay(
    {
      adminEmails: body.adminEmails ?? [],
      allowedDomains: body.allowedDomains ?? [],
      groupRoleMap: body.groupRoleMap ?? {},
      validRoles: validRoleIds(),
    },
    sess.sub
  );
  if (!res.ok) return jsonErr(400, res.error || 'invalid access policy');

  const overlay = await getPolicyOverlay({ fresh: true });
  await writeAudit({
    actor: sess.sub,
    action: 'config.access_policy',
    detail: {
      adminEmails: overlay.adminEmails.length,
      allowedDomains: overlay.allowedDomains.length,
      groups: Object.keys(overlay.groupRoleMap).length,
    },
  });
  const env = envAccessPolicy();
  return jsonOk({
    ok: true,
    env,
    policy: overlay,
    effective: {
      adminEmails: Array.from(new Set([...env.adminEmails, ...overlay.adminEmails])).sort(),
      allowedDomains: Array.from(new Set([...env.allowedDomains, ...overlay.allowedDomains])).sort(),
      groupRoleMap: overlay.groupRoleMap,
    },
    validRoles: validRoleIds(),
  });
}
