import type { Settings, VocabState, WordStatus, MarkedRange, UsageRecord } from '@shared/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { JsonStore } from './storage';

const settingsStore = new JsonStore<Settings>('settings', () => structuredClone(DEFAULT_SETTINGS));
const vocabStore = new JsonStore<VocabState>('vocab', () => ({ words: {}, marked: {} }));
const usageStore = new JsonStore<{ records: UsageRecord[] }>('usage', () => ({ records: [] }));

function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = deepMerge(cur, v as never);
    else out[k] = v;
  }
  return out as T;
}

export function getSettings(): Settings { return deepMerge(structuredClone(DEFAULT_SETTINGS), settingsStore.get()); }
export function setSettings(patch: Partial<Settings>): Settings {
  const next = deepMerge(getSettings(), patch);
  settingsStore.set(next);
  return next;
}

export function getVocab(): VocabState { return vocabStore.get(); }
export function setWordStatus(lemma: string, status: WordStatus | null): void {
  vocabStore.update((v) => {
    const words = { ...v.words };
    if (status) words[lemma] = status; else delete words[lemma];
    return { ...v, words };
  });
}
export function setMarkedRanges(bookId: string, ranges: MarkedRange[]): void {
  vocabStore.update((v) => ({ ...v, marked: { ...v.marked, [bookId]: ranges } }));
}

export function addUsage(rec: UsageRecord): void {
  usageStore.update((u) => ({ records: [...u.records.slice(-5000), rec] }));
}
export function getUsage(): UsageRecord[] { return usageStore.get().records; }
export function usdSpent(sinceIso: string): number {
  return usageStore.get().records.filter((r) => r.date >= sinceIso).reduce((s, r) => s + r.usd, 0);
}
