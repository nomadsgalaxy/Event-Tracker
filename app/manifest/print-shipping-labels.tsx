'use client';

import { Tag } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { EventManifest, ManifestEventListRow } from '@/lib/views/manifest-view';

// print-shipping-labels.tsx — the per-case 4″×6″ SHIPPING-LABEL print (in addition to the manifest
// print), a faithful port of the Python MatrixPrintModal 'shipping' size (index.html ~L18540): one
// 4×6 label per roadcase — the case's Data Matrix up top, a big readable case label + slug, a
// SHIP-TO block (the destination event / city / dates), and the return-to + emergency blocks when
// that data is available. Standard Dymo 4XL / Zebra ZD-series stock; a die-cut border is drawn.
//
// Same mechanism as the manifest print: an off-screen #eit-shipping-print block + a scoped @media
// print rule that hides the app and reveals only the labels, one per page (page-break-after). The
// case Data Matrix SVGs are the SAME server-built `eitm:…:c:<caseId>` codes the manifest + scan use.

// One label's return-to address (a case's home warehouse, or the HQ fallback) — optional; the block
// is omitted when not threaded. The emergency contact is the global "if found" line.
export interface ShippingLabelExtras {
  returnTo?: { name?: string; address?: string; phone?: string } | null;
  emergency?: { name?: string; phone?: string } | null;
}

const SHIPPING_PRINT_CSS = `
@media screen {
  #eit-shipping-print { display: none; }
}
@media print {
  /* Only reveal when the shipping-label print was triggered (body[data-print="shipping"]); a normal
     "Print Manifest" leaves this hidden so the two print paths never collide. */
  body[data-print="shipping"] * { visibility: hidden; }
  body[data-print="shipping"] #eit-shipping-print,
  body[data-print="shipping"] #eit-shipping-print * { visibility: visible; }
  body[data-print="shipping"] #eit-shipping-print { display: block !important; }
  #eit-shipping-print {
    position: absolute; left: 0; top: 0; width: 100%;
    color: #000; background: #fff;
  }
  #eit-shipping-print .eit-ship-label {
    box-sizing: border-box;
    width: 4in; height: 6in; padding: 0.25in;
    display: flex; flex-direction: column; align-items: center; justify-content: space-between;
    gap: 0.12in; border: 0.04in solid #000;
    page-break-after: always; break-after: page;
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  #eit-shipping-print .eit-ship-label:last-child { page-break-after: auto; }
  #eit-shipping-print .eit-ship-dm { width: 2.4in; height: 2.4in; background: #fff; }
  #eit-shipping-print .eit-ship-dm svg { display: block; width: 100%; height: 100%; }
  #eit-shipping-print .eit-ship-name { font-size: 16pt; font-weight: 700; text-align: center; line-height: 1.15; max-width: 3.4in; }
  #eit-shipping-print .eit-ship-slug { font-size: 10pt; font-family: ui-monospace, Menlo, monospace; color: #333; text-align: center; }
  #eit-shipping-print .eit-ship-block { width: 100%; border: 0.015in solid #000; border-radius: 0.04in; padding: 0.06in 0.08in; line-height: 1.2; }
  #eit-shipping-print .eit-ship-block.emergency { border: none; background: #f3f3f3; }
  #eit-shipping-print .eit-ship-block .lbl { font-size: 7pt; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #555; margin-bottom: 0.02in; }
  #eit-shipping-print .eit-ship-block .nm { font-size: 11pt; font-weight: 700; }
  #eit-shipping-print .eit-ship-block .ad { font-size: 9pt; }
  #eit-shipping-print .eit-ship-block .ph { font-size: 9pt; font-family: ui-monospace, Menlo, monospace; }
  @page { size: 4in 6in; margin: 0; }
}
`;

export function PrintShippingLabelsButton({ disabled }: { disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => {
        // Tag the document so the @media print rule targets the shipping block, then restore on
        // afterprint so a later "Print Manifest" prints the manifest block instead.
        document.body.setAttribute('data-print', 'shipping');
        const restore = () => {
          document.body.removeAttribute('data-print');
          window.removeEventListener('afterprint', restore);
        };
        window.addEventListener('afterprint', restore);
        window.print();
      }}
      title="Print a 4×6 shipping label per roadcase"
    >
      <Tag size={14} aria-hidden />
      <span className="hidden sm:inline">Print labels</span>
    </Button>
  );
}

export function PrintShippingLabels({
  manifest,
  row,
  caseSvgByCaseId,
  extrasByCaseId,
}: {
  manifest: EventManifest | null;
  row: ManifestEventListRow | null;
  caseSvgByCaseId?: Record<string, string>;
  extrasByCaseId?: Record<string, ShippingLabelExtras>;
}) {
  if (!manifest || !row || manifest.caseGroups.length === 0) return null;
  const caseSvg = caseSvgByCaseId ?? {};

  return (
    <>
      <style>{SHIPPING_PRINT_CSS}</style>
      {/* The shipping block only reveals when body[data-print="shipping"] (set by the button) so it
          never collides with the manifest print. The default print path stays the manifest. */}
      {/* Hidden on screen via @media screen; revealed only for body[data-print="shipping"] in print. */}
      <div id="eit-shipping-print" aria-hidden>
        {manifest.caseGroups.map((g) => {
          const extras = extrasByCaseId?.[g.caseId];
          const svg = caseSvg[g.caseId];
          return (
            <div key={g.caseId} className="eit-ship-label">
              {svg ? (
                <span
                  className="eit-ship-dm"
                  role="img"
                  aria-label={`Data Matrix code for case ${g.label}`}
                  // Server-built, deterministic bwip-js SVG (no user HTML).
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              ) : (
                <span className="eit-ship-dm" />
              )}
              <div className="eit-ship-name">{g.label}</div>
              {g.slug && g.slug !== g.caseId ? <div className="eit-ship-slug">{g.slug}</div> : null}
              {extras?.returnTo ? (
                <div className="eit-ship-block">
                  <div className="lbl">Return to</div>
                  <div className="nm">{extras.returnTo.name || ''}</div>
                  {extras.returnTo.address ? <div className="ad">{extras.returnTo.address}</div> : null}
                  {extras.returnTo.phone ? <div className="ph">{extras.returnTo.phone}</div> : null}
                </div>
              ) : null}
              {extras?.emergency ? (
                <div className="eit-ship-block emergency">
                  <div className="lbl">If found, contact</div>
                  <div className="nm">{extras.emergency.name || ''}</div>
                  {extras.emergency.phone ? <div className="ph">{extras.emergency.phone}</div> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

export default PrintShippingLabels;
