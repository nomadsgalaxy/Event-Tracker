import { withKey, apiOk, apiErr, keyCan, requireScope, readBody, qParam, intParam, auditKeyWrite } from '@/lib/api/api-v1';
import { getInventory } from '@/lib/db/data';
import { createInventoryItem, type ItemPatch } from '@/lib/db/write';
import { itemMatchesQuery, itemInStorage } from '@/lib/views/inventory-shape';
import { serializeItem } from '@/lib/api/api-v1-serialize';

export const dynamic = 'force-dynamic';

// GET /api/v1/inventory?q=&low_stock=&limit=&offset= — list inventory items (resolved stock figures).
export async function GET(req: Request) {
  return withKey(req, async (vk) => {
    if (!keyCan(vk, 'db.read.session')) return apiErr(403, 'this key cannot read');
    const q = qParam(req, 'q');
    const limit = intParam(req, 'limit', 100, 500);
    const offset = intParam(req, 'offset', 0, 100000);
    const lowOnly = ['1', 'true', 'yes'].includes(qParam(req, 'low_stock').toLowerCase());
    const all = await getInventory();
    let filtered = all.filter((d) => itemMatchesQuery(d.payload, d._id, q));
    if (lowOnly) {
      filtered = filtered.filter((d) => {
        const it = d.payload;
        return it.reorderPoint != null && (it.reorderPoint as unknown) !== '' && itemInStorage(it) < Number(it.reorderPoint);
      });
    }
    const items = filtered.slice(offset, offset + limit).map((d) => serializeItem(d._id, d.payload));
    return apiOk({ items, total: filtered.length, limit, offset });
  });
}

// POST /api/v1/inventory — create an item (db.write.app). Returns the created item.
export async function POST(req: Request) {
  return withKey(req, async (vk) => {
    requireScope(vk, 'db.write.app');
    const body = await readBody(req);
    const res = await createInventoryItem({ patch: body as ItemPatch, actorRole: vk.role });
    await auditKeyWrite(vk, req, 'api.inventory.create', `inventory/${res.id}`, 'ok');
    const all = await getInventory();
    const doc = all.find((d) => d._id === res.id);
    return apiOk(doc ? { item: serializeItem(doc._id, doc.payload) } : { item: { id: res.id } }, 201);
  });
}
