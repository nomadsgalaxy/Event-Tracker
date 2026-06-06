'use client';

import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/util/utils';

// components/inventory/item-matrix-modal.tsx — the ItemMatrixModal (the item Data-Matrix label print).
// A faithful port of index.html MatrixPrintModal kind:'item' (~L18601/18837): a size picker — 1″
// (Matrix only) · 2″ (Matrix + name) · 4×6″ (Shipping) — over the item's `eitm:…:i:<id>` Data Matrix,
// with a Print button that drives window.print() against an off-screen, size-tagged print block. This
// mirrors the case-matrix-modal pattern exactly, retargeted to item codes.
//
// The Data Matrix SVG is encoded SERVER-SIDE (lib/data-matrix is server-only) and threaded in as
// `matrixSvg` (the SAME `eitm:…:i:<id>` code the scan screen decodes). Mount-gated Dymo probe so the
// navigator/window read never runs during SSR (no hydration mismatch). The print mechanism scopes the
// reveal to body[data-print="item-matrix"].

type MatrixSize = 'one' | 'two' | 'shipping';

const SIZE_OPTIONS: { k: MatrixSize; label: string; sub: string }[] = [
  { k: 'one', label: '1″', sub: 'Matrix only' },
  { k: 'two', label: '2″', sub: 'Matrix + name' },
  { k: 'shipping', label: '4×6″', sub: 'Shipping' },
];

// Print CSS — faithful port of the Python MatrixPrintModal `.eit-print-label` system (see
// case-matrix-modal for the shared spec): 1″ bare code, 2″ bordered card (1.4in code + 9pt name +
// 7pt slug), 4×6″ shipping card (2.4in code + 16pt name). Reveal scoped to body[data-print="item-matrix"].
const MATRIX_PRINT_CSS = `
@media screen {
  #eit-item-matrix-print { display: none; }
}
@media print {
  body[data-print="item-matrix"] * { visibility: hidden; }
  body[data-print="item-matrix"] #eit-item-matrix-print,
  body[data-print="item-matrix"] #eit-item-matrix-print * { visibility: visible; }
  body[data-print="item-matrix"] #eit-item-matrix-print {
    display: flex !important; position: fixed; left: 0; top: 0; width: 100%; height: 100%;
    align-items: center; justify-content: center; margin: 0; padding: 0;
    color: #000; background: #fff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  #eit-item-matrix-print .eit-print-label {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    width: 2in; height: 2in; gap: 0.04in; padding: 0.06in; box-sizing: border-box; border: 1px solid #000;
  }
  #eit-item-matrix-print .eit-print-label svg { width: 1.4in; height: 1.4in; display: block; }
  #eit-item-matrix-print [role="img"] { display: block; background: #fff; }
  #eit-item-matrix-print .eit-print-name {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 9pt; font-weight: 600; line-height: 1.1; text-align: center;
    max-width: 1.85in; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #eit-item-matrix-print .eit-print-slug {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 7pt; color: #444;
  }
  body[data-print="item-matrix"][data-size="one"] #eit-item-matrix-print .eit-print-label {
    width: 1in; height: 1in; padding: 0; gap: 0; border: 0;
  }
  body[data-print="item-matrix"][data-size="one"] #eit-item-matrix-print .eit-print-label svg { width: 1in; height: 1in; }
  body[data-print="item-matrix"][data-size="one"] #eit-item-matrix-print .eit-print-name,
  body[data-print="item-matrix"][data-size="one"] #eit-item-matrix-print .eit-print-slug { display: none; }
  body[data-print="item-matrix"][data-size="shipping"] #eit-item-matrix-print .eit-print-label {
    width: 4in; height: 6in; padding: 0.25in; gap: 0.12in; border: 0.04in solid #000; justify-content: space-between;
  }
  body[data-print="item-matrix"][data-size="shipping"] #eit-item-matrix-print .eit-print-label svg { width: 2.4in; height: 2.4in; }
  body[data-print="item-matrix"][data-size="shipping"] #eit-item-matrix-print .eit-print-name {
    font-size: 16pt; max-width: 3.4in; white-space: normal; line-height: 1.15;
  }
  body[data-print="item-matrix"][data-size="shipping"] #eit-item-matrix-print .eit-print-slug { font-size: 10pt; max-width: 3.4in; }
  @page { margin: 0; }
}
`;

export function ItemMatrixModal({
  itemLabel,
  itemSub,
  code,
  matrixSvg,
  open,
  onOpenChange,
}: {
  itemLabel: string;
  /** SKU / Matrix value shown under the name at the shipping size. */
  itemSub?: string;
  /** The `eitm:…:i:<id>` payload (shown as the human-readable caption / fallback). */
  code: string;
  /** Server-encoded Data Matrix SVG (empty string when encoding failed → text fallback). */
  matrixSvg: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [size, setSize] = useState<MatrixSize>('two');
  const [mounted, setMounted] = useState(false);
  const [dymo, setDymo] = useState<{ available: boolean } | null>(null);
  useEffect(() => {
    setMounted(true);
    const w = window as unknown as { dymoConnect?: { detect: () => Promise<{ available: boolean }> } };
    if (!w.dymoConnect) {
      setDymo({ available: false });
      return;
    }
    let cancelled = false;
    w.dymoConnect
      .detect()
      .then((r) => {
        if (!cancelled) setDymo({ available: !!r?.available });
      })
      .catch(() => {
        if (!cancelled) setDymo({ available: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function print() {
    document.body.setAttribute('data-print', 'item-matrix');
    document.body.setAttribute('data-size', size);
    const restore = () => {
      document.body.removeAttribute('data-print');
      document.body.removeAttribute('data-size');
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Print item Matrix</DialogTitle>
          <DialogDescription>
            Print a scannable Data Matrix label for {itemLabel || 'this item'}.
          </DialogDescription>
        </DialogHeader>

        {/* Preview tile */}
        <div className="flex flex-col items-center gap-2">
          <span
            role="img"
            aria-label={`Data Matrix code for item ${itemLabel}`}
            className="grid size-28 place-items-center rounded-md bg-white p-1"
          >
            {matrixSvg ? (
              <span className="block size-full" dangerouslySetInnerHTML={{ __html: matrixSvg }} />
            ) : (
              <span className="px-1 font-mono text-[8px] break-all text-black">{code}</span>
            )}
          </span>
          <p className="font-mono text-[10px] break-all text-muted-foreground">{code}</p>
        </div>

        {/* Size picker */}
        <div className="grid grid-cols-3 gap-2">
          {SIZE_OPTIONS.map((o) => (
            <button
              key={o.k}
              type="button"
              onClick={() => setSize(o.k)}
              aria-pressed={size === o.k}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded-md border p-2 text-center transition-colors',
                size === o.k
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:border-primary/40'
              )}
            >
              <span className="text-sm font-semibold">{o.label}</span>
              <span className="text-[10px]">{o.sub}</span>
            </button>
          ))}
        </div>

        {mounted && dymo ? (
          <p className="text-xs text-muted-foreground">
            {dymo.available
              ? 'Dymo Connect detected — printing uses your browser print dialog.'
              : 'No Dymo Connect bridge — prints via the browser print dialog at the chosen page size.'}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={print}>
            <Printer size={14} aria-hidden />
            Print
          </Button>
        </DialogFooter>

        {/* Off-screen print block (revealed only when body[data-print="item-matrix"]). Size class +
            body[data-size] drive dimensions; name/slug hidden by CSS at 1″. */}
        <style>{MATRIX_PRINT_CSS}</style>
        <div id="eit-item-matrix-print" aria-hidden>
          <div className={cn('eit-print-label', size === 'one' && 'size-one', size === 'shipping' && 'size-shipping')}>
            <span role="img" aria-label={`Data Matrix code for item ${itemLabel}`}>
              {matrixSvg ? <span dangerouslySetInnerHTML={{ __html: matrixSvg }} /> : <span className="eit-print-slug">{code}</span>}
            </span>
            <div className="eit-print-name">{itemLabel}</div>
            <div className="eit-print-slug">{itemSub || code}</div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ItemMatrixModal;
