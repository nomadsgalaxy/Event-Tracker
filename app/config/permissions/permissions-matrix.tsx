'use client';

import * as React from 'react';
import { useId, useState } from 'react';
import { Check, Minus, Lock, Plus, Trash2, Loader2, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/util/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Eyebrow } from '@/components/ui/eyebrow';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { EffectiveTable } from '@/lib/auth/rbac';
import { useUnsavedGuard, UnsavedChangesDialog } from '@/components/hooks/use-unsaved-guard';

// permissions-matrix.tsx — the EDITABLE role × capability matrix (Config > Permissions). The client
// half: toggle a capability per role, add/remove CUSTOM roles, Save / Reset to defaults behind a
// STEP-UP. Faithful to the eit_perms model + the source's admin Permissions UI:
//   • STRUCTURAL invariants (editable:false — db.*/session.*/admin.console/integration.keys/tls) render
//     LOCKED: their cells are read-only and reflect the seeded rank default. The server's
//     validateOverride refuses any attempt to re-grant them, so this lock is UX mirroring the authority.
//   • CONTEXT grants (self / lead-of-event) are shown per capability — they grant regardless of role, so
//     a cap with a ctx grant is "also granted" beyond the checkboxes.
//   • Save validates client-side (lifeline: at least one role must hold the admin caps; built-ins stay)
//     for fast feedback, then POSTs to /api/auth/perms which RE-VALIDATES + persists (the authority).
//   • A "customized for this site" indicator shows when an override is installed (table.customized).

const STEPUP_URL = '/api/auth/stepup';
const PERMS_URL = '/api/auth/perms';

// The admin LIFELINE caps (mirrors _LIFELINE_CAPS) — at least one role must keep these or the save is
// refused (you'd lock everyone out of this very table).
const LIFELINE_CAPS = ['admin.console', 'admin.users.local', 'admin.users.directory'];

async function api(url: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  } catch {
    return { status: 0, data: { error: 'Network error — please try again.' } };
  }
}

type Cap = EffectiveTable['capabilities'][number];
type RoleDefT = EffectiveTable['roles'][number];

interface MatrixState {
  roles: RoleDefT[];
  // role id -> Set of granted cap ids
  grants: Record<string, Set<string>>;
}

function tableToState(t: EffectiveTable): MatrixState {
  const grants: Record<string, Set<string>> = {};
  for (const [rid, caps] of Object.entries(t.grants)) grants[rid] = new Set(caps);
  return { roles: t.roles.map((r) => ({ ...r })), grants };
}

// The seeded (rank) grant a structural cap MUST keep — used to lock those cells to the rank rule.
function seededHas(cap: Cap, role: RoleDefT): boolean {
  return role.rank >= cap.minRank;
}

export function PermissionsMatrix({
  initialTable,
  myRole,
}: {
  initialTable: EffectiveTable;
  myRole: string;
}) {
  const [table, setTable] = useState<EffectiveTable>(initialTable);
  const [state, setState] = useState<MatrixState>(() => tableToState(initialTable));
  const [baseline, setBaseline] = useState<string>(() => serialize(tableToState(initialTable)));
  const [addRoleOpen, setAddRoleOpen] = useState(false);
  const [stepUp, setStepUp] = useState<null | { mode: 'save' | 'reset' }>(null);
  const [busy, setBusy] = useState(false);

  const caps = table.capabilities;
  const groups = React.useMemo(() => groupCaps(caps), [caps]);
  const roles = state.roles.slice().sort((a, b) => a.rank - b.rank);

  const dirty = serialize(state) !== baseline;
  const guard = useUnsavedGuard(dirty);

  function toggle(cap: Cap, roleId: string) {
    if (!cap.editable) return; // structural — locked
    setState((s) => {
      const next = { ...s.grants };
      const set = new Set(next[roleId] ?? []);
      if (set.has(cap.id)) set.delete(cap.id);
      else set.add(cap.id);
      next[roleId] = set;
      return { ...s, grants: next };
    });
  }

  function addRole(role: { id: string; label: string; rank: number }) {
    setState((s) => {
      // Seed the new role's grants by its rank (the default rule), so it starts sensible.
      const granted = new Set<string>();
      for (const c of caps) if (role.rank >= c.minRank) granted.add(c.id);
      return {
        roles: [...s.roles, { ...role, color: 'var(--muted-foreground)', hidden: false, builtin: false, desc: '' }],
        grants: { ...s.grants, [role.id]: granted },
      };
    });
  }

  function removeRole(roleId: string) {
    setState((s) => {
      const grants = { ...s.grants };
      delete grants[roleId];
      return { roles: s.roles.filter((r) => r.id !== roleId), grants };
    });
  }

  // Client-side pre-validate (fast feedback) — the server re-validates authoritatively.
  function clientValidate(): string | null {
    const ids = state.roles.map((r) => r.id);
    if (ids.length === 0) return 'At least one role is required.';
    if (new Set(ids).size !== ids.length) return 'Two roles share an id.';
    const ranks = state.roles.map((r) => r.rank);
    if (new Set(ranks).size !== ranks.length) return 'Two roles share a rank.';
    for (const cap of LIFELINE_CAPS) {
      const held = ids.some((rid) => state.grants[rid]?.has(cap));
      if (!held) return `At least one role must keep "${cap}" (admin lifeline).`;
    }
    return null;
  }

  function requestSave() {
    const err = clientValidate();
    if (err) {
      toast.error(err);
      return;
    }
    setStepUp({ mode: 'save' });
  }

  function requestReset() {
    setStepUp({ mode: 'reset' });
  }

  async function withStepUp(token: string) {
    const mode = stepUp?.mode;
    setStepUp(null);
    setBusy(true);
    try {
      let body: Record<string, unknown>;
      if (mode === 'reset') {
        body = { reset: true, stepupToken: token };
      } else {
        const grants: Record<string, string[]> = {};
        for (const [rid, set] of Object.entries(state.grants)) grants[rid] = [...set].sort();
        body = {
          stepupToken: token,
          roles: state.roles,
          grants,
          capsSeen: caps.map((c) => c.id),
        };
      }
      const { status, data } = await api(PERMS_URL, body);
      if (status !== 200) {
        toast.error(String(data.error || 'The save was refused.'));
        return;
      }
      // The server returns the fresh effective table — adopt it as the new baseline.
      const fresh = data as unknown as EffectiveTable;
      setTable(fresh);
      const freshState = tableToState(fresh);
      setState(freshState);
      setBaseline(serialize(freshState));
      toast.success(mode === 'reset' ? 'Reverted to the default permission table.' : 'Permission table saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header / actions */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Eyebrow>Permissions</Eyebrow>
          <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold text-foreground">
            Role × capability matrix
            {table.customized ? (
              <Badge variant="outline" className="gap-1 text-[10px] text-primary" style={{ color: 'var(--primary)', borderColor: 'var(--primary)' }}>
                <ShieldCheck className="size-2.5" aria-hidden /> Customized for this site
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px]">
                Defaults
              </Badge>
            )}
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Toggle a capability per role. Structural invariants are locked (the server refuses to re-grant
            them). Add or remove custom roles below. Saving requires a fresh password confirmation and is
            recorded in the audit log. The server evaluates the SAME table for every read + write, so the
            UI and enforcement can never drift.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={requestReset} disabled={busy || !table.customized}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}
            Reset to defaults
          </Button>
          <Button size="sm" onClick={requestSave} disabled={busy || !dirty}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
            Save permissions
          </Button>
        </div>
      </div>

      {/* Role chips + add/remove */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Roles</span>
        {roles.map((r) => (
          <span
            key={r.id}
            className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
            style={{ color: r.color, borderColor: r.color }}
          >
            <span className="inline-block size-1.5 rounded-full" style={{ background: r.color }} aria-hidden />
            {r.label}
            <span className="font-mono text-[10px] text-muted-foreground">r{r.rank}</span>
            {!r.builtin && (
              <button
                type="button"
                title={`Remove ${r.label}`}
                onClick={() => removeRole(r.id)}
                className="ml-0.5 rounded text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Remove role ${r.label}`}
              >
                <Trash2 className="size-3" aria-hidden />
              </button>
            )}
          </span>
        ))}
        <Button variant="outline" size="sm" onClick={() => setAddRoleOpen(true)}>
          <Plus className="size-4" aria-hidden /> Add role
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          you are <span className="font-mono text-foreground">{myRole}</span>
        </span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Check className="size-3.5 text-success" aria-hidden /> granted
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Minus className="size-3.5 text-muted-foreground/50" aria-hidden /> not granted
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Lock className="size-3.5 text-muted-foreground" aria-hidden /> structural — locked
        </span>
      </div>

      {/* The grouped matrix */}
      {groups.map((group) => (
        <section key={group.name} className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{group.name}</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-card">
                  <th className="min-w-[16rem] px-3 py-2 text-left font-medium">Capability</th>
                  {roles.map((r) => (
                    <th key={r.id} className="px-3 py-2 text-center font-medium" style={{ color: r.color }}>
                      {r.label}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">Enforced</th>
                </tr>
              </thead>
              <tbody>
                {group.caps.map((cap) => (
                  <tr key={cap.id} className="border-b border-border last:border-0">
                    <td className="max-w-0 px-3 py-2 align-top">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-foreground">{cap.label}</span>
                        {!cap.editable && (
                          <Badge variant="secondary" className="text-[10px]">
                            invariant
                          </Badge>
                        )}
                        {cap.ctx.length > 0 && (
                          <span
                            className="text-[10px] text-st-upcoming"
                            title={cap.ctx.map((c) => (c === 'self' ? 'self' : 'lead-of-event')).join(' / ')}
                          >
                            {cap.ctx.map((c) => (c === 'self' ? 'self' : 'lead')).join(' / ')}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{cap.desc}</p>
                      <code className="mt-0.5 block font-mono text-[10px] text-muted-foreground/70">{cap.id}</code>
                    </td>
                    {roles.map((r) => {
                      const locked = !cap.editable;
                      const has = locked ? seededHas(cap, r) : state.grants[r.id]?.has(cap.id) ?? false;
                      return (
                        <td key={r.id} className="px-3 py-2 text-center align-top">
                          {locked ? (
                            <span className="inline-flex items-center justify-center" title="Structural invariant — not editable">
                              {has ? (
                                <Check className="size-4 text-success/60" aria-label="granted (locked)" />
                              ) : (
                                <Lock className="size-3.5 text-muted-foreground/40" aria-label="not granted (locked)" />
                              )}
                            </span>
                          ) : (
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={has}
                              aria-label={`${cap.label} for ${r.label}`}
                              onClick={() => toggle(cap, r.id)}
                              className={cn(
                                'inline-flex size-5 items-center justify-center rounded border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                                has ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:border-foreground/40'
                              )}
                            >
                              {has ? <Check className="size-3.5" aria-hidden /> : null}
                            </button>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right align-top">
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px] capitalize',
                          cap.enforced === 'both' && 'text-success',
                          cap.enforced === 'server' && 'text-st-upcoming',
                          cap.enforced === 'client' && 'text-warning'
                        )}
                      >
                        {cap.enforced}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <AddRoleDialog
        open={addRoleOpen}
        existingIds={state.roles.map((r) => r.id)}
        existingRanks={state.roles.map((r) => r.rank)}
        onOpenChange={setAddRoleOpen}
        onAdd={(role) => {
          addRole(role);
          setAddRoleOpen(false);
        }}
      />

      <StepUpModal
        open={stepUp !== null}
        title={stepUp?.mode === 'reset' ? 'Confirm reset' : 'Confirm save'}
        onCancel={() => setStepUp(null)}
        onToken={withStepUp}
      />

      <UnsavedChangesDialog
        guard={guard}
        description="The permission changes haven’t been saved. Leaving now will lose them."
      />
    </div>
  );
}

function groupCaps(caps: Cap[]): { name: string; caps: Cap[] }[] {
  const groups: { name: string; caps: Cap[] }[] = [];
  for (const cap of caps) {
    let g = groups.find((x) => x.name === cap.group);
    if (!g) {
      g = { name: cap.group, caps: [] };
      groups.push(g);
    }
    g.caps.push(cap);
  }
  return groups;
}

function serialize(s: MatrixState): string {
  const roles = s.roles
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((r) => `${r.id}:${r.rank}:${r.label}`)
    .join('|');
  const grants = Object.keys(s.grants)
    .sort()
    .map((rid) => `${rid}=${[...s.grants[rid]].sort().join(',')}`)
    .join('|');
  return roles + '||' + grants;
}

function AddRoleDialog({
  open,
  existingIds,
  existingRanks,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  existingIds: string[];
  existingRanks: number[];
  onOpenChange: (v: boolean) => void;
  onAdd: (role: { id: string; label: string; rank: number }) => void;
}) {
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [rank, setRank] = useState('');

  function reset() {
    setId('');
    setLabel('');
    setRank('');
  }

  function submit() {
    const cleanId = id.trim().toLowerCase().replace(/\s+/g, '-');
    const r = Number(rank);
    if (!cleanId) return toast.error('A role id is required.');
    if (existingIds.includes(cleanId)) return toast.error('That role id already exists.');
    if (!Number.isInteger(r)) return toast.error('Rank must be a whole number.');
    if (existingRanks.includes(r)) return toast.error('Another role already uses that rank.');
    onAdd({ id: cleanId, label: label.trim() || cleanId, rank: r });
    reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a custom role</DialogTitle>
          <DialogDescription>
            A new role gets the default grants for its rank, which you then tune. Pick a rank not already
            in use (rank orders privilege low → high).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="role-id">Id</Label>
            <Input id="role-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. supervisor" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="role-label">Label</Label>
            <Input id="role-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Supervisor" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="role-rank">Rank</Label>
            <Input id="role-rank" type="number" value={rank} onChange={(e) => setRank(e.target.value)} placeholder="e.g. 2" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Add role</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Step-up modal (re-auth with the current password → a short-lived token). Mirrors the account
// security panel's StepUpModal — every sensitive admin write (here, the perms save/reset) presents
// the token, which the server re-verifies against the session email.
function StepUpModal({
  open,
  title,
  onCancel,
  onToken,
}: {
  open: boolean;
  title: string;
  onCancel: () => void;
  onToken: (token: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pwId = useId();

  React.useEffect(() => {
    if (open) {
      setPassword('');
      setError('');
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { status, data } = await api(STEPUP_URL, { password });
      if (status === 200 && typeof data.stepupToken === 'string') {
        onToken(data.stepupToken);
        return;
      }
      setError(String(data.error || 'Could not confirm your password.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Re-enter your password to change the permission table. This requires a local-password sign-in.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={pwId}>Password</Label>
            <Input
              id={pwId}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
              required
            />
          </div>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Lock aria-hidden />}
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default PermissionsMatrix;
