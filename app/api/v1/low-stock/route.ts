import { withKey, apiOk, apiErr, keyCan } from '@/lib/api/api-v1';
import { getInventory } from '@/lib/db/data';
import { itemInStorage } from '@/lib/views/inventory-shape';

export const dynamic = 'force-dynamic';

// GET /api/v1/low-stock — inventory items at or below their reorder point (in-storage < reorderPoint).
export async function GET(req: Request) {
  return withKey(req, async (vk) => {
    if (!keyCan(vk, 'db.read.session')) return apiErr(403, 'this key cannot read');
    const items = await getInventory();
    const lowStock = items
      .filter((d) => {
        const it = d.payload;
        return it.reorderPoint != null && (it.reorderPoint as unknown) !== '' && itemInStorage(it) < Number(it.reorderPoint);
      })
      .map((d) => {
        const it = d.payload;
        const inStorage = itemInStorage(it);
        const reorderPoint = Number(it.reorderPoint);
        return {
          itemId: it.id ?? d._id,
          name: it.name || d._id,
          sku: it.qr || it.sku || '',
          inStorage,
          reorderPoint,
          short: reorderPoint - inStorage,
        };
      })
      .sort((a, b) => b.short - a.short);
    return apiOk({ lowStock, count: lowStock.length });
  });
}
