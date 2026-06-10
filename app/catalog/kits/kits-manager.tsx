'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Pencil, Trash2, Package, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/util/utils';
import { createRoadKitAction, saveRoadKitAction, deleteRoadKitAction } from './actions';

export interface KitCaseOption {
  id: string;
  label: string;
}
export interface KitRow {
  id: string;
  name: string;
  notes: string;
  color: string | null;
  caseIds: string[];
  cases: { id: string; label: string }[];
}

// The kit header tints reuse the status palette tokens (dark-only).
const SWATCHES: { label: string; value: string }[] = [
  { label: 'Orange', value: '#fd5000' },
  { label: 'Blue', value: '#346ef4' },
  { label: 'Green', value: '#65c900' },
  { label: 'Amber', value: '#f5a623' },
  { label: 'Violet', value: '#a78bfa' },
];

export function RoadKitsManager({
  kits,
  caseOptions,
  canEdit,
}: {
  kits: KitRow[];
  caseOptions: KitCaseOption[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<KitRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<KitRow | null>(null);
  const [pending, startTransition] = useTransition();

  function confirmDelete() {
    const k = deleting;
    if (!k) return;
    startTransition(async () => {
      const res = await deleteRoadKitAction(k.id);
      setDeleting(null);
      if (res.error) toast.error(res.error);
      else {
        toast.success(`Deleted "${k.name}".`);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus size={14} aria-hidden />
            New kit
          </Button>
        </div>
      ) : null}

      {kits.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
          <Package className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium text-foreground">No road kits yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {canEdit ? 'Bundle the cases that always travel together so you can assign them in one step.' : 'No road kits have been defined.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {kits.map((k) => (
            <div key={k.id} className="rounded-lg border border-border bg-card">
              <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: k.color || 'var(--muted-foreground)' }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground">{k.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {k.caseIds.length} {k.caseIds.length === 1 ? 'case' : 'cases'}
                    {k.notes ? ` · ${k.notes}` : ''}
                  </div>
                </div>
                {canEdit ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${k.name}`} onClick={() => setEditing(k)}>
                      <Pencil size={14} aria-hidden />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${k.name}`} onClick={() => setDeleting(k)}>
                      <Trash2 size={14} className="text-destructive" aria-hidden />
                    </Button>
                  </div>
                ) : null}
              </div>
              {k.cases.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 px-4 py-3">
                  {k.cases.map((c) => (
                    <span key={c.id} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {c.label}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="px-4 py-3 text-xs italic text-muted-foreground">No cases in this kit yet.</p>
              )}
            </div>
          ))}
        </div>
      )}

      {editing ? (
        <KitEditor
          kit={editing === 'new' ? null : editing}
          caseOptions={caseOptions}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{deleting?.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              This removes the kit and its grouping from any event. The cases themselves stay assigned
              to their events.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Delete kit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KitEditor({
  kit,
  caseOptions,
  onClose,
  onSaved,
}: {
  kit: KitRow | null;
  caseOptions: KitCaseOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(kit?.name ?? '');
  const [notes, setNotes] = useState(kit?.notes ?? '');
  const [color, setColor] = useState<string | null>(kit?.color ?? null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(kit?.caseIds ?? []));
  const [q, setQ] = useState('');
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return caseOptions;
    return caseOptions.filter((c) => c.label.toLowerCase().includes(needle));
  }, [caseOptions, q]);

  function toggle(id: string, on: boolean) {
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  function submit() {
    if (!name.trim()) {
      toast.warning('Give the kit a name.');
      return;
    }
    const input = { name: name.trim(), caseIds: [...picked], notes: notes.trim(), color };
    startTransition(async () => {
      const res = kit ? await saveRoadKitAction(kit.id, input) : await createRoadKitAction(input);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(kit ? 'Kit updated.' : 'Kit created.');
      onSaved();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{kit ? 'Edit road kit' : 'New road kit'}</DialogTitle>
          <DialogDescription>Name the kit and pick the cases that travel in it.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kit-name">Kit name</Label>
            <Input id="kit-name" value={name} placeholder="e.g. Large-Format Kit" onChange={(e) => setName(e.target.value)} autoFocus />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Cases ({picked.size} selected)</Label>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={q} placeholder="Search cases…" className="pl-8" onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1">
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs italic text-muted-foreground">No cases match.</p>
              ) : (
                filtered.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50">
                    <Checkbox checked={picked.has(c.id)} onCheckedChange={(v) => toggle(c.id, v === true)} />
                    <span className="truncate">{c.label}</span>
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Colour (optional)</Label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="No colour"
                onClick={() => setColor(null)}
                className={cn('size-6 rounded-full border border-border bg-muted', color === null && 'ring-2 ring-ring ring-offset-2 ring-offset-background')}
              />
              {SWATCHES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  aria-label={s.label}
                  onClick={() => setColor(s.value)}
                  className={cn('size-6 rounded-full', color === s.value && 'ring-2 ring-ring ring-offset-2 ring-offset-background')}
                  style={{ background: s.value }}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kit-notes">Notes (optional)</Label>
            <Textarea id="kit-notes" rows={2} value={notes} placeholder="What this kit is for…" onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {kit ? 'Save kit' : 'Create kit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RoadKitsManager;
