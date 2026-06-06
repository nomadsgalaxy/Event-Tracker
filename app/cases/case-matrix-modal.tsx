'use client';

import { useEffect, useState } from 'react';
import { Printer, QrCode } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// case-matrix-modal.tsx — the CaseMatrixModal / MatrixPrintModal port (the case-label print path). A
// faithful port of index.html MatrixPrintModal kind:'case' (~L18601): a size picker — 1″ (Matrix
// only) · 2″ (Matrix + name, the catalog default) · 4×6″ (Shipping) — over the case's Data Matrix,
// with a Dymo-Connect probe (mount-gated so the navigator/window read never runs during SSR), and a
// Print button that drives window.print() against an off-screen, size-tagged print block.
//
// The Data Matrix SVG is encoded SERVER-SIDE (lib/data-matrix is server-only) and threaded in as
// `matrixSvg` (the SAME `eitm:…:c:<id>` code the scan screen decodes). The print mechanism mirrors
// print-shipping-labels: body[data-print="case-matrix"] reveals only the label, one page at the
// chosen @page size; afterprint clears the tag.

type MatrixSize = 'one' | 'two' | 'shipping';

const SIZE_OPTIONS: { k: MatrixSize; label: string; sub: string }[] = [
  { k: 'one', label: '1″', sub: 'Matrix only' },
  { k: 'two', label: '2″', sub: 'Matrix + name' },
  { k: 'shipping', label: '4×6″', sub: 'Shipping' },
];

// Print CSS — a faithful port of the Python MatrixPrintModal label system (index.html ensurePrintCSS
// `.eit-print-label` / size-one / size-two / size-shipping). The label is a CENTERED card: 1″ is the
// bare code (no border/text), 2″ is a 1px-bordered 2in card holding a 1.4in code + name (9pt) + slug
// (7pt mono), 4×6″ is the shipping card (2.4in code, 16pt name). Reveal is scoped to
// body[data-print="case-matrix"]; the chosen size drives the card class.
const MATRIX_PRINT_CSS = `
@media screen {
  #eit-case-matrix-print { display: none; }
}
@media print {
  body[data-print="case-matrix"] * { visibility: hidden; }
  body[data-print="case-matrix"] #eit-case-matrix-print,
  body[data-print="case-matrix"] #eit-case-matrix-print * { visibility: visible; }
  body[data-print="case-matrix"] #eit-case-matrix-print {
    display: flex !important; position: fixed; left: 0; top: 0; width: 100%; height: 100%;
    align-items: center; justify-content: center; margin: 0; padding: 0;
    color: #000; background: #fff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  /* 2″ card (the catalog default). */
  #eit-case-matrix-print .eit-print-label {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    width: 2in; height: 2in; gap: 0.04in; padding: 0.06in; box-sizing: border-box; border: 1px solid #000;
  }
  #eit-case-matrix-print .eit-print-label svg { width: 1.4in; height: 1.4in; display: block; }
  #eit-case-matrix-print [role="img"] { display: block; background: #fff; }
  #eit-case-matrix-print .eit-print-name {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 9pt; font-weight: 600; line-height: 1.1; text-align: center;
    max-width: 1.85in; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #eit-case-matrix-print .eit-print-slug {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 7pt; color: #444;
  }
  /* 1″ — bare code, no border or text. */
  body[data-print="case-matrix"][data-size="one"] #eit-case-matrix-print .eit-print-label {
    width: 1in; height: 1in; padding: 0; gap: 0; border: 0;
  }
  body[data-print="case-matrix"][data-size="one"] #eit-case-matrix-print .eit-print-label svg { width: 1in; height: 1in; }
  body[data-print="case-matrix"][data-size="one"] #eit-case-matrix-print .eit-print-name,
  body[data-print="case-matrix"][data-size="one"] #eit-case-matrix-print .eit-print-slug { display: none; }
  /* 4×6″ shipping card. */
  body[data-print="case-matrix"][data-size="shipping"] #eit-case-matrix-print .eit-print-label {
    width: 4in; height: 6in; padding: 0.25in; gap: 0.12in; border: 0.04in solid #000; justify-content: space-between;
  }
  body[data-print="case-matrix"][data-size="shipping"] #eit-case-matrix-print .eit-print-label svg { width: 2.4in; height: 2.4in; }
  body[data-print="case-matrix"][data-size="shipping"] #eit-case-matrix-print .eit-print-name {
    font-size: 16pt; max-width: 3.4in; white-space: normal; line-height: 1.15;
  }
  body[data-print="case-matrix"][data-size="shipping"] #eit-case-matrix-print .eit-print-slug { font-size: 10pt; max-width: 3.4in; }
  /* 4×6 return-to + if-found blocks (the case-static info), identical to the Manifest shipping label. */
  body[data-print="case-matrix"][data-size="shipping"] #eit-case-matrix-print .eit-ship-block {
    width: 100%; border: 0.015in solid #000; border-radius: 0.04in; padding: 0.06in 0.08in; line-height: 1.2;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  body[data-print="case-matrix"][data-size="shipping"] #eit-case-matrix-print .eit-ship-block.emergency { border: none; background: #f3f3f3; }
  body[data-print="case-matrix"][data-size="shipping"] #eit-case-matrix-print .eit-ship-block .lbl { font-size: 7pt; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #555; margin-bottom: 0.02in; }
  body[data-print="case-matrix"][data-size="shipping"] #eit-case-matrix-print .eit-ship-block .nm { font-size: 11pt; font-weight: 700; }
  body[data-print="case-matrix"][data-size="shipping"] #eit-case-matrix-print .eit-ship-block .ad { font-size: 9pt; }
  body[data-print="case-matrix"][data-size="shipping"] #eit-case-matrix-print .eit-ship-block .ph { font-size: 9pt; font-family: ui-monospace, Menlo, monospace; }
  @page { margin: 0; }
}
`;

export function CaseMatrixModal({
  caseLabel,
  caseSlug,
  code,
  matrixSvg,
  extras,
  open,
  onOpenChange,
}: {
  caseLabel: string;
  caseSlug?: string;
  /** The `eitm:…:c:<id>` payload (shown as the human-readable caption / fallback). */
  code: string;
  /** Server-encoded Data Matrix SVG (empty string when encoding failed → text fallback). */
  matrixSvg: string;
  /** Case-static 4×6 label extras (Return-to address + If-found contact); the blocks render only at
   *  the 4×6 size. Computed server-side via caseReturnAndContact; omitted blocks simply don't print. */
  extras?: {
    returnTo?: { name?: string; address?: string; phone?: string } | null;
    emergency?: { name?: string; phone?: string } | null;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [size, setSize] = useState<MatrixSize>('two');
  const [mounted, setMounted] = useState(false);
  // Dymo-Connect probe is mount-gated (navigator only exists on the client) so the initial SSR
  // render is deterministic — no hydration mismatch.
  const [dymo, setDymo] = useState<{ available: boolean } | null>(null);
  useEffect(() => {
    setMounted(true);
    // Probe for the Dymo Connect bridge if present; otherwise report unavailable.
    const w = window as unknown as { dymoConnect?: { detect: () => Promise<{ available: boolean }> } };
    if (!w.dymoConnect) {
      setDymo({ available: false });
      return;
    }
    let cancelled = false;
    w.dymoConnect.detect().then((r) => {
      if (!cancelled) setDymo({ available: !!r?.available });
    }).catch(() => {
      if (!cancelled) setDymo({ available: false });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function print() {
    document.body.setAttribute('data-print', 'case-matrix');
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
          <DialogTitle>Print case Matrix</DialogTitle>
          <DialogDescription>
            Print a scannable Data Matrix label for {caseLabel || 'this case'}.
          </DialogDescription>
        </DialogHeader>

        {/* Preview tile */}
        <div className="flex flex-col items-center gap-2">
          <span
            role="img"
            aria-label={`Data Matrix code for case ${caseLabel}`}
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

        {/* Dymo status (mount-gated). */}
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

        {/* Off-screen print block (revealed only when body[data-print="case-matrix"]). The size class
            on the card + the body[data-size] selectors drive the dimensions; name/slug are hidden by
            CSS at the 1″ size. */}
        <style>{MATRIX_PRINT_CSS}</style>
        <div id="eit-case-matrix-print" aria-hidden>
          <div className={cn('eit-print-label', size === 'one' && 'size-one', size === 'shipping' && 'size-shipping')}>
            <span role="img" aria-label={`Data Matrix code for case ${caseLabel}`}>
              {matrixSvg ? <span dangerouslySetInnerHTML={{ __html: matrixSvg }} /> : <span className="eit-print-slug">{code}</span>}
            </span>
            <div className="eit-print-name">{caseLabel}</div>
            <div className="eit-print-slug">{caseSlug || code}</div>
            {/* 4×6 only — the case-static Return-to + If-found blocks (hidden at 1″/2″). */}
            {size === 'shipping' && extras?.returnTo ? (
              <div className="eit-ship-block">
                <div className="lbl">Return to</div>
                <div className="nm">{extras.returnTo.name || ''}</div>
                {extras.returnTo.address ? <div className="ad">{extras.returnTo.address}</div> : null}
                {extras.returnTo.phone ? <div className="ph">{extras.returnTo.phone}</div> : null}
              </div>
            ) : null}
            {size === 'shipping' && extras?.emergency ? (
              <div className="eit-ship-block emergency">
                <div className="lbl">If found, contact</div>
                <div className="nm">{extras.emergency.name || ''}</div>
                {extras.emergency.phone ? <div className="ph">{extras.emergency.phone}</div> : null}
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// A small standalone trigger (the detail's "Print Matrix" affordance).
export function PrintMatrixButton(props: Omit<Parameters<typeof CaseMatrixModal>[0], 'open' | 'onOpenChange'>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <QrCode size={14} aria-hidden />
        Print Matrix
      </Button>
      <CaseMatrixModal {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}

export default CaseMatrixModal;
