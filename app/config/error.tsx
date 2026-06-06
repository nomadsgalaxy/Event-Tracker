'use client';

import { useEffect } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Route-level error boundary for the WHOLE /config area. The layout's requireRole('admin') throws
// a "Forbidden" Error for an authed-but-non-admin caller (requireUser redirects an unauthenticated
// one to /login first) — this surfaces that as a clear "Admins only" wall rather than a raw 500.
// Any live-DB read failure also lands here (this stack reads live; a connection problem is fatal
// at request time, never served from a stale cache).
export default function ConfigError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[config] route error:', error);
  }, [error]);

  const forbidden = /forbidden/i.test(error.message);

  return (
    <div className="mx-auto mt-16 max-w-md">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-destructive" aria-hidden />
            {forbidden ? 'Admins only' : 'Something went wrong'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {forbidden
              ? 'The configuration console is restricted to admins. Your account does not have admin access.'
              : 'The configuration console could not be loaded. This stack reads live from the database, so a connection problem surfaces here rather than serving stale data.'}
          </p>
          <p className="rounded-md bg-muted/50 p-2 font-mono text-xs break-words text-muted-foreground">
            {error.message}
          </p>
          {!forbidden && (
            <Button onClick={reset} className="w-fit">
              Try again
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
