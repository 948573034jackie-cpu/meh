import { describe, it, expect } from 'vitest';
import { Playback } from '@core/listen/playback';
import { FakeTtsEngine } from '@core/tts/fake';
import { nextPosition, prevPosition, paragraphStart, percentAt, firstPosition } from '@core/nav';
import { makeBook } from './helpers';

const book = makeBook([
  { title: 'One', paragraphs: ['First sentence here. Second sentence here.', 'Third one.'] },
  { title: 'Two', paragraphs: ['Fourth one. Fifth one.'] },
]);

describe('nav', () => {
  it('walks sentences across paragraphs and chapters', () => {
    const p0 = firstPosition(book)!;
    expect(p0).toEqual({ chapter: 0, paragraph: 0, sentence: 0 });
    const seq = []; let p: typeof p0 | null = p0;
    while (p) { seq.push(`${p.chapter}.${p.paragraph}.${p.sentence}`); p = nextPosition(book, p); }
    expect(seq).toEqual(['0.0.0', '0.0.1', '0.1.0', '1.0.0', '1.0.1']);
    expect(prevPosition(book, { chapter: 1, paragraph: 0, sentence: 0 })).toEqual({ chapter: 0, paragraph: 1, sentence: 0 });
    expect(prevPosition(book, p0)).toBeNull();
    expect(paragraphStart(book, p0, 1)).toEqual({ chapter: 0, paragraph: 1, sentence: 0 });
    expect(paragraphStart(book, { chapter: 1, paragraph: 0, sentence: 1 }, -1)).toEqual({ chapter: 0, paragraph: 1, sentence: 0 });
    expect(percentAt(book, { chapter: 1, paragraph: 0, sentence: 0 })).toBeCloseTo(66.7, 0);
  });
});

function makePlayback(engine: FakeTtsEngine, pauseMs = 0) {
  return new Playback(book, { engine: () => engine, voice: () => ({ voiceId: 'fake-gb', rate: 1 }), pauseMs: () => pauseMs });
}

describe('Playback', () => {
  it('reads every sentence in order and emits word events', async () => {
    const engine = new FakeTtsEngine(1);
    const pb = makePlayback(engine);
    const sentences: string[] = []; let words = 0;
    pb.on('sentence', (p) => sentences.push(`${p.chapter}.${p.paragraph}.${p.sentence}`));
    pb.on('word', () => words++);
    const finished = new Promise<void>((r) => pb.on('finished', r));
    pb.play();
    await finished;
    expect(sentences).toEqual(['0.0.0', '0.0.1', '0.1.0', '1.0.0', '1.0.1']);
    expect(engine.spoken.map((s) => s.text)).toEqual(['First sentence here.', 'Second sentence here.', 'Third one.', 'Fourth one.', 'Fifth one.']);
    expect(words).toBeGreaterThan(5);
    expect(pb.state).toBe('idle');
    expect(pb.sentencesInLast(60).length).toBe(5);
  });

  it('pauses and resumes from the start of the current sentence', async () => {
    const engine = new FakeTtsEngine(20);
    const pb = makePlayback(engine);
    pb.play();
    await new Promise((r) => setTimeout(r, 60));
    pb.pause();
    expect(pb.state).toBe('paused');
    const spokenBefore = engine.spoken.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(engine.spoken.length).toBe(spokenBefore);
    pb.resume();
    expect(pb.state).toBe('playing');
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.spoken[engine.spoken.length - 1].text).toBe(engine.spoken[spokenBefore - 1].text);
    pb.stop();
  });

  it('stops at a hard word, runs the hook, and continues with the next sentence', async () => {
    const engine = new FakeTtsEngine(2);
    const pb = makePlayback(engine);
    const stops: { pos: string; token: number | null }[] = [];
    pb.hooks = {
      stopAt: (pos) => (pos.chapter === 0 && pos.paragraph === 0 && pos.sentence === 1 ? 1 : null), // stop at 'sentence' in 'Second sentence here.'
      onStop: async (pos, token) => { stops.push({ pos: `${pos.chapter}.${pos.paragraph}.${pos.sentence}`, token }); await new Promise((r) => setTimeout(r, 5)); return 'next'; },
    };
    const states: string[] = [];
    pb.on('state', (s) => states.push(s));
    const finished = new Promise<void>((r) => pb.on('finished', r));
    pb.play();
    await finished;
    expect(stops).toEqual([{ pos: '0.0.1', token: 1 }]);
    expect(states).toContain('explaining');
    expect(engine.spoken.map((s) => s.text)).toEqual(['First sentence here.', 'Second sentence here.', 'Third one.', 'Fourth one.', 'Fifth one.']);
  });

  it("'end' stops after the sentence and seek restarts playback there", async () => {
    const engine = new FakeTtsEngine(1);
    const pb = makePlayback(engine);
    let hookCalls = 0;
    pb.hooks = { stopAt: (pos) => (pos.chapter === 0 && pos.paragraph === 1 ? 'end' : null), onStop: async () => { hookCalls++; return 'stop'; } };
    const paused = new Promise<void>((r) => pb.on('state', (s) => { if (s === 'paused') r(); }));
    pb.play();
    await paused;
    expect(hookCalls).toBe(1);
    expect(pb.position).toEqual({ chapter: 0, paragraph: 1, sentence: 0 });
    pb.hooks = {};
    pb.seek({ chapter: 1, paragraph: 0, sentence: 1 });
    expect(pb.state).toBe('paused');
    const finished = new Promise<void>((r) => pb.on('finished', r));
    pb.play();
    await finished;
    expect(engine.spoken[engine.spoken.length - 1].text).toBe('Fifth one.');
  });
});

// ---- regression tests ----------------------------------------------------------------------------

/** Engine that reports no word boundaries at all (online Web Speech voices, OpenAI audio before estimation). */
class SilentEngine extends FakeTtsEngine {
  override speak(text: string, opts: Parameters<FakeTtsEngine['speak']>[1]) { return super.speak(text, { ...opts, onWord: undefined }); }
}

class FailingEngine extends FakeTtsEngine {
  override speak(text: string, opts: Parameters<FakeTtsEngine['speak']>[1]) {
    const h = super.speak(text, opts);
    const out: typeof h = { cancel: () => h.cancel(), done: h.done.then((o) => { if (o !== 'ended') return o; out.error = new Error('Microsoft voice returned no audio'); return 'error' as const; }) };
    return out;
  }
}

/** Engine whose first attempt at every sentence fails (a synthesizer hiccup the engine then clears). */
class FlakyEngine extends FakeTtsEngine {
  failed = new Set<string>();
  override speak(text: string, opts: Parameters<FakeTtsEngine['speak']>[1]) {
    const h = super.speak(text, opts);
    if (this.failed.has(text)) return h;
    this.failed.add(text);
    const out: typeof h = { cancel: () => h.cancel(), done: h.done.then((o) => { if (o !== 'ended') return o; out.error = new Error('The Mac voice did not start'); return 'error' as const; }) };
    return out;
  }
}

describe('Playback regressions', () => {
  it('re-reads a sentence after one speech error and only reports two errors in a row', async () => {
    const engine = new FlakyEngine(1);
    const pb = makePlayback(engine);
    const errors: string[] = [];
    pb.on('error', (e) => errors.push(e.message));
    const finished = new Promise<void>((r) => pb.on('finished', r));
    pb.play();
    await finished;
    expect(errors).toEqual([]);
    expect(engine.spoken.map((s) => s.text)).toEqual(['First sentence here.', 'First sentence here.', 'Second sentence here.', 'Second sentence here.', 'Third one.', 'Third one.', 'Fourth one.', 'Fourth one.', 'Fifth one.', 'Fifth one.']);
    expect(pb.state).toBe('idle');
  });

  it('stops with the engine message when a sentence fails twice in a row', async () => {
    const engine = new FailingEngine(1);
    const pb = makePlayback(engine);
    const errors: string[] = [];
    pb.on('error', (e) => errors.push(e.message));
    const paused = new Promise<void>((r) => pb.on('state', (s) => { if (s === 'paused') r(); }));
    pb.play();
    await paused;
    expect(engine.spoken.map((s) => s.text)).toEqual(['First sentence here.', 'First sentence here.']);
    expect(errors).toEqual(['Microsoft voice returned no audio']);
    expect(pb.position).toEqual({ chapter: 0, paragraph: 0, sentence: 0 });
  });

  it('stops for a hard word even when it is the last word of the sentence', async () => {
    const engine = new FakeTtsEngine(2);
    const pb = makePlayback(engine);
    const stops: { pos: string; token: number | null }[] = [];
    // 'Third one.' -> tokens [Third, one, .]; the hard word 'one' (index 1) is the last word
    pb.hooks = {
      stopAt: (pos) => (pos.chapter === 0 && pos.paragraph === 1 ? 1 : null),
      onStop: async (pos, token) => { stops.push({ pos: `${pos.chapter}.${pos.paragraph}.${pos.sentence}`, token }); return 'next'; },
    };
    const finished = new Promise<void>((r) => pb.on('finished', r));
    pb.play();
    await finished;
    expect(stops).toEqual([{ pos: '0.1.0', token: 1 }]);
  });

  it('stops for a hard word when the engine delivers no word boundaries', async () => {
    const engine = new SilentEngine(2);
    const pb = makePlayback(engine);
    const stops: number[] = [];
    pb.hooks = { stopAt: (pos) => (pos.chapter === 0 && pos.paragraph === 0 && pos.sentence === 0 ? 1 : null), onStop: async (_p, t) => { stops.push(t ?? -1); return 'next'; } };
    const finished = new Promise<void>((r) => pb.on('finished', r));
    pb.play();
    await finished;
    expect(stops).toEqual([1]);
  });

  it('reports the engine error message', async () => {
    const engine = new FailingEngine(1);
    const pb = makePlayback(engine);
    const errors: string[] = [];
    pb.on('error', (e) => errors.push(e.message));
    const paused = new Promise<void>((r) => pb.on('state', (s) => { if (s === 'paused') r(); }));
    pb.play();
    await paused;
    expect(errors).toEqual(['Microsoft voice returned no audio']);
  });

  it('"last N seconds" includes the sentence that was being spoken when the learner paused, without duplicates', async () => {
    const engine = new FakeTtsEngine(20);
    const pb = makePlayback(engine);
    pb.play();
    await new Promise((r) => setTimeout(r, 40));
    pb.pause();
    expect(pb.sentencesInLast(30)).toEqual([{ chapter: 0, paragraph: 0, sentence: 0 }]);
    pb.resume();
    await new Promise((r) => setTimeout(r, 40));
    pb.pause();
    // the same sentence was started twice: reported once
    expect(pb.sentencesInLast(30)).toEqual([{ chapter: 0, paragraph: 0, sentence: 0 }]);
  });

  it('a seek to an empty paragraph continues with the next sentence instead of ending the book', async () => {
    const gapBook = makeBook([{ title: 'One', paragraphs: ['Alpha beta.'] }, { title: 'Two', paragraphs: ['', 'Gamma delta.'] }]);
    const engine = new FakeTtsEngine(1);
    const pb = new Playback(gapBook, { engine: () => engine, voice: () => ({ voiceId: 'fake-gb', rate: 1 }), pauseMs: () => 0 });
    let finished = false; pb.on('finished', () => { finished = true; });
    const sentences: string[] = []; pb.on('sentence', (p) => sentences.push(`${p.chapter}.${p.paragraph}.${p.sentence}`));
    pb.play({ chapter: 1, paragraph: 0, sentence: 0 });
    await new Promise((r) => setTimeout(r, 80));
    expect(engine.spoken.map((s) => s.text)).toEqual(['Gamma delta.']);
    expect(sentences).toContain('1.1.0');
    expect(finished).toBe(true);
  });
});

import { sentenceKey } from '@core/model';
import { stripInline, DEFAULT_SKIP, skippedSentences } from '@core/import/skip';
describe('Playback skip panel', () => {
  it('skips whole sentences and speaks stripped text', async () => {
    const book = makeBook([{ title: 'One', paragraphs: ['Hello there (Smith, 2020).', '12', 'The end.'] }]);
    const engine = new FakeTtsEngine(0);
    const settings = { ...DEFAULT_SKIP, citations: true };
    const skipped = skippedSentences(book, settings);
    const pb = new Playback(book, {
      engine: () => engine, voice: () => ({ voiceId: 'fake-gb', rate: 1 }), pauseMs: () => 0,
      shouldSkip: (p) => skipped.has(sentenceKey(p)), strip: (t) => stripInline(t, settings),
    });
    const done = new Promise<void>((r) => pb.on('finished', r));
    pb.play();
    await done;
    expect(engine.spoken.map((s) => s.text)).toEqual(['Hello there.', 'The end.']);
  });
});
