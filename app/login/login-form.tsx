'use client';

import { useEffect, useId, useState } from 'react';
import { Eye, EyeOff, Fingerprint, KeyRound, Loader2, LogIn, ShieldCheck, TriangleAlert } from 'lucide-react';
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { QrCode } from '@/components/auth/qr-code';

// app/login/login-form.tsx — the multi-stage sign-in card. The SERVER is the sole authority over what
// session is granted (lib/auth + the /api/auth/* routes); this is the interactive shell that walks the
// state machine the server returns:
//
//   password ─POST /api/auth/login─▶ ok                          → redirect (full session cookie set)
//                                  ├▶ twofa:'totp_required'      → STAGE pending2fa  (6-digit code)
//                                  │     └ recovery-code toggle  → POST /api/auth/recovery
//                                  ├▶ twofa:'totp_setup_required'→ STAGE setup2fa    (QR enroll+confirm)
//                                  └▶ mustChangePassword         → STAGE mustchangepw(new password)
//   passkey  ─begin+assert+finish─▶ ok                           → redirect (passwordless)
//
// The staging tokens (pendingToken/setupToken/changeToken) ride the response body and are echoed back
// to the finishing route, which re-verifies them server-side. A full session ONLY ever lands as the
// HttpOnly cookie the server sets — the client never fabricates auth state.

type Stage = 'password' | 'pending2fa' | 'setup2fa' | 'mustchangepw';

interface LoginResp {
  ok?: boolean;
  error?: string;
  twofa?: 'totp_required' | 'totp_setup_required';
  pendingToken?: string;
  setupToken?: string;
  mustChangePassword?: boolean;
  changeToken?: string;
  email?: string;
  recoveryRemaining?: number;
  recoveryCodes?: string[];
  hint?: string;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

function ErrorAlert({ id, message }: { id: string; message: string }) {
  return (
    <Alert variant="destructive" id={id} aria-live="assertive">
      <TriangleAlert aria-hidden />
      <AlertTitle>Sign-in failed</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export default function LoginForm({ next }: { next?: string }) {
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [stage, setStage] = useState<Stage>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Staging tokens carried between steps (opaque, server-verified).
  const [pendingToken, setPendingToken] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [changeToken, setChangeToken] = useState('');

  // pending2fa
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  // setup2fa
  const [otpauthUri, setOtpauthUri] = useState('');
  const [secret, setSecret] = useState('');
  const [enrollCode, setEnrollCode] = useState('');
  // mustchangepw
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');

  // Passkey support (mount-gated; secure-context only).
  const [passkeySupported, setPasskeySupported] = useState(false);
  useEffect(() => {
    try {
      setPasskeySupported(typeof window !== 'undefined' && window.isSecureContext && browserSupportsWebAuthn());
    } catch {
      setPasskeySupported(false);
    }
  }, []);

  const dest = next || '/';
  function done() {
    // Hard navigation so middleware + the server re-read the just-set HttpOnly cookie.
    window.location.assign(dest);
  }

  function resetToPassword() {
    setStage('password');
    setPendingToken('');
    setSetupToken('');
    setChangeToken('');
    setCode('');
    setEnrollCode('');
    setOtpauthUri('');
    setSecret('');
    setNewPw('');
    setConfirmPw('');
    setUseRecovery(false);
    setError('');
  }

  // ── Stage 1: password ──────────────────────────────────────────────────────────────────────
  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!email || !password) {
      setError('Enter both your email and password.');
      return;
    }
    setBusy(true);
    try {
      const { status, data } = await postJson('/api/auth/login', { email, password });
      const r = data as LoginResp;
      if (status === 200 && r.ok) return done();
      if (status === 200 && r.twofa === 'totp_required' && r.pendingToken) {
        setPendingToken(r.pendingToken);
        setStage('pending2fa');
        return;
      }
      if (status === 200 && r.twofa === 'totp_setup_required' && r.setupToken) {
        setSetupToken(r.setupToken);
        // Kick off enrollment immediately so the QR is ready.
        const setup = await postJson('/api/auth/totp/setup', { setupToken: r.setupToken });
        if (setup.status === 200) {
          setOtpauthUri(String(setup.data.otpauthUri ?? ''));
          setSecret(String(setup.data.secret ?? ''));
        }
        setStage('setup2fa');
        return;
      }
      if (status === 200 && r.mustChangePassword && r.changeToken) {
        setChangeToken(r.changeToken);
        setStage('mustchangepw');
        return;
      }
      setError(String(r.error || 'Sign-in failed. Check your email and password.'));
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  // ── Stage 2a: pending2fa (TOTP code OR recovery code) ──────────────────────────────────────
  async function submit2fa(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const url = useRecovery ? '/api/auth/recovery' : '/api/auth/totp/verify';
      const { status, data } = await postJson(url, { pendingToken, code: code.trim() });
      const r = data as LoginResp;
      if (status === 200 && r.ok) {
        if (useRecovery && typeof r.recoveryRemaining === 'number') {
          toast.message('Recovery code used', { description: String(r.hint ?? '') });
        }
        return done();
      }
      if (status === 401 && /login first/i.test(String(r.error))) {
        toast.error('Your sign-in timed out — please sign in again.');
        resetToPassword();
        return;
      }
      setError(String(r.error || (useRecovery ? 'Invalid recovery code.' : 'Invalid code.')));
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  // ── Stage 2b: setup2fa (confirm the enrolled authenticator) ────────────────────────────────
  async function submitEnroll(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { status, data } = await postJson('/api/auth/totp/confirm', { setupToken, code: enrollCode.trim() });
      const r = data as LoginResp;
      if (status === 200 && r.ok) {
        const codes = r.recoveryCodes ?? [];
        if (codes.length) {
          toast.success('Two-factor enabled', {
            description: `Save your recovery codes now: ${codes.join('  ')}`,
            duration: 30000,
          });
        }
        return done();
      }
      setError(String(r.error || 'That code was not valid.'));
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  // ── Stage 2c: mustchangepw (rotate the admin temp password) ────────────────────────────────
  async function submitNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPw.length < 8) {
      setError('Your new password must be at least 8 characters.');
      return;
    }
    if (newPw !== confirmPw) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const { status, data } = await postJson('/api/auth/password/initial', { changeToken, newPassword: newPw });
      const r = data as LoginResp;
      if (status === 200 && r.ok) return done();
      if (status === 401) {
        toast.error('Your sign-in timed out — please sign in again.');
        resetToPassword();
        return;
      }
      setError(String(r.error || 'Could not set your password.'));
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  // ── Passkey sign-in (passwordless WebAuthn assertion) ──────────────────────────────────────
  async function signInWithPasskey() {
    setError('');
    if (!email) {
      setError('Enter your email first, then use your passkey.');
      return;
    }
    setBusy(true);
    try {
      const begin = await postJson('/api/auth/passkey/login/begin', { email: email.trim() });
      if (begin.status !== 200) {
        if (begin.status === 404) setError('No passkey is registered for that email. Sign in with your password.');
        else setError(String((begin.data as LoginResp).error || 'Could not start passkey sign-in.'));
        return;
      }
      const options = begin.data.options as Parameters<typeof startAuthentication>[0]['optionsJSON'];
      let assertion;
      try {
        assertion = await startAuthentication({ optionsJSON: options });
      } catch {
        setError('Passkey sign-in was cancelled or failed.');
        return;
      }
      const finish = await postJson('/api/auth/passkey/login/finish', { state: begin.data.state, credential: assertion });
      if (finish.status === 200 && (finish.data as LoginResp).ok) return done();
      setError(String((finish.data as LoginResp).error || 'Passkey verification failed.'));
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  // Surface an OAuth failure passed back as ?sso=<reason>.
  useEffect(() => {
    const sso = new URLSearchParams(window.location.search).get('sso');
    if (!sso) return;
    const MSG: Record<string, string> = {
      state: 'Sign-in expired — please try again.',
      exchange: 'Could not complete Google sign-in.',
      offboarded: 'This account has been deactivated.',
      not_allowed: 'That email domain isn’t allowed to sign in.',
      unverified: 'Your Google email address isn’t verified.',
      cancelled: 'Google sign-in was cancelled.',
      unconfigured: 'Google sign-in isn’t configured.',
    };
    toast.error('Google sign-in failed', { description: MSG[sso] || 'Please try again.' });
  }, []);

  // ── Render per stage ───────────────────────────────────────────────────────────────────────
  if (stage === 'pending2fa') {
    return (
      <form onSubmit={submit2fa} className="grid gap-4" noValidate>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="size-4 text-primary" aria-hidden />
          {useRecovery ? 'Enter a recovery code' : 'Two-factor authentication'}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="twofa-code">{useRecovery ? 'Recovery code' : '6-digit code'}</Label>
          <Input
            id="twofa-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            placeholder={useRecovery ? 'e.g. a1b2c3d4e5' : '123456'}
            autoFocus
            required
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
        {error ? <ErrorAlert id={errorId} message={error} /> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
          {busy ? 'Verifying…' : 'Verify'}
        </Button>
        <div className="flex items-center justify-between text-xs">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => {
              setUseRecovery((v) => !v);
              setCode('');
              setError('');
            }}
          >
            {useRecovery ? 'Use your authenticator instead' : 'Lost your device? Use a recovery code'}
          </button>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={resetToPassword}>
            Start over
          </button>
        </div>
      </form>
    );
  }

  if (stage === 'setup2fa') {
    return (
      <form onSubmit={submitEnroll} className="grid gap-4" noValidate>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="size-4 text-primary" aria-hidden />
          Set up two-factor authentication
        </div>
        <p className="text-xs text-muted-foreground">
          Two-factor is required for this account. Scan the code with an authenticator app (Google
          Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.
        </p>
        <div className="flex flex-col items-center gap-3">
          {otpauthUri ? <QrCode value={otpauthUri} alt="Authenticator setup QR code" /> : <Loader2 className="animate-spin" aria-hidden />}
          {secret ? (
            <p className="text-center text-xs text-muted-foreground">
              Or enter this key manually:
              <br />
              <span className="font-mono tracking-wide text-foreground break-all">{secret}</span>
            </p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="enroll-code">6-digit code</Label>
          <Input
            id="enroll-code"
            value={enrollCode}
            onChange={(e) => setEnrollCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            required
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
        {error ? <ErrorAlert id={errorId} message={error} /> : null}
        <Button type="submit" className="w-full" disabled={busy || !otpauthUri}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
          {busy ? 'Confirming…' : 'Confirm & finish sign-in'}
        </Button>
        <button type="button" className="text-center text-xs text-muted-foreground hover:text-foreground" onClick={resetToPassword}>
          Start over
        </button>
      </form>
    );
  }

  if (stage === 'mustchangepw') {
    return (
      <form onSubmit={submitNewPassword} className="grid gap-4" noValidate>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <KeyRound className="size-4 text-primary" aria-hidden />
          Set a new password
        </div>
        <p className="text-xs text-muted-foreground">
          Your account uses a temporary password set by an administrator. Choose a new one to continue.
        </p>
        <div className="grid gap-2">
          <Label htmlFor="new-pw">New password</Label>
          <Input id="new-pw" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" required autoFocus />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="confirm-pw">Confirm new password</Label>
          <Input id="confirm-pw" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" required />
        </div>
        {error ? <ErrorAlert id={errorId} message={error} /> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
          {busy ? 'Saving…' : 'Set password & continue'}
        </Button>
        <button type="button" className="text-center text-xs text-muted-foreground hover:text-foreground" onClick={resetToPassword}>
          Start over
        </button>
      </form>
    );
  }

  // Default: password stage.
  return (
    <div className="grid gap-4">
      <form onSubmit={submitPassword} className="grid gap-4" noValidate>
        <div className="grid gap-2">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            id={emailId}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            inputMode="email"
            autoComplete="username"
            placeholder="you@company.com"
            required
            autoFocus
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor={passwordId}>Password</Label>
          <InputGroup>
            <InputGroupInput
              id={passwordId}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="••••••••"
              required
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? errorId : undefined}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="button"
                size="icon-xs"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>

        {error ? <ErrorAlert id={errorId} message={error} /> : null}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <LogIn aria-hidden />}
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {passkeySupported ? (
        <Button type="button" variant="outline" className="w-full" onClick={signInWithPasskey} disabled={busy}>
          <Fingerprint aria-hidden />
          Sign in with a passkey
        </Button>
      ) : null}

      <div className="relative">
        <div className="absolute inset-0 flex items-center" aria-hidden>
          <span className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-2 text-muted-foreground">or</span>
        </div>
      </div>

      <Button asChild variant="outline" className="w-full">
        <a href={`/api/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`}>
          <GoogleIcon />
          Continue with Google
        </a>
      </Button>
    </div>
  );
}
