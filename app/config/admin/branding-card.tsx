'use client';

import * as React from 'react';
import { useCallback, useId, useState } from 'react';
import { Building2, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useStepUp } from '@/components/config/step-up';

// branding-card.tsx — Config > Admin "Company branding". A REAL editable card: the default company
// name + a domain→company map, persisted (step-up-gated) to the settings store. The label surfaces on
// the top-bar company chip, mapped by the signed-in user's email domain (unmapped → the default).
// Mirrors the Python Company-branding card.

export interface BrandingInitial {
  companyDefault: string;
  companyMap: Record<string, string>;
}

function mapToText(m: Record<string, string>): string {
  return Object.entries(m)
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n');
}

// Parse "domain = Company Name" lines (one per line; '=' separates). Tolerant of extra whitespace.
function textToMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\n+/)) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const dom = line.slice(0, i).trim().toLowerCase().replace(/^@/, '');
    const name = line.slice(i + 1).trim();
    if (dom && name) out[dom] = name;
  }
  return out;
}

export function BrandingCard({ initial }: { initial: BrandingInitial }) {
  const [companyDefault, setCompanyDefault] = useState(initial.companyDefault);
  const [mapText, setMapText] = useState(mapToText(initial.companyMap));
  const [busy, setBusy] = useState(false);
  const { requireStepUp, element: stepUpModal } = useStepUp();
  const defaultId = useId();
  const mapId = useId();

  const doSave = useCallback(
    (stepupToken: string) => {
      setBusy(true);
      fetch('/api/auth/branding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepupToken, companyDefault: companyDefault.trim(), companyMap: textToMap(mapText) }),
        cache: 'no-store',
      })
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as { error?: string; companyDefault?: string; companyMap?: Record<string, string> };
          if (res.status !== 200) {
            toast.error(data.error || `Save failed (${res.status}).`);
            return;
          }
          if (typeof data.companyDefault === 'string') setCompanyDefault(data.companyDefault);
          if (data.companyMap) setMapText(mapToText(data.companyMap));
          toast.success('Company branding saved.');
        })
        .catch(() => toast.error('Network error — please try again.'))
        .finally(() => setBusy(false));
    },
    [companyDefault, mapText]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="size-4 text-primary" aria-hidden />
          Company branding
        </CardTitle>
        <CardDescription>
          The label shown in the top bar, mapped by the signed-in user’s email domain; unmapped domains
          fall back to the default. Who may sign in and who is an admin is managed in the{' '}
          <strong className="text-foreground">Access policy</strong> card below.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={defaultId}>Default company name</Label>
          <Input
            id={defaultId}
            value={companyDefault}
            onChange={(e) => setCompanyDefault(e.target.value)}
            placeholder="e.g. Acme Corp"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">Leave blank to hide the label entirely.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={mapId}>Domain → company name</Label>
          <Textarea
            id={mapId}
            value={mapText}
            onChange={(e) => setMapText(e.target.value)}
            rows={4}
            placeholder={'acme.com = Acme Corp\nfoo.org = Foo Industries'}
            className="resize-y font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            One per line. <span className="font-mono">domain = company name</span>.
          </p>
        </div>
        <div>
          <Button onClick={() => requireStepUp(doSave)} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
            Save branding
          </Button>
        </div>
      </CardContent>
      {stepUpModal}
    </Card>
  );
}
