'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/util/utils';
import type { InventoryPayload, ItemFlag } from '@/lib/views/inventory-shape';

// components/inventory/flag-modals.tsx — the SHARED FlagItemModal + ResolveFlagModal (reused by
// Manifest, Catalog, Inventory, Sign-off). Faithful ports of index.html FlagItemModal (~L22079) and
// ResolveFlagModal (~L22129): a note + category (general/damage/maintenance) + severity (low/med/
// high) on flag; the open flag's detail + a resolution note on resolve.
//
// REUSABLE API: each takes the live `item`, the controlled `open`/`onOpenChange`, and an async
// `onSubmit` that performs the gated write (the host wires the Server Action) and returns
// { ok?, error? }. The modal owns the form state + the pending UI + the success/error toast, and
// closes on success — so a host only supplies the item + the write. No client-side data authority.

const CATEGORIES: { id: 'general' | 'damage' | 'maintenance'; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'damage', label: 'Damage' },
  { id: 'maintenance', label: 'Maintenance' },
];

const SEVERITIES: { id: 'low' | 'med' | 'high'; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'med', label: 'Med' },
  { id: 'high', label: 'High' },
];

export interface FlagSubmit {
  note: string;
  category: 'general' | 'damage' | 'maintenance';
  severity: 'low' | 'med' | 'high';
  /** When flagging a serial item FROM a case, the unit ids to flag (the serials in that case). When
   *  omitted/empty the host flags the item type (bulk items, or the catalog with no case context). */
  unitIds?: string[];
}

export interface ActionResult {
  ok?: boolean;
  error?: string;
}

export function FlagItemModal({
  item,
  open,
  onOpenChange,
  onSubmit,
  serialUnits,
}: {
  item: InventoryPayload;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: FlagSubmit) => Promise<ActionResult>;
  /** The serial unit(s) of this item physically in the current case (case context only). When given,
   *  the flag defaults to those serials; with more than one, the user can pick which. */
  serialUnits?: { id: string; serial: string }[];
}) {
  const perSerial = Array.isArray(serialUnits) && serialUnits.length > 0;
  const [note, setNote] = useState('');
  const [category, setCategory] = useState<FlagSubmit['category']>('general');
  const [severity, setSeverity] = useState<FlagSubmit['severity']>('med');
  const [picked, setPicked] = useState<Set<string>>(() => new Set((serialUnits || []).map((u) => u.id)));
  const [pending, startTransition] = useTransition();

  function reset() {
    setNote('');
    setCategory('general');
    setSeverity('med');
    setPicked(new Set((serialUnits || []).map((u) => u.id)));
  }

  function submit() {
    if (!note.trim()) {
      toast.warning('Please add a note describing the issue.');
      return;
    }
    if (perSerial && picked.size === 0) {
      toast.warning('Pick at least one serial to flag.');
      return;
    }
    startTransition(async () => {
      const res = await onSubmit({ note: note.trim(), category, severity, unitIds: perSerial ? [...picked] : undefined });
      if (res.error && !res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Flagged ${item.name || 'item'}`);
      reset();
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Flag: {item.name || item.id}</DialogTitle>
          <DialogDescription>Record an issue with this item for the crew to action.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {perSerial ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-2.5">
              <Label className="text-xs">
                {serialUnits!.length === 1 ? 'Flagging this serial (in this case)' : 'Which serials in this case?'}
              </Label>
              {serialUnits!.length === 1 ? (
                <span className="font-mono text-xs text-foreground">{serialUnits![0].serial || '(no serial)'}</span>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {serialUnits!.map((u) => (
                    <label key={u.id} className="flex cursor-pointer items-center gap-2 text-xs">
                      <Checkbox
                        checked={picked.has(u.id)}
                        onCheckedChange={(v) =>
                          setPicked((s) => {
                            const n = new Set(s);
                            if (v === true) n.add(u.id);
                            else n.delete(u.id);
                            return n;
                          })
                        }
                      />
                      <span className="font-mono">{u.serial || '(no serial)'}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="flag-note">Issue description</Label>
            <Textarea
              id="flag-note"
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Describe the problem — broken part, missing serial, customs hold, etc."
            />
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Category</legend>
            <div className="grid grid-cols-3 gap-2">
              {CATEGORIES.map((c) => (
                <Button
                  key={c.id}
                  type="button"
                  variant={category === c.id ? 'secondary' : 'outline'}
                  size="sm"
                  aria-pressed={category === c.id}
                  className={cn('uppercase tracking-wide text-[11px]', category === c.id && 'ring-1 ring-primary')}
                  onClick={() => setCategory(c.id)}
                >
                  {c.label}
                </Button>
              ))}
            </div>
            {(category === 'damage' || category === 'maintenance') && (
              <p className="text-xs text-warning">
                A {category} flag takes this item out of service until the flag is resolved.
              </p>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Severity</legend>
            <div className="grid grid-cols-3 gap-2">
              {SEVERITIES.map((s) => {
                const active = severity === s.id;
                const tone =
                  s.id === 'high' ? 'var(--destructive)' : s.id === 'med' ? 'var(--warning)' : 'var(--muted-foreground)';
                return (
                  <Button
                    key={s.id}
                    type="button"
                    variant={active ? 'secondary' : 'outline'}
                    size="sm"
                    aria-pressed={active}
                    className="uppercase tracking-wide text-[11px]"
                    style={active ? { color: tone, borderColor: tone } : undefined}
                    onClick={() => setSeverity(s.id)}
                  >
                    {s.label}
                  </Button>
                );
              })}
            </div>
          </fieldset>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Flag item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function fmtFlagDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

export function ResolveFlagModal({
  item,
  flag,
  open,
  onOpenChange,
  onSubmit,
}: {
  item: InventoryPayload;
  flag: ItemFlag;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (resolution: string) => Promise<ActionResult>;
}) {
  const [resolution, setResolution] = useState('');
  const [pending, startTransition] = useTransition();

  const sevTone =
    flag.severity === 'high'
      ? 'var(--destructive)'
      : flag.severity === 'med'
        ? 'var(--warning)'
        : 'var(--muted-foreground)';

  function submit() {
    if (!resolution.trim()) {
      toast.warning('Please describe how the issue was resolved.');
      return;
    }
    startTransition(async () => {
      const res = await onSubmit(resolution.trim());
      if (res.error && !res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Flag resolved');
      setResolution('');
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setResolution('');
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resolve flag: {item.name || item.id}</DialogTitle>
          <DialogDescription>Close out this issue with a resolution note.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* The flag being resolved. */}
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: sevTone }}>
                {flag.severity || 'med'}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {flag.flaggedBy || flag.by || 'unknown'} · {fmtFlagDate(flag.flaggedAt)}
              </span>
            </div>
            <p className="text-sm text-foreground">{flag.note || '(no description)'}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="resolve-note">Resolution</Label>
            <Textarea
              id="resolve-note"
              rows={4}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="What was done to fix this? Replaced part, returned to stock, discarded, etc."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Mark resolved
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
