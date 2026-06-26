'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Trash2, X, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Form } from '@/components/ui/form';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Eyebrow } from '@/components/ui/eyebrow';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type { EventPayload } from '@/lib/types/types';
import { saveEventAction, createEventAction, deleteEventAction } from '@/app/event/actions';
import { eventFormSchema, toFormValues, toPatch, type EventFormValues } from './schema';
import { OverviewPanel, TeamPanel, PackingPanel, ShippingPanel, SidePanel } from './editor-fields';
import { EditorProvider, type EditorContextValue } from './editor-context';
import { useUnsavedGuard, UnsavedChangesDialog } from '@/components/hooks/use-unsaved-guard';

// The server hands the editor everything in EditorContextValue EXCEPT viewerTimezone — that's an
// Intl read, which must be client-only + mount-gated (no client read during the initial render, to
// avoid an SSR hydration mismatch). The editor resolves it after mount and merges it into the context.
export type EditorServerContext = Omit<EditorContextValue, 'viewerTimezone'>;

// app/event/[id]/edit/event-editor.tsx — the tabbed event EDITOR (the flagship), full parity pass.
//
// WHY THE TWO OLD BUGS ARE STRUCTURALLY IMPOSSIBLE HERE:
//   • #90 (remount / focus-loss): every field component lives at MODULE SCOPE in editor-fields.tsx
//     and binds to the form via react-hook-form. None is defined inside this component's render body,
//     so React keeps a stable element identity and reconciles each <input> in place — a re-render on
//     a keystroke / tab switch / field-array mutation can't blow away the focused input. (RHF further
//     isolates re-renders per field.)
//   • #93 (tab-switch data loss): the Tabs primitive keeps EVERY panel MOUNTED — each TabsContent
//     uses `forceMount`, inactive panels are merely `hidden`, never unmounted. A half-typed value in
//     the Team tab survives switching to Shipping and back because its inputs were never torn down AND
//     because the value lives in ONE react-hook-form store, not in panel-local state. Nothing is
//     panel-local that a switch could lose. (The Python needed an onBlur local-draft hack to survive
//     its own remount bug; here RHF's stable identity makes that unnecessary.)
//
// CREATE vs EDIT: `isNew` flips the eyebrow/title/buttons + routes Save to createEventAction (which
// mints the id server-side and navigates to the new event) instead of saveEventAction. A new event
// always starts on the Overview tab.
//
// On Save we reduce the form value to the editable allowlist patch and post to the Server Action
// (live-DB write through lib/write.ts → updateOne $set / insertOne + revalidate). PII fields the
// editor was never shown are absent from the value, so the write never blanks stored PII it wasn't
// allowed to touch (and the server re-merges defensively regardless).

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'team', label: 'Team & Travel' },
  { id: 'packing', label: 'Packing' },
  { id: 'shipping', label: 'Shipping' },
  { id: 'side', label: 'Side events' },
] as const;

// The SAME sessionStorage key the read-only detail uses (#85/#93) so toggling view↔edit keeps the tab.
const TAB_STORAGE_KEY = 'eit:evTab';

export function EventEditor({
  id,
  initial,
  piiEditable,
  isNew = false,
  editorContext,
}: {
  id: string;
  initial: EventPayload;
  piiEditable: boolean;
  isNew?: boolean;
  editorContext: EditorServerContext;
}) {
  const router = useRouter();

  // viewerTimezone — client-only Intl read, resolved AFTER mount (no client read during the initial
  // render, so the SSR + first client render match). Until then the "Use mine" button is disabled.
  const [viewerTimezone, setViewerTimezone] = useState('');
  useEffect(() => {
    try {
      setViewerTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
    } catch {
      /* leave blank */
    }
  }, []);
  const fullContext: EditorContextValue = useMemo(
    () => ({ ...editorContext, viewerTimezone }),
    [editorContext, viewerTimezone]
  );
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteErr, setDeleteErr] = useState('');
  const [active, setActive] = useState<string>('overview');

  const defaults = useMemo(() => toFormValues(initial, piiEditable), [initial, piiEditable]);

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventFormSchema),
    defaultValues: defaults,
    mode: 'onBlur',
  });

  const { isSubmitSuccessful } = form.formState;
  const eventName = form.watch('name');

  // Dirty by SAVED-PATCH SIGNATURE, not RHF's isDirty. RHF's isDirty can read chronically-dirty when a
  // field's SHAPE doesn't round-trip against its default ("" vs undefined, string vs number, an empty
  // field array), which form.reset() then can't clear — and with the navigation guard below that would
  // TRAP the user on the page after a save. Comparing the reduced patch (the exact thing we persist)
  // against the last-saved signature always clears the moment a save succeeds.
  const watchedValues = form.watch();
  const [savedSig, setSavedSig] = useState(() => JSON.stringify(toPatch(defaults)));
  const dirty = useMemo(() => JSON.stringify(toPatch(watchedValues)) !== savedSig, [watchedValues, savedSig]);

  // Restore the last active editor tab across reloads (matches the source app's sessionStorage'd
  // tab). A NEW event always starts on Overview. Read once on mount to avoid a hydration mismatch.
  useEffect(() => {
    if (isNew) return;
    try {
      const saved = sessionStorage.getItem(TAB_STORAGE_KEY);
      if (saved && TABS.some((t) => t.id === saved)) setActive(saved);
    } catch {
      /* sessionStorage unavailable — fine */
    }
  }, [isNew]);
  const selectTab = useCallback((next: string) => {
    setActive(next);
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  // Guard unsaved edits against reload/close AND in-app navigation (nav tabs, cards, the back button)
  // — see use-unsaved-guard. The editor's own Save/Cancel below clear `dirty` or route through it.
  const guard = useUnsavedGuard(dirty);

  // Concurrency: the editor posts the baseline it loaded against (savedSig) so the server can field-
  // merge and refuse a save that would overwrite someone else's out-of-band edit. On a conflict we
  // surface the field names and flip Save to "Save anyway" — the next click arms `overrideRef`, which
  // re-submits with override so the user's version wins. Cleared on a successful save.
  const [conflictFields, setConflictFields] = useState<string[] | null>(null);
  const overrideRef = useRef(false);
  const armOverride = () => {
    if (conflictFields) overrideRef.current = true;
  };

  const onSubmit = (values: EventFormValues) => {
    const json = JSON.stringify(toPatch(values));
    startTransition(async () => {
      if (isNew) {
        const res = await createEventAction(json);
        if (res.ok && res.id) {
          // Clear dirty before navigating so the guard doesn't flag this intentional jump.
          setSavedSig(json);
          toast.success('Event created.');
          router.push(`/event/${res.id}`);
        } else {
          toast.error(res.error || 'Create failed.');
        }
        return;
      }
      const override = overrideRef.current;
      overrideRef.current = false;
      const res = await saveEventAction(id, json, savedSig, override);
      if (res.ok) {
        // Adopt the saved patch as the new baseline → dirty clears, the guard relaxes. (form.reset keeps
        // RHF's own validation/submit state coherent; the signature is what drives `dirty`.)
        setSavedSig(json);
        setConflictFields(null);
        form.reset(values);
        toast.success('Event saved.');
        router.refresh();
      } else if (res.conflict) {
        setConflictFields(res.fields || []);
        const list = (res.fields || []).join(', ');
        toast.error(
          `This event changed since you opened it${list ? ` (${list})` : ''}. Review, then click “Save anyway” to overwrite.`
        );
      } else {
        toast.error(res.error || 'Save failed.');
      }
    });
  };

  // Cancel routes through the guard: clean → leave now, dirty → the discard dialog.
  const doCancel = () => guard.guardedPush(isNew ? '/' : `/event/${id}`);

  const doDelete = () => {
    setDeleteErr('');
    startTransition(async () => {
      const r = await deleteEventAction(id);
      if (r.ok) {
        setSavedSig(JSON.stringify(toPatch(form.getValues()))); // clean → guard ignores the redirect
        setConfirmDelete(false);
        toast.success('Event deleted.');
        router.push('/');
      } else {
        setDeleteErr(r.error || 'Delete failed.');
      }
    });
  };

  const saved = !isNew && isSubmitSuccessful && !dirty;

  return (
    <EditorProvider value={fullContext}>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5">
          <header className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <Eyebrow>{isNew ? 'Create event' : 'Edit event'}</Eyebrow>
              <h1 className="mt-0.5 truncate text-2xl font-semibold tracking-tight">
                {eventName || (isNew ? 'New showcase' : 'Untitled event')}
              </h1>
            </div>
            {dirty && (
              <Badge variant="outline" className="text-warning" style={{ borderColor: 'var(--warning)' }}>
                Unsaved
              </Badge>
            )}
            {saved && (
              <Badge variant="outline" className="text-success" style={{ borderColor: 'var(--success)' }}>
                Saved
              </Badge>
            )}
            <Button type="button" variant="ghost" onClick={doCancel} disabled={pending}>
              <X aria-hidden />
              Cancel
            </Button>
            <Button type="submit" disabled={pending} onClick={armOverride}>
              {pending ? <Loader2 aria-hidden className="animate-spin" /> : <Save aria-hidden />}
              {pending ? (isNew ? 'Creating…' : 'Saving…') : isNew ? 'Create' : conflictFields ? 'Save anyway' : 'Save'}
            </Button>
          </header>

          <Tabs value={active} onValueChange={selectTab}>
            {/* w-fit by default → the 5 tab labels overflow the viewport on mobile (page jiggle +
                last tab clipped). WRAP to a second row instead of overflow-x-auto: the latter forces
                overflow-y:auto, and the trigger's bottom-[-5px] underline then spawns a stray scrollbar. */}
            <TabsList aria-label="Event editor sections" className="h-auto w-full max-w-full flex-wrap justify-start">
              {TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="shrink-0 flex-none">
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>

            {/* forceMount keeps EVERY panel mounted (the #93 contract); hide the inactive ones. */}
            <TabsContent value="overview" forceMount className="mt-4 data-[state=inactive]:hidden">
              <OverviewPanel />
            </TabsContent>
            <TabsContent value="team" forceMount className="mt-4 data-[state=inactive]:hidden">
              <TeamPanel piiEditable={piiEditable} />
            </TabsContent>
            <TabsContent value="packing" forceMount className="mt-4 data-[state=inactive]:hidden">
              <PackingPanel />
            </TabsContent>
            <TabsContent value="shipping" forceMount className="mt-4 data-[state=inactive]:hidden">
              <ShippingPanel />
            </TabsContent>
            <TabsContent value="side" forceMount className="mt-4 data-[state=inactive]:hidden">
              <SidePanel />
            </TabsContent>
          </Tabs>

          {/* Footer — Delete (left, EDIT mode only) / Cancel + Save (right). */}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <div>
              {!isNew && (
                <Button
                  type="button"
                  variant="outline"
                  className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                  disabled={pending}
                >
                  <Trash2 aria-hidden />
                  Delete event
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={doCancel} disabled={pending}>
                <X aria-hidden />
                Cancel
              </Button>
              <Button type="submit" disabled={pending} onClick={armOverride}>
                {pending ? <Loader2 aria-hidden className="animate-spin" /> : <Save aria-hidden />}
                {pending ? (isNew ? 'Creating…' : 'Saving…') : isNew ? 'Create event' : conflictFields ? 'Save anyway' : 'Save changes'}
              </Button>
            </div>
          </div>
        </form>

        {/* Discard-confirm — fires on Cancel AND any accidental navigation while dirty. */}
        <UnsavedChangesDialog
          guard={guard}
          description="This event has changes that haven’t been saved. Leaving now will lose them."
        />

        {/* Delete-confirm (EDIT mode). */}
        <Dialog open={confirmDelete} onOpenChange={(o) => !pending && setConfirmDelete(o)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Delete event</DialogTitle>
              <DialogDescription>
                Delete &ldquo;{eventName || 'Untitled event'}&rdquo;? This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {deleteErr && <p className="text-sm text-destructive">{deleteErr}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={doDelete} disabled={pending} className="bg-destructive text-white hover:bg-destructive/90">
                {pending ? 'Deleting…' : 'Yes, delete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Form>
    </EditorProvider>
  );
}

export default EventEditor;
