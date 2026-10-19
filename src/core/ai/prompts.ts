import type { ExplainRequest, ExplainKind } from '@shared/api';
import type { CefrLevel } from '@core/model';

export interface PromptBundle { system: string; user: string; maxTokens: number }

/**
 * Builds the system prompt (stable across a session, cacheable) and the per-request user message.
 * The reply is spoken aloud, so the prompts insist on plain spoken English and a fixed line format
 * that parseExplanation() turns into script parts.
 */
export function buildPrompt(req: ExplainRequest, opts: { level: CefrLevel; instructions: string; length: 'short' | 'normal' | 'long' }): PromptBundle {
  const system = [
    `You are a patient English tutor inside a reading app. The learner is a native Chinese speaker at CEFR level ${opts.level}.`,
    `Your reply will be SPOKEN ALOUD by a text-to-speech voice. Write for the ear: short sentences, plain common words, no markdown, no bullet points, no headings, no asterisks, no emojis, no phonetic symbols, and do not put quotation marks around words.`,
    `Never translate a whole sentence into Chinese. Use Chinese only for the meaning of single words or short phrases, where the format asks for it.`,
    `Keep to the exact line labels requested. Do not add greetings or closing remarks.`,
    opts.instructions.trim() ? `The learner's own instructions: ${opts.instructions.trim()}` : '',
  ].filter(Boolean).join('\n');

  const len = opts.length;
  const ctx = [
    `Book: ${req.book.title}${req.book.chapter ? ` — ${req.book.chapter}` : ''}`,
    req.before ? `Text before: ${req.before}` : '',
    `Sentence: ${req.sentence}`,
    req.after ? `Text after: ${req.after}` : '',
  ].filter(Boolean).join('\n');

  let task = '';
  let maxTokens = 600;
  const t = req.target;
  const dict = req.dict ? ` (dictionary hint: ${[req.dict.ipa, req.dict.zh, req.dict.level ? `level ${req.dict.level}` : ''].filter(Boolean).join('; ')})` : '';
  switch (req.kind) {
    case 'word':
    case 'phrase': {
      const what = req.kind === 'word' ? 'word' : 'phrase';
      const n = len === 'short' ? 'one short sentence' : len === 'long' ? 'two or three sentences' : 'one or two sentences';
      task = [
        `${what[0].toUpperCase()}${what.slice(1)} to explain: ${t}${dict}`,
        `Answer with exactly these lines, each starting with the label:`,
        `DEFINITION: ${n} saying what ${t} means in general, in simple English.`,
        `IN THIS SENTENCE: ${n} explaining what ${t} means here, in this story, and why the author uses it.`,
        len === 'short' ? '' : `EXAMPLE: one short new example sentence using ${t} with the same meaning.`,
        `CHINESE: the Chinese meaning of ${t} as used here, two to eight characters, nothing else.`,
      ].filter(Boolean).join('\n');
      maxTokens = len === 'long' ? 700 : 450;
      break;
    }
    case 'sentence': {
      task = [
        `Explain this sentence: ${t}`,
        `Answer with exactly these lines, each starting with the label:`,
        `MEANING: ${len === 'short' ? 'one or two' : len === 'long' ? 'three to five' : 'two to four'} short, simple English sentences explaining what this sentence means in the story. Break it into parts if it is long.`,
        `HARD WORDS: up to three difficult words or phrases from the sentence, each as: word, then its simple English meaning, then its Chinese meaning, separated by commas; separate items with semicolons. If there are none, write: none.`,
      ].join('\n');
      maxTokens = len === 'long' ? 800 : 500;
      break;
    }
    case 'passage': {
      task = [
        `Explain this passage the learner just listened to: ${t}`,
        `Answer with exactly these lines, each starting with the label:`,
        `SUMMARY: ${len === 'short' ? 'two' : len === 'long' ? 'four to six' : 'three or four'} short, simple English sentences explaining what happens and what it means.`,
        `HARD WORDS: up to five difficult words or phrases from the passage, each as: word, then its simple English meaning, then its Chinese meaning, separated by commas; separate items with semicolons. If there are none, write: none.`,
      ].join('\n');
      maxTokens = 900;
      break;
    }
    case 'question': {
      task = [`The learner asks: ${req.question ?? ''}`, `Answer in plain spoken English in at most ${len === 'short' ? 60 : len === 'long' ? 180 : 110} words. Give the Chinese meaning of any single word you define.`].join('\n');
      maxTokens = 700;
      break;
    }
  }
  const history = req.history.length ? `Earlier in this chapter you were asked:\n${req.history.slice(-6).map((h) => `${h.role === 'user' ? 'Learner' : 'You'}: ${h.text.slice(0, 400)}`).join('\n')}\n\n` : '';
  return { system, user: `${history}${ctx}\n\n${task}`, maxTokens };
}

export interface ExplanationParts {
  definition?: string;
  inSentence?: string;
  example?: string;
  chinese?: string;
  meaning?: string;
  summary?: string;
  hardWords?: { word: string; meaning: string; zh: string }[];
  /** everything, when no labels were found */
  free?: string;
}

const LABELS: Record<string, keyof ExplanationParts> = {
  'DEFINITION': 'definition', 'IN THIS SENTENCE': 'inSentence', 'EXAMPLE': 'example', 'CHINESE': 'chinese', 'MEANING': 'meaning', 'SUMMARY': 'summary', 'HARD WORDS': 'hardWords',
};

/**
 * Parses the labelled reply into parts. Tolerant of what models actually produce: markdown bold, bullets or
 * numbering before a label, a Chinese colon or a dash after it, several labels on one line (upper-case only,
 * so "for example:" inside a definition is not a label), extra lines, and pinyin after the Chinese meaning.
 */
export function parseExplanation(text: string, kind: ExplainKind): ExplanationParts {
  const clean = text.replace(/\*\*|__/g, '').replace(/^#+[ \t]*/gm, '').replace(/\r/g, '').trim();
  const parts: ExplanationParts = {};
  const re = /(^|\n[ \t]*|[ \t]+)(?:(?:[-*•]|\d+[.)])[ \t]*)?(DEFINITION|IN THIS SENTENCE|EXAMPLE|CHINESE|MEANING|SUMMARY|HARD WORDS)[ \t]*(?:[:：]|[-–—](?=\s))[ \t]*/gi;
  const hits: { key: keyof ExplanationParts; start: number; end: number }[] = [];
  for (const m of clean.matchAll(re)) {
    const atLineStart = m.index === 0 || m[1].startsWith('\n');
    if (!atLineStart && m[2] !== m[2].toUpperCase()) continue;
    hits.push({ key: LABELS[m[2].toUpperCase()], start: m.index!, end: m.index! + m[0].length });
  }
  if (!hits.length) {
    parts.free = clean;
    return parts;
  }
  const buf: Partial<Record<keyof ExplanationParts, string[]>> = {};
  hits.forEach((h, i) => {
    const body = clean.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : undefined).replace(/\s+/g, ' ').trim();
    (buf[h.key] ??= []).push(body);
  });
  for (const [k, v] of Object.entries(buf) as [keyof ExplanationParts, string[]][]) {
    const joined = v.join(' ').trim();
    if (k === 'hardWords') parts.hardWords = parseHardWords(joined);
    else if (k === 'chinese') parts.chinese = chineseOnly(joined);
    else (parts as Record<string, unknown>)[k] = joined;
  }
  void kind;
  return parts;
}

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** Keeps the Chinese meaning itself: no pinyin, no bracketed notes, no trailing full stop (it is read by a Chinese voice). */
function chineseOnly(s: string): string {
  let t = s.replace(/[(（][^)）]*[)）]/g, ' ').trim();
  if (!CJK.test(t)) return t;
  t = t.replace(/[^\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF、，,；;/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.replace(/^[、，,；;/ ]+|[、，,；;/ .。]+$/g, '');
}

function parseHardWords(s: string): { word: string; meaning: string; zh: string }[] {
  const t = s.trim();
  if (!t || /^(?:there (?:are|is) )?none\b/i.test(t) || /^no (?:hard|difficult) words/i.test(t)) return [];
  return t.split(/;|；|\n/).map((item) => item.trim()).filter(Boolean).map((item) => {
    const bits = item.split(/,|，|=|—|–/).map((b) => b.trim()).filter(Boolean);
    const zhIdx = bits.findIndex((b) => CJK.test(b));
    const zh = zhIdx >= 0 ? bits[zhIdx] : '';
    const rest = bits.filter((_, i) => i !== zhIdx);
    return { word: rest[0] ?? item, meaning: rest.slice(1).join(', '), zh };
  }).filter((h) => h.meaning || h.zh);
}

/** The English text to speak for a parsed explanation, in the order the learner asked for. */
export function spokenEnglish(parts: ExplanationParts): string[] {
  const out: string[] = [];
  if (parts.free) return [parts.free];
  if (parts.definition) out.push(parts.definition);
  if (parts.inSentence) out.push(`In this sentence: ${parts.inSentence}`);
  if (parts.example) out.push(`For example: ${parts.example}`);
  if (parts.meaning) out.push(parts.meaning);
  if (parts.summary) out.push(parts.summary);
  if (parts.hardWords?.length) out.push(...parts.hardWords.map((h) => (h.meaning ? `${h.word}: ${h.meaning}` : h.word)));
  return out;
}

/** Chinese fragments to speak with a Chinese voice (the word meaning only, never whole sentences). */
export function spokenChinese(parts: ExplanationParts): string[] {
  const out: string[] = [];
  if (parts.chinese) out.push(parts.chinese);
  if (parts.hardWords?.length) out.push(...parts.hardWords.filter((h) => h.zh).map((h) => `${h.word}, ${h.zh}`));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Style-based prompts (Dream Read): plain prose replies, long context, learner-editable templates.

import { fillTemplate, type ExplanationStyle } from '@shared/styles';

export interface StyledPromptOpts {
  style: ExplanationStyle;
  /** shared rules (DEFAULT_CONTEXT_RULES or the learner's edited version) */
  contextRules: string;
  level: CefrLevel;
  /** learner's first language, as a word for the AI: 'Chinese' */
  native: string;
}

/**
 * Builds the system + user messages for a word/phrase/sentence explanation in a given style.
 * The system part (rules + learner facts) is stable within a session and cacheable; the user part carries
 * the book context (title, chapter, ~500 words before, the sentence, ~200 words after) and the filled template.
 */
export function buildStyledPrompt(req: ExplainRequest, opts: StyledPromptOpts): PromptBundle {
  const values = {
    word: req.target,
    sentence: req.sentence,
    before: req.before,
    after: req.after,
    title: req.book.title,
    chapter: req.book.chapter,
    level: opts.level,
    native: opts.native,
    dict: req.dict ? `Dictionary hint for the word: ${[req.dict.ipa ? `pronunciation ${req.dict.ipa}` : '', req.dict.zh ? `${opts.native} meaning ${req.dict.zh}` : '', req.dict.level ? `CEFR level ${req.dict.level}` : ''].filter(Boolean).join(', ')}.` : '',
  };
  const system = fillTemplate(opts.contextRules, values);
  const ctx = [
    `Book: ${req.book.title || 'Untitled'}`,
    req.book.chapter ? `Chapter: ${req.book.chapter}` : '',
    req.position ? `Place in the book: chapter ${req.position.chapter + 1}, paragraph ${req.position.paragraph + 1}, sentence ${req.position.sentence + 1}.` : '',
    req.before ? `Text before the sentence:\n${req.before}` : '',
    `The sentence being read now:\n${req.sentence}`,
    req.after ? `Text after the sentence:\n${req.after}` : '',
  ].filter(Boolean).join('\n\n');
  const template = req.kind === 'sentence' ? opts.style.sentencePrompt : opts.style.wordPrompt;
  let task = fillTemplate(template, values);
  if (req.again) task += `\n\nThe learner has just heard a first explanation of this and said they still do not understand. Explain it again from a different angle, more slowly and in more detail than before: start from what they surely know, use the story around this moment, compare it with a simpler word or situation, give one more everyday example, and check the meaning in this exact sentence once more at the end. Take the time it needs.`;
  const history = req.history.length ? `Earlier in this chapter:\n${req.history.slice(-4).map((h) => `${h.role === 'user' ? 'Learner' : 'You'}: ${h.text.slice(0, 300)}`).join('\n')}\n\n` : '';
  return { system, user: `${history}${ctx}\n\n${task}`, maxTokens: req.again ? Math.round(opts.style.maxTokens * 1.6) : opts.style.maxTokens };
}

/** Strips anything a model might still add that a voice should not read: markdown, labels, list markers. */
export function cleanSpokenProse(text: string): string {
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+[ \t]*/gm, '')
    .replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/gm, '')
    .replace(/^(?:DEFINITION|IN THIS SENTENCE|EXAMPLE|MEANING|SUMMARY|SCENE|CONTEXT|STEP \d+)[ \t]*[:：][ \t]*/gim, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
