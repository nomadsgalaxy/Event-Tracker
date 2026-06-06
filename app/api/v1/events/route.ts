import { withKey, apiOk, apiErr, keyCan, requireScope, readBody, qParam, intParam, matches, auditKeyWrite } from '@/lib/api/api-v1';
import { getEvents, getEvent, getInventory } from '@/lib/db/data';
import { createEvent, type EventPatch } from '@/lib/db/write';
import { stripEventForKey, eventManifest } from '@/lib/api/api-v1-serialize';

export const dynamic = 'force-dynamic';

// Drop the fields the API never lets a generic event write touch: staff (PII — use the travel/lodging
// endpoints, which gate on the staff.pii.view scope) and cases (assigned via the dedicated path on
// update). createEvent/saveEvent also filter to their own allowlist; this is the explicit cut.
function eventPatchFromBody(body: Record<string, unknown>): EventPatch {
  const { staff, cases, ...rest } = body;
  void staff;
  void cases;
  return rest as EventPatch;
}

// GET /api/v1/events?q=&limit=&offset= — list events (PII-stripped to the key's scope).
export async function GET(req: Request) {
  return withKey(req, async (vk) => {
    if (!keyCan(vk, 'db.read.session')) return apiErr(403, 'this key cannot read');
    const q = qParam(req, 'q');
    const limit = intParam(req, 'limit', 100, 500);
    const offset = intParam(req, 'offset', 0, 100000);
    const all = await getEvents();
    const filtered = all.filter((d) => matches(d.payload.name, q) || matches(d._id, q) || matches(d.payload.city, q));
    const events = filtered.slice(offset, offset + limit).map((d) => ({ id: d._id, ...stripEventForKey(d.payload, vk) }));
    return apiOk({ events, total: filtered.length, limit, offset });
  });
}

// POST /api/v1/events — create an event (event.create). Returns the created event (201).
export async function POST(req: Request) {
  return withKey(req, async (vk) => {
    requireScope(vk, 'event.create');
    const body = await readBody(req);
    const res = await createEvent({ patch: eventPatchFromBody(body), actorEmail: vk.ownerEmail, actorRole: vk.role });
    await auditKeyWrite(vk, req, 'api.event.create', `events/${res.id}`, 'ok');
    const doc = await getEvent(res.id);
    const inventory = await getInventory();
    return apiOk(
      doc ? { event: { id: doc._id, ...stripEventForKey(doc.payload, vk) }, manifest: eventManifest(doc.payload, inventory.map((d) => d.payload)) } : { event: { id: res.id } },
      201
    );
  });
}
