// lib/auth/rbac.ts — the SINGLE SOURCE OF TRUTH for Event Tracker authorization in the
// Next.js stack. A faithful TypeScript port of server/eit_perms.py: the role/rank
// model, the capability registry, and can(cap, role, ctx).
//
// PURE + ISOMORPHIC: no I/O, no `server-only`. Usable from a Server Component, a
// Server Action, middleware, AND a Client Component for UI gating — both sides
// evaluate the SAME table so they can never drift (the whole point of eit_perms).
//
// SCOPE NOTE: the Python module also supports an admin-editable per-org override
// (the `__perms__` doc) that remaps the matrix at runtime. That is a LATER wave for
// this rewrite (it needs the admin console + the auth-collection settings store).
// The seam is here — see applyOverride()/effectiveGrants() — but with no override
// installed this evaluates byte-for-byte the seeded DEFAULT matrix, identical to a
// fresh eit_perms install. Do NOT widen this without porting validateOverride too.

import type { Role } from '@/lib/types/types';

// ── Roles (seeded defaults) ─────────────────────────────────────────────────────────
// rank orders privilege low->high and seeds the default grant matrix (a role holds every
// capability whose minRank <= its rank). Ranks: read-only 0, authorized 1, technician 2,
// lead 3, manager 4, admin 5. 'technician' sits between authorized and lead — it holds the
// inventory/sign-off tier (minRank 2) but NOT the manager tier (minRank 4: events, PII).
// When 'technician' was inserted, lead/manager/admin shifted up one and every cap minRank
// that was 3 (manager) became 4 and 4 (admin) became 5, so the existing roles keep their
// exact capabilities.
export interface RoleDef {
  id: string;
  rank: number;
  label: string;
  color: string;
  hidden: boolean;
  builtin: boolean;
  desc: string;
}

export const DEFAULT_ROLES: readonly RoleDef[] = [
  {
    id: 'read-only',
    rank: 0,
    label: 'Read-only',
    color: 'var(--muted-foreground)',
    hidden: true,
    builtin: true,
    desc: 'Least-privilege baseline (DEFAULT_ROLE). Reads app data + the team directory; manages only their own account, itinerary, API keys and calendar feed. No writes.',
  },
  {
    id: 'authorized',
    rank: 1,
    label: 'Authorized',
    color: 'var(--muted-foreground)',
    hidden: true,
    builtin: true,
    desc: 'Lowest write tier (warehouse worker). Packs/unpacks, assigns cases to pallets, writes general app data. Not the event editor, not PII.',
  },
  {
    id: 'technician',
    rank: 2,
    label: 'Technician',
    color: 'var(--st-unpacking)',
    hidden: false,
    builtin: true,
    desc: 'Inventory technician. Works flagged / out-of-service items: edits inventory, sign-off, loose-item management, label print/adopt, tag apply, pack/unpack. Same inventory powers as a Lead but NO control over events (no create/edit/delete, no travel PII) unless separately made the lead of an event.',
  },
  {
    id: 'lead',
    rank: 3,
    label: 'Lead',
    color: 'var(--success)',
    hidden: false,
    builtin: true,
    desc: "Crew lead. Sign-off, loose-item management, label print/adopt, tag apply; can edit the events they LEAD and see those events' travel/hotel.",
  },
  {
    id: 'manager',
    rank: 4,
    label: 'Manager',
    color: 'var(--st-upcoming)',
    hidden: false,
    builtin: true,
    desc: "Supervisor PII tier. Sees/edits accommodations + emergency contacts + everyone's travel/hotel, edits any event, prints others' itineraries, manages tags.",
  },
  {
    id: 'admin',
    rank: 5,
    label: 'Admin',
    color: 'var(--primary)',
    hidden: false,
    builtin: true,
    desc: 'Full control: user directory + local accounts, admin console, audit log, sync/TLS, integration keys (step-up). Effective-admin emails are force-stamped admin per-site.',
  },
];

// VALID_ROLES — the set of built-in role ids (mirrors eit_auth.VALID_ROLES). The login
// role model resolves to one of these; anything else is clamped to DEFAULT_ROLE.
export const VALID_ROLES: ReadonlySet<string> = new Set(DEFAULT_ROLES.map((r) => r.id));

// DEFAULT_ROLE — least privilege. The fallback whenever a role is missing/invalid.
// (eit_perms read-only rank 0; eit_auth role_for() ultimate fallback.)
export const DEFAULT_ROLE: Role = 'read-only';

// _ROLE_RANK mirror (eit_auth.py:2839). Built from DEFAULT_ROLES so they can't diverge.
const ROLE_RANK: Readonly<Record<string, number>> = Object.fromEntries(
  DEFAULT_ROLES.map((r) => [r.id, r.rank])
);

/** Effective rank for a role id. Unknown role => -1 (below everything), matching
 *  eit_perms._rank_of(). Use this for the coarse rank comparisons the data plane does. */
export function rankOf(role: string | null | undefined): number {
  if (!role) return -1;
  const r = ROLE_RANK[role.trim().toLowerCase()];
  return r === undefined ? -1 : r;
}

/** Normalize an arbitrary stored value into a valid Role, clamping to DEFAULT_ROLE.
 *  Mirrors the client normalizeRole clamp + role_for's "always in VALID_ROLES" guarantee
 *  (the #94 fix: an invalid role like the legacy 'member' must never leak through). */
export function normalizeRole(role: string | null | undefined): Role {
  const r = (role || '').trim().toLowerCase();
  return (VALID_ROLES.has(r) ? r : DEFAULT_ROLE) as Role;
}

// ── Context grants: non-role conditions that also grant a capability ────────────────
export const CTX_SELF = 'self'; // ctx.isSelf — the subject record is the caller's own
export const CTX_LEAD = 'leadOfEvent'; // ctx.isLeadOfEvent — the caller leads the event in ctx
export type CtxGrant = typeof CTX_SELF | typeof CTX_LEAD;

/** Context for a can() decision. Mirrors eit_perms ctx keys. */
export interface AuthzCtx {
  isSelf?: boolean;
  isLeadOfEvent?: boolean;
}

// Capability groups (for an admin UI layout + docs).
const G_EVENT = 'Events';
const G_INV = 'Inventory & tags';
const G_PII = 'Personal data (PII)';
const G_ADMIN = 'Administration';
const G_SELF = 'Self-service';
const G_STRUCT = 'Structural invariants (not editable)';

// ── Capability registry ─────────────────────────────────────────────────────────────
// Each capability carries a default grant rule (a minimum rank) + optional CONTEXT grants
// + an `editable` flag. `minRank` seeds the default matrix (role holds it when role.rank >=
// minRank). `editable=false` capabilities are documented structural invariants.
export interface CapDef {
  id: string;
  label: string;
  desc: string;
  group: string;
  minRank: number;
  ctx: readonly CtxGrant[];
  editable: boolean;
  enforced: 'both' | 'server' | 'client';
  note: string;
}

function cap(
  id: string,
  label: string,
  desc: string,
  group: string,
  minRank: number,
  opts: { ctx?: CtxGrant[]; editable?: boolean; enforced?: 'both' | 'server' | 'client'; note?: string } = {}
): CapDef {
  return {
    id,
    label,
    desc,
    group,
    minRank,
    ctx: opts.ctx ?? [],
    editable: opts.editable ?? true,
    enforced: opts.enforced ?? 'both',
    note: opts.note ?? '',
  };
}

export const CAP_LIST: readonly CapDef[] = [
  // ── Events ──────────────────────────────────────────────────────────────────────
  cap('event.create', 'Create an event', 'Spin up a new event.', G_EVENT, 4, {
    note: 'Default manager+: managers set events up and assign a lead. Editable.',
  }),
  cap('event.edit', 'Edit an event', 'Open the full event editor and write the event doc.', G_EVENT, 4, {
    ctx: [CTX_LEAD],
    note: 'manager+ OR the LEAD of this event. Tightened from the legacy authorized+ so warehouse workers can\'t edit events; they still assign cases via pallets.edit. (#165)',
  }),
  cap('event.delete', 'Delete an event', 'Soft-delete an event (tombstone replicates to peers).', G_EVENT, 4, {
    ctx: [CTX_LEAD],
    note: 'manager+ OR the lead of this event. Was authorized+ with no stricter gate than a field edit — tightened.',
  }),
  cap('pallets.edit', 'Assign cases / edit pallets', 'Add/remove a case to a pallet, edit tracking, reorder.', G_EVENT, 1, {
    note: 'authorized+: the case-assignment path warehouse workers use from outside the event editor.',
  }),
  cap('signoff.view', 'Open the sign-off screen', 'See the sign-off / ship-kit screen.', G_EVENT, 2),
  cap('signoff.commit', 'Record a sign-off', 'Commit a sign-off (pack/load) or a shipment leg.', G_EVENT, 2, {
    note: 'lead+, now enforced server-side too (was client-only above an authorized+ write gate).',
  }),
  cap('signoff.revert', 'Revert a sign-off', 'Un-sign-off a record.', G_EVENT, 4),
  cap('scan.pack', 'Pack / unpack / return', 'Scan items into/out of cases.', G_EVENT, 1, {
    note: 'authorized+ by design (#65) so warehouse workers can pack.',
  }),
  cap('scan.label', 'Print labels / adopt code', 'Print QR/Data-Matrix labels; associate a new code with an item.', G_EVENT, 2),
  cap('looseitem.manage', 'Manage loose inventory', 'Add/remove/transfer/absorb hand-carried inventory at an event.', G_EVENT, 2),

  // ── Inventory & tags ─────────────────────────────────────────────────────────────
  cap('tags.apply', 'Apply / remove a tag', 'Tag or untag events and items.', G_INV, 2),
  cap('tags.edit', 'Create / edit tag metadata', 'Create a tag or edit its name/color/flair.', G_INV, 4),
  cap('tags.delete', 'Delete a tag', 'Delete a tag.', G_INV, 4, {
    note: 'Default manager+. The legacy >3-uses-admin-only graduation is a client refinement layered on top.',
  }),

  // ── Personal data (PII) ──────────────────────────────────────────────────────────
  cap('staff.pii.view', 'View staff travel & hotel', "See an event staffer's flights and lodging (per-event PII).", G_PII, 4, {
    ctx: [CTX_SELF, CTX_LEAD],
    note: 'manager+ OR self OR the lead of this event. Server-enforced gate — was client-display-only. (#164)',
  }),
  cap('accommodations.view', 'View accommodations', "See a person's dietary / accessibility / allergies / medical / emergency contact.", G_PII, 4, {
    ctx: [CTX_SELF],
    note: 'manager+ OR self. NOT lead — medical/dietary is more sensitive than logistics.',
  }),
  cap('accommodations.edit', 'Edit accommodations', "Write a person's accommodations profile.", G_PII, 4, {
    ctx: [CTX_SELF],
    note: 'manager+ OR self.',
  }),
  cap('emergency_contact.read', 'Read emergency/shipping contact', 'Read the global emergency_contact collection.', G_PII, 4),
  cap('emergency_contact.write', 'Write emergency/shipping contact', 'Write the global emergency_contact collection.', G_PII, 4),
  cap('itinerary.print.others', "Print others' itineraries", "Print another staffer's travel itinerary.", G_PII, 4, {
    note: 'manager+. Subject PII flows through staff.pii.view, so this stays consistent.',
  }),
  cap('calendar.global', 'Global calendar feed', 'Subscribe to the global operational-schedule .ics feed.', G_PII, 4, {
    note: "manager+; the owner's live role is re-checked on every fetch server-side.",
  }),

  // ── Administration ───────────────────────────────────────────────────────────────
  cap('admin.users.directory', 'User directory panel', 'Config > Users: list, edit, reset, delete users.', G_ADMIN, 5),
  cap('users.role.assign', 'Assign user roles', "Change a user's role in the directory.", G_ADMIN, 4, {
    note: 'manager+, BUT never assign a role ABOVE your own rank (role-raise guard — see canGrantRole).',
  }),
  cap('admin.console', 'Admin console', 'Config > Admin console: admin allowlist, permitted domains, company map.', G_ADMIN, 5, {
    editable: false,
    note: 'Admin-only invariant: the capability that defines who is an admin; making it role-editable could brick the install.',
  }),
  cap('admin.users.local', 'Local account CRUD', 'Create / reset-password / delete local email+password accounts.', G_ADMIN, 5),
  cap('audit.view', 'View audit log', 'Config > Audit log + GET /auth/audit.', G_ADMIN, 5),
  cap('sync.monitor', 'Sync + VPN monitor', 'Config > Sync monitor + Nebula VPN panel.', G_ADMIN, 5),
  cap('integration.keys', 'Edit integration keys', 'Edit OAuth/Sheets/Calendar/flight/shipping keys (requires step-up).', G_ADMIN, 5, {
    ctx: [CTX_SELF],
    editable: false,
    note: 'Admin + a fresh password step-up. Invariant.',
  }),
  cap('tls.manage', 'Manage TLS certs', 'Import/generate TLS certificates.', G_ADMIN, 5, { editable: false }),

  // ── Self-service (always granted to the caller's own record; not role-editable) ──
  cap('account.self', 'Own account screen', 'Profile / security / prefs / own accommodations self-edit.', G_SELF, 0, {
    ctx: [CTX_SELF],
    editable: false,
  }),
  cap('itinerary.print.self', 'Print own itinerary', 'Print your own travel itinerary.', G_SELF, 0, {
    ctx: [CTX_SELF],
    editable: false,
  }),
  cap('apikeys.self', 'Manage own API keys', 'List/create/revoke your own API keys (create needs local pw + step-up).', G_SELF, 0, {
    ctx: [CTX_SELF],
    editable: false,
  }),
  cap('calendar.personal', 'Own calendar feed', 'Your personal .ics feed + token management.', G_SELF, 0, {
    ctx: [CTX_SELF],
    editable: false,
  }),

  // ── Structural invariants (documented; NOT editable) ─────────────────────────────
  cap('db.read.session', 'Data-plane read', 'Read app data (full session required when enforce is on).', G_STRUCT, 0, {
    editable: false,
    enforced: 'server',
  }),
  cap('db.write.app', 'Data-plane app write', 'Coarse write gate for general app collections.', G_STRUCT, 1, {
    editable: false,
    enforced: 'server',
    note: 'The authorized+ backstop. Fine event/sign-off/PII caps refine this UP per collection/record.',
  }),
  cap('db.collection.allowlist', 'Collection allowlist', "Only app collections are reachable; 'auth' + audit_log are off-limits to every caller incl. admin.", G_STRUCT, 0, {
    editable: false,
    enforced: 'server',
  }),
  cap('db.aggregate.sanitize', 'Aggregate sanitization', 'Forbid cross-collection/write aggregate stages.', G_STRUCT, 0, {
    editable: false,
    enforced: 'server',
  }),
  cap('session.verify', 'Session verification', 'HMAC-verify the session cookie; the trust root.', G_STRUCT, 0, {
    editable: false,
    enforced: 'server',
  }),
  cap('auth.bootstrap', 'Bootstrap first admin', 'Create the first admin when the store is empty (token + effective-admin email gated).', G_STRUCT, 0, {
    editable: false,
    enforced: 'server',
  }),
];

export const CAPS: Readonly<Record<string, CapDef>> = Object.fromEntries(CAP_LIST.map((c) => [c.id, c]));
export const CAP_IDS: readonly string[] = CAP_LIST.map((c) => c.id);

// A typed union of every known capability id — lets `can()` call sites be checked at compile
// time (a typo'd cap is a type error, not a silent always-deny). Derived from CAP_LIST.
export type Capability = (typeof CAP_LIST)[number]['id'];

// Capabilities a role MUST hold for the install to be administrable (mirrors _LIFELINE_CAPS).
// Used by an override validator (later wave); referenced here so the seam is documented.
export const LIFELINE_CAPS: readonly string[] = ['admin.console', 'admin.users.local', 'admin.users.directory'];

// ── Dangerous capabilities (API-key risk gate) ──────────────────────────────────────────────────────
// Caps that grant ADMINISTRATIVE access or the ability to DELETE / destroy data through the /api/v1
// surface. Scoping an API key to ANY of these triggers the create-time "are you sure" confirmation in
// the UI, and the server REQUIRES an explicit risk acknowledgement (lib/api/api-keys.createApiKey) on
// top of the step-up that key creation already needs. The whole Administration group counts; the rest
// are the caps that back a DELETE / destructive endpoint: event/case/inventory/tag deletion, clearing
// the global emergency contact, and reverting a sign-off. Isomorphic — the client picker + the server
// gate evaluate the SAME set so they can't drift.
const DESTRUCTIVE_CAP_IDS: ReadonlySet<string> = new Set([
  'event.delete',
  'tags.delete',
  'pallets.edit',
  'db.write.app',
  'emergency_contact.write',
  'signoff.revert',
]);

/** True iff scoping a key to `cap` grants administrative access or the ability to delete/destroy data. */
export function isDangerousCap(cap: string): boolean {
  const c = CAPS[cap];
  if (!c) return false;
  return c.group === G_ADMIN || DESTRUCTIVE_CAP_IDS.has(cap);
}

/** The administrative/destructive subset of `caps` (drives the create-time confirmation + server gate). */
export function dangerousCaps(caps: readonly string[]): string[] {
  return caps.filter(isDangerousCap);
}

// ── Override seam (admin-editable per-org table) ────────────────────────────────────
// With no override installed, effectiveGrants() returns the pure seeded matrix — identical
// to a fresh eit_perms. The persisted __perms__ doc (lib/perms-store) is read server-side and
// installed via applyOverride(); the wire shape mirrors eit_perms' override doc exactly.
export interface OverrideDoc {
  roles?: RoleDef[];
  grants?: Record<string, string[]>;
  capsSeen?: string[];
  /** A bare reset marker doc ({ _reset:true }) carries no roles/grants → defaults (eit_perms parity). */
  _reset?: boolean;
}
let _override: OverrideDoc | null = null;

/** Install (or clear with null) the admin override. An invalid override is REFUSED (kept null /
 *  prior) so a corrupt persisted doc can never brick the matrix — mirrors eit_perms.set_override. */
export function applyOverride(doc: OverrideDoc | null): void {
  if (doc == null || doc._reset) {
    _override = null;
    return;
  }
  const [ok] = validateOverride(doc);
  _override = ok ? doc : null;
}

/** The currently installed override (or null). For the "customized for this site" indicator. */
export function hasOverride(): boolean {
  return _override !== null;
}

/** The role list — override roles if present, else DEFAULT_ROLES — as fresh copies so a
 *  caller mutating the result can't pollute the defaults (mirrors effective_roles()). */
export function effectiveRoles(): RoleDef[] {
  const src = _override?.roles && _override.roles.length ? _override.roles : DEFAULT_ROLES;
  return src.map((r) => ({ ...r }));
}

/** Seed the matrix by rank: a role holds every capability whose minRank <= its rank
 *  (mirrors _default_grants), then overlay the override if present (mirrors effective_grants:
 *  caps NOT in capsSeen fall back to their seed rule so a NEW cap defaults in). */
export function effectiveGrants(): Record<string, Set<string>> {
  const roles = effectiveRoles();
  const out: Record<string, Set<string>> = {};
  if (!_override || !_override.grants) {
    for (const r of roles) {
      out[r.id] = new Set(CAP_LIST.filter((c) => r.rank >= c.minRank).map((c) => c.id));
    }
    return out;
  }
  const seen = new Set(_override.capsSeen && _override.capsSeen.length ? _override.capsSeen : CAP_IDS);
  const ov = _override.grants;
  for (const r of roles) {
    const granted = new Set<string>();
    const ovSet = new Set(ov[r.id] ?? []);
    for (const c of CAP_LIST) {
      const here = seen.has(c.id) ? ovSet.has(c.id) : r.rank >= c.minRank;
      if (here) granted.add(c.id);
    }
    out[r.id] = granted;
  }
  return out;
}

/**
 * THE one authorization decision (mirrors eit_perms.can). Granted iff a context grant
 * matches (ctx.isSelf / ctx.isLeadOfEvent) OR the role's effective capability set contains
 * `cap`. An UNKNOWN capability => deny (fail closed). Pure + isomorphic.
 *
 * @param cap   capability id (typed against the registry)
 * @param role  the caller's effective role id
 * @param ctx   { isSelf?, isLeadOfEvent? }
 */
export function can(cap: Capability | string, role: string | null | undefined, ctx: AuthzCtx = {}): boolean {
  const spec = CAPS[cap];
  if (!spec) return false; // unknown capability => deny
  if (spec.ctx.includes(CTX_SELF) && ctx.isSelf) return true;
  if (spec.ctx.includes(CTX_LEAD) && ctx.isLeadOfEvent) return true;
  const grants = effectiveGrants();
  const r = normalizeRoleForGrants(role);
  return (grants[r] ?? new Set<string>()).has(cap);
}

// A role lookup for the grant table that tolerates custom override roles (which may not be in
// VALID_ROLES) while still failing closed for an unknown one. Unlike normalizeRole (which
// clamps to a built-in), this preserves a valid override role id so its grants apply.
function normalizeRoleForGrants(role: string | null | undefined): string {
  const r = (role || '').trim().toLowerCase();
  // If the role exists in the effective role list, keep it (so a custom override role's grants
  // apply); else fall back to least privilege. Fails closed for an unknown/empty role.
  return effectiveRoles().some((rd) => rd.id === r) ? r : DEFAULT_ROLE;
}

/** Role-raise guard (capability users.role.assign, divergence #3): you may never set a role
 *  whose rank is ABOVE your own. Mirrors role_can_grant_role. Admin (top rank) may assign any. */
export function canGrantRole(actorRole: string, targetRole: string): boolean {
  const a = rankOf(actorRole);
  const t = rankOf(targetRole);
  return a >= t && t >= 0;
}

// ── The serializable effective table (what the admin Permissions UI edits) ──────────────────
// Mirrors eit_perms.effective_table(): roles + the capability registry (incl. minRank/editable/
// enforced/ctx) + the per-role granted-cap lists + the `customized` flag.
export interface EffectiveTable {
  schemaVersion: number;
  roles: RoleDef[];
  capabilities: {
    id: string;
    label: string;
    desc: string;
    group: string;
    ctx: string[];
    editable: boolean;
    enforced: 'both' | 'server' | 'client';
    note: string;
    minRank: number;
  }[];
  grants: Record<string, string[]>;
  customized: boolean;
}

const SCHEMA_VERSION = 1;

export function effectiveTable(): EffectiveTable {
  const grants = effectiveGrants();
  return {
    schemaVersion: SCHEMA_VERSION,
    roles: effectiveRoles(),
    capabilities: CAP_LIST.map((c) => ({
      id: c.id,
      label: c.label,
      desc: c.desc,
      group: c.group,
      ctx: [...c.ctx],
      editable: c.editable,
      enforced: c.enforced,
      note: c.note,
      minRank: c.minRank,
    })),
    grants: Object.fromEntries(Object.entries(grants).map(([rid, set]) => [rid, [...set].sort()])),
    customized: hasOverride(),
  };
}

/**
 * Validate an admin-submitted override BEFORE it's persisted/installed (mirrors
 * eit_perms.validate_override). Returns [ok, error]. Refuses anything that would brick the install:
 * not an object; empty/duplicate roles; a missing/blank role id or non-int rank; rank collisions;
 * an editable=false STRUCTURAL capability being moved off its default; or NO role holding the admin
 * LIFELINE capabilities. This is the server's authority — the client mirrors it for UX only.
 */
export function validateOverride(doc: unknown): [boolean, string] {
  if (!doc || typeof doc !== 'object') return [false, 'override must be an object'];
  const d = doc as { roles?: unknown; grants?: unknown; capsSeen?: unknown };

  const roles = d.roles;
  if (!Array.isArray(roles) || roles.length === 0) return [false, 'at least one role is required'];

  const ids = new Set<string>();
  const ranks = new Set<number>();
  for (const r of roles) {
    if (!r || typeof r !== 'object') return [false, 'each role must be an object'];
    const rid = (r as { id?: unknown }).id;
    if (typeof rid !== 'string' || !rid.trim()) return [false, 'every role needs a non-empty id'];
    if (ids.has(rid)) return [false, `duplicate role id '${rid}'`];
    ids.add(rid);
    const rank = (r as { rank?: unknown }).rank;
    if (typeof rank !== 'number' || !Number.isInteger(rank)) return [false, `role '${rid}' needs an integer rank`];
    if (ranks.has(rank)) return [false, `two roles share rank ${rank}`];
    ranks.add(rank);
  }

  const grants = d.grants;
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) return [false, 'grants must be an object'];
  const grantsRec = grants as Record<string, unknown>;

  // An editable=false capability must keep EXACTLY its default (rank) grant — the admin can't relax
  // a structural invariant via the table.
  const rankById = new Map<string, number>(roles.map((r) => [(r as { id: string }).id, (r as { rank: number }).rank]));
  const seenArr = Array.isArray(d.capsSeen) && d.capsSeen.length ? (d.capsSeen as string[]) : CAP_IDS;
  const seen = new Set(seenArr);
  for (const c of CAP_LIST) {
    if (c.editable || !seen.has(c.id)) continue;
    for (const rid of ids) {
      const want = (rankById.get(rid) ?? -1) >= c.minRank;
      const granted = grantsRec[rid];
      const have = Array.isArray(granted) && granted.includes(c.id);
      if (want !== have) return [false, `capability '${c.id}' is structural and cannot be re-granted`];
    }
  }

  // Lifeline: at least one role must keep the admin capabilities, or no one can ever edit this table again.
  for (const cap of LIFELINE_CAPS) {
    const held = [...ids].some((rid) => {
      const g = grantsRec[rid];
      return Array.isArray(g) && g.includes(cap);
    });
    if (!held) return [false, `at least one role must hold '${cap}' (admin lifeline)`];
  }
  return [true, ''];
}
