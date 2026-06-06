import { withKey, apiOk, apiErr, keyCan, qParam, intParam, matches } from '@/lib/api-v1';
import { getEvents, getCases, getInventory } from '@/lib/data';
import { itemMatchesQuery } from '@/lib/inventory-shape';
import { stripEventForKey } from '@/lib/api-v1-serialize';

export const dynamic = 'force-dynamic';

// GET /api/v1/search?q= — cross-entity free-text search over inventory, cases, and events. Events are
// PII-stripped to the key's scope. Each list is capped (limit, default 25).
export async function GET(req: Request) {
  return withKey(req, async (vk) => {
    if (!keyCan(vk, 'db.read.session')) return apiErr(403, 'this key cannot read');
    const q = qParam(req, 'q');
    const limit = intParam(req, 'limit', 25, 200);

    const [events, cases, inventory] = await Promise.all([getEvents(), getCases(), getInventory()]);

    const invHits = inventory
      .filter((d) => itemMatchesQuery(d.payload, d._id, q))
      .slice(0, limit)
      .map((d) => ({ id: d._id, name: d.payload.name || d._id, sku: d.payload.qr || d.payload.sku || '', kind: d.payload.kind || d.payload.type || '' }));

    const caseHits = cases
      .filter((d) => matches(d.payload.label, q) || matches(d.payload.slug, q) || matches(d._id, q))
      .slice(0, limit)
      .map((d) => ({ id: d._id, label: d.payload.label || d._id, zone: d.payload.zone || '' }));

    const eventHits = events
      .filter((d) => matches(d.payload.name, q) || matches(d._id, q) || matches(d.payload.city, q))
      .slice(0, limit)
      .map((d) => {
        const p = stripEventForKey(d.payload, vk);
        return { id: d._id, name: p.name || d._id, state: p.state || 'draft', startDate: p.startDate || '' };
      });

    return apiOk({ query: q, inventory: invHits, cases: caseHits, events: eventHits });
  });
}
