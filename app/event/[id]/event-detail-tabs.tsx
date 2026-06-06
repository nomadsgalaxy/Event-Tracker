'use client';

import { useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  Pencil,
  Layers,
  Trash2,
  Boxes,
  QrCode,
  Plane,
  Hotel,
  ShieldCheck,
  Bell,
  Printer,
  ExternalLink,
  TriangleAlert,
  ChevronRight,
  MapPin,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { TagChip } from '@/components/ui/tag-chip';
import { TrackingBadge } from '@/components/ui/tracking-badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Eyebrow } from '@/components/ui/eyebrow';
import { WeatherChip } from '@/components/ui/weather-chip';
import { cn } from '@/lib/utils';
import type { EventForecastRow } from '@/lib/types-dashboard';
import type {
  EventPayload,
  EventState,
  HotelInfo,
  TravelInfo,
  TravelLeg,
  AccommodationsProfile,
} from '@/lib/types';
import type { EventDetailView, StaffCardView } from '@/lib/types-event-detail';
import { toast } from 'sonner';
import { deleteEventAction, markEventOnsiteAction } from '@/app/event/actions';
import { requestTravelInfoAction } from '@/app/notifications/actions';

// app/event/[id]/event-detail-tabs.tsx — the CLIENT shell for the Event DETAIL view.
//
// The payload is ALREADY PII-stripped server-side (any staffer without hotel/travel here means the
// viewer wasn't allowed to see it) and every derived view is precomputed in lib/event-detail-view —
// this component ONLY renders + handles the local interactions (tab switch, Delete confirm, the
// event Data-Matrix modal, the Manifest-CSV download, the Request-travel-info button). It never
// decides access.
//
// #93 GUARANTEE: every tab panel is kept MOUNTED (display:none toggling), not conditionally
// unmounted — the same structural contract as the editor, so a future inline edit inherits it.

const EV_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'team', label: 'Team & Travel' },
  { id: 'packing', label: 'Packing' },
  { id: 'shipping', label: 'Shipping' },
  { id: 'side', label: 'Side events' },
] as const;

type TabId = (typeof EV_TABS)[number]['id'];

// ── Small shared bits ────────────────────────────────────────────────────────────────────────
function FieldGroup({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-4 rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Eyebrow asChild>
          <h2>{title}</h2>
        </Eyebrow>
        {action}
      </div>
      {children}
    </section>
  );
}

function DataRow({ label, value, mono }: { label: string; value?: ReactNode; mono?: boolean }) {
  const empty = value === undefined || value === null || value === '';
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 border-b border-border py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'min-w-0 break-words text-foreground',
          mono && 'font-mono text-[0.8rem] tabular-nums',
          empty && 'text-muted-foreground'
        )}
      >
        {empty ? '—' : value}
      </span>
    </div>
  );
}

function EmptyBlock({ children }: { children: ReactNode }) {
  return <div className="py-2 text-sm text-muted-foreground">{children}</div>;
}

function venueStr(v: EventPayload['venue'], key: string): string {
  const raw = v?.[key];
  return raw == null || raw === '' ? '' : String(raw);
}

// Date helpers — the live data stores YYYY-MM-DD; we keep the locale-stable display the rest of the
// Next.js port uses (DESIGN_ALIGNMENT: window.formatDate equivalent; no client-only Date during the
// initial render so the strings are deterministic). datetime-local windows render their stored form.
function fmtDate(d?: string): string {
  return d || '';
}

function fmtDateTimeLocal(s?: string): string {
  // "2026-06-12T12:00" → "2026-06-12 · 12:00" (deterministic, no locale/timezone read).
  if (!s) return '';
  const [date, time] = String(s).split('T');
  if (!time) return date;
  return `${date} · ${time.slice(0, 5)}`;
}

function fmtDTRange(start?: string, end?: string): string {
  if (!start) return '';
  if (!end) return fmtDateTimeLocal(start);
  const s = fmtDateTimeLocal(start);
  const [sd] = String(start).split('T');
  const [ed, et] = String(end).split('T');
  // Same calendar day → collapse to "… · 12:00 → 17:00".
  if (sd === ed && et) return `${s} → ${et.slice(0, 5)}`;
  return `${s} → ${fmtDateTimeLocal(end)}`;
}

function fmtPickup(date?: string, time?: string): string {
  if (!date) return '';
  return time ? `${date} · ${time.slice(0, 5)}` : date;
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}

function legSummary(leg: TravelLeg | undefined): ReactNode {
  if (!leg) return null;
  if (!(leg.carrier || leg.number || leg.departLocation || leg.arriveLocation || leg.departAt)) return null;
  const route =
    leg.departLocation || leg.arriveLocation ? (
      <span className="text-foreground">
        {leg.departLocation || '?'} → {leg.arriveLocation || '?'}
      </span>
    ) : null;
  const carrier = [leg.carrier, leg.number].filter(Boolean).join(' ');
  return (
    <>
      {route}
      {carrier ? <span className="text-muted-foreground"> · {carrier}</span> : null}
      {leg.confirmation ? <span className="text-muted-foreground"> · conf {leg.confirmation}</span> : null}
    </>
  );
}

// ── Tab strip ──────────────────────────────────────────────────────────────────────────────────
function TabStrip({ active, onSelect }: { active: TabId; onSelect: (id: TabId) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Event sections"
      className="mb-4 flex flex-wrap gap-0.5 border-b border-border"
    >
      {EV_TABS.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(t.id)}
            className={cn(
              '-mb-px cursor-pointer px-3.5 py-2 text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
              isActive
                ? 'border-b-2 border-primary text-foreground'
                : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────────────────────────
function ForecastStrip({ rows, tempUnit = 'F' }: { rows: EventForecastRow[]; tempUnit?: 'C' | 'F' }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-4">
      <Eyebrow asChild>
        <h3>Forecast at venue</h3>
      </Eyebrow>
      <div className="mt-2 flex flex-wrap gap-2">
        {rows.map((row) => {
          const isData = row.status === 'data';
          const note =
            row.status === 'beyond' ? 'Beyond 10-day forecast' : row.status === 'past' ? '—' : 'No data yet';
          return (
            <div
              key={row.ymd}
              title={isData && row.w ? row.w.label : note}
              className={cn(
                'flex items-center gap-1.5 rounded border border-border bg-muted/40 px-2.5 py-1.5',
                !isData && 'opacity-55'
              )}
            >
              <div className="flex flex-col leading-tight">
                <span className="font-mono text-[10px] text-muted-foreground">{row.label}</span>
                {isData && row.w ? (
                  <WeatherChip w={row.w} unit={tempUnit} className="text-foreground" />
                ) : (
                  <span className="text-xs text-muted-foreground">{note}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">
        Forecast updates every 6 hours. Google Weather shows up to 10 days out.
      </div>
    </div>
  );
}

function OverviewPanel({ p, forecastRows, tempUnit = 'F' }: { p: EventPayload; forecastRows: EventForecastRow[]; tempUnit?: 'C' | 'F' }) {
  const v = p.venue;
  const cityLine = [venueStr(v, 'city'), venueStr(v, 'state'), venueStr(v, 'zip')].filter(Boolean).join(' · ');
  const website = p.website || venueStr(v, 'website');
  const amenities = Array.isArray(v?.amenities) ? v!.amenities.filter(Boolean) : [];
  const contact = v?.contact;
  const booth = [venueStr(v, 'booth') || '—', venueStr(v, 'boothSize') || '—'].join(' · ');
  return (
    <>
      <FieldGroup title="Schedule">
        <DataRow label="Start" value={fmtDate(p.startDate)} />
        <DataRow label="End" value={fmtDate(p.endDate)} />
        <DataRow label="Doors" value={`${p.doorsOpen || '—'} – ${p.doorsClose || '—'}`} mono />
        <DataRow label="Setup" value={fmtDTRange(p.setup?.start, p.setup?.end)} mono />
        <DataRow label="Teardown" value={fmtDTRange(p.teardown?.start, p.teardown?.end)} mono />
      </FieldGroup>

      <FieldGroup title="Venue">
        <DataRow label="Name" value={venueStr(v, 'name')} />
        <DataRow
          label="Website"
          value={
            website ? (
              <a
                href={website}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 break-all text-primary hover:underline"
              >
                {website}
                <ExternalLink aria-hidden className="size-3 shrink-0" />
              </a>
            ) : (
              ''
            )
          }
        />
        <DataRow label="Address" value={venueStr(v, 'address')} />
        <DataRow label="City / State / ZIP" value={cityLine} />
        <DataRow label="Booth" value={booth} mono />
        <DataRow
          label="Amenities"
          value={amenities.length ? amenities.join(' · ') : ''}
        />

        <ForecastStrip rows={forecastRows} tempUnit={tempUnit} />

        <div className="mt-4">
          <Eyebrow asChild>
            <h3>Point of contact</h3>
          </Eyebrow>
          <div className="mt-2">
            <DataRow label="Name" value={contact?.name} />
            <DataRow label="Role" value={contact?.role} />
            <DataRow
              label="Email"
              mono
              value={
                contact?.email ? (
                  <a href={`mailto:${contact.email}`} className="text-primary hover:underline">
                    {contact.email}
                  </a>
                ) : (
                  ''
                )
              }
            />
            <DataRow
              label="Phone"
              mono
              value={
                contact?.phone ? (
                  <a href={`tel:${contact.phone}`} className="text-primary hover:underline">
                    {contact.phone}
                  </a>
                ) : (
                  ''
                )
              }
            />
          </div>
        </div>
      </FieldGroup>
    </>
  );
}

// ── Team & Travel tab ────────────────────────────────────────────────────────────────────────
function HotelBlock({ hotel }: { hotel: HotelInfo }) {
  const addressLine = [hotel.address, hotel.city, hotel.state].filter(Boolean).join(', ');
  const mapsUrl = hotel.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        [hotel.address, hotel.city, hotel.state, hotel.zip].filter(Boolean).join(' ')
      )}`
    : '';
  return (
    <div className="flex flex-col gap-1 pl-9 text-xs text-muted-foreground">
      <div className="flex items-start gap-2">
        <Hotel aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          <span className="text-muted-foreground/80">Hotel: </span>
          <span className="text-foreground">{hotel.name || '(unnamed)'}</span>
          {hotel.room ? <span> · room {String(hotel.room)}</span> : null}
        </span>
      </div>
      {addressLine && (
        <div className="pl-[22px]">
          <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            {addressLine}
          </a>
        </div>
      )}
      {hotel.phone && (
        <div className="pl-[22px]">
          <a href={`tel:${hotel.phone}`} className="text-primary hover:underline">
            ☎ {hotel.phone}
          </a>
        </div>
      )}
    </div>
  );
}

function TravelBlock({ travel }: { travel: TravelInfo }) {
  if (!travel || !(travel.outbound || travel.return)) return null;
  const modeLabel =
    travel.mode === 'flight'
      ? 'Flight'
      : travel.mode === 'train'
        ? 'Train'
        : travel.mode === 'drive'
          ? 'Drive'
          : 'Travel';
  const out = legSummary(travel.outbound);
  const ret = legSummary(travel.return);
  return (
    <div className="flex flex-col gap-1 pl-9 text-xs text-muted-foreground">
      <div className="flex items-start gap-2">
        <Plane aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          <span className="text-muted-foreground/80">Travel · </span>
          <span className="text-foreground">{modeLabel}</span>
        </span>
      </div>
      {out && (
        <div className="pl-[22px]">
          <span className="text-muted-foreground/80">Out: </span>
          {out}
        </div>
      )}
      {ret && (
        <div className="pl-[22px]">
          <span className="text-muted-foreground/80">Return: </span>
          {ret}
        </div>
      )}
    </div>
  );
}

function AccommodationsBlock({ acc }: { acc: AccommodationsProfile }) {
  const dietary = Array.isArray(acc.dietary) ? acc.dietary : [];
  const accessibility = Array.isArray(acc.accessibility) ? acc.accessibility : [];
  const allergies = acc.allergies && acc.allergies.text ? acc.allergies : null;
  const contacts = [
    ...(acc.emergencyContact ? [acc.emergencyContact] : []),
    ...(Array.isArray(acc.emergencyContacts) ? acc.emergencyContacts : []),
  ].filter((c) => c && (c.name || c.phone));
  const hasAny =
    dietary.length || accessibility.length || allergies || acc.medical || acc.notes || contacts.length;
  if (!hasAny) return null;
  const sevColor: Record<string, string> = {
    mild: 'text-muted-foreground',
    severe: 'text-warning',
    epipen: 'text-destructive',
  };
  return (
    <div className="ml-9 mt-1 rounded border border-border bg-muted/40 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <Eyebrow asChild>
          <span>Accommodations</span>
        </Eyebrow>
        <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Private</span>
      </div>
      <div className="flex flex-col gap-1.5 text-[11px] text-muted-foreground">
        {dietary.length > 0 && (
          <div>
            <span className="text-muted-foreground/80">Dietary: </span>
            {dietary.join(' · ')}
          </div>
        )}
        {allergies && (
          <div>
            <span className="text-muted-foreground/80">Allergies: </span>
            <span>{allergies.text}</span>
            <span className={cn('ml-1.5 text-[10px] font-bold uppercase', sevColor[allergies.severity || ''] || 'text-muted-foreground')}>
              {allergies.severity}
            </span>
          </div>
        )}
        {accessibility.length > 0 && (
          <div>
            <span className="text-muted-foreground/80">Accessibility: </span>
            {accessibility.join(' · ')}
          </div>
        )}
        {acc.medical && (
          <div>
            <span className="text-muted-foreground/80">Medical: </span>
            <span className="text-foreground">{acc.medical}</span>
          </div>
        )}
        {contacts.length > 0 && (
          <div className="border-t border-dashed border-border pt-1.5">
            <div className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">
              Emergency contact{contacts.length > 1 ? 's' : ''}
            </div>
            {contacts.map((ec, i) => (
              <div key={i} className={cn(i ? 'mt-1' : '')}>
                <div className="text-foreground">
                  {ec.name}
                  {ec.relationship ? ` · ${ec.relationship}` : ''}
                </div>
                {ec.phone && (
                  <a href={`tel:${ec.phone}`} className="text-primary hover:underline">
                    ☎ {ec.phone}
                  </a>
                )}
                {ec.email && (
                  <span className="text-muted-foreground/80">
                    {ec.phone ? ' · ' : ''}
                    {ec.email}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {acc.notes && (
          <div>
            <span className="text-muted-foreground/80">Notes: </span>
            {acc.notes}
          </div>
        )}
      </div>
    </div>
  );
}

function RequestTravelButton({
  eventId,
  subjectEmail,
  subjectName,
}: {
  eventId: string;
  subjectEmail: string;
  subjectName: string;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const send = () => {
    setState('busy');
    requestTravelInfoAction(eventId, subjectEmail).then((r) => {
      if (r.ok) {
        setState('sent');
        setMsg(r.duplicate ? 'Already requested' : 'Request sent');
      } else {
        setState('error');
        setMsg(r.error || 'Failed');
      }
    });
  };
  if (state === 'sent') {
    return (
      <div className="pl-9 text-xs text-muted-foreground">
        <Bell aria-hidden className="mr-1 inline size-3" /> {msg} — waiting on {subjectName}
      </div>
    );
  }
  return (
    <div className="pl-9">
      <Button
        variant="ghost"
        size="xs"
        disabled={state === 'busy'}
        onClick={send}
        title={`Ask ${subjectName} (or a manager) to share their travel for this event`}
        className="text-muted-foreground"
      >
        <Bell aria-hidden className="size-3" />
        {state === 'busy' ? 'Requesting…' : 'Request travel info'}
      </Button>
      {state === 'error' && <span className="ml-2 text-xs text-destructive">{msg}</span>}
    </div>
  );
}

function StaffCard({
  eventId,
  s,
  canPrintOthers,
  onPrint,
}: {
  eventId: string;
  s: StaffCardView;
  canPrintOthers: boolean;
  onPrint: (s: StaffCardView) => void;
}) {
  const name = s.name || s.email || '(no name)';
  const piiVisible = !!s.hotel || !!s.travel;
  // Per-staffer print (manager+) — only meaningful when there's something to print (PII visible).
  const showPrint = canPrintOthers && !s.isSelf && piiVisible;
  return (
    <div className="flex flex-col gap-2 rounded bg-muted/40 px-2.5 py-2">
      <div className="flex items-center gap-2.5">
        <Avatar size="sm" className={s.isLead ? 'ring-2 ring-primary/60' : undefined}>
          {s.picture ? <AvatarImage src={s.picture} alt="" referrerPolicy="no-referrer" /> : null}
          <AvatarFallback className="text-[10px] font-bold">{initialsOf(name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">
            {name}
            {s.isLead && <span className="ml-1.5 text-[10px] font-semibold text-primary">LEAD</span>}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {s.role || '—'}
            {s.email ? ` · ${s.email}` : ''}
          </div>
        </div>
        {showPrint && (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground"
            title={`Print itinerary for ${name} (this event)`}
            onClick={() => onPrint(s)}
          >
            <Printer aria-hidden className="size-3.5" />
          </Button>
        )}
        {piiVisible && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium text-warning"
            style={{ borderColor: 'var(--warning)' }}
            title="Travel / hotel shown — you're permitted to see this staffer's PII"
          >
            <ShieldCheck aria-hidden className="size-3" />
            PII
          </span>
        )}
      </div>

      {(s.onsiteStart || s.onsiteEnd) && (
        <p className="pl-9 text-[11px] text-muted-foreground">
          Onsite: {fmtDateTimeLocal(s.onsiteStart) || '?'} → {fmtDateTimeLocal(s.onsiteEnd) || '?'}
        </p>
      )}
      {s.hotel && (s.hotel.name || s.hotel.address || s.hotel.room) && <HotelBlock hotel={s.hotel} />}
      {s.travel && <TravelBlock travel={s.travel} />}
      {s.accommodations && <AccommodationsBlock acc={s.accommodations} />}
      {s.canRequest && (
        <RequestTravelButton eventId={eventId} subjectEmail={s.email} subjectName={s.name || s.email} />
      )}
    </div>
  );
}

function TeamPanel({
  eventId,
  view,
  viewerIsStaffed,
  canPrintOthers,
  onPrint,
}: {
  eventId: string;
  view: EventDetailView;
  viewerIsStaffed: boolean;
  canPrintOthers: boolean;
  onPrint: (s: StaffCardView) => void;
}) {
  const staff = view.staff;
  const me = staff.find((s) => s.isSelf);
  // "Print my itinerary" — shown when the viewer is staffed here (itinerary.print.self is a self
  // capability everyone holds for their own record).
  const myPrint =
    viewerIsStaffed && me ? (
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        title="Print your travel itinerary for this event"
        onClick={() => onPrint(me)}
      >
        <Printer aria-hidden className="size-3.5" />
        Print my itinerary
      </Button>
    ) : null;
  return (
    <FieldGroup title={`Team · ${staff.length} assigned`} action={myPrint}>
      {staff.length === 0 ? (
        <EmptyBlock>No staff assigned yet.</EmptyBlock>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {staff.map((s, i) => (
            <StaffCard key={s.email || i} eventId={eventId} s={s} canPrintOthers={canPrintOthers} onPrint={onPrint} />
          ))}
        </div>
      )}
    </FieldGroup>
  );
}

// ── Packing tab ──────────────────────────────────────────────────────────────────────────────
function CaseTile({ tile }: { tile: EventDetailView['caseTiles'][number] }) {
  return (
    <Link
      href={`/cases/${tile.id}`}
      className="flex items-center gap-2 rounded border border-transparent bg-muted/40 p-2.5 transition-colors hover:border-primary hover:bg-muted"
      title={`Open ${tile.label}`}
    >
      <Boxes aria-hidden className="size-3.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        {tile.slug && <div className="font-mono text-[10px] text-muted-foreground">{tile.slug}</div>}
        <div className="truncate text-xs text-foreground">{tile.label}</div>
        {tile.conflicts.map((cf) => (
          <div
            key={cf.eventId}
            className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-warning"
            title={`Also committed to ${cf.name} (${cf.start} to ${cf.end})`}
          >
            <TriangleAlert aria-hidden className="size-2.5 shrink-0" />
            Also committed to {cf.name} ({cf.start}→{cf.end})
          </div>
        ))}
      </div>
      <div className="flex flex-col items-end gap-0.5">
        {tile.total > 0 && (
          <span className={cn('font-mono text-[10px]', tile.flagged > 0 ? 'text-warning' : 'text-muted-foreground')}>
            {tile.packed}/{tile.total}
            {tile.flagged > 0 ? ` · ${tile.flagged}!` : ''}
          </span>
        )}
        {tile.weight && <span className="font-mono text-[10px] text-muted-foreground">{tile.weight}</span>}
      </div>
      <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/50" />
    </Link>
  );
}

function PackingPanel({ eventId, view }: { eventId: string; view: EventDetailView }) {
  const tiles = view.caseTiles;
  const loose = view.loose;
  const pallets = view.pallets;
  return (
    <>
      <FieldGroup
        title={`Road cases · ${tiles.length} assigned`}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={`/manifest?event=${encodeURIComponent(eventId)}`}>
              <Boxes aria-hidden />
              Manage
            </Link>
          </Button>
        }
      >
        {tiles.length === 0 ? (
          <EmptyBlock>No cases assigned yet.</EmptyBlock>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {tiles.map((t) => (
              <CaseTile key={t.id} tile={t} />
            ))}
          </div>
        )}
      </FieldGroup>

      <FieldGroup title={`Loose inventory · ${loose.length} ${loose.length === 1 ? 'item' : 'items'}`}>
        {loose.length === 0 ? (
          <EmptyBlock>No loose items at this event.</EmptyBlock>
        ) : (
          <div className="flex flex-col gap-1.5">
            {loose.map((row) => (
              <div
                key={row.id}
                className="flex items-center gap-2.5 rounded border border-border bg-muted/40 px-2.5 py-2"
              >
                <Boxes aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-foreground">{row.name || '(unnamed)'}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    ×{row.qty} · {row.kind || '—'}
                    {row.serials.length
                      ? ` · SN ${row.serials.slice(0, 2).join(', ')}${
                          row.serials.length > 2 ? ` +${row.serials.length - 2}` : ''
                        }`
                      : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </FieldGroup>

      {pallets.length > 0 && (
        <FieldGroup title={`Pallets · ${pallets.length}`}>
          <div className="flex flex-col gap-2">
            {pallets.map((p) => (
              <div key={p.id} className="rounded bg-muted/40 p-2.5">
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-semibold text-foreground">{p.label}</span>
                  <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                    {p.caseChips.length} {p.caseChips.length === 1 ? 'case' : 'cases'} · {p.weight}
                  </span>
                </div>
                {p.tracking && (
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">Tracking # {p.tracking}</span>
                    <TrackingBadge number={p.tracking} />
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {p.caseChips.length === 0 ? (
                    <span className="text-[11px] italic text-muted-foreground">No cases assigned.</span>
                  ) : (
                    p.caseChips.map((c) => (
                      <span
                        key={c.id}
                        className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground"
                      >
                        {c.label}
                      </span>
                    ))
                  )}
                </div>
              </div>
            ))}
            {view.palletLooseChips.length > 0 && (
              <div className="rounded border border-dashed border-border bg-muted/40 p-2.5">
                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Loose (unpalletized) · {view.palletLooseChips.length}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {view.palletLooseChips.map((c) => (
                    <span
                      key={c.id}
                      className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground"
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </FieldGroup>
      )}
    </>
  );
}

// ── Shipping tab ─────────────────────────────────────────────────────────────────────────────
function ShippingPanel({ p }: { p: EventPayload }) {
  const out = p.outbound ?? {};
  const ret = p.return ?? {};
  return (
    <>
      <FieldGroup title="Outbound shipping">
        <DataRow label="Carrier" value={out.carrier} />
        <DataRow label="Pickup" value={fmtPickup(out.pickupDate, out.pickupTime)} />
        <DataRow label="Tracking #" value={out.tracking} mono />
        {out.tracking && (
          <div className="py-1.5">
            <TrackingBadge number={out.tracking} carrier={out.carrier} />
          </div>
        )}
        <DataRow label="Notes" value={out.notes} />
      </FieldGroup>

      <FieldGroup title="Return shipping">
        <DataRow label="Carrier" value={ret.carrier} />
        <DataRow
          label="Arrival"
          value={fmtPickup(ret.arrivalDate || ret.pickupDate, ret.arrivalTime)}
        />
        <DataRow label="Tracking #" value={ret.tracking} mono />
        {ret.tracking && (
          <div className="py-1.5">
            <TrackingBadge number={ret.tracking} carrier={ret.carrier} />
          </div>
        )}
        <DataRow label="Notes" value={ret.notes} />
      </FieldGroup>
    </>
  );
}

// ── Side events tab ──────────────────────────────────────────────────────────────────────────
function SidePanel({ p }: { p: EventPayload }) {
  const side = p.sideEvents ?? [];
  return (
    <FieldGroup title={`Side events · ${side.length}`}>
      {side.length === 0 ? (
        <EmptyBlock>No after-parties or community events.</EmptyBlock>
      ) : (
        <div className="flex flex-col gap-2">
          {side.map((s, i) => (
            <div key={i} className="rounded bg-muted/40 p-2.5">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="text-[13px] font-semibold text-foreground">{s.name}</span>
                <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                  {fmtDate(s.date)} · {s.time}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">{s.venue}</div>
              {s.notes && <div className="mt-1 text-[11px] text-muted-foreground">{s.notes}</div>}
            </div>
          ))}
        </div>
      )}
    </FieldGroup>
  );
}

// ── Readiness strip ──────────────────────────────────────────────────────────────────────────
function ReadinessStrip({ ready, blockers }: { ready: boolean; blockers: string[] }) {
  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-3 rounded border px-4 py-3"
      style={{
        borderColor: ready ? 'var(--success)' : 'var(--warning)',
        background: ready ? 'color-mix(in oklch, var(--success) 8%, transparent)' : 'color-mix(in oklch, var(--warning) 8%, transparent)',
      }}
    >
      <span
        className="text-[11px] font-extrabold uppercase tracking-wider"
        style={{ color: ready ? 'var(--success)' : 'var(--warning)' }}
      >
        {ready ? 'Ready' : 'Not ready'}
      </span>
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        {ready ? 'All packed, no flags, sign-off gate met.' : blockers.length ? blockers.join(' · ') : 'Blocked'}
      </span>
    </div>
  );
}

// ── CSV download (client-side Blob from server-built rows) ─────────────────────────────────────
function downloadManifestCsv(eventName: string, rows: EventDetailView['csvRows']) {
  const cols: { key: keyof EventDetailView['csvRows'][number]; label: string }[] = [
    { key: 'itemId', label: 'itemId' },
    { key: 'itemName', label: 'itemName' },
    { key: 'sku', label: 'sku' },
    { key: 'qr', label: 'qr' },
    { key: 'caseLabel', label: 'caseLabel' },
    { key: 'qty', label: 'qty' },
    { key: 'serials', label: 'serials' },
    { key: 'state', label: 'state' },
    { key: 'flags', label: 'flags' },
    { key: 'signoff', label: 'signoff' },
  ];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.map((c) => c.label).join(',');
  const body = rows.map((r) => cols.map((c) => esc(r[c.key])).join(',')).join('\n');
  const csv = header + '\n' + body;
  const base = (eventName || 'event').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `manifest-${base}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Event Data-Matrix modal ──────────────────────────────────────────────────────────────────
function EventMatrixModal({
  open,
  onOpenChange,
  name,
  code,
  svg,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  name: string;
  code: string;
  svg: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Event Data Matrix</DialogTitle>
          <DialogDescription>Scan this code to open {name || 'this event'}.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-2">
          <span
            role="img"
            aria-label={`Data Matrix code for event ${name}`}
            className="grid size-40 place-items-center rounded-md bg-white p-2"
          >
            {svg ? (
              <span
                className="block size-full [&>svg]:block [&>svg]:size-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : (
              <span className="break-all px-1 text-center font-mono text-[8px] text-black">{code || '—'}</span>
            )}
          </span>
          {code && <p className="max-w-full truncate font-mono text-[10px] text-muted-foreground">{code}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => window.print()}>
            <Printer aria-hidden />
            Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The whole detail client (header + tag row + readiness strip + tabs) ────────────────────────
export function EventDetailClient({
  eventId,
  name,
  state,
  startDate,
  city,
  leadDisplay,
  payload,
  view,
  forecastRows,
  tempUnit = 'F',
  canEdit,
  canDelete,
  canPrintOthersItin,
  canMarkOnsite,
  viewerIsStaffed,
  eventMatrixCode,
  eventMatrixSvg,
}: {
  eventId: string;
  name: string;
  state?: EventState;
  startDate: string;
  city: string;
  leadDisplay: string;
  payload: EventPayload;
  view: EventDetailView;
  forecastRows: EventForecastRow[];
  tempUnit?: 'C' | 'F';
  canEdit: boolean;
  canDelete: boolean;
  canPrintOthersItin: boolean;
  /** signoff.commit (lead+/lead-of-event) — show "Mark on site" while the event is in transit. */
  canMarkOnsite: boolean;
  viewerIsStaffed: boolean;
  eventMatrixCode: string;
  eventMatrixSvg: string;
}) {
  const router = useRouter();
  const [active, setActive] = useState<TabId>('overview');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [deleting, startDelete] = useTransition();
  const [deleteErr, setDeleteErr] = useState('');
  const [markingOnsite, startMarkOnsite] = useTransition();

  // Lead marks an in-transit event arrived at the venue (sets it On Site).
  const doMarkOnsite = () => {
    startMarkOnsite(() => {
      markEventOnsiteAction(eventId).then((r) => {
        if (r.ok) {
          toast.success('Marked on site.');
          router.refresh();
        } else {
          toast.error(r.error || 'Could not mark on site.');
        }
      });
    });
  };
  // Itinerary print: open the SHARED server-rendered boarding-pass itinerary (the same rich format as
  // "Print all my travel", with scannable Data Matrix codes), scoped to this event + staffer, in a new
  // tab. The route re-checks PII permission server-side, so this prints exactly what the viewer may see.
  const printItineraryFor = (s: StaffCardView) => {
    window.open(
      `/event/${encodeURIComponent(eventId)}/itinerary/print?staff=${encodeURIComponent(s.email)}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  const doDelete = () => {
    setDeleteErr('');
    startDelete(() => {
      deleteEventAction(eventId).then((r) => {
        if (r.ok) {
          setConfirmDelete(false);
          router.push('/');
        } else {
          setDeleteErr(r.error || 'Delete failed.');
        }
      });
    });
  };

  const eyebrow = `${startDate ? fmtDate(startDate) : 'Draft event'} · ${city || '—'}`;
  const stats = view.totals;

  // The shared action buttons (used in both the desktop row and the mobile icon strip via labels).
  const manifestHref = `/manifest?event=${encodeURIComponent(eventId)}`;

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
      {/* Back link (desktop). */}
      <Button asChild variant="ghost" size="sm" className="-ml-2 hidden w-fit text-muted-foreground sm:inline-flex">
        <Link href="/">
          <ChevronLeft aria-hidden />
          Dashboard
        </Link>
      </Button>

      {/* Header — eyebrow / title / meta + actions. */}
      <header className="flex flex-col gap-3">
        <div className="min-w-0">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight sm:text-3xl">
            {name || 'Untitled event'}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <StatusBadge state={state} />
            <span>
              Lead: <span className="text-foreground">{leadDisplay || '—'}</span>
            </span>
            <span>
              Manifest:{' '}
              <span className="font-mono tabular-nums text-foreground">
                {stats.packed}/{stats.total}
              </span>
            </span>
            {stats.flagged > 0 && <span className="text-warning">{stats.flagged} flagged</span>}
          </div>
        </div>

        {/* Action row — Delete left-isolated, then Manifest / Manifest CSV / Cases / Print Matrix / Edit.
            Horizontally scrollable on mobile so the icon strip never wraps awkwardly. */}
        <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1">
          {canDelete && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              title="Delete event"
              className="shrink-0 border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 aria-hidden />
              <span className="hidden sm:inline">Delete</span>
            </Button>
          )}
          <div className="hidden flex-1 sm:block" />
          {state === 'in_transit' && canMarkOnsite && (
            <Button
              size="sm"
              onClick={doMarkOnsite}
              disabled={markingOnsite}
              title="Mark the shipment as arrived at the venue (sets the event On Site)"
              className="shrink-0"
            >
              <MapPin aria-hidden />
              <span className="hidden sm:inline">{markingOnsite ? 'Marking…' : 'Mark on site'}</span>
            </Button>
          )}
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link href={manifestHref} title="Manifest">
              <Layers aria-hidden />
              <span className="hidden sm:inline">Manifest</span>
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadManifestCsv(name, view.csvRows)}
            title="Download the manifest as CSV"
            className="shrink-0"
          >
            <Layers aria-hidden />
            <span className="hidden sm:inline">Manifest CSV</span>
          </Button>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link href="/catalog?view=cases" title="Cases">
              <Boxes aria-hidden />
              <span className="hidden sm:inline">Cases</span>
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMatrixOpen(true)}
            title="Generate a printable Data Matrix for this event"
            className="shrink-0"
          >
            <QrCode aria-hidden />
            <span className="hidden sm:inline">Print Matrix</span>
          </Button>
          {canEdit && (
            <Button asChild size="sm" className="shrink-0">
              <Link href={`/event/${eventId}/edit`} title="Edit event">
                <Pencil aria-hidden />
                <span className="hidden sm:inline">Edit</span>
              </Link>
            </Button>
          )}
        </div>
      </header>

      {/* Applied tags (display-only — add/remove is editor-side). */}
      {view.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Eyebrow asChild>
            <span className="mr-1">Tags</span>
          </Eyebrow>
          {view.tags.map((t) => (
            <Link key={t.id} href={`/tag/${t.id}`} className="no-underline">
              <TagChip tag={t} />
            </Link>
          ))}
        </div>
      )}

      {/* Readiness strip. */}
      <ReadinessStrip ready={view.readiness.ready} blockers={view.readiness.blockers} />

      {/* Tab strip + panels (all panels stay mounted; only the active one shows — #93 contract). */}
      <div>
        <TabStrip active={active} onSelect={setActive} />
        <div role="tabpanel" hidden={active !== 'overview'}>
          <OverviewPanel p={payload} forecastRows={forecastRows} tempUnit={tempUnit} />
        </div>
        <div role="tabpanel" hidden={active !== 'team'}>
          <TeamPanel
            eventId={eventId}
            view={view}
            viewerIsStaffed={viewerIsStaffed}
            canPrintOthers={canPrintOthersItin}
            onPrint={printItineraryFor}
          />
        </div>
        <div role="tabpanel" hidden={active !== 'packing'}>
          <PackingPanel eventId={eventId} view={view} />
        </div>
        <div role="tabpanel" hidden={active !== 'shipping'}>
          <ShippingPanel p={payload} />
        </div>
        <div role="tabpanel" hidden={active !== 'side'}>
          <SidePanel p={payload} />
        </div>
      </div>

      {/* Delete confirm. */}
      <Dialog open={confirmDelete} onOpenChange={(o) => !deleting && setConfirmDelete(o)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete event</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{name || 'Untitled event'}&rdquo;? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteErr && <p className="text-sm text-destructive">{deleteErr}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              onClick={doDelete}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? 'Deleting…' : 'Yes, delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Event Data-Matrix modal. */}
      <EventMatrixModal
        open={matrixOpen}
        onOpenChange={setMatrixOpen}
        name={name}
        code={eventMatrixCode}
        svg={eventMatrixSvg}
      />

    </div>
  );
}

