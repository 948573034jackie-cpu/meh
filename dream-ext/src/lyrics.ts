/**
 * Lyrics mode: a song's lyrics, found by the video's title. LRCLIB (lrclib.net, free, no key) has lyrics with
 * timestamps ("synced lyrics"): each line knows when it is sung, so the page follows the song like the subtitles do.
 * Without timestamps the lines are spread over the song by their length (the page still follows, roughly).
 * The lyrics are only fetched and shown on the learner's own device, for their own study.
 */

export interface LyricLine { start: number; end: number; text: string; verse: number }
export interface Lyrics { artist: string; title: string; album?: string; lines: LyricLine[]; synced: boolean; source: string; id?: number }

/** "Artist - Title (Official Music Video) [HD]" -> { artist: "Artist", title: "Title" } */
export function songOf(videoTitle: string, channel = ''): { artist: string; title: string } {
  let t = videoTitle.replace(/\s+-\s+YouTube$/i, '');
  // the extras YouTube titles carry
  t = t.replace(/[([](?:[^)\]]*?(?:official|video|audio|lyric|lyrics|visuali[sz]er|hd|4k|remaster(?:ed)?|live|mv|m\/v|explicit|clean|color coded)[^)\]]*?)[)\]]/gi, ' ');
  t = t.replace(/\b(?:official (?:music )?video|official audio|lyric video|lyrics?)\b/gi, ' ');
  t = t.replace(/\s*\|.*$/, '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  const dash = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  let artist = dash ? dash[1] : channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  let title = dash ? dash[2] : t;
  title = title.replace(/\s*(?:ft\.?|feat\.?|featuring)\s.+$/i, '').trim();
  artist = artist.replace(/\s*(?:ft\.?|feat\.?|featuring|&|,|\bx\b)\s.+$/i, '').trim();
  return { artist, title };
}

/** "[01:02.34] text" lines -> timed lines; a blank line or a verse marker starts a new verse */
export function parseLrc(lrc: string, duration = 0): LyricLine[] {
  const out: { start: number; text: string; verse: number }[] = [];
  let verse = 0, gap = false;
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!stamps.length) { if (!text) gap = true; continue; }
    if (!text) { gap = true; continue; }
    if (gap && out.length) verse++;
    gap = false;
    for (const s of stamps) out.push({ start: Number(s[1]) * 60 + Number(s[2]) + (s[3] ? Number(`0.${s[3]}`) : 0), text, verse });
  }
  out.sort((a, b) => a.start - b.start);
  return out.map((l, i) => ({ ...l, end: i + 1 < out.length ? out[i + 1].start : Math.max(l.start + 4, duration || l.start + 4) }));
}

/** Lyrics without times: spread over the song by the length of each line (after a short intro). */
export function spreadPlain(text: string, duration: number): LyricLine[] {
  const lines: { text: string; verse: number }[] = [];
  let verse = 0, gap = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) { gap = true; continue; }
    if (/^\[[^\]]+\]$/.test(t)) { gap = true; continue; } // [Chorus], [Verse 2]
    if (gap && lines.length) verse++;
    gap = false;
    lines.push({ text: t, verse });
  }
  if (!lines.length) return [];
  const total = Math.max(30, duration || 180);
  const from = Math.min(10, total * 0.05), to = total * 0.97;
  const weight = lines.map((l) => 2 + l.text.length);
  const sum = weight.reduce((a, b) => a + b, 0);
  let at = from;
  return lines.map((l, i) => {
    const len = ((to - from) * weight[i]) / sum;
    const line = { start: at, end: at + len, text: l.text, verse: l.verse };
    at += len;
    return line;
  });
}

interface LrclibHit { id: number; trackName: string; artistName: string; albumName?: string; duration?: number; instrumental?: boolean; plainLyrics?: string | null; syncedLyrics?: string | null }

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** how well a hit fits the song: the same title, the same artist, about the same length */
export function hitScore(h: Pick<LrclibHit, 'trackName' | 'artistName' | 'duration' | 'syncedLyrics' | 'plainLyrics'>, want: { artist: string; title: string; duration: number }): number {
  let s = 0;
  const t = norm(h.trackName), wt = norm(want.title);
  if (t === wt) s += 4; else if (t.includes(wt) || wt.includes(t)) s += 2;
  const a = norm(h.artistName), wa = norm(want.artist);
  if (wa && (a === wa || a.includes(wa) || wa.includes(a))) s += 3;
  if (want.duration && h.duration) { const d = Math.abs(h.duration - want.duration); s += d <= 2 ? 3 : d <= 8 ? 1.5 : d > 30 ? -3 : 0; }
  if (h.syncedLyrics) s += 1;
  if (!h.syncedLyrics && !h.plainLyrics) s -= 10;
  return s;
}

/**
 * The lyrics of this video's song from LRCLIB, or null. `fetchJson` is the app's own way to fetch (the background
 * page in Chrome, Swift on the iPhone).
 */
export async function findLyrics(videoTitle: string, channel: string, duration: number, fetchJson: (url: string) => Promise<unknown>): Promise<Lyrics | null> {
  const want = { ...songOf(videoTitle, channel), duration };
  if (!want.title) return null;
  const tries = [
    `https://lrclib.net/api/search?track_name=${encodeURIComponent(want.title)}${want.artist ? `&artist_name=${encodeURIComponent(want.artist)}` : ''}`,
    `https://lrclib.net/api/search?q=${encodeURIComponent(`${want.artist} ${want.title}`.trim())}`,
  ];
  let best: LrclibHit | null = null, bestScore = -Infinity;
  for (const url of tries) {
    let hits: LrclibHit[] = [];
    try { hits = ((await fetchJson(url)) as LrclibHit[]) ?? []; } catch { continue; }
    for (const h of Array.isArray(hits) ? hits : []) {
      if (h.instrumental) continue;
      const sc = hitScore(h, want);
      if (sc > bestScore) { best = h; bestScore = sc; }
    }
    if (best && bestScore >= 7) break;
  }
  if (!best || bestScore < 4) return null;
  const lines = best.syncedLyrics ? parseLrc(best.syncedLyrics, duration) : spreadPlain(best.plainLyrics ?? '', duration);
  if (!lines.length) return null;
  return { artist: best.artistName, title: best.trackName, album: best.albumName, lines, synced: !!best.syncedLyrics, source: 'LRCLIB', id: best.id };
}
