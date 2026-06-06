'use client';

import { useState } from 'react';
import { Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CsvImportModal, type MapRowResult } from './csv-import-modal';
import { importCasesAction } from './actions';
import type { CaseCsvRow } from '@/lib/db/write';

// case-csv-import.tsx — the case-specific binding of the generic CsvImportModal: the column map for
// the catalog "roadcases" Export headers (ID · Label · Size · Zone · Kit · Weight (kg)), validation,
// the existing-id set (so a known id becomes an update-by-id), and the gated importCasesAction commit.
// Round-trips with the catalog Export CSV. #43: a multi-SKU Kit cell (space/comma-separated) is split
// into kitFor[].

// The Export headers (catalog-screen.tsx downloadCsv 'roadcases'). Only these are imported; the rest
// (Status/Assignment/Packed/Total/Flagged) are derived, never written.
const EXPECTED_HEADERS = ['ID', 'Label', 'Size', 'Zone', 'Kit', 'Weight (kg)'];

const VALID_SIZES = new Set(['small', 'medium', 'large', 'xl']);

function mapCaseRow(rec: Record<string, string>, knownIds: Set<string>): MapRowResult<CaseCsvRow> {
  const id = String(rec['ID'] ?? rec['Id'] ?? rec['id'] ?? '').trim();
  const label = String(rec['Label'] ?? '').trim();
  if (!label) return { error: 'Label is required.' };

  const sizeRaw = String(rec['Size'] ?? '').trim().toLowerCase();
  if (sizeRaw && !VALID_SIZES.has(sizeRaw)) {
    return { error: `Unknown size "${sizeRaw}" (small/medium/large/xl).` };
  }

  const weightRaw = String(rec['Weight (kg)'] ?? rec['Weight'] ?? '').trim();
  let weight: number | string = '';
  if (weightRaw) {
    const n = Number(weightRaw.replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(n) || n < 0) return { error: `Weight must be a non-negative number — got "${weightRaw}".` };
    weight = n;
  }

  // #43: a Kit cell may carry several SKUs (space- or comma-separated).
  const kitFor = String(rec['Kit'] ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const mapped: CaseCsvRow = {
    id: id || undefined,
    label,
    size: sizeRaw || 'medium',
    zone: String(rec['Zone'] ?? '').trim(),
    kitFor,
    weight,
  };
  return { mapped, isUpdate: !!id && knownIds.has(id) };
}

export function CaseCsvImportButton({ existingIds }: { existingIds: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Upload size={14} aria-hidden />
        <span className="hidden sm:inline">Import CSV</span>
      </Button>
      <CsvImportModal<CaseCsvRow>
        title="Import roadcases"
        expectedHeaders={EXPECTED_HEADERS}
        mapRow={mapCaseRow}
        existingIds={existingIds}
        open={open}
        onOpenChange={setOpen}
        onCommit={(rows) => importCasesAction(rows)}
      />
    </>
  );
}

export default CaseCsvImportButton;
