'use client';

import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Fingerprint,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Unlink,
} from 'lucide-react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Eyebrow } from '@/components/ui/eyebrow';
import { DetailRow } from '@/components/ui/detail-row';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { effectiveTable, isDangerousCap, dangerousCaps } from '@/lib/auth/rbac';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { QrCode } from '@/components/auth/qr-code';
import { WebhookSubscriptionsCard } from '@/app/config/admin/webhook-subscriptions-card';

// components/account/security-panel.tsx — the Account → Security self-management tab. The SERVER is
// the sole authority for every action here (the /api/auth/* routes re-check the session + step-up +
// secrets); this is the client shell. Sensitive actions (replace TOTP, regenerate recovery, remove a
// passkey, unlink an identity, create an API key) require a fresh STEP-UP (a re-entered password →
// short-lived single-purpose token) — gated through the StepUpModal so a stolen session cookie can't
// silently rotate a victim's factors. Mirrors index.html AccountSecurityTab + the eit_auth/eit_api/
// eit_calendar/eit_webauthn endpoints.

// ── tiny fetch helper ──────────────────────────────────────────────────────────────────────────
async function api(url: string, body?: unknown, method = 'POST'): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  return { status: res.status, data };
}

interface TwoFaStatus {
  email: string;
  src: string;
  isLocal: boolean;
  hasPassword: boolean;
  twofaRequired: boolean;
  totpEnrolled: boolean;
  passkeyCount: number;
  recoveryRemaining: number;
  identities: { provider: string; email?: string; linkedAt?: number }[];
}

// ── shared layout helpers (match account-tabs FieldGroup) ────────────────────────────────────────
function FieldGroup({
  title,
  description,
  action,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Eyebrow asChild>
            <h2>{title}</h2>
          </Eyebrow>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error('Could not copy to clipboard.');
        }
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

// ── Step-up modal (re-auth with the current password → a short-lived step-up token) ───────────────
// A plain "are you sure?" confirm before a sensitive security change. Replaces the old password
// step-up: the account is local OR OAuth-only (an OAuth-only account has no password to re-enter), so
// these self-service changes are gated by a full session + an explicit confirm, not a re-auth.
function StepUpModal({
  open,
  onCancel,
  onToken,
}: {
  open: boolean;
  onCancel: () => void;
  onToken: (token: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Are you sure?</DialogTitle>
          <DialogDescription>Confirm you want to make this change to your account security.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={() => onToken('')}>
            <Check aria-hidden /> Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// A one-time recovery-codes dialog — shown ONCE after enroll/regenerate; copy + acknowledge.
function RecoveryCodesDialog({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <Dialog open={codes.length > 0} onOpenChange={(o) => { if (!o) onDone(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save your recovery codes</DialogTitle>
          <DialogDescription>
            Each code works ONCE if you lose your authenticator. Store them somewhere safe — they
            won’t be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/40 p-3 font-mono text-sm">
          {codes.map((c) => (
            <span key={c} className="tabular-nums">{c}</span>
          ))}
        </div>
        <DialogFooter className="sm:justify-between">
          <CopyButton value={codes.join('\n')} label="Copy all" />
          <Button type="button" onClick={onDone}>
            <Check aria-hidden /> I’ve saved them
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface SecurityInitial {
  email: string;
  source: string;
  role: string;
}

export function SecurityPanel({ initial }: { initial: SecurityInitial }) {
  const [status, setStatus] = useState<TwoFaStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Step-up gating: a pending sensitive action waits for a token, then runs.
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const pendingAction = useRef<((token: string) => void) | null>(null);
  const requireStepUp = useCallback((run: (token: string) => void) => {
    pendingAction.current = run;
    setStepUpOpen(true);
  }, []);

  // One-time recovery codes to display.
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const { status: s, data } = await api('/api/auth/2fa/status', undefined, 'GET');
    if (s === 200) setStatus(data as unknown as TwoFaStatus);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasPassword = status?.hasPassword ?? false;
  // How THIS session signed in (for the Method label only).
  const signedInLocally = status?.isLocal ?? (initial.source.toLowerCase() === 'local' || !initial.source);
  // "Has a local credential" — drives the password-backed security features (2FA, passkeys, API keys,
  // unlink). A user who set a password HAS one even when the current session came from SSO (Google),
  // so don't gate those features on the session source — gate on the password actually existing.
  const isLocal = signedInLocally || hasPassword;

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading your security settings…
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <FieldGroup title="Sign-in">
        <dl className="flex flex-col divide-y divide-border">
          <DetailRow label="Method" value={signedInLocally ? 'Password (local account)' : initial.source} className="capitalize" />
          <DetailRow label="Email" value={initial.email} mono />
        </dl>
      </FieldGroup>

      <PasswordCard hasPassword={hasPassword} isLocal={isLocal} onChanged={refresh} />

      <TwoFactorCard
        status={status}
        isLocal={isLocal}
        hasPassword={hasPassword}
        onRefresh={refresh}
        requireStepUp={requireStepUp}
        onRecoveryCodes={setRecoveryCodes}
      />

      <PasskeysCard onRefresh={refresh} requireStepUp={requireStepUp} />

      <LinkedLoginsCard status={status} isLocal={isLocal} onRefresh={refresh} requireStepUp={requireStepUp} />

      <ApiKeysCard />

      {/* Webhooks live beside API keys: same per-user mint flow, but editable after creation. */}
      <WebhookSubscriptionsCard scope="mine" />

      <CalendarCard />

      <StepUpModal
        open={stepUpOpen}
        onCancel={() => {
          setStepUpOpen(false);
          pendingAction.current = null;
        }}
        onToken={(token) => {
          setStepUpOpen(false);
          const run = pendingAction.current;
          pendingAction.current = null;
          run?.(token);
        }}
      />
      <RecoveryCodesDialog codes={recoveryCodes} onDone={() => setRecoveryCodes([])} />
    </div>
  );
}

// ── Password card (change OR set-initial for SSO #53) ────────────────────────────────────────────
function PasswordCard({ hasPassword, isLocal, onChanged }: { hasPassword: boolean; isLocal: boolean; onChanged: () => void }) {
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [busy, setBusy] = useState(false);

  // When the account has no password yet (SSO-only), this card SETS an initial one (#53) — no old pw.
  const settingInitial = !hasPassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (newPw.length < 8) return toast.error('Your new password must be at least 8 characters.');
    if (newPw !== confirmPw) return toast.error('The two passwords do not match.');
    setBusy(true);
    try {
      const { status, data } = settingInitial
        ? await api('/api/auth/password/set', { newPassword: newPw })
        : await api('/api/auth/password/change', { oldPassword: oldPw, newPassword: newPw });
      if (status === 200 && data.ok) {
        toast.success(settingInitial ? 'Password set. You can now use password sign-in and security features.' : 'Password changed.');
        setOldPw('');
        setNewPw('');
        setConfirmPw('');
        onChanged();
        return;
      }
      toast.error(String(data.error || 'Could not update your password.'));
    } catch {
      toast.error('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <FieldGroup
      title={settingInitial ? 'Set a password' : 'Change password'}
      description={
        settingInitial
          ? 'Your account signs in with an external provider. Set a local password to also use password sign-in, two-factor, passkeys, and API keys.'
          : 'Use at least 8 characters.'
      }
    >
      <form onSubmit={submit} className="grid max-w-md gap-3">
        {!settingInitial ? (
          <div className="grid gap-1.5">
            <Label htmlFor="cur-pw" className="text-xs text-muted-foreground">Current password</Label>
            <Input id="cur-pw" type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" required />
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor="set-new-pw" className="text-xs text-muted-foreground">New password</Label>
          <Input id="set-new-pw" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="set-confirm-pw" className="text-xs text-muted-foreground">Confirm new password</Label>
          <Input id="set-confirm-pw" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" required />
        </div>
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
            {settingInitial ? 'Set password' : 'Change password'}
          </Button>
        </div>
      </form>
    </FieldGroup>
  );
}

// ── Two-factor (TOTP) card ───────────────────────────────────────────────────────────────────────
function TwoFactorCard({
  status,
  isLocal,
  hasPassword,
  onRefresh,
  requireStepUp,
  onRecoveryCodes,
}: {
  status: TwoFaStatus | null;
  isLocal: boolean;
  hasPassword: boolean;
  onRefresh: () => void;
  requireStepUp: (run: (token: string) => void) => void;
  onRecoveryCodes: (codes: string[]) => void;
}) {
  const enrolled = status?.totpEnrolled ?? false;
  const recoveryRemaining = status?.recoveryRemaining ?? 0;
  const [enrolling, setEnrolling] = useState(false);
  const [otpauthUri, setOtpauthUri] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  // Start enrollment. A FIRST-TIME enroll (no existing TOTP) needs no step-up; REPLACING an existing
  // authenticator requires step-up (the server enforces this — we pass the token when we have it).
  function beginEnroll(stepupToken?: string) {
    setBusy(true);
    api('/api/auth/totp/setup', stepupToken ? { stepupToken } : {})
      .then(({ status: s, data }) => {
        if (s === 200) {
          setOtpauthUri(String(data.otpauthUri ?? ''));
          setSecret(String(data.secret ?? ''));
          setEnrolling(true);
        } else {
          toast.error(String(data.error || 'Could not start enrollment.'));
        }
      })
      .catch(() => toast.error('Network error — please try again.'))
      .finally(() => setBusy(false));
  }

  function onEnrollClick() {
    if (enrolled) requireStepUp((token) => beginEnroll(token)); // replace ⇒ step-up
    else beginEnroll(); // first-time ⇒ no step-up
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { status: s, data } = await api('/api/auth/totp/confirm', { code: code.trim() });
      if (s === 200 && data.ok) {
        const codes = (data.recoveryCodes as string[] | undefined) ?? [];
        onRecoveryCodes(codes);
        toast.success('Two-factor authentication enabled.');
        setEnrolling(false);
        setCode('');
        setOtpauthUri('');
        setSecret('');
        onRefresh();
        return;
      }
      toast.error(String(data.error || 'That code was not valid.'));
    } catch {
      toast.error('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  function regenerateRecovery() {
    requireStepUp(async (token) => {
      const { status: s, data } = await api('/api/auth/recovery/regenerate', { stepupToken: token });
      if (s === 200 && Array.isArray(data.recoveryCodes)) {
        onRecoveryCodes(data.recoveryCodes as string[]);
        onRefresh();
      } else {
        toast.error(String(data.error || 'Could not regenerate recovery codes.'));
      }
    });
  }

  // 2FA management needs a LOCAL password account.
  if (!isLocal || !hasPassword) {
    return (
      <FieldGroup title="Two-factor authentication" description="Adds a one-time code from an authenticator app at sign-in.">
        <p className="text-xs text-muted-foreground">
          Set a local password above to enable two-factor authentication for this account.
        </p>
      </FieldGroup>
    );
  }

  return (
    <FieldGroup
      title="Two-factor authentication"
      description="Require a one-time code from an authenticator app when you sign in."
      action={
        enrolled ? (
          <Badge variant="outline" className="gap-1 text-[var(--success)]">
            <ShieldCheck className="size-3" aria-hidden /> Enabled
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <ShieldOff className="size-3" aria-hidden /> Off
          </Badge>
        )
      }
    >
      {enrolling ? (
        <form onSubmit={confirmEnroll} className="flex flex-col items-start gap-3">
          <p className="text-xs text-muted-foreground">
            Scan with your authenticator app, then enter the 6-digit code to confirm.
          </p>
          <div className="flex flex-col items-center gap-2 self-center sm:self-start">
            {otpauthUri ? <QrCode value={otpauthUri} alt="Authenticator setup QR code" /> : null}
            {secret ? (
              <p className="text-center text-xs text-muted-foreground">
                Manual key: <span className="font-mono text-foreground break-all">{secret}</span>
              </p>
            ) : null}
          </div>
          <div className="grid w-full max-w-xs gap-1.5">
            <Label htmlFor="totp-confirm" className="text-xs text-muted-foreground">6-digit code</Label>
            <Input id="totp-confirm" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
              Confirm
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setEnrolling(false); setCode(''); }}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          {enrolled ? (
            <p className="text-xs text-muted-foreground">
              {recoveryRemaining} recovery {recoveryRemaining === 1 ? 'code' : 'codes'} remaining.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant={enrolled ? 'outline' : 'default'} onClick={onEnrollClick} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
              {enrolled ? 'Replace authenticator' : 'Set up two-factor'}
            </Button>
            {enrolled ? (
              <Button type="button" variant="outline" onClick={regenerateRecovery}>
                <RefreshCw aria-hidden /> Regenerate recovery codes
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </FieldGroup>
  );
}

// ── Passkeys card ────────────────────────────────────────────────────────────────────────────────
interface PublicPasskey {
  id: string;
  label?: string;
  addedAt?: number;
  counter: number;
}
function PasskeysCard({ onRefresh, requireStepUp }: { onRefresh: () => void; requireStepUp: (run: (token: string) => void) => void }) {
  const [keys, setKeys] = useState<PublicPasskey[]>([]);
  const [supported, setSupported] = useState(false);
  const [secure, setSecure] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      setSecure(typeof window !== 'undefined' && window.isSecureContext);
      setSupported(browserSupportsWebAuthn());
    } catch {
      setSupported(false);
    }
  }, []);

  const load = useCallback(async () => {
    const { status, data } = await api('/api/auth/passkey/list');
    if (status === 200 && Array.isArray(data.passkeys)) setKeys(data.passkeys as PublicPasskey[]);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function addPasskey() {
    setBusy(true);
    try {
      const begin = await api('/api/auth/passkey/register/begin');
      if (begin.status !== 200) {
        toast.error(String(begin.data.error || 'Could not start passkey registration.'));
        return;
      }
      const options = begin.data.options as Parameters<typeof startRegistration>[0]['optionsJSON'];
      let attestation;
      try {
        attestation = await startRegistration({ optionsJSON: options });
      } catch {
        toast.error('Passkey registration was cancelled.');
        return;
      }
      const finish = await api('/api/auth/passkey/register/finish', {
        state: begin.data.state,
        credential: attestation,
        label: navigator.platform || 'This device',
      });
      if (finish.status === 200 && finish.data.ok) {
        toast.success('Passkey added.');
        await load();
        onRefresh();
        return;
      }
      toast.error(String(finish.data.error || 'Could not register that passkey.'));
    } catch {
      toast.error('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  function removePasskey(id: string) {
    requireStepUp(async (token) => {
      const { status, data } = await api('/api/auth/passkey/remove', { id, stepupToken: token });
      if (status === 200 && data.ok) {
        toast.success('Passkey removed.');
        await load();
        onRefresh();
      } else {
        toast.error(String(data.error || 'Could not remove that passkey.'));
      }
    });
  }

  return (
    <FieldGroup
      title="Passkeys"
      description="Phishing-resistant sign-in with your device’s biometric or PIN."
      action={
        secure && supported ? (
          <Button type="button" variant="outline" size="sm" onClick={addPasskey} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
            Add passkey
          </Button>
        ) : null
      }
    >
      {!secure || !supported ? (
        <p className="text-xs text-muted-foreground">
          Passkeys need a secure (HTTPS) connection and a supported browser. They’re unavailable here.
        </p>
      ) : keys.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          <Fingerprint className="size-5 shrink-0" aria-hidden />
          No passkeys yet. Add one to sign in without a password.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex items-center gap-2 text-sm">
                <Fingerprint className="size-4 text-muted-foreground" aria-hidden />
                <span>{k.label || 'Passkey'}</span>
                {k.addedAt ? <span className="text-xs text-muted-foreground">· added {new Date(k.addedAt).toLocaleDateString()}</span> : null}
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => removePasskey(k.id)} aria-label="Remove passkey">
                <Trash2 aria-hidden /> Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </FieldGroup>
  );
}

// ── Linked logins (OIDC identities) ──────────────────────────────────────────────────────────────
function LinkedLoginsCard({
  status,
  isLocal,
  onRefresh,
  requireStepUp,
}: {
  status: TwoFaStatus | null;
  isLocal: boolean;
  onRefresh: () => void;
  requireStepUp: (run: (token: string) => void) => void;
}) {
  const identities = status?.identities ?? [];

  function unlink(provider: string) {
    requireStepUp(async (token) => {
      const { status: s, data } = await api('/api/auth/identity/unlink', { provider, stepupToken: token });
      if (s === 200 && data.ok) {
        toast.success(`Unlinked ${provider}.`);
        onRefresh();
      } else {
        toast.error(String(data.error || 'Could not unlink that provider.'));
      }
    });
  }

  return (
    <FieldGroup
      title="Linked logins"
      description="External sign-in providers connected to this account."
      action={
        <Button asChild variant="outline" size="sm">
          <a href="/api/auth/google/start?next=/account">
            <Link2 aria-hidden /> Link Google
          </a>
        </Button>
      }
    >
      {identities.length === 0 ? (
        <p className="text-xs text-muted-foreground">No external logins linked.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {identities.map((i) => (
            <li key={`${i.provider}:${i.email ?? ''}`} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex flex-col">
                <span className="text-sm capitalize">{i.provider}</span>
                {i.email ? <span className="text-xs text-muted-foreground">{i.email}</span> : null}
              </div>
              {isLocal ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => unlink(i.provider)}>
                  <Unlink aria-hidden /> Unlink
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Set a password to unlink</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </FieldGroup>
  );
}

// ── API keys card ────────────────────────────────────────────────────────────────────────────────
interface PublicApiKey {
  id: string;
  label: string;
  scope: string;
  caps: string[];
  createdAt?: number;
  lastUsedAt?: number | null;
}

// The full capability registry (labels + groups) is the SAME isomorphic table the server enforces, so
// the picker shows exactly what a key can be scoped to. ownerCaps (from the server) is the LIVE ceiling
// — a cap the owner doesn't currently hold is shown disabled. Only editable caps are user-pickable
// (structural/self-service caps like db.read.session are implied; admin-class caps are off the API).
const PICKABLE_CAPS = effectiveTable().capabilities.filter((c) => c.editable);
const CAP_GROUP_ORDER = ['Events', 'Inventory & tags', 'Personal data (PII)', 'Administration'];
const CAP_LABEL: Record<string, string> = Object.fromEntries(PICKABLE_CAPS.map((c) => [c.id, c.label]));
function capSummary(k: PublicApiKey): string {
  const writeOrPii = (k.caps || []).filter((c) => c !== 'db.read.session');
  if (writeOrPii.length === 0) return 'Read only';
  return `${writeOrPii.length} ${writeOrPii.length === 1 ? 'capability' : 'capabilities'}`;
}

function ApiKeysCard() {
  const [keys, setKeys] = useState<PublicApiKey[]>([]);
  const [tokenPrefix, setTokenPrefix] = useState('eitk_');
  const [ownerCaps, setOwnerCaps] = useState<string[]>([]);
  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newToken, setNewToken] = useState('');
  const [confirmDanger, setConfirmDanger] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    const { status, data } = await api('/api/auth/apikeys', undefined, 'GET');
    if (status === 200) {
      setKeys((data.keys as PublicApiKey[] | undefined) ?? []);
      setOwnerCaps((data.ownerCaps as string[] | undefined) ?? []);
      if (typeof data.tokenPrefix === 'string') setTokenPrefix(data.tokenPrefix);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const ownerSet = new Set(ownerCaps);
  // The caps this owner can actually grant a key, grouped for the picker.
  const grantable = PICKABLE_CAPS.filter((c) => ownerSet.has(c.id));
  const groups = CAP_GROUP_ORDER.map((g) => ({ group: g, caps: grantable.filter((c) => c.group === g) })).filter((g) => g.caps.length);

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Create the key. acknowledge=true is sent only after the user clears the danger confirmation below;
  // the server independently requires it for admin/destructive caps. A full session is the gate (no
  // step-up — the account may be OAuth-only with no password to re-enter).
  async function proceedCreate(acknowledge: boolean) {
    const caps = [...selected].filter((c) => ownerSet.has(c));
    const { status, data } = await api('/api/auth/apikeys/create', {
      label: label.trim() || 'API key',
      caps,
      acknowledgeRisk: acknowledge,
    });
    if (status === 200 && typeof data.token === 'string') {
      setNewToken(data.token);
      setLabel('');
      setSelected(new Set());
      await load();
    } else {
      toast.error(String(data.error || 'Could not create the key.'));
    }
  }

  function createKey() {
    // If the selection grants administrative access or the ability to delete data, make the user
    // explicitly confirm (with the back-up-your-DB warning) BEFORE the step-up. A safe (read/edit-only)
    // key skips straight to step-up.
    const danger = dangerousCaps([...selected].filter((c) => ownerSet.has(c)));
    if (danger.length > 0) {
      setConfirmDanger(danger);
      return;
    }
    proceedCreate(false);
  }

  async function revokeKey(id: string) {
    const { status, data } = await api('/api/auth/apikeys/revoke', { id });
    if (status === 200 && data.ok) {
      toast.success('API key revoked.');
      await load();
    } else {
      toast.error(String(data.error || 'Could not revoke that key.'));
    }
  }

  return (
    <FieldGroup title="API keys" description="User-bound keys for the scoped REST API + MCP server. A key can only do what you can — and only the capabilities you select. The full key is shown once at creation.">
      <div className="flex flex-col gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="key-label" className="text-xs text-muted-foreground">Label</Label>
          <Input id="key-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. CI export" className="w-64" />
        </div>

        <div className="grid gap-2 rounded-md border border-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Capabilities</span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set(grantable.map((c) => c.id)))}>
                Match my access
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Read only
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            With nothing selected the key is read-only. Demoting your role narrows every key you hold automatically.
          </p>
          {groups.map(({ group, caps }) => (
            <div key={group} className="grid gap-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group}</span>
              {caps.map((c) => (
                <label key={c.id} className="flex items-start gap-2 text-xs">
                  <Checkbox
                    checked={selected.has(c.id)}
                    onCheckedChange={(v) => toggle(c.id, v === true)}
                    aria-label={c.label}
                    className="mt-0.5"
                  />
                  <span className="flex flex-col">
                    <span className="flex items-center gap-1.5">
                      {c.label}
                      {isDangerousCap(c.id) ? (
                        <span
                          className="rounded bg-[color-mix(in_oklab,var(--destructive)_15%,transparent)] px-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--destructive)]"
                          title={c.group === 'Administration' ? undefined : 'Potentially Destructive'}
                          aria-label={c.group === 'Administration' ? undefined : 'Potentially Destructive'}
                        >
                          {c.group === 'Administration' ? 'admin' : 'D'}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground">{c.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          ))}
          {groups.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">Your role grants no extra capabilities — keys will be read-only.</p>
          ) : null}
        </div>

        <Button type="button" onClick={createKey} className="self-start">
          <Plus aria-hidden /> Create key
        </Button>

        {newToken ? (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--success)] bg-[color-mix(in_oklab,var(--success)_10%,transparent)] p-3">
            <p className="text-xs font-medium text-[var(--success)]">Copy your new key now — it won’t be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs">{newToken}</code>
              <CopyButton value={newToken} />
            </div>
            <Button type="button" variant="ghost" size="sm" className="self-end" onClick={() => setNewToken('')}>
              Done
            </Button>
          </div>
        ) : null}

        {keys.length === 0 ? (
          <p className="text-xs text-muted-foreground">No API keys yet. Keys begin with <code className="font-mono">{tokenPrefix}</code>.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {keys.map((k) => {
              const reduced = (k.caps || []).some((c) => !ownerSet.has(c));
              return (
                <li key={k.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="flex flex-col">
                    <span className="text-sm">{k.label}</span>
                    <span className="text-xs text-muted-foreground">
                      <code className="font-mono">{tokenPrefix}{k.id}…</code> · {capSummary(k)}
                      {k.createdAt ? ` · created ${new Date(k.createdAt).toLocaleDateString()}` : ''}
                      {' · '}
                      {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'never used'}
                      {reduced ? ' · reduced to your current role' : ''}
                    </span>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => revokeKey(k.id)}>
                    <Trash2 aria-hidden /> Revoke
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog open={confirmDanger !== null} onOpenChange={(o) => { if (!o) setConfirmDanger(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[var(--destructive)]">ARE YOU SURE!?</DialogTitle>
            <DialogDescription>
              You’re about to create an API key that can <strong>delete data</strong> or use{' '}
              <strong>administrative functions</strong>. Please be sure your database is on a backup
              schedule before you proceed.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 rounded-md border border-[var(--destructive)] bg-[color-mix(in_oklab,var(--destructive)_8%,transparent)] p-3 text-xs">
            <span className="font-medium">This key would be granted:</span>
            <ul className="list-disc pl-4">
              {(confirmDanger ?? []).map((id) => (
                <li key={id}>{CAP_LABEL[id] ?? id}</li>
              ))}
            </ul>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmDanger(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmDanger(null);
                proceedCreate(true);
              }}
            >
              I understand — continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </FieldGroup>
  );
}

// ── Calendar subscription card ───────────────────────────────────────────────────────────────────
function CalendarCard() {
  const [personalUrl, setPersonalUrl] = useState('');
  const [globalUrl, setGlobalUrl] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { status, data } = await api('/api/auth/calendar', undefined, 'GET');
    if (status === 200) {
      setPersonalUrl(String(data.personalUrl ?? ''));
      setGlobalUrl(typeof data.globalUrl === 'string' ? data.globalUrl : '');
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function regenerate(which: 'personal' | 'global') {
    const { status, data } = await api('/api/auth/calendar/regenerate', { which });
    if (status === 200 && typeof data.url === 'string') {
      if (which === 'global') setGlobalUrl(data.url);
      else setPersonalUrl(data.url);
      toast.success(`${which === 'global' ? 'Global' : 'Personal'} calendar link regenerated. The old link no longer works.`);
    } else {
      toast.error(String(data.error || 'Could not regenerate the link.'));
    }
  }

  return (
    <FieldGroup title="Calendar subscription" description="Subscribe in any calendar app (Add calendar → From URL). Read-only, auto-refreshing.">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Your events + travel</Label>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs text-muted-foreground">{personalUrl}</code>
              <CopyButton value={personalUrl} />
              <Button type="button" variant="ghost" size="sm" onClick={() => regenerate('personal')} aria-label="Regenerate personal link">
                <RefreshCw aria-hidden />
              </Button>
            </div>
          </div>
          {globalUrl ? (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Global schedule (all events)</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs text-muted-foreground">{globalUrl}</code>
                <CopyButton value={globalUrl} />
                <Button type="button" variant="ghost" size="sm" onClick={() => regenerate('global')} aria-label="Regenerate global link">
                  <RefreshCw aria-hidden />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </FieldGroup>
  );
}

export default SecurityPanel;
