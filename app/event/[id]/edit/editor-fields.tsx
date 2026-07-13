'use client';

import * as React from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  useFormContext,
  useFieldArray,
  useWatch,
  Controller,
  type FieldPath,
} from 'react-hook-form';
import { Plus, Trash2, Lock, X, Plane, Check, ChevronsUpDown, ChevronDown, ChevronLeft, ChevronRight, Copy, Truck, Star } from 'lucide-react';
import { useParams } from 'next/navigation';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { TagChip } from '@/components/ui/tag-chip';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { PlacesAddressField, type ParsedPlace } from '@/components/ui/places-address-field';
import { StarRating } from '@/components/ui/star-rating';
import { cn, telHref } from '@/lib/util/utils';
import type { DashTag } from '@/lib/types/types-dashboard';
import { lookupFlightAction, type FlightLeg } from '@/app/event/flight-actions';
import { EVENT_STATES, type EventFormValues } from './schema';
import { useEditorContext } from './editor-context';
import {
  RECEPTACLES,
  REGION_LABEL,
  inferEventRegion,
  regionPower,
  deviceFitsVolts,
  type Region,
  type VoltFamily,
  type DeviceVolts,
} from '@/lib/power/connectors';

// app/event/[id]/edit/editor-fields.tsx — the editor's field components (full 1:1 parity pass).
//
// #90 GUARANTEE (focus loss / remount is structurally impossible): EVERY component here lives at
// MODULE SCOPE and is a real React component. None is defined inside another component's render body,
// so React keeps a STABLE element identity across re-renders and reconciles each <input> in place — a
// re-render (on any keystroke, on a tab switch, on a useFieldArray mutation) can never tear down and
// remount the focused input. (RHF further isolates re-renders per field via Controller/register.)
//
// State lives in ONE react-hook-form store. Inputs read/write that store via Controller/register, so
// there is NO panel-local draft to lose on a tab switch — combined with the editor's forceMount tabs
// (#93), a half-typed value in any tab survives switching away and back. (This is strictly BETTER
// than the Python, which needed an onBlur local-draft hack to dodge its remount bug — RHF makes the
// hack unnecessary because the field identity is stable.)

type Name = FieldPath<EventFormValues>;

// ── Group heading ─────────────────────────────────────────────────────────────
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

function FieldGroup({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <GroupLabel>{title}</GroupLabel>
        {action}
      </div>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}

// ── Generic text field bound to a form path ───────────────────────────────────
export function TextField({
  name,
  label,
  placeholder,
  type = 'text',
  mono,
  description,
  className,
}: {
  name: Name;
  label: string;
  placeholder?: string;
  type?: string;
  mono?: boolean;
  description?: string;
  className?: string;
}) {
  const { control } = useFormContext<EventFormValues>();
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type={type}
              placeholder={placeholder}
              className={cn(mono && 'font-mono')}
              {...field}
              value={typeof field.value === 'string' ? field.value : ''}
            />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

// A bare text input bound to a path (no FormItem chrome) — for grid rows where the label is implicit.
function BareInput({
  name,
  placeholder,
  type = 'text',
  mono,
  ariaLabel,
}: {
  name: Name;
  placeholder?: string;
  type?: string;
  mono?: boolean;
  ariaLabel?: string;
}) {
  const { control } = useFormContext<EventFormValues>();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <Input
          type={type}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={cn(mono && 'font-mono')}
          {...field}
          value={typeof field.value === 'string' ? field.value : ''}
        />
      )}
    />
  );
}

// ── State select ──────────────────────────────────────────────────────────────
const STATE_LABELS: Record<string, string> = {
  draft: 'Draft',
  upcoming: 'Upcoming',
  packing: 'Packing',
  ready: 'Ready to ship',
  in_transit: 'In transit',
  onsite: 'On site',
  returning: 'Returning',
  unpacking: 'Unpacking',
  closed: 'Closed',
};

export function StateField() {
  const { control } = useFormContext<EventFormValues>();
  return (
    <FormField
      control={control}
      name="state"
      render={({ field }) => (
        <FormItem>
          <FormLabel>State</FormLabel>
          <Select value={field.value} onValueChange={field.onChange}>
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select state" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {EVENT_STATES.map((st) => (
                <SelectItem key={st} value={st}>
                  {STATE_LABELS[st] ?? st}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

// ── A datetime-local "range" (setup/teardown) ──────────────────────────────────
function DateTimeRange({
  startName,
  endName,
  label,
  description,
  startPlaceholder,
  endPlaceholder,
}: {
  startName: Name;
  endName: Name;
  label: string;
  description?: string;
  startPlaceholder?: string;
  endPlaceholder?: string;
}) {
  return (
    <FormItem>
      <FormLabel>{label}</FormLabel>
      <div className="grid gap-3 sm:grid-cols-2">
        <BareInput name={startName} type="datetime-local" ariaLabel={startPlaceholder || `${label} begins`} />
        <BareInput name={endName} type="datetime-local" ariaLabel={endPlaceholder || `${label} ends`} />
      </div>
      {description && <FormDescription>{description}</FormDescription>}
    </FormItem>
  );
}

// ── Per-day hours editor (the "week strip") ─────────────────────────────────────
// Appears under the date range once both dates are set: one column per show day, each with a vertical
// time-block visualization (attendee doors in primary, exhibitor access dashed blue behind), draggable
// block edges (15-min snap), compact time inputs, and ◀ ▶ copy-to-neighbor buttons. A day with no
// override uses the event-level doorsOpen/doorsClose; entries live in form value `hours` keyed by
// 'YYYY-MM-DD' (toPatch prunes empties + out-of-range days on save).

const RAIL_START = 6; // 6 AM
const RAIL_END = 22; // 10 PM
const RAIL_H = 132; // px
const DAY_CAP = 21;

/** 'HH:MM' → minutes since midnight, or null when not a valid time string. */
function tMin(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 1440 ? v : null;
}
function minToT(min: number): string {
  const m = Math.min(1439, Math.max(0, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
/** Minutes → px offset on the rail (clamped to the visible 6:00–22:00 window). */
function railY(min: number): number {
  const lo = RAIL_START * 60;
  const hi = RAIL_END * 60;
  return ((Math.min(hi, Math.max(lo, min)) - lo) / (hi - lo)) * RAIL_H;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Enumerate 'YYYY-MM-DD' days from start..end inclusive (explicit local Date math, capped). */
function enumerateDays(start: string, end: string, cap: number): { key: string; label: string }[] {
  const m1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start);
  const m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  if (!m1 || !m2 || start > end) return [];
  const d = new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]));
  const out: { key: string; label: string }[] = [];
  for (let i = 0; i < cap; i++) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (key > end) break;
    out.push({ key, label: `${WEEKDAYS[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}` });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

type DayHoursRec = EventFormValues['hours'];

export function DayHoursEditor() {
  const { control, setValue, getValues } = useFormContext<EventFormValues>();
  const startDate = useWatch({ control, name: 'startDate' });
  const endDate = useWatch({ control, name: 'endDate' });
  const doorsOpen = useWatch({ control, name: 'doorsOpen' });
  const doorsClose = useWatch({ control, name: 'doorsClose' });
  const hours = (useWatch({ control, name: 'hours' }) ?? {}) as DayHoursRec;

  const days = useMemo(() => enumerateDays(startDate, endDate, DAY_CAP), [startDate, endDate]);
  const railRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const setDay = useCallback(
    (date: string, patch: Partial<EventFormValues['hours'][string]>) => {
      const cur = (getValues('hours') ?? {}) as DayHoursRec;
      const prev = cur[date] || { open: '', close: '', exOpen: '', exClose: '' };
      setValue('hours', { ...cur, [date]: { ...prev, ...patch } }, { shouldDirty: true });
    },
    [getValues, setValue]
  );
  const clearDay = useCallback(
    (date: string) => {
      const cur = { ...((getValues('hours') ?? {}) as DayHoursRec) };
      delete cur[date];
      setValue('hours', cur, { shouldDirty: true });
    },
    [getValues, setValue]
  );

  // Effective values for a day: attendee falls back to the default doors; exhibitor is explicit-only.
  const eff = useCallback(
    (date: string) => {
      const d = hours[date];
      return {
        open: d?.open || doorsOpen || '',
        close: d?.close || doorsClose || '',
        exOpen: d?.exOpen || '',
        exClose: d?.exClose || '',
      };
    },
    [hours, doorsOpen, doorsClose]
  );

  // Copy a day's EFFECTIVE hours onto a neighbor (materializes as an explicit override there).
  const copyTo = useCallback(
    (from: string, to: string) => {
      const e = eff(from);
      setDay(to, { open: e.open, close: e.close, exOpen: e.exOpen, exClose: e.exClose });
    },
    [eff, setDay]
  );

  // Drag a block edge: pointer-captured, 15-min snap, clamped so open stays ≥15min before close (and
  // both stay inside the rail window). `kind` picks attendee vs exhibitor; `edge` picks which time.
  const dragEdge = useCallback(
    (date: string, kind: 'att' | 'ex', edge: 'start' | 'end') => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const rail = railRefs.current[date];
      if (!rail) return;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const apply = (clientY: number) => {
        const rect = rail.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
        const raw = RAIL_START * 60 + frac * (RAIL_END - RAIL_START) * 60;
        // Rail-clamp the DRAG POSITION first, then apply the ordering clamp LAST so the written pair
        // can never invert — a counterpart outside the 6:00–22:00 rail (e.g. a 22:30 typed time) pins
        // the edge 15 min away from it, possibly past the rail, which is a valid non-inverted time.
        let min = Math.round(raw / 15) * 15;
        min = Math.min(RAIL_END * 60, Math.max(RAIL_START * 60, min));
        const ev = eff(date);
        const field = kind === 'att' ? (edge === 'start' ? 'open' : 'close') : edge === 'start' ? 'exOpen' : 'exClose';
        const other = kind === 'att' ? (edge === 'start' ? ev.close : ev.open) : edge === 'start' ? ev.exClose : ev.exOpen;
        const otherMin = tMin(other);
        if (otherMin !== null) {
          if (edge === 'start') min = Math.min(min, otherMin - 15);
          else min = Math.max(min, otherMin + 15);
        }
        setDay(date, { [field]: minToT(min) });
      };
      const move = (ev: PointerEvent) => apply(ev.clientY);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    },
    [eff, setDay]
  );

  if (days.length === 0) return null;
  const capped = !!endDate && days[days.length - 1].key < endDate;

  return (
    <FormItem>
      <FormLabel>Daily hours</FormLabel>
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="flex gap-2">
          {days.map((d, i) => {
            const e = eff(d.key);
            const hasOverride = !!hours[d.key] && Object.values(hours[d.key]).some(Boolean);
            const ao = tMin(e.open);
            const ac = tMin(e.close);
            const xo = tMin(e.exOpen);
            const xc = tMin(e.exClose);
            const attOk = ao !== null && ac !== null && ac > ao;
            const exOk = xo !== null && xc !== null && xc > xo;
            return (
              <div key={d.key} className="w-[8.25rem] shrink-0 rounded-md border border-border bg-card/60 p-1.5">
                {/* Header: weekday + copy/clear controls. */}
                <div className="mb-1 flex items-center justify-between gap-0.5">
                  <span className={cn('text-[11px] font-semibold', hasOverride ? 'text-foreground' : 'text-muted-foreground')}>
                    {d.label}
                    {hasOverride && <span className="ml-1 inline-block size-1.5 rounded-full bg-primary align-middle" aria-label="custom hours" />}
                  </span>
                  <span className="flex items-center">
                    {i > 0 && (
                      <button
                        type="button"
                        title={`Copy ${d.label} hours to ${days[i - 1].label}`}
                        aria-label={`Copy this day's hours to ${days[i - 1].label}`}
                        onClick={() => copyTo(d.key, days[i - 1].key)}
                        className="rounded-sm p-0.5 text-muted-foreground/60 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <ChevronLeft className="size-3.5" aria-hidden />
                      </button>
                    )}
                    {i < days.length - 1 && (
                      <button
                        type="button"
                        title={`Copy ${d.label} hours to ${days[i + 1].label}`}
                        aria-label={`Copy this day's hours to ${days[i + 1].label}`}
                        onClick={() => copyTo(d.key, days[i + 1].key)}
                        className="rounded-sm p-0.5 text-muted-foreground/60 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <ChevronRight className="size-3.5" aria-hidden />
                      </button>
                    )}
                    {hasOverride && (
                      <button
                        type="button"
                        title="Reset this day to the default doors"
                        aria-label="Reset this day to the default doors"
                        onClick={() => clearDay(d.key)}
                        className="rounded-sm p-0.5 text-muted-foreground/60 outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    )}
                  </span>
                </div>

                {/* Rail: 6:00–22:00, hour ticks every 4h; exhibitor block (dashed blue) behind the
                    attendee block (primary). Edges drag with a 15-min snap. */}
                <div
                  ref={(el) => {
                    railRefs.current[d.key] = el;
                  }}
                  className="relative rounded-sm border border-border/60 bg-muted/20"
                  style={{ height: RAIL_H }}
                >
                  {[8, 12, 16, 20].map((h) => (
                    <div key={h} className="absolute inset-x-0 border-t border-border/40" style={{ top: railY(h * 60) }}>
                      <span className="absolute left-0.5 -top-0.5 -translate-y-1/2 text-[8px] leading-none text-muted-foreground/50">
                        {h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`}
                      </span>
                    </div>
                  ))}
                  {exOk && (
                    <div
                      className="absolute inset-x-0.5 rounded-[3px] border border-dashed"
                      style={{
                        top: railY(xo),
                        height: Math.max(6, railY(xc) - railY(xo)),
                        borderColor: 'var(--st-upcoming)',
                        background: 'color-mix(in oklch, var(--st-upcoming) 10%, transparent)',
                      }}
                    >
                      <div onPointerDown={dragEdge(d.key, 'ex', 'start')} className="absolute inset-x-0 -top-1 h-2.5 cursor-ns-resize touch-none" aria-hidden />
                      <div onPointerDown={dragEdge(d.key, 'ex', 'end')} className="absolute inset-x-0 -bottom-1 h-2.5 cursor-ns-resize touch-none" aria-hidden />
                    </div>
                  )}
                  {attOk && (
                    <div
                      className="absolute inset-x-2 rounded-[3px] border"
                      style={{
                        top: railY(ao),
                        height: Math.max(6, railY(ac) - railY(ao)),
                        borderColor: 'var(--primary)',
                        background: 'color-mix(in oklch, var(--primary) 22%, transparent)',
                      }}
                    >
                      <div onPointerDown={dragEdge(d.key, 'att', 'start')} className="absolute inset-x-0 -top-1 h-2.5 cursor-ns-resize touch-none" aria-hidden />
                      <div onPointerDown={dragEdge(d.key, 'att', 'end')} className="absolute inset-x-0 -bottom-1 h-2.5 cursor-ns-resize touch-none" aria-hidden />
                    </div>
                  )}
                  {!attOk && (
                    <div className="absolute inset-0 grid place-items-center p-1 text-center text-[9px] leading-tight text-muted-foreground/60">
                      Set doors above or type times below
                    </div>
                  )}
                </div>

                {/* Compact per-day time inputs: attendee doors + exhibitor access. */}
                <div className="mt-1.5 flex flex-col gap-1">
                  <div className="flex items-center gap-1">
                    <span className="w-8 shrink-0 text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Doors</span>
                    <input
                      type="time"
                      value={e.open}
                      aria-label={`${d.label} doors open`}
                      onChange={(ev) => setDay(d.key, { open: ev.target.value })}
                      className="h-6 w-full min-w-0 rounded border border-input bg-transparent px-1 font-mono text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    />
                    <input
                      type="time"
                      value={e.close}
                      aria-label={`${d.label} doors close`}
                      onChange={(ev) => setDay(d.key, { close: ev.target.value })}
                      className="h-6 w-full min-w-0 rounded border border-input bg-transparent px-1 font-mono text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="w-8 shrink-0 text-[9px] font-bold uppercase tracking-wide" style={{ color: 'var(--st-upcoming)' }}>
                      Exhib
                    </span>
                    <input
                      type="time"
                      value={e.exOpen}
                      aria-label={`${d.label} exhibitor access from`}
                      onChange={(ev) => setDay(d.key, { exOpen: ev.target.value })}
                      className="h-6 w-full min-w-0 rounded border border-input bg-transparent px-1 font-mono text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    />
                    <input
                      type="time"
                      value={e.exClose}
                      aria-label={`${d.label} exhibitor access until`}
                      onChange={(ev) => setDay(d.key, { exClose: ev.target.value })}
                      className="h-6 w-full min-w-0 rounded border border-input bg-transparent px-1 font-mono text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <FormDescription>
        Attendee doors + exhibitor access per day. Days without custom times use the default doors above;
        drag a block&rsquo;s edges (15-min steps), type exact times, or use ◀ ▶ to copy a day to its neighbor.
        {capped ? ` Showing the first ${DAY_CAP} days of the range.` : ''}
      </FormDescription>
    </FormItem>
  );
}

// ── Places-backed address field bound to a set of venue/hotel paths ─────────────
// Writes the street to `addressName` on every keystroke; on a place pick, fans out city/state/zip/
// lat/lng via setValue. Faithful to the Python PlacesAddressField + its onPlace fan-out.
function PlacesField({
  addressName,
  cityName,
  stateName,
  zipName,
  latName,
  lngName,
  label,
  placeholder,
  description,
  onPlacePicked,
}: {
  addressName: Name;
  cityName: Name;
  stateName: Name;
  zipName: Name;
  latName?: Name;
  lngName?: Name;
  label: string;
  placeholder?: string;
  description?: string;
  onPlacePicked?: (p: ParsedPlace) => void;
}) {
  const { control, setValue } = useFormContext<EventFormValues>();
  const { placesAvailable } = useEditorContext();
  const handlePlace = useCallback(
    (p: ParsedPlace) => {
      // Order: fan out the multi-field update so a street-only onChange can't clobber it (Python rule).
      if (p.address) setValue(addressName, p.address, { shouldDirty: true });
      if (p.city) setValue(cityName, p.city, { shouldDirty: true });
      if (p.state) setValue(stateName, p.state, { shouldDirty: true });
      if (p.zip) setValue(zipName, p.zip, { shouldDirty: true });
      if (latName && typeof p.lat === 'number') setValue(latName, p.lat as never, { shouldDirty: true });
      if (lngName && typeof p.lng === 'number') setValue(lngName, p.lng as never, { shouldDirty: true });
      onPlacePicked?.(p);
    },
    [addressName, cityName, stateName, zipName, latName, lngName, setValue, onPlacePicked]
  );
  return (
    <FormField
      control={control}
      name={addressName}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <PlacesAddressField
              value={typeof field.value === 'string' ? field.value : ''}
              onChange={(v) => field.onChange(v)}
              onPlace={handlePlace}
              placeholder={placeholder}
              placesAvailable={placesAvailable}
              aria-label={label}
            />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
        </FormItem>
      )}
    />
  );
}

// ── Amenities list editor (add/remove rows) ────────────────────────────────────
// ── Booth power (powerDrop + powerNotes + the receptacle grid) ─────────────────
// Whether the event/booth provides a power drop, with the drop detail + WHICH receptacle types the
// drop offers — picked from a visual grid (SVG faces + official names, lib/power/connectors),
// grouped by region (the venue's inferred region first) and GREYED when no assigned powered
// equipment can use that voltage (a 120 V-only device can't use a 240 V receptacle; amp variants
// stay live). Module-scope (never define a component inside a render body — the #59/#90 lesson).
function PowerDropFields() {
  const { control } = useFormContext<EventFormValues>();
  const { casePowerVolts } = useEditorContext();
  const powerDrop = useWatch({ control, name: 'powerDrop' });
  const venue = useWatch({ control, name: 'venue' });
  const city = useWatch({ control, name: 'city' });
  const caseIds = useWatch({ control, name: 'cases' });

  const region = inferEventRegion(venue, city);
  // The voltage classes the SELECTED cases' powered equipment needs (empty = nothing known → no greying).
  const needed = new Set<string>();
  for (const cid of Array.isArray(caseIds) ? caseIds : []) {
    for (const v of casePowerVolts[cid] ?? []) needed.add(v);
  }
  const usable = (fam: VoltFamily): boolean => {
    if (needed.size === 0) return true;
    return [...needed].some((d) => deviceFitsVolts(d as DeviceVolts, fam));
  };
  // Inferred region first, then the rest in catalog order.
  const regions: Region[] = [region, ...(['NA', 'EU', 'UK', 'AU'] as Region[]).filter((r) => r !== region)];

  const destPower = regionPower(region);
  return (
    <div className="flex flex-col gap-3">
      {/* The proactive "what plug will you need there" line — driven by the venue's coordinates
          (Places autocomplete stamps lat/lng; text fallback otherwise). */}
      <p className="text-xs text-muted-foreground">
        Destination: <span className="text-foreground">{REGION_LABEL[region]}</span> — mains {destPower.mains}; local
        receptacle: {destPower.receptacles.map((r) => r.label).join(', ')}.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <FormField
          control={control}
          name="powerDrop"
          render={({ field }) => (
            <FormItem className="flex h-9 flex-row items-center gap-2 space-y-0">
              <FormControl>
                <Checkbox checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} />
              </FormControl>
              <FormLabel className="cursor-pointer font-normal">Venue provides a power drop</FormLabel>
            </FormItem>
          )}
        />
        {powerDrop ? (
          <TextField
            name="powerNotes"
            label="Power drop details"
            placeholder="e.g. 2× 20A 120V to the booth"
            className="min-w-64 flex-1"
          />
        ) : null}
      </div>

      {powerDrop ? (
        <Controller
          control={control}
          name="powerReceptacles"
          render={({ field }) => {
            const selected = new Set(Array.isArray(field.value) ? field.value : []);
            const toggle = (id: string) => {
              const next = new Set(selected);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              field.onChange([...next]);
            };
            return (
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">
                  Receptacles at the drop — {REGION_LABEL[region]} shown first (inferred from the venue).
                  Greyed types aren&apos;t usable by the assigned equipment&apos;s voltage.
                </span>
                {regions.map((reg) => {
                  const recs = RECEPTACLES.filter((r) => r.region === reg);
                  if (!recs.length) return null;
                  return (
                    <div key={reg} className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {REGION_LABEL[reg]}
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {recs.map((r) => {
                          const on = selected.has(r.id);
                          const ok = usable(r.volts);
                          return (
                            <button
                              key={r.id}
                              type="button"
                              onClick={() => toggle(r.id)}
                              aria-pressed={on}
                              title={ok ? `${r.label} · ${r.volts === '120' ? '120 V' : '230/240 V'} ${r.amps} A` : `${r.label} — no assigned equipment uses ${r.volts === '120' ? '120 V' : '230/240 V'}`}
                              className={cn(
                                'flex w-[88px] flex-col items-center gap-0.5 rounded-md border px-2 py-2 text-center transition-colors',
                                on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent/50',
                                !ok && 'opacity-40'
                              )}
                            >
                              <span className="size-9 text-foreground">{r.svg}</span>
                              <span className="text-[10px] font-medium leading-tight">{r.label}</span>
                              <span className="text-[9px] tabular-nums">{r.volts === '120' ? '120V' : '230/240V'} · {r.amps}A</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          }}
        />
      ) : null}
    </div>
  );
}

function AmenitiesEditor() {
  const { control } = useFormContext<EventFormValues>();
  const { fields, append, remove } = useFieldArray({ control, name: 'venue.amenities' as never });
  return (
    <FormItem>
      <FormLabel>Amenities</FormLabel>
      <FormDescription>Wi-Fi, power, loading dock, forklift, etc.</FormDescription>
      <div className="grid gap-2">
        {fields.map((f, i) => (
          <div key={f.id} className="flex items-center gap-2">
            <BareInput name={`venue.amenities.${i}` as Name} placeholder="Amenity" ariaLabel={`Amenity ${i + 1}`} />
            <Button
              type="button"
              variant="destructive"
              size="icon-sm"
              onClick={() => remove(i)}
              aria-label={`Remove amenity ${i + 1}`}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
      </div>
      <div>
        <Button type="button" size="sm" variant="secondary" onClick={() => append('' as never)}>
          <Plus aria-hidden />
          Add amenity
        </Button>
      </div>
    </FormItem>
  );
}

// ── Timezone field + "Use mine" ────────────────────────────────────────────────
function TimezoneField() {
  const { control, setValue } = useFormContext<EventFormValues>();
  const { viewerTimezone } = useEditorContext();
  return (
    <FormField
      control={control}
      name="venue.timezone"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Timezone</FormLabel>
          <div className="flex items-center gap-2">
            <FormControl>
              <Input
                {...field}
                value={typeof field.value === 'string' ? field.value : ''}
                placeholder={viewerTimezone || 'America/New_York'}
                className="font-mono"
              />
            </FormControl>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="whitespace-nowrap"
              disabled={!viewerTimezone}
              onClick={() => setValue('venue.timezone', viewerTimezone, { shouldDirty: true })}
            >
              Use mine
            </Button>
          </div>
          <FormDescription>
            Auto-filled from the address. Event times show in the venue&rsquo;s time and each viewer&rsquo;s local time.
            IANA name, e.g. America/New_York.
          </FormDescription>
        </FormItem>
      )}
    />
  );
}

// ── Overview panel ────────────────────────────────────────────────────────────
export function OverviewPanel() {
  return (
    <div>
      <FieldGroup title="Basics">
        <TextField name="name" label="Name" placeholder="e.g. RAPID + TCT 2026" />
        <StateField />
        <FormField
          name="brief"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Brief / Notes</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  value={typeof field.value === 'string' ? field.value : ''}
                  placeholder="Goals, booth plan, talking points, logistics context — anything the team should read before the show."
                  rows={5}
                  maxLength={20000}
                />
              </FormControl>
              <FormDescription>
                Shown on the event page. Also writable through the API/MCP, so an AI agent can draft or update it.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </FieldGroup>

      <FieldGroup title="Schedule">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="startDate" label="Start date" type="date" />
          <TextField name="endDate" label="End date" type="date" />
          <TextField name="doorsOpen" label="Doors open" type="time" />
          <TextField name="doorsClose" label="Doors close" type="time" />
        </div>
        <DayHoursEditor />
        <DateTimeRange
          startName="setup.start"
          endName="setup.end"
          label="Setup"
          description="When booth setup begins and ends."
          startPlaceholder="Setup begins"
          endPlaceholder="Setup ends"
        />
        <DateTimeRange
          startName="teardown.start"
          endName="teardown.end"
          label="Teardown"
          description="When tear-down begins and ends."
          startPlaceholder="Teardown begins"
          endPlaceholder="Teardown ends"
        />
      </FieldGroup>

      <FieldGroup title="Venue">
        <TextField name="venue.name" label="Venue name" placeholder="e.g. Cobo Center" />
        <TextField
          name="website"
          label="Website"
          type="url"
          placeholder="https://example.com/event"
          description="Show registration page, venue website, or any URL the team should reference."
        />
        <PlacesField
          addressName="venue.address"
          cityName="venue.city"
          stateName="venue.state"
          zipName="venue.zip"
          latName={'venue.lat' as Name}
          lngName={'venue.lng' as Name}
          label="Street address"
          placeholder="3150 Paradise Rd"
          description="Start typing — pick a suggestion to autofill city / state / ZIP."
        />
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
          <TextField name="venue.city" label="City" placeholder="Las Vegas" />
          <TextField name="venue.state" label="State" placeholder="NV" />
          <TextField name="venue.zip" label="ZIP" mono placeholder="89109" />
        </div>
        <TimezoneField />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="venue.booth" label="Booth #" mono />
          <TextField name="venue.boothSize" label="Booth size" placeholder="e.g. 20×20 ft" />
        </div>
        <PowerDropFields />
        <AmenitiesEditor />
      </FieldGroup>

      <FieldGroup title="Point of contact (venue)">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="venue.contact.name" label="Name" />
          <TextField name="venue.contact.role" label="Role" placeholder="e.g. Exhibitor services" />
          <TextField name="venue.contact.email" label="Email" type="email" mono />
          <TextField name="venue.contact.phone" label="Phone" type="tel" mono />
        </div>
      </FieldGroup>

      <FieldGroup title="Tags">
        <TagsField />
      </FieldGroup>
    </div>
  );
}

// ── Tags field (apply / remove + primary radio) ────────────────────────────────
function TagsField() {
  const { control, setValue } = useFormContext<EventFormValues>();
  const { tags, canApplyTags } = useEditorContext();
  const radioName = useId();

  return (
    <Controller
      control={control}
      name="tagIds"
      render={({ field: tagIdsField }) => (
        <Controller
          control={control}
          name="primaryTagId"
          render={({ field: primaryField }) => {
            const appliedIds: string[] = Array.isArray(tagIdsField.value) ? tagIdsField.value : [];
            const appliedTags = appliedIds
              .map((id) => tags.find((t) => t.id === id))
              .filter((t): t is DashTag => !!t);
            const primary = primaryField.value as string | null;
            const apply = (id: string) => {
              if (appliedIds.includes(id)) return;
              tagIdsField.onChange([...appliedIds, id]);
            };
            const unapply = (id: string) => {
              tagIdsField.onChange(appliedIds.filter((x) => x !== id));
              if (primary === id) setValue('primaryTagId', null, { shouldDirty: true });
            };
            const unapplied = tags.filter((t) => !appliedIds.includes(t.id));
            return (
              <div className="grid gap-3">
                {canApplyTags && unapplied.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-xs text-muted-foreground">Apply:</span>
                    {unapplied.map((t) => (
                      <TagChip key={t.id} tag={t} onClick={() => apply(t.id)} />
                    ))}
                  </div>
                )}
                {appliedTags.length > 0 ? (
                  <div className="grid gap-2">
                    {appliedTags.length > 1 && (
                      <p className="text-[11px] text-muted-foreground">
                        Primary tag — shown on narrow preview cards (Dashboard timeline). Pick it with the radio.
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2.5">
                      {appliedTags.map((t) => (
                        <div key={t.id} className="flex items-center gap-1.5">
                          <input
                            type="radio"
                            name={radioName}
                            value={t.id}
                            checked={primary === t.id}
                            disabled={!canApplyTags}
                            onChange={() => setValue('primaryTagId', t.id, { shouldDirty: true })}
                            aria-label={`Make ${t.label} the primary tag`}
                            title="Make this the primary tag (shown on narrow Dashboard cards)"
                          />
                          <span className="inline-flex items-center gap-1">
                            <TagChip tag={t} />
                            {canApplyTags && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="size-5 text-muted-foreground"
                                onClick={() => unapply(t.id)}
                                aria-label={`Remove tag ${t.label}`}
                              >
                                <X aria-hidden className="size-3" />
                              </Button>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] italic text-muted-foreground">
                    {canApplyTags ? 'No tags applied yet. Click a tag above to apply it.' : 'No tags applied.'}
                  </p>
                )}
              </div>
            );
          }}
        />
      )}
    />
  );
}

// ── Team & Travel panel (PII) ─────────────────────────────────────────────────
export function TeamPanel({ piiEditable }: { piiEditable: boolean }) {
  const { control, setValue } = useFormContext<EventFormValues>();
  const { fields, append, remove } = useFieldArray({ control, name: 'staff' });
  const { directory } = useEditorContext();

  // Staffers already on the event when it loaded default to COLLAPSED (fold the existing roster); a
  // staffer added now stays expanded so you can fill them in. Tracked by the field's stable id, so a
  // remove/reorder doesn't reclassify rows.
  const initialStaffIds = useRef<Set<string> | null>(null);
  if (initialStaffIds.current === null) initialStaffIds.current = new Set(fields.map((f) => f.id));

  // Watch staff emails to compute the available directory + the lead options (reactive).
  const staffWatch = useWatch({ control, name: 'staff' }) as EventFormValues['staff'] | undefined;
  const staffList = staffWatch ?? [];
  const lead = useWatch({ control, name: 'lead' }) as string | undefined;

  const assignedEmails = useMemo(
    () => new Set(staffList.map((s) => (s.email || '').toLowerCase()).filter(Boolean)),
    [staffList]
  );
  const available = useMemo(
    () => directory.filter((u) => !assignedEmails.has(u.email.toLowerCase())),
    [directory, assignedEmails]
  );

  // Lead options from ALL assigned staff (email preferred, name fallback for legacy email-less staff).
  const leadOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { value: string; label: string }[] = [];
    for (const s of staffList) {
      const val = (s.email || s.name || '').trim();
      if (!val || seen.has(val)) continue;
      seen.add(val);
      const u = s.email ? directory.find((d) => d.email.toLowerCase() === s.email.toLowerCase()) : null;
      opts.push({ value: val, label: (u && u.name) || s.name || s.email || '(no name)' });
    }
    return opts;
  }, [staffList, directory]);

  // Normalize the stored lead (legacy name OR email) to an option value.
  const currentLeadStaffer = staffList.find((s) => lead && (lead === s.email || lead === s.name));
  const currentLeadValue = currentLeadStaffer ? currentLeadStaffer.email || currentLeadStaffer.name : lead || '';

  const addFromDirectory = (email: string) => {
    if (!email) return;
    const u = directory.find((d) => d.email.toLowerCase() === email.toLowerCase());
    const row = piiEditable
      ? { name: u?.name || '', email, role: '', onsiteStart: '', onsiteEnd: '', hotel: {}, travel: {} }
      : { name: u?.name || '', email, role: '', onsiteStart: '', onsiteEnd: '' };
    append(row);
  };

  return (
    <div>
      <FieldGroup title="Team">
        <FormItem>
          <FormLabel>Lead</FormLabel>
          <Select
            value={currentLeadValue || undefined}
            onValueChange={(v) => setValue('lead', v, { shouldDirty: true })}
          >
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="— choose a lead —" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {leadOptions.length === 0 ? (
                <SelectItem value="__none__" disabled>
                  Add a staffer first
                </SelectItem>
              ) : (
                leadOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <FormDescription>The lead may edit this event and see everyone&rsquo;s travel &amp; hotel.</FormDescription>
        </FormItem>
      </FieldGroup>

      <FieldGroup title={`Staff · ${fields.length} assigned`}>
        {fields.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No staff yet. Add a team member from the directory below.
          </div>
        ) : (
          <div className="grid gap-3">
            {fields.map((f, i) => (
              <StaffRow
                key={f.id}
                index={i}
                piiEditable={piiEditable}
                onRemove={() => remove(i)}
                defaultCollapsed={initialStaffIds.current?.has(f.id) ?? false}
              />
            ))}
          </div>
        )}

        <Separator />

        {available.length > 0 ? (
          <FormItem>
            <FormLabel>Add team member</FormLabel>
            <StaffPicker options={available} onSelect={addFromDirectory} />
            <FormDescription>
              {directory.length} {directory.length === 1 ? 'user' : 'users'} in directory · search by name or email.
            </FormDescription>
          </FormItem>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            All directory users are already assigned. New users appear here after they sign in for the first time,
            or after an admin pre-creates them on the Config screen.
          </p>
        )}
      </FieldGroup>
    </div>
  );
}

// Searchable directory picker for adding a team member — a search bar over the available directory
// (filter by name or email) with selectable results, instead of a long scrolling <select>. Mirrors the
// roadcase/kit-BOM combobox pattern (Popover + cmdk Command). Module scope so it's never re-created.
function StaffPicker({
  options,
  onSelect,
}: {
  options: { email: string; name?: string }[];
  onSelect: (email: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = (u: { email: string; name?: string }) => (u.name ? `${u.name} (${u.email})` : u.email);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal text-muted-foreground"
        >
          + Add team member from directory…
          <ChevronsUpDown size={14} className="shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by name or email…" />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-sm text-muted-foreground">No matching users.</CommandEmpty>
            <CommandGroup>
              {options.map((u) => (
                <CommandItem
                  key={u.email}
                  value={`${u.name || ''} ${u.email}`}
                  onSelect={() => {
                    onSelect(u.email);
                    setOpen(false);
                  }}
                >
                  <Check size={14} className="mr-2 shrink-0 opacity-0" aria-hidden />
                  <span className="truncate">{label(u)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// "Copy from…" — pulls another staffer's travel or hotel into this one (multiple people often share a
// flight or hotel). Lists the other staffers who HAVE that kind of info; selecting one deep-copies it.
// Reads live form values via getValues (so it's current even though the row is render-isolated).
function CopyFromMenu({
  index,
  kind,
  onCopy,
}: {
  index: number;
  kind: 'travel' | 'hotel';
  onCopy: (data: unknown) => void;
}) {
  const { getValues } = useFormContext<EventFormValues>();
  const { directory } = useEditorContext();
  const [open, setOpen] = useState(false);

  const hasData = (v: unknown): boolean => {
    const o = v as Record<string, unknown> | undefined;
    if (!o) return false;
    return kind === 'travel'
      ? !!(o.mode || o.outbound || o.return)
      : !!(o.name || o.address || o.room || o.phone || o.checkInAt || o.checkOutAt || o.confirmation || o.notes);
  };
  const labelFor = (s: Record<string, unknown>): string => {
    const email = String(s.email || '').toLowerCase();
    const u = email ? directory.find((d) => d.email.toLowerCase() === email) : null;
    return (u && u.name) || String(s.name || '') || String(s.email || '') || '(unnamed)';
  };
  // Recomputed each render (re-runs when the popover toggles) off LIVE values.
  const sources = ((getValues('staff') as Record<string, unknown>[] | undefined) || [])
    .map((s, i) => ({ i, s }))
    .filter(({ i, s }) => i !== index && hasData(s?.[kind]))
    .map(({ i, s }) => ({ i, label: labelFor(s), data: s[kind] }));
  if (sources.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="text-muted-foreground">
          <Copy size={12} aria-hidden /> Copy from…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Copy {kind} from
        </p>
        {sources.map((src) => (
          <button
            key={src.i}
            type="button"
            onClick={() => {
              onCopy(JSON.parse(JSON.stringify(src.data)));
              setOpen(false);
            }}
            className="block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            {src.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// One staffer row — its OWN module-scope component, so editing staffer N's role can't remount
// staffer M's inputs. Field paths are computed from the row index. Shows the directory avatar/name +
// onsite range, then (when piiEditable) the travel + hotel sub-editors.
function StaffRow({
  index,
  piiEditable,
  onRemove,
  defaultCollapsed = false,
}: {
  index: number;
  piiEditable: boolean;
  onRemove: () => void;
  defaultCollapsed?: boolean;
}) {
  const base = `staff.${index}` as const;
  const { control } = useFormContext<EventFormValues>();
  const { directory } = useEditorContext();
  const email = useWatch({ control, name: `${base}.email` as Name }) as string | undefined;
  const nameVal = useWatch({ control, name: `${base}.name` as Name }) as string | undefined;
  const u = email ? directory.find((d) => d.email.toLowerCase() === email.toLowerCase()) : null;
  const display = u || { name: nameVal || '', email: email || '', picture: '' };
  const initials =
    (display.name || display.email || '?')
      .split(/\s+/)
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?';
  const isLegacy = !email && !!nameVal;
  // Each staffer card collapses to its header so you can fold the people you're done with while editing
  // another (events with a big roster get long fast). Pre-saved staffers default collapsed; a freshly
  // added one stays open. Toggled by clicking the name.
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <div className="grid gap-4 rounded-lg border border-border bg-muted/30 p-4">
      <div className="grid items-center gap-3 sm:grid-cols-[auto_1fr_1fr_auto]">
        <Avatar size="sm">
          {display.picture ? <AvatarImage src={display.picture} alt="" referrerPolicy="no-referrer" /> : null}
          <AvatarFallback className="text-[10px] font-bold">{initials}</AvatarFallback>
        </Avatar>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand staffer details' : 'Collapse staffer details'}
          className="flex min-w-0 items-center gap-2 rounded text-left hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronDown size={14} className={cn('shrink-0 text-muted-foreground transition-transform', collapsed && '-rotate-90')} aria-hidden />
          <span className="min-w-0">
            <span className="block truncate text-sm text-foreground">
              {display.name || display.email || <span className="italic text-muted-foreground">not yet picked</span>}
            </span>
            <span className="block truncate font-mono text-[10px] text-muted-foreground">
              {display.email}
              {isLegacy ? ' · legacy entry' : ''}
            </span>
          </span>
        </button>
        <BareInput name={`${base}.role` as Name} placeholder="Role (Lead, Booth ops, …)" ariaLabel={`Role for staffer ${index + 1}`} />
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={onRemove}
          aria-label={`Remove staffer ${index + 1}`}
        >
          <Trash2 aria-hidden />
          <span className="hidden sm:inline">Remove</span>
        </Button>
      </div>

      {!collapsed ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormItem>
              <FormLabel>Onsite arrives</FormLabel>
              <BareInput name={`${base}.onsiteStart` as Name} type="datetime-local" ariaLabel="Onsite arrives" />
            </FormItem>
            <FormItem>
              <FormLabel>Onsite leaves</FormLabel>
              <BareInput name={`${base}.onsiteEnd` as Name} type="datetime-local" ariaLabel="Onsite leaves" />
            </FormItem>
          </div>

          {piiEditable ? (
            <>
              <TravelEditor base={base} index={index} />
              <HotelEditor base={base} index={index} />
            </>
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Lock aria-hidden className="size-3.5" />
              Travel &amp; hotel are private — only a manager, this staffer, or the event lead can edit them.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}

// ── "Stayed here before" suggestions ───────────────────────────────────────────
// When the hotel name is still empty, offers past hotels near the event's city (from
// /api/hotel-suggestions — aggregate of prior events' staff lodging, avg stay rating included).
// Tapping a chip fills the identity fields (name/address/phone); dates, room, confirmation and the
// rating stay untouched — the rating is for THIS stay, not inherited from the last one.
interface HotelSuggestion {
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  rating: number | null;
  stays: number;
  lastEvent: string;
  breakfast: string; // 'included' | 'paid' | 'none' | ''
  breakfastRating: number | null;
  amenities: string[];
}

function HotelSuggestions({ h }: { h: string }) {
  const { control, getValues, setValue } = useFormContext<EventFormValues>();
  const params = useParams<{ id: string }>();
  const name = useWatch({ control, name: `${h}.name` as Name }) as string | undefined;
  const eventCity = useWatch({ control, name: 'city' }) as string | undefined;
  const venueCity = useWatch({ control, name: 'venue.city' }) as string | undefined;
  const target = (eventCity || venueCity || '').trim();
  const [list, setList] = useState<HotelSuggestion[]>([]);

  useEffect(() => {
    if (!target) {
      setList([]);
      return;
    }
    let stale = false;
    // Debounced: `target` changes keystroke-by-keystroke while the city is being typed.
    const t = setTimeout(() => {
      fetch(`/api/hotel-suggestions?city=${encodeURIComponent(target)}&event=${encodeURIComponent(params?.id ?? '')}`)
        .then((r) => (r.ok ? r.json() : { suggestions: [] }))
        .then((d) => {
          if (!stale) setList(Array.isArray(d.suggestions) ? d.suggestions : []);
        })
        .catch(() => {
          if (!stale) setList([]);
        });
    }, 350);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [target, params?.id]);

  if ((name || '').trim() || !list.length) return null;
  const pick = (sug: HotelSuggestion) => {
    const cur = (getValues(h as Name) as Record<string, unknown>) || {};
    const next: Record<string, unknown> = {
      ...cur,
      name: sug.name,
      address: sug.address,
      city: sug.city,
      state: sug.state,
      zip: sug.zip,
      phone: sug.phone,
    };
    // Breakfast availability + amenities are properties of the hotel — carry them into the new
    // booking as a starting point (unlike the RATING, which belongs to the past stay and is never
    // inherited).
    if (sug.breakfast) next.breakfast = sug.breakfast;
    if (Array.isArray(sug.amenities) && sug.amenities.length) next.amenities = sug.amenities;
    setValue(h as Name, next as never, { shouldDirty: true });
  };
  const bfLabel = (b: string) => (b === 'included' ? 'bfast incl.' : b === 'paid' ? 'bfast paid' : b === 'none' ? 'no bfast' : '');
  return (
    <div className="grid gap-1.5">
      <span className="text-[11px] text-muted-foreground">Stayed near {target} before — tap to fill:</span>
      <div className="flex flex-wrap gap-1.5">
        {list.map((sug) => (
          <button
            key={sug.name}
            type="button"
            onClick={() => pick(sug)}
            title={
              [
                sug.lastEvent ? `Last stay: ${sug.lastEvent}` : '',
                sug.amenities?.length ? `Amenities: ${sug.amenities.join(', ')}` : '',
              ]
                .filter(Boolean)
                .join(' · ') || undefined
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {sug.rating != null ? (
              <span className="inline-flex items-center gap-0.5 tabular-nums text-primary">
                <Star size={11} className="fill-primary text-primary" aria-hidden />
                {sug.rating}
              </span>
            ) : (
              <span className="text-muted-foreground">unrated</span>
            )}
            <span className="text-foreground">{sug.name}</span>
            <span className="text-muted-foreground">
              · {sug.stays} stay{sug.stays === 1 ? '' : 's'}
            </span>
            {bfLabel(sug.breakfast) && (
              <span
                className="text-muted-foreground"
                title={sug.breakfastRating != null ? `Breakfast rated ${sug.breakfastRating}/5` : undefined}
              >
                · {bfLabel(sug.breakfast)}
                {sug.breakfastRating != null ? ` ${sug.breakfastRating}★` : ''}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// The fixed amenity vocabulary — ids double as display labels (capitalized), so aggregation
// across stays never fragments on free-text spellings.
const HOTEL_AMENITIES = ['gym', 'pool', 'laundry', 'restaurant', 'parking', 'shuttle'] as const;

// ── Hotel sub-editor (PII) ─────────────────────────────────────────────────────
// Collapsible. On first expand, seeds default check-in/out from the onsite range (Python parity).
function HotelEditor({ base, index }: { base: string; index: number }) {
  const h = `${base}.hotel` as const;
  const { control, getValues, setValue } = useFormContext<EventFormValues>();
  const hotel = useWatch({ control, name: h as Name }) as Record<string, unknown> | undefined;
  const hasAny = !!(
    hotel &&
    (hotel.name || hotel.address || hotel.room || hotel.phone || hotel.checkInAt || hotel.checkOutAt || hotel.confirmation || hotel.notes || hotel.rating || hotel.breakfast || (Array.isArray(hotel.amenities) && hotel.amenities.length))
  );
  const [expanded, setExpanded] = useState(hasAny);

  const seedDefaults = useCallback(() => {
    const cur = (getValues(h as Name) as Record<string, unknown>) || {};
    const onsiteStart = getValues(`${base}.onsiteStart` as Name) as string;
    const onsiteEnd = getValues(`${base}.onsiteEnd` as Name) as string;
    const startDate = getValues('startDate');
    const endDate = getValues('endDate');
    const next = { ...cur };
    let mutated = false;
    const baseInDate = (onsiteStart || (startDate ? `${startDate}T09:00` : '')).slice(0, 10);
    const baseOutDate = (onsiteEnd || (endDate ? `${endDate}T17:00` : '')).slice(0, 10);
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!next.checkInAt && baseInDate) {
      const d = new Date(baseInDate + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      next.checkInAt = `${ymd(d)}T15:00`;
      mutated = true;
    }
    if (!next.checkOutAt && baseOutDate) {
      const d = new Date(baseOutDate + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      next.checkOutAt = `${ymd(d)}T11:00`;
      mutated = true;
    }
    if (mutated) setValue(h as Name, next as never, { shouldDirty: true });
  }, [base, h, getValues, setValue]);

  const clear = () => {
    setValue(h as Name, {} as never, { shouldDirty: true });
    setExpanded(false);
  };
  const copyFrom = (data: unknown) => {
    setValue(h as Name, data as never, { shouldDirty: true });
    setExpanded(true);
  };

  // Places fan-out for the hotel address writes onto the hotel sub-object.
  const onHotelPlace = useCallback(
    (p: ParsedPlace) => {
      const cur = (getValues(h as Name) as Record<string, unknown>) || {};
      const next = { ...cur };
      if (p.address) next.address = p.address;
      if (p.city) next.city = p.city;
      if (p.state) next.state = p.state;
      if (p.zip) next.zip = p.zip;
      if (typeof p.lat === 'number') next.lat = p.lat;
      if (typeof p.lng === 'number') next.lng = p.lng;
      setValue(h as Name, next as never, { shouldDirty: true });
    },
    [h, getValues, setValue]
  );

  const phone = (hotel?.phone as string) || '';

  if (!expanded) {
    // Has data → a compact summary that re-expands (no data loss); empty → the Add button.
    if (hasAny) {
      return (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Expand hotel info"
          className="flex w-fit items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronDown size={14} className="-rotate-90 text-muted-foreground" aria-hidden />
          <span className="text-foreground">Hotel{hotel?.name ? ` · ${String(hotel.name)}` : ''}</span>
        </button>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-fit text-muted-foreground"
          onClick={() => {
            setExpanded(true);
            seedDefaults();
          }}
        >
          <Plus aria-hidden />
          Add hotel info
        </Button>
        <CopyFromMenu index={index} kind="hotel" onCopy={copyFrom} />
      </div>
    );
  }
  return (
    <fieldset className="grid gap-3 rounded-md border border-border bg-card p-3">
      <legend className="flex w-full items-center justify-between px-1">
        <GroupLabel>Hotel</GroupLabel>
      </legend>
      <div className="flex items-center justify-end gap-1 -mt-2">
        <CopyFromMenu index={index} kind="hotel" onCopy={copyFrom} />
        <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={clear}>
          Clear
        </Button>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label="Collapse hotel"
          className="rounded p-1 text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronDown size={14} aria-hidden />
        </button>
      </div>
      <HotelSuggestions h={h} />
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <BareInput name={`${h}.name` as Name} placeholder="Hotel name (e.g. Marriott Marquis)" ariaLabel="Hotel name" />
        <BareInput name={`${h}.room` as Name} placeholder="Room #" ariaLabel="Room number" />
        <BareInput name={`${h}.confirmation` as Name} placeholder="Confirmation #" ariaLabel="Confirmation number" />
      </div>
      <PlacesField
        addressName={`${h}.address` as Name}
        cityName={`${h}.city` as Name}
        stateName={`${h}.state` as Name}
        zipName={`${h}.zip` as Name}
        latName={`${h}.lat` as Name}
        lngName={`${h}.lng` as Name}
        label="Hotel address"
        placeholder="1331 Pennsylvania Ave NW"
        onPlacePicked={onHotelPlace}
      />
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <BareInput name={`${h}.phone` as Name} type="tel" placeholder="Front desk phone (tap-to-call)" mono ariaLabel="Front desk phone" />
        {phone ? (
          <a
            href={telHref(phone)}
            className="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-sm text-primary hover:bg-accent"
          >
            Call front desk
          </a>
        ) : (
          <span className="self-center text-[11px] text-muted-foreground">Add a phone for one-tap dial.</span>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormItem>
          <FormLabel>Check-in</FormLabel>
          <BareInput name={`${h}.checkInAt` as Name} type="datetime-local" ariaLabel="Hotel check-in" />
        </FormItem>
        <FormItem>
          <FormLabel>Check-out</FormLabel>
          <BareInput name={`${h}.checkOutAt` as Name} type="datetime-local" ariaLabel="Hotel check-out" />
        </FormItem>
      </div>
      <BareInput name={`${h}.notes` as Name} placeholder="Notes (e.g. rooming with M. Kovář, late check-in)" ariaLabel="Hotel notes" />
      {/* Breakfast availability — a booking-time fact (quality gets rated in the post-event survey). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Breakfast</span>
          <Select
            value={String(hotel?.breakfast ?? 'unknown')}
            onValueChange={(v) => {
              const cur = (getValues(h as Name) as Record<string, unknown>) || {};
              const next = { ...cur };
              if (v === 'unknown') delete next.breakfast;
              else next.breakfast = v;
              setValue(h as Name, next as never, { shouldDirty: true });
            }}
          >
            <SelectTrigger size="sm" className="h-8 w-40" aria-label="Breakfast availability">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unknown">Unknown</SelectItem>
              <SelectItem value="included">Included</SelectItem>
              <SelectItem value="paid">Available (paid)</SelectItem>
              <SelectItem value="none">None</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">How was the stay?</span>
          <StarRating
            label="Hotel stay rating"
            value={Number(hotel?.rating) || 0}
            onChange={(n) => {
              const cur = (getValues(h as Name) as Record<string, unknown>) || {};
              const next = { ...cur };
              if (n) next.rating = n;
              else delete next.rating;
              setValue(h as Name, next as never, { shouldDirty: true });
            }}
          />
        </div>
      </div>
      {/* Amenity flags — informational (no ratings); ids render capitalized everywhere. */}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Hotel amenities">
        <span className="mr-0.5 text-[11px] text-muted-foreground">Amenities</span>
        {HOTEL_AMENITIES.map((a) => {
          const selected = Array.isArray(hotel?.amenities) && (hotel.amenities as unknown[]).includes(a);
          return (
            <button
              key={a}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                const cur = (getValues(h as Name) as Record<string, unknown>) || {};
                const list = Array.isArray(cur.amenities) ? (cur.amenities as string[]).filter((x) => typeof x === 'string') : [];
                const nextList = selected ? list.filter((x) => x !== a) : [...list, a];
                const next = { ...cur };
                if (nextList.length) next.amenities = nextList;
                else delete next.amenities;
                setValue(h as Name, next as never, { shouldDirty: true });
              }}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                selected
                  ? 'border-primary/60 bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted/50'
              )}
            >
              {a}
            </button>
          );
        })}
      </div>
      {/* keep `index` referenced for a stable per-row id space if needed later */}
      <span className="sr-only">Hotel for staffer {index + 1}</span>
    </fieldset>
  );
}

// ── Travel sub-editor (PII) — mode radios + two legs + flight lookup ───────────
function TravelEditor({ base, index }: { base: string; index: number }) {
  const t = `${base}.travel` as const;
  const { control, getValues, setValue } = useFormContext<EventFormValues>();
  const travel = useWatch({ control, name: t as Name }) as Record<string, unknown> | undefined;
  const mode = (travel?.mode as string) || '';
  const hasAny = !!(
    mode ||
    travel?.outbound ||
    travel?.return ||
    (Array.isArray(travel?.outboundConnections) && travel.outboundConnections.length) ||
    (Array.isArray(travel?.returnConnections) && travel.returnConnections.length)
  );
  const [expanded, setExpanded] = useState(hasAny);
  const radioName = useId();

  const setMode = (m: string) => setValue(`${t}.mode` as Name, m as never, { shouldDirty: true });
  const clear = () => {
    setValue(t as Name, {} as never, { shouldDirty: true });
    setExpanded(false);
  };
  const copyFrom = (data: unknown) => {
    setValue(t as Name, data as never, { shouldDirty: true });
    setExpanded(true);
  };

  if (!expanded) {
    // Has data → a compact summary that re-expands (no data loss); empty → the Add button.
    if (hasAny) {
      return (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Expand travel info"
          className="flex w-fit items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronDown size={14} className="-rotate-90 text-muted-foreground" aria-hidden />
          <Plane size={14} className="text-muted-foreground" aria-hidden />
          <span className="text-foreground capitalize">Travel{mode ? ` · ${mode}` : ''}</span>
        </button>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-fit text-muted-foreground"
          onClick={() => setExpanded(true)}
        >
          <Plane aria-hidden />
          Add travel info
        </Button>
        <CopyFromMenu index={index} kind="travel" onCopy={copyFrom} />
      </div>
    );
  }

  return (
    <fieldset className="grid gap-3 rounded-md border border-border bg-card p-3">
      <legend className="px-1">
        <GroupLabel>Travel</GroupLabel>
      </legend>
      <div className="flex items-center justify-between -mt-2">
        <div className="flex flex-wrap gap-4">
          {[
            { value: 'flight', label: 'Flight' },
            { value: 'train', label: 'Train' },
            { value: 'drive', label: 'Drive' },
          ].map((m) => (
            <label key={m.value} className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
              <input type="radio" name={radioName} value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
              {m.label}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <CopyFromMenu index={index} kind="travel" onCopy={copyFrom} />
          <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={clear}>
            Clear
          </Button>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Collapse travel"
            className="rounded p-1 text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronDown size={14} aria-hidden />
          </button>
        </div>
      </div>
      {mode && (
        <>
          <JourneyLegs t={t} dir="outbound" label="Outbound" mode={mode} travel={travel} getValues={getValues} setValue={setValue} />
          <JourneyLegs t={t} dir="return" label="Return" mode={mode} travel={travel} getValues={getValues} setValue={setValue} />
        </>
      )}
    </fieldset>
  );
}

// ── Multi-leg journey (a direction's primary leg + its connection legs + layovers) ──────────────
// The primary leg stays at travel.outbound|return (single-leg readers untouched); connections live in
// travel.outboundConnections|returnConnections in travel order. Between consecutive legs a computed
// layover chip shows where/how long — amber when tight (<45 min), red when the times overlap.

/** Naive 'YYYY-MM-DDTHH:MM' → ms for WALL-CLOCK ARITHMETIC (Date.UTC on the parsed fields — never
 *  the browser's local Date, whose DST transitions would skew a layover spanning them by ±1h and
 *  falsely flag/miss a tight connection). Only ever subtracted, never displayed. */
function legMs(s: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s ?? ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

function LayoverChip({ prev, next }: { prev: Record<string, unknown> | undefined; next: Record<string, unknown> | undefined }) {
  const a = legMs(prev?.arriveAt);
  const b = legMs(next?.departAt);
  if (a === null || b === null) return null;
  const min = Math.round((b - a) / 60000);
  const where = String(prev?.arriveLocation ?? '').trim();
  const dur = min < 0 ? '' : min >= 60 ? `${Math.floor(min / 60)}h ${min % 60 ? `${min % 60}m` : ''}`.trim() : `${min}m`;
  const tone = min < 0 ? 'var(--destructive)' : min < 45 ? 'var(--warning)' : 'var(--muted-foreground)';
  return (
    <div className="flex items-center gap-2 pl-3 text-[11px]" style={{ color: tone }} aria-live="polite">
      <span aria-hidden>↳</span>
      {min < 0
        ? `Connection departs before the previous leg lands${where ? ` in ${where}` : ''} — check the times`
        : `Layover${where ? ` in ${where}` : ''} · ${dur}${min < 45 ? ' — tight connection' : ''}`}
    </div>
  );
}

function JourneyLegs({
  t,
  dir,
  label,
  mode,
  travel,
  getValues,
  setValue,
}: {
  t: string;
  dir: 'outbound' | 'return';
  label: string;
  mode: string;
  travel: Record<string, unknown> | undefined;
  getValues: ReturnType<typeof useFormContext<EventFormValues>>['getValues'];
  setValue: ReturnType<typeof useFormContext<EventFormValues>>['setValue'];
}) {
  const connsPath = `${t}.${dir}Connections`;
  const conns = (Array.isArray(travel?.[`${dir}Connections`]) ? (travel![`${dir}Connections`] as Record<string, unknown>[]) : []);
  const primary = travel?.[dir] as Record<string, unknown> | undefined;

  // STABLE per-leg keys (not the array index): on a middle removal the RHF values shift down one
  // slot, and an index key would keep the OLD component instance (with its note/busy/lastAutoNum
  // local state) rendering the SHIFTED-IN leg's data — wrong lookup captions under another leg's PII
  // and a silently-suppressed auto-lookup. The uid list mirrors the conns array: appended on growth,
  // spliced in removeConn, trimmed on external shrink (a Copy-from replace).
  const uidSeq = useRef(0);
  const uidsRef = useRef<string[]>([]);
  while (uidsRef.current.length < conns.length) uidsRef.current.push(`leg-${uidSeq.current++}`);
  if (uidsRef.current.length > conns.length) uidsRef.current.length = conns.length;

  const addConn = () => {
    const cur = (getValues(connsPath as Name) as unknown[]) || [];
    setValue(connsPath as Name, [...(Array.isArray(cur) ? cur : []), {}] as never, { shouldDirty: true });
  };
  const removeConn = (i: number) => {
    uidsRef.current.splice(i, 1); // keep uid↔leg pairing across the shift
    const cur = (getValues(connsPath as Name) as unknown[]) || [];
    setValue(connsPath as Name, (Array.isArray(cur) ? cur : []).filter((_, x) => x !== i) as never, { shouldDirty: true });
  };

  return (
    <div className="grid gap-2">
      <TravelLeg base={`${t}.${dir}`} label={label} mode={mode} getValues={getValues} setValue={setValue} />
      {conns.map((_, i) => (
        <React.Fragment key={uidsRef.current[i] ?? `${dir}-conn-${i}`}>
          <LayoverChip prev={i === 0 ? primary : conns[i - 1]} next={conns[i]} />
          <TravelLeg
            base={`${connsPath}.${i}`}
            label={`${label} · leg ${i + 2}`}
            mode={mode}
            getValues={getValues}
            setValue={setValue}
            onRemove={() => removeConn(i)}
          />
        </React.Fragment>
      ))}
      {mode !== 'drive' && (
        <Button type="button" variant="ghost" size="xs" className="w-fit text-muted-foreground" onClick={addConn}>
          <Plus aria-hidden />
          Add connection
        </Button>
      )}
    </div>
  );
}

// One travel leg. Module-scope identity keeps focus (no local-draft-on-blur hack needed — RHF holds
// the value). Flight mode shows a "Look up flight" button (when the provider is wired) that calls the
// server proxy + fills blanks; when NOT wired, it flags the key. Auto-lookup on a plausible flight #.
function TravelLeg({
  base,
  label,
  mode,
  getValues,
  setValue,
  onRemove,
}: {
  base: string;
  label: string;
  mode: string;
  getValues: ReturnType<typeof useFormContext<EventFormValues>>['getValues'];
  setValue: ReturnType<typeof useFormContext<EventFormValues>>['setValue'];
  /** Present on CONNECTION legs — renders the ✕ that removes this leg from the journey. */
  onRemove?: () => void;
}) {
  const { control } = useFormContext<EventFormValues>();
  const { flightLookupAvailable } = useEditorContext();
  const isDrive = mode === 'drive';
  const isFlight = mode === 'flight';
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const lastAutoNum = useRef('');

  const legNumber = useWatch({ control, name: `${base}.number` as Name }) as string | undefined;
  const legCarrier = useWatch({ control, name: `${base}.carrier` as Name }) as string | undefined;
  const legDepartLoc = useWatch({ control, name: `${base}.departLocation` as Name }) as string | undefined;
  const legArriveLoc = useWatch({ control, name: `${base}.arriveLocation` as Name }) as string | undefined;
  const legDepartAt = useWatch({ control, name: `${base}.departAt` as Name }) as string | undefined;

  const carrierLabel = isFlight ? 'Airline' : mode === 'train' ? 'Operator' : 'Vehicle / driver';
  const numberLabel = isFlight ? 'Flight #' : mode === 'train' ? 'Train #' : 'Plate / vehicle';
  const locLabel = (isFlight ? 'airport' : mode === 'train' ? 'station' : 'location');

  const applyLeg = useCallback(
    (looked: FlightLeg, auto: boolean, forNum: string) => {
      // PIN the async write to the leg the lookup was launched FOR: `base` is a positional path, and
      // between launch and resolve the user may have removed a connection (shifting another leg into
      // this index) or removed this leg entirely. If the leg now at `base` doesn't still carry the
      // looked-up flight number, drop the result — never fill another flight's data into it, never
      // resurrect a removed row. (Same number-pin the flight-refresh write filter uses server-side.)
      const norm = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
      const curLeg = (getValues(base as Name) as Record<string, unknown>) || {};
      if (norm(curLeg.number) !== norm(forNum)) return;
      let next: Record<string, unknown>;
      if (auto) {
        // Fill only blanks — preserve everything the user already entered.
        next = { ...curLeg };
        for (const k of Object.keys(looked) as (keyof FlightLeg)[]) {
          if (next[k] == null || next[k] === '') next[k] = looked[k];
        }
      } else {
        // Manual: replace with looked-up values, keep the user's confirmation #.
        next = { ...looked, confirmation: (curLeg.confirmation as string) || looked.confirmation || '' };
      }
      setValue(base as Name, next as never, { shouldDirty: true });
    },
    [base, getValues, setValue]
  );

  const doLookup = useCallback(
    async (auto: boolean) => {
      const num = (legNumber || '').trim();
      if (!num) {
        if (!auto) setNote('Enter a flight number first.');
        return;
      }
      const date = (legDepartAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
      setBusy(true);
      setNote('');
      try {
        const r = await lookupFlightAction(num, date);
        if (!r.available) {
          if (!auto) setNote('Flight lookup is not configured.');
          return;
        }
        if (!r.leg) {
          if (!auto) setNote('No matching flight for that number + date.');
          return;
        }
        applyLeg(r.leg, auto, num);
        setNote(auto ? `Auto-filled ${num.toUpperCase()}.` : `Filled ${num.toUpperCase()} from flight data.`);
      } catch (e) {
        if (!auto) setNote('Flight lookup failed: ' + (e instanceof Error ? e.message : String(e)));
      } finally {
        setBusy(false);
      }
    },
    [legNumber, legDepartAt, applyLeg]
  );

  // Auto flight lookup (#15): debounced, fill-blanks-only, fires once per plausible flight number,
  // skipped when the leg already looks complete (so we never clobber typed data or make a needless call).
  useEffect(() => {
    if (!isFlight || !flightLookupAvailable) return;
    if (legCarrier && legDepartLoc && legArriveLoc) return; // already filled
    const num = (legNumber || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9]{2}\d{1,4}$/.test(num)) return;
    if (num === lastAutoNum.current) return;
    const tmr = setTimeout(() => {
      lastAutoNum.current = num;
      void doLookup(true);
    }, 1200);
    return () => clearTimeout(tmr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legNumber, legDepartAt, isFlight, flightLookupAvailable]);

  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <GroupLabel>{label}</GroupLabel>
        <span className="inline-flex items-center gap-2">
          {isFlight && flightLookupAvailable && (
            <>
              {busy && <span className="text-[10px] text-muted-foreground">looking up…</span>}
              <Button type="button" variant="secondary" size="xs" disabled={busy} onClick={() => doLookup(false)}>
                Look up flight
              </Button>
            </>
          )}
          {isFlight && !flightLookupAvailable && (
            <span className="text-[10px] text-muted-foreground" title="No flight-lookup key configured">
              Set a FlightAware AeroAPI key to auto-fill flights
            </span>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${label}`}
              title="Remove this connection"
              className="rounded p-1 text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </span>
      </div>
      {!isDrive && (
        <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr_1fr]">
          <BareInput name={`${base}.carrier` as Name} placeholder={carrierLabel} ariaLabel={`${label} ${carrierLabel}`} />
          <BareInput name={`${base}.number` as Name} placeholder={numberLabel} ariaLabel={`${label} ${numberLabel}`} />
          <BareInput name={`${base}.confirmation` as Name} placeholder="Confirmation #" ariaLabel={`${label} confirmation`} />
        </div>
      )}
      {/* #92: ONE grid in ROW order so DOM order == Tab order (locations row, then dates row). */}
      <div className="grid gap-3 sm:grid-cols-2">
        <BareInput name={`${base}.departLocation` as Name} placeholder={`Depart from (${locLabel})`} ariaLabel={`${label} depart from`} />
        <BareInput name={`${base}.arriveLocation` as Name} placeholder={`Arrive at (${locLabel})`} ariaLabel={`${label} arrive at`} />
        <BareInput name={`${base}.departAt` as Name} type="datetime-local" ariaLabel={`${label} depart date`} />
        <BareInput name={`${base}.arriveAt` as Name} type="datetime-local" ariaLabel={`${label} arrive date`} />
      </div>
      <BareInput name={`${base}.notes` as Name} placeholder="Notes (e.g. seat, layover, parking)" ariaLabel={`${label} notes`} />
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

// ── Packing panel — assigned cases grid + pallets ──────────────────────────────
export function PackingPanel() {
  return (
    <div>
      <FieldGroup title="Road cases">
        <FormItem>
          <FormLabel>Assigned cases</FormLabel>
          <FormDescription>Pick from the case catalog. Item-level contents come from scan-pack.</FormDescription>
          <CasesGrid />
        </FormItem>
      </FieldGroup>
      <PalletsSection />
    </div>
  );
}

// The assigned-cases checkbox grid — reuses the Manifest assign-cases availability logic (the lock).
function CasesGrid() {
  const { control, setValue, getValues } = useFormContext<EventFormValues>();
  const { cases } = useEditorContext();
  const assigned = (useWatch({ control, name: 'cases' }) as string[] | undefined) ?? [];
  const assignedSet = new Set(assigned);

  // Retired cases are excluded unless already assigned to THIS event (Python parity).
  const visible = cases.filter((c) => !c.retired || assignedSet.has(c.id));

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...assigned, id] : assigned.filter((x) => x !== id);
    // Prune any now-removed case from its pallet (the #24 FK cleanup; also enforced server-side).
    const pallets = (getValues('pallets') as EventFormValues['pallets']) || [];
    const validSet = new Set(next);
    const prunedPallets = pallets.map((p) => ({ ...p, caseIds: (p.caseIds || []).filter((cid) => validSet.has(cid)) }));
    setValue('cases', next, { shouldDirty: true });
    setValue('pallets', prunedPallets, { shouldDirty: true });
  };

  if (visible.length === 0) {
    return <p className="text-sm text-muted-foreground">No cases in the catalog yet.</p>;
  }

  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
      {visible.map((c) => {
        const sel = assignedSet.has(c.id);
        const locked = c.unavailable && !sel;
        return (
          <label
            key={c.id}
            className={cn(
              'flex items-center gap-2 rounded-md border px-2.5 py-2 transition-colors',
              locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
              sel ? 'border-primary bg-primary/8' : 'border-border bg-muted/30 hover:bg-muted'
            )}
          >
            <Checkbox
              checked={sel}
              disabled={locked}
              onCheckedChange={(v) => !locked && toggle(c.id, v === true)}
              aria-label={`Assign ${c.label}`}
            />
            <div className="min-w-0 flex-1">
              {c.slug ? <div className="truncate font-mono text-[10px] text-muted-foreground">{c.slug}</div> : null}
              <div className="truncate text-xs text-foreground">{c.label}</div>
              {locked && (
                <div className="mt-0.5 flex items-center gap-1 text-[10px]" style={{ color: 'var(--warning)' }}>
                  <Lock aria-hidden className="size-2.5" /> {c.statusLabel}
                </div>
              )}
            </div>
          </label>
        );
      })}
    </div>
  );
}

// ── Pallets editor — add/rename/remove, assign cases (select + drag-drop), tracking ─────────────
function newPalletId(): string {
  return 'pallet-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function PalletsSection() {
  const { control, setValue } = useFormContext<EventFormValues>();
  const { caseLabelById } = useEditorContext();
  const pallets = (useWatch({ control, name: 'pallets' }) as EventFormValues['pallets'] | undefined) ?? [];
  const cases = (useWatch({ control, name: 'cases' }) as string[] | undefined) ?? [];

  const palletForCase = (cid: string) => pallets.find((p) => (p.caseIds || []).includes(cid)) || null;
  const looseCaseIds = cases.filter((cid) => !palletForCase(cid));

  const writePallets = (next: EventFormValues['pallets']) => setValue('pallets', next, { shouldDirty: true });

  const addPallet = () => {
    writePallets([
      ...pallets,
      { id: newPalletId(), label: `Pallet ${pallets.length + 1}`, caseIds: [], tracking: '', notes: '' },
    ]);
  };
  const removePallet = (id: string) => writePallets(pallets.filter((p) => p.id !== id));
  const renamePallet = (id: string, label: string) =>
    writePallets(pallets.map((p) => (p.id === id ? { ...p, label } : p)));
  const setTracking = (id: string, tracking: string) =>
    writePallets(pallets.map((p) => (p.id === id ? { ...p, tracking } : p)));
  const assignCaseToPallet = (cid: string, palletId: string | null) => {
    const next = pallets.map((p) => ({ ...p, caseIds: (p.caseIds || []).filter((x) => x !== cid) }));
    if (palletId) {
      const target = next.find((p) => p.id === palletId);
      if (target && !target.caseIds.includes(cid)) target.caseIds.push(cid);
    }
    writePallets(next);
  };

  const summary = `${pallets.length} ${pallets.length === 1 ? 'pallet' : 'pallets'} · ${looseCaseIds.length} loose ${looseCaseIds.length === 1 ? 'case' : 'cases'}`;
  const labelOf = (cid: string) => caseLabelById[cid] || cid;

  // HTML5 drag-drop (a desktop progressive enhancement; the <select> rows are the keyboard/touch fallback).
  const onDragStart = (e: React.DragEvent, cid: string) => {
    e.dataTransfer.setData('text/plain', cid);
    e.dataTransfer.effectAllowed = 'move';
  };
  const dropTo = (palletId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).style.outline = '';
    const cid = e.dataTransfer.getData('text/plain');
    if (cid) assignCaseToPallet(cid, palletId);
  };
  const dragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const dragEnter = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.outline = '2px dashed var(--primary)';
    (e.currentTarget as HTMLElement).style.outlineOffset = '2px';
  };
  const dragLeave = (e: React.DragEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (!el.contains(e.relatedTarget as Node)) el.style.outline = '';
  };

  return (
    <FieldGroup
      title="Pallets"
      action={
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">{summary}</span>
          {cases.length > 0 && (
            <Button type="button" size="sm" variant="secondary" onClick={addPallet}>
              <Plus aria-hidden />
              Add pallet
            </Button>
          )}
        </div>
      }
    >
      <FormDescription>
        Group roadcases into pallets for the carrier. Logistics only — item contents are unchanged. Unpalletized cases
        ship loose. Drag a case chip between pallets (desktop), or use the menus below.
      </FormDescription>

      {cases.length === 0 ? (
        <p className="text-xs text-muted-foreground">Assign roadcases to this event first, then group them into pallets here.</p>
      ) : (
        <div className="grid gap-2">
          {pallets.map((p) => (
            <div
              key={p.id}
              onDragOver={dragOver}
              onDragEnter={dragEnter}
              onDragLeave={dragLeave}
              onDrop={dropTo(p.id)}
              className="grid gap-2 rounded-md border border-border bg-muted/30 p-3"
            >
              <div className="grid items-center gap-2 sm:grid-cols-[1fr_auto_auto]">
                <Input
                  value={p.label}
                  placeholder="Pallet label"
                  aria-label="Pallet label"
                  onChange={(e) => renamePallet(p.id, e.target.value)}
                />
                <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                  {(p.caseIds || []).length} {(p.caseIds || []).length === 1 ? 'case' : 'cases'}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="border-destructive text-destructive hover:bg-destructive/10"
                  title="Remove pallet (its cases become loose)"
                  aria-label="Remove pallet"
                  onClick={() => removePallet(p.id)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
              <FormItem>
                <FormLabel className="text-[11px]">Tracking #</FormLabel>
                <Input
                  value={p.tracking}
                  placeholder="Optional — per-pallet LTL / freight #"
                  aria-label="Pallet tracking number"
                  className="font-mono"
                  onChange={(e) => setTracking(p.id, e.target.value)}
                />
              </FormItem>
              <div className="flex flex-wrap gap-1.5">
                {(p.caseIds || []).length === 0 ? (
                  <span className="text-[11px] italic text-muted-foreground">No cases yet — assign below.</span>
                ) : (
                  (p.caseIds || []).map((cid) => (
                    <span
                      key={cid}
                      draggable
                      onDragStart={(e) => onDragStart(e, cid)}
                      className="inline-flex cursor-grab items-center gap-1 rounded border border-border bg-background py-0.5 pl-2 pr-1 text-[11px] text-foreground"
                    >
                      {labelOf(cid)}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-4 text-muted-foreground"
                        title="Make loose"
                        aria-label={`Make ${labelOf(cid)} loose`}
                        onClick={() => assignCaseToPallet(cid, null)}
                      >
                        <X aria-hidden className="size-3" />
                      </Button>
                    </span>
                  ))
                )}
              </div>
            </div>
          ))}

          {/* Loose drop zone */}
          <div
            onDragOver={dragOver}
            onDragEnter={dragEnter}
            onDragLeave={dragLeave}
            onDrop={dropTo(null)}
            className="rounded-md border border-dashed border-border bg-muted/30 p-3"
          >
            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Loose (unpalletized) · {looseCaseIds.length}
            </div>
            {looseCaseIds.length === 0 ? (
              <span className="text-[11px] italic text-muted-foreground">All cases are on a pallet.</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {looseCaseIds.map((cid) => (
                  <span
                    key={cid}
                    draggable
                    onDragStart={(e) => onDragStart(e, cid)}
                    className="cursor-grab rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground"
                  >
                    {labelOf(cid)}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Menu fallback (keyboard / touch) — assign each case to a pallet via a select. */}
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              Assign cases with menus (keyboard / no-drag)
            </summary>
            <div className="mt-2 grid gap-1.5">
              {cases.map((cid) => {
                const cur = palletForCase(cid);
                return (
                  <div key={cid} className="grid items-center gap-2 sm:grid-cols-[1fr_180px]">
                    <span className="truncate text-xs text-foreground">{labelOf(cid)}</span>
                    <Select
                      value={cur ? cur.id : '__loose__'}
                      onValueChange={(v) => assignCaseToPallet(cid, v === '__loose__' ? null : v)}
                    >
                      <SelectTrigger className="w-full" aria-label={`Pallet for ${labelOf(cid)}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__loose__">— Loose —</SelectItem>
                        {pallets.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.label || 'Pallet'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </details>
        </div>
      )}
    </FieldGroup>
  );
}

// ── Shipping panel ────────────────────────────────────────────────────────────
export function ShippingPanel() {
  // Soft return-shipping nudge: once outbound shipping is being entered, remind the user to verify a
  // RETURN pickup is requested (or confirm the items aren't coming back). It's advisory only — it
  // never blocks save, and it self-clears the moment any return field is filled.
  const { control } = useFormContext<EventFormValues>();
  const watched = useWatch({
    control,
    name: ['outbound.carrier', 'outbound.tracking', 'outbound.pickupDate', 'return.carrier', 'return.tracking', 'return.arrivalDate'],
  }) as (string | undefined)[];
  const filled = (...vals: (string | undefined)[]) => vals.some((v) => !!String(v ?? '').trim());
  const outboundStarted = filled(watched[0], watched[1], watched[2]);
  const returnStarted = filled(watched[3], watched[4], watched[5]);
  const remindReturn = outboundStarted && !returnStarted;
  return (
    <div>
      <FieldGroup title="Outbound shipping">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="outbound.carrier" label="Carrier" />
          <TextField name="outbound.tracking" label="Tracking #" mono />
        </div>
        <FormItem>
          <FormLabel>Pickup</FormLabel>
          <FormDescription>When the carrier picks up from the warehouse.</FormDescription>
          <div className="grid gap-3 sm:grid-cols-2">
            <BareInput name="outbound.pickupDate" type="date" ariaLabel="Outbound pickup date" />
            <BareInput name="outbound.pickupTime" type="time" ariaLabel="Outbound pickup time" />
          </div>
        </FormItem>
        <NotesField name="outbound.notes" placeholder="Loading dock instructions, special handling, etc." />
      </FieldGroup>

      {remindReturn ? (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm" role="note">
          <Truck className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div>
            <span className="font-medium text-warning">Don’t forget the return.</span>{' '}
            <span className="text-foreground">
              Verify return shipping has been requested — or confirm these items aren’t coming back (e.g. consumables or sold
              stock).
            </span>
          </div>
        </div>
      ) : null}

      <FieldGroup title="Return shipping">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="return.carrier" label="Carrier" />
          <TextField name="return.tracking" label="Tracking #" mono />
        </div>
        <FormItem>
          <FormLabel>Arrival</FormLabel>
          <FormDescription>When the cases should land back at the warehouse.</FormDescription>
          <div className="grid gap-3 sm:grid-cols-2">
            <BareInput name="return.arrivalDate" type="date" ariaLabel="Return arrival date" />
            <BareInput name="return.arrivalTime" type="time" ariaLabel="Return arrival time" />
          </div>
        </FormItem>
        <NotesField name="return.notes" placeholder="Return logistics, reconciliation deadline, etc." />
      </FieldGroup>
    </div>
  );
}

function NotesField({ name, placeholder }: { name: Name; placeholder?: string }) {
  const { control } = useFormContext<EventFormValues>();
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Notes</FormLabel>
          <FormControl>
            <Textarea
              {...field}
              value={typeof field.value === 'string' ? field.value : ''}
              placeholder={placeholder}
              rows={2}
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

// ── Side events panel ─────────────────────────────────────────────────────────
export function SidePanel() {
  const { control } = useFormContext<EventFormValues>();
  const { fields, append, remove } = useFieldArray({ control, name: 'sideEvents' });
  return (
    <FieldGroup title="Side events">
      <FormDescription>
        Optional after-parties / community events — welcome receptions, meet-ups, dinners.
      </FormDescription>
      {fields.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No side events yet.
        </div>
      ) : (
        <div className="grid gap-3">
          {fields.map((f, i) => (
            <div key={f.id} className="grid gap-2 rounded-md border border-border bg-muted/30 p-3">
              <div className="grid items-center gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
                <BareInput name={`sideEvents.${i}.name` as Name} placeholder="Name (e.g. Welcome reception)" ariaLabel={`Side event ${i + 1} name`} />
                <BareInput name={`sideEvents.${i}.date` as Name} type="date" ariaLabel={`Side event ${i + 1} date`} />
                <BareInput name={`sideEvents.${i}.time` as Name} type="time" ariaLabel={`Side event ${i + 1} time`} />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon-sm"
                  onClick={() => remove(i)}
                  aria-label={`Remove side event ${i + 1}`}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
              <BareInput name={`sideEvents.${i}.venue` as Name} placeholder="Venue" ariaLabel={`Side event ${i + 1} venue`} />
              <BareInput name={`sideEvents.${i}.notes` as Name} placeholder="Notes" ariaLabel={`Side event ${i + 1} notes`} />
            </div>
          ))}
        </div>
      )}
      <div>
        <Button type="button" size="sm" variant="secondary" onClick={() => append({ name: '', date: '', time: '', venue: '', notes: '' })}>
          <Plus aria-hidden />
          Add side event
        </Button>
      </div>
    </FieldGroup>
  );
}
