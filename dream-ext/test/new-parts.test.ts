/**
 * The YouTube additions: the AI's complete sentences, the live Chinese lines, hard sentences, shortcuts, the live
 * call's settings and cost, and the hard-sentence stop through Dream Read's teacher (played from the video, the
 * commands window, the explanation spoken while it streams in, the sentence again, back to its start).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { chunkBounds, parseSplit, regroup, splitWithAi, flatten, plainSentence, alignLines, joinCut, punctuationLines } from '../src/sentences-ai';
import { parseLines, parseWordMeanings } from '../src/zh';
import { parseHardSentences } from '../src/hard-sentences';
import { comboOf, actionFor, comboLabel } from '../src/shortcuts';
import { realtimeUsd, liveSessionLadder, liveModels, pickProvider, azureSsml, azureTurn } from '../src/bg';
import { sessionFor, liveInstructions } from '../src/live';
import { resolveVoice, SentenceFromVideo, azureZhVoice } from '../src/voice';
import { Playback } from '@core/listen/playback';
import { ListenController, type CommandWindow } from '@core/listen/controller';
import { FakeTtsEngine } from '@core/tts/fake';
import { DEFAULT_SETTINGS, type Settings, type VocabState } from '@shared/settings';
import type { ExplainRequest } from '@shared/api';
import { getSentence } from '@core/nav';
import { buildVideoBook } from '../src/video-book';
import { azureRegionOf, azureCharsSince, azureUsageText, resumeAt } from '../src/store';
import { suggestLevel, levelNote } from '../src/vocab';
import { VideoEngine } from '../src/video-engine';
import { FakeVideo, realDictionary } from './helpers';
import type { TimedWord } from '../src/video-book';

const W = (text: string, t0: number, step = 0.4): TimedWord[] => text.split(' ').map((w, i) => ({ w, t: t0 + i * step, e: t0 + (i + 1) * step - 0.05 }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000): Promise<void> { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await wait(10); } }

describe('the AI finds the complete sentences', () => {
  const words = [...W('so today we are going to talk about', 0), ...W('cooking and i think you will love it', 3.5)];
  it('cuts chunks at the longest pause', () => {
    const b = chunkBounds(words, 10);
    expect(b[0]).toEqual([0, 8]); // the 0.75 s pause after "about"
    expect(b[b.length - 1][1]).toBe(words.length);
  });
  it('reads "<last word>|<sentence>" lines, drops bad ones and closes the end', () => {
    const lines = parseSplit('7|So today we are going to talk about cooking.\nnonsense\n3|bad order\n15|And I think you will love it.', 0, 16);
    expect(lines).toEqual([{ end: 7, text: 'So today we are going to talk about cooking.' }, { end: 15, text: 'And I think you will love it.' }]);
    expect(parseSplit('5|Only part.', 0, 16).at(-1)).toEqual({ end: 15, text: '' });
  });
  it('keeps the word times and uses the AI text only when it is still these words', () => {
    const out = regroup(words, [{ end: 8, text: 'So today, we are going to talk about cooking.' }, { end: 15, text: 'Something completely different here.' }]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe('So today, we are going to talk about cooking.');
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBeCloseTo(words[8].e);
    expect(out[1].text).toBe('And i think you will love it.'); // the AI text did not fit: the words themselves
    expect(plainSentence(['[Music]', 'hello', 'there'])).toBe('Hello there.');
  });
  it('never cuts a sentence in the middle when the AI counts the words wrong (its text decides)', () => {
    const ws = [...W('So in college, I was a government major,', 0), ...W('which means I had to write a lot of papers.', 3.3), ...W('(Laughter) Now, when a normal student writes a paper,', 7.8), ...W('they might spread the work out.', 11.5)];
    // the AI's numbers are wrong (7 and 20), its sentences are right
    const lines = alignLines(ws, parseSplit('7|So in college, I was a government major, which means I had to write a lot of papers.\n20|Now, when a normal student writes a paper, they might spread the work out.', 0, ws.length), 0, ws.length);
    expect(lines.map((l) => l.end)).toEqual([18, ws.length - 1]); // after "papers." and the (Laughter)
    const out = regroup(ws, lines);
    expect(out.map((s) => s.text)).toEqual(['So in college, I was a government major, which means I had to write a lot of papers.', 'Now, when a normal student writes a paper, they might spread the work out.']);
    expect(plainSentence(['I', 'was', 'a', 'major,'])).toBe('I was a major.');
    // the AI thinking aloud between its sentences: dropped, its words stay with the real sentences
    const junk = alignLines(ws, parseSplit('5|So in college, I was a government major, which means I had to write a lot of papers.\n9|Actually the first line should start at word 1584. Let me do it.\n20|Now, when a normal student writes a paper, they might spread the work out.', 0, ws.length), 0, ws.length);
    expect(junk.map((l) => l.end)).toEqual([18, ws.length - 1]);
    // an AI text with words that are not there (it "finished" the sentence itself): the real words are shown
    expect(regroup(ws, [{ end: 7, text: 'So in college, I was a government major, which means I had to write a lot of papers.' }, { end: ws.length - 1, text: '' }])[0].text).toBe('So in college, I was a government major.');
  });
  it('a sentence cut at a comma becomes one sentence again', async () => {
    const rule = [{ start: 0, end: 2.8, text: 'so today we are going to talk about', words: words.slice(0, 8) }, { start: 3.5, end: 6.7, text: 'cooking and i think you will love it', words: words.slice(8) }];
    const out = await splitWithAi(rule, async () => '4|So today, we are going,\n15|to talk about cooking, and I think you will love it.');
    expect(out.map((s) => s.text)).toEqual(['So today, we are going, to talk about cooking, and I think you will love it.']);
    // a real end stays an end; speech subtitles without punctuation are not joined
    expect(joinCut([{ start: 0, end: 1, text: 'It works.' }, { start: 1, end: 2, text: 'iPhones too.' }]).length).toBe(2);
    expect(joinCut([{ start: 0, end: 1, text: 'so today we' }, { start: 1, end: 2, text: 'are going' }]).length).toBe(2);
    // written subtitles (full stops): when the AI fails, the sentences are where the full stops are
    const ws = [...W('I was a major, which means', 0), ...W('papers. (Laughter) Now when', 3), ...W('it ends.', 6)];
    expect(punctuationLines(ws, 0, ws.length).map((l) => l.end)).toEqual([7, ws.length - 1]);
  });
  it('a sentence cut where two chunks meet becomes one sentence again', async () => {
    const rule = [{ start: 0, end: 2.8, text: 'so today we are going to talk about', words: words.slice(0, 8) }, { start: 3.5, end: 6.7, text: 'cooking and i think you will love it', words: words.slice(8) }];
    const out = await splitWithAi(rule, async (p) => (p.user.includes('0:so') ? '7|~So today we are going to talk about' : '15|Cooking, and I think you will love it.'), undefined, 1, 10);
    expect(out.map((s) => s.text)).toEqual(['So today we are going to talk about cooking, and I think you will love it.']);
    expect(flatten(out)).toHaveLength(16);
  });
  it('a nonsense answer keeps the first guess (never one giant sentence)', async () => {
    const rule = [{ start: 0, end: 2.8, text: 'so today we are going to talk about', words: words.slice(0, 8) }, { start: 3.5, end: 6.7, text: 'cooking and i think you will love it', words: words.slice(8) }];
    // no usable answer at all: an error, and the tutor keeps the first guess
    await expect(splitWithAi(rule, async () => 'Meticulous means very careful.')).rejects.toThrow();
    await expect(splitWithAi(rule, async () => '2|So today we.')).rejects.toThrow();
    // one chunk unusable, the other fine: the unusable one keeps the first guess
    const long = [...rule, { start: 8, end: 11, text: 'and this is the end of it all', words: W('and this is the end of it all', 8) }];
    let n = 0;
    const out = await splitWithAi(long, async (p) => (n++ === 0 && p.user.includes('0:so') ? '15|So today we are going to talk about cooking and I think you will love it.' : 'garbage'), undefined, 1);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });
  it('splits a whole video with the model (a few chunks at a time)', async () => {
    const rule = [{ start: 0, end: 2.8, text: 'so today we are going to talk about', words: words.slice(0, 8) }, { start: 3.5, end: 6.7, text: 'cooking and i think you will love it', words: words.slice(8) }];
    const prompts: string[] = [];
    const out = await splitWithAi(rule, async (p) => { prompts.push(p.user); return '8|So today we are going to talk about cooking.\n15|And I think you will love it.'; });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('0:so 1:today');
    expect(out.map((s) => s.text)).toEqual(['So today we are going to talk about cooking.', 'And I think you will love it.']);
    expect(flatten(out)).toHaveLength(16);
  });
});

describe('live Chinese, hard sentences, shortcuts', () => {
  it('Chinese lines appear as soon as each is complete', () => {
    expect([...parseLines('1. 你好\n2. 今天我', 3)]).toEqual([[1, '你好']]);
    expect([...parseLines('1. 你好\n2. 今天我们学习', 3, true)]).toEqual([[1, '你好'], [2, '今天我们学习']]);
    expect(parseWordMeanings('一丝不苟的；细致的')).toEqual(['一丝不苟的', '细致的']);
    expect(parseWordMeanings('none')).toBeNull();
  });
  it('hard sentences: 1-based JSON to positions, at most max', () => {
    expect(parseHardSentences('Sure: {"hard":[3,1,3,9]}', 5, 2)).toEqual([0, 2]);
    expect(parseHardSentences('nothing', 5, 2)).toEqual([]);
  });
  it('shortcuts: ← explains the last sentence, custom keys win', () => {
    const k = (code: string, shift = false) => ({ code, shiftKey: shift, ctrlKey: false, altKey: false, metaKey: false });
    expect(actionFor(k('ArrowLeft'), {})?.id).toBe('explainSentence');
    expect(actionFor(k('KeyE', true), {})?.id).toBe('explainLast');
    expect(actionFor(k('KeyJ'), { talk: 'KeyJ' })?.id).toBe('talk');
    expect(comboOf(k('ShiftLeft', true))).toBe('');
    expect(comboLabel('Shift+KeyE')).toBe('Shift+E');
    expect(comboLabel('BracketRight')).toBe(']');
  });
});

describe('the live call and the voice', () => {
  it('session settings: sensitive microphone = a lower speech threshold; the ladder gets simpler', () => {
    const s = sessionFor({ model: 'gpt-realtime-2.1', voice: 'marin', instructions: 'x', transcribe: true, mic: 3 }) as { audio: { input: { turn_detection: { type: string; threshold: number } } } };
    expect(s.audio.input.turn_detection).toMatchObject({ type: 'server_vad', threshold: 0.25 });
    const ladder = liveSessionLadder(s as unknown as Record<string, unknown>);
    expect(ladder).toHaveLength(3);
    expect(JSON.stringify(ladder[2])).not.toContain('transcription');
    expect(JSON.stringify(ladder[2])).toContain('marin');
  });
  it('live models: the chosen one first, then the older ones', () => {
    expect(liveModels('gpt-realtime-2.1-mini')).toEqual(['gpt-realtime-2.1-mini', 'gpt-realtime-2.1', 'gpt-realtime-2', 'gpt-realtime']);
  });
  it('cost of the live call from its usage', () => {
    const usd = realtimeUsd('gpt-realtime-2.1-mini', { input_token_details: { audio_tokens: 1_000_000, text_tokens: 0 }, output_token_details: { audio_tokens: 1_000_000 } });
    expect(usd).toBeCloseTo(30);
  });
  it('one key is enough: the other provider is used', () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    expect(pickProvider(s, { openai: 'k' }).provider).toBe('openai');
    expect(pickProvider(s, { anthropic: 'k', openai: 'k' }).provider).toBe(s.ai.provider);
  });
  it('the Microsoft voice: Auto picks it with its key (free); the request says Chinese in Mandarin', () => {
    expect(resolveVoice('auto', { azure: 'k', openai: 'o' })).toBe('azure');
    expect(resolveVoice('azure', { openai: 'o' })).toBe('mac');
    expect(resolveVoice('azure', { azure: 'k' })).toBe('azure');
    const ssml = azureSsml('It means 主修 & more <now>.', 'en-GB-AdaMultilingualNeural');
    expect(ssml).toContain('xml:lang="en-GB"');
    expect(ssml).toContain('<voice name="en-GB-AdaMultilingualNeural">');
    expect(ssml).toContain('<lang xml:lang="zh-CN">主修</lang>');
    expect(ssml).toContain('&amp; more &lt;now&gt;.');
    expect(azureSsml('主修', 'en-US-AvaMultilingualNeural', 'zh', false)).toContain('<voice name="en-US-AvaMultilingualNeural">主修</voice>');
    // a voice that is not multilingual: no <lang>; its Chinese words go to a Mandarin voice of the same gender
    expect(azureSsml('It means 主修.', 'en-CA-LiamNeural')).not.toContain('<lang');
    expect(azureSsml('主修', 'zh-CN-YunxiNeural', 'zh')).toContain('<voice name="zh-CN-YunxiNeural">主修</voice>');
    expect(azureZhVoice('en-CA-LiamNeural')).toBe('zh-CN-YunxiNeural');
    expect(azureZhVoice('en-AU-NatashaNeural')).toBe('zh-CN-XiaoxiaoNeural');
    expect(azureZhVoice('en-GB-AdaMultilingualNeural')).toBe('en-GB-AdaMultilingualNeural');
    expect(azureRegionOf('East US')).toBe('eastus');
    expect(azureRegionOf('https://westeurope.api.cognitive.microsoft.com/')).toBe('westeurope');
  });
  it('Microsoft free plan: at most 19 voice requests a minute, the others wait their turn (no error, no Mac voice)', async () => {
    vi.useFakeTimers();
    try {
      const done: number[] = [];
      for (let i = 0; i < 21; i++) void azureTurn().then(() => done.push(i));
      await vi.advanceTimersByTimeAsync(10);
      expect(done.length).toBe(19);
      await vi.advanceTimersByTimeAsync(60_100);
      expect(done).toEqual([...Array(21).keys()]);
    } finally { vi.useRealTimers(); }
  });
  it('the Microsoft counter: characters this month, of the free 500,000, and the hours left', () => {
    const rec = (date: string, model: string, chars: number) => ({ date, provider: 'openai' as const, model, inputTokens: chars, outputTokens: 0, cachedTokens: 0, usd: 0 });
    const list = [rec('2026-09-30T10:00:00.000Z', 'azure-neural', 9000), rec('2026-10-02T10:00:00.000Z', 'azure-neural', 40000), rec('2026-10-03T10:00:00.000Z', 'gpt-4o-mini-tts', 5000), rec('2026-10-04T10:00:00.000Z', 'azure-neural', 7312)];
    expect(azureCharsSince(list, '2026-10-01T00:00:00.000Z')).toBe(47312);
    expect(azureUsageText(47312).text).toBe('Microsoft this month: 47,312 of 500,000 free characters used (9%) · about 8.4 hours of talking left');
    expect(azureUsageText(450000).low).toBe(true);
    expect(azureUsageText(500000).text).toMatch(/nothing left: the Microsoft voice stops until next month/);
  });
  it('back where you stopped: a video well started and not finished, seen in the last two months', () => {
    const now = Date.parse('2026-10-24T10:00:00Z');
    expect(resumeAt({ t: 300, d: 900, at: now - 3600_000 }, now, 900)).toBe(297);
    expect(resumeAt({ t: 20, d: 900, at: now }, now, 900)).toBeNull(); // just started
    expect(resumeAt({ t: 890, d: 900, at: now }, now, 900)).toBeNull(); // finished
    expect(resumeAt({ t: 300, d: 900, at: now - 70 * 86400_000 }, now, 900)).toBeNull(); // long ago
    expect(resumeAt(null, now, 900)).toBeNull();
  });
  it('my level from my words: up when I knew most of the next level, down when many of mine were new', () => {
    const lv = (level: string, known: number, learning: number) => ({ level, known, learning, unknown: 0, total: 1000 }) as never;
    expect(suggestLevel([lv('B2', 10, 2), lv('C1', 16, 4)], 'B2')).toEqual({ level: 'C1', reason: 'you knew 16 of the 20 C1 words you met' });
    expect(suggestLevel([lv('B2', 10, 2), lv('C1', 8, 6)], 'B2')).toBeNull(); // too few C1 words, and not 75 %
    expect(suggestLevel([lv('B2', 4, 14)], 'B2')?.level).toBe('B1');
    expect(suggestLevel([lv('C2', 40, 2)], 'C2')).toBeNull();
    expect(levelNote([lv('B2', 10, 2), lv('C1', 16, 4)], 'B2')).toBe('B2 words you met: 10 of 12 known · C1 words you met: 16 of 20 known');
  });
  it('auto voice = OpenAI with its key, else the Mac voice', () => {
    expect(resolveVoice('auto', { openai: 'k' })).toBe('openai');
    expect(resolveVoice('auto', {})).toBe('mac');
    expect(resolveVoice('elevenlabs', {})).toBe('mac');
  });
  it('the tutor knows the part on the screen and the learner\'s rules', () => {
    const t = liveInstructions({ teacher: 'RULE ONE', level: 'B2', title: 'Lesson', part: ['Hello there.', 'It was meticulous.'], from: '0:00', to: '0:30', word: 'meticulous', explanation: 'Very careful.' });
    expect(t).toContain('RULE ONE');
    expect(t).toContain('2. It was meticulous.');
    expect(t).toContain('continue_video');
    expect(t).toContain('"meticulous"');
  });
});

describe('a hard sentence stops like a word (YouTube)', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  it('plays it once from the video, the window, explains while streaming, plays it again, back to its start', async () => {
    const s1 = 'Hello and welcome back.';
    const s2 = 'Then she went home to rest.';
    const vb = buildVideoBook({ id: 'vid00000002', title: 'Test' }, [
      { start: 0, end: 1.6, text: s1, words: W(s1.toLowerCase(), 0) },
      { start: 1.6, end: 4.0, text: s2, words: W(s2.toLowerCase(), 1.6) },
    ]);
    const video = new FakeVideo(30);
    const clock = setInterval(() => video.tick(0.05), 10);
    const engine = new VideoEngine(() => video, () => vb);
    const tts = new FakeTtsEngine(1);
    const router = new SentenceFromVideo(() => tts, engine, (text) => { const p = engine.target; return !!p && getSentence(vb.book, p)?.text === text; });
    const settings: Settings = structuredClone(DEFAULT_SETTINGS);
    settings.listen.commandWindowMs = 300;
    settings.listen.pauseAfterExplainMs = 200;
    settings.ai.speakChinese = false;
    settings.ai.styles = { custom: { shape: { wordBefore: 3, wordAfter: 10, sentenceAfterWord: 1, sentenceBefore: 1, sentenceAfter: 1 } } };
    const vocab: VocabState = { words: {}, marked: {} };
    const requests: ExplainRequest[] = [];
    const windows: (CommandWindow | null)[] = [];
    const playback = new Playback(vb.book, { engine: () => engine, voice: () => ({ voiceId: 'v', rate: 1 }), pauseMs: () => 0 }, vb.order[0]);
    playback.on('sentence', (pos) => { engine.target = pos; });
    playback.on('state', (st) => { if (st === 'explaining') engine.hold(); });
    let spokenBeforeDone = 0;
    const controller = new ListenController(playback, {
      book: vb.book, dict: realDictionary(), names: new Set(),
      settings: () => settings, vocab: () => vocab, marked: () => [],
      engine: () => router, explainEngine: () => tts, zhEngine: () => tts,
      voice: () => ({ voiceId: 'v', rate: 1 }), explainVoice: () => ({ voiceId: 'v', rate: 1 }), zhVoiceId: () => null,
      explain: (req, onDelta) => {
        requests.push(req);
        // the reply streams in; it is only "done" a while later
        onDelta('She goes to her house.');
        setTimeout(() => onDelta('She goes to her house. She wants to sleep.'), 30);
        const done = new Promise<{ text: string; usage: { usd: number; dailyUsd: number; monthlyUsd: number } }>((r) => setTimeout(() => { spokenBeforeDone = tts.spoken.filter((x) => x.text.startsWith('She goes')).length; r({ text: 'She goes to her house. She wants to sleep.', usage: { usd: 0, dailyUsd: 0, monthlyUsd: 0 } }); }, 400));
        return { done, cancel: () => undefined };
      },
      onTranscript: () => undefined,
      onMarkLearning: (l) => { vocab.words[l] = 'learning'; },
      onCommandWindow: (w) => windows.push(w),
      sentenceTrigger: (pos) => (pos.sentence === vb.order[1].sentence && pos.paragraph === vb.order[1].paragraph ? { lemma: 'sentence: then she went home to rest' } : null),
      streamProse: () => true,
    });
    controller.enabled = true;
    cleanup = () => { clearInterval(clock); controller.dispose(); playback.stop(); };
    playback.play();
    await until(() => requests.length === 1);
    expect(requests[0].kind).toBe('sentence');
    expect(windows.find((w) => w)?.phase).toBe('before');
    // the sentence was played once from the video before the window: a jump back to its start
    expect(video.events.filter((e) => e === 'seek@1.45').length).toBeGreaterThanOrEqual(1);
    // the explanation started speaking before the reply was complete
    await until(() => spokenBeforeDone > 0 || tts.spoken.some((x) => x.text === 'She wants to sleep.'));
    expect(spokenBeforeDone).toBeGreaterThan(0);
    // then the sentence again from the video, and the reading goes on after it (it was just heard)
    await until(() => video.events.filter((e) => e === 'seek@1.45').length >= 2, 10000);
    await until(() => playback.state === 'idle' || video.currentTime > 3.95, 10000);
    expect(video.events.filter((e) => e === 'seek@1.45').length).toBe(2);
    await until(() => vocab.words['sentence: then she went home to rest'] === 'learning');
  }, 20000);
});
