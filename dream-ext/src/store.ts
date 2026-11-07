/**
 * Everything the Dream Tutor keeps, in the extension's own storage (chrome.storage.local, unlimited): the
 * Dream Read settings (same shape and defaults as the Mac app), the YouTube extras, the word statuses and
 * My Vocabulary, AI usage for the budget, and the API keys. Survives restarts and extension updates.
 */
import { DEFAULT_SETTINGS, migrateSettings, type Settings, type VocabState, type WordStatus, type UsageRecord } from '@shared/settings';
import type { VocabEntry, VocabEntryInput } from '@shared/api';
import { mergeEntry } from './vocab';
import { DEFAULT_TEACHER, MY_TEACHER_STYLE, OLD_TEACHER } from './teacher-text';
import { TEACHING_WAYS, wayPrompts, wayStyle } from './teaching-ways';
import type { StyleOverride } from '@shared/styles';
import type { Dictionary } from '@core/dict/types';
import { EMPTY_META, SEED, SEED_VERSION, seedWords, testId, estimateLevel, type GroupScores, type LevelMeta, itemKey, type VocabularyDoc, itemId, type MergeResult } from './level-db';
import type { AiItem, TestGroups } from './level-check';

/** YouTube-only choices (not in the Mac app). */
export interface YtExtras {
  /** the bar button: the Dream Tutor (your API key) is on */
  tutorOn: boolean;
  /** when YOU stop the video (pause button, Space, a click): explain the last part (lastSecondsWindow) */
  explainOnStop: boolean;
  /** the Dream panel (song-lyrics lines) next to the video */
  panel: boolean;
  /** big Dream subtitles over the video: 'auto' = in full screen and theater mode */
  band: 'auto' | 'on' | 'off';
  /** hide YouTube's own captions while the Dream subtitles show (no double text) */
  hideYtCaptions: boolean;
  /** the tutor's voice: 'auto' = Microsoft when its key is saved, else OpenAI with its key, else the Mac voice */
  voice: VoiceChoice;
  /** Microsoft (Azure Speech) voice name, e.g. en-US-AvaMultilingualNeural */
  azureVoice: string;
  /** the region of the learner's Azure Speech resource, e.g. eastus */
  azureRegion: string;
  /** OpenAI voice (gpt-4o-mini-tts and the live call): marin, cedar, … */
  openaiVoice: string;
  /** ElevenLabs voice id */
  elevenVoice: string;
  /** ElevenLabs model: 'best' = Multilingual v2 (the most natural, about 2x the credits), 'fast' = Flash v2.5 */
  elevenQuality: 'best' | 'fast';
  /** after each explanation the talk opens (real time with an OpenAI key; else speech recognition + the tutor) */
  talkAfterExplain: boolean;
  /** quiet seconds in the talk before the video goes on by itself; 0 = wait for me ("go on", Enter or play) */
  talkSilenceSec: number;
  /** the talk is a live voice call (real time, needs an OpenAI key); off = speech recognition + the tutor's voice */
  liveOn: boolean;
  /** the OpenAI realtime model of the live talk */
  liveModel: string;
  /** the voice call: Claude + the tutor's voice (speech recognition, no OpenAI needed) or OpenAI realtime */
  callEngine: 'claude' | 'openai';
  /** microphone of the live talk: 1 normal, 2 sensitive, 3 very sensitive */
  micLevel: 1 | 2 | 3;
  /** 'listening' = Dream Read's page with all the subtitles over the whole screen; 'normal' = the video */
  /** … 'reading' = pages like an e-reader: the text does not move, a thin line follows the word, the pages turn by themselves */
  view: 'normal' | 'listening' | 'reading' | 'lyrics';
  /** a phone, Video mode: the subtitle line on the video, px (a little smaller than the pages) */
  phoneBandPx?: number;
  /** the letters thinner or bolder: 300 (thin) … 700 (bold), 400 = normal */
  textWeight?: number;
  /** one-button mode (Listening): the page is one big dark button that explains the last N seconds */
  oneButton?: boolean;
  /** an E button on every sentence (explain this sentence); on a phone a switch, off at first */
  sentenceButtons?: boolean;
  /** iPhone: talk through the Bluetooth headphones' own microphone (the sound is then phone-call quality) */
  headsetMic?: boolean;
  /** Reading pages: 'day' (light) or 'night' (dark) */
  readLook?: 'day' | 'night';
  /** text size of the reading pages, px (each mode has its own size) */
  readSizePx: number;
  /** (old) where the playing line stayed, % from the top: playLine replaced it */
  followAt: number;
  /** the play line: where the playing sentence stays on the page, 0 = the bottom of the page … 100 = the top */
  playLine: number;
  /** text size of the reading page on a phone, px (it never changes by itself) */
  phoneSizePx: number;
  /** show what the tutor says as text too (off: you only hear it) */
  showSay: boolean;
  /** Level Check stops for hard WORDS: on / off, and their share of the sentences in % */
  stopItemsOn: boolean;
  capWords: number;
  /** Level Check stops for PHRASES (idioms, slang, phrasal verbs): on / off, and their share in % */
  stopPhrasesOn: boolean;
  capPhrases: number;
  /** Level Check stops for whole sentences (hard grammar, hidden meaning): on / off, and their share in % */
  stopHardOn: boolean;
  capSentences: number;
  /** a word or phrase asked or explained is not asked again within this many words */
  repeatWords: number;
  /** explained this many times, a word is marked known and never stops again (0 = never by itself) */
  knownAfter: number;
  /** the phone's own first settings were made (see phoneDefaults) */
  phoneSet: boolean;
  /** the full-screen reading page at every stop */
  stageOn: boolean;
  /** when you pause: play the part (complete sentences) again on the reading page before the explanation */
  replayPart: boolean;
  /** text size on the reading page, px */
  stageSizePx: number;
  /** the AI's Chinese translation under each line of the reading page */
  zhLines: boolean;
  /** the AI finds the complete sentences in the subtitles first (cheap model, once per video) */
  aiSentences: boolean;
  /** stop after sentences the AI finds too hard for your level (played, explained, played again) */
  stopSentences: boolean;
  /** the learner's own words: how the teacher should teach (sent with every explanation and to the live talk) */
  teacher: string;
  /** keyboard shortcuts: action id -> key combination ("Shift+KeyE") */
  shortcuts: Record<string, string>;
  /** volume of the teacher's explanation, 0..100 (100 = as loud as the video when followVideoVolume) */
  teacherVolume: number;
  /** volume of the word / sentence being taught (said by the tutor's voice), 0..100 */
  wordVolume: number;
  /** the tutor's volume follows YouTube's volume slider (100 % = as loud as the video) */
  followVideoVolume: boolean;
  /** where the subtitles over the video sit: % of the player's height from its bottom edge */
  bandBottom: number;
  /** YouTube's own captions are always hidden while the tutor is on (not only while Dream subtitles show) */
  hideYtAlways: boolean;
  /** the video's width on the watch page, % of the page (0 = YouTube's own size) */
  videoSize: number;
  /** the microphone listens the whole time (voice commands like "hi bro") instead of only when the tutor waits for you */
  micAlways: boolean;
  /** voice mode: the microphone is on; "hello" explains / opens the call, "stop", "play", anything else is a question,
   *  "bye bye" turns it off */
  voiceMode: boolean;
  /** automatic stops: at most one every N seconds of video (0 = at every hard word, -1 = never by itself) */
  stopGapSec: number;
  /** one-time changes of saved settings already made (see migrateExtras) */
  migrated: number;
  /** my level follows my own words (up when I know most of the next level's words, down when I know few of mine) */
  levelAuto: boolean;
  /** ask "Level Check" before every video, book, PDF or text */
  levelAsk: boolean;
  /** stops by the Level Check rules: the hardest sentences; words and phrases have their share (capWords), whole sentences theirs (capSentences) */
  levelMode: boolean;
  /** with Level Check every video goes into Listening mode after its analysis */
  levelListening: boolean;
  /** the model of the one analysis ('' = the cheap one, Claude Haiku) */
  analysisModel: string;
  /** test only: a silent fake voice instead of the Mac voices */
  fakeVoice?: boolean;
}

export type VoiceChoice = 'auto' | 'mac' | 'openai' | 'elevenlabs' | 'azure';

export const DEFAULT_EXTRAS: YtExtras = {
  tutorOn: true, explainOnStop: true, panel: true, band: 'auto', hideYtCaptions: true,
  voice: 'auto', openaiVoice: 'marin', elevenVoice: 'JBFqnCBsd6RMkjVDRZzb', azureVoice: 'en-GB-AdaMultilingualNeural', azureRegion: 'eastus', talkAfterExplain: false, talkSilenceSec: 3, liveOn: true, liveModel: 'gpt-realtime-2.1', micLevel: 3, view: 'normal', followAt: 42, playLine: 40, phoneSizePx: 21, readSizePx: 22, showSay: false,
  stopItemsOn: true, capWords: 35, stopPhrasesOn: true, capPhrases: 15, stopHardOn: true, capSentences: 5, repeatWords: 1000, knownAfter: 7, phoneSet: false,
  stageOn: true, replayPart: true, stageSizePx: 34, zhLines: true, aiSentences: true, stopSentences: true, teacher: DEFAULT_TEACHER, shortcuts: {},
  teacherVolume: 60, wordVolume: 80, followVideoVolume: true, bandBottom: 7, hideYtAlways: false, videoSize: 0, stopGapSec: 45, callEngine: 'claude', micAlways: false, voiceMode: false, elevenQuality: 'best', migrated: 0, levelAuto: true, levelAsk: true, levelMode: true, levelListening: true, analysisModel: '',
};

/**
 * One-time changes to saved settings when the app learns better defaults:
 * 1 = after an explanation the video goes on by itself (no talk, no live call waiting); talk only when you ask (📞).
 * 2 = three stop groups (words, phrases, sentences: the old "words and phrases" share goes to both), known after 7
 *     explanations, no "stops by itself: off" left over (that row is gone), the learner's own teacher.
 */
export const EXTRAS_VERSION = 3;
export function migrateExtras(x: YtExtras): Partial<YtExtras> | null {
  if ((x.migrated ?? 0) >= EXTRAS_VERSION) return null;
  const p: Partial<YtExtras> = { migrated: EXTRAS_VERSION };
  if ((x.migrated ?? 0) < 1) p.talkAfterExplain = false;
  if ((x.migrated ?? 0) < 2) {
    if (x.stopPhrasesOn === undefined) { p.stopPhrasesOn = x.stopItemsOn !== false; p.capPhrases = Math.min(x.capWords ?? 15, 15); }
    if (x.knownAfter === undefined || x.knownAfter === 5) p.knownAfter = 7;
    if ((x.stopGapSec ?? 45) < 0) p.stopGapSec = 45;
    if (x.teacher === OLD_TEACHER) p.teacher = DEFAULT_TEACHER;
  }
  return p;
}

/** The first settings of a phone (once): a book of subtitles only, your voice is enough, "Explain 20 s", no word test. */
export function phoneDefaults(x: YtExtras): Partial<YtExtras> | null {
  // (the word test before every video is off: Settings turns it on)
  return x.phoneSet ? null : { phoneSet: true, zhLines: false, voiceMode: true, view: 'listening', levelAsk: false };
}

/** github: a token with only "Gists: read and write" (the online vocabulary); genius: not used yet */
export interface Keys { anthropic?: string; openai?: string; elevenlabs?: string; azure?: string; github?: string; genius?: string }
export type KeyName = keyof Keys;

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
  // YouTube: "My Custom Style" starts as the learner's own teacher rules (until they edit it)
  const storedStyles = (s.ai as { styles?: Record<string, unknown> } | undefined)?.styles;
  if (!storedStyles || !storedStyles.custom) merged.ai = { ...merged.ai, styles: { ...merged.ai.styles, custom: MY_TEACHER_STYLE } };
  // the seven teaching ways, in the learner's level (beginner A1–A2, intermediate B1 and up); a prompt the learner
  // edited is kept (a saved copy of a default prompt is not an edit, so a new level still changes it)
  const ways: Record<string, StyleOverride> = {};
  for (const w of TEACHING_WAYS) {
    const mine = storedStyles?.[w.id] as StyleOverride | undefined;
    const base = wayStyle(w, merged.learnerLevel);
    const defaults = [wayPrompts(w, 'A2'), wayPrompts(w, 'B2')];
    const word = mine?.wordPrompt && !defaults.some((d) => d.wordPrompt === mine.wordPrompt) ? { wordPrompt: mine.wordPrompt } : {};
    const sentence = mine?.sentencePrompt && !defaults.some((d) => d.sentencePrompt === mine.sentencePrompt) ? { sentencePrompt: mine.sentencePrompt } : {};
    ways[w.id] = { ...base, ...word, ...sentence, shape: { ...base.shape!, ...(mine?.shape ?? {}) } };
  }
  merged.ai = { ...merged.ai, styles: { ...merged.ai.styles, ...ways } };
  // only the Mac voices (and the video itself) exist in Chrome; the Dream voice (Kokoro) needs the Mac app
  merged.voice = { ...merged.voice, engine: 'webspeech', explainEngine: null, voiceId: merged.voice.engine === 'webspeech' ? merged.voice.voiceId : '' };
  return merged;
}

export async function getSettings(): Promise<Settings> {
  const o = await area().get(K.settings);
  return mergeSettings(o[K.settings] as Partial<Settings>);
}
/** changes are saved one after the other: two at the same moment would otherwise overwrite each other */
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}
export function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  return oneAtATime(async () => {
    const cur = await getSettings();
    const next = { ...cur, ...patch } as Settings;
    await area().set({ [K.settings]: next });
    return next;
  });
}
/** the extras as saved (no defaults mixed in): for the one-time changes, which look at what is missing */
export async function getRawExtras(): Promise<Partial<YtExtras>> {
  const o = await area().get(K.extras);
  return { ...((o[K.extras] as Partial<YtExtras> | undefined) ?? {}) };
}
export async function getExtras(): Promise<YtExtras> {
  const o = await area().get(K.extras);
  return { ...DEFAULT_EXTRAS, ...(o[K.extras] as Partial<YtExtras> | undefined) };
}
/** a change made on the settings as they are at that moment (inside the queue) */
export function updateSettings(fn: (cur: Settings) => Partial<Settings>): Promise<Settings> {
  return oneAtATime(async () => {
    const cur = await getSettings();
    const next = { ...cur, ...fn(cur) } as Settings;
    await area().set({ [K.settings]: next });
    return next;
  });
}
export function patchExtras(patch: Partial<YtExtras>): Promise<YtExtras> {
  return oneAtATime(async () => {
    const next = { ...(await getExtras()), ...patch };
    await area().set({ [K.extras]: next });
    return next;
  });
}

export async function getVocab(): Promise<VocabState> {
  const o = await area().get(K.vocab);
  const v = o[K.vocab] as VocabState | undefined;
  return { words: { ...(v?.words ?? {}) }, marked: { ...(v?.marked ?? {}) } };
}
/**
 * The vocabulary is saved as one object: every change reads it, changes it and writes it back. Changes made at the
 * same moment (a stop marks its words, "I know" marks one known) go one after the other, so none is lost.
 */
let vocabWrites: Promise<unknown> = Promise.resolve();
function oneVocabWrite<T>(fn: () => Promise<T>): Promise<T> {
  const p = vocabWrites.then(fn, fn);
  vocabWrites = p.catch(() => undefined);
  return p;
}
export function setWordStatus(lemma: string, status: WordStatus | null, met?: { word?: string; sentence?: string }): Promise<VocabState> {
  return oneVocabWrite(() => setWordStatusNow(lemma, status, met));
}
async function setWordStatusNow(lemma: string, status: WordStatus | null, met?: { word?: string; sentence?: string }): Promise<VocabState> {
  const v = await getVocab();
  const changed = v.words[lemma] !== (status ?? undefined);
  if (status) v.words[lemma] = status; else delete v.words[lemma];
  await area().set({ [K.vocab]: v });
  // the database: when it got this status, and where it was met
  if (changed || met) await logWord(lemma, status, met);
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
export function upsertEntry(input: VocabEntryInput): Promise<VocabEntry> {
  return oneVocabWrite(() => upsertEntryNow(input));
}
async function upsertEntryNow(input: VocabEntryInput): Promise<VocabEntry> {
  const entries = await getEntries();
  const e = mergeEntry(entries[input.lemma] ?? null, input, new Date().toISOString());
  const v = await getVocab();
  if (v.words[input.lemma] === 'known') e.status = 'known';
  entries[input.lemma] = e;
  await area().set({ [K.entries]: entries });
  if (v.words[input.lemma] !== 'known') await setWordStatusNow(input.lemma, 'learning');
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
// ---- memory of each video: where the learner stopped, and the stops already explained ------------------------------
export interface VideoSpot { t: number; d: number; at: number }
const SPOTS = 'drSpots', DONE = 'drDone';
/** keeps the newest `max` entries of an object of { at } values */
function newest<T extends { at: number }>(all: Record<string, T>, max: number): Record<string, T> {
  const keys = Object.keys(all);
  if (keys.length <= max) return all;
  const out = { ...all };
  for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - max)) delete out[k];
  return out;
}
export async function getSpot(videoId: string): Promise<VideoSpot | null> {
  const o = await area().get(SPOTS);
  return ((o[SPOTS] as Record<string, VideoSpot> | undefined) ?? {})[videoId] ?? null;
}
/** where the learner is in a video (the last 300 videos are kept) */
export function setSpot(videoId: string, spot: VideoSpot): Promise<void> {
  return oneAtATime(async () => {
    const o = await area().get(SPOTS);
    await area().set({ [SPOTS]: newest({ ...((o[SPOTS] as Record<string, VideoSpot> | undefined) ?? {}), [videoId]: spot }, 300) });
  });
}
interface DoneList { keys: string[]; at: number }
/** the sentences of a video whose stop (a hard phrase or sentence) was already explained */
export async function getDone(videoId: string): Promise<string[]> {
  const o = await area().get(DONE);
  return ((o[DONE] as Record<string, DoneList> | undefined) ?? {})[videoId]?.keys ?? [];
}
export function addDone(videoId: string, key: string): Promise<void> {
  return oneAtATime(async () => {
    const o = await area().get(DONE);
    const all = (o[DONE] as Record<string, DoneList> | undefined) ?? {};
    const keys = all[videoId]?.keys ?? [];
    if (keys.includes(key)) return;
    await area().set({ [DONE]: newest({ ...all, [videoId]: { keys: [...keys, key].slice(-800), at: Date.now() } }, 200) });
  });
}
/** a video is "where you stopped" when it is well started and not finished */
export function resumeAt(spot: VideoSpot | null, now: number, duration: number): number | null {
  if (!spot || !(spot.t > 30)) return null;
  const d = duration > 0 ? duration : spot.d;
  if (d > 0 && spot.t > d - 30) return null; // finished (or nearly): from the start
  if (now - spot.at > 60 * 86400_000) return null; // two months ago: forgotten
  return Math.max(0, spot.t - 3);
}

/** Microsoft's free plan: 500,000 characters a month */
export const AZURE_FREE_CHARS = 500_000;
/** characters the Microsoft voice made since then (each request counts, also the ones made ahead) */
export function azureCharsSince(list: UsageRecord[], sinceIso: string): number { return list.filter((r) => r.date >= sinceIso && r.model === 'azure-neural').reduce((n, r) => n + (r.inputTokens || 0), 0); }
/** "Microsoft this month: 47,312 of 500,000 free characters (9%) · about 8.4 hours left" */
export function azureUsageText(used: number): { text: string; low: boolean } {
  const left = Math.max(0, AZURE_FREE_CHARS - used);
  const pct = Math.min(100, Math.round((used / AZURE_FREE_CHARS) * 100));
  const hours = left / 54_000; // about 54,000 characters = 1 hour of the tutor talking
  const leftText = left === 0 ? 'nothing left: the Microsoft voice stops until next month' : `about ${hours >= 1 ? `${hours.toFixed(1)} hours` : `${Math.round(hours * 60)} minutes`} of talking left`;
  return { text: `Microsoft this month: ${used.toLocaleString('en-US')} of ${AZURE_FREE_CHARS.toLocaleString('en-US')} free characters used (${pct}%) · ${leftText}`, low: pct >= 80 };
}
export function usdSince(list: UsageRecord[], sinceIso: string): number { return list.filter((r) => r.date >= sinceIso).reduce((n, r) => n + (r.usd || 0), 0); }
export function periodStarts(now = new Date()): { day: string; month: string } {
  return { day: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), month: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
}

export async function getKeys(): Promise<Keys> {
  const o = await area().get(K.keys);
  return { ...((o[K.keys] as Keys | undefined) ?? {}) };
}
/** "East US", "eastus" or an endpoint like https://eastus.api.cognitive.microsoft.com/ -> eastus */
export function azureRegionOf(input: string): string {
  const t = input.trim().toLowerCase();
  const host = /^https?:\/\/([^./]+)\./.exec(t);
  return (host ? host[1] : t).replace(/[^a-z0-9]/g, '');
}

export async function setKey(provider: KeyName, key: string): Promise<void> {
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

// ---- the vocabulary database (level-db.ts): the tests, the level, when each word got its status --------------------
export const LEVEL_KEY = 'drLevel';
export const DB_STATUS_KEY = 'drDbStatus';
export interface DbStatus {
  ok: boolean; at: string; path?: string; error?: string;
  /** the Mac: the Google Drive and iCloud Drive copies */
  drive?: string | null; driveOk?: boolean; driveError?: string; icloud?: string | null; icloudOk?: boolean; icloudError?: string;
  /** the phone (YT Learn): the folder you chose in the Files app, shared with the Mac */
  phone?: boolean; shared?: boolean; sharedOk?: boolean; sharedError?: string; folder?: string;
  /** how many words came in from the other device's copy this time */
  merged?: number;
  notInstalled?: boolean; noDevice?: boolean; safari?: boolean;
  /** the helper on the Mac is an older one: it writes the file but cannot read the iPhone's words back */
  oldHelper?: boolean;
  /** the online copy (a private GitHub gist): on, saved, its error, how many words came in from it */
  gist?: boolean; gistOk?: boolean; gistError?: string; gistMerged?: number; gistAt?: string;
}

export async function getLevel(): Promise<LevelMeta> {
  const o = await area().get(LEVEL_KEY);
  return { ...EMPTY_META, ...(o[LEVEL_KEY] as Partial<LevelMeta> | undefined) };
}
export function updateLevel(fn: (cur: LevelMeta) => LevelMeta): Promise<LevelMeta> {
  return oneAtATime(async () => {
    const next = fn(await getLevel());
    await area().set({ [LEVEL_KEY]: next });
    return next;
  });
}
function logWord(lemma: string, status: WordStatus | null, met?: { word?: string; sentence?: string }): Promise<LevelMeta> {
  return updateLevel((m) => {
    const log = { ...m.log };
    if (!status) delete log[lemma];
    else log[lemma] = { ...log[lemma], word: met?.word || log[lemma]?.word || lemma, date: new Date().toISOString().slice(0, 10), ...(met?.sentence ? { sentence: met.sentence } : {}) };
    return { ...m, log };
  });
}

/** the last copy of the vocabulary merged with the shared file (level-db-bg.ts) */
export const DB_BASE_KEY = 'drDbBase';

/**
 * The learner's starting data goes in once per version of it (the app's own word list grew: an install that has the
 * older one gets the new words). Only words the device does not have go in: a word it knows, ignores or is still
 * learning keeps its status. On an update a word that was taken out (on this device or the other one, since the
 * shared file began) does not come back.
 */
export function ensureSeeded(dict: Pick<Dictionary, 'lemmaOf'>): Promise<boolean> {
  // (in the line of the other vocabulary writes: a stop that marks a word at the same moment is not lost)
  return oneVocabWrite(async () => {
    const before = (await getLevel()).seeded;
    if (before >= SEED_VERSION) return false;
    const seed = seedWords(dict);
    const v = await getVocab();
    // (an update: the words this device or the other one took out since the shared file began stay out; they are
    // in the last merged copy, or in its list of words taken out, and no longer here)
    // (by the way the item is written and by its vocabulary key: "squandered" taken out is "squander" in the list)
    const out = new Set<string>(), outKeys = new Set<string>();
    if (before) {
      const b = (await area().get(DB_BASE_KEY))[DB_BASE_KEY] as VocabularyDoc | undefined;
      for (const r of [...(b?.removed ?? []), ...(b?.known ?? []), ...(b?.stillLearning ?? [])]) if (r && typeof r.item === 'string') { out.add(itemId(r.item)); outKeys.add(itemKey(dict, r.item)); }
    }
    // only words this device does not have: a word it knows, ignores or is still learning keeps its status
    const added: string[] = [];
    for (const [k, st] of Object.entries(seed.words)) {
      if (v.words[k] || outKeys.has(k) || out.has(itemId(seed.log[k]?.word ?? k))) continue;
      v.words[k] = st;
      added.push(k);
    }
    await area().set({ [K.vocab]: v });
    const seedLog: LevelMeta['log'] = {};
    for (const k of added) if (seed.log[k]) seedLog[k] = seed.log[k];
    await updateLevel((m) => {
      // (a test the device already has, from an earlier starting data, is not there twice)
      const have = new Set(m.tests.map(testId));
      return { ...m, tests: [...SEED.tests.filter((t) => !have.has(testId(t))), ...m.tests], currentLevel: m.currentLevel || SEED.currentLevel, log: { ...seedLog, ...m.log }, seeded: SEED_VERSION };
    });
    // (only the very first time: a level the learner chose since is theirs)
    if (!before) await patchSettings({ learnerLevel: 'B2' });
    return true;
  });
}

/** every word of this device by the way it is written in the document (buildDoc's `item`): its vocabulary key */
export function itemKeys(words: Record<string, WordStatus>, meta: LevelMeta, entries: Record<string, VocabEntry>): Map<string, string> {
  const out = new Map<string, string>();
  for (const lemma of Object.keys(words)) {
    if (lemma.startsWith('sentence: ')) continue;
    const id = itemId(meta.log[lemma]?.word || entries[lemma]?.word || lemma);
    if (!out.has(id)) out.set(id, lemma);
  }
  return out;
}

/**
 * What the merge with the other device's copy changes here (mergeDocs): a status for a word, or the word taken out;
 * the tests and the level of the merged document. A word ignored on this device stays ignored. Nothing else is
 * touched, and nothing is written when nothing changes. Returns how many words changed.
 */
export async function applyDoc(merged: MergeResult, dict: Pick<Dictionary, 'lemmaOf'>): Promise<number> {
  const { doc, changes } = merged;
  const [v, meta, entries] = await Promise.all([getVocab(), getLevel(), getEntries()]);
  const keys = itemKeys(v.words, meta, entries);
  let changed = 0, filled = 0, entriesChanged = false;
  const log: LevelMeta['log'] = {};
  const gone: string[] = [];
  for (const c of changes) {
    const key = keys.get(itemId(c.item)) ?? itemKey(dict, c.item);
    const cur = v.words[key];
    if (!key || cur === 'ignored') continue;
    if (c.status === null) {
      if (cur !== 'known' && cur !== 'learning') continue;
      delete v.words[key];
      gone.push(key);
      if (entries[key]) { delete entries[key]; entriesChanged = true; }
      changed++;
      continue;
    }
    // (a sentence for a word with the same status: never a status change, also when the item maps to another word here)
    if (c.fill && cur !== c.status) continue;
    if (cur === c.status) {
      // (the same status: only an example sentence or a level group this device did not have comes in)
      const l = meta.log[key];
      if ((c.sentence && !l?.sentence) || (c.group && !l?.group)) {
        log[key] = { ...(l ?? { word: c.item, date: c.date || new Date().toISOString().slice(0, 10) }), ...(c.sentence && !l?.sentence ? { sentence: c.sentence } : {}), ...(c.group && !l?.group ? { group: c.group } : {}) };
        filled++;
      }
      continue;
    }
    v.words[key] = c.status;
    changed++;
    log[key] = { word: c.item, date: c.date || new Date().toISOString().slice(0, 10), ...(c.sentence ? { sentence: c.sentence } : {}), ...(c.group ? { group: c.group } : {}) };
    if (entries[key] && entries[key].status !== c.status) { entries[key] = { ...entries[key], status: c.status }; entriesChanged = true; }
  }
  if (changed) await area().set({ [K.vocab]: v });
  if (entriesChanged) await area().set({ [K.entries]: entries });
  const testsDiffer = JSON.stringify(meta.tests) !== JSON.stringify(doc.tests) || (!!doc.currentLevel && doc.currentLevel !== meta.currentLevel);
  if (changed || filled || testsDiffer) {
    await updateLevel((m) => {
      const all = { ...m.log, ...log };
      for (const k of gone) delete all[k];
      // (every test of both, once: a test saved here meanwhile is never lost)
      const tests = [...m.tests];
      const have = new Set(tests.map(testId));
      for (const t of doc.tests) if (!have.has(testId(t))) { tests.push(t); have.add(testId(t)); }
      tests.sort((a, b) => a.date.localeCompare(b.date));
      return { ...m, tests, currentLevel: doc.currentLevel || m.currentLevel, log: all };
    });
  }
  return changed;
}

/** The tap test is done: tapped = known, the others = still learning (with their sentence); the test and the level saved. */
export async function saveTestResult(shown: TestGroups, knownKeys: ReadonlySet<string>, source: string, scores: GroupScores): Promise<ReturnType<typeof estimateLevel>> {
  const est = estimateLevel(scores);
  const today = new Date().toISOString().slice(0, 10);
  const v = await getVocab();
  const log: LevelMeta['log'] = {};
  for (const group of ['b2', 'c1', 'c2'] as const) for (const it of shown[group]) {
    const known = knownKeys.has(it.key);
    v.words[it.key] = known ? 'known' : 'learning';
    log[it.key] = { word: it.text, date: today, group, ...(known ? {} : { sentence: it.sentence }) };
  }
  await area().set({ [K.vocab]: v });
  await updateLevel((m) => ({ ...m, tests: [...m.tests, { date: today, source, scores, level: est.label }], currentLevel: `about ${est.label}`, log: { ...m.log, ...log } }));
  await patchSettings({ learnerLevel: est.cefr });
  return est;
}

/** the AI's idioms and slang of a text, kept with the text (so its test opens at once next time) */
export async function getLevelItems(id: string): Promise<AiItem[] | null> {
  const k = `drLevelItems:${id}`;
  return ((await area().get(k))[k] as AiItem[] | undefined) ?? null;
}
/** the explanations of a video, written once by the AI (level-analysis.ts): sentence -> explanation */
export async function getAnalysis(id: string): Promise<Record<string, string>> {
  const k = `drAnalysis:${id}`;
  return ((await area().get(k))[k] as Record<string, string> | undefined) ?? {};
}
export async function setAnalysis(id: string, texts: Record<string, string>): Promise<void> {
  await area().set({ [`drAnalysis:${id}`]: texts });
  await remember('drAnalysis', id, 30);
}
export async function setLevelItems(id: string, items: AiItem[]): Promise<void> {
  await area().set({ [`drLevelItems:${id}`]: items });
  await remember('drLevelItems', id);
}

/** Per-video caches (the AI's complete sentences, the Chinese lines); the oldest are removed after 80 videos. */
/** "Find me a video": a video's level, worked out once from its subtitles (the newest 400 kept) */
export async function getVideoLevel<T>(videoId: string): Promise<T | null> {
  const o = await area().get(`drVLevel:${videoId}`);
  return (o[`drVLevel:${videoId}`] as T | undefined) ?? null;
}
export async function setVideoLevel(videoId: string, level: unknown): Promise<void> {
  await area().set({ [`drVLevel:${videoId}`]: level });
  await remember('drVLevel', videoId, 400);
}

async function remember(prefix: string, videoId: string, keep = 80): Promise<void> {
  const idxKey = `${prefix}Index`;
  const o = await area().get(idxKey);
  const list = ((o[idxKey] as string[] | undefined) ?? []).filter((x) => x !== videoId);
  list.push(videoId);
  const drop = list.splice(0, Math.max(0, list.length - keep));
  await area().set({ [idxKey]: list });
  if (drop.length) await area().remove(drop.map((id) => `${prefix}:${id}`));
}

/** The AI's sentence split of a video: where each sentence ends (word number) and its punctuated text. */
export interface VideoSplit { version: number; words: number; ends: number[]; texts: string[] }
export async function getSplit(videoId: string, version: number): Promise<VideoSplit | null> {
  const k = `drSent:${videoId}`;
  const v = (await area().get(k))[k] as VideoSplit | undefined;
  return v && v.version === version ? v : null;
}
export async function setSplit(videoId: string, v: VideoSplit): Promise<void> { await area().set({ [`drSent:${videoId}`]: v }); await remember('drSent', videoId); }

/** Chinese translation of each sentence of a video (by its text, so a new split keeps what still fits). */
/** lyrics mode: what the tutor said about a song before it played (summary, background, how people read it) */
export async function getSong(id: string): Promise<string | null> {
  const k = `drSong:${id}`;
  return ((await area().get(k))[k] as string | undefined) ?? null;
}
export async function setSong(id: string, notes: string): Promise<void> { await area().set({ [`drSong:${id}`]: notes }); await remember('drSong', id, 60); }

export async function getZh(videoId: string): Promise<Record<string, string>> {
  const k = `drZh:${videoId}`;
  return { ...(((await area().get(k))[k] as Record<string, string> | undefined) ?? {}) };
}
export async function setZh(videoId: string, zh: Record<string, string>): Promise<void> { await area().set({ [`drZh:${videoId}`]: zh }); await remember('drZh', videoId); }
