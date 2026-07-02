import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/auth';
import { googleClientId } from '@/lib/auth/oidc';
import { getEnabledProviders } from '@/lib/auth/settings-store';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import LoginForm from './login-form';
import { GoogleOneTap } from './google-one-tap';

// /login — the only unauthenticated PAGE (middleware lets it through). A Server Component shell: if
// there's already a valid full session, skip straight to the destination; otherwise render the
// client form (login-form.tsx) that drives the staged /api/auth/* sign-in flow (password → 2FA /
// setup / forced-change / passkey → full session). Live-DB model: getSession verifies the signed
// cookie HMAC on every request (Node runtime — middleware only does the cheap presence pre-check).
export const dynamic = 'force-dynamic';

// Only honor an internal, absolute-path `next` (no open redirect). The action re-validates this
// on submit; we mirror it here for the already-signed-in fast path.
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next === '/login' || next.startsWith('/login/')) return '/';
  return next;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const dest = safeNext(next);

  // Already signed in → skip to the destination. getCurrentUser is REVOKED-AWARE (returns null for a
  // deleted/offboarded session), so a locked-out user isn't bounced back into the app (no redirect
  // loop with requireUser); they see the sign-in form, and any attempt is refused at the gate.
  const current = await getCurrentUser();
  if (current) redirect(dest);

  const gClientId = googleClientId();
  const enabledProviders = await getEnabledProviders();

  return (
    // Fill the viewport below the global header (h-14) and the main's py-6, then center the card.
    <div className="flex min-h-[calc(100dvh-7.5rem)] items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-lg tracking-tight">
            EVENT <span className="text-primary">TRACKER</span>
          </CardTitle>
          <CardDescription>Sign in to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Only thread `next` when it points somewhere other than the default. */}
          <LoginForm next={dest !== '/' ? dest : undefined} enabledProviders={enabledProviders} />
          {/* Google One Tap: surfaces an existing Google session as a one-tap (or auto) sign-in. */}
          {gClientId ? <GoogleOneTap clientId={gClientId} next={dest !== '/' ? dest : undefined} /> : null}
        </CardContent>
      </Card>
    </div>
  );
}
