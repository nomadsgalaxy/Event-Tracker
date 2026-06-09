import { requireRole } from '@/lib/auth/auth';
import { getUsers } from '@/lib/db/data';
import { getAccountPostures } from '@/lib/auth/auth-store';
import { getProviderConfigs } from '@/lib/auth/settings-store';
import { normalizeRole, effectiveRoles, can } from '@/lib/auth/rbac';
import { UsersTable, type UserRow, type RoleOption } from './users-table';

// A configured provider's button label is "Continue with Microsoft" — strip the lead-in to a short
// name ("Microsoft") for the Users list; fall back to a title-cased id.
function shortProviderName(label: string, id: string): string {
  const l = (label || '').trim();
  const m = l.match(/^(?:continue|sign[ -]?in|log[ -]?in)\s+with\s+(.+)$/i);
  const name = (m ? m[1] : l).trim();
  return name || id.charAt(0).toUpperCase() + id.slice(1);
}

// Turn a stored `source` ('local' | 'oidc:google' | 'oidc:<id>' | 'github' | legacy 'google'/'oauth')
// into the sign-in method the admin actually recognizes. The list used to print the raw value, so an
// OIDC account showed the token "Oidc:google" instead of "Google".
function methodLabel(source: string, providerLabels: Record<string, string>): string {
  const s = (source || '').trim();
  if (!s) return '';
  const lc = s.toLowerCase();
  if (lc === 'local') return 'Local';
  if (lc === 'github') return 'GitHub';
  if (lc === 'google' || lc === 'oidc:google') return 'Google';
  if (lc === 'oidc' || lc === 'oauth') return 'OAuth';
  if (lc.startsWith('oidc:')) {
    const id = s.slice(5);
    return providerLabels[id] || id.charAt(0).toUpperCase() + id.slice(1);
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// app/config (Users) — the directory user-management panel. Server Component: reads the live
// `users` directory and the admin's session (the layout already requireRole('admin')s the whole
// area; we re-resolve here too to thread the SAME session email the own-role rule pins to). Each
// row gets a role <Select> wired to the changeUserRoleAction Server Action — the privilege write,
// which independently re-checks admin + valid-role + role-raise + refuse-own-role server-side.
//
// We hand the client a lean, serializable projection (no Mongo internals) plus the precomputed
// role-options list (from the rbac role table — only NON-hidden built-in roles are offered as
// assignable, matching the current app's role picker, while a stored hidden role like 'read-only'
// still renders as the current value so it isn't silently misrepresented).
export const dynamic = 'force-dynamic';

export default async function ConfigUsersPage() {
  const [admin, userDocs, postures, providerCfgs] = await Promise.all([
    requireRole('admin'),
    getUsers(),
    getAccountPostures(),
    getProviderConfigs(),
  ]);

  const providerLabels: Record<string, string> = {};
  for (const c of providerCfgs) providerLabels[c.id] = shortProviderName(c.label, c.id);

  const rows: UserRow[] = userDocs.map((doc) => {
    const p = doc.payload || {};
    const email = (p.email || doc._id || '').toLowerCase();
    const posture = postures.get(email);
    const source =
      typeof (p as { source?: unknown }).source === 'string'
        ? (p as { source?: string }).source!
        : posture?.source || '';
    // Friendly label for the list; empty source falls back to the credential posture.
    const sourceLabel = methodLabel(source, providerLabels) || (posture?.hasPassword ? 'Local' : posture ? 'OAuth' : '');
    return {
      email,
      // The DIRECTORY name (p.name) is what the admin edits inline; preferredName is the user's own
      // self-chosen display name (read for the avatar/label, never overwritten by the admin edit).
      name: p.name || '',
      preferredName: p.preferredName || '',
      role: normalizeRole(p.role),
      source,
      sourceLabel,
      picture: typeof p.picture === 'string' ? p.picture : '',
      lastLoginAt: typeof p.lastLoginAt === 'number' ? p.lastLoginAt : null,
      isSelf: email === admin.email,
      // Credential posture (no secrets) — drives the right control labels + the 2FA/lock badges.
      hasLocalAccount: Boolean(posture),
      hasPassword: Boolean(posture?.hasPassword),
      twofaEnrolled: Boolean(posture?.twofaEnrolled),
      locked: Boolean(posture?.locked),
    };
  });

  // Assignable roles = the rbac role table, ordered low→high rank. We surface ALL built-in roles
  // (incl. the hidden baseline 'read-only') as options so an admin can demote to least-privilege;
  // each carries its label + rank for the Select. Single source of truth = lib/rbac.
  const roleOptions: RoleOption[] = effectiveRoles()
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((r) => ({ id: r.id, label: r.label, rank: r.rank, hidden: r.hidden }));

  return (
    <UsersTable
      rows={rows}
      roleOptions={roleOptions}
      adminEmail={admin.email}
      // Cap flags for UX gating (the Server Actions re-check independently). The whole area is
      // admin-gated, so these are all true today — passing them keeps the UI honest if the matrix
      // is later customized.
      canManageLocal={can('admin.users.local', admin.role)}
      canViewAccommodations={can('accommodations.view', admin.role)}
      canEditAccommodations={can('accommodations.edit', admin.role)}
      canPrintOthers={can('itinerary.print.others', admin.role)}
    />
  );
}
