import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitPieces, normalizeWord } from '../../src/main/kokoro/text';
import { textToChunks, tokenize, fixPhonemes, proportionalCounts, VOCAB, SPACE_TOKEN, type Phonemizer } from '../../src/main/kokoro/phonemes';
import { wordTimes, trimRange } from '../../src/main/kokoro/align';
import { encodeWav, decodeWav } from '../../src/main/kokoro/wav';
import { parseNpy, readVoicesNpz } from '../../src/main/kokoro/npz';
import { isPresent, presentVariant, MODEL_FILES, VOICES_FILE } from '../../src/main/kokoro/download';

describe('kokoro text pieces', () => {
  it('splits words and punctuation keeping original offsets', () => {
    const p = splitPieces('Hello, world! "Don’t" (stop)...');
    expect(p.map((x) => [x.kind, x.spoken, x.charIndex, x.charLength])).toEqual([
      ['word', 'Hello', 0, 5], ['punct', ',', 5, 1], ['word', 'world', 7, 5], ['punct', '!', 12, 1], ['punct', '"', 14, 1],
      ['word', "Don't", 15, 5], ['punct', '"', 20, 1], ['punct', '«', 22, 1], ['word', 'stop', 23, 4], ['punct', '»', 27, 1], ['punct', '.', 28, 3],
    ]);
  });
  it('keeps the full stop out of ordinary words but inside titles', () => {
    const p = splitPieces('Mr. Darcy left. Dr. Who');
    expect(p.map((x) => x.spoken)).toEqual(['Mister', 'Darcy', 'left', '.', 'Doctor', 'Who']);
    expect(p[2]).toMatchObject({ charIndex: 10, charLength: 4 });
  });
  it('normalises numbers, money, years and times', () => {
    expect(normalizeWord('1999')).toBe('19 99');
    expect(normalizeWord('2005')).toBe('2005');
    expect(normalizeWord('2024')).toBe('20 24');
    expect(normalizeWord('1800')).toBe('18 hundred');
    expect(normalizeWord('42')).toBe('42');
    expect(normalizeWord('1,250')).toBe('1250');
    expect(normalizeWord('3.14')).toBe('3 point 1 4');
    expect(normalizeWord('$5.50')).toBe('5 dollars and 50 cents');
    expect(normalizeWord('£1')).toBe('1 pound');
    expect(normalizeWord('10:30')).toBe('10 30');
    expect(normalizeWord('9:05')).toBe('9 oh 5');
    expect(normalizeWord('U.S.A')).toBe('U S A');
    expect(normalizeWord('BBC')).toBe('BBC');
    expect(normalizeWord('NHS')).toBe('N H S');
  });
});

/** A fake G2P: each word becomes its lowercase letters; "was the" is merged into one group like espeak does. */
const fakePhonemize: Phonemizer = async (text) => [text.toLowerCase().replace(/was the/g, 'wasthe')];

describe('kokoro chunks and token ownership', () => {
  it('maps every token to its word and inserts punctuation tokens', async () => {
    const chunks = await textToChunks('Hi you, mate.', 'en', fakePhonemize);
    expect(chunks).toHaveLength(1);
    const c = chunks[0];
    expect(c.words.map((w) => [w.charIndex, w.charLength])).toEqual([[0, 2], [3, 3], [8, 4]]);
    expect(c.phonemes).toBe('hi you, mate.');
    expect(c.tokens).toEqual(tokenize('hi you, mate.'));
    expect(c.owner).toEqual([0, 0, -1, 1, 1, 1, -1, -1, 2, 2, 2, 2, -1]);
  });
  it('splits merged phoneme groups over the words proportionally', async () => {
    const [c] = await textToChunks('It was the best', 'en', fakePhonemize);
    expect(c.words).toHaveLength(4);
    // the model input keeps espeak's own spacing ("it wasthe best"), ownership splits "wasthe" 3/3
    expect(c.tokens).toEqual(tokenize('it wasthe best'));
    expect(c.owner).toEqual([0, 0, -1, 1, 1, 1, 2, 2, 2, -1, 3, 3, 3, 3]);
    expect(c.tokens.filter((t) => t === SPACE_TOKEN)).toHaveLength(2);
  });
  it('cuts long texts at sentence ends under the token limit', async () => {
    const sentence = 'word '.repeat(60).trim() + '. ';
    const chunks = await textToChunks(sentence.repeat(4), 'en', fakePhonemize);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokens.length).toBeLessThanOrEqual(510);
    expect(chunks.reduce((n, c) => n + c.words.length, 0)).toBe(240);
  });
  it('proportionalSplit and fixPhonemes', () => {
    expect(proportionalCounts(6, [1, 1])).toEqual([3, 3]);
    expect(proportionalCounts(7, [1, 2, 4])).toEqual([1, 2, 4]);
    expect(proportionalCounts(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(fixPhonemes('wˈɜːrld x ʲ', 'en')).toBe('wˈɜːɹld k j');
    expect(VOCAB.get('ˈ')).toBe(156);
    expect(tokenize('a?z')).toEqual([43, 6, 68]);
  });
});

describe('kokoro word timing', () => {
  it('turns token durations into word times, scaled to the waveform', () => {
    // tokens: h i _ y o (pads around) -> durations per token incl. pads
    const durations = [10, 2, 2, 1, 3, 3, 10]; // sum 31 frames
    const samples = 3100; // 100 samples per frame
    const owner = [0, 0, -1, 1, 1];
    const words = [{ charIndex: 0, charLength: 2 }, { charIndex: 3, charLength: 2 }];
    const t = wordTimes(durations, owner, words, samples, 1000);
    expect(t).toEqual([
      { charIndex: 0, charLength: 2, start: 1.0, end: 1.4 },
      { charIndex: 3, charLength: 2, start: 1.5, end: 2.1 },
    ]);
    const shifted = wordTimes(durations, owner, words, samples, 1000, -1000);
    expect(shifted[0].start).toBeCloseTo(0);
  });
  it('accepts BigInt64Array durations (what onnxruntime returns)', () => {
    const t = wordTimes(BigInt64Array.from([5n, 5n, 5n]), [0], [{ charIndex: 0, charLength: 1 }], 1500, 1000);
    expect(t[0]).toEqual({ charIndex: 0, charLength: 1, start: 0.5, end: 1.0 });
  });
  it('trims the leading and trailing pad silence', () => {
    const durations = [10, 5, 5, 4, 20]; // pad, a, b, '.', pad
    const tokens = [43, 44, 4];
    const [s, e] = trimRange(durations, tokens, 4400, 1000, 0.05, 0.1);
    expect(s).toBe(950);        // first token at 1000, keep 50 ms
    expect(e).toBe(2100);       // last word ends at 2000 ('.' and pad are silence), keep 100 ms
  });
});

describe('kokoro wav and npz', () => {
  it('round-trips 16-bit WAV', () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1, 2]);
    const wav = encodeWav(pcm, 24000);
    expect(wav.length).toBe(44 + 12);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    const back = decodeWav(wav);
    expect(back.sampleRate).toBe(24000);
    expect(Array.from(back.pcm)).toEqual([0, 16384, -16384, 32767, -32768, 32767]);
  });
  it('parses .npy float32 arrays and .npz voice archives', async () => {
    const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 1, 2), }";
    const pad = ' '.repeat((16 - ((10 + header.length + 1) % 16)) % 16) + '\n';
    const h = Buffer.from(header + pad, 'latin1');
    const npy = Buffer.concat([Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]), Buffer.from([h.length & 255, h.length >> 8]), h, Buffer.from(new Float32Array([1, 2, 3, 4]).buffer)]);
    expect(Array.from(parseNpy(npy))).toEqual([1, 2, 3, 4]);
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip(); zip.file('bf_emma.npy', npy); zip.file('readme.txt', 'x');
    const voices = await readVoicesNpz(await zip.generateAsync({ type: 'nodebuffer' }));
    expect([...voices.keys()]).toEqual(['bf_emma']);
    expect(voices.get('bf_emma')![3]).toBe(4);
  });
});

describe('kokoro model files', () => {
  it('detects complete files by size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-test-'));
    expect(isPresent(dir, 'fp16')).toBe(false);
    expect(presentVariant(dir, 'fp16')).toBeNull();
    fs.writeFileSync(path.join(dir, MODEL_FILES.fp16.name), Buffer.alloc(10));
    fs.writeFileSync(path.join(dir, VOICES_FILE.name), Buffer.alloc(10));
    expect(isPresent(dir, 'fp16')).toBe(false);
    fs.truncateSync(path.join(dir, MODEL_FILES.fp16.name), MODEL_FILES.fp16.size);
    fs.truncateSync(path.join(dir, VOICES_FILE.name), VOICES_FILE.size);
    expect(isPresent(dir, 'fp16')).toBe(true);
    expect(presentVariant(dir, 'int8')).toBe('fp16');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// Real-model smoke test: runs only when KOKORO_MODEL_DIR holds the downloaded files (see scripts/kokoro-bench.mjs).
const modelDir = process.env.KOKORO_MODEL_DIR ?? '';
const haveModel = !!modelDir && presentVariant(modelDir, 'fp16') !== null;
describe.skipIf(!haveModel)('kokoro engine (real model)', () => {
  it('synthesizes a sentence with word timings and caches it on disk', async () => {
    const { KokoroEngine } = await import('../../src/main/kokoro/engine');
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-cache-'));
    const engine = new KokoroEngine({ modelDir, cacheDir, threads: 2, warmUp: false });
    const text = 'Hello there, my friend.';
    const r = await engine.synthesize(text, { voice: 'bf_emma' });
    expect(r.sampleRate).toBe(24000);
    expect(r.durationSec).toBeGreaterThan(0.8);
    expect(r.durationSec).toBeLessThan(4);
    expect(r.words.map((w) => text.slice(w.charIndex, w.charIndex + w.charLength))).toEqual(['Hello', 'there', 'my', 'friend']);
    for (let i = 1; i < r.words.length; i++) expect(r.words[i].start).toBeGreaterThanOrEqual(r.words[i - 1].end - 1e-6);
    expect(r.words[r.words.length - 1].end).toBeLessThanOrEqual(r.durationSec + 1e-6);
    expect(r.fromCache).toBe(false);
    await new Promise((res) => setTimeout(res, 200));
    expect(fs.existsSync(engine.wavPath(text, 'bf_emma', 1))).toBe(true);
    engine.clearMemory();
    const again = await engine.synthesize(text, { voice: 'bf_emma' });
    expect(again.fromCache).toBe(true);
    expect(again.words).toEqual(r.words);
    await engine.release();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }, 120_000);
});
