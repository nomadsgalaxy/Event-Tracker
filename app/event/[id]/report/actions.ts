'use server';

import { requireReportAccess } from './report-access';
import { buildEventReport, reportAiPrompt } from '@/lib/views/event-report';
import { generateAiReport, type AiProvider } from '@/lib/integrations/ai-report';

// Server action: generate the AI narrative for an event report. Same gate as the report page;
// the provider must be one of the three known ids (the key check happens inside the generator).

export interface AiReportActionResult {
  ok: boolean;
  markdown?: string;
  error?: string;
}

const PROVIDERS: readonly AiProvider[] = ['anthropic', 'openai', 'gemini'];

export async function generateEventReportAction(eventId: string, provider: string): Promise<AiReportActionResult> {
  const access = await requireReportAccess(eventId);
  if (!access.ok) return { ok: false, error: access.error };
  if (!PROVIDERS.includes(provider as AiProvider)) return { ok: false, error: 'Unknown AI provider.' };

  const report = buildEventReport(access.doc);
  const res = await generateAiReport(provider as AiProvider, reportAiPrompt(report));
  return res.ok ? { ok: true, markdown: res.markdown } : { ok: false, error: res.error };
}
