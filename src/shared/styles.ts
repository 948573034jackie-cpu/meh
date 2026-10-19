import type { AiProviderId } from './settings';

/**
 * Explanation styles: how the AI teaches a word or a sentence. Every style is a pair of plain-text prompt
 * templates (word, sentence) plus the shape of the spoken script around the AI's answer. All text is
 * editable by the learner in Settings; DEFAULT_STYLES is the "reset to default" source.
 *
 * Template placeholders: {{word}} {{sentence}} {{before}} {{after}} {{title}} {{chapter}} {{level}} {{dict}}
 * {{native}} (the learner's first language, e.g. Chinese). Unknown placeholders are left as is.
 *
 * The reply must be plain prose for a voice. A quiz-style prompt may put the token [PAUSE] on its own line:
 * the app stops speaking there, waits for the learner (or the listening-mode pause), then speaks the rest.
 */
export type StyleId = 'custom' | 'teacher' | 'picture' | 'chunks' | 'wordparts' | 'story' | 'quiz';

export interface ScriptShape {
  /** say the word N times before the AI explanation */
  wordBefore: number;
  /** say the word N times after the AI explanation */
  wordAfter: number;
  /** read the sentence N times after a word explanation */
  sentenceAfterWord: number;
  /** read the sentence N times before / after a sentence explanation */
  sentenceBefore: number;
  sentenceAfter: number;
}

export interface ExplanationStyle {
  id: StyleId;
  name: string;
  /** one line for the style picker */
  description: string;
  /** the research the style is built on, shown under the description */
  basis: string;
  wordPrompt: string;
  sentencePrompt: string;
  shape: ScriptShape;
  /** null = use the global provider/model */
  provider: AiProviderId | null;
  model: string | null;
  /** rough output budget: the AI is told how long to talk and max_tokens follows it */
  maxTokens: number;
}

/** The per-style fields a learner may override; merged over DEFAULT_STYLES by id. */
export type StyleOverride = Partial<Pick<ExplanationStyle, 'name' | 'wordPrompt' | 'sentencePrompt' | 'shape' | 'provider' | 'model'>>;

export const PLACEHOLDERS = ['word', 'sentence', 'before', 'after', 'title', 'chapter', 'level', 'dict', 'native'] as const;

/** Shared rules sent with every style (system prompt). Editable, with reset. */
export const DEFAULT_CONTEXT_RULES = `You are a warm, patient English teacher inside a reading app. The learner's first language is {{native}} and their English is about CEFR level {{level}}.

Before you explain anything, read the whole passage you are given: the book title, the chapter, the text before, the sentence itself and the text after. Understand the story at this moment: who is there, what just happened, what each person wants and feels, and the meaning underneath the words. Explain the word or sentence as it is used in this exact moment of this story, never only a general dictionary meaning. If the word has other meanings, you may mention the most common one briefly, but the meaning in this story comes first and gets the most time.

When you describe the scene, put the learner inside the moment: who is in the room, what they see, hear and feel. Use only what the book says or clearly implies. Never invent events, names, dialogue or details that are not in the book, and never quote text that is not in the passage you were given.

Your words will be spoken aloud by a voice, so write for the ear. Use easy, natural English with short sentences and common words. Plain text only: no headings, no labels, no numbers or bullet points, no markdown, no asterisks, no emojis, no phonetic symbols. Do not announce what you are about to do and do not name your steps; simply teach, in a smooth flow, as if talking to one person. No greeting and no closing line.

Do not translate the whole sentence into {{native}} unless the style asks for one easy translation. Use {{native}} only where the style asks for it.`;

const CUSTOM_WORD = `The word to teach is "{{word}}" in this sentence: {{sentence}}
{{dict}}

Teach it like this, in one smooth spoken flow. First, give the meaning of {{word}} in easy English, the way a good teacher would say it to a student, without reading a dictionary. Then describe the scene of the story at this exact moment, so the learner can see it: who is there, what they see, hear and feel, and where {{word}} fits in that picture. Then explain what {{word}} means in this exact sentence and why the author chose it here. Keep it clear and complete; a little longer is fine if it truly helps understanding.`;

const CUSTOM_SENTENCE = `The sentence to teach is: {{sentence}}

Teach it like this, in one smooth spoken flow. Break the sentence into its natural parts and explain each part in easy English, in the context of this story moment, so the learner understands how the parts build the meaning. Then give a short summary of what the whole sentence means in the story. Then give one easy {{native}} translation of the sentence, said once. Keep it clear and complete.`;

const TEACHER_WORD = `The word to teach is "{{word}}" in this sentence: {{sentence}}
{{dict}}

Teach it the way a skilled English teacher teaches a new word, in one smooth spoken flow. Start with a friendly everyday explanation of what {{word}} means, the kind you would say to a student, using words the learner already knows, and say when people usually use it. Then say how the word works: what kind of word it is here and the small pattern it sits in, such as the word that usually comes after it. Then show what it means right here in the story: who is doing or feeling it, what is happening, and why the author used this word instead of a plainer one. Then give one short example from everyday life with the same meaning. Finish with one sentence saying whether this is a common, useful word worth remembering, or a rare one the learner only needs to recognise.`;

const TEACHER_SENTENCE = `The sentence to teach is: {{sentence}}

Teach it the way a skilled English teacher would, in one smooth spoken flow. First say who is speaking or acting and what has just happened, so the learner is inside the moment. Then rebuild the sentence piece by piece in everyday English, taking each natural part in order and saying what it adds to the meaning, and pointing out any phrase or grammar that could confuse a {{level}} learner. Then say the one idea or feeling the author wants the reader to have from this sentence.`;

const PICTURE_WORD = `The word to teach is "{{word}}" in this sentence: {{sentence}}
{{dict}}

Teach it through a picture, in one smooth spoken flow. Step inside this exact moment of the story and describe it like a film shot: where we are, who is there, what they see, hear and feel, and show the meaning of {{word}} through that picture, so the learner understands it by seeing it happen. Then give a one-line memory hook that links the sound or look of the word {{word}} to the picture, something easy to remember. Then say plainly what {{word}} means in this sentence.`;

const PICTURE_SENTENCE = `The sentence to teach is: {{sentence}}

Teach it through a picture, in one smooth spoken flow. Paint the scene of this sentence like a single film shot: the place, the people, the light, the sounds, what the main character feels. Then go through the sentence part by part and say what each part adds to that picture. Then say in one or two easy sentences what the whole sentence means.`;

const CHUNKS_WORD = `The word to teach is "{{word}}" in this sentence: {{sentence}}
{{dict}}

Teach it as part of its chunk, in one smooth spoken flow. First find the natural group of words that {{word}} belongs to in this sentence, the phrase people really say together, and say that whole chunk slowly. Explain what the chunk means here in the story, with who is doing it and why. Then give three or four very common partner words that often go with {{word}}, said as short chunks, each with its meaning in a few words. Then give one easy example sentence that uses the same chunk as the book, with the same meaning. Then say plainly what {{word}} means in this sentence.`;

const CHUNKS_SENTENCE = `The sentence to teach is: {{sentence}}

Teach it in chunks, in one smooth spoken flow. Cut the sentence into its natural chunks, the groups of words that go together, and say each chunk slowly followed by its meaning in easy English, in the context of this story moment. Then put the chunks back together and say what the whole sentence means. Point out one chunk the learner can reuse in their own English.`;

const WORDPARTS_WORD = `The word to teach is "{{word}}" in this sentence: {{sentence}}
{{dict}}

Teach it through its parts, in one smooth spoken flow. If {{word}} has useful parts, name them in plain words: the beginning part, the root, the ending, and what each part means. Then give two or three relatives in the same word family that the learner probably knows, and say how they are connected. Then show how the parts add up to the meaning of {{word}} right here in this sentence of the story, with who is doing or feeling it. If the word has no useful parts, say so in a few words and instead teach it like a good teacher: easy meaning, the meaning in this story moment, and one everyday example. Then say plainly what {{word}} means in this sentence.`;

const WORDPARTS_SENTENCE = `The sentence to teach is: {{sentence}}

Teach it through its heavy words, in one smooth spoken flow. Find the two or three words that carry the most meaning in this sentence. For each one, show its parts or its word family in plain words, and what it means here. Then rebuild the meaning of the whole sentence in easy English, in the context of this story moment.`;

const STORY_WORD = `The word to teach is "{{word}}" in this sentence: {{sentence}}
{{dict}}

Teach it through the story itself, in one smooth spoken flow. Retell this exact moment of the book in easier English, a little simpler than the book but natural, and use the word {{word}} three times inside your retelling, each time in a way that makes its meaning clearer, so the learner understands it from the story without any dictionary talk. Use only what the book says or clearly implies. At the very end, say in one short sentence what {{word}} means.`;

const STORY_SENTENCE = `The sentence to teach is: {{sentence}}

Teach it through the story itself, in one smooth spoken flow. Retell this moment of the book in very simple English first, in two or three short sentences. Then retell it again a little closer to the book's own words, keeping the meaning the same, so the learner can hear the gap between simple and real. Use only what the book says or clearly implies. Then say in one sentence what the sentence means for the story.`;

const QUIZ_WORD = `The word to teach is "{{word}}" in this sentence: {{sentence}}
{{dict}}

Teach it with a question, in one smooth spoken flow. First give a short, friendly meaning of {{word}} as it is used in this moment of the story, with who is doing or feeling it. Then ask the learner one quick question that makes them think about the meaning here, for example a choice between two feelings or two situations, and invite them to say their answer. Then write the token [PAUSE] alone on its own line. After the token, confirm the right answer in a kind way, repeat the meaning of {{word}} in this sentence, and give one everyday example that uses it.`;

const QUIZ_SENTENCE = `The sentence to teach is: {{sentence}}

Teach it with a question, in one smooth spoken flow. First ask the learner what they think this sentence means in the story, and invite them to say their answer in their own words. Then write the token [PAUSE] alone on its own line. After the token, explain the real meaning in easy English, part by part, in the context of this story moment, and gently correct the most likely misunderstanding.`;

const DEFAULT_SHAPE: ScriptShape = { wordBefore: 3, wordAfter: 3, sentenceAfterWord: 1, sentenceBefore: 1, sentenceAfter: 2 };

export const DEFAULT_STYLES: ExplanationStyle[] = [
  {
    id: 'custom', name: 'My Custom Style', description: 'Your own steps: meaning, scene, meaning in context.',
    basis: 'Your own instructions. Edit the text below any way you like.',
    wordPrompt: CUSTOM_WORD, sentencePrompt: CUSTOM_SENTENCE,
    shape: { wordBefore: 3, wordAfter: 1, sentenceAfterWord: 1, sentenceBefore: 1, sentenceAfter: 2 },
    provider: null, model: null, maxTokens: 900,
  },
  {
    id: 'teacher', name: 'Teacher Style', description: 'Friendly definition, how the word is used, meaning here, example, is it worth learning.',
    basis: 'Beck, McKeown and Kucan, Bringing Words to Life (student-friendly explanations); Paul Nation, form, meaning and use.',
    wordPrompt: TEACHER_WORD, sentencePrompt: TEACHER_SENTENCE, shape: DEFAULT_SHAPE, provider: null, model: null, maxTokens: 1000,
  },
  {
    id: 'picture', name: 'Picture Style', description: 'See the scene, feel the moment, remember the word with a picture.',
    basis: 'Dual coding (Paivio, Sadoski) and the keyword method (Atkinson and Raugh).',
    wordPrompt: PICTURE_WORD, sentencePrompt: PICTURE_SENTENCE, shape: DEFAULT_SHAPE, provider: null, model: null, maxTokens: 900,
  },
  {
    id: 'chunks', name: 'Chunk Style', description: 'Learn the word with its partner words, the way people really say it.',
    basis: 'The Lexical Approach (Lewis) and collocation research; chunks are read faster and remembered better.',
    wordPrompt: CHUNKS_WORD, sentencePrompt: CHUNKS_SENTENCE, shape: DEFAULT_SHAPE, provider: null, model: null, maxTokens: 900,
  },
  {
    id: 'wordparts', name: 'Word Parts Style', description: 'Prefix, root, ending and the word family.',
    basis: 'Morphological awareness research: word-part teaching gives consistent vocabulary gains.',
    wordPrompt: WORDPARTS_WORD, sentencePrompt: WORDPARTS_SENTENCE, shape: DEFAULT_SHAPE, provider: null, model: null, maxTokens: 900,
  },
  {
    id: 'story', name: 'Story Style', description: 'The moment retold in easier English, the word used three times.',
    basis: 'Comprehensible input (Krashen) and narrow reading: meaning learned from the story itself.',
    wordPrompt: STORY_WORD, sentencePrompt: STORY_SENTENCE, shape: DEFAULT_SHAPE, provider: null, model: null, maxTokens: 900,
  },
  {
    id: 'quiz', name: 'Quiz Style', description: 'A short meaning, one quick question for you, then the answer.',
    basis: 'Retrieval practice and spaced repetition; the Involvement Load Hypothesis (Laufer and Hulstijn).',
    wordPrompt: QUIZ_WORD, sentencePrompt: QUIZ_SENTENCE, shape: DEFAULT_SHAPE, provider: null, model: null, maxTokens: 800,
  },
];

export const PAUSE_TOKEN = '[PAUSE]';

export function defaultStyle(id: StyleId): ExplanationStyle {
  return DEFAULT_STYLES.find((s) => s.id === id) ?? DEFAULT_STYLES[0];
}

/** Merges learner overrides over the defaults; unknown ids are ignored so new default styles always appear. */
export function resolveStyles(overrides: Partial<Record<StyleId, StyleOverride>> | undefined): ExplanationStyle[] {
  return DEFAULT_STYLES.map((d) => {
    const o = overrides?.[d.id];
    if (!o) return d;
    return { ...d, ...o, shape: { ...d.shape, ...(o.shape ?? {}) } };
  });
}

export function resolveStyle(id: StyleId, overrides: Partial<Record<StyleId, StyleOverride>> | undefined): ExplanationStyle {
  return resolveStyles(overrides).find((s) => s.id === id) ?? resolveStyles(overrides)[0];
}

/** Fills {{placeholders}}; missing values become empty strings, unknown placeholders stay. */
export function fillTemplate(template: string, values: Partial<Record<(typeof PLACEHOLDERS)[number], string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (PLACEHOLDERS as readonly string[]).includes(k) ? (values[k as (typeof PLACEHOLDERS)[number]] ?? '') : m).replace(/\n{3,}/g, '\n\n').trim();
}

/** Splits a reply at the [PAUSE] token: [spokenFirst, spokenAfterPause]. */
export function splitAtPause(text: string): [string, string | null] {
  const i = text.indexOf(PAUSE_TOKEN);
  if (i < 0) return [text.trim(), null];
  return [text.slice(0, i).trim(), text.slice(i + PAUSE_TOKEN.length).trim() || null];
}
