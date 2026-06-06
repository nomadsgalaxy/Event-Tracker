import { Database, CircleCheck, CircleX } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// storage-card.tsx — the HONEST read-only "storage adapter" card. The Python app shipped a
// multi-adapter editor (Primary / Replica / SheetsAdapter). That model does NOT apply here: this
// deployment is Mongo-DIRECT (one MONGO_URI, no Sheets mirror, no in-process replica selection), so
// instead of a fake adapter editor we state that plainly and show a LIVE connection check + the DB
// name. RSC — the ping runs server-side; the URI/credentials are never exposed.

export function StorageCard({ reachable, dbName }: { reachable: boolean; dbName: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="size-4 text-primary" aria-hidden />
          Storage
        </CardTitle>
        <CardDescription>
          This deployment connects directly to MongoDB (one <code className="font-mono">MONGO_URI</code>).
          There is no Primary/Replica/Sheets adapter to configure — that multi-adapter model belongs to
          the legacy single-file app. The connection string is set in the server environment and is
          never shown here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Connection</span>
            {reachable ? (
              <Badge variant="outline" className="gap-1.5 border-[var(--success)] text-[var(--success)]">
                <CircleCheck className="size-3.5" aria-hidden /> Connected
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1.5 border-destructive text-destructive">
                <CircleX className="size-3.5" aria-hidden /> Unreachable
              </Badge>
            )}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Database</span>
            <span className="font-mono text-foreground">{dbName}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
