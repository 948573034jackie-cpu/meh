import { describe, it, expect } from 'vitest';
import { Playback } from '@core/listen/playback';
import { ListenController, type ListenDeps, type TranscriptEntry } from '@core/listen/controller';
import { FakeTtsEngine } from '@core/tts/fake';
import type { Dictionary, DictEntry } from '@core/dict/types';
import type { ExplainRequest } from '@shared/api';
import { DEFAULT_SETTINGS, type Settings, type VocabState } from '@shared/settings';
import { makeBook } from './helpers';

// The controller side of voice chat: streamed replies spoken sentence by sentence, the pause window
// (onPauseWindow), barge-in (hold / release), and "I know" / "I don't know" during the pause.

const entry = (word: string, level: DictEntry['level']): DictEntry => ({ word, ipa: '', zh: word === 'sanguine' ? '乐观的' : '词', tags: [], frq: 100, bnc: 100, collins: 1, oxford: false, level, levelSource: 'cefrj' });
const dict: Dictionary = {
  size: 1,
  lookup: (t) => { const w = t.toLowerCase(); return { entry: entry(w, w === 'sanguine' ? 'C1' : 'A1'), lemma: w, via: 'exact' }; },
  lookupPhrase: () => null,
  lemmaOf: (t) => t.toLowerCase(),
};

interface Call { req: ExplainRequest; cancelled: boolean; delta: (full: string) => void; resolve: (text: string) => void }
function fakeAi() {
  const calls: Call[] = [];
  const explain: ListenDeps['explain'] = (req, onDelta) => {
    let resolve!: (t: string) => void; let reject!: (e: Error) => void;
    const done = new Promise<string>((res, rej) => { resolve = res; reject = rej; }).then((text) => ({ text, usage: { usd: 0.001, dailyUsd: 0.01, monthlyUsd: 0.1 } }));
    done.catch(() => undefined);
    const call: Call = { req, cancelled: false, delta: onDelta, resolve };
    calls.push(call);
    return { done, cancel: () => { call.cancelled = true; reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })); } };
  };
  return { calls, explain };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await sleep(5); }
}

function setup(paragraphs: string[], listen: Partial<Settings['listen']> = {}, mode: 'reading' | 'listening' = 'listening') {
  const book = makeBook([{ title: 'One', paragraphs }]);
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  settings.voice.pauseBetweenSentencesMs = 0;
  settings.ai.speakChinese = false;
  settings.ai.styles = { custom: { shape: { wordBefore: 1, wordAfter: 0, sentenceAfterWord: 0, sentenceBefore: 1, sentenceAfter: 0 } } };
  Object.assign(settings.listen, { pauseAfterExplainMs: 0, quizWaitMs: 40, commandWindowMs: 30 }, listen);
  const vocab: VocabState = { words: {}, marked: {} };
  const reader = new FakeTtsEngine(1), explainer = new FakeTtsEngine(1), zh = new FakeTtsEngine(1);
  const ai = fakeAi();
  const windows: boolean[] = [];
  const entries: TranscriptEntry[] = [];
  const playback = new Playback(book, { engine: () => reader, voice: () => ({ voiceId: 'fake-gb', rate: 1 }), pauseMs: () => 0 });
  const controller = new ListenController(playback, {
    book, dict, names: new Set(), settings: () => settings, vocab: () => vocab, marked: () => [],
    engine: () => reader, explainEngine: () => explainer, zhEngine: () => zh,
    voice: () => ({ voiceId: 'fake-gb', rate: 1 }), explainVoice: () => ({ voiceId: 'fake-gb', rate: 1 }), zhVoiceId: () => null,
    explain: ai.explain, onTranscript: (e) => entries.push(e), onMarkLearning: () => undefined, mode: () => mode,
    onPauseWindow: (open) => windows.push(open),
  });
  controller.enabled = true;
  return { book, settings, vocab, reader, explainer, ai, windows, entries, playback, controller };
}

const POS = { chapter: 0, paragraph: 0, sentence: 0 };

describe('voice chat: controller', () => {
  it('a question is spoken sentence by sentence while the reply is still streaming', async () => {
    const t = setup(['He was calm.', 'Then he left.'], {}, 'reading');
    const p = t.controller.explainNow('question', 'He was calm.', POS, null, undefined, 'why is he calm', undefined, undefined, true);
    await until(() => t.ai.calls.length === 1);
    expect(t.ai.calls[0].req).toMatchObject({ kind: 'question', question: 'why is he calm', history: [] });
    t.ai.calls[0].delta('He has nothing');
    await sleep(20);
    expect(t.explainer.spoken).toEqual([]);
    t.ai.calls[0].delta('He has nothing to fear. He');
    await until(() => t.explainer.spoken.length === 1);
    expect(t.explainer.spoken[0].text).toBe('He has nothing to fear.'); // before the reply is complete
    expect(t.entries.at(-1)).toMatchObject({ kind: 'question', question: 'why is he calm', spoken: true, status: 'speaking' });
    t.ai.calls[0].resolve('He has nothing to fear. He trusts **his** friends.');
    await p;
    expect(t.explainer.spoken.map((s) => s.text)).toEqual(['He has nothing to fear.', 'He trusts his friends.']);
    expect(t.entries.at(-1)).toMatchObject({ status: 'done', parts: { free: 'He has nothing to fear. He trusts **his** friends.' } });
    // the question and the answer join the chapter's history for the next question
    void t.controller.explainNow('question', 'He was calm.', POS, null, undefined, 'and then?');
    await until(() => t.ai.calls.length === 2);
    expect(t.ai.calls[1].req.history).toEqual([{ role: 'user', text: 'why is he calm' }, { role: 'assistant', text: 'He has nothing to fear. He trusts **his** friends.' }]);
    t.controller.skip();
  });

  it('Listening: the window after the word opens the voice line; "I know" (markKnown + answerWindow) goes on at once, no explanation', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 5000 });
    const finished = new Promise<void>((r) => t.playback.on('finished', r));
    t.playback.play();
    await until(() => t.windows.length === 1);
    expect(t.windows).toEqual([true]);
    expect(t.controller.lastExplained).toMatchObject({ kind: 'word', lemma: 'sanguine' });
    const t0 = Date.now();
    expect(t.controller.answerWindow('know')).toBe(true);
    t.controller.markKnown('sanguine');
    await finished;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(t.ai.calls.length).toBe(1); // the prepared request, dropped
    expect(t.ai.calls[0].cancelled).toBe(true);
    expect(t.explainer.spoken).toEqual([]);
    expect(t.windows).toEqual([true, false]);
    expect(t.reader.spoken.slice(-2).map((s) => s.text)).toEqual(['He was sanguine.', 'Then he left.']);
  });

  it('"I don\'t know" after the explanation: the word again with again=true, then a new window', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 300 });
    t.playback.play();
    await until(() => t.ai.calls.length === 1); // silence in the first window: the explanation
    t.ai.calls[0].resolve('Sanguine means hopeful.');
    await until(() => t.windows.length === 3);
    expect(t.controller.answerWindow('dont_know')).toBe(true);
    await until(() => t.ai.calls.length === 2);
    expect(t.ai.calls[1].req).toMatchObject({ kind: 'word', target: 'sanguine', again: true });
    expect(t.windows).toEqual([true, false, true, false]);
    t.ai.calls[1].resolve('It means cheerful about the future.');
    await until(() => t.windows.length === 5);
    expect(t.windows).toEqual([true, false, true, false, true]);
    await until(() => t.reader.spoken.at(-1)?.text === 'Then he left.');
  });

  it('keepWaiting (the learner starts talking in the window) does not restart its countdown; a command still being said is waited for', async () => {
    const t = setup(['He was sanguine.', 'Then he left.'], { commandWindowMs: 150 });
    t.playback.play();
    await until(() => t.windows.length === 1);
    const t0 = Date.now();
    expect(t.ai.calls.length).toBe(1); // prepared when the book paused, not spoken yet
    t.ai.calls[0].resolve('Sanguine means hopeful.');
    await sleep(60);
    t.controller.keepWaiting(); // speech starts
    t.controller.answerWindow({ text: 'what is it' }); // swallowed: the window only takes commands
    await sleep(200);
    expect(t.windows).toEqual([true]); // past its end, but the learner is still talking: their words may be a command
    t.controller.windowSpeechEnded();
    const ended = Date.now();
    await until(() => t.explainer.spoken.length === 1); // nothing came: the prepared explanation
    expect(Date.now() - ended).toBeGreaterThanOrEqual(1100); // the words of a command arrive after the speech ends
    expect(Date.now() - t0).toBeLessThan(150 + 2500 + 300); // never more than 2.5 s past the end
    expect(t.windows).toEqual([true, false]);
    expect(t.ai.calls.length).toBe(1);
    expect(t.ai.calls[0].req.question).toBeUndefined();
    t.playback.stop();
  });

  it('barge-in: hold() silences the explanation and pauses; the spoken question resumes Listening afterwards', async () => {
    const t = setup(['He was calm.', 'Then he left.', 'The end.']);
    t.playback.play();
    await until(() => t.reader.spoken.length >= 1);
    expect(t.controller.hold()).toBe(true);
    expect(t.playback.state).toBe('paused');
    expect(t.controller.holding).toBe(true);
    const p = t.controller.explainNow('question', 'He was calm.', t.playback.position, null, undefined, 'what does calm mean', undefined, undefined, true);
    await until(() => t.ai.calls.length === 1);
    expect(t.controller.holding).toBe(false);
    t.ai.calls[0].resolve('Calm means quiet and relaxed.');
    await p;
    await until(() => t.playback.state === 'playing' || t.playback.state === 'idle');
  });

  it('barge-in during a reply cancels the reply (no resume); release() after noise resumes only what was playing', async () => {
    const t = setup(['He was calm.', 'Then he left.']);
    t.playback.play();
    await until(() => t.reader.spoken.length >= 1);
    const p = t.controller.explainNow('question', 'He was calm.', POS, null, undefined, 'why', undefined, undefined, true);
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].delta('Because he is tired. And');
    await until(() => t.explainer.spoken.length === 1);
    t.controller.hold();
    await p;
    expect(t.ai.calls[0].cancelled).toBe(true);
    expect(t.playback.state).toBe('paused'); // the learner is talking: the book waits
    t.controller.release(true);
    expect(t.playback.state).toBe('playing');
    t.playback.stop();
    // nothing was playing: release does not start the book
    const r = setup(['He was calm.']);
    r.controller.hold();
    r.controller.release(true);
    expect(r.playback.state).toBe('idle');
  });

  it('Reading: no pause, but a short answer window after an explanation', async () => {
    const t = setup(['He was sanguine.'], { pauseAfterExplainMs: 80 }, 'reading');
    const p = t.controller.explainNow('word', 'sanguine', POS, null, 'sanguine');
    await until(() => t.ai.calls.length === 1);
    t.ai.calls[0].resolve('Hopeful.');
    await p;
    expect(t.windows).toEqual([true]);
    await until(() => t.windows.length === 2);
    expect(t.windows).toEqual([true, false]);
    expect(t.playback.state).not.toBe('playing');
  });
});
