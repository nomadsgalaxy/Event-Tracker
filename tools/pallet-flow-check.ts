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
  createEvent, saveEvent, softDeleteEvent, setEventCases, setCaseSignoff, placeItemOnPallet, removeItemFromPallet, setPalletItemPacked,
  commitEventReady, markEventOnsite, commitEventClosed, signOffItemDisposition, setRowDisposition, markUnscannedMissing, eventIdForPallet,
} from '@/lib/db/write';
import { caseContents, caseEventContext, palletAsScanCase, rowDispositionKind } from '@/lib/views/scan';
import { eventCanCommitReady, packingBlockReason, eventCanCommitClosed, buildCheckinSweep } from '@/lib/views/signoff-view';
import { buildEventManifest } from '@/lib/views/manifest-view';
import { itemInStorage, unitIsOutOfService } from '@/lib/views/inventory-shape';
import { buildConditionReport } from '@/lib/views/reports';
import { palletWeightKg } from '@/lib/views/event-readiness';

const actor = { email: 'admin@test', name: 'Admin', role: 'admin' };
const role = 'admin';

async function main() {
  const now = Date.now();
  const db = await getDb();
  assert.match(db.databaseName, /test/, 'refusing to drop a database whose name has no "test" in it');
  await db.dropDatabase();
  const inv = () => db.collection('inventory').find({}).toArray().then((d) => d.map((x: any) => x.payload));
  const ev = async (id: string) => (await db.collection('events').findOne({ _id: id as any }))!.payload as any;

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

  // ── Review regressions ───────────────────────────────────────────────────────────────
  await db.dropDatabase();
  await db.collection('inventory').insertMany([
    { _id: 'c1', payload: { id: 'c1', name: 'Core One+', kind: 'equipment', tracking: 'serial', weight: 20, flags: [], distribution: [],
      units: [{ id: 'u1', serial: 'SN1', location: 'storage' }, { id: 'u2', serial: 'SN2', location: 'storage', status: 'out_of_service' }, { id: 'u3', serial: 'SN3', location: 'storage' }] },
      createdAt: now, updatedAt: now, deletedAt: null },
    { _id: 'pla', payload: { id: 'pla', name: 'PLA', kind: 'consumable', tracking: 'bulk', stockTotal: 10, distribution: [], flags: [] }, createdAt: now, updatedAt: now, deletedAt: null },
    { _id: 'tool', payload: { id: 'tool', name: 'Wrench', kind: 'tool', tracking: 'bulk', stockTotal: 1, distribution: [], flags: [] }, createdAt: now, updatedAt: now, deletedAt: null },
  ] as any);
  await db.collection('cases').insertOne({ _id: 'case1', payload: { id: 'case1', label: 'Case 1' }, createdAt: now, updatedAt: now, deletedAt: null } as any);
  const mk = async (name: string) => {
    const r = await createEvent({ patch: { name, pallets: [{ id: 'pallet-' + name, label: name, caseIds: [] }] } as any, actorEmail: actor.email, actorRole: role });
    await saveEvent({ id: r.id, patch: { state: 'packing' } as any, actorEmail: actor.email, actorRole: role });
    return r.id;
  };

  // one unit in repair doesn't block the others; the first-free pick skips it
  const e2 = await mk('two');
  await placeItemOnPallet({ eventId: e2, palletId: 'pallet-two', itemId: 'c1', actor });
  await placeItemOnPallet({ eventId: e2, palletId: 'pallet-two', itemId: 'c1', actor });
  items = await inv();
  assert.deepEqual(items.find((i: any) => i.id === 'c1').units.map((u: any) => u.location), ['pallet-two', 'storage', 'pallet-two']);
  // closing by a plain state edit releases the pallet
  await saveEvent({ id: e2, patch: { state: 'closed' } as any, actorEmail: actor.email, actorRole: role });
  items = await inv();
  assert.ok(items.find((i: any) => i.id === 'c1').units.every((u: any) => u.location === 'storage'));

  // deleting an event releases its pallet
  const e3 = await mk('three');
  await placeItemOnPallet({ eventId: e3, palletId: 'pallet-three', itemId: 'pla', qty: 3, actor });
  await softDeleteEvent({ id: e3, actorEmail: actor.email, actorRole: role });
  assert.equal(itemInStorage((await inv()).find((i: any) => i.id === 'pla')), 10);

  // a unit signed missing comes back out of service + flagged; damaged comes back flagged
  const e4 = await mk('four');
  await placeItemOnPallet({ eventId: e4, palletId: 'pallet-four', itemId: 'c1', unitId: 'u1', actor });
  await placeItemOnPallet({ eventId: e4, palletId: 'pallet-four', itemId: 'c1', unitId: 'u3', actor });
  await setPalletItemPacked({ eventId: e4, palletId: 'pallet-four', itemId: 'c1', packed: true, actor });
  await commitEventReady({ eventId: e4, shipping: { carrier: 'X' }, actor } as any);
  await markEventOnsite({ eventId: e4, actor });
  await saveEvent({ id: e4, patch: { state: 'unpacking' } as any, actorEmail: actor.email, actorRole: role });
  await db.collection('inventory').updateOne({ _id: 'c1' as any }, { $set: { 'payload.units.0.signoff': { kind: 'missing' }, 'payload.units.2.signoff': { kind: 'damaged' } } });
  await commitEventClosed({ eventId: e4, actor });
  const units = (await inv()).find((i: any) => i.id === 'c1').units;
  assert.equal(units[0].status, 'out_of_service');
  assert.match(units[0].flags.at(-1).note, /missing/);
  assert.equal(units[2].flags.at(-1).category, 'damage');

  // an older stored pallet id without the prefix still saves; a new one is refused
  const e5 = await mk('five');
  await db.collection('events').updateOne({ _id: e5 as any }, { $set: { 'payload.pallets': [{ id: 'legacy1', label: 'Old', caseIds: [] }] } });
  await saveEvent({ id: e5, patch: { pallets: [{ id: 'legacy1', label: 'Old renamed', caseIds: [] }] } as any, actorEmail: actor.email, actorRole: role });
  await assert.rejects(saveEvent({ id: e5, patch: { pallets: [{ id: 'legacy1', label: 'Old', caseIds: [] }, { id: 'nope', label: 'x', caseIds: [] }] } as any, actorEmail: actor.email, actorRole: role }), /pallet-/);

  // road-case flow is unchanged: a boxed case ships, an unboxed one blocks
  const e6 = await mk('six');
  await setEventCases({ eventId: e6, caseIds: ['case1'], actorEmail: actor.email, actorRole: role } as any);
  await db.collection('inventory').updateOne({ _id: 'tool' as any }, { $set: { 'payload.distribution': [{ caseId: 'case1', eventId: null, qty: 1, serials: [], state: 'packed' }] } });
  assert.match(packingBlockReason(await ev(e6), await inv())!, /case.* still need boxing/);
  await setCaseSignoff({ eventId: e6, caseId: 'case1', boxed: true, actorEmail: actor.email, actorRole: role } as any);
  assert.equal(eventCanCommitReady(await ev(e6), await inv()), true);

  // ── Pallet losses survive close (board topic 126, Nula's check) ────────────────────────────
  // One show comes back with a returned, a damaged and a missing line (bulk and serial). Closing
  // releases the pallet rows, so the loss history has to live on event.palletReturns.
  await db.collection('inventory').insertMany([
    { _id: 'cam', payload: { id: 'cam', name: 'Camera', kind: 'equipment', tracking: 'serial', flags: [], distribution: [], replacementCost: 300,
      units: [{ id: 'v1', serial: 'CAM1', location: 'storage' }, { id: 'v2', serial: 'CAM2', location: 'storage' }, { id: 'v3', serial: 'CAM3', location: 'storage' }] },
      createdAt: now, updatedAt: now, deletedAt: null },
    { _id: 'tape', payload: { id: 'tape', name: 'Tape gun', kind: 'tool', tracking: 'bulk', stockTotal: 5, distribution: [], flags: [] }, createdAt: now, updatedAt: now, deletedAt: null },
    { _id: 'cord', payload: { id: 'cord', name: 'Cord', kind: 'cable', tracking: 'bulk', stockTotal: 4, distribution: [], flags: [], purchasePrice: 10 }, createdAt: now, updatedAt: now, deletedAt: null },
    { _id: 'mat', payload: { id: 'mat', name: 'Floor mat', kind: 'fixture', tracking: 'bulk', stockTotal: 3, distribution: [], flags: [] }, createdAt: now, updatedAt: now, deletedAt: null },
  ] as any);
  const e7 = await mk('seven');
  for (const unitId of ['v1', 'v2', 'v3']) await placeItemOnPallet({ eventId: e7, palletId: 'pallet-seven', itemId: 'cam', unitId, actor });
  await placeItemOnPallet({ eventId: e7, palletId: 'pallet-seven', itemId: 'tape', qty: 2, actor });
  await placeItemOnPallet({ eventId: e7, palletId: 'pallet-seven', itemId: 'cord', qty: 3, actor });
  await placeItemOnPallet({ eventId: e7, palletId: 'pallet-seven', itemId: 'mat', qty: 2, actor });
  for (const itemId of ['cam', 'tape', 'cord', 'mat']) await setPalletItemPacked({ eventId: e7, palletId: 'pallet-seven', itemId, packed: true, actor });
  await commitEventReady({ eventId: e7, shipping: { carrier: 'X' }, actor } as any);
  await markEventOnsite({ eventId: e7, actor });
  await saveEvent({ id: e7, patch: { state: 'unpacking' } as any, actorEmail: actor.email, actorRole: role });
  await signOffItemDisposition({ eventId: e7, itemId: 'tape', caseId: 'pallet-seven', kind: 'ok', actor });
  await signOffItemDisposition({ eventId: e7, itemId: 'cord', caseId: 'pallet-seven', kind: 'missing', actor });
  await signOffItemDisposition({ eventId: e7, itemId: 'mat', caseId: 'pallet-seven', kind: 'damaged', actor });
  await db.collection('inventory').updateOne({ _id: 'cam' as any }, { $set: { 'payload.units.0.signoff': { kind: 'ok' }, 'payload.units.1.signoff': { kind: 'damaged' }, 'payload.units.2.signoff': { kind: 'missing' } } });
  await commitEventClosed({ eventId: e7, actor });

  const lossState = async () => {
    const all = await inv();
    const by = (id: string) => all.find((i: any) => i.id === id);
    return {
      tape: itemInStorage(by('tape')),
      cord: [by('cord').stockTotal, itemInStorage(by('cord'))],
      mat: [by('mat').stockTotal, itemInStorage(by('mat'))],
      cam: by('cam').units.map((u: any) => [u.location, unitIsOutOfService(u)]),
      returns: ((await ev(e7)).palletReturns ?? []).map((r: any) => `${r.itemId}:${r.unitId ?? ''}:${r.kind}:${r.qty}`).sort(),
    };
  };
  const afterClose = await lossState();
  assert.equal(afterClose.tape, 5, 'returned bulk is available once');
  assert.deepEqual(afterClose.cord, [1, 1], 'missing bulk comes off stock');
  assert.deepEqual(afterClose.mat, [1, 1], 'damaged bulk comes off stock, not back as good stock');
  assert.deepEqual(afterClose.cam, [['storage', false], ['storage', true], ['storage', true]], 'damaged + missing units stay unavailable');
  assert.deepEqual(afterClose.returns, ['cam:v2:damaged:1', 'cam:v3:missing:1', 'cord::missing:3', 'mat::damaged:2']);
  await assert.rejects(placeItemOnPallet({ eventId: await mk('eight'), palletId: 'pallet-eight', itemId: 'cam', unitId: 'v2', actor }), /out of service/);

  // the report still sees the losses after the rows are gone
  const evDocs = (await db.collection('events').find({}).toArray()).map((d: any) => ({ id: d._id, payload: d.payload }));
  const itemDocs = (await inv()).map((p: any) => ({ id: p.id, payload: p }));
  const report = buildConditionReport(itemDocs as any, evDocs as any);
  const seven = report.shrink.filter((r) => r.eventName === 'seven');
  assert.deepEqual(seven.map((r) => `${r.itemName}:${r.qty}`).sort(), ['Camera:1', 'Cord:3']);
  assert.equal(seven.reduce((n, r) => n + r.dollarsLost, 0), 300 + 3 * 10);
  const camRow = report.perItem.find((r) => r.name === 'Camera')!;
  assert.equal(camRow.damaged, 1);
  assert.equal(camRow.missing, 1);
  assert.equal(report.perItem.find((r) => r.name === 'Floor mat')!.damaged, 2);

  // closing again, reopening and closing, or deleting changes nothing and records nothing twice
  await saveEvent({ id: e7, patch: { state: 'closed' } as any, actorEmail: actor.email, actorRole: role });
  assert.deepEqual(await lossState(), afterClose);
  await saveEvent({ id: e7, patch: { state: 'unpacking' } as any, actorEmail: actor.email, actorRole: role });
  await saveEvent({ id: e7, patch: { state: 'closed' } as any, actorEmail: actor.email, actorRole: role });
  assert.deepEqual(await lossState(), afterClose);
  await softDeleteEvent({ id: e7, actorEmail: actor.email, actorRole: role });
  assert.deepEqual(await lossState(), afterClose);

  // ── Scan-to-pallet: a pallet works as the scan target, packing and returning ─────────────────
  await db.collection('inventory').insertMany([
    { _id: 'box', payload: { id: 'box', name: 'Box', kind: 'consumable', tracking: 'bulk', stockTotal: 3, distribution: [], flags: [] }, createdAt: now, updatedAt: now, deletedAt: null },
    { _id: 'mon', payload: { id: 'mon', name: 'Monitor', kind: 'equipment', tracking: 'serial', flags: [], distribution: [], units: [{ id: 'w1', serial: 'MON1', location: 'storage' }] }, createdAt: now, updatedAt: now, deletedAt: null },
  ] as any);
  const e9 = await mk('nine');
  const lean = async () => (await db.collection('events').find({}).toArray()).map((d: any) => ({ id: d._id, payload: d.payload }));
  assert.equal(await eventIdForPallet('pallet-nine'), e9);
  assert.equal(palletAsScanCase('pallet-nine', await lean())?.slug, 'nine');
  assert.equal(caseEventContext('pallet-nine', await lean()).mode, 'pack');
  await placeItemOnPallet({ eventId: e9, palletId: 'pallet-nine', itemId: 'box', qty: 1, actor });
  await placeItemOnPallet({ eventId: e9, palletId: 'pallet-nine', itemId: 'box', qty: 1, actor }); // a second scan merges
  await placeItemOnPallet({ eventId: e9, palletId: 'pallet-nine', itemId: 'mon', actor });
  await setPalletItemPacked({ eventId: e9, palletId: 'pallet-nine', itemId: 'box', packed: true, actor });
  let rows = caseContents('pallet-nine', await inv());
  assert.deepEqual(rows.map((r) => `${r.itemId}:${r.dist.qty}:${r.dist.state}`).sort(), ['box:2:packed', 'mon:1:pending']);
  await setPalletItemPacked({ eventId: e9, palletId: 'pallet-nine', itemId: 'mon', packed: true, actor });
  await commitEventReady({ eventId: e9, shipping: { carrier: 'X' }, actor } as any);
  await markEventOnsite({ eventId: e9, actor });
  await saveEvent({ id: e9, patch: { state: 'unpacking' } as any, actorEmail: actor.email, actorRole: role });
  assert.equal(caseEventContext('pallet-nine', await lean()).mode, 'unpack');
  await setRowDisposition({ itemId: 'box', caseId: 'pallet-nine', disposition: 'ok', actorRole: role, actor });
  assert.equal((await markUnscannedMissing({ caseId: 'pallet-nine', actorRole: role, actor })).marked, 1);
  rows = caseContents('pallet-nine', await inv());
  assert.deepEqual(rows.map((r) => `${r.itemId}:${rowDispositionKind(r.dist)}`).sort(), ['box:ok', 'mon:missing']);
  assert.equal(eventCanCommitClosed(await ev(e9), await inv()), true);

  await db.dropDatabase();
  console.log('pallet flow: all checks passed');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
