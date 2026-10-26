// tools/connectors-check.tsx — sanity check of the power-connector catalog: unique ids per list,
// the receptacle ids events already store, and every face renders. No database needed:
//   npx tsx tools/connectors-check.tsx            (asserts only)
//   npx tsx tools/connectors-check.tsx sheet.svg  (also writes a contact sheet of every face)
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  INLETS, CABLE_MALE_ENDS, CABLE_FEMALE_ENDS, RECEPTACLES, WALL_PLUGS, REGION_DEFAULT_PLUG,
  cableEndById, cableEndRating, cableEndsCrossVoltage, isDcInlet, regionPower, receptacleById,
} from '@/lib/power/connectors';

for (const [name, list] of [['INLETS', INLETS], ['male', CABLE_MALE_ENDS], ['female', CABLE_FEMALE_ENDS], ['RECEPTACLES', RECEPTACLES]] as const) {
  const ids = list.map((e) => e.id);
  assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), [], `duplicate ids in ${name}`);
  for (const e of list) assert.ok(renderToStaticMarkup(e.svg as never).startsWith('<svg'), `${name} ${e.id} renders`);
}

// Ids already stored on events (powerReceptacles) and items (plugType / cable ends) must keep resolving.
for (const id of ['NEMA 5-15R', 'NEMA 5-20R', 'NEMA L5-30R', 'NEMA 6-15R', 'NEMA 6-20R', 'NEMA L6-30R', 'Schuko CEE 7/3',
  'IEC 60309 blue 16A', 'IEC 60309 blue 32A', 'IEC 60309 red 32A', 'BS 1363', 'AS/NZS 3112']) {
  assert.ok(receptacleById(id), `legacy receptacle ${id}`);
}
for (const id of ['C14', 'C20', 'C16', 'C6', 'C8', 'FIXED', 'Hardwired']) assert.ok(INLETS.some((i) => i.id === id), `legacy inlet ${id}`);
for (const id of Object.values(REGION_DEFAULT_PLUG)) assert.ok(WALL_PLUGS.some((w) => w.id === id), `region default ${id}`);
assert.ok(!WALL_PLUGS.some((w) => w.group === 'IEC'), 'a fixed cord never ends in an inline IEC coupler');
for (const r of ['NA', 'EU', 'UK', 'AU'] as const) assert.ok(regionPower(r).receptacles.length > 0, `local receptacles for ${r}`);

// The EU 9 V amp PSU: Europlug in, barrel out — a power supply, not a cross-voltage fault.
const euro = cableEndById('CEE 7/16', 'male');
const barrel = cableEndById('DC 5.5x2.1', 'female');
assert.ok(euro && barrel);
assert.equal(cableEndsCrossVoltage(euro, barrel), false);
assert.equal(cableEndRating(barrel), 'DC 5A');
assert.equal(cableEndRating(cableEndById('USB-A', 'male')!), '5V DC 3A');
assert.equal(cableEndsCrossVoltage(cableEndById('NEMA 5-15P', 'male'), cableEndById('Schuko CEE 7/3', 'female')), true);
assert.ok(isDcInlet('USB-C') && !isDcInlet('C14') && !isDcInlet('FIXED'));

const out = process.argv[2];
if (out) {
  const all = [...INLETS, ...CABLE_MALE_ENDS, ...CABLE_FEMALE_ENDS].filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i);
  const cell = (e: (typeof all)[number], i: number) =>
    `<g transform="translate(${(i % 10) * 110},${Math.floor(i / 10) * 110})"><svg x="21" y="4" width="68" height="68" ${renderToStaticMarkup(e.svg as never).slice(5)}<text x="55" y="92" font-size="9" text-anchor="middle" font-family="sans-serif">${e.label.replace(/&/g, '&amp;')}</text></g>`;
  writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="${Math.ceil(all.length / 10) * 110}" color="black"><rect width="100%" height="100%" fill="white"/>${all.map(cell).join('')}</svg>`);
}
console.log(`connectors ok — ${INLETS.length} inlets, ${CABLE_MALE_ENDS.length} male, ${CABLE_FEMALE_ENDS.length} female, ${RECEPTACLES.length} receptacles`);
