import type { ParsedTag } from '@/lib/integrations/nfc-decoders';

// components/inventory/parsed-tag-view.tsx — the shared read-only render of a decoded filament/resin
// tag (OpenPrintTag/OpenSpool). Used by the consumable NFC panel (in-app) AND the public /t viewer
// (any phone that taps a written tag). One renderer so a tag reads the same everywhere.

export function tagHeading(p: ParsedTag | null | undefined, category?: string): string {
  if (!p) return category === 'resin' ? 'Resin' : 'Filament';
  return (
    (p.brand_name ? p.brand_name + ' ' : '') +
    (p.material_name || p.material_type || (p.material_class === 'SLA' ? 'Resin' : 'Filament'))
  ).trim();
}

const fmtDate = (ms?: number | string | null): string | null => {
  if (ms == null || ms === '') return null;
  const d = new Date(typeof ms === 'string' ? ms : Number(ms));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex flex-col">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground">{value}</span>
    </div>
  );
}

export function ParsedTagFields({ p }: { p: ParsedTag }) {
  const weight = p.actual_netto_full_weight != null ? p.actual_netto_full_weight : p.nominal_netto_full_weight;
  const color = p.primary_color;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      <Field label="Material" value={p.material_type} />
      <Field label="Class" value={p.material_class} />
      {color ? (
        <div className="flex flex-col">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Color</span>
          <span className="flex items-center gap-1.5 text-xs text-foreground">
            <span className="inline-block size-3 rounded-[3px] border border-border" style={{ background: color }} aria-hidden />
            {color}
          </span>
        </div>
      ) : null}
      <Field label="Net weight" value={weight != null ? `${weight} g` : null} />
      <Field label="Remaining" value={p.remaining_weight != null ? `${p.remaining_weight} g` : null} />
      <Field label="Diameter" value={p.filament_diameter != null ? `${p.filament_diameter} mm` : null} />
      <Field
        label="Nozzle"
        value={p.min_print_temperature != null || p.max_print_temperature != null ? `${p.min_print_temperature ?? '?'}–${p.max_print_temperature ?? '?'} °C` : null}
      />
      <Field
        label="Bed"
        value={p.min_bed_temperature != null || p.max_bed_temperature != null ? `${p.min_bed_temperature ?? '?'}–${p.max_bed_temperature ?? '?'} °C` : null}
      />
      <Field label="Density" value={p.density != null ? `${p.density} g/cm³` : null} />
      <Field label="Manufactured" value={fmtDate(p.manufactured_date)} />
      <Field label="Expires" value={fmtDate(p.expiration_date)} />
      <Field label="Storage" value={p.storage_location} />
    </div>
  );
}

/** A self-contained card: heading (color swatch + brand/material), the fields grid, and an optional
 *  format/UID footer. Used in-app and on the public viewer. */
export function ParsedTagView({
  parsed,
  category,
  format,
  uid,
}: {
  parsed: ParsedTag;
  category?: string;
  format?: string;
  uid?: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-accent bg-card p-3" style={{ borderColor: 'var(--accent)' }}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          {parsed.primary_color ? (
            <span className="inline-block size-3.5 rounded-[3px] border border-border" style={{ background: parsed.primary_color }} aria-hidden />
          ) : null}
          {tagHeading(parsed, category)}
        </span>
        {format ? <span className="font-mono text-[10px] text-muted-foreground">{format}</span> : null}
      </div>
      <ParsedTagFields p={parsed} />
      {uid ? (
        <div className="border-t border-border pt-2 font-mono text-[10px] text-muted-foreground">UID {uid}</div>
      ) : null}
    </div>
  );
}
