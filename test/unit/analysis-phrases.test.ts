import { describe, it, expect } from 'vitest';
import { createDictionary } from '@core/dict/dictionary';
import type { DictData, DictRaw } from '@shared/api';
import { annotateSentence, phraseLevel } from '@core/vocab/analysis';
import type { PhraseHit } from '@core/ai/hints';
import { makeBook } from './helpers';

const raw = (l: string, s = 'cefrj', t = 'n. 词'): DictRaw => ({ i: '', t, g: '', f: 5000, b: 5000, c: 3, o: 0, l, s });
const dict = createDictionary({
  w: {
    he: raw('A1'), paid: raw('A1'), lip: raw('A2'), service: raw('B1'), to: raw('A1'), it: raw('A1'), in: raw('A1'), spite: raw('B2'), of: raw('A1'),
    rain: raw('A1'), the: raw('A1'), pay: raw('A1'), was: raw('A1'), red: raw('A1', 'cefrj', 'a. 红的'), tape: raw('A2'), all: raw('A1'), heed: raw('C1'), take: raw('A1'),
    'lip service': raw('C1', 'est', 'n. 口惠'),
    'in spite of': raw('C1', 'est', '不管'),
    'red tape': raw('C1', 'est', 'phr. 官样文章'),
    'take heed': raw('C2', 'oct', '注意'),
    'look forward to': raw('B1', 'est', '期望'), look: raw('A1'), forward: raw('A2'),
  },
  f: { paid: 'pay' },
} as DictData);

const book = makeBook([{ title: 'x', paragraphs: ['He paid lip service to it. In spite of the rain. It was all red tape. Take heed.'] }]);
const para = book.chapters[0].paragraphs[0];
const ann = (si: number, learner: 'A2' | 'B1' | 'B2' | 'C1', hits: PhraseHit[] = []) => annotateSentence(para, para.sentences[si], dict, new Set(), learner, hits);
const hit = (si: number, start: number, end: number, lemma: string, level: PhraseHit['level']): PhraseHit => {
  const toks = para.sentences[si].tokens;
  return { sentenceKey: `0.0.${si}`, start, end, text: para.text.slice(toks[start].start, toks[end].end), lemma, level, zh: '意思' };
};

describe('phraseLevel', () => {
  it('derives an estimated phrase level from its hardest word, at least B1, never above the estimate', () => {
    expect(phraseLevel(dict.lookupPhrase(['lip', 'service'])!, dict)).toBe('B1');
    expect(phraseLevel(dict.lookupPhrase(['in', 'spite', 'of'])!, dict)).toBe('B2');
    expect(phraseLevel(dict.lookupPhrase(['red', 'tape'])!, dict)).toBe('B1');          // idiom-marked: the B1 floor
    expect(phraseLevel(dict.lookupPhrase(['look', 'forward', 'to'])!, dict)).toBe('B1');
  });
  it('keeps a level that comes from a CEFR list', () => {
    expect(phraseLevel(dict.lookupPhrase(['take', 'heed'])!, dict)).toBe('C2');
  });
});

describe('annotateSentence with the chapter job\'s phrases', () => {
  it('an estimated dictionary phrase is not above-level from its estimate alone', () => {
    const a = ann(0, 'B1');
    expect(a.phrases.map((p) => [p.result.lemma, p.level, p.confirmed, p.above])).toEqual([['lip service', 'B1', false, false]]);
    expect(ann(1, 'B1').phrases.map((p) => [p.result.lemma, p.above])).toEqual([['in spite of', true]]);   // B2 from 'spite'
    expect(ann(3, 'C1').phrases.map((p) => [p.result.lemma, p.above])).toEqual([['take heed', true]]);   // Octanove C2
  });
  it('the chapter job confirms a dictionary phrase with its own level', () => {
    const a = ann(0, 'B1', [hit(0, 2, 3, 'lip service', 'C1')]);
    expect(a.phrases.map((p) => [p.result.lemma, p.level, p.confirmed, p.above])).toEqual([['lip service', 'C1', true, true]]);
    expect(a.aiPhrases).toEqual([]);   // the same span is reported once, as the dictionary phrase
    // a confirmation by lemma over overlapping tokens counts too ("paid lip service" -> lemma "lip service")
    const b = ann(0, 'B1', [hit(0, 1, 3, 'lip service', 'B2')]);
    expect(b.phrases[0]).toMatchObject({ level: 'B2', confirmed: true, above: true });
    expect(b.aiPhrases.map((h) => h.text)).toEqual(['paid lip service']);
  });
  it('lists AI phrases with their above flag and leaves the words of an above-level one to the phrase', () => {
    const toks = para.sentences[0].tokens;
    const idx = (w: string) => toks.findIndex((t) => t.text === w);
    const h = hit(0, idx('paid'), idx('to'), 'pay lip service to', 'C1');
    const a = ann(0, 'A2', [h]);
    expect(a.aiPhrases).toEqual([{ ...h, above: true }]);
    for (let i = h.start; i <= h.end; i++) expect(a.hardTokens).not.toContain(i);
    // at C1 the phrase is not above
    const c = ann(0, 'C1', [h]);
    expect(c.aiPhrases[0].above).toBe(false);
  });
});
