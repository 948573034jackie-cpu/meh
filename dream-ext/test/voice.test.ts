/**
 * The good (cloud) voice must not "disconnect": a failed sentence is tried again, then only that sentence goes to the
 * Mac voice; three failures in a row = the Mac voice for one minute, then the good voice again. Chrome's online
 * voices get short pieces (they stop after about 15 s). The Microsoft voice request (SSML).
 */
import { describe, it, expect } from 'vitest';
import { VoiceWithBackup, ShortPieces, splitPieces } from '../src/voice';
import { azureSsml } from '../src/bg';
import type { TtsEngine, SpeakHandle, SpeakOptions, SpeakOutcome } from '@core/tts/engine';

/** a voice whose sentences end with the given outcomes, one by one ('silent' = never starts) */
function fakeVoice(outcomes: (SpeakOutcome | 'silent')[]) {
  const said: string[] = [];
  const engine: TtsEngine = {
    id: 'openai', kind: 'cloud', label: 'fake', costNote: '', wordBoundaries: false, paused: false,
    listVoices: async () => [],
    speak(text: string, opts: SpeakOptions): SpeakHandle {
      said.push(text);
      const o = outcomes.length ? outcomes.shift()! : 'ended';
      if (o === 'silent') {
        let resolve!: (x: SpeakOutcome) => void;
        const done = new Promise<SpeakOutcome>((r) => { resolve = r; });
        return { done, cancel: () => resolve('cancelled') };
      }
      if (o === 'ended') opts.onStart?.();
      const h: SpeakHandle = { done: Promise.resolve(o), cancel: () => undefined };
      if (o === 'error') h.error = new Error('HTTP 500');
      return h;
    },
    pause: () => undefined, resume: () => undefined, cancelAll: () => undefined,
  } as unknown as TtsEngine;
  return { engine, said };
}

describe('the good voice does not disconnect', () => {
  it('a hiccup: tried once more, still the good voice', async () => {
    const cloud = fakeVoice(['error', 'ended']), mac = fakeVoice([]);
    const v = new VoiceWithBackup(cloud.engine, mac.engine, () => 'mac', () => undefined);
    expect(await v.speak('Hello there.', { voiceId: 'marin', rate: 1 }).done).toBe('ended');
    expect(cloud.said).toEqual(['Hello there.', 'Hello there.']);
    expect(mac.said).toEqual([]);
  });
  it('failed twice: only that sentence by the Mac voice, the next one is the good voice again', async () => {
    const cloud = fakeVoice(['error', 'error', 'ended']), mac = fakeVoice([]);
    const trouble: boolean[] = [];
    const v = new VoiceWithBackup(cloud.engine, mac.engine, () => 'mac', (_e, cooling) => trouble.push(cooling));
    await v.speak('One.', { voiceId: 'marin', rate: 1 }).done;
    await v.speak('Two.', { voiceId: 'marin', rate: 1 }).done;
    expect(mac.said).toEqual(['One.']);
    expect(cloud.said.at(-1)).toBe('Two.');
    expect(trouble).toEqual([false]);
    expect(v.failed).toBe(false);
  });
  it('three failed sentences in a row: the Mac voice for one minute, then the good voice again', async () => {
    let now = 0;
    const cloud = fakeVoice(['error', 'error', 'error', 'error', 'error', 'error']), mac = fakeVoice([]);
    const trouble: boolean[] = [];
    const v = new VoiceWithBackup(cloud.engine, mac.engine, () => 'mac', (_e, cooling) => trouble.push(cooling), 12_000, () => now);
    for (const t of ['A.', 'B.', 'C.']) await v.speak(t, { voiceId: 'marin', rate: 1 }).done;
    expect(trouble).toEqual([false, false, true]);
    expect(v.failed).toBe(true);
    await v.speak('D.', { voiceId: 'marin', rate: 1 }).done;
    expect(mac.said).toEqual(['A.', 'B.', 'C.', 'D.']);
    now += 61_000;
    expect(v.failed).toBe(false);
    await v.speak('E.', { voiceId: 'marin', rate: 1 }).done;
    expect(cloud.said.at(-1)).toBe('E.');
  });
  it('no sound in time: tried again, then the Mac voice', async () => {
    const cloud = fakeVoice(['silent', 'silent']), mac = fakeVoice([]);
    const v = new VoiceWithBackup(cloud.engine, mac.engine, () => 'mac', () => undefined, 30);
    expect(await v.speak('Hi.', { voiceId: 'marin', rate: 1 }).done).toBe('ended');
    expect(cloud.said).toHaveLength(2);
    expect(mac.said).toEqual(['Hi.']);
    expect(v.lastError).toMatch(/no sound/);
  });
  it('Chrome online voices get short pieces; others the whole text', async () => {
    const inner = fakeVoice([]);
    const v = new ShortPieces(inner.engine, (id) => /^Google /.test(id), 40);
    const long = 'This is a long explanation, with several parts, that would take more than fifteen seconds to say.';
    await v.speak(long, { voiceId: 'Google UK English Female', rate: 1 }).done;
    expect(inner.said.length).toBeGreaterThan(1);
    expect(inner.said.every((p) => p.length <= 41)).toBe(true);
    expect(inner.said.join(' ').replace(/\s+/g, ' ')).toBe(long);
    inner.said.length = 0;
    await v.speak(long, { voiceId: 'Samantha', rate: 1 }).done;
    expect(inner.said).toEqual([long]);
    expect(splitPieces('a, b', 100)).toEqual(['a, b']);
  });
  it('the Microsoft voice: SSML with the voice, Chinese with a Mandarin voice, text escaped', () => {
    expect(azureSsml('Tom & <Jerry>', 'en-GB-SoniaNeural')).toContain('<voice name="en-GB-SoniaNeural">Tom &amp; &lt;Jerry&gt;</voice>');
    expect(azureSsml('Tom', 'en-GB-SoniaNeural')).toContain('xml:lang="en-GB"');
    expect(azureSsml('一丝不苟的', 'en-US-AvaMultilingualNeural', 'zh')).toContain('zh-CN-XiaoxiaoNeural');
  });
});
