import { withKey, apiOk, apiErr, keyCan } from '@/lib/api/api-v1';
import { getEvents, getCases, getInventory } from '@/lib/db/data';

export const dynamic = 'force-dynamic';

// GET /api/v1/status — high-level instance counts (events / cases / inventory) + a generated timestamp.
export async function GET(req: Request) {
  return withKey(req, async (vk) => {
    if (!keyCan(vk, 'db.read.session')) return apiErr(403, 'this key cannot read');
    const [events, cases, inventory] = await Promise.all([getEvents(), getCases(), getInventory()]);
    return apiOk({
      events: events.length,
      cases: cases.length,
      inventory: inventory.length,
      generatedAt: new Date().toISOString(),
    });
  });
}
