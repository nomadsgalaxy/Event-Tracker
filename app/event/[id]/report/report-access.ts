import 'server-only';
import { requireUser, type CurrentUser } from '@/lib/auth/auth';
import { can } from '@/lib/auth/rbac';
import { getEvent } from '@/lib/db/data';
import { viewerLeadsEvent } from '@/lib/views/event-view';
import type { EventDoc } from '@/lib/types/types';

// report-access.ts — the ONE gate every Event Report surface (page, exports, AI action) runs.
// Lead-of-event or staff.pii.view (manager+): the report shows every staffer's ratings and
// free-text comments, so it rides the same tier as the rest of the per-event staff data.

export type ReportAccess =
  | { ok: true; user: CurrentUser; doc: EventDoc }
  | { ok: false; status: 401 | 403 | 404; error: string };

export async function requireReportAccess(eventId: string): Promise<ReportAccess> {
  const user = await requireUser(); // redirects signed-out to /login (page); route callers get the redirect too
  const doc = await getEvent(String(eventId ?? '').trim());
  if (!doc?.payload) return { ok: false, status: 404, error: 'Event not found.' };
  const isLead = viewerLeadsEvent(doc.payload, user.email);
  if (!can('staff.pii.view', user.role, { isLeadOfEvent: isLead })) {
    return { ok: false, status: 403, error: 'Only the event lead or a manager can view the event report.' };
  }
  return { ok: true, user, doc };
}
