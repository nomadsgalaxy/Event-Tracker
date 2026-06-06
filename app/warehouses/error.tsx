'use client';

import { useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// Route-level error boundary for /warehouses. Surfaces a Forbidden error (requireUser/requireRole
// on an under-ranked caller) and any data-layer failure (a live-DB read is fatal at request time
// in this stack — there is no stale-cache fallback). A reset retry re-runs the server render.
export default function WarehousesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[warehouses] route error:', error);
  }, [error]);

  const forbidden = /forbidden/i.test(error.message);

  return (
    <div className="mx-auto max-w-md py-16">
      <Card>
        <CardHeader>
          <CardTitle>{forbidden ? 'Not permitted' : 'Something went wrong'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {forbidden
              ? 'You do not have permission to view warehouses.'
              : 'The warehouses view could not be loaded. This stack reads live from the database, so a connection problem surfaces here rather than serving stale data.'}
          </p>
          <p className="font-mono text-xs break-words text-muted-foreground">{error.message}</p>
          <Button onClick={reset}>Try again</Button>
        </CardContent>
      </Card>
    </div>
  );
}
