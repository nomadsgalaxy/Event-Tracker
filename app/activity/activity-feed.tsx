'use client';

import { useMemo, useState } from 'react';
import { Search, History } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Eyebrow } from '@/components/ui/eyebrow';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ActivityFeedRow } from '@/lib/views/activity';

// activity-feed.tsx — the interactive half of the OPERATIONAL activity log (/activity, user-menu only).
// Faithful to the Python ActivityScreen (index.html ~L29797): a reverse-chronological feed GROUPED BY
// DAY with a free-text search + a TYPE (kind) filter + an ACTOR filter. Each row shows a colored kind
// badge (flag = warning, else accent), then "itemLabel · eventName · [severity] · note · actor (email)
// · time". Read-only — there is no write path to the feed from any client.

export type { ActivityFeedRow } from '@/lib/views/activity';

const ALL = 'all';

function dayKey(at: number): string {
  // Group by LOCAL calendar date (matches the source's per-day grouping; the day heading + the per-row
  // time both read in the viewer's locale/zone). 0/invalid at -> "unknown" tail.
  if (!at) return 'unknown';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtDay(key: string): string {
  if (key === 'unknown') return 'Undated';
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtTime(at: number): string {
  if (!at) return '';
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function ActivityFeed({ rows }: { rows: ActivityFeedRow[] }) {
  const [text, setText] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>(ALL);
  const [actorFilter, setActorFilter] = useState<string>(ALL);

  // Distinct kinds + actors for the filter dropdowns (mirrors the source's allTypes/allActors). Stable.
  const allTypes = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.kind) s.add(r.kind);
    return Array.from(s).sort();
  }, [rows]);
  const allActors = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.actorEmail) s.add(r.actorEmail);
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter !== ALL && r.kind !== typeFilter) return false;
      if (actorFilter !== ALL && r.actorEmail !== actorFilter) return false;
      if (q) {
        const hay = [r.kind, r.actorEmail, r.actorName, r.note, r.eventName, r.itemLabel]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, text, typeFilter, actorFilter]);

  // Group the (already newest-first) rows by calendar day, preserving order.
  const groups = useMemo(() => {
    const m = new Map<string, ActivityFeedRow[]>();
    for (const r of filtered) {
      const key = dayKey(r.at);
      const bucket = m.get(key);
      if (bucket) bucket.push(r);
      else m.set(key, [r]);
    }
    return Array.from(m.entries());
  }, [filtered]);

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar: search + type + actor + a live count. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative min-w-0 flex-1 sm:min-w-52">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search activity…"
            aria-label="Search activity"
            className="h-9 pl-8"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="h-9 w-full sm:w-44" aria-label="Filter by type">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {allTypes.map((t) => (
              <SelectItem key={t} value={t} className="font-mono text-xs">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={actorFilter} onValueChange={setActorFilter}>
          <SelectTrigger className="h-9 w-full sm:w-56" aria-label="Filter by actor">
            <SelectValue placeholder="All actors" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All actors</SelectItem>
            {allActors.map((a) => (
              <SelectItem key={a} value={a} className="text-xs">
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {filtered.length} of {rows.length}
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
          <History className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">
            {rows.length === 0 ? 'No activity yet' : 'No activity matches'}
          </p>
          <p className="text-xs text-muted-foreground">
            {rows.length === 0
              ? 'Sign-off, shipping, and inventory-flag activity will appear here.'
              : 'Adjust the search, type, or actor filter.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map(([day, dayRows]) => (
            <section key={day} className="flex flex-col gap-2">
              <Eyebrow asChild>
                <h2>{fmtDay(day)}</h2>
              </Eyebrow>
              <ul className="flex flex-col gap-1.5">
                {dayRows.map((r) => (
                  <ActivityItem key={r.key} row={r} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityItem({ row: r }: { row: ActivityFeedRow }) {
  const isFlag = r.kind === 'flag';
  // Kind badge color: flag = warning, else the brand accent. Token-driven (never inline hex).
  const badgeColor = isFlag ? 'var(--warning)' : 'var(--primary)';
  const badgeBg = isFlag ? 'color-mix(in oklab, var(--warning) 14%, transparent)' : 'var(--accent)';
  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5">
      <span
        className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide uppercase"
        style={{ color: badgeColor, background: badgeBg }}
      >
        {r.kind}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-sm text-foreground">
          {r.itemLabel ? <span>{r.itemLabel}</span> : null}
          {r.itemLabel && r.eventName ? <span className="text-muted-foreground"> · </span> : null}
          {r.eventName ? <span className="text-muted-foreground">{r.eventName}</span> : null}
          {r.severity ? (
            <span className="ml-1.5 text-xs" style={{ color: 'var(--warning)' }}>
              [{r.severity}]
            </span>
          ) : null}
        </div>
        {r.note && <p className="text-xs text-muted-foreground">{r.note}</p>}
        <p className="text-xs text-muted-foreground/80">
          {r.actorName || r.actorEmail || 'system'}
          {r.actorName && r.actorEmail ? ` (${r.actorEmail})` : ''} · {fmtTime(r.at)}
        </p>
      </div>
    </li>
  );
}

export default ActivityFeed;
