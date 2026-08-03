'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { FileText, Plus, Paperclip, Pencil, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/util/utils';
import { saveBolAction, deleteBolAction } from '@/app/event/bol-actions';
import type { EventBol, EventPallet } from '@/lib/types/types';

// components/events/bol-manager.tsx — the Bill-of-Lading manager for ONE shipping leg, shared by the
// event detail's Shipping tab and the EDITOR's Shipping step (the editor is where people naturally
// enter shipping info, so it has to be attachable from there too).
//
// BOLs are server-owned (payload.bols) and save through their own Server Action the moment you hit
// Add/Save in the dialog — they do NOT ride the editor form's submit. That's deliberate: the editor
// $sets outbound/return wholesale, so nesting BOLs in the form would let a stale form state wipe
// them. The editor copy says so, and it needs a saved event (an id) to attach to.

// ── Bills of lading (per shipping leg) ─────────────────────────────────────────────────────────
const FREIGHT_TERMS_LABEL: Record<string, string> = { prepaid: 'Prepaid', collect: 'Collect', 'third-party': '3rd party' };
const BOL_MODE_LABEL: Record<string, string> = { ltl: 'LTL', ftl: 'Full truckload', parcel: 'Parcel' };

/** "4 pallets · 2 boxes · 2 crates on skids" from the structured counts + free text. */
function bolHuSummary(b: EventBol): string {
  const parts: string[] = [];
  if (b.palletCount) parts.push(`${b.palletCount} pallet${b.palletCount === 1 ? '' : 's'}`);
  if (b.boxCount) parts.push(`${b.boxCount} box${b.boxCount === 1 ? '' : 'es'}`);
  if (b.pieces) parts.push(b.pieces);
  return parts.join(' · ');
}

/** Open the attached BOL PDF in a new tab (data: URLs can't be top-navigated — go via a Blob). */
function openBolPdf(b: EventBol) {
  if (!b.fileDataUrl) return;
  fetch(b.fileDataUrl)
    .then((r) => r.blob())
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    })
    .catch(() => toast.error('Could not open the PDF.'));
}

export function BolManager({ eventId, direction, bols, pallets, canEdit, note }: { eventId: string; direction: 'outbound' | 'return'; bols: EventBol[]; pallets: EventPallet[]; canEdit: boolean; note?: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState<EventBol | 'new' | null>(null);
  const [pending, startTransition] = useTransition();
  const mine = bols.filter((b) => b.direction === direction);

  const remove = (b: EventBol) => {
    startTransition(async () => {
      const res = await deleteBolAction(eventId, b.id);
      if (!res.ok) {
        toast.error(res.error || 'Could not delete the BOL.');
        return;
      }
      toast.success('BOL deleted.');
      router.refresh();
    });
  };

  return (
    <div className="mt-2 border-t border-border pt-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Bills of lading · {mine.length}
        </span>
        {canEdit && (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditing('new')} disabled={pending}>
            <Plus className="size-3.5" aria-hidden /> Add BOL
          </Button>
        )}
      </div>
      {note && <p className="mb-1.5 text-[11px] text-muted-foreground">{note}</p>}
      {mine.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground">No BOLs recorded.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {mine.map((b) => (
            <div key={b.id} className="rounded border border-border bg-muted/30 p-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <FileText className="size-3.5 text-primary" aria-hidden />
                <span className="font-mono text-xs font-semibold">{b.bolNumber || '(no BOL #)'}</span>
                {b.carrier && <span className="text-xs text-muted-foreground">{b.carrier}</span>}
                {b.shipDate && <span className="text-xs tabular-nums text-muted-foreground">{b.shipDate}</span>}
                {b.mode && (
                  <span className="rounded border border-primary/50 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                    {BOL_MODE_LABEL[b.mode] ?? b.mode}
                  </span>
                )}
                {b.freightTerms && (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {FREIGHT_TERMS_LABEL[b.freightTerms] ?? b.freightTerms}
                  </span>
                )}
                <span className="min-w-0 flex-1" />
                {b.fileDataUrl && (
                  <button type="button" onClick={() => openBolPdf(b)} className="inline-flex items-center gap-1 text-[11px] text-primary underline decoration-dotted underline-offset-2">
                    <Paperclip className="size-3" aria-hidden />
                    {b.fileName || 'PDF'}
                  </button>
                )}
                {canEdit && (
                  <span className="flex items-center gap-0.5">
                    <Button size="icon" variant="ghost" className="size-6" title="Edit BOL" onClick={() => setEditing(b)} disabled={pending}>
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-6 text-destructive hover:text-destructive" title="Delete BOL" onClick={() => remove(b)} disabled={pending}>
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
                {b.proNumber && <span>PRO <span className="font-mono">{b.proNumber}</span></span>}
                {bolHuSummary(b) && <span>{bolHuSummary(b)}</span>}
                {b.grossWeightLbs ? <span>{b.grossWeightLbs} lbs gross</span> : null}
                {b.referenceNumbers && <span>Ref {b.referenceNumbers}</span>}
              </div>
              {(b.palletIds ?? []).length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {(b.palletIds ?? []).map((pid) => {
                    const pl = pallets.find((x) => x.id === pid);
                    return (
                      <span key={pid} className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground">
                        {pl?.label || pid}
                      </span>
                    );
                  })}
                </div>
              )}
              {(b.specialInstructions || b.deliveryInstructions || b.notes) && (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {[b.specialInstructions, b.deliveryInstructions, b.notes].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {editing !== null && (
        <BolDialog
          eventId={eventId}
          direction={direction}
          pallets={pallets}
          initial={editing === 'new' ? null : editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) router.refresh();
          }}
        />
      )}
    </div>
  );
}

function BolDialog({ eventId, direction, pallets, initial, onClose }: { eventId: string; direction: 'outbound' | 'return'; pallets: EventPallet[]; initial: EventBol | null; onClose: (saved: boolean) => void }) {
  const [f, setF] = useState({
    bolNumber: initial?.bolNumber ?? '',
    proNumber: initial?.proNumber ?? '',
    carrier: initial?.carrier ?? '',
    shipDate: initial?.shipDate ?? '',
    shipFrom: initial?.shipFrom ?? '',
    shipTo: initial?.shipTo ?? '',
    freightTerms: initial?.freightTerms ?? '',
    mode: initial?.mode ?? '',
    pieces: initial?.pieces ?? '',
    palletCount: initial?.palletCount ? String(initial.palletCount) : '',
    boxCount: initial?.boxCount ? String(initial.boxCount) : '',
    grossWeightLbs: initial?.grossWeightLbs ? String(initial.grossWeightLbs) : '',
    specialInstructions: initial?.specialInstructions ?? '',
    deliveryInstructions: initial?.deliveryInstructions ?? '',
    referenceNumbers: initial?.referenceNumbers ?? '',
    notes: initial?.notes ?? '',
  });
  // undefined = keep the stored attachment; '' = clear; a value = new PDF.
  const [file, setFile] = useState<{ name: string; dataUrl: string } | '' | undefined>(undefined);
  const [palletIds, setPalletIds] = useState<string[]>(initial?.palletIds ?? []);
  const [pending, startTransition] = useTransition();

  const pickFile = (input: HTMLInputElement) => {
    const picked = input.files?.[0];
    if (!picked) return;
    if (picked.type !== 'application/pdf') {
      toast.error('BOL attachments must be PDF.');
      input.value = '';
      return;
    }
    if (picked.size > 700_000) {
      toast.error('PDF too large — 700 KB max.');
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setFile({ name: picked.name, dataUrl: String(reader.result) });
    reader.readAsDataURL(picked);
  };

  const save = () => {
    startTransition(async () => {
      const res = await saveBolAction(eventId, {
        ...(initial ? { id: initial.id } : {}),
        direction,
        ...f,
        grossWeightLbs: f.grossWeightLbs ? Number(f.grossWeightLbs) : null,
        palletCount: f.palletCount ? Number(f.palletCount) : null,
        boxCount: f.boxCount ? Number(f.boxCount) : null,
        palletIds,
        ...(file === undefined ? {} : file === '' ? { fileDataUrl: '' } : { fileDataUrl: file.dataUrl, fileName: file.name }),
      });
      if (!res.ok) {
        toast.error(res.error || 'Could not save the BOL.');
        return;
      }
      toast.success(initial ? 'BOL updated.' : 'BOL added.');
      onClose(true);
    });
  };

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const hasStoredFile = !!initial?.fileDataUrl && file === undefined;

  return (
    <Dialog open onOpenChange={(v) => !v && !pending && onClose(false)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit BOL' : 'Add BOL'} — {direction === 'outbound' ? 'outbound' : 'return'}</DialogTitle>
          <DialogDescription>
            The bill of lading for this freight move. Attach the carrier PDF so the crew has the
            document at the dock.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>BOL number</Label>
            <Input value={f.bolNumber} onChange={set('bolNumber')} placeholder="SLL37588633" className="font-mono" />
          </div>
          <div className="grid gap-1.5">
            <Label>PRO number</Label>
            <Input value={f.proNumber} onChange={set('proNumber')} placeholder="assigned at pickup" className="font-mono" />
          </div>
          <div className="grid gap-1.5">
            <Label>Carrier</Label>
            <Input value={f.carrier} onChange={set('carrier')} placeholder="(UPGF) TForce Freight" />
          </div>
          <div className="grid gap-1.5">
            <Label>Ship date</Label>
            <Input type="date" value={f.shipDate} onChange={set('shipDate')} />
          </div>
          <div className="grid gap-1.5">
            <Label>Ship from</Label>
            <Textarea value={f.shipFrom} onChange={set('shipFrom')} rows={3} placeholder={'Name\nAddress\nContact, phone'} />
          </div>
          <div className="grid gap-1.5">
            <Label>Ship to</Label>
            <Textarea value={f.shipTo} onChange={set('shipTo')} rows={3} placeholder={'Name\nAddress\nContact, phone'} />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>Shipment type</Label>
            <div className="flex overflow-hidden rounded-md border border-input" role="radiogroup" aria-label="Shipment type">
              {([['', '—'], ['ltl', 'LTL freight'], ['ftl', 'Full truckload'], ['parcel', 'Parcel (UPS/FedEx)']] as const).map(([v, lbl]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={f.mode === v}
                  onClick={() => setF({ ...f, mode: v })}
                  className={cn(
                    'h-9 flex-1 px-2 text-xs transition-colors',
                    f.mode === v ? 'bg-primary/15 font-semibold text-primary' : 'text-muted-foreground hover:bg-accent/50'
                  )}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Freight terms</Label>
            <div className="flex overflow-hidden rounded-md border border-input" role="radiogroup" aria-label="Freight terms">
              {([['', '—'], ['prepaid', 'Prepaid'], ['collect', 'Collect'], ['third-party', '3rd party']] as const).map(([v, lbl]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={f.freightTerms === v}
                  onClick={() => setF({ ...f, freightTerms: v })}
                  className={cn(
                    'h-9 flex-1 px-2 text-xs transition-colors',
                    f.freightTerms === v ? 'bg-primary/15 font-semibold text-primary' : 'text-muted-foreground hover:bg-accent/50'
                  )}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label>Pallets</Label>
              <Input type="number" min={0} inputMode="numeric" value={f.palletCount} onChange={set('palletCount')} placeholder="5" />
            </div>
            <div className="grid gap-1.5">
              <Label>Boxes</Label>
              <Input type="number" min={0} inputMode="numeric" value={f.boxCount} onChange={set('boxCount')} placeholder="0" />
            </div>
            <div className="grid gap-1.5">
              <Label>Gross wt (lbs)</Label>
              <Input type="number" min={0} inputMode="numeric" value={f.grossWeightLbs} onChange={set('grossWeightLbs')} placeholder="1400" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Other handling units</Label>
            <Input value={f.pieces} onChange={set('pieces')} placeholder="2 crates on skids" />
          </div>
          {pallets.length > 0 && (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Event pallets on this BOL</Label>
              <div className="flex flex-wrap gap-1.5">
                {pallets.map((pl) => {
                  const on = palletIds.includes(pl.id);
                  return (
                    <button
                      key={pl.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPalletIds(on ? palletIds.filter((x) => x !== pl.id) : [...palletIds, pl.id])}
                      className={cn(
                        'rounded border px-2 py-1 text-xs transition-colors',
                        on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent/50'
                      )}
                    >
                      {pl.label || pl.id}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>Special instructions</Label>
            <Input value={f.specialInstructions} onChange={set('specialInstructions')} placeholder="Do not stack — see descriptions, commercial pickup" />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>Delivery instructions</Label>
            <Input value={f.deliveryInstructions} onChange={set('deliveryInstructions')} placeholder="Access via MacArthur Dr — drop at door #4" />
          </div>
          <div className="grid gap-1.5">
            <Label>Reference numbers</Label>
            <Input value={f.referenceNumbers} onChange={set('referenceNumbers')} />
          </div>
          <div className="grid gap-1.5">
            <Label>Notes</Label>
            <Input value={f.notes} onChange={set('notes')} />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>BOL PDF (≤ 700 KB)</Label>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => pickFile(e.target)}
              className="text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-transparent file:px-2.5 file:py-1.5 file:text-xs file:text-foreground"
            />
            {hasStoredFile && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={false} onChange={() => setFile('')} />
                Attached: <span className="font-mono">{initial?.fileName || 'bol.pdf'}</span> — tick to remove
              </label>
            )}
            {file === '' && <span className="text-xs text-muted-foreground">Attachment will be removed on save.</span>}
            {typeof file === 'object' && file != null && <span className="text-xs text-muted-foreground">Selected: <span className="font-mono">{file.name}</span></span>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            {initial ? 'Save BOL' : 'Add BOL'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
