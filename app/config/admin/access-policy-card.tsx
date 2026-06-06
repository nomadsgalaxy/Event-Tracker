'use client';

import * as React from 'react';
import { useCallback, useId, useState } from 'react';
import { Loader2, Save, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useStepUp } from '@/components/config/step-up';

// access-policy-card.tsx — Config > Admin "Access policy". Editable admin-email allowlist + allowed
// sign-in domains + an optional IdP group→role map. These ADD to the deploy-time env allowlist
// (EIT_ADMIN_EMAILS / EIT_OIDC_ALLOWED_DOMAINS), which is shown as READ-ONLY chips and can never be
// removed from here. Saving is step-up-gated. Mirrors the Python AccessPolicyCard.

export interface AccessPolicyInitial {
  env: { adminEmails: string[]; allowedDomains: string[] };
  policy: { adminEmails: string[]; allowedDomains: string[]; groupRoleMap: Record<string, string> };
  validRoles: { id: string; label: string }[];
}

const linesToList = (s: string): string[] =>
  s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

const mapToText = (m: Record<string, string>): string =>
  Object.entries(m)
    .map(([g, r]) => `${g} = ${r}`)
    .join('\n');

export function AccessPolicyCard({ initial }: { initial: AccessPolicyInitial }) {
  const [admins, setAdmins] = useState(initial.policy.adminEmails.join('\n'));
  const [domains, setDomains] = useState(initial.policy.allowedDomains.join('\n'));
  const [groups, setGroups] = useState(mapToText(initial.policy.groupRoleMap));
  const [env, setEnv] = useState(initial.env);
  const [busy, setBusy] = useState(false);
  const { requireStepUp, element: stepUpModal } = useStepUp();
  const adminsId = useId();
  const domainsId = useId();
  const groupsId = useId();

  const validRoleIds = new Set(initial.validRoles.map((r) => r.id));

  function parseGroups(): { ok: true; map: Record<string, string> } | { ok: false; bad: string } {
    const map: Record<string, string> = {};
    for (const line of groups.split(/\n+/)) {
      if (!line.trim()) continue;
      const i = line.indexOf('=');
      if (i < 0) return { ok: false, bad: line.trim() };
      const g = line.slice(0, i).trim();
      const role = line.slice(i + 1).trim().toLowerCase();
      if (!g) continue;
      if (!validRoleIds.has(role)) return { ok: false, bad: `${line.trim()} (role must be one of: ${initial.validRoles.map((r) => r.id).join(', ')})` };
      map[g] = role;
    }
    return { ok: true, map };
  }

  const doSave = useCallback(
    (stepupToken: string, groupRoleMap: Record<string, string>) => {
      setBusy(true);
      fetch('/api/auth/access-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stepupToken,
          adminEmails: linesToList(admins),
          allowedDomains: linesToList(domains),
          groupRoleMap,
        }),
        cache: 'no-store',
      })
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            env?: AccessPolicyInitial['env'];
            policy?: AccessPolicyInitial['policy'];
          };
          if (res.status !== 200) {
            toast.error(data.error || `Save failed (${res.status}).`);
            return;
          }
          if (data.env) setEnv(data.env);
          if (data.policy) {
            setAdmins(data.policy.adminEmails.join('\n'));
            setDomains(data.policy.allowedDomains.join('\n'));
            setGroups(mapToText(data.policy.groupRoleMap));
          }
          toast.success('Access policy saved.');
        })
        .catch(() => toast.error('Network error — please try again.'))
        .finally(() => setBusy(false));
    },
    [admins, domains]
  );

  function onSave() {
    const parsed = parseGroups();
    if (!parsed.ok) {
      toast.error(`Invalid group mapping: ${parsed.bad}`);
      return;
    }
    requireStepUp((token) => doSave(token, parsed.map));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-primary" aria-hidden />
          Access policy
        </CardTitle>
        <CardDescription>
          Who can sign in and at what role. These entries <strong className="text-foreground">add to</strong> the
          deploy-time environment allowlist (shown read-only below); they never remove it. Saving requires
          your account password.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {env.adminEmails.length > 0 || env.allowedDomains.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {env.adminEmails.map((e) => (
              <Badge key={`a-${e}`} variant="outline" className="font-mono text-xs text-muted-foreground">
                {e} <span className="ml-1 text-muted-foreground/70">(env admin)</span>
              </Badge>
            ))}
            {env.allowedDomains.map((d) => (
              <Badge key={`d-${d}`} variant="outline" className="font-mono text-xs text-muted-foreground">
                {d} <span className="ml-1 text-muted-foreground/70">(env domain)</span>
              </Badge>
            ))}
          </div>
        ) : null}

        <div className="grid gap-1.5">
          <Label htmlFor={adminsId}>Admin emails (one per line)</Label>
          <Textarea id={adminsId} value={admins} onChange={(e) => setAdmins(e.target.value)} rows={3} className="resize-y font-mono text-sm" placeholder="person@example.com" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={domainsId}>Allowed sign-in domains (one per line)</Label>
          <Textarea id={domainsId} value={domains} onChange={(e) => setDomains(e.target.value)} rows={3} className="resize-y font-mono text-sm" placeholder="example.com" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={groupsId}>IdP group → role (lines of group = role)</Label>
          <Textarea id={groupsId} value={groups} onChange={(e) => setGroups(e.target.value)} rows={3} className="resize-y font-mono text-sm" placeholder="EventStaff = authorized" />
          <p className="text-xs text-muted-foreground">
            Roles: {initial.validRoles.map((r) => r.id).join(', ')}.
          </p>
        </div>

        <div>
          <Button onClick={onSave} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
            Save policy
          </Button>
        </div>
      </CardContent>
      {stepUpModal}
    </Card>
  );
}
