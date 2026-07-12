import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { getIntegrationKey } from '@/lib/auth/settings-store';

// lib/integrations/ai-report.ts — the "Generate AI report" backend (server-only).
//
// Three keyed providers, any one is enough: Anthropic (official SDK), OpenAI and Gemini (plain
// REST — their calls are one fetch each; no extra dependencies). The caller passes the fully
// assembled prompt (lib/views/event-report.reportAiPrompt) and a provider choice; keys resolve via
// env || the encrypted settings store and NEVER reach the browser. Output is markdown text.
//
// Models are pinned to stable ids so a provider-side rename fails loudly here (surfaced as the
// provider's error message in the UI) instead of silently degrading.

export type AiProvider = 'anthropic' | 'openai' | 'gemini';

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'GPT (OpenAI)',
  gemini: 'Gemini (Google)',
};

const ANTHROPIC_MODEL = 'claude-opus-4-8';
const OPENAI_MODEL = 'gpt-5';
const GEMINI_MODEL = 'gemini-2.5-flash';

const SYSTEM = 'You write concise, factual post-event reports for a trade-show logistics team. Markdown, a few short sections, no preamble.';

// One wall-clock budget for every provider: prod sits behind a Cloudflare tunnel that cuts
// responses at ~100s, so a slower generation must fail HERE (a clean toast) rather than as a 524.
const AI_TIMEOUT_MS = 85_000;

/** Cap + de-noise a provider error before it reaches the browser. */
const briefError = (msg: unknown, fallback: string): string => {
  const s = String(msg ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 300) : fallback;
};

/** Which AI providers have a key configured (env or store). Order = the UI's default preference. */
export async function availableAiProviders(): Promise<AiProvider[]> {
  const [a, o, g] = await Promise.all([
    getIntegrationKey('anthropicKey'),
    getIntegrationKey('openaiKey'),
    getIntegrationKey('geminiKey'),
  ]);
  const out: AiProvider[] = [];
  if (a) out.push('anthropic');
  if (o) out.push('openai');
  if (g) out.push('gemini');
  return out;
}

export interface AiReportResult {
  ok: boolean;
  markdown?: string;
  error?: string;
}

export async function generateAiReport(provider: AiProvider, prompt: string): Promise<AiReportResult> {
  try {
    switch (provider) {
      case 'anthropic':
        return await viaAnthropic(prompt);
      case 'openai':
        return await viaOpenAi(prompt);
      case 'gemini':
        return await viaGemini(prompt);
      default:
        return { ok: false, error: 'Unknown AI provider.' };
    }
  } catch (e) {
    const aborted = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError' || /timed? ?out/i.test(e.message));
    return {
      ok: false,
      error: aborted
        ? 'The AI took too long — try again, or try a different provider.'
        : briefError(e instanceof Error ? e.message : '', 'AI request failed.'),
    };
  }
}

/** Flag a length-capped response so a mid-sentence cutoff never reads as a finished report. */
const markTruncated = (text: string) => `${text}\n\n---\n_⚠ The model hit its output limit — this report may be cut off. Regenerate or try another provider._`;

async function viaAnthropic(prompt: string): Promise<AiReportResult> {
  const apiKey = await getIntegrationKey('anthropicKey');
  if (!apiKey) return { ok: false, error: 'No Anthropic API key configured.' };
  // maxRetries 0: one shot inside the tunnel budget — the user has a Regenerate button.
  const client = new Anthropic({ apiKey, timeout: AI_TIMEOUT_MS, maxRetries: 0 });
  const msg = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 16000, // shared thinking+text budget under adaptive thinking — headroom over 8k
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  if (msg.stop_reason === 'refusal') return { ok: false, error: 'The model declined this request.' };
  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) return { ok: false, error: 'Empty response from Claude.' };
  return { ok: true, markdown: msg.stop_reason === 'max_tokens' ? markTruncated(text) : text };
}

async function viaOpenAi(prompt: string): Promise<AiReportResult> {
  const apiKey = await getIntegrationKey('openaiKey');
  if (!apiKey) return { ok: false, error: 'No OpenAI API key configured.' };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  });
  const data = (await r.json().catch(() => null)) as
    | { choices?: { message?: { content?: string }; finish_reason?: string }[]; error?: { message?: string } }
    | null;
  if (!r.ok) return { ok: false, error: briefError(data?.error?.message, `OpenAI error (HTTP ${r.status}).`) };
  const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) return { ok: false, error: 'Empty response from OpenAI.' };
  return { ok: true, markdown: data?.choices?.[0]?.finish_reason === 'length' ? markTruncated(text) : text };
}

async function viaGemini(prompt: string): Promise<AiReportResult> {
  const apiKey = await getIntegrationKey('geminiKey');
  if (!apiKey) return { ok: false, error: 'No Gemini API key configured.' };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }),
    }
  );
  const data = (await r.json().catch(() => null)) as
    | { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; error?: { message?: string } }
    | null;
  if (!r.ok) return { ok: false, error: briefError(data?.error?.message, `Gemini error (HTTP ${r.status}).`) };
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => String(p?.text ?? ''))
    .join('')
    .trim();
  if (!text) return { ok: false, error: 'Empty response from Gemini.' };
  return { ok: true, markdown: data?.candidates?.[0]?.finishReason === 'MAX_TOKENS' ? markTruncated(text) : text };
}
