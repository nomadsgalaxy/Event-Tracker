'use client';

import { useState, useTransition } from 'react';
import { TriangleAlert, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CaseDeleteClassification } from '@/lib/views/case-view';
import { retireOrDeleteCaseAction } from './actions';

// retire-case-modal.tsx — the SHARED RetireCaseModal (DELETE vs RETIRE confirmation flow). A faithful
// port of index.html RetireCaseModal (~L19628): the FK situation is classified SERVER-SIDE (the page
// passes the precomputed classifyCaseDelete result down) into one of three states —
//   • blocked : held by ≥1 non-closed event → cancel-only, lists the holders
//   • retire  : only historical refs (closed events / inventory) → required reason, soft-retire
//   • delete  : zero FK refs → optional reason, permanent (tombstone) delete
// On confirm it calls the gated retireOrDeleteCaseAction (which RE-CLASSIFIES live, so a stale
// classification can't be exploited). Callable from BOTH the card and the editor.

export function RetireCaseModal({
  caseId,
  caseLabel,
  classification,
  open,
  onOpenChange,
  onDone,
}: {
  caseId: string;
  caseLabel: string;
  classification: CaseDeleteClassification;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful delete/retire (e.g. to navigate away). */
  onDone?: (action: 'delete' | 'retire') => void;
}) {
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();
  const action = classification.action;
  const label = caseLabel || 'roadcase';

  const reasonRequired = action === 'retire';
  const reasonOk = !reasonRequired || reason.trim().length > 0;

  const title =
    action === 'blocked'
      ? 'Cannot delete or retire'
      : action === 'retire'
        ? `Retire ${label}?`
        : `Delete ${label}?`;

  function confirm(act: 'delete' | 'retire') {
    startTransition(async () => {
      const res = await retireOrDeleteCaseAction(caseId, act, reason.trim());
      if (res.error || !res.ok) {
        toast.error(res.error || 'Could not complete the action.');
        return;
      }
      const did = (res.action === 'delete' ? 'delete' : 'retire') as 'delete' | 'retire';
      toast.success(did === 'delete' ? 'Case deleted.' : 'Case retired.');
      onOpenChange(false);
      onDone?.(did);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Delete or retire this roadcase.
          </DialogDescription>
        </DialogHeader>

        {action === 'blocked' && (
          <>
            <p className="text-sm text-foreground">
              This case is currently held by{' '}
              {classification.blockers.events.length === 1 ? 'an event' : 'events'} that{' '}
              {classification.blockers.events.length === 1 ? "hasn't" : "haven't"} closed yet. Remove
              the case from {classification.blockers.events.length === 1 ? 'that event' : 'those events'}{' '}
              first, then come back.
            </p>
            <div className="rounded-md border border-border bg-muted/40 p-2">
              {classification.blockers.events.map((e) => (
                <div key={e.id} className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
                  <TriangleAlert className="size-3 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground/70">{e.state}</span>
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}

        {action === 'retire' && (
          <>
            <p className="text-sm leading-relaxed text-foreground">
              This case has historical references and cannot be permanently deleted. It will be{' '}
              <strong style={{ color: 'var(--warning)' }}>retired</strong> — hidden from all pickers,
              never assignable to new events. Closed events keep their reference to it.
            </p>
            {(classification.historical.closedEvents.length > 0 ||
              classification.historical.items.length > 0) && (
              <div className="rounded-md border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
                {classification.historical.closedEvents.length > 0 && (
                  <div>
                    Held by{' '}
                    <span className="text-foreground">
                      {classification.historical.closedEvents.length}
                    </span>{' '}
                    closed {classification.historical.closedEvents.length === 1 ? 'event' : 'events'}:{' '}
                    {classification.historical.closedEvents.slice(0, 3).map((e) => e.name).join(', ')}
                    {classification.historical.closedEvents.length > 3
                      ? `, +${classification.historical.closedEvents.length - 3}`
                      : ''}
                    .
                  </div>
                )}
                {classification.historical.items.length > 0 && (
                  <div className="mt-1">
                    Referenced by{' '}
                    <span className="text-foreground">{classification.historical.items.length}</span>{' '}
                    inventory {classification.historical.items.length === 1 ? 'item' : 'items'}.
                  </div>
                )}
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="retire-reason">Reason (required)</Label>
              <Input
                id="retire-reason"
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. damaged beyond repair"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancel
              </Button>
              <Button
                onClick={() => confirm('retire')}
                disabled={!reasonOk || pending}
                style={{ background: 'var(--warning)', color: '#000' }}
              >
                {pending && <Loader2 className="animate-spin" aria-hidden />}
                Retire case
              </Button>
            </DialogFooter>
          </>
        )}

        {action === 'delete' && (
          <>
            <p className="text-sm leading-relaxed text-foreground">
              This case has no event or inventory references and can be{' '}
              <strong style={{ color: 'var(--destructive)' }}>permanently deleted</strong>. It will be
              removed from the store entirely with no historical record.
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="delete-reason">Reason (optional)</Label>
              <Input
                id="delete-reason"
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. created in error"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => confirm('delete')} disabled={pending}>
                {pending && <Loader2 className="animate-spin" aria-hidden />}
                Delete permanently
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default RetireCaseModal;
