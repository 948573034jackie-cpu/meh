import { describe, it, expect } from 'vitest';
import { createDictionary, looksLikeFreeCombination } from '@core/dict/dictionary';
import type { DictData } from '@shared/api';
import {
  buildPhrasesPrompt, parsePhrases, validatePhrases, mapPhraseHits, chunkChapter, phraseQuota, chapterText,
  normalizePhraseText, phraseWords, PHRASES_PER_CHAPTER, PHRASE_CHUNK_CHARS,
} from '@core/ai/hints';
import type { PhraseItem, RawPhrase } from '@core/ai/hints';
import { createSegmenter } from '@core/segment';
import type { Book, Paragraph } from '@core/model';
import { makeBook } from './helpers';

const raw = (t: string, l: DictData['w'][string]['l']): DictData['w'][string] => ({ i: '', t, g: '', f: 5000, b: 5000, c: 3, o: 0, l, s: 'cefrj' });
const DICT: DictData = {
  w: {
    take: raw('vt. 拿, 取', 'A1'), for: raw('prep. 为了', 'A1'), granted: raw('a. 同意的', 'B2'), give: raw('vt. 给', 'A1'), up: raw('adv. 向上', 'A1'),
    old: raw('a. 老的, 旧的', 'A1'), man: raw('n. 男人, 人', 'A1'), red: raw('a. 红的', 'A1'), tape: raw('n. 带子', 'A2'),
    big: raw('a. 大的', 'A1'), deal: raw('n. 交易, 数量\nvt. 处理', 'A2'), in: raw('prep. 在...里', 'A1'),
  },
  f: { took: 'take', taken: 'take', takes: 'take', taking: 'take', gave: 'give', gives: 'give' },
};
const dict = createDictionary(DICT);

const book = makeBook([{
  title: 'One',
  paragraphs: [
    'He took it for granted that she would stay. Never give up.',
    'She gave up the fight. They take everything for granted. The old man smiled.',
    'It was all red tape to him. He took for granted the kindness of strangers.',
  ],
}]);
const text = chapterText(book, 0);

describe('buildPhrasesPrompt', () => {
  it('asks for 2-5 word expressions with a CEFR level and Chinese meaning, as strict JSON, with the chunk text', () => {
    const p = buildPhrasesPrompt('He took it for granted.', { title: 'Book', chapter: 'One', level: 'B1', max: 30 });
    expect(p.system).toContain('CEFR level B1');
    expect(p.system).toMatch(/2 to 5 words/);
    expect(p.system).toMatch(/idioms, phrasal verbs, fixed expressions/);
    expect(p.system).toContain('"level":"<A2|B1|B2|C1|C2>"');
    expect(p.system).toContain('{"phrases":[{"text"');
    expect(p.system).toMatch(/literally appear/);
    expect(p.system).toMatch(/No single words/);
    expect(p.system).toMatch(/old man/);
    expect(p.system).toContain('At most 30');
    expect(p.user.startsWith('Phrases. Book: Book — One')).toBe(true);
    expect(p.user).toContain('He took it for granted.');
    expect(p.maxTokens).toBeGreaterThan(30 * 30);
    expect(p.maxTokens).toBeLessThan(2000);
    expect(buildPhrasesPrompt('x', { title: 'B', chapter: '', level: 'B2', part: [2, 3] }).user).toContain('(part 2 of 3)');
  });
});

describe('chunkChapter / phraseQuota', () => {
  it('keeps a normal chapter in one chunk, paragraphs on their own lines', () => {
    const chunks = chunkChapter(book, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].split('\n')).toHaveLength(3);
    expect(phraseQuota(chunks)).toEqual([PHRASES_PER_CHAPTER]);
  });
  it('splits a long chapter at sentence boundaries under the limit (~6k tokens per request)', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog again and again. ';
    const long = makeBook([{ title: 'L', paragraphs: Array.from({ length: 40 }, () => sentence.repeat(20).trim()) }]);
    const chunks = chunkChapter(long, 0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(PHRASE_CHUNK_CHARS);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(chapterText(long, 0).replace(/\s+/g, ' '));
    const q = phraseQuota(chunks);
    expect(q.every((n) => n >= 10)).toBe(true);
    expect(chunkChapter(long, 5)).toEqual([]);
  });
});

describe('parsePhrases', () => {
  it('reads the object, a bare array, fences and prose around it', () => {
    const item = { text: 'took it for granted', lemma: 'take for granted', level: 'B2', zh: '视为理所当然' };
    expect(parsePhrases(JSON.stringify({ phrases: [item] }))).toEqual([item]);
    expect(parsePhrases('```json\n' + JSON.stringify({ phrases: [item] }) + '\n```')).toEqual([item]);
    expect(parsePhrases('Here you go: ' + JSON.stringify([item]) + ' Enjoy!')).toEqual([item]);
    expect(parsePhrases('{"phrases":[]}')).toEqual([]);
    expect(parsePhrases('')).toEqual([]);
    expect(parsePhrases('no json')).toEqual([]);
  });
  it('salvages complete items from a truncated reply and skips items without text', () => {
    const s = '{"phrases":[{"text":"give up","lemma":"give up","level":"A2","zh":"放弃"},{"lemma":"x","level":"B1"},{"text":"red tape","lemma":"red tape","level":"C1","zh":"官僚作风"},{"text":"take ev';
    expect(parsePhrases(s).map((p) => p.text)).toEqual(['give up', 'red tape']);
  });
});

describe('validatePhrases', () => {
  const r = (text: string, level = 'B2', lemma = '', zh = '意思'): RawPhrase => ({ text, lemma, level, zh });
  const isFree = (ws: string[], zh: string) => looksLikeFreeCombination(dict, ws, zh);

  it('keeps phrases found in the chapter (case, quotes, spaces folded) with the model level', () => {
    const out = validatePhrases([r('Took  it for granted', 'b2', 'Take for granted', '视为理所当然'), r('give up', 'A2', 'give up', '放弃')], text);
    expect(out).toEqual([
      { text: 'Took  it for granted', lemma: 'take for granted', level: 'B2', zh: '视为理所当然' },
      { text: 'give up', lemma: 'give up', level: 'A2', zh: '放弃' },
    ]);
  });
  it('drops phrases not in the text, bad levels, single words, too long texts, partial words and duplicates', () => {
    const out = validatePhrases([
      r('kick the bucket'),          // not in the chapter
      r('give up', 'B3'),            // not a CEFR code
      r('red tape', 'advanced'),     // not a CEFR code
      r('granted'),                  // a single word
      r('took it for granted that she would'), // too long
      r('ave up'),                   // inside "gave up", not whole words
      r('red tape', 'C1'),
      r('Red Tape', 'C1'),           // duplicate text
    ], text);
    expect(out.map((p) => [p.text, p.level])).toEqual([['red tape', 'C1']]);
  });
  it('matches curly quotes and dashes in the book against straight ones from the model', () => {
    expect(validatePhrases([r("arm's length")], 'He kept her at arm’s length.')).toHaveLength(1);
    expect(validatePhrases([r('well-to-do family')], 'A well‑to‑do family.')).toHaveLength(1);
    expect(normalizePhraseText('  It’s  “Fine” — ok ')).toBe('it\'s "fine" - ok');
    expect(phraseWords('Took it, for granted!')).toEqual(['took', 'it', 'for', 'granted']);
  });
  it('drops free combinations whose meaning is the sum of the words, keeps idioms', () => {
    const out = validatePhrases([r('old man', 'B1', 'old man', '老人'), r('red tape', 'C1', 'red tape', '官僚作风')], text, { isFree });
    expect(out.map((p) => p.lemma)).toEqual(['red tape']);
    expect(looksLikeFreeCombination(dict, ['big', 'deal'], '大事')).toBe(false);   // "deal" gloss shares nothing with 事
    expect(looksLikeFreeCombination(dict, ['give', 'up'], '放弃')).toBe(false);     // not adjective + noun
  });
  it('caps the number of phrases', () => {
    expect(validatePhrases([r('give up'), r('red tape'), r('old man')], text, { max: 2 })).toHaveLength(2);
  });
});

describe('mapPhraseHits', () => {
  const items: PhraseItem[] = [
    { text: 'took it for granted', lemma: 'take for granted', level: 'B2', zh: '视为理所当然' },
    { text: 'give up', lemma: 'give up', level: 'A2', zh: '放弃' },
    { text: 'red tape', lemma: 'red tape', level: 'C1', zh: '官僚作风' },
  ];
  const lemmaOf = (w: string) => dict.lemmaOf(w);
  const hits = mapPhraseHits(book, 0, items, lemmaOf);
  const covered = (key: string) => {
    const [, p, s] = key.split('.').map(Number);
    const para = book.chapters[0].paragraphs[p];
    return hits[key].map((h) => para.text.slice(para.sentences[s].tokens[h.start].start, para.sentences[s].tokens[h.end].end));
  };

  it('maps the exact text to token spans with an inclusive end', () => {
    expect(hits['0.0.0']).toEqual([{ sentenceKey: '0.0.0', start: 1, end: 4, text: 'took it for granted', lemma: 'take for granted', level: 'B2', zh: '视为理所当然' }]);
    expect(covered('0.0.1')).toEqual(['give up']);
    expect(covered('0.2.0')).toEqual(['red tape']);
  });
  it('finds inflected first words and the lemma with an object pronoun or another gap-free form', () => {
    expect(covered('0.1.0')).toEqual(['gave up']);               // inflected first word, via the lemma
    expect(covered('0.2.1')).toEqual(['took for granted']);      // lemma, inflected first word
    expect(covered('0.1.1')).toEqual(['take everything for granted']); // one object pronoun after the verb
    const noun = makeBook([{ title: 'x', paragraphs: ['They take the money for granted.'] }]);
    expect(mapPhraseHits(noun, 0, items, lemmaOf)['0.0.0']).toBeUndefined();   // a longer gap is not followed
    expect(hits['0.1.2']).toBeUndefined();                       // nothing in "The old man smiled."
  });
  it('without lemmaOf matches only the exact words', () => {
    const plain = mapPhraseHits(book, 0, items);
    expect(plain['0.1.0']).toBeUndefined();
    expect(plain['0.0.0']).toHaveLength(1);
  });
  it('prefers the longer phrase and never overlaps', () => {
    const b = makeBook([{ title: 'x', paragraphs: ['Do not give up on me.'] }]);
    const m = mapPhraseHits(b, 0, [
      { text: 'give up', lemma: 'give up', level: 'A2', zh: '放弃' },
      { text: 'give up on', lemma: 'give up on', level: 'B2', zh: '对…失去信心' },
    ], lemmaOf);
    expect(m['0.0.0'].map((h) => h.lemma)).toEqual(['give up on']);
  });
  it('works on real segmenter output (no whitespace tokens) and does not cross punctuation', () => {
    const seg = createSegmenter();
    const mk = (t: string): Paragraph => ({ index: 0, kind: 'p', text: t, sentences: seg.segmentParagraph(t) });
    const real: Pick<Book, 'chapters'> = { chapters: [{ index: 0, title: '', paragraphs: [mk('She took it for granted, and gave up. Give, up!')] }] };
    const m = mapPhraseHits(real, 0, items, lemmaOf);
    const p = real.chapters[0].paragraphs[0];
    expect(m['0.0.0'].map((h) => h.text)).toEqual(['took it for granted', 'gave up']);
    for (const h of m['0.0.0']) expect(p.sentences[0].tokens[h.end].kind).toBe('word');
    expect(m['0.0.1']).toBeUndefined();
  });
});
