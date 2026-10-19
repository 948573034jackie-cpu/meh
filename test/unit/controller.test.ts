import { describe, it, expect } from 'vitest';
import { Playback } from '@core/listen/playback';
import { ListenController, type ListenDeps, type CommandWindow, type ChapterPhrase } from '@core/listen/controller';
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
function setup(paragraphs: string[], patch: Partial<Settings['listen']> = {}, phrases?: (pos: Position) => ChapterPhrase[]) {
  const book = makeBook([{ title: 'One', paragraphs }]);
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  settings.voice.pauseBetweenSentencesMs = 0;
  settings.ai.styles = { custom: { shape: { wordBefore: 1, wordAfter: 0, sentenceAfterWord: 0, sentenceBefore: 1, sentenceAfter: 1 } } };
  Object.assign(settings.listen, { pauseAfterExplainMs: 0, quizWaitMs: 40, commandWindowMs: 30 }, patch);
  mode = 'listening';
  const vocab: VocabState = { words: {}, marked: {} };
  const reader = new FakeTtsEngine(1);
  const explainer = new FakeTtsEngine(1);
  const zh = new FakeTtsEngine(1);
  const ai = fakeAi();
  const learning: string[] = [];
  const windows: boolean[] = [];
  const bars: (CommandWindow | null)[] = [];
  const playback = new Playback(book, { engine: () => reader, voice: () => ({ voiceId: 'fake-gb', rate: 1 }), pauseMs: () => 0 });
  const controller = new ListenController(playback, {
    book, dict, names: new Set(),
    settings: () => settings, vocab: () => vocab, marked: () => [],
    engine: () => reader, explainEngine: () => explainer, zhEngine: () => zh,
    voice: () => ({ voiceId: 'fake-gb', rate: 1 }), explainVoice: () => ({ voiceId: 'fake-gb', rate: 1 }), zhVoiceId: () => 'fake-zh',
    explain: ai.explain, onTranscript: () => undefined, onMarkLearning: (l) => learning.push(l), mode: () => mode,
    onPauseWindow: (open) => windows.push(open),
    onCommandWindow: (w) => bars.push(w),
    chapterPhrases: phrases,
  });
  controller.enabled = true;
  const states: string[] = [];
  playback.on('state', (s) => states.push(s));
  return { book, settings, vocab, reader, explainer, zh, ai, learning, playback, controller, states, windows, bars };
}

const REPLY = 'Sanguine means hopeful.\n\nIn this sentence he stays cheerful.';

describe('ListenController', () => {
  it('Listening: at a stop the word 3 times, the window, the explanation, the window, then the sentence again and on', async () => {
    const t = setup(['He was sanguine.', 'Then he left.']);
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    expect(t.ai.calls[0].req).toMatchObject({ kind: 'word', target: 'sanguine', sentence: 'He was sanguine.', styleId: 'custom', position: { chapter: 0, paragraph: 0, sentence: 0 }, before: '', after: 'Then he left.' });
    t.ai.calls[0].resolve(REPLY);
    await finished;
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['Sanguine means hopeful.', 'In this sentence he stays cheerful.']);
    expect(t.zh.spoken.map((s) => s.text)).toEqual(['乐观的']);
    expect(t.reader.spoken.map((s) => s.text)).toEqual(['He was sanguine.', 'sanguine', 'sanguine', 'sanguine', 'He was sanguine.', 'Then he left.']);
    expect(t.learning).toEqual(['sanguine']);
    expect(t.windows).toEqual([true, false, true, false]);
    expect(t.bars.map((b) => b?.phase ?? null)).toEqual(['before', null, 'after', null]);
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

  it('skip ends the stop; the sentence is read again (no second stop in it) and reading goes on', async () => {
    const t = setup(['The sanguine man was acrimonious.', 'Then he left.']);
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.controller.skip();
    await finished;
    expect(t.ai.calls.length).toBe(1);
    expect(t.reader.spoken.map((s) => s.text).slice(-2)).toEqual(['The sanguine man was acrimonious.', 'Then he left.']);
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

  it('listening mode: silence after the explanation (the whole window), then the book continues', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 120 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.windows.length === 3); // the window after the explanation
    const t0 = Date.now();
    await finished;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(t.reader.spoken.map((s) => s.text).slice(-2)).toEqual(['He was sanguine.', 'Then he left.']);
  });

  it('listening mode: moving to another sentence during the pause closes the voice window at once', async () => {
    const t = setup(['He was sanguine.', 'Then he left.', 'The end.'], { commandWindowMs: 5000 });
    t.playback.play();
    await until(() => t.windows.length === 1);
    expect(t.windows).toEqual([true]);
    t.controller.skip();
    t.playback.seek({ chapter: 0, paragraph: 2, sentence: 0 }); // e.g. a chapter change from the menu
    await until(() => t.windows.length === 2, 500);
    expect(t.windows).toEqual([true, false]);
    await until(() => t.reader.spoken.some((s) => s.text === 'The end.'));
    expect(t.reader.spoken.map((s) => s.text)).not.toContain('Then he left.');
  });

  it('listening mode: switching to Reading during the pause keeps the book paused', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 150 });
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.windows.length === 3);
    mode = 'reading';
    await until(() => t.playback.state === 'paused');
    await sleep(60);
    expect(t.reader.spoken.map((s) => s.text)).not.toContain('Then he left.');
  });

  it('dispose ends the Reading answer window and every wait without resuming anything', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { pauseAfterExplainMs: 5000 });
    mode = 'reading';
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.playback.state === 'paused' && t.windows.length === 1);
    t.controller.dispose();
    t.playback.stop();
    expect(t.windows).toEqual([true, false]);
    t.controller.release();
    await sleep(30);
    expect(t.playback.state).toBe('idle');
  });

  it('reading mode: stops after the explanation and waits', async () => {
    const t = setup(['He was sanguine.', 'Then he left.']);
    mode = 'reading';
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.playback.state === 'paused');
    await sleep(60);
    // Reading keeps its script (the style's word repeats before the explanation), no commands window before it
    expect(t.reader.spoken.map((s) => s.text)).toEqual(['He was sanguine.', 'sanguine']);
    expect(t.playback.state).toBe('paused');
    expect(t.bars.filter(Boolean).every((b) => b!.phase === 'after')).toBe(true);
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

  it('does not explain the same word again within the repeat window, but does after it', async () => {
    const filler = Array.from({ length: 30 }, (_, i) => `Word ${i} here.`).join(' '); // 90 words
    const t = setup(['He was sanguine.', 'Still sanguine.', filler, 'Again sanguine.'], { repeatWindowWords: 50 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.ai.calls.length === 2, 8000);
    expect(t.ai.calls[1].req.sentence).toBe('Again sanguine.');
    t.ai.calls[1].resolve(REPLY);
    await finished;
    expect(t.ai.calls.length).toBe(2);
    expect(t.controller.countStops(0)).toBeGreaterThanOrEqual(1);
  });

  it('an easy word the learner marked as learning (yellow) also makes listening pause', () => {
    const t = setup(['Then he left.']);
    expect(t.controller.triggersFor({ chapter: 0, paragraph: 0, sentence: 0 })).toEqual([]);
    t.vocab.words.left = 'learning';
    expect(t.controller.triggersFor({ chapter: 0, paragraph: 0, sentence: 0 }).map((x) => x.target)).toEqual(['left']);
  });

  it('a learning word (heard before, learner silent) is explained again later; a known word never', () => {
    const t = setup(['He was sanguine.', 'Then acrimonious.']);
    t.vocab.words.sanguine = 'learning';
    t.vocab.words.acrimonious = 'known';
    expect(t.controller.triggersFor({ chapter: 0, paragraph: 0, sentence: 0 }).map((x) => x.lemma)).toEqual(['sanguine']);
    expect(t.controller.triggersFor({ chapter: 0, paragraph: 1, sentence: 0 })).toEqual([]);
  });

  it('"I don\'t know" after the explanation: again, deeper (again=true), then the window again; nothing = learning, re-read', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    expect(t.controller.answerWindow('dont_know')).toBe(true); // before the explanation: it simply starts
    await until(() => t.ai.calls.length === 1);
    expect(t.ai.calls[0].req.again).toBeFalsy();
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.windows.length === 3);
    expect(t.controller.stopWindow).toBe('after');
    expect(t.controller.answerWindow('dont_know')).toBe(true);
    await until(() => t.ai.calls.length === 2);
    expect(t.ai.calls[1].req).toMatchObject({ kind: 'word', target: 'sanguine', again: true });
    t.ai.calls[1].resolve('Sanguine is hopeful, from another angle.');
    await until(() => t.windows.length === 5);
    expect(t.windows).toEqual([true, false, true, false, true]);
    t.settings.listen.commandWindowMs = 30;
    t.controller.keepWaiting(30); // the learner said nothing in the end: the window runs out
    await finished;
    expect(t.explainer.spoken.map((s) => s.text).slice(-1)).toEqual(['Sanguine is hopeful, from another angle.']);
    expect(t.reader.spoken.map((s) => s.text).slice(-2)).toEqual(['He was sanguine.', 'Then he left.']);
    expect(t.learning).toContain('sanguine');
  });

  it('"I know" in the first window: no explanation request, known, the sentence is read again from its start', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    expect(t.reader.spoken.map((s) => s.text)).toEqual(['He was sanguine.', 'sanguine', 'sanguine', 'sanguine']);
    expect(t.ai.calls.length).toBe(0); // nothing is said or asked during the window
    expect(t.bars.at(-1)).toMatchObject({ phase: 'before', ms: 5000, target: 'sanguine', kind: 'word' });
    expect(t.controller.lastExplained).toMatchObject({ kind: 'word', lemma: 'sanguine' });
    t.controller.markKnown('sanguine'); // what ReaderView does with "I know" (and it saves the status)
    expect(t.controller.answerWindow('know')).toBe(true);
    await finished;
    expect(t.ai.calls.length).toBe(0);
    expect(t.learning).toEqual([]);
    expect(t.windows).toEqual([true, false]);
    expect(t.reader.spoken.map((s) => s.text)).toEqual(['He was sanguine.', 'sanguine', 'sanguine', 'sanguine', 'He was sanguine.', 'Then he left.']);
    expect(t.controller.triggersFor({ chapter: 0, paragraph: 0, sentence: 0 })).toEqual([]);
  });

  it('"bye bye" (Esc, Go on) in the first window: no explanation, the AI is silent, the sentence is read again', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    expect(t.controller.answerWindow('bye')).toBe(true);
    await finished;
    expect(t.ai.calls.length).toBe(0);
    expect(t.explainer.spoken).toEqual([]);
    expect(t.learning).toEqual([]);
    expect(t.reader.spoken.map((s) => s.text).slice(-2)).toEqual(['He was sanguine.', 'Then he left.']);
  });

  it('the learner says something else in the first window: it goes on the explain request as the question', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    t.playback.play();
    await until(() => t.windows.length === 1);
    expect(t.controller.answerWindow({ text: 'sang win' })).toBe(true);
    await until(() => t.ai.calls.length === 1);
    expect(t.ai.calls[0].req).toMatchObject({ kind: 'word', target: 'sanguine', question: 'sang win' });
    expect(t.ai.calls[0].req.history.at(-1)).toMatchObject({ role: 'user' });
    expect(t.ai.calls[0].req.history.at(-1)!.text).toContain('sang win');
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.windows.length === 3);
    // after the explanation a question is not taken by the window (it is answered as a question)
    expect(t.controller.answerWindow({ text: 'why is he happy' })).toBe(false);
    expect(t.controller.answerWindow('know')).toBe(true);
    await until(() => t.playback.state === 'idle');
    expect(t.ai.calls.length).toBe(1);
  });

  it('the re-read of the sentence never stops at the same word again, even with no repeat window', async () => {
    const t = setup(['He was sanguine and acrimonious.', 'Then he left.'], { repeatWindowWords: 0 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.ai.calls.length === 2); // both hard words of the sentence are handled in the one stop
    expect(t.ai.calls[1].req.target).toBe('acrimonious');
    t.ai.calls[1].resolve('Acrimonious means bitter.');
    await finished;
    expect(t.ai.calls.length).toBe(2);
    const read = t.reader.spoken.map((s) => s.text).filter((x) => x.includes(' '));
    expect(read).toEqual(['He was sanguine and acrimonious.', 'He was sanguine and acrimonious.', 'Then he left.']);
  });

  it('pausing in the window ends the stop without resuming; play goes on from the same sentence without stopping there', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000, repeatWindowWords: 0 });
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.playback.pause();
    await until(() => t.windows.length === 2);
    await sleep(40);
    expect(t.playback.state).toBe('paused');
    expect(t.ai.calls.length).toBe(0);
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await finished;
    expect(t.windows).toEqual([true, false]);
    expect(t.reader.spoken.map((s) => s.text).slice(-2)).toEqual(['He was sanguine.', 'Then he left.']);
  });

  it('hold() (the learner starts talking) in the window ends the stop; release() re-reads the sentence once', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000, repeatWindowWords: 0 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    expect(t.controller.hold()).toBe(true);
    await sleep(30);
    expect(t.playback.state).toBe('paused');
    t.controller.release(true);
    await finished;
    expect(t.ai.calls.length).toBe(0);
    expect(t.reader.spoken.map((s) => s.text).filter((x) => x === 'Then he left.')).toHaveLength(1);
    expect(t.reader.spoken.map((s) => s.text).filter((x) => x === 'He was sanguine.')).toHaveLength(2);
  });

  it('dispose during the window closes it and nothing resumes', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.controller.dispose();
    t.playback.stop();
    await sleep(40);
    expect(t.windows).toEqual([true, false]);
    expect(t.bars.at(-1)).toBeNull();
    expect(t.playback.state).toBe('idle');
    expect(t.ai.calls.length).toBe(0);
  });

  it('chapter phrases above the level stop like words (the phrase 3 times, after its last word)', async () => {
    const phrases = (pos: Position): ChapterPhrase[] => (pos.paragraph === 0 ? [{ start: 1, end: 2, text: 'kicked off', lemma: 'kick off', level: 'C1', zh: '开始' }, { start: 4, end: 5, text: 'the party', lemma: 'the party', level: 'A1' }] : []);
    const t = setup(['They kicked off the party.', 'Then he left.'], { commandWindowMs: 5000 }, phrases);
    const trig = t.controller.triggersFor({ chapter: 0, paragraph: 0, sentence: 0 });
    expect(trig).toEqual([expect.objectContaining({ kind: 'phrase', token: 1, end: 2, target: 'kicked off', lemma: 'kick off', dict: { ipa: '', zh: '开始', level: 'C1' } })]);
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    expect(t.reader.spoken.map((s) => s.text)).toEqual(['They kicked off the party.', 'kicked off', 'kicked off', 'kicked off']);
    t.controller.answerWindow('dont_know');
    await until(() => t.ai.calls.length === 1);
    expect(t.ai.calls[0].req).toMatchObject({ kind: 'phrase', target: 'kicked off' });
    t.ai.calls[0].resolve('To kick off means to start.');
    await until(() => t.windows.length === 3);
    t.controller.answerWindow('bye');
    await finished;
    expect(t.learning).toEqual(['kick off']);
  });

  it('answerWindow is false when no commands window of a stop is open', () => {
    const t = setup(['He was calm.']);
    expect(t.controller.answerWindow('know')).toBe(false);
    expect(t.controller.stopWindow).toBeNull();
  });

  it('explains a lemma once per sentence even when it appears twice', () => {
    const t = setup(['The sanguine man met a sanguine woman.']);
    expect(t.controller.triggersFor({ chapter: 0, paragraph: 0, sentence: 0 }).map((x) => x.token)).toEqual([1]);
  });
});
