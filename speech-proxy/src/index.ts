/**
 * The speech proxy of I Know (YouTube) and I Know Book: a small Cloudflare Worker between the two apps and Speechify.
 *
 * - The Speechify API key lives ONLY here, as the secret SPEECHIFY_API_KEY. The apps never see it.
 * - Every request must carry the header X-App-Code equal to the secret APP_CODE (compared in constant time), else 401.
 * - POST /speak {text, voice?, format?, lang?} -> JSON {audio (base64), mime, format, chars, cached, voice, model, marks}
 *   (`chars` = characters Speechify billed for this request; 0 when the clip came from the cache)
 * - GET /voices -> {default, voices: [...]} (English voices, British first; the Speechify list is cached for a day)
 * - GET /usage  -> {day, today, month, monthChars, requestsToday, dailyLimit, left} (as this Worker counts them, UTC days)
 * - GET /health -> {ok: true, model, voice, version, ...} (also needs the app code: it proves the address AND the code are right)
 *
 * `version` (in /speak, /voices and /health) = "MODEL|default voice": the apps keep their clips under it, so a new
 * MODEL or DEFAULT_VOICE is never answered with an old clip.
 *
 * Money rules: a finished clip is kept in the Cache API under SHA-256(voice | model | format | lang | text), so the
 * same text is never paid twice, from either app; a cached clip counts nothing. The characters are counted by ONE
 * Durable Object (UsageCounter, SQLite): a request first RESERVES its characters there (one step, so two requests at
 * the same moment can never both pass the limit), then Speechify is called; afterwards the reservation becomes the
 * billed characters, or is given back when Speechify failed. Over DAILY_CHAR_LIMIT -> 429 {code: 'daily-limit',
 * resetAt}; the apps then use the free iPhone voice until resetAt (the next UTC midnight).
 */

/** what a Durable Object namespace gives (only what is used here) */
export interface CounterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}
/** the SQLite of a Durable Object (ctx.storage.sql; only what is used here) */
export interface SqlLike { exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] } }
export interface CounterState { storage: { sql: SqlLike } }
export interface CacheLike {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
}
export interface Ctx { waitUntil(p: Promise<unknown>): void }

export interface Env {
  /** secret: the Speechify API key (wrangler secret put SPEECHIFY_API_KEY) */
  SPEECHIFY_API_KEY?: string;
  /** secret: the private code both apps send in X-App-Code (wrangler secret put APP_CODE) */
  APP_CODE?: string;
  /** the Durable Object that counts the characters (wrangler.toml: [[durable_objects.bindings]] USAGE_COUNTER) */
  USAGE_COUNTER: CounterNamespace;
  /** characters Speechify may bill per UTC day (default 20000) */
  DAILY_CHAR_LIMIT?: string;
  /** a Speechify voice id; empty = the first natural British English voice of GET /v1/voices */
  DEFAULT_VOICE?: string;
  /** Speechify model (default simba-3.5) */
  MODEL?: string;
  /** most characters in one request (default 2000 = Speechify's own limit of /v1/audio/speech) */
  MAX_TEXT_CHARS?: string;
  /** browser origins allowed (comma list; an entry ending in * is a prefix; "*" = all). Requests with no Origin are always fine. */
  ALLOWED_ORIGINS?: string;
  /** optional Speechify output_format such as mp3_24000_64 (empty = audio_format only) */
  OUTPUT_FORMAT?: string;
  /** tests only: another address for Speechify */
  SPEECHIFY_BASE?: string;
}

const SPEECHIFY = 'https://api.speechify.ai';
/** where the Worker keeps things in the Cache API (never fetched: only a name) */
const CACHE_HOST = 'https://speech-proxy.cache';
const DEFAULT_ORIGINS = 'ytlearn://app,null,https://www.youtube.com,https://m.youtube.com,chrome-extension://*';
const FORMATS: Record<string, string> = { mp3: 'audio/mpeg', ogg: 'audio/ogg', aac: 'audio/aac', wav: 'audio/wav' };
const VOICES_TTL = 86_400;
const CLIP_TTL = 365 * 86_400;

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};
export const dailyLimit = (env: Env): number => num(env.DAILY_CHAR_LIMIT, 20_000);
const maxChars = (env: Env): number => num(env.MAX_TEXT_CHARS, 2000) || 2000;
const modelOf = (env: Env): string => (env.MODEL ?? '').trim() || 'simba-3.5';
const base = (env: Env): string => (env.SPEECHIFY_BASE ?? '').trim().replace(/\/+$/, '') || SPEECHIFY;

function clipCache(): CacheLike | null {
  const c = (globalThis as unknown as { caches?: { default?: CacheLike } }).caches;
  return c?.default ?? null;
}

// ---- auth and CORS ------------------------------------------------------------------------------------------------
/** constant time: both sides are hashed first, so neither the length nor the first wrong letter shows in the time */
export async function sameSecret(given: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(secret))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function originAllowed(origin: string, env: Env): boolean {
  const list = (env.ALLOWED_ORIGINS?.trim() || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  return list.some((o) => o === '*' || o === origin || (o.endsWith('*') && origin.startsWith(o.slice(0, -1))));
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Code',
    'Access-Control-Expose-Headers': 'X-Cache, X-Chars-Billed',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}
const fail = (status: number, code: string, message: string, extra: Record<string, string> = {}) => json({ error: message, code }, status, extra);

// ---- the counter: one Durable Object with its own SQLite (free plan), one row per UTC day ----------------------------
export interface MonthUsage { days: Record<string, number>; requests: Record<string, number> }
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
/** the next UTC midnight (when the daily limit starts again) */
export const nextUtcMidnight = (d: Date): string => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();

/**
 * The character counter. A Durable Object runs one request at a time, and SQLite here is synchronous: between the
 * check and the write of /reserve nothing else can run, so two requests can never both take the last characters.
 *  POST /reserve {day, chars, limit} -> {ok, today}  (ok false = it does not fit: nothing is taken)
 *  POST /settle  {day, reserved, billed}             (the reservation becomes what Speechify billed; one request more)
 *  POST /release {day, reserved}                     (Speechify failed: the characters are given back)
 *  GET  /usage?day=YYYY-MM-DD                        -> {days, requests} of that month
 */
export class UsageCounter {
  private sql: SqlLike;
  constructor(state: CounterState, _env?: unknown) {
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, chars INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0)');
  }
  private charsOf(day: string): number {
    const row = this.sql.exec('SELECT chars FROM days WHERE day = ?', day).toArray()[0];
    return row ? Number(row.chars) || 0 : 0;
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // (the body is read FIRST: after this line there is no await, so each step below is one piece)
    const b = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as { day?: string; chars?: number; limit?: number; reserved?: number; billed?: number }) : {};
    const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
    const day = String(b.day ?? url.searchParams.get('day') ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'day' }, 400);
    if (url.pathname === '/reserve') {
      const now = this.charsOf(day), chars = n(b.chars);
      if (now + chars > n(b.limit)) return json({ ok: false, today: now }, 200);
      this.sql.exec('INSERT INTO days (day, chars, requests) VALUES (?, ?, 0) ON CONFLICT(day) DO UPDATE SET chars = chars + excluded.chars', day, chars);
      return json({ ok: true, today: now + chars }, 200);
    }
    if (url.pathname === '/settle') {
      this.sql.exec('INSERT INTO days (day, chars, requests) VALUES (?, ?, 1) ON CONFLICT(day) DO UPDATE SET chars = MAX(0, chars - ? + ?), requests = requests + 1', day, n(b.billed), n(b.reserved), n(b.billed));
      // (rows older than about 13 months are not needed any more)
      this.sql.exec('DELETE FROM days WHERE day < ?', utcDay(new Date(Date.parse(`${day}T00:00:00Z`) - 400 * 86_400_000)));
      return json({ ok: true }, 200);
    }
    if (url.pathname === '/release') {
      this.sql.exec('UPDATE days SET chars = MAX(0, chars - ?) WHERE day = ?', n(b.reserved), day);
      return json({ ok: true }, 200);
    }
    if (url.pathname === '/usage') {
      const m: MonthUsage = { days: {}, requests: {} };
      for (const r of this.sql.exec('SELECT day, chars, requests FROM days WHERE day >= ? AND day <= ?', `${day.slice(0, 7)}-01`, `${day.slice(0, 7)}-31`).toArray()) {
        m.days[String(r.day)] = Number(r.chars) || 0;
        m.requests[String(r.day)] = Number(r.requests) || 0;
      }
      return json(m, 200);
    }
    return json({ error: 'not-found' }, 404);
  }
}

/** one call to the counter (the Worker's only Durable Object, named "usage") */
async function counter(env: Env, path: string, body?: Record<string, unknown>): Promise<Response> {
  const stub = env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName('usage'));
  return stub.fetch(new Request(`https://usage-counter${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}));
}

async function readMonth(env: Env, now: Date): Promise<MonthUsage> {
  try {
    const v = (await (await counter(env, `/usage?day=${utcDay(now)}`)).json()) as Partial<MonthUsage>;
    return { days: { ...(v.days ?? {}) }, requests: { ...(v.requests ?? {}) } };
  } catch { return { days: {}, requests: {} }; }
}

export function usageView(m: MonthUsage, env: Env, now: Date) {
  const day = utcDay(now);
  const today = m.days[day] ?? 0;
  const limit = dailyLimit(env);
  return { day, today, month: day.slice(0, 7), monthChars: Object.values(m.days).reduce((a, b) => a + b, 0), requestsToday: m.requests[day] ?? 0, dailyLimit: limit, left: Math.max(0, limit - today) };
}

// ---- voices ---------------------------------------------------------------------------------------------------------
export interface SpeechifyVoice {
  id: string; display_name?: string; locale?: string; gender?: string; tags?: string[] | null; type?: string;
  models?: { name: string; languages?: { locale?: string; preview_audio?: string | null }[] }[];
  preview_audio?: string | null; staff_pick_rank?: number;
}

const localesOf = (v: SpeechifyVoice): string[] => [v.locale ?? '', ...(v.models ?? []).flatMap((m) => (m.languages ?? []).map((l) => l.locale ?? ''))].filter(Boolean).map((l) => l.toLowerCase());
export const isBritish = (v: SpeechifyVoice): boolean => (v.locale ?? '').toLowerCase().startsWith('en-gb') || (!v.locale && localesOf(v).some((l) => l.startsWith('en-gb')));
export const isEnglish = (v: SpeechifyVoice): boolean => localesOf(v).some((l) => l === 'en' || l.startsWith('en-'));
const NATURAL = /natural|conversational|warm|narrat|audiobook|calm|soft/i;

/** lower = better: Speechify's own staff picks first (rank 1 = their first pick), then "natural"-type tags, then the model */
function rank(v: SpeechifyVoice, model: string): number {
  const staff = typeof v.staff_pick_rank === 'number' && v.staff_pick_rank > 0 ? v.staff_pick_rank : 1000;
  const natural = (v.tags ?? []).some((t) => NATURAL.test(t)) ? 0 : 0.5;
  const fits = !v.models?.length || v.models.some((m) => m.name === model) ? 0 : 0.25;
  return staff + natural + fits;
}

/** the British English voice used when the app names none: shared voices only (never someone's own clone) */
export function pickDefaultVoice(voices: SpeechifyVoice[], model = 'simba-3.5'): SpeechifyVoice | null {
  const gb = voices.filter((v) => v.id && v.type !== 'personal' && isBritish(v));
  if (!gb.length) return null;
  return gb.map((v, i) => ({ v, i, r: rank(v, model) })).sort((a, b) => a.r - b.r || a.i - b.i)[0].v;
}

class Upstream extends Error { constructor(message: string, readonly status: number, readonly code = 'speechify') { super(message); } }

async function upstreamError(res: Response, what: string): Promise<Upstream> {
  let code = '', message = '';
  try { const j = (await res.json()) as { error?: { code?: string; message?: string } | string; message?: string }; if (typeof j.error === 'object') { code = j.error.code ?? ''; message = j.error.message ?? ''; } else { message = j.error ?? j.message ?? ''; } } catch { /* no JSON */ }
  const why = res.status === 401 || res.status === 403 ? 'Speechify did not accept the API key (check the secret SPEECHIFY_API_KEY)'
    : res.status === 402 ? 'Speechify: no characters left on the Speechify account (free amount used, or no credit)'
    : res.status === 429 ? 'Speechify is busy (too many requests): try again in a moment'
    : `Speechify ${what} failed (HTTP ${res.status}${code ? `, ${code}` : ''})`;
  return new Upstream(message ? `${why}: ${message.slice(0, 200)}` : why, res.status);
}

async function loadVoices(env: Env, ctx: Ctx): Promise<SpeechifyVoice[]> {
  const cache = clipCache();
  const key = new Request(`${CACHE_HOST}/voices/v1`);
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return (await hit.json()) as SpeechifyVoice[];
  const all: SpeechifyVoice[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const url = `${base(env)}/v1/voices?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    let res: Response;
    try { res = await fetch(url, { headers: { Authorization: `Bearer ${env.SPEECHIFY_API_KEY}` } }); } catch (e) { throw new Upstream(`Speechify could not be reached: ${(e as Error).message}`, 0); }
    if (!res.ok) throw await upstreamError(res, 'voice list');
    const j = (await res.json()) as SpeechifyVoice[] | { voices?: SpeechifyVoice[]; has_more?: boolean; next_cursor?: string | null };
    if (Array.isArray(j)) { all.push(...j); break; }
    all.push(...(j.voices ?? []));
    if (!j.has_more || !j.next_cursor) break;
    cursor = j.next_cursor;
  }
  if (cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(all), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${VOICES_TTL}` } })).catch(() => undefined));
  return all;
}

export interface VoiceInfo { id: string; name: string; locale: string; gender: string; tags: string[]; preview: string | null; british: boolean; isDefault: boolean; models: string[] }

function voiceInfo(v: SpeechifyVoice, def: string | null): VoiceInfo {
  return { id: v.id, name: v.display_name ?? v.id, locale: v.locale ?? '', gender: v.gender ?? 'not_specified', tags: v.tags ?? [], preview: v.preview_audio ?? null, british: isBritish(v), isDefault: v.id === def, models: (v.models ?? []).map((m) => m.name) };
}

/** the voice of a request: the app's, else DEFAULT_VOICE, else the British pick; `def` = the default ('' = not known now) */
async function voiceFor(asked: string, env: Env, ctx: Ctx): Promise<{ id: string; voice: SpeechifyVoice | null; def: string }> {
  let voices: SpeechifyVoice[] = [];
  let listed = true;
  try { voices = await loadVoices(env, ctx); } catch (e) { listed = false; if (!asked && !env.DEFAULT_VOICE?.trim()) throw e; }
  const def = env.DEFAULT_VOICE?.trim() || (listed ? pickDefaultVoice(voices, modelOf(env))?.id ?? '' : '');
  const want = asked || env.DEFAULT_VOICE?.trim() || '';
  if (want) return { id: want, voice: voices.find((v) => v.id === want) ?? null, def };
  const pick = pickDefaultVoice(voices, modelOf(env));
  if (!pick) throw new Upstream('Speechify has no British English voice in its list: set DEFAULT_VOICE', 0);
  return { id: pick.id, voice: pick, def };
}

/** what the apps keep their clips under: the model and the default voice ('' when the default is not known now) */
export const versionOf = (env: Env, def: string): string => `${modelOf(env)}|${def}`;

/** the model asked for, unless the voice lists others only (then its first) */
const modelFor = (voice: SpeechifyVoice | null, model: string): string => (!voice?.models?.length || voice.models.some((m) => m.name === model) ? model : voice.models[0].name);

// ---- speech marks -> word times ---------------------------------------------------------------------------------------
interface Chunk { type?: string; start?: number; end?: number; start_time?: number; end_time?: number; value?: string }
export interface Timing { start: number; end: number; charIndex: number; charLength: number }

/**
 * Speechify's speech marks -> the word times the apps use (seconds, place in the text). The docs do not say whether the
 * times are ms or s: more than 1 unit per character for the whole text = ms. `end` is exclusive unless the word
 * shows that it is inclusive.
 */
export function marksToTimings(sm: { chunks?: Chunk[] } | null | undefined, text: string): Timing[] | null {
  const words = (sm?.chunks ?? []).filter((c) => (!c.type || c.type === 'word') && typeof c.start === 'number' && typeof c.end === 'number' && typeof c.start_time === 'number' && typeof c.end_time === 'number');
  if (!words.length) return null;
  const last = Math.max(...words.map((c) => c.end_time as number));
  const k = last / Math.max(1, text.length) > 1 ? 1 / 1000 : 1;
  return words.map((c) => {
    const s = c.start as number;
    let e = c.end as number;
    if (c.value && text.slice(s, e) !== c.value && text.slice(s, e + 1) === c.value) e += 1;
    return { start: (c.start_time as number) * k, end: (c.end_time as number) * k, charIndex: s, charLength: Math.max(1, e - s) };
  });
}

// ---- /speak -----------------------------------------------------------------------------------------------------------
async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** the Cache API name of a finished clip (a GET request: the Cache API keeps GET only) */
export async function clipKey(voice: string, model: string, format: string, lang: string, text: string): Promise<string> {
  return `${CACHE_HOST}/clip/${await sha256Hex(`${voice}|${model}|${format}|${lang}|${text}`)}`;
}

async function speak(req: Request, env: Env, ctx: Ctx, cors: Record<string, string>): Promise<Response> {
  let body: { text?: unknown; voice?: unknown; format?: unknown; lang?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return fail(400, 'bad-request', 'Send JSON: {"text": "..."}', cors); }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return fail(400, 'empty', 'No text to say', cors);
  const max = maxChars(env);
  if (text.length > max) return fail(413, 'too-long', `The text is too long (${text.length} characters, at most ${max} in one request)`, cors);
  const format = typeof body.format === 'string' && FORMATS[body.format] ? body.format : 'mp3';
  const lang = body.lang === 'zh' ? 'zh' : 'en';
  const asked = typeof body.voice === 'string' ? body.voice.trim().slice(0, 120) : '';

  let voiceId: string, model: string, version: string | undefined;
  try {
    const v = await voiceFor(asked, env, ctx);
    voiceId = v.id;
    model = modelFor(v.voice, modelOf(env));
    // (the default is not known when Speechify's voice list could not be read: no version then, the app keeps its own)
    version = v.def ? versionOf(env, v.def) : undefined;
  } catch (e) { return fail(502, 'speechify', (e as Error).message, cors); }

  // the same text in the same voice was made before (by either app): it is played again, nothing is paid or counted
  const cache = clipCache();
  const key = new Request(await clipKey(voiceId, model, format, lang, text));
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) {
    const kept = (await hit.json()) as Record<string, unknown>;
    return json({ ...kept, chars: 0, cached: true, ...(version ? { version } : {}) }, 200, { ...cors, 'X-Cache': 'HIT', 'X-Chars-Billed': '0' });
  }

  // the characters are reserved FIRST (one step in the counter): two requests at once cannot both pass the limit
  const now = new Date();
  const day = utcDay(now);
  const limit = dailyLimit(env);
  const reserved = text.length;
  let got: { ok?: boolean; today?: number };
  try { got = (await (await counter(env, '/reserve', { day, chars: reserved, limit })).json()) as typeof got; } catch (e) { return fail(500, 'counter', `The character counter did not answer: ${(e as Error).message}`, cors); }
  if (!got.ok) {
    const usage = usageView(await readMonth(env, now), env, now);
    return json({ error: `Today's Speechify limit is reached (${usage.today} of ${usage.dailyLimit} characters). The free iPhone voice reads until tomorrow (UTC).`, code: 'daily-limit', resetAt: nextUtcMidnight(now), ...usage }, 429, cors);
  }
  // (from here on, every way out settles or releases the reservation)
  const release = () => counter(env, '/release', { day, reserved }).catch((e) => console.error('reservation not given back', e));

  let res: Response;
  try {
    res = await fetch(`${base(env)}/v1/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SPEECHIFY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice_id: voiceId, audio_format: format, model, ...(lang === 'zh' ? { language: 'zh-CN' } : {}), ...(env.OUTPUT_FORMAT?.trim() ? { output_format: env.OUTPUT_FORMAT.trim() } : {}) }),
    });
  } catch (e) { await release(); return fail(502, 'speechify', `Speechify could not be reached: ${(e as Error).message}`, cors); }
  if (!res.ok) { await release(); const u = await upstreamError(res, 'speech'); return json({ error: u.message, code: 'speechify', upstream: res.status }, 502, cors); }
  let data: { audio_data?: string; audio_format?: string; billable_characters_count?: number; speech_marks?: { chunks?: Chunk[] } };
  // (an answer without sound: Speechify may still have billed it; the reservation stays as the count)
  try { data = (await res.json()) as typeof data; } catch { await counter(env, '/settle', { day, reserved, billed: reserved }).catch(() => undefined); return fail(502, 'speechify', 'Speechify sent an answer that is not JSON', cors); }
  const chars = typeof data.billable_characters_count === 'number' ? data.billable_characters_count : text.length;
  await counter(env, '/settle', { day, reserved, billed: chars }).catch((e) => console.error('usage not counted', e));
  if (!data.audio_data) return fail(502, 'speechify', 'Speechify sent no sound', cors);
  const out = { audio: data.audio_data, mime: FORMATS[data.audio_format ?? format] ?? FORMATS[format], format: data.audio_format ?? format, chars, cached: false, voice: voiceId, model, ...(version ? { version } : {}), marks: marksToTimings(data.speech_marks, text) };

  if (cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify({ ...out, chars: 0 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CLIP_TTL}` } })).catch(() => undefined));
  return json(out, 200, { ...cors, 'X-Cache': 'MISS', 'X-Chars-Billed': String(chars) });
}

// ---- the router ---------------------------------------------------------------------------------------------------------
export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const origin = req.headers.get('Origin');
    // (the iPhone app's own fetch sends no Origin; a browser page does: only the apps' pages may use this from a browser)
    if (origin !== null && !originAllowed(origin, env)) return fail(403, 'origin', 'This page may not use the speech proxy');
    const cors = corsHeaders(origin);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!env.APP_CODE || !env.SPEECHIFY_API_KEY) return fail(500, 'not-set-up', `The Worker is not set up yet: the secret ${!env.APP_CODE ? 'APP_CODE' : 'SPEECHIFY_API_KEY'} is missing (see SETUP.md)`, cors);
    if (!(await sameSecret(req.headers.get('X-App-Code') ?? '', env.APP_CODE))) return fail(401, 'auth', 'App code missing or wrong', cors);

    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/speak') return req.method === 'POST' ? await speak(req, env, ctx, cors) : fail(405, 'method', 'Use POST', cors);
      if (req.method !== 'GET') return fail(405, 'method', 'Use GET', cors);
      if (path === '/health') {
        // (the default voice too, for the apps' clip names; the voice list is free and kept for a day)
        let def = env.DEFAULT_VOICE?.trim() || '';
        if (!def) { try { def = pickDefaultVoice(await loadVoices(env, ctx), modelOf(env))?.id ?? ''; } catch { /* not known now */ } }
        return json({ ok: true, model: modelOf(env), dailyLimit: dailyLimit(env), voice: def || null, ...(def ? { version: versionOf(env, def) } : {}) }, 200, cors);
      }
      if (path === '/usage') { const now = new Date(); return json(usageView(await readMonth(env, now), env, now), 200, cors); }
      if (path === '/voices') {
        const all = await loadVoices(env, ctx);
        const def = env.DEFAULT_VOICE?.trim() || pickDefaultVoice(all, modelOf(env))?.id || null;
        const every = new URL(req.url).searchParams.get('all') === '1';
        const list = all.filter((v) => v.id && (every || isEnglish(v) || v.id === def));
        const model = modelOf(env);
        // the default first, then British voices (best first), then the other English voices
        const order = (v: SpeechifyVoice) => (v.id === def ? -1 : isBritish(v) ? rank(v, model) : 10_000 + rank(v, model));
        list.sort((a, b) => order(a) - order(b));
        return json({ default: def, model, ...(def ? { version: versionOf(env, def) } : {}), voices: list.map((v) => voiceInfo(v, def)) }, 200, cors);
      }
      return fail(404, 'not-found', 'Unknown address (use /speak, /voices, /usage or /health)', cors);
    } catch (e) {
      if (e instanceof Upstream) return fail(502, e.code, e.message, cors);
      return fail(500, 'error', `The Worker failed: ${(e as Error).message}`, cors);
    }
  },
};
