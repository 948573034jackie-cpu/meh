/**
 * Background (service worker) half of the Dream Tutor: AI explanations and background jobs with the learner's
 * own API key. Same request shape, refusal fallback, cost meter and error messages as Dream Read's
 * src/main/ai.ts; the official SDKs run here (browser mode), so the key never reaches the YouTube page.
 *
 * Content scripts talk to it over a port named 'dream-ai':
 *   -> { type: 'explain', req }                       <- { type: 'delta', text } ... { type: 'done', text, usage } | { type: 'error', message, code }
 *   -> { type: 'complete', prompt, stream? }          <- ({ type: 'delta', text } ...) { type: 'done', text } | { type: 'error', ... }   (hints model)
 * Closing the port cancels the request.
 * One-off messages: 'dream-tts' (a sentence in the OpenAI / ElevenLabs voice), 'dream-live-sdp' (connects the live
 * voice call: the page's WebRTC offer goes to OpenAI's /v1/realtime/calls with the key, the answer comes back),
 * 'dream-usage' (the live call's cost), 'dream-test-key', 'dream-open'.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ExplainRequest, AiErrorCode } from '@shared/api';
import { buildPrompt, buildStyledPrompt, type PromptBundle } from '@core/ai/prompts';
import { resolveStyle, type StyleId } from '@shared/styles';
import type { AiProviderId, Settings } from '@shared/settings';
import { getSettings, getKeys, getExtras, addUsage, getUsage, usdSince, periodStarts, type Keys } from './store';
import { PART_PROMPT } from './teacher-text';

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
/** OpenAI realtime (the live voice call), USD per million tokens: text in, cached text in, text out, audio in, cached audio in, audio out. */
const REALTIME_PRICES: Record<string, [number, number, number, number, number, number]> = {
  'gpt-realtime-2.1': [4, 0.4, 24, 32, 0.4, 64],
  'gpt-realtime-2.1-mini': [0.6, 0.06, 2.4, 10, 0.3, 20],
};
export interface RealtimeUsage {
  input_tokens?: number; output_tokens?: number;
  input_token_details?: { text_tokens?: number; audio_tokens?: number; cached_tokens?: number; cached_tokens_details?: { text_tokens?: number; audio_tokens?: number } };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}
export function realtimeUsd(model: string, u: RealtimeUsage): number {
  const p = REALTIME_PRICES[model] ?? Object.entries(REALTIME_PRICES).find(([k]) => model.startsWith(k))?.[1] ?? REALTIME_PRICES['gpt-realtime-2.1'];
  const it = u.input_token_details ?? {}, ot = u.output_token_details ?? {};
  const cachedText = it.cached_tokens_details?.text_tokens ?? 0, cachedAudio = it.cached_tokens_details?.audio_tokens ?? 0;
  const textIn = Math.max(0, (it.text_tokens ?? 0) - cachedText), audioIn = Math.max(0, (it.audio_tokens ?? 0) - cachedAudio);
  return (textIn * p[0] + cachedText * p[1] + (ot.text_tokens ?? 0) * p[2] + audioIn * p[3] + cachedAudio * p[4] + (ot.audio_tokens ?? 0) * p[5]) / 1_000_000;
}

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
async function baseUrls(): Promise<{ anthropic?: string; openai?: string; elevenlabs?: string; azure?: string }> {
  const o = await chrome.storage.local.get('drTestBaseUrls');
  return (o.drTestBaseUrls as { anthropic?: string; openai?: string; elevenlabs?: string; azure?: string } | undefined) ?? {};
}

/** The chosen provider, or the other one when only its key is saved (one key is enough to start). */
export function pickProvider(s: Settings, keys: Keys): { provider: AiProviderId; model: string } {
  const want = s.ai.provider;
  const other: AiProviderId = want === 'anthropic' ? 'openai' : 'anthropic';
  const provider = keys[want] || !keys[other] ? want : other;
  return { provider, model: provider === 'anthropic' ? s.ai.anthropicModel : s.ai.openaiModel };
}

/** The learner's own teacher instructions go into the system prompt (cached with it). */
async function withTeacher(prompt: PromptBundle): Promise<PromptBundle> {
  const t = (await getExtras()).teacher?.trim();
  if (!t) return prompt;
  return { ...prompt, system: `${prompt.system}\n\nThe learner's own instructions for you, their teacher. Follow them in every answer:\n${t}` };
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
  const keys = await getKeys();
  const part = req.kind === 'passage';
  const style = styled || part ? resolveStyle((req.styleId as StyleId) ?? s.ai.activeStyle, s.ai.styles) : null;
  const picked = pickProvider(s, keys);
  const provider = style?.provider && keys[style.provider] ? style.provider : picked.provider;
  const model = style?.model && provider === style.provider ? style.model : picked.model;
  const key = keys[provider];
  if (!key) throw noKey(provider);
  const monthly = usdSince(await getUsage(), periodStarts().month);
  if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) throw Object.assign(new Error(`Monthly AI budget of $${s.ai.monthlyStopUsd} reached. Raise it in the Dream Tutor settings to continue.`), { code: 'budget' });
  // (YouTube) "you stopped the video": the part just heard, taught as a whole with the learner's rules
  const partPrompt = part && style ? { ...style, sentencePrompt: PART_PROMPT.replace('{{part}}', req.target).replace('{{seconds}}', String((req as ExplainRequest & { seconds?: number }).seconds ?? 30)), maxTokens: Math.max(style.maxTokens, 1400) } : null;
  const prompt = await withTeacher(style
    ? buildStyledPrompt(partPrompt ? { ...req, kind: 'sentence' } : req, { style: partPrompt ?? style, contextRules: s.ai.contextRules, level: s.learnerLevel, native: 'Chinese' })
    : buildPrompt(req, { level: s.learnerLevel, instructions: s.ai.instructions, length: s.ai.explanationLength }));
  try {
    const r = provider === 'anthropic' ? await streamAnthropic(key, model, prompt, signal, onDelta) : await streamOpenAI(key, model, prompt, signal, onDelta);
    const u = await record(provider, model, r);
    return { text: r.text, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedTokens: r.cachedTokens, ...u, model } };
  } catch (e) { throw Object.assign(new Error(classifyError(e, { model }).message), { code: classifyError(e, { model }).code }); }
}

/** A background job (Chinese hints, phrases) with the cheap hints model; nothing streamed. */
export async function runCompletion(prompt: PromptBundle, signal: AbortSignal, onDelta?: (t: string) => void): Promise<{ text: string; usd: number }> {
  const s = await getSettings();
  const keys = await getKeys();
  const picked = pickProvider(s, keys);
  const { provider, model } = picked.provider === s.ai.provider ? hintsModelFor(s) : { provider: picked.provider, model: picked.provider === 'anthropic' ? DEFAULT_ANTHROPIC_HINTS_MODEL : s.ai.openaiModel };
  const key = keys[provider];
  if (!key) throw noKey(provider);
  const monthly = usdSince(await getUsage(), periodStarts().month);
  if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) throw Object.assign(new Error('Monthly AI budget reached.'), { code: 'budget' });
  try {
    const onText = onDelta ?? ((): void => undefined);
    const r = provider === 'anthropic' ? await streamAnthropic(key, model, prompt, signal, onText) : await streamOpenAI(key, model, prompt, signal, onText);
    const u = await record(provider, model, r);
    return { text: r.text, usd: u.usd };
  } catch (e) { const c = classifyError(e, { model }); throw Object.assign(new Error(c.message), { code: c.code }); }
}

// ---- the tutor's voice: OpenAI (gpt-4o-mini-tts) or ElevenLabs, one sentence at a time --------------------------
interface TtsAsk { engine: 'openai' | 'elevenlabs' | 'azure'; text: string; voice: string; lang?: 'en' | 'zh' }
interface TtsAnswer { b64: string; mime: string; timings: { start: number; end: number; charIndex: number; charLength: number }[] | null }

const VOICE_STYLE = {
  en: 'Speak clear, warm, natural English at a calm teaching pace, like a kind English teacher talking to a student.',
  zh: 'Speak Mandarin Chinese (Putonghua) clearly and warmly, at a calm pace.',
};

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function synthesize(a: TtsAsk): Promise<TtsAnswer> {
  const keys = await getKeys();
  const text = a.text.trim();
  if (!text) return { b64: '', mime: 'audio/mpeg', timings: [] };
  const urls = await baseUrls();
  if (a.engine === 'openai') {
    if (!keys.openai) throw new Error('Add your OpenAI API key (Dream Tutor settings) to use the OpenAI voice.');
    // short sentences: a quick timeout and two retries (a slow or failed request is tried again at once)
    const client = new OpenAI({ apiKey: keys.openai, maxRetries: 2, timeout: 20_000, dangerouslyAllowBrowser: true, ...(urls.openai ? { baseURL: urls.openai } : {}) });
    try {
      const res = await client.audio.speech.create({ model: 'gpt-4o-mini-tts', voice: (a.voice || 'marin') as never, input: text, instructions: VOICE_STYLE[a.lang ?? 'en'], response_format: 'mp3' });
      const audio = await res.arrayBuffer();
      // about 1.5 cents per minute of speech (roughly 900 characters)
      void addUsage({ date: new Date().toISOString(), provider: 'openai', model: 'gpt-4o-mini-tts', inputTokens: text.length, outputTokens: 0, cachedTokens: 0, usd: (text.length / 900) * 0.015 }).catch(() => undefined);
      const head = new Uint8Array(audio.slice(0, 4));
      const wav = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46; // "RIFF"
      return { b64: toBase64(audio), mime: wav ? 'audio/wav' : 'audio/mpeg', timings: null };
    } catch (e) { throw new Error(`OpenAI voice: ${classifyError(e).message}`); }
  }
  if (a.engine === 'azure') return synthAzure(a, keys.azure, urls.azure);
  if (!keys.elevenlabs) throw new Error('Add your ElevenLabs API key (Dream Tutor settings) to use the ElevenLabs voice.');
  const base = urls.elevenlabs ?? 'https://api.elevenlabs.io';
  const res = await fetch(`${base}/v1/text-to-speech/${encodeURIComponent(a.voice || 'JBFqnCBsd6RMkjVDRZzb')}/with-timestamps?output_format=mp3_44100_64`, {
    method: 'POST', headers: { 'xi-api-key': keys.elevenlabs, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'ElevenLabs rejected the key. Check it in the Dream Tutor settings.' : `ElevenLabs voice: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const data = (await res.json()) as { audio_base64: string; alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null };
  void addUsage({ date: new Date().toISOString(), provider: 'openai', model: 'elevenlabs-flash', inputTokens: text.length, outputTokens: 0, cachedTokens: 0, usd: text.length * 0.00005 }).catch(() => undefined);
  return { b64: data.audio_base64, mime: 'audio/mpeg', timings: data.alignment ? charAlignmentToWords(data.alignment) : null };
}

const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The SSML for one sentence: English with the chosen voice; Chinese with a Mandarin voice (Xiaoxiao). */
export function azureSsml(text: string, voice: string, lang: 'en' | 'zh' = 'en'): string {
  const v = lang === 'zh' ? 'zh-CN-XiaoxiaoNeural' : voice || 'en-US-AvaMultilingualNeural';
  const loc = lang === 'zh' ? 'zh-CN' : (/^([a-z]{2}-[A-Z]{2})/.exec(v)?.[1] ?? 'en-US');
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${loc}"><voice name="${xml(v)}">${xml(text)}</voice></speak>`;
}

/** Microsoft's neural voices through Azure Speech (official REST; the key and region of your Speech resource). */
async function synthAzure(a: TtsAsk, key: string | undefined, testBase?: string): Promise<TtsAnswer> {
  if (!key) throw new Error('Add your Azure Speech key (⚙ → API keys) to use the Microsoft voices.');
  const region = (await getExtras()).azureRegion || 'eastus';
  const url = testBase ? `${testBase}/cognitiveservices/v1` : `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  let res: Response | null = null;
  for (let i = 0; i < 3; i++) {
    res = await fetch(url, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'DreamTutor' }, body: azureSsml(a.text, a.voice, a.lang) }).catch(() => null);
    if (res && res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  if (!res) throw new Error('Microsoft voice: no internet connection');
  if (!res.ok) throw new Error(res.status === 401 ? 'Microsoft voice: the Azure key or the region is wrong (⚙ → API keys / Voice)' : res.status === 429 ? 'Microsoft voice: the free hours of this month are used up (or too many requests)' : `Microsoft voice: HTTP ${res.status}`);
  const audio = await res.arrayBuffer();
  // the free tier covers about 500,000 characters a month; nothing is counted against your AI budget
  void addUsage({ date: new Date().toISOString(), provider: 'openai', model: 'azure-neural', inputTokens: a.text.length, outputTokens: 0, cachedTokens: 0, usd: 0 }).catch(() => undefined);
  return { b64: toBase64(audio), mime: 'audio/mpeg', timings: null };
}

/** ElevenLabs character times -> word timings (Dream Read src/main/tts.ts). */
export function charAlignmentToWords(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): { start: number; end: number; charIndex: number; charLength: number }[] {
  const out: { start: number; end: number; charIndex: number; charLength: number }[] = [];
  let i = 0;
  while (i < a.characters.length) {
    if (/\s/.test(a.characters[i])) { i++; continue; }
    const start = i;
    while (i < a.characters.length && !/\s/.test(a.characters[i])) i++;
    out.push({ start: a.character_start_times_seconds[start], end: a.character_end_times_seconds[i - 1], charIndex: start, charLength: i - start });
  }
  return out;
}

// ---- the live voice call (OpenAI Realtime over WebRTC) -----------------------------------------------------------
interface LiveAsk { sdp: string; session: Record<string, unknown> }

/** Session settings that newer or older realtime models may refuse: tried in this order, simplest last. */
export function liveSessionLadder(session: Record<string, unknown>): Record<string, unknown>[] {
  const audio = (session.audio ?? {}) as { input?: Record<string, unknown>; output?: Record<string, unknown> };
  const noExtras = { ...session, audio: { input: { turn_detection: (audio.input ?? {}).turn_detection }, output: { voice: (audio.output ?? {}).voice } } };
  const minimal = { type: session.type, model: session.model, instructions: session.instructions, tools: session.tools, audio: { output: { voice: (audio.output ?? {}).voice } } };
  return [session, noExtras, minimal];
}

/** live models tried in this order when the chosen one is not available for the key */
export function liveModels(chosen: string): string[] {
  return [...new Set([chosen, 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-realtime-2', 'gpt-realtime'])];
}

export async function liveConnect(a: LiveAsk): Promise<{ sdp: string; level: number; model: string }> {
  const keys = await getKeys();
  if (!keys.openai) throw Object.assign(new Error('The live voice call needs an OpenAI API key (Dream Tutor settings).'), { status: 401 });
  const s = await getSettings();
  const monthly = usdSince(await getUsage(), periodStarts().month);
  if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) throw new Error(`Monthly AI budget of $${s.ai.monthlyStopUsd} reached. Raise it in the Dream Tutor settings to talk again.`);
  const base = (await baseUrls()).openai ?? 'https://api.openai.com/v1';
  let last = '';
  for (const model of liveModels(String(a.session.model))) {
    const ladder = liveSessionLadder({ ...a.session, model });
    let modelMissing = false;
    for (let level = 0; level < ladder.length; level++) {
      const form = new FormData();
      form.set('sdp', a.sdp);
      form.set('session', JSON.stringify(ladder[level]));
      const res = await fetch(`${base}/realtime/calls`, { method: 'POST', headers: { Authorization: `Bearer ${keys.openai}` }, body: form });
      if (res.ok) return { sdp: await res.text(), level, model };
      last = (await res.text()).slice(0, 300);
      // this model is not there for the key: the next model
      if (res.status === 404 || ((res.status === 400 || res.status === 403) && /model/i.test(last) && /not (found|exist|available|have access)|does not exist|access/i.test(last))) { modelMissing = true; break; }
      // a setting this model does not take: try the simpler session; anything else is final
      if (res.status !== 400 && res.status !== 422) {
        const msg = res.status === 401 ? 'OpenAI rejected the API key. Check it in the Dream Tutor settings.'
          : res.status === 429 ? (/quota|billing|credit/i.test(last) ? 'Your OpenAI account has no credit left or reached its limit.' : 'Too many requests to OpenAI right now; try again in a moment.')
          : `The live voice did not connect (HTTP ${res.status}): ${last}`;
        throw Object.assign(new Error(msg), { status: res.status });
      }
    }
    if (!modelMissing) break;
  }
  throw Object.assign(new Error(`The live voice did not connect: ${last || 'no live model is available for this key'}. You can call Claude instead (⚙ → Voice call → Claude).`), { status: 400 });
}

async function recordLive(a: { model: string; usage: RealtimeUsage }): Promise<{ usd: number; monthlyUsd: number }> {
  const usd = realtimeUsd(a.model, a.usage);
  await addUsage({ date: new Date().toISOString(), provider: 'openai', model: a.model, inputTokens: a.usage.input_tokens ?? 0, outputTokens: a.usage.output_tokens ?? 0, cachedTokens: a.usage.input_token_details?.cached_tokens ?? 0, usd });
  return { usd, monthlyUsd: usdSince(await getUsage(), periodStarts().month) };
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
    port.onMessage.addListener((msg: { type: string; req?: ExplainRequest; prompt?: PromptBundle; stream?: boolean }) => {
      if (msg?.type === 'explain' && msg.req) {
        runExplain(msg.req, ctrl.signal, (t) => post({ type: 'delta', text: t }))
          .then((r) => post({ type: 'done', text: r.text, usage: r.usage }))
          .catch((e: Error & { code?: string }) => post({ type: 'error', message: e.message, code: e.code ?? 'other' }));
      } else if (msg?.type === 'complete' && msg.prompt) {
        runCompletion(msg.prompt, ctrl.signal, msg.stream ? (t) => post({ type: 'delta', text: t }) : undefined)
          .then((r) => post({ type: 'done', text: r.text, usd: r.usd }))
          .catch((e: Error & { code?: string }) => post({ type: 'error', message: e.message, code: e.code ?? 'other' }));
      }
    });
  });
  chrome.runtime.onMessage.addListener((msg: { type?: string; provider?: AiProviderId }, _sender, sendResponse) => {
    if (msg?.type === 'dream-test-key' && msg.provider) { void testKey(msg.provider).then(sendResponse); return true; }
    if (msg?.type === 'dream-tts') { void synthesize(msg as unknown as TtsAsk).then(sendResponse, (e: Error) => sendResponse({ error: e.message })); return true; }
    if (msg?.type === 'dream-live-sdp') { void liveConnect(msg as unknown as LiveAsk).then(sendResponse, (e: Error & { status?: number }) => sendResponse({ error: e.message, status: e.status })); return true; }
    if (msg?.type === 'dream-usage') { void recordLive(msg as unknown as { model: string; usage: RealtimeUsage }).then(sendResponse, () => sendResponse(null)); return true; }
    if (msg?.type === 'dream-open' && (msg as { page?: string }).page) { void chrome.tabs.create({ url: chrome.runtime.getURL(`dream/${(msg as { page: string }).page}.html`) }); return false; }
    return false;
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) installDreamBackground();
