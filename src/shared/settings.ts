import type { CefrLevel, Position } from '@core/model';
import type { LevelModelJSON } from '@core/level/adapt';
import type { LevelResult } from '@core/level/score';
import type { StyleId, StyleOverride } from './styles';
import { DEFAULT_CONTEXT_RULES, LEGACY_CONTEXT_RULES } from './styles';
import type { SkipSettings } from '@core/import/skip';
import { DEFAULT_SKIP } from '@core/import/skip';

export type AiProviderId = 'anthropic' | 'openai';
export type TtsEngineId = 'webspeech' | 'edge' | 'openai' | 'elevenlabs' | 'kokoro' | 'azure' | 'google';
/** night (warm dark, default), sepia, light, grey; 'system' follows macOS (night or light). The old 'dark' is read as 'night'. */
export type ThemeId = 'night' | 'sepia' | 'light' | 'grey' | 'system';
/** Themes that render dark; the others use the light highlight palette. */
export const DARK_THEMES: readonly ThemeId[] = ['night', 'grey'];
export type LayoutId = 'page' | 'scroll';
/** The two screens of a book: Reading (Kindle-like pages) and Listening (karaoke lines). */
export type ReadMode = 'reading' | 'listening';

export interface HighlightColors {
  /** word above the learner's level (auto-explain candidate) */
  unknown: string;
  /** word the learner tapped / had explained */
  learning: string;
  /** sentence currently being read */
  sentence: string;
  /** word currently being spoken */
  word: string;
  /** phrase or sentence the learner marked for explanation */
  marked: string;
}

export interface Settings {
  version: 1;
  onboarded: boolean;
  learnerLevel: CefrLevel;
  nativeLanguage: 'zh';
  ai: {
    provider: AiProviderId;
    anthropicModel: string;
    openaiModel: string;
    /**
     * Model for the background chapter hints (Chinese meaning under hard words). null = the cheapest fit:
     * Claude Haiku 5.5 when the provider is Anthropic, else the OpenAI model above.
     */
    hintsModel: string | null;
    /** The learner's own instructions, sent as part of the system prompt. */
    instructions: string;
    explanationLength: 'short' | 'normal' | 'long';
    /** Speak the Chinese meaning with a Chinese system voice after the English explanation. */
    speakChinese: boolean;
    dailyWarnUsd: number;
    monthlyStopUsd: number;
    /** explanation style used for word/phrase/sentence explanations */
    activeStyle: StyleId;
    /** learner edits per style (prompts, shape, model), merged over the defaults */
    styles: Partial<Record<StyleId, StyleOverride>>;
    /** shared rules sent with every style (system prompt); editable, reset to DEFAULT_CONTEXT_RULES */
    contextRules: string;
    contextWordsBefore: number;
    contextWordsAfter: number;
    /** Picture style: also generate an image of the scene (OpenAI key, costs money) */
    /** @deprecated no images are made; the tutor paints the scene with words (kept so old settings files load) */
    generateScenePicture: boolean;
  };
  voice: {
    engine: TtsEngineId;
    /** engine-specific voice id for reading */
    voiceId: string;
    /** engine + voice for explanations; null = same as reading */
    explainEngine: TtsEngineId | null;
    explainVoiceId: string | null;
    rate: number; // 0.5 .. 2.5
    pauseBetweenSentencesMs: number;
  };
  listen: {
    /** stop on highlighted words automatically while in listening mode */
    autoExplainWords: boolean;
    autoExplainPhrases: boolean;
    /** @deprecated replaced by repeatWindowWords */
    firstOccurrencePerChapterOnly: boolean;
    /** a word explained once is not explained again within this many words of text (0 = every time) */
    repeatWindowWords: number;
    maxStopsPer10Min: number; // 0 = unlimited
    wordRepeats: number; // say the word N times before and after the explanation
    sentenceRepeatsAfterWord: number; // read the sentence N times after a word explanation
    sentenceRepeatsForPhrase: number; // read the sentence N times (once before, once after by default = 2)
    lastSecondsWindow: 20 | 30 | 40 | 60;
    /** in listening mode, a single tap on a highlighted word cancels it instead of opening the popup */
    tapHighlightCancels: boolean;
    /** listening mode: silence after an explanation before the book continues */
    pauseAfterExplainMs: number;
    /**
     * Listening mode, at a hard word or phrase: how long the commands window stays open (mic listening for
     * "I know" / "I don't know" / "bye bye", K / D / Esc, the buttons), after the word is said and after its explanation
     */
    commandWindowMs: number;
    /** quiz style: how long to wait for the learner's answer before giving it */
    quizWaitMs: number;
  };
  appearance: {
    theme: ThemeId;
    layout: LayoutId;
    fontFamily: 'serif' | 'sans' | 'dyslexic';
    /** book text size */
    fontSizePx: number;
    /** listening subtitles (the band) */
    subtitleSizePx: number;
    /** explanation panel / transcript text */
    explainSizePx: number;
    /** whole-UI scale, 0.9 .. 1.3 */
    uiScale: number;
    lineHeight: number;
    /** maximum line length of the reading column, in characters (ch) */
    maxLineChars: number;
    /** maximum line length of the listening screen (subtitles), in characters (ch); wider, with comfortable side margins */
    listenMaxLineChars: number;
    marginPx: number;
    /** "tap anything to see how it works" tooltips on the main buttons */
    showTips: boolean;
    bandEnabled: boolean;
    bandHeightPct: number; // 20..45
    highlightsDark: HighlightColors;
    highlightsLight: HighlightColors;
    underlineOnly: boolean;
    /** Word Wise-style hints: a small Chinese meaning under words above the learner's level */
    showHints: boolean;
    /** slide animation when a page turns in Reading mode */
    pageTurnAnimation: boolean;
  };
  shortcuts: Record<string, string>;
  /** the screen the learner used last (new books open in it) */
  lastMode: ReadMode;
  /** bookId -> the screen the learner used last for that book */
  bookModes: Record<string, ReadMode>;
  /** vocabulary level test (src/core/level): the adaptive model, the last result and when it was taken */
  level: LevelSettings;
  /** talking with the tutor by voice (src/renderer/voice) */
  voiceChat: VoiceChatSettings;
  /** Speechify-style skipping while reading aloud (src/core/import/skip.ts): what the voice leaves out */
  skip: SkipSettings;
}

export type SttModelId = 'moonshine-base' | 'moonshine-tiny' | 'parakeet-v3';

export interface VoiceChatSettings {
  /** the voice line opens by itself with the book (the mic listens all the time) */
  alwaysOn: boolean;
  /** local speech-to-text model (docs/VOICE.md) */
  model: SttModelId;
  /** key that opens / closes the voice line (KeyboardEvent.code, same format as `shortcuts`) */
  pushToTalkKey: string;
  /** the speech-model download was offered once on entering Listening mode (never asked again by itself) */
  modelOffered?: boolean;
}

export interface LevelSettings {
  /** daily Beta model (LevelModel.toJSON()), null until the first test */
  model: LevelModelJSON | null;
  /** result of the last test the learner accepted (or saw), null until the first test */
  lastResult: LevelResult | null;
  /** ISO time of the last test, null until the first test */
  testedAt: string | null;
  /** words and pseudowords shown in earlier tests, so a retake draws fresh items */
  used?: { words: string[]; pseudowords: string[] };
}

export const DEFAULT_INSTRUCTIONS = `I am a native Chinese speaker learning English at B2 level. Explain in simple, clear English. Keep it short because I will listen to it, not read it. Give the Chinese meaning of the word or phrase, but do not translate whole sentences into Chinese.`;

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  onboarded: false,
  learnerLevel: 'B2',
  nativeLanguage: 'zh',
  ai: {
    provider: 'anthropic',
    anthropicModel: 'claude-opus-5-5',
    openaiModel: 'gpt-5.4-mini',
    hintsModel: null,
    instructions: DEFAULT_INSTRUCTIONS,
    explanationLength: 'normal',
    speakChinese: true,
    dailyWarnUsd: 1,
    monthlyStopUsd: 10,
    activeStyle: 'custom',
    styles: {},
    contextRules: DEFAULT_CONTEXT_RULES,
    contextWordsBefore: 500,
    contextWordsAfter: 200,
    generateScenePicture: false,
  },
  voice: { engine: 'kokoro', voiceId: 'bf_emma', explainEngine: null, explainVoiceId: null, rate: 1.0, pauseBetweenSentencesMs: 250 },
  listen: {
    autoExplainWords: true,
    autoExplainPhrases: true,
    firstOccurrencePerChapterOnly: true,
    repeatWindowWords: 500,
    maxStopsPer10Min: 0,
    wordRepeats: 3,
    sentenceRepeatsAfterWord: 2,
    sentenceRepeatsForPhrase: 2,
    lastSecondsWindow: 30,
    tapHighlightCancels: true,
    pauseAfterExplainMs: 5000,
    commandWindowMs: 5000,
    quizWaitMs: 7000,
  },
  appearance: {
    theme: 'night',
    layout: 'page',
    fontFamily: 'serif',
    fontSizePx: 20,
    subtitleSizePx: 22,
    explainSizePx: 15,
    uiScale: 1,
    lineHeight: 1.6,
    maxLineChars: 70,
    listenMaxLineChars: 90,
    marginPx: 48,
    showTips: true,
    bandEnabled: true,
    bandHeightPct: 30,
    highlightsDark: { unknown: '#59c7fa', learning: '#ffd666', sentence: '#ffffff', word: '#fb923c', marked: '#c084fc' },
    highlightsLight: { unknown: '#3b82f6', learning: '#eab308', sentence: '#f97316', word: '#ea580c', marked: '#9333ea' },
    underlineOnly: false,
    showHints: true,
    pageTurnAnimation: true,
  },
  shortcuts: {
    playPause: 'Space', prevSentence: 'ArrowLeft', nextSentence: 'ArrowRight', prevParagraph: 'Shift+ArrowLeft', nextParagraph: 'Shift+ArrowRight',
    prevPage: 'PageUp', nextPage: 'PageDown', replaySentence: 'KeyR', explain: 'KeyE', explainLast: 'Shift+KeyE', markKnown: 'KeyK', markLearning: 'Shift+KeyL',
    ignore: 'KeyX', toggleListen: 'KeyQ', toggleBand: 'KeyB', sayWord: 'KeyS', speedUp: 'Equal', speedDown: 'Minus', speedReset: 'Digit0',
    nextHard: 'Tab', prevHard: 'Shift+Tab', closePopup: 'Escape', markPhrase: 'KeyH',
    switchMode: 'KeyL', dontKnow: 'KeyD', help: 'Shift+Slash', toggleHints: 'KeyW', goTo: 'KeyG',
  },
  lastMode: 'reading',
  bookModes: {},
  level: { model: null, lastResult: null, testedAt: null },
  voiceChat: { alwaysOn: false, model: 'moonshine-base', pushToTalkKey: 'KeyM', modelOffered: false },
  skip: { ...DEFAULT_SKIP },
};

/**
 * Brings a stored settings object up to date in place and returns it: the v1 theme 'dark' became 'night';
 * shared AI rules still equal to an earlier default get the current default (no filler, badly recognised
 * speech); the old 7 s pause after an explanation became the 5 s window.
 * Safe to call on partial objects (patches) and on the defaults.
 */
export function migrateSettings<T extends { appearance?: { theme?: string } }>(s: T): T {
  const theme = s?.appearance?.theme as string | undefined;
  if (theme === 'dark') s.appearance!.theme = 'night';
  const ai = (s as { ai?: { contextRules?: unknown } } | null)?.ai;
  if (ai && typeof ai.contextRules === 'string' && LEGACY_CONTEXT_RULES.some((old) => old.trim() === (ai.contextRules as string).trim())) ai.contextRules = DEFAULT_CONTEXT_RULES;
  const listen = (s as { listen?: { pauseAfterExplainMs?: unknown } } | null)?.listen;
  if (listen && listen.pauseAfterExplainMs === 7000) listen.pauseAfterExplainMs = 5000;
  return s;
}

export function isDarkTheme(theme: ThemeId): boolean { return DARK_THEMES.includes(theme); }

export type WordStatus = 'known' | 'learning' | 'ignored';

export interface VocabState {
  /** lemma -> status */
  words: Record<string, WordStatus>;
  /** bookId -> array of "chapter.paragraph.sentence:start-end" ranges the learner marked for explanation */
  marked: Record<string, MarkedRange[]>;
}

export interface MarkedRange { chapter: number; paragraph: number; sentence: number; start: number; end: number; text: string }

export interface LibraryItem {
  id: string;
  title: string;
  author?: string;
  kind: 'epub' | 'pdf' | 'text';
  addedAt: string;
  lastOpenedAt: string;
  position: Position | null;
  percent: number;
  words: number;
  /** the screen the learner used last for this book (filled in from settings.bookModes by the renderer) */
  mode?: ReadMode;
}

export interface UsageRecord {
  date: string; provider: AiProviderId; model: string; inputTokens: number; outputTokens: number; cachedTokens: number; usd: number;
  /** a request cancelled mid-way (an explanation prepared at a Listening stop and then dropped): output is a lower bound */
  partial?: boolean;
}
