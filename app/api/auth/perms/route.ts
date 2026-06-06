import { type NextRequest } from 'next/server';
import { getSession, verifyStepupToken } from '@/lib/session';
import { resolveLiveRole } from '@/lib/auth';
import { rankOf, type RoleDef } from '@/lib/rbac';
import { syncPerms, savePermsOverride, resetPermsOverride } from '@/lib/perms-store';
import { writeAudit } from '@/lib/data';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// /api/auth/perms — the permission-matrix override surface (Config > Permissions).
//
// GET  — any FULL session: the effective table (roles + capabilities + grants + the `customized`
//        flag) so the admin UI can render + edit it. syncPerms() installs the persisted override
//        first, so the table reflects the saved state. The matrix is the product's authz MODEL, not
//        a secret (enforcement is server-side regardless) — but it still needs a signed-in session.
//        `myRole` is added so the client can mirror its own grants. Mirrors eit_auth._h_perms_get.
//
// POST — ADMIN + a fresh STEP-UP (a re-auth token from /api/auth/stepup): validate + persist a
//        customized table, or { reset:true } to revert to defaults. The role is re-resolved LIVE (a
//        just-demoted admin is refused) and the step-up token is verified against the SESSION email
//        (a stolen cookie alone can't rewrite the matrix). validateOverride (in savePermsOverride)
//        refuses anything that bricks the install. Mirrors eit_auth._h_perms_set.

export async function GET() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  const table = await syncPerms();
  return jsonOk({ ...table, myRole: sess.role });
}

interface PermsBody {
  reset?: boolean;
  stepupToken?: string;
  roles?: RoleDef[];
  grants?: Record<string, string[]>;
  capsSeen?: string[];
}

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');

  // ADMIN on the LIVE role (re-resolved — never trust the baked token; a just-demoted admin is out).
  const liveRole = await resolveLiveRole(sess.sub);
  if (rankOf(liveRole) < rankOf('admin')) return jsonErr(403, 'admin session required');

  const body = (await readJson(req)) as PermsBody;

  // STEP-UP: a fresh re-auth token bound to THIS session email (defends a stolen cookie).
  if (!verifyStepupToken(body.stepupToken, sess.sub)) return jsonErr(403, 'step-up required');

  if (body.reset) {
    const res = await resetPermsOverride(sess.sub);
    if (!res.ok) return jsonErr(503, res.error || 'reset failed');
    await writeAudit({ actor: sess.sub, action: 'perms.reset' });
    return jsonOk({ ...res.table, myRole: liveRole });
  }

  if (!Array.isArray(body.roles) || !body.grants || typeof body.grants !== 'object') {
    return jsonErr(400, 'roles + grants are required');
  }
  const res = await savePermsOverride({
    roles: body.roles,
    grants: body.grants,
    capsSeen: body.capsSeen,
    actorEmail: sess.sub,
  });
  if (!res.ok) return jsonErr(400, res.error || 'invalid permission table');
  const customRoles = body.roles.filter((r) => !r.builtin).length;
  await writeAudit({ actor: sess.sub, action: 'perms.update', detail: { roles: body.roles.length, customRoles } });
  return jsonOk({ ...res.table, myRole: liveRole });
}
