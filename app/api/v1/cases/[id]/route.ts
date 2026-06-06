import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, keyCan, requireScope, readBody, auditKeyWrite } from '@/lib/api-v1';
import { getCase, getInventory } from '@/lib/data';
import { saveCase, retireOrDeleteCase, type CasePatch } from '@/lib/write';
import { serializeCase } from '@/lib/api-v1-serialize';

export const dynamic = 'force-dynamic';

async function caseResponse(id: string) {
  const doc = await getCase(id);
  if (!doc) return apiErr(404, 'case not found');
  const inventory = await getInventory();
  return apiOk(serializeCase(doc._id, doc.payload, inventory.map((d) => d.payload)));
}

// GET /api/v1/cases/:id — the case + its packed manifest.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    if (!keyCan(vk, 'db.read.session')) return apiErr(403, 'this key cannot read');
    return caseResponse(id);
  });
}

// POST | PATCH /api/v1/cases/:id — edit the case (pallets.edit).
async function update(req: NextRequest, id: string) {
  return withKey(req, async (vk) => {
    requireScope(vk, 'pallets.edit');
    const body = await readBody(req);
    await saveCase({ id, patch: body as CasePatch, actorEmail: vk.ownerEmail, actorRole: vk.role });
    await auditKeyWrite(vk, req, 'api.case.update', `cases/${id}`, 'ok');
    return caseResponse(id);
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

// DELETE /api/v1/cases/:id — delete/retire (pallets.edit). The server re-classifies on live FKs: a case
// held by a non-closed event is blocked (403); one with historical refs is retired instead of deleted.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    requireScope(vk, 'pallets.edit');
    const res = await retireOrDeleteCase({ id, action: 'delete', reason: '', actorEmail: vk.ownerEmail, actorName: vk.ownerEmail, actorRole: vk.role });
    await auditKeyWrite(vk, req, 'api.case.delete', `cases/${id}`, res.action);
    return apiOk({ ok: res.ok, action: res.action, id });
  });
}
