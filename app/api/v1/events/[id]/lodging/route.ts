import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, requireScope, readBody, auditKeyWrite } from '@/lib/api/api-v1';
import { setStaffPii } from '@/lib/db/write';

export const dynamic = 'force-dynamic';

// POST /api/v1/events/:id/lodging — set a staffer's hotel on the event. Per-event PII: gated by the
// staff.pii.view scope; setStaffPii applies the owner half (self / lead / manager). Target defaults to
// the key owner. Body: { name, confirmation, checkInAt, checkOutAt, address, room, phone, staffEmail }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    requireScope(vk, 'staff.pii.view');
    const body = await readBody(req);
    if (!String(body.name ?? '').trim()) return apiErr(400, 'a hotel name is required');
    const { staffEmail, ...patch } = body;
    const res = await setStaffPii({
      eventId: id,
      staffEmail: staffEmail != null ? String(staffEmail) : undefined,
      kind: 'hotel',
      patch,
      actorEmail: vk.ownerEmail,
      actorRole: vk.role,
    });
    await auditKeyWrite(vk, req, 'api.event.lodging', `events/${id}`, 'ok', { staffEmail: res.staffEmail });
    return apiOk({ hotel: res.hotel, staffEmail: res.staffEmail });
  });
}
