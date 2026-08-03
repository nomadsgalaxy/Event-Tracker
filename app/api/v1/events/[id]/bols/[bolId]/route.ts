import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, requireScope, readBody, auditKeyWrite } from '@/lib/api/api-v1';
import { getEvent } from '@/lib/db/data';
import { saveEventBol, removeEventBol, WriteForbiddenError } from '@/lib/db/write';
import { publicBol } from '@/lib/api/api-v1-serialize';

// PATCH /api/v1/events/:id/bols/:bolId — update one BOL in place (partial: only the fields you send;
// `fileDataUrl: ""` clears the attachment). DELETE — remove it. Both need event.edit, re-checked
// against the stored event inside the write helpers.
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; bolId: string }> }) {
  const { id, bolId } = await params;
  return withKey(req, async (vk) => {
    requireScope(vk, 'event.edit');
    const body = await readBody(req);
    try {
      // The stored record supplies every field the caller didn't send (saveEventBol rebuilds the
      // whole record from `prev`, so a bare PATCH can't blank the rest).
      const doc = await getEvent(id);
      if (!doc) return apiErr(404, 'event not found');
      const prev = (doc.payload.bols ?? []).find((b) => b.id === bolId);
      if (!prev) return apiErr(404, 'BOL not found');
      const merged = { ...prev, ...body, id: bolId, direction: body.direction ?? prev.direction };
      const res = await saveEventBol({ eventId: id, bol: merged, actorEmail: vk.ownerEmail, actorRole: vk.role });
      if (!res.ok) return apiErr(400, res.error || 'could not update the BOL');
      await auditKeyWrite(vk, req, 'api.event.bol.update', `events/${id}/bols/${bolId}`, 'ok');
      const after = await getEvent(id);
      const saved = (after?.payload.bols ?? []).find((b) => b.id === bolId);
      return apiOk({ bol: saved ? publicBol(saved) : { id: bolId } });
    } catch (e) {
      if (e instanceof WriteForbiddenError) return apiErr(403, e.message);
      return apiErr(400, e instanceof Error ? e.message : 'could not update the BOL');
    }
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; bolId: string }> }) {
  const { id, bolId } = await params;
  return withKey(req, async (vk) => {
    requireScope(vk, 'event.edit');
    try {
      const res = await removeEventBol({ eventId: id, bolId, actorEmail: vk.ownerEmail, actorRole: vk.role });
      if (!res.ok) return apiErr(res.error === 'No such BOL.' ? 404 : 400, res.error || 'could not delete the BOL');
      await auditKeyWrite(vk, req, 'api.event.bol.delete', `events/${id}/bols/${bolId}`, 'ok');
      return apiOk({ deleted: bolId });
    } catch (e) {
      if (e instanceof WriteForbiddenError) return apiErr(403, e.message);
      return apiErr(400, e instanceof Error ? e.message : 'could not delete the BOL');
    }
  });
}
