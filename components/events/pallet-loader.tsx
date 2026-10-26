'use client';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { TrackingBadge } from '@/components/ui/tracking-badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { placeOnPalletAction, removeFromPalletAction, setPalletItemPackedAction } from '@/app/event/pallet-actions';
import type { PalletItemView, PalletPickItem, PalletView } from '@/lib/types/types-event-detail';

// The event's pallets with the items riding them. With canLoad, each line can be packed or taken off
// and "Add items" loads stock from storage; without it the list is read-only.
export function PalletLoader({
  eventId,
  pallets,
  pick,
  canLoad,
}: {
  eventId: string;
  pallets: PalletView[];
  pick: PalletPickItem[];
  canLoad: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState<PalletView | null>(null);

  const act = (fn: () => Promise<{ ok?: boolean; error?: string }>, done?: string) =>
    startTransition(async () => {
      const res = await fn();
      if (res.error) {
        toast.error(res.error);
        return;
      }
      if (done) toast.success(done);
      router.refresh();
    });

  const lineKey = (l: PalletItemView) => `${l.itemId}:${l.unitId ?? 'bulk'}`;

  return (
    <div className="flex flex-col gap-2">
      {pallets.map((p) => {
        const packed = p.items.filter((l) => l.packed).length;
        return (
          <div key={p.id} className="rounded bg-muted/40 p-2.5">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-semibold text-foreground">{p.label}</span>
              <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                {p.items.length > 0 && `${packed}/${p.items.length} packed · `}
                {p.caseChips.length > 0 && `${p.caseChips.length} ${p.caseChips.length === 1 ? 'case' : 'cases'} · `}
                {p.weight}
              </span>
            </div>
            {p.tracking && (
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">Tracking # {p.tracking}</span>
                <TrackingBadge number={p.tracking} />
              </div>
            )}
            {p.caseChips.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {p.caseChips.map((c) => (
                  <span key={c.id} className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground">
                    {c.label}
                  </span>
                ))}
              </div>
            )}

            {p.items.length === 0 ? (
              <p className="text-[11px] italic text-muted-foreground">Nothing on this pallet yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded border border-border bg-background">
                {p.items.map((l) => (
                  <li key={lineKey(l)} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                    {canLoad ? (
                      <Checkbox
                        checked={l.packed}
                        disabled={pending}
                        aria-label={`${l.name} packed`}
                        onCheckedChange={(v) => act(() => setPalletItemPackedAction(eventId, p.id, l.itemId, v === true, l.unitId))}
                      />
                    ) : (
                      <span className={l.packed ? 'text-primary' : 'text-muted-foreground'}>{l.packed ? '✓' : '○'}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {l.name}
                      {l.serial && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{l.serial}</span>}
                      {l.flagged && <span className="ml-1.5 text-[11px] text-destructive">flagged</span>}
                    </span>
                    {!l.unitId && <span className="font-mono tabular-nums text-muted-foreground">×{l.qty}</span>}
                    {canLoad && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={pending}
                        title="Take off the pallet (back to storage)"
                        aria-label={`Take ${l.name} off ${p.label}`}
                        onClick={() => act(() => removeFromPalletAction(eventId, p.id, l.itemId, { unitId: l.unitId ?? undefined }))}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {canLoad && (
              <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={pending} onClick={() => setAdding(p)}>
                <Plus aria-hidden />
                Add items
              </Button>
            )}
          </div>
        );
      })}

      {adding && (
        <AddItemsDialog
          pallet={adding}
          pick={pick}
          pending={pending}
          onAdd={(itemId, opts) => act(() => placeOnPalletAction(eventId, adding.id, itemId, opts))}
          onClose={() => setAdding(null)}
        />
      )}
    </div>
  );
}

function AddItemsDialog({
  pallet,
  pick,
  pending,
  onAdd,
  onClose,
}: {
  pallet: PalletView;
  pick: PalletPickItem[];
  pending: boolean;
  onAdd: (itemId: string, opts: { qty?: number; unitId?: string }) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? pick.filter((p) => p.name.toLowerCase().includes(needle) || p.units.some((u) => u.serial.toLowerCase().includes(needle))) : pick;
  }, [q, pick]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add items to {pallet.label}</DialogTitle>
          <DialogDescription>Only stock that&apos;s in storage is listed. Each add takes it out of storage until it&apos;s taken off or the show closes.</DialogDescription>
        </DialogHeader>
        <Input autoFocus value={q} placeholder="Search by name or serial" aria-label="Search storage" onChange={(e) => setQ(e.target.value)} />
        {shown.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{pick.length === 0 ? 'Nothing is in storage.' : 'No matches.'}</p>
        ) : (
          <ul className="divide-y divide-border rounded border border-border">
            {shown.map((it) =>
              it.serial ? (
                it.units.map((u) => (
                  <li key={`${it.itemId}:${u.id}`} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      {it.name}
                      <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{u.serial || 'no serial'}</span>
                    </span>
                    <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => onAdd(it.itemId, { unitId: u.id })}>
                      {pending ? <Loader2 className="animate-spin" aria-hidden /> : 'Add'}
                    </Button>
                  </li>
                ))
              ) : (
                <li key={it.itemId} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate">
                    {it.name}
                    <span className="ml-1.5 text-[11px] text-muted-foreground">{it.inStorage} in storage</span>
                  </span>
                  <Input
                    className="h-7 w-16"
                    inputMode="numeric"
                    aria-label={`How many ${it.name}`}
                    value={qty[it.itemId] ?? '1'}
                    onChange={(e) => setQty((m) => ({ ...m, [it.itemId]: e.target.value }))}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() => onAdd(it.itemId, { qty: Math.max(1, Math.floor(Number(qty[it.itemId] ?? '1')) || 1) })}
                  >
                    {pending ? <Loader2 className="animate-spin" aria-hidden /> : 'Add'}
                  </Button>
                </li>
              )
            )}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
