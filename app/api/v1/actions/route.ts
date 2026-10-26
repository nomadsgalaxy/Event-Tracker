import { withKey, apiOk, requireCap } from '@/lib/api/api-v1';
import { actionNames } from '@/lib/api/api-v1-actions';

export const dynamic = 'force-dynamic';

// GET /api/v1/actions — the server actions a full-access key can call via POST /api/v1/actions/:name.
export async function GET(req: Request) {
  return withKey(req, async (vk) => {
    requireCap(vk, 'api.fullaccess');
    return apiOk({ actions: actionNames() });
  });
}
