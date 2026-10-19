import type { Book, Position } from '@core/model';
import type { Settings, VocabState, LibraryItem, WordStatus, MarkedRange, UsageRecord, TtsEngineId } from './settings';

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
  /** exact place being read, so the AI can follow the timeline */
  position?: Position;
  /** explanation style to use; undefined = the active style in settings */
  styleId?: string;
  /** previous exchanges in this chapter, oldest first */
  history: { role: 'user' | 'assistant'; text: string }[];
}

export type AiErrorCode = 'no_key' | 'auth' | 'rate_limit' | 'spend_limit' | 'model' | 'network' | 'timeout' | 'budget' | 'cancelled' | 'other';

export type AiEvent =
  | { type: 'delta'; streamId: string; text: string }
  | { type: 'done'; streamId: string; text: string; usage: { inputTokens: number; outputTokens: number; cachedTokens: number; usd: number; dailyUsd: number; monthlyUsd: number; model: string } }
  | { type: 'error'; streamId: string; message: string; code?: AiErrorCode };

/**
 * API keys the app can store, one per service. Values are plain key strings, except:
 *  - azure: a JSON string {"key": "...", "region": "uksouth"}; a plain key is also accepted and then
 *    the region defaults to "uksouth" (see src/main/secrets.ts getAzureCredentials).
 *  - google: a Google Cloud API key (not a service-account JSON) with the Text-to-Speech API enabled.
 */
export type SecretName = 'anthropic' | 'openai' | 'elevenlabs' | 'azure' | 'google';
export const SECRET_NAMES: readonly SecretName[] = ['anthropic', 'openai', 'elevenlabs', 'azure', 'google'];
export const SECRET_LABELS: Record<SecretName, string> = { anthropic: 'Anthropic', openai: 'OpenAI', elevenlabs: 'ElevenLabs', azure: 'Azure Speech', google: 'Google Cloud' };

export interface SecretStatus {
  /** a record for this key exists in secrets.json */
  saved: boolean;
  /** the record decrypts with the app's key file (false = saved but unreadable) */
  verified: boolean;
  /** the key could not be recovered at startup (old Keychain record after a re-sign); shown to the user once */
  lostAtStartup: boolean;
}
export type SecretStatusMap = Record<SecretName, SecretStatus>;

/** Result of the "Test" button for any provider key. */
export interface ProviderTestResult { ok: boolean; message: string; detail?: string }

export interface TtsVoiceInfo { id: string; name: string; lang: string; gender?: string; quality?: string; note?: string }

export interface WordTiming { start: number; end: number; charIndex: number; charLength: number }

export interface CloudTtsResult { audio: ArrayBuffer; mime: string; timings: WordTiming[] | null; durationSec: number | null }

export interface Diagnostics {
  platform: string; arch: string; electron: string; chrome: string; node: string; appVersion: string;
  userData: string; secretsFile: string; dictWords: number; secrets: SecretStatusMap;
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
  /** Saves (or removes, when empty) a key; resolves with a warning when the key does not look right. Throws if the key cannot be read back. */
  setSecret(name: SecretName, value: string): Promise<{ warning: string | null }>;
  hasSecret(name: SecretName): Promise<boolean>;
  secretStatus(): Promise<SecretStatusMap>;
  /** clears the "could not be recovered" notices for this session */
  dismissLostKeys(): Promise<void>;
  // AI
  aiExplain(req: ExplainRequest): Promise<{ streamId: string }>;
  aiCancel(streamId: string): Promise<void>;
  /** Tests the saved key of any provider (AI or voice) with a tiny request; the message is meant for the user. */
  aiTest(provider: SecretName): Promise<ProviderTestResult>;
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
