import type { CefrLevel, Position } from '@core/model';

export type AiProviderId = 'anthropic' | 'openai';
export type TtsEngineId = 'webspeech' | 'edge' | 'openai' | 'elevenlabs' | 'kokoro';
export type ThemeId = 'dark' | 'light' | 'sepia' | 'system';
export type LayoutId = 'page' | 'scroll';

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
    /** The learner's own instructions, sent as part of the system prompt. */
    instructions: string;
    explanationLength: 'short' | 'normal' | 'long';
    /** Speak the Chinese meaning with a Chinese system voice after the English explanation. */
    speakChinese: boolean;
    dailyWarnUsd: number;
    monthlyStopUsd: number;
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
    firstOccurrencePerChapterOnly: boolean;
    maxStopsPer10Min: number; // 0 = unlimited
    wordRepeats: number; // say the word N times before and after the explanation
    sentenceRepeatsAfterWord: number; // read the sentence N times after a word explanation
    sentenceRepeatsForPhrase: number; // read the sentence N times (once before, once after by default = 2)
    lastSecondsWindow: 20 | 30 | 40 | 60;
    /** in listening mode, a single tap on a highlighted word cancels it instead of opening the popup */
    tapHighlightCancels: boolean;
  };
  appearance: {
    theme: ThemeId;
    layout: LayoutId;
    fontFamily: 'serif' | 'sans' | 'dyslexic';
    fontSizePx: number;
    lineHeight: number;
    marginPx: number;
    bandEnabled: boolean;
    bandHeightPct: number; // 20..45
    highlightsDark: HighlightColors;
    highlightsLight: HighlightColors;
    underlineOnly: boolean;
  };
  shortcuts: Record<string, string>;
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
    instructions: DEFAULT_INSTRUCTIONS,
    explanationLength: 'normal',
    speakChinese: true,
    dailyWarnUsd: 1,
    monthlyStopUsd: 10,
  },
  voice: { engine: 'webspeech', voiceId: '', explainEngine: null, explainVoiceId: null, rate: 1.0, pauseBetweenSentencesMs: 250 },
  listen: {
    autoExplainWords: true,
    autoExplainPhrases: true,
    firstOccurrencePerChapterOnly: true,
    maxStopsPer10Min: 0,
    wordRepeats: 3,
    sentenceRepeatsAfterWord: 2,
    sentenceRepeatsForPhrase: 2,
    lastSecondsWindow: 30,
    tapHighlightCancels: true,
  },
  appearance: {
    theme: 'dark',
    layout: 'page',
    fontFamily: 'serif',
    fontSizePx: 20,
    lineHeight: 1.6,
    marginPx: 48,
    bandEnabled: true,
    bandHeightPct: 30,
    highlightsDark: { unknown: '#59c7fa', learning: '#ffd666', sentence: '#ffffff', word: '#fb923c', marked: '#c084fc' },
    highlightsLight: { unknown: '#3b82f6', learning: '#eab308', sentence: '#f97316', word: '#ea580c', marked: '#9333ea' },
    underlineOnly: false,
  },
  shortcuts: {
    playPause: 'Space', prevSentence: 'ArrowLeft', nextSentence: 'ArrowRight', prevParagraph: 'Shift+ArrowLeft', nextParagraph: 'Shift+ArrowRight',
    prevPage: 'PageUp', nextPage: 'PageDown', replaySentence: 'KeyR', explain: 'KeyE', explainLast: 'Shift+KeyE', markKnown: 'KeyK', markLearning: 'KeyL',
    ignore: 'KeyX', toggleListen: 'KeyQ', toggleBand: 'KeyB', sayWord: 'KeyS', speedUp: 'Equal', speedDown: 'Minus', speedReset: 'Digit0',
    nextHard: 'Tab', prevHard: 'Shift+Tab', closePopup: 'Escape', markPhrase: 'KeyH',
  },
};

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
}

export interface UsageRecord { date: string; provider: AiProviderId; model: string; inputTokens: number; outputTokens: number; cachedTokens: number; usd: number }
