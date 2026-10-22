import { describe, it, expect, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, safeStorage: { isEncryptionAvailable: () => false }, app: { getPath: () => '/tmp' } }));
import { parseEdgeMetadata, alignWords, charAlignmentToWords } from '../../src/main/tts';
import { handlePrepare } from '../../src/main/kokoro/ipc-prepare';

describe('cloud TTS timing helpers', () => {
  it('parses Edge word boundaries and aligns them to the text', () => {
    const text = 'Hello there, Mr Darcy.';
    const chunk = JSON.stringify({ Metadata: [
      { Type: 'WordBoundary', Data: { Offset: 1_000_000, Duration: 3_000_000, text: { Text: 'Hello' } } },
      { Type: 'WordBoundary', Data: { Offset: 5_000_000, Duration: 2_000_000, text: { Text: 'there' } } },
      { Type: 'SentenceBoundary', Data: { Offset: 0, Duration: 0, text: { Text: 'x' } } },
      { Type: 'WordBoundary', Data: { Offset: 8_000_000, Duration: 2_000_000, text: { Text: 'Mr' } } },
      { Type: 'WordBoundary', Data: { Offset: 11_000_000, Duration: 4_000_000, text: { Text: 'Darcy' } } },
    ] });
    const t = parseEdgeMetadata([chunk], text)!;
    expect(t.map((x) => [x.charIndex, x.charLength])).toEqual([[0, 5], [6, 5], [13, 2], [16, 5]]);
    expect(t[0].start).toBeCloseTo(0.1); expect(t[3].end).toBeCloseTo(1.5);
    expect(parseEdgeMetadata(['not json'], text)).toBeNull();
  });
  it('tolerates words the engine normalised differently', () => {
    const t = alignWords([{ start: 0, end: 1, word: 'In' }, { start: 1, end: 2, word: 'two thousand' }, { start: 2, end: 3, word: 'we' }], 'In 2000 we went.');
    expect(t[0].charIndex).toBe(0); expect(t[2].charIndex).toBe(8);
  });
  it('converts ElevenLabs character alignment to words', () => {
    const t = charAlignmentToWords({ characters: ['H', 'i', ' ', 'y', 'o', 'u'], character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] });
    expect(t).toEqual([{ start: 0, end: 0.2, charIndex: 0, charLength: 2 }, { start: 0.3, end: 0.6, charIndex: 3, charLength: 3 }]);
  });
});

describe('alignWords edge cases', () => {
  it('does not match an engine word inside another word', () => {
    // the engine dropped the boundary for 'cat': 'at' must not land inside 'cat'
    const t = alignWords([{ start: 0, end: 1, word: 'the' }, { start: 1, end: 2, word: 'at' }], 'the cat at home');
    expect(t.map((x) => x.charIndex)).toEqual([0, 8]);
  });
  it('keeps contractions and curly apostrophes aligned', () => {
    const t = alignWords([{ start: 0, end: 1, word: 'I' }, { start: 1, end: 2, word: "don't" }, { start: 2, end: 3, word: 'know' }], 'I don’t know.');
    expect(t.map((x) => [x.charIndex, x.charLength])).toEqual([[0, 1], [2, 5], [8, 4]]);
  });
  it('ignores metadata entries without text', () => {
    const chunk = JSON.stringify({ Metadata: [{ Type: 'WordBoundary', Data: { Offset: 0, Duration: 1 } }] });
    expect(parseEdgeMetadata([chunk], 'Hi')).toBeNull();
  });
});

describe('kokoro:prepare drop items (an explanation prepared ahead was dropped)', () => {
  function fakeEngine() {
    const calls: string[] = [];
    const eng = {
      prepare: async (items: { text: string }[], opts: { replace?: boolean; wait?: boolean } = {}) => { calls.push(`prepare ${items.map((i) => i.text).join('|')}${opts.replace ? ' replace' : ''}${opts.wait ? ' wait' : ''}`); },
      releaseWaiters: () => { calls.push('release'); },
      dropTexts: (texts: string[], opts: { voice?: string; speed?: number }) => { calls.push(`drop ${texts.join('|')} ${opts.voice} ${opts.speed}`); },
    };
    return { calls, eng };
  }
  it('routes the texts to dropTexts with the voice and speed 1, and queues nothing', () => {
    const { calls, eng } = fakeEngine();
    const r = handlePrepare(eng, [{ text: '', voice: 'bf_emma', drop: ['Sanguine means hopeful.', 7 as unknown as string, 'He stays cheerful.'] }]);
    expect(r).toBeUndefined();
    expect(calls).toEqual(['drop Sanguine means hopeful.|He stays cheerful. bf_emma 1']);
  });
  it('a drop item next to other items: the drop first, then the jobs', async () => {
    const { calls, eng } = fakeEngine();
    await handlePrepare(eng, [{ text: '', voice: 'bf_emma', speed: 1, drop: ['Old.'] }, { text: 'New.', voice: 'bf_emma', wait: true }]);
    expect(calls).toEqual(['drop Old. bf_emma 1', 'prepare New. wait']);
  });
});
