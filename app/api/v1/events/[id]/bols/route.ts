import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, keyCan, requireScope, readBody, auditKeyWrite } from '@/lib/api/api-v1';
import { getEvent } from '@/lib/db/data';
import { saveEventBol, WriteForbiddenError } from '@/lib/db/write';
import { publicBol } from '@/lib/api/api-v1-serialize';

// /api/v1/events/:id/bols — bills of lading for an event's freight.
//
// GET  — list them (metadata only; the attached PDF is never echoed — `hasFile` marks one).
// POST — create OR update (pass `id` to update). This is the endpoint an AI agent uses after reading
//        a BOL document: extract the fields, POST them, done. Optionally attach the PDF itself as a
//        `fileDataUrl` data URL (application/pdf, ~700 KB max).
//
// GATE: event.edit (manager+ or the event's lead) — the same cap the editor UI needs, enforced
// inside saveEventBol against the STORED event.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    if (!keyCan(vk, 'db.read.session')) return apiErr(403, 'this key cannot read');
    const doc = await getEvent(id);
    if (!doc) return apiErr(404, 'event not found');
    const bols = Array.isArray(doc.payload.bols) ? doc.payload.bols : [];
    return apiOk({ eventId: doc._id, bols: bols.map(publicBol) });
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    requireScope(vk, 'event.edit');
    const body = await readBody(req);
    try {
      const res = await saveEventBol({ eventId: id, bol: body, actorEmail: vk.ownerEmail, actorRole: vk.role });
      if (!res.ok) return apiErr(res.error === 'No such BOL.' ? 404 : 400, res.error || 'could not save the BOL');
      await auditKeyWrite(vk, req, 'api.event.bol.save', `events/${id}/bols/${res.bolId}`, 'ok', {
        direction: body.direction,
        bolNumber: body.bolNumber,
        attached: typeof body.fileDataUrl === 'string' && body.fileDataUrl.length > 0,
      });
      const doc = await getEvent(id);
      const saved = (doc?.payload.bols ?? []).find((b) => b.id === res.bolId);
      return apiOk({ bol: saved ? publicBol(saved) : { id: res.bolId } }, body.id ? 200 : 201);
    } catch (e) {
      if (e instanceof WriteForbiddenError) return apiErr(403, e.message);
      return apiErr(e instanceof Error && /not found/i.test(e.message) ? 404 : 400, e instanceof Error ? e.message : 'could not save the BOL');
    }
  });
}
