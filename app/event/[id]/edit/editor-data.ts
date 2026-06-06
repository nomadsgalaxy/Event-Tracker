import 'server-only';
import { getCases, getEvents, getTags, getUsers, type TagDoc } from '@/lib/data';
import { getCaseAvailability, caseStatusLabel, isCaseRetired } from '@/lib/case-view';
import { can } from '@/lib/rbac';
import { integrationStatus } from '@/lib/integrations';
import type { DashTag } from '@/lib/types-dashboard';
import type { DirectoryUser, EditorCase } from './editor-context';

// app/event/[id]/edit/editor-data.ts — assemble the editor's NON-form reference data server-side.
//
// One place that reads the directory + the case catalog (with per-case availability) + the visible
// tag library + the keyed-integration flags, so the edit page and the /event/new page build the
// editor context identically. The `viewerTimezone` is the ONLY field NOT set here — it's a client-only
// read (Intl), filled in the client island after mount to avoid an SSR hydration mismatch.

function toDashTag(doc: TagDoc): DashTag {
  const p = doc.payload ?? {};
  let flair = typeof p.customEmoji === 'string' ? p.customEmoji : '';
  if (!flair && p.flair === 'flag-us') flair = '🇺🇸';
  if (!flair && p.flair === 'flag-cz') flair = '🇨🇿';
  return {
    id: doc._id,
    label: typeof p.label === 'string' ? p.label : '',
    flair,
    color: typeof p.color === 'string' && p.color ? p.color : null,
  };
}

export interface EditorServerData {
  directory: DirectoryUser[];
  cases: EditorCase[];
  caseLabelById: Record<string, string>;
  tags: DashTag[];
  placesAvailable: boolean;
  flightLookupAvailable: boolean;
  canApplyTags: boolean;
}

/**
 * Build the editor's reference data. `selfEventId` is the event being edited (its own held cases
 * never lock it out of its own assignment grid); pass null for a brand-new event.
 */
export async function assembleEditorData(role: string, selfEventId: string | null): Promise<EditorServerData> {
  const [caseDocs, eventDocs, tagDocs, userDocs] = await Promise.all([
    getCases(),
    getEvents(),
    getTags(),
    getUsers(),
  ]);

  // Directory — sorted by display name, with the picture for the staffer avatar.
  const directory: DirectoryUser[] = userDocs
    .map((u) => {
      const p = (u.payload ?? {}) as { name?: string; preferredName?: string; picture?: string };
      return { email: u._id, name: p.preferredName || p.name || '', picture: p.picture || '' };
    })
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

  // Cases — with per-case availability (the lock), mirroring the Manifest assign-cases logic. A case
  // held by THIS event isn't a lock against itself (the availability event excludes selfEventId).
  const allEvents = eventDocs.map((e) => ({ _id: e._id, payload: e.payload }));
  const cases: EditorCase[] = caseDocs.map((c) => {
    const p = c.payload;
    const avail = getCaseAvailability(c._id, allEvents);
    const unavailable = avail.status === 'unavailable' && avail.eventId !== selfEventId;
    return {
      id: c._id,
      slug: p.slug && p.slug !== c._id ? p.slug : '',
      label: p.label || c._id,
      unavailable,
      statusLabel: unavailable ? caseStatusLabel(avail.event) : '',
      retired: isCaseRetired(p),
    };
  });
  const caseLabelById: Record<string, string> = {};
  for (const c of cases) caseLabelById[c.id] = c.label;

  // Visible tags (hidden tags never render a chip in the picker/applied list).
  const tags: DashTag[] = tagDocs.filter((d) => !d.payload?.hidden).map(toDashTag);

  const { placesAvailable, flightLookupAvailable } = await integrationStatus();

  return {
    directory,
    cases,
    caseLabelById,
    tags,
    placesAvailable,
    flightLookupAvailable,
    canApplyTags: can('tags.apply', role),
  };
}
