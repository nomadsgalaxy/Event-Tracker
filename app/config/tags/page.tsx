import { requireRole } from '@/lib/auth/auth';
import { getTags, getEvents, getInventory } from '@/lib/db/data';
import { can } from '@/lib/auth/rbac';
import { TagsPanel, type TagLibRow } from './tags-panel';

// app/config/tags — the tag-library manager (Config > Tags). Server Component: reads the live `tags`
// collection + the events/inventory to compute per-tag USAGE counts (event uses + item uses), the
// same cross-join the Python TagsConfigPanel does over the in-memory stores. The whole /config area
// is admin-gated by the layout; we re-resolve the role here to thread the EFFECTIVE tags.edit /
// tags.delete grants to the client (UX gating — the Server Actions re-check independently).
export const dynamic = 'force-dynamic';

export default async function ConfigTagsPage() {
  const [admin, tagDocs, eventDocs, invDocs] = await Promise.all([
    requireRole('admin'),
    getTags(),
    getEvents(),
    getInventory(),
  ]);

  // Per-tag use counts: an event/item uses a tag when its payload.tagIds[] includes the tag id.
  const eventUses = new Map<string, number>();
  const itemUses = new Map<string, number>();
  for (const e of eventDocs) {
    for (const id of e.payload?.tagIds ?? []) eventUses.set(id, (eventUses.get(id) ?? 0) + 1);
  }
  for (const it of invDocs) {
    for (const id of it.payload?.tagIds ?? []) itemUses.set(id, (itemUses.get(id) ?? 0) + 1);
  }

  // getTags already excludes top-level tombstones (NOT_DELETED) + sorts by label. Project to a lean,
  // serializable row.
  const rows: TagLibRow[] = tagDocs.map((d) => {
    const p = d.payload || {};
    const id = p.id || d._id;
    return {
      id,
      label: p.label || '',
      hidden: Boolean(p.hidden),
      color: typeof p.color === 'string' ? p.color : null,
      flair: typeof p.flair === 'string' ? p.flair : null,
      customEmoji: typeof p.customEmoji === 'string' ? p.customEmoji : '',
      eventUses: eventUses.get(id) ?? 0,
      itemUses: itemUses.get(id) ?? 0,
    };
  });

  return (
    <TagsPanel
      rows={rows}
      canEdit={can('tags.edit', admin.role)}
      // tags.delete is the base cap; the >3-uses graduation to admin is re-checked server-side. We
      // pass whether the caller is admin so the client can mirror the ">3 uses needs admin" UX lock.
      canDelete={can('tags.delete', admin.role)}
      isAdmin={admin.role === 'admin'}
    />
  );
}
