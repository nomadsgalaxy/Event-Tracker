'use client';

import { useCallback, useEffect, useState } from 'react';
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
  listWebhooksAction,
  mintWebhookAction,
  editWebhookAction,
  deleteWebhookAction,
  testWebhookAction,
  type WebhookRow,
} from './webhook-subscription-actions';

// webhook-subscriptions-card.tsx — the per-user webhook manager, with an API-key-style MINT flow:
// each new webhook picks exactly the events it wants via checkboxes. Unlike API keys, minted
// webhooks stay EDITABLE — url, events, method, secret, description, and an active toggle.
// Two scopes: 'mine' (Account > Security, beside the API keys card — your own webhooks) and 'all'
// (Config > API — the admin oversight view, every webhook + who minted it). Self-loading via
// listWebhooksAction so it drops into any page without server wiring; hides itself entirely when
// the viewer isn't allowed to mint (read-only users).

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
const EVENT_TYPES = Object.keys(EVENT_LABELS);

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
  hasSecret,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: FormState;
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
          {EVENT_TYPES.map((id) => (
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

export function WebhookSubscriptionsCard({ scope }: { scope: 'mine' | 'all' }) {
  const [rows, setRows] = useState<WebhookRow[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [minting, setMinting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    listWebhooksAction(scope).then((r) => {
      if (r.ok) setRows(r.rows ?? []);
      // Forbidden (read-only viewer) → the card simply isn't for them; disappear quietly.
      else setHidden(true);
    });
  }, [scope]);

  useEffect(() => {
    load();
  }, [load]);

  const run = (p: Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    setBusy(true);
    p.then((r) => {
      if (r.ok) {
        toast.success(okMsg);
        setMinting(false);
        setEditingId(null);
        load();
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
      .finally(() => {
        setBusy(false);
        load();
      });
  };

  if (hidden) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Webhook className="size-4 text-primary" aria-hidden />
          {scope === 'all' ? 'All webhooks' : 'Webhooks'}
        </CardTitle>
        <CardDescription>
          {scope === 'all' ? (
            <>
              Every webhook minted on this deployment and who minted it. Each is owned and managed by
              its user (Account &gt; Security) — as an admin you can also test, pause, edit, or delete
              any of them here.
            </>
          ) : (
            <>
              Deliver Event Tracker events to your endpoints. Minted like API keys — each webhook picks
              exactly the events it receives — but editable after creation. Deliveries are signed when a
              secret is set. Also manageable via the REST API (<span className="font-mono">/api/v1/webhooks</span>)
              and the MCP tools. Up to 10 per user.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
          </p>
        ) : (
          <>
            {rows.length === 0 && !minting && (
              <p className="text-sm text-muted-foreground">No webhooks yet.</p>
            )}
            {rows.map((w) =>
              editingId === w.id ? (
                <WebhookForm
                  key={w.id}
                  initial={{ url: w.url, method: w.method, description: w.description, secret: undefined, events: new Set(w.events) }}
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
                  {(scope === 'all' || w.description) && (
                    <p className="w-full text-xs text-muted-foreground">
                      {scope === 'all' && (
                        <span className="mr-2 font-mono text-foreground/80" title="Minted by">{w.owner || 'unknown'}</span>
                      )}
                      {w.description}
                    </p>
                  )}
                </div>
              )
            )}

            {minting ? (
              <WebhookForm
                initial={emptyForm()}
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
