// migrate-perms-technician.js — one-time mongosh migration for the __perms__ override doc.
//
// Inserting the Technician role renumbered the built-in ranks (lead 2->3, manager 3->4, admin 4->5)
// and the cap minRanks moved with them. A __perms__ override saved BEFORE that change still pins the
// old ranks, so validateOverride now refuses it (admin rank 4 < admin.console minRank 5) and the app
// silently falls back to defaults — dropping any admin-made grant customizations (e.g. managers
// granted admin.users.directory + audit.view).
//
// This remaps a STOCK old-rank override in place: bumps lead/manager/admin ranks, inserts technician
// (rank 2) preserving every existing role's label/color/desc, copies lead's grant list to technician
// (identical to the technician seed), and leaves all other grants + caps_seen untouched. Idempotent;
// aborts on anything non-stock rather than guessing.
//
//   docker exec -i <mongo> mongosh <db> --quiet < migrate-perms-technician.js

const coll = db.getCollection('auth');
const d = coll.findOne({ _id: '__perms__' });
function fail(m) { print('ABORT: ' + m); quit(1); }

if (!d || d._reset) { print('OK: no override stored (defaults apply) — nothing to migrate.'); quit(0); }

const roles = d.roles || [];
const rank = {};
roles.forEach((r) => (rank[r.id] = r.rank));
if (rank['technician'] !== undefined || rank['admin'] === 5) { print('OK: already on the new rank model.'); quit(0); }

if (roles.map((r) => r.id).sort().join(',') !== 'admin,authorized,lead,manager,read-only')
  fail('unexpected role set — re-save via Config > Permissions instead.');
if (rank['read-only'] !== 0 || rank['authorized'] !== 1 || rank['lead'] !== 2 || rank['manager'] !== 3 || rank['admin'] !== 4)
  fail('unexpected ranks — re-save via Config > Permissions instead.');

const g = d.grants || {};
if (!Array.isArray(g['lead']) || g['lead'].length === 0) fail('no stored lead grant list to seed technician from.');

// Bump the built-ins, preserving their stored label/color/hidden/desc; insert technician before lead.
const bumped = roles.map((r) => Object.assign({}, r, { rank: r.id === 'lead' ? 3 : r.id === 'manager' ? 4 : r.id === 'admin' ? 5 : r.rank }));
const technician = {
  id: 'technician', rank: 2, label: 'Technician', color: 'var(--st-unpacking)', hidden: false, builtin: true,
  desc: 'Inventory technician. Works flagged / out-of-service items: edits inventory, sign-off, loose-item management, label print/adopt, tag apply, pack/unpack. Same inventory powers as a Lead but NO control over events (no create/edit/delete, no travel PII) unless separately made the lead of an event.',
};
bumped.splice(bumped.findIndex((r) => r.id === 'lead'), 0, technician);

const grants = Object.assign({}, g, { technician: g['lead'].slice() });

const res = coll.updateOne(
  { _id: '__perms__' },
  { $set: { roles: bumped, grants: grants, updatedAt: Date.now(), updatedBy: 'migration:technician-ranks' } }
);
print('MIGRATED: modified=' + res.modifiedCount);
const after = coll.findOne({ _id: '__perms__' });
print('roles: ' + after.roles.map((r) => r.id + ':' + r.rank).join(' '));
print('technician grants (' + after.grants.technician.length + '): ' + after.grants.technician.slice().sort().join(','));
print('manager keeps admin.users.directory: ' + (after.grants.manager.indexOf('admin.users.directory') >= 0));
print('manager keeps audit.view: ' + (after.grants.manager.indexOf('audit.view') >= 0));
