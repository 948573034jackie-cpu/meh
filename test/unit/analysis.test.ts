import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DictData, DictRaw } from '@shared/api';
import type { Book, Chapter, Paragraph, ParagraphKind, Sentence, Token } from '@core/model';
import { createDictionary } from '@core/dict/dictionary';
import { detectNames, nameKey } from '@core/dict/names';
import { analyzeToken, isAboveLevel, findPhrases, annotateSentence, type WordInfo } from '@core/vocab/analysis';

const DATA_PATH = fileURLToPath(new URL('../../resources/dict/dict.json.gz', import.meta.url));
const data = JSON.parse(gunzipSync(readFileSync(DATA_PATH)).toString('utf8')) as DictData;
const dict = createDictionary(data);

/* --- a tiny tokenizer / book builder for fixtures (the real Segmenter lives in another module) --- */

const TOKEN_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu;

function tokenize(text: string, offset = 0): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0];
    const kind: Token['kind'] = /^\s/.test(t) ? 'space' : /^\p{N}/u.test(t) ? 'number' : /^\p{L}/u.test(t) ? 'word' : 'punct';
    out.push({ start: offset + m.index!, end: offset + m.index! + t.length, text: t, kind });
  }
  return out;
}

/** Each string is one sentence; the paragraph text joins them with single spaces. */
function para(sentences: string[], kind: ParagraphKind = 'p', index = 0): Paragraph {
  const text = sentences.join(' ');
  const out: Sentence[] = [];
  let pos = 0;
  sentences.forEach((s, i) => {
    out.push({ index: i, start: pos, end: pos + s.length, tokens: tokenize(s, pos) });
    pos += s.length + 1;
  });
  return { index, kind, text, sentences: out };
}

function book(paragraphs: Paragraph[]): Pick<Book, 'chapters'> {
  const chapter: Chapter = { index: 0, title: 'One', paragraphs: paragraphs.map((p, i) => ({ ...p, index: i })) };
  return { chapters: [chapter] };
}

const wordIdx = (tokens: Token[], text: string): number => tokens.findIndex((t) => t.text === text);

/* ------------------------------------------------------------------------------------------------ */

describe('detectNames', () => {
  const b = book([
    para(['CHAPTER I'], 'h1'),
    para(['The Meryton Assembly'], 'h2'),
    para([
      'It is a truth universally acknowledged that a single man must be in want of a wife.',
      'Mr. Darcy looked at Elizabeth, and Elizabeth looked back at him.',
      'The house at Netherfield was large.',
      'Netherfield is three miles from Longbourn.',
      '"Yes," said Jane, "He is very handsome."',
      'The truth was that the house was cold.',
      'Elizabeth laughed at Darcy’s pride.',
      'Miss Bennet smiled at Lady Catherine and Sir William.',
      'Will you come to the assembly on Monday?',
      'I will, said Will, who had the will to go.',
      'They walked to LONDON and back.',
    ]),
    para(['Chapter Two'], 'h1'),
    para(['He said: "The weather was fine." The weather was indeed fine, said He.']),
  ]);
  const names = detectNames(b, dict);

  it('finds titled, repeated and unknown proper nouns', () => {
    expect(names).toContain('darcy');        // after "Mr." and unknown to the dictionary
    expect(names).toContain('elizabeth');    // repeated mid-sentence (in the dictionary, bnc > 0)
    expect(names).toContain('netherfield');  // unknown to the dictionary, once mid-sentence
    expect(names).toContain('longbourn');
    expect(names).toContain('bennet');       // after "Miss"
    expect(names).toContain('catherine');    // after "Lady"
    expect(names).toContain('william');      // after "Sir"
    // 'Jane' occurs once mid-sentence and the dictionary knows it (BNC rank, est level): one sighting is not enough
    expect(names).not.toContain('jane');
  });

  it('accepts a dictionary-known name once it is seen twice where capitals are not conventional', () => {
    const b2 = book([para(['"Yes," said Jane, "he is handsome."', 'Then Jane left.', 'Everyone liked Jane.'])]);
    expect(detectNames(b2, dict)).toEqual(['jane']);
  });

  it('never marks sentence-initial, all-caps, quoted-initial or common words', () => {
    expect(names).not.toContain('the');
    expect(names).not.toContain('it');
    expect(names).not.toContain('he');       // only after an opening quote / colon / period
    expect(names).not.toContain('yes');
    expect(names).not.toContain('chapter');  // all-caps and heading-initial only
    expect(names).not.toContain('i');
    expect(names).not.toContain('will');     // used in lower case more often than as a name
    expect(names).not.toContain('assembly'); // in the dictionary with frequency, seen once in a heading only
    expect(names).not.toContain('london');   // ALL-CAPS only
    expect(names).not.toContain('mr');       // honorifics are never names
    expect(names).not.toContain('miss');
    expect(names).not.toContain('lady');
    expect(names).not.toContain('sir');
    expect(names).not.toContain('weather');
    expect(names).not.toContain('house');
    expect(names).not.toContain('truth');
  });

  it('returns lower-cased unique sorted names', () => {
    expect(names).toEqual([...new Set(names)].sort());
    for (const n of names) expect(n).toBe(n.toLowerCase());
  });

  it('counts a heading word only when titled or unknown-and-mid-sentence elsewhere', () => {
    // 'Meryton' appears only in a Title Case heading: headings are not evidence on their own
    expect(names).not.toContain('meryton');
    const b2 = book([para(['The Meryton Assembly'], 'h2'), para(['They drove to Meryton after breakfast.'])]);
    expect(detectNames(b2, dict)).toEqual(['meryton']);
  });

  it('tolerates a title split off at the end of the previous sentence', () => {
    const b3 = book([para(['She waited for Mr.', 'Bingley to arrive.'])]);
    expect(detectNames(b3, dict)).toContain('bingley');
  });

  it('accepts "Mr." as a single token too', () => {
    const p: Paragraph = { index: 0, kind: 'p', text: 'She met Mr. Collins.', sentences: [{ index: 0, start: 0, end: 20, tokens: [
      { start: 0, end: 3, text: 'She', kind: 'word' }, { start: 3, end: 4, text: ' ', kind: 'space' },
      { start: 4, end: 7, text: 'met', kind: 'word' }, { start: 7, end: 8, text: ' ', kind: 'space' },
      { start: 8, end: 11, text: 'Mr.', kind: 'word' }, { start: 11, end: 12, text: ' ', kind: 'space' },
      { start: 12, end: 19, text: 'Collins', kind: 'word' }, { start: 19, end: 20, text: '.', kind: 'punct' },
    ] }] };
    expect(detectNames(book([p]), dict)).toEqual(['collins']);
  });

  it('marks words ECDICT knows only as obscure terms (no frequency, no BNC rank, no tags)', () => {
    // synthesise such an entry to assert the rule independently of what the real data happens to contain
    const d = createDictionary({ w: {
      the: { i: '', t: 'art. 那', g: 'zk', f: 1, b: 1, c: 5, o: 1, l: 'A1', s: 'cefrj' },
      darcy: { i: '', t: 'n. 达西(渗透率单位)', g: '', f: 0, b: 0, c: 0, o: 0, l: 'C2', s: 'est' },
      garden: { i: '', t: 'n. 花园', g: 'zk', f: 900, b: 900, c: 4, o: 1, l: 'A1', s: 'cefrj' },
    }, f: {} });
    const b4 = book([para(['They walked past Darcy into the Garden.'])]);
    expect(detectNames(b4, d)).toEqual(['darcy']);
  });

  it('handles an empty book', () => {
    expect(detectNames({ chapters: [] }, dict)).toEqual([]);
  });

  it('nameKey', () => {
    expect(nameKey("Darcy’s")).toBe('darcy');
    expect(nameKey('Mr.')).toBe('mr');
    expect(nameKey('I')).toBeNull();
    expect(nameKey("I'm")).toBeNull();
    expect(nameKey('A')).toBeNull();
    expect(nameKey('O’Brien')).toBe("o'brien");
    expect(nameKey('42')).toBeNull();
  });
});

describe('analyzeToken / isAboveLevel', () => {
  const names = new Set(['darcy', 'elizabeth', 'grace']);
  const tok = (text: string, kind: Token['kind'] = 'word'): Token => ({ start: 0, end: text.length, text, kind });

  it('fills WordInfo from the dictionary', () => {
    const info = analyzeToken(tok('houses'), false, dict, names);
    expect(info).toMatchObject({ lemma: 'house', level: data.w.house.l, levelSource: 'cefrj', isName: false, inDict: true });
    expect(info.entry!.word).toBe('house');
  });

  it('marks names only when capitalised, and unknown capitalised words mid-sentence', () => {
    expect(analyzeToken(tok('Darcy'), false, dict, names).isName).toBe(true);
    expect(analyzeToken(tok("Darcy's"), false, dict, names).isName).toBe(true);
    expect(analyzeToken(tok('Darcy'), true, dict, names).isName).toBe(true);     // in the book's list: also at sentence start
    expect(analyzeToken(tok('DARCY'), false, dict, names).isName).toBe(true);
    expect(analyzeToken(tok('Grace'), false, dict, names).isName).toBe(true);
    expect(analyzeToken(tok('grace'), false, dict, names).isName).toBe(false);   // lower case: the common noun
    expect(analyzeToken(tok('Pemberley'), false, dict, names).isName).toBe(true);  // unknown + capitalised + mid-sentence
    expect(analyzeToken(tok('Pemberley'), true, dict, names).isName).toBe(false);  // sentence start: no evidence
    expect(analyzeToken(tok('The'), true, dict, names).isName).toBe(false);
    expect(analyzeToken(tok('House'), false, dict, names).isName).toBe(false);
  });

  it('gives non-word and unknown tokens a null level and a fallback lemma', () => {
    expect(analyzeToken(tok('1813', 'number'), false, dict, names)).toMatchObject({ lemma: '1813', level: null, levelSource: null, inDict: false, entry: null, isName: false });
    expect(analyzeToken(tok('Xyzzyq'), true, dict, names)).toMatchObject({ lemma: 'xyzzyq', level: null, inDict: false });
    expect(analyzeToken(tok('Façades'), true, dict, names).lemma).toBe('facade');
  });

  const info = (o: Partial<WordInfo>): WordInfo => ({ lemma: 'x', level: 'C1', levelSource: 'cefrj', isName: false, inDict: true, entry: null, ...o });
  const entry = (o: Partial<NonNullable<WordInfo['entry']>>) => ({ word: 'x', ipa: '', zh: 'n. 东西', tags: [], frq: 10, bnc: 10, collins: 0, oxford: false, level: 'C1' as const, levelSource: 'cefrj' as const, ...o });

  it('isAboveLevel compares strictly and ignores names and unknown levels', () => {
    expect(isAboveLevel(info({ level: 'C1' }), 'B2')).toBe(true);
    expect(isAboveLevel(info({ level: 'B2' }), 'B2')).toBe(false);
    expect(isAboveLevel(info({ level: 'A1' }), 'B2')).toBe(false);
    expect(isAboveLevel(info({ level: 'C2' }), 'C2')).toBe(false);
    expect(isAboveLevel(info({ level: 'A2' }), 'A1')).toBe(true);
    expect(isAboveLevel(info({ level: null, levelSource: null, inDict: false }), 'A1')).toBe(false);
    expect(isAboveLevel(info({ level: 'C2', isName: true }), 'A1')).toBe(false);
  });

  it('treats estimated C2 with no corpus frequency as above only when there is a gloss', () => {
    const rare = info({ level: 'C2', levelSource: 'est', entry: entry({ level: 'C2', levelSource: 'est', frq: 0, zh: 'n. 稀有词' }) });
    expect(isAboveLevel(rare, 'B2')).toBe(true);
    const junk = info({ level: 'C2', levelSource: 'est', entry: entry({ level: 'C2', levelSource: 'est', frq: 0, zh: '  ' }) });
    expect(isAboveLevel(junk, 'B2')).toBe(false);
    const rareWithFreq = info({ level: 'C2', levelSource: 'est', entry: entry({ level: 'C2', levelSource: 'est', frq: 30000, zh: '' }) });
    expect(isAboveLevel(rareWithFreq, 'B2')).toBe(true);
    const listedC2 = info({ level: 'C2', levelSource: 'oct', entry: entry({ level: 'C2', levelSource: 'oct', frq: 0, zh: '' }) });
    expect(isAboveLevel(listedC2, 'B2')).toBe(true);
  });

  it('applies the rule to real entries', () => {
    const acr = analyzeToken(tok('acrimonious'), false, dict, names);
    expect(acr.level).toBe(data.w.acrimonious.l);
    expect(isAboveLevel(acr, 'B2')).toBe(acr.level === 'C1' || acr.level === 'C2');
    const house = analyzeToken(tok('house'), false, dict, names);
    expect(isAboveLevel(house, 'A1')).toBe(false);
    expect(isAboveLevel(analyzeToken(tok('ubiquitous'), false, dict, names), 'B1')).toBe(true);
  });
});

describe('findPhrases', () => {
  it('finds the longest non-overlapping dictionary phrases over space-separated words', () => {
    const tokens = tokenize('We look forward to seeing you, in spite of the rain, according to plan.');
    const found = findPhrases(tokens, dict);
    const lemmas = found.map((p) => p.result.lemma);
    expect(lemmas).toContain('look forward to');
    expect(lemmas).toContain('in spite of');
    expect(lemmas).toContain('according to');
    const lf = found.find((p) => p.result.lemma === 'look forward to')!;
    expect(lf.words).toBe(3);
    expect(tokens.slice(lf.start, lf.end).map((t) => t.text).join('')).toBe('look forward to');
    // non-overlapping and in order
    for (let i = 1; i < found.length; i++) expect(found[i].start).toBeGreaterThanOrEqual(found[i - 1].end);
  });

  it('lemmatises the words of a phrase', () => {
    const tokens = tokenize('She was looking forward to it.');
    expect(findPhrases(tokens, dict).map((p) => p.result.lemma)).toEqual(['look forward to']);
    expect(findPhrases(tokens, dict)[0].result.via).toBe('form');
  });

  it('does not cross punctuation and copes with short input', () => {
    expect(findPhrases(tokenize('look, forward to'), dict).map((p) => p.result.lemma)).not.toContain('look forward to');
    expect(findPhrases(tokenize('look'), dict)).toEqual([]);
    expect(findPhrases([], dict)).toEqual([]);
    expect(findPhrases(tokenize('The old house stood alone.'), dict)).toEqual([]);
  });

  it('prefers the longest match at a position', () => {
    // 'in spite of' (3) beats any 2-word phrase starting at 'in'
    const tokens = tokenize('in spite of');
    const found = findPhrases(tokens, dict);
    expect(found).toHaveLength(1);
    expect(found[0].words).toBe(3);
  });
});

describe('annotateSentence', () => {
  const names = new Set(detectNames(book([para(['Elizabeth looked at Mr. Darcy.', 'Darcy and Elizabeth talked.', 'He liked Elizabeth.'])]), dict));
  const raw = (l: string, s = 'cefrj'): DictRaw => ({ i: '', t: 'n. 词', g: '', f: 100, b: 100, c: 0, o: 0, l, s });

  it('flags words above the learner level, not names or easy words', () => {
    const p = para(['Their acrimonious debate left the house in a melancholy silence, said Darcy.']);
    const s = p.sentences[0];
    const a = annotateSentence(p, s, dict, names, 'B2');
    expect(a.infos).toHaveLength(s.tokens.length);
    s.tokens.forEach((t, i) => expect(a.infos[i] === null).toBe(t.kind !== 'word'));
    const hard = a.hardTokens.map((i) => s.tokens[i].text);
    expect(hard).toContain('acrimonious');            // C1 in the data
    expect(hard).not.toContain('house');
    expect(hard).not.toContain('Darcy');
    expect(hard).not.toContain('Their');
    // 'melancholy' is C2 (Octanove) in this data set, so it IS above B2; it would not be for a C2 learner
    expect(data.w.melancholy.l).toBe('C2');
    expect(hard).toContain('melancholy');
    expect(annotateSentence(p, s, dict, names, 'C2').hardTokens).toEqual([]);
    const a1 = annotateSentence(p, s, dict, names, 'A1');
    expect(a1.hardTokens.map((i) => s.tokens[i].text)).toContain('debate');
    expect(a1.hardTokens.map((i) => s.tokens[i].text)).not.toContain('Darcy');
  });

  it('marks the first word token as sentence-first and names from the book list', () => {
    const p = para(['Darcy walked to Pemberley with Elizabeth.']);
    const s = p.sentences[0];
    const a = annotateSentence(p, s, dict, names, 'B2');
    expect(a.infos[wordIdx(s.tokens, 'Darcy')]!.isName).toBe(true);        // in the list, even at sentence start
    expect(a.infos[wordIdx(s.tokens, 'Pemberley')]!.isName).toBe(true);    // unknown mid-sentence
    expect(a.infos[wordIdx(s.tokens, 'Elizabeth')]!.isName).toBe(true);
    expect(a.infos[wordIdx(s.tokens, 'walked')]!.lemma).toBe('walk');
    expect(a.hardTokens).toEqual([]);
  });

  it('returns phrase spans with their own above-level flag and leaves their words to the phrase', () => {
    const p = para(['In spite of the rain we look forward to the trip.']);
    const s = p.sentences[0];
    const a = annotateSentence(p, s, dict, names, 'B2');
    const byLemma = Object.fromEntries(a.phrases.map((x) => [x.result.lemma, x]));
    expect(byLemma['in spite of']).toBeDefined();
    expect(byLemma['look forward to']).toBeDefined();
    expect(byLemma['in spite of'].above).toBe(data.w['in spite of'].l === 'C1' || data.w['in spite of'].l === 'C2');
    expect(byLemma['look forward to'].above).toBe(false);   // B1 in the data
    // words inside an above-level phrase are left to the phrase; words inside an easy phrase keep their own flag
    for (const ph of a.phrases) {
      for (let i = ph.start; i < ph.end; i++) {
        if (ph.above) expect(a.hardTokens).not.toContain(i);
        else if (a.infos[i] && isAboveLevel(a.infos[i]!, 'B2')) expect(a.hardTokens).toContain(i);
      }
    }
  });

  it('keeps word flags inside easy phrases and drops them inside hard phrases (synthetic levels)', () => {
    const d = createDictionary({ w: {
      we: raw('A1'), take: raw('A1'), heed: raw('C1'), 'take heed': raw('C2', 'oct'),
      in: raw('A1'), lieu: raw('C2', 'oct'), of: raw('A1'), 'in lieu of': raw('B1', 'est'), advice: raw('A2'),
    }, f: {} });
    const p = para(['We take heed in lieu of advice.']);
    const s = p.sentences[0];
    const a = annotateSentence(p, s, d, new Set(), 'B2');
    expect(a.phrases.map((x) => [x.result.lemma, x.above])).toEqual([['take heed', true], ['in lieu of', false]]);
    const hard = a.hardTokens.map((i) => s.tokens[i].text);
    expect(hard).toEqual(['lieu']);   // 'heed' (C1) is explained as part of 'take heed'; 'lieu' (C2) stays its own stop
  });

  it('handles a sentence with no word tokens', () => {
    const p = para(['...']);
    const a = annotateSentence(p, p.sentences[0], dict, names, 'B2');
    expect(a.infos.length).toBe(p.sentences[0].tokens.length);
    expect(a.infos.every((x) => x === null)).toBe(true);
    expect(a.phrases).toEqual([]);
    expect(a.hardTokens).toEqual([]);
  });
});
