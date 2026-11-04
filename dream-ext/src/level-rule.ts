/**
 * The hard rule of the explanations at a stop, and the check that enforces it: only the explanation, starting with the
 * hard words themselves; no heading, label, intro or filler; no Chinese and no IPA. The AI's reply is spoken while it
 * streams in, so every sentence passes the check before the voice gets it (RuleGuard).
 */
import type { PromptBundle } from '@core/ai/prompts';
import type { ExplainRequest } from '@shared/api';

export interface LevelRule { items: string[]; known?: string[]; level: string }
/** levelCheap: the rest of what the learner asks for with Level Check on ("Explain 30 s"): the same cheap model */
export type RuleRequest = ExplainRequest & { levelRule?: LevelRule; levelCheap?: boolean };

export function ruleSystem(level: string): string {
  return `You explain one hard moment of a video or book, out loud, to an English learner whose level is about ${level}.

These rules are absolute.
Give only the explanation. No heading, no label, no title, no intro and no filler. Never write things like "Teacher's note", "Let's look at", "The whole sentence", "Let's read it again", "Great", "OK so" or anything similar, and never say what you are going to do.
Your very first words are the hard word or phrase itself, in quotation marks, copied exactly from the original words, so the learner knows which part you mean.
Break the sentence down and explain every hard part from the context: what is happening, who is speaking and why.
Explain each hard word fully: its meaning, its feeling, and how it is used in this sentence.
Use very easy English in plain, flowing sentences. Be longer and clear, about 100 to 200 words. Write only English: no Chinese and no pronunciation symbols. No lists, no numbers, no markdown.
The app plays the sentence from the video before and after you, so do not read the whole sentence out at the end.`;
}

export function buildRulePrompt(req: RuleRequest): PromptBundle {
  const r = req.levelRule!;
  const single = req.kind !== 'sentence';
  const items = single ? [req.target] : r.items;
  const system = ruleSystem(r.level);
  const ctx = [
    `Source: ${req.book.title || 'Untitled'}`,
    req.before ? `Just before this:\n${req.before}` : '',
    `The sentence:\n${req.sentence}`,
    req.after ? `Just after this:\n${req.after}` : '',
  ].filter(Boolean).join('\n\n');
  const hard = single
    ? `The learner tapped "${req.target}" because they do not know it. Start with it and explain it as it is used in this sentence.`
    : items.length ? `The hard parts for this learner, in order: ${items.map((i) => `"${i}"`).join(', ')}. Start with the first one.` : 'Find the hardest part of its grammar or meaning, and start with those exact words.';
  const known = r.known?.length ? `\nThe learner already knows these, so do not explain them: ${r.known.join(', ')}.` : '';
  const again = req.again ? '\nThe learner heard a first explanation and still does not understand: explain it from another angle, more slowly.' : '';
  return { system, user: `${ctx}\n\n${hard}${known}${again}`, maxTokens: 700 };
}

const CJK = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const IPA = /[/[][^/\]\s]*[\u0251\u0252\u00E6\u0250\u0259\u025B\u025C\u026A\u028A\u028C\u0254\u03B8\u00F0\u0283\u0292\u014B\u02C8\u02CC\u02D0][^/\]]*[/\]]/;
/** phrases that are never part of an explanation: the sentence around them goes */
const META_SENTENCE = [
  /\blet['\u2019]s (?:look|read|take|start|break|see|begin|go|hear|listen|think|talk)\b/i,
  /\blet me\b/i,
  /\b(?:here['\u2019]s|here is) (?:the|an?|what|how|my)\b/i,
  /\b(?:i will|i['\u2019]ll|i am going to|i['\u2019]m going to|we will|we['\u2019]ll|we are going to|we['\u2019]re going to) (?:explain|look|read|break|start|go through|talk about)\b/i,
  /\b(?:to sum up|in summary|to summari[sz]e)\b/i,
];
const OPENING = /^(?:(?:ok(?:ay)?|alright|all right|great|good|nice|well|so|now|right|sure|first of all|first|next|then)\b[\s,.:;!\u2014\u2013-]*)+/i;
const LABEL = /^(?:[\p{L}'\u2019 ]{1,32})[:\uFF1A]\s*/u;
/** phrases of the rule's list that may stand inside a useful sentence: replaced, the rest of the sentence stays */
const THE_WHOLE = /\bthe whole sentence\b/gi;
const TEACHERS_NOTE = /\bteacher['\u2019]s note\b[\s:\uFF1A,.\u2014\u2013-]*/gi;

/** The problems of an explanation (empty = it follows the rule). Used by the tests and on what the guard lets through. */
export function checkExplanation(text: string, o: { sentence?: string; items?: readonly string[] } = {}): string[] {
  const out: string[] = [];
  const t = text.trim();
  if (!t) return ['empty'];
  if (CJK.test(t)) out.push('Chinese');
  if (IPA.test(t)) out.push('IPA');
  if (/^#|^\s*[-*\u2022]\s|\*\*/m.test(t)) out.push('markdown');
  if (THE_WHOLE.test(t)) out.push('"the whole sentence"');
  THE_WHOLE.lastIndex = 0;
  if (TEACHERS_NOTE.test(t)) out.push('"Teacher\'s note"');
  TEACHERS_NOTE.lastIndex = 0;
  for (const re of META_SENTENCE) { const m = re.exec(t); if (m) out.push(`"${m[0]}"`); }
  const first = t.split(/(?<=[.!?])\s+/)[0] ?? '';
  if (OPENING.test(t)) out.push(`opens with filler: "${(OPENING.exec(t)?.[0] ?? '').trim()}"`);
  const label = LABEL.exec(first);
  if (label && !/["“‘']/.test(label[0])) out.push(`label: "${label[0].trim()}"`);
  if (o.sentence !== undefined && !startsWithOriginal(t, o.sentence, o.items ?? [])) out.push('does not start with the original words');
  return out;
}

const folded = (s: string): string => s.toLowerCase().replace(/[\u2019]/g, "'").replace(/[^\p{L}\p{N}'-]+/gu, ' ').trim();
/** Opens with words copied from the sentence, in quotation marks or not. */
function startsWithOriginal(text: string, sentence: string, items: readonly string[]): boolean {
  const start = folded(text).split(' ').slice(0, 12).join(' ');
  if (items.some((i) => start.startsWith(folded(i)))) return true;
  const q = /^["\u201C\u2018']([^"\u201D\u2019']{2,120})["\u201D\u2019']/.exec(text.trim());
  return !!q && ` ${folded(sentence)} `.includes(` ${folded(q[1])} `);
}

/** One sentence as the voice may say it: '' when nothing of it may be said. */
export function cleanRuleSentence(raw: string): string {
  let s = raw.replace(/\*\*|__|`/g, '').replace(/^\s*(?:#+|[-*\u2022]|\d+[.)])\s+/, '').trim();
  // Chinese and pronunciation, with the brackets or the "(…)" around them
  s = s.replace(/[(\uFF08][^()\uFF08\uFF09]*[\u3400-\u9FFF][^()\uFF08\uFF09]*[)\uFF09]/g, ' ').replace(new RegExp(`${CJK.source}+`, 'g'), ' ').replace(new RegExp(IPA.source, 'g'), ' ');
  s = s.replace(/\(\s*\)/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  for (const re of META_SENTENCE) if (re.test(s)) return '';
  const before = s;
  s = s.replace(TEACHERS_NOTE, '').trim();
  const label = LABEL.exec(s);
  if (label && !/["“‘']/.test(label[0])) s = s.slice(label[0].length).trim();
  s = s.replace(OPENING, '').trim();
  if (before !== s && /^\p{Ll}/u.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
  s = s.replace(THE_WHOLE, (m) => (m[0] === 'T' ? 'This' : 'this'));
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

const END = /[.!?]["\u201D\u2019')\]]*(?=\s)/g;
/** complete sentences at the front of the text, and what is still being written */
function splitDone(full: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let from = 0;
  END.lastIndex = 0;
  for (let m = END.exec(full); m; m = END.exec(full)) {
    const end = m.index + m[0].length;
    // ("Mr. Duffy", "e.g. this", a capital must follow a real end; the next sentence may start with a quote)
    if (/\b(?:Mr|Mrs|Ms|Dr|St|e\.g|i\.e|etc)\.$/i.test(full.slice(from, end))) continue;
    done.push(full.slice(from, end));
    from = end;
  }
  return { done, rest: full.slice(from) };
}

/**
 * The AI's reply on its way to the voice: only complete sentences that pass the rule go through, and what went through
 * never changes, so the text only grows. If the reply does not start with the hard words, they are said first.
 */
export class RuleGuard {
  rejected = 0;
  private lead: string;
  constructor(private o: { sentence?: string; items?: readonly string[] } = {}) { this.lead = o.items?.[0] ?? ''; }

  private build(sentences: readonly string[]): string {
    const out: string[] = [];
    let dropped = 0;
    for (const raw of sentences) {
      const c = cleanRuleSentence(raw);
      if (c !== raw.replace(/\s+/g, ' ').trim()) dropped++;
      if (!c) continue;
      if (!out.length && this.o.sentence !== undefined && this.lead && !startsWithOriginal(c, this.o.sentence, this.o.items ?? [])) out.push(`“${this.lead}.”`);
      out.push(c);
    }
    this.rejected = Math.max(this.rejected, dropped);
    return out.join(' ');
  }

  /** the text so far from the AI -> what may be said so far (with a space after it, so its last sentence counts as done) */
  push(full: string): string {
    const t = this.build(splitDone(full).done);
    return t ? `${t} ` : '';
  }

  /** the whole reply */
  finish(full: string): string {
    const { done, rest } = splitDone(full);
    return this.build(rest.trim() ? [...done, rest] : done);
  }
}
