import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  songOf, songIsClear, artistOfChannel, buildSongNamePrompt, parseSongName, lyricTries, findLyrics, titleFits, lengthFits, cleanOvh,
  spreadPlain, plainLines, alignToCaptions, captionWords, timePlain, lyricsNote, type CaptionWord, type Lyrics,
} from '../src/lyrics';
import { findSongLyrics, usePastedLyrics, loadSongRecord, lyricSentences, withTimes, type FindSongDeps } from '../src/lyrics-find';

describe('the real song from a YouTube title (rules, no AI)', () => {
  const cases: [string, string, string, string][] = [
    // title, channel, artist, song
    ['Adele - Hello (Official Music Video)', 'AdeleVEVO', 'Adele', 'Hello'],
    ['Ed Sheeran - Shape of You [Official Video]', 'Ed Sheeran', 'Ed Sheeran', 'Shape of You'],
    ['Queen – Bohemian Rhapsody (Official Video Remastered)', 'Queen Official', 'Queen', 'Bohemian Rhapsody'],
    ['Bohemian Rhapsody (Remastered 2011)', 'Queen - Topic', 'Queen', 'Bohemian Rhapsody'],
    ['Calvin Harris - Summer ft. Someone | Lyrics', '', 'Calvin Harris', 'Summer'],
    ['The Weeknd - Blinding Lights (Official Audio) [4K]', 'TheWeekndVEVO', 'The Weeknd', 'Blinding Lights'],
    ['Billie Eilish - bad guy (Lyrics) HD', '7clouds', 'Billie Eilish', 'bad guy'],
    ['Imagine Dragons - Believer (feat. Lil Wayne) [Official Lyric Video]', 'ImagineDragonsVEVO', 'Imagine Dragons', 'Believer'],
    ['Hotel California by Eagles (with lyrics)', 'Music Lover', 'Eagles', 'Hotel California'],
    ['Coldplay "Yellow" (Official Video)', 'Coldplay', 'Coldplay', 'Yellow'],
    ['Simon & Garfunkel - The Sound of Silence (Audio)', 'SimonGarfunkelVEVO', 'Simon & Garfunkel', 'The Sound of Silence'],
    ['Taylor Swift - All Too Well (10 Minute Version) (Taylor\'s Version) (Lyric Video)', 'Taylor Swift', 'Taylor Swift', 'All Too Well'],
    ['The Rolling Stones - (I Can\'t Get No) Satisfaction (Official Lyric Video)', 'The Rolling Stones', 'The Rolling Stones', '(I Can\'t Get No) Satisfaction'],
    ['Don\'t Stop Believin\' (2022 Remaster)', 'Journey - Topic', 'Journey', 'Don\'t Stop Believin\''],
    ['Dua Lipa, Elton John - Cold Heart (PNAU Remix) (Official Video)', 'Dua Lipa', 'Dua Lipa', 'Cold Heart (PNAU Remix)'],
    ['Someone Like You', 'AdeleVEVO', 'Adele', 'Someone Like You'],
    ['Lewis Capaldi - Someone You Loved - YouTube', '', 'Lewis Capaldi', 'Someone You Loved'],
    ['【Lyrics】 Oasis - Wonderwall [HQ]', 'x', 'Oasis', 'Wonderwall'],
  ];
  for (const [title, channel, artist, song] of cases) {
    it(title, () => { expect(songOf(title, channel)).toEqual({ artist, title: song }); });
  }
  it('a channel\'s name as the artist', () => {
    expect(artistOfChannel('Queen - Topic')).toBe('Queen');
    expect(artistOfChannel('EdSheeranVEVO')).toBe('Ed Sheeran');
    expect(artistOfChannel('Coldplay Official')).toBe('Coldplay');
    expect(artistOfChannel('Adele')).toBe('Adele');
  });
  it('clear = a pattern of the title or a music channel; else it is only a guess (then the AI may be asked once)', () => {
    expect(songIsClear('Adele - Hello (Official Music Video)', 'AdeleVEVO')).toBe(true);
    expect(songIsClear('Someone Like You', 'AdeleVEVO')).toBe(true);
    expect(songIsClear('Bohemian Rhapsody', 'Queen - Topic')).toBe(true);
    expect(songIsClear('the best song ever made (you will cry)', 'Random Uploads')).toBe(false);
    expect(songIsClear('', '')).toBe(false);
  });
  it('the one small AI request: title + channel + the first 300 characters of the description -> {"artist","song"}', () => {
    const p = buildSongNamePrompt('the best song ever made (you will cry)', 'Random Uploads', 'x'.repeat(900));
    expect(p.user).toContain('the best song ever made');
    expect(p.user).toContain('Random Uploads');
    expect(p.user).toContain('x'.repeat(300));
    expect(p.user).not.toContain('x'.repeat(301));
    expect(p.maxTokens).toBeLessThanOrEqual(100);
    expect(parseSongName('{"artist":"Leonard Cohen","song":"Hallelujah"}')).toEqual({ artist: 'Leonard Cohen', title: 'Hallelujah' });
    expect(parseSongName('```json\n{"artist": "Leonard Cohen", "song": "Hallelujah"}\n```')).toEqual({ artist: 'Leonard Cohen', title: 'Hallelujah' });
    expect(parseSongName('{"artist":"Leonard Cohen","song":"Hallelujah"')).toEqual({ artist: 'Leonard Cohen', title: 'Hallelujah' });
    expect(parseSongName('{"artist":"","song":""}')).toBeNull();
    expect(parseSongName('I do not know this one.')).toBeNull();
  });
});

describe('the sources and the spellings', () => {
  it('in order: LRCLIB get, LRCLIB search (as it is, without ( ), without "the", one artist, swapped, free text, the track alone), then lyrics.ovh', () => {
    const t = lyricTries({ artist: 'The Rolling Stones & Friends', title: '(I Can\'t Get No) Satisfaction' }, 224);
    expect(t.map((x) => x.kind)).toEqual(['get', 'search', 'search', 'search', 'search', 'search', 'search', 'search', 'ovh', 'ovh']);
    expect(t[0].url).toBe('https://lrclib.net/api/get?artist_name=The%20Rolling%20Stones%20%26%20Friends&track_name=(I%20Can\'t%20Get%20No)%20Satisfaction&duration=224');
    expect(t[1].url).toContain('/api/search?track_name=(I%20Can\'t%20Get%20No)%20Satisfaction&artist_name=The%20Rolling%20Stones%20%26%20Friends');
    expect(t[2].url).toContain('track_name=Satisfaction&artist_name=The%20Rolling%20Stones%20%26%20Friends'); // without ( )
    expect(t[3].url).toContain('artist_name=Rolling%20Stones%20%26%20Friends'); // without "the"
    expect(t[4].url).toContain('artist_name=The%20Rolling%20Stones&'.slice(0, -1)); // one artist
    expect(t[5].url).toContain('track_name=The%20Rolling%20Stones%20%26%20Friends&artist_name='); // swapped
    expect(t[6].url).toContain('/api/search?q=');
    expect(t[7].url).toMatch(/\/api\/search\?track_name=Satisfaction$/); // the track alone
    expect(t[8].url).toBe('https://api.lyrics.ovh/v1/The%20Rolling%20Stones%20%26%20Friends/Satisfaction');
    // only the two free services, never a lyrics website
    for (const x of t) expect(x.url).toMatch(/^https:\/\/(lrclib\.net\/api|api\.lyrics\.ovh\/v1)\//);
    // no repeats; a simple name needs fewer tries; no title = nothing to ask
    const simple = lyricTries({ artist: 'Adele', title: 'Hello' }, 295);
    expect(new Set(simple.map((x) => x.url)).size).toBe(simple.length);
    expect(simple.map((x) => x.kind)).toEqual(['get', 'search', 'search', 'search', 'search', 'ovh']);
    expect(lyricTries({ artist: 'Adele', title: '' }, 0)).toEqual([]);
    expect(lyricTries({ artist: '', title: 'Hello' }, 0).map((x) => x.kind)).toEqual(['search', 'search']);
  });
  it('a match must fit the title\'s words and, for timed lyrics, the length (12 s or 8%)', () => {
    expect(titleFits('Hello', 'Hello')).toBe(true);
    expect(titleFits('All Too Well (10 Minute Version) (Taylor\'s Version)', 'All Too Well')).toBe(true);
    expect(titleFits('Hello Goodbye', 'Hello')).toBe(true);
    expect(titleFits('Yellow Submarine', 'Yellow')).toBe(true);
    expect(titleFits('Goodbye', 'Hello')).toBe(false);
    expect(titleFits('Shellow', 'Hello')).toBe(false);
    expect(lengthFits(295, 300)).toBe(true);
    expect(lengthFits(270, 300)).toBe(false);
    expect(lengthFits(100, 115)).toBe(false); // (a short song: 12 s)
    expect(lengthFits(100, 110)).toBe(true);
    expect(lengthFits(560, 600)).toBe(true); // 8%
    expect(lengthFits(undefined, 300)).toBe(true);
  });
  const SYNC = '[00:12.50] Hello, it\'s me\n[00:16.00] I was wondering if after all these years\n[00:20.00] You\'d like to meet\n\n[00:40.10] Hello from the other side';
  const PLAIN = 'Hello, it\'s me\nI was wondering if after all these years\nYou\'d like to meet\n\nHello from the other side\nI must have called a thousand times';
  /** a fake of the two services: `routes` by a part of the address; no match = 404 (fetchJson throws) */
  const fake = (routes: Record<string, unknown>) => {
    const urls: string[] = [];
    const fetchJson = async (url: string): Promise<unknown> => {
      urls.push(url);
      const k = Object.keys(routes).find((x) => url.includes(x));
      if (!k) throw new Error('HTTP 404');
      return routes[k];
    };
    return { urls, fetchJson };
  };
  it('LRCLIB get has timed lyrics of the right length: one request, done', async () => {
    const f = fake({ '/api/get': { id: 7, trackName: 'Hello', artistName: 'Adele', albumName: '25', duration: 295, syncedLyrics: SYNC, plainLyrics: PLAIN } });
    const l = await findLyrics('Adele - Hello (Official Music Video)', 'AdeleVEVO', 296, f.fetchJson);
    expect(f.urls).toHaveLength(1);
    expect(l).toMatchObject({ artist: 'Adele', title: 'Hello', album: '25', synced: true, source: 'LRCLIB', id: 7 });
    expect(l!.lines.map((x) => x.start)).toEqual([12.5, 16, 20, 40.1]);
    expect(l!.plain).toBeUndefined();
  });
  it('get says 404: the search finds it; timed lyrics win over plain ones; another length\'s timings are not used', async () => {
    const f = fake({ '/api/search?track_name=Hello&artist_name=Adele': [
      { id: 1, trackName: 'Hello', artistName: 'Adele', duration: 295, plainLyrics: PLAIN },
      { id: 2, trackName: 'Hello', artistName: 'Adele', duration: 367, syncedLyrics: SYNC }, // (the long video version: its times do not fit)
      { id: 3, trackName: 'Hello', artistName: 'Adele', duration: 297, syncedLyrics: SYNC },
      { id: 4, trackName: 'Hello', artistName: 'Lionel Richie', duration: 250, syncedLyrics: '[00:01.00] Hello, is it me you\'re looking for' },
      { id: 5, trackName: 'Hello (instrumental)', artistName: 'Adele', duration: 295, instrumental: true },
    ] });
    const l = await findLyrics('Adele - Hello', '', 295, f.fetchJson);
    expect(f.urls.map((u) => (u.includes('/api/get') ? 'get' : 'search'))).toEqual(['get', 'search']);
    expect(l!.id).toBe(3);
    expect(l!.synced).toBe(true);
  });
  it('only plain lyrics at LRCLIB: they are taken (no length check), the text is kept to be timed; lyrics.ovh is not asked', async () => {
    const f = fake({ '/api/search?track_name=Hello&artist_name=Adele': [{ id: 1, trackName: 'Hello', artistName: 'Adele', duration: 200, plainLyrics: PLAIN }] });
    const l = await findLyrics('Adele - Hello', '', 295, f.fetchJson);
    expect(l).toMatchObject({ synced: false, source: 'LRCLIB', timing: 'spread', plain: PLAIN });
    expect(l!.lines).toHaveLength(5);
    expect(f.urls.some((u) => u.includes('lyrics.ovh'))).toBe(false);
  });
  it('nothing at LRCLIB (every spelling tried): lyrics.ovh gives plain lyrics', async () => {
    const f = fake({ 'api.lyrics.ovh/v1/Adele/Hello': { lyrics: `Paroles de la chanson Hello par Adele\r\n${PLAIN.replace(/\n/g, '\r\n')}` } });
    const l = await findLyrics('Adele - Hello', '', 295, f.fetchJson);
    expect(f.urls.filter((u) => u.includes('lrclib.net')).length).toBeGreaterThanOrEqual(4);
    expect(f.urls[f.urls.length - 1]).toBe('https://api.lyrics.ovh/v1/Adele/Hello');
    expect(l).toMatchObject({ artist: 'Adele', title: 'Hello', synced: false, source: 'lyrics.ovh' });
    expect(l!.lines[0].text).toBe('Hello, it\'s me');
    expect(cleanOvh('Paroles de la chanson X par Y\nLine one\n\n\n\nLine two')).toBe('Line one\n\nLine two');
    for (const u of f.urls) expect(u).toMatch(/^https:\/\/(lrclib\.net\/api|api\.lyrics\.ovh\/v1)\//);
  });
  it('another song with a like name, or another artist\'s song, is not taken; nothing anywhere = null', async () => {
    const f = fake({ '/api/search': [
      { id: 1, trackName: 'Goodbye', artistName: 'Adele', duration: 295, syncedLyrics: SYNC },
      { id: 2, trackName: 'Hello', artistName: 'Lionel Richie', duration: 250, syncedLyrics: SYNC },
    ] });
    expect(await findLyrics('Adele - Hello', '', 295, f.fetchJson)).toBeNull();
    expect(await findLyrics('Some talk show clip', '', 300, async () => [])).toBeNull();
    expect(await findLyrics('', '', 300, async () => { throw new Error('never asked'); })).toBeNull();
  });
  it('the channel was not the artist: the song of that very name and length is still found', async () => {
    const f = fake({ '/api/search?track_name=Hello': [
      { id: 2, trackName: 'Hello', artistName: 'Lionel Richie', duration: 250, syncedLyrics: SYNC },
      { id: 3, trackName: 'Hello', artistName: 'Adele', duration: 296, syncedLyrics: SYNC },
    ] });
    const l = await findLyrics('Hello', 'Some Lyrics Channel', 295, f.fetchJson);
    expect(l!.id).toBe(3);
  });
  it('the names from the AI are used instead of the title\'s rules; tests can give other addresses', async () => {
    const f = fake({ '/api/get?artist_name=Leonard%20Cohen&track_name=Hallelujah': { id: 9, trackName: 'Hallelujah', artistName: 'Leonard Cohen', duration: 275, syncedLyrics: SYNC } });
    const l = await findLyrics('the best song ever made (you will cry)', 'Random Uploads', 276, f.fetchJson, { names: { artist: 'Leonard Cohen', title: 'Hallelujah' }, base: { lrclib: 'http://localhost:8825/lrclib/', ovh: 'http://localhost:8825/ovh' } });
    expect(f.urls[0]).toBe('http://localhost:8825/lrclib/api/get?artist_name=Leonard%20Cohen&track_name=Hallelujah&duration=276');
    expect(l!.id).toBe(9);
  });
});

describe('lyrics without times are put in time with the song', () => {
  const TEXT = 'I walk along the river in the morning\nThe water sings a song I used to know\n\nCarry me home, carry me home\nOver the hills where the wild winds blow\n\nI packed my bag and I left the city\nNobody saw me, nobody cried';
  it('spread over the song: after an intro of 8%, by the number of words, a short gap between verses', () => {
    const l = spreadPlain(TEXT, 200);
    expect(l).toHaveLength(6);
    expect(l[0].start).toBeCloseTo(16, 5); // 8% of 200
    expect(l[5].end).toBeCloseTo(194, 5);
    expect(l[1].start).toBeCloseTo(l[0].end, 5);
    expect(l[2].start).toBeGreaterThan(l[1].end + 0.5); // a new verse
    expect(l[2].verse).toBe(1);
    // more words = more time
    const short = spreadPlain('One\nTwo three four five six seven', 100);
    expect(short[1].end - short[1].start).toBeGreaterThan((short[0].end - short[0].start) * 2.5);
    expect(spreadPlain('', 100)).toEqual([]);
    expect(plainLines('[Verse 1]\nA\n(Chorus x2)\nB').map((x) => [x.text, x.verse])).toEqual([['A', 0], ['B', 1]]);
  });
  // the song as it is really sung: each line's start, 0.4 s a word
  const truth = [20, 26, 40, 46, 70, 76];
  const heard = (mishear: (w: string, i: number) => string | null): CaptionWord[] => {
    const out: CaptionWord[] = [];
    let n = 0;
    plainLines(TEXT).forEach((l, li) => l.text.split(' ').forEach((w, k) => { const x = mishear(w, n++); if (x) out.push({ w: x, t: truth[li] + k * 0.4, e: truth[li] + k * 0.4 + 0.35 }); }));
    return out;
  };
  it('matched to the captions\' words: every line starts where it is sung', () => {
    const a = alignToCaptions(TEXT, heard((w) => w), 120)!;
    expect(a).toHaveLength(6);
    a.forEach((l, i) => expect(Math.abs(l.start - truth[i])).toBeLessThan(0.5));
    expect(a.map((l) => l.verse)).toEqual([0, 0, 1, 1, 2, 2]);
    for (let i = 1; i < a.length; i++) { expect(a[i].start).toBeGreaterThan(a[i - 1].start); expect(a[i - 1].end).toBeLessThanOrEqual(a[i].start + 1e-9); }
  });
  it('misheard and missing words are tolerated; a line that was not heard at all goes between its neighbours', () => {
    // every third word is wrong, every seventh is missing, and the whole 4th line is missing
    const caps = heard((w, i) => (i >= 21 && i <= 27 ? null : i % 7 === 6 ? null : i % 3 === 2 ? 'banana' : w.toLowerCase().replace(/[,.]/g, '')));
    const a = alignToCaptions(TEXT, caps, 120)!;
    expect(a).not.toBeNull();
    [0, 1, 2, 4, 5].forEach((i) => expect(Math.abs(a[i].start - truth[i])).toBeLessThan(1.5));
    expect(a[3].start).toBeGreaterThan(a[2].start);
    expect(a[3].start).toBeLessThan(a[4].start);
  });
  it('captions that are about something else (or too few): not trusted, the lines are spread', () => {
    const other = 'welcome back to my channel today we are going to cook a very nice soup with onions and a lot of garlic so please like and subscribe'.split(' ').map((w, i) => ({ w, t: i * 0.5 }));
    expect(alignToCaptions(TEXT, other, 120)).toBeNull();
    expect(alignToCaptions(TEXT, [], 120)).toBeNull();
    expect(timePlain(TEXT, other, 120).timing).toBe('spread');
    expect(timePlain(TEXT, heard((w) => w), 120).timing).toBe('captions');
  });
  it('caption sentences without word times: their words are spread over the sentence', () => {
    const w = captionWords([{ start: 10, end: 12, text: 'carry me home now' }, { start: 20, end: 21, text: 'x', words: [{ w: 'over', t: 20.2, e: 20.5 }] }]);
    expect(w.map((x) => [x.w, x.t])).toEqual([['carry', 10], ['me', 10.5], ['home', 11], ['now', 11.5], ['over', 20.2]]);
  });
  it('the status line says where the lyrics come from and when the timing is a guess', () => {
    expect(lyricsNote({ source: 'LRCLIB', synced: true })).toBe('lyrics from LRCLIB');
    expect(lyricsNote({ source: 'lyrics.ovh', synced: false, timing: 'spread' })).toBe('lyrics from lyrics.ovh, timing guessed');
    expect(lyricsNote({ source: 'LRCLIB', synced: false, timing: 'captions' })).toBe('lyrics from LRCLIB, timing guessed (from the captions)');
    expect(lyricsNote({ source: 'pasted', synced: false, timing: 'spread' })).toBe('your own lyrics, timing guessed');
  });
});

describe('the page\'s side: found once per video, kept; the AI names the song at most once', () => {
  let stored: Record<string, unknown> = {};
  beforeEach(() => {
    stored = {};
    (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: {
      get: async (k: string) => (k in stored ? { [k]: JSON.parse(JSON.stringify(stored[k])) } : {}),
      set: async (o: Record<string, unknown>) => { Object.assign(stored, JSON.parse(JSON.stringify(o))); },
      remove: async (keys: string[]) => { for (const k of keys) delete stored[k]; },
    } } };
  });
  afterEach(() => { delete (globalThis as unknown as { chrome?: unknown }).chrome; });
  const SYNCED: Lyrics = { artist: 'Adele', title: 'Hello', lines: [{ start: 12, end: 16, text: 'Hello, it\'s me', verse: 0 }, { start: 16, end: 20, text: 'I was wondering', verse: 0 }], synced: true, source: 'LRCLIB' };
  const PLAIN_TEXT = 'Carry me home, carry me home\nOver the hills where the wild winds blow\nI packed my bag and I left the city\nNobody saw me, nobody cried';
  const PLAIN: Lyrics = { artist: 'X', title: 'Carry Me Home', lines: spreadPlain(PLAIN_TEXT, 100), synced: false, source: 'lyrics.ovh', plain: PLAIN_TEXT, timing: 'spread' };
  const setup = (over: Partial<FindSongDeps>, answer: (msg: Record<string, unknown>) => Lyrics | null, aiReply = '{"artist":"Leonard Cohen","song":"Hallelujah"}') => {
    const asked: Record<string, unknown>[] = [];
    const ai: string[] = [];
    const deps: FindSongDeps = {
      videoId: 'songsong001', title: 'Adele - Hello (Official Music Video)', channel: 'AdeleVEVO', duration: 295, description: 'From the album 25.', captions: [], tutorOn: true,
      complete: async (p) => { ai.push(p.user); return aiReply; },
      ask: async (msg) => { asked.push(msg); return { ok: true, lyrics: answer(msg), reached: true }; },
      hasKey: async () => true, now: () => 1_000_000, ...over,
    };
    return { deps, asked, ai };
  };
  it('the rules find the song: no AI; the second time nothing is asked at all (kept per video)', async () => {
    const s = setup({}, () => SYNCED);
    const a = await findSongLyrics(s.deps);
    expect(a).toMatchObject({ from: 'found', aiAsked: false });
    expect(a.lyrics).toEqual(SYNCED);
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ type: 'dream-lyrics', title: 'Adele - Hello (Official Music Video)', channel: 'AdeleVEVO', duration: 295 });
    expect(s.ai).toHaveLength(0);
    const b = await findSongLyrics(s.deps);
    expect(b).toMatchObject({ from: 'kept', aiAsked: false });
    expect(b.lyrics).toEqual(SYNCED);
    expect(s.asked).toHaveLength(1);
    expect((await loadSongRecord('songsong001'))!.lyrics!.source).toBe('LRCLIB');
  });
  it('the rules find nothing and the tutor is on: ONE AI request names the song, the search runs again with it; never asked twice', async () => {
    const s = setup({ title: 'the best song ever made (you will cry)', channel: 'Random Uploads' }, (msg) => (msg.song === 'Hallelujah' && msg.artist === 'Leonard Cohen' ? SYNCED : null));
    const a = await findSongLyrics(s.deps);
    expect(a).toMatchObject({ from: 'found', aiAsked: true });
    expect(s.ai).toHaveLength(1);
    expect(s.ai[0]).toContain('From the album 25.');
    expect(s.asked).toHaveLength(2);
    // nothing found even with the AI's name: the name is kept, so the AI is not asked again for this video
    const t = setup({ videoId: 'songsong002', title: 'a strange title', channel: 'Random Uploads' }, () => null);
    expect(await findSongLyrics(t.deps)).toMatchObject({ lyrics: null, from: 'none', aiAsked: true });
    expect(await findSongLyrics({ ...t.deps, now: () => 1_000_000 + 13 * 3600 * 1000 })).toMatchObject({ lyrics: null, aiAsked: false });
    expect(t.ai).toHaveLength(1);
    // (and for half a day the sources are not asked again either)
    const n = t.asked.length;
    await findSongLyrics({ ...t.deps, now: () => 1_000_000 + 60_000 });
    expect(t.asked).toHaveLength(n);
  });
  it('the tutor is off, there is no key, or the learner already left lyrics mode: no AI request', async () => {
    for (const over of [{ tutorOn: false }, { hasKey: async () => false }, { alive: () => false }] as Partial<FindSongDeps>[]) {
      stored = {};
      const s = setup({ title: 'a strange title', channel: 'Random Uploads', ...over }, () => null);
      expect(await findSongLyrics(s.deps)).toMatchObject({ lyrics: null, from: 'none', aiAsked: false });
      expect(s.ai).toHaveLength(0);
    }
  });
  it('the AI said "not a song": that is kept too; a failed AI request is not an answer', async () => {
    const s = setup({ title: 'a strange title', channel: 'Random Uploads' }, () => null, '{"artist":"","song":""}');
    await findSongLyrics(s.deps);
    expect((await loadSongRecord('songsong001'))!.aiName).toBeNull();
    stored = {};
    const f = setup({ title: 'a strange title', channel: 'Random Uploads', complete: async () => { throw new Error('offline'); } }, () => null);
    await findSongLyrics(f.deps);
    expect((await loadSongRecord('songsong001'))!.aiName).toBeUndefined();
  });
  it('no internet (the services were not reached): "nothing found" is not kept', async () => {
    const s = setup({ ask: async () => ({ ok: true, lyrics: null, reached: false }), tutorOn: false }, () => null);
    await findSongLyrics(s.deps);
    expect(await loadSongRecord('songsong001')).toBeNull();
  });
  it('plain lyrics are timed with the video\'s captions when they match, else spread ("timing guessed")', async () => {
    const captions = [
      { start: 30, end: 34, text: 'carry me home carry me home' }, { start: 36, end: 40, text: 'over the hills where the wild winds blow' },
      { start: 50, end: 54, text: 'i packed my bag and i left the city' }, { start: 56, end: 60, text: 'nobody saw me nobody cried' },
    ];
    const s = setup({ captions, duration: 100 }, () => PLAIN);
    const a = await findSongLyrics(s.deps);
    expect(a.lyrics!.timing).toBe('captions');
    expect(a.lyrics!.lines.map((l) => Math.round(l.start))).toEqual([30, 36, 50, 56]);
    expect(lyricsNote(a.lyrics!)).toBe('lyrics from lyrics.ovh, timing guessed (from the captions)');
    expect(withTimes(PLAIN, [], 100).timing).toBe('spread');
    expect(withTimes(SYNCED, captions, 100)).toBe(SYNCED);
  });
  it('pasted lyrics: timed the same way, kept for this video, used the next time; "[mm:ss]" lines keep their own times', async () => {
    const base = { videoId: 'songsong003', title: 'X - Carry Me Home', channel: '', duration: 100, captions: [] };
    expect(await usePastedLyrics({ ...base, text: '   \n ' })).toBeNull();
    const a = await usePastedLyrics({ ...base, text: `[Verse 1]\n${PLAIN_TEXT}` });
    expect(a).toMatchObject({ artist: 'X', title: 'Carry Me Home', source: 'pasted', synced: false, timing: 'spread' });
    expect(a!.lines).toHaveLength(4);
    const s = setup({ videoId: 'songsong003' }, () => { throw new Error('not asked'); });
    expect(await findSongLyrics(s.deps)).toMatchObject({ from: 'kept', lyrics: { source: 'pasted' } });
    const b = await usePastedLyrics({ ...base, text: '[00:10.00] Carry me home\n[00:14.50] Over the hills\n[00:20.00] I packed my bag' });
    expect(b).toMatchObject({ synced: true, source: 'pasted' });
    expect(b!.lines.map((l) => l.start)).toEqual([10, 14.5, 20]);
    expect(lyricsNote(b!)).toBe('your own lyrics');
  });
  it('the lines as the page\'s sentences: a new part at a new verse, or where the sections say', () => {
    const lyr: Lyrics = { ...SYNCED, lines: [{ start: 1, end: 2, text: 'a', verse: 0 }, { start: 2, end: 3, text: 'b', verse: 0 }, { start: 3, end: 4, text: 'c', verse: 1 }] };
    expect(lyricSentences(lyr).map((s) => s.para)).toEqual([true, false, true]);
    expect(lyricSentences(lyr, new Set([0, 1])).map((s) => s.para)).toEqual([true, true, false]);
  });
});
