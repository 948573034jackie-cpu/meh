import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { detectNames } from '@core/dict/names';
import { buildVideoBook } from '../src/video-book';
import { realDictionary } from './helpers';
import {
  topicOf, makeSearches, wantsMusic, notEnglish, isMusicVideo, pickCandidates, buildRankPrompt, parseRankReply, makeList, textDifficulty,
  fitLabel, orderedVideos, neighbour, readList, loadList, saveList, finderNext, finderPrev, finderEnded, resetFinderPlaylist, currentList,
  LIST_KEY, type FoundVideo, type FinderList, type PlaylistDeps,
} from '../src/finder-list';

const vid = (id: string, title = id, extra: Partial<FoundVideo> = {}): FoundVideo => ({ id: id.padEnd(11, '0').slice(0, 11), title, channel: 'Channel', lengthSeconds: 600, ...extra });

describe('the searches (fixed patterns, no AI)', () => {
  it('the topic of what was said', () => {
    expect(topicOf('black holes')).toBe('black holes');
    expect(topicOf('Please find me some videos about black holes.')).toBe('black holes');
    expect(topicOf('I want to learn about the Roman empire')).toBe('the Roman empire');
    expect(topicOf('I want to know more about how planes fly')).toBe('how planes fly');
    expect(topicOf('can you show me a good video on jazz piano')).toBe('jazz piano');
    expect(topicOf('I want to learn to cook')).toBe('learn to cook');
    expect(topicOf('how to sleep better')).toBe('how to sleep better');
    expect(topicOf('  ')).toBe('');
    // a long voice note: its first sentence, a few words
    expect(topicOf('The history of the Silk Road and the people who travelled along it for many hundreds of years. I like history.').split(' ').length).toBeLessThanOrEqual(9);
  });
  it('4 to 6 searches: the words, + explained, + what fits; no repeats', () => {
    const a = makeSearches('black holes');
    expect(a[0]).toBe('black holes');
    expect(a).toContain('black holes explained');
    expect(a).toContain('black holes documentary');
    expect(a).toContain('black holes for beginners');
    expect(a.length).toBeGreaterThanOrEqual(4);
    expect(a.length).toBeLessThanOrEqual(6);
    expect(new Set(a.map((x) => x.toLowerCase())).size).toBe(a.length);
    const b = makeSearches('how to bake bread');
    expect(b).toContain('how to bake bread for beginners');
    expect(b).not.toContain('how to bake bread documentary');
    expect(b.length).toBeGreaterThanOrEqual(4);
    // (words that are in it already are not added again)
    expect(makeSearches('photosynthesis explained').filter((x) => /explained explained/.test(x))).toEqual([]);
    expect(makeSearches('python for beginners').filter((x) => /beginners for beginners/.test(x))).toEqual([]);
    expect(makeSearches('')).toEqual([]);
  });
  it('music: only when asked', () => {
    expect(wantsMusic('songs by Adele')).toBe(true);
    expect(wantsMusic('jazz piano')).toBe(true);
    expect(wantsMusic('black holes')).toBe(false);
    expect(makeSearches('Adele songs')).toContain('Adele songs lyrics');
  });
});

describe('the candidates', () => {
  it('other languages and music videos are known by their titles', () => {
    expect(notEnglish('黑洞是什么？科学解释')).toBe(true);
    expect(notEnglish('Что такое чёрная дыра')).toBe(true);
    expect(notEnglish('Agujeros negros explicados en español')).toBe(true);
    expect(notEnglish('¿Qué pasaría si cayeras en un agujero negro? Explicación')).toBe(true);
    expect(notEnglish('Black Holes Explained – From Birth to Death')).toBe(false);
    expect(notEnglish('What is a Black Hole? (黑洞) | NASA')).toBe(false);
    expect(notEnglish('Café culture in Paris: a short history')).toBe(false);
    expect(isMusicVideo({ title: 'Muse - Supermassive Black Hole (Official Music Video)', channel: 'Muse' })).toBe(true);
    expect(isMusicVideo({ title: 'Black Hole Sun', channel: 'SoundgardenVEVO' })).toBe(true);
    expect(isMusicVideo({ title: 'Black Hole (Lyrics)', channel: 'x' })).toBe(true);
    expect(isMusicVideo({ title: 'Black holes explained', channel: 'Kurzgesagt' })).toBe(false);
  });
  it('the searches take turns; no repeats, no Shorts, no other languages, no music unless asked', () => {
    const lists = [
      [vid('a', 'Black holes explained'), vid('b', 'A short', { lengthSeconds: 45 }), vid('c', 'What is a black hole?')],
      [vid('d', 'Black holes documentary'), vid('a', 'Black holes explained'), vid('e', '黑洞是什么？科学解释')],
      [vid('f', 'Muse - Supermassive Black Hole (Official Music Video)'), vid('g', 'Falling in #shorts'), vid('h', 'Black holes explained', { channel: 'Copy' })],
      [],
    ];
    const out = pickCandidates(lists, 'black holes');
    expect(out.map((v) => v.id[0])).toEqual(['a', 'd', 'c']); // (h: the same title and length as a)
    expect(pickCandidates(lists, 'songs about black holes').map((v) => v.id[0])).toContain('f');
    // a video whose length is not known stays; at most `max`
    expect(pickCandidates([[vid('x', 'No length', { lengthSeconds: undefined })]], 'x')).toHaveLength(1);
    const many = Array.from({ length: 30 }, (_, i) => vid(`m${i}`.padEnd(11, 'x'), `Video ${i}`));
    const more = Array.from({ length: 30 }, (_, i) => vid(`n${i}`.padEnd(11, 'x'), `Other ${i}`));
    expect(pickCandidates([many, more], 'x')).toHaveLength(40);
  });
});

describe('the ONE AI request: pick and rank', () => {
  const cands = Array.from({ length: 30 }, (_, i) => vid(`v${i}`.padEnd(11, 'x'), `Video ${i + 1}`, { views: '1.2M views', age: '3 years ago' }));
  it('the prompt: the words, the numbered videos, the level with its 3 anchors, strict JSON', () => {
    const p = buildRankPrompt('black holes', cands, 62);
    expect(p.user).toContain('black holes');
    expect(p.user).toContain('1. Video 1 | Channel | 10 min | 1.2M views | 3 years ago');
    expect(p.user).toContain('30. Video 30');
    expect(p.user).toMatch(/level is 62/);
    expect(p.user).toMatch(/20 = slow, simple talk/);
    expect(p.user).toMatch(/55 = normal, clear talk/);
    expect(p.user).toMatch(/85 = fast and dense talk/);
    expect(p.user).toMatch(/the best one first/);
    expect(p.system).toMatch(/JSON only/);
  });
  const good = { videos: Array.from({ length: 10 }, (_, i) => ({ n: 30 - i * 2, why: `Reason ${i + 1}.`, level: 30 + i * 5 })) };
  it('strict JSON', () => {
    const r = parseRankReply(JSON.stringify(good), 30);
    expect(r).toHaveLength(10);
    expect(r[0]).toEqual({ n: 30, why: 'Reason 1.', level: 30 });
    expect(r[9]).toEqual({ n: 12, why: 'Reason 10.', level: 75 });
  });
  it('code fences, text around it, other key names, a bare list', () => {
    expect(parseRankReply('Sure!\n```json\n' + JSON.stringify(good, null, 1) + '\n```\nEnjoy.', 30)).toHaveLength(10);
    expect(parseRankReply('{"best":[{"number":"3","reason":"Clear.","difficulty":40}]}', 30)).toEqual([{ n: 3, why: 'Clear.', level: 40 }]);
    expect(parseRankReply('[5, 2, 5, 99, 0, 7]', 30).map((x) => x.n)).toEqual([5, 2, 7]);
    expect(parseRankReply('[{"n":4,"why":"x","level":140},{"n":6,"why":"y","level":"hard"}]', 30)).toEqual([{ n: 4, why: 'x', level: null }, { n: 6, why: 'y', level: null }]);
  });
  it('a cut-off answer keeps its complete entries; at most 10; garbage = []', () => {
    const cut = '{"videos":[{"n":7,"why":"It is about \\"black holes\\".","level":55},{"n":2,"why":"Easy words.","level":30},{"n":9,"why":"A long tal';
    expect(parseRankReply(cut, 30)).toEqual([{ n: 7, why: 'It is about "black holes".', level: 55 }, { n: 2, why: 'Easy words.', level: 30 }]);
    expect(parseRankReply(JSON.stringify({ videos: Array.from({ length: 20 }, (_, i) => ({ n: i + 1 })) }), 30)).toHaveLength(10);
    expect(parseRankReply('I cannot help with that.', 30)).toEqual([]);
    expect(parseRankReply('', 30)).toEqual([]);
    expect(parseRankReply('{"videos":"none"}', 30)).toEqual([]);
    expect(parseRankReply('{"videos":[{"n":31},{"n":-1},{"n":1.5}]}', 30)).toEqual([]);
  });
  it('the list: the picks in the AI\'s order with rank 1-10; fewer picks = filled in YouTube\'s order; no picks = the first 10', () => {
    const list = makeList('black holes', cands, parseRankReply(JSON.stringify(good), 30), 1000);
    expect(list.videos.map((v) => v.title).slice(0, 3)).toEqual(['Video 30', 'Video 28', 'Video 26']);
    expect(list.videos.map((v) => v.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(list.videos[0]).toMatchObject({ why: 'Reason 1.', level: 30, levelFrom: 'ai' });
    expect(list).toMatchObject({ query: 'black holes', at: 1000, ranked: 'ai', order: 'best', playing: null });
    const few = makeList('x', cands, [{ n: 5, why: 'w', level: null }]);
    expect(few.videos.map((v) => v.title).slice(0, 4)).toEqual(['Video 5', 'Video 1', 'Video 2', 'Video 3']);
    expect(few.videos).toHaveLength(10);
    expect(few.videos[0].levelFrom).toBeNull();
    const none = makeList('x', cands, []);
    expect(none.ranked).toBe('search');
    expect(none.videos.map((v) => v.title)).toEqual(Array.from({ length: 10 }, (_, i) => `Video ${i + 1}`));
    expect(makeList('x', cands.slice(0, 4), []).videos).toHaveLength(4);
  });
});

describe('a video\'s level 0-100 from its subtitles (no AI)', () => {
  const dict = realDictionary();
  const table = new Map<string, number>();
  for (const [z, words] of Object.entries(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname, '../../youtube-to-claude/dream/zipf.json.gz'))).toString('utf8')) as Record<string, string>)) for (const w of words.split(' ')) table.set(w, Number(z) / 10);
  const zipf = (w: string) => table.get(w.toLowerCase()) ?? null;
  const level = (text: string, z: typeof zipf | null = zipf) => {
    const sentences = text.split(/(?<=[.?!])\s+/).map((t, i) => ({ start: i * 4, end: i * 4 + 4, text: t }));
    const vb = buildVideoBook({ id: 'x', title: 'x' }, sentences);
    return textDifficulty(vb.book, dict, new Set(detectNames(vb.book, dict)), z);
  };
  const EASY = 'Hello and welcome. Today I want to talk about my day. I get up at seven in the morning. I eat some bread and I drink a cup of tea. Then I go to work by bus. I like my work because the people are nice. At lunch I eat with my friends. We talk about our families and our plans. In the evening I go home and I cook dinner. After dinner I read a book or I watch a film. I go to bed at ten. It is a simple day but I am happy. What do you do every day? Tell me about your day.';
  const NORMAL = 'A black hole is a place in space where gravity pulls so much that even light cannot get out. The gravity is so strong because matter has been squeezed into a tiny space. This can happen when a star is dying. Because no light can get out, people cannot see black holes. They are invisible. Space telescopes with special tools can help find black holes. Scientists can see how stars that are very close to black holes act differently than other stars. Black holes can be big or small. The largest black holes are called supermassive, and they sit at the centre of almost every large galaxy.';
  const HARD = 'The epistemological ramifications of quantum decoherence remain contentious among theoreticians. Proponents of the many-worlds interpretation postulate that the wavefunction never collapses, whereas adherents of objective-collapse theories invoke stochastic nonlinear modifications to the Schrödinger equation. Entanglement entropy quantifies correlations between subsystems, and its asymptotic scaling distinguishes gapped phases from critical ones. Renormalization group techniques elucidate universality, yet nonperturbative phenomena such as confinement resist analytic treatment. Consequently, lattice simulations, despite their computational exorbitance, constitute an indispensable methodology for interrogating strongly coupled regimes.';
  it('simple talk is low, normal clear talk is in the middle, dense technical talk is high', () => {
    const e = level(EASY)!, n = level(NORMAL)!, h = level(HARD)!;
    expect(e.level).toBeLessThan(n.level);
    expect(n.level).toBeLessThan(h.level);
    expect(e.level).toBeLessThanOrEqual(40);
    expect(n.level).toBeGreaterThanOrEqual(35);
    expect(n.level).toBeLessThanOrEqual(70);
    expect(h.level).toBeGreaterThanOrEqual(70);
    expect(e.words).toBeGreaterThan(80);
  });
  it('too few words = no level; no frequency table = still a level from the school levels', () => {
    expect(level('Hello there. Nice to see you.')).toBeNull();
    const a = level(EASY, null)!, b = level(HARD, null)!;
    expect(a.level).toBeLessThan(b.level);
  });
});

describe('the order of the list (no AI, no search)', () => {
  const mk = (levels: (number | null)[]): FinderList => makeList('q', levels.map((_, i) => vid(`o${i}`.padEnd(11, 'x'), `V${i + 1}`)), levels.map((l, i) => ({ n: i + 1, why: '', level: l })));
  const list = mk([80, 20, 60, 45, null, 62]);
  const ids = (l: FinderList, my = 55) => orderedVideos(l, my).map((v) => v.title);
  it('"Best" is the first ranking', () => {
    expect(ids(list)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6']);
  });
  it('"My level": the best fit first, the same fit by rank, no level last', () => {
    // level 55: just right is 60; 60 and 62 fit best, then 45, 80, 20; V5 has no level
    expect(ids({ ...list, order: 'mine' })).toEqual(['V3', 'V6', 'V4', 'V1', 'V2', 'V5']);
    // a learner at 15: the easy video comes first
    expect(ids({ ...list, order: 'mine' }, 15)[0]).toBe('V2');
  });
  it('a chosen level orders for that number, whatever my level is; "Best" brings the first ranking back', () => {
    expect(ids({ ...list, order: 75 })[0]).toBe('V1');
    expect(ids({ ...list, order: 15 }, 90)[0]).toBe('V2');
    expect(ids({ ...list, order: 'best' }, 90)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6']);
    // (the list itself is not changed by ordering it)
    expect(list.videos.map((v) => v.title)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6']);
  });
  it('fits you / easy for you / hard for you', () => {
    expect(fitLabel(60, 55)).toEqual({ text: 'fits you', kind: 'ok' });
    expect(fitLabel(20, 55).kind).toBe('easy');
    expect(fitLabel(90, 55).kind).toBe('hard');
  });
  it('next and previous follow the order now shown; the ends do not go round', () => {
    const byLevel: FinderList = { ...list, order: 'mine' };
    const id = (t: string) => list.videos.find((v) => v.title === t)!.id;
    expect(neighbour(list, id('V1'), 1, 55)!.title).toBe('V2');
    expect(neighbour(list, id('V1'), -1, 55)).toBeNull();
    expect(neighbour(list, id('V6'), 1, 55)).toBeNull();
    expect(neighbour(byLevel, id('V3'), 1, 55)!.title).toBe('V6');
    expect(neighbour(byLevel, id('V4'), -1, 55)!.title).toBe('V6');
    // a video that is not in the list: from the one that played last; nothing played: the first
    expect(neighbour({ ...list, playing: id('V2') }, 'zzzzzzzzzzz', 1, 55)!.title).toBe('V3');
    expect(neighbour(list, null, 1, 55)!.title).toBe('V1');
    expect(neighbour(list, null, -1, 55)).toBeNull();
  });
});

describe('the list is kept; the playlist', () => {
  let stored: Record<string, unknown> = {};
  const cands = Array.from({ length: 12 }, (_, i) => vid(`p${i}`.padEnd(11, 'x'), `Video ${i + 1}`, { lengthSeconds: 300 }));
  const fresh = () => makeList('black holes', cands, [{ n: 3, why: 'Good.', level: 50 }, { n: 1, why: 'Clear.', level: 70 }, { n: 2, why: 'Easy.', level: 20 }]);
  let opened: string[] = [];
  let here: string | null = null;
  let ad = false, busy = false;
  const deps: PlaylistDeps = { currentId: () => here, isAd: () => ad, myLevel: () => 55, open: (id) => { opened.push(id); here = id; }, busy: () => busy };
  beforeEach(() => {
    stored = {}; opened = []; here = null; ad = false; busy = false;
    (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: {
      get: async (k: string) => (k in stored ? { [k]: JSON.parse(JSON.stringify(stored[k])) } : {}),
      set: async (o: Record<string, unknown>) => { Object.assign(stored, JSON.parse(JSON.stringify(o))); },
    } } };
    resetFinderPlaylist(null, deps);
  });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as unknown as { chrome?: unknown }).chrome; });

  it('saved and read back the same: the words, the 10 videos with rank, why and level, the order, which one plays', async () => {
    const list: FinderList = { ...fresh(), order: 40, playing: cands[0].id };
    await saveList(list);
    expect(stored[LIST_KEY]).toBeTruthy();
    expect(await loadList()).toEqual(list);
    expect((await loadList())!.videos).toHaveLength(10);
  });
  it('a broken stored value is no list; bad entries are dropped', async () => {
    expect(readList(null)).toBeNull();
    expect(readList({ videos: [] })).toBeNull();
    expect(readList({ videos: [{ id: 'bad' }] })).toBeNull();
    const l = readList({ query: 'q', videos: [{ id: 'abcdefghijk', title: 'T', rank: 1, level: 300, levelFrom: 'subs' }, { id: 'abcdefghijk' }, { title: 'no id' }], order: 'nonsense', playing: 'zzzzzzzzzzz' })!;
    expect(l.videos).toHaveLength(1);
    expect(l.videos[0]).toMatchObject({ level: 100, levelFrom: 'subs', why: '' });
    expect(l.order).toBe('best');
    expect(l.playing).toBeNull();
    stored[LIST_KEY] = 'garbage';
    expect(await loadList()).toBeNull();
  });
  it('next / previous open the neighbour and the list knows which one plays', async () => {
    const list = { ...fresh(), playing: cands[2].id };
    resetFinderPlaylist(list, deps);
    here = cands[2].id; // (rank 1)
    expect(finderPrev()).toBe(false);
    expect(finderNext()).toBe(true);
    await vi.waitFor(() => expect(opened).toEqual([cands[0].id]));
    expect(currentList()!.playing).toBe(cands[0].id);
    expect((stored[LIST_KEY] as FinderList).playing).toBe(cands[0].id);
    expect(finderPrev()).toBe(true);
    await vi.waitFor(() => expect(opened).toEqual([cands[0].id, cands[2].id]));
  });
  it('no list = nothing to do', () => {
    expect(finderNext()).toBe(false);
    expect(finderPrev()).toBe(false);
    expect(finderEnded({ duration: 300 })).toBe(false);
  });
  it('a video of the list ended: the next one of the order shown opens by itself', async () => {
    const list: FinderList = { ...fresh(), order: 'mine', playing: cands[2].id };
    resetFinderPlaylist(list, deps);
    here = cands[2].id; // level 50: the best fit for 55; then 70, then 20
    expect(finderEnded({ duration: 301 })).toBe(true);
    await vi.waitFor(() => expect(opened).toEqual([cands[0].id]));
  });
  it('not at an advertisement\'s end, not for a video that was not opened from the list, not after the last one', async () => {
    const list: FinderList = { ...fresh(), playing: cands[2].id };
    resetFinderPlaylist(list, deps);
    here = cands[2].id;
    ad = true;
    expect(finderEnded({ duration: 300 })).toBe(false);
    ad = false;
    // (an advertisement that ended just as its mark went away: its length is not the video's)
    expect(finderEnded({ duration: 15 })).toBe(false);
    here = 'zzzzzzzzzzz';
    expect(finderEnded({ duration: 300 })).toBe(false);
    // a video of the list, but opened from somewhere else (it is not the one "playing")
    here = cands[0].id;
    expect(finderEnded({ duration: 300 })).toBe(false);
    const last = list.videos[list.videos.length - 1].id;
    resetFinderPlaylist({ ...list, playing: last }, deps);
    here = last;
    expect(finderEnded({ duration: 300 })).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual([]);
  });
  it('the tutor still explains the last sentence: the next video waits for it', async () => {
    vi.useFakeTimers();
    const list: FinderList = { ...fresh(), playing: cands[2].id };
    resetFinderPlaylist(list, deps);
    here = cands[2].id;
    busy = true;
    expect(finderEnded({ duration: 300 })).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(opened).toEqual([]);
    busy = false;
    await vi.advanceTimersByTimeAsync(1200);
    expect(opened).toEqual([cands[0].id]);
  });
});

// youtube.js is a content script (no import): its search parser also reads the views and the age
describe('youtube.js search parser: views and age', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../youtube-to-claude/youtube.js'), 'utf8');
  const part = src.slice(src.indexOf('// FINDER-PURE-START'), src.indexOf('// FINDER-PURE-END'));
  const { finderVideos } = new Function(`${part}; return { finderVideos };`)() as { finderVideos(data: unknown, max?: number): FoundVideo[] };
  it('when the search answer has them (old and new shapes), else they are left out', () => {
    const v = finderVideos({ contents: [
      { videoRenderer: { videoId: 'AAAAAAAAAAA', title: { simpleText: 'One' }, ownerText: { runs: [{ text: 'Ch' }] }, lengthText: { simpleText: '12:34' }, shortViewCountText: { simpleText: '1.2M views' }, publishedTimeText: { simpleText: '3 years ago' } } },
      { videoWithContextRenderer: { videoId: 'BBBBBBBBBBB', headline: { runs: [{ text: 'Two' }] }, shortViewCountText: { runs: [{ text: '15K views' }] }, publishedTimeText: { runs: [{ text: '2 weeks ago' }] } } },
      { lockupViewModel: { contentId: 'CCCCCCCCCCC', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'Three' }, metadata: { contentMetadataViewModel: { metadataRows: [
        { metadataParts: [{ text: { content: 'Shape Channel' } }] }, { metadataParts: [{ text: { content: '987 views' } }, { text: { content: '1 day ago' } }] }] } } } } } },
      { videoRenderer: { videoId: 'DDDDDDDDDDD', title: { simpleText: 'Four' } } },
    ] });
    expect(v.map((x) => [x.views, x.age])).toEqual([['1.2M views', '3 years ago'], ['15K views', '2 weeks ago'], ['987 views', '1 day ago'], [undefined, undefined]]);
    expect('views' in v[3]).toBe(false);
  });
});
