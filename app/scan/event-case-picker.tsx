'use client';

import { useMemo, useState } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Eyebrow } from '@/components/ui/eyebrow';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/util/utils';
import type { ScanCaseLean, ScanEventLean } from '@/lib/views/scan';

// app/scan/event-case-picker.tsx — the manual case picker. Faithful port of index.html
// EventCasePicker (~L17411): a three-tab full-screen picker — Packing / Returning / Unassigned —
// with PER-TAB COUNTS, PER-EVENT grouping (each event header + its held cases), and a per-tab empty
// message. Packing groups events in packing/ready/in_transit/onsite; Returning groups
// returning/unpacking; Unassigned lists every live, non-retired case held by NO in-flight event.
// Tapping a case fires onPick(caseId) and closes.

const PACK_STATES = ['packing', 'ready', 'in_transit', 'onsite'];
const UNPACK_STATES = ['returning', 'unpacking'];

export function EventCasePicker({
  events,
  cases,
  open,
  onOpenChange,
  onPick,
}: {
  events: ScanEventLean[];
  cases: ScanCaseLean[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (caseId: string) => void;
}) {
  const [tab, setTab] = useState<'packing' | 'returning' | 'unassigned'>('packing');

  const groups = useMemo(() => {
    const caseById = new Map(cases.map((c) => [c.id, c]));
    const packing: { event: ScanEventLean; cases: ScanCaseLean[] }[] = [];
    const returning: { event: ScanEventLean; cases: ScanCaseLean[] }[] = [];
    const heldCaseIds = new Set<string>();
    for (const e of events) {
      const p = e.payload;
      if (!p || (p as { deletedAt?: number | null }).deletedAt) continue;
      const st = String(p.state);
      const inPack = PACK_STATES.includes(st);
      const inUnpack = UNPACK_STATES.includes(st);
      if (inPack || inUnpack) {
        const cs = (p.cases || []).map((cid) => caseById.get(cid)).filter((c): c is ScanCaseLean => !!c);
        const entry = { event: e, cases: cs };
        if (inPack) packing.push(entry);
        else returning.push(entry);
        for (const cid of p.cases || []) heldCaseIds.add(cid);
      }
    }
    // Unassigned = live, non-retired cases held by no in-flight event.
    const unassigned = cases.filter((c) => !heldCaseIds.has(c.id) && !c.retired);
    return { packing, returning, unassigned };
  }, [events, cases]);

  const tabs = [
    { k: 'packing' as const, l: 'Packing', n: groups.packing.reduce((a, e) => a + e.cases.length, 0) },
    { k: 'returning' as const, l: 'Returning', n: groups.returning.reduce((a, e) => a + e.cases.length, 0) },
    { k: 'unassigned' as const, l: 'Unassigned', n: groups.unassigned.length },
  ];

  function pick(caseId: string) {
    onPick(caseId);
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[90dvh] gap-0 p-0">
        <SheetHeader className="border-b border-border">
          <SheetTitle>Open a case</SheetTitle>
          <SheetDescription className="sr-only">
            Pick a road case to pack into, grouped by Packing, Returning, or Unassigned.
          </SheetDescription>
          <div className="mt-2 flex gap-1">
            {tabs.map((t) => {
              const active = tab === t.k;
              return (
                <button
                  key={t.k}
                  type="button"
                  onClick={() => setTab(t.k)}
                  className={cn(
                    'flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                  )}
                  aria-pressed={active}
                >
                  {t.l} <span className="opacity-70">{t.n}</span>
                </button>
              );
            })}
          </div>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
          {tab === 'packing' && groups.packing.length === 0 && (
            <EmptyLine>No events in packing/ready/transit/on-site.</EmptyLine>
          )}
          {tab === 'returning' && groups.returning.length === 0 && <EmptyLine>No events in returning/unpacking.</EmptyLine>}
          {tab === 'unassigned' && groups.unassigned.length === 0 && <EmptyLine>No unassigned cases.</EmptyLine>}

          {(tab === 'packing' ? groups.packing : tab === 'returning' ? groups.returning : []).map((g) => (
            <div key={g.event.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 py-1.5">
                <span className="text-xs font-bold uppercase tracking-[0.04em] text-foreground">
                  {g.event.payload.name || g.event.id}
                </span>
                {g.event.payload.state ? <StatusBadge state={g.event.payload.state} /> : null}
              </div>
              {g.cases.length === 0 && <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No cases on this event.</p>}
              {g.cases.map((c) => (
                <CaseRow key={c.id} c={c} onPick={pick} />
              ))}
            </div>
          ))}

          {tab === 'unassigned' && groups.unassigned.map((c) => <CaseRow key={c.id} c={c} sub="no event" onPick={pick} />)}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CaseRow({ c, sub, onPick }: { c: ScanCaseLean; sub?: string; onPick: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(c.id)}
      className={cn(
        'flex w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors',
        'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium text-foreground">{c.label || c.slug || c.id}</span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {(c.slug || c.id) + (sub ? ' · ' + sub : '')}
        </span>
      </span>
    </button>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-5 text-center">
      <Eyebrow className="text-muted-foreground">{children}</Eyebrow>
    </div>
  );
}

export default EventCasePicker;
