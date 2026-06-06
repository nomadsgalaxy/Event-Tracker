import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, keyCan, requireScope, readBody, auditKeyWrite } from '@/lib/api-v1';
import { getInventory } from '@/lib/data';
import { upsertItem, deleteInventoryItem, type ItemPatch } from '@/lib/write';
import { serializeItem } from '@/lib/api-v1-serialize';

export const dynamic = 'force-dynamic';

async function itemResponse(id: string) {
  const all = await getInventory();
  const doc = all.find((d) => d._id === id);
  if (!doc) return apiErr(404, 'inventory item not found');
  return apiOk({ item: serializeItem(doc._id, doc.payload) });
}

// GET /api/v1/inventory/:id — one item with resolved stock figures.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    if (!keyCan(vk, 'db.read.session')) return apiErr(403, 'this key cannot read');
    return itemResponse(id);
  });
}

// POST | PATCH /api/v1/inventory/:id — edit the item (db.write.app).
async function update(req: NextRequest, id: string) {
  return withKey(req, async (vk) => {
    requireScope(vk, 'db.write.app');
    const body = await readBody(req);
    await upsertItem({ id, patch: body as ItemPatch, actorRole: vk.role });
    await auditKeyWrite(vk, req, 'api.inventory.update', `inventory/${id}`, 'ok');
    return itemResponse(id);
  });
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return update(req, id);
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return update(req, id);
}

// DELETE /api/v1/inventory/:id — soft-delete the item (db.write.app).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    requireScope(vk, 'db.write.app');
    const res = await deleteInventoryItem(id, vk.role);
    await auditKeyWrite(vk, req, 'api.inventory.delete', `inventory/${id}`, 'ok');
    return apiOk({ ok: res.ok, deleted: id });
  });
}
