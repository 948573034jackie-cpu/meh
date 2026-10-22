/**
 * Dream Read's own listening teacher (Playback + ListenController, unchanged) reading a YouTube video through the
 * VideoEngine: the video stops right after a hard word, the word is said 3 times, the 5-second commands window
 * opens (nothing sent to the AI), the explanation comes, then the video goes back to the start of the
 * interrupted sentence and plays on.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Playback } from '@core/listen/playback';
import { ListenController, type CommandWindow } from '@core/listen/controller';
import { FakeTtsEngine } from '@core/tts/fake';
import { DEFAULT_SETTINGS, type Settings, type VocabState } from '@shared/settings';
import type { ExplainRequest } from '@shared/api';
import { buildVideoBook } from '../src/video-book';
import { VideoEngine } from '../src/video-engine';
import { FakeVideo, realDictionary } from './helpers';

const words = (text: string, t0: number, step = 0.4) => text.split(' ').map((w, i) => ({ w, t: t0 + i * step, e: t0 + (i + 1) * step }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000): Promise<void> { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await wait(10); } }

function setup(opts: { windowMs?: number } = {}) {
  const s1 = 'She was very meticulous about her work.';
  const s2 = 'Then she went home to rest.';
  const vb = buildVideoBook({ id: 'vid00000001', title: 'Test video' }, [
    { start: 0, end: 2.8, text: s1, words: words(s1.toLowerCase(), 0) },
    { start: 2.8, end: 5.2, text: s2, words: words(s2.toLowerCase(), 2.8) },
  ]);
  const video = new FakeVideo(30);
  const clock = setInterval(() => video.tick(0.05), 10); // the video runs 5x faster than real time
  const engine = new VideoEngine(() => video, () => vb);
  const tts = new FakeTtsEngine(1);
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  settings.listen.commandWindowMs = opts.windowMs ?? 300;
  settings.listen.pauseAfterExplainMs = 300;
  settings.ai.speakChinese = false;
  const vocab: VocabState = { words: {}, marked: {} };
  const requests: ExplainRequest[] = [];
  const windows: (CommandWindow | null)[] = [];
  const timeline: string[] = [];
  const playback = new Playback(vb.book, { engine: () => engine, voice: () => ({ voiceId: 'fake-gb', rate: 1 }), pauseMs: () => 0 }, vb.order[0]);
  playback.on('sentence', (pos) => { engine.target = pos; });
  playback.on('state', (st) => { if (st === 'explaining') engine.hold(); });
  const controller = new ListenController(playback, {
    book: vb.book, dict: realDictionary(), names: new Set(),
    settings: () => settings, vocab: () => vocab, marked: () => [],
    engine: () => tts, explainEngine: () => tts, zhEngine: () => tts,
    voice: () => ({ voiceId: 'fake-gb', rate: 1 }), explainVoice: () => ({ voiceId: 'fake-gb', rate: 1 }), zhVoiceId: () => null,
    explain: (req) => { requests.push(req); timeline.push(`explain:${req.target}@${video.currentTime.toFixed(1)}`); return { done: Promise.resolve({ text: 'It means very careful about every small detail.', usage: { usd: 0, dailyUsd: 0, monthlyUsd: 0 } }), cancel: () => undefined }; },
    onTranscript: () => undefined,
    onMarkLearning: (l) => { vocab.words[l] = 'learning'; },
    onCommandWindow: (w) => { windows.push(w); if (w) timeline.push(`window:${w.phase}`); },
  });
  controller.enabled = true;
  return { vb, video, clock, engine, tts, settings, vocab, requests, windows, timeline, playback, controller };
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

describe('the Dream Read listening rule on a YouTube video', () => {
  it('stops after the hard word, says it 3 times, commands window, explains, then re-reads the sentence from its start', async () => {
    const t = setup();
    cleanup = () => { clearInterval(t.clock); t.controller.dispose(); t.playback.stop(); };
    t.playback.play();
    await until(() => t.requests.length === 1);
    // the video paused right after "meticulous" (1.2-1.6 s), not at the end of the sentence
    const pause = t.video.events.find((e) => e.startsWith('pause@'))!;
    expect(Number(pause.slice(6))).toBeGreaterThan(1.5);
    expect(Number(pause.slice(6))).toBeLessThan(2.1);
    // the word was said 3 times by the voice before anything was sent, and a commands window came first
    expect(t.tts.spoken.slice(0, 3).map((x) => x.text)).toEqual(['meticulous', 'meticulous', 'meticulous']);
    expect(t.timeline[0]).toBe('window:before');
    expect(t.requests[0].kind).toBe('word');
    expect(t.requests[0].target).toBe('meticulous');
    expect(t.requests[0].sentence).toBe('She was very meticulous about her work.');
    // nothing played while the teacher was talking
    expect(t.video.paused).toBe(true);
    // after the explanation and the second window: back to the start of the sentence, then on to the next one
    await until(() => t.video.events.some((e) => e === 'play@0.00'));
    await until(() => t.video.currentTime > 3.5);
    expect(t.timeline).toContain('window:after');
    expect(t.requests).toHaveLength(1); // no second stop in the re-read sentence
    expect(t.vocab.words.meticulous).toBe('learning');
    // jumps: to the start once at the beginning, once back to the start after the stop; the second sentence followed straight on
    expect(t.video.events.filter((e) => e.startsWith('seek@'))).toEqual(['seek@0.00', 'seek@0.00']);
  });

  it('"I know" in the first window: no explanation, marked known, reading goes on from the sentence start', async () => {
    const t = setup({ windowMs: 3000 });
    cleanup = () => { clearInterval(t.clock); t.controller.dispose(); t.playback.stop(); };
    t.playback.play();
    await until(() => t.windows.some((w) => w?.phase === 'before'));
    expect(t.controller.answerWindow('know')).toBe(true);
    await until(() => t.video.events.includes('play@0.00') && t.video.currentTime > 3);
    expect(t.requests).toHaveLength(0);
  });

  it('anything else said in the window is never sent to the AI', async () => {
    const t = setup({ windowMs: 3000 });
    cleanup = () => { clearInterval(t.clock); t.controller.dispose(); t.playback.stop(); };
    t.playback.play();
    await until(() => t.windows.some((w) => w?.phase === 'before'));
    expect(t.controller.answerWindow({ text: 'meticulous meticulous what is that' })).toBe(true);
    await wait(100);
    expect(t.requests).toHaveLength(0);
    t.controller.answerWindow('dont_know');
    await until(() => t.requests.length === 1);
    expect(t.requests[0].question).toBeUndefined();
  });
});
