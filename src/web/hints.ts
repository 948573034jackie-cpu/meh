/**
 * The chapter-hints job ("Word Wise in Chinese") in the browser: the same queue, ordering, retry and
 * caching semantics as src/main/hints.ts (HintsJob), with the per-book cache kept in the IndexedDB
 * "hints" store as { version, chapters: { [index]: HintMap } } and progress delivered to onHintsProgress.
 */
import type { Book } from '@core/model';
import type { HintMap, HintsProgress } from '@shared/api';
import type { Settings, AiProviderId } from '@shared/settings';
import { collectHardWords, batchHardWords, buildHintsPrompt, parseHints } from '@core/ai/hints';
import { runCompletion, estimateUsd, periodStarts, classifyError } from './ai';
import { getSettings, getVocab, addUsage, usdSpent } from './settings';
import { readBook, getDictionary } from './library';
import { idbGet, idbSet, idbDelete } from './idb';

export const HINTS_CACHE_VERSION = 1;
export const DEFAULT_ANTHROPIC_HINTS_MODEL = 'claude-haiku-5-5';
const RETRY_AFTER_MS = 2 * 60_000;

export interface HintsCache { version: number; chapters: Record<string, HintMap> }

export function hintsModelFor(s: Settings): { provider: AiProviderId; model: string } {
  const provider = s.ai.provider;
  const model = s.ai.hintsModel?.trim() || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_HINTS_MODEL : s.ai.openaiModel);
  return { provider, model };
}

interface Pending { bookId: string; chapter: number }
const key = (bookId: string, chapter: number) => `${bookId}:${chapter}`;
const same = (a: Pending, b: Pending) => a.bookId === b.bookId && a.chapter === b.chapter;

const listeners = new Set<(ev: HintsProgress) => void>();
function send(ev: HintsProgress): void { for (const cb of [...listeners]) { try { cb(ev); } catch (e) { console.error(e); } } }
export function onHintsProgress(cb: (ev: HintsProgress) => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }

class WebHintsJob {
  private caches = new Map<string, Promise<HintsCache>>();
  private queue: Pending[] = [];
  private running: Pending | null = null;
  private focus: Pending | null = null;
  private failed = new Map<string, number>();
  private books = new Map<string, Book>();

  async get(bookId: string, chapter: number): Promise<HintMap | null> {
    return (await this.cache(bookId)).chapters[String(chapter)] ?? null;
  }

  async request(bookId: string, chapter: number): Promise<void> {
    if (!bookId || !Number.isInteger(chapter) || chapter < 0) return;
    const p = { bookId, chapter };
    this.focus = p;
    if (await this.get(bookId, chapter)) return;
    if (this.queue.some((q) => same(q, p)) || (this.running && same(this.running, p))) return;
    const failedAt = this.failed.get(key(bookId, chapter));
    if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_MS) return;
    this.queue.push(p);
    send({ bookId, chapter, state: 'queued' });
    void this.pump();
  }

  async clear(bookId: string): Promise<void> {
    this.caches.delete(bookId);
    this.books.delete(bookId);
    this.queue = this.queue.filter((p) => p.bookId !== bookId);
    for (const k of [...this.failed.keys()]) if (k.startsWith(`${bookId}:`)) this.failed.delete(k);
    try { await idbDelete('hints', bookId); } catch { /* nothing cached */ }
  }

  private cache(bookId: string): Promise<HintsCache> {
    let c = this.caches.get(bookId);
    if (!c) {
      c = idbGet<HintsCache>('hints', bookId).catch(() => undefined).then((stored) =>
        stored && stored.version === HINTS_CACHE_VERSION && stored.chapters && typeof stored.chapters === 'object' ? stored : { version: HINTS_CACHE_VERSION, chapters: {} });
      this.caches.set(bookId, c);
    }
    return c;
  }

  private async store(bookId: string, chapter: number, hints: HintMap): Promise<void> {
    const c = await this.cache(bookId);
    c.chapters[String(chapter)] = hints;
    await idbSet('hints', bookId, c);
  }

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
      try { await this.run(p); } finally { this.running = null; }
    }
  }

  private async book(id: string): Promise<Book | null> {
    const cached = this.books.get(id);
    if (cached) return cached;
    const b = await readBook(id);
    if (b) { this.books.clear(); this.books.set(id, b); }
    return b;
  }

  private async run(p: Pending): Promise<void> {
    const { bookId, chapter } = p;
    const progress = (ev: Omit<HintsProgress, 'bookId' | 'chapter'>) => send({ bookId, chapter, ...ev });
    progress({ state: 'running' });
    try {
      const s = await getSettings();
      const { provider, model } = hintsModelFor(s);
      const book = await this.book(bookId);
      if (!book) throw Object.assign(new Error('The book is no longer in the library.'), { code: 'other' });
      if (!book.chapters[chapter]) throw Object.assign(new Error(`Chapter ${chapter + 1} does not exist.`), { code: 'other' });
      const dict = await getDictionary();
      const known = new Set(Object.keys((await getVocab()).words));
      const words = collectHardWords(book, chapter, dict, s.learnerLevel, new Set(book.names), known);
      const hints: HintMap = {};
      const title = book.chapters[chapter].title;
      for (const batch of batchHardWords(words)) {
        const monthly = await usdSpent(periodStarts().month);
        if (s.ai.monthlyStopUsd > 0 && monthly >= s.ai.monthlyStopUsd) {
          throw Object.assign(new Error(`Monthly AI budget of $${s.ai.monthlyStopUsd} reached. Raise it in Settings to continue.`), { code: 'budget' });
        }
        const prompt = buildHintsPrompt(batch, { title: book.title, chapter: title, level: s.learnerLevel });
        const result = await runCompletion(provider, model, prompt);
        const usd = estimateUsd(model, result.inputTokens, result.outputTokens, result.cachedTokens);
        try { await addUsage({ date: new Date().toISOString(), provider, model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedTokens: result.cachedTokens, usd }); } catch (e) { console.error('hints usage not recorded', e); }
        const parsed = parseHints(result.text);
        for (const w of batch) {
          const pair = parsed[w.lemma] ?? parsed[w.lemma.toLowerCase()];
          if (pair) hints[w.lemma] = pair;
        }
      }
      await this.store(bookId, chapter, hints);
      this.failed.delete(key(bookId, chapter));
      progress({ state: 'done' });
    } catch (e) {
      this.failed.set(key(bookId, chapter), Date.now());
      const err = e as { code?: string; message?: string };
      const c = err?.code === 'no_key' || err?.code === 'budget' || err?.code === 'other'
        ? { message: err.message ?? 'Unknown AI error', code: err.code }
        : classifyError(e, { model: hintsModelFor(await getSettings()).model });
      progress({ state: 'error', error: c.message, code: c.code as HintsProgress['code'] });
    }
  }
}

export const hintsJob = new WebHintsJob();
