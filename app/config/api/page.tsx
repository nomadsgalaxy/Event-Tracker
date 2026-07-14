import { KeyRound } from 'lucide-react';
import { requireRole } from '@/lib/auth/auth';
import { listAllApiKeys } from '@/lib/api/api-keys';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { WebhookSubscriptionsCard } from '../admin/webhook-subscriptions-card';

// app/config/api — Config > API: the admin OVERSIGHT view of the programmatic surface. Both API
// keys and webhooks are minted per-user in Account > Security; this page shows all of them across
// the deployment — who minted each, and (for keys) what they're scoped to. Keys are read-only here
// on purpose: a key is bound to its owner's credential and revoked from their own account (or by
// deleting/offboarding the user, which kills their keys). Webhooks ARE manageable here — an admin
// can test, pause, edit, or delete any user's.
export const dynamic = 'force-dynamic';

function fmtWhen(ts?: number | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

export default async function ConfigApiPage() {
  await requireRole('admin');
  const keys = await listAllApiKeys();

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4 text-primary" aria-hidden />
            All API keys
          </CardTitle>
          <CardDescription>
            Every API key minted on this deployment and who minted it. A key can never exceed its
            owner&apos;s live role — capabilities are re-intersected on every request. Keys are minted
            and revoked by their owner in Account &gt; Security; deleting or offboarding a user kills
            their keys.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No API keys minted yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-card hover:bg-card">
                    <TableHead>Owner</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead className="hidden md:table-cell">Created</TableHead>
                    <TableHead className="hidden md:table-cell">Last used</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((k) => (
                    <TableRow key={k.id}>
                      <TableCell className="max-w-0">
                        <span className="block truncate font-mono text-xs">{k.owner}</span>
                      </TableCell>
                      <TableCell className="max-w-0">
                        <span className="block truncate text-sm" title={`id ${k.id}`}>{k.label}</span>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          <Badge variant={k.scope === 'write' ? 'default' : 'secondary'} className="text-[10px]">
                            {k.scope}
                          </Badge>
                          <span className="text-xs text-muted-foreground" title={k.caps.join(', ')}>
                            {k.caps.length} {k.caps.length === 1 ? 'capability' : 'capabilities'}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground tabular-nums md:table-cell">{fmtWhen(k.createdAt)}</TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground tabular-nums md:table-cell">{fmtWhen(k.lastUsedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <WebhookSubscriptionsCard scope="all" />
    </div>
  );
}
