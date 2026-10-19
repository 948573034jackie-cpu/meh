import { describe, it, expect } from 'vitest';
import { Playback } from '@core/listen/playback';
import { ListenController, type ListenDeps } from '@core/listen/controller';
import { FakeTtsEngine } from '@core/tts/fake';
import type { Dictionary, DictEntry } from '@core/dict/types';
import type { ExplainRequest } from '@shared/api';
import type { Position } from '@core/model';
import { DEFAULT_SETTINGS, type Settings, type VocabState } from '@shared/settings';
import { makeBook } from './helpers';

const HARD: Record<string, string> = { sanguine: '乐观的', acrimonious: '尖刻的' };

function entry(word: string, level: DictEntry['level']): DictEntry {
  return { word, ipa: '', zh: HARD[word] ?? '词', tags: [], frq: 100, bnc: 100, collins: 1, oxford: false, level, levelSource: 'cefrj' };
}
const dict: Dictionary = {
  size: 1,
  lookup: (t) => { const w = t.toLowerCase(); return { entry: entry(w, HARD[w] ? 'C1' : 'A1'), lemma: w, via: 'exact' }; },
  lookupPhrase: () => null,
  lemmaOf: (t) => t.toLowerCase(),
};

function fakeAi() {
  const calls: { req: ExplainRequest; cancelled: boolean; resolve: (text: string) => void }[] = [];
  const explain: ListenDeps['explain'] = (req) => {
    let resolve!: (t: string) => void; let reject!: (e: Error) => void;
    const done = new Promise<string>((res, rej) => { resolve = res; reject = rej; }).then((text) => ({ text, usage: { usd: 0.001, dailyUsd: 0.01, monthlyUsd: 0.1 } }));
    done.catch(() => undefined);
    const call = { req, cancelled: false, resolve };
    calls.push(call);
    return { done, cancel: () => { call.cancelled = true; reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })); } };
  };
  return { calls, explain };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await sleep(5); }
}

let mode: 'reading' | 'listening' = 'listening';
function setup(paragraphs: string[], patch: Partial<Settings['listen']> = {}) {
  const book = makeBook([{ title: 'One', paragraphs }]);
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  settings.voice.pauseBetweenSentencesMs = 0;
  settings.ai.styles = { custom: { shape: { wordBefore: 1, wordAfter: 1, sentenceAfterWord: 1, sentenceBefore: 1, sentenceAfter: 1 } } };
  Object.assign(settings.listen, { pauseAfterExplainMs: 0, quizWaitMs: 40 }, patch);
  mode = 'listening';
  const vocab: VocabState = { words: {}, marked: {} };
  const reader = new FakeTtsEngine(1);
  const explainer = new FakeTtsEngine(1);
  const zh = new FakeTtsEngine(1);
  const ai = fakeAi();
  const learning: string[] = [];
  const playback = new Playback(book, { engine: () => reader, voice: () => ({ voiceId: 'fake-gb', rate: 1 }), pauseMs: () => 0 });
  const controller = new ListenController(playback, {
    book, dict, names: new Set(),
    settings: () => settings, vocab: () => vocab, marked: () => [],
    engine: () => reader, explainEngine: () => explainer, zhEngine: () => zh,
    voice: () => ({ voiceId: 'fake-gb', rate: 1 }), explainVoice: () => ({ voiceId: 'fake-gb', rate: 1 }), zhVoiceId: () => 'fake-zh',
    explain: ai.explain, onTranscript: () => undefined, onMarkLearning: (l) => learning.push(l), mode: () => mode,
  });
  controller.enabled = true;
  const states: string[] = [];
  playback.on('state', (s) => states.push(s));
  return { book, settings, vocab, reader, explainer, zh, ai, learning, playback, controller, states };
}

const REPLY = 'Sanguine means hopeful.\n\nIn this sentence he stays cheerful.';

describe('ListenController', () => {
  it('runs the word script at a stop, even when the hard word ends the sentence, then continues reading', async () => {
    const t = setup(['He was sanguine.', 'Then he left.']);
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    expect(t.ai.calls[0].req).toMatchObject({ kind: 'word', target: 'sanguine', sentence: 'He was sanguine.', styleId: 'custom', position: { chapter: 0, paragraph: 0, sentence: 0 }, before: '', after: 'Then he left.' });
    t.ai.calls[0].resolve(REPLY);
    await finished;
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['Sanguine means hopeful.', 'In this sentence he stays cheerful.']);
    expect(t.zh.spoken.map((s) => s.text)).toEqual(['乐观的']);
    expect(t.reader.spoken.map((s) => s.text)).toEqual(['He was sanguine.', 'sanguine', 'sanguine', 'He was sanguine.', 'Then he left.']);
    expect(t.learning).toEqual(['sanguine']);
    expect(t.controller.busy).toBe(false);
  });

  it('pausing during an explanation cancels the AI request and starts no further explanation', async () => {
    const t = setup(['The sanguine man was acrimonious.', 'Then he left.']);
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    await until(() => t.explainer.spoken.length + t.reader.spoken.length >= 2); // the word is being said
    const spokenBefore = t.reader.spoken.length + t.explainer.spoken.length;
    t.playback.pause();
    expect(t.ai.calls[0].cancelled).toBe(true);
    await sleep(150);
    expect(t.ai.calls.length).toBe(1); // 'acrimonious' must not be explained while paused
    expect(t.reader.spoken.length + t.explainer.spoken.length).toBe(spokenBefore);
    expect(t.controller.busy).toBe(false);
    expect(t.playback.state).toBe('paused');
  });

  it('stopping playback (leaving the reader) aborts a pending explanation', async () => {
    const t = setup(['He was sanguine.', 'Then he left.']);
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.playback.stop();
    expect(t.ai.calls[0].cancelled).toBe(true);
    t.ai.calls[0].resolve(REPLY); // too late: nothing may be spoken
    await sleep(50);
    expect(t.explainer.spoken).toEqual([]);
    expect(t.controller.busy).toBe(false);
  });

  it('skip ends the stop and reading continues with the next sentence', async () => {
    const t = setup(['The sanguine man was acrimonious.', 'Then he left.']);
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.controller.skip();
    await finished;
    expect(t.ai.calls.length).toBe(1);
    expect(t.reader.spoken.map((s) => s.text).slice(-1)).toEqual(['Then he left.']);
  });

  it('a manual explanation during an automatic one replaces it, ends that stop, and stays skippable', async () => {
    const t = setup(['The sanguine man was acrimonious.', 'Then he left.']);
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    const p = t.controller.explainNow('word', 'left', { chapter: 0, paragraph: 0, sentence: 1 }, null, 'left');
    expect(t.ai.calls[0].cancelled).toBe(true);
    await until(() => t.ai.calls.length === 2);
    await sleep(60); // the cancelled explanation finishes its bookkeeping
    expect(t.ai.calls.length).toBe(2); // no automatic explanation of 'acrimonious' while the manual one runs
    expect(t.controller.busy).toBe(true);
    t.controller.skip(); // skipping a manual explanation must not swallow the pause steps either
    expect(t.ai.calls[1].cancelled).toBe(true);
    await Promise.race([p, sleep(100).then(() => { throw new Error('skip took too long'); })]);
    expect(t.controller.busy).toBe(false);
    await sleep(50);
    expect(t.ai.calls.length).toBe(2);
    // it was listening before: reading resumed with the sentence of the explained word and ran to the end
    expect(t.states.slice(-3)).toEqual(['paused', 'playing', 'idle']);
    expect(t.reader.spoken.map((s) => s.text).slice(-1)).toEqual(['Then he left.']);
  });

  it('"explain the last seconds" includes the sentence being spoken and resumes reading where it paused', async () => {
    const t = setup(['He was sanguine.', 'Then he left.']);
    t.controller.enabled = false;
    t.reader.msPerChar = 20;
    t.playback.play();
    await until(() => t.reader.spoken.length === 1);
    await sleep(30);
    const p = t.controller.explainLast(30);
    expect(t.playback.state).toBe('paused');
    await until(() => t.ai.calls.length === 1);
    expect(t.ai.calls[0].req.kind).toBe('passage');
    expect(t.ai.calls[0].req.target).toBe('He was sanguine.');
    t.ai.calls[0].resolve('SUMMARY: He felt hopeful.\nHARD WORDS: none');
    await p;
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['He felt hopeful.']);
    expect(t.playback.state).toBe('playing');
    expect(t.playback.position).toEqual({ chapter: 0, paragraph: 0, sentence: 0 });
    t.playback.stop();
  });

  it('navigating away during a manual explanation does not drag the reader back afterwards', async () => {
    const t = setup(['He was sanguine.', 'Then he left.', 'The end.']);
    t.playback.play();
    await until(() => t.reader.spoken.length === 1);
    const p = t.controller.explainNow('word', 'sanguine', { chapter: 0, paragraph: 0, sentence: 0 }, null, 'sanguine');
    expect(t.playback.state).toBe('paused');
    await until(() => t.ai.calls.length === 1);
    // what ReaderView's nav() does for the "next sentence" key
    t.controller.skip();
    t.playback.seek({ chapter: 0, paragraph: 2, sentence: 0 });
    await p;
    await sleep(30);
    expect(t.playback.position).toEqual({ chapter: 0, paragraph: 2, sentence: 0 });
    expect(t.playback.state).toBe('paused');
  });

  it('dismiss only cancels the explanation of that word and never marks it as learning', async () => {
    const t = setup(['The sanguine man was acrimonious.', 'Then he left.']);
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.controller.dismiss('acrimonious');
    expect(t.ai.calls[0].cancelled).toBe(false);
    t.controller.dismiss('sanguine');
    expect(t.ai.calls[0].cancelled).toBe(true);
    await finished;
    expect(t.ai.calls.length).toBe(1);
    expect(t.learning).toEqual([]);
  });

  it('listening mode: silence after the explanation, then the book continues', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { pauseAfterExplainMs: 120 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.reader.spoken.length === 4); // sentence, word, word, sentence
    const t0 = Date.now();
    await finished;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(t.reader.spoken.map((s) => s.text).slice(-1)).toEqual(['Then he left.']);
  });

  it('reading mode: stops after the explanation and waits', async () => {
    const t = setup(['He was sanguine.', 'Then he left.']);
    mode = 'reading';
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.playback.state === 'paused');
    await sleep(60);
    expect(t.reader.spoken.map((s) => s.text)).toEqual(['He was sanguine.', 'sanguine', 'sanguine', 'He was sanguine.']);
    expect(t.playback.state).toBe('paused');
  });

  it('quiz style: waits at [PAUSE] for the learner, continueNow ends the wait early', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { quizWaitMs: 5000 });
    t.settings.ai.activeStyle = 'quiz';
    t.settings.ai.styles.quiz = { shape: { wordBefore: 1, wordAfter: 1, sentenceAfterWord: 1, sentenceBefore: 1, sentenceAfter: 1 } };
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    expect(t.ai.calls[0].req.styleId).toBe('quiz');
    t.ai.calls[0].resolve('Was he happy or sad?\n[PAUSE]\nHe was happy.');
    await until(() => t.explainer.spoken.length === 1);
    await sleep(40);
    expect(t.explainer.spoken.length).toBe(1); // waiting for the answer
    t.controller.continueNow();
    await finished;
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['Was he happy or sad?', 'He was happy.']);
  });

  it('explains a lemma once per sentence even when it appears twice', () => {
    const t = setup(['The sanguine man met a sanguine woman.']);
    expect(t.controller.triggersFor({ chapter: 0, paragraph: 0, sentence: 0 }).map((x) => x.token)).toEqual([1]);
  });
});
