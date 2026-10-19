import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Minimal stand-in for window.speechSynthesis: records spoken utterances, cancel() fires 'canceled' on them. */
class FakeUtterance {
  rate = 1; lang = ''; voice: FakeVoice | null = null; volume = 1;
  onstart: (() => void) | null = null; onend: (() => void) | null = null; onboundary: ((e: unknown) => void) | null = null; onerror: ((e: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}
interface FakeVoice { voiceURI: string; name: string; lang: string; localService: boolean; default: boolean }
const DANIEL: FakeVoice = { voiceURI: 'com.apple.voice.premium.en-GB.Daniel', name: 'Daniel (Premium)', lang: 'en-GB', localService: true, default: false };
const SAMANTHA: FakeVoice = { voiceURI: 'com.apple.voice.en-US.Samantha', name: 'Samantha', lang: 'en-US', localService: true, default: true };
const TINGTING: FakeVoice = { voiceURI: 'com.apple.voice.zh-CN.Tingting', name: 'Tingting', lang: 'zh-CN', localService: true, default: false };

const synth = {
  spoken: [] as FakeUtterance[], speaking: false, paused: false, resumes: 0, throwOnSpeak: false,
  voices: [DANIEL, SAMANTHA, TINGTING] as FakeVoice[],
  listeners: new Set<() => void>(),
  getVoices() { return this.voices; },
  speak(u: FakeUtterance) { if (this.throwOnSpeak) throw new Error('synthesizer exploded'); this.spoken.push(u); this.speaking = true; },
  cancel() { this.speaking = false; this.paused = false; for (const u of this.spoken.splice(0)) u.onerror?.({ error: 'canceled' }); },
  pause() { this.paused = true; }, resume() { this.paused = false; this.resumes++; },
  addEventListener(_ev: string, fn: () => void) { this.listeners.add(fn); },
  removeEventListener(_ev: string, fn: () => void) { this.listeners.delete(fn); },
  fireVoicesChanged() { for (const fn of [...this.listeners]) fn(); },
};
Object.assign(globalThis, { window: globalThis, speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance });

const { WebSpeechEngine, START_TIMEOUT_MS, START_TIMEOUT_NEW_VOICE_MS, END_TIMEOUT_EXTRA_MS, RESUME_TICK_MS, VOICE_DID_NOT_START } = await import('@core/tts/webspeech');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const voiceId = DANIEL.voiceURI;

function resetSynth() {
  synth.spoken.length = 0; synth.speaking = false; synth.paused = false; synth.resumes = 0; synth.throwOnSpeak = false;
  synth.voices = [DANIEL, SAMANTHA, TINGTING]; synth.listeners.clear();
}

describe('WebSpeechEngine', () => {
  beforeEach(resetSynth);

  it('speaks and resolves when the utterance ends', async () => {
    const e = new WebSpeechEngine();
    const h = e.speak('Hello there', { voiceId, rate: 1 });
    await sleep(5);
    expect(synth.spoken.map((u) => u.text)).toEqual(['Hello there']);
    expect(synth.spoken[0].voice).toBe(DANIEL);
    expect(synth.spoken[0].lang).toBe('en-GB');
    synth.spoken[0].onstart?.();
    synth.spoken[0].onend?.();
    expect(await h.done).toBe('ended');
  });

  it('after cancelling one utterance (stop at a hard word) the next speak waits for the engine to settle', async () => {
    const e = new WebSpeechEngine();
    const a = e.speak('The sanguine man laughed.', { voiceId, rate: 1 });
    await sleep(5);
    a.cancel();
    expect(await a.done).toBe('cancelled');
    const b = e.speak('sanguine', { voiceId, rate: 1 });
    await sleep(10);
    expect(synth.spoken.map((u) => u.text)).toEqual([]); // Chromium drops a speak() issued right after cancel()
    await sleep(80);
    expect(synth.spoken.map((u) => u.text)).toEqual(['sanguine']);
    synth.spoken[0].onend?.();
    expect(await b.done).toBe('ended');
  });

  it('cancelAll() also cancels utterances still waiting to be spoken', async () => {
    const e = new WebSpeechEngine();
    e.cancelAll(); // opens the settle window
    const b = e.speak('ghost sentence', { voiceId, rate: 1 });
    e.cancelAll();
    expect(await Promise.race([b.done, sleep(20).then(() => 'pending')])).toBe('cancelled');
    await sleep(100);
    expect(synth.spoken.map((u) => u.text)).toEqual([]);
  });

  it('a chosen voice that no longer exists falls back to the default British voice, not an unvoiced utterance', async () => {
    const e = new WebSpeechEngine();
    e.speak('Hello', { voiceId: 'com.apple.voice.enhanced.en-GB.Serena', rate: 1 });
    await sleep(5);
    expect(synth.spoken[0].voice).toBe(DANIEL);
    expect(synth.spoken[0].lang).toBe('en-GB');
    // a Chinese voice that does exist is used as asked
    e.speak('你好', { voiceId: TINGTING.voiceURI, rate: 1 });
    await sleep(5);
    expect(synth.spoken[1].voice).toBe(TINGTING);
  });

  it('waits for voices to load before speaking when getVoices() is still empty', async () => {
    synth.voices = [];
    const e = new WebSpeechEngine();
    const h = e.speak('Hello', { voiceId, rate: 1 });
    await sleep(10);
    expect(synth.spoken).toEqual([]);
    synth.voices = [DANIEL, SAMANTHA];
    synth.fireVoicesChanged();
    await sleep(5);
    expect(synth.spoken[0]?.voice).toBe(DANIEL);
    synth.spoken[0].onend?.();
    expect(await h.done).toBe('ended');
  });
});

describe('WebSpeechEngine stuck-synthesizer recovery', () => {
  beforeEach(() => { resetSynth(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it('a speak() that throws fails only that utterance; later utterances still play', async () => {
    const e = new WebSpeechEngine();
    synth.throwOnSpeak = true;
    const a = e.speak('First', { voiceId, rate: 1 });
    await tick(5);
    expect(await a.done).toBe('error');
    expect(a.error?.message).toContain('synthesizer exploded');
    synth.throwOnSpeak = false;
    const b = e.speak('Second', { voiceId, rate: 1 });
    await tick(5);
    expect(synth.spoken.map((u) => u.text)).toEqual(['Second']);
    synth.spoken[0].onstart?.(); synth.spoken[0].onend?.();
    expect(await b.done).toBe('ended');
  });

  it('resumes a synthesizer left paused (after a cancel) before speaking', async () => {
    const e = new WebSpeechEngine();
    synth.paused = true;
    e.speak('Hello', { voiceId, rate: 1 });
    await tick(5);
    expect(synth.paused).toBe(false);
    expect(synth.resumes).toBe(1);
    expect(synth.spoken.map((u) => u.text)).toEqual(['Hello']);
  });

  it('start watchdog: cancels and retries once when onstart never fires, then fails with a clear message', async () => {
    const e = new WebSpeechEngine();
    const h = e.speak('Hello there', { voiceId, rate: 1 });
    await tick(5);
    expect(synth.spoken.length).toBe(1);
    const first = synth.spoken[0];
    // the first utterance after a (new) voice gets the long warm-up allowance
    await tick(START_TIMEOUT_NEW_VOICE_MS - 100);
    expect(synth.spoken.length).toBe(1);
    await tick(100 + 300);
    expect(synth.spoken.length).toBe(1); // the stuck utterance was cancelled and a fresh one spoken
    expect(synth.spoken[0]).not.toBe(first);
    expect(synth.spoken[0].text).toBe('Hello there');
    // the retry gets the normal allowance (same voice now), then gives up
    let settled: string | null = null; void h.done.then((o) => { settled = o; });
    await tick(START_TIMEOUT_MS - 100);
    expect(settled).toBeNull();
    await tick(200);
    expect(settled).toBe('error');
    expect(h.error?.message).toBe(VOICE_DID_NOT_START);
    expect(synth.speaking).toBe(false); // the engine was cleared so the next sentence can start
  });

  it('start watchdog: the retry succeeds when the synthesizer wakes up', async () => {
    const e = new WebSpeechEngine();
    const started: string[] = [];
    const h = e.speak('Hello there', { voiceId, rate: 1, onStart: () => started.push('start') });
    await tick(START_TIMEOUT_NEW_VOICE_MS + 400);
    expect(synth.spoken.length).toBe(1);
    synth.spoken[0].onstart?.();
    expect(started).toEqual(['start']);
    await tick(START_TIMEOUT_MS); // no further retry or failure once it started (the end watchdog is at 6.6 s)
    expect(synth.spoken.length).toBe(1);
    synth.spoken[0].onend?.();
    expect(await h.done).toBe('ended');
  });

  it('start watchdog waits while another utterance is still legitimately speaking', async () => {
    const e = new WebSpeechEngine();
    const a = e.speak('A long first sentence that is still being read aloud.', { voiceId, rate: 1 });
    await tick(5);
    synth.spoken[0].onstart?.();
    const b = e.speak('Second', { voiceId, rate: 1 });
    await tick(START_TIMEOUT_MS * 2);
    expect(synth.spoken.length).toBe(2); // nothing was cancelled
    synth.spoken[0].onend?.();
    expect(await a.done).toBe('ended');
    synth.spoken[1].onstart?.(); synth.spoken[1].onend?.();
    expect(await b.done).toBe('ended');
  });

  it('end watchdog: finishes an utterance whose onend never comes, after twice its expected duration', async () => {
    const e = new WebSpeechEngine();
    const text = 'one two three four five six seven eight nine ten'; // 10 words at 150 wpm = 4 s
    const h = e.speak(text, { voiceId, rate: 1 });
    await tick(5);
    synth.spoken[0].onstart?.();
    let settled: string | null = null; void h.done.then((o) => { settled = o; });
    await tick(4000 * 2 + END_TIMEOUT_EXTRA_MS - 100);
    expect(settled).toBeNull();
    await tick(200);
    expect(settled).toBe('ended');
  });

  it('ticks resume() every 10 s while speaking (Chromium pauses long utterances)', async () => {
    const e = new WebSpeechEngine();
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '); // 60 words at rate 0.5: 48 s expected
    const h = e.speak(text, { voiceId, rate: 0.5 });
    await tick(5);
    synth.spoken[0].onstart?.();
    await tick(RESUME_TICK_MS * 2 + 50);
    expect(synth.resumes).toBe(2);
    synth.spoken[0].onend?.();
    await h.done;
    await tick(RESUME_TICK_MS * 2);
    expect(synth.resumes).toBe(2); // stops with the utterance
  });

  it('probe() reports ok when the voice starts and a reason when it does not', async () => {
    const e = new WebSpeechEngine();
    const p1 = e.probe(voiceId);
    await tick(100);
    expect(synth.spoken.length).toBe(1);
    expect(synth.spoken[0].volume).toBeCloseTo(0.01);
    synth.spoken[0].onstart?.();
    synth.spoken[0].onend?.();
    expect(await p1).toEqual({ ok: true });
    resetSynth();
    const p2 = e.probe(voiceId);
    await tick(100);
    expect(synth.spoken.length).toBe(1);
    await tick(6000);
    const r2 = await p2;
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain(VOICE_DID_NOT_START);
    synth.voices = [];
    const p3 = e.probe();
    await tick(2100); // waitForVoices gives up after 2 s
    expect((await p3).reason).toContain('No system voices');
  });
});
