'use client';

import { useState } from 'react';
import { Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CsvImportModal, type MapRowResult } from '@/app/cases/csv-import-modal';
import { importInventoryAction, type InventoryCsvRow } from './actions';
import { ITEM_KINDS } from '@/lib/views/inventory-shape';

// inventory-csv-import.tsx — the inventory-specific binding of the generic CsvImportModal (reuses the
// case CsvImportModal pattern). The column map for the inventory Export headers (id · name · sku · qr
// · kind · stockTotal · reorderPoint · storageNotes + the #43 skuOptions JSON), validation, the
// existing-id set (a known id is an update-by-id), and the gated importInventoryAction commit. A
// faithful port of the Python InventoryPanel importMapRow (index.html ~L19970).

const EXPECTED_HEADERS = ['id', 'name', 'sku', 'qr', 'kind', 'stockTotal', 'reorderPoint', 'storageNotes'];
const KIND_SET = new Set<string>(ITEM_KINDS);

// Parse the #43 skuOptions cell. Accepts a JSON array ([{ "sku":"X","label":"Y" }]) OR a simple
// comma/space-separated SKU list (each becomes { sku }). Mirrors the Python parseSkuOpts.
function parseSkuOpts(raw: string): { sku: string; label?: string }[] {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return parsed
        .map((o) => (typeof o === 'string' ? { sku: o } : { sku: String(o?.sku ?? '').trim(), label: String(o?.label ?? '').trim() }))
        .filter((o) => o.sku);
    }
  } catch {
    /* not JSON — fall through to the simple split */
  }
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((sku) => ({ sku }));
}

function numOrNull(raw: string): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

function mapInventoryRow(rec: Record<string, string>, knownIds: Set<string>): MapRowResult<InventoryCsvRow> {
  const id = String(rec['id'] ?? rec['ID'] ?? rec['Id'] ?? '').trim();
  const name = String(rec['name'] ?? rec['Name'] ?? '').trim();
  if (!name) return { error: 'Name is required.' };

  const kindRaw = String(rec['kind'] ?? rec['Kind'] ?? '').trim().toLowerCase();
  if (kindRaw && !KIND_SET.has(kindRaw)) {
    return { error: `Unknown kind "${kindRaw}".` };
  }

  const mapped: InventoryCsvRow = {
    id: id || undefined,
    name,
    sku: String(rec['sku'] ?? rec['SKU'] ?? '').trim(),
    qr: String(rec['qr'] ?? rec['QR'] ?? rec['Matrix'] ?? '').trim(),
    kind: kindRaw || 'peripheral',
    stockTotal: numOrNull(rec['stockTotal'] ?? rec['Stock'] ?? ''),
    reorderPoint: numOrNull(rec['reorderPoint'] ?? ''),
    storageNotes: String(rec['storageNotes'] ?? '').trim(),
    skuOptions: parseSkuOpts(rec['skuOptions'] ?? ''),
  };
  return { mapped, isUpdate: !!id && knownIds.has(id) };
}

export function InventoryCsvImportButton({ existingIds }: { existingIds: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Upload size={14} aria-hidden />
        <span className="hidden sm:inline">Import CSV</span>
      </Button>
      <CsvImportModal<InventoryCsvRow>
        title="Import inventory CSV"
        expectedHeaders={EXPECTED_HEADERS}
        mapRow={mapInventoryRow}
        existingIds={existingIds}
        open={open}
        onOpenChange={setOpen}
        onCommit={(rows) => importInventoryAction(rows)}
      />
    </>
  );
}

export default InventoryCsvImportButton;
