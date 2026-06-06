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
}

export function AssignCasesModal({
  open,
  onOpenChange,
  eventName,
  assignedIds,
  cases,
  canAddLoose,
  onSave,
  onAddLoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventName: string;
  /** The case ids currently on the event (seeds the checkbox selection). */
  assignedIds: string[];
  cases: AssignCaseRow[];
  /** Loose-policy gate (lead+) — shows the "or add a loose item" link. */
  canAddLoose: boolean;
  onSave: (caseIds: string[]) => Promise<{ ok?: boolean; error?: string }>;
  onAddLoose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(assignedIds));
  const [pending, startTransition] = useTransition();

  // Re-seed the selection whenever the modal (re)opens or the assigned set changes (after a save).
  useEffect(() => {
    if (open) setSelected(new Set(assignedIds));
  }, [open, assignedIds]);

  const priorSet = useMemo(() => new Set(assignedIds), [assignedIds]);

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function save() {
    const ids = Array.from(selected);
    startTransition(async () => {
      const res = await onSave(ids);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Assign cases to {eventName}</DialogTitle>
          <DialogDescription>
            Pick the roadcases traveling to this event. A case held by another in-flight event is locked.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
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
                      onCheckedChange={(v) => !locked && toggle(c.id, v === true)}
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
  );
}

export default AssignCasesModal;
