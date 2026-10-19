import { describe, it, expect } from 'vitest';
import { Playback } from '@core/listen/playback';
import { ListenController } from '@core/listen/controller';
import { FakeTtsEngine } from '@core/tts/fake';
import type { Dictionary, DictEntry } from '@core/dict/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { renderSentence } from '../../src/renderer/reader/render';
import { makeBook } from './helpers';

// Regression: PhraseSpan.end is exclusive. A phrase at the very end of a sentence must not pull in the
// punctuation after it, and must not crash when nothing follows it.
const entry = (word: string, level: DictEntry['level']): DictEntry => ({ word, ipa: '', zh: '放弃', tags: [], frq: 100, bnc: 100, collins: 1, oxford: false, level, levelSource: 'cefrj' });
const dict: Dictionary = {
  size: 1,
  lookup: (t) => ({ entry: entry(t.toLowerCase(), 'A1'), lemma: t.toLowerCase(), via: 'exact' }),
  lookupPhrase: (words) => (words.map((w) => w.toLowerCase()).join(' ') === 'give up' ? { entry: entry('give up', 'C1'), lemma: 'give up', via: 'exact' } : null),
  lemmaOf: (t) => t.toLowerCase(),
};

const book = makeBook([{ title: 'One', paragraphs: ['He would never give up. They would give up'] }]);
const para = book.chapters[0].paragraphs[0];

describe('phrase at the end of a sentence', () => {
  it('render: the phrase span holds exactly the phrase words, closed before the full stop', () => {
    for (const s of para.sentences) {
      const html = renderSentence(para, s, 0, { dict, names: new Set(), learner: 'B2', vocab: {}, marked: [] });
      const span = /<span class="ph[^"]*"[^>]*>(.*?)<\/span><\/span>/.exec(html);
      expect(span).not.toBeNull();
      const text = span![1].replace(/<[^>]+>/g, '');
      expect(text).toBe('give up');
      expect((html.match(/<span/g) ?? []).length).toBe((html.match(/<\/span>/g) ?? []).length);
    }
  });

  it('controller: the phrase trigger covers the phrase only and does not crash without final punctuation', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const fake = new FakeTtsEngine(1);
    const playback = new Playback(book, { engine: () => fake, voice: () => ({ voiceId: 'fake-gb', rate: 1 }), pauseMs: () => 0 });
    const c = new ListenController(playback, {
      book, dict, names: new Set(), settings: () => settings, vocab: () => ({ words: {}, marked: {} }), marked: () => [],
      engine: () => fake, explainEngine: () => fake, zhEngine: () => fake, voice: () => ({ voiceId: 'fake-gb', rate: 1 }), explainVoice: () => ({ voiceId: 'fake-gb', rate: 1 }), zhVoiceId: () => null,
      explain: () => ({ done: new Promise(() => undefined), cancel: () => undefined }), onTranscript: () => undefined, onMarkLearning: () => undefined,
    });
    for (const s of para.sentences) {
      const pos = { chapter: 0, paragraph: 0, sentence: s.index };
      const ts = c.triggersFor(pos).filter((t) => t.kind === 'phrase');
      expect(ts).toHaveLength(1);
      expect(ts[0].target).toBe('give up');
      expect(s.tokens[ts[0].end].text).toBe('up');
    }
  });
});
