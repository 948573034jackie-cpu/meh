import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CloudTtsResult, WordTiming } from '@shared/api';
import { synthesisSegments, endPunctOf, PRIORITY } from '@core/tts/segments';

/** An audio element that plays for SEG_SEC seconds of (fake) time and reports currentTime from the clock. */
const SEG_SEC = 2;
class FakeAudio {
  static instances: FakeAudio[] = [];
  preload = ''; preservesPitch = false; playbackRate = 1; duration = SEG_SEC;
  loads = 0; plays = 0; startedAt = -1; private timer: ReturnType<typeof setTimeout> | null = null;
  onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(public src: string) { FakeAudio.instances.push(this); }
  get currentTime(): number { return this.startedAt < 0 ? 0 : Math.min(SEG_SEC, ((Date.now() - this.startedAt) / 1000) * this.playbackRate); }
  load() { this.loads++; }
  play() {
    this.plays++; this.startedAt = Date.now();
    this.onplaying?.();
    this.timer = setTimeout(() => this.onended?.(), (SEG_SEC * 1000) / this.playbackRate);
    return Promise.resolve();
  }
  pause() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
Object.assign(globalThis, {
  Audio: FakeAudio,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
const { AudioTtsEngine } = await import('@core/tts/audio');

/** word timings for a piece of text: one word every 0.3 s, as the main process returns them */
function timings(text: string): WordTiming[] {
  return [...text.matchAll(/[\p{L}\p{N}’']+/gu)].map((m, i) => ({ start: Math.min(SEG_SEC - 0.01, i * 0.1), end: Math.min(SEG_SEC, i * 0.1 + 0.08), charIndex: m.index!, charLength: m[0].length }));
}
const result = (text: string): CloudTtsResult => ({ audio: new ArrayBuffer(16), mime: 'audio/wav', timings: timings(text.trim()), durationSec: SEG_SEC });

/** a serial synthesizer like the main process: each request takes `ms` after the previous one */
function serialSynth(ms: number) {
  const calls: { text: string; at: number }[] = [];
  let free = 0;
  const fn = (_e: string, text: string) => {
    const start = Math.max(Date.now(), free);
    free = start + ms;
    calls.push({ text, at: Date.now() });
    return new Promise<CloudTtsResult>((r) => setTimeout(() => r(result(text)), free - Date.now()));
  };
  return { fn, calls };
}

const LONG = '“Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it, that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week.”';

describe('AudioTtsEngine: long sentences in segments', () => {
  beforeEach(() => { FakeAudio.instances.length = 0; vi.useFakeTimers({ now: 0 }); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts after the first segment is synthesized and plays the rest back to back with sentence word offsets', async () => {
    const synth = serialSynth(1000); // 1 s of synthesis per segment
    const e = new AudioTtsEngine('kokoro', synth.fn, async () => [], true, { segment: true });
    const segs = synthesisSegments(LONG);
    expect(segs.length).toBe(3);
    const words: string[] = [];
    let startedAt = -1;
    const h = e.speak(LONG, { voiceId: 'bf_emma', rate: 1, onStart: () => { startedAt = Date.now(); }, onWord: (i, n) => words.push(LONG.slice(i, i + n)) });
    // every segment is requested at once, in order
    expect(synth.calls.map((c) => c.text)).toEqual(segs.map((s) => s.text));
    await vi.advanceTimersByTimeAsync(1000);
    expect(startedAt).toBe(1000); // not 3000: the first segment plays while the others are synthesized
    expect(FakeAudio.instances.filter((a) => a.plays).length).toBe(1);
    await vi.advanceTimersByTimeAsync(SEG_SEC * 1000 * 3 + 100);
    expect(await h.done).toBe('ended');
    const played = FakeAudio.instances.filter((a) => a.plays);
    expect(played.map((a) => a.startedAt)).toEqual([1000, 3000, 5000]); // no gap between segments
    expect(words).toEqual([...LONG.matchAll(/[\p{L}\p{N}’']+/gu)].map((m) => m[0])); // every word, in order, sentence offsets
  });

  it('a short sentence is one request, as before', async () => {
    const synth = serialSynth(500);
    const e = new AudioTtsEngine('kokoro', synth.fn, async () => [], true, { segment: true });
    const h = e.speak('A short one.', { voiceId: 'v', rate: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await h.done).toBe('ended');
    expect(synth.calls.map((c) => c.text)).toEqual(['A short one.']);
  });

  it('trimmed local audio (the result names its end punctuation): the pause it calls for comes between segments', async () => {
    const synth = serialSynth(1000);
    // the main process trims each segment to the speech and says how the text ended
    const fn = (e: string, text: string) => synth.fn(e, text).then((r) => ({ ...r, endPunct: endPunctOf(text) }));
    const e = new AudioTtsEngine('kokoro', fn, async () => [], true, { segment: true });
    const segs = synthesisSegments(LONG);
    expect(segs.map((x) => endPunctOf(x.text))).toEqual([';', ';', '.']);
    const h = e.speak(LONG, { voiceId: 'v', rate: 1 });
    await vi.advanceTimersByTimeAsync(SEG_SEC * 1000 * 3 + 2000);
    expect(await h.done).toBe('ended');
    // 280 ms after each ';' (the next segment was ready long before)
    expect(FakeAudio.instances.filter((a) => a.plays).map((a) => a.startedAt)).toEqual([1000, 3280, 5560]);
  });

  it('the pause between segments overlaps the synthesis of the next one, and a cancel during it ends the speech', async () => {
    const synth = serialSynth(2500); // slower than the audio: the next segment is late anyway
    const fn = (e: string, text: string) => synth.fn(e, text).then((r) => ({ ...r, endPunct: endPunctOf(text) }));
    const e = new AudioTtsEngine('kokoro', fn, async () => [], true, { segment: true });
    const h = e.speak(LONG, { voiceId: 'v', rate: 1 });
    await vi.advanceTimersByTimeAsync(5100);
    // first segment 2500-4500; the second was ready at 5000: no 280 ms on top of the wait
    expect(FakeAudio.instances.filter((a) => a.plays).map((a) => a.startedAt)).toEqual([2500, 5000]);
    await vi.advanceTimersByTimeAsync(2000); // the second segment ends at 7000; the pause runs
    h.cancel();
    expect(await h.done).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeAudio.instances.filter((a) => a.plays)).toHaveLength(2); // the third never plays
  });

  it('a voice that names no end punctuation (cloud voices keep their own silence) plays its segments back to back', async () => {
    const synth = serialSynth(100);
    const fn = (e: string, text: string) => synth.fn(e, text).then((r) => ({ ...r, endPunct: null }));
    const e = new AudioTtsEngine('kokoro', fn, async () => [], true, { segment: true });
    const h = e.speak(LONG, { voiceId: 'v', rate: 1 });
    await vi.advanceTimersByTimeAsync(SEG_SEC * 1000 * 3 + 500);
    expect(await h.done).toBe('ended');
    expect(FakeAudio.instances.filter((a) => a.plays).map((a) => a.startedAt)).toEqual([100, 2100, 4100]);
  });

  it('the speed set while a long sentence plays applies to its next segments', async () => {
    const synth = serialSynth(100);
    const e = new AudioTtsEngine('kokoro', synth.fn, async () => [], true, { segment: true });
    const h = e.speak(LONG, { voiceId: 'v', rate: 1 });
    await vi.advanceTimersByTimeAsync(150);
    e.setRate(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await h.done).toBe('ended');
    expect(FakeAudio.instances.filter((a) => a.plays).map((a) => a.playbackRate)).toEqual([2, 2, 2]);
  });
});

describe('AudioTtsEngine: the next sentence is ready before it is needed', () => {
  beforeEach(() => { FakeAudio.instances.length = 0; vi.useFakeTimers({ now: 0 }); });
  afterEach(() => { vi.useRealTimers(); });

  it('readAhead fetches and pre-decodes the next sentence; speak() then only calls play()', async () => {
    const synth = serialSynth(800);
    const prepared: unknown[][] = [];
    const prepare = async (items: unknown[]) => { prepared.push(items); return true; };
    const e = new AudioTtsEngine('kokoro', synth.fn, async () => [], true, { segment: true, prepare });
    const cur = e.speak('The current sentence.', { voiceId: 'v', rate: 1 });
    e.readAhead(['The next sentence.', 'And the one after.'], 'v', 1);
    await vi.advanceTimersByTimeAsync(1700); // current ready at 800, next at 1600 (fetched after "ready")
    const next = FakeAudio.instances.find((a) => a.plays === 0)!;
    expect(next).toBeDefined();
    expect(next.loads).toBe(1); // loaded (decoded) while the current one plays
    expect(next.preload).toBe('auto');
    await vi.advanceTimersByTimeAsync(SEG_SEC * 1000);
    expect(await cur.done).toBe('ended');
    const count = FakeAudio.instances.length;
    const h = e.speak('The next sentence.', { voiceId: 'v', rate: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeAudio.instances.length).toBe(count); // no new element, no new request
    expect(next.plays).toBe(1);
    expect(e.lastStartDelayMs).toBe(0);
    expect(synth.calls.map((c) => c.text)).toEqual(['The current sentence.', 'The next sentence.']);
    h.cancel();
  });

  it('local voice: the read-ahead list replaces the previous one with priorities by distance; the next is awaited, never requested as now', async () => {
    const synth = serialSynth(100);
    const prepared: { text: string; priority?: number; wait?: boolean; replace?: boolean }[][] = [];
    let release!: (v: boolean) => void;
    const prepare = (items: { text: string }[]) => { prepared.push(items); return items.some((i) => (i as { wait?: boolean }).wait) ? new Promise<boolean>((r) => { release = r; }) : Promise.resolve(true); };
    const e = new AudioTtsEngine('kokoro', synth.fn, async () => [], true, { segment: true, prepare });
    e.readAhead(['B.', 'C.', 'D.'], 'v', 1);
    expect(prepared[0]).toEqual([{ text: '', replace: true }, { text: 'B.', voice: 'v', speed: 1, priority: PRIORITY.ahead - 1 }, { text: 'C.', voice: 'v', speed: 1, priority: PRIORITY.ahead - 2 }, { text: 'D.', voice: 'v', speed: 1, priority: PRIORITY.ahead - 3 }]);
    expect(prepared[1]).toEqual([{ text: 'B.', voice: 'v', speed: 1, priority: PRIORITY.next, wait: true }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(synth.calls).toEqual([]); // nothing requested as 'now' while the main process works on it
    release(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(synth.calls.map((c) => c.text)).toEqual(['B.']); // fetched (a memory hit in the main process) and decoded
    e.stopReadAhead();
    expect(prepared[2]).toEqual([{ text: '', replace: true }]);
  });

  it('a read-ahead dropped by the main process (false) is not fetched', async () => {
    const synth = serialSynth(100);
    const e = new AudioTtsEngine('kokoro', synth.fn, async () => [], true, { segment: true, prepare: async (items) => (items.some((i) => i.wait) ? false : true) });
    e.readAhead(['B.'], 'v', 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(synth.calls).toEqual([]);
  });

  it('cloud voices fetch only the next two sentences (they cost money)', async () => {
    const synth = serialSynth(100);
    const e = new AudioTtsEngine('edge', synth.fn, async () => [], true);
    e.readAhead(['B.', 'C.', 'D.', 'E.'], 'v', 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(synth.calls.map((c) => c.text)).toEqual(['B.', 'C.']);
  });

  it('cancelAll forgets requests nobody waits for and tells the local queue', async () => {
    const synth = serialSynth(1000);
    const prepared: unknown[][] = [];
    const e = new AudioTtsEngine('kokoro', synth.fn, async () => [], true, { segment: true, prepare: async (items) => { prepared.push(items); return true; } });
    const h = e.speak('First.', { voiceId: 'v', rate: 1 });
    e.cancelAll();
    expect(await h.done).toBe('cancelled');
    expect(prepared).toEqual([[{ text: '', release: true }]]);
    // a new speak() of the same text asks again (the main process re-raises its priority) instead of reusing the stale request
    e.speak('First.', { voiceId: 'v', rate: 1 }).cancel();
    expect(synth.calls.map((c) => c.text)).toEqual(['First.', 'First.']);
  });
});
