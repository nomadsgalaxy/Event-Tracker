// tools/pallet-flow-check.ts — end-to-end check of items riding event pallets (load → pack → ship with
// no cases → sign off → close releases to storage). Drops the database it's pointed at, so only run it
// against a scratch Mongo:
//   docker run -d --rm --name et-scratch -p 27199:27017 mongo:7
//   mkdir -p /tmp/shim/server-only && echo '{"main":"i.js"}' > /tmp/shim/server-only/package.json && touch /tmp/shim/server-only/i.js
//   NODE_PATH=/tmp/shim MONGO_URI=mongodb://localhost:27199 MONGO_DB=pallet_test ET_SESSION_SECRET=0123456789abcdef npx tsx tools/pallet-flow-check.ts
// (server-only is a Next build alias, so outside Next it needs that empty stand-in.)
import assert from 'node:assert/strict';
import { getDb } from '@/lib/db/mongo';
import {
  createEvent, saveEvent, placeItemOnPallet, removeItemFromPallet, setPalletItemPacked,
  commitEventReady, markEventOnsite, commitEventClosed, signOffItemDisposition,
} from '@/lib/db/write';
import { eventCanCommitReady, packingBlockReason, eventCanCommitClosed, buildCheckinSweep } from '@/lib/views/signoff-view';
import { buildEventManifest } from '@/lib/views/manifest-view';
import { itemInStorage } from '@/lib/views/inventory-shape';
import { palletWeightKg } from '@/lib/views/event-readiness';

const actor = { email: 'admin@test', name: 'Admin', role: 'admin' };
const role = 'admin';

async function main() {
  const db = await getDb();
  assert.match(db.databaseName, /test/, 'refusing to drop a database whose name has no "test" in it');
  await db.dropDatabase();
  const inv = () => db.collection('inventory').find({}).toArray().then((d) => d.map((x: any) => x.payload));
  const ev = async (id: string) => (await db.collection('events').findOne({ _id: id as any }))!.payload as any;

  const now = Date.now();
  await db.collection('inventory').insertMany([
    { _id: 'pla', payload: { id: 'pla', name: 'PLA', kind: 'consumable', tracking: 'bulk', stockTotal: 10, weight: 1, distribution: [], flags: [] }, createdAt: now, updatedAt: now, deletedAt: null },
    { _id: 'c1', payload: { id: 'c1', name: 'Core One+', kind: 'equipment', tracking: 'serial', weight: 20, flags: [], distribution: [],
      units: [{ id: 'u1', serial: 'SN1', location: 'storage' }, { id: 'u2', serial: 'SN2', location: 'storage' }] }, createdAt: now, updatedAt: now, deletedAt: null },
  ] as any);

  const { id } = await createEvent({ patch: { name: 'Test show', pallets: [{ id: 'pallet-a', label: 'Pallet A', caseIds: [], weightKg: 25 }] } as any, actorEmail: actor.email, actorRole: role });
  await saveEvent({ id, patch: { state: 'packing' } as any, actorEmail: actor.email, actorRole: role });

  // bad pallet id refused
  await assert.rejects(saveEvent({ id, patch: { pallets: [{ id: 'case-x', label: 'x', caseIds: [] }] } as any, actorEmail: actor.email, actorRole: role }), /pallet-/);
  // nothing to ship yet
  assert.equal(packingBlockReason(await ev(id), await inv()), 'Assign cases or put items on a pallet first.');

  await placeItemOnPallet({ eventId: id, palletId: 'pallet-a', itemId: 'pla', qty: 4, actor });
  await placeItemOnPallet({ eventId: id, palletId: 'pallet-a', itemId: 'pla', qty: 2, actor }); // merges
  await placeItemOnPallet({ eventId: id, palletId: 'pallet-a', itemId: 'c1', unitId: 'u1', actor });
  await assert.rejects(placeItemOnPallet({ eventId: id, palletId: 'pallet-a', itemId: 'pla', qty: 5, actor }), /Only 4/);
  await assert.rejects(placeItemOnPallet({ eventId: id, palletId: 'pallet-a', itemId: 'c1', unitId: 'u1', actor }), /not in storage/);
  let items = await inv();
  assert.equal(itemInStorage(items.find((i: any) => i.id === 'pla')), 4);
  assert.equal(itemInStorage(items.find((i: any) => i.id === 'c1')), 1);
  const pla = items.find((i: any) => i.id === 'pla');
  assert.equal(pla.distribution.length, 1);
  assert.equal(pla.distribution[0].qty, 6);

  // manifest + weight
  let e = await ev(id);
  const m = buildEventManifest(e, id, items, {});
  assert.equal(m.palletGroups.length, 1);
  assert.equal(m.palletGroups[0].total, 7);
  assert.equal(m.looseGroup, null);
  assert.equal(m.totals.total, 7);
  assert.equal(palletWeightKg(e.pallets[0], {}, items), 25 + 6 + 20);

  // can't drop a loaded pallet
  await assert.rejects(saveEvent({ id, patch: { pallets: [] } as any, actorEmail: actor.email, actorRole: role }), /still has items/);

  // remove part, then pack everything
  await removeItemFromPallet({ eventId: id, palletId: 'pallet-a', itemId: 'pla', qty: 1, actor });
  items = await inv();
  assert.equal(items.find((i: any) => i.id === 'pla').distribution[0].qty, 5);
  assert.equal(eventCanCommitReady(await ev(id), items), false);
  assert.match(packingBlockReason(await ev(id), items)!, /2 of 2 pallet items still need packing/);
  await setPalletItemPacked({ eventId: id, palletId: 'pallet-a', itemId: 'pla', packed: true, actor });
  await setPalletItemPacked({ eventId: id, palletId: 'pallet-a', itemId: 'c1', packed: true, actor });
  assert.equal(eventCanCommitReady(await ev(id), await inv()), true);

  // ship with no cases
  const snapshot = (await commitEventReady({ eventId: id, shipping: { carrier: 'X', tracking: 'T1' }, actor } as any)).snapshot!;
  assert.equal(snapshot.rows.length, 2);
  assert.ok(snapshot.rows.every((r: any) => r.palletId === 'pallet-a' && r.caseLabel === 'Pallet A' && !r.loose));
  assert.equal(snapshot.pallets?.[0].weightKg, 25);
  // loading is locked once shipped
  await assert.rejects(placeItemOnPallet({ eventId: id, palletId: 'pallet-a', itemId: 'pla', qty: 1, actor }), /Draft, Upcoming or Packing/);

  await markEventOnsite({ eventId: id, actor });
  await saveEvent({ id, patch: { state: 'unpacking' } as any, actorEmail: actor.email, actorRole: role });
  assert.equal(eventCanCommitClosed(await ev(id), await inv()), false);

  // sign off: bulk pallet row by pallet id, serial unit by pallet id
  await signOffItemDisposition({ eventId: id, itemId: 'pla', caseId: 'pallet-a', kind: 'consumed', actor });
  await signOffItemDisposition({ eventId: id, itemId: 'c1', caseId: 'pallet-a', kind: 'ok', actor });
  items = await inv();
  const sweep = buildCheckinSweep(await ev(id), items);
  assert.equal(sweep.tally.missing, 0, JSON.stringify(sweep.discrepancies));
  assert.equal(eventCanCommitClosed(await ev(id), items), true);

  await commitEventClosed({ eventId: id, actor });
  items = await inv();
  const plaAfter = items.find((i: any) => i.id === 'pla');
  assert.equal(plaAfter.distribution.length, 0);
  assert.equal(plaAfter.stockTotal, 5); // 5 consumed came off the 10
  assert.equal(itemInStorage(plaAfter), 5);
  const c1After = items.find((i: any) => i.id === 'c1');
  assert.ok(c1After.units.every((u: any) => u.location === 'storage'));
  assert.equal(itemInStorage(c1After), 2);

  await db.dropDatabase();
  console.log('pallet flow: all checks passed');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
