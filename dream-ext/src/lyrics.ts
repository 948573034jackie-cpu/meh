/**
 * Lyrics mode: the right lyrics for a song video.
 * 1. The real song: the video's title is cleaned by rules ("Artist - Song (Official Video) [4K] ft. X" -> artist +
 *    song; "Song by Artist"; the channel as the artist). Only when that finds nothing, the AI is asked once
 *    (lyrics-find.ts) and its answer comes in here as `names`.
 * 2. The sources, in order, stopping at the first good match: LRCLIB `get` (artist + track + length), LRCLIB `search`
 *    with several spellings, lyrics with timings first, then LRCLIB's plain lyrics, then lyrics.ovh (plain). Both are
 *    free, public APIs without a key. No lyrics website is ever read or copied (not Genius, AZLyrics or Musixmatch).
 *    A match must fit the song's title and, for timed lyrics, the video's length.
 * 3. Lyrics without timings are put in time with the song: matched to the words of YouTube's automatic captions when
 *    there are any (alignToCaptions), otherwise spread over the song (spreadPlain). Both are "timing guessed".
 * The lyrics are only fetched and shown on the learner's own device, for their own study.
 */

export interface LyricLine { start: number; end: number; text: string; verse: number }
export interface Lyrics {
  artist: string; title: string; album?: string; lines: LyricLine[];
  /** the times come from the source (LRCLIB's synced lyrics) */
  synced: boolean;
  /** 'LRCLIB' | 'lyrics.ovh' | 'pasted' */
  source: string;
  id?: number;
  /** lyrics without times: the text as it came (so it can be timed with the captions), and how it was timed */
  plain?: string;
  timing?: 'captions' | 'spread';
}
export interface SongName { artist: string; title: string }

// ---------- 1. the real song, by rules ----------

/** words in ( ) or [ ] that are about the video, not the song */
const NOISE = /official|video|audio|lyric|visuali[sz]er|\bhd\b|\bhq\b|\b[48]k\b|\buhd\b|remaster|\blive\b|\bmv\b|m\/v|explicit|clean|colou?r coded|\bversion\b|\bedit\b|\bprod\b|\bft\b|\bfeat\b|featuring|\bwith lyrics\b|\bfull\b|\bsub(?:title)?s?\b|\b(?:19|20)\d\d\b|\bost\b|soundtrack|\bcover\b|\bkaraoke\b|\binstrumental\b|\bsped up\b|\bslowed\b|\breverb\b|\bbonus\b|\bdeluxe\b|\bsingle\b|\bout now\b|\bpremiere\b/i;

/** a channel's name as an artist: "Queen - Topic" -> Queen, "AdeleVEVO" -> Adele, "EdSheeranVEVO" -> Ed Sheeran */
export function artistOfChannel(channel: string): string {
  let c = String(channel ?? '').trim();
  c = c.replace(/\s*-\s*Topic$/i, '');
  if (/vevo$/i.test(c)) { c = c.replace(/\s*vevo$/i, ''); if (!/\s/.test(c)) c = c.replace(/([a-z])([A-Z])/g, '$1 $2'); }
  c = c.replace(/\s+(?:official(?:\s+(?:channel|music|youtube))?|music|tv|records|channel)$/i, '').replace(/^official\s+/i, '');
  return c.trim();
}

const stripFeat = (s: string): string => s.replace(/\s*[([]?\s*\b(?:ft\.?|feat\.?|featuring)\s.+$/i, '').trim();
/** "A, B" / "A x B" -> A (a duo's "&" stays: "Simon & Garfunkel"; soloArtist() cuts there for another spelling) */
const firstArtist = (s: string): string => stripFeat(s).replace(/\s*(?:,|\bx\b|\bvs\.?\b)\s.+$/i, '').trim();
export const soloArtist = (s: string): string => s.split(/\s*(?:&|\band\b|\bwith\b|,)\s*/i)[0].trim();

/**
 * "Artist - Title (Official Music Video) [4K] ft. X" -> { artist: "Artist", title: "Title" }. `clear` (songIsClear)
 * says whether a pattern was found, or the artist is only a guess from the channel's name.
 */
export function songOf(videoTitle: string, channel = ''): SongName {
  return songParts(videoTitle, channel).name;
}
/** the rules found the song by a pattern of the title or by a music channel (not only a guess) */
export function songIsClear(videoTitle: string, channel = ''): boolean {
  const p = songParts(videoTitle, channel);
  return p.clear && !!p.name.artist && !!p.name.title;
}

function songParts(videoTitle: string, channel: string): { name: SongName; clear: boolean } {
  let t = String(videoTitle ?? '').replace(/\s+-\s+YouTube$/i, '');
  const topic = /\s-\sTopic$/i.test(channel.trim());
  const musicChannel = topic || /vevo$/i.test(channel.trim());
  // quotes first: Artist "Song" / Artist - "Song" (before the quotes are taken away)
  const quoted = /^(.+?)\s*[-–—:]?\s*["“]([^"“”]{2,80})["”](?:\s|$|[([|])/.exec(t);
  // the extras YouTube titles carry
  t = t.replace(/[([【][^)\]】]*[)\]】]/g, (m) => (NOISE.test(m) ? ' ' : m));
  t = t.replace(/\b(?:official\s+(?:music\s+|lyric\s+|hd\s+|4k\s+)?(?:video|audio|mv|visuali[sz]er)|(?:music|lyric|lyrics)\s+video|with\s+lyrics|lyrics?|(?:19|20)\d\d\s+remaster(?:ed)?|remaster(?:ed)?(?:\s+(?:19|20)\d\d)?|\bhd\b|\bhq\b|\b[48]k\b|\bm\/v\b|\bmv\b)\b/gi, ' ');
  t = t.replace(/\s*(?:\||\/\/|｜).*$/, '').replace(/["“”]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').trim();
  let artist = '', title = '', clear = false;
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(t) ?? /^(.+?)\s*[–—]\s*(.+)$/.exec(t);
  const by = /^(.+?)\s+by\s+(.+)$/i.exec(t);
  if (topic) {
    // a "Topic" channel: the title is the track, the channel is the artist
    artist = artistOfChannel(channel);
    title = dash && dash[1].toLowerCase() === artist.toLowerCase() ? dash[2] : t;
    clear = true;
  } else if (dash) {
    artist = dash[1]; title = dash[2].replace(/\s+[-–—]\s+.*$/, '');
    clear = true;
  } else if (quoted && !/[-–—]/.test(t)) {
    artist = quoted[1].replace(/[-–—:\s]+$/, ''); title = quoted[2];
    clear = true;
  } else if (by && by[2].split(' ').length <= 5) {
    title = by[1]; artist = by[2];
    clear = true;
  } else {
    artist = artistOfChannel(channel); title = t;
    clear = musicChannel;
  }
  // ('Song' in single quotes loses them; "Don't Stop Believin'" keeps its own)
  const unquote = (x: string): string => x.trim().replace(/^['‘]([^'‘’]+)['’]$/, '$1').trim();
  title = unquote(stripFeat(title));
  artist = unquote(firstArtist(artist));
  return { name: { artist, title }, clear };
}

/** the one small AI request for an unclear title (asked by lyrics-find.ts, once per video) */
export function buildSongNamePrompt(title: string, channel: string, description: string): { system: string; user: string; maxTokens: number } {
  return {
    system: 'You name the song in a YouTube video. Reply with JSON only: no other text, no code fences.',
    user: `Video title: ${title.slice(0, 200)}\nChannel: ${channel.slice(0, 80)}\nDescription (its first lines): ${description.replace(/\s+/g, ' ').slice(0, 300)}\n\nWhich song is it? Give the main artist and the song's name as they are written on a record (no "official video", no "feat."). When the video is not one song (a talk, a mix, a whole album), give empty strings.\nJSON: {"artist":"...","song":"..."}`,
    maxTokens: 80,
  };
}
export function parseSongName(text: string): SongName | null {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  let o: Record<string, unknown> | null = null;
  try { o = JSON.parse(s) as Record<string, unknown>; } catch {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { o = JSON.parse(s.slice(a, b + 1)) as Record<string, unknown>; } catch { o = null; } }
  }
  let artist = '', title = '';
  if (o && typeof o === 'object') {
    artist = typeof o.artist === 'string' ? o.artist : '';
    title = typeof o.song === 'string' ? o.song : typeof o.title === 'string' ? o.title : typeof o.track === 'string' ? o.track : '';
  } else {
    // a cut-off answer
    artist = /"artist"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s)?.[1] ?? '';
    title = /"(?:song|title|track)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s)?.[1] ?? '';
  }
  artist = artist.replace(/\s+/g, ' ').trim().slice(0, 80);
  title = title.replace(/\s+/g, ' ').trim().slice(0, 120);
  return title ? { artist, title } : null;
}

// ---------- timed and plain lyrics as lines ----------

/** "[01:02.34] text" lines -> timed lines; a blank line or a verse marker starts a new verse */
export function parseLrc(lrc: string, duration = 0): LyricLine[] {
  const out: { start: number; text: string; verse: number }[] = [];
  let verse = 0, gap = false;
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g, '').trim();
    if (!stamps.length) { if (!text) gap = true; continue; }
    if (!text) { gap = true; continue; }
    if (gap && out.length) verse++;
    gap = false;
    for (const s of stamps) out.push({ start: Number(s[1]) * 60 + Number(s[2]) + (s[3] ? Number(`0.${s[3]}`) : 0), text, verse });
  }
  out.sort((a, b) => a.start - b.start);
  return out.map((l, i) => ({ ...l, end: i + 1 < out.length ? out[i + 1].start : Math.max(l.start + 4, duration || l.start + 4) }));
}

/** plain lyrics as lines with their verse; "[Chorus]" lines and blank lines start a new verse */
export function plainLines(text: string): { text: string; verse: number }[] {
  const lines: { text: string; verse: number }[] = [];
  let verse = 0, gap = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) { gap = true; continue; }
    if (/^\[[^\]]+\]$/.test(t) || /^\([^)]*(?:chorus|verse|bridge|intro|outro|x\d)[^)]*\)$/i.test(t)) { gap = true; continue; } // [Chorus], [Verse 2]
    if (gap && lines.length) verse++;
    gap = false;
    lines.push({ text: t, verse });
  }
  return lines;
}

const wordsOf = (s: string): string[] => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’'`]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Lyrics without times, spread over the song: the first sung word after an intro (a guess: 8% of the length), each
 * line as long as its number of words, a short gap between verses.
 */
export function spreadPlain(text: string, duration: number): LyricLine[] {
  const lines = plainLines(text);
  if (!lines.length) return [];
  const total = Math.max(30, duration || 180);
  const from = total * 0.08, to = total * 0.97;
  const weight = lines.map((l) => 1 + wordsOf(l.text).length);
  const GAP = 2; // (a verse gap is as long as two words)
  const gaps: number[] = lines.map((l, i) => (i > 0 && l.verse !== lines[i - 1].verse ? GAP : 0));
  const sum = weight.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  const unit = (to - from) / sum;
  let at = from;
  return lines.map((l, i) => {
    at += gaps[i] * unit;
    const len = weight[i] * unit;
    const line = { start: at, end: at + len, text: l.text, verse: l.verse };
    at += len;
    return line;
  });
}

export interface CaptionWord { w: string; t: number; e?: number }

/** the words of the captions with their times (a sentence without word times: its words spread over it) */
export function captionWords(sentences: ReadonlyArray<{ start: number; end: number; text: string; words?: ReadonlyArray<{ w: string; t: number; e?: number }> | null }>): CaptionWord[] {
  const out: CaptionWord[] = [];
  for (const s of sentences ?? []) {
    if (!s || !Number.isFinite(s.start)) continue;
    if (s.words && s.words.length) { for (const w of s.words) if (w && typeof w.w === 'string' && Number.isFinite(w.t)) out.push({ w: w.w, t: w.t, e: w.e }); continue; }
    const ws = String(s.text ?? '').split(/\s+/).filter(Boolean);
    const len = Math.max(0.2, (Number.isFinite(s.end) && s.end > s.start ? s.end : s.start + 2) - s.start);
    ws.forEach((w, i) => out.push({ w, t: s.start + (len * i) / ws.length, e: s.start + (len * (i + 1)) / ws.length }));
  }
  return out.sort((a, b) => a.t - b.t);
}

/** two words are the same for the alignment: equal, or nearly (a misheard ending: "runnin" / "running", "love" / "loved") */
function alike(a: string, b: string): number {
  if (a === b) return a.length <= 2 ? 2 : 3;
  if (a.length >= 4 && b.length >= 4) {
    const n = Math.min(a.length, b.length);
    let same = 0;
    while (same < n && a[same] === b[same]) same++;
    if (same >= Math.max(4, n - 1) && Math.abs(a.length - b.length) <= 3) return 2;
  }
  return 0;
}

/**
 * Plain lyrics put in time with the song by the words of its captions (YouTube's automatic captions hear a song
 * badly: many words are wrong or missing). The lyric words and the caption words are matched in order (the longest
 * chain of matching words, a dynamic-programming alignment that skips what does not match); a line starts where its
 * first matched word is heard; lines with no matched word are placed between their neighbours by their number of
 * words. null = too few words matched to trust it (then the lines are spread over the song).
 */
export function alignToCaptions(text: string, captions: readonly CaptionWord[], duration: number): LyricLine[] | null {
  const lines = plainLines(text);
  if (!lines.length || captions.length < 8) return null;
  const lw: { line: number; k: number; w: string }[] = [];
  const count: number[] = [];
  lines.forEach((l, i) => { const ws = wordsOf(l.text); count.push(ws.length); ws.forEach((w, k) => lw.push({ line: i, k, w })); });
  const cw: { w: string; t: number }[] = [];
  for (const c of captions) for (const w of wordsOf(c.w)) cw.push({ w, t: c.t });
  const n = lw.length, m = cw.length;
  if (n < 4 || m < 8 || n * m > 6_000_000) return null;
  // the best chain: score[i][j] = the best sum for the first i lyric words and the first j caption words
  const W = m + 1;
  const score = new Int32Array((n + 1) * W);
  const step = new Uint8Array((n + 1) * W); // 1 = matched, 2 = skip a lyric word, 3 = skip a caption word
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const a = alike(lw[i - 1].w, cw[j - 1].w);
      const diag = a ? score[(i - 1) * W + (j - 1)] + a : -1;
      const up = score[(i - 1) * W + j], left = score[i * W + (j - 1)];
      if (diag >= up && diag >= left) { score[i * W + j] = diag; step[i * W + j] = 1; }
      else if (up >= left) { score[i * W + j] = up; step[i * W + j] = 2; }
      else { score[i * W + j] = left; step[i * W + j] = 3; }
    }
  }
  // back along the chain: each line's first matched word
  const first: ({ t: number; k: number } | null)[] = lines.map(() => null);
  const hits: number[] = lines.map(() => 0);
  let matched = 0;
  for (let i = n, j = m; i > 0 && j > 0;) {
    const s = step[i * W + j];
    if (s === 1) { const x = lw[i - 1]; first[x.line] = { t: cw[j - 1].t, k: x.k }; hits[x.line]++; matched++; i--; j--; }
    else if (s === 2) i--;
    else j--;
  }
  if (matched < 6 || matched / n < 0.25) return null;
  const total = Math.max(duration || 0, cw[m - 1].t + 2);
  // a line's start: where its first matched word is heard, less the words before it (about 0.35 s each).
  // One matched small word in a long line is not enough to place it.
  const start: (number | null)[] = lines.map((_, i) => {
    const f = first[i];
    if (!f) return null;
    if (hits[i] < 2 && count[i] > 3) return null;
    return Math.max(0, f.t - f.k * 0.35);
  });
  // never back in time
  let last = -1;
  for (let i = 0; i < start.length; i++) { const s = start[i]; if (s === null) continue; if (s <= last) start[i] = null; else last = s; }
  if (start.filter((s) => s !== null).length < Math.max(2, Math.ceil(lines.length * 0.2))) return null;
  const placed: number[] = [];
  start.forEach((x, i) => { if (x !== null) placed.push(i); });
  const t: number[] = lines.map((_, i) => start[i] ?? 0);
  const w = count.map((c) => c + 1);
  // before the first placed line: back from it, by the number of words
  for (let i = placed[0] - 1; i >= 0; i--) t[i] = Math.max(0, t[i + 1] - w[i] * 0.45);
  // between two placed lines: by the number of words
  for (let x = 0; x + 1 < placed.length; x++) {
    const p = placed[x], q = placed[x + 1];
    const sum = w.slice(p, q).reduce((u, v) => u + v, 0);
    let acc = 0;
    for (let k = p + 1; k < q; k++) { acc += w[k - 1]; t[k] = t[p] + ((t[q] - t[p]) * acc) / sum; }
  }
  // after the last placed line: on from it (and all of it before the song ends)
  const lastAt = placed[placed.length - 1];
  const rest = w.slice(lastAt).reduce((u, v) => u + v, 0) * 0.6;
  const room = Math.max(1, total - t[lastAt]);
  const f = rest > room ? room / rest : 1;
  for (let i = lastAt + 1; i < lines.length; i++) t[i] = t[i - 1] + w[i - 1] * 0.6 * f;
  // (never two lines at the same moment)
  for (let i = 1; i < t.length; i++) if (t[i] <= t[i - 1]) t[i] = t[i - 1] + 0.05;
  return lines.map((l, i) => {
    const next = i + 1 < lines.length ? t[i + 1] : Math.max(t[i] + 1, total);
    // (a long time before the next line is music: the line itself is not that long)
    const end = Math.max(t[i] + 0.05, Math.min(next, t[i] + Math.max(4, count[i] * 1.2)));
    return { start: t[i], end, text: l.text, verse: l.verse };
  });
}

/** plain lyrics -> timed lines: by the captions when they can be matched, else spread over the song */
export function timePlain(text: string, captions: readonly CaptionWord[], duration: number): { lines: LyricLine[]; timing: 'captions' | 'spread' } {
  const a = alignToCaptions(text, captions, duration);
  if (a && a.length) return { lines: a, timing: 'captions' };
  return { lines: spreadPlain(text, duration), timing: 'spread' };
}

/** what the status line says about where the lyrics come from */
export function lyricsNote(l: Pick<Lyrics, 'source' | 'synced' | 'timing'>): string {
  const from = l.source === 'pasted' ? 'your own lyrics' : `lyrics from ${l.source}`;
  return l.synced ? from : `${from}, timing guessed${l.timing === 'captions' ? ' (from the captions)' : ''}`;
}

// ---------- 2. the sources ----------

interface LrclibHit { id: number; trackName: string; artistName: string; albumName?: string; duration?: number; instrumental?: boolean; plainLyrics?: string | null; syncedLyrics?: string | null }

const norm = (s: string) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

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

/** the title's words fit: the same, one inside the other, or most words shared */
export function titleFits(have: string, want: string): boolean {
  const a = norm(have), b = norm(want);
  if (!a || !b) return false;
  if (a === b) return true;
  const inside = (x: string, y: string) => (` ${y} `).includes(` ${x} `);
  if (inside(a, b) || inside(b, a)) return true;
  const wa = a.split(' '), wb = new Set(b.split(' '));
  const shared = wa.filter((w) => wb.has(w)).length;
  return shared / Math.min(wa.length, wb.size) >= 0.6 && shared >= 2;
}
const artistFits = (have: string, want: string): boolean => {
  const fits = (x: string, y: string): boolean => { const a = norm(x), b = norm(y); return !!a && !!b && (a === b || (` ${a} `).includes(` ${b} `) || (` ${b} `).includes(` ${a} `)); };
  return fits(have, want) || fits(have, soloArtist(want)) || fits(soloArtist(have), soloArtist(want));
};
/** timed lyrics must be for a recording of about this length: within 12 s or 8% */
export function lengthFits(have: number | undefined, want: number): boolean {
  if (!want || !have) return true;
  return Math.abs(have - want) <= Math.max(12, want * 0.08);
}

const LRCLIB = 'https://lrclib.net', OVH = 'https://api.lyrics.ovh';
const noParens = (s: string) => s.replace(/\s*[([][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim();
const noThe = (s: string) => s.replace(/^the\s+/i, '').trim();

export interface LyricTry { kind: 'get' | 'search' | 'ovh'; url: string; want: SongName }

/** the requests to try, in order: LRCLIB get, LRCLIB search with several spellings, then lyrics.ovh; no repeats */
export function lyricTries(name: SongName, duration: number, base: { lrclib?: string; ovh?: string } = {}): LyricTry[] {
  const L = (base.lrclib || LRCLIB).replace(/\/+$/, ''), O = (base.ovh || OVH).replace(/\/+$/, '');
  const artist = name.artist.trim(), title = name.title.trim();
  if (!title) return [];
  const e = encodeURIComponent;
  const out: LyricTry[] = [];
  const seen = new Set<string>();
  const add = (t: LyricTry) => { if (!seen.has(t.url)) { seen.add(t.url); out.push(t); } };
  const search = (a: string, t: string, want: SongName) => { if (t) add({ kind: 'search', url: `${L}/api/search?track_name=${e(t)}${a ? `&artist_name=${e(a)}` : ''}`, want }); };
  if (artist) add({ kind: 'get', url: `${L}/api/get?artist_name=${e(artist)}&track_name=${e(title)}${duration ? `&duration=${Math.round(duration)}` : ''}`, want: name });
  search(artist, title, name);
  // other spellings: without ( ), without "the", the artist and the track the other way round, the track alone
  if (noParens(title) !== title || noParens(artist) !== artist) search(noParens(artist), noParens(title), { artist: noParens(artist), title: noParens(title) });
  if (noThe(artist) !== artist || noThe(title) !== title) search(noThe(artist), noThe(title), { artist: noThe(artist), title: noThe(title) });
  if (artist && soloArtist(artist) !== artist) search(soloArtist(artist), title, { artist: soloArtist(artist), title });
  if (artist) search(title, artist, { artist: title, title: artist });
  add({ kind: 'search', url: `${L}/api/search?q=${e(`${artist} ${title}`.trim())}`, want: name });
  if (artist) search('', noParens(title), { artist, title: noParens(title) });
  if (artist) {
    add({ kind: 'ovh', url: `${O}/v1/${e(artist)}/${e(noParens(title))}`, want: name });
    if (noThe(artist) !== artist) add({ kind: 'ovh', url: `${O}/v1/${e(noThe(artist))}/${e(noParens(title))}`, want: name });
  }
  return out;
}

/** lyrics.ovh puts a line about the song first ("Paroles de la chanson … par …") */
export function cleanOvh(text: string): string {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\s*Paroles de la chanson[^\n]*\n/i, '').replace(/\n{3,}/g, '\n\n').trim();
}

export interface FindOptions {
  /** the song's names when the rules could not find them (the AI's answer, or the learner's) */
  names?: SongName | null;
  /** tests: other addresses for the two services */
  base?: { lrclib?: string; ovh?: string };
}

/**
 * The lyrics of this video's song, or null. `fetchJson` is the app's own way to fetch (the background page in
 * Chrome, Swift on the iPhone); it throws when the answer is not OK (LRCLIB's `get` answers 404 for "not found").
 * Lyrics with times are taken at once; plain lyrics only when no try had timed ones (lines spread over the song;
 * `plain` keeps the text so the page can time it with the captions).
 */
export async function findLyrics(videoTitle: string, channel: string, duration: number, fetchJson: (url: string) => Promise<unknown>, opts: FindOptions = {}): Promise<Lyrics | null> {
  const name: SongName = opts.names && opts.names.title ? { artist: opts.names.artist ?? '', title: opts.names.title } : songOf(videoTitle, channel);
  if (!name.title) return null;
  let plain: { hit: LrclibHit; score: number } | null = null;
  const timed = (h: LrclibHit): Lyrics | null => {
    const lines = parseLrc(h.syncedLyrics ?? '', duration);
    return lines.length ? { artist: h.artistName, title: h.trackName, album: h.albumName, lines, synced: true, source: 'LRCLIB', id: h.id } : null;
  };
  for (const t of lyricTries(name, duration, opts.base)) {
    if (t.kind === 'ovh' && plain) break; // (LRCLIB's plain lyrics come first)
    let data: unknown;
    try { data = await fetchJson(t.url); } catch { continue; }
    if (t.kind === 'ovh') {
      const text = cleanOvh((data as { lyrics?: unknown } | null)?.lyrics as string);
      if (plainLines(text).length < 4) continue;
      return { artist: name.artist, title: name.title, lines: spreadPlain(text, duration), synced: false, source: 'lyrics.ovh', plain: text, timing: 'spread' };
    }
    const hits: LrclibHit[] = Array.isArray(data) ? (data as LrclibHit[]) : data && typeof data === 'object' && 'trackName' in (data as object) ? [data as LrclibHit] : [];
    let best: LrclibHit | null = null, bestScore = -Infinity;
    for (const h of hits) {
      if (!h || h.instrumental || (!h.syncedLyrics && !h.plainLyrics)) continue;
      if (!titleFits(h.trackName, t.want.title)) continue;
      const artistOk = !t.want.artist || artistFits(h.artistName, t.want.artist);
      const close = !!duration && !!h.duration && Math.abs(h.duration - duration) <= 3;
      // another artist's song of the same name: only when the length is the very same (the channel was not the artist)
      if (!artistOk && !(close && norm(h.trackName) === norm(t.want.title))) continue;
      const sc = hitScore(h, { ...t.want, duration });
      if (h.syncedLyrics && lengthFits(h.duration, duration)) { if (sc > bestScore) { best = h; bestScore = sc; } }
      else if (h.plainLyrics && (!plain || sc > plain.score)) plain = { hit: h, score: sc };
    }
    if (best) { const l = timed(best); if (l) return l; }
    // (a search that knows the song but has no timed lyrics for this length: the other spellings would say the same)
    if (plain && t.kind === 'search') break;
  }
  if (plain) {
    const text = String(plain.hit.plainLyrics ?? '');
    const lines = spreadPlain(text, duration);
    if (lines.length) return { artist: plain.hit.artistName, title: plain.hit.trackName, album: plain.hit.albumName, lines, synced: false, source: 'LRCLIB', id: plain.hit.id, plain: text, timing: 'spread' };
  }
  return null;
}
