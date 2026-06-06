import { requireRole } from '@/lib/auth/auth';
import { RefreshCw, Server, Info } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// app/config/sync — Config > Sync. HONEST informational shell. The multi-instance two-way DB sync
// (the Python eit_sync.py engine: custom LWW across N sites on the auth/data collections) is a
// SERVER-INFRA process the Next.js app does not run in-process. We say so plainly and do NOT fake
// live sync controls. If a sync-status source is later exposed (e.g. a status doc the engine writes),
// wire a read-only view here — until then this is a clear shell.
export const dynamic = 'force-dynamic';

export default async function ConfigSyncPage() {
  await requireRole('admin');

  // Whether a sync engine is even configured for this deployment (env signal only — we never claim
  // a live status we can't observe).
  const syncEnabled = ['1', 'true', 'yes'].includes(String(process.env.EIT_SYNC_ENABLED || '').toLowerCase());

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="size-4 text-primary" aria-hidden />
            Multi-instance sync
          </CardTitle>
          <CardDescription>
            Sync between deployments is handled by the server engine (<code className="font-mono">eit_sync</code>),
            not by this app. The web app talks to one MongoDB directly; when more than one site runs, a
            separate server-side process replicates changes between their databases (two-way, last-write-wins).
            That engine runs alongside the deployment — it isn’t controlled from here, so there are no live
            sync toggles on this page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-muted-foreground">
                <Server className="size-4" aria-hidden /> Sync engine
              </span>
              <Badge variant="outline" className="text-muted-foreground">
                {syncEnabled ? 'Enabled for this deployment' : 'Not enabled (single-site)'}
              </Badge>
            </div>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                This reflects the <code className="font-mono">EIT_SYNC_ENABLED</code> deployment flag only — it
                indicates that an engine is configured, not its live replication health. There is no in-app
                status feed to read yet; status and control live with the server engine.
              </span>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
