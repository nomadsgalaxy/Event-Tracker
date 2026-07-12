'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Loader2, Printer, Copy, Sparkles, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { generateEventReportAction } from './actions';

// report-client.tsx — the Event Report page's interactive strip: Print, CSV/JSON export links,
// copy-AI-prompt, and the in-app "Generate AI report" panel (provider select over whichever of
// Anthropic/OpenAI/Gemini keys the server said are configured).

export function PrintButton() {
  return (
    <Button variant="outline" size="sm" onClick={() => window.print()} className="print:hidden">
      <Printer aria-hidden />
      Print
    </Button>
  );
}

export function ExportButtons({ eventId }: { eventId: string }) {
  const href = (format: string) => `/event/${encodeURIComponent(eventId)}/report/export?format=${format}`;
  return (
    <>
      <Button asChild variant="outline" size="sm">
        <a href={href('csv')} download>
          <Download aria-hidden />
          CSV
        </a>
      </Button>
      <Button asChild variant="outline" size="sm">
        <a href={href('json')} download>
          <Download aria-hidden />
          JSON
        </a>
      </Button>
    </>
  );
}

export function AiReportPanel({
  eventId,
  providers,
  providerLabels,
  prompt,
}: {
  eventId: string;
  /** Providers with a configured key, server-resolved. Empty ⇒ show the copy-prompt fallback only. */
  providers: string[];
  providerLabels: Record<string, string>;
  /** The full AI-ready prompt (also downloadable via export?format=prompt) for the copy fallback. */
  prompt: string;
}) {
  const [provider, setProvider] = React.useState(providers[0] ?? '');
  const [busy, setBusy] = React.useState(false);
  const [markdown, setMarkdown] = React.useState('');
  const [error, setError] = React.useState('');

  const copyPrompt = () => {
    navigator.clipboard
      .writeText(prompt)
      .then(() => toast.success('AI prompt copied — paste it into any AI chat.'))
      .catch(() => toast.error('Could not copy — use the Prompt download instead.'));
  };

  const generate = () => {
    if (!provider) return;
    setBusy(true);
    setError('');
    generateEventReportAction(eventId, provider)
      .then((r) => {
        if (r.ok && r.markdown) setMarkdown(r.markdown);
        else setError(r.error || 'Generation failed.');
      })
      .catch(() => setError('Generation failed — check your connection.'))
      .finally(() => setBusy(false));
  };

  return (
    <section className="grid gap-3 rounded-lg border border-border bg-card p-4 print:border-0 print:bg-transparent print:p-0">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <h2 className="mr-auto flex items-center gap-2 text-sm font-semibold">
          <Sparkles size={16} className="text-primary" aria-hidden />
          AI report
        </h2>
        <Button variant="outline" size="sm" onClick={copyPrompt} title="Copy a ready-to-paste prompt with all the report data for any AI chat">
          <Copy aria-hidden />
          Copy AI prompt
        </Button>
        {providers.length > 1 && (
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger size="sm" className="w-44" aria-label="AI provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p} value={p}>
                  {providerLabels[p] ?? p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {providers.length > 0 && (
          <Button size="sm" onClick={generate} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
            {busy ? 'Generating…' : markdown ? 'Regenerate' : `Generate with ${providerLabels[provider] ?? provider}`}
          </Button>
        )}
      </div>

      {providers.length === 0 && (
        <p className="text-sm text-muted-foreground print:hidden">
          No AI key configured. Copy the prompt above into any AI chat, or add an Anthropic, OpenAI or
          Gemini key in Config → Databases &amp; API to generate reports in-app.
        </p>
      )}
      {error && <p className="text-sm text-destructive print:hidden">{error}</p>}
      {/* The generated narrative DOES print — it's the point of the report. Only the controls hide. */}
      {markdown && (
        <div className="rounded-md border border-border bg-background p-4 text-sm leading-relaxed whitespace-pre-wrap print:border-0 print:bg-transparent print:p-0">
          {markdown}
        </div>
      )}
    </section>
  );
}
