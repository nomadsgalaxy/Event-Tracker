'use client';

import * as React from 'react';
import { useCallback, useId, useState } from 'react';
import { CircleCheck, CircleSlash, KeyRound, Loader2, PlugZap, Save } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useStepUp } from '@/components/config/step-up';
import { IS_DEMO, DEMO_LOCK_NOTE } from '@/lib/util/demo-flag';

// integration-keys-card.tsx — the Config > Databases & API integration-key editor. The server stores
// each key AES-256-GCM-ENCRYPTED in the off-data-plane __settings__ doc and NEVER echoes a secret
// back; this island only ever learns a per-key set/unset boolean (set, fromEnv, inStore). A Save
// requires a fresh STEP-UP (re-entered password → /api/auth/integration-keys gates admin + step-up),
// and the keys apply for EVERYONE (env || store resolution in lib/weather, lib/integrations,
// flight-actions). Mirrors the Python IntegrationKeysCard, adapted to the keys this app actually uses.

export type KeyName =
  | 'googleApiKey'
  | 'weatherKey'
  | 'flightAwareKey'
  | 'openskyClientId'
  | 'openskyClientSecret'
  | 'easypostKey'
  | 'track17Key'
  | 'aftershipKey';

export interface KeyStatus {
  name: KeyName;
  set: boolean;
  fromEnv: boolean;
  inStore: boolean;
}

interface KeyMeta {
  name: KeyName;
  label: string;
  hint: string;
  placeholder: string;
  /** When true, render a "Verify connection" button that probes which Google APIs the key can reach. */
  verify?: boolean;
}

interface KeyGroup {
  title: string;
  defaultOpen: boolean;
  keys: KeyMeta[];
}

// The provider groups, mirroring the Python card's collapsible sections (Identity & Google / Flight /
// Shipping), adapted to the Mongo-direct app's actual integrations.
const GROUPS: KeyGroup[] = [
  {
    title: 'Google (Maps · Places · Weather)',
    defaultOpen: true,
    keys: [
      {
        name: 'googleApiKey',
        label: 'Google API key',
        hint: 'ONE key powers venue address autocomplete (Places), maps/geocoding, and the per-venue weather chips. Enable the Places, Geocoding, and Weather APIs on the key’s Google Cloud project, then Verify to see what’s live.',
        placeholder: 'AIzaSy…',
        verify: true,
      },
    ],
  },
  {
    title: 'Flights — lookup, delay alerts & live progress',
    defaultOpen: false,
    keys: [
      {
        name: 'flightAwareKey',
        label: 'FlightAware AeroAPI key — live status & delays',
        hint: 'The flight-status source: real estimated/actual times, so delays and cancellations are detected and alerted. Get a key at flightaware.com/aeroapi — the personal tier includes a free monthly credit. Proxied server-side — never sent to a browser.',
        placeholder: 'your AeroAPI key (x-apikey)',
      },
      {
        name: 'openskyClientId',
        label: 'OpenSky Network client ID — live flight progress',
        hint: 'Powers the live in-air progress on a traveler’s flight (position, altitude, speed). Create a free API client at opensky-network.org (account → API clients); enter its client ID here and the secret below.',
        placeholder: 'your-opensky-api-client',
      },
      {
        name: 'openskyClientSecret',
        label: 'OpenSky Network client secret',
        hint: 'The OAuth2 secret that pairs with the client ID above. Used server-side only.',
        placeholder: 'client secret',
      },
    ],
  },
  {
    title: 'Shipment tracking',
    defaultOpen: false,
    keys: [
      {
        name: 'easypostKey',
        label: 'EasyPost API key — FedEx / UPS / USPS / DHL + LTL',
        hint: 'Resolves tracking numbers to live carrier status. A free EasyPost account covers parcel carriers. Server-side only.',
        placeholder: 'EZAK… / EZTK…',
      },
      {
        name: 'track17Key',
        label: '17TRACK API key — free fallback (parcel / UPS)',
        hint: 'Free fallback when EasyPost can’t match (100/mo, no card). UniShippers LTL freight has no free API — those fall back to a free “Track ↗” link-out.',
        placeholder: 'your 17TRACK API token',
      },
      {
        name: 'aftershipKey',
        label: 'AfterShip API key — UniShippers LTL (paid)',
        hint: 'Aggregator that natively tracks UniShippers/LTL when EasyPost can’t read a number. Paid (~$99/mo); a free tier exists.',
        placeholder: 'asat_…',
      },
    ],
  },
];

function statusOf(keys: KeyStatus[], name: KeyName): KeyStatus {
  return keys.find((k) => k.name === name) ?? { name, set: false, fromEnv: false, inStore: false };
}

export function IntegrationKeysCard({
  initialKeys,
  meta,
}: {
  initialKeys: KeyStatus[];
  meta: { updatedBy?: string; updatedAt?: number };
}) {
  const [keys, setKeys] = useState<KeyStatus[]>(initialKeys);
  const [savedMeta, setSavedMeta] = useState(meta);
  // Per-key draft input (new plaintext) + a per-key "remove" flag.
  const [drafts, setDrafts] = useState<Partial<Record<KeyName, string>>>({});
  const [removes, setRemoves] = useState<Partial<Record<KeyName, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const { requireStepUp, element: stepUpModal } = useStepUp();

  const setDraft = (name: KeyName, v: string) => setDrafts((p) => ({ ...p, [name]: v }));
  const setRemove = (name: KeyName, v: boolean) => setRemoves((p) => ({ ...p, [name]: v }));

  // A save is meaningful only if there's at least one new value (for a key not flagged for removal)
  // OR at least one removal.
  const dirty =
    (Object.entries(drafts) as [KeyName, string][]).some(([name, v]) => (v ?? '').trim().length > 0 && !removes[name]) ||
    Object.values(removes).some(Boolean);

  const doSave = useCallback(
    (stepupToken: string) => {
      setBusy(true);
      const set: Partial<Record<KeyName, string>> = {};
      const clear: KeyName[] = [];
      for (const group of GROUPS) {
        for (const k of group.keys) {
          if (removes[k.name]) {
            clear.push(k.name);
          } else {
            const v = (drafts[k.name] ?? '').trim();
            if (v) set[k.name] = v;
          }
        }
      }
      fetch('/api/auth/integration-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepupToken, set, clear }),
        cache: 'no-store',
      })
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            keys?: KeyStatus[];
            updatedBy?: string;
            updatedAt?: number;
          };
          if (res.status !== 200) {
            toast.error(data.error || `Save failed (${res.status}).`);
            return;
          }
          if (data.keys) setKeys(data.keys);
          setSavedMeta({ updatedBy: data.updatedBy, updatedAt: data.updatedAt });
          setDrafts({});
          setRemoves({});
          toast.success('Integration keys saved — applied for everyone.');
        })
        .catch(() => toast.error('Network error — please try again.'))
        .finally(() => setBusy(false));
    },
    [drafts, removes]
  );

  function onSave() {
    if (!dirty) {
      toast.message('No key changes to save.');
      return;
    }
    requireStepUp(doSave);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-primary" aria-hidden />
          Integration keys
        </CardTitle>
        <CardDescription>
          Set these once here and they apply for <strong className="text-foreground">everyone</strong> — no
          per-browser setup. Each key is stored <strong className="text-foreground">encrypted</strong> on the
          server (AES-256-GCM) and never shown again; we only report whether it’s set. A key set in the
          server environment overrides the value here. Saving requires your account password.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {IS_DEMO ? (
          <p className="mb-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground">
            {DEMO_LOCK_NOTE}
          </p>
        ) : null}
        {GROUPS.map((group) => (
          <KeyGroupSection key={group.title} group={group} keys={keys} drafts={drafts} removes={removes} setDraft={setDraft} setRemove={setRemove} />
        ))}

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button onClick={onSave} disabled={busy || !dirty || IS_DEMO}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
            Save for everyone
          </Button>
          {savedMeta.updatedAt ? (
            <span className="text-xs text-muted-foreground">
              Last updated {new Date(savedMeta.updatedAt).toLocaleString()}
              {savedMeta.updatedBy ? ` by ${savedMeta.updatedBy}` : ''}
            </span>
          ) : null}
        </div>
      </CardContent>
      {stepUpModal}
    </Card>
  );
}

function KeyGroupSection({
  group,
  keys,
  drafts,
  removes,
  setDraft,
  setRemove,
}: {
  group: KeyGroup;
  keys: KeyStatus[];
  drafts: Partial<Record<KeyName, string>>;
  removes: Partial<Record<KeyName, boolean>>;
  setDraft: (name: KeyName, v: string) => void;
  setRemove: (name: KeyName, v: boolean) => void;
}) {
  const [open, setOpen] = useState(group.defaultOpen);
  const panelId = useId();
  return (
    <section className="border-b border-border py-2 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{group.title}</span>
        <span className="text-base leading-none" aria-hidden>{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <div id={panelId} className="flex flex-col gap-4 px-1 pb-2 pt-1">
          {group.keys.map((meta) => (
            <KeyRow key={meta.name} meta={meta} status={statusOf(keys, meta.name)} draft={drafts[meta.name] ?? ''} remove={!!removes[meta.name]} setDraft={setDraft} setRemove={setRemove} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function KeyRow({
  meta,
  status,
  draft,
  remove,
  setDraft,
  setRemove,
}: {
  meta: KeyMeta;
  status: KeyStatus;
  draft: string;
  remove: boolean;
  setDraft: (name: KeyName, v: string) => void;
  setRemove: (name: KeyName, v: boolean) => void;
}) {
  const inputId = useId();
  const removeId = useId();
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    source: string;
    results: Record<string, { ok: boolean; message: string }>;
  } | null>(null);

  async function runVerify() {
    setVerifying(true);
    try {
      const res = await fetch('/api/integrations/google/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Probe the ENTERED draft if there is one (test before saving), else the stored/env key.
        body: JSON.stringify({ key: draft.trim() || undefined }),
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        source?: string;
        results?: Record<string, { ok: boolean; message: string }>;
      };
      if (res.status !== 200 || !data.results) {
        toast.error(data.error || `Verify failed (${res.status}).`);
        return;
      }
      setVerifyResult({ source: data.source || 'stored', results: data.results });
    } catch {
      toast.error('Network error — please try again.');
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={inputId} className="text-sm">
          {meta.label}
        </Label>
        {status.set ? (
          <Badge variant="outline" className="gap-1 border-[var(--success)] text-[var(--success)]">
            <CircleCheck className="size-3" aria-hidden />
            Set{status.fromEnv ? ' · via env' : status.inStore ? ' · stored' : ''}
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <CircleSlash className="size-3" aria-hidden />
            Not set
          </Badge>
        )}
      </div>
      <Input
        id={inputId}
        type="password"
        value={draft}
        onChange={(e) => setDraft(meta.name, e.target.value)}
        disabled={remove || status.fromEnv || IS_DEMO}
        autoComplete="new-password"
        placeholder={status.fromEnv ? 'Set via the server environment' : status.set ? '•••••••• (blank keeps it)' : meta.placeholder}
      />
      <p className="text-xs text-muted-foreground">{meta.hint}</p>
      {meta.verify ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={runVerify}
              disabled={verifying || IS_DEMO || (!draft.trim() && !status.set)}
              title={!draft.trim() && !status.set ? 'Enter or save a key first' : 'Probe which Google APIs this key can reach'}
            >
              {verifying ? <Loader2 className="animate-spin" aria-hidden /> : <PlugZap aria-hidden />}
              Verify connection
            </Button>
          </div>
          {verifyResult ? (
            <div className="rounded-md border border-border bg-muted/30 p-2.5">
              <p className="mb-1.5 text-[11px] text-muted-foreground">
                Probed the {verifyResult.source === 'entered' ? 'entered' : 'saved'} key — features light up for each API that responds:
              </p>
              <ul className="flex flex-col gap-1">
                {(
                  [
                    ['places', 'Address autocomplete (Places)'],
                    ['weather', 'Weather forecast chips'],
                    ['geocoding', 'Maps / geocoding'],
                  ] as const
                ).map(([k, label]) => {
                  const r = verifyResult.results[k];
                  const ok = !!r?.ok;
                  return (
                    <li key={k} className="flex items-start gap-1.5 text-xs">
                      {ok ? (
                        <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--success)]" aria-hidden />
                      ) : (
                        <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                      )}
                      <span className={ok ? 'text-foreground' : 'text-muted-foreground'}>
                        <span className="font-medium">{label}</span>
                        {ok ? (
                          <span className="text-[var(--success)]"> · available</span>
                        ) : (
                          <span> · {r?.message || 'unavailable'}</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {status.inStore && !status.fromEnv ? (
        <label htmlFor={removeId} className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox id={removeId} checked={remove} disabled={IS_DEMO} onCheckedChange={(c) => setRemove(meta.name, c === true)} />
          Remove this stored key
        </label>
      ) : null}
    </div>
  );
}
