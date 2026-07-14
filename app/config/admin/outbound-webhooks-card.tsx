'use client';

import { useState } from 'react';
import { Loader2, Save, Webhook } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useStepUp } from '@/components/config/step-up';

// outbound-webhooks-card.tsx — Config > Admin "Outbound notifications". A generic JSON webhook URL
// and/or a Slack incoming-webhook URL, plus which events fan out. Best-effort: the app POSTs on the
// enabled events and never blocks on a slow endpoint. Empty URLs = off.

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

export interface OutboundWebhooksInitial {
  webhookUrl: string;
  slackWebhookUrl: string;
  enabledEvents: string[];
  eventTypes: readonly string[];
}

export function OutboundWebhooksCard({ initial }: { initial: OutboundWebhooksInitial }) {
  const [webhookUrl, setWebhookUrl] = useState(initial.webhookUrl);
  const [slackWebhookUrl, setSlackWebhookUrl] = useState(initial.slackWebhookUrl);
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(initial.enabledEvents));
  const [busy, setBusy] = useState(false);
  const { requireStepUp, element: stepUpModal } = useStepUp();

  const toggle = (id: string, on: boolean) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  function doSave(stepupToken: string) {
    setBusy(true);
    fetch('/api/auth/outbound-webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepupToken, webhookUrl: webhookUrl.trim(), slackWebhookUrl: slackWebhookUrl.trim(), enabledEvents: [...enabled] }),
      cache: 'no-store',
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status !== 200) {
          toast.error(data.error || `Save failed (${res.status}).`);
          return;
        }
        toast.success('Outbound notifications saved.');
      })
      .catch(() => toast.error('Network error — please try again.'))
      .finally(() => setBusy(false));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Webhook className="size-4 text-primary" aria-hidden />
          Outbound notifications
        </CardTitle>
        <CardDescription>
          POST a JSON webhook and/or a Slack message when these events happen. Best-effort — a slow or
          down endpoint never blocks the app. Leave a URL blank to turn it off.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="ow-webhook">Webhook URL</Label>
          <Input id="ow-webhook" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://example.com/hooks/event-tracker" className="font-mono text-sm" />
          <p className="text-xs text-muted-foreground">Receives {'{ event, ts, summary, data }'} as JSON.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ow-slack">Slack incoming-webhook URL</Label>
          <Input id="ow-slack" value={slackWebhookUrl} onChange={(e) => setSlackWebhookUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" className="font-mono text-sm" />
        </div>
        <div className="grid gap-1.5">
          <Label>Events</Label>
          <div className="flex flex-col gap-2">
            {initial.eventTypes.map((id) => (
              <label key={id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={enabled.has(id)} onCheckedChange={(v) => toggle(id, v === true)} disabled={id === 'low_stock'} />
                <span className={id === 'low_stock' ? 'text-muted-foreground' : ''}>{EVENT_LABELS[id] ?? id}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <Button onClick={() => requireStepUp(doSave)} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
            Save
          </Button>
        </div>
      </CardContent>
      {stepUpModal}
    </Card>
  );
}

export default OutboundWebhooksCard;
