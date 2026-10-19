import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Playback, READ_AHEAD_SENTENCES } from '@core/listen/playback';
import { FakeTtsEngine } from '@core/tts/fake';
import type { CloudTtsResult } from '@shared/api';
import { sentenceKey } from '@core/model';
import { makeBook } from './helpers';
import { KokoroEngine, type SynthesisResult } from '../../src/main/kokoro/engine';
import { handlePrepare } from '../../src/main/kokoro/ipc-prepare';
import { encodeWav } from '../../src/main/kokoro/wav';

class FakeAudio {
  preload = ''; preservesPitch = false; playbackRate = 1; currentTime = 0; duration = 0.02;
  onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(public src: string) {}
  load() { /* decoded */ }
  play() { this.onplaying?.(); setTimeout(() => { this.currentTime = this.duration; this.onended?.(); }, 15); return Promise.resolve(); }
  pause() { /* noop */ }
}
Object.assign(globalThis, {
  Audio: FakeAudio,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 4),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
const { AudioTtsEngine } = await import('@core/tts/audio');

const SENTENCES = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} is a sentence of the book.`);
const book = makeBook([{ title: 'One', paragraphs: [SENTENCES.slice(0, 6).join(' '), SENTENCES.slice(6).join(' ')] }]);

/** records the order of speak / readAhead / stopReadAhead calls */
class ReadAheadEngine extends FakeTtsEngine {
  log: string[] = [];
  aheads: string[][] = [];
  override speak(text: string, opts: Parameters<FakeTtsEngine['speak']>[1]) { this.log.push(`speak ${text}`); return super.speak(text, opts); }
  readAhead(texts: string[]) { this.log.push('readAhead'); this.aheads.push(texts); }
  stopReadAhead() { this.log.push('stop'); }
}

describe('Playback read-ahead', () => {
  it('asks for the current sentence first, then hands the engine up to 8 sentences ahead, and stops the read-ahead on pause', async () => {
    const engine = new ReadAheadEngine(0.5);
    const skipped = new Set([sentenceKey({ chapter: 0, paragraph: 0, sentence: 2 })]);
    const pb = new Playback(book, { engine: () => engine, voice: () => ({ voiceId: 'v', rate: 1 }), pauseMs: () => 0, shouldSkip: (p) => skipped.has(sentenceKey(p)) });
    const second = new Promise<void>((r) => { let n = 0; pb.on('sentence', () => { if (++n === 2) r(); }); });
    pb.play();
    await second;
    expect(engine.log.slice(0, 2)).toEqual([`speak ${SENTENCES[0]}`, 'readAhead']);
    expect(engine.aheads[0].length).toBe(READ_AHEAD_SENTENCES);
    expect(engine.aheads[0][0]).toBe(SENTENCES[1]);
    expect(engine.aheads[0]).not.toContain(SENTENCES[2]); // Skip panel
    expect(engine.aheads[0][1]).toBe(SENTENCES[3]);
    pb.pause();
    expect(engine.log[engine.log.length - 1]).toBe('stop');
    pb.stop();
  });

  it('limits the read-ahead to about a minute of speech', async () => {
    const long = Array.from({ length: 10 }, (_, i) => `${'Long words that go on and on, '.repeat(10)}number ${i}.`); // ~300 chars = 20 s each
    const b = makeBook([{ title: 'L', paragraphs: [long.join(' ')] }]);
    const engine = new ReadAheadEngine(0.01);
    const pb = new Playback(b, { engine: () => engine, voice: () => ({ voiceId: 'v', rate: 1 }), pauseMs: () => 0 });
    pb.play();
    await new Promise((r) => setTimeout(r, 5));
    expect(engine.aheads[0].length).toBe(3); // 3 x 20 s reaches 60 s
    pb.stop();
  });
});

describe('Playback + Kokoro queue: the sentence being read is never synthesized after read-ahead', () => {
  it('first the current sentence, then the next one, then the rest, even when another prepare came first', async () => {
    const calls: string[] = [];
    const fakeResult = (text: string): SynthesisResult => {
      const pcm = new Float32Array(240);
      return { pcm, sampleRate: 24000, words: [], durationSec: 0.01, wav: encodeWav(pcm, 24000), phonemes: '', fromCache: false };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-pb-'));
    // a slow fake synthesizer: 30 ms per sentence, one at a time
    const main = new KokoroEngine({ modelDir: dir, cacheDir: dir, persist: false, warmUp: false, synth: async (text) => { calls.push(text); await new Promise((r) => setTimeout(r, 30)); return fakeResult(text); } });
    const toCloud = (r: SynthesisResult): CloudTtsResult => ({ audio: new ArrayBuffer(r.wav.byteLength), mime: 'audio/wav', timings: [], durationSec: r.durationSec });
    const audio = new AudioTtsEngine('kokoro', (_e, text) => main.synthesize(text).then(toCloud), async () => [], true, {
      segment: true,
      prepare: async (items) => (await handlePrepare(main, items)) ?? undefined,
    });
    const pb = new Playback(book, { engine: () => audio, voice: () => ({ voiceId: 'bf_emma', rate: 1 }), pauseMs: () => 0 });
    // ReaderView prepares the next five on every 'sentence' event, before Playback speaks
    pb.on('sentence', (p) => { void main.prepare(SENTENCES.slice(p.sentence + 1, p.sentence + 6).map((text) => ({ text, voice: 'bf_emma', speed: 1 }))); });
    const third = new Promise<void>((r) => { let n = 0; pb.on('sentence', () => { if (++n === 3) r(); }); });
    pb.play();
    await third;
    pb.pause();
    expect(calls[0]).toBe(SENTENCES[0]);
    expect(calls[1]).toBe(SENTENCES[1]);
    expect(calls.slice(0, 3)).toEqual(SENTENCES.slice(0, 3)); // read-ahead in reading order
    expect(new Set(calls).size).toBe(calls.length); // nothing synthesized twice
    await new Promise((r) => setTimeout(r, 80));
    const after = calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.length).toBe(after); // paused: the read-ahead stopped
  });
});
