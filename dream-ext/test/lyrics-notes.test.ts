import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Lyrics } from '../src/lyrics';
import {
  buildSongPrompt, parseSongReply, tidySections, askSongNotes, notesByLine, sectionStarts, songContext, noteIsEnough,
  loadSongNotes, saveSongNotes, dropSongNotes, type SongNotes,
} from '../src/lyrics-notes';

const TEXTS = [
  'I walk along the river in the morning', 'The water sings a song I used to know',
  'Carry me home, carry me home', 'Over the hills where the wild winds blow',
  'I packed my bag and I left the city', 'Nobody saw me, nobody cried',
  'Carry me home, carry me home', 'Over the hills where the wild winds blow',
  'Paper boats on a silver sea', 'Carry me home',
];
const LYR: Lyrics = { artist: 'The Testers', title: 'Paper Boats', album: 'Rivers', synced: true, source: 'LRCLIB', lines: TEXTS.map((text, i) => ({ start: 10 + i * 5, end: 15 + i * 5, text, verse: Math.floor(i / 2) })) };
const GOOD = {
  about: 'This song is about going back home after a long time in the city. The singer feels small and tired, and the river and the hills are the places of their childhood.',
  sections: [{ from: 1, to: 2, name: 'Verse 1' }, { from: 3, to: 4, name: 'Chorus' }, { from: 5, to: 6, name: 'Verse 2' }, { from: 7, to: 8, name: 'Chorus' }, { from: 9, to: 10, name: 'Outro' }],
  notes: [
    { line: 2, note: 'The river is like an old friend. Its sound brings back a song from when the singer was a child.' },
    { line: 3, note: 'This is the heart of the song: the singer asks to be taken home, like a tired child.' },
    { line: 6, note: 'Nobody noticed when they left. It shows how alone they felt in the city.' },
    { line: 9, note: '"Paper boats" are small and weak, like the singer\'s hopes on a big sea.' },
  ],
};

describe('the one AI request of a song', () => {
  it('the prompt: the song, its numbered lines, the three things, own words, strict JSON', () => {
    const p = buildSongPrompt(LYR, 'B2');
    expect(p.user).toContain('"Paper Boats" by The Testers, from the album "Rivers"');
    expect(p.user).toContain('1. I walk along the river in the morning');
    expect(p.user).toContain('10. Carry me home');
    expect(p.user).toMatch(/"about":[^]*80 to 140 words/);
    expect(p.user).toMatch(/"sections":[^]*Intro, Verse 1, Verse 2, Pre-Chorus, Chorus/);
    expect(p.user).toMatch(/chorus by its repeated lines/);
    expect(p.user).toMatch(/"notes":[^]*8 to 16 lines/);
    expect(p.user).toMatch(/Write your own words\. Do not reproduce annotations/);
    expect(p.user).toMatch(/quote at most a few words of a line/);
    expect(p.system).toMatch(/level is about B2/);
    expect(p.system).toMatch(/JSON only/);
  });
  it('strict JSON: about, the parts (lines from 0), the notes by line', () => {
    const n = parseSongReply(JSON.stringify(GOOD), 10)!;
    expect(n.about).toMatch(/^This song is about going back home/);
    expect(n.sections).toEqual([{ from: 0, to: 1, name: 'Verse 1' }, { from: 2, to: 3, name: 'Chorus' }, { from: 4, to: 5, name: 'Verse 2' }, { from: 6, to: 7, name: 'Chorus' }, { from: 8, to: 9, name: 'Outro' }]);
    expect(Object.keys(n.notes).map(Number)).toEqual([1, 2, 5, 8]);
    expect(n.notes[2]).toMatch(/heart of the song/);
    expect(n.lines).toBe(10);
  });
  it('code fences and text around it; other key names; brackets in the names', () => {
    const n = parseSongReply('Here you go:\n```json\n' + JSON.stringify(GOOD, null, 2) + '\n```\nEnjoy the song!', 10)!;
    expect(n.sections).toHaveLength(5);
    expect(Object.keys(n.notes)).toHaveLength(4);
    const m = parseSongReply('{"summary":"About it.","parts":[{"start":"1","end":"4","heading":"[Verse 1]"}],"annotations":[{"n":2,"text":"It means the river is a friend of the singer."}]}', 10)!;
    expect(m).toMatchObject({ about: 'About it.', sections: [{ from: 0, to: 3, name: 'Verse 1' }], notes: { 1: 'It means the river is a friend of the singer.' } });
  });
  it('a cut-off answer keeps what is complete: about, every finished part and note', () => {
    const full = JSON.stringify(GOOD);
    const cut = full.slice(0, full.indexOf('"line":6') + 30); // (in the middle of the third note)
    const n = parseSongReply(cut, 10)!;
    expect(n.about).toMatch(/^This song is about/);
    expect(n.sections).toHaveLength(5);
    expect(Object.keys(n.notes).map(Number)).toEqual([1, 2]);
    // cut inside "about": nothing complete
    expect(parseSongReply(full.slice(0, 60), 10)).toBeNull();
    // cut inside the parts: about + the finished parts
    const n2 = parseSongReply(full.slice(0, full.indexOf('"Verse 2"') - 20), 10)!;
    expect(n2.sections.map((s) => s.name)).toEqual(['Verse 1', 'Chorus']);
    expect(n2.notes).toEqual({});
  });
  it('garbage = null; lines outside the song and empty notes are dropped; at most 24 notes', () => {
    expect(parseSongReply('I am sorry, I cannot do that.', 10)).toBeNull();
    expect(parseSongReply('', 10)).toBeNull();
    expect(parseSongReply('{"about":"","sections":[],"notes":[]}', 10)).toBeNull();
    expect(parseSongReply('[1,2,3]', 10)).toBeNull();
    const n = parseSongReply(JSON.stringify({ about: 'x', notes: [{ line: 0, note: 'a' }, { line: 11, note: 'b' }, { line: 4, note: '' }, { line: 5, note: 'ok' }, { line: 5, note: 'again' }, { line: 'six', note: 'c' }] }), 10)!;
    expect(n.notes).toEqual({ 4: 'ok' });
    const many = parseSongReply(JSON.stringify({ about: 'x', notes: Array.from({ length: 40 }, (_, i) => ({ line: i + 1, note: 'n' })) }), 60)!;
    expect(Object.keys(many.notes)).toHaveLength(24);
  });
  it('the parts are put in order, inside the song, never one over another', () => {
    expect(tidySections([{ from: 4, to: 7, name: 'Chorus' }, { from: 0, to: 5, name: 'Verse 1' }, { from: 8, to: 30, name: '[Outro]' }, { from: 9, to: 9, name: 'Extra' }, { from: 3, to: 2, name: 'Bad' }], 10))
      .toEqual([{ from: 0, to: 5, name: 'Verse 1' }, { from: 6, to: 7, name: 'Chorus' }, { from: 8, to: 9, name: 'Outro' }]);
  });
  it('askSongNotes makes exactly one request; no lines = no request', async () => {
    let calls = 0;
    const n = await askSongNotes(LYR, 'B2', async () => { calls++; return JSON.stringify(GOOD); });
    expect(calls).toBe(1);
    expect(n!.sections).toHaveLength(5);
    expect(await askSongNotes({ ...LYR, lines: [] }, 'B2', async () => { calls++; return '{}'; })).toBeNull();
    expect(calls).toBe(1);
    expect(await askSongNotes(LYR, 'B2', async () => 'no idea')).toBeNull();
  });
});

describe('the notes on the page and at the stops (no AI)', () => {
  const notes = parseSongReply(JSON.stringify(GOOD), 10)!;
  it('a line that comes back (the chorus) has the same note each time; headings start the parts', () => {
    const by = notesByLine(notes, LYR);
    expect([...by.keys()].sort((a, b) => a - b)).toEqual([1, 2, 5, 6, 8]); // (line 7 says the same as line 3)
    expect(by.get(6)).toBe(by.get(2));
    expect(notesByLine(null, LYR).size).toBe(0);
    expect([...sectionStarts(notes)]).toEqual([[0, 'Verse 1'], [2, 'Chorus'], [4, 'Verse 2'], [6, 'Chorus'], [8, 'Outro']]);
  });
  it('what the explanations know: the story; for one line its own note; for the whole song all notes', () => {
    const one = songContext(notes, LYR, 5)!;
    expect(one).toMatch(/^This song is about going back home/);
    expect(one).toMatch(/About this line \("Nobody saw me, nobody cried"\): Nobody noticed when they left/);
    expect(one).not.toMatch(/Paper boats/);
    expect(songContext(notes, LYR, 0)).toBe(notes.about); // (a line without a note: the story only)
    expect(songContext(notes, LYR, -1)).toBe(notes.about);
    const all = songContext(notes, LYR)!;
    expect(all).toMatch(/What some lines mean:/);
    expect(all.match(/^- "/gm)).toHaveLength(4);
    expect(songContext(null, LYR)).toBeUndefined();
  });
  it('a note is read at a stop only when it really explains the line', () => {
    expect(noteIsEnough(notes.notes[2])).toBe(true);
    expect(noteIsEnough('Slang for money.')).toBe(false);
    expect(noteIsEnough(undefined)).toBe(false);
  });
});

describe('the notes are kept with the song', () => {
  let stored: Record<string, unknown> = {};
  beforeEach(() => {
    stored = {};
    (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: {
      get: async (k: string) => (k in stored ? { [k]: JSON.parse(JSON.stringify(stored[k])) } : {}),
      set: async (o: Record<string, unknown>) => { Object.assign(stored, JSON.parse(JSON.stringify(o))); },
      remove: async (keys: string | string[]) => { for (const k of [].concat(keys as never)) delete stored[k]; },
    } } };
  });
  afterEach(() => { delete (globalThis as unknown as { chrome?: unknown }).chrome; });
  it('saved and read back the same; other lyrics (another number of lines) = no notes; dropped when new lyrics are pasted', async () => {
    const notes: SongNotes = parseSongReply(JSON.stringify(GOOD), 10)!;
    expect(await loadSongNotes('vid00000001~lyrics', 10)).toBeNull();
    await saveSongNotes('vid00000001~lyrics', notes);
    expect(await loadSongNotes('vid00000001~lyrics', 10)).toEqual(notes);
    expect(await loadSongNotes('vid00000001~lyrics', 12)).toBeNull();
    expect(await loadSongNotes('other000001~lyrics', 10)).toBeNull();
    await dropSongNotes('vid00000001~lyrics');
    expect(await loadSongNotes('vid00000001~lyrics', 10)).toBeNull();
  });
});
