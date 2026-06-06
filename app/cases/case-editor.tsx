'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Plus, Loader2, Trash2, Truck, MapPin } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { weightInUnit, parseWeightToKg, weightUnitLabel } from '@/lib/weight';
import type { CasePayload } from '@/lib/types';
import type { CaseEffectiveTransit, CaseDeleteClassification } from '@/lib/case-view';
import {
  saveCaseAction,
  createCaseAction,
  caseTransferAction,
  caseMarkArrivedAction,
  type CaseFormValues,
} from './actions';
import { RetireCaseModal } from './retire-case-modal';

// case-editor.tsx — the full CaseEditor (DESIGN_ALIGNMENT feature parity). A faithful port of
// index.html CaseEditor (~L19474): label · kit-for · size · weight (entered + shown in the user's
// unit, #11) · note/zone · home warehouse · the #66 Current-location / transfer block (Mark-in-transit
// with carrier + tracking; Mark-arrived) · and the Delete/Retire footer (→ RetireCaseModal). Works in
// BOTH blank (New case → createCaseAction) and edit (saveCaseAction) modes. The actual writes go
// through the gated Server Actions; this component only collects + submits. The trigger is a button
// (Edit case / New case) that opens the Dialog.

const SIZE_OPTIONS = [
  { value: 'small', label: 'small' },
  { value: 'medium', label: 'medium' },
  { value: 'large', label: 'large' },
  { value: 'xl', label: 'xl' },
] as const;

export interface WarehouseLite {
  id: string;
  name: string;
  type: 'hq' | 'sub';
}

interface CaseEditorProps {
  id: string;
  payload: CasePayload;
  isNew?: boolean;
  /** The user's preferred weight unit ('kg'|'lbs') — entry + display honor it (#11). */
  weightUnit: 'kg' | 'lbs';
  warehouses: WarehouseLite[];
  /** Pre-resolved current-location label ("At HQ" / "⇆ In transit to X"). */
  locationLabel?: string;
  /** Whether this case is currently in transit (own record). */
  inTransit?: boolean;
  /** Where it's heading (name), when in transit. */
  transitToName?: string;
  /** Whether the transit is driven by an event's in_transit state (read-only, no manual move). */
  effectiveTransit?: CaseEffectiveTransit;
  /** The FK classification for the Delete/Retire footer (null when not deletable, e.g. New). */
  classification?: CaseDeleteClassification | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CaseEditorDialog({
  id,
  payload,
  isNew = false,
  weightUnit,
  warehouses,
  locationLabel,
  inTransit = false,
  transitToName,
  effectiveTransit,
  classification,
  open,
  onOpenChange,
}: CaseEditorProps) {
  const router = useRouter();
  const wUnit = weightUnitLabel(weightUnit);

  const kitForCsv = Array.isArray(payload.kitFor) ? payload.kitFor.filter(Boolean).join(', ') : '';
  const initialSize = SIZE_OPTIONS.some((o) => o.value === payload.size)
    ? (payload.size as (typeof SIZE_OPTIONS)[number]['value'])
    : 'medium';

  const [label, setLabel] = useState(payload.label ?? '');
  const [kitFor, setKitFor] = useState(kitForCsv);
  const [size, setSize] = useState<string>(initialSize);
  const [weight, setWeight] = useState(weightInUnit(payload.weight, weightUnit));
  const [zone, setZone] = useState(payload.zone ?? '');
  const [homeWarehouseId, setHomeWarehouseId] = useState(payload.homeWarehouseId ?? '');

  // #66 transfer sub-form state.
  const [moveTo, setMoveTo] = useState('');
  const [moveCarrier, setMoveCarrier] = useState('');
  const [moveNumber, setMoveNumber] = useState('');

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [transitPending, startTransit] = useTransition();

  const retired = !!payload.retiredAt;
  const eventDriven = effectiveTransit?.kind === 'event';

  // Build the canonical-kg form values the Server Action expects (the user enters in their unit).
  function buildValues(): CaseFormValues {
    const kg = weight === '' || weight == null ? '' : String(parseWeightToKg(weight, weightUnit) ?? '');
    return { label, size, zone, kitFor, weight: kg, homeWarehouseId };
  }

  function submit() {
    startTransition(async () => {
      const values = buildValues();
      const res = isNew ? await createCaseAction(values) : await saveCaseAction(id, values);
      if (res.error || !res.ok) {
        toast.error(res.error || 'Failed to save case.');
        return;
      }
      toast.success(isNew ? 'Case created.' : 'Case saved.');
      onOpenChange(false);
      if (isNew && res.id) router.push(`/cases/${encodeURIComponent(res.id)}`);
    });
  }

  function doTransfer() {
    if (!moveTo) return;
    startTransit(async () => {
      // Save the form first (so an in-progress edit isn't lost), then mark in transit.
      const save = await saveCaseAction(id, buildValues());
      if (save.error || !save.ok) {
        toast.error(save.error || 'Could not save before transfer.');
        return;
      }
      const res = await caseTransferAction(id, moveTo, moveCarrier, moveNumber);
      if (res.error || !res.ok) {
        toast.error(res.error || 'Could not mark in transit.');
        return;
      }
      toast.success('Marked in transit.');
      setMoveTo('');
      setMoveCarrier('');
      setMoveNumber('');
      router.refresh();
    });
  }

  function doArrived() {
    startTransit(async () => {
      const res = await caseMarkArrivedAction(id);
      if (res.error || !res.ok) {
        toast.error(res.error || 'Could not mark arrived.');
        return;
      }
      toast.success('Marked arrived.');
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] gap-4 overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isNew ? 'New roadcase' : `Edit ${payload.label || 'roadcase'}`}</DialogTitle>
          <DialogDescription>
            {isNew
              ? 'Create a road or flight case. The id is minted automatically and never changes.'
              : "Update this case's label, kit, size, weight, home warehouse and location."}
          </DialogDescription>
        </DialogHeader>

        {!isNew && retired && (
          <Alert>
            <AlertTitle style={{ color: 'var(--warning)' }}>Retired</AlertTitle>
            <AlertDescription>{payload.retiredReason || '(no reason recorded)'}</AlertDescription>
          </Alert>
        )}

        {!isNew && payload.slug && payload.slug !== id && (
          <div className="flex items-baseline gap-3 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs">
            <span className="font-semibold tracking-wide text-muted-foreground uppercase">Slug</span>
            <span className="font-mono text-muted-foreground">{payload.slug}</span>
            <span className="flex-1" />
            <span className="text-muted-foreground/70 italic">locked</span>
          </div>
        )}

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="case-label">Label</Label>
            <Input id="case-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. MK4 Kit A" />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="case-kit">Kit for (SKU codes, comma-separated; blank = shared)</Label>
            <Input
              id="case-kit"
              className="font-mono"
              value={kitFor}
              onChange={(e) => setKitFor(e.target.value)}
              placeholder="XL-5T, CO, MK4S · (blank for shared)"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="case-size">Size</Label>
              <Select value={size} onValueChange={setSize}>
                <SelectTrigger id="case-size" className="w-full">
                  <SelectValue placeholder="Size" />
                </SelectTrigger>
                <SelectContent>
                  {SIZE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="case-weight">Weight ({wUnit})</Label>
              <Input
                id="case-weight"
                inputMode="decimal"
                className="font-mono"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                placeholder={wUnit === 'lbs' ? 'e.g. 50' : 'e.g. 22.5'}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="case-zone">Note (shown beneath the case name in catalog cards)</Label>
            <Input
              id="case-zone"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="e.g. CORE One+ · MK4S · Banners (booth)"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="case-home">Home warehouse (return address on shipping labels)</Label>
            {warehouses.length === 0 ? (
              <p className="py-1.5 text-xs text-muted-foreground italic">
                No warehouses configured. Add one in Config → Warehouses.
              </p>
            ) : (
              <Select value={homeWarehouseId || '__none__'} onValueChange={(v) => setHomeWarehouseId(v === '__none__' ? '' : v)}>
                <SelectTrigger id="case-home" className="w-full">
                  <SelectValue placeholder="— Use default HQ —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— Use default HQ —</SelectItem>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                      {w.type === 'hq' ? ' · HQ' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* #66 Current location / transfer block — edit mode only. */}
          {!isNew && (
            <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-3">
              <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <MapPin className="size-4 text-muted-foreground" aria-hidden />
                {locationLabel || '—'}
                {eventDriven ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    (set by the event&apos;s In Transit state)
                  </span>
                ) : null}
              </div>

              {inTransit ? (
                <div className="flex flex-wrap items-center gap-2.5">
                  {payload.transit?.tracking?.number ? (
                    <span className="font-mono text-xs text-muted-foreground">
                      {payload.transit.tracking.carrier ? payload.transit.tracking.carrier + ' ' : ''}
                      {payload.transit.tracking.number}
                    </span>
                  ) : null}
                  <Button size="sm" onClick={doArrived} disabled={transitPending}>
                    {transitPending ? <Loader2 className="animate-spin" aria-hidden /> : <Truck size={14} aria-hidden />}
                    Mark arrived{transitToName ? ` at ${transitToName}` : ''}
                  </Button>
                </div>
              ) : eventDriven ? null : warehouses.length > 0 ? (
                <div className="grid gap-1.5">
                  <p className="text-xs text-muted-foreground">Transfer / return to another warehouse:</p>
                  <Select value={moveTo} onValueChange={setMoveTo}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="— choose destination —" />
                    </SelectTrigger>
                    <SelectContent>
                      {warehouses
                        .filter((w) => w.id !== (payload.currentWarehouseId || payload.homeWarehouseId))
                        .map((w) => (
                          <SelectItem key={w.id} value={w.id}>
                            {w.name}
                            {w.type === 'hq' ? ' · HQ' : ''}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input value={moveCarrier} onChange={(e) => setMoveCarrier(e.target.value)} placeholder="Carrier (optional)" />
                    <Input value={moveNumber} onChange={(e) => setMoveNumber(e.target.value)} placeholder="Tracking # (optional)" />
                  </div>
                  <div>
                    <Button size="sm" disabled={!moveTo || transitPending} onClick={doTransfer}>
                      {transitPending ? <Loader2 className="animate-spin" aria-hidden /> : <Truck size={14} aria-hidden />}
                      Mark in transit
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter className="flex-col gap-3 sm:flex-row sm:justify-between">
          {/* Destructive — existing, non-retired cases only. */}
          {!isNew && !retired && classification ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              className="text-destructive border-destructive/60 hover:bg-destructive/10"
            >
              <Trash2 size={14} aria-hidden />
              Delete / Retire
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} disabled={pending}>
              {pending && <Loader2 className="animate-spin" aria-hidden />}
              {isNew ? 'Create case' : 'Save'}
            </Button>
          </div>
        </DialogFooter>

        {classification && (
          <RetireCaseModal
            caseId={id}
            caseLabel={payload.label || ''}
            classification={classification}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            onDone={() => {
              onOpenChange(false);
              router.push('/catalog');
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Trigger buttons ──────────────────────────────────────────────────────────────────────────

/** The "Edit case" button on the detail page (opens the editor in edit mode). */
export function CaseEditButton(props: Omit<CaseEditorProps, 'open' | 'onOpenChange' | 'isNew'>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="default" size="sm" onClick={() => setOpen(true)}>
        <Pencil aria-hidden />
        Edit case
      </Button>
      <CaseEditorDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** The "New case" button (opens the editor in blank/create mode). */
export function NewCaseButton({
  weightUnit,
  warehouses,
  className,
}: {
  weightUnit: 'kg' | 'lbs';
  warehouses: WarehouseLite[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const blank: CasePayload = {
    id: '',
    label: '',
    slug: '',
    size: 'medium',
    zone: '',
    kitFor: null,
    weight: '',
    homeWarehouseId: null,
  };
  return (
    <>
      <Button size="sm" className={cn(className)} onClick={() => setOpen(true)}>
        <Plus size={14} aria-hidden />
        <span>New case</span>
      </Button>
      <CaseEditorDialog
        id=""
        payload={blank}
        isNew
        weightUnit={weightUnit}
        warehouses={warehouses}
        classification={null}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

export default CaseEditorDialog;
