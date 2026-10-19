import { ipcMain, BrowserWindow } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { SECRET_NAMES, SECRET_LABELS, type ExplainRequest, type AiEvent, type AiErrorCode, type SecretName, type ProviderTestResult } from '@shared/api';
import { buildPrompt, buildStyledPrompt } from '@core/ai/prompts';
import { resolveStyle } from '@shared/styles';
import type { StyleId } from '@shared/styles';
import type { AiProviderId } from '@shared/settings';
import { getSettings, addUsage, getUsage, usdSpent } from './settings';
import { getSecret, hasSecret, formatWarning, getAzureCredentials } from './secrets';

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
  ipcMain.handle('ai:test', async (_e, provider: SecretName) => testProvider(provider));
}

async function runExplain(streamId: string, req: ExplainRequest, ctrl: AbortController, send: (ev: AiEvent) => void): Promise<void> {
  // Everything is inside the try: the renderer waits for a 'done' or 'error' event and nothing else may end the stream.
  try {
    const s = getSettings();
    // word/phrase/sentence explanations use the active explanation style (its own prompt, provider and model)
    const styled = req.kind === 'word' || req.kind === 'phrase' || req.kind === 'sentence';
    const style = styled ? resolveStyle((req.styleId as StyleId) ?? s.ai.activeStyle, s.ai.styles) : null;
    const provider = style?.provider ?? s.ai.provider;
    const model = style?.model ?? (provider === 'anthropic' ? s.ai.anthropicModel : s.ai.openaiModel);
    const key = getSecret(provider);
    if (!key) { send({ type: 'error', streamId, message: provider === 'anthropic' ? 'Add your Anthropic API key in Settings.' : 'Add your OpenAI API key in Settings.', code: 'no_key' }); return; }
    const monthly = usdSpent(periodStarts().month);
    if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) {
      send({ type: 'error', streamId, message: `Monthly AI budget of $${s.ai.monthlyStopUsd} reached. Raise it in Settings to continue.`, code: 'budget' });
      return;
    }
    const prompt = style
      ? buildStyledPrompt(req, { style, contextRules: s.ai.contextRules, level: s.learnerLevel, native: 'Chinese' })
      : buildPrompt(req, { level: s.learnerLevel, instructions: s.ai.instructions, length: s.ai.explanationLength });
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

export interface StreamResult { text: string; inputTokens: number; outputTokens: number; cachedTokens: number }

/**
 * One non-streaming completion with an explicit provider and model (background jobs such as the chapter
 * hints; nothing is shown while it runs). Same request shape and usage accounting as the explanations;
 * the caller records the usage and classifies errors.
 */
export async function runCompletion(provider: AiProviderId, model: string, prompt: { system: string; user: string; maxTokens: number }, signal: AbortSignal = new AbortController().signal): Promise<StreamResult> {
  const key = getSecret(provider);
  if (!key) throw Object.assign(new Error(provider === 'anthropic' ? 'Add your Anthropic API key in Settings.' : 'Add your OpenAI API key in Settings.'), { code: 'no_key' });
  const noop = (): void => { /* nothing is streamed */ };
  return provider === 'anthropic' ? streamAnthropic(key, model, prompt, signal, noop) : streamOpenAI(key, model, prompt, signal, noop);
}

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

export function classifyError(e: unknown, ctx?: { model?: string }): { message: string; code: AiErrorCode } {
  const err = e as { name?: string; status?: number; message?: string; code?: string; cause?: { code?: string; name?: string; message?: string } };
  const msg = err?.message ?? '';
  const causeCode = err?.cause?.code ?? '';
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError whose message also says "aborted": test it first
  if (e instanceof Anthropic.APIConnectionTimeoutError || e instanceof OpenAI.APIConnectionTimeoutError || err?.name === 'TimeoutError' || /timed? ?out|ETIMEDOUT/i.test(msg) || causeCode === 'ETIMEDOUT' || causeCode === 'UND_ERR_CONNECT_TIMEOUT' || causeCode === 'UND_ERR_HEADERS_TIMEOUT') {
    return { message: 'The service did not answer in time. Check your internet connection and try again.', code: 'timeout' };
  }
  if (err?.name === 'AbortError' || err?.code === 'cancelled' || /abort/i.test(msg)) return { message: 'Cancelled', code: 'cancelled' };
  if (e instanceof Anthropic.AuthenticationError || e instanceof OpenAI.AuthenticationError || err?.status === 401) return { message: 'The API key was rejected. Check it in Settings.', code: 'auth' };
  if (e instanceof Anthropic.PermissionDeniedError || e instanceof OpenAI.PermissionDeniedError || err?.status === 403) return { message: 'The API key is not allowed to use this service (permission denied). Check the key\'s permissions in your provider account.', code: 'auth' };
  if (e instanceof Anthropic.RateLimitError || e instanceof OpenAI.RateLimitError || err?.status === 429) {
    const spend = /spend|usage limit|billing|quota|insufficient|credit/i.test(msg);
    return { message: spend ? 'Your API account has no credit left or reached its spending limit.' : 'Too many requests right now; try again in a moment.', code: spend ? 'spend_limit' : 'rate_limit' };
  }
  // Anthropic reports an empty prepaid balance as a 400 ("credit balance is too low")
  if (err?.status === 400 && /usage limit|spend|credit balance|insufficient/i.test(msg)) return { message: 'Your API account has no credit left or reached its spending limit.', code: 'spend_limit' };
  if (e instanceof Anthropic.NotFoundError || e instanceof OpenAI.NotFoundError || err?.status === 404) {
    if (ctx?.model || /model/i.test(msg)) return { message: `Model ${ctx?.model ?? ''} is not available for your key; pick another model.`.replace('Model  is', 'The chosen model is'), code: 'model' };
    return { message: `The service reported "not found" (HTTP 404): ${msg || 'no details'}`, code: 'other' };
  }
  if (err?.status === 529 || err?.status === 503 || err?.status === 502 || /overloaded/i.test(msg)) return { message: 'The AI service is overloaded right now; try again in a moment.', code: 'rate_limit' };
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError || /fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|network/i.test(msg) || /ENOTFOUND|ECONN|EAI_AGAIN/.test(causeCode)) return { message: 'No internet connection, or the AI service is unreachable.', code: 'network' };
  return { message: msg || 'Unknown AI error', code: 'other' };
}

const TEST_TIMEOUT_MS = 15_000;

function noKeyMessage(name: SecretName): string { return `No ${SECRET_LABELS[name]} API key is saved yet. Paste it in Settings and click Save.`; }

/**
 * Checks the saved key of any provider with a tiny request. Messages are written for the learner and
 * distinguish: no key saved, key looks wrong, key rejected, no credit, model unavailable, offline,
 * timeout, service overloaded, and anything else (with the raw message in `detail`).
 */
export async function testProvider(provider: SecretName): Promise<ProviderTestResult> {
  if (!SECRET_NAMES.includes(provider)) return { ok: false, message: `Unknown provider "${provider}".` };
  const key = getSecret(provider);
  if (!key) return { ok: false, message: hasSecret(provider) ? `The ${SECRET_LABELS[provider]} key is saved but cannot be decrypted; remove it and paste it again.` : noKeyMessage(provider) };
  const looksWrong = formatWarning(provider, key);
  const result = await runTest(provider, key);
  if (!result.ok && looksWrong && result.code === 'auth') {
    return { ok: false, message: `The key looks wrong: ${looksWrong.replace(/ It was saved anyway; use Test to check it\.$/, '')} Check that you pasted the whole key.`, detail: result.detail ?? result.message };
  }
  return { ok: result.ok, message: result.message, ...(result.detail ? { detail: result.detail } : {}) };
}

type TestOutcome = ProviderTestResult & { code?: AiErrorCode };

async function runTest(provider: SecretName, key: string): Promise<TestOutcome> {
  const s = getSettings();
  try {
    if (provider === 'anthropic') {
      const model = s.ai.anthropicModel;
      const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 30_000 });
      const res = await client.messages.create({ model, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('').trim();
      return { ok: true, message: `Connected. ${res.model} replied: ${text.slice(0, 40)}` };
    }
    if (provider === 'openai') {
      const model = s.ai.openaiModel;
      const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 30_000 });
      const res = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_completion_tokens: 20 });
      return { ok: true, message: `Connected. ${res.model} replied: ${(res.choices[0]?.message?.content ?? '').trim().slice(0, 40)}` };
    }
    if (provider === 'elevenlabs') return await testElevenLabs(key);
    if (provider === 'azure') return await testAzure(key);
    return await testGoogle(key);
  } catch (e) {
    const model = provider === 'anthropic' ? s.ai.anthropicModel : provider === 'openai' ? s.ai.openaiModel : undefined;
    const c = classifyError(e, { model });
    const raw = (e as { message?: string })?.message;
    return { ok: false, message: c.code === 'other' ? `Unexpected error from ${SECRET_LABELS[provider]}: ${raw || 'no details'}` : c.message, code: c.code, ...(raw ? { detail: raw } : {}) };
  }
}

async function readBody(res: Response): Promise<string> { try { return (await res.text()).slice(0, 2000); } catch { return ''; } }

/** Shared HTTP outcomes for the voice services; `specific` handles the provider's own status meanings first. */
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

async function testElevenLabs(key: string): Promise<TestOutcome> {
  const res = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
  const body = await readBody(res);
  if (!res.ok) return httpFailure('ElevenLabs', res.status, body);
  let sub: { tier?: string; character_count?: number; character_limit?: number } = {};
  try { sub = (JSON.parse(body) as { subscription?: typeof sub }).subscription ?? {}; } catch { /* unexpected shape; still connected */ }
  const used = sub.character_count ?? 0, limit = sub.character_limit ?? 0;
  if (limit > 0 && used >= limit) return { ok: false, message: `The ElevenLabs key works, but the monthly character allowance is used up (${used.toLocaleString()} of ${limit.toLocaleString()}). Voices will fail until it resets or you upgrade the plan.`, code: 'spend_limit' };
  const facts = [sub.tier ? `${sub.tier} plan` : '', limit > 0 ? `${used.toLocaleString()} of ${limit.toLocaleString()} characters used this month` : ''].filter(Boolean);
  return { ok: true, message: `Connected to ElevenLabs${facts.length ? ` (${facts.join(', ')})` : ''}.` };
}

async function testAzure(value: string): Promise<TestOutcome> {
  const creds = getAzureCredentials();
  if (!creds) return { ok: false, message: 'The Azure entry could not be read. Paste the key and region again.', code: 'auth', detail: value.startsWith('{') ? 'JSON could not be parsed' : 'empty' };
  const host = `${creds.region}.api.cognitive.microsoft.com`;
  let res: Response;
  try {
    res = await fetch(`https://${host}/sts/v1.0/issueToken`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': creds.key, 'Content-Length': '0' }, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
  } catch (e) {
    const err = e as { cause?: { code?: string; hostname?: string } };
    if (err?.cause?.code === 'ENOTFOUND' && err.cause.hostname === host) return { ok: false, message: `Azure region "${creds.region}" does not exist. Check the region of your Speech resource (for example "uksouth").`, code: 'auth', detail: `ENOTFOUND ${host}` };
    throw e;
  }
  const body = await readBody(res);
  if (res.ok) return { ok: true, message: `Connected to Azure Speech in region "${creds.region}".` };
  if (res.status === 401) return { ok: false, message: `Azure rejected the key (HTTP 401). Check the key, and that the region "${creds.region}" matches your Speech resource.`, code: 'auth', detail: `HTTP 401: ${body}` };
  if (res.status === 403) return { ok: false, message: 'Azure says this key is out of quota or the resource is disabled (HTTP 403). Check the Speech resource in the Azure portal.', code: 'spend_limit', detail: `HTTP 403: ${body}` };
  return httpFailure('Azure Speech', res.status, body);
}

async function testGoogle(key: string): Promise<TestOutcome> {
  const res = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(key)}&languageCode=en-GB`, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
  const body = await readBody(res);
  if (res.ok) {
    let n = 0;
    try { n = ((JSON.parse(body) as { voices?: unknown[] }).voices ?? []).length; } catch { /* still connected */ }
    return { ok: true, message: `Connected to Google Cloud Text-to-Speech (${n} British English voices available).` };
  }
  const detail = `HTTP ${res.status}: ${body}`;
  let reason = '', message = '';
  try { const err = (JSON.parse(body) as { error?: { message?: string; status?: string; details?: { reason?: string }[] } }).error; reason = err?.details?.map((d) => d.reason ?? '').join(' ') ?? ''; message = err?.message ?? ''; if (!reason) reason = err?.status ?? ''; } catch { message = body; }
  if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(`${reason} ${message}`)) return { ok: false, message: 'Google rejected the key (API key not valid). Check it and paste it again.', code: 'auth', detail };
  if (res.status === 403 && /SERVICE_DISABLED|has not been used|is disabled|not enabled/i.test(`${reason} ${message}`)) return { ok: false, message: 'The Cloud Text-to-Speech API is not enabled for this key\'s project. Enable it in the Google Cloud console, wait a minute, then test again.', code: 'auth', detail };
  if (res.status === 403 && /BILLING|billing/i.test(`${reason} ${message}`)) return { ok: false, message: 'Google says billing is not enabled or has no credit for this project. Enable billing in the Google Cloud console.', code: 'spend_limit', detail };
  if (res.status === 403) return { ok: false, message: 'Google says this key may not call the Text-to-Speech API (permission denied). Edit the key\'s API restrictions in the Google Cloud console.', code: 'auth', detail };
  if (res.status === 429) return { ok: false, message: 'Google says the quota for this project is used up (HTTP 429). Check quotas and billing in the Google Cloud console.', code: 'spend_limit', detail };
  return httpFailure('Google Cloud', res.status, body);
}
