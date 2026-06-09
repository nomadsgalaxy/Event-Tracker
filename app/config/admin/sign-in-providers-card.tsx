'use client';

import { useState } from 'react';
import { Loader2, Save, LogIn, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import type { ProviderConfig } from '@/lib/auth/settings-store';

// sign-in-providers-card.tsx — Config > Admin "Sign-in providers". Admins add any OIDC provider (Entra,
// Okta, Auth0, Keycloak) via a discovery URL + client id/secret, or a GitHub OAuth app. Google stays a
// built-in (env-configured). Client secrets are write-only: never sent back, blank keeps the stored one.
// Admin-gated + audited server-side; no password step-up (admins are OAuth-only).

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

interface Row extends ProviderConfig {
  _secret: string; // write-only draft (never pre-filled)
}

export function SignInProvidersCard({
  initialProviders,
  initialSecretStatus,
  googleConfigured,
}: {
  initialProviders: ProviderConfig[];
  initialSecretStatus: Record<string, boolean>;
  googleConfigured: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(initialProviders.map((p) => ({ ...p, _secret: '' })));
  const [secretStatus, setSecretStatus] = useState<Record<string, boolean>>(initialSecretStatus);
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<Row>) => setRows((s) => s.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows((s) => s.filter((_, j) => j !== i));
  const add = () =>
    setRows((s) => [...s, { id: '', type: 'oidc', label: '', enabled: true, clientId: '', discoveryUrl: '', scopes: '', _secret: '' }]);

  function onSave() {
    // Derive an id from the label for any new row; validate uniqueness + required fields client-side.
    const prepared = rows.map((r) => ({ ...r, id: r.id || slug(r.label) }));
    const ids = prepared.map((r) => r.id);
    if (ids.some((id) => !/^[a-z0-9_-]{1,40}$/.test(id))) {
      toast.error('Each provider needs a label that yields a valid id (letters, numbers, -, _).');
      return;
    }
    if (new Set(ids).size !== ids.length) {
      toast.error('Two providers share the same id — give them distinct labels.');
      return;
    }
    for (const r of prepared) {
      if (r.type === 'oidc' && !r.discoveryUrl?.trim()) {
        toast.error(`"${r.label || r.id}" needs an OIDC discovery URL.`);
        return;
      }
      if (!r.clientId.trim()) {
        toast.error(`"${r.label || r.id}" needs a client ID.`);
        return;
      }
      // A brand-new provider (no stored secret yet) must have one entered now.
      if (!r._secret.trim() && !secretStatus[r.id]) {
        toast.error(`"${r.label || r.id}" needs a client secret.`);
        return;
      }
    }
    const providers: ProviderConfig[] = prepared.map(({ _secret, ...p }) => { void _secret; return p; });
    const secrets: Record<string, string> = {};
    for (const r of prepared) if (r._secret.trim()) secrets[r.id] = r._secret.trim();

    setBusy(true);
    fetch('/api/auth/oidc-providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers, secrets }),
      cache: 'no-store',
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { error?: string; providers?: ProviderConfig[]; secretStatus?: Record<string, boolean> };
        if (res.status !== 200) {
          toast.error(data.error || `Save failed (${res.status}).`);
          return;
        }
        if (data.providers) setRows(data.providers.map((p) => ({ ...p, _secret: '' })));
        if (data.secretStatus) setSecretStatus(data.secretStatus);
        toast.success('Sign-in providers saved.');
      })
      .catch(() => toast.error('Network error — please try again.'))
      .finally(() => setBusy(false));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LogIn className="size-4 text-primary" aria-hidden />
          Sign-in providers
        </CardTitle>
        <CardDescription>
          Add any OpenID Connect provider (Microsoft/Entra, Okta, Auth0, Keycloak) or a GitHub OAuth app.
          Client secrets are stored encrypted and never shown again — leave the secret blank to keep the
          stored one. Google is built-in (configured by environment).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Google (built-in, read-only) */}
        <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
          <span className="text-sm font-medium">Google <span className="text-muted-foreground">(built-in)</span></span>
          {googleConfigured ? (
            <Badge variant="outline" className="text-[var(--success)]">Configured</Badge>
          ) : (
            <Badge variant="outline" className="text-[var(--warning)]">Not configured (set GOOGLE_CLIENT_ID/SECRET)</Badge>
          )}
        </div>

        {rows.map((r, i) => (
          <div key={i} className="flex flex-col gap-2.5 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={r.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
                Enabled
              </label>
              <div className="flex items-center gap-2">
                {secretStatus[r.id] ? <Badge variant="outline" className="text-[10px] text-muted-foreground">secret set</Badge> : null}
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove provider" onClick={() => remove(i)}>
                  <Trash2 className="size-3.5 text-destructive" aria-hidden />
                </Button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">Label</Label>
                <Input value={r.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Continue with Microsoft" className="h-8 text-sm" />
              </div>
              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">Type</Label>
                <select
                  value={r.type}
                  onChange={(e) => update(i, { type: e.target.value as 'oidc' | 'github' })}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none dark:bg-input/30"
                >
                  <option value="oidc">OpenID Connect</option>
                  <option value="github">GitHub</option>
                </select>
              </div>
              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">Client ID</Label>
                <Input value={r.clientId} onChange={(e) => update(i, { clientId: e.target.value })} className="h-8 font-mono text-xs" />
              </div>
              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">Client secret {secretStatus[r.id] ? '(blank keeps stored)' : ''}</Label>
                <Input
                  type="password"
                  value={r._secret}
                  onChange={(e) => update(i, { _secret: e.target.value })}
                  placeholder={secretStatus[r.id] ? '•••••• stored' : 'required'}
                  autoComplete="new-password"
                  className="h-8 font-mono text-xs"
                />
              </div>
              {r.type === 'oidc' ? (
                <div className="grid gap-1 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">Discovery URL (.well-known/openid-configuration)</Label>
                  <Input value={r.discoveryUrl || ''} onChange={(e) => update(i, { discoveryUrl: e.target.value })} placeholder="https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration" className="h-8 font-mono text-xs" />
                </div>
              ) : null}
              <div className="grid gap-1 sm:col-span-2">
                <Label className="text-xs text-muted-foreground">Scopes (optional)</Label>
                <Input value={r.scopes || ''} onChange={(e) => update(i, { scopes: e.target.value })} placeholder={r.type === 'github' ? 'read:user user:email' : 'openid email profile'} className="h-8 font-mono text-xs" />
              </div>
            </div>
          </div>
        ))}

        <div className="flex items-center justify-between">
          <Button type="button" variant="outline" size="sm" onClick={add}>
            <Plus aria-hidden /> Add provider
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
            Save providers
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default SignInProvidersCard;
