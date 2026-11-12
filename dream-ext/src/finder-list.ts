/**
 * "Find me a video", the parts with no screen: the YouTube searches made from the learner's words (fixed patterns, no
 * AI), the candidates (no Shorts, no other languages, no music unless asked), the ONE AI request that picks and ranks
 * the 10 best, a video's level 0–100 from its subtitles (no AI), the order of the list (Best / a level), the list
 * kept in the storage, and the playlist (the next video opens by itself when one of the list ends).
 */
import type { Book } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import { analyzeToken } from '@core/vocab/analysis';
import { clampLevel, fitScore, myLevelOf, wordDifficulty } from './level100';

/** the learner's level 0-100 (the slider's number; before it was set: the old A1-C2 level as a number) */
export const learnerLevelOf = myLevelOf;

export interface FoundVideo { id: string; title: string; channel: string; lengthSeconds?: number; thumb?: string; views?: string; age?: string }
/** one video of the list: its place in the first ranking (1 = the best), why it is good, its level 0–100 */
export interface ListVideo extends FoundVideo {
  rank: number;
  why: string;
  /** 0 (easiest) … 100 (hardest); null = not known */
  level: number | null;
  /** where the level comes from: the AI's guess, or measured from the subtitles */
  levelFrom: 'ai' | 'subs' | null;
  /** how often its subtitles were asked for (so a video without subtitles is not asked again and again) */
  tried?: number;
}
/** the order of the list: the first ranking, by how well each video fits my level, or fits a chosen level */
export type ListOrder = 'best' | 'mine' | number;
export interface FinderList {
  v: 1;
  query: string;
  /** when it was made (ms) */
  at: number;
  /** who ranked it: the AI, or YouTube's own order (the AI was off or failed) */
  ranked: 'ai' | 'search';
  order: ListOrder;
  /** the video of the list that was opened last (the playlist goes on from it) */
  playing: string | null;
  videos: ListVideo[];
}
/** a video's level as it is cached per video (drVLevel:<id>) */
export interface FinderLevel { n: number | null; words?: number; note?: 'too short' }

export const LIST_KEY = 'drFinderList';
export const LIST_SIZE = 10;
const MAX_CANDIDATES = 40;

// ---------- the searches (no AI) ----------

const clean = (s: string): string => String(s ?? '').replace(/[“”"«»]/g, ' ').replace(/\s+/g, ' ').trim();

/** "please find me some videos about black holes" -> "black holes" (what to type into YouTube's search) */
export function topicOf(said: string): string {
  let q = clean(said).replace(/^(?:(?:hi|hello|hey|ok|okay|so|well|um|uh|please)[, ]+)+/i, '');
  // a long voice note: its first sentence (no lookbehind: iOS 16.0 does not have it)
  q = q.split(/[.!?。！？]+\s+/)[0].replace(/[.!?。！？,;:]+$/g, '').trim();
  // "... (videos / learn / know / something) about X" -> X, when it comes early in what was said
  const about = /^((?:\S+ ){0,8}?)(?:videos?|talks?|clips?|lessons?|something|anything|everything|more|learn|know|understand|hear|study) (?:about|on) (.+)$/i.exec(q);
  if (about && about[2].trim().length >= 3) q = about[2].trim();
  else {
    const frame = /^(?:(?:can|could|would) you (?:please )?)?(?:please )?(?:i (?:want|need|would like|'d like)(?: to)? |i am looking for |i'm looking for )?(?:(?:find|show|give|get|search for|look for|watch|see)(?: me| us)? )?(?:(?:a|an|some|the|good|best|few|any|great|nice|interesting) )*(?:(?:videos?|talks?|clips?) (?:about|on|of|for|that (?:explains?|shows?|talks? about)) )?/i.exec(q);
    if (frame && frame[0].length && q.length - frame[0].length >= 3) q = q.slice(frame[0].length).trim();
  }
  // (YouTube's search works with a few words)
  const words = q.split(' ');
  if (words.length > 9) q = words.slice(0, 9).join(' ');
  return q.slice(0, 90).trim();
}

/** the learner asked for music (then music videos stay in the list) */
export function wantsMusic(said: string): boolean {
  return /\b(music|musics|songs?|sing|singing|singers?|albums?|lyrics?|bands?|concerts?|rap|hip[ -]?hop|jazz|rock|pop|blues|opera|orchestra|symphony|piano|guitar|violin|drums?|covers?|mv|soundtrack|playlist|melody|choir)\b/i.test(said);
}

/** 4 to 6 YouTube searches from the learner's words, by fixed patterns (no AI); no repeats */
export function makeSearches(said: string): string[] {
  const q = topicOf(said);
  if (!q) return [];
  const has = (re: RegExp) => re.test(q);
  const music = wantsMusic(said);
  const howTo = has(/\b(how to|how do|learn|lessons?|tutorials?|course|practice|exercises?|tips)\b/i);
  const tails: string[] = [];
  if (music && !howTo) tails.push('explained', 'lyrics', 'live', 'interview', 'documentary');
  else {
    tails.push('explained');
    if (!has(/\b(beginners?|easy|basics?|simple|introduction|intro)\b/i)) tails.push('for beginners');
    if (!howTo) tails.push('documentary');
    if (!howTo) tails.push('interview');
    tails.push(howTo ? 'step by step' : 'talk');
    if (howTo) tails.push('tutorial');
  }
  const out = [q];
  const seen = new Set([q.toLowerCase()]);
  for (const t of tails) {
    if (new RegExp(`\\b${t.split(' ')[0]}`, 'i').test(q)) continue; // (the words are in it already)
    const s = `${q} ${t}`;
    if (seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= 6) break;
  }
  return out;
}

// ---------- the candidates ----------

/** a title that is clearly not English: mostly another script, or it says its language */
export function notEnglish(title: string): boolean {
  const letters = title.match(/\p{L}/gu) ?? [];
  if (!letters.length) return false;
  const other = letters.filter((c) => !/[\p{Script=Latin}]/u.test(c)).length;
  if (other / letters.length > 0.3) return true;
  if (/\b(en español|subtitulado|sub español|legendado|dublado|auf deutsch|en français|in hindi|hindi dubbed|in urdu|in tamil|in telugu|in bengali|bahasa indonesia|sub indo|tagalog|vietsub|doblado)\b/i.test(title)) return true;
  // Latin letters, but many marks English does not use (ñ, ç, ã, ß, ø …)
  const marks = letters.filter((c) => /[àáâãäåæçèéêëìíîïñòóôõöøùúûüýÿßœšžčćđğışąęłńśźż]/i.test(c)).length;
  return marks >= 3 && marks / letters.length > 0.06;
}

/** a music video (dropped when the learner did not ask for music) */
export function isMusicVideo(v: Pick<FoundVideo, 'title' | 'channel'>): boolean {
  if (/vevo$/i.test(v.channel.trim()) || /\s-\sTopic$/i.test(v.channel.trim())) return true;
  return /(official\s+(?:music\s+|lyric\s+|hd\s+)?video|official\s+audio|official\s+mv|music\s+video|lyric\s+video|\blyrics\b|\(audio\)|\[audio\]|\bM\/V\b|\bvisuali[sz]er\b|full\s+album|\bkaraoke\b|\bremix\b|\b(?:ft|feat)\.)/i.test(v.title);
}

/**
 * The hits of the searches as one list of candidates: the searches take turns (so every search has a say), without
 * repeats, without Shorts (under 90 seconds), without titles in other languages and, unless asked, without music videos.
 */
export function pickCandidates(lists: FoundVideo[][], said: string, max = MAX_CANDIDATES): FoundVideo[] {
  const music = wantsMusic(said);
  const out: FoundVideo[] = [];
  const seen = new Set<string>();
  const titles = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => (Array.isArray(l) ? l.length : 0)));
  for (let i = 0; i < longest && out.length < max; i++) {
    for (const l of lists) {
      const v = Array.isArray(l) ? l[i] : undefined;
      if (!v || !v.id || seen.has(v.id) || out.length >= max) continue;
      seen.add(v.id);
      const title = clean(v.title);
      if (!title) continue;
      if (typeof v.lengthSeconds === 'number' && v.lengthSeconds > 0 && v.lengthSeconds < 90) continue;
      if (/#shorts?\b/i.test(title)) continue;
      if (notEnglish(title)) continue;
      if (!music && isMusicVideo(v)) continue;
      // (the same video put up twice)
      const tk = `${title.toLowerCase()}|${v.lengthSeconds ?? ''}`;
      if (titles.has(tk)) continue;
      titles.add(tk);
      out.push({ ...v, title, channel: clean(v.channel) });
    }
  }
  return out;
}

// ---------- the ONE AI request: pick and rank ----------

export const minutes = (sec?: number): string => (sec && sec > 0 ? `${Math.max(1, Math.round(sec / 60))} min` : '');

export function buildRankPrompt(said: string, cands: readonly FoundVideo[], myLevel: number): { system: string; user: string; maxTokens: number } {
  const system = 'You choose the best YouTube videos for a learner of English (a Chinese speaker). Reply with JSON only: no other text, no code fences.';
  const lines = cands.map((v, i) => `${i + 1}. ${[v.title.slice(0, 110), v.channel.slice(0, 40), minutes(v.lengthSeconds), v.views, v.age].filter(Boolean).join(' | ')}`);
  const user = [
    `What the learner wants (it may come from speech recognition, so small mistakes are possible):\n"""${said.trim().slice(0, 1200)}"""`,
    `Their English level is ${clampLevel(myLevel)} on a line from 0 (beginner) to 100 (like a native speaker).`,
    `These are the videos YouTube found (number. title | channel | length | views | age):\n${lines.join('\n')}`,
    `Choose the ${LIST_SIZE} best videos for what the learner wants and put them in order, the best one first. "Best" means: it is really about what they asked for, it is good and can be trusted (a channel that knows the topic, a clear speaker, a whole video and not a clip, a trailer or an advertisement), and people speak clear English in it. Their level matters only a little: between two videos that are equally good, take the one nearer their level. Do not choose two videos that are almost the same.`,
    'For each one give: "n" = its number in the list above; "why" = ONE short sentence in easy English (words a B1 learner knows) that says why this video is good for them; "level" = your guess of how hard its English is, a number from 0 (easiest) to 100 (hardest): 20 = slow, simple talk; 55 = normal, clear talk; 85 = fast and dense talk, with slang or technical words.',
    'JSON: {"videos":[{"n":7,"why":"...","level":55}]}',
  ].join('\n\n');
  return { system, user, maxTokens: 1100 };
}

export interface RankPick { n: number; why: string; level: number | null }

/**
 * The AI's answer -> the picks in order (n = the candidate's number, from 1). Strict JSON is asked for; code fences,
 * text around it, a bare list, other key names and a cut-off answer (its complete entries) are accepted. Garbage = [].
 */
export function parseRankReply(text: string, count: number): RankPick[] {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  const tryParse = (t: string): unknown => { try { return JSON.parse(t); } catch { return undefined; } };
  let data = tryParse(s);
  if (data === undefined) { const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) data = tryParse(s.slice(a, b + 1)); }
  if (data === undefined) { const a = s.indexOf('['), b = s.lastIndexOf(']'); if (a >= 0 && b > a) data = tryParse(s.slice(a, b + 1)); }
  let list: unknown = data;
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    const o = list as Record<string, unknown>;
    list = o.videos ?? o.best ?? o.ranking ?? o.results ?? o.list ?? o.picks ?? null;
  }
  let items: unknown[] = [];
  if (Array.isArray(list)) items = list;
  else {
    // a cut-off or broken answer: every entry that is complete
    for (const m of s.matchAll(/\{[^{}]*\}/g)) { const o = tryParse(m[0]); if (o && typeof o === 'object') items.push(o); }
  }
  const out: RankPick[] = [];
  const seen = new Set<number>();
  const num = (x: unknown): number => (typeof x === 'number' ? x : typeof x === 'string' && /^\s*#?\d+\s*$/.test(x) ? parseInt(x.replace('#', ''), 10) : NaN);
  for (const it of items) {
    let n = NaN, why = '', level: number | null = null;
    if (typeof it === 'number' || typeof it === 'string') n = num(it);
    else if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>;
      n = num(o.n ?? o.number ?? o.index ?? o.video ?? o.id);
      const w = o.why ?? o.reason ?? o.because;
      if (typeof w === 'string') why = w.replace(/\s+/g, ' ').trim().slice(0, 240);
      const l = num(o.level ?? o.difficulty ?? o.hard);
      if (Number.isFinite(l) && l >= 0 && l <= 100) level = Math.round(l);
    }
    if (!Number.isInteger(n) || n < 1 || n > count || seen.has(n)) continue;
    seen.add(n);
    out.push({ n, why, level });
    if (out.length >= LIST_SIZE) break;
  }
  return out;
}

/**
 * The list of the 10 best: the AI's picks in its order; when it gave fewer than 10 (or none: the AI is off or
 * failed), the rest in the order YouTube found them.
 */
export function makeList(query: string, cands: readonly FoundVideo[], picks: readonly RankPick[], now = Date.now()): FinderList {
  const videos: ListVideo[] = [];
  const used = new Set<number>();
  for (const p of picks) {
    const v = cands[p.n - 1];
    if (!v || used.has(p.n) || videos.length >= LIST_SIZE) continue;
    used.add(p.n);
    videos.push({ ...v, rank: videos.length + 1, why: p.why, level: p.level, levelFrom: p.level === null ? null : 'ai' });
  }
  for (let i = 0; i < cands.length && videos.length < LIST_SIZE; i++) {
    if (used.has(i + 1)) continue;
    videos.push({ ...cands[i], rank: videos.length + 1, why: '', level: null, levelFrom: null });
  }
  return { v: 1, query: query.trim().slice(0, 1500), at: now, ranked: picks.length ? 'ai' : 'search', order: 'best', playing: null, videos };
}

// ---------- a video's level 0–100 from its subtitles (no AI) ----------

/**
 * How hard a text is, 0 (easiest) … 100 (hardest): the difficulty below which 95% of its running words fall
 * (so a learner at that level meets about one harder word in twenty; simple talk gives about 25, a clear talk about
 * 45-50, dense technical talk 80 and more)
 * (every word's number from level100.ts; names and unknown junk do not count). null = too few words to tell.
 */
export function textDifficulty(book: Pick<Book, 'chapters'>, dict: Dictionary, names: Set<string>, zipf: ((word: string) => number | null) | null, share = 0.95, minWords = 60): { level: number; words: number } | null {
  const ds: number[] = [];
  for (const c of book.chapters ?? []) for (const p of c.paragraphs ?? []) for (const s of p.sentences ?? []) {
    const first = s.tokens.findIndex((t) => t.kind === 'word');
    s.tokens.forEach((t, i) => {
      if (t.kind !== 'word' || !/\p{L}/u.test(t.text)) return;
      const info = analyzeToken(t, i === first, dict, names);
      if (info.isName) return;
      const z = zipf ? zipf(t.text) ?? (info.lemma && info.lemma !== t.text ? zipf(info.lemma) : null) : null;
      // nobody knows it: a name or a caption mistake ("gonna", "y'all" are easy talk)
      if (!info.inDict && z === null) { if (/['’]/.test(t.text)) ds.push(15); return; }
      let cefr = info.level;
      // an estimated C2 that no corpus knows and the dictionary cannot explain: most likely junk
      if (cefr === 'C2' && info.levelSource === 'est' && info.entry && info.entry.frq === 0 && !info.entry.zh.trim()) cefr = null;
      // (no frequency table at all: a word without a school level counts as a common one)
      ds.push(!zipf && !cefr ? 30 : wordDifficulty(z, cefr));
    });
  }
  if (ds.length < minWords) return null;
  ds.sort((a, b) => a - b);
  const at = Math.min(ds.length - 1, Math.max(0, Math.ceil(ds.length * share) - 1));
  return { level: clampLevel(ds[at]), words: ds.length };
}

// ---------- the order ----------

/** "fits you" / "easy for you" / "hard for you" for a video of this level */
export function fitLabel(level: number, myLevel: number): { text: string; kind: 'ok' | 'easy' | 'hard' } {
  if (fitScore(level, myLevel) >= 70) return { text: 'fits you', kind: 'ok' };
  return level < myLevel + 5 ? { text: 'easy for you', kind: 'easy' } : { text: 'hard for you', kind: 'hard' };
}

/** the level the order is made for (null = the first ranking) */
export const orderLevel = (order: ListOrder, myLevel: number): number | null => (order === 'best' ? null : order === 'mine' ? clampLevel(myLevel) : clampLevel(order));

/**
 * The list in the order now shown: "best" = the first ranking; a level = by how well each video fits that level
 * (the best fit first; the same fit: the better rank first; videos with no level last). Only an order: no AI, no search.
 */
export function orderedVideos(list: Pick<FinderList, 'videos' | 'order'>, myLevel: number): ListVideo[] {
  const byRank = [...list.videos].sort((a, b) => a.rank - b.rank);
  const lv = orderLevel(list.order, myLevel);
  if (lv === null) return byRank;
  const fit = (v: ListVideo) => (v.level === null ? -1 : fitScore(v.level, lv));
  return byRank.sort((a, b) => fit(b) - fit(a) || a.rank - b.rank);
}

/** the video after (step 1) or before (step -1) this one in the order now shown; null = none (the list does not go round) */
export function neighbour(list: FinderList, id: string | null, step: 1 | -1, myLevel: number): ListVideo | null {
  const o = orderedVideos(list, myLevel);
  if (!o.length) return null;
  let i = id ? o.findIndex((v) => v.id === id) : -1;
  if (i < 0 && list.playing) i = o.findIndex((v) => v.id === list.playing);
  if (i < 0) return step > 0 ? o[0] : null;
  return o[i + step] ?? null;
}

// ---------- the list in the storage ----------

/** a stored value -> a list (null when it is not one) */
export function readList(raw: unknown): FinderList | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<FinderList>;
  if (!Array.isArray(o.videos)) return null;
  const videos: ListVideo[] = [];
  for (const x of o.videos as Partial<ListVideo>[]) {
    if (!x || typeof x.id !== 'string' || !/^[\w-]{11}$/.test(x.id) || videos.some((v) => v.id === x.id)) continue;
    const level = typeof x.level === 'number' && Number.isFinite(x.level) ? clampLevel(x.level) : null;
    videos.push({
      id: x.id, title: String(x.title ?? ''), channel: String(x.channel ?? ''),
      ...(typeof x.lengthSeconds === 'number' ? { lengthSeconds: x.lengthSeconds } : {}), ...(typeof x.thumb === 'string' ? { thumb: x.thumb } : {}),
      ...(typeof x.views === 'string' ? { views: x.views } : {}), ...(typeof x.age === 'string' ? { age: x.age } : {}),
      rank: typeof x.rank === 'number' && x.rank > 0 ? x.rank : videos.length + 1, why: String(x.why ?? ''),
      level, levelFrom: level === null ? null : x.levelFrom === 'subs' ? 'subs' : 'ai', ...(typeof x.tried === 'number' ? { tried: x.tried } : {}),
    });
    if (videos.length >= LIST_SIZE) break;
  }
  if (!videos.length) return null;
  const order: ListOrder = o.order === 'mine' ? 'mine' : typeof o.order === 'number' && Number.isFinite(o.order) ? clampLevel(o.order) : 'best';
  return {
    v: 1, query: String(o.query ?? ''), at: typeof o.at === 'number' ? o.at : 0, ranked: o.ranked === 'ai' ? 'ai' : 'search', order,
    playing: typeof o.playing === 'string' && videos.some((v) => v.id === o.playing) ? o.playing : null, videos,
  };
}

const area = (): chrome.storage.StorageArea | null => { try { return chrome.storage.local; } catch { return null; } };

export async function loadList(): Promise<FinderList | null> {
  try { const o = await area()?.get(LIST_KEY); return readList(o?.[LIST_KEY]); } catch { return null; }
}
export async function saveList(list: FinderList): Promise<void> {
  mem = list;
  try { await area()?.set({ [LIST_KEY]: list }); } catch { /* not kept this time */ }
}

// ---------- the playlist ----------

export interface PlaylistDeps {
  /** the video on the page now */
  currentId(): string | null;
  /** an advertisement plays now */
  isAd(): boolean;
  myLevel(): number;
  /** go to this video (it plays by itself, with the tutor as usual) */
  open(id: string): void;
  /** the tutor is in the middle of an explanation (the next video waits for its end) */
  busy?(): boolean;
}

let mem: FinderList | null = null;
let pl: PlaylistDeps | null = null;
let going = false;

/** the list as it is now (after installFinderPlaylist() or a load / save) */
export const currentList = (): FinderList | null => mem;

function go(list: FinderList, id: string): void {
  if (!pl || going) return;
  going = true;
  const deps = pl;
  let done = false;
  const open = () => { if (done) return; done = true; going = false; try { deps.open(id); } catch { /* the page's problem */ } };
  // (the list knows which one plays before the page goes away)
  void saveList({ ...list, playing: id }).then(open, open);
  setTimeout(open, 600);
}

/** this video is opened from the list (a tap in the finder): the playlist goes on from it */
export function playFromList(list: FinderList, id: string): void { go(list, id); }

function step(dir: 1 | -1): boolean {
  if (!pl || !mem) return false;
  const next = neighbour(mem, pl.currentId(), dir, pl.myLevel());
  if (!next) return false;
  go(mem, next.id);
  return true;
}
/** the next video of the list, in the order now shown (a bar button, the finder's "Next"); false = there is none */
export function finderNext(): boolean { return step(1); }
/** the video before (false = there is none) */
export function finderPrev(): boolean { return step(-1); }

/** a video of the list ended: the next one opens by itself. Returns true when it goes (or will go) to the next one. */
export function finderEnded(v: Pick<HTMLVideoElement, 'duration'> | null): boolean {
  const list = mem;
  if (!pl || !list) return false;
  let id: string | null = null;
  try { if (pl.isAd()) return false; id = pl.currentId(); } catch { return false; }
  // (only a video that was opened from the list; any other video ends as YouTube wants)
  if (!id || list.playing !== id) return false;
  const me = list.videos.find((x) => x.id === id);
  // an advertisement's end looks like the video's end: the length tells them apart
  const d = v?.duration;
  if (me?.lengthSeconds && typeof d === 'number' && Number.isFinite(d) && d > 0 && Math.abs(d - me.lengthSeconds) > Math.max(20, me.lengthSeconds * 0.15)) return false;
  const next = neighbour(list, id, 1, pl.myLevel());
  if (!next) return false;
  const deps = pl;
  // the tutor still explains the last sentence: the next video waits for it (at most 2 minutes)
  const until = Date.now() + 120000;
  const wait = () => {
    let busy = false;
    try { busy = !!deps.busy?.(); } catch { busy = false; }
    if (busy && Date.now() < until) { setTimeout(wait, 400); return; }
    const now = mem ?? list;
    go(now, next.id);
  };
  wait();
  return true;
}

/**
 * Once per page: the playlist listens for the end of the video (YouTube's own "up next" must not win: the next
 * video of the list is opened at once) and keeps the list in step with the storage.
 */
export function installFinderPlaylist(deps: PlaylistDeps): void {
  const first = !pl;
  pl = deps;
  if (!first) return;
  void loadList().then((l) => { if (!mem) mem = l; });
  try {
    chrome.storage.onChanged.addListener((ch, where) => { if (where === 'local' && ch[LIST_KEY]) mem = readList(ch[LIST_KEY].newValue); });
  } catch { /* no storage events here */ }
  // ("ended" does not bubble: it is caught on its way down)
  document.addEventListener('ended', (e) => {
    const t = e.target as HTMLVideoElement | null;
    if (t && t.tagName === 'VIDEO') finderEnded(t);
  }, true);
}

/** tests only */
export function resetFinderPlaylist(list: FinderList | null = null, deps: PlaylistDeps | null = null): void { mem = list; pl = deps; going = false; }
