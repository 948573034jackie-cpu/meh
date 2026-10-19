/**
 * The spoken script of the review class (pure): turns a ReviewPlan (src/core/vocab/review.ts) into a friendly
 * intro line, an ordered list of explain requests for the AI/voice layer, and a duration estimate.
 *
 * Order: one 'word' request per vocabulary item (plan order), then one 'passage' request per context group
 * (book/chapter order as in the plan) asking for a short retelling plus one question for the learner.
 */
import type { ExplainRequest } from '@shared/api';
import type { ContextGroup, ReviewPlan } from './review';

export const MINUTES_PER_WORD = 0.75;
export const MINUTES_PER_CONTEXT_GROUP = 1;

/** The instruction sent with each context group: retell, ask one question, pause, then give the answer. */
export const PASSAGE_REVIEW_QUESTION =
  'Retell briefly, in two or three simple sentences, what happened in this part of the story. ' +
  'Then ask the learner one short question about it. End with [PAUSE] followed by the answer.';

export interface ReviewScriptOptions {
  /** title of the book being read; used when a group or item has no title of its own */
  bookTitle: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One friendly sentence opening the class, e.g. "Let's review 6 words from today, then the story so far." */
export function reviewIntro(plan: ReviewPlan): string {
  const n = plan.items.length;
  const story = plan.context.length > 0;
  if (n === 0) return story ? "Let's go over the story so far." : 'Nothing to review right now. Well done!';
  const session = plan.items.filter((i) => i.reason === 'session').length;
  const due = n - session;
  let what: string;
  if (due === 0) what = `${plural(n, 'word')} from today`;
  else if (session === 0) what = `${plural(n, 'word')} from earlier sessions`;
  else what = `${plural(n, 'word')}: ${session} from today and ${due} from earlier`;
  return `Let's review ${what}${story ? ', then the story so far' : ''}.`;
}

/** The context group a vocabulary item's sentence belongs to (for its chapter), if any. */
function groupOf(plan: ReviewPlan, lemma: string): ContextGroup | undefined {
  return plan.context.find((g) => g.sentences.some((s) => s.lemma === lemma));
}

/** The ordered explain requests of the class: every word item, then every context group as a passage. */
export function buildReviewRequests(plan: ReviewPlan, opts: ReviewScriptOptions): ExplainRequest[] {
  const out: ExplainRequest[] = [];
  for (const item of plan.items) {
    const g = groupOf(plan, item.lemma);
    out.push({
      kind: 'word',
      target: item.word || item.lemma,
      sentence: item.sentence,
      before: '',
      after: '',
      book: { title: opts.bookTitle || g?.bookTitle || '', chapter: g?.chapter ?? '' },
      ...(item.chinese ? { dict: { zh: item.chinese } } : {}),
      history: [],
      again: false,
    });
  }
  for (const g of plan.context) {
    const passage = g.sentences.map((s) => s.sentence.trim()).filter(Boolean).join(' ');
    if (!passage) continue;
    out.push({
      kind: 'passage',
      target: passage,
      sentence: passage,
      before: '',
      after: '',
      book: { title: g.bookTitle || opts.bookTitle, chapter: g.chapter },
      question: PASSAGE_REVIEW_QUESTION,
      history: [],
      again: false,
    });
  }
  return out;
}

/** About 0.75 minutes per word item plus 1 minute per context group, rounded up to whole minutes. */
export function estimateReviewMinutes(plan: ReviewPlan): number {
  const groups = plan.context.filter((g) => g.sentences.some((s) => s.sentence.trim())).length;
  return Math.ceil(plan.items.length * MINUTES_PER_WORD + groups * MINUTES_PER_CONTEXT_GROUP);
}
