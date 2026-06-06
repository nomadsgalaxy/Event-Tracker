'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardAction } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { saveEmergencyContactAction } from './actions';
import type { EmergencyContact } from './warehouse-data';

// emergency-contact-panel.tsx — the single fleet-wide emergency contact (a faithful port of the
// Python EmergencyContactPanel, index.html ~L14180). One contact (operations lead / dispatch) printed
// as the "if found, contact" line on every 4×6 shipping label, used as the fallback when a roadcase's
// home warehouse has no per-warehouse #71 contact. Save upserts; Clear soft-deletes the record.
// Gated by emergency_contact.write (manager+) — the panel is read-only (disabled) for lower roles.

export function EmergencyContactPanel({
  initial,
  canManage,
}: {
  initial: EmergencyContact | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<EmergencyContact>(
    initial ?? { name: '', role: '', phone: '', email: '' }
  );
  const [confirmClear, setConfirmClear] = useState(false);
  const [pending, startTransition] = useTransition();

  const set = (patch: Partial<EmergencyContact>) => setDraft((d) => ({ ...d, ...patch }));

  function save() {
    startTransition(async () => {
      const res = await saveEmergencyContactAction(draft);
      if (res.error || !res.ok) {
        toast.error(res.error || 'Could not save the contact.');
        return;
      }
      toast.success('Emergency contact saved.');
      router.refresh();
    });
  }
  function clear() {
    startTransition(async () => {
      const res = await saveEmergencyContactAction(null);
      if (res.error || !res.ok) {
        toast.error(res.error || 'Could not clear the contact.');
        return;
      }
      toast.success('Emergency contact cleared.');
      setDraft({ name: '', role: '', phone: '', email: '' });
      setConfirmClear(false);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-muted-foreground" aria-hidden />
          Emergency contact
        </CardTitle>
        <CardAction className="text-xs text-muted-foreground">Printed on every 4×6 label</CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          A single fleet-wide contact (operations lead / dispatch) used as the &ldquo;if found, contact&rdquo;
          line on shipping labels — the fallback when a roadcase&apos;s home warehouse has no per-warehouse contact.
        </p>
        {!canManage ? (
          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Read-only — setting the emergency contact needs the <strong className="text-foreground">Manager</strong>{' '}
            role or higher.
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="em-name">Name</Label>
            <Input id="em-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={!canManage} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="em-role">Role / title</Label>
            <Input id="em-role" value={draft.role} onChange={(e) => set({ role: e.target.value })} disabled={!canManage} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="em-phone">Phone</Label>
            <Input id="em-phone" value={draft.phone} onChange={(e) => set({ phone: e.target.value })} disabled={!canManage} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="em-email">Email</Label>
            <Input id="em-email" type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} disabled={!canManage} />
          </div>
        </div>
        {canManage ? (
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)} disabled={pending}>
              Clear
            </Button>
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Save
            </Button>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear emergency contact?</DialogTitle>
            <DialogDescription>
              Shipping labels will print without it (unless a roadcase&apos;s home warehouse sets its own contact).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={clear} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Clear contact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default EmergencyContactPanel;
