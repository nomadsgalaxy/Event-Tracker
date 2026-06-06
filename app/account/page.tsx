import { requireUser } from '@/lib/auth';
import { getDb, NOT_DELETED } from '@/lib/mongo';
import { DEFAULT_ROLES } from '@/lib/rbac';
import { clampThemeId } from '@/lib/themes';
import type { UserDoc, AccommodationsProfile } from '@/lib/types';
import { getWarehouses } from '@/app/warehouses/warehouse-data';
import { ScreenHeader } from '@/components/ui/screen-header';
import { AccountTabs, type AccountInitial } from './account-tabs';

// /account — Account & Preferences (Archetype B: an eyebrow→title header over an underline tab
// strip; each tab's save patches ONLY its own fields — the #37 tab-scoping rule). Reachable ONLY
// from the user menu, never the primary nav. AUTH-GATED self-only (requireUser): a user manages
// THEIR OWN record; there is no other-user surface here. Mirrors index.html AccountScreen
// (Profile / Travel & Display / Security) — re-organized to the task's Profile / Preferences /
// Security tab set.
//
// LIVE-DB: reads the caller's OWN `users` directory doc (pinned to the session email) on every
// request — no cache, no localStorage. The Server Actions in ./actions.ts write it back, scoped to
// the same self email.
export const dynamic = 'force-dynamic';

const USERS_COLLECTION = 'users';

function roleLabel(role: string): string {
  return DEFAULT_ROLES.find((r) => r.id === role)?.label ?? role;
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [user, sp] = await Promise.all([requireUser(), searchParams]);
  const id = String(user.email).trim().toLowerCase();

  // Self-scoped read — the caller's OWN directory record, pinned to the session email (scalar _id).
  // Also read the warehouses for the home-warehouse picker (#66).
  const db = await getDb();
  const [doc, warehouseDocs] = await Promise.all([
    db.collection<UserDoc>(USERS_COLLECTION).findOne({ _id: id, ...NOT_DELETED }),
    getWarehouses(),
  ]);
  const p = (doc?.payload ?? {}) as UserDoc['payload'] & {
    unitPrefs?: { temperature?: string; weight?: string; dateFormat?: string } | null;
    portOfCall?: { airport?: string; trainStation?: string } | null;
    accommodations?: AccommodationsProfile | null;
    uiTheme?: string;
    homeWarehouseId?: string | null;
    source?: string;
  };

  // The ?linked= OAuth-bind return banner (the source's __eitLinkedBanner). `linked=<provider>` =
  // success; `linked_error=<reason>` = failure. Both are short, sanitized server-side here.
  const linkedRaw = typeof sp.linked === 'string' ? sp.linked : '';
  const linkedErrRaw = typeof sp.linked_error === 'string' ? sp.linked_error : '';
  const linkedBanner = linkedRaw
    ? { ok: true, msg: `Linked your ${linkedRaw} sign-in to this account.` }
    : linkedErrRaw
      ? { ok: false, msg: `Couldn't link that sign-in: ${linkedErrRaw}.` }
      : null;

  // A lean, serializable projection for the client tabs (no Mongo internals). The LIVE role comes
  // from requireUser (re-resolved every request), NOT the stored payload.role — so a demotion shows
  // immediately and the read-only "Role" field never misrepresents the session.
  const initial: AccountInitial = {
    email: id,
    name: p.name ?? '',
    role: user.role,
    roleLabel: roleLabel(user.role),
    preferredName: p.preferredName ?? '',
    picture: typeof p.picture === 'string' ? p.picture : '',
    source: typeof p.source === 'string' ? p.source : '',
    accommodations: (p.accommodations ?? null) as AccommodationsProfile | null,
    uiTheme: clampThemeId(p.uiTheme),
    homeWarehouseId: typeof p.homeWarehouseId === 'string' ? p.homeWarehouseId : '',
    warehouses: warehouseDocs.map((w) => ({
      id: w._id,
      name: w.payload?.name || w._id,
      isHq: w.payload?.type === 'hq',
    })),
    prefs: {
      temperature: p.unitPrefs?.temperature === 'C' ? 'C' : 'F',
      weight: p.unitPrefs?.weight === 'kg' ? 'kg' : 'lbs',
      dateFormat: (['auto', 'mdy', 'dmy', 'ymd'] as const).includes(
        p.unitPrefs?.dateFormat as 'auto' | 'mdy' | 'dmy' | 'ymd'
      )
        ? (p.unitPrefs!.dateFormat as 'auto' | 'mdy' | 'dmy' | 'ymd')
        : 'auto',
      airport: p.portOfCall?.airport ?? '',
      trainStation: p.portOfCall?.trainStation ?? '',
    },
  };

  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <ScreenHeader
        eyebrow={`You · Account · ${id}`}
        title="Account & Preferences"
        subtitle="Manage your profile, display preferences, and account security. Each section saves on its own."
      />
      <AccountTabs initial={initial} linkedBanner={linkedBanner} />
    </div>
  );
}
