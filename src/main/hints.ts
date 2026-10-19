import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Book } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { HintMap, HintsProgress } from '@shared/api';
import type { Settings, UsageRecord, VocabState, AiProviderId } from '@shared/settings';
import type { PromptBundle } from '@core/ai/prompts';
import { collectHardWords, batchHardWords, buildHintsPrompt, parseHints } from '@core/ai/hints';
import { runCompletion, estimateUsd, periodStarts, classifyError } from './ai';
import type { StreamResult } from './ai';
import { getSettings, getVocab, addUsage, usdSpent } from './settings';
import { loadBook, getDictionary } from './library';
import { dataDir, writeAtomic, readJsonFile } from './storage';

/**
 * Background "Word Wise in Chinese" job: for each chapter the learner opens, ask a cheap model for the
 * Chinese meaning of every hard word *as used in that chapter*, cache the answer per book and tell the
 * renderer when it is ready. Until then the reader shows the dictionary gloss.
 *
 * Cost: a chapter of ~80 hard words is ~80 × 15 tokens in + ~80 × 12 tokens out ≈ 2k tokens ≈ $0.0005 with
 * Claude Haiku 5.5 (the default when the provider is Anthropic). A 60-chapter novel is a few cents.
 *
 * Cache file: <userData>/data/hints/<bookId>.json = { version, chapters: { [index]: { [lemma]: [zh1, zh2] } } }.
 */

export const HINTS_CACHE_VERSION = 1;
/** The default hints model for an Anthropic key: the cheapest current Claude. */
export const DEFAULT_ANTHROPIC_HINTS_MODEL = 'claude-haiku-5-5';
/** A failed chapter is not retried automatically for this long (the learner's key or budget will not change in seconds). */
const RETRY_AFTER_MS = 2 * 60_000;

export interface HintsCache { version: number; chapters: Record<string, HintMap> }

/** Everything the job touches outside itself, so tests can run it without Electron, the network or the real stores. */
export interface HintsJobDeps {
  complete: (provider: AiProviderId, model: string, prompt: PromptBundle) => Promise<StreamResult>;
  loadBook: (id: string) => Book | null;
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

  constructor(private deps: HintsJobDeps) {}

  /** Cached hints of a chapter, or null when the job has not produced them yet. */
  get(bookId: string, chapter: number): HintMap | null {
    return this.cache(bookId).chapters[String(chapter)] ?? null;
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
    this.queue = this.queue.filter((p) => p.bookId !== bookId);
    for (const k of [...this.failed.keys()]) if (k.startsWith(`${bookId}:`)) this.failed.delete(k);
    try { fs.unlinkSync(this.file(bookId)); } catch { /* nothing cached */ }
  }

  /** Resolves when the queue is empty (tests). */
  async idle(): Promise<void> {
    while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 5));
  }

  get pending(): readonly Pending[] { return this.queue; }

  private file(bookId: string): string { return path.join(this.deps.dir(), `${bookId.replace(/[^\w.-]/g, '_')}.json`); }

  private cache(bookId: string): HintsCache {
    let c = this.caches.get(bookId);
    if (!c) {
      const stored = readJsonFile<HintsCache>(this.file(bookId));
      c = stored && stored.version === HINTS_CACHE_VERSION && stored.chapters && typeof stored.chapters === 'object' ? stored : { version: HINTS_CACHE_VERSION, chapters: {} };
      this.caches.set(bookId, c);
    }
    return c;
  }

  private store(bookId: string, chapter: number, hints: HintMap): void {
    const c = this.cache(bookId);
    c.chapters[String(chapter)] = hints;
    fs.mkdirSync(this.deps.dir(), { recursive: true });
    writeAtomic(this.file(bookId), JSON.stringify(c));
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

  private book(id: string): Book | null {
    const cached = this.books.get(id);
    if (cached) return cached;
    const b = this.deps.loadBook(id);
    if (b) { this.books.clear(); this.books.set(id, b); }
    return b;
  }

  private async run(p: Pending): Promise<void> {
    const { bookId, chapter } = p;
    const send = (ev: Omit<HintsProgress, 'bookId' | 'chapter'>) => this.deps.send({ bookId, chapter, ...ev });
    send({ state: 'running' });
    try {
      const s = this.deps.getSettings();
      const { provider, model } = hintsModelFor(s);
      const book = this.book(bookId);
      if (!book) throw Object.assign(new Error('The book is no longer in the library.'), { code: 'other' });
      if (!book.chapters[chapter]) throw Object.assign(new Error(`Chapter ${chapter + 1} does not exist.`), { code: 'other' });
      const dict = await this.deps.getDictionary();
      const known = new Set(Object.keys(this.deps.getVocab().words));
      const words = collectHardWords(book, chapter, dict, s.learnerLevel, new Set(book.names), known);
      const hints: HintMap = {};
      const title = book.chapters[chapter].title;
      for (const batch of batchHardWords(words)) {
        const monthly = this.deps.usdSpent(periodStarts().month);
        if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) {
          throw Object.assign(new Error(`Monthly AI budget of $${s.ai.monthlyStopUsd} reached. Raise it in Settings to continue.`), { code: 'budget' });
        }
        const prompt = buildHintsPrompt(batch, { title: book.title, chapter: title, level: s.learnerLevel });
        const result = await this.deps.complete(provider, model, prompt);
        const usd = estimateUsd(model, result.inputTokens, result.outputTokens, result.cachedTokens);
        try { this.deps.addUsage({ date: new Date().toISOString(), provider, model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedTokens: result.cachedTokens, usd }); } catch (e) { console.error('hints usage not recorded', e); }
        const parsed = parseHints(result.text);
        // keep only the words we asked about, under the lemma we asked with
        for (const w of batch) {
          const pair = parsed[w.lemma] ?? parsed[w.lemma.toLowerCase()];
          if (pair) hints[w.lemma] = pair;
        }
      }
      this.store(bookId, chapter, hints);
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
    loadBook,
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
  ipcMain.handle('hints:request', (_e, bookId: string, chapter: number) => { j.request(String(bookId), Number(chapter)); });
  ipcMain.handle('hints:clear', (_e, bookId: string) => { j.clear(String(bookId)); });
}
