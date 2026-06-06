'use server';

import { revalidatePath } from 'next/cache';
import { requireRole, type CurrentUser } from '@/lib/auth/auth';
import { setUserRole, WriteForbiddenError } from '@/lib/db/write';
import { VALID_ROLES } from '@/lib/auth/rbac';

// app/config/actions.ts — the privilege-management Server Action for Config > Users.
//
// SECURITY (this is the role-assignment escalation surface — explicitly red-teamed):
//   • requireRole('admin') is the COARSE pre-gate: an unauthenticated caller is redirected to
//     /login, an authed non-admin is bounced with a Forbidden before any work runs. This alone
//     makes the action UNREACHABLE by a non-admin (Server Actions are POST endpoints gated by
//     this guard on every invocation — there is no client-trust path).
//   • lib/write.setUserRole is the REAL authority and re-checks EVERYTHING independently against
//     the caller's LIVE role (defense in depth — never trust the pre-gate alone):
//       - admin on the live re-resolved role (a just-demoted admin loses this immediately),
//       - the new role ∈ VALID_ROLES,
//       - the role-raise guard (never grant above your own rank),
//       - REFUSE changing your OWN role (target email vs the session email → Forbidden),
//       - target pinned by a scalar _id, and ONLY payload.role + timestamps written.
//   • The caller NEVER writes Mongo directly; this action only forwards the session email +
//     the requested target/role to the gated write helper.
//
// On success we revalidate the config Users + Audit pages so the new role (and, once the
// server-side audit trail is wired for this stack, the new entry) show on the next render.

export interface RoleChangeResult {
  ok?: boolean;
  error?: string;
  email?: string;
  role?: string;
}

export async function changeUserRoleAction(
  targetEmail: string,
  newRole: string
): Promise<RoleChangeResult> {
  // COARSE PRE-GATE — admin only. requireRole redirects an unauthenticated caller and throws
  // Forbidden for an authed-but-under-ranked one; we translate that into a friendly result so the
  // client surfaces a toast rather than a 500.
  let user: CurrentUser;
  try {
    user = await requireRole('admin');
  } catch {
    return { error: 'Only an admin can change user roles.' };
  }

  // Cheap shape checks before the DB trip (the write helper re-validates authoritatively).
  const target = String(targetEmail ?? '').trim().toLowerCase();
  const role = String(newRole ?? '').trim().toLowerCase();
  if (!target) return { error: 'Missing target user.' };
  if (!VALID_ROLES.has(role)) return { error: 'That is not a valid role.' };

  try {
    const res = await setUserRole({
      targetEmail: target,
      newRole: role,
      actorEmail: user.email, // the own-role refusal pins to the SESSION email, server-side
    });
    // Live-DB: refresh the Users list + Audit so the change reflects immediately.
    revalidatePath('/config');
    revalidatePath('/config/audit');
    return { ok: true, email: res.email, role: res.role };
  } catch (err) {
    if (err instanceof WriteForbiddenError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Failed to change the role.' };
  }
}
