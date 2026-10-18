import { ipcMain, BrowserWindow } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ExplainRequest, AiEvent } from '@shared/api';
import type { AiProviderId } from '@shared/settings';
import { buildPrompt } from '@core/ai/prompts';
import { getSettings, addUsage, getUsage, usdSpent } from './settings';
import { getSecret } from './secrets';

/** Approximate list prices in USD per million tokens (input, output, cache read). Used only for the in-app cost meter. */
const PRICES: Record<string, [number, number, number]> = {
  'claude-haiku-5-5': [0.10, 0.50, 0.01],
  'claude-sonnet-5-5': [2, 10, 0.20],
  'claude-opus-5-5': [4, 20, 0.20],
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-haiku-4-5': [1, 5, 0.10],
  'gpt-5.4-mini': [0.75, 4.50, 0.075],
  'gpt-5.6-luna': [0.20, 1.20, 0.02],
  'gpt-5.6-terra': [2, 12, 0.20],
  'gpt-5-mini': [0.25, 2, 0.025],
  'gpt-4o-mini': [0.15, 0.60, 0.075],
};

export function estimateUsd(model: string, inputTokens: number, outputTokens: number, cachedTokens: number): number {
  const p = PRICES[model] ?? Object.entries(PRICES).find(([k]) => model.startsWith(k))?.[1] ?? [2, 10, 0.2];
  return ((inputTokens - cachedTokens) * p[0] + outputTokens * p[1] + cachedTokens * p[2]) / 1_000_000;
}

const streams = new Map<string, AbortController>();
let counter = 0;

/** Usage records carry UTC instants; the budgets are per local day and local month, so compare against local midnight. */
export function periodStarts(now = new Date()): { day: string; month: string } {
  return { day: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), month: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
}

export function registerAiHandlers(getWindow: () => BrowserWindow | null): void {
  const send = (ev: AiEvent) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('ai:event', ev); } catch { /* window closed while streaming */ }
  };

  ipcMain.handle('ai:explain', async (_e, req: ExplainRequest) => {
    const streamId = `s${++counter}`;
    const ctrl = new AbortController();
    streams.set(streamId, ctrl);
    // run after returning the id so the renderer can subscribe
    setTimeout(() => runExplain(streamId, req, ctrl, send).finally(() => streams.delete(streamId)), 0);
    return { streamId };
  });
  ipcMain.handle('ai:cancel', async (_e, id: string) => { streams.get(id)?.abort(); });
  ipcMain.handle('ai:usage', async () => getUsage());
  ipcMain.handle('ai:test', async (_e, provider: AiProviderId) => testProvider(provider));
}

async function runExplain(streamId: string, req: ExplainRequest, ctrl: AbortController, send: (ev: AiEvent) => void): Promise<void> {
  // Everything is inside the try: the renderer waits for a 'done' or 'error' event and nothing else may end the stream.
  try {
    const s = getSettings();
    const provider = s.ai.provider;
    const model = provider === 'anthropic' ? s.ai.anthropicModel : s.ai.openaiModel;
    const key = getSecret(provider);
    if (!key) { send({ type: 'error', streamId, message: provider === 'anthropic' ? 'Add your Anthropic API key in Settings.' : 'Add your OpenAI API key in Settings.', code: 'no_key' }); return; }
    const monthly = usdSpent(periodStarts().month);
    if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) {
      send({ type: 'error', streamId, message: `Monthly AI budget of $${s.ai.monthlyStopUsd} reached. Raise it in Settings to continue.`, code: 'budget' });
      return;
    }
    const prompt = buildPrompt(req, { level: s.learnerLevel, instructions: s.ai.instructions, length: s.ai.explanationLength });
    const result = provider === 'anthropic'
      ? await streamAnthropic(key, model, prompt, ctrl.signal, (t) => send({ type: 'delta', streamId, text: t }))
      : await streamOpenAI(key, model, prompt, ctrl.signal, (t) => send({ type: 'delta', streamId, text: t }));
    const usd = estimateUsd(model, result.inputTokens, result.outputTokens, result.cachedTokens);
    // a failed usage write must not lose the reply the learner is waiting for
    try { addUsage({ date: new Date().toISOString(), provider, model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedTokens: result.cachedTokens, usd }); } catch (e) { console.error('usage not recorded', e); }
    const { day, month } = periodStarts();
    send({ type: 'done', streamId, text: result.text, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedTokens: result.cachedTokens, usd, dailyUsd: usdSpent(day), monthlyUsd: usdSpent(month), model } });
  } catch (e) {
    send({ type: 'error', streamId, ...classifyError(e) });
  }
}

interface StreamResult { text: string; inputTokens: number; outputTokens: number; cachedTokens: number }

async function streamAnthropic(apiKey: string, model: string, prompt: { system: string; user: string; maxTokens: number }, signal: AbortSignal, onText: (t: string) => void): Promise<StreamResult> {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
  const params = {
    model,
    max_tokens: prompt.maxTokens,
    system: [{ type: 'text' as const, text: prompt.system, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user' as const, content: prompt.user }],
    output_config: { effort: 'low' as const },
  };
  // Opus 5.5 / Sonnet 5.5 / Fable: opt into server-side refusal fallbacks so a rare safety decline still yields an answer.
  const wantsFallback = /^claude-(opus-5-5|sonnet-5-5|fable)/.test(model);
  let final: Anthropic.Message | Anthropic.Beta.BetaMessage;
  if (wantsFallback) {
    const stream = client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as never, { signal });
    stream.on('text', (t: string) => onText(t));
    final = await stream.finalMessage();
  } else {
    const stream = client.messages.stream(params, { signal });
    stream.on('text', (t: string) => onText(t));
    final = await stream.finalMessage();
  }
  const text = (final.content as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  if (final.stop_reason === 'refusal') throw Object.assign(new Error('The AI declined to answer this request.'), { code: 'other' });
  const u = final.usage;
  return { text, inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, cachedTokens: u.cache_read_input_tokens ?? 0 };
}

async function streamOpenAI(apiKey: string, model: string, prompt: { system: string; user: string; maxTokens: number }, signal: AbortSignal, onText: (t: string) => void): Promise<StreamResult> {
  const client = new OpenAI({ apiKey, maxRetries: 1, timeout: 60_000 });
  const stream = await client.chat.completions.create({
    model,
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: prompt.maxTokens + 800,
    ...(/^(gpt-5|o[1-9])/.test(model) ? { reasoning_effort: 'low' as const } : {}),
  }, { signal });
  let text = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, cached: 0 };
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) { text += delta; onText(delta); }
    if (chunk.usage) usage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens, cached: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0 };
  }
  return { text, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, cachedTokens: usage.cached };
}

export function classifyError(e: unknown): { message: string; code: Extract<AiEvent, { type: 'error' }>['code'] } {
  const err = e as { name?: string; status?: number; message?: string; code?: string; error?: { error?: { message?: string } } };
  if (err?.name === 'AbortError' || err?.code === 'cancelled' || /abort/i.test(err?.message ?? '')) return { message: 'Cancelled', code: 'cancelled' };
  if (e instanceof Anthropic.AuthenticationError || e instanceof OpenAI.AuthenticationError || err?.status === 401) return { message: 'The API key was rejected. Check it in Settings.', code: 'auth' };
  if (e instanceof Anthropic.RateLimitError || e instanceof OpenAI.RateLimitError || err?.status === 429) {
    const spend = /spend|usage limit|billing|quota|insufficient|credit/i.test(err?.message ?? '');
    return { message: spend ? 'Your API account has no credit left or reached its spending limit.' : 'Too many requests right now; try again in a moment.', code: spend ? 'spend_limit' : 'rate_limit' };
  }
  // Anthropic reports an empty prepaid balance as a 400 ("credit balance is too low")
  if (err?.status === 400 && /usage limit|spend|credit balance|insufficient/i.test(err?.message ?? '')) return { message: 'Your API account has no credit left or reached its spending limit.', code: 'spend_limit' };
  if (err?.status === 529 || err?.status === 503 || /overloaded/i.test(err?.message ?? '')) return { message: 'The AI service is overloaded right now; try again in a moment.', code: 'rate_limit' };
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError || /fetch failed|ENOTFOUND|ECONN|network/i.test(err?.message ?? '')) return { message: 'No internet connection, or the AI service is unreachable.', code: 'network' };
  return { message: err?.message ?? 'Unknown AI error', code: 'other' };
}

async function testProvider(provider: AiProviderId): Promise<{ ok: boolean; message: string }> {
  const s = getSettings();
  const key = getSecret(provider);
  if (!key) return { ok: false, message: 'No API key saved yet.' };
  try {
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 30_000 });
      const res = await client.messages.create({ model: s.ai.anthropicModel, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('').trim();
      return { ok: true, message: `Connected. ${res.model} replied: ${text.slice(0, 40)}` };
    }
    const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 30_000 });
    const res = await client.chat.completions.create({ model: s.ai.openaiModel, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_completion_tokens: 20 });
    return { ok: true, message: `Connected. ${res.model} replied: ${(res.choices[0]?.message?.content ?? '').trim().slice(0, 40)}` };
  } catch (e) {
    return { ok: false, message: classifyError(e).message };
  }
}
