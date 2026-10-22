import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { speechRange, SPEECH_TRIM } from '../../src/main/kokoro/align';
import { KokoroEngine, trimChunk, AUDIO_FORMAT, SAMPLE_RATE, type SynthesisResult } from '../../src/main/kokoro/engine';
import { MODEL_VERSION } from '../../src/main/kokoro/download';
import { encodeWav } from '../../src/main/kokoro/wav';
import { PAD_TOKEN, type Phonemizer } from '../../src/main/kokoro/phonemes';
import { endPunctOf, pauseAfter } from '@core/tts/segments';

const SR = 24000;
const ms = (n: number) => Math.round((n / 1000) * SR);
/** a sine at `dbfs` (RMS) for `len` samples */
function tone(len: number, dbfs: number, hz = 220): Float32Array {
  const amp = Math.SQRT2 * 10 ** (dbfs / 20);
  return Float32Array.from({ length: len }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
}
function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const rmsDb = (w: Float32Array, from: number, to: number) => { let s = 0; for (let i = from; i < to; i++) s += w[i] * w[i]; return 10 * Math.log10(s / (to - from) + 1e-12); };

describe('speechRange: the silence Kokoro leaves after the last phoneme is trimmed by energy', () => {
  // 100 ms near-silence, 500 ms of speech, a soft final consonant (150 ms at -45 dBFS, like the "f" of "wife."), then
  // 600 ms of -80 dBFS: what trimRange keeps today
  const wave = () => concat(tone(ms(100), -80), tone(ms(500), -14), tone(ms(150), -45), tone(ms(600), -80));

  it('keeps the soft ending and 80 ms after it plus a 15 ms fade; removes the rest; keeps 30 ms before the speech', () => {
    const w = wave();
    const [s, e] = speechRange(w, 0, w.length, SR);
    expect(SPEECH_TRIM).toMatchObject({ floorDb: -58, rangeDb: 45, keepSec: 0.08, fadeSec: 0.015, leadSec: 0.03 });
    expect(s).toBe(ms(100 - 30));
    expect(e).toBe(ms(100 + 500 + 150 + 80 + 15)); // the -45 dBFS part is speech (above max(-58, peak - 45))
    expect(rmsDb(w, ms(600), ms(750))).toBeGreaterThan(-46); // untouched
    expect(w.length - e).toBeGreaterThan(ms(500)); // the silence is gone
  });

  it('the fade-out is linear and monotone down to 0 over the last 15 ms', () => {
    const w = wave();
    const orig = w.slice();
    const [, e] = speechRange(w, 0, w.length, SR);
    const from = e - ms(15);
    let prev = Infinity;
    for (let i = from; i < e; i++) {
      if (Math.abs(orig[i]) < 1e-7) continue;
      const gain = w[i] / orig[i];
      expect(gain).toBeLessThan(prev);
      expect(gain).toBeGreaterThanOrEqual(0);
      prev = gain;
    }
    expect(Math.abs(w[e - 1])).toBe(0);
    for (let i = ms(100); i < from; i++) expect(w[i]).toBe(orig[i]); // nothing before the fade changes
  });

  it('a stricter threshold (-40 dBFS / peak - 35 dB) would have cut the soft ending: the chosen one keeps it', () => {
    const w = wave();
    const [, strict] = speechRange(w.slice(), 0, w.length, SR, { ...SPEECH_TRIM, floorDb: -40, rangeDb: 35 });
    const [, chosen] = speechRange(w, 0, w.length, SR);
    expect(strict).toBeLessThan(ms(600 + 150)); // inside the consonant
    expect(chosen).toBeGreaterThan(ms(600 + 150));
  });

  it('speech up to the end (a clip cut inside a word) and a clip with no speech are kept whole', () => {
    const toEnd = concat(tone(ms(100), -80), tone(ms(400), -14));
    expect(speechRange(toEnd, 0, toEnd.length, SR)).toEqual([ms(70), toEnd.length]);
    const quiet = tone(ms(400), -90);
    expect(speechRange(quiet, 0, quiet.length, SR)).toEqual([0, quiet.length]);
    const tiny = tone(ms(20), -14);
    expect(speechRange(tiny, 0, tiny.length, SR)).toEqual([0, tiny.length]);
  });

  it('works inside the range trimRange gave (offsets are absolute samples)', () => {
    const w = concat(tone(ms(300), -80), tone(ms(400), -14), tone(ms(900), -80));
    const [s, e] = speechRange(w, ms(250), ms(1500), SR);
    expect(s).toBe(ms(300 - 30));
    expect(e).toBe(ms(700 + 95));
  });
});

/**
 * Where speechRange ends the audio for speech that stops at sample `speechEnd`: its 10 ms frames are counted from
 * trimRange's start (50 ms before the first phoneme, which starts after the 10-frame pad), so the end of the speech is
 * rounded up to that grid; then 80 ms + the 15 ms fade.
 */
const keptEnd = (speechEnd: number) => { const s0 = 10 * 600 - ms(50); return s0 + Math.ceil((speechEnd - s0) / 240) * 240 + ms(95); };

/** Kokoro-like model output: pad, phonemes (the last one holds the pause: 22 frames, mostly silent), '.', pad */
function modelOutput(phonemes: number) {
  const FRAME = 600; // samples per duration frame
  const durations = [10, ...Array(phonemes - 1).fill(3), 22, 2, 5];
  const speechFrames = 3 * (phonemes - 1) + 4; // the last phoneme sounds for 4 frames, then silence
  const total = durations.reduce((a, b) => a + b, 0);
  const wave = concat(tone(10 * FRAME, -85), tone(speechFrames * FRAME, -14), tone((total - 10 - speechFrames) * FRAME, -85));
  const tokens = [...Array(phonemes).fill(50), 4]; // phonemes, then '.'
  return { wave, durations, tokens, speechEnd: (10 + speechFrames) * FRAME };
}

describe('trimChunk: one model output to the kept audio and its word times', () => {
  it('word times are clamped to the kept audio and start at the offset', () => {
    const { wave, durations, tokens, speechEnd } = modelOutput(6);
    const owner = [0, 0, 0, 1, 1, 1, -1];
    const words = [{ charIndex: 0, charLength: 3 }, { charIndex: 4, charLength: 3 }];
    const { pcm, words: wt } = trimChunk(wave, durations, tokens, owner, words, ms(1000));
    const start = 10 * 600 - ms(30);
    expect(pcm.length).toBe(keptEnd(speechEnd) - start);
    const hi = (ms(1000) + pcm.length) / SR;
    expect(wt).toHaveLength(2);
    expect(wt[0].start).toBeCloseTo(1 + ms(30) / SR, 5); // the first word at the offset + the 30 ms lead
    // the last word's end held the pause frames (it ended at 1.0 + 0.97 s): clamped to the end of the kept audio
    expect(wt[1].end).toBeCloseTo(hi, 6);
    for (const w of wt) { expect(w.start).toBeGreaterThanOrEqual(1); expect(w.end).toBeLessThanOrEqual(hi + 1e-9); }
  });
});

describe('end punctuation and the cache', () => {
  it('endPunctOf: the punctuation a text ends with (closing quotes skipped), and the pause it asks for', () => {
    expect(endPunctOf('He left.')).toBe('.');
    expect(endPunctOf('“Have you heard?”  ')).toBe('?');
    expect(endPunctOf('“Stop!”')).toBe('!');
    expect(endPunctOf('“My dear Mr. Bennet,”')).toBe(',');
    expect(endPunctOf('returned she;')).toBe(';');
    expect(endPunctOf('as follows:')).toBe(':');
    expect(endPunctOf('and then —')).toBe('—');
    expect(endPunctOf('and then –')).toBe('—');
    expect(endPunctOf('and so…')).toBe('.');
    expect(endPunctOf('(see the note).')).toBe('.');
    expect(endPunctOf('a cut at a space')).toBeNull();
    expect(endPunctOf('')).toBeNull();
    expect([',', ';', '.', null].map((p) => pauseAfter(p as never))).toEqual([180, 280, 350, 0]);
  });

  it('cacheKey has the audio format in it: WAVs made before the trim are not reused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-trim-'));
    const e = new KokoroEngine({ modelDir: dir, cacheDir: dir, persist: false, warmUp: false });
    const old = crypto.createHash('sha1').update(`${MODEL_VERSION}\0bf_emma\0${(1).toFixed(2)}\0Hello.`).digest('hex');
    expect(AUDIO_FORMAT).toBe('trim2');
    expect(e.cacheKey('Hello.', 'bf_emma', 1)).not.toBe(old);
    expect(e.cacheKey('Hello.', 'bf_emma', 1)).toBe(crypto.createHash('sha1').update(`${MODEL_VERSION}/trim2\0bf_emma\0${(1).toFixed(2)}\0Hello.`).digest('hex'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('every result names its end punctuation, also when read back from the disk cache', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-trim-'));
    const fake = (text: string): SynthesisResult => { const pcm = new Float32Array(240); return { pcm, sampleRate: 24000, words: [], durationSec: 0.01, wav: encodeWav(pcm, 24000), phonemes: text, fromCache: false }; };
    const a = new KokoroEngine({ modelDir: dir, cacheDir: dir, warmUp: false, synth: async (t) => fake(t) });
    expect((await a.synthesize('Well, then,')).endPunct).toBe(',');
    expect((await a.synthesize('Is it?')).endPunct).toBe('?');
    const json = path.join(dir, `${a.cacheKey('Is it?', 'bf_emma', 1)}.json`);
    for (let i = 0; i < 100 && !fs.existsSync(json); i++) await new Promise((r) => setTimeout(r, 5));
    const b = new KokoroEngine({ modelDir: dir, cacheDir: dir, warmUp: false, synth: async () => { throw new Error('not from the cache'); } });
    const r = await b.synthesize('Is it?');
    expect(r.fromCache).toBe(true);
    expect(r.endPunct).toBe('?');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('KokoroEngine.run (a fake model): trimmed audio, clamped words, end punctuation', () => {
  it('a sentence comes back trimmed to the speech plus 95 ms, with its words inside and its end punctuation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-trim-'));
    const e = new KokoroEngine({ modelDir: dir, cacheDir: dir, persist: false, warmUp: false });
    // one letter = one phoneme; the model gives the last phoneme the sentence-final pause, as Kokoro does
    const phonemize: Phonemizer = async (text) => [text.toLowerCase()];
    let speechEnd = 0;
    const inference = {
      where: 'inline' as const,
      async run(ids: BigInt64Array) {
        const tokens = Array.from(ids.slice(1, -1), Number);
        const durations = [10, ...tokens.map(() => 3), 5];
        let last = tokens.length - 1;
        while (last >= 0 && tokens[last] <= 16) last--;
        durations[last + 1] = 22;
        const frames = durations.reduce((a, b) => a + b, 0);
        const speechFrames = durations.slice(1, last + 1).reduce((a, b) => a + b, 0) + 4;
        speechEnd = (10 + speechFrames) * 600;
        const waveform = concat(tone(10 * 600, -85), tone(speechFrames * 600, -14), tone((frames - 10 - speechFrames) * 600, -85));
        expect(ids[0]).toBe(BigInt(PAD_TOKEN));
        return { waveform, duration: BigInt64Array.from(durations, (v) => BigInt(v)) };
      },
      async release() { /* nothing */ },
    };
    Object.assign(e as unknown as Record<string, unknown>, { inference, voices: new Map([['bf_emma', new Float32Array(510 * 256)]]), phonemizer: phonemize, loaded: true });
    const r = await e.synthesize('Hi you, mate.');
    expect(r.endPunct).toBe('.');
    expect(r.durationSec).toBeCloseTo((keptEnd(speechEnd) - (10 * 600 - ms(30))) / SAMPLE_RATE, 6);
    expect(r.words.map((w) => w.charIndex)).toEqual([0, 3, 8]);
    for (const w of r.words) expect(w.end).toBeLessThanOrEqual(r.durationSec + 1e-9);
    expect(r.words[2].end).toBeCloseTo(r.durationSec, 6); // "mate" held the pause frames: clamped
    expect(rmsDb(r.pcm as Float32Array, r.pcm.length - ms(15), r.pcm.length)).toBeLessThan(-80); // faded out
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
