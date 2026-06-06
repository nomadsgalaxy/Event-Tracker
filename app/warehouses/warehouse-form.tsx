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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PlacesAddressField } from '@/components/ui/places-address-field';
import {
  createWarehouseAction,
  saveWarehouseAction,
  type WarehouseFormValues,
} from './actions';

// warehouse-form.tsx — the Add / Edit warehouse modal (a faithful port of the Python WarehousesPanel
// inline editor, index.html ~L14122). Name + type (HQ/sub), the street with Google Places
// autocomplete (reuses <PlacesAddressField>; selecting a suggestion fans out city/region/postal/
// country + lat/lng), then city/region/postal/country/phone, and the #71 primary contact
// (name/role/email). Submit calls the gated createWarehouseAction / saveWarehouseAction.

export interface WarehouseEditValues extends WarehouseFormValues {
  id?: string;
}

const BLANK: WarehouseEditValues = {
  name: '',
  type: 'sub',
  street: '',
  city: '',
  region: '',
  postal: '',
  country: '',
  phone: '',
  contactName: '',
  contactRole: '',
  contactEmail: '',
  lat: null,
  lng: null,
};

export function WarehouseForm({
  initial,
  placesAvailable,
  open,
  onOpenChange,
  onSaved,
}: {
  /** Existing warehouse to edit (carries id), or undefined for a fresh create. */
  initial?: WarehouseEditValues;
  placesAvailable: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<WarehouseEditValues>(initial ?? BLANK);
  const [pending, startTransition] = useTransition();
  const isEdit = !!initial?.id;

  const set = (patch: Partial<WarehouseEditValues>) => setForm((f) => ({ ...f, ...patch }));

  function submit() {
    if (!form.name.trim()) {
      toast.warning('Warehouse name is required.');
      return;
    }
    startTransition(async () => {
      const values: WarehouseFormValues = {
        name: form.name,
        type: form.type === 'hq' ? 'hq' : 'sub',
        street: form.street,
        city: form.city,
        region: form.region,
        postal: form.postal,
        country: form.country,
        phone: form.phone,
        contactName: form.contactName,
        contactRole: form.contactRole,
        contactEmail: form.contactEmail,
        lat: form.lat ?? null,
        lng: form.lng ?? null,
      };
      const res = isEdit
        ? await saveWarehouseAction(initial!.id!, values)
        : await createWarehouseAction(values);
      if (res.error || !res.ok) {
        toast.error(res.error || 'Could not save the warehouse.');
        return;
      }
      toast.success(isEdit ? 'Warehouse saved.' : 'Warehouse created.');
      onSaved();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit warehouse' : 'New warehouse'}</DialogTitle>
          <DialogDescription>
            Return-address location — each roadcase can home here, and its 4×6 shipping label prints this
            address + contact.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[2fr_1fr] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wh-name">Name</Label>
            <Input id="wh-name" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Main Warehouse" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wh-type">Type</Label>
            <select
              id="wh-type"
              value={form.type}
              onChange={(e) => set({ type: e.target.value as 'hq' | 'sub' })}
              className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30"
            >
              <option value="hq">HQ</option>
              <option value="sub">Sub-warehouse</option>
            </select>
          </div>
        </div>

        {/* Street with Places autocomplete — fans out city/region/postal/country + lat/lng. */}
        <div className="flex flex-col gap-1.5">
          <Label>Street address</Label>
          <PlacesAddressField
            value={form.street}
            placesAvailable={placesAvailable}
            onChange={(v) => set({ street: v })}
            onPlace={(p) =>
              set({
                street: p.address || form.street,
                city: p.city || form.city,
                region: p.state || form.region,
                postal: p.zip || form.postal,
                lat: p.lat != null ? p.lat : form.lat,
                lng: p.lng != null ? p.lng : form.lng,
              })
            }
            placeholder="Start typing the street address…"
            aria-label="Street address"
          />
        </div>

        <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wh-city">City</Label>
            <Input id="wh-city" value={form.city} onChange={(e) => set({ city: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wh-region">State / region</Label>
            <Input id="wh-region" value={form.region} onChange={(e) => set({ region: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wh-postal">Postal</Label>
            <Input id="wh-postal" value={form.postal} onChange={(e) => set({ postal: e.target.value })} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wh-country">Country</Label>
            <Input id="wh-country" value={form.country} onChange={(e) => set({ country: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wh-phone">Phone</Label>
            <Input id="wh-phone" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
          </div>
        </div>

        {/* #71 per-warehouse primary contact — printed as the "If found, contact" on this warehouse's
            roadcase shipping labels, falling back to the global emergency contact when blank. */}
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Primary contact · #71</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wh-cname">Contact name</Label>
              <Input id="wh-cname" value={form.contactName} onChange={(e) => set({ contactName: e.target.value })} placeholder="optional" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wh-crole">Contact role</Label>
              <Input id="wh-crole" value={form.contactRole} onChange={(e) => set({ contactRole: e.target.value })} placeholder="e.g. Warehouse Lead" />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wh-cemail">Contact email</Label>
            <Input id="wh-cemail" type="email" value={form.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} placeholder="optional" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {isEdit ? 'Save warehouse' : 'Create warehouse'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default WarehouseForm;
