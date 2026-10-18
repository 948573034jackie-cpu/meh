import { describe, it, expect, beforeEach } from 'vitest';
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
});
