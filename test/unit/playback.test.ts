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
