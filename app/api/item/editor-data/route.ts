import { getSession } from '@/lib/session';
import { getDb, NOT_DELETED } from '@/lib/mongo';
import { getUserDisplayName } from '@/lib/data';
import { jsonOk, jsonErr } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// GET /api/item/editor-data — the supporting data the FULL ItemDetailsModal needs so it renders the
// SAME everywhere (the #27 kit-BOM part picker + checklist + the service-flag "by" name), regardless
// of which screen opened it. Callers that already have this (the catalog) pass it as props and skip
// the fetch; callers that don't (a roadcase, the manifest, sign-off) let the modal fetch it here, so
// the editor is universal — one editor, not a stripped-down variant. Signed-in only; no secrets.
//
//   candidates — every non-deleted item (lean: id/name/sku/skuOptions/tagIds) — the kit-BOM part picker.
//   tags       — every non-deleted, non-hidden tag ({ id, label }) — the kit-BOM tag picker.
//   actorName  — the caller's display name, stamped on a service flag / resolution.
export async function GET() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  try {
    const db = await getDb();
    const [itemDocs, tagDocs, actorName] = await Promise.all([
      db
        .collection<{ _id: string; payload?: { name?: string; sku?: string; skuOptions?: unknown; tagIds?: unknown } }>('inventory')
        .find(NOT_DELETED)
        .project({ _id: 1, 'payload.name': 1, 'payload.sku': 1, 'payload.skuOptions': 1, 'payload.tagIds': 1 })
        .toArray(),
      db
        .collection<{ _id: string; payload?: { label?: string; hidden?: boolean } }>('tags')
        .find(NOT_DELETED)
        .project({ _id: 1, 'payload.label': 1, 'payload.hidden': 1 })
        .toArray(),
      getUserDisplayName(sess.sub).catch(() => sess.sub),
    ]);

    const candidates = itemDocs.map((d) => ({
      id: d._id,
      name: d.payload?.name || '',
      sku: d.payload?.sku || '',
      skuOptions: Array.isArray(d.payload?.skuOptions) ? (d.payload?.skuOptions as { sku: string; label?: string }[]) : [],
      tagIds: Array.isArray(d.payload?.tagIds) ? (d.payload?.tagIds as string[]) : [],
    }));
    const tags = tagDocs
      .filter((t) => !t.payload?.hidden)
      .map((t) => ({ id: t._id, label: t.payload?.label || t._id }));

    return jsonOk({ candidates, tags, actorName: actorName || sess.sub });
  } catch {
    return jsonErr(503, 'could not load editor data');
  }
}
