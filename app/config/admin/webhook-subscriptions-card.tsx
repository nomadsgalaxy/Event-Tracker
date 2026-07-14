'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Plus, Webhook, Pencil, Trash2, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  mintWebhookAction,
  editWebhookAction,
  deleteWebhookAction,
  testWebhookAction,
} from './webhook-subscription-actions';

// webhook-subscriptions-card.tsx — Config → Admin "Webhook subscriptions". The API-managed,
// multi-endpoint sibling of the legacy Outbound-notifications card, with an API-key-style MINT
// flow: each new webhook picks exactly the events it wants via checkboxes. Unlike API keys,
// minted webhooks stay EDITABLE — url, events, method, secret, description, and an active toggle.

const EVENT_LABELS: Record<string, string> = {
  item_flagged: 'Item flagged',
  flight_delay: 'Flight delay / cancellation',
  severe_weather: 'Severe weather warning',
  ship_kit_signoff: 'Kit shipped (sign-off)',
  low_stock: 'Low stock (coming soon)',
  event_created: 'Event created',
  event_state_changed: 'Event state changed',
  feedback_submitted: 'Post-event feedback submitted',
};

export interface WebhookRow {
  id: string;
  url: string;
  method: 'POST' | 'GET';
  events: string[];
  hasSecret: boolean;
  description: string;
  active: boolean;
  lastFiredAt: number | null;
  lastStatus: number | null;
}

interface FormState {
  url: string;
  method: string;
  description: string;
  /** undefined = keep the existing secret (edit mode); '' = none/clear; value = set. */
  secret: string | undefined;
  events: Set<string>;
}

const emptyForm = (): FormState => ({ url: '', method: 'POST', description: '', secret: '', events: new Set() });

function WebhookForm({
  initial,
  eventTypes,
  hasSecret,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: FormState;
  eventTypes: readonly string[];
  /** Edit mode: whether a secret is currently set (drives the keep/clear affordance). */
  hasSecret?: boolean;
  busy: boolean;
  submitLabel: string;
  onSubmit: (f: FormState) => void;
  onCancel?: () => void;
}) {
  const [f, setF] = useState<FormState>(initial);
  const toggle = (id: string, on: boolean) =>
    setF((p) => {
      const events = new Set(p.events);
      if (on) events.add(id);
      else events.delete(id);
      return { ...p, events };
    });
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
        <div className="grid gap-1.5">
          <Label>Endpoint URL</Label>
          <Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://example.com/hooks/event-tracker" className="font-mono text-sm" />
        </div>
        <div className="grid gap-1.5">
          <Label>Delivery</Label>
          <Select value={f.method} onValueChange={(v) => setF({ ...f, method: v })}>
            <SelectTrigger aria-label="Delivery method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="POST">POST (JSON push)</SelectItem>
              <SelectItem value="GET">GET (query ping)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label>Description</Label>
        <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Ops dashboard notifier" />
      </div>
      <div className="grid gap-1.5">
        <Label>Secret (optional — signs deliveries)</Label>
        <Input
          value={f.secret ?? ''}
          onChange={(e) => setF({ ...f, secret: e.target.value })}
          placeholder={f.secret === undefined && hasSecret ? '•••••• (unchanged — type to replace)' : 'shared HMAC secret'}
          className="font-mono text-sm"
        />
        {hasSecret && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={f.secret === ''}
              onCheckedChange={(v) => setF({ ...f, secret: v === true ? '' : undefined })}
            />
            Clear the stored secret
          </label>
        )}
        <p className="text-xs text-muted-foreground">
          POST: <span className="font-mono">X-EIT-Signature: sha256=…</span> header · GET: <span className="font-mono">&amp;sig=…</span> param.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label>Events this webhook receives</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {eventTypes.map((id) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <Checkbox checked={f.events.has(id)} onCheckedChange={(v) => toggle(id, v === true)} disabled={id === 'low_stock'} />
              <span className={id === 'low_stock' ? 'text-muted-foreground' : ''}>{EVENT_LABELS[id] ?? id}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => onSubmit(f)} disabled={busy || !f.url.trim() || f.events.size === 0}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export function WebhookSubscriptionsCard({
  initial,
  eventTypes,
}: {
  initial: WebhookRow[];
  eventTypes: readonly string[];
}) {
  const router = useRouter();
  const [minting, setMinting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (p: Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    setBusy(true);
    p.then((r) => {
      if (r.ok) {
        toast.success(okMsg);
        setMinting(false);
        setEditingId(null);
        router.refresh();
      } else {
        toast.error(r.error || 'That did not work.');
      }
    })
      .catch(() => toast.error('Network error — please try again.'))
      .finally(() => setBusy(false));
  };

  const test = (id: string) => {
    setBusy(true);
    testWebhookAction(id)
      .then((r) =>
        r.ok
          ? toast.success(`Delivered — endpoint answered ${r.receiverStatus}.`)
          : toast.error(r.error || `Endpoint answered ${r.receiverStatus ?? '—'}.`)
      )
      .catch(() => toast.error('Test failed — check your connection.'))
      .finally(() => setBusy(false));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Webhook className="size-4 text-primary" aria-hidden />
          Webhook subscriptions
        </CardTitle>
        <CardDescription>
          Mint per-endpoint webhooks like API keys — each one picks exactly the events it receives —
          but editable after creation. Deliveries are signed when a secret is set. Also manageable via
          the REST API (<span className="font-mono">/api/v1/webhooks</span>) and the MCP tools.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {initial.length === 0 && !minting && (
          <p className="text-sm text-muted-foreground">No webhooks yet.</p>
        )}
        {initial.map((w) =>
          editingId === w.id ? (
            <WebhookForm
              key={w.id}
              initial={{ url: w.url, method: w.method, description: w.description, secret: undefined, events: new Set(w.events) }}
              eventTypes={eventTypes}
              hasSecret={w.hasSecret}
              busy={busy}
              submitLabel="Save changes"
              onSubmit={(f) =>
                run(
                  editWebhookAction(w.id, {
                    url: f.url,
                    method: f.method,
                    description: f.description,
                    events: [...f.events],
                    ...(f.secret !== undefined ? { secret: f.secret } : {}),
                  }),
                  'Webhook updated.'
                )
              }
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border px-3 py-2.5">
              <Badge variant="outline" className="font-mono">{w.method}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-sm" title={w.url}>{w.url}</span>
              {!w.active && <Badge variant="outline" className="text-muted-foreground">Paused</Badge>}
              <span className="text-xs text-muted-foreground">
                {w.events.length} event{w.events.length === 1 ? '' : 's'}
                {w.hasSecret ? ' · signed' : ''}
                {w.lastStatus != null ? ` · last ${w.lastStatus || 'no response'}` : ''}
              </span>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => test(w.id)} disabled={busy} title="Send a test delivery">
                  <Radio aria-hidden />
                  Test
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => run(editWebhookAction(w.id, { active: !w.active }), w.active ? 'Webhook paused.' : 'Webhook resumed.')}
                  disabled={busy}
                >
                  {w.active ? 'Pause' : 'Resume'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditingId(w.id); setMinting(false); }} disabled={busy} title="Edit">
                  <Pencil aria-hidden />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => run(deleteWebhookAction(w.id), 'Webhook deleted.')}
                  disabled={busy}
                  title="Delete"
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
              {w.description && <p className="w-full text-xs text-muted-foreground">{w.description}</p>}
            </div>
          )
        )}

        {minting ? (
          <WebhookForm
            initial={emptyForm()}
            eventTypes={eventTypes}
            busy={busy}
            submitLabel="Mint webhook"
            onSubmit={(f) =>
              run(
                mintWebhookAction({
                  url: f.url,
                  method: f.method,
                  description: f.description,
                  secret: f.secret ?? '',
                  events: [...f.events],
                }),
                'Webhook minted.'
              )
            }
            onCancel={() => setMinting(false)}
          />
        ) : (
          <div>
            <Button variant="outline" size="sm" onClick={() => { setMinting(true); setEditingId(null); }} disabled={busy}>
              <Plus aria-hidden />
              New webhook
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
