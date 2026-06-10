import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { requireUser } from '@/lib/auth/auth';
import { can } from '@/lib/auth/rbac';
import { getRoadKits, getCases } from '@/lib/db/data';
import { isCaseRetired } from '@/lib/views/case-view';
import { ScreenHeader } from '@/components/ui/screen-header';
import { RoadKitsManager, type KitRow, type KitCaseOption } from './kits-manager';

// app/catalog/kits — the Road Kits library (the reusable case bundles). A Road Kit is a saved set
// of cases that travel together; assign the whole kit to an event in one action (Manifest → Assign
// cases) and the manifest groups the event's cases by kit. Server Component: live read of kits +
// cases, no cache. AUTH: requireUser gates the session; can('pallets.edit') decides whether the
// create/edit/delete affordances show (the real boundary stays the Server Action's gate).
export const dynamic = 'force-dynamic';

export default async function RoadKitsPage() {
  const [user, kitDocs, caseDocs] = await Promise.all([requireUser(), getRoadKits(), getCases()]);
  const canEdit = can('pallets.edit', user.role);

  const caseLabelById = new Map<string, string>();
  for (const d of caseDocs) caseLabelById.set(d._id, d.payload.label || d.payload.slug || d._id);

  // The case picker offers live (non-retired) cases; retired ones already in a kit still render as chips.
  const caseOptions: KitCaseOption[] = caseDocs
    .filter((d) => !isCaseRetired(d.payload))
    .map((d) => ({ id: d._id, label: d.payload.label || d.payload.slug || d._id }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const kits: KitRow[] = kitDocs.map((d) => {
    const ids = Array.isArray(d.payload.caseIds) ? d.payload.caseIds.filter(Boolean) : [];
    return {
      id: d._id,
      name: d.payload.name || d._id,
      notes: d.payload.notes || '',
      color: d.payload.color ?? null,
      caseIds: ids,
      cases: ids.map((cid) => ({ id: cid, label: caseLabelById.get(cid) || cid })),
    };
  });

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
      <ScreenHeader
        eyebrow={
          <Link href="/catalog?view=cases" className="inline-flex items-center gap-1 hover:text-foreground">
            <ChevronLeft size={13} aria-hidden /> Catalog
          </Link>
        }
        title="Road Kits"
        as="h1"
      />
      <p className="-mt-3 max-w-2xl text-sm text-muted-foreground">
        A Road Kit is a saved bundle of cases that travel together. Assign a whole kit to an event in
        one step from Manifest, and the manifest groups its cases under the kit.
      </p>
      <RoadKitsManager kits={kits} caseOptions={caseOptions} canEdit={canEdit} />
    </div>
  );
}
