import { requireRole } from '@/lib/auth';
import { getAuditPage, AUDIT_DEFAULT_LIMIT } from '@/lib/data';
import { getEvents, getInventory } from '@/lib/data';
import { buildActivityFeed } from '@/lib/activity';
import { AuditTable, type AuditRow, type ActivityRow } from './audit-table';

// app/config/audit — the security AUDIT LOG with advanced filters + pagination + an optional
// operational-ACTIVITY interleave. Server Component:
//   • Reads `audit_log` LIVE (admin-only, off the data-plane allowlist; re-asserted here) with the
//     URL searchParams driving the filters — actor / result / date range / free-text — and
//     limit/offset pagination (default 100/page) returning the matching `total` + the actor/action
//     facets. Faithful to eit_audit.handle.
//   • When the URL asks to show activity, ALSO folds the operational feed (every event.audit[] entry
//     + every inventory item flag, via buildActivityFeed) into the view so the SECURITY trail and the
//     ACTIVITY trail can be read together, each source-tagged. This is a pure read of the live
//     events+inventory — no PII (audit/flag rows carry actor + a short note only).
// The pagination + filters are URL-reflected so Prev/Next are real navigations (shareable, back-button
// friendly) — the client form just pushes the next querystring.
export const dynamic = 'force-dynamic';

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}
function numOrUndef(v: string): number | undefined {
  if (!v) return undefined;
  // The date inputs post yyyy-mm-dd; convert to an epoch-ms bound. A bare number passes through.
  const asNum = Number(v);
  if (Number.isFinite(asNum) && /^\d+$/.test(v)) return asNum;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

export default async function ConfigAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole('admin');
  const sp = await searchParams;

  const action = first(sp.action);
  const actor = first(sp.actor);
  const result = first(sp.result);
  const q = first(sp.q);
  const fromRaw = first(sp.from);
  const toRaw = first(sp.to);
  const from = numOrUndef(fromRaw);
  // The "to" date is inclusive of the whole day — bump to end-of-day if a bare date was given.
  const toBase = numOrUndef(toRaw);
  const to = toBase != null && /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? toBase + 86_399_999 : toBase;
  const showActivity = first(sp.activity) === '1';
  const offset = Math.max(0, Number(first(sp.offset)) || 0);

  const page = await getAuditPage({ action, actor, result, q, from, to, limit: AUDIT_DEFAULT_LIMIT, offset });

  const rows: AuditRow[] = page.entries.map((e) => ({
    id: e._id,
    ts: e.ts,
    actor: e.actor ?? '',
    action: e.action ?? '',
    target: e.target ?? '',
    result: e.result ?? 'ok',
    ip: e.ip ?? '',
    detail:
      e.detail == null ? '' : typeof e.detail === 'string' ? e.detail : safeStringify(e.detail),
  }));

  // Operational activity (only fetched when requested — it's a full events+inventory read).
  let activity: ActivityRow[] = [];
  if (showActivity) {
    const [events, inventory] = await Promise.all([getEvents(), getInventory()]);
    activity = buildActivityFeed(events, inventory).map((a) => ({
      key: a.key,
      ts: a.at,
      actor: a.actorName || a.actorEmail || 'system',
      action: a.kind,
      context: a.eventName || a.itemLabel || '',
      note: a.note || '',
      severity: a.severity,
    }));
  }

  return (
    <AuditTable
      rows={rows}
      total={page.total}
      limit={page.limit}
      offset={page.offset}
      actions={page.actions}
      actors={page.actors}
      activity={activity}
      showActivity={showActivity}
      filters={{ action, actor, result, q, from: fromRaw, to: toRaw }}
    />
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
