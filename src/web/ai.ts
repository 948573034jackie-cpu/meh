/**
 * AI explanations, key tests and usage for the web build: the semantics of src/main/ai.ts with the
 * provider SDKs replaced by fetch + a small server-sent-events reader, so nothing Node-only is bundled.
 * Requests go straight from the browser to the provider with the learner's own key (Anthropic requires
 * the `anthropic-dangerous-direct-browser-access` header for that; OpenAI allows CORS by default).
 */
import { SECRET_NAMES, SECRET_LABELS, type ExplainRequest, type AiEvent, type AiErrorCode, type SecretName, type ProviderTestResult } from '@shared/api';
import { buildPrompt, buildStyledPrompt, type PromptBundle } from '@core/ai/prompts';
import { resolveStyle, type StyleId } from '@shared/styles';
import type { AiProviderId } from '@shared/settings';
import { getSettings, addUsage, usdSpent } from './settings';
import { getSecret, hasSecret, formatWarning, getAzureCredentials } from './secrets';

/** Approximate list prices in USD per million tokens (input, output, cache read); copied from src/main/ai.ts. */
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

export function periodStarts(now = new Date()): { day: string; month: string } {
  return { day: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), month: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
}

export interface StreamResult { text: string; inputTokens: number; outputTokens: number; cachedTokens: number }

/** An HTTP failure from a provider, shaped like the SDK errors classifyError understands. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly body = '') { super(message); this.name = 'HttpError'; }
}

const REQUEST_TIMEOUT_MS = 60_000;

/** Aborts when the caller aborts or after `ms`; the reason tells a timeout apart from a cancel. */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(Object.assign(new Error('The request timed out'), { name: 'TimeoutError' })), ms);
  const onAbort = () => ctrl.abort(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  return { signal: ctrl.signal, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

/** Rethrows fetch/read failures with the abort reason (fetch rejects with a generic AbortError otherwise). */
function rethrow(e: unknown, signal: AbortSignal): never {
  if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
  throw e;
}

/** rethrow(), with what the stream had used when it ended (`partialUsage`, recorded for a cancelled request). */
function withPartialUsage(e: unknown, signal: AbortSignal, partial: StreamResult | undefined): never {
  try { rethrow(e, signal); } catch (err) {
    if (partial && err && typeof err === 'object') Object.assign(err, { partialUsage: partial });
    throw err;
  }
}

async function errorFromResponse(res: Response, label: string): Promise<HttpError> {
  let body = '';
  try { body = (await res.text()).slice(0, 2000); } catch { /* no body */ }
  let message = '';
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    message = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message ?? '';
  } catch { message = body.slice(0, 300); }
  return new HttpError(res.status, `${res.status} ${message || `${label} HTTP error`}`, body);
}

/** Reads a text/event-stream body and calls onEvent(eventName, data) for every event. */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let data: string[] = [];
  const dispatch = () => {
    if (data.length) onEvent(event || 'message', data.join('\n'));
    event = ''; data = [];
  };
  const line = (l: string) => {
    if (l === '') { dispatch(); return; }
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
      const sep = buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1;
      line(buf.slice(0, nl));
      buf = buf.slice(nl + sep);
    }
  }
  buf += decoder.decode();
  if (buf) line(buf);
  dispatch();
}

export async function streamAnthropic(apiKey: string, model: string, prompt: PromptBundle, signal: AbortSignal, onText: (t: string) => void): Promise<StreamResult> {
  // Opus 5.5 / Sonnet 5.5 / Fable: opt into server-side refusal fallbacks, as the Mac app does
  const wantsFallback = /^claude-(opus-5-5|sonnet-5-5|fable)/.test(model);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (wantsFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  const body: Record<string, unknown> = {
    model,
    max_tokens: prompt.maxTokens,
    system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt.user }],
    output_config: { effort: 'low' },
    stream: true,
  };
  if (wantsFallback) body.fallbacks = 'default';
  // Haiku 5.5 may answer without thinking at effort high or below (sooner first words), as the Mac app does
  if (/^claude-haiku-5-5/.test(model)) body.thinking = { type: 'disabled' };
  const t = withTimeout(signal, REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body), signal: t.signal }).catch((e) => rethrow(e, t.signal));
    if (!res.ok || !res.body) throw await errorFromResponse(res, 'Anthropic');
    let text = '';
    let stop: string | null = null;
    const u = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    let streamError: HttpError | null = null;
    const takeUsage = (x: Record<string, number | undefined> | undefined) => {
      if (!x) return;
      if (typeof x.input_tokens === 'number') u.input = Math.max(u.input, x.input_tokens);
      if (typeof x.cache_read_input_tokens === 'number') u.cacheRead = Math.max(u.cacheRead, x.cache_read_input_tokens);
      if (typeof x.cache_creation_input_tokens === 'number') u.cacheWrite = Math.max(u.cacheWrite, x.cache_creation_input_tokens);
      if (typeof x.output_tokens === 'number') u.output = Math.max(u.output, x.output_tokens);
    };
    await readSse(res.body, (_event, data) => {
      let ev: { type?: string; message?: { usage?: Record<string, number> }; delta?: { type?: string; text?: string; stop_reason?: string }; usage?: Record<string, number>; error?: { type?: string; message?: string } };
      try { ev = JSON.parse(data); } catch { return; }
      if (ev.type === 'message_start') takeUsage(ev.message?.usage);
      else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) { text += ev.delta.text; onText(ev.delta.text); }
      else if (ev.type === 'message_delta') { if (ev.delta?.stop_reason) stop = ev.delta.stop_reason; takeUsage(ev.usage); }
      else if (ev.type === 'error') {
        const type = ev.error?.type ?? '';
        const status = type === 'overloaded_error' ? 529 : type === 'rate_limit_error' ? 429 : type === 'authentication_error' ? 401 : type === 'not_found_error' ? 404 : 500;
        streamError = new HttpError(status, ev.error?.message ?? type ?? 'stream error');
      }
    }).catch((e) => {
      // ended early: what it had used (runExplain counts it for a cancelled request); output is a lower bound
      const started = u.input + u.cacheRead + u.cacheWrite > 0;
      withPartialUsage(e, t.signal, started ? { text: '', inputTokens: u.input + u.cacheRead + u.cacheWrite, outputTokens: Math.max(u.output, Math.ceil(text.length / 4)), cachedTokens: u.cacheRead } : undefined);
    });
    if (streamError) throw streamError;
    if (stop === 'refusal') throw Object.assign(new Error('The AI declined to answer this request.'), { code: 'other' });
    return { text, inputTokens: u.input + u.cacheRead + u.cacheWrite, outputTokens: u.output, cachedTokens: u.cacheRead };
  } finally { t.done(); }
}

export async function streamOpenAI(apiKey: string, model: string, prompt: PromptBundle, signal: AbortSignal, onText: (t: string) => void): Promise<StreamResult> {
  const body = {
    model,
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: prompt.maxTokens + 800,
    ...(/^(gpt-5|o[1-9])/.test(model) ? { reasoning_effort: 'low' } : {}),
  };
  const t = withTimeout(signal, REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: t.signal,
    }).catch((e) => rethrow(e, t.signal));
    if (!res.ok || !res.body) throw await errorFromResponse(res, 'OpenAI');
    let text = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0, cached: 0 };
    let streamError: HttpError | null = null;
    let started = false;
    await readSse(res.body, (_event, data) => {
      started = true;
      if (data === '[DONE]') return;
      let chunk: { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } }; error?: { message?: string } };
      try { chunk = JSON.parse(data); } catch { return; }
      if (chunk.error) { streamError = new HttpError(500, chunk.error.message ?? 'stream error'); return; }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) { text += delta; onText(delta); }
      if (chunk.usage) usage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens, cached: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0 };
    }).catch((e) => {
      // ended early: OpenAI reports usage only at the end, so the prompt is estimated from its characters
      withPartialUsage(e, t.signal, started ? { text: '', inputTokens: Math.ceil((prompt.system.length + prompt.user.length) / 4), outputTokens: Math.ceil(text.length / 4), cachedTokens: 0 } : undefined);
    });
    if (streamError) throw streamError;
    return { text, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, cachedTokens: usage.cached };
  } finally { t.done(); }
}

/** Same messages and codes as src/main/ai.ts classifyError, for fetch errors (Safari: "Load failed"). */
export function classifyError(e: unknown, ctx?: { model?: string }): { message: string; code: AiErrorCode } {
  const err = e as { name?: string; status?: number; message?: string; code?: string };
  const msg = err?.message ?? '';
  if (err?.name === 'TimeoutError' || /timed? ?out/i.test(msg)) return { message: 'The service did not answer in time. Check your internet connection and try again.', code: 'timeout' };
  if (err?.name === 'AbortError' || err?.code === 'cancelled' || /abort/i.test(msg)) return { message: 'Cancelled', code: 'cancelled' };
  if (err?.status === 401) return { message: 'The API key was rejected. Check it in Settings.', code: 'auth' };
  if (err?.status === 403) return { message: 'The API key is not allowed to use this service (permission denied). Check the key\'s permissions in your provider account.', code: 'auth' };
  if (err?.status === 429) {
    const spend = /spend|usage limit|billing|quota|insufficient|credit/i.test(msg);
    return { message: spend ? 'Your API account has no credit left or reached its spending limit.' : 'Too many requests right now; try again in a moment.', code: spend ? 'spend_limit' : 'rate_limit' };
  }
  if (err?.status === 400 && /usage limit|spend|credit balance|insufficient/i.test(msg)) return { message: 'Your API account has no credit left or reached its spending limit.', code: 'spend_limit' };
  if (err?.status === 404) {
    if (ctx?.model || /model/i.test(msg)) return { message: `Model ${ctx?.model ?? ''} is not available for your key; pick another model.`.replace('Model  is', 'The chosen model is'), code: 'model' };
    return { message: `The service reported "not found" (HTTP 404): ${msg || 'no details'}`, code: 'other' };
  }
  if (err?.status === 529 || err?.status === 503 || err?.status === 502 || /overloaded/i.test(msg)) return { message: 'The AI service is overloaded right now; try again in a moment.', code: 'rate_limit' };
  if ((e instanceof TypeError && !err?.status) || /load failed|failed to fetch|networkerror|network/i.test(msg)) return { message: 'No internet connection, or the AI service is unreachable.', code: 'network' };
  return { message: msg || 'Unknown AI error', code: 'other' };
}

function noKey(provider: AiProviderId): string { return provider === 'anthropic' ? 'Add your Anthropic API key in Settings.' : 'Add your OpenAI API key in Settings.'; }

/** One non-streamed completion (hints job): same request shape and usage accounting; the caller records usage. */
export async function runCompletion(provider: AiProviderId, model: string, prompt: PromptBundle, signal: AbortSignal = new AbortController().signal): Promise<StreamResult> {
  const key = await getSecret(provider);
  if (!key) throw Object.assign(new Error(noKey(provider)), { code: 'no_key' });
  const noop = (): void => { /* nothing is shown */ };
  return provider === 'anthropic' ? streamAnthropic(key, model, prompt, signal, noop) : streamOpenAI(key, model, prompt, signal, noop);
}

/* ------------------------------------------------------------------------------------------------
 * Explanations: aiExplain / aiCancel / onAiEvent
 * ---------------------------------------------------------------------------------------------- */

const listeners = new Set<(ev: AiEvent) => void>();
const streams = new Map<string, AbortController>();
let counter = 0;

function send(ev: AiEvent): void {
  for (const cb of [...listeners]) { try { cb(ev); } catch (e) { console.error('[web] AI listener failed', e); } }
}

export function onAiEvent(cb: (ev: AiEvent) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export async function aiExplain(req: ExplainRequest): Promise<{ streamId: string }> {
  const streamId = `s${++counter}`;
  const ctrl = new AbortController();
  streams.set(streamId, ctrl);
  // start after returning the id so the renderer can subscribe first
  setTimeout(() => { void runExplain(streamId, req, ctrl).finally(() => streams.delete(streamId)); }, 0);
  return { streamId };
}

export async function aiCancel(streamId: string): Promise<void> { streams.get(streamId)?.abort(); }

async function runExplain(streamId: string, req: ExplainRequest, ctrl: AbortController): Promise<void> {
  let used: { provider: AiProviderId; model: string } | null = null;
  try {
    const s = await getSettings();
    const styled = req.kind === 'word' || req.kind === 'phrase' || req.kind === 'sentence';
    const style = styled ? resolveStyle((req.styleId as StyleId) ?? s.ai.activeStyle, s.ai.styles) : null;
    const provider = style?.provider ?? s.ai.provider;
    const model = style?.model ?? (provider === 'anthropic' ? s.ai.anthropicModel : s.ai.openaiModel);
    used = { provider, model };
    const key = await getSecret(provider);
    if (!key) { send({ type: 'error', streamId, message: noKey(provider), code: 'no_key' }); return; }
    const monthly = await usdSpent(periodStarts().month);
    if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) {
      send({ type: 'error', streamId, message: `Monthly AI budget of $${s.ai.monthlyStopUsd} reached. Raise it in Settings to continue.`, code: 'budget' });
      return;
    }
    const prompt = style
      ? buildStyledPrompt(req, { style, contextRules: s.ai.contextRules, level: s.learnerLevel, native: 'Chinese' })
      : buildPrompt(req, { level: s.learnerLevel, instructions: s.ai.instructions, length: s.ai.explanationLength });
    const onText = (t: string) => send({ type: 'delta', streamId, text: t });
    const result = provider === 'anthropic'
      ? await streamAnthropic(key, model, prompt, ctrl.signal, onText)
      : await streamOpenAI(key, model, prompt, ctrl.signal, onText);
    const usd = estimateUsd(model, result.inputTokens, result.outputTokens, result.cachedTokens);
    try { await addUsage({ date: new Date().toISOString(), provider, model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedTokens: result.cachedTokens, usd }); } catch (e) { console.error('usage not recorded', e); }
    const { day, month } = periodStarts();
    send({ type: 'done', streamId, text: result.text, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedTokens: result.cachedTokens, usd, dailyUsd: await usdSpent(day), monthlyUsd: await usdSpent(month), model } });
  } catch (e) {
    const c = classifyError(e);
    // cancelled mid-way (a prepared explanation the learner did not need): the tokens are billed all the same
    const partial = (e as { partialUsage?: StreamResult }).partialUsage;
    if (c.code === 'cancelled' && partial && used) {
      try { await addUsage({ date: new Date().toISOString(), provider: used.provider, model: used.model, inputTokens: partial.inputTokens, outputTokens: partial.outputTokens, cachedTokens: partial.cachedTokens, usd: estimateUsd(used.model, partial.inputTokens, partial.outputTokens, partial.cachedTokens), partial: true }); } catch (err) { console.error('usage not recorded', err); }
    }
    send({ type: 'error', streamId, ...c });
  }
}

/* ------------------------------------------------------------------------------------------------
 * Key tests (the "Test" buttons)
 * ---------------------------------------------------------------------------------------------- */

const TEST_TIMEOUT_MS = 15_000;
type TestOutcome = ProviderTestResult & { code?: AiErrorCode };

function noKeyMessage(name: SecretName): string { return `No ${SECRET_LABELS[name]} API key is saved yet. Paste it in Settings and click Save.`; }

export async function testProvider(provider: SecretName): Promise<ProviderTestResult> {
  if (!SECRET_NAMES.includes(provider)) return { ok: false, message: `Unknown provider "${provider}".` };
  const key = await getSecret(provider);
  if (!key) return { ok: false, message: (await hasSecret(provider)) ? `The ${SECRET_LABELS[provider]} key is saved but cannot be read; remove it and paste it again.` : noKeyMessage(provider) };
  const looksWrong = formatWarning(provider, key);
  const result = await runTest(provider, key);
  if (!result.ok && looksWrong && result.code === 'auth') {
    return { ok: false, message: `The key looks wrong: ${looksWrong.replace(/ It was saved anyway; use Test to check it\.$/, '')} Check that you pasted the whole key.`, detail: result.detail ?? result.message };
  }
  return { ok: result.ok, message: result.message, ...(result.detail ? { detail: result.detail } : {}) };
}

async function runTest(provider: SecretName, key: string): Promise<TestOutcome> {
  const s = await getSettings();
  try {
    if (provider === 'anthropic' || provider === 'openai') {
      const model = provider === 'anthropic' ? s.ai.anthropicModel : s.ai.openaiModel;
      const t = withTimeout(undefined, 30_000);
      try {
        const res = provider === 'anthropic'
          ? await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', signal: t.signal,
            headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
            body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }),
          }).catch((e) => rethrow(e, t.signal))
          : await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST', signal: t.signal,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_completion_tokens: 20 }),
          }).catch((e) => rethrow(e, t.signal));
        if (!res.ok) throw await errorFromResponse(res, SECRET_LABELS[provider]);
        const j = await res.json() as { model?: string; content?: { type: string; text?: string }[]; choices?: { message?: { content?: string } }[] };
        const text = provider === 'anthropic' ? (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') : j.choices?.[0]?.message?.content ?? '';
        return { ok: true, message: `Connected. ${j.model ?? model} replied: ${text.trim().slice(0, 40)}` };
      } finally { t.done(); }
    }
    if (provider === 'elevenlabs') return await testElevenLabs(key);
    if (provider === 'azure') return await testAzure();
    return await testGoogle(key);
  } catch (e) {
    const model = provider === 'anthropic' ? s.ai.anthropicModel : provider === 'openai' ? s.ai.openaiModel : undefined;
    const c = classifyError(e, { model });
    const raw = (e as { message?: string })?.message;
    return { ok: false, message: c.code === 'other' ? `Unexpected error from ${SECRET_LABELS[provider]}: ${raw || 'no details'}` : c.message, code: c.code, ...(raw ? { detail: raw } : {}) };
  }
}

async function readBody(res: Response): Promise<string> { try { return (await res.text()).slice(0, 2000); } catch { return ''; } }

function httpFailure(label: string, status: number, body: string): TestOutcome {
  const detail = body ? `HTTP ${status}: ${body}` : `HTTP ${status}`;
  if (status === 401) return { ok: false, message: `${label} rejected the key (HTTP 401). Check it and paste it again.`, code: 'auth', detail };
  if (status === 403) return { ok: false, message: `${label} says this key is not allowed to use the service (HTTP 403). Check the key's permissions or quota in your ${label} account.`, code: 'auth', detail };
  if (status === 429) {
    const spend = /quota|credit|billing|limit|exhausted/i.test(body);
    return { ok: false, message: spend ? `Your ${label} account has no credit left or reached its usage limit.` : `${label} is receiving too many requests right now; try again in a moment.`, code: spend ? 'spend_limit' : 'rate_limit', detail };
  }
  if (status === 402) return { ok: false, message: `Your ${label} account has no credit left or reached its spending limit.`, code: 'spend_limit', detail };
  if (status === 404) return { ok: false, message: `${label} replied "not found" (HTTP 404); the service address may have changed. Update the app or try again later.`, code: 'other', detail };
  if (status === 502 || status === 503 || status === 529) return { ok: false, message: `${label} is overloaded or down for maintenance right now; try again in a moment.`, code: 'rate_limit', detail };
  if (status >= 500) return { ok: false, message: `${label} reported a server error (HTTP ${status}); try again in a moment.`, code: 'rate_limit', detail };
  return { ok: false, message: `Unexpected reply from ${label} (HTTP ${status}): ${body.slice(0, 200) || 'no details'}`, code: 'other', detail };
}

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(Object.assign(new Error('The request timed out'), { name: 'TimeoutError' })), ms);
  return c.signal;
}

async function testElevenLabs(key: string): Promise<TestOutcome> {
  const res = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': key }, signal: timeoutSignal(TEST_TIMEOUT_MS) });
  const body = await readBody(res);
  if (!res.ok) return httpFailure('ElevenLabs', res.status, body);
  let sub: { tier?: string; character_count?: number; character_limit?: number } = {};
  try { sub = (JSON.parse(body) as { subscription?: typeof sub }).subscription ?? {}; } catch { /* still connected */ }
  const used = sub.character_count ?? 0, limit = sub.character_limit ?? 0;
  if (limit > 0 && used >= limit) return { ok: false, message: `The ElevenLabs key works, but the monthly character allowance is used up (${used.toLocaleString()} of ${limit.toLocaleString()}). Voices will fail until it resets or you upgrade the plan.`, code: 'spend_limit' };
  const facts = [sub.tier ? `${sub.tier} plan` : '', limit > 0 ? `${used.toLocaleString()} of ${limit.toLocaleString()} characters used this month` : ''].filter(Boolean);
  return { ok: true, message: `Connected to ElevenLabs${facts.length ? ` (${facts.join(', ')})` : ''}.` };
}

async function testAzure(): Promise<TestOutcome> {
  const creds = await getAzureCredentials();
  if (!creds) return { ok: false, message: 'The Azure entry could not be read. Paste the key and region again.', code: 'auth' };
  const res = await fetch(`https://${creds.region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': creds.key }, signal: timeoutSignal(TEST_TIMEOUT_MS) });
  const body = await readBody(res);
  if (res.ok) return { ok: true, message: `Connected to Azure Speech in region "${creds.region}".` };
  if (res.status === 401) return { ok: false, message: `Azure rejected the key (HTTP 401). Check the key, and that the region "${creds.region}" matches your Speech resource.`, code: 'auth', detail: `HTTP 401: ${body}` };
  return httpFailure('Azure Speech', res.status, body);
}

async function testGoogle(key: string): Promise<TestOutcome> {
  const res = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(key)}&languageCode=en-GB`, { signal: timeoutSignal(TEST_TIMEOUT_MS) });
  const body = await readBody(res);
  if (res.ok) {
    let n = 0;
    try { n = ((JSON.parse(body) as { voices?: unknown[] }).voices ?? []).length; } catch { /* still connected */ }
    return { ok: true, message: `Connected to Google Cloud Text-to-Speech (${n} British English voices available).` };
  }
  return httpFailure('Google Cloud', res.status, body);
}
