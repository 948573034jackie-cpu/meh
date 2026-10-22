import type { Book, Position, CefrLevel } from '@core/model';
import type { Settings, VocabState, LibraryItem, WordStatus, MarkedRange, UsageRecord, TtsEngineId } from './settings';
import type { HintMap, PhraseMap } from '@core/ai/hints';
import type { EndPunct } from '@core/tts/segments';

export type { HintMap, HintPair, PhraseHit, PhraseMap } from '@core/ai/hints';

/** Progress of the background chapter-hints job (src/main/hints.ts), broadcast as 'hints:progress'. */
export interface HintsProgress {
  bookId: string;
  chapter: number;
  state: 'queued' | 'running' | 'done' | 'error';
  /** learner-readable message when state is 'error' */
  error?: string;
  code?: AiErrorCode;
}

export interface DictData { w: Record<string, DictRaw>; f: Record<string, string> }
export interface DictRaw { i: string; t: string; g: string; f: number; b: number; c: number; o: number; l: string; s: string }

/* ------------------------------------------------------------------------------------------------
 * My Vocabulary (src/main/vocabulary.ts): every word the learner had explained, with where it was met.
 * ---------------------------------------------------------------------------------------------- */

export type VocabEntryStatus = 'learning' | 'known';

export interface VocabEntry {
  /** dictionary lemma; the key of the entry and of VocabState.words */
  lemma: string;
  /** the word as it appeared in the text the first time */
  word: string;
  /** the sentence it was first met in (kept on later explanations) */
  sentence: string;
  /** the latest explanation */
  explanation: string;
  /** Chinese meaning (dictionary gloss or the explanation's Chinese line) */
  chinese: string;
  bookId: string;
  bookTitle: string;
  /** chapter title (or number) where the word was first met */
  chapter: string;
  position: Position | null;
  createdAt: string;
  lastSeenAt: string;
  timesExplained: number;
  status: VocabEntryStatus;
  level?: CefrLevel;
  /** how many times the learner said "I don't know" about this word */
  again: number;
}

/** What the reader sends when a word was explained; counters and dates are filled in by the store. */
export interface VocabEntryInput {
  lemma: string;
  word: string;
  sentence: string;
  explanation: string;
  chinese?: string;
  bookId: string;
  bookTitle: string;
  chapter: string;
  position?: Position | null;
  level?: CefrLevel;
  /** true when this explanation was an "I don't know" (explain again) */
  again?: boolean;
}

export interface LevelProgress {
  level: CefrLevel;
  /** words of this level (CEFR-tagged dictionary words) marked known */
  known: number;
  learning: number;
  /** CEFR-tagged dictionary words of this level that are neither known nor learning (ignored words are left out) */
  unknown: number;
  /** CEFR-tagged dictionary words at this level */
  total: number;
}

export interface VocabProgress {
  levels: LevelProgress[];
  totals: {
    /** all words marked known (any level, tagged or not) */
    known: number;
    learning: number;
    unknown: number;
    /** entries in My Vocabulary */
    entries: number;
  };
  /** entries added to My Vocabulary in the last 7 days */
  learnedThisWeek: number;
  /** days in a row (ending today or yesterday) with at least one word met or explained */
  streakDays: number;
  /** YYYY-MM-DD of the last day with activity, null when there is none */
  lastActiveDay: string | null;
}

/** A dictionary word the learner does not know yet, for the Progress page. */
export interface UnknownWord { word: string; zh: string; ipa: string; level: CefrLevel; frq: number }

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
  /** the learner heard an explanation and said "I don't know": explain again, deeper */
  again?: boolean;
  /** previous exchanges in this chapter, oldest first */
  history: { role: 'user' | 'assistant'; text: string }[];
}

export interface KokoroStatus {
  state: 'missing' | 'downloading' | 'loading' | 'ready' | 'error';
  variant: string;
  modelDir: string;
  downloadBytes: number;
  progress: { file: string; received: number; total: number; percent: number } | null;
  error: string | null;
  queued: number;
  version: string;
}

/** Local speech-to-text engine status (mirrors src/main/stt/engine.ts EngineStatus), broadcast as 'stt:progress'. */
export interface SttStatus {
  state: 'missing' | 'downloading' | 'loading' | 'ready' | 'error';
  variant: 'moonshine-base' | 'moonshine-tiny' | 'parakeet-v3';
  modelDir: string;
  /** bytes still to download for the configured model (0 when installed) */
  downloadBytes: number;
  progress: { phase: 'download' | 'extract' | 'done'; file: string; received: number; total: number; overallReceived: number; overallTotal: number } | null;
  error: string | null;
  sessions: number;
  version: string;
  confidence: boolean;
}

/** One event of the speech-to-text engine ('stt:event'); same shape as SttEngineEvent in src/core/voice/session.ts. */
export type SttEvent =
  | { type: 'partial' | 'final'; text: string; confidence?: number; segmentId: string; sessionId: string }
  | { type: 'speechStart' | 'speechEnd'; sessionId: string; segmentId: string }
  | { type: 'error'; sessionId: string; message: string };

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

export interface CloudTtsResult {
  audio: ArrayBuffer; mime: string; timings: WordTiming[] | null; durationSec: number | null;
  /**
   * the local voice (Kokoro) trims its audio to the speech and names the punctuation the text ended with, so the
   * renderer adds that pause before the next segment of the same sentence (src/core/tts/segments SEGMENT_PAUSE_MS)
   */
  endPunct?: EndPunct;
}

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
  // My Vocabulary (the explained-words list; keeps VocabState.words in sync)
  vocabEntries(): Promise<VocabEntry[]>;
  /** adds a word or merges into its entry: one more explanation, first sentence kept, latest explanation kept */
  vocabUpsertEntry(entry: VocabEntryInput): Promise<VocabEntry>;
  vocabSetEntryStatus(lemma: string, status: VocabEntryStatus): Promise<void>;
  vocabDeleteEntry(lemma: string): Promise<void>;
  /** writes ~/Documents/Dream Read/my-vocabulary.csv now, reveals it in Finder and resolves with the path */
  vocabExportCsv(): Promise<string>;
  /** where the CSV is written (it is also rewritten automatically after every change) */
  vocabCsvPath(): Promise<string>;
  vocabProgress(): Promise<VocabProgress>;
  /** dictionary words of that CEFR level the learner has not marked yet, most frequent first */
  vocabUnknownAtLevel(level: CefrLevel): Promise<UnknownWord[]>;
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
  // chapter hints (Chinese meaning under hard words, chosen by the AI for the chapter; see src/main/hints.ts)
  /** cached hints of a chapter (lemma -> [meaning here, other meaning]) or null when the job has not run yet */
  hintsGet(bookId: string, chapter: number): Promise<HintMap | null>;
  /**
   * cached phrases of a chapter found by the same job: sentenceKey ("c.p.s") -> PhraseHit[] (token span with
   * INCLUSIVE end, lemma, the model's CEFR level, Chinese meaning), or null when the job has not run yet.
   * Refetch on the 'done' hints:progress event. Pass map[sentenceKey] to annotateSentence(…, hits).
   */
  hintsPhrases(bookId: string, chapter: number): Promise<PhraseMap | null>;
  /** queues the chapter (no-op when cached or already queued); progress arrives through onHintsProgress */
  hintsRequest(bookId: string, chapter: number): Promise<void>;
  /** forgets the cached hints of a book (next request recomputes them) */
  hintsClear(bookId: string): Promise<void>;
  onHintsProgress(cb: (ev: HintsProgress) => void): () => void;
  // cloud TTS (engines that synthesize in the main process)
  ttsListVoices(engine: TtsEngineId): Promise<TtsVoiceInfo[]>;
  ttsSynthesize(engine: TtsEngineId, text: string, voiceId: string, rate: number): Promise<CloudTtsResult>;
  // Kokoro (free local voice): model download and prefetch
  kokoroStatus(): Promise<KokoroStatus>;
  kokoroDownload(): Promise<KokoroStatus>;
  kokoroCancelDownload(): Promise<void>;
  /**
   * queues texts for synthesis (src/main/kokoro/ipc.ts has the item rules: priority, wait, replace, release, drop);
   * with `wait` items it resolves true when they are ready, false when they were dropped first
   */
  kokoroPrepare(items: { text: string; voice?: string; speed?: number; priority?: number; wait?: boolean; replace?: boolean; release?: boolean; drop?: string[] }[]): Promise<boolean | void>;
  onKokoroProgress(cb: (s: KokoroStatus) => void): () => void;
  // local speech-to-text (docs/VOICE.md); absent where there is no STT engine (the web build)
  sttStatus?(): Promise<SttStatus>;
  /** downloads the configured model; resolves when it is on disk (progress via onSttProgress) */
  sttDownload?(): Promise<SttStatus>;
  sttCancelDownload?(): Promise<void>;
  /** opens a mic session (loads the model first) */
  sttStart?(sessionId: string, opts?: { sampleRate?: number }): Promise<SttStatus>;
  /** Int16 mono PCM at the session rate (16 kHz), 20–40 ms per call */
  sttPush?(sessionId: string, pcm: ArrayBuffer): Promise<void>;
  /** closes the session; resolves after its last final transcript was sent */
  sttStop?(sessionId: string): Promise<void>;
  onSttEvent?(cb: (ev: SttEvent) => void): () => void;
  onSttProgress?(cb: (s: SttStatus) => void): () => void;
  // misc
  getDiagnostics(): Promise<Diagnostics>;
  openExternal(url: string): Promise<void>;
  /** Writes a text file into ~/Documents/Dream Read and reveals it in Finder; resolves with the full path. */
  exportText(fileName: string, contents: string): Promise<string>;
  onMenu(cb: (action: string) => void): () => void;
}

declare global {
  interface Window { readalong: ReadAlongApi }
}
