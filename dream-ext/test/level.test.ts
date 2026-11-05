import { describe, it, expect } from 'vitest';
import { realDictionary } from './helpers';
import { SEED, seedWords, itemKey, phraseSig, estimateLevel, unknownChance, buildDoc, levelSummary, mergeDocs, sameDoc, isDoc, EMPTY_META, type LevelMeta, type VocabularyDoc } from '../src/level-db';
import { collectItems, parseItems, pickForScreen, scoreTest, chipsHeight, MIN_PER_GROUP, MAX_PER_GROUP, type TestGroups, type TestItem } from '../src/level-check';
import { scoreSentences, selectStops, selectStopsByKind, stopKindOf, groupOf, mayStopGroup, mayStop, counterText, itemsToHits, MAX_STOP_RATIO, DEFAULT_CAPS } from '../src/level-stops';
import { checkExplanation, cleanRuleSentence, RuleGuard, buildRulePrompt, type RuleRequest } from '../src/level-rule';
import { textBook, orderOf, paragraphsOf, pagesToText } from '../src/reader-text';
import { Analysis, analysisId, buildAnalysisPrompt, parseAnalysis, STOPS_PER_PART, LOOK_AHEAD, type AnalysisStop } from '../src/level-analysis';
import { sentenceKey, sentenceText } from '@core/model';

const dict = realDictionary();
const TEXT = `Hello everyone and welcome back to the channel.
Today my friend was very meticulous about her work.
She walked to the shop and bought some bread.
It was an ephemeral moment of joy.
He went home and had a cup of tea.
My uncle is a gregarious man who loves big parties.
The children played in the garden after school.
They had to squander their wages on provisions.
We will talk about it again very soon.
He had fallen on his feet in the big city.`;
const book = textBook('t', 'Lesson', TEXT.split('\n').join('\n\n'), 'text');
const order = orderOf(book);
const flat = (g: TestGroups): TestItem[] => [...g.b2, ...g.c1, ...g.c2];
const chance = unknownChance(SEED.tests);
const score = (status: (l: string) => 'known' | 'learning' | 'ignored' | undefined = () => undefined, extra: Partial<Parameters<typeof scoreSentences>[0]> = {}) =>
  scoreSentences({ book, order, dict, names: new Set(), status, phraseDone: () => false, phrases: {}, hard: new Set(), chance, zipf: () => null, ...extra });

describe('the database', () => {
  it('the starting data is all there, as vocabulary keys', () => {
    const { words, log } = seedWords(dict);
    expect(SEED.known).toHaveLength(17);
    expect(SEED.learning.b2).toHaveLength(18);
    expect(SEED.learning.c1).toHaveLength(31);
    expect(SEED.learning.c2).toHaveLength(28);
    expect(words[dict.lemmaOf('threaten')]).toBe('known');
    expect(words[dict.lemmaOf('squander')]).toBe('learning');
    expect(words['keep nix']).toBe('learning');
    expect(words.bully).toBe('learning');
    expect(log.bully.word).toBe('bully (great)');
    expect(log['keep nix'].group).toBe('c2');
    expect(SEED.tests.map((t) => t.scores.b2)).toEqual([45, 42]);
  });
  it('a phrase has the same signature in another form', () => {
    expect(phraseSig(dict, 'fallen on his feet')).toBe(phraseSig(dict, "fall on one's feet"));
    expect(itemKey(dict, 'bully (great)')).toBe('bully');
  });
  it('the level from the percentages (their own tests: lower B2)', () => {
    expect(estimateLevel({ b2: 45, c1: 5, c2: 13 }).label).toBe('lower B2');
    expect(estimateLevel({ b2: 42, c1: 0, c2: 0 }).cefr).toBe('B2');
    expect(estimateLevel({ b2: 90, c1: 60, c2: 10 }).cefr).toBe('C1');
    expect(estimateLevel({ b2: 10, c1: 0, c2: 0 }).cefr).toBe('B1');
    expect(estimateLevel({ b2: null, c1: null, c2: null }).cefr).toBe('B1');
  });
  it('the newest test decides how likely a level is unknown', () => {
    expect(chance.B2).toBeCloseTo(0.58);
    expect(chance.C1).toBe(1);
    expect(unknownChance([]).B2).toBe(0.5);
  });
  it('the document and the summary for Claude', () => {
    const meta: LevelMeta = { ...EMPTY_META, tests: SEED.tests, currentLevel: SEED.currentLevel, log: { wage: { word: 'wages', date: '2026-11-04', sentence: 'Her wages were low.', group: 'b2' } } };
    const doc = buildDoc(meta, { wage: 'learning', duty: 'known', 'sentence: hello': 'learning', foo: 'ignored' }, {}, new Date('2026-11-05T10:00:00Z'));
    expect(doc.stillLearning).toEqual([{ item: 'wages', date: '2026-11-04', sentence: 'Her wages were low.', group: 'b2' }]);
    expect(doc.known).toEqual([{ item: 'duty', date: '2026-11-05' }]);
    const t = levelSummary(doc);
    expect(t).toContain('about lower B2');
    expect(t).toContain('wages');
    expect(t).toContain('duty');
    expect(levelSummary(doc, '2026-11-06')).not.toContain('New since');
  });
});

describe('the tap test', () => {
  it('only words of this text, B2 and up, nothing from the database', () => {
    const g = collectItems({ book, dict, names: new Set(), inDatabase: (k) => k === dict.lemmaOf('meticulous') });
    const items = flat(g);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(TEXT.toLowerCase()).toContain(it.text.split(' ')[0]);
      expect(it.key).not.toBe(dict.lemmaOf('meticulous'));
      if (it.kind === 'word') expect(['B2', 'C1', 'C2']).toContain(dict.lookup(it.text)?.entry.level);
    }
    expect(items.find((i) => i.text === 'gregarious')).toBeTruthy();
    expect(items.find((i) => i.text === 'bread')).toBeFalsy();
  });
  it('contractions, very common words and names inside a sentence stay out, whatever level the dictionary gives them', () => {
    const b2 = textBook('n', 'N', "We don't know what Mel found there. The found money was meticulous work.", 'text');
    const items = flat(collectItems({ book: b2, dict, names: new Set(), inDatabase: () => false, zipf: (w) => (w === 'found' ? 5.3 : null) })).map((i) => i.text);
    expect(items).not.toContain("don't");
    expect(items).not.toContain('found');
    expect(items).not.toContain('mel');
    expect(items).toContain('meticulous');
    const list = scoreSentences({ book: b2, order: orderOf(b2), dict, names: new Set(), status: () => undefined, phraseDone: () => false, phrases: {}, hard: new Set(), chance, zipf: (w) => (w === 'found' ? 5.3 : null) });
    expect(list[0].items).not.toContain('found');
  });
  it('the AI cannot bring in anything that is not in the text', () => {
    const lines = TEXT.split('\n');
    const raw = JSON.stringify({ items: [{ t: 'fallen on his feet', level: 'C1', kind: 'idiom' }, { t: 'kick the bucket', level: 'C1', kind: 'idiom' }, { t: 'squander', level: 'C1', kind: 'phrase' }, { t: 'sentence after sentence', level: 'C2', kind: 'idiom' }] });
    expect(parseItems(raw, lines).map((x) => x.text)).toEqual(['fallen on his feet']);
    expect(parseItems('no json', lines)).toEqual([]);
  });
  it('idioms and slang go to the last group, a known phrase in another form stays out', () => {
    const ai = [{ text: 'fallen on his feet', level: 'C1' as const, kind: 'idiom' as const }];
    expect(collectItems({ book, dict, names: new Set(), inDatabase: () => false, ai }).c2.map((i) => i.text)).toContain('fallen on his feet');
    const sig = phraseSig(dict, "fall on one's feet");
    expect(flat(collectItems({ book, dict, names: new Set(), inDatabase: (_k, s) => s === sig, ai })).map((i) => i.text)).not.toContain('fallen on his feet');
  });
  const many = (g: 'b2' | 'c1' | 'c2', n: number): TestItem[] => Array.from({ length: n }, (_, i) => ({ text: `word${g}${i}`, key: `${g}${i}`, group: g, kind: 'word', sentence: '' }));
  const all: TestGroups = { b2: many('b2', 40), c1: many('c1', 40), c2: many('c2', 40) };
  it('12 to 20 per group, on one phone screen', () => {
    for (const screen of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
      const p = pickForScreen(all, screen);
      for (const id of ['b2', 'c1', 'c2'] as const) { expect(p[id].length).toBeGreaterThanOrEqual(MIN_PER_GROUP); expect(p[id].length).toBeLessThanOrEqual(MAX_PER_GROUP); }
      const h = 112 + (['b2', 'c1', 'c2'] as const).reduce((a, id) => a + 24 + chipsHeight(p[id], Math.min(screen.width, 520) - 28), 0);
      expect(h).toBeLessThanOrEqual(screen.height);
    }
    expect(pickForScreen(all, { width: 1280, height: 900 }).b2.length).toBe(MAX_PER_GROUP);
    expect(pickForScreen({ b2: many('b2', 3), c1: [], c2: [] }, { width: 390, height: 844 }).b2).toHaveLength(3);
  });
  it('the percentages', () => {
    const shown: TestGroups = { b2: many('b2', 4), c1: many('c1', 2), c2: [] };
    expect(scoreTest(shown, new Set(['b20', 'c10', 'c11']))).toEqual({ b2: 25, c1: 100, c2: null });
  });
});

describe('the stops', () => {
  it('at most half of the sentences, the hardest, and easy sentences never', () => {
    const list = score();
    const set = selectStops(list);
    expect(set.size).toBeGreaterThan(0);
    expect(set.size).toBeLessThanOrEqual(order.length * MAX_STOP_RATIO);
    const easy = order.findIndex((p) => sentenceText(book.chapters[0].paragraphs[p.paragraph], book.chapters[0].paragraphs[p.paragraph].sentences[p.sentence]).startsWith('The children'));
    expect(set.has(sentenceKey(order[easy]))).toBe(false);
    const min = Math.min(...[...set].map((k) => list.find((s) => s.key === k)!.score));
    for (const s of list) if (!set.has(s.key)) expect(s.score).toBeLessThanOrEqual(min);
  });
  it('never more than half, even when every sentence is hard', () => {
    const hard = new Set(order.map((p) => sentenceKey(p)));
    expect(selectStops(score(() => undefined, { hard })).size).toBe(Math.floor(order.length / 2));
  });
  it('a known word never causes a stop', () => {
    const lem = dict.lemmaOf('meticulous');
    const key = sentenceKey(order[1]);
    expect(score().find((s) => s.key === key)!.lemmas).toContain(lem);
    const after = score((l) => (l === lem ? 'known' : undefined)).find((s) => s.key === key)!;
    expect(after.lemmas).not.toContain(lem);
    expect(after.items).not.toContain('meticulous');
    // nothing left in it: no stop
    const known = (l: string) => (l === lem ? 'known' as const : undefined);
    expect(selectStops(score(known)).has(key)).toBe(false);
  });
  it('a still-learning word counts more, and a rare word more than a common one', () => {
    const k = sentenceKey(order[3]);
    const base = score().find((s) => s.key === k)!.score;
    expect(score((l) => (l === dict.lemmaOf('ephemeral') ? 'learning' : undefined)).find((s) => s.key === k)!.score).toBeGreaterThan(base);
    const rare = score(() => undefined, { zipf: () => 1 }).find((s) => s.key === k)!.score;
    const common = score(() => undefined, { zipf: () => 5 }).find((s) => s.key === k)!.score;
    expect(rare).toBeGreaterThan(common);
  });
  it('an idiom from the AI counts; once known, in any form, it does not', () => {
    const hits = itemsToHits(book, order, [{ text: 'fallen on his feet', level: 'C1' }], dict);
    const key = sentenceKey(order[9]);
    expect(hits[key]).toHaveLength(1);
    expect(score(() => undefined, { phrases: hits }).find((s) => s.key === key)!.items).toContain('fallen on his feet');
    const sig = phraseSig(dict, "fall on one's feet");
    expect(score(() => undefined, { phrases: hits, phraseDone: (s) => s === sig }).find((s) => s.key === key)!.items).not.toContain('fallen on his feet');
  });
  it('every hard item says what it is: a word or a phrase; the stop is for a word first, else a phrase, else the sentence', () => {
    const hits = itemsToHits(book, order, [{ text: 'fallen on his feet', level: 'C1' }], dict);
    const list = score(() => undefined, { phrases: hits });
    const word = list.find((s) => s.key === sentenceKey(order[1]))!;
    expect(word.kinds[word.items.indexOf('meticulous')]).toBe('word');
    expect(word.kind).toBe('word');
    const idiom = list.find((s) => s.key === sentenceKey(order[9]))!;
    expect(idiom.kinds[idiom.items.indexOf('fallen on his feet')]).toBe('phrase');
    for (const s of list) { expect(s.kinds).toHaveLength(s.items.length); expect(s.kind).toBe(stopKindOf(s.kinds)); }
    expect(stopKindOf(['phrase', 'word'])).toBe('word');
    expect(stopKindOf(['phrase'])).toBe('phrase');
    expect(stopKindOf([])).toBe('sentence');
    // a sentence only the AI found hard: a stop for the sentence
    const hard = new Set(order.map((p) => sentenceKey(p)));
    expect(score(() => undefined, { hard }).filter((s) => !s.items.length).every((s) => s.kind === 'sentence' && s.hard)).toBe(true);
  });
  it('each kind of stop has its own share of the sentences; 0 = never', () => {
    const hard = new Set(order.map((p) => sentenceKey(p)));
    const list = score(() => undefined, { hard });
    const n = order.length;
    const count = (set: Set<string>, kind: string) => list.filter((s) => set.has(s.key) && s.kind === kind).length;
    const def = selectStopsByKind(list);
    expect(count(def, 'word') + count(def, 'phrase')).toBeLessThanOrEqual(Math.floor(n * DEFAULT_CAPS.item));
    expect(count(def, 'sentence')).toBeLessThanOrEqual(Math.floor(n * DEFAULT_CAPS.sentence));
    expect(def.size).toBeLessThanOrEqual(n / 2);
    // sentences off: only words and phrases stop; both off: nothing stops
    const noSentences = selectStopsByKind(list, { item: 1, sentence: 0 });
    expect(count(noSentences, 'sentence')).toBe(0);
    expect(noSentences.size).toBe(list.filter((s) => groupOf(s.kind) === 'item').length);
    const onlySentences = selectStopsByKind(list, { item: 0, sentence: 1 });
    expect(count(onlySentences, 'word') + count(onlySentences, 'phrase')).toBe(0);
    expect(selectStopsByKind(list, { item: 0, sentence: 0 }).size).toBe(0);
    // in a group, the hardest first
    const one = selectStopsByKind(list, { item: 1 / n, sentence: 0 });
    expect(one.size).toBe(1);
    const best = list.filter((s) => groupOf(s.kind) === 'item').sort((a, b) => b.score - a.score)[0];
    expect(one.has(best.key)).toBe(true);
  });
  it('as the video plays the count stays at half or under', () => {
    // a group's first stop never waits; after it the group keeps to its share; off (0) never stops
    expect(mayStopGroup(0, 1, 0.45)).toBe(true);
    expect(mayStopGroup(1, 3, 0.45)).toBe(false);
    expect(mayStopGroup(1, 5, 0.45)).toBe(true);
    expect(mayStopGroup(0, 1, 0.05)).toBe(true);
    expect(mayStopGroup(1, 39, 0.05)).toBe(false);
    expect(mayStopGroup(1, 40, 0.05)).toBe(true);
    expect(mayStopGroup(0, 100, 0)).toBe(false);
    expect(mayStop(0, 1)).toBe(false);
    expect(mayStop(0, 2)).toBe(true);
    expect(mayStop(1, 2)).toBe(false);
    expect(mayStop(14, 30)).toBe(true);
    expect(mayStop(15, 30)).toBe(false);
    expect(counterText(12, 30)).toBe('12/30 (40%)');
    expect(counterText(0, 0)).toBe('0/0 (0%)');
  });
});

describe('the explanation rule', () => {
  const sentence = 'Today my friend was very meticulous about her work.';
  it('finds labels, filler, Chinese and IPA', () => {
    for (const bad of ["Teacher's note: \"meticulous\" means careful.", "Let's look at \"meticulous\".", 'The whole sentence means she is careful.', "Let's read it again.", 'Great, "meticulous" means careful.', 'OK so "meticulous" means careful.', '"Meticulous" means 细致的.', '"Meticulous" /məˈtɪkjələs/ means careful.', '**Meaning**: careful.', 'Explanation: it means careful.']) {
      expect(checkExplanation(bad), bad).not.toEqual([]);
    }
  });
  it('lets a good explanation through', () => {
    const good = '"Very meticulous" means very careful about every small detail. Your friend checks her work again and again, and she feels proud when it is right. People use this word for someone who never makes small mistakes.';
    expect(checkExplanation(good, { sentence, items: ['meticulous'] })).toEqual([]);
    expect(checkExplanation('She is a careful person.', { sentence, items: ['meticulous'] })).toContain('does not start with the original words');
  });
  it('cleans what it can, drops the rest', () => {
    expect(cleanRuleSentence("Let's look at this word.")).toBe('');
    expect(cleanRuleSentence("Teacher's note: it means careful.")).toBe('It means careful.');
    expect(cleanRuleSentence('OK so it means careful.')).toBe('It means careful.');
    expect(cleanRuleSentence('Great, it means careful.')).toBe('It means careful.');
    expect(cleanRuleSentence('It means careful (细致的).')).toBe('It means careful.');
    expect(cleanRuleSentence('It sounds like /məˈtɪkjələs/ here.')).toBe('It sounds like here.');
    expect(cleanRuleSentence('The whole sentence means she cares.')).toBe('This means she cares.');
    // "great" and "so" inside a sentence are ordinary words
    expect(cleanRuleSentence('It was a great party, so she stayed.')).toBe('It was a great party, so she stayed.');
  });
  it('the guard passes only checked, complete sentences, and the text only grows', () => {
    const g = new RuleGuard({ sentence, items: ['meticulous'] });
    const reply = 'OK so "meticulous" means very careful. Let\'s look at the next part. Your friend checks her work, and "about her work" shows what she cares about. She feels proud.';
    let last = '';
    for (let i = 1; i <= reply.length; i += 7) {
      const t = g.push(reply.slice(0, i));
      expect(t.startsWith(last.trimEnd())).toBe(true);
      expect(t).not.toMatch(/OK so|Let's look/);
      last = t;
    }
    const final = g.finish(reply);
    expect(final).toBe('"Meticulous" means very careful. Your friend checks her work, and "about her work" shows what she cares about. She feels proud.'.replace('"Meticulous"', '"meticulous"'));
    expect(checkExplanation(final, { sentence, items: ['meticulous'] })).toEqual([]);
    expect(g.rejected).toBeGreaterThan(0);
  });
  it('a reply that does not start with the hard words gets them first', () => {
    const g = new RuleGuard({ sentence, items: ['meticulous'] });
    expect(g.finish('She is very careful.')).toBe('“meticulous.” She is very careful.');
  });
  it('the prompt carries the rule and no Chinese word', () => {
    const req = { kind: 'sentence', target: sentence, sentence, before: '', after: '', book: { title: 'T', chapter: '' }, history: [], levelRule: { items: ['meticulous'], known: ['friend'], level: 'about lower B2' } } as RuleRequest;
    const p = buildRulePrompt(req);
    expect(p.system).toContain('no Chinese');
    expect(p.system).toContain("Teacher's note");
    expect(p.user).toContain('"meticulous"');
    expect(p.user).toContain('friend');
  });
});

describe('the reading mode\'s text', () => {
  it('keeps every word in order', () => {
    const text = 'One line of a\nparagraph here. And its second sen-\ntence.\n\nA new paragraph: “quoted words”, 3 numbers!\n';
    const b = textBook('x', 'T', text, 'text');
    const out = b.chapters[0].paragraphs.map((p) => p.text);
    expect(out).toEqual(['One line of a paragraph here. And its second sentence.', 'A new paragraph: “quoted words”, 3 numbers!']);
    expect(paragraphsOf('a\n\n\nb')).toEqual(['a', 'b']);
    // every sentence is a piece of its paragraph, together they are all of it
    for (const p of b.chapters[0].paragraphs) expect(p.sentences.map((s) => sentenceText(p, s)).join(' ')).toBe(p.text);
  });
  it('a PDF\'s lines become paragraphs, a page end does not cut a sentence', () => {
    const item = (str: string, y: number) => ({ str, transform: [1, 0, 0, 1, 0, y], hasEOL: true });
    const text = pagesToText([[item('First line of', 700), item('the paragraph.', 686), item('Second paragraph starts', 650), item('and goes on to the', 636)], [item('next page here.', 700)]]);
    expect(paragraphsOf(text)).toEqual(['First line of the paragraph.', 'Second paragraph starts and goes on to the next page here.']);
  });
});

describe('analyze once', () => {
  const stopsOf = (n: number, every = 2): AnalysisStop[] => Array.from({ length: n }, (_, i) => ({ id: `s${i * every}`, index: i * every, text: `Sentence number ${i * every} is hard.`, items: ['hard'] }));
  const reply = (part: string) => [...part.matchAll(/\*(\d+)\. /g)].map((m) => `@@${m[1]}\n"hard" means something here. OK so this is fine (细致).`).join('\n');
  function make(stops: AnalysisStop[], saved: Record<string, string> = {}, fail = false) {
    const prompts: string[] = [];
    const log = { saved: {} as Record<string, string> };
    const a = new Analysis({
      load: async () => saved, save: async (t) => { log.saved = { ...t }; }, stops: () => stops,
      lineAt: (i) => `Sentence number ${i} is hard.`, total: () => 1000, title: () => 'T', level: () => 'B2',
      stream: (p, onDelta) => {
        prompts.push(p.user);
        const text = reply(p.user);
        return { done: fail ? Promise.reject(new Error('no')) : Promise.resolve().then(() => { onDelta(text); return text; }), cancel: () => undefined };
      },
    });
    return { a, prompts, log };
  }
  it('one call for many stops, a part ahead, not one call per stop', async () => {
    const stops = stopsOf(50);
    const { a, prompts, log } = make(stops);
    await a.ready;
    a.plan(0);
    expect(await a.wait(stops[0].id)).toContain('means something here');
    await new Promise((r) => setTimeout(r, 0));
    expect(prompts).toHaveLength(1);
    for (const s of stops.slice(0, STOPS_PER_PART)) expect(await a.wait(s.id)).toBeTruthy();
    expect(prompts).toHaveLength(1);
    expect(Object.keys(log.saved)).toHaveLength(STOPS_PER_PART);
    // far from the end of what is written: nothing new is asked
    a.plan(stops[3].index);
    expect(prompts).toHaveLength(1);
    // close to it: the next part, once
    a.plan(stops[STOPS_PER_PART - LOOK_AHEAD + 1].index);
    expect(prompts).toHaveLength(2);
  });
  it('what is saved costs nothing again', async () => {
    const stops = stopsOf(3);
    const saved = Object.fromEntries(stops.map((s) => [s.id, 'Saved words.']));
    const { a, prompts } = make(stops, saved);
    await a.ready;
    a.plan(0);
    expect(await a.wait(stops[1].id)).toBe('Saved words.');
    expect(prompts).toHaveLength(0);
  });
  it('a stop reached while its explanation is being written waits for it (no AI call of its own)', async () => {
    const stops = stopsOf(3);
    let finish!: (t: string) => void;
    let calls = 0;
    const list = [...stops];
    const a = new Analysis({
      load: async () => ({}), save: async () => undefined, stops: () => list, lineAt: (i) => `Line ${i}.`, total: () => 100, title: () => 'T', level: () => 'B2',
      stream: () => { calls++; return { done: new Promise<string>((r) => { finish = r; }), cancel: () => undefined }; },
    });
    await a.ready;
    a.plan(0);
    // (the stop is going on, and the stop list no longer offers it)
    list.shift();
    const waiting = a.wait(stops[0].id);
    finish(`@@1\n"hard" is explained here.\n@@3\n"hard" again.\n@@5\n"hard" once more.`);
    expect(await waiting).toContain('explained here');
    expect(calls).toBe(1);
  });
  it('the rule\'s check runs on what the analysis wrote', async () => {
    const stops = stopsOf(1);
    const { a } = make(stops);
    await a.ready;
    a.plan(0);
    const t = await a.wait(stops[0].id);
    expect(t).not.toMatch(/OK so|细致/);
    expect(a.rejected).toBeGreaterThan(0);
  });
  it('a failed analysis does not hang: the stop goes on without it', async () => {
    const stops = stopsOf(2);
    const { a } = make(stops, {}, true);
    await a.ready;
    a.plan(0);
    expect(await a.wait(stops[0].id)).toBeNull();
    expect(a.settled(stops[0].id)).toBe(true);
  });
  it('the format', () => {
    expect(parseAnalysis('@@3\nOne two.\n@@7\nThree', false)).toEqual([{ n: 3, text: 'One two.' }]);
    expect(parseAnalysis('@@3\nOne two.\n@@7\nThree', true)).toEqual([{ n: 3, text: 'One two.' }, { n: 7, text: 'Three' }]);
    expect(analysisId('It\u2019s a  TEST, here!')).toBe('it s a test here');
    const p = buildAnalysisPrompt({ title: 'T', level: 'B2', part: stopsOf(2), lineAt: (i) => `Line ${i}.`, total: 10 });
    expect(p.user).toContain('*1. Line 0.  [hard: hard]');
    expect(p.user).toContain('2. Line 1.');
    expect(p.user).toContain('*3. Line 2.');
    expect(p.system).toContain('These rules are absolute');
  });
});

describe('one database for the Mac and the phone (mergeDocs)', () => {
  const doc = (p: Partial<VocabularyDoc>): VocabularyDoc => ({ version: 1, updatedAt: '2026-11-04T00:00:00.000Z', currentLevel: '', tests: [], known: [], stillLearning: [], ...p });
  const NOW = new Date('2026-11-06T09:00:00.000Z');
  const mac = doc({ currentLevel: 'about lower B2', tests: [{ date: '2026-11-04', source: 'Eveline', scores: { b2: 45, c1: 5, c2: 13 }, level: 'lower B2' }],
    known: [{ item: 'familiar', date: '2026-11-04' }, { item: 'shelter', date: '2026-11-01' }], stillLearning: [{ item: 'invade', date: '2026-11-04', sentence: 'They invade.' }, { item: 'odour', date: '2026-11-02', sentence: 'A bad odour.' }] });
  const phone = doc({ currentLevel: 'about B2', tests: [{ date: '2026-11-05', source: 'A phone video', scores: { b2: 60, c1: 20, c2: 10 }, level: 'B2' }, { date: '2026-11-04', source: 'Eveline', scores: { b2: 45, c1: 5, c2: 13 }, level: 'lower B2' }],
    known: [{ item: 'serendipity', date: '2026-11-05' }, { item: 'odour', date: '2026-11-05' }], stillLearning: [{ item: 'shelter', date: '2026-11-05', sentence: 'No shelter.' }, { item: 'invade', date: '2026-11-04', sentence: 'They invade us.' }] });
  it('the first merge (nothing shared yet): both devices\' words, every test once, the level of the newest test', () => {
    const m = mergeDocs(mac, [phone], null, new Set(), NOW);
    expect(m.doc.known.map((k) => k.item)).toEqual(['familiar', 'odour', 'serendipity']);
    expect(m.doc.stillLearning.map((l) => l.item)).toEqual(['invade', 'shelter']);
    expect(m.doc.tests.map((t) => t.source)).toEqual(['Eveline', 'A phone video']);
    expect(m.doc.currentLevel).toBe('about B2');
    // what changes on the Mac: the phone's new word, and the two words whose newer status is the phone's
    expect(m.changes.map((c) => `${c.item}:${c.status}`).sort()).toEqual(['odour:known', 'serendipity:known', 'shelter:learning']);
    expect(m.doc.stillLearning.find((l) => l.item === 'invade')?.sentence).toBe('They invade.'); // a tie: this device's record
    expect(m.doc.removed).toBeUndefined();
  });
  it('merging the device\'s own last copy changes nothing', () => {
    const m = mergeDocs(mac, [mac], mac, new Set(), NOW);
    expect(m.changes).toEqual([]);
    expect(sameDoc(m.doc, mac)).toBe(true);
  });
  it('a word removed here does not come back from the file, and the other device is told', () => {
    const base = mergeDocs(mac, [phone], null, new Set(), NOW).doc;
    const mine = doc({ ...base, stillLearning: base.stillLearning.filter((l) => l.item !== 'invade') }); // "invade" removed in My Vocabulary
    const m = mergeDocs(mine, [base], base, new Set(), NOW);
    expect(m.changes).toEqual([]);
    expect(m.doc.stillLearning.map((l) => l.item)).toEqual(['shelter']);
    expect(m.doc.removed).toEqual([{ item: 'invade', date: '2026-11-06' }]);
    // the other device (still has it, unchanged since the last merge) takes it out
    const there = mergeDocs(base, [m.doc], base, new Set(), new Date('2026-11-06T10:00:00.000Z'));
    expect(there.changes).toEqual([{ item: 'invade', status: null }]);
    expect(there.doc.stillLearning.map((l) => l.item)).toEqual(['shelter']);
    // ...and that is old news at the next merge: nothing more happens, on either side
    expect(mergeDocs(there.doc, [m.doc], there.doc, new Set(), NOW).changes).toEqual([]);
    expect(mergeDocs(m.doc, [there.doc], m.doc, new Set(), NOW).changes).toEqual([]);
  });
  it('a word ignored here is never taken from the file, and goes out of it', () => {
    const base = mergeDocs(mac, [phone], null, new Set(), NOW).doc;
    const mine = doc({ ...base, known: base.known.filter((k) => k.item !== 'serendipity') }); // ignored here: not in this device's document
    const m = mergeDocs(mine, [base], base, new Set(['serendipity']), NOW);
    expect(m.changes).toEqual([]);
    expect(m.doc.known.map((k) => k.item)).toEqual(['familiar', 'odour']);
    expect(m.doc.removed?.map((r) => r.item)).toEqual(['serendipity']);
    // also a word the other device adds later, that this device ignores
    const m2 = mergeDocs(mine, [doc({ ...base, stillLearning: [...base.stillLearning, { item: 'quay', date: '2026-11-06', sentence: 'The quay.' }] })], base, new Set(['serendipity', 'quay']), NOW);
    expect(m2.changes).toEqual([]);
    expect(m2.doc.stillLearning.map((l) => l.item)).not.toContain('quay');
  });
  it('met again on the other device after it was removed here: it comes back', () => {
    const base = mergeDocs(mac, [phone], null, new Set(), NOW).doc;
    const mine = doc({ ...base, stillLearning: base.stillLearning.filter((l) => l.item !== 'invade') });
    const sent = mergeDocs(mine, [base], base, new Set(), new Date('2026-11-06T09:00:00.000Z')).doc; // removed on the 6th
    const theirs = doc({ ...base, stillLearning: base.stillLearning.map((l) => (l.item === 'invade' ? { ...l, date: '2026-11-08' } : l)), known: base.known });
    const back = mergeDocs(mine, [doc({ ...theirs, known: [...theirs.known, { item: 'invade', date: '2026-11-08' }], stillLearning: theirs.stillLearning.filter((l) => l.item !== 'invade') })], sent, new Set(), new Date('2026-11-09T09:00:00.000Z'));
    expect(back.changes).toEqual([{ item: 'invade', status: 'known', date: '2026-11-08' }]);
    expect(back.doc.removed).toBeUndefined();
  });
  it('an older or foreign copy of the file never deletes words here', () => {
    const base = mergeDocs(mac, [phone], null, new Set(), NOW).doc;
    const m = mergeDocs(base, [doc({ known: [{ item: 'familiar', date: '2026-11-04' }] })], base, new Set(), NOW); // a file with almost nothing in it
    expect(m.changes).toEqual([]);
    expect(m.doc.known.length).toBe(base.known.length);
    expect(m.doc.stillLearning.length).toBe(base.stillLearning.length);
  });
  it('changed on both devices since the last merge: the newest wins; changed only there: taken', () => {
    const base = doc({ stillLearning: [{ item: 'quay', date: '2026-11-01', sentence: 'The quay.' }, { item: 'weary', date: '2026-11-01', sentence: 'Weary.' }] });
    const mine = doc({ known: [{ item: 'quay', date: '2026-11-03' }], stillLearning: [{ item: 'weary', date: '2026-11-01', sentence: 'Weary.' }] });
    const theirs = doc({ known: [{ item: 'weary', date: '2026-11-02' }], stillLearning: [{ item: 'quay', date: '2026-11-02', sentence: 'The quay again.' }] });
    const m = mergeDocs(mine, [theirs], base, new Set(), NOW);
    expect(m.doc.known.map((k) => k.item)).toEqual(['quay', 'weary']); // quay: mine is newer; weary: only they changed it
    expect(m.changes).toEqual([{ item: 'weary', status: 'known', date: '2026-11-02' }]);
  });
  it('two tests of the same text on one day are both kept', () => {
    const a = doc({ tests: [{ date: '2026-11-05', source: 'V', scores: { b2: 40, c1: 0, c2: 0 }, level: 'lower B2' }] });
    const b = doc({ tests: [{ date: '2026-11-05', source: 'V', scores: { b2: 60, c1: 10, c2: 0 }, level: 'B2' }] });
    expect(mergeDocs(a, [b], null, new Set(), NOW).doc.tests.length).toBe(2);
    expect(mergeDocs(a, [a], null, new Set(), NOW).doc.tests.length).toBe(1);
  });
  it('sameDoc and isDoc', () => {
    expect(sameDoc(mac, mergeDocs(mac, [], null, new Set(), NOW).doc)).toBe(true);
    expect(sameDoc(mac, mergeDocs(mac, [phone], null, new Set(), NOW).doc)).toBe(false);
    expect(isDoc(mac)).toBe(true);
    expect(isDoc({ echo: 1 })).toBe(false);
    expect(isDoc(null)).toBe(false);
  });
});
