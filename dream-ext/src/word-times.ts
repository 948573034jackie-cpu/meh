/**
 * When each word of a spoken text is said, for the line under the spoken word. Exact times come from the voice service
 * when it gives them (ElevenLabs: the start and end of every letter); for the voices that give none (Microsoft, OpenAI)
 * they are estimated from the length of the sound: longer words take longer, and the voice rests after , ; : and . ! ?
 * wordAt() reads them a little early: the line may lead the voice, it must never be late.
 */
import type { WordTime } from '@core/tts/engine';
export type { WordTime };

/** ElevenLabs "with-timestamps": every letter of the text with its start and end, in seconds */
export interface Alignment { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
/** the words of a text as the line follows them: letters and digits, with ' and - inside (never at the end) */
export function wordSpans(text: string): { charStart: number; charEnd: number }[] {
  const out: { charStart: number; charEnd: number }[] = [];
  WORD.lastIndex = 0;
  for (let m = WORD.exec(text); m; m = WORD.exec(text)) out.push({ charStart: m.index, charEnd: m.index + m[0].replace(/['’\-]+$/, '').length });
  return out;
}

const fold = (c: string): string => (c === '’' || c === '‘' ? "'" : c === '“' || c === '”' ? '"' : c.toLowerCase());

/**
 * The service's letter times -> the times of the words of `text`. The service spoke the text as it was sent (trimmed);
 * a letter it changed or left out is passed over, and a word none of whose letters has a time gets the gap between
 * its neighbours. [] when nothing fits.
 */
export function wordsFromAlignment(text: string, a: Alignment): WordTime[] {
  // one entry for every UTF-16 unit the service spoke
  const ch: string[] = [], st: number[] = [], en: number[] = [];
  a.characters.forEach((c, i) => { for (const u of c.split('')) { ch.push(fold(u)); st.push(a.character_start_times_seconds[i]); en.push(a.character_end_times_seconds[i]); } });
  // each letter of the text -> its letter in the service's list (-1 = not found within the next few)
  const at = new Int32Array(text.length).fill(-1);
  let j = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    const c = fold(text[i]);
    let k = j, passed = 0;
    while (k < ch.length && ch[k] !== c && passed < 6) { if (!/\s/.test(ch[k])) passed++; k++; }
    if (k < ch.length && ch[k] === c) { at[i] = k; j = k + 1; }
  }
  const good = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
  const out: WordTime[] = [];
  const open: number[] = []; // words still without a time
  let any = false;
  for (const w of wordSpans(text)) {
    let first = -1, last = -1;
    for (let i = w.charStart; i < w.charEnd; i++) if (at[i] >= 0 && good(st[at[i]]) && good(en[at[i]])) { if (first < 0) first = at[i]; last = at[i]; }
    if (first < 0) { open.push(out.length); out.push({ start: NaN, end: NaN, ...w }); continue; }
    any = true;
    out.push({ start: st[first], end: en[last], ...w });
  }
  if (!any) return [];
  for (const i of open) {
    let p = i - 1, n = i + 1;
    while (p >= 0 && !good(out[p].end)) p--;
    while (n < out.length && !good(out[n].start)) n++;
    const from = p >= 0 ? out[p].end : 0;
    out[i].start = from;
    out[i].end = n < out.length ? Math.max(from, out[n].start) : from;
  }
  // (times only go forward)
  let t = 0;
  for (const w of out) { w.start = Math.max(t, w.start); w.end = Math.max(w.start, w.end); t = w.start; }
  return out;
}

/** about how many beats a word has: its groups of vowels (a silent e at the end aside); a digit is said as a word */
function beats(word: string): number {
  const w = word.toLowerCase();
  const digits = (w.match(/\p{N}/gu) ?? []).length;
  const groups = (w.replace(/e$/, '').match(/[aeiouyà-öø-ÿ]+/g) ?? []).length;
  // (letters of other scripts, Chinese: one beat each)
  const other = (w.match(/[^\p{Script=Latin}\p{N}'’\-]/gu) ?? []).length;
  return Math.max(1, groups + digits * 2 + other);
}

/** how long the voice rests after a word, in the same units as a word's weight */
function rest(after: string): number {
  const m = /^["”’')\]]*([.!?…]+|[,;:]|\s*[—–])/.exec(after);
  if (!m) return 0;
  return /[.!?…]/.test(m[1]) ? 7 : /[,;:]/.test(m[1]) ? 3.5 : 3;
}

/**
 * The times of the words of `text` in a sound `duration` seconds long, for a voice that gives none. Each word gets a
 * share of the time by its beats and letters; after , ; : there is a short rest, after . ! ? a longer one. `lead` and
 * `tail` = seconds of silence at the start and the end of the sound (measured ones when the clip was decoded: see
 * SpeakHandle.clock). Not given: no silence at the start, and a little at the end (services add some), so that a
 * wrong guess makes the line early, never late.
 */
export function estimateWordTimes(text: string, duration: number, o: { lead?: number; tail?: number } = {}): WordTime[] {
  const spans = wordSpans(text);
  if (!spans.length || !(duration > 0)) return [];
  let lead = Math.max(0, o.lead ?? 0), tail = Math.max(0, o.tail ?? Math.min(0.3, duration * 0.06));
  // (silence can not be most of the sound: then the numbers are wrong, and the words get the larger part)
  if (lead + tail > duration * 0.6) { const k = (duration * 0.6) / (lead + tail); lead *= k; tail *= k; }
  const said = spans.map((w, i) => {
    const word = text.slice(w.charStart, w.charEnd);
    return { own: beats(word) * 2 + (word.match(/[\p{L}\p{N}]/gu) ?? []).length * 0.5, rest: i + 1 < spans.length ? rest(text.slice(w.charEnd, spans[i + 1].charStart)) : 0 };
  });
  const total = said.reduce((s, w) => s + w.own + w.rest, 0);
  const unit = (duration - lead - tail) / total;
  let t = lead;
  return spans.map((w, i) => {
    const start = t, end = t + said[i].own * unit;
    t = end + said[i].rest * unit;
    return { start, end, ...w };
  });
}

/**
 * The word being said at `t` seconds (its index in `times`), read `lead` seconds early so the line is on the word when
 * the voice gets there. -1 = before the first word; after the last word it stays on the last one.
 */
export function wordAt(times: readonly WordTime[], t: number, lead = 0.1): number {
  const at = t + lead;
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid].start <= at) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
