import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, auditKeyWrite } from '@/lib/api-v1';
import { deleteRecord, DbMirrorError } from '@/lib/api-v1-db';

export const dynamic = 'force-dynamic';

// POST /api/v1/db/:collection/:id/delete — soft-delete a record (routed through the typed delete helper).
export async function POST(req: NextRequest, { params }: { params: Promise<{ collection: string; id: string }> }) {
  const { collection, id } = await params;
  return withKey(req, async (vk) => {
    try {
      const out = await deleteRecord(vk, collection, id);
      await auditKeyWrite(vk, req, 'api.db.delete', `${collection}/${id}`, 'ok');
      return apiOk(out);
    } catch (e) {
      if (e instanceof DbMirrorError) return apiErr(e.status, e.message);
      throw e;
    }
  });
}
