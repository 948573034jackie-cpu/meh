/**
 * The voice services as I Know Book asks for them: Microsoft's lighter sound, its free limit of 19 requests a minute
 * (a sentence that would wait is said by the device voice at once, with one short message), a paid key without that
 * limit, ElevenLabs' fast model by name with the times of the words, "Auto" without OpenAI. The YouTube tutor asks
 * for none of it, and gets what it got before.
 * The services are stand-ins on this computer (a made-up fetch, no key).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { azureTurn, resetAzureTurns, synthesize, AZURE_PER_MINUTE, AZURE_MAX_WAIT_MS, AZURE_FULL, AZURE_LIGHT, elevenModel, elevenBody, soundKey, alignmentTimings } from '../src/bg';
import { AZURE_BUSY } from '../src/tts-cache';
import { VoiceWithBackup, cloudEngine, resolveVoice, isBusy, BUSY_NOTE, BOOK_VOICE } from '../src/voice';
import { DEFAULT_EXTRAS } from '../src/store';
import type { TtsEngine, SpeakHandle, SpeakOptions, SpeakOutcome, WordTime } from '@core/tts/engine';

const G = globalThis as unknown as Record<string, unknown>;
let stored: Record<string, unknown> = {};
interface Call { url: string; headers: Record<string, string>; body: string }
let calls: Call[] = [];
const ALIGN = (text: string) => ({ characters: text.split(''), character_start_times_seconds: text.split('').map((_, i) => i * 0.1), character_end_times_seconds: text.split('').map((_, i) => (i + 1) * 0.1) });

beforeEach(() => {
  resetAzureTurns();
  calls = [];
  stored = { drKeys: { azure: 'test-azure-key', elevenlabs: 'test-eleven-key' }, drTestBaseUrls: { azure: 'http://azure.test', elevenlabs: 'http://eleven.test' } };
  G.chrome = { storage: { local: {
    get: async (k: string) => (k in stored ? { [k]: JSON.parse(JSON.stringify(stored[k])) } : {}),
    set: async (o: Record<string, unknown>) => { Object.assign(stored, JSON.parse(JSON.stringify(o))); },
  } } };
  vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    if (url.startsWith('http://azure.test')) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    const text = (JSON.parse(init.body) as { text: string }).text;
    return new Response(JSON.stringify({ audio_base64: 'AQID', alignment: ALIGN(text) }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); delete G.chrome; });

describe('Microsoft: the sound that is asked for', () => {
  it('I Know Book (light): 24 kHz / 96 kbit mp3; the YouTube tutor: 48 kHz / 192 kbit as before', async () => {
    const light = await synthesize({ engine: 'azure', text: 'Hello there.', voice: 'en-GB-AdaMultilingualNeural', light: true });
    const full = await synthesize({ engine: 'azure', text: 'Hello there.', voice: 'en-GB-AdaMultilingualNeural' });
    expect(calls.map((c) => c.headers['X-Microsoft-OutputFormat'])).toEqual(['audio-24khz-96kbitrate-mono-mp3', 'audio-48khz-192kbitrate-mono-mp3']);
    expect([AZURE_LIGHT, AZURE_FULL]).toEqual(['audio-24khz-96kbitrate-mono-mp3', 'audio-48khz-192kbitrate-mono-mp3']);
    expect(calls[0].url).toBe('http://azure.test/cognitiveservices/v1');
    expect(calls[0].headers['Ocp-Apim-Subscription-Key']).toBe('test-azure-key');
    expect(calls[0].body).toContain('<voice name="en-GB-AdaMultilingualNeural">Hello there.</voice>');
    expect(light).toEqual({ b64: 'AQIDBA==', mime: 'audio/mpeg', timings: null });
    expect(full.b64).toBe('AQIDBA==');
  });
  it('the two sounds are kept under two names; every other name is as it was', () => {
    const ask = { engine: 'azure' as const, voice: 'Ada', lang: 'en' as const };
    expect(soundKey(ask, 'word', 'best')).toBe('azure|Ada|en|best|word');
    expect(soundKey({ ...ask, light: true }, 'word', 'best')).toBe('azure|Ada|en|light|word');
    expect(soundKey({ engine: 'openai', voice: 'marin' }, 'word', 'best')).toBe('openai|marin|en|best|word');
    expect(soundKey({ engine: 'elevenlabs', voice: 'v', lang: 'zh' }, '词', 'best')).toBe('elevenlabs|v|zh|best|词');
    expect(soundKey({ engine: 'elevenlabs', voice: 'v' }, 'word', 'fast')).toBe('elevenlabs|v|en|fast|word');
    expect(soundKey({ engine: 'elevenlabs', voice: 'v', fast: true }, 'word', 'best')).toBe('elevenlabs|v|en|fast|word');
  });
});

describe('Microsoft\'s free limit: 19 requests a minute, and nothing waits in line', () => {
  it('a request that would wait more than about 1.5 s is refused at once, with a name the page knows', async () => {
    vi.useFakeTimers();
    try {
      const done: number[] = [];
      for (let i = 0; i < AZURE_PER_MINUTE; i++) void azureTurn(AZURE_MAX_WAIT_MS).then(() => done.push(i));
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveLength(19);
      const e = await azureTurn(AZURE_MAX_WAIT_MS).then(() => null, (x: Error & { code?: string }) => x);
      expect(e?.code).toBe('busy');
      expect(e?.message).toBe('Microsoft is busy (free keys allow 19 requests a minute)');
      expect(e?.message).toBe(AZURE_BUSY);
      expect(isBusy(e)).toBe(true);
      expect(AZURE_MAX_WAIT_MS).toBe(1500);
    } finally { vi.useRealTimers(); }
  });
  it('a refused request takes no turn; a short wait (under 1.5 s) is still waited for', async () => {
    vi.useFakeTimers();
    try {
      const turn = () => { const r = { went: false, refused: false }; void azureTurn(AZURE_MAX_WAIT_MS).then(() => { r.went = true; }, () => { r.refused = true; }); return r; };
      for (let i = 0; i < AZURE_PER_MINUTE; i++) turn();
      const many = Array.from({ length: 30 }, turn);
      await vi.advanceTimersByTimeAsync(1);
      expect(many.every((r) => r.refused)).toBe(true);
      // 58 s later the first turn is still 2 s from being free: refused
      await vi.advanceTimersByTimeAsync(58_000);
      const early = turn();
      await vi.advanceTimersByTimeAsync(1);
      expect(early.refused).toBe(true);
      // at 58.7 s it is 1.35 s away: this request waits for it, and goes when the minute is over
      await vi.advanceTimersByTimeAsync(699);
      const waits = turn();
      await vi.advanceTimersByTimeAsync(1000);
      expect(waits).toEqual({ went: false, refused: false });
      await vi.advanceTimersByTimeAsync(400);
      expect(waits.went).toBe(true);
      // the 31 refused requests took no turn: the new minute has room for 18 more beside the one that waited, not fewer
      const next = Array.from({ length: 18 }, turn);
      const over = turn();
      await vi.advanceTimersByTimeAsync(1);
      expect(next.every((r) => r.went)).toBe(true);
      expect(over.refused).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('never more than 19 in any minute, also with requests that waited', async () => {
    vi.useFakeTimers();
    try {
      const at: number[] = [];
      const t0 = Date.now();
      // a request every 2 s for 3 minutes (30 a minute are wanted): those with no room are refused
      for (let s = 0; s < 180; s += 2) {
        void azureTurn(AZURE_MAX_WAIT_MS).then(() => at.push(Date.now() - t0), () => undefined);
        await vi.advanceTimersByTimeAsync(2000);
      }
      expect(at.length).toBeGreaterThanOrEqual(19 * 2);
      for (const t of at) expect(at.filter((x) => x >= t && x < t + 60_000).length).toBeLessThanOrEqual(19);
    } finally { vi.useRealTimers(); }
  });
  it('the voice path: the 20th sentence of a minute is refused before anything is sent; a paid key has no such limit', async () => {
    for (let i = 0; i < 19; i++) await synthesize({ engine: 'azure', text: `Sentence ${i}.`, voice: 'Ada' });
    expect(calls).toHaveLength(19);
    const e = await synthesize({ engine: 'azure', text: 'One more.', voice: 'Ada' }).then(() => null, (x: Error & { code?: string }) => x);
    expect(e?.code).toBe('busy');
    expect(e?.message).toBe(AZURE_BUSY);
    expect(calls).toHaveLength(19);
    // "My Microsoft key is a paid one"
    stored.drExtras = { azurePaid: true };
    for (let i = 0; i < 30; i++) await synthesize({ engine: 'azure', text: `Paid ${i}.`, voice: 'Ada' });
    expect(calls).toHaveLength(49);
  });
  it('the setting is off at first (and the line under the spoken word is on)', () => {
    expect(DEFAULT_EXTRAS.azurePaid).toBe(false);
    expect(DEFAULT_EXTRAS.followWord).toBe(true);
  });
});

/** a voice whose sentences end as told ('busy' = the service has no room), with made-up word times */
function voice(outcomes: (SpeakOutcome | 'busy')[], words: WordTime[] | null = null) {
  const said: string[] = [];
  const handles: SpeakHandle[] = [];
  const engine = {
    id: 'azure', kind: 'cloud', label: 'v', costNote: '', wordBoundaries: false, paused: false, listVoices: async () => [],
    speak(text: string, opts: SpeakOptions): SpeakHandle {
      said.push(text);
      const o = outcomes.length ? outcomes.shift()! : 'ended';
      let resolve!: (x: SpeakOutcome) => void;
      const h: SpeakHandle = { done: new Promise<SpeakOutcome>((r) => { resolve = r; }), cancel: () => resolve('cancelled'), clock: () => ({ t: 0.5, d: 2 }), words: Promise.resolve(words), onBoundary: null };
      if (o === 'busy') h.error = Object.assign(new Error(AZURE_BUSY), { code: 'busy' });
      else if (o === 'error') h.error = new Error('HTTP 500');
      // (it starts a moment later, as a real voice does, says its words, then ends)
      setTimeout(() => { if (o === 'ended') { opts.onStart?.(); h.onBoundary?.(0, 5); } resolve(o === 'busy' ? 'error' : o); }, 5);
      handles.push(h);
      return h;
    },
    pause: () => undefined, resume: () => undefined, cancelAll: () => undefined,
  } as unknown as TtsEngine;
  return { engine, said, handles };
}

describe('a sentence Microsoft has no room for is said by the device voice at once', () => {
  it('no second try, no wait; the message says why; the next sentence is the good voice again', async () => {
    const cloud = voice(['busy', 'ended']), mac = voice([]);
    const told: (Error & { code?: string })[] = [], cooled: boolean[] = [];
    const v = new VoiceWithBackup(cloud.engine, mac.engine, () => 'Daniel', (e, c) => { told.push(e); cooled.push(c); });
    const t0 = Date.now();
    expect(await v.speak('One.', { voiceId: 'ada', rate: 1 }).done).toBe('ended');
    expect(Date.now() - t0).toBeLessThan(300); // (a failed sentence waits 400 ms before its second try: not this one)
    expect(cloud.said).toEqual(['One.']);
    expect(mac.said).toEqual(['One.']);
    expect(told).toHaveLength(1);
    expect(told[0].message).toBe('Microsoft is busy (free keys allow 19 requests a minute): the iPhone voice read this sentence');
    expect(told[0].message).toBe(BUSY_NOTE);
    expect(told[0].code).toBe('busy');
    expect(cooled).toEqual([false]);
    expect(v.lastError).toBe(BUSY_NOTE);
    await v.speak('Two.', { voiceId: 'ada', rate: 1 }).done;
    expect(cloud.said).toEqual(['One.', 'Two.']);
    expect(mac.said).toEqual(['One.']);
  });
  it('busy sentences are no failure of the good voice (it is not left for a minute), and the message comes once a minute', async () => {
    let now = 1000;
    const cloud = voice(['busy', 'busy', 'busy', 'busy', 'ended', 'busy']), mac = voice([]);
    const told: string[] = [];
    const v = new VoiceWithBackup(cloud.engine, mac.engine, () => 'Daniel', (e) => told.push(e.message), 12_000, () => now);
    for (const t of ['A.', 'B.', 'C.', 'D.']) await v.speak(t, { voiceId: 'ada', rate: 1 }).done;
    expect(mac.said).toEqual(['A.', 'B.', 'C.', 'D.']);
    expect(v.failed).toBe(false);
    expect(told).toEqual([BUSY_NOTE]);
    await v.speak('E.', { voiceId: 'ada', rate: 1 }).done;
    expect(cloud.said.at(-1)).toBe('E.');
    expect(mac.said).toHaveLength(4);
    now += 61_000;
    await v.speak('F.', { voiceId: 'ada', rate: 1 }).done;
    expect(told).toEqual([BUSY_NOTE, BUSY_NOTE]);
  });
  it('any other failure is still tried once more first', async () => {
    const cloud = voice(['error', 'ended']), mac = voice([]);
    const v = new VoiceWithBackup(cloud.engine, mac.engine, () => 'Daniel', () => undefined);
    await v.speak('One.', { voiceId: 'ada', rate: 1 }).done;
    expect(cloud.said).toEqual(['One.', 'One.']);
    expect(mac.said).toEqual([]);
  });
});

describe('the handle follows the voice that is heard (for the line under the spoken word)', () => {
  const W: WordTime[] = [{ start: 0, end: 0.4, charStart: 0, charEnd: 5 }];
  it('the good voice: its clock, its word times', async () => {
    const cloud = voice(['ended'], W), mac = voice([]);
    const v = new VoiceWithBackup(cloud.engine, mac.engine, () => 'Daniel', () => undefined);
    const h = v.speak('Hello there.', { voiceId: 'ada', rate: 1, timings: true });
    expect(await h.words).toEqual(W);
    expect(h.clock?.()).toEqual({ t: 0.5, d: 2 });
    expect(await h.done).toBe('ended');
  });
  it('a voice without word times: null as soon as it starts (not at the end of the sentence)', async () => {
    const cloud = voice(['ended'], null), mac = voice([]);
    const v = new VoiceWithBackup(cloud.engine, mac.engine, () => 'Daniel', () => undefined);
    let ended = false;
    const h = v.speak('Hello there.', { voiceId: 'ada', rate: 1 });
    void h.done.then(() => { ended = true; });
    expect(await h.words).toBeNull();
    expect(ended).toBe(false);
    await h.done;
  });
  it('the sentence went to the device voice: its word events reach the caller, and its word times, not the failed try\'s', async () => {
    const MAC: WordTime[] = [{ start: 0.1, end: 0.3, charStart: 0, charEnd: 5 }];
    const cloud = voice(['busy'], null), mac = voice(['ended'], MAC);
    const v = new VoiceWithBackup(cloud.engine, mac.engine, () => 'Daniel', () => undefined);
    const events: [number, number][] = [];
    const h = v.speak('Hello there.', { voiceId: 'ada', rate: 1 });
    h.onBoundary = (i, l) => events.push([i, l]);
    expect(await h.words).toEqual(MAC);
    expect(await h.done).toBe('ended');
    expect(events).toEqual([[0, 5]]);
  });
  it('cancelled before anything was heard: the word times are null, the promise is never left open', async () => {
    const cloud = voice(['ended'], null), mac = voice([]);
    const v = new VoiceWithBackup(cloud.engine, mac.engine, () => 'Daniel', () => undefined);
    const h = v.speak('Hello there.', { voiceId: 'ada', rate: 1 });
    h.cancel();
    expect(await h.done).toBe('cancelled');
    expect(await h.words).toBeNull();
  });
});

describe('what the page asks the background for', () => {
  const ask = async (engine: TtsEngine, answer: unknown) => {
    const sent: Record<string, unknown>[] = [];
    (G.chrome as { runtime?: unknown }).runtime = { sendMessage: async (m: Record<string, unknown>) => { sent.push(m); return answer; } };
    const h = engine.speak('Hello there.', { voiceId: 'ada', rate: 1 });
    const outcome = await h.done;
    return { sent, outcome, h };
  };
  it('I Know Book: the light sound and the fast model are asked for; the YouTube tutor asks as before', async () => {
    const book = await ask(cloudEngine('azure', 'en', BOOK_VOICE), { error: 'x' });
    expect(book.sent).toEqual([{ type: 'dream-tts', engine: 'azure', text: 'Hello there.', voice: 'ada', lang: 'en', light: true, fast: true }]);
    const yt = await ask(cloudEngine('azure', 'en'), { error: 'x' });
    expect(yt.sent).toEqual([{ type: 'dream-tts', engine: 'azure', text: 'Hello there.', voice: 'ada', lang: 'en' }]);
    expect(BOOK_VOICE).toEqual({ light: true, fast: true });
  });
  it('"busy" from the background is known by its code, and by its words when the code is not passed on', async () => {
    const a = await ask(cloudEngine('azure', 'en'), { error: AZURE_BUSY, code: 'busy' });
    expect(a.outcome).toBe('error');
    expect(isBusy(a.h.error)).toBe(true);
    const b = await ask(cloudEngine('azure', 'en'), { error: AZURE_BUSY });
    expect(isBusy(b.h.error)).toBe(true);
    const c = await ask(cloudEngine('azure', 'en'), { error: 'Microsoft voice: HTTP 500' });
    expect(isBusy(c.h.error)).toBe(false);
    expect(c.h.error?.message).toBe('Microsoft voice: HTTP 500');
  });
});

describe('ElevenLabs: the model by name, the voice settings, the times of the words', () => {
  it('the model: the fast one when the page asks for it or the setting says so, else the most natural one', () => {
    expect(elevenModel({ fast: true }, 'best')).toBe('eleven_flash_v2_5');
    expect(elevenModel({}, 'fast')).toBe('eleven_flash_v2_5');
    expect(elevenModel({}, 'best')).toBe('eleven_multilingual_v2');
    expect(elevenModel({}, undefined)).toBe('eleven_multilingual_v2');
    expect(elevenBody('Hi.', 'eleven_flash_v2_5')).toEqual({ text: 'Hi.', model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true } });
  });
  it('I Know Book: with-timestamps, model_id "eleven_flash_v2_5", the same voice settings; the words come back with their times', async () => {
    const text = '“Hello,” she said.';
    const r = await synthesize({ engine: 'elevenlabs', text, voice: 'JBFqnCBsd6RMkjVDRZzb', fast: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://eleven.test/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps?output_format=mp3_44100_128');
    expect(calls[0].headers['xi-api-key']).toBe('test-eleven-key');
    expect(JSON.parse(calls[0].body)).toEqual({ text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true } });
    expect(r.b64).toBe('AQID');
    // the words (without their quotation marks and commas), each with the start of its first letter and the end of its last
    expect(r.timings?.map((w) => text.slice(w.charIndex, w.charIndex + w.charLength))).toEqual(['Hello', 'she', 'said']);
    expect(r.timings?.[0].start).toBeCloseTo(0.1);
    expect(r.timings?.[0].end).toBeCloseTo(0.6);
    expect(r.timings?.[2].end).toBeCloseTo(1.7);
  });
  it('the YouTube tutor (nothing asked): the model of the quality setting, as before', async () => {
    await synthesize({ engine: 'elevenlabs', text: 'Hello.', voice: 'v' });
    stored.drExtras = { elevenQuality: 'fast' };
    await synthesize({ engine: 'elevenlabs', text: 'Hello.', voice: 'v' });
    expect(calls.map((c) => (JSON.parse(c.body) as { model_id: string }).model_id)).toEqual(['eleven_multilingual_v2', 'eleven_flash_v2_5']);
  });
  it('no letter times in the answer: no word times (null), the sound all the same', () => {
    expect(alignmentTimings('Hello.', { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] })).toBeNull();
    expect(alignmentTimings('Hi you', ALIGN('Hi you'))).toEqual([{ start: 0, end: 0.2, charIndex: 0, charLength: 2 }, { start: expect.closeTo(0.3, 5), end: expect.closeTo(0.6, 5), charIndex: 3, charLength: 3 }]);
  });
});

describe('"Auto" voice', () => {
  it('I Know Book (noOpenAi): Microsoft, else ElevenLabs, else the device voice; never OpenAI', () => {
    const o = { noOpenAi: true };
    expect(resolveVoice('auto', { azure: 'a', elevenlabs: 'e', openai: 'o' }, o)).toBe('azure');
    expect(resolveVoice('auto', { elevenlabs: 'e', openai: 'o' }, o)).toBe('elevenlabs');
    expect(resolveVoice('auto', { openai: 'o' }, o)).toBe('mac');
    expect(resolveVoice('auto', {}, o)).toBe('mac');
    // OpenAI chosen by name still works while it lasts
    expect(resolveVoice('openai', { openai: 'o' }, o)).toBe('openai');
    expect(resolveVoice('elevenlabs', { elevenlabs: 'e' }, o)).toBe('elevenlabs');
    expect(resolveVoice('azure', {}, o)).toBe('mac');
  });
  it('the YouTube tutor: as before', () => {
    expect(resolveVoice('auto', { azure: 'a', openai: 'o' })).toBe('azure');
    expect(resolveVoice('auto', { elevenlabs: 'e', openai: 'o' })).toBe('openai');
    expect(resolveVoice('auto', { elevenlabs: 'e' })).toBe('mac');
  });
});
