'use client';

import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ExternalLink, Loader2, Nfc, PencilLine, RadioTower } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Eyebrow } from '@/components/ui/eyebrow';
import { cn } from '@/lib/util/utils';
import { useNfcReader, type NfcOutRecord } from '@/app/scan/use-nfc-reader';
import { tagDataAction } from '@/app/scan/actions';
import { encodeOpenPrintTag, encodeOpenSpool, type TagEncodeInput } from '@/lib/integrations/nfc-encoders';
import { buildTagViewerUrl } from '@/lib/integrations/tag-url';
import { ParsedTagView, tagHeading } from '@/components/inventory/parsed-tag-view';
import type { NfcTagEntry, ParsedTag } from '@/lib/integrations/nfc-decoders';
import type { InventoryPayload, ItemTagData } from '@/lib/views/inventory-shape';

// components/inventory/consumable-nfc-panel.tsx — the consumable NFC affordance inside ItemDetailsModal.
// Shown only for kind 'consumable'. Reads a filament/resin tag (OpenPrintTag / OpenSpool / OpenTag3D),
// binds it to this item by UID (tagDataAction), shows the decoded material data, offers to apply the
// name/weight to the catalog item, and programs a blank tag. A written tag carries BOTH the data record
// AND a /t URI record, so the tag is readable on any platform (iOS/Android open the URI on tap). Web NFC
// read/write is Chrome-on-Android only, so the controls degrade gracefully elsewhere.

const MATERIAL_TYPES = [
  'PLA', 'PETG', 'TPU', 'ABS', 'ASA', 'PC', 'PCTG', 'PP', 'PA6', 'PA11', 'PA12', 'PA66', 'CPE', 'TPE',
  'HIPS', 'PHA', 'PET', 'PEI', 'PBT', 'PVB', 'PVA', 'PEKK', 'PEEK', 'BVOH', 'TPC', 'PPS', 'PPSU', 'PVC',
  'PEBA', 'PVDF', 'PPA', 'PCL', 'PES', 'PMMA', 'POM', 'PPE', 'PS', 'PSU', 'TPI', 'SBS', 'OBC', 'EVA',
];

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
  const [expandedUid, setExpandedUid] = useState<string | null>(null);

  const boundTags = useMemo<ItemTagData[]>(
    () => (item.tagData ? Object.values(item.tagData) : []).sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0)),
    [item.tagData]
  );
  // Each spool tag is also a serial unit (auto-registered): map tag UID → unit for its location/remaining.
  const unitByTag = useMemo(() => {
    const m = new Map<string, NonNullable<InventoryPayload['units']>[number]>();
    for (const u of item.units || []) if (u && !u.deletedAt && u.tagUid) m.set(u.tagUid, u);
    return m;
  }, [item.units]);

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
    const heading = tagHeading(p, lastEntry?.category);
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
          Reading/writing tags needs Chrome on Android (Web NFC). Tags written here carry a link any phone
          can tap to read; bound tags also show below on any device.
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
        <div className="flex flex-col gap-2">
          <ParsedTagView parsed={lastParsed} category={lastEntry?.category} format={lastEntry?.format} uid={lastEntry?.tagUid} />
          {canEdit && onApplyToForm ? (
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={applyToForm}>
                Apply name + weight to item
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Already-bound tags (persisted on the item) — click to explore the full decoded data. Works on
          any device (desktop included): it reads the stored tagData, no NFC needed. */}
      {boundTags.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            Bound tags · {boundTags.length}
          </span>
          {boundTags.map((t) => {
            const open = expandedUid === t.tagUid;
            const origin = typeof window !== 'undefined' ? window.location.origin : '';
            const unit = unitByTag.get(t.tagUid);
            const remaining = unit?.remainingWeight ?? t.parsed?.remaining_weight ?? null;
            const where = unit ? (unit.location && unit.location !== 'storage' ? 'in a case' : 'in storage') : null;
            return (
              <div key={t.tagUid} className="overflow-hidden rounded-md border border-border bg-card">
                <button
                  type="button"
                  onClick={() => setExpandedUid(open ? null : t.tagUid)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-muted/40"
                >
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-foreground">
                    {t.parsed?.primary_color ? (
                      <span className="inline-block size-3 shrink-0 rounded-[3px] border border-border" style={{ background: t.parsed.primary_color }} aria-hidden />
                    ) : null}
                    <span className="truncate">{tagHeading(t.parsed, t.category)}</span>
                    {where ? (
                      <span className="shrink-0 rounded border border-border px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                        {where}
                        {remaining != null ? ` · ${remaining}g` : ''}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="font-mono text-[10px] text-muted-foreground">{t.tagUid}</span>
                    <ChevronDown size={13} className={cn('text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
                  </span>
                </button>
                {open ? (
                  t.parsed ? (
                    <div className="flex flex-col gap-2 border-t border-border p-2.5">
                      <ParsedTagView parsed={t.parsed} category={t.category} format={t.format} uid={t.tagUid} />
                      <div className="flex items-center justify-between gap-2">
                        {t.lastReadAt ? (
                          <span className="text-[10px] text-muted-foreground">
                            Read {new Date(t.lastReadAt).toLocaleString()}
                          </span>
                        ) : <span />}
                        <a
                          href={buildTagViewerUrl(t.parsed as Parameters<typeof buildTagViewerUrl>[0], origin)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[11px] text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                        >
                          Open in tag viewer <ExternalLink size={11} aria-hidden />
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div className="border-t border-border p-2.5 text-xs text-muted-foreground">
                      This tag has no decoded material data (UID only — it wasn&apos;t an OpenPrintTag/OpenSpool tag).
                    </div>
                  )
                ) : null}
              </div>
            );
          })}
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
  writeTag: (records: NfcOutRecord[]) => Promise<{ ok: boolean; error?: string }>;
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
    // Two-record message: the universal-read /t URI (any phone opens it on tap) + the format data record.
    const records: NfcOutRecord[] = [
      { recordType: 'url', data: buildTagViewerUrl(input, window.location.origin) },
      { recordType: 'mime', mediaType: enc.mediaType, data: enc.data },
    ];
    setWriting(true);
    const res = await writeTag(records);
    setWriting(false);
    setConfirming(false);
    if (res.ok) toast.success('Tag written — readable on any phone');
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
      <p className="text-[10px] text-muted-foreground">
        Writes the {format === 'opt' ? 'OpenPrintTag' : 'OpenSpool'} data plus a link any phone can tap to read.
      </p>
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
