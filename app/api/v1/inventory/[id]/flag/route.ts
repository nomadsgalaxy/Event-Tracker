import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, requireScope, readBody, auditKeyWrite } from '@/lib/api-v1';
import { flagInventoryItem } from '@/lib/write';

export const dynamic = 'force-dynamic';

// POST /api/v1/inventory/:id/flag — flag an item with a note (db.write.app). Body: { note, severity }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    requireScope(vk, 'db.write.app');
    const body = await readBody(req);
    const note = String(body.note ?? '').trim();
    if (!note) return apiErr(400, 'a note is required');
    const severity = String(body.severity ?? 'med').trim().toLowerCase();
    const res = await flagInventoryItem({
      itemId: id,
      note,
      severity: ['low', 'med', 'high'].includes(severity) ? severity : 'med',
      category: typeof body.category === 'string' ? body.category : undefined,
      actorRole: vk.role,
      actor: { email: vk.ownerEmail, name: vk.ownerEmail },
    });
    await auditKeyWrite(vk, req, 'api.inventory.flag', `inventory/${id}`, 'ok');
    return apiOk({ ok: res.ok, itemId: res.itemId, flag: res.flag });
  });
}
