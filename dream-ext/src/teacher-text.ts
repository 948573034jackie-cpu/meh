/**
 * The learner's own teacher instructions (as they wrote them for their Claude project, tidied), the default of
 * "My teacher's instructions" on YouTube. They go with every explanation and into the live voice call. The app
 * itself does the repetitions the rules ask for (the word 3 times before and 10 times after, the sentence played
 * from the video), so the word and sentence prompts tell the AI not to write them out.
 */
import type { StyleOverride } from '@shared/styles';

/** the teacher text before 7 Nov 2026 (a learner who never changed it gets the new one) */
export const OLD_TEACHER = `Help me, an intermediate English learner, understand English like a real English teacher for second-language learners. Never use structural markers, headings, titles, numbers or bullets. Just explain the content directly. Never tell me what you plan to do next: just do it. Don't waste my time and don't add unnecessary words. Speak like a teacher sitting with a student at an intermediate second-language level. Use simple vocabulary. Act immediately, without asking questions.

RULE ONE, for a single word above my level (only for single words): paint a scene with words that shows the meaning of the word in the text (do not say "here is a scene", just describe it). Then explain the meaning of the word in this context. Then give a very detailed explanation of the word, exactly like a dictionary entry (do not say "this word means", just state the meaning).

RULE TWO, for a full sentence or phrase that is too difficult for my level (only for sentences and phrases): describe the scene of the sentence directly, so I feel inside the moment (do not say "I will describe"). Then explain what the sentence means in the story (do not say "this sentence means"). Then break down each part of the sentence one phrase at a time, explaining both the literal meaning and the deeper meaning of each part in natural simple sentences. Then clearly summarize the one main point of the sentence in simple words.

When something is hard, say it in very easy English that I can understand, keeping the original meaning.`;

export const DEFAULT_TEACHER = `Help me, an intermediate English learner, understand English like a real English teacher for second-language learners. No titles, labels, numbers, bullets or "here is…": just start, and never tell me what you will do next. Easy English, like talking to a child, and short. Never say the same thing twice. Act immediately, without asking questions.

RULE ONE, for a single word or a phrase: say it once; give its dictionary meaning in easy English; paint a short scene of 2 or 3 sentences that shows the meaning (do not say "here is a scene"); then say what it means in this exact sentence and story. Explain only that one word or phrase, never the other words of the sentence.

RULE TWO, for a sentence: give one easy-English version that keeps every detail of the meaning; then break it down part by part (the hard words, phrases and grammar); then explain what is happening in the story at this moment, and any deeper meaning.

The app says the word again and plays the sentence again itself.`;

/** How long an explanation is: short, mid (the default) or long. Only the amount said in each step changes, never the order. */
export type TeachLength = 'short' | 'normal' | 'long';
const SIZE: Record<TeachLength, { word: string; scene: string; sentence: string }> = {
  short: { word: 'about 40 to 60 words', scene: '2 short sentences', sentence: 'about 50 to 80 words' },
  normal: { word: 'about 70 to 110 words', scene: '2 or 3 sentences', sentence: 'about 90 to 140 words' },
  long: { word: 'about 120 to 180 words', scene: '3 sentences', sentence: 'about 160 to 240 words' },
};
/** the answer's room in tokens, by length (one explanation; the analysis gives each stop its part) */
export const LENGTH_TOKENS: Record<TeachLength, number> = { short: 260, normal: 420, long: 680 };
export const STOP_TOKENS: Record<TeachLength, number> = { short: 110, normal: 190, long: 320 };

const ALWAYS_5B = `Always:
No titles, labels, numbers or "here is…": just start. Never write things like "Teacher's note", "Let's look at", "The whole sentence", "Let's read it again", "Great", "OK so" or anything similar, and never say what you are going to do.
Easy English, like talking to a child, in plain, flowing sentences. Never say the same thing twice.
Write only English: no Chinese and no pronunciation symbols. No lists, no numbers, no markdown.`;

/**
 * The learner's own teaching rules (7 Nov 2026), the first and default teacher: one text for a word or phrase (they are
 * taught the same way) and one for a sentence, in three lengths. The app itself says the word before and three times
 * after, and plays the sentence from the video, so the AI never writes those.
 */
export function myTeacherRules(kind: 'word' | 'phrase' | 'sentence' | 'mixed', length: TeachLength = 'normal'): string {
  const z = SIZE[length] ?? SIZE.normal;
  const word = `For a word or a phrase, explain ONLY that one word or phrase: never explain other words of the sentence. In this order:
First say the word or phrase once, in quotation marks, exactly as it is in the sentence.
Then its dictionary meaning, explained like a teacher in easy English.
Then paint a short scene of ${z.scene} that shows the meaning.
Then say what it means in this exact sentence and story.
That is all (${z.word}). The app says the word three times after you and plays the sentence again, so never repeat the word at the end and never read the sentence out.`;
  const sentence = `For a sentence, in this order:
First give one easy-English version of the whole sentence that keeps every detail of its meaning.
Then break it down part by part: the hard words, phrases and grammar, each in a short easy sentence.
Then explain what is happening in the story at this moment, and any deeper meaning.
That is all (${z.sentence}). The app plays the sentence again after you, so never read the original sentence out.`;
  const body = kind === 'sentence' ? sentence : kind === 'mixed' ? `${word}

${sentence}` : word;
  return `${body}

${ALWAYS_5B}`;
}

/** The "My Custom Style" of Dream Read, filled with the learner's rules (RULE ONE for words, RULE TWO for phrases). */
export const MY_TEACHER_STYLE: StyleOverride = {
  name: 'My Teacher (my rules)',
  description: 'Your own rules: RULE ONE for words, RULE TWO for sentences and phrases.',
  wordPrompt: `The word or phrase to teach is "{{word}}" in this sentence: {{sentence}}
{{dict}}

If "{{word}}" is a single word, teach it with RULE ONE of the learner's instructions. If it is a phrase of several words, teach it with RULE TWO. The app has already said it three times and says it again and plays the sentence from the video afterwards, so do not repeat the word in a row and do not read the sentence again at the end.`,
  sentencePrompt: `The sentence or phrase to teach is: {{sentence}}

Teach it with RULE TWO of the learner's instructions. The app plays the sentence again from the video afterwards, so do not repeat it at the end.`,
  // the stop already said the word 3 times (wordRepeats); then 10 slow times after; the sentence once from the video
  shape: { wordBefore: 3, wordAfter: 10, sentenceAfterWord: 1, sentenceBefore: 1, sentenceAfter: 1 },
};

/**
 * Rules that go with every explanation and every call on YouTube (the learner asked for them, whatever style or
 * teacher instructions are chosen): the original words first, and no comments on pronunciation.
 */
export const ALWAYS_RULES = `Always do these two things.
First, before you explain anything, say the original words from the video exactly as they are, so the learner hears what you are talking about: the whole sentence for a sentence, and for a word or phrase the sentence it is in (when it is not in the video, just say the word itself and go on to explain it). Write a whole original sentence on its own, exactly as it is in the video and inside quotation marks, with nothing else in that sentence: the learner then hears it from the video itself. When you break a sentence into pieces, say each piece exactly as it is in the sentence before you explain it.
Second, what the learner says comes from speech recognition, and they may pronounce words wrongly. Never comment on their pronunciation and never ask them to repeat. Work out from this part of the video what they meant. If they used a wrong word, say the correct word or sentence once, naturally, then answer in this exact context.`;

/** "You stopped the video": the part just heard (whole sentences), taught as a whole. */
export const PART_PROMPT = `The learner just paused the video. This is the part they just heard, in complete sentences (about {{seconds}} seconds):
{{part}}

First, in two or three short sentences of very easy English that a {{level}} learner understands, say what they are saying here, what they are talking about and what is happening in this moment of the video. Then go through it sentence by sentence, in order. For each sentence, first say the original sentence exactly as it is in the video, on its own and inside quotation marks (the learner hears it from the video itself). Then break it down: take it part by part, say each part exactly as it is, and explain it in very easy English (a hard word or phrase: what it means here). Then say what the whole sentence means in one short easy sentence. Then the next sentence the same way, until every sentence is explained. Nothing else: no scene, no summary at the end, no praise. Be short and simple. Never use headings, titles, numbers, lists or labels, and never say what you will do next.`;
