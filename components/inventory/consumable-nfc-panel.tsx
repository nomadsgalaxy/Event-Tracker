'use client';

import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Loader2, Nfc, PencilLine, RadioTower } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Eyebrow } from '@/components/ui/eyebrow';
import { useNfcReader } from '@/app/scan/use-nfc-reader';
import { tagDataAction } from '@/app/scan/actions';
import { encodeOpenPrintTag, encodeOpenSpool, type TagEncodeInput } from '@/lib/integrations/nfc-encoders';
import type { NfcTagEntry, ParsedTag } from '@/lib/integrations/nfc-decoders';
import type { InventoryPayload, ItemTagData } from '@/lib/views/inventory-shape';

// components/inventory/consumable-nfc-panel.tsx — the consumable NFC affordance inside ItemDetailsModal.
// Shown only for kind 'consumable'. Reads a filament/resin tag (OpenPrintTag / OpenSpool / OpenTag3D),
// binds it to this item by UID (tagDataAction), shows the decoded material data, offers to apply the
// name/weight to the catalog item, and can program a blank tag from the item's data. Web NFC is
// Chrome-on-Android only, so the read/write controls degrade gracefully elsewhere.

const MATERIAL_TYPES = [
  'PLA', 'PETG', 'TPU', 'ABS', 'ASA', 'PC', 'PCTG', 'PP', 'PA6', 'PA11', 'PA12', 'PA66', 'CPE', 'TPE',
  'HIPS', 'PHA', 'PET', 'PEI', 'PBT', 'PVB', 'PVA', 'PEKK', 'PEEK', 'BVOH', 'TPC', 'PPS', 'PPSU', 'PVC',
  'PEBA', 'PVDF', 'PPA', 'PCL', 'PES', 'PMMA', 'POM', 'PPE', 'PS', 'PSU', 'TPI', 'SBS', 'OBC', 'EVA',
];

function headingOf(p: ParsedTag | null | undefined, category?: string): string {
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

// One labelled value in the decoded-fields grid.
function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex flex-col">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground">{value}</span>
    </div>
  );
}

function ParsedFields({ p, color }: { p: ParsedTag; color?: string | null }) {
  const weight =
    p.actual_netto_full_weight != null ? p.actual_netto_full_weight : p.nominal_netto_full_weight;
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

export function ConsumableNfcPanel({
  item,
  canEdit,
  onApplyToForm,
}: {
  item: InventoryPayload;
  canEdit: boolean;
  onApplyToForm?: (patch: { name?: string; weight?: string }) => void;
}) {
  const itemId = item.id || '';
  const [lastEntry, setLastEntry] = useState<NfcTagEntry | null>(null);
  const [savingPending, startSaving] = useTransition();
  const [showWriter, setShowWriter] = useState(false);

  const boundTags = useMemo<ItemTagData[]>(
    () => (item.tagData ? Object.values(item.tagData) : []).sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0)),
    [item.tagData]
  );

  const handleTag = (entry: NfcTagEntry) => {
    setLastEntry(entry);
    nfc.stop();
    // Bind the physical tag to this item by UID (server enforces scan.pack / authorized+).
    if (itemId) {
      startSaving(async () => {
        const res = await tagDataAction({
          itemId,
          entry: {
            tagUid: entry.tagUid,
            format: entry.format,
            category: entry.category,
            parsed: (entry.parsed as Record<string, unknown> | null) ?? null,
            raw: entry.raw,
            lastReadAt: entry.lastReadAt,
          },
        });
        if (res.error && !res.ok) toast.error(res.error);
        else toast.success('Tag saved to this item');
      });
    }
  };

  const nfc = useNfcReader({ onTag: handleTag });

  const startRead = () => {
    setShowWriter(false);
    void nfc.start();
  };

  const applyToForm = () => {
    const p = lastEntry?.parsed;
    if (!p || !onApplyToForm) return;
    const patch: { name?: string; weight?: string } = {};
    const heading = headingOf(p, lastEntry?.category);
    if (heading) patch.name = heading;
    // nominal net weight is grams of material; the item's "weight ea." is in kg.
    const grams = p.nominal_netto_full_weight ?? p.actual_netto_full_weight;
    if (grams != null) patch.weight = String(grams / 1000);
    onApplyToForm(patch);
    toast.success('Applied to the form — Save to keep it');
  };

  const lastParsed = lastEntry?.parsed || null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Nfc size={14} className="text-primary" aria-hidden />
          <Eyebrow>Consumable NFC tag</Eyebrow>
        </div>
        <div className="flex gap-1.5">
          {nfc.supported ? (
            <Button type="button" variant="outline" size="sm" onClick={startRead} disabled={nfc.active || savingPending}>
              {nfc.active ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RadioTower size={13} aria-hidden />}
              {nfc.active ? 'Tap a tag…' : 'Read tag'}
            </Button>
          ) : null}
          {nfc.supported && canEdit ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => { nfc.stop(); setShowWriter((v) => !v); }}>
              <PencilLine size={13} aria-hidden /> Write tag
            </Button>
          ) : null}
        </div>
      </div>

      {!nfc.supported ? (
        <p className="text-xs italic text-muted-foreground">
          Reading and writing NFC tags needs Chrome on Android (Web NFC). Bound tags still show here on any device.
        </p>
      ) : null}
      {nfc.active ? (
        <p className="text-xs text-muted-foreground">Hold the spool&apos;s tag to the back of your phone…</p>
      ) : null}
      {nfc.error && nfc.error !== 'nfc-unsupported' ? (
        <p className="text-xs text-warning">
          {nfc.error === 'permission-denied' ? 'NFC permission was denied — allow it and try again.' : `NFC error: ${nfc.error}`}
        </p>
      ) : null}

      {/* Just-read tag */}
      {lastParsed ? (
        <div className="flex flex-col gap-2 rounded-md border border-accent bg-card p-2.5" style={{ borderColor: 'var(--accent)' }}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-foreground">{headingOf(lastParsed, lastEntry?.category)}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{lastEntry?.format}</span>
          </div>
          <ParsedFields p={lastParsed} color={lastParsed.primary_color} />
          <div className="mt-0.5 flex items-center justify-between gap-2 border-t border-border pt-2">
            <span className="font-mono text-[10px] text-muted-foreground">UID {lastEntry?.tagUid || '—'}</span>
            {canEdit && onApplyToForm ? (
              <Button type="button" variant="outline" size="sm" onClick={applyToForm}>
                Apply name + weight to item
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Already-bound tags (persisted on the item) */}
      {boundTags.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            Bound tags · {boundTags.length}
          </span>
          {boundTags.map((t) => (
            <div key={t.tagUid} className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
              <span className="flex items-center gap-1.5 truncate text-xs text-foreground">
                {t.parsed?.primary_color ? (
                  <span className="inline-block size-3 rounded-[3px] border border-border" style={{ background: t.parsed.primary_color }} aria-hidden />
                ) : null}
                {headingOf(t.parsed, t.category)}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{t.tagUid}</span>
            </div>
          ))}
        </div>
      ) : null}

      {showWriter ? <TagWriter item={item} seed={lastParsed} writeTag={nfc.writeTag} /> : null}
    </div>
  );
}

// ── Tag writer — compose material data and program a blank tag ────────────────────────────────────
function TagWriter({
  item,
  seed,
  writeTag,
}: {
  item: InventoryPayload;
  seed: ParsedTag | null;
  writeTag: (rec: { mediaType: string; data: Uint8Array }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [format, setFormat] = useState<'opt' | 'openspool'>('opt');
  const [materialClass, setMaterialClass] = useState<'FFF' | 'SLA'>((seed?.material_class as 'FFF' | 'SLA') || 'FFF');
  const [materialType, setMaterialType] = useState(seed?.material_type || 'PLA');
  const [brand, setBrand] = useState(seed?.brand_name || '');
  const [materialName, setMaterialName] = useState(seed?.material_name || item.name || '');
  const [color, setColor] = useState(seed?.primary_color?.slice(0, 7) || '#000000');
  const [weight, setWeight] = useState(seed?.nominal_netto_full_weight != null ? String(seed.nominal_netto_full_weight) : '1000');
  const [minTemp, setMinTemp] = useState(seed?.min_print_temperature != null ? String(seed.min_print_temperature) : '');
  const [maxTemp, setMaxTemp] = useState(seed?.max_print_temperature != null ? String(seed.max_print_temperature) : '');
  const [confirming, setConfirming] = useState(false);
  const [writing, setWriting] = useState(false);

  const num = (s: string): number | null => (s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s));

  const doWrite = async () => {
    const input: TagEncodeInput = {
      material_class: materialClass,
      material_type: materialType.trim().toUpperCase() || null,
      material_name: materialName.trim() || null,
      brand_name: brand.trim() || null,
      primary_color: color,
      nominal_netto_full_weight: num(weight),
      min_print_temperature: num(minTemp),
      max_print_temperature: num(maxTemp),
    };
    const enc = format === 'openspool' ? encodeOpenSpool(input) : encodeOpenPrintTag(input);
    setWriting(true);
    const res = await writeTag({ mediaType: enc.mediaType, data: enc.data });
    setWriting(false);
    setConfirming(false);
    if (res.ok) toast.success('Tag written');
    else if (res.error === 'permission-denied') toast.error('NFC permission denied');
    else toast.error(res.error === 'nfc-unsupported' ? 'NFC writing needs Chrome on Android' : `Write failed: ${res.error || 'unknown'}`);
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-border bg-card p-3">
      <Eyebrow>Write a blank tag</Eyebrow>
      <div className="flex gap-2">
        {(['opt', 'openspool'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFormat(f)}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${format === f ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground'}`}
          >
            {f === 'opt' ? 'OpenPrintTag' : 'OpenSpool'}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label className="text-[10px]">Class</Label>
          <select
            value={materialClass}
            onChange={(e) => setMaterialClass(e.target.value as 'FFF' | 'SLA')}
            className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none dark:bg-input/30"
          >
            <option value="FFF">FFF (filament)</option>
            <option value="SLA">SLA (resin)</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[10px]">Type</Label>
          <select
            value={materialType}
            onChange={(e) => setMaterialType(e.target.value)}
            className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none dark:bg-input/30"
          >
            {MATERIAL_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[10px]">Color</Label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-full rounded-md border border-input bg-transparent" />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[10px]">Brand</Label>
          <Input value={brand} onChange={(e) => setBrand(e.target.value)} className="h-7 text-xs" placeholder="e.g. Prusament" />
        </div>
        <div className="col-span-2 flex flex-col gap-1">
          <Label className="text-[10px]">Material name</Label>
          <Input value={materialName} onChange={(e) => setMaterialName(e.target.value)} className="h-7 text-xs" />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[10px]">Net weight (g)</Label>
          <Input value={weight} inputMode="numeric" onChange={(e) => setWeight(e.target.value)} className="h-7 text-xs" />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[10px]">Nozzle min °C</Label>
          <Input value={minTemp} inputMode="numeric" onChange={(e) => setMinTemp(e.target.value)} className="h-7 text-xs" />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[10px]">Nozzle max °C</Label>
          <Input value={maxTemp} inputMode="numeric" onChange={(e) => setMaxTemp(e.target.value)} className="h-7 text-xs" />
        </div>
      </div>
      {confirming ? (
        <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/[0.06] p-2.5">
          <p className="text-xs text-foreground">Hold a blank (or rewritable) tag to the back of your phone, then confirm.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={writing}>Cancel</Button>
            <Button type="button" size="sm" onClick={doWrite} disabled={writing}>
              {writing ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Nfc size={13} aria-hidden />}
              Confirm write
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
            <Nfc size={13} aria-hidden /> Write to tag
          </Button>
        </div>
      )}
    </div>
  );
}

export default ConsumableNfcPanel;
