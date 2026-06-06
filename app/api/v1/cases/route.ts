import { withKey, apiOk, apiErr, keyCan, requireScope, readBody, qParam, intParam, matches, auditKeyWrite } from '@/lib/api-v1';
import { getCases, getCase, getInventory } from '@/lib/data';
import { createCase, type CasePatch } from '@/lib/write';
import { serializeCase } from '@/lib/api-v1-serialize';

export const dynamic = 'force-dynamic';

// GET /api/v1/cases?q=&limit=&offset= — list cases.
export async function GET(req: Request) {
  return withKey(req, async (vk) => {
    if (!keyCan(vk, 'db.read.session')) return apiErr(403, 'this key cannot read');
    const q = qParam(req, 'q');
    const limit = intParam(req, 'limit', 100, 500);
    const offset = intParam(req, 'offset', 0, 100000);
    const all = await getCases();
    const filtered = all.filter((d) => matches(d.payload.label, q) || matches(d.payload.slug, q) || matches(d._id, q));
    const cases = filtered.slice(offset, offset + limit).map((d) => ({ id: d._id, ...d.payload }));
    return apiOk({ cases, total: filtered.length, limit, offset });
  });
}

// POST /api/v1/cases — create a case (pallets.edit). Returns the case + its (empty) manifest.
export async function POST(req: Request) {
  return withKey(req, async (vk) => {
    requireScope(vk, 'pallets.edit');
    const body = await readBody(req);
    const res = await createCase({ patch: body as CasePatch, actorEmail: vk.ownerEmail, actorRole: vk.role });
    await auditKeyWrite(vk, req, 'api.case.create', `cases/${res.id}`, 'ok');
    const doc = await getCase(res.id);
    const inventory = await getInventory();
    return apiOk(doc ? serializeCase(doc._id, doc.payload, inventory.map((d) => d.payload)) : { case: { id: res.id } }, 201);
  });
}
