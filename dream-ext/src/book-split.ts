/**
 * I Know Book: a big book is kept in light parts, so a page turns and a tap answers at once on an iPhone.
 * A PDF often has no paragraph breaks at all (its whole text is one "paragraph"), and one EPUB chapter can be a
 * hundred pages: both are cut here, at the end of a sentence, never inside one.
 *
 *  - a paragraph longer than MAX_BLOCK letters is cut into paragraphs of whole sentences;
 *  - a chapter longer than PART_CHARS letters (or PART_BLOCKS paragraphs) is cut into parts.
 *
 * Nothing is lost or added by a cut: the pieces put together are the text again, letter for letter. So the place in
 * the book is a letter count (offsetOfPlace / placeOfOffset), and a book stored in the old, heavy way is cut when it
 * is opened with the reader still at the same sentence.
 */
import type { RawParagraph } from '@core/import/text';
import type { RawChapter } from './epub';

export const MAX_BLOCK = 1400;
export const PART_CHARS = 14000;
export const PART_BLOCKS = 250;
/** stored with a book that was cut this way (its kept AI work is kept under a new name: the parts changed) */
export const SPLIT_VERSION = 2;

/** a paragraph as long as this is cut, whatever else (splitLong leaves one long sentence whole up to here) */
const HEAVY_BLOCK = MAX_BLOCK * 1.5;
/** a chapter as long as this is cut into parts */
const HEAVY_CHARS = PART_CHARS * 1.3;
const HEAVY_BLOCKS = PART_BLOCKS + 70;

/** a short word with a full stop that ends no sentence ("Mr. Smith", "J. K. Rowling", "e.g. this") */
const NO_END = /(?:^|[\s("“‘'])(?:[A-Za-z]|Mr|Mrs|Ms|Dr|St|Mt|Prof|Sr|Jr|vs|etc|No|Vol|Fig|e\.g|i\.e|cf)\.$/;
const END = /[.!?…]+["”’'»)\]]*\s+|[。！？]+[」』”’）]*\s*/gu;

/** the text's sentences, each with the spaces after it; put together they are the text again */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const m of text.matchAll(END)) {
    const end = m.index + m[0].length;
    if (end >= text.length) break;
    // ("He stopped... and went on", "Mr. Smith": the sentence goes on)
    const next = text[end];
    if (/\s$/.test(m[0]) && (/\p{Ll}/u.test(next) || NO_END.test(text.slice(Math.max(from, end - m[0].length - 8), end).trimEnd()))) continue;
    out.push(text.slice(from, end));
    from = end;
  }
  if (from < text.length) out.push(text.slice(from));
  return out.length ? out : [text];
}

/** a long paragraph -> paragraphs of whole sentences, each about `max` letters at most (together: the same text) */
export function splitLong(text: string, max = MAX_BLOCK): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  const push = () => { if (cur) out.push(cur); cur = ''; };
  for (const s of sentencesOf(text)) {
    if (s.length > max * 1.5) {
      // (one "sentence" with no end in sight, e.g. a PDF without any full stop: cut between words)
      push();
      let rest = s;
      while (rest.length > max) {
        let at = rest.lastIndexOf(' ', max - 1) + 1;
        if (at < max / 2) at = max;
        out.push(rest.slice(0, at));
        rest = rest.slice(at);
      }
      cur = rest;
      continue;
    }
    if (cur && cur.length + s.length > max) push();
    cur += s;
  }
  push();
  // (a few spaces alone are no paragraph: they stay with the piece before them)
  for (let i = out.length - 1; i > 0; i--) if (!out[i].trim()) { out[i - 1] += out[i]; out.splice(i, 1); }
  return out.length ? out : [text];
}

const lettersOf = (blocks: readonly RawParagraph[]): number => blocks.reduce((n, b) => n + b.text.length, 0);
/** headings stay whole; every other kind of paragraph can be cut */
const canCut = (b: RawParagraph): boolean => !/^h\d$/.test(b.kind);
/** has it anything to read (the reader drops a block of spaces or invisible marks: it is no paragraph) */
const real = (text: string): boolean => text.replace(/[​⁠﻿]/g, '').trim().length > 0;

/** is any part of this book heavy (it is cut when it is opened) */
export function needsSplit(chapters: readonly RawChapter[]): boolean {
  return chapters.some((c) => c.blocks.length > HEAVY_BLOCKS || lettersOf(c.blocks) > HEAVY_CHARS || c.blocks.some((b) => canCut(b) && b.text.length > HEAVY_BLOCK));
}

/** a chapter's title without its part, and which part it is ("The Storm · Part 2 of 7" -> The Storm, 2, 7) */
export function partTitle(title: string): { base: string; part: number; of: number } {
  const m = /^(?:(.*?) · )?Part (\d+) of (\d+)$/.exec(title ?? '');
  return m ? { base: m[1] ?? '', part: Number(m[2]), of: Number(m[3]) } : { base: title ?? '', part: 1, of: 1 };
}

/**
 * Parts made the old way ("The Storm (2 of 5)", "Part (2 of 5)": 250 paragraphs each) are put together again, so the
 * new cut names them once. The letters and their order stay the same.
 */
export function joinOldParts(chapters: readonly RawChapter[]): RawChapter[] {
  const out: RawChapter[] = [];
  let run: { base: string; next: number; of: number } | null = null;
  for (const c of chapters) {
    const m = /^(.*) \((\d+) of (\d+)\)$/.exec(c.title ?? '');
    if (m && run && run.base === m[1] && run.next === Number(m[2]) && run.of === Number(m[3])) {
      const last = out[out.length - 1];
      out[out.length - 1] = { ...last, blocks: [...last.blocks, ...c.blocks] };
      run.next++;
      continue;
    }
    if (m && Number(m[2]) === 1 && Number(m[3]) > 1) { run = { base: m[1], next: 2, of: Number(m[3]) }; out.push({ ...c, title: m[1] === 'Part' ? '' : m[1] }); continue; }
    run = null;
    out.push(c);
  }
  return out;
}

/** the chapters, with long paragraphs and long chapters cut (short ones are left as they are) */
export function splitChapters(chapters: readonly RawChapter[]): RawChapter[] {
  const out: RawChapter[] = [];
  for (const c of chapters) {
    const blocks: RawParagraph[] = c.blocks.flatMap((b) => (canCut(b) && b.text.length > MAX_BLOCK ? splitLong(b.text).map((text) => ({ ...b, text })) : [b]));
    if (blocks.length <= HEAVY_BLOCKS && lettersOf(blocks) <= HEAVY_CHARS) { out.push({ ...c, blocks }); continue; }
    const groups: RawParagraph[][] = [];
    let cur: RawParagraph[] = [], n = 0;
    for (const b of blocks) {
      if (cur.length && (cur.length >= PART_BLOCKS || n + b.text.length > PART_CHARS)) { groups.push(cur); cur = []; n = 0; }
      cur.push(b); n += b.text.length;
    }
    if (cur.length) groups.push(cur);
    // (a last part of a few lines goes with the one before it)
    if (groups.length > 1) {
      const last = groups[groups.length - 1], before = groups[groups.length - 2];
      if (lettersOf(last) < PART_CHARS / 5 && last.length + before.length <= HEAVY_BLOCKS && lettersOf(last) + lettersOf(before) <= HEAVY_CHARS) { groups.pop(); before.push(...last); }
    }
    const total = groups.length;
    groups.forEach((g, i) => out.push({ ...c, title: total > 1 ? `${c.title ? `${c.title} · ` : ''}Part ${i + 1} of ${total}` : c.title, blocks: g }));
  }
  return out;
}

/** was anything cut (more chapters, or more paragraphs in one) */
export function wasCut(before: readonly RawChapter[], after: readonly RawChapter[]): boolean {
  return before.length !== after.length || before.some((c, i) => c.blocks.length !== after[i].blocks.length);
}

/** the paragraph number a block has once the chapter is read (empty blocks are no paragraphs) */
export function paragraphOfBlock(ch: RawChapter, block: number): number {
  let n = 0;
  for (let i = 0; i < block && i < ch.blocks.length; i++) if (real(ch.blocks[i].text)) n++;
  return n;
}
/** the block a paragraph number came from */
export function blockOfParagraph(ch: RawChapter, paragraph: number): number {
  let n = 0;
  for (let i = 0; i < ch.blocks.length; i++) {
    if (!real(ch.blocks[i].text)) continue;
    if (n === paragraph) return i;
    n++;
  }
  return Math.max(0, ch.blocks.length - 1);
}

/** how many letters of the book come before this place (its paragraph's start, plus `within` letters into it) */
export function offsetOfPlace(chapters: readonly RawChapter[], place: { chapter: number; paragraph: number }, within = 0): number {
  let n = 0;
  for (let c = 0; c < place.chapter && c < chapters.length; c++) n += lettersOf(chapters[c].blocks);
  const ch = chapters[place.chapter];
  if (!ch) return n;
  const b = blockOfParagraph(ch, place.paragraph);
  for (let i = 0; i < b; i++) n += ch.blocks[i].text.length;
  return n + Math.max(0, Math.min(within, (ch.blocks[b]?.text.length ?? 1) - 1));
}
/** the place of the paragraph that holds this letter of the book; `within`: how many letters into the paragraph */
export function placeOfOffset(chapters: readonly RawChapter[], offset: number): { chapter: number; paragraph: number; sentence: number; within: number } {
  let left = Math.max(0, offset);
  for (let c = 0; c < chapters.length; c++) {
    const len = lettersOf(chapters[c].blocks);
    if (left < len || c === chapters.length - 1) {
      const blocks = chapters[c].blocks;
      for (let b = 0; b < blocks.length; b++) {
        if (left < blocks[b].text.length || b === blocks.length - 1) return { chapter: c, paragraph: paragraphOfBlock(chapters[c], b), sentence: 0, within: Math.min(left, blocks[b].text.length) };
        left -= blocks[b].text.length;
      }
      return { chapter: c, paragraph: 0, sentence: 0, within: 0 };
    }
    left -= len;
  }
  return { chapter: 0, paragraph: 0, sentence: 0, within: 0 };
}

// The reader does not have a stored paragraph letter for letter: every run of spaces is one space, none stand in
// front, and invisible marks are gone. These two go from one count to the other (for the place of a sentence).
const INVISIBLE = /[\u200B\u2060\uFEFF]/;
/** how many letters the reader has before the stored text's letter `at` */
export function readLetters(text: string, at: number): number {
  let n = 0, space = true;
  for (let i = 0; i < at && i < text.length; i++) {
    const ch = text[i];
    if (INVISIBLE.test(ch)) continue;
    const ws = /\s/.test(ch);
    if (ws && space) continue;
    n++; space = ws;
  }
  return n;
}
/** the stored text's letter where the reader's letter `n` is */
export function storedLetter(text: string, n: number): number {
  let seen = 0, space = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (INVISIBLE.test(ch)) continue;
    const ws = /\s/.test(ch);
    if (ws && space) continue;
    if (seen === n) return i;
    seen++; space = ws;
  }
  return text.length;
}

/**
 * A book stored the old way, cut into light parts: its chapters, and where the reader is now. `within`: how many
 * letters into the old paragraph the reader's sentence starts; the answer's `within` is the same letter in its new
 * paragraph (the caller finds the sentence there).
 */
export function recut(chapters: readonly RawChapter[], place: { chapter: number; paragraph: number }, within = 0): { chapters: RawChapter[]; place: { chapter: number; paragraph: number; sentence: number; within: number } } {
  const cut = splitChapters(joinOldParts(chapters));
  return { chapters: cut, place: placeOfOffset(cut, offsetOfPlace(chapters, place, within)) };
}

export interface SearchHit { chapter: number; block: number; at: number; before: string; match: string; after: string }
/** every place where the words are found (as they are written, big or small letters alike), in book order */
export function searchBook(chapters: readonly RawChapter[], query: string, max = 300): { hits: SearchHit[]; more: boolean } {
  const q = query.replace(/\s+/g, ' ').trim().toLowerCase();
  const hits: SearchHit[] = [];
  if (q.length < 2) return { hits, more: false };
  for (let c = 0; c < chapters.length; c++) {
    const blocks = chapters[c].blocks;
    for (let b = 0; b < blocks.length; b++) {
      const text = blocks[b].text.replace(/\s+/g, ' ');
      const low = text.toLowerCase();
      // (a rare letter is longer in small letters: then the places would not fit the text, so that paragraph is read as it is)
      const hay = low.length === text.length ? low : text;
      let at = hay.indexOf(q);
      while (at >= 0) {
        if (hits.length >= max) return { hits, more: true };
        const from = Math.max(0, at - 50), to = Math.min(text.length, at + q.length + 70);
        hits.push({ chapter: c, block: b, at, before: (from > 0 ? '…' : '') + text.slice(from, at), match: text.slice(at, at + q.length), after: text.slice(at + q.length, to) + (to < text.length ? '…' : '') });
        at = hay.indexOf(q, at + q.length);
      }
    }
  }
  return { hits, more: false };
}
