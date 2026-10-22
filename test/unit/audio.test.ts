import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CloudTtsResult } from '@shared/api';

class FakeAudio {
  static instances: FakeAudio[] = [];
  preservesPitch = false; playbackRate = 1; currentTime = 0; duration = 2; played = 0;
  onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(public src: string) { FakeAudio.instances.push(this); }
  play() { this.played++; this.onplaying?.(); return Promise.resolve(); }
  pause() { /* noop */ }
}
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
});
