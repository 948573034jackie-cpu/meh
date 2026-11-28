/**
 * The Speechify voice (through the learner's own Worker, speech-proxy/) as both apps use it: the Worker gets the app
 * code, never a Speechify key; every clip is kept on the device (paid once); only characters really billed are counted;
 * the daily limit (the app's, or the Worker's 'daily-limit') = the free iPhone voice until tomorrow; any error = the
 * iPhone voice for that sentence at once, with one short message; only the next sentence is made ahead; 'auto' takes
 * Speechify first when the address and the app code are set; pages that do not ask for it never get it.
 * The Worker is a stand-in here (a made-up fetch), and so is the device's clip store (IndexedDB).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { synthesize, speechifySent, speechifyVoices, speechifyServerUsage, testSpeechify, speechifyClipKey, resetSpeechifyQuiet, SPEECHIFY_SPEAK_TIMEOUT_MS, SPEECHIFY_QUIET_MS, SPEECHIFY_VERSION_MAX_AGE_MS } from '../src/bg';
import { SPEECHIFY_LIMIT } from '../src/tts-cache';
import { VoiceWithBackup, cloudEngine, resolveVoice, ttsError, isBusy, speechifyVoiceList, speechifyVoiceName, SPEECHIFY_LABEL, SPEECHIFY_ENGINE, SPEECHIFY_COOL_MS } from '../src/voice';
import { DEFAULT_EXTRAS, getSpeechifyUsage, speechifyUsageText, localDay, getUsage, usdSince, voiceUsdSince, periodStarts, addUsage, clearSpeechifyStop, nextUtcMidnight } from '../src/store';
import type { TtsEngine, SpeakHandle, SpeakOptions, SpeakOutcome } from '@core/tts/engine';

const G = globalThis as unknown as Record<string, unknown>;
const URL_ = 'https://iknow-speech.test.workers.dev';
const CODE = 'app-code-0123456789';

// ---- a stand-in IndexedDB (only what tts-cache.ts uses) ------------------------------------------------------------
const idbStores = new Map<string, Map<string, unknown>>();
function fakeIndexedDB() {
  const later = (f: () => void) => queueMicrotask(f);
  const req = <T>(value: () => T) => { const r: { result?: T; onsuccess?: () => void; onerror?: () => void } = {}; later(() => { r.result = value(); r.onsuccess?.(); }); return r; };
  const db = {
    objectStoreNames: { contains: (n: string) => idbStores.has(n) },
    createObjectStore: (n: string) => { idbStores.set(n, new Map()); return { createIndex: () => undefined }; },
    transaction: (name: string) => {
      const tx: { oncomplete?: () => void; onerror?: () => void; objectStore: () => unknown } = { objectStore: () => undefined };
      const st = idbStores.get(name)!;
      tx.objectStore = () => ({
        get: (k: string) => req(() => st.get(k)),
        put: (v: unknown, k: string) => req(() => { st.set(k, v); }),
        count: () => req(() => st.size),
        index: () => ({ openKeyCursor: () => req(() => null) }),
      });
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
  };
  return { open: () => { const r: { result: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = { result: db }; later(() => { r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; } };
}
G.indexedDB = fakeIndexedDB();

// ---- a stand-in Worker ---------------------------------------------------------------------------------------------
interface Call { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }
let calls: Call[] = [];
let stored: Record<string, unknown> = {};
let answer: (c: Call) => Response | Promise<Response>;
/** the Worker's "MODEL|default voice" (speech-proxy versionOf) */
let workerVersion = 'simba-3.5|gb-1';
const okClip = (c: Call) => {
  const text = String(c.body?.text ?? '');
  return new Response(JSON.stringify({ audio: 'SUQzZmFrZQ==', mime: 'audio/mpeg', format: 'mp3', chars: text.length, cached: false, voice: 'gb-1', model: 'simba-3.5', version: workerVersion, marks: [{ start: 0, end: 0.4, charIndex: 0, charLength: 5 }] }), { status: 200 });
};
const json = (t: string): Record<string, unknown> | null => { try { return JSON.parse(t) as Record<string, unknown>; } catch { return null; } };
const speakCalls = () => calls.filter((c) => c.url.endsWith('/speak'));
let signals: (AbortSignal | null)[] = [];
/** a Worker that never answers (only the request's own timeout ends it) */
const stalled = (): Promise<Response> => new Promise((_r, reject) => { const sg = signals[signals.length - 1]; sg?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });

beforeEach(() => {
  calls = [];
  workerVersion = 'simba-3.5|gb-1';
  resetSpeechifyQuiet();
  speechifySent.length = 0;
  for (const s of idbStores.values()) s.clear();
  stored = { drKeys: { speechify: CODE, azure: 'test-azure-key' }, drExtras: { speechifyUrl: `${URL_}/` } };
  G.chrome = {
    storage: { local: {
      get: async (k: string) => (k in stored ? { [k]: JSON.parse(JSON.stringify(stored[k])) } : {}),
      set: async (o: Record<string, unknown>) => { Object.assign(stored, JSON.parse(JSON.stringify(o))); },
      remove: async (k: string | string[]) => { for (const x of Array.isArray(k) ? k : [k]) delete stored[x]; },
    } },
    // (the page's voice asks the background, as in the app)
    runtime: { sendMessage: async (m: { type: string }) => (m.type === 'dream-tts' ? synthesize(m as never).catch((e: Error & { code?: string; note?: string }) => ({ error: e.message, code: e.code, note: e.note })) : m.type === 'dream-speechify-voices' ? speechifyVoices().catch((e: Error) => ({ error: e.message })) : undefined) },
  };
  answer = okClip;
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? json(init.body) : null };
    calls.push(c);
    signals.push(init.signal ?? null);
    return answer(c);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); delete G.chrome; });

const say = (text: string, voice = '') => synthesize({ engine: 'speechify', text, voice });
const failOf = (p: Promise<unknown>) => p.then(() => null, (e: Error & { code?: string; note?: string; why?: string }) => e);

describe('settings: opt-in, nothing changes for anyone who does not set it up', () => {
  it('new settings start empty / at 20,000 characters a day; the choice "speechify" exists', () => {
    expect(DEFAULT_EXTRAS.speechifyUrl).toBe('');
    expect(DEFAULT_EXTRAS.speechifyVoice).toBe('');
    expect(DEFAULT_EXTRAS.speechifyDailyChars).toBe(20_000);
    expect(DEFAULT_EXTRAS.voice).toBe('auto');
  });
  it('resolveVoice: a page that does not pass speechifyUrl gets exactly what it got before', () => {
    const keys = { azure: 'a', speechify: CODE };
    expect(resolveVoice('auto', keys)).toBe('azure');
    expect(resolveVoice('speechify', keys)).toBe('mac');
    expect(resolveVoice('auto', { elevenlabs: 'e', speechify: CODE }, { noOpenAi: true })).toBe('elevenlabs');
  });
  it('resolveVoice with speechifyUrl: chosen, or FIRST in auto, only when the address AND the app code are set', () => {
    expect(resolveVoice('speechify', { speechify: CODE }, { speechifyUrl: URL_ })).toBe('speechify');
    expect(resolveVoice('auto', { azure: 'a', openai: 'o', speechify: CODE }, { speechifyUrl: URL_ })).toBe('speechify');
    expect(resolveVoice('auto', { azure: 'a', speechify: CODE }, { speechifyUrl: URL_, noOpenAi: true })).toBe('speechify');
    expect(resolveVoice('auto', { azure: 'a' }, { speechifyUrl: URL_ })).toBe('azure');
    expect(resolveVoice('auto', { azure: 'a', speechify: CODE }, { speechifyUrl: '  ' })).toBe('azure');
    expect(resolveVoice('speechify', { azure: 'a' }, { speechifyUrl: URL_ })).toBe('mac');
    expect(resolveVoice('azure', { azure: 'a', speechify: CODE }, { speechifyUrl: URL_ })).toBe('azure');
    expect(resolveVoice('mac', { speechify: CODE }, { speechifyUrl: URL_ })).toBe('mac');
  });
});

describe('the request to the Worker', () => {
  it('POST <address>/speak with the app code (no Speechify key anywhere), the clip and its word times back', async () => {
    const r = await say('Hello world.', 'gb-2');
    expect(r).toEqual({ b64: 'SUQzZmFrZQ==', mime: 'audio/mpeg', timings: [{ start: 0, end: 0.4, charIndex: 0, charLength: 5 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${URL_}/speak`, method: 'POST', body: { text: 'Hello world.', voice: 'gb-2', format: 'mp3', lang: 'en' } });
    expect(calls[0].headers['X-App-Code']).toBe(CODE);
    expect(JSON.stringify(calls[0])).not.toMatch(/sk_|Bearer/);
  });
  it('the voice of the settings when the page names none; none at all = the Worker\'s British default', async () => {
    await say('One.');
    expect(calls[0].body).not.toHaveProperty('voice');
    stored.drExtras = { speechifyUrl: URL_, speechifyVoice: 'gb-7' };
    await say('Two.');
    expect(calls[1].body).toMatchObject({ voice: 'gb-7' });
  });
});

describe('money: paid once, counted right', () => {
  it('the same text again plays from the device: no request, nothing counted', async () => {
    await say('Hello world.');
    await new Promise((r) => setTimeout(r, 5));
    const again = await say('  Hello world. ');
    expect(again.b64).toBe('SUQzZmFrZQ==');
    expect(speakCalls()).toHaveLength(1);
    expect((await getSpeechifyUsage()).today).toBe(12);
    // (kept under the voice, the Worker's version (model | default voice) and the text, in the store of long clips: any length)
    expect(idbStores.get('clips')?.has(speechifyClipKey('', 'simba-3.5|gb-1', 'en', 'Hello world.'))).toBe(true);
    const long = 'A long paragraph of a book. '.repeat(20).trim();
    await say(long);
    await new Promise((r) => setTimeout(r, 5));
    await say(long);
    expect(speakCalls()).toHaveLength(2);
  });
  it('counts the characters the Worker says were billed; a clip from the Worker\'s cache counts 0', async () => {
    answer = () => new Response(JSON.stringify({ audio: 'AA==', chars: 7, cached: false }), { status: 200 });
    await say('Seven characters, the Worker says.');
    answer = () => new Response(JSON.stringify({ audio: 'AA==', chars: 0, cached: true }), { status: 200 });
    await say('Made before by the other app.');
    const u = await getSpeechifyUsage();
    expect(u).toMatchObject({ today: 7, month: 7, dailyLimit: 20_000, left: 19_993, stopped: false });
    expect(speechifyUsageText(u)).toBe('Speechify today: 7 of 20,000 characters · this month: 7');
  });
  it('today and this month: yesterday counts for the month only', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 25, 22, 0));
    await say('Hello world.');
    vi.setSystemTime(new Date(2026, 10, 26, 9, 0));
    await say('Good morning.');
    expect(await getSpeechifyUsage()).toMatchObject({ today: 13, month: 25 });
  });
});

describe('the daily limit: then the free iPhone voice until tomorrow', () => {
  it('the app\'s own limit (speechifyDailyChars): a sentence that does not fit is not sent; cached clips still play', async () => {
    stored.drExtras = { speechifyUrl: URL_, speechifyDailyChars: 20 };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 26, 9, 0));
    await say('Hello world.');
    await new Promise((r) => setTimeout(r, 5));
    // (8 characters left: this one does not fit and is not sent; the device voice says it)
    const e = await failOf(say('Hello again, friend.'));
    expect(isBusy(e)).toBe(true);
    expect(speakCalls()).toHaveLength(1);
    // (a short one still fits, and uses the rest)
    await say('Hi there');
    expect(speakCalls()).toHaveLength(2);
    // (done for today: nothing is sent any more)
    const done = await failOf(say('Hi.'));
    expect(done?.message).toBe(SPEECHIFY_LIMIT);
    expect(speakCalls()).toHaveLength(2);
    expect((await getSpeechifyUsage()).stopped).toBe(true);
    expect((await say('Hello world.')).b64).toBe('SUQzZmFrZQ==');
    // tomorrow: Speechify again
    vi.setSystemTime(new Date(2026, 10, 27, 9, 0));
    await say('Hi.');
    expect(speakCalls()).toHaveLength(3);
  });
  it('the Worker\'s 429 daily-limit: no more requests until the Worker\'s day starts again (its resetAt, UTC midnight)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T20:00:00Z'));
    answer = () => new Response(JSON.stringify({ code: 'daily-limit', error: 'limit', resetAt: '2026-11-27T00:00:00.000Z' }), { status: 429 });
    const e = await failOf(say('Hello world.'));
    expect(e?.message).toBe(SPEECHIFY_LIMIT);
    answer = okClip;
    expect(await failOf(say('Another one.'))).not.toBeNull();
    expect(speakCalls()).toHaveLength(1);
    expect(stored.drSpeechifyStop).toEqual({ until: '2026-11-27T00:00:00.000Z' });
    // (the Worker's new day: Speechify again, even if the device's own day has not changed)
    vi.setSystemTime(new Date('2026-11-27T00:00:01Z'));
    expect(await failOf(say('Another one.'))).toBeNull();
    expect(speakCalls()).toHaveLength(2);
  });
  it('a 429 without resetAt (an older Worker): until the next UTC midnight; an old flag (the local day) still works', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T20:00:00Z'));
    answer = () => new Response(JSON.stringify({ code: 'daily-limit' }), { status: 429 });
    await failOf(say('Hello world.'));
    expect(stored.drSpeechifyStop).toEqual({ until: nextUtcMidnight(new Date('2026-11-26T20:00:00Z')) });
    stored.drSpeechifyStop = localDay();
    expect((await getSpeechifyUsage()).stopped).toBe(true);
  });
  it('ONE text longer than what is left today fails alone: no "done for today", shorter texts still go to Speechify', async () => {
    stored.drExtras = { speechifyUrl: URL_, speechifyDailyChars: 30 };
    const long = 'This sentence is much longer than thirty characters.';
    const e = await failOf(say(long));
    expect(isBusy(e)).toBe(true);
    expect(e?.message).toMatch(/longer than the characters left today \(30\)/);
    expect(e?.message).not.toBe(SPEECHIFY_LIMIT);
    expect(stored.drSpeechifyStop).toBeUndefined();
    expect((await getSpeechifyUsage()).stopped).toBe(false);
    expect((await say('Short one.')).b64).toBe('SUQzZmFrZQ==');
    expect(speakCalls()).toHaveLength(1);
  });
  it('clearSpeechifyStop (the learner raised the limit): Speechify may speak again', async () => {
    stored.drSpeechifyStop = { until: new Date(Date.now() + 3_600_000).toISOString() };
    expect((await getSpeechifyUsage()).stopped).toBe(true);
    await clearSpeechifyStop();
    expect((await getSpeechifyUsage()).stopped).toBe(false);
    expect((await say('Hi.')).b64).toBe('SUQzZmFrZQ==');
  });
  it('a limit of 0 = Speechify never sends anything', async () => {
    stored.drExtras = { speechifyUrl: URL_, speechifyDailyChars: 0 };
    expect(await failOf(say('Hi.'))).not.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('errors: a clear message, the iPhone voice at once', () => {
  it('not set up (no address, or no app code): nothing is sent', async () => {
    stored.drExtras = {};
    expect((await failOf(say('Hi.')))?.message).toMatch(/Worker address is missing/);
    stored.drExtras = { speechifyUrl: URL_ };
    stored.drKeys = {};
    expect((await failOf(say('Hi.')))?.message).toMatch(/app code is missing/);
    stored.drExtras = { speechifyUrl: 'http://evil.example' };
    stored.drKeys = { speechify: CODE };
    expect((await failOf(say('Hi.')))?.message).toMatch(/https/);
    expect(calls).toHaveLength(0);
  });
  it('a wrong app code, a Speechify error, no internet: each says what happened, nothing is counted', async () => {
    answer = () => new Response(JSON.stringify({ code: 'auth', error: 'App code missing or wrong' }), { status: 401 });
    expect((await failOf(say('Hi.')))?.message).toMatch(/did not accept the app code/);
    answer = () => new Response(JSON.stringify({ code: 'speechify', error: 'Speechify did not accept the API key' }), { status: 502 });
    const e = await failOf(say('Hi.'));
    expect(e?.message).toMatch(/Speechify did not accept the API key/);
    expect(e?.code).toBe('busy');
    answer = () => { throw new TypeError('Failed to fetch'); };
    expect((await failOf(say('Hi.')))?.message).toMatch(/could not be reached/);
    expect((await getSpeechifyUsage()).today).toBe(0);
  });
  it('ttsError: every Speechify failure goes to the device voice at once and is told once; other voices as before', () => {
    const e = ttsError('speechify', { error: 'Speechify voice: the Worker answered HTTP 500.' }) as Error & { code?: string; note?: string; once?: boolean };
    expect(e).toMatchObject({ code: 'busy', once: true, note: 'Speechify voice: the Worker answered HTTP 500. The iPhone voice reads instead.' });
    expect((ttsError('speechify', { error: SPEECHIFY_LIMIT }) as Error & { note?: string }).note).toBe(SPEECHIFY_LIMIT);
    expect((ttsError('speechify', undefined) as Error & { code?: string }).code).toBe('busy');
    expect((ttsError('openai', { error: 'HTTP 500' }) as Error & { code?: string }).code).toBeUndefined();
  });
});

describe('the AI budget does not count the Speechify voice', () => {
  it('a Speechify clip is in the usage list with its cost, but not in the AI\'s sums (it is shown as the voice)', async () => {
    await addUsage({ date: new Date().toISOString(), provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 50, cachedTokens: 0, usd: 0.25 });
    await say('A paragraph of a book that costs Speechify characters.');
    const list = await getUsage();
    const { day, month } = periodStarts();
    expect(list.some((r) => r.model === 'speechify' && r.usd > 0)).toBe(true);
    expect(usdSince(list, month)).toBeCloseTo(0.25, 6);
    expect(usdSince(list, day)).toBeCloseTo(0.25, 6);
    expect(voiceUsdSince(list, month)).toBeCloseTo('A paragraph of a book that costs Speechify characters.'.length * 15e-6, 9);
  });
  it('however much Speechify costs, the AI budget sum stays the AI\'s own', async () => {
    for (let i = 0; i < 3; i++) await addUsage({ date: new Date().toISOString(), provider: 'openai', model: 'speechify', inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, usd: 15 });
    expect(usdSince(await getUsage(), periodStarts().month)).toBe(0);
  });
});

describe('a stalled Worker: a short wait, one try, then the device voice for a minute', () => {
  it('/speak gives up after 6 s; then no request at all for 60 s (the device voice at once); then Speechify again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    answer = () => stalled();
    const p = failOf(say('The Worker is stuck.'));
    await vi.advanceTimersByTimeAsync(SPEECHIFY_SPEAK_TIMEOUT_MS - 100);
    expect(speakCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    const e = await p;
    expect(e?.message).toMatch(/did not answer in time/);
    expect(isBusy(e)).toBe(true);
    // (the next sentences: refused at once, nothing is sent, nothing waits)
    answer = okClip;
    const quick = await failOf(say('Next sentence.'));
    // (the same words: the learner is told once, not once per sentence)
    expect(quick?.message).toBe(e?.message);
    expect((quick as { note?: string }).note).toBe((e as { note?: string }).note);
    expect(isBusy(quick)).toBe(true);
    expect(speakCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SPEECHIFY_QUIET_MS + 10);
    expect((await say('Next sentence.')).b64).toBe('SUQzZmFrZQ==');
    expect(speakCalls()).toHaveLength(2);
  });
  it('no internet is the same (the device voice for a minute); a Worker error is not (the next sentence asks again)', async () => {
    answer = () => { throw new TypeError('Failed to fetch'); };
    await failOf(say('One.'));
    answer = okClip;
    expect((await failOf(say('Two.')))?.message).toMatch(/could not be reached/);
    expect(speakCalls()).toHaveLength(1);
    resetSpeechifyQuiet();
    answer = () => new Response(JSON.stringify({ code: 'speechify', error: 'Speechify is busy' }), { status: 502 });
    await failOf(say('Three.'));
    answer = okClip;
    expect((await say('Four.')).b64).toBe('SUQzZmFrZQ==');
  });
});

describe('the clips on the device follow the Worker\'s model and default voice', () => {
  it('a new MODEL / DEFAULT_VOICE on the Worker: an old clip is not played again', async () => {
    await say('Hello world.');
    await new Promise((r) => setTimeout(r, 5));
    expect(stored.drSpeechifyServer).toMatchObject({ version: 'simba-3.5|gb-1' });
    // (the owner changed MODEL; the app hears it from the Worker: Test / the picker / GET /health)
    workerVersion = 'simba-3.2|gb-1';
    answer = (c) => c.url.endsWith('/health') ? new Response(JSON.stringify({ ok: true, model: 'simba-3.2', dailyLimit: 20000, version: workerVersion }), { status: 200 }) : okClip(c);
    expect((await testSpeechify()).ok).toBe(true);
    expect(stored.drSpeechifyServer).toMatchObject({ version: 'simba-3.2|gb-1' });
    await say('Hello world.');
    expect(speakCalls()).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 5));
    await say('Hello world.');
    expect(speakCalls()).toHaveLength(2);
  });
  it('a /speak answer with a new version is remembered for the next clips', async () => {
    stored.drSpeechifyServer = { version: 'simba-3.5|gb-1', at: Date.now() };
    workerVersion = 'simba-3.5|gb-9';
    await say('First.');
    expect(stored.drSpeechifyServer).toMatchObject({ version: 'simba-3.5|gb-9' });
    expect(idbStores.get('clips')?.has(speechifyClipKey('', 'simba-3.5|gb-9', 'en', 'First.'))).toBe(true);
  });
  it('after a restart (the version known from before): a kept clip plays with no request at all', async () => {
    stored.drSpeechifyServer = { version: 'simba-3.5|gb-1', at: Date.now() };
    idbStores.get('clips')?.set(speechifyClipKey('gb-2', 'simba-3.5|gb-1', 'en', 'Kept from yesterday.'), { b64: 'S0VQVA==', mime: 'audio/mpeg', timings: null, at: 1 });
    expect((await say('Kept from yesterday.', 'gb-2')).b64).toBe('S0VQVA==');
    expect(calls).toHaveLength(0);
  });
  it('a version heard long ago is asked again in the background (GET /health, free); the clip plays at once', async () => {
    stored.drSpeechifyServer = { version: 'simba-3.5|gb-1', at: Date.now() - SPEECHIFY_VERSION_MAX_AGE_MS - 1000 };
    idbStores.get('clips')?.set(speechifyClipKey('', 'simba-3.5|gb-1', 'en', 'Old clip.'), { b64: 'T0xE', mime: 'audio/mpeg', timings: null, at: 1 });
    answer = (c) => new Response(JSON.stringify({ ok: true, model: 'simba-3.2', version: 'simba-3.2|gb-1' }), { status: 200 });
    expect((await say('Old clip.')).b64).toBe('T0xE');
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.map((c) => c.url)).toEqual([`${URL_}/health`]);
    expect(stored.drSpeechifyServer).toMatchObject({ version: 'simba-3.2|gb-1' });
  });
  it('the voice picker teaches the version too (GET /voices)', async () => {
    answer = () => new Response(JSON.stringify({ default: 'gb-1', model: 'simba-3.5', version: 'simba-3.5|gb-1', voices: [] }), { status: 200 });
    await speechifyVoices();
    expect(stored.drSpeechifyServer).toMatchObject({ version: 'simba-3.5|gb-1' });
  });
});

/** a voice whose sentences all fail with `error` */
function failing(error: Error): TtsEngine & { asked: string[] } {
  const asked: string[] = [];
  return {
    id: 'azure', kind: 'cloud', label: 'x', costNote: '', wordBoundaries: false, paused: false, asked,
    listVoices: async () => [],
    speak(text: string): SpeakHandle { asked.push(text); const h: SpeakHandle = { done: Promise.resolve('error' as SpeakOutcome), cancel: () => undefined }; h.error = error; return h; },
    pause() {}, resume() {}, cancelAll() {},
  };
}
function device(): TtsEngine & { said: string[] } {
  const said: string[] = [];
  return {
    id: 'webspeech', kind: 'local', label: 'iPhone', costNote: '', wordBoundaries: true, paused: false, said,
    listVoices: async () => [],
    speak(text: string, _o: SpeakOptions): SpeakHandle { said.push(text); return { done: Promise.resolve('ended' as SpeakOutcome), cancel: () => undefined }; },
    pause() {}, resume() {}, cancelAll() {},
  };
}

describe('VoiceWithBackup with the Speechify voice', () => {
  it('a failed sentence: no second try, the iPhone voice says it, the learner is told once', async () => {
    const primary = failing(ttsError('speechify', { error: 'Speechify voice: the Worker answered HTTP 500.' }));
    const mac = device();
    const told: string[] = [];
    const v = new VoiceWithBackup(primary, mac, () => 'Daniel', (e) => told.push(e.message));
    expect(await v.speak('First sentence.', { voiceId: '', rate: 1 }).done).toBe('ended');
    expect(await v.speak('Second sentence.', { voiceId: '', rate: 1 }).done).toBe('ended');
    expect(primary.asked).toEqual(['First sentence.', 'Second sentence.']);
    expect(mac.said).toEqual(['First sentence.', 'Second sentence.']);
    expect(told).toEqual(['Speechify voice: the Worker answered HTTP 500. The iPhone voice reads instead.']);
    expect(v.failed).toBe(false);
  });
  it('no sound in time: no second try, the device voice says it, and reads alone for a minute', async () => {
    let t = 1_000_000;
    const asked: string[] = [];
    const silent: TtsEngine = {
      id: SPEECHIFY_ENGINE, kind: 'cloud', label: 'Speechify', costNote: '', wordBoundaries: false, paused: false,
      listVoices: async () => [],
      speak(text: string): SpeakHandle { asked.push(text); let end!: (o: SpeakOutcome) => void; const done = new Promise<SpeakOutcome>((r) => { end = r; }); return { done, cancel: () => end('cancelled') }; },
      pause() {}, resume() {}, cancelAll() {},
    };
    const mac = device();
    const told: [string, boolean][] = [];
    const v = new VoiceWithBackup(silent, mac, () => 'Daniel', (e, cooling) => told.push([e.message, cooling]), 30, () => t);
    expect(await v.speak('First sentence.', { voiceId: '', rate: 1 }).done).toBe('ended');
    expect(asked).toEqual(['First sentence.']);
    expect(mac.said).toEqual(['First sentence.']);
    expect(told).toEqual([['Speechify voice: no sound came in time. The iPhone voice reads for a minute.', true]]);
    expect(v.failed).toBe(true);
    await v.speak('Second sentence.', { voiceId: '', rate: 1 }).done;
    expect(asked).toEqual(['First sentence.']);
    t += SPEECHIFY_COOL_MS + 1;
    expect(v.failed).toBe(false);
  });
  it('the limit is told once too, in its own words', async () => {
    const told: string[] = [];
    const v = new VoiceWithBackup(failing(ttsError('speechify', { error: SPEECHIFY_LIMIT })), device(), () => 'Daniel', (e) => told.push(e.message));
    for (let i = 0; i < 3; i++) await v.speak(`S${i}.`, { voiceId: '', rate: 1 }).done;
    expect(told).toEqual([SPEECHIFY_LIMIT]);
  });
});

/** the audio element and object addresses are stand-ins (no browser here) */
class FakeAudio {
  preload = ''; preservesPitch = false; playbackRate = 1; volume = 1; currentTime = 0; duration = 2; paused = true;
  onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(public src = '') {}
  load(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  pause(): void { this.paused = true; }
}

describe('the engine: only what plays (and the very next sentence) is made', () => {
  beforeEach(() => {
    G.Audio = FakeAudio;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:test/1');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); delete G.Audio; });
  it('readAhead of three sentences sends only the next one; its label is Speechify', async () => {
    const e = cloudEngine('speechify', 'en');
    expect(e.label).toBe(SPEECHIFY_LABEL);
    expect(e.id).toBe('speechify');
    e.readAhead(['Next one.', 'After that.', 'And later.'], '', 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(speechifySent).toEqual(['Next one.']);
    e.stopReadAhead();
  });
  it('the other cloud voices still read two ahead (unchanged)', async () => {
    stored.drKeys = { azure: 'k' };
    stored.drTestBaseUrls = { azure: 'http://azure.test' };
    answer = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    const e = cloudEngine('azure', 'en');
    e.readAhead(['One here.', 'Two here.', 'Three here.'], 'Ada', 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.map((c) => c.url)).toEqual(['http://azure.test/cognitiveservices/v1', 'http://azure.test/cognitiveservices/v1']);
  });
});

describe('the picker, the counter of the Worker, the Test button', () => {
  it('the voice list from GET /voices: the British default first and marked', async () => {
    answer = (c) => c.url.endsWith('/voices') ? new Response(JSON.stringify({ default: 'gb-1', voices: [{ id: 'gb-1', name: 'Emma', locale: 'en-GB', gender: 'female', tags: [], preview: null, british: true, isDefault: true }, { id: 'us-1', name: 'Ava', locale: 'en-US', gender: 'female', tags: [], preview: null, british: false, isDefault: false }] }), { status: 200 }) : okClip(c);
    const list = await speechifyVoiceList();
    expect(list.default).toBe('gb-1');
    expect(list.voices.map(speechifyVoiceName)).toEqual(['Emma (British, woman) ★ default', 'Ava (American, woman)']);
    expect(calls[0].headers['X-App-Code']).toBe(CODE);
  });
  it('no address: the picker says why', async () => {
    stored.drExtras = {};
    await expect(speechifyVoiceList()).rejects.toThrow(/address is missing/);
  });
  it('GET /usage and GET /health', async () => {
    answer = (c) => new Response(JSON.stringify(c.url.endsWith('/usage') ? { day: '2026-11-26', today: 120, month: '2026-11', monthChars: 999, requestsToday: 3, dailyLimit: 20000, left: 19880 } : { ok: true, model: 'simba-3.5', dailyLimit: 20000 }), { status: 200 });
    expect((await speechifyServerUsage()).monthChars).toBe(999);
    expect(await testSpeechify()).toEqual({ ok: true, message: 'The Speechify Worker works (model simba-3.5, at most 20,000 characters a day).' });
    answer = () => new Response(JSON.stringify({ code: 'auth' }), { status: 401 });
    expect((await testSpeechify()).ok).toBe(false);
  });
});

// ---- I Know 3.13, step 1: the steady Speechify voice (no other voice ever takes over) --------------------------------
import { speechifyTest, SPEECHIFY_STEADY_TRIES, SPEECHIFY_STEADY_TIMEOUT_MS } from '../src/bg';
import { SPEECHIFY_LIMIT_STEADY } from '../src/tts-cache';
import { STEADY_START_TIMEOUT_MS } from '../src/voice';
import { voiceLogNow, clearVoiceLog, mergeVoiceLog, voiceLogLineText, voiceLog, VOICE_LOG_MAX } from '../src/voice-log';

const saySteady = (text: string, voice = '') => synthesize({ engine: 'speechify', text, voice, steady: true } as never);
const logged = () => voiceLogNow().map((l) => l.what);

describe('the steady voice asks the Worker: a longer wait, quiet new tries, no "quiet minute"', () => {
  beforeEach(() => { clearVoiceLog(); speechifyTest.waits = [1, 1]; speechifyTest.timeoutMs = null; });
  afterEach(() => { speechifyTest.waits = null; speechifyTest.timeoutMs = null; });

  it('a Worker that needs 9 s is waited for (the old voice gave up after 6 s)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    expect(SPEECHIFY_STEADY_TIMEOUT_MS).toBeGreaterThan(SPEECHIFY_SPEAK_TIMEOUT_MS + 3000);
    answer = (c) => new Promise((r) => setTimeout(() => r(okClip(c)), 9000));
    const p = saySteady('A slow sentence.');
    await vi.advanceTimersByTimeAsync(9100);
    expect((await p).b64).toBe('SUQzZmFrZQ==');
    expect(speakCalls()).toHaveLength(1);
    // (a long wait is written down, with how long it took)
    expect(voiceLogNow().map((l) => [l.what, l.ms && l.ms >= 9000])).toEqual([['slow answer', true]]);
  });
  it('a failed try is tried again quietly: the second try works, nothing is told', async () => {
    let n = 0;
    answer = (c) => (++n === 1 ? new Response(JSON.stringify({ code: 'speechify', error: 'Speechify is busy' }), { status: 502 }) : okClip(c));
    expect((await saySteady('Tried twice.')).b64).toBe('SUQzZmFrZQ==');
    expect(speakCalls()).toHaveLength(2);
    expect(logged()).toEqual(['try 1 of 3 failed', 'worked at try 2']);
    expect(voiceLogNow()[0].why).toMatch(/Speechify is busy/);
    // (the text was paid for once)
    expect(speechifySent).toEqual(['Tried twice.']);
  });
  it('every try failed: three requests, the error says "not spoken" (code silent, never busy), each try is in the log with its reason', async () => {
    answer = () => { throw new TypeError('Failed to fetch'); };
    const e = await failOf(saySteady('No internet now.'));
    expect(speakCalls()).toHaveLength(SPEECHIFY_STEADY_TRIES);
    expect(e?.code).toBe('silent');
    expect(isBusy(e)).toBe(false);
    expect(e?.note).toMatch(/could not be reached.*This sentence was not spoken\.$/);
    expect(e?.note).not.toMatch(/iPhone voice/);
    expect(logged()).toEqual(['try 1 of 3 failed', 'try 2 of 3 failed', 'try 3 of 3 failed', 'not spoken']);
    expect(voiceLogNow().every((l) => /could not be reached/.test(l.why ?? '') && l.text === 'No internet now.')).toBe(true);
  });
  it('after that: each next sentence gets ONE short try (no long waits in a row), and the voice is back by itself', async () => {
    answer = () => { throw new TypeError('Failed to fetch'); };
    await failOf(saySteady('One.'));
    calls = [];
    await failOf(saySteady('Two.'));
    expect(speakCalls()).toHaveLength(1);
    // (no request is ever refused without asking: the Worker is asked for every sentence)
    answer = okClip;
    calls = [];
    expect((await saySteady('Three.')).b64).toBe('SUQzZmFrZQ==');
    expect(logged().at(-1)).toBe('Speechify answers again');
    // (and three tries again from now on)
    answer = () => new Response('{}', { status: 500 });
    calls = [];
    await failOf(saySteady('Four.'));
    expect(speakCalls()).toHaveLength(3);
  });
  it('what a new try cannot change is asked once: a wrong app code, the Worker\'s daily limit', async () => {
    answer = () => new Response(JSON.stringify({ error: 'App code missing or wrong', code: 'auth' }), { status: 401 });
    const e = await failOf(saySteady('Wrong code.'));
    expect(speakCalls()).toHaveLength(1);
    expect(e?.message).toMatch(/did not accept the app code/);
    expect(e?.code).toBe('silent');
    calls = [];
    answer = () => new Response(JSON.stringify({ code: 'daily-limit', error: 'limit', resetAt: nextUtcMidnight() }), { status: 429 });
    const l = await failOf(saySteady('Too much today.'));
    expect(speakCalls()).toHaveLength(1);
    expect(l?.message).toBe(SPEECHIFY_LIMIT_STEADY);
    expect(l?.note).toBe(SPEECHIFY_LIMIT_STEADY);
    // (the day is done on this device: the next sentence is not even sent, and says the same)
    calls = [];
    expect((await failOf(saySteady('Next one.')))?.message).toBe(SPEECHIFY_LIMIT_STEADY);
    expect(speakCalls()).toHaveLength(0);
    expect(logged().at(-1)).toBe('not asked');
  });
  it('the old voice (I Know Book) is exactly as before: one try, 6 s, then the quiet minute', async () => {
    answer = () => { throw new TypeError('Failed to fetch'); };
    const e = await failOf(say('Old rule.'));
    expect(speakCalls()).toHaveLength(1);
    expect(isBusy(e)).toBe(true);
    expect(e?.note).toMatch(/The iPhone voice reads instead\.$/);
    answer = okClip;
    await failOf(say('Old rule, next.'));
    expect(speakCalls()).toHaveLength(1);
    expect(voiceLogNow()).toEqual([]);
  });
});

describe('VoiceWithBackup, steady: the Speechify voice is the only voice', () => {
  const silentErr = (message: string) => ttsError('speechify', { error: message, code: 'silent' });
  it('a sentence that could not be made: NOT said by the device voice, the next one is asked again, the reason told once a minute', async () => {
    let t = 5_000_000;
    const primary = failing(silentErr('Speechify voice: the Worker could not be reached (Failed to fetch).'));
    const mac = device();
    const told: [string, boolean][] = [];
    const v = new VoiceWithBackup(primary, mac, () => 'Daniel', (e, cooling) => told.push([e.message, cooling]), 12_000, () => t, { steady: true });
    for (const s of ['First.', 'Second.', 'Third.', 'Fourth.']) expect(await v.speak(s, { voiceId: '', rate: 1 }).done).toBe('ended');
    // (asked for every sentence, once each: the background already tried three times)
    expect(primary.asked).toEqual(['First.', 'Second.', 'Third.', 'Fourth.']);
    expect(mac.said).toEqual([]);
    expect(v.failed).toBe(false);
    expect(told).toEqual([['Speechify voice: the Worker could not be reached (Failed to fetch). This sentence was not spoken.', false]]);
    expect(v.silentInARow).toBe(4);
    t += 61_000;
    await v.speak('Fifth.', { voiceId: '', rate: 1 }).done;
    expect(told).toHaveLength(2);
  });
  it('the sound was made but did not play: once more (it is still in memory), then it is left out; never the device voice', async () => {
    const primary = failing(new Error('audio playback failed'));
    const mac = device();
    const lines: string[] = [];
    const v = new VoiceWithBackup(primary, mac, () => 'Daniel', () => undefined, 12_000, undefined, { steady: true, log: (what) => lines.push(what) });
    const h = v.speak('Play me.', { voiceId: '', rate: 1 });
    expect(await h.done).toBe('ended');
    expect(primary.asked).toEqual(['Play me.', 'Play me.']);
    expect(mac.said).toEqual([]);
    expect(lines).toEqual(['the sound did not play: once more', 'not spoken']);
    expect(h.error?.message).toBe('audio playback failed');
  });
  it('no sound for 40 s: the sentence is given up, nothing else speaks, and the next sentence is the Speechify voice again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asked: string[] = [];
    let hang = true;
    const primary: TtsEngine = {
      id: SPEECHIFY_ENGINE, kind: 'cloud', label: 'Speechify', costNote: '', wordBoundaries: false, paused: false,
      listVoices: async () => [],
      speak(text: string, o: SpeakOptions): SpeakHandle {
        asked.push(text);
        if (!hang) { o.onStart?.(); return { done: Promise.resolve('ended' as SpeakOutcome), cancel: () => undefined }; }
        let end!: (x: SpeakOutcome) => void; const done = new Promise<SpeakOutcome>((r) => { end = r; }); return { done, cancel: () => end('cancelled') };
      },
      pause() {}, resume() {}, cancelAll() {},
    };
    const mac = device();
    const told: string[] = [];
    const v = new VoiceWithBackup(primary, mac, () => 'Daniel', (e) => told.push(e.message), 12_000, undefined, { steady: true });
    const h = v.speak('Never comes.', { voiceId: '', rate: 1 });
    // (the old Speechify rule gave up after 8 s and changed the voice: here it still waits)
    await vi.advanceTimersByTimeAsync(STEADY_START_TIMEOUT_MS - 1000);
    let over = false;
    void h.done.then(() => { over = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(over).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await h.done).toBe('ended');
    expect(mac.said).toEqual([]);
    expect(told).toEqual(['Speechify voice: no sound came in time. This sentence was not spoken.']);
    expect(v.failed).toBe(false);
    hang = false;
    expect(await v.speak('Here I am.', { voiceId: '', rate: 1 }).done).toBe('ended');
    expect(asked).toEqual(['Never comes.', 'Here I am.']);
    expect(v.silentInARow).toBe(0);
  });
  it('made ahead whatever happened before (the old voice stopped preparing while it "cooled")', () => {
    const got: string[] = [];
    const primary = { ...failing(silentErr('x')), prefetch: (t: string) => { got.push(t); }, readAhead: (ts: string[]) => { got.push(...ts); } } as unknown as TtsEngine;
    const v = new VoiceWithBackup(primary, device(), () => 'Daniel', () => undefined, 12_000, undefined, { steady: true });
    v.prefetch('A word', '', 1);
    v.readAhead(['Next.', 'After.'], '', 1);
    expect(got).toEqual(['A word', 'Next.', 'After.']);
  });
});

describe('the steady engine: the next TWO sentences are made ahead', () => {
  beforeEach(() => {
    G.Audio = FakeAudio;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:test/1');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); delete G.Audio; });
  it('readAhead of three sentences sends two (one sentence takes the Worker 3 to 5 s)', async () => {
    const e = cloudEngine('speechify', 'en', { steady: true });
    e.readAhead(['Next one.', 'After that.', 'And later.'], '', 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(speechifySent).toEqual(['Next one.', 'After that.']);
    // (they went to the Worker as the steady voice's requests)
    expect(speakCalls()).toHaveLength(2);
    e.stopReadAhead();
  });
});

describe('the voice log', () => {
  beforeEach(() => clearVoiceLog());
  it('a line: the time, what, why, how long, the first words of the text (never more than 40 letters)', () => {
    voiceLog('not spoken', { why: 'the Worker did not answer in time.', ms: 12_034, text: 'It means to feel a little worried about something that may happen soon.' });
    const [l] = voiceLogNow();
    expect(l.text).toBe('It means to feel a little worried about');
    expect(voiceLogLineText({ ...l, at: new Date(2026, 10, 28, 14, 3, 27).getTime() })).toBe('14:03:27 not spoken · the Worker did not answer in time. · 12.0 s · “It means to feel a little worried about”');
  });
  it('the saved lines and the new ones are one list: each line once, in the order of time, the newest kept', () => {
    const a = [{ at: 1, what: 'a' }, { at: 3, what: 'c' }];
    const b = [{ at: 2, what: 'b' }, { at: 3, what: 'c' }];
    expect(mergeVoiceLog(a, b).map((l) => l.what)).toEqual(['a', 'b', 'c']);
    const many = Array.from({ length: VOICE_LOG_MAX + 20 }, (_, i) => ({ at: i, what: `l${i}` }));
    const kept = mergeVoiceLog(many, []);
    expect(kept).toHaveLength(VOICE_LOG_MAX);
    expect(kept[0].what).toBe('l20');
  });
});

/** an audio element that plays until the test ends it; the test can pause it "from outside" (as iOS does) */
class LiveAudio {
  static last: LiveAudio | null = null;
  static refuse = false;
  preload = ''; preservesPitch = false; playbackRate = 1; volume = 1; currentTime = 0; duration = 2; paused = true; ended = false; error = null;
  plays = 0;
  onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null; onpause: (() => void) | null = null;
  constructor(public src = '') { LiveAudio.last = this; }
  load(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  play(): Promise<void> {
    this.plays++;
    if (LiveAudio.refuse && this.plays > 1) return Promise.reject(new DOMException('not allowed now', 'NotAllowedError'));
    this.paused = false;
    queueMicrotask(() => this.onplaying?.());
    return Promise.resolve();
  }
  pause(): void { this.paused = true; }
  /** iOS pauses the clip (not the tutor) */
  outsidePause(): void { this.paused = true; this.onpause?.(); }
  finish(): void { this.ended = true; this.paused = true; this.onpause?.(); this.onended?.(); }
}

describe('the steady engine: a sound that the device pauses from outside', () => {
  const W = globalThis as unknown as { __ytcSoundInterrupted?: boolean; requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  let lines: string[] = [];
  beforeEach(() => {
    G.Audio = LiveAudio; LiveAudio.last = null; LiveAudio.refuse = false; lines = [];
    W.requestAnimationFrame = () => 0; W.cancelAnimationFrame = () => undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:test/1');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    clearVoiceLog();
  });
  afterEach(() => { vi.restoreAllMocks(); delete G.Audio; delete W.__ytcSoundInterrupted; delete W.requestAnimationFrame; delete W.cancelAnimationFrame; });
  const start = async () => {
    const e = cloudEngine('speechify', 'en', { steady: true });
    const h = e.speak('A sentence that is being said.', { voiceId: '', rate: 1 });
    await vi.advanceTimersByTimeAsync(30);
    const a = LiveAudio.last!;
    let out: SpeakOutcome | null = null;
    void h.done.then((o) => { out = o; });
    return { e, h, a, out: () => out };
  };
  const whats = () => voiceLogNow().map((l) => l.what);

  it('is started again by itself, and the sentence is said to its end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { h, a, out } = await start();
    expect(a.plays).toBe(1);
    a.outsidePause();
    await vi.advanceTimersByTimeAsync(300);
    expect(a.plays).toBe(2);
    expect(a.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(out()).toBe(null);
    a.finish();
    expect(await h.done).toBe('ended');
    expect(whats()).toEqual(['paused from outside', 'started again']);
  });
  it('that will not go on: given up after 3 s (nothing waits for ever), with the reason in the log', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    LiveAudio.refuse = true;
    const { h, a } = await start();
    a.outsidePause();
    await vi.advanceTimersByTimeAsync(300 + 3100);
    expect(await h.done).toBe('error');
    expect(h.error?.message).toMatch(/paused the sound and it would not go on/);
    expect(whats()).toEqual(['paused from outside', 'could not start again', 'given up']);
  });
  it('the tutor\'s own pause is not one (the learner paused the teacher): nothing is started again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { e, a } = await start();
    e.pause();
    a.onpause?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(a.plays).toBe(1);
    expect(whats()).toEqual([]);
    e.cancelAll();
  });
  it('a phone call or Siri has the sound: the clip waits for the end of it, then goes on (it is not skipped)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    LiveAudio.refuse = true;
    const { h, a, out } = await start();
    W.__ytcSoundInterrupted = true;
    a.outsidePause();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(out()).toBe(null);
    // the call is over
    W.__ytcSoundInterrupted = false;
    LiveAudio.refuse = false;
    await vi.advanceTimersByTimeAsync(1100);
    expect(a.paused).toBe(false);
    a.finish();
    expect(await h.done).toBe('ended');
    expect(whats().at(-1)).toBe('started again');
  });
  it('the old engine (I Know Book) does nothing of this: a paused clip is left as it was', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const e = cloudEngine('speechify', 'en');
    e.speak('The old way.', { voiceId: '', rate: 1 });
    await vi.advanceTimersByTimeAsync(30);
    const a = LiveAudio.last!;
    expect(a.onpause).toBe(null);
    e.cancelAll();
  });
});
