'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ITEM_KINDS } from '@/lib/views/inventory-shape';
import { saveItemAction, deleteItemAction } from '../actions';
import { useUnsavedGuard, UnsavedChangesDialog } from '@/components/hooks/use-unsaved-guard';

// edit-form.tsx — the gated inline catalog item editor (react-hook-form + zod + shadcn Form).
// Submit builds a FormData and calls the saveItemAction Server Action (which routes to
// lib/write.ts under requireRole); field errors render inline via FormMessage, server errors +
// success go to a sonner toast. Delete goes through deleteItemAction behind a confirm Dialog
// (destructive button, default focus on Cancel) and routes back to the list on success.

export interface EditInitial {
  name: string;
  sku: string;
  qr: string;
  kind: string;
  stockTotal: number | null;
  reorderPoint: number | null;
  storageNotes: string;
}

// Mirrors the server-side allowlist + numeric coercion in app/catalog/actions.ts. A blank numeric
// field clears the value (-> null server-side); a non-numeric one is caught here before the trip.
const KIND_VALUES = ['', ...ITEM_KINDS] as const;
const numField = z
  .string()
  .trim()
  .refine((s) => s === '' || Number.isFinite(Number(s)), 'Must be a number')
  .refine((s) => s === '' || Number(s) >= 0, 'Must be 0 or more');

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required.'),
  kind: z.enum(KIND_VALUES),
  sku: z.string().trim(),
  qr: z.string().trim(),
  stockTotal: numField,
  reorderPoint: numField,
  storageNotes: z.string(),
});

type FormValues = z.infer<typeof schema>;

function toDefaults(initial: EditInitial): FormValues {
  return {
    name: initial.name,
    kind: (ITEM_KINDS as readonly string[]).includes(initial.kind)
      ? (initial.kind as (typeof KIND_VALUES)[number])
      : '',
    sku: initial.sku,
    qr: initial.qr,
    stockTotal: initial.stockTotal == null ? '' : String(initial.stockTotal),
    reorderPoint: initial.reorderPoint == null ? '' : String(initial.reorderPoint),
    storageNotes: initial.storageNotes,
  };
}

export function EditItem({ id, initial }: { id: string; initial: EditInitial }) {
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: toDefaults(initial),
    mode: 'onTouched',
  });

  // Don't let an accidental nav (a nav tab, a card, the back button) drop unsaved edits.
  const guard = useUnsavedGuard(form.formState.isDirty);

  function onSubmit(values: FormValues) {
    const fd = new FormData();
    fd.set('id', id);
    fd.set('name', values.name);
    fd.set('kind', values.kind);
    fd.set('sku', values.sku);
    fd.set('qr', values.qr);
    fd.set('stockTotal', values.stockTotal);
    fd.set('reorderPoint', values.reorderPoint);
    fd.set('storageNotes', values.storageNotes);

    startTransition(async () => {
      const res = await saveItemAction({}, fd);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      // The server revalidated /catalog/[id]; reset the form to the just-saved values so the
      // dirty flag clears and the Save button disables again.
      form.reset(values);
      toast.success('Item saved.');
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit item</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Item name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="kind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Kind</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="— Kind —" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ITEM_KINDS.map((k) => (
                          <SelectItem key={k} value={k} className="capitalize">
                            {k}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="sku"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>SKU</FormLabel>
                    <FormControl>
                      <Input placeholder="optional" className="font-mono" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="qr"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Data Matrix / QR</FormLabel>
                    <FormControl>
                      <Input placeholder="optional" className="font-mono" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="stockTotal"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Stock total</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} inputMode="numeric" {...field} />
                    </FormControl>
                    <FormDescription>Total owned; blank derives from placements.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="reorderPoint"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reorder point</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} inputMode="numeric" {...field} />
                    </FormControl>
                    <FormDescription>Low-stock warning threshold.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="storageNotes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Storage notes</FormLabel>
                  <FormControl>
                    <Textarea placeholder="e.g. Shelf B3, main warehouse" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex items-center justify-between gap-2 pt-1">
              <Button type="submit" disabled={pending || !form.formState.isDirty}>
                {pending && <Loader2 className="animate-spin" aria-hidden />}
                {pending ? 'Saving…' : 'Save changes'}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 aria-hidden />
                Delete item
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>

      <DeleteConfirm
        id={id}
        name={initial.name}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
      />
      <UnsavedChangesDialog guard={guard} />
    </Card>
  );
}

function DeleteConfirm({
  id,
  name,
  open,
  onOpenChange,
}: {
  id: string;
  name: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onDelete() {
    const fd = new FormData();
    fd.set('id', id);
    startTransition(async () => {
      const res = await deleteItemAction({}, fd);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success('Item deleted.');
      onOpenChange(false);
      router.push('/catalog');
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete item</DialogTitle>
          <DialogDescription>
            Permanently remove <strong className="text-foreground">{name || 'this item'}</strong>{' '}
            from inventory? This soft-deletes the record — it stops showing in the catalog and the
            tombstone replicates to peers.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" autoFocus>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" onClick={onDelete} disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            {pending ? 'Deleting…' : 'Delete item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default EditItem;
