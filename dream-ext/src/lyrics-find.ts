/**
 * Lyrics mode, on the page's side: the lyrics of this video's song, found once and kept per video.
 * - kept already (found before, or pasted by the learner): used as they are, nothing is asked;
 * - else the background looks for them by the title's rules (lyrics.ts: LRCLIB, then lyrics.ovh);
 * - nothing found and the tutor is on (with a key): ONE small AI request names the song (title + channel + the first
 *   300 characters of the description), kept per video so it is never asked twice, and the search runs again;
 * - lyrics without times are put in time with the captions of the video, or spread over the song;
 * - nothing found: null (the page says so and offers "Paste the lyrics"); pasted lyrics are timed the same way and kept.
 */
import { songOf, buildSongNamePrompt, parseSongName, timePlain, captionWords, parseLrc, plainLines, type Lyrics, type SongName } from './lyrics';
import { getKeys } from './store';

type Caption = { start: number; end: number; text: string; words?: ReadonlyArray<{ w: string; t: number; e?: number }> | null };

/** what is kept per video (drLyr:<videoId>) */
export interface SongRecord {
  v: 1;
  /** the AI's name for the song (null = it was asked and knows none); not there = never asked */
  aiName?: SongName | null;
  lyrics?: Lyrics;
  /** when the sources had nothing (ms): not asked again for a while */
  none?: number;
}
const KEY = (id: string) => `drLyr:${id}`;
const INDEX = 'drLyrIndex', KEEP = 80;
/** nothing found: the sources are asked again after this long */
const AGAIN_MS = 12 * 3600 * 1000;

const area = (): chrome.storage.StorageArea | null => { try { return chrome.storage.local; } catch { return null; } };

export async function loadSongRecord(videoId: string): Promise<SongRecord | null> {
  try {
    const o = await area()?.get(KEY(videoId));
    const r = o?.[KEY(videoId)] as SongRecord | undefined;
    return r && typeof r === 'object' && r.v === 1 ? r : null;
  } catch { return null; }
}
export async function saveSongRecord(videoId: string, rec: SongRecord): Promise<void> {
  const a = area();
  if (!a) return;
  try {
    await a.set({ [KEY(videoId)]: rec });
    // (the newest 80 songs are kept)
    const list = (((await a.get(INDEX))[INDEX] as string[] | undefined) ?? []).filter((x) => x !== videoId);
    list.push(videoId);
    const drop = list.splice(0, Math.max(0, list.length - KEEP));
    await a.set({ [INDEX]: list });
    if (drop.length) await a.remove(drop.map(KEY));
  } catch { /* not kept this time */ }
}

export interface FindSongDeps {
  videoId: string;
  title: string;
  channel: string;
  /** the video's length in seconds (0 = not known) */
  duration: number;
  /** the first lines of the video's description (for the AI, when the title is unclear) */
  description?: string;
  /** the video's own captions as sentences (to time lyrics that have no times) */
  captions: ReadonlyArray<Caption>;
  /** My tutor is on (the AI may be asked, when there is a key) */
  tutorOn: boolean;
  complete(prompt: { system: string; user: string; maxTokens: number }): Promise<string>;
  /** still wanted (the learner did not leave lyrics mode meanwhile) */
  alive?(): boolean;
  /** the background's lyrics search (tests give their own) */
  ask?(msg: Record<string, unknown>): Promise<{ ok?: boolean; lyrics?: Lyrics | null; reached?: boolean } | null>;
  hasKey?(): Promise<boolean>;
  now?(): number;
}
export interface FoundSong { lyrics: Lyrics | null; from: 'kept' | 'found' | 'none'; aiAsked: boolean }

const pageApi = (): { description?: () => string; videoLength?: () => number } | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { __ytcApi?: { description?: () => string; videoLength?: () => number } }).__ytcApi);
const sameName = (a: SongName, b: SongName): boolean => a.title.trim().toLowerCase() === b.title.trim().toLowerCase() && a.artist.trim().toLowerCase() === b.artist.trim().toLowerCase();

/** lyrics without times get them here: from the captions when they can be matched, else spread over the song */
export function withTimes(lyr: Lyrics, captions: ReadonlyArray<Caption>, duration: number): Lyrics {
  if (lyr.synced || !lyr.plain) return lyr;
  const t = timePlain(lyr.plain, captionWords(captions), duration);
  return t.lines.length ? { ...lyr, lines: t.lines, timing: t.timing } : lyr;
}

export async function findSongLyrics(d: FindSongDeps): Promise<FoundSong> {
  const now = d.now?.() ?? Date.now();
  const rec = await loadSongRecord(d.videoId);
  if (rec?.lyrics?.lines?.length) return { lyrics: rec.lyrics, from: 'kept', aiAsked: false };
  let duration = Number.isFinite(d.duration) && d.duration > 0 ? d.duration : 0;
  if (!duration) { try { duration = pageApi()?.videoLength?.() || 0; } catch { duration = 0; } }
  const ask = d.ask ?? ((msg: Record<string, unknown>) => chrome.runtime.sendMessage(msg) as Promise<{ ok?: boolean; lyrics?: Lyrics | null; reached?: boolean } | null>);
  let reached = false;
  const search = async (names?: SongName | null): Promise<Lyrics | null> => {
    const r = await ask({ type: 'dream-lyrics', title: d.title, channel: d.channel, duration, ...(names ? { artist: names.artist, song: names.title } : {}) }).catch(() => null);
    if (r?.reached !== false && r?.ok) reached = true;
    return r?.lyrics?.lines?.length ? r.lyrics : null;
  };
  let aiName = rec?.aiName;
  let aiAsked = false;
  let lyr: Lyrics | null = null;
  const fresh = !rec?.none || now - rec.none > AGAIN_MS;
  const rules = songOf(d.title, d.channel);
  if (fresh && rules.title) lyr = await search();
  // the rules found nothing usable: the AI names the song, once per video
  if (!lyr && aiName === undefined && d.tutorOn && d.alive?.() !== false && (await (d.hasKey ?? hasKey)())) {
    let description = d.description ?? '';
    if (!description) { try { description = pageApi()?.description?.() ?? ''; } catch { description = ''; } }
    aiAsked = true;
    try { aiName = parseSongName(await d.complete(buildSongNamePrompt(d.title, d.channel, description))); } catch { aiName = undefined; } // (a failed request is not an answer: it may be asked again)
    if (aiName !== undefined) await saveSongRecord(d.videoId, { v: 1, ...(rec ?? {}), aiName });
    if (aiName && aiName.title && !sameName(aiName, rules)) lyr = await search(aiName);
  } else if (!lyr && fresh && aiName && aiName.title && !sameName(aiName, rules)) lyr = await search(aiName);
  if (lyr) lyr = withTimes(lyr, d.captions, duration);
  if (lyr) await saveSongRecord(d.videoId, { v: 1, ...(aiName !== undefined ? { aiName } : {}), lyrics: lyr });
  else if (reached) await saveSongRecord(d.videoId, { v: 1, ...(aiName !== undefined ? { aiName } : {}), none: now });
  return { lyrics: lyr, from: lyr ? 'found' : 'none', aiAsked };
}

async function hasKey(): Promise<boolean> {
  try { const k = await getKeys(); return !!(k.anthropic || k.openai); } catch { return false; }
}

/**
 * The learner's own lyrics for this video (pasted or typed): lines with "[01:02.30]" times are used as they are, any
 * other text is put in time with the captions or spread over the song. Kept for this video. null = no lines in it.
 */
export async function usePastedLyrics(o: { videoId: string; text: string; title: string; channel: string; duration: number; captions: ReadonlyArray<Caption> }): Promise<Lyrics | null> {
  const text = String(o.text ?? '').replace(/\r\n?/g, '\n').slice(0, 30000).trim();
  if (!text) return null;
  let duration = Number.isFinite(o.duration) && o.duration > 0 ? o.duration : 0;
  if (!duration) { try { duration = pageApi()?.videoLength?.() || 0; } catch { duration = 0; } }
  const rec = await loadSongRecord(o.videoId);
  const name = rec?.lyrics ? { artist: rec.lyrics.artist, title: rec.lyrics.title } : rec?.aiName?.title ? rec.aiName : songOf(o.title, o.channel);
  const stamped = text.split('\n').filter((l) => /^\s*\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(l)).length;
  let lyr: Lyrics;
  if (stamped >= 3) {
    const lines = parseLrc(text, duration);
    if (!lines.length) return null;
    lyr = { artist: name.artist, title: name.title || o.title, lines, synced: true, source: 'pasted' };
  } else {
    if (!plainLines(text).length) return null;
    const t = timePlain(text, captionWords(o.captions), duration);
    if (!t.lines.length) return null;
    lyr = { artist: name.artist, title: name.title || o.title, lines: t.lines, synced: false, source: 'pasted', plain: text, timing: t.timing };
  }
  await saveSongRecord(o.videoId, { v: 1, ...(rec?.aiName !== undefined ? { aiName: rec.aiName } : {}), lyrics: lyr });
  return lyr;
}

/** the lyrics as the sentences of the page; `starts` = the lines (from 0) that begin a new part (a verse, a section) */
export function lyricSentences(lyr: Lyrics, starts?: ReadonlySet<number>): { start: number; end: number; text: string; words: null; para: boolean }[] {
  let verse = -1;
  return lyr.lines.map((l, i) => {
    const para = starts && starts.size ? starts.has(i) : l.verse !== verse;
    verse = l.verse;
    return { start: l.start, end: l.end, text: l.text, words: null, para };
  });
}
