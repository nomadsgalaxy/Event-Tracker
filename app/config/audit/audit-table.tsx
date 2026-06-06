'use client';

import { useMemo, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import {
  Search,
  ScrollText,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  Activity,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

// audit-table.tsx — the AUDIT log view with advanced filters + pagination + the optional operational-
// activity interleave. The filters are URL-reflected: changing one pushes the next querystring (the
// page re-reads server-side, applying the filter against Mongo). The Show-activity toggle folds the
// operational feed (event history + item flags) IN, source-tagged SECURITY vs ACTIVITY. Each security
// row expands to its raw JSON detail. The result column distinguishes the soft-fail (a denied write
// the app handled) from a hard 403/error.

export interface AuditRow {
  id: string;
  ts: number;
  actor: string;
  action: string;
  target: string;
  result: string;
  ip: string;
  detail: string;
}

export interface ActivityRow {
  key: string;
  ts: number;
  actor: string;
  action: string;
  context: string;
  note: string;
  severity: string | null;
}

export interface AuditFilters {
  action: string;
  actor: string;
  result: string;
  q: string;
  from: string;
  to: string;
}

const ALL = '__all__';

function fmtTs(ts: number): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function AuditTable({
  rows,
  total,
  limit,
  offset,
  actions,
  actors,
  activity,
  showActivity,
  filters,
}: {
  rows: AuditRow[];
  total: number;
  limit: number;
  offset: number;
  actions: string[];
  actors: string[];
  activity: ActivityRow[];
  showActivity: boolean;
  filters: AuditFilters;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // Free-text is debounced into the URL via the form submit (Enter) or the Apply button; the dropdowns
  // navigate immediately. A local `q` mirror keeps the input responsive before submit.
  const [q, setQ] = useState(filters.q);

  // Build the next querystring from the current filters + an override, RESETTING offset to 0 on any
  // filter change (a new filter starts at page 1). Pagination passes an explicit offset to keep it.
  function navigate(overrides: Partial<AuditFilters & { activity: boolean; offset: number }>) {
    const params = new URLSearchParams();
    const next = {
      action: filters.action,
      actor: filters.actor,
      result: filters.result,
      q: filters.q,
      from: filters.from,
      to: filters.to,
      activity: showActivity,
      offset: 0,
      ...overrides,
    };
    if (next.action) params.set('action', next.action);
    if (next.actor) params.set('actor', next.actor);
    if (next.result) params.set('result', next.result);
    if (next.q) params.set('q', next.q);
    if (next.from) params.set('from', next.from);
    if (next.to) params.set('to', next.to);
    if (next.activity) params.set('activity', '1');
    if (next.offset) params.set('offset', String(next.offset));
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const hasFilters =
    !!filters.action || !!filters.actor || !!filters.result || !!filters.q || !!filters.from || !!filters.to;

  const page = Math.floor(offset / Math.max(1, limit)) + 1;
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + rows.length, total);

  // Merge the security rows with the (optional) activity rows for the interleaved render, tagging each
  // by source + sorting newest-first. When activity is OFF, only the (already-paginated) security rows.
  const merged = useMemo(() => {
    const sec = rows.map((r) => ({ source: 'security' as const, ts: r.ts, sec: r, act: null as ActivityRow | null }));
    if (!showActivity) return sec;
    const act = activity.map((a) => ({ source: 'activity' as const, ts: a.ts, sec: null as AuditRow | null, act: a }));
    return [...sec, ...act].sort((a, b) => b.ts - a.ts);
  }, [rows, activity, showActivity]);

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Actor</Label>
            <Select
              value={filters.actor || ALL}
              onValueChange={(v) => navigate({ actor: v === ALL ? '' : v })}
            >
              <SelectTrigger className="w-52" aria-label="Filter by actor">
                <SelectValue placeholder="All actors" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All actors</SelectItem>
                {actors.map((a) => (
                  <SelectItem key={a} value={a} className="font-mono text-xs">
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Action</Label>
            <Select
              value={filters.action || ALL}
              onValueChange={(v) => navigate({ action: v === ALL ? '' : v })}
            >
              <SelectTrigger className="w-52" aria-label="Filter by action">
                <SelectValue placeholder="All actions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All actions</SelectItem>
                {actions.map((a) => (
                  <SelectItem key={a} value={a} className="font-mono text-xs">
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Result</Label>
            <Select
              value={filters.result || ALL}
              onValueChange={(v) => navigate({ result: v === ALL ? '' : v })}
            >
              <SelectTrigger className="w-36" aria-label="Filter by result">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any result</SelectItem>
                <SelectItem value="ok">OK</SelectItem>
                <SelectItem value="fail">Fail</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="audit-from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="audit-from"
              type="date"
              defaultValue={/^\d{4}-\d{2}-\d{2}$/.test(filters.from) ? filters.from : ''}
              onChange={(e) => navigate({ from: e.target.value })}
              className="w-40"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="audit-to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="audit-to"
              type="date"
              defaultValue={/^\d{4}-\d{2}-\d{2}$/.test(filters.to) ? filters.to : ''}
              onChange={(e) => navigate({ to: e.target.value })}
              className="w-40"
            />
          </div>

          <form
            className="relative flex-1 min-w-[220px]"
            onSubmit={(e) => {
              e.preventDefault();
              navigate({ q });
            }}
          >
            <Label htmlFor="audit-q" className="text-xs text-muted-foreground">
              Search
            </Label>
            <div className="relative mt-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="audit-q"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="actor, action, target… (Enter to apply)"
                aria-label="Search the audit log"
                className="pl-8"
              />
            </div>
          </form>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="show-activity"
              checked={showActivity}
              onCheckedChange={(v) => navigate({ activity: v })}
            />
            <Label htmlFor="show-activity" className="text-sm text-muted-foreground">
              Show operational activity (event history + item flags)
            </Label>
          </div>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQ('');
                router.push(showActivity ? `${pathname}?activity=1` : pathname);
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      </div>

      {/* Count + pagination header */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>
          {total === 0 ? (
            'No matching entries'
          ) : (
            <>
              Showing <span className="tabular-nums text-foreground">{showingFrom}</span>–
              <span className="tabular-nums text-foreground">{showingTo}</span> of{' '}
              <span className="tabular-nums text-foreground">{total}</span> security entries
              {showActivity && activity.length > 0 && (
                <span className="text-muted-foreground"> · {activity.length} activity rows merged</span>
              )}
            </>
          )}
        </span>
        <div className="flex items-center gap-2">
          <span className="tabular-nums">
            Page {page} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={offset <= 0}
            onClick={() => navigate({ offset: Math.max(0, offset - limit) })}
          >
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + limit >= total}
            onClick={() => navigate({ offset: offset + limit })}
          >
            Next
          </Button>
        </div>
      </div>

      {merged.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
          <ScrollText className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">No entries to show</p>
          <p className="text-xs text-muted-foreground">
            {hasFilters ? 'Adjust or clear the filters.' : 'The audit log is empty.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[1fr] divide-y divide-border">
            {merged.map((m) =>
              m.source === 'security' && m.sec ? (
                <SecurityRowView key={m.sec.id} row={m.sec} />
              ) : m.act ? (
                <ActivityRowView key={m.act.key} row={m.act} />
              ) : null
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SourceTag({ source }: { source: 'security' | 'activity' }) {
  return source === 'security' ? (
    <Badge variant="outline" className="gap-1 text-[10px] text-st-upcoming" style={{ color: 'var(--st-upcoming)', borderColor: 'var(--st-upcoming)' }}>
      <ShieldAlert className="size-2.5" aria-hidden /> SECURITY
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
      <Activity className="size-2.5" aria-hidden /> ACTIVITY
    </Badge>
  );
}

function SecurityRowView({ row: r }: { row: AuditRow }) {
  const [open, setOpen] = useState(false);
  const ok = r.result === 'ok';
  const hasDetail = !!r.detail;
  return (
    <div className="bg-background">
      <div className="flex items-start gap-3 px-3 py-2.5 hover:bg-card/50">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((o) => !o)}
          disabled={!hasDetail}
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-0"
          aria-label={open ? 'Collapse detail' : 'Expand detail'}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SourceTag source="security" />
            <code className="font-mono text-xs text-foreground">{r.action}</code>
            <span className="text-xs text-muted-foreground tabular-nums">{fmtTs(r.ts)}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="truncate">
              actor <span className="font-mono text-foreground">{r.actor || '—'}</span>
            </span>
            {r.target && (
              <span className="truncate">
                target <span className="font-mono text-foreground">{r.target}</span>
              </span>
            )}
            {r.ip && <span className="font-mono text-[10px]">{r.ip}</span>}
          </div>
          {open && hasDetail && (
            <pre className="mt-2 overflow-x-auto rounded border border-border bg-card p-2 font-mono text-[11px] text-muted-foreground">
              {r.detail}
            </pre>
          )}
        </div>

        <Badge
          variant="outline"
          className={cn('shrink-0 gap-1 font-medium', ok ? 'text-success' : 'text-destructive')}
          style={{
            color: ok ? 'var(--success)' : 'var(--destructive)',
            borderColor: ok ? 'var(--success)' : 'var(--destructive)',
          }}
          // The soft-fail vs hard-403 distinction: a non-'ok' result is a DENIED/failed action the
          // trail recorded (e.g. a 403 a non-admin hit) — surfaced as a destructive 'fail' pill.
          title={ok ? 'Action succeeded' : 'Action was denied or failed (soft-fail / 403)'}
        >
          {ok ? <CheckCircle2 className="size-3" aria-hidden /> : <XCircle className="size-3" aria-hidden />}
          {r.result}
        </Badge>
      </div>
    </div>
  );
}

function ActivityRowView({ row: a }: { row: ActivityRow }) {
  return (
    <div className="bg-background">
      <div className="flex items-start gap-3 px-3 py-2.5 hover:bg-card/50">
        <span className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SourceTag source="activity" />
            <code className="font-mono text-xs text-foreground">{a.action}</code>
            <span className="text-xs text-muted-foreground tabular-nums">{fmtTs(a.ts)}</span>
            {a.severity && (
              <Badge variant="secondary" className="text-[10px] capitalize">
                {a.severity}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="truncate">
              by <span className="text-foreground">{a.actor || 'system'}</span>
            </span>
            {a.context && <span className="truncate">{a.context}</span>}
          </div>
          {a.note && <p className="mt-0.5 truncate text-xs text-muted-foreground/80">{a.note}</p>}
        </div>
      </div>
    </div>
  );
}

export default AuditTable;
