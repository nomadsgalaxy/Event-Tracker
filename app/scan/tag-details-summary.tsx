'use client';

import { Eyebrow } from '@/components/ui/eyebrow';
import type { NfcTagEntry } from '@/lib/nfc-decoders';

// app/scan/tag-details-summary.tsx — the domain-aware NFC tag preview card. Faithful port of
// index.html TagDetailsSummary (~L18255): gated on a non-generic category WITH parsed data, it shows
// a color swatch + brand/material heading + weight / manufactured-date / UID line. Renders nothing
// for a generic tag (just a UID, no domain data) — the caller already gates on category !== generic.

export function TagDetailsSummary({ entry }: { entry: NfcTagEntry | null }) {
  if (!entry || entry.category === 'generic' || !entry.parsed) return null;
  const p = entry.parsed;
  const weight = p.actual_netto_full_weight != null ? p.actual_netto_full_weight : p.nominal_netto_full_weight;
  const mfg = p.manufactured_date ? new Date(p.manufactured_date).toISOString().slice(0, 10) : null;
  const heading =
    (p.brand_name ? p.brand_name + ' ' : '') +
    (p.material_name || p.material_type || (entry.category === 'resin' ? 'Resin' : 'Filament'));

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-accent bg-card p-2.5" style={{ borderColor: 'var(--accent)' }}>
      <Eyebrow style={{ color: 'var(--accent)' }}>Detected from tag · {entry.format}</Eyebrow>
      <div className="flex items-center gap-2">
        {p.primary_color ? (
          <span
            className="inline-block size-3.5 rounded-[3px] border border-border align-middle"
            style={{ background: p.primary_color }}
            aria-hidden
          />
        ) : null}
        <span className="text-[13px] font-semibold text-foreground">{heading}</span>
      </div>
      <div className="font-mono text-[10px] text-muted-foreground">
        {weight ? weight + ' g' : ''}
        {weight && mfg ? ' · ' : ''}
        {mfg || ''}
        {weight || mfg ? ' · ' : ''}
        UID {entry.tagUid || '—'}
      </div>
    </div>
  );
}

export default TagDetailsSummary;
