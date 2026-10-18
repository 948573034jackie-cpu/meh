import type { Book, Position } from '@core/model';
import type { Settings, VocabState, LibraryItem, WordStatus, MarkedRange, UsageRecord, TtsEngineId, AiProviderId } from './settings';

export interface DictData { w: Record<string, DictRaw>; f: Record<string, string> }
export interface DictRaw { i: string; t: string; g: string; f: number; b: number; c: number; o: number; l: string; s: string }

export type ExplainKind = 'word' | 'phrase' | 'sentence' | 'passage' | 'question';

export interface ExplainRequest {
  kind: ExplainKind;
  /** the word, phrase, sentence or passage to explain */
  target: string;
  /** the sentence containing the target (for passage: the whole passage) */
  sentence: string;
  before: string;
  after: string;
  book: { title: string; chapter: string };
  dict?: { ipa?: string; zh?: string; level?: string } | null;
  question?: string;
  /** previous exchanges in this chapter, oldest first */
  history: { role: 'user' | 'assistant'; text: string }[];
}

export type AiEvent =
  | { type: 'delta'; streamId: string; text: string }
  | { type: 'done'; streamId: string; text: string; usage: { inputTokens: number; outputTokens: number; cachedTokens: number; usd: number; dailyUsd: number; monthlyUsd: number; model: string } }
  | { type: 'error'; streamId: string; message: string; code?: 'no_key' | 'auth' | 'rate_limit' | 'spend_limit' | 'network' | 'budget' | 'cancelled' | 'other' };

export interface TtsVoiceInfo { id: string; name: string; lang: string; gender?: string; quality?: string; note?: string }

export interface WordTiming { start: number; end: number; charIndex: number; charLength: number }

export interface CloudTtsResult { audio: ArrayBuffer; mime: string; timings: WordTiming[] | null; durationSec: number | null }

export interface Diagnostics {
  platform: string; arch: string; electron: string; chrome: string; node: string; appVersion: string;
  userData: string; safeStorage: boolean; dictWords: number; secrets: Record<string, boolean>;
}

/** Contract between renderer and main; implemented in src/preload/index.ts and src/main/ipc.ts. */
export interface ReadAlongApi {
  // library
  importBookDialog(): Promise<Book | null>;
  importFile(path: string): Promise<Book>;
  /** absolute path of a File dropped on the window (Electron's webUtils) */
  pathForFile(file: File): string;
  importText(title: string, text: string): Promise<Book>;
  listLibrary(): Promise<LibraryItem[]>;
  loadBook(id: string): Promise<Book | null>;
  removeBook(id: string): Promise<void>;
  saveProgress(id: string, position: Position, percent: number): Promise<void>;
  // dictionary
  loadDictionary(): Promise<DictData>;
  // vocabulary
  getVocab(): Promise<VocabState>;
  setWordStatus(lemma: string, status: WordStatus | null): Promise<void>;
  setMarkedRanges(bookId: string, ranges: MarkedRange[]): Promise<void>;
  // settings & secrets
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  setSecret(name: 'anthropic' | 'openai' | 'elevenlabs', value: string): Promise<void>;
  hasSecret(name: 'anthropic' | 'openai' | 'elevenlabs'): Promise<boolean>;
  // AI
  aiExplain(req: ExplainRequest): Promise<{ streamId: string }>;
  aiCancel(streamId: string): Promise<void>;
  aiTest(provider: AiProviderId): Promise<{ ok: boolean; message: string }>;
  onAiEvent(cb: (ev: AiEvent) => void): () => void;
  getUsage(): Promise<UsageRecord[]>;
  // cloud TTS (engines that synthesize in the main process)
  ttsListVoices(engine: TtsEngineId): Promise<TtsVoiceInfo[]>;
  ttsSynthesize(engine: TtsEngineId, text: string, voiceId: string, rate: number): Promise<CloudTtsResult>;
  // misc
  getDiagnostics(): Promise<Diagnostics>;
  openExternal(url: string): Promise<void>;
  onMenu(cb: (action: string) => void): () => void;
}

declare global {
  interface Window { readalong: ReadAlongApi }
}
