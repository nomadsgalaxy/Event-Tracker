'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Route-level error boundary for /manifest. Surfaces a data-layer failure (this stack reads live from
// the database, so a connection problem surfaces here rather than serving stale data) or a Forbidden
// error from a guard. A reset retry re-runs the server render.
export default function ManifestError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[manifest] route error:', error);
  }, [error]);

  const forbidden = /forbidden/i.test(error.message);

  return (
    <div className="mx-auto mt-10 max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>{forbidden ? 'Not permitted' : 'Something went wrong'}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {forbidden
              ? 'You do not have permission to view this manifest.'
              : 'The manifest could not be loaded. This stack reads live from the database, so a connection problem surfaces here rather than serving stale data.'}
          </p>
          <p className="rounded-md bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
            {error.message}
          </p>
          <Button onClick={reset} className="w-fit">
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
