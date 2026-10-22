import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Book } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { HintMap, HintsProgress, PhraseMap } from '@shared/api';
import type { Settings, UsageRecord, VocabState, AiProviderId } from '@shared/settings';
import type { PromptBundle } from '@core/ai/prompts';
import { collectHardWordsAsync, batchHardWords, buildHintsPrompt, parseHints, chunkChapter, phraseQuota, buildPhrasesPrompt, parsePhrases, validatePhrases, mapPhraseHits, chapterText, PHRASES_PER_CHAPTER } from '@core/ai/hints';
import type { RawPhrase } from '@core/ai/hints';
import { looksLikeFreeCombination } from '@core/dict/dictionary';
import { runCompletion, estimateUsd, periodStarts, classifyError } from './ai';
import type { StreamResult } from './ai';
import { getSettings, getVocab, addUsage, usdSpent } from './settings';
import { readBook, getDictionary } from './library';
import { hasSecret } from './secrets';
import { dataDir, writeAtomicAsync, readJsonFile } from './storage';

/**
 * Background "Word Wise in Chinese" job: for each chapter the learner opens, ask a cheap model for the
 * Chinese meaning of every hard word *as used in that chapter*, cache the answer per book and tell the
 * renderer when it is ready. Until then the reader shows the dictionary gloss.
 *
 * Cost: a chapter of ~80 hard words is ~80 × 15 tokens in + ~80 × 12 tokens out ≈ 2k tokens ≈ $0.0005 with
 * Claude Haiku 5.5 (the default when the provider is Anthropic). A 60-chapter novel is a few cents.
 *
 * The same job finds the chapter's phrases (idioms, phrasal verbs, fixed expressions; docs/RULES.md "Phrases"):
 * one more request per chunk of ~18k characters (most chapters: one) ≈ $0.0012, each phrase with the model's CEFR
 * level, validated against the chapter text and mapped to token spans of its sentences (PhraseHit).
 *
 * Cache file: <userData>/data/hints/<bookId>.json =
 *   { version, chapters: { [index]: { [lemma]: [zh1, zh2] } }, phrases: { [index]: { [sentenceKey]: PhraseHit[] } } }.
 * A chapter is done when both are stored; a cache of an older version is dropped and recomputed on request.
 *
 * The job shares the main process with the voice's audio and the AI's text, so it stays out of their way: no key, no
 * work (checked first); the book is the library's parsed copy (not read and parsed again); the hard words are
 * collected a paragraph at a time with the thread given back in between; the cache file is written asynchronously.
 */

export const HINTS_CACHE_VERSION = 2;
/** The default hints model for an Anthropic key: the cheapest current Claude. */
export const DEFAULT_ANTHROPIC_HINTS_MODEL = 'claude-haiku-5-5';
/** A failed chapter is not retried automatically for this long (the learner's key or budget will not change in seconds). */
const RETRY_AFTER_MS = 2 * 60_000;

export interface HintsCache { version: number; chapters: Record<string, HintMap>; phrases: Record<string, PhraseMap> }

/** Everything the job touches outside itself, so tests can run it without Electron, the network or the real stores. */
export interface HintsJobDeps {
  complete: (provider: AiProviderId, model: string, prompt: PromptBundle) => Promise<StreamResult>;
  /** the parsed book (the library shares the copy it read last) */
  loadBook: (id: string) => Promise<Book | null> | Book | null;
  /** is a key saved for the provider? Without one the job does no work at all (missing = assume yes) */
  hasKey?: (provider: AiProviderId) => boolean;
  getDictionary: () => Promise<Dictionary>;
  getSettings: () => Settings;
  getVocab: () => VocabState;
  addUsage: (rec: UsageRecord) => void;
  usdSpent: (sinceIso: string) => number;
  /** directory of the per-book cache files */
  dir: () => string;
  send: (ev: HintsProgress) => void;
}

/** The provider and model the job uses: the explanation provider, with the hints model override or the cheapest default. */
export function hintsModelFor(s: Settings): { provider: AiProviderId; model: string } {
  const provider = s.ai.provider;
  const model = s.ai.hintsModel?.trim() || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_HINTS_MODEL : s.ai.openaiModel);
  return { provider, model };
}

interface Pending { bookId: string; chapter: number }

export class HintsJob {
  private caches = new Map<string, HintsCache>();
  private queue: Pending[] = [];
  private running: Pending | null = null;
  /** the chapter the learner is reading (last requested), used to order the queue */
  private focus: Pending | null = null;
  private failed = new Map<string, number>();
  private books = new Map<string, Book>();
  /** the cache file write of each book (one at a time per book; each writes the latest cache) */
  private writes = new Map<string, Promise<void>>();
  /** bumped by clear(): a chapter that was running then is not stored */
  private generation = new Map<string, number>();

  constructor(private deps: HintsJobDeps) {}

  /** Cached hints of a chapter, or null when the job has not produced them yet. */
  get(bookId: string, chapter: number): HintMap | null {
    return this.cache(bookId).chapters[String(chapter)] ?? null;
  }

  /** Cached phrase hits of a chapter (sentenceKey -> hits), or null when the job has not produced them yet. */
  phrases(bookId: string, chapter: number): PhraseMap | null {
    return this.cache(bookId).phrases[String(chapter)] ?? null;
  }

  /** Queues a chapter. Cached, queued, running and recently failed chapters are left alone. */
  request(bookId: string, chapter: number): void {
    if (!bookId || !Number.isInteger(chapter) || chapter < 0) return;
    this.focus = { bookId, chapter };
    if (this.get(bookId, chapter)) return;
    if (this.queue.some((p) => same(p, this.focus!)) || (this.running && same(this.running, this.focus))) return;
    const failedAt = this.failed.get(key(bookId, chapter));
    if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_MS) return;
    this.queue.push({ bookId, chapter });
    this.deps.send({ bookId, chapter, state: 'queued' });
    void this.pump();
  }

  /** Forgets the hints of a book (file and memory) and drops its queued chapters. */
  clear(bookId: string): void {
    this.caches.delete(bookId);
    this.books.delete(bookId);
    this.generation.set(bookId, (this.generation.get(bookId) ?? 0) + 1);
    this.queue = this.queue.filter((p) => p.bookId !== bookId);
    for (const k of [...this.failed.keys()]) if (k.startsWith(`${bookId}:`)) this.failed.delete(k);
    const file = this.file(bookId);
    const unlink = () => { try { fs.unlinkSync(file); } catch { /* nothing cached */ } };
    unlink();
    // a write that was already running may put the file back: remove it again once it ended
    void this.writes.get(bookId)?.then(unlink);
  }

  /** Resolves when the queue is empty and the cache files are written (tests). */
  async idle(): Promise<void> {
    while (this.running || this.queue.length || this.writes.size) {
      await Promise.all([...this.writes.values()]);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  get pending(): readonly Pending[] { return this.queue; }

  private file(bookId: string): string { return path.join(this.deps.dir(), `${bookId.replace(/[^\w.-]/g, '_')}.json`); }

  private cache(bookId: string): HintsCache {
    let c = this.caches.get(bookId);
    if (!c) {
      const stored = readJsonFile<HintsCache>(this.file(bookId));
      c = stored && stored.version === HINTS_CACHE_VERSION && stored.chapters && typeof stored.chapters === 'object' ? stored : { version: HINTS_CACHE_VERSION, chapters: {}, phrases: {} };
      if (!c.phrases || typeof c.phrases !== 'object') c.phrases = {};
      this.caches.set(bookId, c);
    }
    return c;
  }

  private store(bookId: string, chapter: number, hints: HintMap, phrases: PhraseMap): void {
    const c = this.cache(bookId);
    c.chapters[String(chapter)] = hints;
    c.phrases[String(chapter)] = phrases;
    this.persist(bookId, c);
  }

  /** Writes the book's cache file in the background, after any write of it still running (readers use the memory copy). */
  private persist(bookId: string, c: HintsCache): void {
    const prev = this.writes.get(bookId) ?? Promise.resolve();
    const next = prev.then(async () => {
      // cleared (or replaced) meanwhile: this copy is not to be saved
      if (this.caches.get(bookId) !== c) return;
      await fs.promises.mkdir(this.deps.dir(), { recursive: true });
      await writeAtomicAsync(this.file(bookId), JSON.stringify(c));
    }).catch((e) => { console.error('hints: could not write the cache', e); });
    this.writes.set(bookId, next);
    void next.then(() => { if (this.writes.get(bookId) === next) this.writes.delete(bookId); });
  }

  /** The current chapter first, then the chapters after it, then earlier ones, then other books. */
  private next(): Pending | undefined {
    if (this.queue.length === 0) return undefined;
    const f = this.focus;
    const rank = (p: Pending): number => {
      if (!f || p.bookId !== f.bookId) return 1_000_000;
      return p.chapter >= f.chapter ? p.chapter - f.chapter : 100_000 + (f.chapter - p.chapter);
    };
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) if (rank(this.queue[i]) < rank(this.queue[best])) best = i;
    return this.queue.splice(best, 1)[0];
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    for (let p = this.next(); p; p = this.next()) {
      this.running = p;
      try {
        await this.run(p);
      } finally {
        this.running = null;
      }
    }
  }

  private async book(id: string): Promise<Book | null> {
    const cached = this.books.get(id);
    if (cached) return cached;
    const b = await this.deps.loadBook(id);
    if (b) { this.books.clear(); this.books.set(id, b); }
    return b;
  }

  private async run(p: Pending): Promise<void> {
    const { bookId, chapter } = p;
    const send = (ev: Omit<HintsProgress, 'bookId' | 'chapter'>) => this.deps.send({ bookId, chapter, ...ev });
    send({ state: 'running' });
    const generation = this.generation.get(bookId) ?? 0;
    try {
      const s = this.deps.getSettings();
      const { provider, model } = hintsModelFor(s);
      // without a key nothing can be asked: no reading, parsing or word collecting for nothing
      if (this.deps.hasKey && !this.deps.hasKey(provider)) throw Object.assign(new Error(provider === 'anthropic' ? 'Add your Anthropic API key in Settings.' : 'Add your OpenAI API key in Settings.'), { code: 'no_key' });
      const book = await this.book(bookId);
      if (!book) throw Object.assign(new Error('The book is no longer in the library.'), { code: 'other' });
      if (!book.chapters[chapter]) throw Object.assign(new Error(`Chapter ${chapter + 1} does not exist.`), { code: 'other' });
      const dict = await this.deps.getDictionary();
      const known = new Set(Object.keys(this.deps.getVocab().words));
      const words = await collectHardWordsAsync(book, chapter, dict, s.learnerLevel, new Set(book.names), known, yieldNow);
      const hints: HintMap = {};
      const title = book.chapters[chapter].title;
      /** one budget-checked, usage-recorded request */
      const ask = async (prompt: PromptBundle): Promise<string> => {
        const monthly = this.deps.usdSpent(periodStarts().month);
        if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) {
          throw Object.assign(new Error(`Monthly AI budget of $${s.ai.monthlyStopUsd} reached. Raise it in Settings to continue.`), { code: 'budget' });
        }
        const result = await this.deps.complete(provider, model, prompt);
        const usd = estimateUsd(model, result.inputTokens, result.outputTokens, result.cachedTokens);
        try { this.deps.addUsage({ date: new Date().toISOString(), provider, model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedTokens: result.cachedTokens, usd }); } catch (e) { console.error('hints usage not recorded', e); }
        return result.text;
      };
      for (const batch of batchHardWords(words)) {
        const prompt = buildHintsPrompt(batch, { title: book.title, chapter: title, level: s.learnerLevel });
        const parsed = parseHints(await ask(prompt));
        // keep only the words we asked about, under the lemma we asked with
        for (const w of batch) {
          const pair = parsed[w.lemma] ?? parsed[w.lemma.toLowerCase()];
          if (pair) hints[w.lemma] = pair;
        }
      }
      // phrases of the chapter, each with the model's level, kept only when they literally appear
      const chunks = chunkChapter(book, chapter);
      const quota = phraseQuota(chunks);
      const raw: RawPhrase[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const prompt = buildPhrasesPrompt(chunks[i], { title: book.title, chapter: title, level: s.learnerLevel, max: quota[i], part: [i + 1, chunks.length] });
        raw.push(...parsePhrases(await ask(prompt)));
      }
      await yieldNow();
      const items = validatePhrases(raw, chapterText(book, chapter), {
        max: PHRASES_PER_CHAPTER * Math.max(1, chunks.length),
        isFree: (ws, zh) => looksLikeFreeCombination(dict, ws, zh),
      });
      await yieldNow();
      const phrases = mapPhraseHits(book, chapter, items, (w) => dict.lemmaOf(w));
      // the learner cleared this book's hints while it ran: the result belongs to the old cache
      if ((this.generation.get(bookId) ?? 0) !== generation) { send({ state: 'done' }); return; }
      this.store(bookId, chapter, hints, phrases);
      this.failed.delete(key(bookId, chapter));
      send({ state: 'done' });
    } catch (e) {
      this.failed.set(key(bookId, chapter), Date.now());
      const err = e as { code?: string; message?: string };
      const c = err?.code === 'no_key' || err?.code === 'budget' || err?.code === 'other' ? { message: err.message ?? 'Unknown AI error', code: err.code } : classifyError(e, { model: hintsModelFor(this.deps.getSettings()).model });
      send({ state: 'error', error: c.message, code: c.code as HintsProgress['code'] });
    }
  }
}

function key(bookId: string, chapter: number): string { return `${bookId}:${chapter}`; }
/** gives the main process's event loop a turn (audio and AI messages waiting behind the job) */
const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));
function same(a: Pending, b: Pending): boolean { return a.bookId === b.bookId && a.chapter === b.chapter; }

export function hintsDir(): string {
  const dir = path.join(dataDir(), 'hints');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let job: HintsJob | null = null;

/** The app-wide job wired to the real stores, the library and the network. */
export function getHintsJob(getWindow: () => BrowserWindow | null): HintsJob {
  if (job) return job;
  job = new HintsJob({
    complete: (provider, model, prompt) => runCompletion(provider, model, prompt),
    loadBook: readBook,
    hasKey: (provider) => hasSecret(provider),
    getDictionary,
    getSettings,
    getVocab,
    addUsage,
    usdSpent,
    dir: hintsDir,
    send: (ev) => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      try { win.webContents.send('hints:progress', ev); } catch { /* window closed */ }
    },
  });
  return job;
}

export function registerHintsHandlers(getWindow: () => BrowserWindow | null): void {
  const j = getHintsJob(getWindow);
  ipcMain.handle('hints:get', (_e, bookId: string, chapter: number) => j.get(String(bookId), Number(chapter)));
  ipcMain.handle('hints:phrases', (_e, bookId: string, chapter: number) => j.phrases(String(bookId), Number(chapter)));
  ipcMain.handle('hints:request', (_e, bookId: string, chapter: number) => { j.request(String(bookId), Number(chapter)); });
  ipcMain.handle('hints:clear', (_e, bookId: string) => { j.clear(String(bookId)); });
}
