import 'server-only';
import { getDb } from '@/lib/db/mongo';
import { AUTH_COLLECTION } from '@/lib/auth/auth';
import { DEMO_MODE, demoDenied } from '@/lib/db/demo';
import {
  applyOverride,
  effectiveTable,
  validateOverride,
  CAP_IDS,
  type EffectiveTable,
  type OverrideDoc,
  type RoleDef,
} from '@/lib/auth/rbac';

// lib/auth/perms-store.ts — the server-authoritative store for the admin-editable permission OVERRIDE
// (the `__perms__` doc). Faithful to eit_auth's _sync_perms / _h_perms_set / PERMS_ID model:
//
//   • The override lives as a single doc keyed `__perms__` in the `auth` collection (the SAME
//     credential store as `__policy__`/accounts — OFF the data-plane allowlist, so a /db caller can
//     never read or write it). Only this module touches it, server-side.
//   • syncPerms() reads the persisted doc and installs it into rbac (applyOverride). It's called on
//     EVERY request that resolves can()/the table for an admin surface, so the live can() reflects
//     the saved override (the task's "live can() must read the saved override"). applyOverride itself
//     RE-VALIDATES, so a corrupt persisted doc fails closed to defaults — never bricks the matrix.
//   • savePermsOverride()/resetPermsOverride() are the ONLY write paths; the Route Handler gates them
//     (admin + step-up) before calling here. We re-validate here too (defense in depth) so a bad
//     table is never persisted even if a caller reached this function some other way.
//
// LIVE-DB: no cache. Each call is a real round-trip — the Python TTL-caches ~30s purely for the hot
// authz path; here every admin-surface read re-syncs, matching the rewrite's live-DB posture.

const PERMS_ID = '__perms__';

interface PermsSettingsDoc {
  _id: string;
  roles?: RoleDef[];
  grants?: Record<string, string[]>;
  // Python persists snake_case `caps_seen`; we read both so a doc written by either stack installs.
  caps_seen?: string[];
  capsSeen?: string[];
  _reset?: boolean;
  updatedBy?: string;
  updatedAt?: number;
}

/** Map a persisted settings doc (either stack's field casing) to the rbac OverrideDoc shape. */
function toOverride(doc: PermsSettingsDoc | null): OverrideDoc | null {
  if (!doc || doc._reset) return null;
  const capsSeen = doc.capsSeen ?? doc.caps_seen;
  return {
    roles: Array.isArray(doc.roles) ? doc.roles : undefined,
    grants: doc.grants && typeof doc.grants === 'object' ? doc.grants : undefined,
    capsSeen: Array.isArray(capsSeen) ? capsSeen : undefined,
  };
}

/**
 * Read the persisted __perms__ doc and install it into rbac. On ANY store error, leave the current
 * override in place (a flaky store must never silently reset the matrix — mirrors _sync_perms). Call
 * this before reading effectiveTable()/can() on an admin surface so the live decision reflects the
 * saved override. Returns the fresh effective table.
 */
export async function syncPerms(): Promise<EffectiveTable> {
  try {
    const db = await getDb();
    const doc = (await db.collection<PermsSettingsDoc>(AUTH_COLLECTION).findOne({ _id: PERMS_ID })) ?? null;
    applyOverride(toOverride(doc));
  } catch {
    // leave the current override untouched
  }
  return effectiveTable();
}

export interface SavePermsResult {
  ok: boolean;
  error?: string;
  table?: EffectiveTable;
}

/**
 * Persist + install a customized permission override. The Route Handler MUST have already verified
 * admin + a fresh step-up before calling this. We re-validate the table (validateOverride — refuses
 * a no-admin-lifeline, empty/duplicate roles, a re-granted structural invariant) so a bad table is
 * never written. On success the doc is stored AND installed (applyOverride), so the next can() uses it.
 */
export async function savePermsOverride({
  roles,
  grants,
  capsSeen,
  actorEmail,
}: {
  roles: RoleDef[];
  grants: Record<string, string[]>;
  capsSeen?: string[];
  actorEmail: string;
}): Promise<SavePermsResult> {
  if (DEMO_MODE) return demoDenied('Permissions');
  const seen = Array.isArray(capsSeen) && capsSeen.length ? capsSeen : CAP_IDS.slice();
  const candidate: OverrideDoc = { roles, grants, capsSeen: seen };
  const [valid, err] = validateOverride(candidate);
  if (!valid) return { ok: false, error: err };

  const now = Date.now();
  const doc: PermsSettingsDoc = {
    _id: PERMS_ID,
    roles,
    grants,
    caps_seen: seen, // snake_case so a doc written here also loads under the Python reader
    updatedBy: String(actorEmail || '').trim().toLowerCase(),
    updatedAt: now,
  };
  try {
    const db = await getDb();
    await db.collection<PermsSettingsDoc>(AUTH_COLLECTION).updateOne({ _id: PERMS_ID }, { $set: doc }, { upsert: true });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'failed to persist the permission table' };
  }
  applyOverride(candidate);
  return { ok: true, table: effectiveTable() };
}

/**
 * Revert to the seeded defaults: persist a bare reset marker doc (so the cleared state replicates to
 * peers) and clear the in-process override. Mirrors _h_perms_set's reset branch.
 */
export async function resetPermsOverride(actorEmail: string): Promise<SavePermsResult> {
  if (DEMO_MODE) return demoDenied('Permissions');
  const now = Date.now();
  try {
    const db = await getDb();
    await db.collection<PermsSettingsDoc>(AUTH_COLLECTION).updateOne(
      { _id: PERMS_ID },
      {
        $set: { _id: PERMS_ID, _reset: true, updatedBy: String(actorEmail || '').trim().toLowerCase(), updatedAt: now },
        $unset: { roles: '', grants: '', caps_seen: '', capsSeen: '' },
      },
      { upsert: true }
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'failed to reset the permission table' };
  }
  applyOverride(null);
  return { ok: true, table: effectiveTable() };
}
