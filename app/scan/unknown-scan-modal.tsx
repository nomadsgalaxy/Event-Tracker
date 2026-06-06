'use client';

import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Eyebrow } from '@/components/ui/eyebrow';
import { cn } from '@/lib/util/utils';
import { isCodeAdopted, scanPolicy, type ScanItemLean } from '@/lib/views/scan';
import type { InventoryPayload } from '@/lib/views/inventory-shape';

// app/scan/unknown-scan-modal.tsx — the adoption flow with guard. Faithful port of index.html
// UnknownScanModal (~L17503). A scan that didn't resolve to a single exact item surfaces here with:
//   • the raw scanned text + detected format
//   • "Did you mean…?" / "Multiple exact matches" suggestion list (onPickItem)
//   • the ALREADY-LINKED guard: if the code is strictly adopted by another item, the adoption
//     options are replaced by an "open that item" card (no re-adoption)
//   • the adoption options (lead+ only, via scanPolicy.canAdopt):
//       - Set as product code on an existing item (productcode step → onAdoptAsProductCode)
//       - Attach as serial to an existing item (serial step → onAttachSerial; needs a case)
//       - Add to case as count-only (count step → onCountOnly; needs a case)
//       - Create new item with this code (onCreateNew; needs a case)
//   • the picker steps share a name/SKU/kind search; productcode filters to items WITHOUT a qr.

export interface UnknownScan {
  text: string;
  format?: string;
  suggestions: InventoryPayload[];
  multiExact: boolean;
}

type Step = null | 'serial' | 'count' | 'productcode';

export function UnknownScanModal({
  scan,
  items,
  activeCaseId,
  role,
  open,
  onOpenChange,
  onPickItem,
  onAttachSerial,
  onCountOnly,
  onAdoptAsProductCode,
  onCreateNew,
}: {
  scan: UnknownScan;
  items: ScanItemLean[];
  activeCaseId: string | null;
  role: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPickItem: (item: InventoryPayload, id: string) => void;
  onAttachSerial: (item: InventoryPayload, id: string) => void;
  onCountOnly: (item: InventoryPayload, id: string) => void;
  onAdoptAsProductCode: (item: InventoryPayload, id: string) => void;
  onCreateNew: () => void;
}) {
  const [step, setStep] = useState<Step>(null);
  const [search, setSearch] = useState('');

  const adoptInfo = useMemo(() => isCodeAdopted(items, scan.text), [items, scan.text]);
  const policy = scanPolicy(role);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    let pool = items;
    if (step === 'productcode') pool = pool.filter((x) => !x.payload.qr || String(x.payload.qr).trim() === '');
    if (!q) return pool.slice(0, 80);
    return pool
      .filter((x) => {
        const it = x.payload;
        const hay = ((it.name || '') + ' ' + (it.sku || '') + ' ' + (it.kind || it.type || '') + ' ' + (it.qr || '')).toLowerCase();
        return hay.indexOf(q) >= 0;
      })
      .slice(0, 80);
  }, [items, search, step]);

  const conflictEntry = adoptInfo.adopted ? items.find((x) => x.id === adoptInfo.by!.itemId) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setStep(null);
          setSearch('');
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="flex max-h-[80vh] flex-col gap-2.5 p-4 sm:max-w-md">
        <DialogHeader className="gap-1">
          <Eyebrow className="text-muted-foreground">Scanned</Eyebrow>
          <DialogTitle className="break-all font-mono text-[13px] font-semibold text-foreground">{scan.text}</DialogTitle>
          <DialogDescription className="font-mono text-[10px] text-muted-foreground">
            {scan.format || 'unknown'}
          </DialogDescription>
        </DialogHeader>

        {/* Did you mean? */}
        {!step && scan.suggestions && scan.suggestions.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Eyebrow className="text-muted-foreground">{scan.multiExact ? 'Multiple exact matches' : 'Did you mean…?'}</Eyebrow>
            <div className="flex max-h-[200px] flex-col gap-1 overflow-y-auto">
              {scan.suggestions.slice(0, 8).map((it) => (
                <PickButton key={it.id} item={it} onClick={() => onPickItem(it, it.id ?? '')} />
              ))}
            </div>
          </div>
        )}

        {/* Adoption guard: already linked */}
        {!step && adoptInfo.adopted && (
          <div className="rounded-lg border border-warning/60 bg-warning/5 p-2.5">
            <Eyebrow className="text-warning">Code already linked</Eyebrow>
            <p className="mt-1 text-xs text-foreground">
              This {adoptInfo.by!.kind} belongs to{' '}
              <strong>{conflictEntry ? conflictEntry.payload.name : adoptInfo.by!.itemId}</strong>.
            </p>
            <Button
              size="sm"
              className="mt-2 w-full"
              onClick={() => conflictEntry && onPickItem(conflictEntry.payload, conflictEntry.id)}
            >
              Open that item →
            </Button>
          </div>
        )}

        {/* Adoption options — only when truly unclaimed + lead+ */}
        {!step && !adoptInfo.adopted && policy.canAdopt && (
          <div className="flex flex-col gap-1.5">
            <Eyebrow className="text-muted-foreground">Adopt this code</Eyebrow>
            <Button variant="outline" className="justify-start" onClick={() => setStep('productcode')}>
              Set as product code on an existing item
            </Button>
            <Button variant="outline" className="justify-start" disabled={!activeCaseId} onClick={() => setStep('serial')}>
              Attach as serial to an existing item{!activeCaseId ? ' (open a case first)' : ''}
            </Button>
            <Button variant="outline" className="justify-start" disabled={!activeCaseId} onClick={() => setStep('count')}>
              Add to case as count-only{!activeCaseId ? ' (open a case first)' : ''}
            </Button>
            <Button variant="outline" className="justify-start" disabled={!activeCaseId} onClick={onCreateNew}>
              Create new item with this code
            </Button>
          </div>
        )}

        {/* Picker step */}
        {step && (
          <div className="flex flex-col gap-1.5">
            <Eyebrow className="text-muted-foreground">
              {step === 'serial' ? 'Pick item to attach serial' : step === 'count' ? 'Pick item to bump qty' : 'Pick item with no product code'}
            </Eyebrow>
            <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name / SKU / kind…" className="h-9" />
            <div className="flex max-h-[220px] flex-col gap-1 overflow-y-auto">
              {matches.length === 0 && <p className="p-2.5 text-center text-[11px] text-muted-foreground">No matches.</p>}
              {matches.map((x) => (
                <PickButton
                  key={x.id}
                  item={x.payload}
                  sub={(x.payload.kind || x.payload.type || '') + ' · ' + (x.payload.qr || x.payload.sku || x.id)}
                  onClick={() => {
                    if (step === 'serial') onAttachSerial(x.payload, x.id);
                    else if (step === 'count') onCountOnly(x.payload, x.id);
                    else if (step === 'productcode') onAdoptAsProductCode(x.payload, x.id);
                  }}
                />
              ))}
            </div>
            <Button
              variant="ghost"
              className="mt-1"
              onClick={() => {
                setStep(null);
                setSearch('');
              }}
            >
              ← Back
            </Button>
          </div>
        )}

        {/* Cancel (top step only — the X close is already in the dialog) */}
        {!step && (
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PickButton({ item, sub, onClick }: { item: InventoryPayload; sub?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col items-start gap-0.5 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors',
        'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
    >
      <span className="text-xs font-medium text-foreground">{item.name}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{sub ?? (item.qr || item.sku || item.id)}</span>
    </button>
  );
}

export default UnknownScanModal;
