'use client';

import * as React from 'react';
import Link from 'next/link';
import { IS_DEMO } from '@/lib/util/demo-flag';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// components/config/step-up.tsx — a reusable STEP-UP gate for the Config settings writes (integration
// keys, branding, access policy, tenant). Mirrors the inline StepUpModal in the account Security panel
// but exported as a hook so every Config card shares one re-auth flow: a sensitive save calls
// requireStepUp(run) → a password modal mints a fresh single-purpose token via /api/auth/stepup → the
// pending `run(token)` proceeds. A stolen session cookie can't write a setting without the password.

async function postStepup(password: string): Promise<{ token?: string; error?: string }> {
  try {
    const res = await fetch('/api/auth/stepup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      cache: 'no-store',
    });
    const data = (await res.json().catch(() => ({}))) as { stepupToken?: string; error?: string };
    if (res.status === 200 && typeof data.stepupToken === 'string') return { token: data.stepupToken };
    return { error: data.error || 'Could not confirm your password.' };
  } catch {
    return { error: 'Network error — please try again.' };
  }
}

function StepUpModal({
  open,
  onCancel,
  onToken,
}: {
  open: boolean;
  onCancel: () => void;
  onToken: (token: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // null = still resolving; true = challenge with the password; false = the account has no local
  // password (pure SSO) → step-up needs one, so we send them to Account → Security to set it.
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const pwId = useId();

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setError('');
    setHasPassword(null);
    let cancelled = false;
    fetch('/api/auth/2fa/status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setHasPassword(d && typeof d.hasPassword === 'boolean' ? d.hasPassword : true);
      })
      .catch(() => {
        if (!cancelled) setHasPassword(true); // fail safe: ask for the password
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const needsPassword = hasPassword === false;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (needsPassword) return; // no local password → can't step up; the modal points to Security
    setError('');
    setBusy(true);
    const res = await postStepup(password);
    setBusy(false);
    if (res.token) {
      onToken(res.token);
      return;
    }
    setError(res.error || 'Could not confirm it’s you.');
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Confirm it’s you</DialogTitle>
          <DialogDescription>
            {IS_DEMO
              ? 'This is a read-only demo — settings can’t be changed here.'
              : needsPassword
                ? 'Sensitive changes need your account password to confirm.'
                : 'Re-enter your account password to save this setting for everyone.'}
          </DialogDescription>
        </DialogHeader>
        {IS_DEMO ? (
          // Demo: every config write funnels through step-up, so blocking it here disables them all at
          // the UI (the server enforces the lock regardless).
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              The demo shows what you can configure, but settings are read-only. Deploy your own instance
              to change integration keys, permissions, branding, the tenant, and more.
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onCancel}>
                Close
              </Button>
            </DialogFooter>
          </div>
        ) : needsPassword ? (
          // Pure-SSO account: no password to challenge with. Step-up is an "are you sure?" gate, so we
          // require a local password — send them to set one (Account → Security), then retry.
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              You signed in with a linked account. Set a local password in Account → Security to confirm
              sensitive changes like this one.
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button asChild onClick={onCancel}>
                <Link href="/account">
                  <Lock aria-hidden />
                  Set a password
                </Link>
              </Button>
            </DialogFooter>
          </div>
        ) : (
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
            {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || hasPassword === null || !password}>
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Lock aria-hidden />}
                Confirm
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The shared step-up controller. Returns { requireStepUp, element }:
 *   • requireStepUp(run) — opens the modal; on success calls run(stepupToken).
 *   • element — render this ONCE in the card so the modal mounts.
 * Step-up always challenges with the account password. A Google/SSO-session admin who has set a local
 * password confirms with it; a pure-SSO account with no password is pointed to Account → Security to
 * set one first (see the /api/auth/stepup route).
 */
export function useStepUp(): {
  requireStepUp: (run: (token: string) => void) => void;
  element: React.ReactElement;
} {
  const [open, setOpen] = useState(false);
  const pending = useRef<((token: string) => void) | null>(null);

  const requireStepUp = useCallback((run: (token: string) => void) => {
    pending.current = run;
    setOpen(true);
  }, []);

  const element = (
    <StepUpModal
      open={open}
      onCancel={() => {
        setOpen(false);
        pending.current = null;
      }}
      onToken={(token) => {
        setOpen(false);
        const run = pending.current;
        pending.current = null;
        run?.(token);
      }}
    />
  );

  return { requireStepUp, element };
}
