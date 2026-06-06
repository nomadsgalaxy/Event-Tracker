'use client';

import * as React from 'react';
import { useCallback, useId, useState } from 'react';
import { Fingerprint, Loader2, Save, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useStepUp } from '@/components/config/step-up';

// tenant-card.tsx — Config > Admin "Deployment tenant". Shows the active tenant id (override || env)
// + its base36 hash (the prefix every printed Data-Matrix code embeds), with an OVERRIDE input. The
// override (when set) feeds lib/settings-store's activeTenantId → activeTenantHash36 on every
// print/scan path. CHANGING IT INVALIDATES already-printed labels — the card warns before saving.
// Mirrors the Python DeploymentTenantPanel.

export interface TenantInitial {
  override: string; // the persisted override ('' when unset)
  active: string; // override || env (what the app uses)
  envDefault: string; // EIT_TENANT_ID || MONGO_DB (read-only)
  hash: string; // base36 hash of `active`
}

export function TenantCard({ initial }: { initial: TenantInitial }) {
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState(initial.override);
  const [busy, setBusy] = useState(false);
  const { requireStepUp, element: stepUpModal } = useStepUp();
  const inputId = useId();

  const draftTrim = draft.trim().toLowerCase();
  const dirty = draftTrim !== state.override.toLowerCase();
  // Saving an override that differs from what's ACTIVE now is the label-invalidating change.
  const wouldChangeActive = (draftTrim || state.envDefault) !== state.active;

  const doSave = useCallback(
    (stepupToken: string) => {
      setBusy(true);
      fetch('/api/auth/tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepupToken, tenantId: draftTrim }),
        cache: 'no-store',
      })
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            override?: string;
            active?: string;
            envDefault?: string;
            hash?: string;
          };
          if (res.status !== 200) {
            toast.error(data.error || `Save failed (${res.status}).`);
            return;
          }
          const next: TenantInitial = {
            override: data.override ?? '',
            active: data.active ?? '',
            envDefault: data.envDefault ?? state.envDefault,
            hash: data.hash ?? '',
          };
          setState(next);
          setDraft(next.override);
          toast.success(draftTrim ? 'Deployment tenant saved.' : 'Tenant override cleared.');
        })
        .catch(() => toast.error('Network error — please try again.'))
        .finally(() => setBusy(false));
    },
    [draftTrim, state.envDefault]
  );

  function onSave() {
    if (!dirty) return;
    requireStepUp(doSave);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Fingerprint className="size-4 text-primary" aria-hidden />
          Deployment tenant
        </CardTitle>
        <CardDescription>
          Every Data-Matrix code this deployment generates is prefixed with this tenant’s hash, so a scan
          in another customer’s app rejects it. By default it’s derived from the server environment
          (<code className="font-mono">EIT_TENANT_ID</code> or the database name). An override below wins.
          Changing it invalidates labels already printed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Active tenant</span>
            <span className="font-mono text-foreground">
              {state.active || <span className="italic text-destructive">unset — Print Matrix disabled</span>}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Matrix prefix (hash)</span>
            <span className="font-mono text-primary">{state.hash || '—'}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Environment default</span>
            <span className="font-mono text-muted-foreground">{state.envDefault || '—'}</span>
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={inputId}>Tenant override</Label>
          <Input
            id={inputId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={state.envDefault ? `blank = use env (${state.envDefault})` : 'e.g. acme.com'}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">Leave blank to fall back to the environment default.</p>
        </div>

        {dirty && wouldChangeActive ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertDescription>
              This changes the active tenant. Matrix codes already printed under{' '}
              <span className="font-mono">{state.active || '(none)'}</span> will be rejected after saving — re-print
              labels for any cases or items already in the field.
            </AlertDescription>
          </Alert>
        ) : null}

        <div>
          <Button onClick={onSave} disabled={busy || !dirty}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
            {draftTrim ? 'Save tenant' : 'Clear override'}
          </Button>
        </div>
      </CardContent>
      {stepUpModal}
    </Card>
  );
}
