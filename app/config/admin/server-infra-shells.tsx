import { Activity, Archive, CircleCheck, CircleX, Lock, Mail, RotateCw, ServerCog } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// server-infra-shells.tsx — the HONEST shells for the Config > Admin items that are SERVER-INFRA, not
// part of the Next.js app: ID-rotation, System status, Backup/Restore, SMTP, local TLS cert
// management. Each renders a one-line "managed by the server infrastructure / not part of the
// Next.js app" note — we do NOT fake these controls. The one genuinely-observable signal (live DB
// reachability) IS shown under System status, since it's a real read this app can perform.

function ShellRow({ icon: Icon, title, note }: { icon: React.ComponentType<{ className?: string }>; title: string; note: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-muted/20 p-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      <Badge variant="outline" className="ml-auto shrink-0 text-muted-foreground">
        Server infra
      </Badge>
    </div>
  );
}

export function ServerInfraShells({ dbReachable, dbName }: { dbReachable: boolean; dbName: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ServerCog className="size-4 text-primary" aria-hidden />
          System & maintenance
        </CardTitle>
        <CardDescription>
          These are managed by the deployment’s server infrastructure, not the web app — they’re listed
          here for visibility. The web app shows the one signal it can observe directly: the live database
          connection.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* System status — the ONE genuinely-observable bit (live DB ping). */}
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
          <div className="flex items-center gap-3">
            <Activity className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium text-foreground">System status</p>
              <p className="text-xs text-muted-foreground">
                Live database reachability (<span className="font-mono">{dbName}</span>). Deeper health probes,
                process metrics, and uptime live with the server infra.
              </p>
            </div>
          </div>
          {dbReachable ? (
            <Badge variant="outline" className="shrink-0 gap-1.5 border-[var(--success)] text-[var(--success)]">
              <CircleCheck className="size-3.5" aria-hidden /> DB reachable
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 gap-1.5 border-destructive text-destructive">
              <CircleX className="size-3.5" aria-hidden /> DB unreachable
            </Badge>
          )}
        </div>

        <ShellRow
          icon={RotateCw}
          title="ID rotation"
          note="Bulk re-keying of entity IDs is a maintenance task run by the server infra, not from the web app."
        />
        <ShellRow
          icon={Archive}
          title="Backup & restore"
          note="Database backup/restore is handled by the deployment’s backup tooling — never from the app (it would expose secret material)."
        />
        <ShellRow
          icon={Mail}
          title="Email (SMTP)"
          note="Outbound email is configured in the server environment; the Next.js app does not send mail in-process."
        />
        <ShellRow
          icon={Lock}
          title="Local TLS certificate"
          note="TLS termination + certificate lifecycle are handled by the reverse proxy / deployment, not the app."
        />
      </CardContent>
    </Card>
  );
}
