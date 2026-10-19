import type { Book, Chapter, Paragraph, Sentence, CefrLevel } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { VocabState, MarkedRange } from '@shared/settings';
import { annotateSentence, type WordInfo } from '@core/vocab/analysis';
import { hintFor } from './hints';

export interface RenderOptions {
  dict: Dictionary;
  names: Set<string>;
  learner: CefrLevel;
  vocab: VocabState['words'];
  marked: MarkedRange[];
  /** Word Wise-style hints (a short Chinese meaning under hard words) as data-hint; default off */
  hints?: boolean;
  /** lemma -> hint text that replaces the dictionary one (a later AI job fills this) */
  hintOverrides?: Record<string, string>;
}

export interface TokenMeta { lemma: string; level: CefrLevel | null; isName: boolean; inDict: boolean; ipa: string; zh: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function stateClass(info: WordInfo, learner: CefrLevel, vocab: VocabState['words']): string {
  if (info.isName || !info.lemma) return '';
  const st = vocab[info.lemma];
  if (st === 'known' || st === 'ignored') return '';
  if (st === 'learning') return 'hl-learning';
  if (info.level && above(info.level, learner)) return 'hl-unknown';
  return '';
}

export function above(level: CefrLevel, learner: CefrLevel): boolean {
  const order = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  return order.indexOf(level) > order.indexOf(learner);
}

/**
 * Builds the HTML of one chapter: one element per paragraph, one span per sentence, one span per word
 * token (data-t = token index) so the highlighter can address them without re-rendering.
 * Returns a per-sentence annotation cache used by the popup.
 */
export function renderChapter(chapter: Chapter, opts: RenderOptions): { html: string; meta: Map<string, (TokenMeta | null)[]> } {
  const meta = new Map<string, (TokenMeta | null)[]>();
  const parts: string[] = [];
  for (const para of chapter.paragraphs) {
    const tag = para.kind === 'h1' || para.kind === 'h2' || para.kind === 'h3' ? para.kind : para.kind === 'li' ? 'li' : para.kind === 'blockquote' ? 'blockquote' : para.kind === 'pre' ? 'pre' : 'p';
    parts.push(`<${tag} class="para k-${para.kind}" data-p="${para.index}">`);
    let cursor = 0;
    for (const s of para.sentences) {
      if (s.start > cursor) parts.push(esc(para.text.slice(cursor, s.start)));
      parts.push(renderSentence(para, s, chapter.index, opts, meta));
      cursor = s.end;
    }
    if (cursor < para.text.length) parts.push(esc(para.text.slice(cursor)));
    parts.push(`</${tag}>`);
  }
  return { html: parts.join(''), meta };
}

export function renderSentence(para: Paragraph, s: Sentence, chapter: number, opts: RenderOptions, meta?: Map<string, (TokenMeta | null)[]>): string {
  const key = `${chapter}.${para.index}.${s.index}`;
  const ann = annotateSentence(para, s, opts.dict, opts.names, opts.learner);
  const marks = opts.marked.filter((m) => m.chapter === chapter && m.paragraph === para.index && m.sentence === s.index);
  const phraseAt = new Map<number, { end: number; lemma: string; level: CefrLevel }>();
  for (const ph of ann.phrases) phraseAt.set(ph.start, { end: ph.end, lemma: ph.result.lemma, level: ph.result.entry.level });
  const metas: (TokenMeta | null)[] = [];
  const out: string[] = [`<span class="s" data-s="${s.index}" data-key="${key}">`];
  let cursor = s.start;
  let phraseEnd = -1;
  for (let i = 0; i < s.tokens.length; i++) {
    const t = s.tokens[i];
    if (t.start > cursor) out.push(esc(para.text.slice(cursor, t.start)));
    const ph = phraseAt.get(i);
    if (ph) {
      const st = opts.vocab[ph.lemma];
      const cls = st === 'known' || st === 'ignored' ? '' : st === 'learning' ? 'hl-learning' : above(ph.level, opts.learner) ? 'hl-unknown' : '';
      out.push(`<span class="ph ${cls}" data-lemma="${esc(ph.lemma)}" data-level="${ph.level}" data-start="${i}" data-end="${ph.end}">`);
      phraseEnd = ph.end - 1; // PhraseSpan.end is exclusive: the span closes after its last word
    }
    const info = ann.infos[i];
    if (t.kind === 'word' && info) {
      const cls = stateClass(info, opts.learner, opts.vocab);
      const inMark = marks.some((m) => t.start >= m.start && t.end <= m.end);
      const hint = opts.hints && phraseEnd < 0 ? hintFor(info, opts.learner, opts.vocab, opts.hintOverrides?.[info.lemma]) : '';
      out.push(`<span class="w${cls ? ' ' + cls : ''}${inMark ? ' hl-marked' : ''}${info.isName ? ' name' : ''}" data-t="${i}" data-lemma="${esc(info.lemma)}"${info.level ? ` data-level="${info.level}"` : ''}${hint ? ` data-hint="${esc(hint)}"` : ''}>${esc(t.text)}</span>`);
      metas.push({ lemma: info.lemma, level: info.level, isName: info.isName, inDict: info.inDict, ipa: info.entry?.ipa ?? '', zh: info.entry?.zh ?? '' });
    } else {
      out.push(`<span class="w ${t.kind}" data-t="${i}">${esc(t.text)}</span>`);
      metas.push(null);
    }
    cursor = t.end;
    if (i === phraseEnd) { out.push('</span>'); phraseEnd = -1; }
  }
  if (cursor < s.end) out.push(esc(para.text.slice(cursor, s.end)));
  out.push('</span>');
  meta?.set(key, metas);
  return out.join('');
}

/**
 * Updates the state class of every span for a lemma after the learner changed its status. A word that is
 * known, learning or ignored loses its hint; a word back to "new" gets it again from `hint`.
 */
export function restyleLemma(root: HTMLElement, lemma: string, status: 'known' | 'learning' | 'ignored' | null, learner: CefrLevel, hint?: string): void {
  const els = root.querySelectorAll<HTMLElement>(`[data-lemma="${CSS.escape(lemma)}"]`);
  for (const el of els) {
    el.classList.remove('hl-unknown', 'hl-learning');
    if (status) delete el.dataset.hint;
    if (status === 'learning') el.classList.add('hl-learning');
    else if (!status) {
      const level = el.dataset.level as CefrLevel | undefined;
      if (level && above(level, learner) && !el.classList.contains('name')) { el.classList.add('hl-unknown'); if (hint && el.classList.contains('w')) el.dataset.hint = hint; }
    }
  }
}

export function sentenceTextOf(book: Book, c: number, p: number, s: number): string {
  const para = book.chapters[c]?.paragraphs[p];
  const sent = para?.sentences[s];
  return para && sent ? para.text.slice(sent.start, sent.end) : '';
}
