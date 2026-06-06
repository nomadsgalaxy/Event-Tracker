import { type NextRequest } from 'next/server';
import { withKey, apiOk, requireScope, readBody, auditKeyWrite } from '@/lib/api/api-v1';
import { setStaffPii } from '@/lib/db/write';

export const dynamic = 'force-dynamic';

// POST /api/v1/events/:id/travel — set a staffer's travel (flight) on the event. Per-event PII: gated
// by the staff.pii.view scope, and setStaffPii applies the owner half (self / lead / manager). The
// target defaults to the key owner when staffEmail is omitted. Body: { mode, outbound|return, staffEmail }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    requireScope(vk, 'staff.pii.view');
    const body = await readBody(req);
    const { staffEmail, ...patch } = body;
    const res = await setStaffPii({
      eventId: id,
      staffEmail: staffEmail != null ? String(staffEmail) : undefined,
      kind: 'travel',
      patch,
      actorEmail: vk.ownerEmail,
      actorRole: vk.role,
    });
    await auditKeyWrite(vk, req, 'api.event.travel', `events/${id}`, 'ok', { staffEmail: res.staffEmail });
    return apiOk({ travel: res.travel, staffEmail: res.staffEmail });
  });
}
