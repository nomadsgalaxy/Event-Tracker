import { type NextRequest } from 'next/server';
import { withKey, apiOk, apiErr, requireScope, readBody, auditKeyWrite } from '@/lib/api/api-v1';
import { saveEvent } from '@/lib/db/write';

export const dynamic = 'force-dynamic';

// POST /api/v1/events/:id/shipment — record a shipment leg (outbound|return) on an event. Maps to the
// event's outbound/return field, so it goes through saveEvent (event.edit OR lead-of-event).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, async (vk) => {
    requireScope(vk, 'event.edit');
    const body = await readBody(req);
    const direction = String(body.direction ?? '').trim().toLowerCase();
    if (direction !== 'outbound' && direction !== 'return') return apiErr(400, "direction must be 'outbound' or 'return'");
    const leg = {
      carrier: String(body.carrier ?? '').trim(),
      pickupDate: String(body.pickupDate ?? '').trim(),
      tracking: String(body.tracking ?? '').trim(),
      notes: String(body.notes ?? '').trim(),
    };
    await saveEvent({ id, patch: { [direction]: leg } as never, actorEmail: vk.ownerEmail, actorRole: vk.role });
    await auditKeyWrite(vk, req, 'api.event.shipment', `events/${id}`, 'ok', { direction });
    return apiOk({ shipment: { direction, ...leg } });
  });
}
