import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CloudTtsResult } from '@shared/api';

class FakeAudio {
  static instances: FakeAudio[] = [];
  preservesPitch = false; playbackRate = 1; currentTime = 0; duration = 2; played = 0;
  paused = true; volumes: number[] = []; pausedAtVolume: number | null = null;
  declare volume: number; // an accessor on the prototype (below)
  onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(public src: string) { FakeAudio.instances.push(this); }
  play() { this.played++; this.paused = false; this.onplaying?.(); return Promise.resolve(); }
  pause() { if (!this.paused) this.pausedAtVolume = this.volume; this.paused = true; }
}
// every volume step is recorded (the fade on a stop)
Object.defineProperty(FakeAudio.prototype, 'volume', {
  get(this: FakeAudio & { _v?: number }) { return this._v ?? 1; },
  set(this: FakeAudio & { _v?: number }, v: number) { this._v = v; (this.volumes ??= []).push(v); },
});
Object.assign(globalThis, {
  Audio: FakeAudio,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 4),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
const { AudioTtsEngine } = await import('@core/tts/audio');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const result = (timings: CloudTtsResult['timings']): CloudTtsResult => ({ audio: new ArrayBuffer(16), mime: 'audio/mpeg', timings, durationSec: null });

describe('AudioTtsEngine', () => {
  beforeEach(() => { FakeAudio.instances.length = 0; });

  it('readAhead urgent (the stop word): in the same replace call at priority soon with wait, then pre-decoded; speak() plays that element', async () => {
    const { PRIORITY } = await import('@core/tts/segments');
    const prepared: { text: string; priority?: number; wait?: boolean; replace?: boolean }[][] = [];
    const synth: string[] = [];
    const e = new AudioTtsEngine('kokoro', async (_e, text) => { synth.push(text); return result(null); }, async () => [], true, { prepare: async (items) => { prepared.push(items); return true; }, segment: true });
    e.readAhead(['The next sentence.'], 'bf_emma', 1, ['sanguine', 'sanguine', ' '], ['acrimonious', 'sanguine']);
    expect(prepared[0]).toEqual([
      { text: '', replace: true },
      { text: 'The next sentence.', voice: 'bf_emma', speed: 1, priority: PRIORITY.ahead - 1 },
      // the next sentence's stop word: after the next sentence, before the read-ahead; not waited for
      { text: 'acrimonious', voice: 'bf_emma', speed: 1, priority: PRIORITY.nextWords },
      { text: 'sanguine', voice: 'bf_emma', speed: 1, priority: PRIORITY.soon, wait: true },
    ]);
    expect(PRIORITY.soon).toBe(95);
    expect(PRIORITY.next).toBeGreaterThan(PRIORITY.nextWords);
    expect(PRIORITY.nextWords).toBeGreaterThan(PRIORITY.ahead);
    // the separate 'next' request for the next sentence, as before
    expect(prepared[1]).toEqual([{ text: 'The next sentence.', voice: 'bf_emma', speed: 1, priority: PRIORITY.next, wait: true }]);
    await sleep(5);
    expect(synth).toContain('sanguine'); // fetched from the main process's memory cache and loaded
    expect(synth).not.toContain('acrimonious');
    expect(FakeAudio.instances).toHaveLength(2); // the word and the next sentence, loaded, none played
    expect(FakeAudio.instances.every((a) => a.played === 0)).toBe(true);
    const before = FakeAudio.instances.length;
    // the cut: the first of the 3 repeats plays the element loaded ahead
    const h = e.speak('sanguine', { voiceId: 'bf_emma', rate: 0.9 });
    await sleep(5);
    expect(FakeAudio.instances.length).toBe(before);
    expect(e.lastStartDelayMs).not.toBeNull();
    expect(FakeAudio.instances.filter((a) => a.played === 1)).toHaveLength(1);
    expect(synth.filter((t) => t === 'sanguine')).toHaveLength(1); // not asked for again
    FakeAudio.instances.find((a) => a.played === 1)!.onended?.();
    expect(await h.done).toBe('ended');
  });

  it('readAhead urgent dropped (a pause replaced the list before it was ready): nothing is loaded', async () => {
    let ready!: (ok: boolean) => void;
    const synth: string[] = [];
    const e = new AudioTtsEngine('kokoro', async (_e, text) => { synth.push(text); return result(null); }, async () => [], true, { prepare: (items) => (items.some((i) => i.text === 'sanguine') ? new Promise((r) => { ready = r; }) : Promise.resolve(true)), segment: true });
    e.readAhead(['The next sentence.'], 'bf_emma', 1, ['sanguine']);
    e.stopReadAhead();
    ready(true);
    await sleep(5);
    expect(synth).not.toContain('sanguine');
  });

  it('readAhead urgent (cloud voice): the word is fetched and pre-decoded at once (a few characters), with the next two sentences', async () => {
    const synth: string[] = [];
    const e = new AudioTtsEngine('edge', async (_e, text) => { synth.push(text); return result(null); }, async () => [], true);
    e.readAhead(['B.', 'C.', 'D.'], 'v', 1, ['sanguine'], ['acrimonious']);
    await sleep(5);
    expect(synth.sort()).toEqual(['B.', 'C.', 'sanguine']); // the next sentence's word is not fetched yet
  });

  it('a stop at a hard word fades the audio out over 25 ms (no click); speak() reports the cancel at once', async () => {
    const e = new AudioTtsEngine('kokoro', async () => result(null), async () => [], true, { segment: true });
    const h = e.speak('He was sanguine about it.', { voiceId: 'v', rate: 1 });
    await sleep(5);
    const a = FakeAudio.instances[0];
    expect(a.played).toBe(1);
    h.cancel({ fade: true });
    expect(await h.done).toBe('cancelled');
    expect(a.paused).toBe(false); // still fading
    await sleep(60);
    expect(a.paused).toBe(true);
    expect(a.volumes.map((v) => +v.toFixed(3))).toEqual([0.8, 0.6, 0.4, 0.2, 0]);
    for (let i = 1; i < a.volumes.length; i++) expect(a.volumes[i]).toBeLessThan(a.volumes[i - 1]);
    expect(a.pausedAtVolume).toBe(0);
    expect(a.src).toBe('');
    // a plain cancel (pause, seek) stops at once
    const h2 = e.speak('Then he left.', { voiceId: 'v', rate: 1 });
    await sleep(5);
    const b = FakeAudio.instances[1];
    h2.cancel();
    expect(await h2.done).toBe('cancelled');
    expect(b.paused).toBe(true);
    expect(b.volumes).toEqual([]);
  });

  it('cancelAll() while the audio is still being synthesized prevents it from playing later', async () => {
    let resolve!: (r: CloudTtsResult) => void;
    const e = new AudioTtsEngine('edge', () => new Promise((r) => { resolve = r; }), async () => [], true);
    const h = e.speak('Hello there', { voiceId: 'v', rate: 1 });
    e.cancelAll();
    resolve(result(null));
    expect(await h.done).toBe('cancelled');
    await sleep(10);
    expect(FakeAudio.instances.reduce((n, a) => n + a.played, 0)).toBe(0);
  });

  it('falls back to estimated word timing when the provider returns an empty timing list', async () => {
    const e = new AudioTtsEngine('elevenlabs', async () => result([]), async () => [], true);
    const words: number[] = [];
    const h = e.speak('Hello there friend', { voiceId: 'v', rate: 1, onWord: (i) => words.push(i) });
    await sleep(20);
    FakeAudio.instances[0].currentTime = 1.99;
    await sleep(20);
    expect(words).toEqual([0, 6, 12]);
    FakeAudio.instances[0].onended?.();
    expect(await h.done).toBe('ended');
  });

  it('maps provider timings back to the untrimmed text it was asked to speak', async () => {
    // the main process trims the text before synthesis; charIndex must still index the renderer's text
    const e = new AudioTtsEngine('edge', async () => result([{ start: 0, end: 0.1, charIndex: 0, charLength: 5 }, { start: 0.5, end: 0.6, charIndex: 6, charLength: 5 }]), async () => [], true);
    const words: number[] = [];
    const h = e.speak('  Hello there', { voiceId: 'v', rate: 1, onWord: (i) => words.push(i) });
    await sleep(20);
    FakeAudio.instances[0].currentTime = 1;
    await sleep(20);
    expect(words).toEqual([2, 8]);
    h.cancel();
  });

  it('prepareSoon (local voice): queued at priority soon with wait, then pre-decoded so speak() only plays it', async () => {
    const { PRIORITY } = await import('@core/tts/segments');
    const prepared: unknown[][] = [];
    const synth: string[] = [];
    const e = new AudioTtsEngine('kokoro', async (_e, text) => { synth.push(text); return result(null); }, async () => [], true, { prepare: async (items) => { prepared.push(items); return true; }, segment: true });
    e.prepareSoon(['Sanguine means hopeful.', ''], 'bf_emma');
    expect(prepared).toEqual([[{ text: 'Sanguine means hopeful.', voice: 'bf_emma', speed: 1, priority: PRIORITY.soon, wait: true }]]);
    await sleep(5);
    expect(synth).toEqual(['Sanguine means hopeful.']); // fetched from the main process's memory cache and loaded
    const before = FakeAudio.instances.length;
    const h = e.speak('Sanguine means hopeful.', { voiceId: 'bf_emma', rate: 1 });
    await sleep(5);
    expect(FakeAudio.instances.length).toBe(before); // the pre-decoded element plays
    FakeAudio.instances.at(-1)!.onended?.();
    expect(await h.done).toBe('ended');
    expect(synth).toHaveLength(1);
  });

  it('prepareSoon release(): the queued jobs are dropped in the main process and the loaded audio is freed', async () => {
    const prepared: unknown[][] = [];
    const e = new AudioTtsEngine('kokoro', async () => result(null), async () => [], true, { prepare: async (items) => { prepared.push(items); return true; }, segment: true });
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    try {
      const h = e.prepareSoon(['Sanguine means hopeful.', 'He stays cheerful.'], 'bf_emma');
      await sleep(5);
      expect(FakeAudio.instances).toHaveLength(2); // both pre-decoded
      const urls = FakeAudio.instances.map((a) => a.src);
      h.release();
      h.release(); // idempotent
      expect(prepared.at(-1)).toEqual([{ text: '', voice: 'bf_emma', speed: 1, drop: ['Sanguine means hopeful.', 'He stays cheerful.'] }]);
      expect(prepared.filter((p) => (p as { drop?: unknown }[])[0].drop)).toHaveLength(1);
      expect(revoke.mock.calls.map((c) => c[0])).toEqual(urls);
      // nothing is left behind: speaking it now loads it again
      const s = e.speak('He stays cheerful.', { voiceId: 'bf_emma', rate: 1 });
      await sleep(5);
      expect(FakeAudio.instances).toHaveLength(3);
      FakeAudio.instances.at(-1)!.onended?.();
      expect(await s.done).toBe('ended');
    } finally { revoke.mockRestore(); }
  });

  it('prepareSoon released before the audio is ready: nothing is loaded', async () => {
    let ready!: (ok: boolean) => void;
    const synth: string[] = [];
    const e = new AudioTtsEngine('kokoro', async (_e, text) => { synth.push(text); return result(null); }, async () => [], true, { prepare: (items) => (items[0].drop ? Promise.resolve(undefined) : new Promise((r) => { ready = r; })), segment: true });
    const h = e.prepareSoon(['Sanguine means hopeful.'], 'bf_emma');
    h.release();
    ready(true); // the job was already running in the main process: it finished anyway
    await sleep(5);
    expect(synth).toEqual([]);
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('prepareSoon (cloud voice): only the first two texts are fetched and pre-decoded (they cost money per character)', async () => {
    const synth: string[] = [];
    const e = new AudioTtsEngine('edge', async (_e, text) => { synth.push(text); return result(null); }, async () => [], true);
    e.prepareSoon(['Sanguine means hopeful.', 'He stays cheerful.', 'Even in the rain.'], 'v');
    await sleep(5);
    expect(synth).toEqual(['Sanguine means hopeful.', 'He stays cheerful.']);
    const before = FakeAudio.instances.length;
    const h = e.speak('He stays cheerful.', { voiceId: 'v', rate: 1 });
    await sleep(5);
    expect(FakeAudio.instances.length).toBe(before); // the pre-decoded element plays
    FakeAudio.instances.at(-1)!.onended?.();
    expect(await h.done).toBe('ended');
    expect(synth).toHaveLength(2);
  });

  it('a hidden page gets no animation frames: the words are polled every 50 ms meanwhile (a stop still cuts at its word), and the timer goes with the clip', async () => {
    const listeners = new Set<() => void>();
    const doc = { visibilityState: 'hidden', addEventListener: (_t: string, f: () => void) => listeners.add(f), removeEventListener: (_t: string, f: () => void) => listeners.delete(f) };
    const raf = globalThis.requestAnimationFrame;
    // frames never come in this test (a hidden window); the timer alone has to announce the words
    Object.assign(globalThis, { document: doc, requestAnimationFrame: () => 0 });
    try {
      const timings = [{ start: 0, end: 0.2, charIndex: 0, charLength: 2 }, { start: 0.3, end: 0.5, charIndex: 3, charLength: 3 }, { start: 0.6, end: 0.9, charIndex: 7, charLength: 8 }];
      const e = new AudioTtsEngine('kokoro', async () => result(timings), async () => [], true, { segment: true });
      const words: number[] = [];
      const h = e.speak('He was sanguine.', { voiceId: 'v', rate: 1, onWord: (i) => words.push(i) });
      await sleep(5);
      const a = FakeAudio.instances[0];
      expect(a.played).toBe(1);
      expect(listeners.size).toBe(1);
      await sleep(70);
      expect(words).toEqual([0]);
      a.currentTime = 0.35;
      await sleep(70);
      expect(words).toEqual([0, 3]); // long before the clip ends
      // shown again: the frames take over and the timer stops (no frames here, so nothing moves)
      doc.visibilityState = 'visible'; listeners.forEach((f) => f());
      a.currentTime = 0.65;
      await sleep(70);
      expect(words).toEqual([0, 3]);
      // hidden again: polled again
      doc.visibilityState = 'hidden'; listeners.forEach((f) => f());
      await sleep(70);
      expect(words).toEqual([0, 3, 7]);
      a.onended?.();
      expect(await h.done).toBe('ended');
      expect(listeners.size).toBe(0);
      const n = words.length;
      a.currentTime = 5;
      await sleep(70);
      expect(words).toHaveLength(n); // the timer stopped with the clip
    } finally {
      Object.assign(globalThis, { requestAnimationFrame: raf });
      delete (globalThis as { document?: unknown }).document;
    }
  });
});

