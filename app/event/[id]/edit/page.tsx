import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, ShieldAlert } from 'lucide-react';
import { getEvent } from '@/lib/data';
import { requireUser } from '@/lib/auth';
import { can } from '@/lib/rbac';
import { viewerLeadsEvent, stripEventPii } from '@/lib/event-view';
import { Button } from '@/components/ui/button';
import { EventEditor } from './event-editor';
import { assembleEditorData } from './editor-data';

// app/event/[id]/edit/page.tsx — the event EDITOR route (Server Component).
//
// GATE: requireUser (redirects to /login when signed out), then the per-event event.edit
// decision is judged on the STORED doc — manager+ OR the lead of THIS event. A signed-in
// user who isn't allowed gets a 403-style block instead of the editor (and the Server
// Action re-checks on write against the stored doc, so hitting the action directly can't
// bypass this).
//
// PII: the draft handed to the client is PII-stripped UNLESS the editor may also edit
// travel/hotel (staff.pii.view — manager+/self/lead). When the editor can't see a staffer's
// PII, those fields are withheld from the wire AND from the form; the save path on the
// server preserves the stored PII it was never shown (defense in depth).
export const dynamic = 'force-dynamic';

export default async function EventEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(); // redirects if not signed in
  const doc = await getEvent(id);
  if (!doc) notFound();

  const isLead = viewerLeadsEvent(doc.payload, user.email);
  const canEdit = can('event.edit', user.role, { isLeadOfEvent: isLead });

  if (!canEdit) {
    return (
      <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 rounded-lg border border-dashed border-border px-6 py-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert aria-hidden />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Not allowed</h1>
          <p className="text-sm text-muted-foreground">
            You don&rsquo;t have permission to edit this event. Only a manager, an admin, or the
            event lead can edit it.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href={`/event/${id}`}>
            <ChevronLeft aria-hidden />
            Back to event
          </Link>
        </Button>
      </div>
    );
  }

  // The editor may see travel/hotel only when staff.pii.view passes (manager+, or the lead
  // of this event). Strip the draft for a sub-PII editor so the wire/form never carry PII the
  // editor shouldn't touch.
  const piiEditable = can('staff.pii.view', user.role, { isLeadOfEvent: isLead });
  const draft = piiEditable ? doc.payload : stripEventPii(doc.payload, user.email, user.role);

  // Non-form reference data (directory, case catalog + availability, tag library, integration flags).
  // selfEventId = this event, so its own held cases don't lock it out of its own assignment grid.
  const editorContext = await assembleEditorData(user.role, id);

  return (
    <div className="flex flex-col gap-5 px-4 py-4 sm:px-6 sm:py-6">
      <Button asChild variant="ghost" size="sm" className="w-fit -ml-2 text-muted-foreground">
        <Link href={`/event/${id}`}>
          <ChevronLeft aria-hidden />
          Back to event
        </Link>
      </Button>
      <EventEditor id={id} initial={draft} piiEditable={piiEditable} editorContext={editorContext} />
    </div>
  );
}
