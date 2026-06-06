import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, readBody, qParam, intParam, auditKeyWrite } from '@/lib/api-v1';
import { listRecords, createRecord, DbMirrorError } from '@/lib/api-v1-db';

export const dynamic = 'force-dynamic';

function bodyRecord(body: Record<string, unknown>): Record<string, unknown> {
  return body.record && typeof body.record === 'object' && !Array.isArray(body.record) ? (body.record as Record<string, unknown>) : body;
}

// GET /api/v1/db/:collection?q=&limit=&offset= — list records in an allowlisted collection.
export async function GET(req: NextRequest, { params }: { params: Promise<{ collection: string }> }) {
  const { collection } = await params;
  return withKey(req, async (vk) => {
    try {
      const q = qParam(req, 'q');
      const limit = intParam(req, 'limit', 100, 500);
      const offset = intParam(req, 'offset', 0, 100000);
      return apiOk(await listRecords(vk, collection, q, limit, offset));
    } catch (e) {
      if (e instanceof DbMirrorError) return apiErr(e.status, e.message);
      throw e;
    }
  });
}

// POST /api/v1/db/:collection — create a record (routed through the typed write helper for the collection).
export async function POST(req: NextRequest, { params }: { params: Promise<{ collection: string }> }) {
  const { collection } = await params;
  return withKey(req, async (vk) => {
    try {
      const out = await createRecord(vk, collection, bodyRecord(await readBody(req)));
      await auditKeyWrite(vk, req, 'api.db.create', `${collection}/${String(out.record.id ?? '')}`, 'ok');
      return apiOk({ record: out.record }, out.status);
    } catch (e) {
      if (e instanceof DbMirrorError) return apiErr(e.status, e.message);
      throw e;
    }
  });
}
