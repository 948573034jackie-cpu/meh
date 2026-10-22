import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KokoroEngine, DroppedError, defaultThreads, type SynthesisResult } from '../../src/main/kokoro/engine';
import { handlePrepare } from '../../src/main/kokoro/ipc-prepare';
import { encodeWav } from '../../src/main/kokoro/wav';
import { synthesisSegments, endPunctOf, pauseAfter, PRIORITY } from '@core/tts/segments';

/** A fake synthesizer: every call waits until the test releases it, and the call order is recorded. */
class FakeSynth {
  calls: string[] = [];
  private waiting: { text: string; go: () => void }[] = [];
  readonly fn = (text: string): Promise<SynthesisResult> => {
    this.calls.push(text);
    return new Promise((resolve) => { this.waiting.push({ text, go: () => resolve(fakeResult(text)) }); });
  };
  /** finishes the running synthesis; returns its text */
  async finishOne(): Promise<string> {
    await this.started();
    const w = this.waiting.shift();
    if (!w) throw new Error('nothing is being synthesized');
    w.go();
    await ticks();
    return w.text;
  }
  get running(): string | undefined { return this.waiting[0]?.text; }
  /** true once a synthesis runs (background jobs start after the engine's short settle wait); false after ~40 ms */
  async started(): Promise<boolean> {
    await ticks();
    for (let i = 0; i < 20 && !this.waiting.length; i++) await new Promise((r) => setTimeout(r, 2));
    return this.waiting.length > 0;
  }
  async drain(): Promise<string[]> { const out: string[] = []; while (await this.started()) out.push(await this.finishOne()); return out; }
  /** finishes the running synthesis without waiting on timers (fake-timer tests) */
  finishNow(): void { const w = this.waiting.shift(); if (!w) throw new Error('nothing is being synthesized'); w.go(); }
}

function fakeResult(text: string): SynthesisResult {
  const words = [...text.matchAll(/[\p{L}\p{N}’']+/gu)].map((m, i) => ({ charIndex: m.index!, charLength: m[0].length, start: i * 0.3, end: i * 0.3 + 0.25 }));
  const durationSec = Math.max(1, words.length) * 0.3;
  const pcm = new Float32Array(Math.round(durationSec * 24000));
  return { pcm, sampleRate: 24000, words, durationSec, wav: encodeWav(pcm, 24000), phonemes: '', fromCache: false };
}

const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function engine(synth: FakeSynth): KokoroEngine {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-queue-'));
  return new KokoroEngine({ modelDir: cacheDir, cacheDir, persist: false, warmUp: false, synth: synth.fn });
}

const S = Array.from({ length: 10 }, (_, i) => `Sentence number ${i + 1} is here.`);

describe('Kokoro queue: what the learner waits for goes first', () => {
  it('a sentence needed now is never queued behind read-ahead requested before it', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    // ReaderView's plain prepare and a read-ahead list arrive first, in the same burst as the speak request
    void e.prepare(S.slice(1, 6).map((text) => ({ text })));
    void e.prepare(S.slice(1, 9).map((text, i) => ({ text, priority: PRIORITY.ahead - (i + 1) })), { replace: true });
    const now = e.synthesize(S[0]);
    expect(await synth.finishOne()).toBe(S[0]);
    await now;
    // then the read-ahead, nearest first
    expect(await synth.drain()).toEqual(S.slice(1, 9));
  });

  it('a request that arrives while read-ahead runs waits only for the job already running', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    void e.prepare(S.slice(1, 9).map((text, i) => ({ text, priority: PRIORITY.ahead - (i + 1) })), { replace: true });
    await synth.started();
    expect(synth.running).toBe(S[1]); // read-ahead started while nothing else was asked for
    const explanation = 'That word means a large house in the country.';
    const p = e.synthesize(explanation);
    expect(await synth.finishOne()).toBe(S[1]);
    expect(await synth.finishOne()).toBe(explanation); // the explanation jumps the other seven
    expect((await p).durationSec).toBeGreaterThan(0);
    expect(await synth.drain()).toEqual(S.slice(2, 9)); // and read-ahead goes on after it
  });

  it('the next sentence (priority next) goes before the read-ahead but after anything needed now', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    void e.prepare([{ text: S[5], priority: PRIORITY.ahead - 5 }]);
    void e.prepare([{ text: S[1], priority: PRIORITY.next }]);
    void e.synthesize(S[0]);
    expect(await synth.drain()).toEqual([S[0], S[1], S[5]]);
  });

  it('dedupes in-flight requests: the same text is synthesized once and every caller gets the result', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    const a = e.prepare([{ text: S[0], priority: PRIORITY.ahead - 1 }]);
    const b = e.synthesize(S[0]);
    const c = e.synthesize(`  ${S[0]}  `); // the renderer's untrimmed text has the same key
    await ticks();
    expect(e.queuedTexts()).toEqual([]); // running, not queued twice
    await synth.finishOne();
    const [rb, rc] = await Promise.all([b, c, a]);
    expect(rb).toBe(rc);
    expect(synth.calls).toEqual([S[0]]);
    // and afterwards it is a memory hit
    await e.synthesize(S[0]);
    expect(synth.calls).toEqual([S[0]]);
  });

  it('a queued read-ahead job that becomes needed now is moved to the front', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    void e.prepare(S.slice(0, 6).map((text, i) => ({ text, priority: PRIORITY.ahead - (i + 1) })), { replace: true });
    await synth.started();
    const p = e.synthesize(S[4]);
    expect(e.queuedTexts()[0]).toEqual({ text: S[4], priority: PRIORITY.now });
    expect(await synth.finishOne()).toBe(S[0]); // was already running
    expect(await synth.finishOne()).toBe(S[4]);
    await p;
  });

  it('replace drops queued read-ahead nobody waits for; a pause clears it; waited requests stay', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    const old = e.prepare(S.slice(1, 6).map((text, i) => ({ text, priority: PRIORITY.ahead - (i + 1) })), { replace: true });
    const wanted = e.synthesize(S[0]);
    await ticks();
    // a seek: the new read-ahead list replaces the old one
    void e.prepare(S.slice(7, 10).map((text, i) => ({ text, priority: PRIORITY.ahead - (i + 1) })), { replace: true });
    await expect(old).rejects.toBeInstanceOf(DroppedError);
    expect(e.queuedTexts().map((q) => q.text)).toEqual(S.slice(7, 10)); // S[0] is running
    e.clearReadAhead(); // paused
    expect(e.queuedTexts()).toEqual([]);
    await synth.finishOne();
    await wanted;
    expect(await synth.drain()).toEqual([]);
  });

  it('releaseWaiters: requests the renderer gave up on no longer go first and can be dropped', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    void e.synthesize(S[0]);
    const stale = e.synthesize(S[1]);
    await ticks();
    e.releaseWaiters();
    void e.synthesize(S[2]);
    expect(e.queuedTexts().map((q) => q.text)).toEqual([S[2], S[1]]);
    e.clearReadAhead();
    await expect(stale).rejects.toBeInstanceOf(DroppedError);
    expect(await synth.drain()).toEqual([S[0], S[2]]);
  });
});

describe('Kokoro queue: long sentences in segments', () => {
  const LONG = '“Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it, that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week.”';

  it('splits at clause ends, never after a title, and offsets point into the text', () => {
    const segs = synthesisSegments(`  ${LONG}`);
    expect(segs.length).toBe(3);
    for (const s of segs) {
      expect(`  ${LONG}`.slice(s.start, s.start + s.text.length)).toBe(s.text);
      expect(s.text.length).toBeLessThanOrEqual(150);
      expect(s.text).toMatch(/[;,.!?”]$/);
      expect(s.text).not.toMatch(/(Mr|Mrs)\.$/);
    }
    expect(synthesisSegments('A short sentence.')).toEqual([{ text: 'A short sentence.', start: 0 }]);
    // a segment is never split again: renderer and main process ask for the same pieces
    for (const s of segs) expect(synthesisSegments(s.text)).toEqual([{ text: s.text, start: 0 }]);
  });

  it('synthesize() of a long sentence runs one job per segment and joins them with word times mapped to the sentence', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    const p = e.synthesize(LONG);
    const segs = synthesisSegments(LONG);
    expect(await synth.drain()).toEqual(segs.map((s) => s.text));
    const r = await p;
    const expectWords = [...LONG.matchAll(/[\p{L}\p{N}’']+/gu)].map((m) => m[0]);
    expect(r.words.map((w) => LONG.slice(w.charIndex, w.charIndex + w.charLength))).toEqual(expectWords);
    for (let i = 1; i < r.words.length; i++) expect(r.words[i].start).toBeGreaterThanOrEqual(r.words[i - 1].start);
    const parts = segs.map((s) => fakeResult(s.text).durationSec);
    // between the segments, the pause their end punctuation calls for (the audio is trimmed to the speech): as the
    // renderer plays segments
    const gaps = segs.slice(0, -1).map((s) => pauseAfter(endPunctOf(s.text)) / 1000);
    expect(gaps).toEqual([0.28, 0.28]); // both end with ';'
    expect(r.durationSec).toBeCloseTo(parts.reduce((a, b) => a + b, 0) + gaps[0] + gaps[1], 5);
    expect(r.endPunct).toBe('.');
    // the first word of the second segment starts when the first segment's audio and its pause end
    const second = r.words.find((w) => w.charIndex >= segs[1].start)!;
    expect(second.start).toBeCloseTo(parts[0] + gaps[0], 5);
    expect(r.wav.length).toBe(44 + Math.round(r.durationSec * 24000) * 2);
  });

  it('prepare() of a long sentence queues the same segments the renderer asks for', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    void e.prepare([{ text: LONG }]);
    await synth.drain();
    const before = synth.calls.length;
    for (const s of synthesisSegments(LONG)) await e.synthesize(s.text);
    expect(synth.calls.length).toBe(before); // all memory hits
  });
});

describe('kokoro:prepare IPC', () => {
  it('replace, release and wait items', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    void e.synthesize(S[0]);
    await ticks();
    const ready = handlePrepare(e, [{ text: S[1], priority: PRIORITY.next, wait: true }]);
    // the following read-ahead list keeps the waited item at its priority
    void handlePrepare(e, [{ text: '', replace: true }, { text: S[1], priority: PRIORITY.ahead - 1 }, { text: S[2], priority: PRIORITY.ahead - 2 }]);
    expect(e.queuedTexts()).toEqual([{ text: S[1], priority: PRIORITY.next }, { text: S[2], priority: PRIORITY.ahead - 2 }]);
    await synth.finishOne();
    await synth.finishOne();
    expect(await ready).toBe(true);
    const dropped = handlePrepare(e, [{ text: S[5], priority: PRIORITY.next, wait: true }]);
    void handlePrepare(e, [{ text: '', replace: true }]); // pause
    expect(await dropped).toBe(false);
    await synth.drain();
    // S[2] (read-ahead) is dropped by the pause too unless it started in the meantime (it waits SETTLE_MS first)
    expect(synth.calls.slice(0, 2)).toEqual([S[0], S[1]]);
    expect(synth.calls).not.toContain(S[5]);
  });
});

describe('kokoro:prepare at priority soon (an explanation the learner will hear in a few seconds)', () => {
  it('goes after speech needed now, before the next sentence and the read-ahead; a pause (replace) drops it', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    void e.synthesize(S[0]); // running
    await ticks();
    void handlePrepare(e, [{ text: '', replace: true }, { text: S[2], priority: PRIORITY.ahead - 1 }, { text: S[3], priority: PRIORITY.ahead - 2 }]);
    void handlePrepare(e, [{ text: S[1], priority: PRIORITY.next, wait: true }]);
    const soon = handlePrepare(e, [{ text: S[7], priority: PRIORITY.soon, wait: true }]);
    void e.synthesize(S[9]); // a word said now (the 3 repeats)
    expect(e.queuedTexts().map((q) => q.text)).toEqual([S[9], S[7], S[1], S[2], S[3]]);
    await synth.drain();
    expect(await soon).toBe(true);
    const dropped = handlePrepare(e, [{ text: S[8], priority: PRIORITY.soon, wait: true }]);
    void handlePrepare(e, [{ text: '', replace: true }]); // pause / the next read-ahead list
    expect(await dropped).toBe(false);
  });
});

describe('Kokoro queue: an explanation prepared ahead (priority soon) and its drop', () => {
  it('dropTexts removes the queued jobs of those texts nobody waits for; the running one finishes; others stay', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    const running = handlePrepare(e, [{ text: S[0], voice: 'bf_emma', speed: 1, priority: PRIORITY.soon, wait: true }]);
    await synth.started();
    expect(synth.running).toBe(S[0]);
    const queued = handlePrepare(e, [{ text: S[1], voice: 'bf_emma', speed: 1, priority: PRIORITY.soon, wait: true }]);
    const waited = e.synthesize(S[2], { voice: 'bf_emma' }); // a speak() waits for this one: never dropped
    const other = handlePrepare(e, [{ text: S[3], voice: 'bf_emma', speed: 1, priority: PRIORITY.soon, wait: true }]);
    void handlePrepare(e, [{ text: S[1], voice: 'bf_emma', speed: 1, priority: PRIORITY.ahead - 1 }]); // the same text in the read-ahead
    void handlePrepare(e, [{ text: '', voice: 'bf_emma', speed: 1, drop: [S[0], S[1], S[2]] }]);
    expect(await queued).toBe(false);
    expect(e.queuedTexts().map((q) => q.text)).toEqual([S[2], S[3]]);
    expect(await synth.drain()).toEqual([S[0], S[2], S[3]]);
    expect(await running).toBe(true);
    expect(await other).toBe(true);
    await waited;
    // another voice or speed is another text
    const elsewhere = handlePrepare(e, [{ text: S[5], voice: 'bf_emma', speed: 1, priority: PRIORITY.soon, wait: true }]);
    e.dropTexts([S[5]], { voice: 'bm_george', speed: 1 });
    e.dropTexts([S[5]], { voice: 'bf_emma', speed: 1.2 });
    expect(await synth.drain()).toEqual([S[5]]);
    expect(await elsewhere).toBe(true);
  });

  it('a replace (pause, the next read-ahead list) drops a soon job nobody waits for: the invariant a Listening stop relies on', async () => {
    const synth = new FakeSynth();
    const e = engine(synth);
    void e.synthesize(S[0]);
    await synth.started();
    const soon = handlePrepare(e, [{ text: S[1], priority: PRIORITY.soon, wait: true }]);
    const kept = handlePrepare(e, [{ text: '', replace: true }, { text: S[2], priority: PRIORITY.ahead - 1 }, { text: S[3], priority: PRIORITY.soon, wait: true }]);
    expect(await soon).toBe(false);
    expect(e.queuedTexts().map((q) => q.text)).toEqual([S[3], S[2]]); // in the replacing call itself: kept
    await synth.drain();
    expect(await kept).toBe(true);
  });

  it('settle: a background job waits 10 ms before it starts, so a now request one message later goes first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const synth = new FakeSynth();
      const e = engine(synth);
      void e.prepare([{ text: S[1] }]); // ReaderView's plain prepare of the next sentence (background)
      await ticks();
      expect(synth.running).toBeUndefined();
      await vi.advanceTimersByTimeAsync(5);
      const now = e.synthesize(S[0]); // the speak() that was one IPC message behind
      await vi.advanceTimersByTimeAsync(10);
      await ticks();
      expect(synth.calls).toEqual([S[0]]);
      synth.finishNow();
      await now;
      await vi.advanceTimersByTimeAsync(10);
      await ticks();
      expect(synth.calls).toEqual([S[0], S[1]]);
      // 'next' and above start at once
      synth.finishNow();
      await ticks();
      void e.prepare([{ text: S[2], priority: PRIORITY.next }]);
      await ticks();
      expect(synth.calls).toEqual([S[0], S[1], S[2]]);
      synth.finishNow();
    } finally { vi.useRealTimers(); }
  });
});

describe('defaultThreads', () => {
  it('uses physical cores and leaves one for the app', () => {
    const env = process.env.KOKORO_THREADS; delete process.env.KOKORO_THREADS;
    try {
      expect(defaultThreads(8, 'x64', 'darwin')).toBe(3); // 4-core Intel MacBook Pro with Hyper-Threading
      expect(defaultThreads(4, 'x64', 'darwin')).toBe(2); // dual-core Intel
      expect(defaultThreads(4, 'x64', 'linux')).toBe(3);
      expect(defaultThreads(8, 'arm64', 'darwin')).toBe(4); // Apple Silicon
      expect(defaultThreads(2, 'x64', 'linux')).toBe(2);
    } finally { if (env !== undefined) process.env.KOKORO_THREADS = env; }
  });
});
