/**
 * Lyrics mode like a lyrics-and-meaning page: ONE AI request per song (kept with the song, never asked again) gives
 * - `about`: what the song is about and the story behind it (shown at the top, and said by the tutor before the song);
 * - `sections`: the parts of the song with their headings ([Intro] [Verse 1] [Chorus] [Bridge] …; the lyrics sources
 *   have no headings);
 * - `notes`: for the 8-16 lines that most need it, what the line really means in the song (wordplay, slang,
 *   references, the feeling, how it fits the story), in easy English.
 * The notes are written by the AI for this learner, in its own words. No annotation site is ever fetched or copied.
 * A tap on a highlighted line only shows what is kept here: no AI request per line. With the tutor off or no key
 * nothing is asked (the plain lyrics still show).
 */
import type { Lyrics } from './lyrics';

export interface SongSection { /** the first and the last line, from 0 */ from: number; to: number; name: string }
export interface SongNotes {
  v: 1;
  about: string;
  sections: SongSection[];
  /** line (from 0) -> its note */
  notes: Record<number, string>;
  /** how many lines the lyrics had (other lyrics = other notes) */
  lines: number;
}

type Prompt = { system: string; user: string; maxTokens: number };

/** the one request of a song */
export function buildSongPrompt(lyr: Pick<Lyrics, 'title' | 'artist' | 'album' | 'lines'>, level: string): Prompt {
  const system = `You are a music teacher and an English teacher. Your student is a musician from China who learns English through songs; their English level is about ${level}. You explain a song's lyrics and their meaning, in your own words and in easy English, like a friend who knows the song well. Reply with JSON only: no other text, no code fences.`;
  const lines = lyr.lines.map((l, i) => `${i + 1}. ${l.text}`).join('\n');
  const user = [
    `The song: "${lyr.title}"${lyr.artist ? ` by ${lyr.artist}` : ''}${lyr.album ? `, from the album "${lyr.album}"` : ''}.`,
    `Its lyrics, one numbered line each:\n${lines}`,
    'Write three things.',
    '"about": what the song is about and the story behind it (who made it, when, why, what was happening in their life or in the world), 80 to 140 words, in easy English, as plain flowing speech: it is read aloud before the song plays. Only facts you are sure of; when you are not sure, say "people say" or leave it out. Never invent dates, names or stories.',
    '"sections": the parts of the song in order, every line in exactly one part: "from" = its first line number, "to" = its last line number, "name" = Intro, Verse 1, Verse 2, Pre-Chorus, Chorus, Post-Chorus, Hook, Bridge, Interlude or Outro. Find the chorus by its repeated lines: the lines that come back are the chorus, each time they come.',
    '"notes": for the 8 to 16 lines that most need it (fewer for a very short song; a line that is repeated only the first time): "line" = the line number, "note" = 1 to 3 short sentences in easy English that say what the line really means in this song: the wordplay, the slang, a reference, the feeling, how it fits the song\'s story.',
    'Write your own words. Do not reproduce annotations or explanations that are published anywhere, and quote at most a few words of a line. No Chinese, no markdown, no labels inside the texts.',
    'JSON: {"about":"...","sections":[{"from":1,"to":4,"name":"Verse 1"}],"notes":[{"line":3,"note":"..."}]}',
  ].join('\n\n');
  // (the answer grows with the song: about 200 tokens for "about", 25 per part, 70 per note)
  return { system, user, maxTokens: 2600 };
}

const tryParse = (t: string): unknown => { try { return JSON.parse(t); } catch { return undefined; } };
const text = (x: unknown, max: number): string => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const int = (x: unknown): number => (typeof x === 'number' ? Math.round(x) : typeof x === 'string' && /^\s*\d+\s*$/.test(x) ? parseInt(x, 10) : NaN);

/** the parts in order, inside the song, never one over another; a part's name without its brackets */
export function tidySections(raw: readonly SongSection[], lines: number): SongSection[] {
  const out: SongSection[] = [];
  let next = 0;
  for (const s of [...raw].filter((x) => Number.isFinite(x.from) && Number.isFinite(x.to)).sort((a, b) => a.from - b.from || a.to - b.to)) {
    const from = Math.max(next, Math.max(0, s.from)), to = Math.min(lines - 1, s.to);
    const name = s.name.replace(/^[[(\s]+|[\])\s:]+$/g, '').slice(0, 30);
    if (!name || from > to) continue;
    out.push({ from, to, name });
    next = to + 1;
  }
  return out;
}

/**
 * The AI's answer -> the song's notes (line numbers from 0). Strict JSON is asked for; code fences and text around it
 * are accepted; of a cut-off answer the complete parts are kept ("about", every finished section and note).
 * null = nothing usable in it.
 */
export function parseSongReply(reply: string, lines: number): SongNotes | null {
  const s = String(reply ?? '').replace(/```(?:json)?/gi, '').trim();
  let data = tryParse(s);
  if (data === undefined) { const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) data = tryParse(s.slice(a, b + 1)); }
  let about = '';
  let secs: unknown[] = [], notes: unknown[] = [];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    about = text(o.about ?? o.summary ?? o.story, 1400);
    if (Array.isArray(o.sections ?? o.parts)) secs = (o.sections ?? o.parts) as unknown[];
    if (Array.isArray(o.notes ?? o.annotations)) notes = (o.notes ?? o.annotations) as unknown[];
  } else {
    // cut off or broken: the finished pieces
    const m = /"about"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
    if (m) about = text(tryParse(`"${m[1]}"`) ?? m[1], 1400);
    for (const x of s.matchAll(/\{[^{}]*\}/g)) {
      const o = tryParse(x[0]);
      if (!o || typeof o !== 'object') continue;
      if ('from' in (o as object)) secs.push(o); else if ('line' in (o as object)) notes.push(o);
    }
  }
  const sections: SongSection[] = [];
  for (const x of secs) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const from = int(o.from ?? o.start), to = int(o.to ?? o.end ?? o.from ?? o.start), name = text(o.name ?? o.heading ?? o.title, 40);
    if (!Number.isInteger(from) || !Number.isInteger(to) || !name) continue;
    sections.push({ from: from - 1, to: to - 1, name });
  }
  const byLine: Record<number, string> = {};
  let count = 0;
  for (const x of notes) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const line = int(o.line ?? o.n ?? o.number), note = text(o.note ?? o.text ?? o.meaning, 480);
    if (!Number.isInteger(line) || line < 1 || line > lines || !note || byLine[line - 1]) continue;
    byLine[line - 1] = note;
    if (++count >= 24) break;
  }
  const tidy = tidySections(sections, lines);
  if (!about && !tidy.length && !count) return null;
  return { v: 1, about, sections: tidy, notes: byLine, lines };
}

/** asks the AI once for this song; null = no usable answer (throws when the request itself fails) */
export async function askSongNotes(lyr: Pick<Lyrics, 'title' | 'artist' | 'album' | 'lines'>, level: string, complete: (p: Prompt) => Promise<string>): Promise<SongNotes | null> {
  if (!lyr.lines.length) return null;
  return parseSongReply(await complete(buildSongPrompt(lyr, level)), lyr.lines.length);
}

const same = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The note of every line that has one: the AI's notes, and the same note for the lines that say the very same
 * (a chorus that comes back is explained each time, with no new request).
 */
export function notesByLine(notes: SongNotes | null, lyr: Pick<Lyrics, 'lines'> | null): Map<number, string> {
  const out = new Map<number, string>();
  if (!notes || !lyr) return out;
  const byText = new Map<string, string>();
  for (const [k, note] of Object.entries(notes.notes)) {
    const i = Number(k);
    const l = lyr.lines[i];
    if (!l || !note) continue;
    out.set(i, note);
    const key = same(l.text);
    if (key && !byText.has(key)) byText.set(key, note);
  }
  lyr.lines.forEach((l, i) => { if (!out.has(i)) { const n = byText.get(same(l.text)); if (n) out.set(i, n); } });
  return out;
}

/** where each part starts: line (from 0) -> "Verse 1" */
export function sectionStarts(notes: SongNotes | null): Map<number, string> {
  const out = new Map<number, string>();
  for (const s of notes?.sections ?? []) out.set(s.from, s.name);
  return out;
}

/** a note that can be read at a stop instead of asking the AI: a real explanation, not two words */
export const noteIsEnough = (note: string | undefined): note is string => !!note && note.trim().split(/\s+/).length >= 8;

/**
 * What the explanations of this song know: the song's story, and (for one line) that line's own note; without a line,
 * the notes of all lines (for the one-time analysis of the whole song).
 */
export function songContext(notes: SongNotes | null, lyr: Pick<Lyrics, 'lines'> | null, line?: number): string | undefined {
  if (!notes) return undefined;
  const parts: string[] = [];
  if (notes.about) parts.push(notes.about);
  const by = notesByLine(notes, lyr);
  const short = (i: number): string => (lyr?.lines[i]?.text ?? '').split(/\s+/).slice(0, 8).join(' ');
  if (line !== undefined) { const n = by.get(line); if (n) parts.push(`About this line ("${short(line)}"): ${n}`); }
  else {
    const own = Object.keys(notes.notes).map(Number).sort((a, b) => a - b).filter((i) => by.has(i));
    if (own.length) parts.push(`What some lines mean:\n${own.map((i) => `- "${short(i)}": ${by.get(i)}`).join('\n')}`);
  }
  return parts.length ? parts.join('\n') : undefined;
}

// ---------- kept with the song ----------

const KEY = (id: string) => `drSongNotes:${id}`;
const INDEX = 'drSongNotesIndex', KEEP = 80;
const area = (): chrome.storage.StorageArea | null => { try { return chrome.storage.local; } catch { return null; } };

/** the kept notes of a song (id = the lyrics cache id); null when there are none, or they were made for other lyrics */
export async function loadSongNotes(id: string, lines: number): Promise<SongNotes | null> {
  try {
    const o = await area()?.get(KEY(id));
    const n = o?.[KEY(id)] as SongNotes | undefined;
    if (!n || typeof n !== 'object' || n.v !== 1 || n.lines !== lines) return null;
    return { v: 1, about: text(n.about, 1400), sections: tidySections(Array.isArray(n.sections) ? n.sections : [], lines), notes: { ...(n.notes ?? {}) }, lines };
  } catch { return null; }
}
export async function saveSongNotes(id: string, notes: SongNotes): Promise<void> {
  const a = area();
  if (!a) return;
  try {
    await a.set({ [KEY(id)]: notes });
    const list = (((await a.get(INDEX))[INDEX] as string[] | undefined) ?? []).filter((x) => x !== id);
    list.push(id);
    const drop = list.splice(0, Math.max(0, list.length - KEEP));
    await a.set({ [INDEX]: list });
    if (drop.length) await a.remove(drop.map(KEY));
  } catch { /* not kept this time */ }
}
/** other lyrics for this video (pasted): its notes were for the old ones */
export async function dropSongNotes(id: string): Promise<void> {
  try { await area()?.remove(KEY(id)); } catch { /* nothing to drop */ }
}
