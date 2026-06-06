import { redirect } from 'next/navigation';

import { getSession } from '@/lib/session';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import LoginForm from './login-form';

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

  const session = await getSession();
  if (session) redirect(dest);

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
          <LoginForm next={dest !== '/' ? dest : undefined} />
        </CardContent>
      </Card>
    </div>
  );
}
