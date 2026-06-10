'use client';

import { Printer } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import type { EventManifest, ManifestEventListRow, ManifestItemRow } from '@/lib/views/manifest-view';

// PrintManifest — the print-friendly manifest section + the Print button (DESIGN_ALIGNMENT §4.3:
// "a clean printable section + a Print button using window.print + a @media print stylesheet").
//
// The existing app opens a freshly-rendered HTML document in a new window and prints THAT
// (window.printManifestSnapshot, index.html). Here we keep the SAME page and use a print stylesheet
// instead: an off-screen `#eit-manifest-print` block holds a clean, paginated table of the manifest;
// a scoped @media print rule hides the whole app chrome and reveals only that block. Clicking Print
// calls window.print(). This needs no popup and no second render path.
//
// DATA MATRIX: the codes are encoded + rendered to SVG SERVER-SIDE (lib/data-matrix, bwip-js) and
// threaded down as the `codes` prop — each CASE label carries its OWN Data Matrix prominently (the
// case-manifest-of-record: a damaged outer label is recoverable from the manifest tucked inside),
// and each ITEM row's code column shows the item's Data Matrix bitmap (the text code stays too).
// These are the SAME `eitm:` codes the scan screen decodes (index.html ~L4740 codeCell /
// caseCodeBox). 'use client' is only for the onClick (window.print); the SVGs are static server data.

/** Server-built Data Matrix SVGs for the printable manifest, keyed by entity id. Empty string when
 *  a code couldn't be encoded — the row then prints the plain-text code only (the source's fallback). */
export interface ManifestCodes {
  /** caseId -> the case's `eitm:…:c:<caseId>` Data Matrix SVG. */
  caseSvgByCaseId: Record<string, string>;
  /** itemId -> the item's `eitm:…:i:<itemId>` Data Matrix SVG. */
  itemSvgByItemId: Record<string, string>;
  /** The event's `eitm:…:e:<eventId>` Data Matrix SVG for the header (scan-to-open). */
  eventSvg?: string;
}

// Insert a server-built (deterministic, no user HTML) Data Matrix SVG string. Styling/sizing comes
// from the parent class (.ec-box / .case-qr) per the Python manifest CSS.
function Svg({ svg }: { svg: string | undefined }) {
  if (!svg) return null;
  return <span dangerouslySetInnerHTML={{ __html: svg }} />;
}

// PrintButton — the toolbar affordance. Split out so the screen header can render just the button on
// the title row while the (bulky) printable block lives at the bottom of the main pane.
//
// SNAPSHOT-OF-RECORD seam: the Python ManifestPool prefers a FROZEN manifest snapshot captured at
// ship time (event.signoff.manifestSnapshot) when present, else a LIVE preview (index.html ~L15960).
// The sign-off wave owns the snapshot field in this stack, so today the print is always the live
// preview; `hasSnapshot` is the seam (defaults false) so the tooltip + a later snapshot-print path
// match the source the moment the field lands.
export function PrintButton({ disabled, hasSnapshot = false }: { disabled?: boolean; hasSnapshot?: boolean }) {
  // Print into a FRESH window that holds only the manifest block + MANIFEST_DOC_CSS (the approach the
  // Python app used). A self-contained document has no app sidebar / scrolling flex column / @media
  // juggling, so the manifest prints at full page width and paginates cleanly — the in-page @media
  // print path kept rendering it as a small, offset left-hand column. The block (rendered hidden by
  // <PrintManifest>) is the HTML source; its inline Data Matrix SVGs come along in outerHTML.
  function printManifest() {
    const block = document.getElementById('eit-manifest-print');
    if (!block) return;
    const title = block.querySelector('h1')?.textContent?.trim() || 'Event manifest';
    const win = window.open('', '_blank', 'width=900,height=1100');
    if (!win) {
      toast.error('Allow pop-ups for this site to print the manifest.');
      return;
    }
    win.document.open();
    win.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>' +
        title +
        '</title><style>' +
        MANIFEST_DOC_CSS +
        '</style></head><body>' +
        block.outerHTML +
        '</body></html>',
    );
    win.document.close();
    // Close the print window once the dialog is dismissed (print OR cancel) so it doesn't linger.
    win.onafterprint = () => {
      try {
        win.close();
      } catch {
        /* some browsers won't close a script window — harmless */
      }
    };
    // Inline SVGs need no network; a short tick lets the new document lay out before the dialog opens.
    const go = () => {
      try {
        win.focus();
        win.print();
      } catch {
        /* the user dismissed the window */
      }
    };
    if (win.document.readyState === 'complete') window.setTimeout(go, 200);
    else win.addEventListener('load', () => window.setTimeout(go, 200));
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={printManifest}
      title={
        hasSnapshot
          ? 'Print the manifest of record (captured at ship time)'
          : 'Print a preview of the current manifest'
      }
    >
      <Printer size={14} aria-hidden />
      <span className="hidden sm:inline">Print Manifest</span>
    </Button>
  );
}

// Self-contained stylesheet for the print WINDOW. The Print button opens a fresh window containing only
// the manifest block + this CSS, then prints THAT (the approach the Python app used). Because the
// document has no app chrome / sidebar / scrolling flex column and no @media-scope juggling, the
// manifest reliably prints at FULL page width and paginates in normal flow — the old in-page @media
// print path kept rendering it as a small, offset left-hand column. Mirrors the roadcase manifest look.
const MANIFEST_DOC_CSS = `
  html, body { margin: 0; padding: 0; background: #fff; }
  #eit-manifest-print {
    width: 100%; box-sizing: border-box;
    color: #111; background: #fff;
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  /* Head matches the roadcase manifest: eyebrow / big title on the left, the Data Matrix box on the
     right, a heavy rule underneath. */
  #eit-manifest-print .doc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 14px; }
  #eit-manifest-print .doc-head-text { min-width: 0; flex: 1; }
  #eit-manifest-print .eyebrow { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #888; font-weight: 700; }
  #eit-manifest-print h1 { font-weight: 700; font-size: 26px; line-height: 1.2; margin: 6px 0; color: #111; }
  /* Orange "Going to" banner — matches the roadcase manifest's banner (name headline, dates · city). */
  #eit-manifest-print .show-banner { border: 1px solid #c98a00; background: #fff7e6; border-left: 5px solid #e08e00; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  #eit-manifest-print .show-banner .sb-eyebrow { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: #9a6a00; font-weight: 700; }
  #eit-manifest-print .show-banner .sb-title { font-size: 16px; font-weight: 700; color: #111; margin-top: 2px; }
  #eit-manifest-print .show-banner .sb-sub { font-size: 12px; color: #555; margin-top: 2px; }
  #eit-manifest-print .event-code { flex-shrink: 0; text-align: center; }
  #eit-manifest-print .event-code .ec-box { width: 108px; height: 108px; display: inline-block; border: 1px solid #bbb; padding: 4px; background: #fff; }
  #eit-manifest-print .event-code .ec-box svg { width: 100%; height: 100%; display: block; }
  #eit-manifest-print .event-code .ec-cap { font-size: 8.5px; letter-spacing: .06em; text-transform: uppercase; color: #888; margin-top: 4px; font-weight: 700; }
  /* The verify note + the per-row packing check box mirror the roadcase manifest. */
  #eit-manifest-print .verify-note { font-size: 11px; color: #666; margin-bottom: 14px; line-height: 1.4; }
  #eit-manifest-print td.chk, #eit-manifest-print th.chk { width: 26px; text-align: center; }
  #eit-manifest-print .chk-box { display: inline-block; width: 13px; height: 13px; border: 1.5px solid #888; border-radius: 2px; }
  /* A case is free to split across a page (the thead repeats, rows don't split) so cases pack down and
     fill each sheet instead of one-per-page. */
  #eit-manifest-print .case-block { margin-bottom: 18px; }
  /* Clean case section header (no heavy black bar): bold name + count on the left, the case Data
     Matrix on the right, a rule beneath. Kept whole + glued to its table so a header never strands. */
  #eit-manifest-print .case-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; padding: 0 2px 5px; margin-top: 4px; background: transparent; color: #111; border-bottom: 1.5px solid #111; break-inside: avoid; break-after: avoid; }
  #eit-manifest-print .case-head .case-head-text { display: flex; align-items: baseline; gap: 9px; flex: 1; min-width: 0; }
  #eit-manifest-print .case-head .name { font-weight: 700; font-size: 14px; letter-spacing: .01em; color: #111; }
  #eit-manifest-print .case-head .count { font-size: 10.5px; color: #888; }
  #eit-manifest-print .case-head .case-qr { flex-shrink: 0; width: 52px; height: 52px; background: #fff; margin-left: 8px; }
  #eit-manifest-print .case-head .case-qr svg { width: 100%; height: 100%; display: block; }
  #eit-manifest-print table { width: 100%; border-collapse: collapse; font-size: 11px; border: 1px solid #ccc; border-top: none; }
  #eit-manifest-print th, #eit-manifest-print td { padding: 5px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid #e5e5e5; }
  #eit-manifest-print th { background: #f3f3f3; font-size: 9px; letter-spacing: .06em; text-transform: uppercase; color: #444; font-weight: 700; border-bottom: 1px solid #ccc; }
  #eit-manifest-print td.qty, #eit-manifest-print th.qty { text-align: right; width: 48px; }
  #eit-manifest-print td.state, #eit-manifest-print th.state { text-transform: uppercase; font-size: 9px; letter-spacing: .05em; color: #555; width: 80px; }
  #eit-manifest-print td.sku { font-family: ui-monospace, Consolas, monospace; font-size: 10px; color: #555; width: 120px; }
  #eit-manifest-print .serials { display: block; font-family: ui-monospace, Consolas, monospace; font-size: 9.5px; color: #666; margin-top: 2px; }
  #eit-manifest-print .signature-block { margin-top: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 28px; break-inside: avoid; }
  #eit-manifest-print .sig { border-top: 1px solid #777; padding-top: 6px; font-size: 11px; color: #555; }
  #eit-manifest-print .footer { margin-top: 18px; padding-top: 12px; border-top: 1px solid #ccc; font-size: 10px; color: #666; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; break-inside: avoid; }
  #eit-manifest-print .footer .stamp { font-weight: 600; color: #111; }
  #eit-manifest-print thead { display: table-header-group; }
  #eit-manifest-print tr { break-inside: avoid; }
  /* US Letter (8.5×11). Margins match the roadcase manifest. */
  @page { size: letter; margin: 12mm 10mm; }
`;

// In the HOST page the block is ONLY the HTML source for the print window — keep it hidden everywhere
// (screen and any direct Ctrl+P of the app page). The print window writes its own MANIFEST_DOC_CSS.
const PRINT_CSS = `#eit-manifest-print { display: none !important; }`;

// One table per case (or the loose group), matching the roadcase manifest's columns exactly:
// check box · Item · SKU / Code · Qty · Serials · State. A flagged row reads "FLAGGED" in the State
// column (RowState carries it), so no separate sign-off column is needed.
function ManifestTable({ rows }: { rows: ManifestItemRow[] }) {
  if (rows.length === 0) return <div style={{ fontSize: 10, fontStyle: 'italic', color: '#777' }}>No items.</div>;
  return (
    <table>
      <thead>
        <tr>
          <th className="chk" />
          <th>Item</th>
          <th>SKU / Code</th>
          <th className="qty">Qty</th>
          <th>Serials</th>
          <th className="state">State</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="chk"><span className="chk-box" /></td>
            <td>{r.name}</td>
            <td className="sku">{r.sku || r.qr || '—'}</td>
            <td className="qty">{r.qty}</td>
            <td>{r.serials.length > 0 ? <span className="serials">{r.serials.join(', ')}</span> : null}</td>
            <td className="state">{r.state}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PrintManifest({
  manifest,
  row,
  codes,
}: {
  manifest: EventManifest | null;
  row: ManifestEventListRow | null;
  codes?: ManifestCodes;
}) {
  if (!manifest || !row) return null;
  const { caseGroups, kitSections, looseGroup, totals } = manifest;
  const printedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const caseSvg = codes?.caseSvgByCaseId ?? {};
  const eventSvg = codes?.eventSvg ?? '';
  const rowCount =
    caseGroups.reduce((n, g) => n + g.rows.length, 0) + (looseGroup?.rows.length ?? 0);
  // Orange "Going to" banner — IDENTICAL in form to the roadcase manifest's banner: the show NAME is
  // the headline, with the dates + location (city) beneath. The name also titles the document, but we
  // lead with it here so the event banner reads the same as the per-case one. The lead still appears in
  // the "Released by" line below.
  const bannerSub = [row.dates, row.city].filter(Boolean).join(' · ');

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div id="eit-manifest-print" aria-hidden>
        {/* Header: eyebrow + title on the left, the event Data Matrix on the right, a heavy rule under. */}
        <div className="doc-head">
          <div className="doc-head-text">
            <div className="eyebrow">Event manifest</div>
            <h1>{row.name || 'Event'}</h1>
          </div>
          {eventSvg ? (
            <div className="event-code">
              <span className="ec-box">
                <Svg svg={eventSvg} />
              </span>
              <div className="ec-cap">Event · scan to open</div>
            </div>
          ) : null}
        </div>

        {/* Orange "Going to" banner — matches the roadcase manifest's banner exactly (name headline). */}
        <div className="show-banner">
          <div className="sb-eyebrow">Going to</div>
          <div className="sb-title">{row.name || 'Event'}</div>
          {bannerSub ? <div className="sb-sub">{bannerSub}</div> : null}
        </div>

        {/* Verify note — mirrors the roadcase manifest's instruction line. */}
        <div className="verify-note">
          Check each case&apos;s physical contents against the lists below. If they differ, update the
          digital record (scan the case or event code) so the two stay in sync.
        </div>

        {(() => {
          const caseBlock = (g: (typeof caseGroups)[number]) => (
            <div key={g.caseId} className="case-block">
              <div className="case-head">
                <span className="case-head-text">
                  <span className="name">{g.label}</span>
                  <span className="count">{g.rows.length} {g.rows.length === 1 ? 'item' : 'items'}</span>
                </span>
                {caseSvg[g.caseId] ? (
                  <span className="case-qr">
                    <Svg svg={caseSvg[g.caseId]} />
                  </span>
                ) : null}
              </div>
              <ManifestTable rows={g.rows} />
            </div>
          );
          // Group by assigned Road Kit when present; else flat (matches the on-screen manifest).
          if (kitSections.length > 0) {
            return kitSections.map((sec) => (
              <div key={sec.kitId ?? '__other__'}>
                <div
                  style={{
                    margin: '16px 0 6px',
                    fontWeight: 700,
                    fontSize: '11px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    borderBottom: '2px solid #000',
                    paddingBottom: '2px',
                  }}
                >
                  {sec.name} · {sec.caseGroups.length} {sec.caseGroups.length === 1 ? 'case' : 'cases'}
                </div>
                {sec.caseGroups.map(caseBlock)}
              </div>
            ));
          }
          return caseGroups.map(caseBlock);
        })()}

        {looseGroup && looseGroup.rows.length > 0 ? (
          <div className="case-block">
            <div className="case-head">
              <span className="case-head-text">
                <span className="name">Loose inventory</span>
                <span className="count">{looseGroup.rows.length} {looseGroup.rows.length === 1 ? 'item' : 'items'}</span>
              </span>
            </div>
            <ManifestTable rows={looseGroup.rows} />
          </div>
        ) : null}

        {caseGroups.length === 0 && (!looseGroup || looseGroup.rows.length === 0) ? (
          <p style={{ fontStyle: 'italic', color: '#777' }}>No items recorded on this manifest.</p>
        ) : null}

        {/* Sign-off lines — released / received. */}
        <div className="signature-block">
          <div className="sig">Released by: {row.lead || '___________________'}</div>
          <div className="sig">Received by: ___________________</div>
        </div>

        <div className="footer">
          <span>
            {rowCount} rows · {totals.total} units · {row.caseCount} cases
            {row.looseTotal > 0 ? ` · ${row.looseTotal} loose` : ''}
          </span>
          <span className="stamp">Generated {printedAt}</span>
        </div>
      </div>
    </>
  );
}

export default PrintManifest;
