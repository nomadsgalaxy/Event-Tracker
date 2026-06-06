import Link from 'next/link';
import { ChevronLeft, ShieldAlert } from 'lucide-react';
import { requireUser } from '@/lib/auth';
import { can } from '@/lib/rbac';
import { Button } from '@/components/ui/button';
import { EventEditor } from '../[id]/edit/event-editor';
import { assembleEditorData } from '../[id]/edit/editor-data';
import type { EventPayload } from '@/lib/types';

// app/event/new/page.tsx — the event CREATE route (Server Component).
//
// GATE: requireUser (redirects to /login when signed out), then event.create (manager+) on the LIVE
// role — a signed-in user who isn't allowed gets a 403-style block instead of the editor (and
// createEventAction re-checks event.create on write, so hitting the action directly can't bypass
// this). The creator is always manager+ (who passes staff.pii.view), so the editor is rendered in
// piiEditable mode — a fresh event has no stored PII to protect.
export const dynamic = 'force-dynamic';

const BLANK_EVENT: EventPayload = {
  name: '',
  state: 'draft',
  startDate: '',
  endDate: '',
  doorsOpen: '',
  doorsClose: '',
  city: '',
  venue: {},
  staff: [],
  cases: [],
  lead: '',
  pallets: [],
  sideEvents: [],
  outbound: {},
  return: {},
  tagIds: [],
  primaryTagId: null,
};

export default async function EventCreatePage() {
  const user = await requireUser(); // redirects if not signed in

  if (!can('event.create', user.role)) {
    return (
      <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 rounded-lg border border-dashed border-border px-6 py-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert aria-hidden />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Not allowed</h1>
          <p className="text-sm text-muted-foreground">
            You don&rsquo;t have permission to create events. Only a manager or an admin can.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/">
            <ChevronLeft aria-hidden />
            Back to dashboard
          </Link>
        </Button>
      </div>
    );
  }

  // No selfEventId for a brand-new event — every held case locks normally.
  const editorContext = await assembleEditorData(user.role, null);

  return (
    <div className="flex flex-col gap-5 px-4 py-4 sm:px-6 sm:py-6">
      <Button asChild variant="ghost" size="sm" className="w-fit -ml-2 text-muted-foreground">
        <Link href="/">
          <ChevronLeft aria-hidden />
          Dashboard
        </Link>
      </Button>
      <EventEditor id="__new__" initial={BLANK_EVENT} piiEditable isNew editorContext={editorContext} />
    </div>
  );
}
