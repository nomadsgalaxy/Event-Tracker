import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, keyCan, requireScope, readBody, auditKeyWrite } from '@/lib/api/api-v1';
import { getEvent, getInventory } from '@/lib/db/data';
import { saveEvent, softDeleteEvent, setEventCases, type EventPatch } from '@/lib/db/write';
import { stripEventForKey, eventManifest } from '@/lib/api/api-v1-serialize';
import type { VerifiedKey } from '@/lib/api/api-keys';

export const dynamic = 'force-dynamic';

function eventPatchFromBody(body: Record<string, unknown>): EventPatch {
  const { staff, cases, ...rest } = body;
  void staff;
  void cases;
  return rest as EventPatch;
}

async function eventResponse(id: string, vk: VerifiedKey) {
  const doc = await getEvent(id);
  if (!doc) return apiErr(404, 'event not found');
  const inventory = await getInventory();
  return apiOk({
    event: { id: doc._id, ...stripEventForKey(doc.payload, vk) },
    manifest: eventManifest(doc.payload, inventory.map((d) => d.payload)),
  });
}

// GET /api/v1/events/:id — the event (PII-stripped) + its per-case manifest.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    if (!keyCan(vk, 'db.read.session')) return apiErr(403, 'this key cannot read');
    return eventResponse(id, vk);
  });
}

// POST | PATCH /api/v1/events/:id — partial update. Non-case fields go through saveEvent (event.edit
// OR lead-of-event); a `cases` array goes through setEventCases (pallets.edit — the case-assignment
// path). The two caps are gated independently so a pallets.edit key can assign cases without event.edit.
async function update(req: NextRequest, id: string) {
  return withKey(req, async (vk) => {
    const body = await readBody(req);
    const patch = eventPatchFromBody(body);
    let touched = false;
    if (Object.keys(patch).length) {
      requireScope(vk, 'event.edit');
      await saveEvent({ id, patch, actorEmail: vk.ownerEmail, actorRole: vk.role });
      touched = true;
    }
    if (Array.isArray(body.cases)) {
      requireScope(vk, 'pallets.edit');
      await setEventCases({ eventId: id, caseIds: (body.cases as unknown[]).map((c) => String(c)), actorEmail: vk.ownerEmail, actorRole: vk.role });
      touched = true;
    }
    if (!touched) return apiErr(400, 'no editable fields supplied');
    await auditKeyWrite(vk, req, 'api.event.update', `events/${id}`, 'ok');
    return eventResponse(id, vk);
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

// DELETE /api/v1/events/:id — soft-delete (event.delete OR lead-of-event).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    requireScope(vk, 'event.delete');
    const res = await softDeleteEvent({ id, actorEmail: vk.ownerEmail, actorRole: vk.role });
    await auditKeyWrite(vk, req, 'api.event.delete', `events/${id}`, 'ok');
    return apiOk({ ok: res.ok, deleted: id });
  });
}
