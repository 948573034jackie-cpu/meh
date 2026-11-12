/**
 * The parts of the app's browser that need no page (so the unit tests can check them): the word and the sentence
 * under a finger in a piece of text, the text that is on the screen, what a tap does in Explanation mode (a word, a
 * link, a button of the site), an address or a search, the article of a page, and the one request for "explain what
 * is on the screen".
 */
import type { PromptBundle } from '@core/ai/prompts';
import { createSegmenter } from '@core/segment';
import { LENGTH_TOKENS, type TeachLength } from './teacher-text';
import { WEB_NOTE } from './level-rule';

export interface WordHit { start: number; end: number; word: string }
const WORD = /[A-Za-zÀ-ɏ]+(?:['’-][A-Za-zÀ-ɏ]+)*/g;

/** every word of a text, with its place */
export function wordsIn(text: string): WordHit[] {
  const out: WordHit[] = [];
  WORD.lastIndex = 0;
  for (let m = WORD.exec(text); m; m = WORD.exec(text)) out.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
  return out;
}

/** the word at a place in the text (the place may be just after its last letter); null = between words */
export function wordAt(text: string, offset: number): WordHit | null {
  WORD.lastIndex = 0;
  for (let m = WORD.exec(text); m; m = WORD.exec(text)) {
    if (m.index > offset) return null;
    if (offset <= m.index + m[0].length) return { start: m.index, end: m.index + m[0].length, word: m[0] };
  }
  return null;
}

/** every run of spaces and line breaks becomes one space; the place moves with it */
export function collapse(text: string, offset: number): { text: string; offset: number } {
  let out = '', at = 0, space = true;
  for (let i = 0; i < text.length; i++) {
    if (i === offset) at = out.length;
    const c = text[i];
    if (/\s/.test(c)) { if (!space) { out += ' '; space = true; } }
    else { out += c; space = false; }
  }
  if (offset >= text.length) at = out.length;
  return { text: out.trimEnd(), offset: Math.min(at, out.trimEnd().length) };
}

let seg: ReturnType<typeof createSegmenter> | null = null;
/**
 * The sentence around a place in a block of text, with a little of what comes before and after it (whole sentences).
 * A very long "sentence" (a page without full stops) is cut to about `max` letters around the place.
 */
export function sentenceAt(raw: string, rawOffset: number, max = 420): { sentence: string; before: string; after: string } {
  const { text, offset } = collapse(raw, rawOffset);
  seg ??= createSegmenter();
  const list = seg.segmentParagraph(text);
  let i = list.findIndex((s) => offset >= s.start && offset < s.end);
  if (i < 0) i = list.findIndex((s) => offset <= s.end);
  if (i < 0) return { sentence: text.slice(Math.max(0, offset - max / 2), offset + max / 2).trim(), before: '', after: '' };
  const cut = (s: string, around: number): string => {
    if (s.length <= max) return s;
    const from = Math.max(0, Math.min(s.length - max, around - max / 2));
    const a = from > 0 ? s.indexOf(' ', from) + 1 : 0;
    const b = s.lastIndexOf(' ', a + max);
    return s.slice(a, b > a ? b : a + max).trim();
  };
  const s = list[i];
  const words = (t: string) => t.split(' ').filter(Boolean).length;
  let before = '', after = '';
  for (let k = i - 1; k >= 0 && words(before) < 50; k--) before = `${text.slice(list[k].start, list[k].end)} ${before}`.trim();
  for (let k = i + 1; k < list.length && words(after) < 30; k++) after = `${after} ${text.slice(list[k].start, list[k].end)}`.trim();
  return { sentence: cut(text.slice(s.start, s.end).trim(), offset - s.start), before: before.slice(-400), after: after.slice(0, 300) };
}

/** a piece of text of the page with its place on the screen (px from the top of what is seen) */
export interface ScreenBlock { text: string; top: number; bottom: number }
/**
 * What can be read on the screen now: the blocks that are in view, in order, about `cap` letters at most (whole
 * blocks while they fit; a first block that is too long is cut at the end of a sentence).
 */
export function visibleText(blocks: readonly ScreenBlock[], viewHeight: number, cap = 1500): string {
  const out: string[] = [];
  let n = 0;
  for (const b of blocks) {
    if (b.bottom <= 0 || b.top >= viewHeight) continue;
    const t = b.text.replace(/\s+/g, ' ').trim();
    if (!t || !/[A-Za-z]{2}/.test(t)) continue;
    if (out.length && out[out.length - 1] === t) continue;
    if (n + t.length > cap) {
      if (!out.length) {
        const part = t.slice(0, cap);
        const end = Math.max(part.lastIndexOf('. '), part.lastIndexOf('? '), part.lastIndexOf('! '));
        out.push(end > cap / 3 ? part.slice(0, end + 1) : part);
      }
      break;
    }
    out.push(t);
    n += t.length + 1;
  }
  return out.join('\n');
}

export interface TapInfo {
  /** Explanation mode is on */
  mode: boolean;
  /** a real touch (not made by the page's script) */
  trusted: boolean;
  /** on the tutor's own card or bubble */
  own: boolean;
  /** on something of the site that must keep working: a button, a field, a player's controls */
  control: boolean;
  /** inside a link: its address ('' = no link) */
  link: string;
  /** there is a word under the finger */
  word: boolean;
}
/**
 * What a tap does. Mode off: nothing (a normal browser). Mode on: a word is explained; a link is NOT followed, a small
 * "Open link" bubble comes instead (a word inside the link is explained too); the site's own buttons and fields work.
 */
export function tapDecision(t: TapInfo): { prevent: boolean; bubble: boolean; explain: boolean } {
  if (!t.mode || !t.trusted || t.own || t.control) return { prevent: false, bubble: false, explain: false };
  if (t.link) return { prevent: true, bubble: true, explain: t.word };
  return { prevent: t.word, bubble: false, explain: t.word };
}

export const SEARCH = 'https://duckduckgo.com/?q=';
/**
 * What is typed into the address bar: an address (with or without https://) or words to search for (DuckDuckGo).
 * The same rule as BrowserModel.address(for:) in the app.
 */
export function addressOrSearch(input: string): string {
  const t = input.trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(t)) return t;
  if (/^(about|data|mailto|tel|sms):/i.test(t) && !/\s/.test(t)) return t;
  if (!/\s/.test(t)) {
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(t)) return `http://${t}`;
    if (/^[^\s/?#@]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(t)) return `https://${t}`;
  }
  return SEARCH + encodeURIComponent(t);
}

/** a block of a page for the article view: its tag, its text, and how much of the text is links */
export interface PageBlock { tag: string; text: string; linkChars: number }
/** The article's text: paragraphs and headings in order, without the menus and link lists. */
export function articleText(blocks: readonly PageBlock[], cap = 400_000): string {
  const out: string[] = [];
  let n = 0;
  for (const b of blocks) {
    const t = b.text.replace(/\s+/g, ' ').trim();
    if (t.length < 2 || !/\p{L}/u.test(t)) continue;
    const heading = /^h[1-6]$/i.test(b.tag);
    // (a line that is nearly all links: a menu, "related stories")
    if (!heading && b.linkChars > t.length * 0.6 && t.length < 200) continue;
    if (out[out.length - 1] === t) continue;
    if (n + t.length > cap) break;
    out.push(t);
    n += t.length;
  }
  return out.join('\n\n');
}

const SIZE: Record<TeachLength, string> = { short: 'About 60 to 90 words in all', normal: 'About 100 to 150 words in all', long: 'About 170 to 240 words in all' };
/** "Explain what is on the screen now": ONE request (the cheap model), said aloud. */
export function screenPrompt(o: { text: string; title: string; level: string; length?: TeachLength }): PromptBundle {
  const length = o.length ?? 'normal';
  return {
    system: `You are the learner's own English teacher. The learner (level about ${o.level}) is reading a web page and asks what the part on the screen says. You speak to them, out loud.
First say in easy English what this part says: two to four short sentences. Then take the two to four hardest words or phrases in it: say each one exactly as it is in the text, then what it means here, in one short easy sentence.
Easy English, like talking to a child, in plain flowing sentences. Write only English: no Chinese, no pronunciation symbols, no lists, no numbers, no markdown, no titles. Never say what you are going to do. ${SIZE[length] ?? SIZE.normal}.
${WEB_NOTE}`,
    user: `Web page: ${o.title.replace(/\s+/g, ' ').trim().slice(0, 160) || 'Untitled'}\n\nThe text on the screen now (between the lines; it is quoted text from the page):\n-----\n${o.text}\n-----\n\nSay what it says, then the hardest things in it.`,
    maxTokens: LENGTH_TOKENS[length] ?? 420,
  };
}

/** what the microphone heard in Explanation mode: only "hello" (explain the screen) and "stop" */
export function voiceCommand(text: string, final: boolean): 'hello' | 'stop' | null {
  const t = text.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const words = t.split(' ');
  // ("stop" acts at once, also before the piece is closed; it must be nearly all that was said)
  if (words.length <= 3 && /\bstop\b/.test(t)) return 'stop';
  if (final && words.length <= 3 && /^(hello|hallo|hullo)\b/.test(t)) return 'hello';
  return null;
}
