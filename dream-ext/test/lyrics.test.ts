import { describe, it, expect } from 'vitest';
import { songOf, parseLrc, spreadPlain, hitScore, findLyrics } from '../src/lyrics';

describe('lyrics mode: finding the song', () => {
  it('the artist and the title from a YouTube title', () => {
    expect(songOf('Adele - Hello (Official Music Video)')).toEqual({ artist: 'Adele', title: 'Hello' });
    expect(songOf('Ed Sheeran - Shape of You [Official Video]')).toEqual({ artist: 'Ed Sheeran', title: 'Shape of You' });
    expect(songOf('Bohemian Rhapsody (Remastered 2011)', 'Queen - Topic')).toEqual({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    expect(songOf('Calvin Harris - Summer ft. Someone | Lyrics')).toEqual({ artist: 'Calvin Harris', title: 'Summer' });
  });
  it('synced lyrics: each line with its time, verses from the blank lines', () => {
    const l = parseLrc('[00:12.50] Hello, it\'s me\n[00:16.00] I was wondering\n\n[00:40.10] Hello from the other side', 60);
    expect(l.map((x) => [x.start, x.text, x.verse])).toEqual([[12.5, "Hello, it's me", 0], [16, 'I was wondering', 0], [40.1, 'Hello from the other side', 1]]);
    expect(l[0].end).toBe(16);
    expect(l[2].end).toBe(60);
  });
  it('plain lyrics: spread over the song, [Chorus] marks a new verse', () => {
    const l = spreadPlain('[Verse 1]\nOne line\nAnother line here\n\n[Chorus]\nSing it', 120);
    expect(l).toHaveLength(3);
    expect(l[2].verse).toBe(1);
    expect(l[0].start).toBeGreaterThan(0);
    expect(l[2].end).toBeLessThanOrEqual(120);
    // (3.8: the lines of a verse follow each other; a new verse comes after a short gap)
    expect(l[1].start).toBeCloseTo(l[0].end, 5);
    expect(l[2].start).toBeGreaterThan(l[1].end);
  });
  it('the best hit: same title and artist, about the same length, with times', () => {
    const want = { artist: 'Adele', title: 'Hello', duration: 295 };
    const good = hitScore({ trackName: 'Hello', artistName: 'Adele', duration: 295, syncedLyrics: '[00:01.00] x' }, want);
    const cover = hitScore({ trackName: 'Hello', artistName: 'Some Cover Band', duration: 200, plainLyrics: 'x' }, want);
    expect(good).toBeGreaterThan(cover);
  });
  it('findLyrics asks LRCLIB and returns the timed lines of the best hit', async () => {
    const urls: string[] = [];
    const lyr = await findLyrics('Adele - Hello (Official Music Video)', '', 295, async (url) => {
      urls.push(url);
      return [{ id: 1, trackName: 'Hello', artistName: 'Adele', duration: 295, syncedLyrics: '[00:01.00] Hello, it\'s me\n[00:05.00] I was wondering' }];
    });
    // (3.8: LRCLIB's `get` by artist + track + length is asked first, then its search)
    expect(urls[0]).toContain('lrclib.net/api/get?artist_name=Adele&track_name=Hello&duration=295');
    expect(lyr?.synced).toBe(true);
    expect(lyr?.lines.map((l) => l.text)).toEqual(["Hello, it's me", 'I was wondering']);
    expect(await findLyrics('Some talk show clip', '', 300, async () => [])).toBeNull();
  });
});
