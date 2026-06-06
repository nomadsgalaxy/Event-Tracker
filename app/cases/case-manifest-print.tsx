'use client';

import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { CaseManifestSnapshot } from '@/lib/case-view';

// case-manifest-print.tsx — the per-case INTERNAL manifest print (the packing list that lives inside
// the case). A faithful port of buildCaseManifestSnapshot + renderCaseManifestHtml (index.html
// ~L4566/4664): the case's own Data Matrix up top (scan to verify), an assigned-event "Going to"
// banner (or a storage banner), a verify note, and the contents table — one row per item with a
// check box, name (+ open-flag detail), SKU/code, qty, serials, and state.
//
// Same mechanism as print-manifest: an off-screen #eit-case-manifest-print block + a scoped @media
// print rule that reveals only that block (body[data-print="case-manifest"]). The case Data Matrix is
// the SAME server-encoded `eitm:…:c:<id>` SVG threaded as `matrixSvg`. Callable from card + detail.

const CASE_MANIFEST_PRINT_CSS = `
@media screen {
  #eit-case-manifest-print { display: none; }
}
@media print {
  body[data-print="case-manifest"] * { visibility: hidden; }
  body[data-print="case-manifest"] #eit-case-manifest-print,
  body[data-print="case-manifest"] #eit-case-manifest-print * { visibility: visible; }
  body[data-print="case-manifest"] #eit-case-manifest-print { display: block !important; }
  #eit-case-manifest-print {
    position: absolute; left: 0; top: 0; width: 100%;
    color: #000; background: #fff;
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  #eit-case-manifest-print table { width: 100%; border-collapse: collapse; border: 1px solid #ccc; }
  #eit-case-manifest-print th, #eit-case-manifest-print td {
    border-bottom: 1px solid #e5e5e5; padding: 5px 8px; text-align: left; vertical-align: top;
  }
  #eit-case-manifest-print th { background: #f3f3f3; font-size: 9px; letter-spacing: .06em; text-transform: uppercase; color: #444; }
  #eit-case-manifest-print thead { display: table-header-group; }
  #eit-case-manifest-print tr { break-inside: avoid; }
  #eit-case-manifest-print [role="img"] svg { display: block; width: 100%; height: 100%; }
  @page { size: letter; margin: 12mm 10mm; }
}
`;

export function CaseManifestPrintButton({
  variant = 'outline',
  label = 'Print manifest',
  showLabel = true,
}: {
  variant?: 'outline' | 'ghost' | 'default';
  label?: string;
  showLabel?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      onClick={() => {
        document.body.setAttribute('data-print', 'case-manifest');
        const restore = () => {
          document.body.removeAttribute('data-print');
          window.removeEventListener('afterprint', restore);
        };
        window.addEventListener('afterprint', restore);
        window.print();
      }}
      title="Print the internal packing list for this case"
    >
      <Printer size={14} aria-hidden />
      {showLabel ? <span className={showLabel ? '' : 'sr-only'}>{label}</span> : null}
    </Button>
  );
}

export function CaseManifestPrint({
  snapshot,
  matrixSvg,
}: {
  snapshot: CaseManifestSnapshot | null;
  matrixSvg: string;
}) {
  // The printed-at stamp is a client-only read (Date.now); mount-gate it so the INITIAL render is
  // deterministic (no SSR/hydration mismatch). Empty until mounted — the print path runs post-mount.
  const [printedAt, setPrintedAt] = useState('');
  useEffect(() => {
    setPrintedAt(new Date().toISOString().slice(0, 16).replace('T', ' '));
  }, []);

  if (!snapshot) return null;
  const ev = snapshot.assignedEvent;
  const evDates = ev
    ? ev.dates.start && ev.dates.end && ev.dates.start !== ev.dates.end
      ? `${ev.dates.start} – ${ev.dates.end}`
      : ev.dates.start || ev.dates.end || ''
    : '';
  const subBits = [
    snapshot.caseSlug,
    snapshot.caseSize ? snapshot.caseSize.toUpperCase() : '',
    snapshot.homeWarehouse ? `Home: ${snapshot.homeWarehouse}` : '',
  ].filter(Boolean);

  return (
    <>
      <style>{CASE_MANIFEST_PRINT_CSS}</style>
      <div id="eit-case-manifest-print" aria-hidden>
        {/* Head — eyebrow / title / sub + the case Data Matrix box. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 18, borderBottom: '2px solid #111', paddingBottom: 12, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', color: '#888', fontWeight: 700 }}>
              Roadcase internal manifest
            </div>
            <h1 style={{ fontWeight: 700, fontSize: 26, lineHeight: 1.2, margin: '6px 0' }}>{snapshot.caseLabel}</h1>
            {subBits.length > 0 ? <div style={{ fontSize: 12, color: '#555' }}>{subBits.join(' · ')}</div> : null}
          </div>
          <div style={{ flexShrink: 0, textAlign: 'center' }}>
            <span
              role="img"
              aria-label={`Data Matrix code for case ${snapshot.caseLabel}`}
              style={{ display: 'inline-block', width: 108, height: 108, border: '1px solid #bbb', background: '#fff', padding: 4 }}
            >
              {matrixSvg ? (
                <span style={{ display: 'block', width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: matrixSvg }} />
              ) : (
                <span style={{ fontFamily: 'monospace', fontSize: 8, wordBreak: 'break-all', color: '#999' }}>{snapshot.caseId}</span>
              )}
            </span>
            <div style={{ fontSize: 8.5, letterSpacing: '.06em', textTransform: 'uppercase', color: '#888', marginTop: 4, fontWeight: 700 }}>
              Scan to verify
            </div>
          </div>
        </div>

        {/* Going-to / storage banner. */}
        {ev ? (
          <div style={{ border: '1px solid #c98a00', background: '#fff7e6', borderLeft: '5px solid #e08e00', padding: '10px 14px', borderRadius: 4, marginBottom: 16 }}>
            <div style={{ fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: '#9a6a00', fontWeight: 700 }}>Going to</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111', marginTop: 2 }}>{ev.name || 'Event'}</div>
            <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>
              {[evDates, ev.venue.name, ev.venue.city, ev.venue.booth ? `Booth ${ev.venue.booth}` : ''].filter(Boolean).join(' · ')}
            </div>
          </div>
        ) : (
          <div style={{ border: '1px solid #ccc', background: '#f6f6f6', padding: '9px 14px', borderRadius: 4, marginBottom: 16, fontSize: 12, color: '#555' }}>
            Not currently assigned to an event — this case is in storage.
          </div>
        )}

        <div style={{ fontSize: 11, color: '#666', marginBottom: 14, lineHeight: 1.4 }}>
          Verify the physical contents of this case against the list below. If they differ, update the
          digital record (scan the case code above) so the two stay in sync.{printedAt ? ` · Printed ${printedAt}.` : ''}
        </div>

        {snapshot.rows.length === 0 ? (
          <p style={{ fontStyle: 'italic', color: '#777' }}>This case has no items recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 26 }} />
                <th>Item</th>
                <th style={{ width: 110 }}>SKU / Code</th>
                <th style={{ width: 42, textAlign: 'right' }}>Qty</th>
                <th>Serials</th>
                <th style={{ width: 74 }}>State</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.rows.map((r, i) => (
                <tr key={r.itemId || i}>
                  <td style={{ textAlign: 'center' }}>
                    <span style={{ display: 'inline-block', width: 13, height: 13, border: '1.5px solid #888', borderRadius: 2 }} />
                  </td>
                  <td>
                    {r.itemName}
                    {r.flags.length > 0 ? (
                      <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {r.flags.map((f, fi) => (
                          <div key={fi} style={{ fontSize: 10, padding: '3px 7px', borderRadius: 2, borderLeft: '3px solid #c0392b', background: '#fdecea', color: '#5a1a14' }}>
                            <span style={{ fontWeight: 700, fontSize: 9, letterSpacing: '.05em', textTransform: 'uppercase', marginRight: 6 }}>
                              {(f.severity || 'med').toUpperCase()}
                            </span>
                            {f.note || '(no description)'}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 10, color: '#555' }}>{r.sku || r.qr || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{r.qty || 0}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 9.5, color: '#666' }}>{r.serials.filter(Boolean).join(', ')}</td>
                  <td style={{ textTransform: 'uppercase', fontSize: 9, letterSpacing: '.05em', color: '#555' }}>{r.state || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export default CaseManifestPrint;
