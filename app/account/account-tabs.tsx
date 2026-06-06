'use client';

import * as React from 'react';
import { useEffect, useRef, useState, useTransition } from 'react';
import {
  UserRound,
  SlidersHorizontal,
  ShieldCheck,
  Loader2,
  Upload,
  Trash2,
  Printer,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Eyebrow } from '@/components/ui/eyebrow';
import { DetailRow } from '@/components/ui/detail-row';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RoleBadge } from '@/app/config/role-badge';
import { TabStrip } from '@/components/ui/layout';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { AccommodationsEditor } from '@/components/account/accommodations-editor';
import { SecurityPanel as SecurityPanelImpl } from '@/components/account/security-panel';
import { UI_THEMES, applyTheme, themeById } from '@/lib/themes';
import type { AccommodationsProfile } from '@/lib/types';
import { saveProfileAction, savePreferencesAction } from './actions';
import { useUnsavedGuard, UnsavedChangesDialog } from '@/components/hooks/use-unsaved-guard';

// account-tabs.tsx — the Account & Preferences underline tab strip (Archetype B). Three tabs:
//   • Profile      — preferredName / picture / Accommodations (sensitive PII, self-write)
//   • Preferences  — display units (temperature / weight / date format) + travel port-of-call +
//                    home-warehouse (#66) + UI THEME (live preview/revert/swatches) + Print my travel
//   • Security     — DEFERRED to the Auth pass (the existing read-only stub — left as-is)
//
// CRITICAL — each tab is its OWN component with its OWN draft + its OWN save that patches ONLY the
// fields THAT tab owns (the #37 tab-scoping rule). The server action mirrors this (it $sets only the
// tab's keys), so a Preferences save can never wipe the Profile tab's name/photo/accommodations and
// vice-versa. TabStrip keeps ALL panels MOUNTED (the #93 fix) so a half-typed field in an inactive
// tab survives a tab switch. The ACTIVE tab is persisted to localStorage 'eit:account:tab', read
// MOUNT-GATED (never during the initial render) so SSR and the first client paint match. The active
// panel is wrapped in an ErrorBoundary (the source's EitErrorBoundary).

export interface AccountInitial {
  email: string;
  name: string;
  role: string;
  roleLabel: string;
  preferredName: string;
  picture: string;
  source: string;
  accommodations: AccommodationsProfile | null;
  uiTheme: string;
  homeWarehouseId: string;
  warehouses: { id: string; name: string; isHq: boolean }[];
  prefs: {
    temperature: 'F' | 'C';
    weight: 'lbs' | 'kg';
    dateFormat: 'auto' | 'mdy' | 'dmy' | 'ymd';
    airport: string;
    trainStation: string;
  };
}

export interface LinkedBanner {
  ok: boolean;
  msg: string;
}

const ACCOUNT_TAB_KEY = 'eit:account:tab';

// ── small shared layout helpers (the FieldGroup / eit-card convention, §5) ──────────────────
function FieldGroup({
  title,
  description,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <Eyebrow asChild>
          <h2>{title}</h2>
        </Eyebrow>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

// A small segmented choice control (replaces the source's PillToggle 'segment'). Real <button>s in a
// radiogroup-style row; the active option is the orange-filled pill.
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  ariaLabel,
}: {
  label?: React.ReactNode;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label ? <Label className="text-xs text-muted-foreground">{label}</Label> : null}
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className="inline-flex w-fit flex-wrap gap-1 rounded-lg border border-border bg-background p-1"
      >
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o.value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SaveBar({ pending, dirty, onSave }: { pending: boolean; dirty: boolean; onSave: () => void }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <Button onClick={onSave} disabled={pending || !dirty}>
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {pending ? 'Saving…' : 'Save'}
      </Button>
      <span className="text-xs text-muted-foreground" aria-live="polite">
        {dirty ? 'Unsaved changes' : 'All changes saved'}
      </span>
    </div>
  );
}

function initials(name: string, email: string): string {
  const base = (name || email || '?').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

// ── PROFILE TAB ─────────────────────────────────────────────────────────────────────────
function ProfilePanel({ initial }: { initial: AccountInitial }) {
  const [preferredName, setPreferredName] = useState(initial.preferredName);
  const [picture, setPicture] = useState(initial.picture);
  // The accommodations draft (serialized stored shape) the embedded editor surfaces on each edit.
  const [accommodations, setAccommodations] = useState<AccommodationsProfile | null>(
    initial.accommodations
  );
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  // Dirty = any owned field differs from the last-saved BASELINE (seeded from initial, advanced on
  // each successful save). Comparing against the immutable `initial` prop would keep the form "unsaved"
  // even right after a save — which, with the navigation guard, would trap the user on the page.
  // Accommodations compares on a content signature so an editor re-emit of the same content isn't dirty.
  const [baseline, setBaseline] = useState({
    preferredName: initial.preferredName,
    picture: initial.picture,
    accSig: accommodationsSig(initial.accommodations),
  });
  const accSig = React.useMemo(() => accommodationsSig(accommodations), [accommodations]);
  const dirty =
    preferredName !== baseline.preferredName || picture !== baseline.picture || accSig !== baseline.accSig;
  const guard = useUnsavedGuard(dirty);

  // Resize the chosen image client-side to a 256px square (cover-crop) → compressed JPEG data URL,
  // exactly like the source: 0.85 quality, and if the result is > 220KB re-encode at 0.6.
  function handleFile(file: File | undefined) {
    if (!file) return;
    if (!/^image\//.test(file.type || '')) {
      toast.error('Please choose an image file.');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      toast.error('Image too large (max 12 MB).');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast.error('Could not read that file.');
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => toast.error('That image could not be decoded.');
      img.onload = () => {
        try {
          const size = 256;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('no 2d context');
          const scale = Math.max(size / img.width, size / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          let url = canvas.toDataURL('image/jpeg', 0.85);
          // Recompress an oversized data URL (> 220KB) at 0.6 quality — the source's exact guard, so
          // the stored photo stays under the server's 1 MB cap even for large/high-detail images.
          if (url.length > 220000) url = canvas.toDataURL('image/jpeg', 0.6);
          setPicture(url);
          toast.success('Photo ready — click Save to apply.');
        } catch {
          toast.error('Could not process that image.');
        }
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  function onSave() {
    startTransition(async () => {
      // #37: this tab writes ONLY preferredName + picture + accommodations.
      const res = await saveProfileAction({ preferredName, picture, accommodations });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      // Advance the baseline to what we just saved so the form is clean again.
      setBaseline({ preferredName, picture, accSig });
      toast.success('Profile saved.');
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <FieldGroup title="Identity">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Profile photo</Label>
          <div className="flex items-center gap-4">
            <Avatar size="lg" className="size-16">
              {picture ? <AvatarImage src={picture} alt="" /> : null}
              <AvatarFallback className="text-lg">
                {initials(initial.name || initial.preferredName, initial.email)}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col items-start gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="sr-only"
                aria-label="Choose a profile photo"
                onChange={(e) => {
                  handleFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  <Upload aria-hidden />
                  {picture ? 'Change photo' : 'Upload photo'}
                </Button>
                {picture ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPicture('')}>
                    <Trash2 aria-hidden />
                    Remove
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                Square images work best. Resized to 256px and stored with your profile. Click Save to
                apply.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-preferred-name" className="text-xs text-muted-foreground">
            Preferred display name
          </Label>
          <Input
            id="account-preferred-name"
            value={preferredName}
            onChange={(e) => setPreferredName(e.target.value)}
            placeholder={`Defaults to "${initial.name || initial.email}"`}
            className="max-w-md"
          />
          <p className="text-xs text-muted-foreground">
            Shown in the top bar and your sign-off attributions.
          </p>
        </div>
      </FieldGroup>

      <FieldGroup
        title="Accommodations"
        description="Sensitive PII. Visible only to admins, managers, and you — not event leads."
      >
        <AccommodationsEditor value={accommodations} onChange={setAccommodations} />
      </FieldGroup>

      <FieldGroup
        title="Account"
        description="These are managed by your administrator and your sign-in provider — read-only here."
      >
        <dl className="flex flex-col divide-y divide-border">
          <DetailRow label="Email" value={initial.email} mono />
          <DetailRow label="Role">
            <RoleBadge role={initial.role} />
          </DetailRow>
          <DetailRow
            label="Sign-in method"
            value={initial.source ? initial.source : 'Password'}
            className="capitalize"
          />
        </dl>
      </FieldGroup>

      <SaveBar pending={pending} dirty={dirty} onSave={onSave} />
      <UnsavedChangesDialog guard={guard} />
    </div>
  );
}

// A content signature for the accommodations profile (ignores updatedAt + the legacy mirror) so the
// dirty check compares real content, not the stamp the editor/serializer adds.
function accommodationsSig(a: AccommodationsProfile | null | undefined): string {
  const v = a || {};
  return JSON.stringify({
    d: v.dietary || [],
    al: v.allergies || null,
    ac: v.accessibility || [],
    m: v.medical || '',
    e: v.emergencyContacts || [],
    n: v.notes || '',
  });
}

// ── PREFERENCES TAB ─────────────────────────────────────────────────────────────────────
const TEMP_OPTIONS = [
  { value: 'F' as const, label: '°F' },
  { value: 'C' as const, label: '°C' },
];
const WEIGHT_OPTIONS = [
  { value: 'lbs' as const, label: 'lbs' },
  { value: 'kg' as const, label: 'kg' },
];
const DATE_OPTIONS = [
  { value: 'auto' as const, label: 'Auto' },
  { value: 'mdy' as const, label: 'MDY' },
  { value: 'dmy' as const, label: 'DMY' },
  { value: 'ymd' as const, label: 'YMD' },
];

// A pure date sample so the user sees what their format choice looks like (the source shows
// formatDate('2026-06-01', prefs)). No locale lib needed for the four explicit orders; 'auto' uses
// the browser locale (mount-gated — see PreferencesPanel).
function sampleDate(fmt: AccountInitial['prefs']['dateFormat'], mounted: boolean): string {
  const y = '2026';
  const m = '06';
  const d = '01';
  switch (fmt) {
    case 'mdy':
      return `${m}/${d}/${y}`;
    case 'dmy':
      return `${d}/${m}/${y}`;
    case 'ymd':
      return `${y}-${m}-${d}`;
    default:
      // 'auto' → the browser locale, but only AFTER mount (toLocaleDateString is client-only / would
      // mismatch SSR). Before mount, show a stable ISO placeholder.
      if (!mounted) return `${y}-${m}-${d}`;
      try {
        return new Date('2026-06-01T00:00:00').toLocaleDateString();
      } catch {
        return `${m}/${d}/${y}`;
      }
  }
}

function PreferencesPanel({ initial }: { initial: AccountInitial }) {
  const [temperature, setTemperature] = useState(initial.prefs.temperature);
  const [weight, setWeight] = useState(initial.prefs.weight);
  const [dateFormat, setDateFormat] = useState(initial.prefs.dateFormat);
  const [airport, setAirport] = useState(initial.prefs.airport);
  const [trainStation, setTrainStation] = useState(initial.prefs.trainStation);
  const [homeWarehouseId, setHomeWarehouseId] = useState(initial.homeWarehouseId);
  const [uiTheme, setUiTheme] = useState(initial.uiTheme);
  const [pending, startTransition] = useTransition();

  // Mount gate: the 'auto' date sample reads the browser locale; the theme live-preview writes to
  // <html>. Both are client-only and must NOT run during the initial render (so SSR matches paint).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // The theme the page loaded with — restore it on leave when an unsaved preview is active. onSave
  // updates this ref so a SAVED theme reverts to itself (a no-op). Mirrors the source's originalTheme.
  const originalTheme = useRef(initial.uiTheme);

  // Live preview: applying a theme writes its accent vars onto <html> immediately (mount-gated). The
  // selector reflects the change; the caption + swatches read the previewed theme.
  function onChangeTheme(id: string) {
    setUiTheme(id);
    if (mounted) applyTheme(id);
  }

  // Revert an unsaved live preview when LEAVING the tab/screen (unmount). A saved theme reverts to
  // itself (originalTheme updated on save) = a no-op. This keeps a previewed-but-not-saved theme from
  // sticking after navigating away — exactly the source's cleanup effect.
  useEffect(() => {
    return () => {
      if (mounted) applyTheme(originalTheme.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // Compare against the last-saved BASELINE, not the immutable `initial` prop — otherwise the form
  // reads "unsaved" right after a save and the nav guard traps the user. Advanced on each save.
  const [baseline, setBaseline] = useState({
    temperature: initial.prefs.temperature,
    weight: initial.prefs.weight,
    dateFormat: initial.prefs.dateFormat,
    airport: initial.prefs.airport,
    trainStation: initial.prefs.trainStation,
    homeWarehouseId: initial.homeWarehouseId,
    uiTheme: initial.uiTheme,
  });
  const dirty =
    temperature !== baseline.temperature ||
    weight !== baseline.weight ||
    dateFormat !== baseline.dateFormat ||
    airport !== baseline.airport ||
    trainStation !== baseline.trainStation ||
    homeWarehouseId !== baseline.homeWarehouseId ||
    uiTheme !== baseline.uiTheme;
  const guard = useUnsavedGuard(dirty);

  function onSave() {
    startTransition(async () => {
      // #37: this tab writes ONLY unitPrefs + portOfCall + uiTheme + homeWarehouseId.
      const res = await savePreferencesAction({
        temperature,
        weight,
        dateFormat,
        airport,
        trainStation,
        uiTheme,
        homeWarehouseId,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      // Advance the baseline to the saved values (clean form) and pin the saved theme so leaving the
      // tab no longer reverts it.
      setBaseline({ temperature, weight, dateFormat, airport, trainStation, homeWarehouseId, uiTheme });
      originalTheme.current = uiTheme;
      toast.success('Preferences saved.');
    });
  }

  const previewTheme = themeById(uiTheme);

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <FieldGroup
        title="Travel"
        description="Used as defaults when filling out a travel form on a future event."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-airport" className="text-xs text-muted-foreground">
              Preferred airport
            </Label>
            <Input
              id="account-airport"
              value={airport}
              onChange={(e) => setAirport(e.target.value)}
              placeholder="e.g. PHL"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-train" className="text-xs text-muted-foreground">
              Preferred train station
            </Label>
            <Input
              id="account-train"
              value={trainStation}
              onChange={(e) => setTrainStation(e.target.value)}
              placeholder="e.g. 30th Street Station"
            />
          </div>
        </div>

        {/* Home warehouse picker (#66) — only when warehouses are configured. */}
        {initial.warehouses.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-warehouse" className="text-xs text-muted-foreground">
              Home warehouse
            </Label>
            <Select value={homeWarehouseId || '__none__'} onValueChange={(v) => setHomeWarehouseId(v === '__none__' ? '' : v)}>
              <SelectTrigger id="account-warehouse" className="max-w-md" aria-label="Home warehouse">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— None (show all warehouses) —</SelectItem>
                {initial.warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                    {w.isHq ? ' · HQ' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The road-case catalog opens scoped to this warehouse. Leave as &ldquo;None&rdquo; to
              browse every warehouse by default.
            </p>
          </div>
        )}

        {/* Print all my travel (#34) — opens the boarding-pass itinerary in a new tab. */}
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <div>
            <Button asChild type="button" variant="outline" size="sm">
              <a href="/account/itinerary/print" target="_blank" rel="noopener noreferrer">
                <Printer aria-hidden />
                Print all my travel
              </a>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            A printable, boarding-pass-styled summary of your flights, hotels, and event assignments
            across every show you&rsquo;re staffed on.
          </p>
        </div>
      </FieldGroup>

      <FieldGroup
        title="Display"
        description="Applies across the app and printouts. Stored dates are unchanged (ISO)."
      >
        <Segmented
          label="Temperature"
          ariaLabel="Temperature unit"
          value={temperature}
          options={TEMP_OPTIONS}
          onChange={setTemperature}
        />
        <Segmented
          label="Weight"
          ariaLabel="Weight unit"
          value={weight}
          options={WEIGHT_OPTIONS}
          onChange={setWeight}
        />
        <Segmented
          label="Date format"
          ariaLabel="Date format"
          value={dateFormat}
          options={DATE_OPTIONS}
          onChange={setDateFormat}
        />
        <p className="text-xs text-muted-foreground">
          Example:{' '}
          <span className="font-mono tabular-nums text-foreground">{sampleDate(dateFormat, mounted)}</span>
        </p>

        {/* UI THEME selector — live preview + revert-on-leave + swatch chips + caption. */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-theme" className="text-xs text-muted-foreground">
            UI theme
          </Label>
          <Select value={uiTheme} onValueChange={onChangeTheme}>
            <SelectTrigger id="account-theme" className="max-w-md" aria-label="UI theme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_THEMES.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.label} — {t.hint}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className="size-3.5 shrink-0 rounded-sm border border-border"
              style={{ background: previewTheme.swatch }}
              aria-hidden
            />
            <span
              className="size-3.5 shrink-0 rounded-sm border border-border"
              style={{ background: previewTheme.surface }}
              aria-hidden
            />
            <span aria-live="polite">Live preview applied.</span>
          </div>
        </div>
      </FieldGroup>

      <SaveBar pending={pending} dirty={dirty} onSave={onSave} />
      <UnsavedChangesDialog guard={guard} />
    </div>
  );
}

// ── SECURITY TAB ─────────────────────────────────────────────────────────────────────────────
// The full self-management surface (password / 2FA / passkeys / linked logins / step-up / API keys /
// calendar feed) lives in components/account/security-panel.tsx — every action is server-authoritative
// (the /api/auth/* routes re-check the session + step-up). This thin wrapper threads the read-only
// identity context (email/source/role) the panel needs to choose between "set" vs "change" password.
function SecurityPanel({ initial }: { initial: AccountInitial }) {
  return <SecurityPanelImpl initial={{ email: initial.email, source: initial.source, role: initial.role }} />;
}

// ── the tab strip ─────────────────────────────────────────────────────────────────────────
export function AccountTabs({
  initial,
  linkedBanner,
}: {
  initial: AccountInitial;
  linkedBanner?: LinkedBanner | null;
}) {
  // ACTIVE TAB — persisted to localStorage, read MOUNT-GATED (never during the initial render, so the
  // server render + the first client paint both start on 'profile'; the stored tab is restored after).
  const [tab, setTab] = useState<string>('profile');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACCOUNT_TAB_KEY);
      if (saved && ['profile', 'preferences', 'security'].includes(saved)) setTab(saved);
    } catch {
      /* private mode / no storage — stay on profile */
    }
  }, []);
  const switchTab = (id: string) => {
    setTab(id);
    try {
      localStorage.setItem(ACCOUNT_TAB_KEY, id);
    } catch {
      /* ignore */
    }
  };

  // The ?linked= OAuth-bind return banner (dismissible).
  const [banner, setBanner] = useState<LinkedBanner | null>(linkedBanner ?? null);

  return (
    <div className="flex flex-col gap-4">
      {banner && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm font-medium"
          role="status"
          style={{
            borderColor: banner.ok ? 'var(--success)' : 'var(--destructive)',
            color: banner.ok ? 'var(--success)' : 'var(--destructive)',
            background: banner.ok
              ? 'color-mix(in oklab, var(--success) 12%, transparent)'
              : 'color-mix(in oklab, var(--destructive) 12%, transparent)',
          }}
        >
          <span>{banner.msg}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label="Dismiss"
            className="rounded-sm p-1 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      )}

      <TabStrip
        ariaLabel="Account sections"
        value={tab}
        onValueChange={switchTab}
        items={[
          {
            id: 'profile',
            label: 'Profile',
            icon: UserRound,
            content: (
              <ErrorBoundary label="the Profile tab" resetKey="profile">
                <ProfilePanel initial={initial} />
              </ErrorBoundary>
            ),
          },
          {
            id: 'preferences',
            label: 'Preferences',
            icon: SlidersHorizontal,
            content: (
              <ErrorBoundary label="the Preferences tab" resetKey="preferences">
                <PreferencesPanel initial={initial} />
              </ErrorBoundary>
            ),
          },
          {
            id: 'security',
            label: 'Security',
            icon: ShieldCheck,
            content: (
              <ErrorBoundary label="the Security tab" resetKey="security">
                <SecurityPanel initial={initial} />
              </ErrorBoundary>
            ),
          },
        ]}
      />
    </div>
  );
}

export default AccountTabs;
