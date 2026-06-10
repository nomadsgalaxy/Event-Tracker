'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Loader2, Lock, Plus } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/util/utils';

// app/manifest/assign-cases-modal.tsx — the Assign-cases modal (DESIGN_ALIGNMENT §4.3 + the Python
// ManifestPool case editor, index.html ~L16436). A checkbox grid of EVERY case (retired excluded,
// already-assigned kept), each row with an availability LOCK (disabled + lock badge + status label
// when held by ANOTHER in-flight event), the case slug shown when distinct from its id, and a
// "Save assignments" that writes event.cases via the gated setEventCasesAction.
//
// The "or add a loose item" link (loose-policy gated) closes this modal and opens the loose picker —
// mirroring the Python flow where the two modals serve different intents.

// One assignable case row, with its server-computed availability (the lock).
export interface AssignCaseRow {
  id: string;
  slug: string; // shown when distinct from id (else '')
  label: string;
  /** True iff a DIFFERENT in-flight event currently holds this case (the availability lock). */
  unavailable: boolean;
  /** The "Packing for X" / "At X" status phrase when unavailable (else ''). */
  statusLabel: string;
  /** Soft double-book warning: other date-overlapping (non-locked) events for this case (else ''). */
  conflictLabel?: string;
}

// A Road Kit the event can assign as a unit (adds all its available cases + groups them on the manifest).
export interface AssignKitOption {
  id: string;
  name: string;
  caseIds: string[];
  color?: string | null;
}

export function AssignCasesModal({
  open,
  onOpenChange,
  eventName,
  assignedIds,
  assignedKitIds = [],
  cases,
  kits = [],
  canAddLoose,
  onSave,
  onAddLoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventName: string;
  /** The case ids currently on the event (seeds the checkbox selection). */
  assignedIds: string[];
  /** The Road Kit ids currently assigned to the event (seeds the kit toggles). */
  assignedKitIds?: string[];
  cases: AssignCaseRow[];
  /** The Road Kits available to assign (empty hides the section). */
  kits?: AssignKitOption[];
  /** Loose-policy gate (lead+) — shows the "or add a loose item" link. */
  canAddLoose: boolean;
  onSave: (caseIds: string[], kitIds: string[]) => Promise<{ ok?: boolean; error?: string }>;
  onAddLoose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(assignedIds));
  const [selectedKits, setSelectedKits] = useState<Set<string>>(() => new Set(assignedKitIds));
  const [pendingConflict, setPendingConflict] = useState<AssignCaseRow | null>(null);
  const [pending, startTransition] = useTransition();

  // Re-seed the selection whenever the modal (re)opens or the assigned set changes (after a save).
  useEffect(() => {
    if (open) {
      setSelected(new Set(assignedIds));
      setSelectedKits(new Set(assignedKitIds));
    }
  }, [open, assignedIds, assignedKitIds]);

  const priorSet = useMemo(() => new Set(assignedIds), [assignedIds]);
  // Cases that can't be auto-added by a kit (held by another in-flight event, not already on this event).
  const lockedSet = useMemo(
    () => new Set(cases.filter((c) => c.unavailable && !priorSet.has(c.id)).map((c) => c.id)),
    [cases, priorSet]
  );
  const caseIdSet = useMemo(() => new Set(cases.map((c) => c.id)), [cases]);

  // Toggle a kit: ON assigns it + adds its available cases; OFF just stops grouping (leaves the cases,
  // so unchecking a kit never silently yanks cases the user may still want).
  function toggleKit(kit: AssignKitOption, on: boolean) {
    setSelectedKits((prev) => {
      const next = new Set(prev);
      if (on) next.add(kit.id);
      else next.delete(kit.id);
      return next;
    });
    if (on) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const cid of kit.caseIds) {
          if (caseIdSet.has(cid) && !lockedSet.has(cid)) next.add(cid);
        }
        return next;
      });
    }
  }

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Adding a case that date-overlaps another (non-locked) event soft-confirms first; everything else
  // toggles immediately. Unassigning never warns.
  function requestToggle(c: AssignCaseRow, on: boolean) {
    if (on && c.conflictLabel && !priorSet.has(c.id) && !selected.has(c.id)) {
      setPendingConflict(c);
      return;
    }
    toggle(c.id, on);
  }

  function save() {
    const ids = Array.from(selected);
    // Only persist kits that still have at least one of their cases on the event (an empty group is noise).
    const kitIds = Array.from(selectedKits).filter((kid) => {
      const kit = kits.find((k) => k.id === kid);
      return kit ? kit.caseIds.some((cid) => selected.has(cid)) : false;
    });
    startTransition(async () => {
      const res = await onSave(ids, kitIds);
      if (res.error && !res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.ok) {
        // setEventCasesAction returns {ok:true, error:<partial msg>} when some cases were skipped.
        if (res.error) toast.warning(res.error);
        else toast.success('Case assignments saved');
        onOpenChange(false);
      }
    });
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Assign cases to {eventName}</DialogTitle>
          <DialogDescription>
            Pick the roadcases traveling to this event. A case held by another in-flight event is locked.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {kits.length > 0 ? (
            <div className="mb-3 flex flex-col gap-1.5">
              <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Road kits</div>
              <div className="flex flex-wrap gap-1.5">
                {kits.map((k) => {
                  const on = selectedKits.has(k.id);
                  return (
                    <button
                      key={k.id}
                      type="button"
                      onClick={() => toggleKit(k, !on)}
                      aria-pressed={on}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                        on ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-accent/50'
                      )}
                    >
                      <span className="size-2 rounded-full" style={{ background: k.color || 'var(--muted-foreground)' }} aria-hidden />
                      {k.name}
                      <span className="tabular-nums opacity-70">{k.caseIds.length}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">Tap a kit to add its cases and group them on the manifest.</p>
            </div>
          ) : null}
          {cases.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">No cases in the catalog yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {cases.map((c) => {
                const sel = selected.has(c.id);
                // A case held elsewhere is locked UNLESS it was already on this event (then it can be unassigned).
                const locked = c.unavailable && !priorSet.has(c.id);
                return (
                  <label
                    key={c.id}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md border px-3 py-2.5 transition-colors',
                      locked
                        ? 'cursor-not-allowed border-border bg-muted/30 opacity-60'
                        : 'cursor-pointer',
                      sel && !locked
                        ? 'border-primary bg-primary/8'
                        : !locked && 'border-border hover:bg-accent/50'
                    )}
                  >
                    <Checkbox
                      checked={sel}
                      disabled={locked}
                      onCheckedChange={(v) => !locked && requestToggle(c, v === true)}
                      aria-label={`Assign ${c.label}`}
                    />
                    <div className="min-w-0 flex-1">
                      {c.slug ? (
                        <div className="truncate font-mono text-[10px] text-muted-foreground">{c.slug}</div>
                      ) : null}
                      <div className="truncate text-sm text-foreground">{c.label}</div>
                      {locked ? (
                        <div className="mt-0.5 flex items-center gap-1 text-[10px]" style={{ color: 'var(--warning)' }}>
                          <Lock size={10} aria-hidden /> {c.statusLabel}
                        </div>
                      ) : !locked && c.conflictLabel ? (
                        <div className="mt-0.5 flex items-start gap-1 text-[10px]" style={{ color: 'var(--warning)' }} title={c.conflictLabel}>
                          <Lock size={10} aria-hidden className="mt-px shrink-0" />
                          <span className="truncate">Overlaps {c.conflictLabel}</span>
                        </div>
                      ) : null}
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          {canAddLoose ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => {
                onOpenChange(false);
                onAddLoose();
              }}
            >
              <Plus size={11} aria-hidden /> or add a loose item
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Save assignments
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Soft double-book confirm — overlapping (non-locked) event. */}
    <Dialog open={!!pendingConflict} onOpenChange={(o) => !o && setPendingConflict(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign despite an overlap?</DialogTitle>
          <DialogDescription>
            <strong className="text-foreground">{pendingConflict?.label}</strong> overlaps another event on
            these dates: {pendingConflict?.conflictLabel}. Assigning it here may double-book the case.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPendingConflict(null)} autoFocus>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (pendingConflict) toggle(pendingConflict.id, true);
              setPendingConflict(null);
            }}
            style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}
          >
            Assign anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

export default AssignCasesModal;
