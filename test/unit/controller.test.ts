import { describe, it, expect, vi } from 'vitest';
import { Playback } from '@core/listen/playback';
import { ListenController, type ListenDeps, type CommandWindow, type ChapterPhrase, type TranscriptEntry } from '@core/listen/controller';
import { FakeTtsEngine } from '@core/tts/fake';
import type { TtsEngine } from '@core/tts/engine';
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
  const calls: { req: ExplainRequest; cancelled: boolean; resolve: (text: string) => void; delta: (full: string) => void; fail: (code: string) => void }[] = [];
  const explain: ListenDeps['explain'] = (req, onDelta) => {
    let resolve!: (t: string) => void; let reject!: (e: Error) => void;
    const done = new Promise<string>((res, rej) => { resolve = res; reject = rej; }).then((text) => ({ text, usage: { usd: 0.001, dailyUsd: 0.01, monthlyUsd: 0.1 } }));
    done.catch(() => undefined);
    const call = { req, cancelled: false, resolve, delta: onDelta, fail: (code: string) => reject(Object.assign(new Error(`failed: ${code}`), { code })) };
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
function setup(paragraphs: string[] | { title: string; paragraphs: string[] }[], patch: Partial<Settings['listen']> = {}, phrases?: (pos: Position) => ChapterPhrase[]) {
  const book = makeBook(paragraphs.every((p) => typeof p === 'string') ? [{ title: 'One', paragraphs: paragraphs as string[] }] : paragraphs as { title: string; paragraphs: string[] }[]);
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
  const entries: TranscriptEntry[] = [];
  const budget: number[] = [];
  const playback = new Playback(book, { engine: () => reader, voice: () => ({ voiceId: 'fake-gb', rate: 1 }), pauseMs: () => 0 });
  const controller = new ListenController(playback, {
    book, dict, names: new Set(),
    settings: () => settings, vocab: () => vocab, marked: () => [],
    engine: () => reader, explainEngine: () => explainer, zhEngine: () => zh,
    voice: () => ({ voiceId: 'fake-gb', rate: 1 }), explainVoice: () => ({ voiceId: 'fake-gb', rate: 1 }), zhVoiceId: () => 'fake-zh',
    explain: ai.explain, onTranscript: (e) => entries.push(e), onMarkLearning: (l) => learning.push(l), mode: () => mode,
    onBudget: (d) => budget.push(d),
    onPauseWindow: (open) => windows.push(open),
    onCommandWindow: (w) => bars.push(w),
    chapterPhrases: phrases,
  });
  controller.enabled = true;
  const states: string[] = [];
  playback.on('state', (s) => states.push(s));
  return { book, settings, vocab, reader, explainer, zh, ai, learning, playback, controller, states, windows, bars, entries, budget };
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

  it('the stop words go to the read-ahead before the cut: urgent for the sentence that stops, upcoming for the one before it', async () => {
    const t = setup(['Then he left. He was sanguine and acrimonious. The end came.']);
    const aheads: { texts: string[]; urgent: string[]; upcoming: string[] }[] = [];
    // the reading voice reads ahead like the Dream voice
    (t.reader as TtsEngine).readAhead = (texts, _v, _r, urgent = [], upcoming = []) => { aheads.push({ texts, urgent, upcoming }); };
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].resolve('Sanguine means hopeful.');
    await until(() => t.ai.calls.length === 2);
    t.ai.calls[1].resolve('Acrimonious means bitter.');
    await finished;
    const [s0, s1, s2] = ['Then he left.', 'He was sanguine and acrimonious.', 'The end came.'];
    expect(aheads[0]).toEqual({ texts: [s1, s2], urgent: [], upcoming: ['sanguine', 'acrimonious'] }); // in the order they stop
    expect(aheads[1]).toEqual({ texts: [s2], urgent: ['sanguine', 'acrimonious'], upcoming: [] }); // the stop: next sentence only
    expect(aheads[2]).toEqual({ texts: [s2], urgent: [], upcoming: [] }); // the re-read (no stop) hands over the list again
    expect(t.reader.spoken.map((x) => x.text)).toEqual([s0, s1, 'sanguine', 'sanguine', 'sanguine', 'acrimonious', 'acrimonious', 'acrimonious', s1, s2]);
  });

  it('no stop words for the read-ahead in Reading mode, with auto-stop off, or without word repeats', async () => {
    for (const variant of ['reading', 'off', 'norepeat'] as const) {
      const t = setup(['Then he left. He was sanguine.'], variant === 'norepeat' ? { wordRepeats: 0 } : {});
      if (variant === 'reading') mode = 'reading';
      if (variant === 'off') t.controller.enabled = false;
      const aheads: string[][] = [];
      (t.reader as TtsEngine).readAhead = (_t, _v, _r, urgent = [], upcoming = []) => { aheads.push([...urgent, ...upcoming]); };
      t.playback.play();
      await until(() => aheads.length >= 1);
      t.playback.stop();
      t.controller.dispose();
      expect(aheads[0]).toEqual([]);
    }
  });

  it('pausing while the word is said cancels the prepared request at once and says the word no more', async () => {
    const t = setup(['The sanguine man was acrimonious.', 'Then he left.']);
    t.reader.msPerChar = 20;
    t.playback.play();
    await until(() => t.reader.spoken.length >= 2); // the word is being said (the request went out before it)
    expect(t.ai.calls.length).toBe(1);
    t.playback.pause();
    expect(t.ai.calls[0].cancelled).toBe(true);
    const said = t.reader.spoken.length;
    await sleep(600);
    expect(t.reader.spoken.length).toBe(said); // no further repeats after the pause
    expect(t.ai.calls.length).toBe(1);
    expect(t.entries).toEqual([]);
    expect(t.controller.busy).toBe(false);
  });

  it('pausing during an explanation cancels the AI request and starts no further explanation', async () => {
    const t = setup(['The sanguine man was acrimonious.', 'Then he left.']);
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].delta('Sanguine means hopeful. It');
    await until(() => t.explainer.spoken.length === 1); // the window ended: the explanation is being said
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
    expect(t.entries).toEqual([]); // the prepared reply never reached the transcript
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
    expect(t.ai.calls.length).toBe(1); // asked for when the book paused
    expect(t.ai.calls[0].req.again).toBeFalsy();
    t.ai.calls[0].resolve(REPLY);
    expect(t.controller.answerWindow('dont_know')).toBe(true); // before the explanation: the prepared one, at once
    await until(() => t.explainer.spoken.length >= 1);
    expect(t.ai.calls.length).toBe(1); // no second request
    await until(() => t.windows.length === 3);
    expect(t.controller.stopWindow).toBe('after');
    expect(t.controller.answerWindow('dont_know')).toBe(true);
    await until(() => t.ai.calls.length === 2);
    expect(t.ai.calls[1].req).toMatchObject({ kind: 'word', target: 'sanguine', again: true });
    t.settings.listen.commandWindowMs = 30; // the next window: the learner says nothing, it runs out
    t.ai.calls[1].resolve('Sanguine is hopeful, from another angle.');
    await until(() => t.windows.length === 5);
    expect(t.windows.slice(0, 5)).toEqual([true, false, true, false, true]);
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
    expect(t.ai.calls.length).toBe(1); // asked for when the book paused; nothing is said during the window
    t.ai.calls[0].resolve(REPLY); // the reply is complete before the learner answers
    await sleep(10);
    expect(t.explainer.spoken).toEqual([]);
    expect(t.bars.at(-1)).toMatchObject({ phase: 'before', ms: 5000, target: 'sanguine', kind: 'word' });
    expect(t.controller.lastExplained).toMatchObject({ kind: 'word', lemma: 'sanguine' });
    expect(t.controller.answerWindow('know')).toBe(true);
    t.controller.markKnown('sanguine'); // what ReaderView does with "I know" (and it saves the status)
    await finished;
    expect(t.ai.calls.length).toBe(1);
    expect(t.ai.calls[0].cancelled).toBe(true);
    expect(t.explainer.spoken).toEqual([]);
    expect(t.entries).toEqual([]); // not in the transcript, so not in My Vocabulary
    expect(t.budget).toEqual([0.01]); // its tokens were spent: the budget warning saw them
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
    expect(t.ai.calls.length).toBe(1);
    expect(t.ai.calls[0].cancelled).toBe(true);
    expect(t.explainer.spoken).toEqual([]);
    expect(t.entries).toEqual([]);
    expect(t.learning).toEqual(['sanguine']); // "go on" keeps it as a word to learn
    expect(t.reader.spoken.map((s) => s.text).slice(-2)).toEqual(['He was sanguine.', 'Then he left.']);
  });

  it('the learner says something else in the window: it is ignored (never sent to the AI); silence then explains', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 300 });
    t.playback.play();
    await until(() => t.windows.length === 1);
    expect(t.controller.answerWindow({ text: 'sang win' })).toBe(true);
    await until(() => t.ai.calls.length === 1);
    expect(t.ai.calls[0].req.question).toBeUndefined();
    expect(JSON.stringify(t.ai.calls[0].req.history)).not.toContain('sang win');
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.windows.length === 3);
    expect(t.controller.answerWindow({ text: 'why is he happy' })).toBe(true); // swallowed in the window too
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

  it('pausing in the window ends the stop without resuming; play stops at the word again (nothing was explained): the first request was cancelled, a second is sent', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.playback.pause();
    await until(() => t.windows.length === 2);
    await sleep(40);
    expect(t.playback.state).toBe('paused');
    expect(t.ai.calls.length).toBe(1);
    expect(t.ai.calls[0].cancelled).toBe(true);
    expect(t.entries).toEqual([]);
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 3); // the same stop again: the word 3 times, the window
    expect(t.ai.calls.length).toBe(2);
    expect(t.ai.calls[1].req).toMatchObject({ kind: 'word', target: 'sanguine', history: [] });
    t.ai.calls[1].resolve(REPLY);
    expect(t.controller.answerWindow('dont_know')).toBe(true);
    await until(() => t.windows.length === 5);
    expect(t.controller.answerWindow('bye')).toBe(true);
    await finished;
    expect(t.ai.calls.length).toBe(2);
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['Sanguine means hopeful.', 'In this sentence he stays cheerful.']);
    expect(t.reader.spoken.map((s) => s.text)).toEqual(['He was sanguine.', 'sanguine', 'sanguine', 'sanguine', 'He was sanguine.', 'sanguine', 'sanguine', 'sanguine', 'He was sanguine.', 'Then he left.']);
  });

  it('hold() (the learner starts talking) in the window ends the stop; release() re-reads the sentence and stops at the word again', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    expect(t.controller.hold()).toBe(true);
    await sleep(30);
    expect(t.playback.state).toBe('paused');
    expect(t.ai.calls[0].cancelled).toBe(true);
    t.controller.release(true);
    await until(() => t.windows.length === 3);
    expect(t.ai.calls.length).toBe(2);
    expect(t.controller.answerWindow('know')).toBe(true);
    t.controller.markKnown('sanguine');
    await finished;
    expect(t.ai.calls[1].cancelled).toBe(true);
    expect(t.explainer.spoken).toEqual([]);
    expect(t.reader.spoken.map((s) => s.text).filter((x) => x === 'Then he left.')).toHaveLength(1);
    expect(t.reader.spoken.map((s) => s.text).filter((x) => x === 'He was sanguine.')).toHaveLength(3);
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
    expect(t.ai.calls.length).toBe(1);
    expect(t.ai.calls[0].cancelled).toBe(true);
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

describe('5-second window is commands only', () => {
  it('speech in the window is never sent to the AI; go on marks learning without explaining', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 200 } as never);
    t.playback.play();
    await until(() => t.controller.stopWindow === 'before', 8000);
    expect(t.controller.answerWindow({ text: 'sanguine sanguine what is this' })).toBe(true);
    expect(t.ai.calls.length).toBe(1); // the prepared request, without what was said
    expect(t.ai.calls[0].req.question).toBeUndefined();
    expect(t.controller.answerWindow('bye')).toBe(true);
    await until(() => t.learning.includes('sanguine'), 4000);
    expect(t.ai.calls.length).toBe(1);
    expect(t.ai.calls[0].cancelled).toBe(true);
    t.playback.stop();
  });
});

describe('prefetch: the explanation is asked for the moment the book pauses (docs/RULES.md 1.3)', () => {
  const POS0 = { chapter: 0, paragraph: 0, sentence: 0 };
  const closedAt = (t: ReturnType<typeof setup>) => { let at = 0; t.controller['deps'].onCommandWindow = (w) => { t.bars.push(w); if (!w) at = Date.now(); }; return () => at; };

  it('the request goes out before the word is said, and is the request the silent case sends', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    const deps = t.controller['deps'];
    const explain = deps.explain;
    let saidBefore = -1;
    deps.explain = (req, onDelta) => { saidBefore = t.reader.spoken.length; return explain(req, onDelta); };
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    expect(saidBefore).toBe(1); // only the sentence: the word has not been said yet
    expect(t.ai.calls[0].req).toMatchObject({ kind: 'word', target: 'sanguine', sentence: 'He was sanguine.', before: '', after: 'Then he left.', styleId: 'custom', position: POS0, history: [] });
    expect(t.ai.calls[0].req.question).toBeUndefined();
    expect(t.ai.calls[0].req.again).toBeFalsy();
    expect(t.entries).toEqual([]); // nothing in the transcript while it streams
    t.playback.stop();
  });

  it('silence: a reply that arrived during the window is spoken the moment the window ends (no second request)', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 200 });
    const closed = closedAt(t);
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.explainer.spoken.length === 1);
    expect(Date.now() - closed()).toBeLessThan(60);
    await finished;
    expect(t.ai.calls.length).toBe(1);
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['Sanguine means hopeful.', 'In this sentence he stays cheerful.']);
    expect(t.entries.at(-1)).toMatchObject({ kind: 'word', lemma: 'sanguine', status: 'done', text: REPLY });
  });

  it('still streaming when the window ends: finished sentences are spoken at once, the rest as it arrives', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 100 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].delta('Sanguine means hopeful. In this');
    await until(() => t.explainer.spoken.length === 1);
    expect(t.explainer.spoken[0].text).toBe('Sanguine means hopeful.');
    expect(t.entries.at(-1)).toMatchObject({ status: 'speaking' });
    t.ai.calls[0].delta('Sanguine means hopeful. In this sentence he stays cheerful.');
    t.ai.calls[0].resolve('Sanguine means hopeful. In this sentence he stays cheerful.');
    await finished;
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['Sanguine means hopeful.', 'In this sentence he stays cheerful.']);
  });

  it('"I don\'t know" in the first window: the prepared explanation at once, no new request', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.ai.calls[0].delta('Sanguine means hopeful. In');
    expect(t.controller.answerWindow('dont_know')).toBe(true);
    await until(() => t.explainer.spoken.length === 1);
    expect(t.ai.calls.length).toBe(1);
    expect(t.ai.calls[0].cancelled).toBe(false);
    t.playback.stop();
  });

  it('a prepared request that fails: when the window ends the dictionary meaning is said, nothing is retried', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 100 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].fail('network');
    await sleep(20);
    expect(t.entries).toEqual([]); // the failure shows when the explanation is due, not during the window
    await finished;
    expect(t.ai.calls.length).toBe(1);
    expect(t.entries.at(-1)).toMatchObject({ status: 'error' });
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['sanguine.']);
    expect(t.zh.spoken.map((s) => s.text)).toEqual(['乐观的']);
  });

  it('tapping the word away during the window ends it as "I know": nothing spoken, not learning, the sentence again', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.controller.dismiss('sanguine');
    expect(t.ai.calls[0].cancelled).toBe(true);
    await finished;
    expect(t.windows).toEqual([true, false]);
    expect(t.explainer.spoken).toEqual([]);
    expect(t.learning).toEqual([]);
    expect(t.reader.spoken.map((s) => s.text).slice(-2)).toEqual(['He was sanguine.', 'Then he left.']);
  });

  it('history: "I know" drops a complete reply (not in the next request); a spoken one is', async () => {
    const t = setup(['He was sanguine.', 'Then acrimonious.', 'The end.'], { commandWindowMs: 5000 });
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await sleep(10);
    t.controller.markKnown('sanguine'); t.controller.answerWindow('know');
    await until(() => t.ai.calls.length === 2);
    expect(t.ai.calls[1].req).toMatchObject({ target: 'acrimonious', history: [] });
    await until(() => t.windows.length === 3);
    t.ai.calls[1].resolve('Acrimonious means bitter.');
    t.controller.answerWindow('dont_know');
    await until(() => t.windows.length === 5); // the window after its explanation
    t.controller.answerWindow('dont_know'); // again, deeper: a live request with the spoken one in its history
    await until(() => t.ai.calls.length === 3);
    expect(t.ai.calls[2].req).toMatchObject({ target: 'acrimonious', again: true, history: [{ role: 'user', text: 'word: acrimonious' }, { role: 'assistant', text: 'Acrimonious means bitter.' }] });
    t.playback.stop();
  });

  it('two hard words in one sentence: the second is asked for when its own stop starts, with the first in its history', async () => {
    const t = setup(['He was sanguine and acrimonious.', 'Then he left.'], { commandWindowMs: 60 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    await sleep(150);
    expect(t.ai.calls.length).toBe(1); // only the current word
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.ai.calls.length === 2);
    expect(t.ai.calls[1].req).toMatchObject({ target: 'acrimonious', history: [{ role: 'user', text: 'word: sanguine' }, { role: 'assistant', text: REPLY }] });
    t.ai.calls[1].resolve('Acrimonious means bitter.');
    await finished;
  });

  it('pre-synthesis: the first two sentences go to the explanation voice during the window, exactly as they are spoken', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 200 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.ai.calls[0].delta('**Sanguine** means hopeful. He stays cheerful. Even');
    expect(t.explainer.prepared.flatMap((p) => p.texts)).toEqual(['Sanguine means hopeful.', 'He stays cheerful.']);
    expect(t.explainer.prepared.every((p) => p.voiceId === 'fake-gb')).toBe(true);
    expect(t.explainer.spoken).toEqual([]);
    t.ai.calls[0].resolve('**Sanguine** means hopeful. He stays cheerful. Even in the rain. Always.');
    await finished;
    const spoken = t.explainer.spoken.map((s) => s.text);
    expect(spoken).toEqual(['Sanguine means hopeful.', 'He stays cheerful.', 'Even in the rain.', 'Always.']);
    // the rest was prepared while the first sentences were spoken
    expect(t.explainer.prepared.flatMap((p) => p.texts)).toEqual(spoken);
  });

  it('Reading mode (no prefetch): a tapped word is spoken sentence by sentence as the reply streams', async () => {
    const t = setup(['He was sanguine.', 'Then he left.']);
    mode = 'reading';
    const p = t.controller.explainNow('word', 'sanguine', POS0, { ipa: '', zh: '乐观的', level: 'C1' }, 'sanguine');
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].delta('Sanguine means hopeful.\n\nIn');
    await until(() => t.explainer.spoken.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await p;
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['Sanguine means hopeful.', 'In this sentence he stays cheerful.']);
    expect(t.zh.spoken.map((s) => s.text)).toEqual(['乐观的']);
  });
});

describe('prefetch: more stops (the controller in Listening mode)', () => {
  const POS0 = { chapter: 0, paragraph: 0, sentence: 0 };
  const DICT = { ipa: '', zh: '乐观的', level: 'C1' as const };
  const prepared = (t: ReturnType<typeof setup>) => t.explainer.prepared.flatMap((p) => p.texts);

  it('switching to Reading in the before-window: the request is dropped at once, nothing is said, the book stays paused; back in Listening it stops at the word again', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.ai.calls[0].delta('Sanguine means hopeful. He stays cheerful. More');
    expect(prepared(t)).toEqual(['Sanguine means hopeful.', 'He stays cheerful.']);
    mode = 'reading';
    t.controller.enabled = false; // what ReaderView does on the switch
    expect(t.ai.calls[0].cancelled).toBe(true);
    expect(t.explainer.prepared.every((p) => p.released)).toBe(true); // its synthesis ahead is dropped too
    await until(() => t.windows.length === 2);
    await until(() => t.playback.state === 'paused');
    await sleep(40);
    expect(t.explainer.spoken).toEqual([]);
    expect(t.entries).toEqual([]);
    expect(t.reader.spoken.map((s) => s.text)).not.toContain('Then he left.');
    // nothing was explained: Listening again stops at the word (a new request)
    mode = 'listening';
    t.controller.enabled = true;
    t.playback.play();
    await until(() => t.windows.length === 3);
    expect(t.ai.calls.length).toBe(2);
    t.playback.stop();
  });

  it('skip() in the before-window drops the prepared request and re-reads the sentence (no explanation, not marked)', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.ai.calls[0].resolve(REPLY);
    t.controller.skip();
    await finished;
    expect(t.ai.calls.length).toBe(1);
    expect(t.ai.calls[0].cancelled).toBe(true);
    expect(t.explainer.spoken).toEqual([]);
    expect(t.entries).toEqual([]);
    expect(t.reader.spoken.map((s) => s.text)).toEqual(['He was sanguine.', 'sanguine', 'sanguine', 'sanguine', 'He was sanguine.', 'Then he left.']);
  });

  it('quiz style streamed: a [PAUSE] that arrives mid-stream waits for the learner (continueNow ends it) before the rest', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000, quizWaitMs: 5000 });
    t.settings.ai.activeStyle = 'quiz';
    t.settings.ai.styles.quiz = { shape: { wordBefore: 1, wordAfter: 0, sentenceAfterWord: 0, sentenceBefore: 1, sentenceAfter: 0 } };
    const waits: boolean[] = [];
    t.controller['deps'].onWaiting = (w) => waits.push(w);
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.ai.calls[0].delta('Was he happy or sad?\n[PAUSE]\nHe');
    expect(t.controller.answerWindow('dont_know')).toBe(true);
    await until(() => waits.length === 1);
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['Was he happy or sad?']);
    t.ai.calls[0].resolve('Was he happy or sad?\n[PAUSE]\nHe was happy.');
    await sleep(60);
    expect(t.explainer.spoken).toHaveLength(1); // still waiting for the learner
    t.controller.continueNow();
    await until(() => t.windows.length >= 5);
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['Was he happy or sad?', 'He was happy.']);
    expect(waits).toEqual([true, false]);
    t.controller.answerWindow('bye');
    await finished;
  });

  it('a marked phrase (no lemma): no prefetch and no window before it; the request starts when its explanation starts', async () => {
    const t = setup(['It was a fine day.', 'Then he left.']);
    t.controller['deps'].marked = () => [{ chapter: 0, paragraph: 0, sentence: 0, start: 7, end: 17, text: 'a fine day' }];
    let readBefore = -1;
    const explain = t.controller['deps'].explain;
    t.controller['deps'].explain = (req, onDelta) => { readBefore = t.reader.spoken.length; return explain(req, onDelta); };
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    expect(readBefore).toBe(1); // the sentence was read to its end, no word repeats
    expect(t.windows).toEqual([]);
    expect(t.ai.calls[0].req).toMatchObject({ kind: 'phrase', target: 'a fine day' });
    expect(t.entries[0]).toMatchObject({ status: 'thinking', target: 'a fine day' }); // a live request: in the transcript at once
    t.ai.calls[0].resolve('It means a lovely day.');
    await until(() => t.windows.length === 1);
    t.controller.answerWindow('bye');
    await finished;
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['It means a lovely day.']);
  });

  it('a prepared reply with Chinese in it: the English runs are synthesized ahead, the Chinese ones go to the Chinese voice (only when Chinese is on)', async () => {
    for (const on of [true, false]) {
      const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 100 });
      t.settings.ai.speakChinese = on;
      const finished = new Promise<void>((r) => t.playback.on('finished', r));
      t.playback.play();
      await until(() => t.windows.length === 1);
      t.ai.calls[0].delta('It means 乐观的 here. He is calm. More');
      expect(prepared(t)).toEqual(['It means', 'here.', 'He is calm.']);
      t.ai.calls[0].resolve('It means 乐观的 here. He is calm. More soon.');
      await until(() => t.windows.length === 3);
      t.controller.answerWindow('bye');
      await finished;
      expect(t.explainer.spoken.map((s) => s.text)).toEqual(['It means', 'here.', 'He is calm.', 'More soon.']);
      expect(prepared(t)).toEqual(['It means', 'here.', 'He is calm.', 'More soon.']);
      expect(t.zh.spoken.map((s) => s.text)).toEqual(on ? ['乐观的', '乐观的'] : []); // in the reply, then the two meanings at the end
      expect(t.explainer.spoken.every((s) => !/[\u4e00-\u9fff]/.test(s.text))).toBe(true); // never an English voice for Chinese
    }
  });

  it('speech at 3 s does not move the explanation: it starts when the 5 s window ends', async () => {
    vi.useFakeTimers();
    try {
      const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
      let openAt = 0;
      const bars: (CommandWindow | null)[] = [];
      t.controller['deps'].onCommandWindow = (w) => { bars.push(w); if (w && !openAt) openAt = Date.now(); };
      t.playback.play();
      for (let i = 0; i < 1000 && !openAt; i++) await vi.advanceTimersByTimeAsync(5);
      t.ai.calls[0].resolve(REPLY);
      await vi.advanceTimersByTimeAsync(3000);
      t.controller.keepWaiting(); // the learner repeats the word
      t.controller.answerWindow({ text: 'sanguine' });
      await vi.advanceTimersByTimeAsync(600);
      t.controller.windowSpeechEnded();
      await vi.advanceTimersByTimeAsync(1390);
      expect(t.explainer.spoken).toEqual([]);
      for (let i = 0; i < 30 && !t.explainer.spoken.length; i++) await vi.advanceTimersByTimeAsync(1);
      expect(Date.now() - openAt).toBeGreaterThanOrEqual(5000);
      expect(Date.now() - openAt).toBeLessThanOrEqual(5010);
      expect(t.explainer.spoken[0].text).toBe('Sanguine means hopeful.');
      expect(bars.filter(Boolean)).toHaveLength(1); // the bar was shown once: never restarted
      t.playback.stop();
    } finally { vi.useRealTimers(); }
  });

  it('a command started at 4.8 s still counts after the window end; the wait for it is at most 2.5 s', async () => {
    vi.useFakeTimers();
    try {
      const t = setup(['He was sanguine.', 'Then acrimonious.', 'The end.'], { commandWindowMs: 5000 });
      const opened: number[] = [], closed: number[] = [];
      t.controller['deps'].onCommandWindow = (w) => (w ? opened : closed).push(Date.now());
      const step = async (cond: () => boolean) => { for (let i = 0; i < 4000 && !cond(); i++) await vi.advanceTimersByTimeAsync(5); };
      t.playback.play();
      await step(() => opened.length === 1);
      await vi.advanceTimersByTimeAsync(4800);
      t.controller.keepWaiting(); // "I know" is being said
      await vi.advanceTimersByTimeAsync(800); // 5.6 s: past the end, the words are not in yet
      expect(t.controller.stopWindow).toBe('before');
      expect(t.controller.answerWindow('know')).toBe(true);
      t.controller.markKnown('sanguine');
      expect(t.ai.calls[0].cancelled).toBe(true);
      // the next word: the learner starts talking at 4.8 s and never stops (noise)
      await step(() => opened.length === 2);
      await vi.advanceTimersByTimeAsync(4800);
      t.controller.keepWaiting();
      await step(() => closed.length === 2);
      expect(closed[1] - opened[1]).toBeGreaterThanOrEqual(7500);
      expect(closed[1] - opened[1]).toBeLessThanOrEqual(7700);
      expect(t.explainer.spoken).toEqual([]);
      t.playback.stop();
    } finally { vi.useRealTimers(); }
  });

  it('tapping the stop word in the before-window is "I don\'t know": the prepared explanation at once, one request', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.ai.calls[0].delta('Sanguine means hopeful. In');
    void t.controller.explainNow('word', 'sanguine', POS0, DICT, 'sanguine'); // ReaderView's tapWord
    await until(() => t.explainer.spoken.length === 1);
    expect(t.ai.calls.length).toBe(1);
    expect(t.ai.calls[0].cancelled).toBe(false);
    expect(t.playback.state).toBe('explaining'); // not paused for a manual explanation
    t.playback.stop();
  });

  it('the first stop of a new chapter sends an empty history', async () => {
    const t = setup([{ title: 'One', paragraphs: ['He was sanguine.'] }, { title: 'Two', paragraphs: ['Then acrimonious.', 'The end.'] }], { commandWindowMs: 60 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].resolve(REPLY);
    await until(() => t.ai.calls.length === 2);
    expect(t.ai.calls[1].req).toMatchObject({ target: 'acrimonious', position: { chapter: 1, paragraph: 0, sentence: 0 }, history: [] });
    t.ai.calls[1].resolve('Acrimonious means bitter.');
    await finished;
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['Sanguine means hopeful.', 'In this sentence he stays cheerful.', 'Acrimonious means bitter.']);
  });

  it('window: at most 2 sentences synthesized ahead; speaking: every arrived English sentence; what is prepared is what is spoken', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    t.explainer.msPerChar = 15;
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.ai.calls[0].delta('Great question! **Sanguine** means hopeful. He stays cheerful.\n\nEven in the rain. He');
    expect(prepared(t)).toEqual(['Sanguine means hopeful.', 'He stays cheerful.']); // filler gone, first two only
    t.ai.calls[0].delta('Great question! **Sanguine** means hopeful. He stays cheerful.\n\nEven in the rain. He smiles. And');
    expect(prepared(t)).toHaveLength(2);
    t.controller.answerWindow('dont_know');
    await until(() => t.explainer.spoken.length === 1);
    // the moment it starts speaking, everything that has arrived is queued for synthesis
    expect(prepared(t)).toEqual(['Sanguine means hopeful.', 'He stays cheerful.', 'Even in the rain.', 'He smiles.']);
    t.ai.calls[0].resolve('Great question! **Sanguine** means hopeful. He stays cheerful.\n\nEven in the rain. He smiles. And laughs.');
    await until(() => t.windows.length === 3, 8000);
    t.controller.answerWindow('bye');
    await finished;
    const spoken = t.explainer.spoken.map((s) => s.text);
    expect(spoken).toEqual(['Sanguine means hopeful.', 'He stays cheerful.', 'Even in the rain.', 'He smiles.', 'And laughs.']);
    expect(prepared(t)).toEqual(spoken);
    expect(t.explainer.prepared.every((p) => p.voiceId === 'fake-gb' && !p.released)).toBe(true);
  });

  it('"I know" in the window releases what was synthesized ahead for the dropped explanation', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    t.ai.calls[0].delta('Sanguine means hopeful. He stays cheerful. More');
    expect(t.explainer.prepared.length).toBeGreaterThan(0);
    expect(t.controller.answerWindow('know')).toBe(true);
    t.controller.markKnown('sanguine');
    await finished;
    expect(t.explainer.prepared.every((p) => p.released)).toBe(true);
  });

  it('question: the next sentence is prepared before the one being spoken ends', async () => {
    const t = setup(['He was calm.', 'Then he left.']);
    mode = 'reading';
    t.explainer.msPerChar = 20;
    const p = t.controller.explainNow('question', 'He was calm.', POS0, null, undefined, 'why is he calm', undefined, undefined, true);
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].delta('He has nothing to fear. He trusts his friends. And');
    await until(() => t.explainer.spoken.length === 1);
    expect(prepared(t)).toEqual(['He has nothing to fear.', 'He trusts his friends.']);
    expect(t.explainer.spoken).toHaveLength(1); // still saying the first one
    t.ai.calls[0].resolve('He has nothing to fear. He trusts his friends. And he sleeps well.');
    await p;
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['He has nothing to fear.', 'He trusts his friends.', 'And he sleeps well.']);
    expect(prepared(t)).toEqual(t.explainer.spoken.map((s) => s.text));
  });

  it('transcript: at most 5 text updates a second while streaming; thinking, speaking and done are always sent', async () => {
    const t = setup(['He was sanguine.', 'Then he left.']);
    mode = 'reading';
    const p = t.controller.explainNow('word', 'sanguine', POS0, DICT, 'sanguine');
    await until(() => t.ai.calls.length === 1);
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0]).toMatchObject({ status: 'thinking', text: '' });
    const t0 = Date.now();
    let full = 'Sanguine';
    for (let i = 0; i < 50; i++) { full += ' word'; t.ai.calls[0].delta(full); await sleep(10); }
    const elapsed = Date.now() - t0;
    await sleep(250); // the last text arrives too (trailing update)
    const thinking = t.entries.filter((e) => e.status === 'thinking');
    expect(thinking.length - 1).toBeLessThanOrEqual(Math.ceil(elapsed / 200) + 1);
    expect(thinking.at(-1)!.text).toBe(full);
    t.ai.calls[0].delta(`${full}. Then more`);
    await until(() => t.entries.some((e) => e.status === 'speaking'));
    t.ai.calls[0].resolve(`${full}. Then more.`);
    await p;
    expect(t.entries.filter((e) => e.status === 'speaking').length).toBeGreaterThanOrEqual(1);
    expect(t.entries.at(-1)).toMatchObject({ status: 'done', text: `${full}. Then more.` });
    expect(t.entries.filter((e) => e.status === 'done')).toHaveLength(1);
  });

  it('streamed sentences are separated by a 300 ms pause, a new paragraph by 450 ms (none before the first)', async () => {
    vi.useFakeTimers();
    try {
      const t = setup(['He was sanguine.', 'Then he left.']);
      mode = 'reading';
      t.settings.ai.speakChinese = false;
      t.settings.ai.styles = { custom: { shape: { wordBefore: 0, wordAfter: 0, sentenceAfterWord: 0, sentenceBefore: 0, sentenceAfter: 0 } } };
      const starts: number[] = [];
      const speak = t.explainer.speak.bind(t.explainer);
      t.explainer.speak = (text, o) => { starts.push(Date.now()); return speak(text, o); };
      const p = t.controller.explainNow('word', 'sanguine', POS0, DICT, 'sanguine');
      await vi.advanceTimersByTimeAsync(1);
      const t0 = Date.now();
      t.ai.calls[0].resolve('One two. Three four.\n\nFive six.');
      for (let i = 0; i < 400 && starts.length < 3; i++) await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(t.explainer.spoken.map((x) => x.text)).toEqual(['One two.', 'Three four.', 'Five six.']);
      expect(starts[0] - t0).toBeLessThan(10);
      // FakeTtsEngine(1): 1 ms per character
      expect(starts[1] - starts[0] - 'One two.'.length).toBeGreaterThanOrEqual(300);
      expect(starts[1] - starts[0] - 'One two.'.length).toBeLessThan(310);
      expect(starts[2] - starts[1] - 'Three four.'.length).toBeGreaterThanOrEqual(450);
      expect(starts[2] - starts[1] - 'Three four.'.length).toBeLessThan(460);
    } finally { vi.useRealTimers(); }
  });

  it('no text 25 s after the explanation was taken: status error, the dictionary meaning is said, the stream is cancelled', async () => {
    vi.useFakeTimers();
    try {
      const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
      t.playback.play();
      for (let i = 0; i < 1000 && t.windows.length < 1; i++) await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(5000); // the window ends: the prepared explanation is taken, nothing has arrived
      expect(t.entries.at(-1)).toMatchObject({ status: 'thinking' });
      await vi.advanceTimersByTimeAsync(24_900);
      expect(t.ai.calls[0].cancelled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(t.ai.calls[0].cancelled).toBe(true);
      for (let i = 0; i < 200 && t.zh.spoken.length < 1; i++) await vi.advanceTimersByTimeAsync(5);
      expect(t.entries.find((e) => e.status === 'error')).toMatchObject({ kind: 'word', lemma: 'sanguine' });
      expect(t.explainer.spoken.map((s) => s.text)).toEqual(['sanguine.']);
      expect(t.zh.spoken.map((s) => s.text)).toEqual(['乐观的']);
      expect(t.ai.calls.length).toBe(1);
      t.playback.stop();
    } finally { vi.useRealTimers(); }
  });
});
