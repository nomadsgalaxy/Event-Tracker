import 'server-only';
import { getEvents, getInventory } from '@/lib/db/data';
import type { EventDoc } from '@/lib/types/types';
import type { InventoryDoc } from '@/lib/views/inventory-shape';

// lib/views/activity.ts — the OPERATIONAL activity feed (Activity screen, /activity).
//
// Faithful port of the Python window.eitActivityFeed (index.html ~L29756) — the SHARED operational
// feed the ActivityScreen renders. It folds, across ALL actors:
//   • every event's audit[] entries  (sign-off / ship / close / reconcile / loose moves), and
//   • every live inventory item's flags[]  (open/closed damage & maintenance flags),
// into ONE descending-by-time list. This is NOT the per-user security `audit_log` (that powered the
// old /activity); the operational feed is the cross-actor logistics trail the source screen shows.
//
// Each row carries: at (ms), kind, actorEmail/actorName, note, eventName, itemLabel, severity.
// PURE projection over the live event + inventory reads. No PII (audit/flag rows carry actor email +
// a short note, never staff travel/hotel) — so this needs no per-staffer strip.

export interface ActivityFeedRow {
  /** Stable React key (kind + index + time — there is no row id on the source rows). */
  key: string;
  at: number;
  kind: string;
  actorEmail: string;
  actorName: string;
  note: string;
  eventName: string;
  itemLabel: string;
  severity: string | null;
}

function toMs(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const n = Date.parse(String(v));
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Build the operational activity feed from the live events + inventory. Mirrors eitActivityFeed:
 *   - each event.audit[] entry -> a row keyed by its `type` (e.g. 'signoff','ship','reconcile'),
 *     actor from a.by.byEmail/byName (or a.byEmail/byName), eventName from the event, no severity.
 *   - each inventory item's flags[] -> a 'flag' row, actor from f.flaggedBy, itemLabel from the item,
 *     severity from f.severity (default 'med'). Soft-deleted items are skipped.
 * Sorted newest-first.
 */
export function buildActivityFeed(events: EventDoc[], inventory: InventoryDoc[]): ActivityFeedRow[] {
  const out: ActivityFeedRow[] = [];
  let i = 0;
  for (const ed of events) {
    const e = ed?.payload;
    if (!e) continue;
    const eventName = e.name || ed._id;
    for (const a of e.audit ?? []) {
      out.push({
        key: `a${i++}`,
        at: toMs(a.at),
        kind: a.type || 'event',
        actorEmail: a.byEmail || 'system',
        actorName: a.byName || '',
        note: a.note || '',
        eventName,
        itemLabel: a.itemLabel || '',
        severity: null,
      });
    }
  }
  for (const id of inventory) {
    const it = id?.payload;
    if (!it || id.deletedAt) continue;
    for (const f of it.flags ?? []) {
      out.push({
        key: `f${i++}`,
        at: toMs(f.flaggedAt),
        kind: 'flag',
        actorEmail: f.flaggedBy || f.by || 'unknown',
        actorName: '',
        note: f.note || '',
        eventName: '',
        itemLabel: it.name || it.slug || it.id || id._id,
        severity: f.severity || 'med',
      });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

/** Read the live events + inventory and build the operational activity feed in one call. */
export async function getActivityFeed(): Promise<ActivityFeedRow[]> {
  const [events, inventory] = await Promise.all([getEvents(), getInventory()]);
  return buildActivityFeed(events, inventory);
}
