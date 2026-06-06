import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, readBody, auditKeyWrite } from '@/lib/api-v1';
import { getRecord, updateRecord, DbMirrorError } from '@/lib/api-v1-db';

export const dynamic = 'force-dynamic';

function bodyRecord(body: Record<string, unknown>): Record<string, unknown> {
  return body.record && typeof body.record === 'object' && !Array.isArray(body.record) ? (body.record as Record<string, unknown>) : body;
}

// GET /api/v1/db/:collection/:id — one record (PII-shaped per collection).
export async function GET(req: NextRequest, { params }: { params: Promise<{ collection: string; id: string }> }) {
  const { collection, id } = await params;
  return withKey(req, async (vk) => {
    try {
      return apiOk(await getRecord(vk, collection, id));
    } catch (e) {
      if (e instanceof DbMirrorError) return apiErr(e.status, e.message);
      throw e;
    }
  });
}

// POST /api/v1/db/:collection/:id — shallow-merge update (routed through the typed write helper).
export async function POST(req: NextRequest, { params }: { params: Promise<{ collection: string; id: string }> }) {
  const { collection, id } = await params;
  return withKey(req, async (vk) => {
    try {
      const out = await updateRecord(vk, collection, id, bodyRecord(await readBody(req)));
      await auditKeyWrite(vk, req, 'api.db.update', `${collection}/${id}`, 'ok');
      return apiOk(out);
    } catch (e) {
      if (e instanceof DbMirrorError) return apiErr(e.status, e.message);
      throw e;
    }
  });
}
