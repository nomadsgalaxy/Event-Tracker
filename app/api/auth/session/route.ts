import { getCurrentUser } from '@/lib/auth/auth';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import { clampThemeId } from '@/lib/util/themes';
import type { UserDoc } from '@/lib/types/types';
import { jsonOk, jsonErr } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// GET /api/auth/session — who the `_eit_auth` cookie belongs to, plus their display preferences.
// Lets a same-origin daughter app (Expense Reporter at /expenses) share the Event Tracker sign-in: it
// forwards the browser's cookie here server-to-server instead of holding ET_SESSION_SECRET itself, so
// every check stays in one place — signature, expiry, stage 'full', revocation and the LIVE role
// (getCurrentUser). Self-only: the caller learns nothing about anyone else. No accommodations, no
// contacts — identity + prefs only.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonErr(401, 'sign in first');
  const email = String(user.email).trim().toLowerCase();

  const db = await getDb();
  const doc = await db.collection<UserDoc>('users').findOne({ _id: email, ...NOT_DELETED });
  const p = (doc?.payload ?? {}) as UserDoc['payload'] & {
    unitPrefs?: { temperature?: string; weight?: string; dateFormat?: string } | null;
    portOfCall?: { airport?: string; trainStation?: string } | null;
    uiTheme?: string;
  };
  const dateFormat = p.unitPrefs?.dateFormat;

  return jsonOk({
    email,
    role: user.role,
    name: (p.preferredName || p.name || '').trim() || null,
    picture: typeof p.picture === 'string' && p.picture ? p.picture : null,
    src: user.session.src,
    exp: user.session.exp,
    prefs: {
      uiTheme: clampThemeId(p.uiTheme),
      temperature: p.unitPrefs?.temperature === 'C' ? 'C' : 'F',
      weight: p.unitPrefs?.weight === 'kg' ? 'kg' : 'lbs',
      dateFormat: dateFormat === 'mdy' || dateFormat === 'dmy' || dateFormat === 'ymd' ? dateFormat : 'auto',
      airport: p.portOfCall?.airport || null,
      trainStation: p.portOfCall?.trainStation || null,
    },
  });
}
