'use server';

import { revalidatePath } from 'next/cache';
import { requireUser, type CurrentUser } from '@/lib/auth';
import { getDb, NOT_DELETED } from '@/lib/mongo';
import { clampThemeId } from '@/lib/themes';
import {
  ACCOMMODATION_DIETARY,
  ACCOMMODATION_ACCESSIBILITY,
  ACCOMMODATION_SEVERITY,
} from '@/lib/accommodations';
import type { UserDoc, AccommodationsProfile, EmergencyContact } from '@/lib/types';

// app/account/actions.ts — the SELF-SCOPED Account & Preferences writes.
//
// SECURITY / SCOPING (this is the user editing their OWN directory record — explicitly designed so
// it can NEVER touch anyone else's record nor the privileged fields):
//   • requireUser() gates every action: an unauthenticated caller is redirected to /login. There is
//     no role check beyond "signed in" — read-only is the floor and may manage its own account
//     (lib/rbac DEFAULT_ROLES: read-only "manages only their own account").
//   • TARGET IS ALWAYS THE SESSION EMAIL. The write _id is the caller's OWN session email
//     (user.email), never a value the client supplies — there is no targetEmail parameter. A crafted
//     post cannot redirect the write to another user's `users` doc.
//   • SCALAR _id PIN. The _id filter is String()-coerced (the Mongo NoSQL-operator defense) so a
//     session subject can never become a {$ne:…} filter.
//   • NARROW, PER-TAB WRITES (the #37 tab-scoping rule). Each action $sets ONLY the field set THAT
//     tab owns — Profile writes preferredName/picture; Preferences writes unitPrefs/portOfCall —
//     never role, never lastLoginAt, never the other tab's fields. We $set into payload.* so a
//     concurrent writer's sibling fields (and the OTHER tab's fields) are preserved; a save can
//     neither clobber the other tab nor escalate the caller's role.
//   • This deliberately does NOT use lib/write (whose helpers are the admin/event/case surfaces with
//     their own gates) — the self-account write is its own minimal, auditable path.
//
// Mirrors index.html AccountProfileTab.onSave / AccountDisplayTab.onSave (the #37-scoped patches)
// and the server /auth/profile endpoint that persists the photo + preferred name to the synced
// `users` record so every instance reads it back.

const USERS_COLLECTION = 'users';

export interface AccountSaveResult {
  ok?: boolean;
  error?: string;
}

// ── shared: load the caller + their OWN directory doc, pinned to the session email ──
async function loadSelf(): Promise<{ user: CurrentUser; id: string } | { error: string }> {
  let user: CurrentUser;
  try {
    user = await requireUser();
  } catch {
    // requireUser redirects an unauthenticated caller; a thrown error here is unexpected — fail closed.
    return { error: 'You must be signed in to update your account.' };
  }
  const id = String(user.email).trim().toLowerCase();
  if (!id) return { error: 'Your session is missing an email — sign in again.' };
  return { user, id };
}

// ── PROFILE TAB ─────────────────────────────────────────────────────────────────────────
// Owns ONLY: preferredName, picture. A 256px-square JPEG data URL is produced client-side; we
// store it verbatim (it syncs wherever the users directory does). Both fields normalize an empty
// value to null (= "fall back to name/initials"), matching the current app.

export interface ProfilePatchInput {
  preferredName?: string;
  /** A data: URL (resized client-side) or '' to clear. */
  picture?: string;
  /** The sensitive accommodations profile (self-write). Optional — absent leaves it untouched. */
  accommodations?: unknown;
}

// Guard the stored photo: only accept a data:image/* URL (what the client produces) or empty.
// A non-data URL or an oversized blob is rejected so this path can't be used to store an arbitrary
// remote URL or bloat the doc. 1 MB of base64 comfortably holds the 256px JPEG.
const MAX_PICTURE_LEN = 1_000_000;
function sanitizePicture(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(s)) return null;
  if (s.length > MAX_PICTURE_LEN) return null;
  return s;
}

// Sanitize the accommodations profile the client posts: clamp the option lists to the known sets,
// bound free-text, cap the emergency-contact array, and STAMP a fresh updatedAt server-side. Returns
// undefined when the input isn't an object (the caller then doesn't $set accommodations at all, so a
// Profile save without the editor never touches it). This is sensitive PII, but it is the user's OWN
// record — the only mutation path is self.
const ACC_DIETARY = new Set(ACCOMMODATION_DIETARY);
const ACC_ACCESS = new Set(ACCOMMODATION_ACCESSIBILITY);
const ACC_SEV = new Set<string>(ACCOMMODATION_SEVERITY);
const MAX_TEXT = 2000;
const MAX_CONTACTS = 10;
function clampText(v: unknown, max = MAX_TEXT): string {
  return (typeof v === 'string' ? v : '').trim().slice(0, max);
}
function sanitizeAccommodations(raw: unknown): AccommodationsProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw as Record<string, unknown>;
  const dietary = Array.isArray(a.dietary)
    ? a.dietary.filter((x): x is string => typeof x === 'string' && ACC_DIETARY.has(x))
    : [];
  const accessibility = Array.isArray(a.accessibility)
    ? a.accessibility.filter((x): x is string => typeof x === 'string' && ACC_ACCESS.has(x))
    : [];
  const allergyRaw = (a.allergies ?? {}) as Record<string, unknown>;
  const sev = typeof allergyRaw.severity === 'string' && ACC_SEV.has(allergyRaw.severity)
    ? allergyRaw.severity
    : 'mild';
  const allergies = { text: clampText(allergyRaw.text, 500), severity: sev };
  const contactsRaw = Array.isArray(a.emergencyContacts) ? a.emergencyContacts : [];
  const emergencyContacts: EmergencyContact[] = contactsRaw
    .slice(0, MAX_CONTACTS)
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

export async function saveProfileAction(patch: ProfilePatchInput): Promise<AccountSaveResult> {
  const self = await loadSelf();
  if ('error' in self) return self;
  const { id } = self;

  const preferredName = typeof patch?.preferredName === 'string' ? patch.preferredName.trim() : '';
  const picture = sanitizePicture(patch?.picture);
  const accommodations = sanitizeAccommodations(patch?.accommodations);

  const now = Date.now();
  // NARROW WRITE — ONLY this tab's fields (preferredName / picture / accommodations). Empty → null so
  // the avatar/name fall back to defaults. accommodations is only $set when the editor posted an
  // object (a no-touch Profile save leaves it untouched — never nulls another tab's data either).
  const set: Record<string, unknown> = {
    'payload.preferredName': preferredName || null,
    'payload.picture': picture, // null clears
    'payload.email': id, // keep the flat email in lockstep (backfill if missing); never role
    'payload.updatedAt': now,
    updatedAt: now,
  };
  if (accommodations) set['payload.accommodations'] = accommodations;

  try {
    const db = await getDb();
    const res = await db
      .collection<UserDoc>(USERS_COLLECTION)
      .updateOne({ _id: id, ...NOT_DELETED }, { $set: set }, { upsert: true });
    if (res.matchedCount === 0 && res.upsertedCount === 0) {
      return { error: 'Could not save your profile — try again.' };
    }
    // Live-DB: the top bar (name/avatar) + the account page read the directory back.
    revalidatePath('/account');
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch {
    return { error: 'Save failed — the directory was unreachable.' };
  }
}

// ── PREFERENCES TAB ─────────────────────────────────────────────────────────────────────
// Owns ONLY: unitPrefs (temperature / weight / dateFormat) + portOfCall (airport / trainStation).
// Never touches preferredName/picture/role — so saving Preferences can't wipe the Profile tab's
// fields (the #37 regression class).

const TEMPS = new Set(['F', 'C']);
const WEIGHTS = new Set(['lbs', 'kg']);
const DATE_FORMATS = new Set(['auto', 'mdy', 'dmy', 'ymd']);

export interface PreferencesPatchInput {
  temperature?: string;
  weight?: string;
  dateFormat?: string;
  airport?: string;
  trainStation?: string;
  uiTheme?: string;
  homeWarehouseId?: string;
}

export async function savePreferencesAction(
  patch: PreferencesPatchInput
): Promise<AccountSaveResult> {
  const self = await loadSelf();
  if ('error' in self) return self;
  const { id } = self;

  // Clamp every field to a known value (fail to the safe default, never write a forged token).
  const temperature = TEMPS.has(String(patch?.temperature)) ? String(patch.temperature) : 'F';
  const weight = WEIGHTS.has(String(patch?.weight)) ? String(patch.weight) : 'lbs';
  const dateFormat = DATE_FORMATS.has(String(patch?.dateFormat))
    ? String(patch.dateFormat)
    : 'auto';
  const airport = typeof patch?.airport === 'string' ? patch.airport.trim() : '';
  const trainStation = typeof patch?.trainStation === 'string' ? patch.trainStation.trim() : '';
  // An empty port-of-call normalizes to null (matches AccountDisplayTab.onSave).
  const portOfCall = airport || trainStation ? { airport, trainStation } : null;
  // #66: the theme id is clamped to a known theme; an empty/unknown home-warehouse normalizes to null
  // ("show all warehouses"). Both are owned by THIS (Preferences) tab — the #37 tab-scoping rule —
  // so saving Preferences never clobbers the Profile tab's name/photo/accommodations.
  const uiTheme = clampThemeId(patch?.uiTheme);
  const homeWarehouseId =
    typeof patch?.homeWarehouseId === 'string' && patch.homeWarehouseId.trim()
      ? patch.homeWarehouseId.trim()
      : null;

  const now = Date.now();
  const set: Record<string, unknown> = {
    'payload.unitPrefs': { temperature, weight, dateFormat },
    'payload.portOfCall': portOfCall,
    'payload.uiTheme': uiTheme,
    'payload.homeWarehouseId': homeWarehouseId,
    'payload.email': id,
    'payload.updatedAt': now,
    updatedAt: now,
  };

  try {
    const db = await getDb();
    const res = await db
      .collection<UserDoc>(USERS_COLLECTION)
      .updateOne({ _id: id, ...NOT_DELETED }, { $set: set }, { upsert: true });
    if (res.matchedCount === 0 && res.upsertedCount === 0) {
      return { error: 'Could not save your preferences — try again.' };
    }
    revalidatePath('/account');
    // The saved theme is applied app-wide on the next render via the boot script — refresh the layout.
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch {
    return { error: 'Save failed — the directory was unreachable.' };
  }
}
