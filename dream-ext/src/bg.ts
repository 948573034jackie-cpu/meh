/**
 * Background (service worker) half of the Dream Tutor: AI explanations and background jobs with the learner's
 * own API key. Same request shape, refusal fallback, cost meter and error messages as Dream Read's
 * src/main/ai.ts; the official SDKs run here (browser mode), so the key never reaches the YouTube page.
 *
 * Content scripts talk to it over a port named 'dream-ai':
 *   -> { type: 'explain', req }                       <- { type: 'delta', text } ... { type: 'done', text, usage } | { type: 'error', message, code }
 *   -> { type: 'complete', prompt }                   <- { type: 'done', text } | { type: 'error', ... }   (hints model, nothing streamed)
 * Closing the port cancels the request.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ExplainRequest, AiErrorCode } from '@shared/api';
import { buildPrompt, buildStyledPrompt, type PromptBundle } from '@core/ai/prompts';
import { resolveStyle, type StyleId } from '@shared/styles';
import type { AiProviderId, Settings } from '@shared/settings';
import { getSettings, getKeys, addUsage, getUsage, usdSince, periodStarts } from './store';

/** Approximate list prices in USD per million tokens (input, output, cache read); copied from Dream Read src/main/ai.ts. */
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

export const DEFAULT_ANTHROPIC_HINTS_MODEL = 'claude-haiku-5-5';
export function hintsModelFor(s: Settings): { provider: AiProviderId; model: string } {
  const provider = s.ai.provider;
  return { provider, model: s.ai.hintsModel?.trim() || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_HINTS_MODEL : s.ai.openaiModel) };
}

export interface StreamResult { text: string; inputTokens: number; outputTokens: number; cachedTokens: number }

/** Test hook: the extension tests point the SDKs at a local fake server (never set in normal use). */
async function baseUrls(): Promise<{ anthropic?: string; openai?: string }> {
  const o = await chrome.storage.local.get('drTestBaseUrls');
  return (o.drTestBaseUrls as { anthropic?: string; openai?: string } | undefined) ?? {};
}

async function streamAnthropic(apiKey: string, model: string, prompt: PromptBundle, signal: AbortSignal, onText: (t: string) => void): Promise<StreamResult> {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000, dangerouslyAllowBrowser: true, ...((await baseUrls()).anthropic ? { baseURL: (await baseUrls()).anthropic } : {}) });
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

async function streamOpenAI(apiKey: string, model: string, prompt: PromptBundle, signal: AbortSignal, onText: (t: string) => void): Promise<StreamResult> {
  const client = new OpenAI({ apiKey, maxRetries: 1, timeout: 60_000, dangerouslyAllowBrowser: true, ...((await baseUrls()).openai ? { baseURL: (await baseUrls()).openai } : {}) });
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

export function classifyError(e: unknown, ctx?: { model?: string }): { message: string; code: AiErrorCode } {
  const err = e as { name?: string; status?: number; message?: string; code?: string };
  const msg = err?.message ?? '';
  if (e instanceof Anthropic.APIConnectionTimeoutError || e instanceof OpenAI.APIConnectionTimeoutError || err?.name === 'TimeoutError' || /timed? ?out/i.test(msg)) {
    return { message: 'The service did not answer in time. Check your internet connection and try again.', code: 'timeout' };
  }
  if (err?.name === 'AbortError' || err?.code === 'cancelled' || e instanceof Anthropic.APIUserAbortError || e instanceof OpenAI.APIUserAbortError || /abort/i.test(msg)) return { message: 'Cancelled', code: 'cancelled' };
  if (e instanceof Anthropic.AuthenticationError || e instanceof OpenAI.AuthenticationError || err?.status === 401) return { message: 'The API key was rejected. Check it in the Dream Tutor settings.', code: 'auth' };
  if (e instanceof Anthropic.PermissionDeniedError || e instanceof OpenAI.PermissionDeniedError || err?.status === 403) return { message: 'The API key is not allowed to use this service (permission denied). Check the key\'s permissions in your provider account.', code: 'auth' };
  if (e instanceof Anthropic.RateLimitError || e instanceof OpenAI.RateLimitError || err?.status === 429) {
    const spend = /spend|usage limit|billing|quota|insufficient|credit/i.test(msg);
    return { message: spend ? 'Your API account has no credit left or reached its spending limit.' : 'Too many requests right now; try again in a moment.', code: spend ? 'spend_limit' : 'rate_limit' };
  }
  if (err?.status === 400 && /usage limit|spend|credit balance|insufficient/i.test(msg)) return { message: 'Your API account has no credit left or reached its spending limit.', code: 'spend_limit' };
  if (e instanceof Anthropic.NotFoundError || e instanceof OpenAI.NotFoundError || err?.status === 404) {
    if (ctx?.model || /model/i.test(msg)) return { message: `Model ${ctx?.model ?? ''} is not available for your key; pick another model.`.replace('Model  is', 'The chosen model is'), code: 'model' };
    return { message: `The service reported "not found" (HTTP 404): ${msg || 'no details'}`, code: 'other' };
  }
  if (err?.status === 529 || err?.status === 503 || err?.status === 502 || /overloaded/i.test(msg)) return { message: 'The AI service is overloaded right now; try again in a moment.', code: 'rate_limit' };
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError || /failed to fetch|network/i.test(msg)) return { message: 'No internet connection, or the AI service is unreachable.', code: 'network' };
  return { message: msg || 'Unknown AI error', code: 'other' };
}

function noKey(provider: AiProviderId): Error {
  return Object.assign(new Error(provider === 'anthropic' ? 'Add your Anthropic (Claude) API key in the Dream Tutor settings.' : 'Add your OpenAI API key in the Dream Tutor settings.'), { code: 'no_key' });
}

async function record(provider: AiProviderId, model: string, r: StreamResult): Promise<{ usd: number; dailyUsd: number; monthlyUsd: number }> {
  const usd = estimateUsd(model, r.inputTokens, r.outputTokens, r.cachedTokens);
  try { await addUsage({ date: new Date().toISOString(), provider, model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedTokens: r.cachedTokens, usd }); } catch (e) { console.error('usage not recorded', e); }
  const list = await getUsage();
  const { day, month } = periodStarts();
  return { usd, dailyUsd: usdSince(list, day), monthlyUsd: usdSince(list, month) };
}

/** One explanation, streamed. */
export async function runExplain(req: ExplainRequest, signal: AbortSignal, onDelta: (t: string) => void): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number; cachedTokens: number; usd: number; dailyUsd: number; monthlyUsd: number; model: string } }> {
  const s = await getSettings();
  const styled = req.kind === 'word' || req.kind === 'phrase' || req.kind === 'sentence';
  const style = styled ? resolveStyle((req.styleId as StyleId) ?? s.ai.activeStyle, s.ai.styles) : null;
  const provider = style?.provider ?? s.ai.provider;
  const model = style?.model ?? (provider === 'anthropic' ? s.ai.anthropicModel : s.ai.openaiModel);
  const key = (await getKeys())[provider];
  if (!key) throw noKey(provider);
  const monthly = usdSince(await getUsage(), periodStarts().month);
  if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) throw Object.assign(new Error(`Monthly AI budget of $${s.ai.monthlyStopUsd} reached. Raise it in the Dream Tutor settings to continue.`), { code: 'budget' });
  const prompt = style
    ? buildStyledPrompt(req, { style, contextRules: s.ai.contextRules, level: s.learnerLevel, native: 'Chinese' })
    : buildPrompt(req, { level: s.learnerLevel, instructions: s.ai.instructions, length: s.ai.explanationLength });
  try {
    const r = provider === 'anthropic' ? await streamAnthropic(key, model, prompt, signal, onDelta) : await streamOpenAI(key, model, prompt, signal, onDelta);
    const u = await record(provider, model, r);
    return { text: r.text, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedTokens: r.cachedTokens, ...u, model } };
  } catch (e) { throw Object.assign(new Error(classifyError(e, { model }).message), { code: classifyError(e, { model }).code }); }
}

/** A background job (Chinese hints, phrases) with the cheap hints model; nothing streamed. */
export async function runCompletion(prompt: PromptBundle, signal: AbortSignal): Promise<{ text: string; usd: number }> {
  const s = await getSettings();
  const { provider, model } = hintsModelFor(s);
  const key = (await getKeys())[provider];
  if (!key) throw noKey(provider);
  const monthly = usdSince(await getUsage(), periodStarts().month);
  if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) throw Object.assign(new Error('Monthly AI budget reached.'), { code: 'budget' });
  try {
    const noop = (): void => undefined;
    const r = provider === 'anthropic' ? await streamAnthropic(key, model, prompt, signal, noop) : await streamOpenAI(key, model, prompt, signal, noop);
    const u = await record(provider, model, r);
    return { text: r.text, usd: u.usd };
  } catch (e) { const c = classifyError(e, { model }); throw Object.assign(new Error(c.message), { code: c.code }); }
}

/** "Test" button in the settings: a tiny request with the saved key. */
export async function testKey(provider: AiProviderId): Promise<{ ok: boolean; message: string }> {
  const s = await getSettings();
  const key = (await getKeys())[provider];
  if (!key) return { ok: false, message: `No ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key is saved yet. Paste it and click Save.` };
  const model = provider === 'anthropic' ? s.ai.anthropicModel : s.ai.openaiModel;
  const urls = await baseUrls();
  try {
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 30_000, dangerouslyAllowBrowser: true, ...(urls.anthropic ? { baseURL: urls.anthropic } : {}) });
      const res = await client.messages.create({ model, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('').trim();
      return { ok: true, message: `Connected. ${res.model} replied: ${text.slice(0, 40)}` };
    }
    const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 30_000, dangerouslyAllowBrowser: true, ...(urls.openai ? { baseURL: urls.openai } : {}) });
    const res = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_completion_tokens: 20 });
    return { ok: true, message: `Connected. ${res.model} replied: ${(res.choices[0]?.message?.content ?? '').trim().slice(0, 40)}` };
  } catch (e) {
    const c = classifyError(e, { model });
    const raw = (e as { message?: string })?.message;
    return { ok: false, message: c.code === 'other' ? `Unexpected error: ${raw || 'no details'}` : c.message };
  }
}

export function installDreamBackground(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'dream-ai') return;
    const ctrl = new AbortController();
    port.onDisconnect.addListener(() => ctrl.abort());
    const post = (m: unknown) => { try { port.postMessage(m); } catch { /* the page went away */ } };
    port.onMessage.addListener((msg: { type: string; req?: ExplainRequest; prompt?: PromptBundle }) => {
      if (msg?.type === 'explain' && msg.req) {
        runExplain(msg.req, ctrl.signal, (t) => post({ type: 'delta', text: t }))
          .then((r) => post({ type: 'done', text: r.text, usage: r.usage }))
          .catch((e: Error & { code?: string }) => post({ type: 'error', message: e.message, code: e.code ?? 'other' }));
      } else if (msg?.type === 'complete' && msg.prompt) {
        runCompletion(msg.prompt, ctrl.signal)
          .then((r) => post({ type: 'done', text: r.text, usd: r.usd }))
          .catch((e: Error & { code?: string }) => post({ type: 'error', message: e.message, code: e.code ?? 'other' }));
      }
    });
  });
  chrome.runtime.onMessage.addListener((msg: { type?: string; provider?: AiProviderId }, _sender, sendResponse) => {
    if (msg?.type === 'dream-test-key' && msg.provider) { void testKey(msg.provider).then(sendResponse); return true; }
    if (msg?.type === 'dream-open' && (msg as { page?: string }).page) { void chrome.tabs.create({ url: chrome.runtime.getURL(`dream/${(msg as { page: string }).page}.html`) }); return false; }
    return false;
  });
}

installDreamBackground();
