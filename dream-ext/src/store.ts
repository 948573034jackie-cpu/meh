/**
 * Everything the Dream Tutor keeps, in the extension's own storage (chrome.storage.local, unlimited): the
 * Dream Read settings (same shape and defaults as the Mac app), the YouTube extras, the word statuses and
 * My Vocabulary, AI usage for the budget, and the API keys. Survives restarts and extension updates.
 */
import { DEFAULT_SETTINGS, migrateSettings, type Settings, type VocabState, type WordStatus, type UsageRecord, type AiProviderId } from '@shared/settings';
import type { VocabEntry, VocabEntryInput } from '@shared/api';
import { mergeEntry } from './vocab';

/** YouTube-only choices (not in the Mac app). */
export interface YtExtras {
  /** the bar button: the Dream Tutor (your API key) is on */
  tutorOn: boolean;
  /** when YOU stop the video (pause button, Space, a click): explain the last part (lastSecondsWindow) */
  explainOnStop: boolean;
  /** hard-word stops also while ChatGPT / Claude (the website call) is on: the card shows, the word goes to the call */
  stopInCall: boolean;
  /** the Dream panel (song-lyrics lines) next to the video */
  panel: boolean;
  /** big Dream subtitles over the video: 'auto' = in full screen and theater mode */
  band: 'auto' | 'on' | 'off';
  /** hide YouTube's own captions while the Dream subtitles show (no double text) */
  hideYtCaptions: boolean;
  /** test only: a silent fake voice instead of the Mac voices */
  fakeVoice?: boolean;
}

export const DEFAULT_EXTRAS: YtExtras = { tutorOn: false, explainOnStop: true, stopInCall: false, panel: true, band: 'auto', hideYtCaptions: true };

export interface Keys { anthropic?: string; openai?: string }

const K = { settings: 'drSettings', extras: 'drExtras', vocab: 'drVocab', entries: 'drEntries', usage: 'drUsage', keys: 'drKeys' } as const;

type Area = chrome.storage.StorageArea;
const area = (): Area => chrome.storage.local;

/** Dream Read settings merged over the defaults (each section separately, so new defaults appear after an update). */
export function mergeSettings(stored: Partial<Settings> | undefined | null): Settings {
  const base = structuredClone(DEFAULT_SETTINGS) as Settings;
  const s = (stored ?? {}) as Record<string, unknown>;
  const out = base as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(s)) {
    const d = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && d && typeof d === 'object' && !Array.isArray(d)) out[k] = { ...(d as object), ...(v as object) };
    else if (v !== undefined) out[k] = v;
  }
  const merged = migrateSettings(out as unknown as Settings);
  // only the Mac voices (and the video itself) exist in Chrome; the Dream voice (Kokoro) needs the Mac app
  merged.voice = { ...merged.voice, engine: 'webspeech', explainEngine: null, voiceId: merged.voice.engine === 'webspeech' ? merged.voice.voiceId : '' };
  return merged;
}

export async function getSettings(): Promise<Settings> {
  const o = await area().get(K.settings);
  return mergeSettings(o[K.settings] as Partial<Settings>);
}
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next = { ...cur, ...patch } as Settings;
  await area().set({ [K.settings]: next });
  return next;
}
export async function getExtras(): Promise<YtExtras> {
  const o = await area().get(K.extras);
  return { ...DEFAULT_EXTRAS, ...(o[K.extras] as Partial<YtExtras> | undefined) };
}
export async function patchExtras(patch: Partial<YtExtras>): Promise<YtExtras> {
  const next = { ...(await getExtras()), ...patch };
  await area().set({ [K.extras]: next });
  return next;
}

export async function getVocab(): Promise<VocabState> {
  const o = await area().get(K.vocab);
  const v = o[K.vocab] as VocabState | undefined;
  return { words: { ...(v?.words ?? {}) }, marked: { ...(v?.marked ?? {}) } };
}
export async function setWordStatus(lemma: string, status: WordStatus | null): Promise<VocabState> {
  const v = await getVocab();
  if (status) v.words[lemma] = status; else delete v.words[lemma];
  await area().set({ [K.vocab]: v });
  // My Vocabulary follows: known / learning
  if (status === 'known' || status === 'learning') {
    const entries = await getEntries();
    if (entries[lemma] && entries[lemma].status !== status) { entries[lemma] = { ...entries[lemma], status }; await area().set({ [K.entries]: entries }); }
  }
  return v;
}

export async function getEntries(): Promise<Record<string, VocabEntry>> {
  const o = await area().get(K.entries);
  return { ...((o[K.entries] as Record<string, VocabEntry> | undefined) ?? {}) };
}
export async function upsertEntry(input: VocabEntryInput): Promise<VocabEntry> {
  const entries = await getEntries();
  const e = mergeEntry(entries[input.lemma] ?? null, input, new Date().toISOString());
  const v = await getVocab();
  if (v.words[input.lemma] === 'known') e.status = 'known';
  entries[input.lemma] = e;
  await area().set({ [K.entries]: entries });
  if (v.words[input.lemma] !== 'known') await setWordStatus(input.lemma, 'learning');
  return e;
}
export async function deleteEntry(lemma: string): Promise<void> {
  const entries = await getEntries();
  delete entries[lemma];
  await area().set({ [K.entries]: entries });
  await setWordStatus(lemma, null);
}

export async function getUsage(): Promise<UsageRecord[]> {
  const o = await area().get(K.usage);
  return (o[K.usage] as UsageRecord[] | undefined) ?? [];
}
export async function addUsage(r: UsageRecord): Promise<void> {
  const list = await getUsage();
  list.push(r);
  // keep about two months
  const cutoff = new Date(Date.now() - 62 * 86400_000).toISOString();
  await area().set({ [K.usage]: list.filter((x) => x.date >= cutoff) });
}
export function usdSince(list: UsageRecord[], sinceIso: string): number { return list.filter((r) => r.date >= sinceIso).reduce((n, r) => n + (r.usd || 0), 0); }
export function periodStarts(now = new Date()): { day: string; month: string } {
  return { day: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), month: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
}

export async function getKeys(): Promise<Keys> {
  const o = await area().get(K.keys);
  return { ...((o[K.keys] as Keys | undefined) ?? {}) };
}
export async function setKey(provider: AiProviderId, key: string): Promise<void> {
  const keys = await getKeys();
  const k = key.trim();
  if (k) keys[provider] = k; else delete keys[provider];
  await area().set({ [K.keys]: keys });
}

/** Subtitle hints of a video (Chinese meanings in context + AI phrases), cached so a video is only asked about once. */
export interface VideoHints { version: number; level: string; hints: Record<string, [string, string]>; phrases: Record<string, unknown[]> }
export const HINTS_VERSION = 1;
export async function getVideoHints(videoId: string): Promise<VideoHints | null> {
  const key = `drHints:${videoId}`;
  const o = await area().get(key);
  const h = o[key] as VideoHints | undefined;
  return h && h.version === HINTS_VERSION ? h : null;
}
export async function setVideoHints(videoId: string, h: VideoHints): Promise<void> { await area().set({ [`drHints:${videoId}`]: h }); }

export const STORAGE_KEYS = K;
