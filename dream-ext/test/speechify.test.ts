/**
 * The Speechify voice (through the learner's own Worker, speech-proxy/) as both apps use it: the Worker gets the app
 * code, never a Speechify key; every clip is kept on the device (paid once); only characters really billed are counted;
 * the daily limit (the app's, or the Worker's 'daily-limit') = the free iPhone voice until tomorrow; any error = the
 * iPhone voice for that sentence at once, with one short message; only the next sentence is made ahead; 'auto' takes
 * Speechify first when the address and the app code are set; pages that do not ask for it never get it.
 * The Worker is a stand-in here (a made-up fetch), and so is the device's clip store (IndexedDB).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { synthesize, speechifySent, speechifyVoices, speechifyServerUsage, testSpeechify, soundKey } from '../src/bg';
import { SPEECHIFY_LIMIT } from '../src/tts-cache';
import { VoiceWithBackup, cloudEngine, resolveVoice, ttsError, isBusy, speechifyVoiceList, speechifyVoiceName, SPEECHIFY_LABEL } from '../src/voice';
import { DEFAULT_EXTRAS, getSpeechifyUsage, speechifyUsageText, localDay } from '../src/store';
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
let answer: (c: Call) => Response;
const okClip = (c: Call) => {
  const text = String(c.body?.text ?? '');
  return new Response(JSON.stringify({ audio: 'SUQzZmFrZQ==', mime: 'audio/mpeg', format: 'mp3', chars: text.length, cached: false, voice: 'gb-1', model: 'simba-3.5', marks: [{ start: 0, end: 0.4, charIndex: 0, charLength: 5 }] }), { status: 200 });
};
const json = (t: string): Record<string, unknown> | null => { try { return JSON.parse(t) as Record<string, unknown>; } catch { return null; } };
const speakCalls = () => calls.filter((c) => c.url.endsWith('/speak'));

beforeEach(() => {
  calls = [];
  speechifySent.length = 0;
  for (const s of idbStores.values()) s.clear();
  stored = { drKeys: { speechify: CODE, azure: 'test-azure-key' }, drExtras: { speechifyUrl: `${URL_}/` } };
  G.chrome = {
    storage: { local: {
      get: async (k: string) => (k in stored ? { [k]: JSON.parse(JSON.stringify(stored[k])) } : {}),
      set: async (o: Record<string, unknown>) => { Object.assign(stored, JSON.parse(JSON.stringify(o))); },
    } },
    // (the page's voice asks the background, as in the app)
    runtime: { sendMessage: async (m: { type: string }) => (m.type === 'dream-tts' ? synthesize(m as never).catch((e: Error & { code?: string; note?: string }) => ({ error: e.message, code: e.code, note: e.note })) : m.type === 'dream-speechify-voices' ? speechifyVoices().catch((e: Error) => ({ error: e.message })) : undefined) },
  };
  answer = okClip;
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? json(init.body) : null };
    calls.push(c);
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
    // (kept under the voice and the text, in the store of long clips: any length)
    expect(idbStores.get('clips')?.has(soundKey({ engine: 'speechify', voice: '' }, 'Hello world.', 'best'))).toBe(true);
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
    const e = await failOf(say('Hello again, friend.'));
    expect(e?.message).toBe(SPEECHIFY_LIMIT);
    expect(isBusy(e)).toBe(true);
    expect(speakCalls()).toHaveLength(1);
    // (done for today: even a short one is not sent any more)
    expect(await failOf(say('Hi.'))).not.toBeNull();
    expect(speakCalls()).toHaveLength(1);
    expect((await getSpeechifyUsage()).stopped).toBe(true);
    expect((await say('Hello world.')).b64).toBe('SUQzZmFrZQ==');
    // tomorrow: Speechify again
    vi.setSystemTime(new Date(2026, 10, 27, 9, 0));
    await say('Hi.');
    expect(speakCalls()).toHaveLength(2);
  });
  it('the Worker\'s 429 daily-limit: no more requests today', async () => {
    answer = () => new Response(JSON.stringify({ code: 'daily-limit', error: 'limit' }), { status: 429 });
    const e = await failOf(say('Hello world.'));
    expect(e?.message).toBe(SPEECHIFY_LIMIT);
    answer = okClip;
    expect(await failOf(say('Another one.'))).not.toBeNull();
    expect(speakCalls()).toHaveLength(1);
    expect(stored.drSpeechifyStop).toBe(localDay());
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
