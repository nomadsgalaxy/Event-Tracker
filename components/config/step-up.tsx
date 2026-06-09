'use client';

import * as React from 'react';
import { IS_DEMO } from '@/lib/util/demo-flag';
import { useCallback, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// components/config/step-up.tsx — a reusable CONFIRM gate for the Config settings writes (integration
// keys, branding, access policy, tenant, sign-in providers). It used to be a password step-up, but
// accounts can be OAuth-only (no password to re-enter), so it's now a plain "are you sure?" confirm —
// the admin session + the server-side admin re-check + the audit log are the gate. The `run(token)`
// signature is kept (token is now '') so the calling cards don't change.

function ConfirmModal({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{IS_DEMO ? 'Read-only demo' : 'Save this change?'}</DialogTitle>
          <DialogDescription>
            {IS_DEMO
              ? 'This is a read-only demo — settings can’t be changed here. Deploy your own instance to configure it.'
              : 'This updates a deployment-wide setting for everyone. Continue?'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {IS_DEMO ? 'Close' : 'Cancel'}
          </Button>
          {IS_DEMO ? null : (
            <Button type="button" onClick={onConfirm}>
              <Check aria-hidden /> Confirm
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The shared confirm controller. Returns { requireStepUp, element }:
 *   • requireStepUp(run) — opens the confirm; on Confirm calls run('') (no step-up token anymore).
 *   • element — render this ONCE in the card so the dialog mounts.
 */
export function useStepUp(): {
  requireStepUp: (run: (token: string) => void) => void;
  element: React.ReactElement;
} {
  const [open, setOpen] = useState(false);
  const pending = useRef<((token: string) => void) | null>(null);

  const requireStepUp = useCallback((run: (token: string) => void) => {
    pending.current = run;
    setOpen(true);
  }, []);

  const element = (
    <ConfirmModal
      open={open}
      onCancel={() => {
        setOpen(false);
        pending.current = null;
      }}
      onConfirm={() => {
        setOpen(false);
        const run = pending.current;
        pending.current = null;
        run?.('');
      }}
    />
  );

  return { requireStepUp, element };
}
