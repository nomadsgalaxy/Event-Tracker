'use server';

import { revalidatePath } from 'next/cache';
import { requireRole, type CurrentUser } from '@/lib/auth/auth';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import {
  adminCreateLocalAccount,
  adminResetPassword,
  adminConvertToOauth,
  adminConvertToLocal,
  adminClear2fa,
  deleteDirectoryUser,
  AdminActionError,
} from '@/lib/auth/auth-store';
import { can } from '@/lib/auth/rbac';
import { writeAudit } from '@/lib/db/data';
import {
  ACCOMMODATION_DIETARY,
  ACCOMMODATION_ACCESSIBILITY,
  ACCOMMODATION_SEVERITY,
} from '@/lib/views/accommodations';
import { createTag, saveTag, deleteTag, WriteForbiddenError, type TagPatch } from '@/lib/db/write';
import { DEMO_MODE, demoDenied } from '@/lib/db/demo';
import type { UserDoc, AccommodationsProfile, EmergencyContact } from '@/lib/types/types';

// app/config/admin-actions.ts — the Config > Users + Tags privilege-management Server Actions.
//
// SECURITY (this is the admin-provisioning surface — explicitly built to be red-teamed):
//   • requireRole('admin') is the COARSE pre-gate on EVERY action: an unauthenticated caller is
//     redirected to /login, an authed non-admin is bounced with a Forbidden before any work runs.
//     Server Actions are POST endpoints gated by this on every invocation — there is no client-trust
//     path, and the whole /config area is already admin-gated by the layout (defense in depth).
//   • The actor is ALWAYS the SESSION email (admin.user.email from requireRole) — never a client value.
//     The lib/auth-store helpers re-resolve the LIVE role and re-assert admin independently, and the
//     self-target refusals (delete-self) pin to this session email.
//   • These actions NEVER write `role` — role assignment stays in changeUserRoleAction → setUserRole
//     (the separately red-teamed role-raise-guarded path). A created account defaults to least
//     privilege; a higher role is a separate explicit role assignment.
//   • Every action logs to the server audit trail (writeAudit) — actor + action + target, mirroring
//     the Python _audit calls — so the change is reviewable in Config > Audit.

const USERS_COLLECTION = 'users';

export interface AdminResult {
  ok?: boolean;
  error?: string;
}

/** Map an AdminActionError / WriteForbiddenError into a friendly result so the client toasts rather
 *  than 500s. requireRole throws for an under-privileged caller — caught + surfaced the same way. */
function toResult(err: unknown): AdminResult {
  if (err instanceof AdminActionError || err instanceof WriteForbiddenError) return { error: err.message };
  return { error: err instanceof Error ? err.message : 'The action failed.' };
}

async function gateAdmin(): Promise<{ user: CurrentUser } | { error: string }> {
  try {
    return { user: await requireRole('admin') };
  } catch {
    return { error: 'An admin session is required.' };
  }
}

// ── Add user (directory entry + OPTIONAL local sign-in account) ─────────────────────────────────
export interface AddUserInput {
  email: string;
  name?: string;
  role?: string;
  /** When true, also create a LOCAL sign-in account with the temp password (forced rotation + 2FA). */
  createLocal?: boolean;
  tempPassword?: string;
}

export async function addUserAction(input: AddUserInput): Promise<AdminResult> {
  const admin = await gateAdmin();
  if ('error' in admin) return admin;

  const email = String(input?.email ?? '').trim().toLowerCase();
  const name = String(input?.name ?? '').trim();
  const role = String(input?.role ?? 'read-only').trim().toLowerCase();
  if (!email || !email.includes('@')) return { error: 'A valid email is required.' };

  try {
    if (input?.createLocal) {
      // Create a local credential account (temp pw + forced rotation + 2FA). adminCreateLocalAccount
      // also provisions the directory record + clamps the role to least-privilege by default.
      await adminCreateLocalAccount({
        targetEmail: email,
        name,
        role,
        tempPassword: String(input?.tempPassword ?? ''),
        twofaRequired: true,
        actorEmail: admin.user.email,
      });
      await writeAudit({ actor: admin.user.email, action: 'account.provision', target: email, detail: { role, local: true } });
    } else {
      // No password ⇒ an OAuth-only (oidc:google) account by default: they sign in via Google, never a
      // password. We set the directory source + provision a credential-less, ssoProvisioned auth record
      // (pw:null) so the account is classified OAuth-only immediately — never a credential, never escalation.
      const db = await getDb();
      const existing = await db.collection<UserDoc>(USERS_COLLECTION).findOne({ _id: email });
      const payloadDeleted = (existing?.payload as { deletedAt?: number | null } | undefined)?.deletedAt;
      if (existing && !existing.deletedAt && !payloadDeleted) {
        return { error: 'That user is already in the directory.' };
      }
      const now = Date.now();
      // Role defaults to least-privilege; a non-builtin string is left for the role <select> to fix —
      // but we never write an admin role implicitly here (the <select> uses the role-raise-guarded path).
      const safeRole = ['read-only', 'authorized', 'technician', 'lead', 'manager', 'admin'].includes(role) ? role : 'read-only';
      await db.collection<UserDoc>(USERS_COLLECTION).updateOne(
        { _id: email },
        {
          $set: {
            'payload.email': email,
            'payload.name': name || email,
            'payload.role': safeRole,
            'payload.source': 'oidc:google',
            'payload.updatedAt': now,
            // Clear a prior tombstone if this re-adds a soft-deleted user.
            'payload.deletedAt': null,
            deletedAt: null,
            updatedAt: now,
          },
          $setOnInsert: { _id: email, createdAt: now },
        },
        { upsert: true }
      );
      // Mark the credential side OAuth-only (no password) so login + the Users table classify it right.
      await db.collection<{ _id: string }>('auth').updateOne(
        { _id: email },
        { $set: { source: 'oidc:google', pw: null, ssoProvisioned: true, updatedAt: now }, $setOnInsert: { _id: email, role: safeRole, createdAt: now } },
        { upsert: true }
      );
      await writeAudit({ actor: admin.user.email, action: 'account.provision', target: email, detail: { role: safeRole, local: false, oauthOnly: true } });
    }
    revalidatePath('/config');
    revalidatePath('/config/audit');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

// ── Inline-edit a user's display name (click-to-edit on the row) ─────────────────────────────────
// Writes ONLY payload.name (+ keeps the flat email in lockstep). Never role/PII. This is the Config
// admin editing the directory name — distinct from the user's OWN preferredName (self-account path).
export async function renameUserAction(targetEmail: string, name: string): Promise<AdminResult> {
  if (DEMO_MODE) return demoDenied('User management');
  const admin = await gateAdmin();
  if ('error' in admin) return admin;
  const email = String(targetEmail ?? '').trim().toLowerCase();
  const next = String(name ?? '').trim();
  if (!email) return { error: 'Missing target user.' };
  try {
    const db = await getDb();
    const now = Date.now();
    const res = await db.collection<UserDoc>(USERS_COLLECTION).updateOne(
      { _id: email, ...NOT_DELETED },
      { $set: { 'payload.name': next || email, 'payload.email': email, 'payload.updatedAt': now, updatedAt: now } }
    );
    if (res.matchedCount === 0) return { error: 'That user is not in the directory.' };
    await writeAudit({ actor: admin.user.email, action: 'account.rename', target: email });
    revalidatePath('/config');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

// ── Delete a user (offboard) ────────────────────────────────────────────────────────────────────
export async function deleteUserAction(targetEmail: string): Promise<AdminResult> {
  const admin = await gateAdmin();
  if ('error' in admin) return admin;
  try {
    await deleteDirectoryUser({ targetEmail, actorEmail: admin.user.email });
    await writeAudit({ actor: admin.user.email, action: 'account.delete', target: String(targetEmail).trim().toLowerCase() });
    revalidatePath('/config');
    revalidatePath('/config/audit');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

// ── Reset / set a local password (+ optionally clear 2FA) ────────────────────────────────────────
export async function resetPasswordAction(
  targetEmail: string,
  tempPassword: string,
  clear2fa = true
): Promise<AdminResult> {
  const admin = await gateAdmin();
  if ('error' in admin) return admin;
  try {
    const res = await adminResetPassword({ targetEmail, tempPassword, clear2fa, actorEmail: admin.user.email });
    await writeAudit({ actor: admin.user.email, action: 'account.admin_reset', target: res.email, detail: { cleared2fa: res.cleared2fa } });
    revalidatePath('/config');
    revalidatePath('/config/audit');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

// ── Convert account type (local XOR oauth) ─────────────────────────────────────────────────────────
/** Default a user back to OAuth-only: clears the password so the login offers Google again (fixes an
 *  SSO user who got a stray password). Keeps their Google binding + passkeys. */
export async function convertToOauthAction(targetEmail: string): Promise<AdminResult> {
  const admin = await gateAdmin();
  if ('error' in admin) return admin;
  try {
    const res = await adminConvertToOauth({ targetEmail, actorEmail: admin.user.email });
    await writeAudit({ actor: admin.user.email, action: 'account.convert_oauth', target: res.email });
    revalidatePath('/config');
    revalidatePath('/config/audit');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

/** Convert a user to a local password account: sets a temp password (force-change) + removes OAuth. */
export async function convertToLocalAction(targetEmail: string, tempPassword: string): Promise<AdminResult> {
  const admin = await gateAdmin();
  if ('error' in admin) return admin;
  try {
    const res = await adminConvertToLocal({ targetEmail, tempPassword, actorEmail: admin.user.email });
    await writeAudit({ actor: admin.user.email, action: 'account.convert_local', target: res.email });
    revalidatePath('/config');
    revalidatePath('/config/audit');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

// ── Clear 2FA (standalone) ───────────────────────────────────────────────────────────────────────
export async function clear2faAction(targetEmail: string): Promise<AdminResult> {
  const admin = await gateAdmin();
  if ('error' in admin) return admin;
  try {
    const res = await adminClear2fa({ targetEmail, actorEmail: admin.user.email });
    await writeAudit({ actor: admin.user.email, action: 'account.clear_2fa', target: res.email });
    revalidatePath('/config');
    revalidatePath('/config/audit');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

// ── Per-user accommodations (PII) — view + edit, gated by accommodations.* ───────────────────────
// The Config Users tab is admin-gated, so an admin passes accommodations.view/edit by rank. We STILL
// re-assert the cap with can() (defense in depth + so a future non-admin grant of this surface is
// honored). The sanitizer clamps the option lists + bounds free-text + caps the contacts array, the
// SAME boundary the self-account write uses. $set ONLY payload.accommodations — never role/name/PII-
// adjacent fields.
const ACC_DIETARY = new Set(ACCOMMODATION_DIETARY);
const ACC_ACCESS = new Set(ACCOMMODATION_ACCESSIBILITY);
const ACC_SEV = new Set<string>(ACCOMMODATION_SEVERITY);
function clampText(v: unknown, max = 2000): string {
  return (typeof v === 'string' ? v : '').trim().slice(0, max);
}
function sanitizeAccommodations(raw: unknown): AccommodationsProfile {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const dietary = Array.isArray(a.dietary)
    ? a.dietary.filter((x): x is string => typeof x === 'string' && ACC_DIETARY.has(x))
    : [];
  const accessibility = Array.isArray(a.accessibility)
    ? a.accessibility.filter((x): x is string => typeof x === 'string' && ACC_ACCESS.has(x))
    : [];
  const allergyRaw = (a.allergies ?? {}) as Record<string, unknown>;
  const sev = typeof allergyRaw.severity === 'string' && ACC_SEV.has(allergyRaw.severity) ? allergyRaw.severity : 'mild';
  const allergies = { text: clampText(allergyRaw.text, 500), severity: sev };
  const contactsRaw = Array.isArray(a.emergencyContacts) ? a.emergencyContacts : [];
  const emergencyContacts: EmergencyContact[] = contactsRaw
    .slice(0, 10)
    .map((c) => {
      const cc = (c ?? {}) as Record<string, unknown>;
      return {
        name: clampText(cc.name, 200),
        relationship: clampText(cc.relationship, 120),
        phone: clampText(cc.phone, 60),
        email: clampText(cc.email, 200),
      };
    })
    .filter((c) => c.name || c.relationship || c.phone || c.email);
  return {
    dietary,
    accessibility,
    allergies,
    medical: clampText(a.medical),
    notes: clampText(a.notes),
    emergencyContacts,
    emergencyContact: emergencyContacts[0] || { name: '', relationship: '', phone: '', email: '' },
    updatedAt: Date.now(),
  };
}

export interface AccommodationsResult extends AdminResult {
  accommodations?: AccommodationsProfile | null;
}

/** Read another user's accommodations (admin Users tab). Gated by accommodations.view. */
export async function getUserAccommodationsAction(targetEmail: string): Promise<AccommodationsResult> {
  const admin = await gateAdmin();
  if ('error' in admin) return admin;
  if (!can('accommodations.view', admin.user.role)) return { error: 'You do not have permission to view accommodations.' };
  const email = String(targetEmail ?? '').trim().toLowerCase();
  if (!email) return { error: 'Missing target user.' };
  try {
    const db = await getDb();
    const doc = await db
      .collection<UserDoc>(USERS_COLLECTION)
      .findOne({ _id: email }, { projection: { 'payload.accommodations': 1 } });
    const acc = (doc?.payload as { accommodations?: AccommodationsProfile } | undefined)?.accommodations ?? null;
    return { ok: true, accommodations: acc };
  } catch (err) {
    return toResult(err);
  }
}

/** Write another user's accommodations (admin Users tab). Gated by accommodations.edit. */
export async function saveUserAccommodationsAction(targetEmail: string, raw: unknown): Promise<AdminResult> {
  if (DEMO_MODE) return demoDenied('Accommodations');
  const admin = await gateAdmin();
  if ('error' in admin) return admin;
  if (!can('accommodations.edit', admin.user.role)) return { error: 'You do not have permission to edit accommodations.' };
  const email = String(targetEmail ?? '').trim().toLowerCase();
  if (!email) return { error: 'Missing target user.' };
  const accommodations = sanitizeAccommodations(raw);
  try {
    const db = await getDb();
    const now = Date.now();
    const res = await db.collection<UserDoc>(USERS_COLLECTION).updateOne(
      { _id: email, ...NOT_DELETED },
      { $set: { 'payload.accommodations': accommodations, 'payload.email': email, 'payload.updatedAt': now, updatedAt: now } }
    );
    if (res.matchedCount === 0) return { error: 'That user is not in the directory.' };
    await writeAudit({ actor: admin.user.email, action: 'accommodations.edit', target: email });
    revalidatePath('/config');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// TAGS — the tag library CRUD (Config > Tags). Gated by tags.edit / tags.delete in lib/write.
// These are NOT admin-only (manager+ can edit) but the Config area is admin-gated, so in practice an
// admin runs them; the write helpers enforce the real cap independently.
// ════════════════════════════════════════════════════════════════════════════════════════════
export interface TagCreateResult extends AdminResult {
  id?: string;
  duplicate?: boolean;
}

export async function createTagAction(input: {
  label: string;
  hidden?: boolean;
  color?: string | null;
  flair?: string | null;
  customEmoji?: string;
}): Promise<TagCreateResult> {
  const admin = await gateAdmin();
  if ('error' in admin) return admin;
  try {
    const res = await createTag({ ...input, actorEmail: admin.user.email, actorRole: admin.user.role });
    revalidatePath('/config/tags');
    return { ok: true, id: res.id, duplicate: res.duplicate };
  } catch (err) {
    return toResult(err);
  }
}

export async function saveTagAction(id: string, patch: TagPatch): Promise<AdminResult> {
  const admin = await gateAdmin();
  if ('error' in admin) return admin;
  try {
    await saveTag({ id, patch, actorEmail: admin.user.email, actorRole: admin.user.role });
    revalidatePath('/config/tags');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

export interface TagDeleteResult extends AdminResult {
  eventUses?: number;
  itemUses?: number;
}

export async function deleteTagAction(id: string): Promise<TagDeleteResult> {
  const admin = await gateAdmin();
  if ('error' in admin) return admin;
  try {
    const res = await deleteTag({ id, actorEmail: admin.user.email, actorRole: admin.user.role });
    revalidatePath('/config/tags');
    return { ok: true, eventUses: res.eventUses, itemUses: res.itemUses };
  } catch (err) {
    return toResult(err);
  }
}
