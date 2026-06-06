import { getDb } from '@/lib/mongo';
import { DEMO_MODE } from '@/lib/demo';

export const dynamic = 'force-dynamic';

// GET /api/demo/export — download THIS visitor's sandbox as the app's standard `_eitBackup` v2 JSON,
// so they can take the data they built in the demo and import it into their own deployment. Reads the
// cookie-keyed sandbox via getDb (their own data only — same isolation as every other read). Demo only.
//
// Credentials are stripped: `auth` is exported as a credential-LESS roster (no pw/totp/recovery/
// passkeys/identities/apiKeys), matching how the app's own backup export redacts secrets.
const DATA_COLLECTIONS = ['events', 'cases', 'inventory', 'warehouses', 'emergency_contact', 'tags', 'metadata', 'sync_meta', 'users'];
const AUTH_SECRET_FIELDS = ['pw', 'totp', 'totpPending', 'recovery', 'passkeys', 'oauthIdentities', 'apiKeys', 'calFeed', 'calFeedGlobal'];

export async function GET() {
  if (!DEMO_MODE) return new Response('Not found', { status: 404 });

  const db = await getDb(); // the visitor's own sandbox (cookie-keyed; isolated)
  const collections: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const name of DATA_COLLECTIONS) {
    const docs = await db.collection(name).find({}).toArray();
    collections[name] = docs;
    counts[name] = docs.length;
  }

  const authRoster = (await db.collection('auth').find({}).toArray()).map((doc) => {
    const rec = { ...(doc as Record<string, unknown>) };
    for (const f of AUTH_SECRET_FIELDS) delete rec[f];
    return rec;
  });
  counts.authRoster = authRoster.length;

  const auditLog = await db.collection('audit_log').find({}).toArray();
  counts.auditLog = auditLog.length;

  const payload = {
    _eitBackup: 2,
    version: 2,
    createdAt: Date.now(),
    db: 'demo',
    collections,
    authRoster,
    settings: {},
    auditLog,
    counts,
  };

  return new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="event-tracker-demo-export.json"',
      'Cache-Control': 'no-store',
    },
  });
}
