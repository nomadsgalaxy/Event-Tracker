'use client';

import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ManifestSnapshot } from '@/lib/types/types';

// print-signoff-manifest.tsx — Print Manifest on the Sign-Off screen. Renders the MANIFEST OF RECORD
// (event.signoff.manifestSnapshot) when frozen, else a LIVE preview built server-side; both arrive as
// a `ManifestSnapshot`. Faithful to handlePrintManifest + printManifestSnapshot (index.html ~L15960):
// the printout prefers the stored snapshot and a banner makes a preview clear.
//
// Same mechanism as the Manifest screen's PrintManifest: an off-screen #eit-signoff-print block + a
// scoped @media print rule reveals only it. 'use client' is only for the onClick (window.print).

// Two print surfaces can be mounted (the live/preview block in the detail + the just-shipped snapshot
// after a Ship Kit commit). They use DISTINCT ids so the print CSS reveals exactly one — and the
// just-shipped block always WINS (its rule comes last + hides the detail block when present), so the
// printout is the frozen manifest of record, never a stray second copy.
// The reveal logic is id-based (the just-shipped block wins); the VISUAL styling is shared via the
// .eit-mdoc class so this manifest of record matches the Manifest screen's printout (and the Python
// renderManifestSnapshotHtml) exactly — black case-header bars, #f3f3f3 column headers, the green
// sign-off column, the signature block + footer. US Letter, full-page.
const PRINT_CSS = `
@media screen { #eit-signoff-print, #eit-signoff-shipped { display: none; } }
@media print {
  /* When the just-shipped block is present, IT owns the page; otherwise the detail block does. */
  body:has(#eit-signoff-shipped) * { visibility: hidden; }
  body:has(#eit-signoff-shipped) #eit-signoff-shipped,
  body:has(#eit-signoff-shipped) #eit-signoff-shipped * { visibility: visible; }
  body:has(#eit-signoff-shipped) #eit-signoff-print { display: none !important; }
  body:not(:has(#eit-signoff-shipped)) * { visibility: hidden; }
  body:not(:has(#eit-signoff-shipped)) #eit-signoff-print,
  body:not(:has(#eit-signoff-shipped)) #eit-signoff-print * { visibility: visible; }
  #eit-signoff-print, #eit-signoff-shipped {
    position: absolute; left: 0; top: 0; width: 100%;
    color: #111; background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .eit-mdoc .eyebrow { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #888; font-weight: 700; }
  .eit-mdoc h1 { font-weight: 700; font-size: 26px; line-height: 1.25; margin: 8px 0 10px; color: #111; }
  .eit-mdoc .meta { font-size: 13px; color: #444; margin-bottom: 18px; line-height: 1.4; }
  .eit-mdoc .meta strong { color: #111; }
  .eit-mdoc .preview-banner { background: #fff5e6; border: 1px solid #f5b73d; color: #7a4a00; font-size: 11px; padding: 8px 12px; border-radius: 3px; margin-bottom: 14px; }
  .eit-mdoc .ship-card { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 18px; font-size: 11px; border: 1px solid #ccc; border-radius: 4px; padding: 12px 14px; margin: 0 0 18px; background: #fafafa; }
  .eit-mdoc .ship-card .lbl { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: #777; font-weight: 700; margin-bottom: 2px; }
  .eit-mdoc .ship-card .val { font-size: 12px; color: #111; font-weight: 600; word-break: break-word; }
  .eit-mdoc .case-block { margin-bottom: 16px; break-inside: avoid; }
  .eit-mdoc .case-head { display: flex; justify-content: space-between; align-items: center; font-size: 11px; background: #111; color: #fff; padding: 7px 12px; border-radius: 3px 3px 0 0; }
  .eit-mdoc .case-head .name { font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .eit-mdoc .case-head .count { font-size: 10px; opacity: .8; }
  .eit-mdoc table { width: 100%; border-collapse: collapse; font-size: 11px; border: 1px solid #ccc; border-top: none; }
  .eit-mdoc th, .eit-mdoc td { padding: 5px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid #e5e5e5; }
  .eit-mdoc th { background: #f3f3f3; font-size: 9px; letter-spacing: .06em; text-transform: uppercase; color: #444; font-weight: 700; border-bottom: 1px solid #ccc; }
  .eit-mdoc td.qty, .eit-mdoc th.qty { text-align: right; width: 48px; }
  .eit-mdoc td.state, .eit-mdoc th.state { text-transform: uppercase; font-size: 9px; letter-spacing: .05em; color: #555; width: 80px; }
  .eit-mdoc td.signed { font-size: 10px; color: #0a7d3b; width: 130px; }
  .eit-mdoc td.sku { font-family: ui-monospace, Consolas, monospace; font-size: 10px; color: #555; width: 120px; }
  .eit-mdoc .serials { display: block; font-family: ui-monospace, Consolas, monospace; font-size: 9.5px; color: #666; margin-top: 2px; }
  .eit-mdoc .signature-block { margin-top: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 28px; break-inside: avoid; }
  .eit-mdoc .sig { border-top: 1px solid #777; padding-top: 6px; font-size: 11px; color: #555; }
  .eit-mdoc .footer { margin-top: 18px; padding-top: 12px; border-top: 1px solid #ccc; font-size: 10px; color: #666; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .eit-mdoc .footer .stamp { font-weight: 600; color: #111; }
  #eit-signoff-print thead, #eit-signoff-shipped thead { display: table-header-group; }
  #eit-signoff-print tr, #eit-signoff-shipped tr { break-inside: avoid; }
  @page { size: letter; margin: 14mm 12mm; }
}
`;

export function PrintSignoffButton({ hasSnapshot }: { hasSnapshot: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => window.print()}
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

export function PrintSignoffManifest({
  snapshot,
  preview,
  shipped = false,
}: {
  snapshot: ManifestSnapshot;
  preview: boolean;
  /** True for the just-shipped manifest of record block (distinct id; wins the print). */
  shipped?: boolean;
}) {
  // Group the snapshot rows by case label (loose rows fall under "Loose").
  const byCase = new Map<string, typeof snapshot.rows>();
  for (const r of snapshot.rows) {
    const key = r.caseLabel || (r.loose ? 'Loose' : '—');
    const arr = byCase.get(key) ?? [];
    arr.push(r);
    byCase.set(key, arr);
  }
  // Mount-gate the "printed at" stamp — new Date() differs between the SSR render and the client, so
  // emitting it during the INITIAL render would be a hydration mismatch. It only matters on paper, and
  // a print is always a post-mount action, so rendering it after mount is faithful + safe.
  const [printedAt, setPrintedAt] = useState('');
  useEffect(() => {
    setPrintedAt(new Date().toISOString().slice(0, 16).replace('T', ' '));
  }, []);
  // capturedAt is a server-frozen number — formatting it is deterministic (UTC ISO), no hydration risk.
  const cap = snapshot.capturedAt
    ? new Date(snapshot.capturedAt).toISOString().slice(0, 16).replace('T', ' ')
    : '';

  const titleTag = preview ? 'Manifest preview' : 'Manifest of record';
  const dateRange = snapshot.eventDates.start
    ? `${snapshot.eventDates.start}${snapshot.eventDates.end && snapshot.eventDates.end !== snapshot.eventDates.start ? ` – ${snapshot.eventDates.end}` : ''}`
    : '';
  const ship = snapshot.shipping;
  const hasShip = !!(ship.carrier || ship.tracking || ship.pickupDate);

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div id={shipped ? 'eit-signoff-shipped' : 'eit-signoff-print'} className="eit-mdoc" aria-hidden>
        {preview ? (
          <div className="preview-banner">
            Preview only — this manifest has not yet been finalized. Use Ship Kit to lock the manifest of
            record.
          </div>
        ) : null}

        {/* Header — eyebrow + title + meta (matches the Manifest screen + Python). */}
        <div className="eyebrow">{titleTag}</div>
        <h1>{snapshot.eventName || 'Event'}</h1>
        {dateRange || snapshot.venue.name || snapshot.venue.city ? (
          <div className="meta">
            {[
              dateRange ? <span key="d">{dateRange}</span> : null,
              snapshot.venue.name ? <strong key="v">{snapshot.venue.name}</strong> : null,
              snapshot.venue.city ? <span key="c">{snapshot.venue.city}</span> : null,
            ]
              .filter(Boolean)
              .map((node, i) => (
                <span key={i}>
                  {i > 0 ? ' · ' : ''}
                  {node}
                </span>
              ))}
          </div>
        ) : null}

        {/* Shipping card (4-col) — only when shipping was recorded. */}
        {hasShip ? (
          <div className="ship-card">
            <div>
              <div className="lbl">Carrier</div>
              <div className="val">{ship.carrier || '—'}</div>
            </div>
            <div>
              <div className="lbl">Tracking</div>
              <div className="val">{ship.tracking || '—'}</div>
            </div>
            <div>
              <div className="lbl">Pickup</div>
              <div className="val">{ship.pickupDate || '—'}</div>
            </div>
            <div>
              <div className="lbl">Cases</div>
              <div className="val">{snapshot.totals.cases}</div>
            </div>
          </div>
        ) : null}

        {[...byCase.entries()].map(([caseLabel, rows]) => (
          <div key={caseLabel} className="case-block">
            <div className="case-head">
              <span className="name">{caseLabel}</span>
              <span className="count">{rows.length} rows</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>SKU / Code</th>
                  <th className="qty">Qty</th>
                  <th>Serials</th>
                  <th className="state">State</th>
                  <th>Sign-off</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const serials = (r.serials || []).filter(Boolean);
                  return (
                    <tr key={`${r.itemId}-${r.caseId ?? 'loose'}-${i}`}>
                      <td>{r.itemName}</td>
                      <td className="sku">{r.sku || r.qr || '—'}</td>
                      <td className="qty">{r.qty}</td>
                      <td>{serials.length > 0 ? <span className="serials">{serials.join(', ')}</span> : null}</td>
                      <td className="state">{r.state || ''}</td>
                      <td className="signed">
                        {r.signoff
                          ? `${String(r.signoff.kind || 'ok').toUpperCase()}${r.signoff.byName ? ` · ${r.signoff.byName}` : r.signoff.byEmail ? ` · ${r.signoff.byEmail}` : ''}`
                          : r.flagsOpen > 0
                            ? '⚑ flagged'
                            : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

        {/* Release / receive signature lines. */}
        <div className="signature-block">
          <div className="sig">Released by: {snapshot.capturedBy?.name || snapshot.capturedBy?.email || '___________________'}</div>
          <div className="sig">Received by: ___________________</div>
        </div>

        <div className="footer">
          <span>
            {snapshot.totals.rows} rows · {snapshot.totals.qty} units · {snapshot.totals.cases} cases
            {snapshot.totals.looseQty > 0 ? ` · ${snapshot.totals.looseQty} loose` : ''}
          </span>
          <span className="stamp">
            {preview
              ? `Generated ${printedAt}`
              : `Captured ${cap}${snapshot.capturedBy?.name ? ` by ${snapshot.capturedBy.name}` : ''}`}
          </span>
        </div>
      </div>
    </>
  );
}

export default PrintSignoffManifest;
