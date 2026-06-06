import { withKey, apiOk } from '@/lib/api-v1';

export const dynamic = 'force-dynamic';

// GET /api/v1/whoami — identify the key in use: owner email, live role, the key's effective caps, and
// the key id/label. Lets a client self-discover what it may do (effective = scoped caps ∩ live role).
export async function GET(req: Request) {
  return withKey(req, async (vk) => {
    const caps = [...vk.effectiveCaps].sort();
    return apiOk({
      email: vk.ownerEmail,
      role: vk.role,
      scope: vk.effectiveCaps.has('db.write.app') ? 'write' : 'read',
      caps,
      key: { id: vk.keyId, label: vk.label },
    });
  });
}
