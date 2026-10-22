/**
 * Settings, word statuses and AI usage for the web build: the same semantics as src/main/settings.ts
 * (stored settings deep-merged over DEFAULT_SETTINGS, theme migration, last 5000 usage records),
 * stored in IndexedDB instead of JSON files.
 *
 * Web-only adjustment: the voice engines that need the Mac app (Kokoro, Microsoft Edge voices) are not
 * available in a browser, so they read as the built-in system voices ("webspeech").
 */
import type { Settings, VocabState, WordStatus, MarkedRange, UsageRecord, TtsEngineId } from '@shared/settings';
import { DEFAULT_SETTINGS, migrateSettings } from '@shared/settings';
import { KvDoc } from './idb';

/** Engines that run only in the desktop app. */
export const UNAVAILABLE_ENGINES: readonly TtsEngineId[] = ['kokoro', 'edge'];

/** DEFAULT_SETTINGS with the voice set to the browser's built-in voices (Safari: the iPad's own voices). */
export function webDefaults(): Settings {
  const d = structuredClone(DEFAULT_SETTINGS);
  d.voice = { ...d.voice, engine: 'webspeech', voiceId: '' };
  return d;
}

const settingsDoc = new KvDoc<Partial<Settings>>('settings', () => ({}));
const vocabDoc = new KvDoc<VocabState>('vocab', () => ({ words: {}, marked: {} }));
const usageDoc = new KvDoc<{ records: UsageRecord[] }>('usage', () => ({ records: [] }));

/** Recursively merges patch over base: nested plain objects merge, arrays and scalars replace (as src/main/settings.ts). */
export function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries((patch ?? {}) as Record<string, unknown>)) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = deepMerge(cur, v as never);
    else out[k] = v;
  }
  return out as T;
}

/** Replaces desktop-only voice engines by the browser voices. */
export function webVoice(s: Settings): Settings {
  const v = s.voice;
  if (UNAVAILABLE_ENGINES.includes(v.engine)) s.voice = { ...v, engine: 'webspeech', voiceId: '' };
  if (s.voice.explainEngine && UNAVAILABLE_ENGINES.includes(s.voice.explainEngine)) s.voice = { ...s.voice, explainEngine: null, explainVoiceId: null };
  return s;
}

export async function getSettings(): Promise<Settings> {
  const stored = structuredClone(await settingsDoc.load()) as Partial<Settings>;
  return webVoice(migrateSettings(deepMerge(webDefaults(), migrateSettings(stored as Settings))));
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = webVoice(migrateSettings(deepMerge(await getSettings(), migrateSettings(structuredClone(patch) as Settings))));
  await settingsDoc.set(next);
  return next;
}

export async function getVocab(): Promise<VocabState> { return structuredClone(await vocabDoc.load()); }
export async function setWordStatus(lemma: string, status: WordStatus | null): Promise<void> {
  await vocabDoc.update((v) => {
    const words = { ...v.words };
    if (status) words[lemma] = status; else delete words[lemma];
    return { ...v, words };
  });
}
export async function setMarkedRanges(bookId: string, ranges: MarkedRange[]): Promise<void> {
  await vocabDoc.update((v) => ({ ...v, marked: { ...v.marked, [bookId]: ranges } }));
}

export async function addUsage(rec: UsageRecord): Promise<void> {
  await usageDoc.update((u) => ({ records: [...u.records.slice(-5000), rec] }));
}
export async function getUsage(): Promise<UsageRecord[]> { return [...(await usageDoc.load()).records]; }
export async function usdSpent(sinceIso: string): Promise<number> {
  return (await usageDoc.load()).records.filter((r) => r.date >= sinceIso).reduce((s, r) => s + r.usd, 0);
}
