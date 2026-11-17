/**
 * The cloud voice's clips on an iPhone (vendor/core/tts/audio.ts): a clip loaded ahead (readAhead / prefetch) is
 * already the one made at the learner's volume, so starting it is just play(); a word said three times uses one audio
 * element; the handle tells where the sound is (clock) and the service's own word times (words).
 * The audio element, the decoder and the object addresses are stand-ins here (no browser in these tests).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AudioTtsEngine, voiceStats } from '@core/tts/audio';
import { resetBake, speechBounds, speechOf } from '@core/tts/gain';
import { FakeTtsEngine } from '@core/tts/fake';
import { WithVolume, sliderGain } from '../src/voice';
import type { TtsEngine } from '@core/tts/engine';
import type { CloudTtsResult } from '@shared/api';

/** what each object address holds ('audio/wav' = a clip made again at the learner's volume, 'audio/mpeg' = as the service made it) */
const kinds = new Map<string, string>();
const revoked: string[] = [];
let decodes = 0;
/** the decoded sound: 0.2 s of silence, 1.5 s of voice, 0.3 s of silence, at 24 kHz */
const SOUND = Float32Array.from({ length: 48000 }, (_, i) => (i >= 4800 && i < 40800 ? Math.sin(i / 5) * 0.5 : 0));

class FakeAudio {
  static made: FakeAudio[] = [];
  /** a clip made again at the learner's volume will not play (as on a device where that does not work) */
  static wavFails = false;
  preload = ''; preservesPitch = false; playbackRate = 1; volume = 1; currentTime = 0; duration = 2;
  onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  plays = 0; loads = 0; paused = true;
  private heard: (() => void)[] = [];
  constructor(public src = '') { FakeAudio.made.push(this); }
  get kind(): string | undefined { return kinds.get(this.src); }
  load(): void { this.loads++; }
  addEventListener(type: string, fn: () => void): void { if (type === 'playing') this.heard.push(fn); }
  play(): Promise<void> {
    this.plays++;
    if (FakeAudio.wavFails && this.kind === 'audio/wav') return Promise.reject(new Error('this sound will not play'));
    this.paused = false;
    queueMicrotask(() => { this.onplaying?.(); this.heard.splice(0).forEach((f) => f()); });
    return Promise.resolve();
  }
  pause(): void { this.paused = true; }
  /** the clip plays to its end */
  end(): void { this.currentTime = this.duration; this.paused = true; this.onended?.(); }
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const sounding = (): FakeAudio => { const a = FakeAudio.made.filter((x) => !x.paused); expect(a).toHaveLength(1); return a[0]; };

function engine(timings: CloudTtsResult['timings'] = null) {
  const asked: string[] = [];
  const e = new AudioTtsEngine('azure', async (_id, text) => { asked.push(text); return { audio: new ArrayBuffer(64), mime: 'audio/mpeg', timings, durationSec: null }; }, async () => [], false, { segment: false });
  return { e, asked };
}
const say = (e: TtsEngine, text: string, volume = 0.36) => e.speak(text, { voiceId: 'ada', rate: 1, volume });

const G = globalThis as unknown as Record<string, unknown>;
beforeEach(() => {
  kinds.clear(); revoked.length = 0; decodes = 0; FakeAudio.made = []; FakeAudio.wavFails = false;
  resetBake();
  G.__ytcBakeVolume = true; // an iPhone: the audio element's own volume is ignored
  G.Audio = FakeAudio;
  G.requestAnimationFrame = () => 0;
  G.cancelAnimationFrame = () => undefined;
  G.OfflineAudioContext = class {
    decodeAudioData(_bytes: ArrayBuffer, ok: (b: unknown) => void): void { decodes++; ok({ length: SOUND.length, numberOfChannels: 1, sampleRate: 24000, getChannelData: () => SOUND }); }
  };
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { const u = `blob:test/${++n}`; kinds.set(u, (b as Blob).type); return u; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => { revoked.push(u); });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ['__ytcBakeVolume', 'Audio', 'requestAnimationFrame', 'cancelAnimationFrame', 'OfflineAudioContext']) delete G[k];
});

describe('an iPhone: the clip loaded ahead is already at my volume', () => {
  it('prefetch: fetched, made at the volume and loaded without playing; speaking it later is just play()', async () => {
    const { e, asked } = engine();
    say(e, 'First sentence.').cancel(); // (the volume is known from the last thing said)
    await flush();
    const before = FakeAudio.made.length;
    e.prefetch('It was a quiet street.', 'ada', 1);
    await flush();
    expect(asked).toEqual(['First sentence.', 'It was a quiet street.']);
    expect(decodes).toBe(1);
    const ahead = FakeAudio.made.slice(before);
    expect(ahead).toHaveLength(1);
    expect(ahead[0].kind).toBe('audio/wav');
    expect(ahead[0].loads).toBe(1);
    expect(ahead[0].plays).toBe(0);
    // now it is said: no new request, no new decoding, no new audio element
    const made = FakeAudio.made.length;
    const h = say(e, 'It was a quiet street.');
    await flush();
    expect(sounding()).toBe(ahead[0]);
    expect(FakeAudio.made.length).toBe(made);
    expect(decodes).toBe(1);
    expect(asked).toHaveLength(2);
    expect(e.lastBaked?.volume).toBeCloseTo(0.36);
    expect(e.lastBaked?.bytes).toBe(44 + SOUND.length * 2);
    ahead[0].end();
    expect(await h.done).toBe('ended');
  });
  it('the volume slider (WithVolume) goes with what is made ahead, also before anything was said', async () => {
    const { e } = engine();
    const out = new WithVolume(() => e, () => sliderGain(50));
    out.prefetch('Hello there.', 'ada', 1);
    await flush();
    expect(FakeAudio.made).toHaveLength(1);
    expect(FakeAudio.made[0].kind).toBe('audio/wav');
    const h = out.speak('Hello there.', { voiceId: 'ada', rate: 1 });
    await flush();
    expect(sounding()).toBe(FakeAudio.made[0]);
    expect(FakeAudio.made).toHaveLength(1);
    expect(e.lastBaked?.volume).toBeCloseTo(0.25);
    FakeAudio.made[0].end();
    await h.done;
  });
  it('readAhead: the next two sentences are asked for, the next one is made at the volume and loaded', async () => {
    const { e, asked } = engine();
    e.readAhead(['Next one.', 'The one after.', 'A third.'], 'ada', 1, 0.36);
    await flush();
    expect(asked).toEqual(['Next one.', 'The one after.']);
    expect(FakeAudio.made).toHaveLength(1);
    expect(FakeAudio.made[0].kind).toBe('audio/wav');
    expect(decodes).toBe(1);
    const h = say(e, 'Next one.');
    await flush();
    expect(sounding()).toBe(FakeAudio.made[0]);
    expect(decodes).toBe(1);
    FakeAudio.made[0].end();
    await h.done;
  });
  it('the slider moved after the clip was made ahead: that clip is dropped, the clip is made at the new volume', async () => {
    const { e } = engine();
    e.prefetch('Hello there.', 'ada', 1, 0.36);
    await flush();
    const old = FakeAudio.made[0];
    const h = say(e, 'Hello there.', 0.64);
    await flush();
    const now = sounding();
    expect(now).not.toBe(old);
    expect(now.kind).toBe('audio/wav');
    expect(e.lastBaked?.volume).toBeCloseTo(0.64);
    expect(revoked).toContain('blob:test/1');
    now.end();
    await h.done;
  });
  it('a clip made ahead that will not play: the clip as the service made it plays instead (never silent)', async () => {
    const { e } = engine();
    const fails = voiceStats.bakeFails;
    e.prefetch('Hello there.', 'ada', 1, 0.36);
    await flush();
    FakeAudio.wavFails = true;
    const h = say(e, 'Hello there.');
    await flush();
    const now = sounding();
    expect(now.kind).toBe('audio/mpeg');
    expect(e.bakeFails).toBe(1);
    expect(voiceStats.bakeFails).toBe(fails + 1);
    expect(e.lastBaked).toBeNull();
    now.end();
    expect(await h.done).toBe('ended');
  });
  it('the slider at 100, or a device whose audio element takes the volume: nothing is made again, the mp3 is loaded ahead', async () => {
    const { e } = engine();
    e.prefetch('At full volume.', 'ada', 1, 1);
    G.__ytcBakeVolume = false;
    e.prefetch('On a Mac.', 'ada', 1, 0.36);
    await flush();
    expect(decodes).toBe(0);
    expect(FakeAudio.made.map((a) => a.kind)).toEqual(['audio/mpeg', 'audio/mpeg']);
    const h = say(e, 'On a Mac.');
    await flush();
    expect(sounding()).toBe(FakeAudio.made[1]);
    expect(sounding().volume).toBeCloseTo(0.36);
    expect(FakeAudio.made).toHaveLength(2);
    FakeAudio.made[1].end();
    await h.done;
  });
});

describe('the same text again at once (a word said three times): one audio element', () => {
  it('one request, one decoding, one element, played three times', async () => {
    const { e, asked } = engine();
    for (let i = 0; i < 3; i++) {
      const h = say(e, 'meticulous');
      await flush();
      const a = sounding();
      expect(a.currentTime).toBe(0);
      a.end();
      expect(await h.done).toBe('ended');
    }
    expect(asked).toEqual(['meticulous']);
    expect(decodes).toBe(1);
    expect(FakeAudio.made).toHaveLength(1);
    expect(FakeAudio.made[0].plays).toBe(3);
    expect(revoked).toEqual([]);
  });
  it('another text: the kept clip is let go; a stopped clip is never kept', async () => {
    const { e } = engine();
    let h = say(e, 'meticulous');
    await flush();
    sounding().end();
    await h.done;
    h = say(e, 'Something else.');
    await flush();
    expect(revoked).toEqual(['blob:test/1']);
    expect(FakeAudio.made).toHaveLength(2);
    // stopped in the middle: its element is gone, the next time is a new one
    h.cancel();
    expect(await h.done).toBe('cancelled');
    expect(revoked).toEqual(['blob:test/1', 'blob:test/2']);
    h = say(e, 'Something else.');
    await flush();
    expect(FakeAudio.made).toHaveLength(3);
    sounding().end();
    await h.done;
  });
  it('the same word at another volume is not the kept clip', async () => {
    const { e } = engine();
    let h = say(e, 'meticulous', 0.36);
    await flush();
    sounding().end();
    await h.done;
    h = say(e, 'meticulous', 0.64);
    await flush();
    expect(FakeAudio.made).toHaveLength(2);
    expect(e.lastBaked?.volume).toBeCloseTo(0.64);
    sounding().end();
    await h.done;
  });
  it('a kept clip does not stay for ever', async () => {
    vi.useFakeTimers();
    try {
      const { e } = engine();
      const h = say(e, 'meticulous');
      await vi.advanceTimersByTimeAsync(5);
      sounding().end();
      await h.done;
      expect(revoked).toEqual([]);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(revoked).toEqual(['blob:test/1']);
    } finally { vi.useRealTimers(); }
  });
});

describe('where the sound is, and the times of its words (for the line under the spoken word)', () => {
  it('clock(): seconds played and the length of the clip; null before a clip is loaded and after the end', async () => {
    const { e } = engine();
    const h = say(e, 'It was a quiet street.');
    expect(h.clock?.()).toBeNull();
    await flush();
    const a = sounding();
    a.currentTime = 0.75;
    const c = h.clock?.();
    expect(c?.t).toBe(0.75);
    expect(c?.d).toBe(2);
    // the clip was decoded for the volume: where its voice starts and ends was measured
    expect(c?.lead).toBeCloseTo(0.2, 2);
    expect(c?.tail).toBeCloseTo(0.3, 2);
    a.end();
    await h.done;
    expect(h.clock?.()).toBeNull();
  });
  it('a clip that was not decoded (the slider at 100): no measured silence, only the times', async () => {
    const { e } = engine();
    const h = say(e, 'It was a quiet street.', 1);
    await flush();
    sounding().currentTime = 1;
    expect(h.clock?.()).toEqual({ t: 1, d: 2 });
    sounding().end();
    await h.done;
  });
  it('words: the service\'s own word times at the places of my text; null when it gives none', async () => {
    const { e } = engine([{ start: 0.1, end: 0.4, charIndex: 0, charLength: 5 }, { start: 0.5, end: 0.9, charIndex: 6, charLength: 5 }]);
    // (the service spoke the text without the spaces before it)
    const h = say(e, '  Hello there.');
    expect(await h.words).toEqual([{ start: 0.1, end: 0.4, charStart: 2, charEnd: 7 }, { start: 0.5, end: 0.9, charStart: 8, charEnd: 13 }]);
    h.cancel();
    // a sound kept from before may count the signs beside a word as part of it: the line goes under the letters only
    const kept = engine([{ start: 0, end: 0.5, charIndex: 0, charLength: 8 }, { start: 0.6, end: 0.7, charIndex: 9, charLength: 1 }, { start: 0.8, end: 1.2, charIndex: 11, charLength: 5 }]).e;
    const hk = say(kept, '“Hello,” — there');
    expect(await hk.words).toEqual([{ start: 0, end: 0.5, charStart: 1, charEnd: 6 }, { start: 0.8, end: 1.2, charStart: 11, charEnd: 16 }]);
    hk.cancel();
    const none = engine().e;
    const h2 = say(none, 'Hello there.');
    expect(await h2.words).toBeNull();
    h2.cancel();
    // a request that fails has no word times either (and never an error from the promise)
    const bad = new AudioTtsEngine('azure', async () => { throw new Error('HTTP 500'); }, async () => [], false, { segment: false });
    const h3 = say(bad, 'Hello there.');
    expect(await h3.words).toBeNull();
    expect(await h3.done).toBe('error');
  });
});

describe('where the voice starts and ends in a clip', () => {
  it('the silence at both ends, in seconds', () => {
    const b = speechBounds(SOUND, 24000);
    expect(b.lead).toBeCloseTo(0.2, 2);
    expect(b.tail).toBeCloseTo(0.3, 2);
  });
  it('a very quiet hiss is silence; a clip that is all voice, or all silence, has none to cut', () => {
    const hiss = SOUND.map((s) => (s === 0 ? 0.002 : s));
    expect(speechBounds(hiss, 24000).lead).toBeCloseTo(0.2, 2);
    expect(speechBounds(Float32Array.from({ length: 2400 }, () => 0.4), 24000)).toEqual({ lead: 0, tail: 0 });
    expect(speechBounds(new Float32Array(2400), 24000)).toEqual({ lead: 0, tail: 0 });
    expect(speechBounds(new Float32Array(0), 24000)).toEqual({ lead: 0, tail: 0 });
  });
  it('kept by the clip\'s name when the clip is decoded; not measured = null', async () => {
    expect(speechOf('nobody')).toBeNull();
    const { e } = engine();
    e.prefetch('Hello there.', 'ada', 1, 0.36);
    await flush();
    const b = speechOf('ada\u0000Hello there.');
    expect(b?.lead).toBeCloseTo(0.2, 2);
    expect(b?.tail).toBeCloseTo(0.3, 2);
  });
});

describe('the test voice (fakeVoice): its made-up timing can be read too', () => {
  it('clock(), the exact words and a word event for each word', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeTtsEngine(10);
      const text = 'The cat sat, then left.';
      const started: number[] = [], events: [number, number][] = [], old: number[] = [];
      const h = fake.speak(text, { voiceId: 'fake-gb', rate: 1, onStart: () => started.push(Date.now()), onWord: (i) => old.push(i) });
      h.onBoundary = (i, l) => events.push([i, l]);
      const words = (await h.words)!;
      expect(words.map((w) => text.slice(w.charStart, w.charEnd))).toEqual(['The', 'cat', 'sat', 'then', 'left']);
      expect(h.clock?.()).toEqual({ t: 0, d: 0.23 });
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toHaveLength(1);
      // at every moment: the word events so far = the words whose start has passed on the clock
      for (let ms = 1; ms < 225; ms += 8) {
        const c = h.clock!()!;
        expect(c.d).toBeCloseTo(0.23);
        expect(c.t).toBeCloseTo(ms / 1000, 2);
        expect(events.length).toBe(words.filter((w) => w.start <= c.t).length);
        await vi.advanceTimersByTimeAsync(8);
      }
      await vi.advanceTimersByTimeAsync(10);
      expect(await h.done).toBe('ended');
      expect(events).toEqual(words.map((w) => [w.charStart, w.charEnd - w.charStart]));
      expect(old).toEqual(words.map((w) => w.charStart));
      for (let i = 1; i < words.length; i++) expect(words[i].start).toBeCloseTo(words[i - 1].end);
      expect(words[words.length - 1].end).toBeCloseTo(0.23);
      expect(h.clock?.()).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
