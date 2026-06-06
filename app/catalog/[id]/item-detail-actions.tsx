'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Settings2, QrCode } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ItemDetailsModal, type ItemDetailsCase, type KitCandidateItem } from '@/components/inventory/item-details-modal';
import { ItemMatrixModal } from '@/components/inventory/item-matrix-modal';
import {
  saveItemDetailsAction,
  saveItemServiceAction,
} from '../actions';
import type { InventoryPayload, ItemFlag, PartRefTag } from '@/lib/inventory-shape';
import type { ItemPatch } from '@/lib/write';
import type { DashTag } from '@/lib/types-dashboard';

// item-detail-actions.tsx — the detail page's "Edit" + "Print Matrix" launchers, reusing the SHARED
// ItemDetailsModal (the full tracking/SKU/distribution/units/tags/flags/service/repair/kit-BOM editor)
// and the ItemMatrixModal — so the deep-link detail surface edits identically to the inventory list.

export function ItemDetailActions({
  item,
  cases,
  tagById,
  allTags,
  kitCandidates,
  matrixSvg,
  code,
  actorName,
  canEdit,
}: {
  item: InventoryPayload;
  cases: ItemDetailsCase[];
  tagById?: Map<string, DashTag>;
  allTags: PartRefTag[];
  kitCandidates: KitCandidateItem[];
  matrixSvg: string;
  code: string;
  actorName?: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);

  async function onSave(patch: ItemPatch) {
    const res = await saveItemDetailsAction(item.id || '', patch);
    if (res.ok) router.refresh();
    return res;
  }
  async function onServiceChange(patch: { status: 'out_of_service' | null; flags: ItemFlag[] }) {
    const res = await saveItemServiceAction(item.id || '', patch);
    if (res.ok) router.refresh();
    return res;
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => setMatrixOpen(true)}>
        <QrCode size={14} aria-hidden />
        Print Matrix
      </Button>
      {canEdit ? (
        <Button size="sm" onClick={() => setEditOpen(true)}>
          <Settings2 size={14} aria-hidden />
          Edit item
        </Button>
      ) : null}

      {editOpen ? (
        <ItemDetailsModal
          item={item}
          cases={cases}
          tagById={tagById}
          open
          onOpenChange={setEditOpen}
          onSave={onSave}
          onServiceChange={onServiceChange}
          actorName={actorName}
          matrixSvg={matrixSvg}
          canEdit={canEdit}
          allInventory={kitCandidates}
          allTags={allTags}
        />
      ) : null}

      <ItemMatrixModal
        itemLabel={item.name || item.sku || 'item'}
        itemSub={item.qr || item.sku || ''}
        code={code}
        matrixSvg={matrixSvg}
        open={matrixOpen}
        onOpenChange={setMatrixOpen}
      />
    </div>
  );
}

export default ItemDetailActions;
