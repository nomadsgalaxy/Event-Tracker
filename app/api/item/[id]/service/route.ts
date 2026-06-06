import { type NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth';
import { upsertItem, WriteForbiddenError } from '@/lib/write';
import type { ItemFlag } from '@/lib/inventory-shape';
import { jsonOk, jsonErr, readJson } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// POST /api/item/[id]/service — the universal out-of-service / repair write, so the shared
// ItemDetailsModal's ServiceStatusPanel works no matter which screen opened it (a caller can still
// pass its own onServiceChange; when it doesn't, the modal posts here). Mirrors the catalog's
// saveItemServiceAction: db.write.app (authorized+), persists { status, flags } via upsertItem (the
// flags are built client-side by the panel — markItemOutOfService / returnItemToService).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const itemId = String(id ?? '').trim();
  if (!itemId) return jsonErr(400, 'missing item id');

  const body = (await readJson(req)) as { status?: 'out_of_service' | null; flags?: ItemFlag[] };
  const status = body.status === 'out_of_service' ? 'out_of_service' : null;
  const flags = Array.isArray(body.flags) ? body.flags : [];

  const user = await requireRole('authorized');
  try {
    await upsertItem({ id: itemId, patch: { status, flags }, actorRole: user.role });
  } catch (e) {
    if (e instanceof WriteForbiddenError) return jsonErr(403, e.message);
    return jsonErr(500, e instanceof Error ? e.message : 'could not update service status');
  }
  return jsonOk({ ok: true });
}
