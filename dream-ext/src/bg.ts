/**
 * Background (service worker) half of the Dream Tutor: AI explanations and background jobs with the learner's
 * own API key. Same request shape, refusal fallback, cost meter and error messages as Dream Read's
 * src/main/ai.ts; the official SDKs run here (browser mode), so the key never reaches the YouTube page.
 *
 * Content scripts talk to it over a port named 'dream-ai':
 *   -> { type: 'explain', req }                       <- { type: 'delta', text } ... { type: 'done', text, usage } | { type: 'error', message, code }
 *   -> { type: 'complete', prompt, stream? }          <- ({ type: 'delta', text } ...) { type: 'done', text } | { type: 'error', ... }   (hints model)
 * Closing the port cancels the request.
 * One-off messages: 'dream-tts' (a sentence in the Microsoft / OpenAI / ElevenLabs / Speechify voice: { engine, text, voice, lang,
 * light?, fast? } -> { b64, mime, timings } | { error, code? }; code 'busy' = Microsoft's free limit is full for the
 * moment, the page says the sentence with the device voice), 'dream-live-sdp' (connects the live
 * voice call: the page's WebRTC offer goes to OpenAI's /v1/realtime/calls with the key, the answer comes back),
 * 'dream-usage' (the live call's cost), 'dream-test-key', 'dream-open'; the Speechify voice (through the learner's own
 * Worker, speech-proxy/): 'dream-speechify-voices', 'dream-speechify-usage', 'dream-speechify-test'.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ExplainRequest, AiErrorCode } from '@shared/api';
import { buildPrompt, buildStyledPrompt, type PromptBundle } from '@core/ai/prompts';
import { resolveStyle, type StyleId } from '@shared/styles';
import type { AiProviderId, Settings } from '@shared/settings';
import { getSettings, getKeys, getExtras, patchExtras, addUsage, getUsage, usdSince, periodStarts, getSpeechifyUsage, stopSpeechifyUntil, getSpeechifyServer, setSpeechifyServer, SPEECHIFY_MODEL, type Keys } from './store';
import { PART_PROMPT, ALWAYS_RULES } from './teacher-text';
import { isWay } from './teaching-ways';
import { installVocabSync, loadOnline, saveOnline } from './vocab-sync';
import { installLevelDb, writeDatabase, syncGist, currentDoc, NATIVE_HOST } from './level-db-bg';
import { levelSummary } from './level-db';
import { buildRulePrompt, partPromptFor, BOOK_ALWAYS_RULES, type RuleRequest } from './level-rule';
import { splitByScript } from '@core/listen/script';
import { getLevel, updateLevel } from './store';
import { getSound, putSound, CACHE_MAX_CHARS, AZURE_BUSY, SPEECHIFY_LIMIT, SPEECHIFY_LIMIT_STEADY } from './tts-cache';
import { voiceLog } from './voice-log';
import { wordsFromAlignment, type Alignment } from './word-times';
import { findLyrics } from './lyrics';

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

/**
 * Chrome stops an idle extension worker after 30 seconds, even while it waits for the AI (thinking, no words yet) or
 * for a voice: the page then sees "The extension stopped". While any job runs, a cheap extension call keeps it awake.
 */
let busyJobs = 0;
let awake: ReturnType<typeof setInterval> | null = null;
export function keepAwake<T>(job: Promise<T>): Promise<T> {
  busyJobs++;
  if (!awake && typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) awake = setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => undefined); }, 20_000);
  const done = () => { busyJobs--; if (busyJobs <= 0 && awake) { clearInterval(awake); awake = null; busyJobs = 0; } };
  job.then(done, done);
  return job;
}

/** The chosen provider, or the other one when only its key is saved (one key is enough to start). */
export function pickProvider(s: Settings, keys: Keys): { provider: AiProviderId; model: string } {
  const want = s.ai.provider;
  const other: AiProviderId = want === 'anthropic' ? 'openai' : 'anthropic';
  const provider = keys[want] || !keys[other] ? want : other;
  return { provider, model: provider === 'anthropic' ? s.ai.anthropicModel : s.ai.openaiModel };
}

/**
 * The learner's own teacher instructions go into the system prompt (cached with it). `book`: the request comes from
 * I Know Book (RuleRequest.fromBook): the rules that are always there speak of the book, not of a video.
 */
async function withTeacher(prompt: PromptBundle, styleId?: string, book = false): Promise<PromptBundle> {
  const t = (await getExtras()).teacher?.trim();
  const always = book ? BOOK_ALWAYS_RULES : ALWAYS_RULES;
  if (!t) return { ...prompt, system: `${prompt.system}\n\n${always}` };
  // one of the seven teaching ways (other than the learner's own Picture It) decides the steps; the rules keep the tone
  const way = isWay(styleId) && styleId !== 'way-picture'
    ? '\nThe learner chose a different teaching way for this explanation. Where these instructions and the teaching way in the task disagree about the steps, follow the teaching way in the task; keep everything else.'
    : '';
  return { ...prompt, system: `${prompt.system}\n\nThe learner's own instructions for you, their teacher. Follow them in every answer:\n${t}${way}\n\n${always}` };
}

/**
 * Claude Haiku 5.5 thinks before it answers unless it is told not to (adaptive thinking is on by default, and the
 * first word waits for it). For the short answers of the tutor it is turned off, which that model takes at effort
 * low / medium / high. NOT for Opus 5.5, Sonnet 5.5 or Fable: there `thinking: disabled` is refused (HTTP 400).
 */
export const thinkingOff = (model: string): boolean => /^claude-haiku-5/.test(model);
/** tokens over the answer's own length when the model does not think (the prompt keeps the length; this is only a stop) */
const NO_THINKING_ROOM = 200;

/** The request of one answer (an explanation, a meaning, the analysis of a part): streamAnthropic sends exactly this. */
export function anthropicParams(model: string, prompt: PromptBundle) {
  const off = thinkingOff(model);
  return {
    model,
    // (+ room for the model's own thinking: the prompt keeps the answer's length; a tight limit can leave it empty.
    // A model that does not think needs no such room, only a small margin)
    max_tokens: prompt.maxTokens + (off ? NO_THINKING_ROOM : 1000),
    system: [{ type: 'text' as const, text: prompt.system, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user' as const, content: prompt.user }],
    output_config: { effort: 'low' as const },
    ...(off ? { thinking: { type: 'disabled' as const } } : {}),
  };
}

async function streamAnthropic(apiKey: string, model: string, prompt: PromptBundle, signal: AbortSignal, onText: (t: string) => void): Promise<StreamResult> {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000, dangerouslyAllowBrowser: true, ...((await baseUrls()).anthropic ? { baseURL: (await baseUrls()).anthropic } : {}) });
  const params = anthropicParams(model, prompt);
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
  if (!text.trim() && final.stop_reason === 'max_tokens') throw Object.assign(new Error(`The AI used all ${prompt.maxTokens} tokens before answering.`), { code: 'other' });
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
  // (Level Check: always the cheap model)
  const song = (req as RuleRequest).levelRule?.song ?? (req as RuleRequest & { songNotes?: string }).songNotes;
  const cheap = !song && ((req as RuleRequest).levelRule || (req as RuleRequest).levelCheap) ? levelModelFor(s, keys, (await getExtras()).analysisModel) : null;
  const provider = cheap ? cheap.provider : style?.provider && keys[style.provider] ? style.provider : picked.provider;
  const model = cheap ? cheap.model : style?.model && provider === style.provider ? style.model : picked.model;
  const key = keys[provider];
  if (!key) throw noKey(provider);
  const monthly = usdSince(await getUsage(), periodStarts().month);
  if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) throw Object.assign(new Error(`Monthly AI budget of $${s.ai.monthlyStopUsd} reached. Raise it in the Dream Tutor settings to continue.`), { code: 'budget' });
  // (YouTube) "you stopped the video": the part just heard, taught as a whole with the learner's rules
  // (I Know Book, `fromBook`: the part of the book just read / heard, in the book's words: level-rule.ts)
  const partPrompt = part && style ? { ...style, sentencePrompt: partPromptFor(req as RuleRequest & { seconds?: number }, PART_PROMPT), maxTokens: Math.max(style.maxTokens, 900) } : null;
  // (Level Check) the hard rule of the explanations at a stop: it replaces the styles and teacher instructions
  const rule = (req as RuleRequest).levelRule;
  const prompt = rule && styled ? buildRulePrompt(req as RuleRequest) : await withTeacher(style
    ? buildStyledPrompt(partPrompt ? { ...req, kind: 'sentence' } : req, { style: partPrompt ?? style, contextRules: s.ai.contextRules, level: s.learnerLevel, native: 'Chinese' })
    : buildPrompt(req, { level: s.learnerLevel, instructions: s.ai.instructions, length: s.ai.explanationLength }), part ? undefined : style?.id, (req as RuleRequest).fromBook === true);
  // (lyrics mode, Explain N s and questions: the song's context goes with them too)
  if (song && !(rule && styled)) prompt.system = `${prompt.system}\n\nThis is a SONG. Explain it like a music teacher who knows this song well: what the lines mean in the song, the images, slang, references and feelings, and how listeners understand them. What is known about the song:\n${song}`;
  try {
    const r = provider === 'anthropic' ? await streamAnthropic(key, model, prompt, signal, onDelta) : await streamOpenAI(key, model, prompt, signal, onDelta);
    const u = await record(provider, model, r);
    return { text: r.text, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedTokens: r.cachedTokens, ...u, model } };
  } catch (e) { throw Object.assign(new Error(classifyError(e, { model }).message), { code: classifyError(e, { model }).code }); }
}

/** A background job (Chinese hints, phrases) with the cheap hints model; nothing streamed. */
/** Level Check: the one analysis, and what the learner asks for beside it, use the cheap model (or the one chosen). */
function levelModelFor(s: Settings, keys: Keys, chosen?: string): { provider: AiProviderId; model: string } {
  const picked = pickProvider(s, keys);
  const hints = s.ai.hintsModel?.trim();
  if (picked.provider === 'anthropic') return { provider: 'anthropic', model: chosen?.startsWith('claude') ? chosen : hints?.startsWith('claude') ? hints : DEFAULT_ANTHROPIC_HINTS_MODEL };
  return { provider: picked.provider, model: chosen && !chosen.startsWith('claude') ? chosen : hints && !hints.startsWith('claude') ? hints : picked.model };
}

export async function runCompletion(prompt: PromptBundle, signal: AbortSignal, onDelta?: (t: string) => void, analysis = false): Promise<{ text: string; usd: number }> {
  const s = await getSettings();
  const keys = await getKeys();
  const picked = pickProvider(s, keys);
  const { provider, model } = analysis ? levelModelFor(s, keys, (await getExtras()).analysisModel) : picked.provider === s.ai.provider ? hintsModelFor(s) : { provider: picked.provider, model: picked.provider === 'anthropic' ? DEFAULT_ANTHROPIC_HINTS_MODEL : s.ai.openaiModel };
  const key = keys[provider];
  if (!key) throw noKey(provider);
  const monthly = usdSince(await getUsage(), periodStarts().month);
  if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) throw Object.assign(new Error('Monthly AI budget reached.'), { code: 'budget' });
  try {
    const onText = onDelta ?? ((): void => undefined);
    // background jobs: room for the model's own thinking (a tight limit can leave the answer empty; only what is
    // written is paid for). The floor stays for a model that does not think too: it is only a stop, and the jobs'
    // own limits were chosen with it there
    const roomy = { ...prompt, maxTokens: Math.max(prompt.maxTokens, 1500) };
    const r = provider === 'anthropic' ? await streamAnthropic(key, model, roomy, signal, onText) : await streamOpenAI(key, model, roomy, signal, onText);
    const u = await record(provider, model, r);
    return { text: r.text, usd: u.usd };
  } catch (e) { const c = classifyError(e, { model }); throw Object.assign(new Error(c.message), { code: c.code }); }
}

// ---- the voice call without OpenAI: the learner's words (speech recognition) go to Claude, a voice reads the answer --
export interface ChatTurn { role: 'user' | 'assistant'; content: string }

/** One turn of the tutor's phone call: the whole conversation so far, streamed back sentence by sentence. */
export async function runChat(system: string, messages: ChatTurn[], signal: AbortSignal, onDelta: (t: string) => void): Promise<{ text: string; usd: number }> {
  const s = await getSettings();
  const keys = await getKeys();
  const picked = pickProvider(s, keys);
  // a phone call wants fast, short answers: the fast, cheap model (Haiku), not the one for the long explanations
  const provider = picked.provider;
  const model = provider === 'anthropic' ? (s.ai.hintsModel?.trim() || DEFAULT_ANTHROPIC_HINTS_MODEL) : picked.model;
  const key = keys[provider];
  if (!key) throw noKey(provider);
  const monthly = usdSince(await getUsage(), periodStarts().month);
  if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) throw Object.assign(new Error('Monthly AI budget reached.'), { code: 'budget' });
  const turns = messages.filter((m) => m.content.trim()).slice(-10);
  while (turns.length && turns[0].role !== 'user') turns.shift(); // the conversation starts with the learner
  try {
    let r: StreamResult;
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 60_000, dangerouslyAllowBrowser: true, ...((await baseUrls()).anthropic ? { baseURL: (await baseUrls()).anthropic } : {}) });
      // (room for the model's own thinking: a tight limit can leave the answer empty; the rules keep answers short)
      const stream = client.messages.stream({ model, max_tokens: 2000, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages: turns, output_config: { effort: 'low' } } as never, { signal });
      stream.on('text', (t: string) => onDelta(t));
      const fin = await stream.finalMessage();
      if (fin.stop_reason === 'refusal') throw Object.assign(new Error('The AI declined to answer this request.'), { code: 'other' });
      const u = fin.usage;
      r = { text: fin.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join(''), inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, cachedTokens: u.cache_read_input_tokens ?? 0 };
    } else {
      const client = new OpenAI({ apiKey: key, maxRetries: 1, timeout: 60_000, dangerouslyAllowBrowser: true, ...((await baseUrls()).openai ? { baseURL: (await baseUrls()).openai } : {}) });
      const stream = await client.chat.completions.create({ model, messages: [{ role: 'system', content: system }, ...turns], stream: true, stream_options: { include_usage: true }, max_completion_tokens: 2000, ...(/^(gpt-5|o[1-9])/.test(model) ? { reasoning_effort: 'low' as const } : {}) }, { signal });
      let text = ''; let usage = { prompt_tokens: 0, completion_tokens: 0, cached: 0 };
      for await (const chunk of stream) {
        const d = chunk.choices?.[0]?.delta?.content;
        if (d) { text += d; onDelta(d); }
        if (chunk.usage) usage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens, cached: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0 };
      }
      r = { text, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, cachedTokens: usage.cached };
    }
    const u = await record(provider, model, r);
    return { text: r.text, usd: u.usd };
  } catch (e) { const c = classifyError(e, { model }); throw Object.assign(new Error(c.message), { code: c.code }); }
}

// ---- the tutor's voice: OpenAI (gpt-4o-mini-tts) or ElevenLabs, one sentence at a time --------------------------
/** `light`: Microsoft's smaller sound (AZURE_LIGHT); `fast`: ElevenLabs' fast model whatever the quality setting (voice.ts CloudOptions) */
/** `steady` (I Know 3.13): the Speechify voice that never hands a sentence to another voice: a longer wait, quiet new tries (speechifySteady) */
interface TtsAsk { engine: 'openai' | 'elevenlabs' | 'azure' | 'speechify'; text: string; voice: string; lang?: 'en' | 'zh'; light?: boolean; fast?: boolean; steady?: boolean }
interface TtsAnswer { b64: string; mime: string; timings: { start: number; end: number; charIndex: number; charLength: number }[] | null }

const VOICE_STYLE = {
  en: 'Speak clear, warm, natural English at a calm teaching pace, like a kind English teacher talking to a student. Say any Chinese words in natural Mandarin Chinese.',
  zh: 'Speak Mandarin Chinese (Putonghua) clearly and warmly, at a calm pace.',
};

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * The SSML for one Microsoft (Azure) request: the multilingual voice says English, and the Chinese in it in Mandarin
 * (<lang xml:lang="zh-CN">). `langTags` false = plain text (a voice that does not take <lang>).
 */
export function azureSsml(text: string, voice: string, lang: 'en' | 'zh' = 'en', langTags = /Multilingual/i.test(voice)): string {
  const locale = /^[a-z]{2}-[A-Z]{2}/.exec(voice)?.[0] ?? 'en-US';
  const zh = (t: string) => (langTags ? `<lang xml:lang="zh-CN">${xmlEsc(t)}</lang>` : xmlEsc(t));
  const body = lang === 'zh' ? zh(text) : splitByScript(text).map((r) => (r.zh ? zh(r.text) : xmlEsc(r.text))).join('');
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}"><voice name="${xmlEsc(voice)}">${body}</voice></speak>`;
}

/**
 * Azure's free plan (F0) takes 20 voice requests a minute: the requests wait their turn instead of failing.
 * `maxWaitMs`: a request that would wait longer than this for its turn is refused at once (an error with `code`
 * 'busy' and the message AZURE_BUSY) and takes no turn: the page says that sentence with the device voice.
 */
const azureSent: number[] = []; // when each request of the last minute went, and when the waiting ones will go
export const AZURE_PER_MINUTE = 19;
/** a sentence is due now: it waits this long for its turn at most (the voice path; azureTurn() itself waits as long as it takes) */
export const AZURE_MAX_WAIT_MS = 1500;
export function azureTurn(maxWaitMs = Infinity): Promise<void> {
  const now = Date.now();
  while (azureSent.length && now - azureSent[0] >= 60_000) azureSent.shift();
  // my turn: now, or when the request 19 before me is a minute old
  const at = azureSent.length < AZURE_PER_MINUTE ? now : Math.max(now, azureSent[azureSent.length - AZURE_PER_MINUTE] + 60_050);
  if (at - now > maxWaitMs) return Promise.reject(Object.assign(new Error(AZURE_BUSY), { code: 'busy' }));
  azureSent.push(at);
  return at <= now ? Promise.resolve() : new Promise((r) => setTimeout(r, at - now));
}
/** (tests) */
export function resetAzureTurns(): void { azureSent.length = 0; }

/** the sound Microsoft is asked for: the full one, and the light one (24 kHz, a quarter of the bytes: `light`) */
export const AZURE_FULL = 'audio-48khz-192kbitrate-mono-mp3', AZURE_LIGHT = 'audio-24khz-96kbitrate-mono-mp3';

/** `maxWaitMs`: see azureTurn; null = no limit of our own (a paid key, extras.azurePaid) */
async function azureSpeak(key: string, base: string, ssml: string, o: { light?: boolean; maxWaitMs?: number | null } = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    if (o.maxWaitMs !== null) await azureTurn(o.maxWaitMs ?? AZURE_MAX_WAIT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}/cognitiveservices/v1`, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': o.light ? AZURE_LIGHT : AZURE_FULL },
        body: ssml,
      });
    } catch {
      // no internet for a moment: try again
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); continue; }
      throw new Error('Microsoft voice: no internet connection');
    }
    // too many requests (or the voice is busy for a moment): wait and try again
    if (res.status === 429 && attempt < 4) { const s = Number(res.headers.get('retry-after')) || 2; await new Promise((r) => setTimeout(r, Math.min(10, s) * 1000)); continue; }
    // a busy server: try again
    if (res.status >= 500 && attempt < 2) { await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); continue; }
    return res;
  }
}

function azureBase(region: string, test?: string): string { return test ?? `https://${region || 'eastus'}.tts.speech.microsoft.com`; }

async function azureFail(res: Response): Promise<Error> {
  const body = (await res.text().catch(() => '')).slice(0, 160);
  if (res.status === 401) return new Error('Microsoft rejected the key. Check the key and the region (for example eastus) in ⚙ → API keys.');
  if (res.status === 403 && /quota/i.test(body)) return new Error('Your free Microsoft voice time for this month is used up (500,000 characters). It starts again next month.');
  if (res.status === 404) return new Error('Microsoft voice: the region looks wrong. Copy the "Location/Region" from your Azure Speech resource (for example eastus).');
  return new Error(`Microsoft voice: HTTP ${res.status} ${body}`);
}

/** the regions an Azure Speech resource can be in (the usual ones first) */
export const AZURE_REGIONS = ['eastus', 'eastus2', 'westus', 'westus2', 'westus3', 'centralus', 'northcentralus', 'southcentralus', 'westcentralus', 'canadacentral', 'canadaeast', 'brazilsouth',
  'westeurope', 'northeurope', 'uksouth', 'ukwest', 'francecentral', 'germanywestcentral', 'switzerlandnorth', 'switzerlandwest', 'norwayeast', 'swedencentral', 'italynorth',
  'southeastasia', 'eastasia', 'japaneast', 'japanwest', 'koreacentral', 'australiaeast', 'centralindia', 'southindia', 'westindia', 'jioindiawest', 'uaenorth', 'qatarcentral', 'southafricanorth'];
/**
 * The region a key belongs to: every other region is asked for its voice list with the key (free, a few at a time);
 * the one that answers is it. null = no region takes this key (it is not a Speech key, or it was deleted).
 */
export async function findAzureRegion(works: (region: string) => Promise<boolean>, skip = '', regions: readonly string[] = AZURE_REGIONS, atOnce = 6): Promise<string | null> {
  const list = regions.filter((r) => r !== skip);
  for (let i = 0; i < list.length; i += atOnce) {
    const part = list.slice(i, i + atOnce);
    const ok = await Promise.all(part.map((r) => works(r).catch(() => false)));
    const at = ok.indexOf(true);
    if (at >= 0) return part[at];
  }
  return null;
}

/**
 * The key and region work (the voice list costs nothing); `key` = a key not saved yet (is this a Microsoft key?).
 * A key the saved region does not take is tried in the other regions: the right one is saved by itself.
 */
export async function testAzure(key?: string): Promise<{ ok: boolean; message: string }> {
  const k = (key ?? (await getKeys()).azure ?? '').trim();
  if (!k) return { ok: false, message: 'No Microsoft key is saved yet.' };
  const region = (await getExtras()).azureRegion || 'eastus';
  const test = (await baseUrls()).azure;
  const list = (r: string) => fetch(`${azureBase(r, test)}/cognitiveservices/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': k } });
  const keep = async (res: Response, r: string, found: boolean): Promise<{ ok: boolean; message: string }> => {
    const voices = (await res.json()) as { ShortName?: string }[];
    // the voices this region really has (the list in ⚙ shows only these)
    await chrome.storage.local.set({ drAzureVoices: voices.map((v) => v.ShortName ?? '').filter(Boolean) }).catch(() => undefined);
    return { ok: true, message: found ? `The Microsoft voice works. Your key's region is ${r}: it is saved now (${voices.length} voices).` : `The Microsoft voice works (${voices.length} voices, region ${r}).` };
  };
  let first: Response | null = null;
  let why = '';
  try { first = await list(region); } catch (e) { why = (e as Error).message; }
  if (first?.ok) return keep(first, region, false);
  // (the free time used up, or too many requests: the key and region are right)
  if (first && first.status !== 401 && first.status !== 404) return { ok: false, message: (await azureFail(first)).message };
  // (the test server has one address for every region: nothing to look for)
  // (only for the key saved as the Microsoft key: a key that is only being tried goes to one region, no further)
  if (key === undefined && (!test || (globalThis as { __ytcFindRegion?: boolean }).__ytcFindRegion)) {
    let hit: Response | null = null;
    const r = await findAzureRegion(async (rg) => { const res = await list(rg); if (res.ok && !hit) hit = res; return res.ok; }, region);
    if (r && hit) {
      // (only a saved key moves the saved region; a key being tried is saved by the caller, then tested again)
      await patchExtras({ azureRegion: r });
      return keep(hit, r, true);
    }
  }
  if (first) return { ok: false, message: first.status === 401 ? 'Microsoft does not take this key in any region. Copy "KEY 1" again from your Speech resource in the Azure portal (Keys and Endpoint), paste it and press Save.' : (await azureFail(first)).message };
  return { ok: false, message: `Microsoft voice: ${why || 'no answer'}. Check the internet connection.` };
}

/** A short text (a word, a phrase) the voice said before is played again from this computer: no new characters. */
export async function synthesize(a: TtsAsk): Promise<TtsAnswer> {
  const text = a.text.trim();
  if (!text) return { b64: '', mime: 'audio/mpeg', timings: [] };
  // Speechify: EVERY clip is kept (any length), so the same text is never paid twice on this device
  if (a.engine === 'speechify') return speechifyCached(a, text);
  if (text.length > CACHE_MAX_CHARS || typeof indexedDB === 'undefined') return synthesizeNow(a);
  const key = soundKey(a, text, a.engine === 'elevenlabs' ? (await getExtras()).elevenQuality : 'best');
  // (the light sound is asked for: the full one kept from before does as well, and costs nothing)
  const kept = await getSound(key) ?? (a.engine === 'azure' && a.light ? await getSound(soundKey({ ...a, light: false }, text, 'best')) : null);
  if (kept) return kept;
  const made = await synthesizeNow(a);
  if (made.b64) void putSound(key, made);
  return made;
}

/** ElevenLabs: the model of a request ('best' = Multilingual v2, the most natural; `fast` or the 'fast' setting = Flash v2.5) */
export const elevenModel = (a: { fast?: boolean }, quality: 'best' | 'fast' | undefined): 'eleven_multilingual_v2' | 'eleven_flash_v2_5' => (a.fast || quality === 'fast' ? 'eleven_flash_v2_5' : 'eleven_multilingual_v2');
/** the name a short sound is kept under: the service, the voice, the language, the kind of sound, the text */
export function soundKey(a: Pick<TtsAsk, 'engine' | 'voice' | 'lang' | 'light' | 'fast'>, text: string, quality: 'best' | 'fast' | undefined): string {
  const kind = a.engine === 'azure' ? (a.light ? 'light' : 'best') : a.engine === 'elevenlabs' && elevenModel(a, quality) === 'eleven_flash_v2_5' ? 'fast' : 'best';
  return `${a.engine}|${a.voice}|${a.lang ?? 'en'}|${kind}|${text}`;
}
/** The body of one ElevenLabs request: the model by name, a warm and steady delivery. */
export function elevenBody(text: string, model: string): { text: string; model_id: string; voice_settings: { stability: number; similarity_boost: number; style: number; use_speaker_boost: boolean } } {
  return { text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true } };
}

async function synthesizeNow(a: TtsAsk): Promise<TtsAnswer> {
  if (a.engine === 'speechify') return speechifySay(a);
  const keys = await getKeys();
  const text = a.text.trim();
  if (!text) return { b64: '', mime: 'audio/mpeg', timings: [] };
  const urls = await baseUrls();
  if (a.engine === 'azure') {
    if (!keys.azure) throw new Error('Add your Microsoft (Azure Speech) key in ⚙ → API keys to use the Microsoft voice.');
    const x = await getExtras();
    const base = azureBase(x.azureRegion, urls.azure);
    const voice = a.voice || 'en-GB-AdaMultilingualNeural';
    // (a free key: at most 19 requests a minute, and no sentence waits long for its turn; a paid key has no such limit)
    const how = { light: a.light, maxWaitMs: x.azurePaid ? null : AZURE_MAX_WAIT_MS };
    let res = await azureSpeak(keys.azure, base, azureSsml(text, voice, a.lang), how);
    // a voice that does not take <lang> (not multilingual): the plain text
    if (res.status === 400 && /[\u3400-\u9FFF]/.test(text)) res = await azureSpeak(keys.azure, base, azureSsml(text, voice, a.lang, false), how);
    if (!res.ok) throw await azureFail(res);
    const audio = await res.arrayBuffer();
    // free up to 500,000 characters a month (F0); after that $15 per million (a Standard resource)
    void addUsage({ date: new Date().toISOString(), provider: 'openai', model: 'azure-neural', inputTokens: text.length, outputTokens: 0, cachedTokens: 0, usd: 0 }).catch(() => undefined);
    return { b64: toBase64(audio), mime: 'audio/mpeg', timings: null };
  }
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
  if (!keys.elevenlabs) throw new Error('Add your ElevenLabs API key (Dream Tutor settings) to use the ElevenLabs voice.');
  const base = urls.elevenlabs ?? 'https://api.elevenlabs.io';
  // the most natural model by default (or the fast, cheaper one: the setting, or a page that asks for it), full
  // quality sound, a warm and steady delivery. The sound comes with the time of every letter (with-timestamps).
  const model = elevenModel(a, (await getExtras()).elevenQuality);
  const best = model !== 'eleven_flash_v2_5';
  const res = await fetch(`${base}/v1/text-to-speech/${encodeURIComponent(a.voice || 'JBFqnCBsd6RMkjVDRZzb')}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': keys.elevenlabs, 'content-type': 'application/json' },
    body: JSON.stringify(elevenBody(text, model)),
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'ElevenLabs rejected the key. Check it in the Dream Tutor settings.' : `ElevenLabs voice: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const data = (await res.json()) as { audio_base64: string; alignment?: Alignment | null };
  void addUsage({ date: new Date().toISOString(), provider: 'openai', model: best ? 'elevenlabs-multilingual-v2' : 'elevenlabs-flash', inputTokens: text.length, outputTokens: 0, cachedTokens: 0, usd: text.length * (best ? 0.0001 : 0.00005) }).catch(() => undefined);
  return { b64: data.audio_base64, mime: 'audio/mpeg', timings: data.alignment ? alignmentTimings(text, data.alignment) : null };
}

// ---- the Speechify voice: through the learner's own speech proxy (speech-proxy/, a Cloudflare Worker) ---------------
// The Speechify key lives only in the Worker. The app sends the Worker's address (extras.speechifyUrl) and the app code
// (Keys.speechify, in the iPhone Keychain with the other keys) in X-App-Code. Errors carry `code` 'busy' and a short
// `note`: the page's voice (voice.ts VoiceWithBackup) then says that sentence with the iPhone voice at once.

/** an error of the Speechify voice: the sentence goes to the device voice at once (code 'busy'), the learner is told `note` once */
export function speechifyError(message: string, why: 'setup' | 'limit' | 'failed' = 'failed'): Error & { code: 'busy'; note: string; why: string } {
  const note = why === 'limit' ? SPEECHIFY_LIMIT : `Speechify voice: ${message} The iPhone voice reads instead.`;
  return Object.assign(new Error(why === 'limit' ? SPEECHIFY_LIMIT : `Speechify voice: ${message}`), { code: 'busy' as const, note, why });
}

/** the Worker's address and the app code, or an error that says what is missing */
async function speechifyAccess(): Promise<{ url: string; code: string }> {
  const url = ((await getExtras()).speechifyUrl ?? '').trim().replace(/\/+$/, '');
  const code = ((await getKeys()).speechify ?? '').trim();
  if (!url || !code) throw speechifyError(`${!url ? 'the Worker address' : 'the app code'} is missing in Settings.`, 'setup');
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)) throw speechifyError('the Worker address must start with https://', 'setup');
  return { url, code };
}

/** one request to the Worker (20 s at most; /speak: SPEECHIFY_SPEAK_TIMEOUT_MS) */
async function workerFetch(path: string, init: { method?: string; body?: unknown } = {}, timeoutMs = 20_000): Promise<Response> {
  const { url, code } = await speechifyAccess();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${url}${path}`, {
      method: init.method ?? 'GET', signal: ctrl.signal,
      headers: { 'X-App-Code': code, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (e) {
    const why = ctrl.signal.aborted ? 'the Worker did not answer in time.' : `the Worker could not be reached (${(e as Error).message || 'no internet'}).`;
    throw Object.assign(speechifyError(why), { down: why });
  } finally { clearTimeout(timer); }
}

async function workerProblem(res: Response): Promise<Error> {
  let j: { error?: string; code?: string; resetAt?: string } = {};
  try { j = (await res.json()) as typeof j; } catch { /* not JSON */ }
  // (the Worker's own count, both apps together: no Speechify until its day starts again, at resetAt)
  if (res.status === 429 && j.code === 'daily-limit') { await stopSpeechifyUntil(j.resetAt).catch(() => undefined); return speechifyError(SPEECHIFY_LIMIT, 'limit'); }
  if (res.status === 401) return speechifyError('the Worker did not accept the app code (check it in Settings).', 'setup');
  if (res.status === 403) return speechifyError('the Worker refused this page (ALLOWED_ORIGINS in wrangler.toml).', 'setup');
  if (res.status === 500 && j.code === 'not-set-up') return speechifyError(`${j.error ?? 'the Worker is not set up yet'}.`, 'setup');
  return speechifyError(`${j.error ?? `the Worker answered HTTP ${res.status}`}.`);
}

/** test hook: every text sent to the Worker (what was paid for), newest last */
export const speechifySent: string[] = [];

/** what one paid Speechify character costs (USD, Starter plan list price): simba-3.5 $15 per million, older models $10 */
const speechifyUsd = (chars: number, model: string): number => chars * (/simba-3\.5/.test(model) ? 15e-6 : 10e-6);

/** a sentence waits this long for the Worker at most; then the device voice says it (one try only) */
export const SPEECHIFY_SPEAK_TIMEOUT_MS = 6_000;
/** after the Worker did not answer (too slow, no internet): the device voice for this long, no request (ms) */
export const SPEECHIFY_QUIET_MS = 60_000;
let speechifyQuietUntil = 0;
/** why (the same words, so the learner is told only once) */
let speechifyQuietWhy = '';
/** (tests) */
export function resetSpeechifyQuiet(): void { speechifyQuietUntil = 0; speechifyDown = false; }

// ---- the steady Speechify voice (I Know 3.13, step 1): no other voice ever takes over ---------------------------------
// Measured on the learner's Worker (28 Nov 2026): a new sentence takes 3 to 5 s, sometimes 7. The old rule (6 s, one
// try, then the iPhone voice for a minute) therefore changed the voice again and again. Now a sentence waits longer
// and is tried again quietly; when every try failed it is simply not spoken (the page says why, once), and every try
// that failed is written to the voice log with its reason.
/** one try waits this long for the Worker */
export const SPEECHIFY_STEADY_TIMEOUT_MS = 12_000;
/** a sentence is tried this many times */
export const SPEECHIFY_STEADY_TRIES = 3;
/** the waits before the second and the third try (ms) */
export const SPEECHIFY_STEADY_WAITS: readonly number[] = [400, 1200];
/** after a sentence that failed every try: each next one gets ONE short try, until the Worker answers again */
export const SPEECHIFY_DOWN_TIMEOUT_MS = 6_000;
let speechifyDown = false;
/** (tests) the waits between the tries can be made short */
export const speechifyTest: { waits: readonly number[] | null; timeoutMs: number | null } = { waits: null, timeoutMs: null };

/** the error of the steady voice: `code` 'silent' = the sentence is not spoken (no other voice says it); `note` = what the learner is told */
export function speechifySilent(e: unknown): Error & { code: 'silent'; note: string; why: string } {
  const x = e as Error & { why?: string };
  const why = x?.why === 'limit' ? 'limit' : x?.why === 'setup' ? 'setup' : 'failed';
  const message = why === 'limit' ? SPEECHIFY_LIMIT_STEADY : (x?.message || 'Speechify voice: no answer.');
  const note = why === 'limit' ? SPEECHIFY_LIMIT_STEADY : `${message} This sentence was not spoken.`;
  return Object.assign(new Error(message), { code: 'silent' as const, note, why });
}

/** the Worker's answer to /speak as a clip; the characters billed are counted on this device */
async function speechifyClip(res: Response, text: string): Promise<TtsAnswer & { version?: string }> {
  let j: { audio?: string; mime?: string; chars?: number; cached?: boolean; model?: string; version?: string; marks?: TtsAnswer['timings'] };
  try { j = (await res.json()) as typeof j; } catch { throw speechifyError('the Worker sent something that is not a clip.'); }
  if (!j.audio) throw speechifyError('the Worker sent no sound.');
  // (a clip the Worker had kept costs nothing: 0 characters)
  const billed = j.cached ? 0 : Math.max(0, Math.round(typeof j.chars === 'number' ? j.chars : text.length));
  if (billed > 0) await addUsage({ date: new Date().toISOString(), provider: 'openai', model: SPEECHIFY_MODEL, inputTokens: billed, outputTokens: 0, cachedTokens: 0, usd: speechifyUsd(billed, j.model ?? '') }).catch(() => undefined);
  return { b64: j.audio, mime: j.mime ?? 'audio/mpeg', timings: Array.isArray(j.marks) && j.marks.length ? j.marks : null, ...(typeof j.version === 'string' && j.version ? { version: j.version } : {}) };
}

/** one sentence by the steady voice: up to SPEECHIFY_STEADY_TRIES tries; what cannot work (no setup, today's limit) is not tried again */
async function speechifySteady(a: TtsAsk): Promise<TtsAnswer & { version?: string }> {
  const text = a.text.trim();
  const t0 = Date.now();
  let voice = '';
  try {
    await speechifyAccess();
    const u = await getSpeechifyUsage();
    if (u.stopped) throw speechifyError(SPEECHIFY_LIMIT, 'limit');
    if (text.length > u.left) throw speechifyError(`this text is longer than the characters left today (${u.left.toLocaleString('en-US')}).`);
    voice = (a.voice || (await getExtras()).speechifyVoice || '').trim();
  } catch (e) {
    const err = speechifySilent(e);
    voiceLog('not asked', { why: err.message, text });
    throw err;
  }
  speechifySent.push(text);
  if (speechifySent.length > 400) speechifySent.splice(0, 200);
  const wasDown = speechifyDown;
  const tries = wasDown ? 1 : SPEECHIFY_STEADY_TRIES;
  const timeout = speechifyTest.timeoutMs ?? (wasDown ? SPEECHIFY_DOWN_TIMEOUT_MS : SPEECHIFY_STEADY_TIMEOUT_MS);
  const waits = speechifyTest.waits ?? SPEECHIFY_STEADY_WAITS;
  let last: unknown = null;
  let final = false;
  for (let n = 0; n < tries && !final; n++) {
    if (n > 0) await new Promise((r) => setTimeout(r, waits[n - 1] ?? waits[waits.length - 1] ?? 1200));
    const t1 = Date.now();
    try {
      const res = await workerFetch('/speak', { method: 'POST', body: { text, ...(voice ? { voice } : {}), format: 'mp3', lang: a.lang ?? 'en' } }, timeout);
      if (!res.ok) {
        const p = (await workerProblem(res)) as Error & { why?: string };
        // (the app code, the Worker's setup, today's limit: a new try would get the same answer)
        if (p.why === 'setup' || p.why === 'limit') final = true;
        throw p;
      }
      const clip = await speechifyClip(res, text);
      if (wasDown) voiceLog('Speechify answers again', { ms: Date.now() - t0, text });
      else if (n > 0) voiceLog(`worked at try ${n + 1}`, { ms: Date.now() - t0, text });
      else if (Date.now() - t1 > 6000) voiceLog('slow answer', { why: 'the Worker took long for this sentence', ms: Date.now() - t1, text });
      speechifyDown = false;
      return clip;
    } catch (e) {
      last = e;
      // (one short try while the Worker is down: the "not spoken" line below says it all)
      if (tries > 1) voiceLog(`try ${n + 1} of ${tries} failed`, { why: (e as Error).message, ms: Date.now() - t1, text });
    }
  }
  // (the Worker cannot be reached or keeps failing: the next sentences do not each wait three long tries)
  if (!final) speechifyDown = true;
  const err = speechifySilent(last);
  voiceLog('not spoken', { why: err.message, ms: Date.now() - t0, text });
  throw err;
}

/** one sentence / paragraph from the Worker; the characters billed are counted on this device; the daily limit holds */
async function speechifySay(a: TtsAsk): Promise<TtsAnswer & { version?: string }> {
  if (a.steady) return speechifySteady(a);
  const text = a.text.trim();
  await speechifyAccess();
  // (the Worker did not answer a moment ago: the device voice at once, no new wait of seconds per sentence)
  if (Date.now() < speechifyQuietUntil) throw speechifyError(speechifyQuietWhy || 'the Worker did not answer.');
  const u = await getSpeechifyUsage();
  if (u.stopped) throw speechifyError(SPEECHIFY_LIMIT, 'limit');
  // (one text longer than what is left today: only this text goes to the device voice; shorter ones still fit)
  if (text.length > u.left) throw speechifyError(`this text is longer than the characters left today (${u.left.toLocaleString('en-US')}).`);
  const voice = (a.voice || (await getExtras()).speechifyVoice || '').trim();
  speechifySent.push(text);
  if (speechifySent.length > 400) speechifySent.splice(0, 200);
  let res: Response;
  try {
    res = await workerFetch('/speak', { method: 'POST', body: { text, ...(voice ? { voice } : {}), format: 'mp3', lang: a.lang ?? 'en' } }, SPEECHIFY_SPEAK_TIMEOUT_MS);
  } catch (e) {
    const down = (e as { down?: string }).down;
    if (down) { speechifyQuietUntil = Date.now() + SPEECHIFY_QUIET_MS; speechifyQuietWhy = down; }
    throw e;
  }
  if (!res.ok) throw await workerProblem(res);
  return speechifyClip(res, text);
}

/**
 * The name a Speechify clip is kept under on the device: the voice asked for ('' = the Worker's default), the
 * Worker's `version` ("MODEL|default voice": a new model or default voice is a new clip), the language, the text.
 */
export function speechifyClipKey(voice: string, version: string, lang: 'en' | 'zh' | undefined, text: string): string {
  return `speechify|${voice}|${version}|${lang ?? 'en'}|best|${text}`;
}
/** the Worker's version is asked again (GET /health, free) when it was last heard longer ago than this (ms) */
export const SPEECHIFY_VERSION_MAX_AGE_MS = 6 * 3_600_000;
let versionAsking: Promise<void> | null = null;
/** the Worker's version again, in the background (nothing waits for it) */
function refreshSpeechifyVersion(): Promise<void> {
  versionAsking ??= workerFetch('/health', {}, 10_000)
    .then(async (res) => { if (res.ok) { const j = (await res.json()) as { version?: string }; if (j.version) await setSpeechifyServer(j.version); } })
    .catch(() => undefined)
    .finally(() => { versionAsking = null; });
  return versionAsking;
}

/** the device's clip store first (any length: a cache hit costs 0 and is not counted), then the Worker */
async function speechifyCached(a: TtsAsk, text: string): Promise<TtsAnswer> {
  // (a web page in the app's browser: nothing of ours is kept in a site's own database, and the page never has the
  // app code; Speechify is not used there, so no clip is ever paid without being kept)
  if ((globalThis as { __drLightBg?: boolean }).__drLightBg) throw speechifyError('it is not used on web pages.', 'setup');
  const voice = (a.voice || (await getExtras()).speechifyVoice || '').trim();
  const idb = typeof indexedDB !== 'undefined';
  // (the Worker's version is known from before, also after a restart: the clip plays with no request at all)
  const server = await getSpeechifyServer().catch(() => null);
  if (server && idb) {
    const kept = await getSound(speechifyClipKey(voice, server.version, a.lang, text), true);
    if (kept) {
      if (Date.now() - server.at > SPEECHIFY_VERSION_MAX_AGE_MS) void refreshSpeechifyVersion();
      return kept;
    }
  }
  const { version, ...made } = await speechifySay({ ...a, voice });
  // (kept under the version the Worker made it with; a new version is remembered for the next clips)
  const ver = version ?? server?.version ?? '';
  if (version && version !== server?.version) await setSpeechifyServer(version).catch(() => undefined);
  else if (version && server && Date.now() - server.at > SPEECHIFY_VERSION_MAX_AGE_MS / 2) void setSpeechifyServer(version).catch(() => undefined);
  if (made.b64 && idb) void putSound(speechifyClipKey(voice, ver, a.lang, text), made, true);
  return made;
}

/** a voice of the Speechify picker ('isDefault' = the Worker's natural British default) */
export interface SpeechifyVoiceInfo { id: string; name: string; locale: string; gender: string; tags: string[]; preview: string | null; british: boolean; isDefault: boolean }
/** the Speechify voices for the picker: English ones, the British default first and marked */
export async function speechifyVoices(): Promise<{ voices: SpeechifyVoiceInfo[]; default: string | null }> {
  const res = await workerFetch('/voices');
  if (!res.ok) throw await workerProblem(res);
  const j = (await res.json()) as { voices?: SpeechifyVoiceInfo[]; default?: string | null; version?: string };
  if (j.version) await setSpeechifyServer(j.version).catch(() => undefined);
  return { voices: (j.voices ?? []).map((v) => ({ id: v.id, name: v.name, locale: v.locale, gender: v.gender, tags: v.tags ?? [], preview: v.preview ?? null, british: !!v.british, isDefault: !!v.isDefault })), default: j.default ?? null };
}
/** the Worker's own count (both apps together, UTC days) */
export interface SpeechifyServerUsage { day: string; today: number; month: string; monthChars: number; requestsToday: number; dailyLimit: number; left: number }
export async function speechifyServerUsage(): Promise<SpeechifyServerUsage> {
  const res = await workerFetch('/usage');
  if (!res.ok) throw await workerProblem(res);
  return (await res.json()) as SpeechifyServerUsage;
}
/** the Test button: the address and the app code work ({ ok, message }); nothing is paid */
export async function testSpeechify(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await workerFetch('/health', {}, 10_000);
    if (!res.ok) throw await workerProblem(res);
    const j = (await res.json()) as { model?: string; dailyLimit?: number; version?: string };
    if (j.version) await setSpeechifyServer(j.version).catch(() => undefined);
    return { ok: true, message: `The Speechify Worker works (model ${j.model ?? '?'}, at most ${(j.dailyLimit ?? 0).toLocaleString('en-US')} characters a day).` };
  } catch (e) { return { ok: false, message: (e as Error).message }; }
}

/** ElevenLabs letter times -> the times of the words of `text` (word-times.ts), in the shape the voice's answer and the sound cache keep */
export function alignmentTimings(text: string, a: Alignment): TtsAnswer['timings'] {
  const words = wordsFromAlignment(text, a);
  return words.length ? words.map((w) => ({ start: w.start, end: w.end, charIndex: w.charStart, charLength: w.charEnd - w.charStart })) : null;
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
  throw Object.assign(new Error(`The live voice did not connect: ${last || 'no live model is available for this key'}. You can talk with Claude instead (⚙ → Talk to my tutor).`), { status: 400 });
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

// ---- an unpacked extension updates itself: a newer build in its folder = reload, then the YouTube tab that noticed --------
const isUnpacked = (): boolean => typeof chrome !== 'undefined' && !!chrome.runtime?.getManifest && !('update_url' in chrome.runtime.getManifest());
async function buildStamp(): Promise<string | null> {
  try { return (await (await fetch(chrome.runtime.getURL('dream/build-stamp.txt'), { cache: 'no-store' })).text()).trim() || null; } catch { return null; }
}
/** `running` = the build the asking YouTube script came from; a different build in the folder = reload */
export async function devReload(tabId: number | undefined, running: string | undefined): Promise<boolean> {
  if (!isUnpacked() || !running) return false;
  const now = await buildStamp();
  if (!now || now === running) return false;
  if (tabId !== undefined) await chrome.storage.session?.set({ drReloadTab: tabId }).catch(() => undefined);
  setTimeout(() => chrome.runtime.reload(), 120);
  return true;
}
async function afterDevReload(): Promise<void> {
  const o = await chrome.storage.session?.get('drReloadTab').catch(() => ({} as Record<string, unknown>));
  const id = (o as Record<string, unknown> | undefined)?.drReloadTab as number | undefined;
  if (id === undefined) return;
  await chrome.storage.session.remove('drReloadTab').catch(() => undefined);
  chrome.tabs.reload(id).catch(() => undefined);
}

export function installDreamBackground(): void {
  void afterDevReload();
  installVocabSync();
  installLevelDb();
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'dream-ai') return;
    const ctrl = new AbortController();
    port.onDisconnect.addListener(() => ctrl.abort());
    const post = (m: unknown) => { try { port.postMessage(m); } catch { /* the page went away */ } };
    port.onMessage.addListener((msg: { type: string; req?: ExplainRequest; prompt?: PromptBundle; stream?: boolean; analysis?: boolean; system?: string; messages?: ChatTurn[] }) => {
      if (msg?.type === 'chat' && msg.system && msg.messages) {
        keepAwake(runChat(msg.system, msg.messages, ctrl.signal, (t) => post({ type: 'delta', text: t })))
          .then((r) => post({ type: 'done', text: r.text, usd: r.usd }))
          .catch((e: Error & { code?: string }) => post({ type: 'error', message: e.message, code: e.code ?? 'other' }));
        return;
      }
      if (msg?.type === 'explain' && msg.req) {
        keepAwake(runExplain(msg.req, ctrl.signal, (t) => post({ type: 'delta', text: t })))
          .then((r) => post({ type: 'done', text: r.text, usage: r.usage }))
          .catch((e: Error & { code?: string }) => post({ type: 'error', message: e.message, code: e.code ?? 'other' }));
      } else if (msg?.type === 'complete' && msg.prompt) {
        keepAwake(runCompletion(msg.prompt, ctrl.signal, msg.stream ? (t) => post({ type: 'delta', text: t }) : undefined, msg.analysis))
          .then((r) => post({ type: 'done', text: r.text, usd: r.usd }))
          .catch((e: Error & { code?: string }) => post({ type: 'error', message: e.message, code: e.code ?? 'other' }));
      }
    });
  });
  chrome.runtime.onMessage.addListener((msg: { type?: string; provider?: AiProviderId }, _sender, sendResponse) => {
    if (msg?.type === 'dream-test-key' && msg.provider) { void testKey(msg.provider).then(sendResponse); return true; }
    if (msg?.type === 'dream-vocab-online') { void (async () => { const saved = (msg as { save?: boolean }).save ? await saveOnline().catch(() => null) : null; const on = await loadOnline().catch(() => null); sendResponse({ saved, at: on?.at ?? null, words: on ? Object.keys(on.words).length : 0, sync: !!chrome.storage?.sync }); })(); return true; }
    if (msg?.type === 'dream-dev-check') { void devReload(_sender.tab?.id, (msg as { build?: string }).build).then((r) => sendResponse({ reloading: r })); return true; }
    if (msg?.type === 'dream-tts') { void keepAwake(synthesize(msg as unknown as TtsAsk)).then(sendResponse, (e: Error & { code?: string; note?: string; why?: string }) => sendResponse({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.note ? { note: e.note } : {}), ...(e.why ? { why: e.why } : {}) })); return true; }
    if (msg?.type === 'dream-test-azure') { void testAzure((msg as { key?: string }).key).then(sendResponse); return true; }
    if (msg?.type === 'dream-speechify-voices') { void speechifyVoices().then(sendResponse, (e: Error) => sendResponse({ error: e.message })); return true; }
    if (msg?.type === 'dream-speechify-usage') { void Promise.all([getSpeechifyUsage(), speechifyServerUsage().catch(() => null)]).then(([local, server]) => sendResponse({ local, server }), (e: Error) => sendResponse({ error: e.message })); return true; }
    if (msg?.type === 'dream-speechify-test') { void testSpeechify().then(sendResponse); return true; }
    if (msg?.type === 'dream-live-sdp') { void liveConnect(msg as unknown as LiveAsk).then(sendResponse, (e: Error & { status?: number }) => sendResponse({ error: e.message, status: e.status })); return true; }
    if (msg?.type === 'dream-usage') { void recordLive(msg as unknown as { model: string; usage: RealtimeUsage }).then(sendResponse, () => sendResponse(null)); return true; }
    if (msg?.type === 'dream-db-write') { void writeDatabase().then(sendResponse); return true; }
    if (msg?.type === 'dream-gist-poll') { void syncGist().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false })); return true; }
    // lyrics mode: the song's lyrics from LRCLIB (timed when it has them), then lyrics.ovh (plain); see lyrics.ts
    if (msg?.type === 'dream-lyrics') {
      const m = msg as { title?: string; channel?: string; duration?: number; artist?: string; song?: string };
      // (a service that does not answer must not hold the page: 9 seconds each)
      const fetchJson = async (url: string): Promise<unknown> => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 9000);
        try { const r = await fetch(url, { signal: ctrl.signal }); reached = true; if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } finally { clearTimeout(timer); }
      };
      // (reached: a service answered, also with "not found"; false = no internet, so "nothing found" is not kept)
      let reached = false;
      void baseUrls().then((b) => findLyrics(m.title ?? '', m.channel ?? '', m.duration ?? 0, fetchJson, { names: m.song ? { artist: m.artist ?? '', title: m.song } : null, base: { lrclib: (b as { lrclib?: string }).lrclib, ovh: (b as { lyricsOvh?: string }).lyricsOvh } }))
        .then((lyr) => sendResponse({ ok: true, lyrics: lyr, reached }), (e: Error) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg?.type === 'dream-db-host') { sendResponse({ host: NATIVE_HOST, id: chrome.runtime.id }); return false; }
    if (msg?.type === 'dream-level-copy') {
      void (async () => {
        const text = levelSummary(await currentDoc(), (await getLevel()).lastCopyAt);
        await updateLevel((m) => ({ ...m, lastCopyAt: new Date().toISOString() }));
        sendResponse({ text });
      })();
      return true;
    }
    if (msg?.type === 'dream-open' && (msg as { page?: string }).page) { void chrome.tabs.create({ url: chrome.runtime.getURL(`dream/${(msg as { page: string }).page}.html`) }); return false; }
    return false;
  });
}

// (the app's browser has its own small background, web-bg.ts: only the AI and the voice, no vocabulary file, nothing at start)
if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect && !(globalThis as { __drLightBg?: boolean }).__drLightBg) installDreamBackground();
