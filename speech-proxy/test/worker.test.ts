/**
 * The speech proxy with a fake Cloudflare (KV, Cache API, waitUntil) and a fake Speechify (global fetch mocked):
 * no network, no real key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { pickDefaultVoice, marksToTimings, sameSecret, originAllowed, type Env, type KVLike, type SpeechifyVoice } from '../src/index';

const CODE = 'test-app-code-0123456789abcdef';

class FakeKV implements KVLike {
  data = new Map<string, string>();
  writes = 0;
  async get(k: string) { return this.data.get(k) ?? null; }
  async put(k: string, v: string) { this.writes++; this.data.set(k, v); }
}
class FakeCache {
  data = new Map<string, Response>();
  async match(req: Request) { const r = this.data.get(req.url); return r ? r.clone() : undefined; }
  async put(req: Request, res: Response) { if (req.method !== 'GET') throw new Error('GET only'); this.data.set(req.url, res.clone()); }
}

const VOICES: SpeechifyVoice[] = [
  { id: 'us-1', display_name: 'Ava', locale: 'en-US', gender: 'female', type: 'shared', staff_pick_rank: 1, models: [{ name: 'simba-3.5' }] },
  { id: 'gb-clone', display_name: 'My clone', locale: 'en-GB', gender: 'male', type: 'personal', staff_pick_rank: 1 },
  { id: 'gb-2', display_name: 'Oliver', locale: 'en-GB', gender: 'male', type: 'shared', tags: ['timbre:deep'], models: [{ name: 'simba-3.5' }] },
  { id: 'gb-1', display_name: 'Emma', locale: 'en-GB', gender: 'female', type: 'shared', staff_pick_rank: 2, tags: ['use-case:audiobook'], models: [{ name: 'simba-3.5' }] },
  { id: 'fr-1', display_name: 'Amélie', locale: 'fr-FR', gender: 'female', type: 'shared', staff_pick_rank: 1 },
];

let kv: FakeKV, cache: FakeCache, env: Env, waits: Promise<unknown>[];
let speechCalls: { url: string; body: Record<string, unknown> | null; auth: string | null }[];
let speechAnswer: () => Response;
const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };

const okSpeech = (text: string) => new Response(JSON.stringify({
  audio_data: btoa('ID3fake-mp3'), audio_format: 'mp3', billable_characters_count: text.length,
  speech_marks: { type: 'sentence', start: 0, end: text.length, start_time: 0, end_time: 900, chunks: [{ type: 'word', start: 0, end: 5, start_time: 0, end_time: 400, value: 'Hello' }, { type: 'word', start: 6, end: 12, start_time: 450, end_time: 900, value: 'world.' }] },
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  kv = new FakeKV(); cache = new FakeCache(); waits = []; speechCalls = [];
  (globalThis as unknown as { caches: unknown }).caches = { default: cache };
  env = { SPEECHIFY_API_KEY: 'sk_test_key', APP_CODE: CODE, USAGE: kv, DAILY_CHAR_LIMIT: '100', DEFAULT_VOICE: '', MODEL: 'simba-3.5' };
  speechAnswer = () => okSpeech('Hello world.');
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = new Headers(init?.headers).get('Authorization');
    if (url.includes('/v1/voices')) { speechCalls.push({ url, body: null, auth }); return new Response(JSON.stringify({ voices: VOICES, has_more: false, next_cursor: null }), { status: 200 }); }
    if (url.endsWith('/v1/audio/speech')) { speechCalls.push({ url, body: JSON.parse(String(init?.body)), auth }); return speechAnswer(); }
    return new Response('not here', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const call = async (path: string, o: { method?: string; code?: string | null; body?: unknown; origin?: string } = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (o.code !== null) headers['X-App-Code'] = o.code ?? CODE;
  if (o.origin) headers.Origin = o.origin;
  const res = await worker.fetch(new Request(`https://iknow-speech.example.workers.dev${path}`, { method: o.method ?? (o.body ? 'POST' : 'GET'), headers, body: o.body ? JSON.stringify(o.body) : undefined }), env, ctx);
  await Promise.all(waits.splice(0));
  return res;
};
const speechOnly = () => speechCalls.filter((c) => c.url.endsWith('/v1/audio/speech'));
const usage = async () => (await (await call('/usage')).json()) as { today: number; monthChars: number; requestsToday: number; left: number };

describe('auth', () => {
  it('refuses a request without the app code, or with a wrong one (401), and calls nobody', async () => {
    expect((await call('/health', { code: null })).status).toBe(401);
    const wrong = await call('/speak', { code: 'nope', body: { text: 'Hello world.' } });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { code: string }).code).toBe('auth');
    expect(speechCalls).toHaveLength(0);
  });
  it('lets the right app code in', async () => {
    const r = await call('/health');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });
  it('never lets anything in when APP_CODE is not set (even an empty code)', async () => {
    env.APP_CODE = '';
    const r = await call('/health', { code: '' });
    expect(r.status).toBe(500);
    expect(((await r.json()) as { code: string }).code).toBe('not-set-up');
  });
  it('compares the code in constant time (hash first) and exactly', async () => {
    expect(await sameSecret(CODE, CODE)).toBe(true);
    expect(await sameSecret(CODE.slice(0, -1), CODE)).toBe(false);
    expect(await sameSecret('', CODE)).toBe(false);
  });
});

describe('CORS', () => {
  it('no Origin (the iPhone app\'s own fetch) is fine; the apps\' pages get CORS headers; other sites get 403', async () => {
    expect((await call('/health')).headers.get('Access-Control-Allow-Origin')).toBeNull();
    const app = await call('/health', { origin: 'ytlearn://app' });
    expect(app.headers.get('Access-Control-Allow-Origin')).toBe('ytlearn://app');
    const pre = await call('/speak', { method: 'OPTIONS', code: null, origin: 'ytlearn://app' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('X-App-Code');
    expect((await call('/health', { origin: 'https://evil.example' })).status).toBe(403);
    expect(originAllowed('chrome-extension://abcdef', env)).toBe(true);
  });
});

describe('/speak', () => {
  it('says the text in the British default voice, counts the billed characters, keeps the clip', async () => {
    const r = await call('/speak', { body: { text: 'Hello world.' } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { audio: string; mime: string; chars: number; cached: boolean; voice: string; model: string; marks: { start: number; end: number; charIndex: number; charLength: number }[] };
    expect(j).toMatchObject({ mime: 'audio/mpeg', chars: 12, cached: false, voice: 'gb-1', model: 'simba-3.5' });
    expect(atob(j.audio)).toBe('ID3fake-mp3');
    expect(j.marks).toEqual([{ start: 0, end: 0.4, charIndex: 0, charLength: 5 }, { start: 0.45, end: 0.9, charIndex: 6, charLength: 6 }]);
    const sent = speechOnly()[0];
    expect(sent.auth).toBe('Bearer sk_test_key');
    expect(sent.body).toMatchObject({ input: 'Hello world.', voice_id: 'gb-1', audio_format: 'mp3', model: 'simba-3.5' });
    expect(r.headers.get('X-Chars-Billed')).toBe('12');
    expect(await usage()).toMatchObject({ today: 12, monthChars: 12, requestsToday: 1, left: 88 });
    expect(kv.writes).toBe(1);
  });

  it('a cache hit makes no Speechify call and counts nothing (the same text is never paid twice)', async () => {
    await call('/speak', { body: { text: 'Hello world.', voice: 'gb-2' } });
    const before = speechOnly().length, writes = kv.writes;
    const again = await call('/speak', { body: { text: '  Hello world. ', voice: 'gb-2' } });
    const j = (await again.json()) as { chars: number; cached: boolean; audio: string };
    expect(j.cached).toBe(true);
    expect(j.chars).toBe(0);
    expect(atob(j.audio)).toBe('ID3fake-mp3');
    expect(again.headers.get('X-Cache')).toBe('HIT');
    expect(speechOnly().length).toBe(before);
    expect(kv.writes).toBe(writes);
    expect((await usage()).today).toBe(12);
  });

  it('another voice or another text is a new clip', async () => {
    await call('/speak', { body: { text: 'Hello world.', voice: 'gb-1' } });
    await call('/speak', { body: { text: 'Hello world.', voice: 'gb-2' } });
    await call('/speak', { body: { text: 'Hello there.', voice: 'gb-2' } });
    expect(speechOnly()).toHaveLength(3);
    expect((await usage()).today).toBe(36);
  });

  it('over the daily limit -> 429 daily-limit, Speechify is not called', async () => {
    env.DAILY_CHAR_LIMIT = '20';
    expect((await call('/speak', { body: { text: 'Hello world.' } })).status).toBe(200);
    const r = await call('/speak', { body: { text: 'Hello again!' } });
    expect(r.status).toBe(429);
    expect(((await r.json()) as { code: string }).code).toBe('daily-limit');
    expect(speechOnly()).toHaveLength(1);
    // (a clip made before still plays: it costs nothing)
    expect((await call('/speak', { body: { text: 'Hello world.' } })).status).toBe(200);
  });

  it('the counter starts again on a new UTC day, and the month adds up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T23:59:00Z'));
    await call('/speak', { body: { text: 'Hello world.' } });
    vi.setSystemTime(new Date('2026-11-26T00:01:00Z'));
    await call('/speak', { body: { text: 'Second day.' } });
    expect(await usage()).toMatchObject({ today: 12, monthChars: 24, requestsToday: 1 });
  });

  it('refuses empty and too long text', async () => {
    const empty = await call('/speak', { body: { text: '   ' } });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { code: string }).code).toBe('empty');
    env.MAX_TEXT_CHARS = '10';
    const long = await call('/speak', { body: { text: 'This is far too long.' } });
    expect(long.status).toBe(413);
    expect(speechOnly()).toHaveLength(0);
  });

  it('a Speechify error -> 502 with a clear message, nothing counted or kept', async () => {
    speechAnswer = () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'bad key' } }), { status: 401 });
    const r = await call('/speak', { body: { text: 'Hello world.' } });
    expect(r.status).toBe(502);
    const j = (await r.json()) as { code: string; error: string; upstream: number };
    expect(j.code).toBe('speechify');
    expect(j.upstream).toBe(401);
    expect(j.error).toMatch(/did not accept the API key/);
    expect(kv.writes).toBe(0);
    speechAnswer = () => new Response('oops', { status: 500 });
    const r2 = await call('/speak', { body: { text: 'Hello world.' } });
    expect(r2.status).toBe(502);
    expect(((await r2.json()) as { error: string }).error).toMatch(/HTTP 500/);
    expect([...cache.data.keys()].some((k) => k.includes('/clip/'))).toBe(false);
  });

  it('DEFAULT_VOICE wins over the automatic pick; Chinese asks for zh-CN', async () => {
    env.DEFAULT_VOICE = 'gb-2';
    await call('/speak', { body: { text: '你好', lang: 'zh' } });
    expect(speechOnly()[0].body).toMatchObject({ voice_id: 'gb-2', language: 'zh-CN' });
  });
});

describe('voices', () => {
  it('picks the first natural British voice: Speechify\'s staff pick, never a personal clone, never another accent', () => {
    expect(pickDefaultVoice(VOICES)?.id).toBe('gb-1');
    expect(pickDefaultVoice(VOICES.filter((v) => v.id !== 'gb-1'))?.id).toBe('gb-2');
    expect(pickDefaultVoice(VOICES.filter((v) => !v.locale?.startsWith('en-GB')))).toBeNull();
  });
  it('GET /voices: English only, the British default first and marked; the Speechify list is asked once a day', async () => {
    const j = (await (await call('/voices')).json()) as { default: string; voices: { id: string; isDefault: boolean; british: boolean }[] };
    expect(j.default).toBe('gb-1');
    expect(j.voices[0]).toMatchObject({ id: 'gb-1', isDefault: true, british: true });
    expect(j.voices.map((v) => v.id)).not.toContain('fr-1');
    expect(j.voices.map((v) => v.id)).toContain('us-1');
    await call('/voices');
    await call('/speak', { body: { text: 'Hello world.' } });
    expect(speechCalls.filter((c) => c.url.includes('/v1/voices'))).toHaveLength(1);
  });
  it('follows the pages of the Speechify list', async () => {
    let page = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      page++;
      return new Response(JSON.stringify(page === 1 ? { voices: [VOICES[0]], has_more: true, next_cursor: 'c2' } : { voices: [VOICES[3]], has_more: false, next_cursor: null }), { status: 200 });
    }));
    const j = (await (await call('/voices')).json()) as { default: string; voices: unknown[] };
    expect(page).toBe(2);
    expect(j.default).toBe('gb-1');
    expect(j.voices).toHaveLength(2);
  });
});

describe('speech marks', () => {
  it('ms or s, exclusive or inclusive ends', () => {
    const text = 'Hi there';
    expect(marksToTimings({ chunks: [{ type: 'word', start: 0, end: 2, start_time: 0, end_time: 300, value: 'Hi' }] }, text)).toEqual([{ start: 0, end: 0.3, charIndex: 0, charLength: 2 }]);
    expect(marksToTimings({ chunks: [{ type: 'word', start: 0, end: 1, start_time: 0, end_time: 0.3, value: 'Hi' }] }, text)).toEqual([{ start: 0, end: 0.3, charIndex: 0, charLength: 2 }]);
    expect(marksToTimings(null, text)).toBeNull();
  });
});
