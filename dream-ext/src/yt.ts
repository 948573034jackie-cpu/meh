/**
 * Dream Tutor on YouTube (content script, runs after lib.js and youtube.js in the same isolated world).
 *
 * Two ways to learn with a video, never both at once (one voice at a time):
 *  - "My tutor" (your own API key): Dream Read's listening teacher reads the video. The AI first rebuilds the
 *    subtitles into complete sentences and marks what is hard for your level (words, phrases, whole sentences).
 *    The video stops right after each of them; the reading page shows the last 30 seconds over the whole screen,
 *    the card shows the word, it is said 3 times, a commands window opens (I know / I don't know / Go on; nothing
 *    said there goes to the AI), the teacher explains with your own rules in a natural voice (OpenAI), the word
 *    is said again and the sentence plays from the video; then you can talk to the tutor in a live voice call
 *    (real time) until you say "go on", and the video goes back to the start of the sentence.
 *    You pause: the part (complete sentences) plays again on the page, the teacher breaks it down, you talk, and
 *    the video goes back to the start of the part. ← explains the last sentence (play, explain, play).
 *    Listening mode = Dream Read's page with all the subtitles over the whole screen; normal mode = the video.
 *  - "ChatGPT" / "Claude" (the website call, youtube.js): unchanged. The Dream panel still shows the subtitles
 *    with hard words highlighted and their Chinese meaning; tapping a word opens its card and can send it to the
 *    call. Stops at hard words in the call are an option (silent card, the word goes to the call).
 */
import css from './dream.css';
import type { Book, Position, CefrLevel } from '@core/model';
import { sentenceKey } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { Settings, VocabState, WordStatus, MarkedRange } from '@shared/settings';
import type { PhraseHit, ExplainRequest } from '@shared/api';
import { Playback, type PlaybackState } from '@core/listen/playback';
import { ListenController, type TranscriptEntry, type CommandWindow, type ChapterPhrase } from '@core/listen/controller';
import { getEngine, useFakeEngine, defaultVoiceFor, chineseVoiceId } from '@core/tts/registry';
import type { TtsEngine } from '@core/tts/engine';
import { getSentence, nextPosition, prevPosition, comparePositions, contextAround, wordOffsets } from '@core/nav';
import { StreamSentenceSplitter } from '@core/listen/sentences';
import { cleanSpokenProse } from '@core/ai/prompts';
import { detectNames } from '@core/dict/names';
import { parseGloss, looksLikeFreeCombination } from '@core/dict/dictionary';
import { detectCommand } from '@core/voice/commands';
import { collectHardWords, batchHardWords, buildHintsPrompt, parseHints, chunkChapter, phraseQuota, buildPhrasesPrompt, parsePhrases, validatePhrases, mapPhraseHits, chapterText, type HintMap } from '@core/ai/hints';
import { renderChapter, renderSentence, restyleLemma } from '../vendor/renderer/render';
import { hintText } from '../vendor/renderer/hints';
import { buildVideoBook, type VideoBook, type TimedSentence } from './video-book';
import type { Lyrics } from './lyrics';
import { lyricsNote } from './lyrics';
import { findSongLyrics, usePastedLyrics, lyricSentences } from './lyrics-find';
import { openPasteBox } from './lyrics-paste';
import { decorateLyricsPage } from './lyrics-page';
import { askSongNotes, loadSongNotes, saveSongNotes, dropSongNotes, songContext, notesByLine, noteIsEnough, type SongNotes } from './lyrics-notes';
import { VideoEngine } from './video-engine';
import { openFinder, finderIsOpen, type FoundVideo, type FinderLevel } from './finder';
import { partRange } from './part';
import { HeardCounter } from './heard';
import { chunkWords, lettersPerLine } from './subtitle-chunks';
import { dailyReview, reviewDue, reviewText, dayKey, REVIEW_KEY } from './review';
import { installFinderPlaylist, finderNext, finderPrev, learnerLevelOf } from './finder-list';
import { explain as aiExplain, complete, completeStream, getDictionary, getDictData, getZipf, gunzipVia } from './ai-client';
import * as store from './store';
import { clock, computeProgress, estimateKnown, suggestLevel, levelNote } from './vocab';
import { voiceStats } from '@core/tts/audio';
import { cloudEngine, resolveVoice, azureZhVoice, isMultilingual, QuotesFromVideo, VoiceWithBackup, SentenceFromVideo, ShortPieces, WithVolume, sliderGain, LIVE_VOICES, cloudSpoken } from './voice';
import { LiveCall, liveInstructions } from './live';
import { ChatCall } from './chat-call';
import { splitWithAi, flatten, regroup, SPLIT_VERSION, splitReport } from './sentences-ai';
import { buildLinesPrompt, parseLines, buildWordPrompt, parseWordMeanings } from './zh';
import { buildHardSentencesPrompt, parseHardSentences, HARD_PER_SECONDS } from './hard-sentences';
import { actionFor, comboLabel, shortcutMap, SHORTCUTS, type ShortcutAction } from './shortcuts';
import { renderQuick } from './quick';
import { unknownChance, phraseSig, EMPTY_META, type LevelMeta } from './level-db';
import { buildItemsPrompt, parseItems, collectItems, pickForScreen, type TestGroups } from './level-check';
import { scoreSentences, selectStopsByLevel, keepHardest, stopKindOf, kindWith, counterText, type SentenceScore, type StopCaps, type StopGroup } from './level-stops';
import { myLevelOf, wordNumber, phraseDifficulty, harderThan, levelToCefr, clampLevel, CEFR_MID, cefrToLevel, belowLevel, clampPct, DEFAULT_EXPLAIN_PCT } from './level100';
import { RuleGuard, type LevelRule, type RuleRequest } from './level-rule';
import type { TeachLength } from './teacher-text';
import { LevelGate } from './level-gate';
import { Analysis, stopId, type AnalysisStop } from './level-analysis';

interface YtcInfo {
  title: string; channel?: string; url: string; cues: unknown[]; errors: string[]; source: string | null;
  /** good English subtitles made by people: used as they are (no AI complete sentences) */
  human?: boolean;
}
interface YtcApi {
  loadTranscript(): Promise<YtcInfo>;
  video(): HTMLVideoElement | null;
  videoId(): string | null;
  isAd(): boolean;
  /** voiceOn: the browser can hear you (speech recognition) */
  settings(): { voiceOn: boolean };
  /** o.human: subtitles made by people (a long sentence stays whole) */
  buildSentences(cues: unknown[], o?: { human?: boolean }): TimedSentence[];
  setBarStatus(text: string, bad?: boolean): void;
  /** the browser refused the microphone */
  micBlocked?(): boolean;
  /** when the microphone last went on or off (ms; a phone may stop the video's sound for a moment then) */
  micChangedAt?(): number;
  micState?(): { listening: boolean; blocked: boolean; lastError: string; failsInARow: number };
  /** 🩺 Check: shows the report over the page */
  showReport?(): void;
  /** the microphone closes what it is hearing now (it comes as final) and listens again */
  finishSpeech?(): void;
  /** "Find me a video": YouTube search on this page, and any video's subtitles */
  searchVideos?(q: string): Promise<FoundVideo[]>;
  cuesFor?(id: string): Promise<unknown[]>;
}
interface DreamHook {
  /** the Dream Tutor handles the video now: youtube.js leaves pauses, plays and voice commands alone */
  owns(): boolean;
  /** the tutor wants the microphone now (it waits for an answer or a talk is open) */
  wantsMic?(): boolean;
  /** how easily the microphone hears you: 1 low, 2 mid, 3 high (the iPhone app's listener) */
  micLevel?(): number;
  headsetMic?(): boolean;
  /** a voice call is open: youtube.js keeps the microphone on, even with voice commands off */
  callOpen?(): boolean;
  /** something the microphone heard; true = handled here */
  heard(text: string, final: boolean, key?: string): boolean;
  /** youtube.js built its bar: add the Tutor button */
  decorateBar(bar: HTMLElement): void;
  /** ChatGPT or Claude was turned on in youtube.js: the tutor goes off */
  /** for the 🩺 check */
  diag(): Record<string, unknown> | null;
  /** the video's subtitles changed (a subtitle file was loaded): the tutor reads the video again */
  reload?(): void;
  /** a button of the iPhone app's bar: a shortcut id (`stop`, `explainLast`, …) or `voiceMode`, `pageAuto`, `vocab`, `quick` */
  action?(id: string): boolean;
}
declare global { interface Window { __ytcApi?: YtcApi; __ytcDream?: DreamHook; __drDebug?: unknown } }
/** the parts of Chrome's SpeechRecognition the 🎤 button uses */
interface SpeechRecognitionLike {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  onresult: ((e: { results: { length: number; [i: number]: { 0: { transcript: string }; isFinal: boolean } } }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
}

const GREEN = '#1e8e3e', RED = '#d93025';
const E2E = () => !!extras.fakeVoice;
const HINTS_VERSION = 4; // 4: every hard sentence and phrase above the level (not a few per minute)

let settings: Settings;
let extras: store.YtExtras = { ...store.DEFAULT_EXTRAS };
let vocab: VocabState = { words: {}, marked: {} };
let levelMeta: LevelMeta = { ...EMPTY_META };
let session: Session | null = null;
let tutorBtn: HTMLButtonElement | null = null;

// ---------------------------------------------------------------------------------------------------------------
// page-level style: the panel takes the place of the related videos; YouTube's own captions hide under the band
// ---------------------------------------------------------------------------------------------------------------
function pageStyle(): void {
  if (document.getElementById('dr-page-style')) return;
  const st = document.createElement('style');
  st.id = 'dr-page-style';
  st.textContent = `
    html.dr-panel #secondary > :not(#dr-panel-host), html.dr-panel #secondary-inner { display: none !important; }
    #dr-panel-host { display: block; position: sticky; top: 68px; height: calc(100vh - 84px); min-height: 360px; margin: 0 0 12px; z-index: 5; }
    html.dr-panel-under #dr-panel-host { position: relative; top: auto; height: 62vh; min-height: 300px; margin: 6px 8px 12px; }
    html.dr-band.dr-hide-cc .ytp-caption-window-container, html.dr-stage.dr-hide-cc .ytp-caption-window-container { display: none !important; }
    #dr-band-host { position: absolute; inset: 0; pointer-events: none; z-index: 61; }
    #dr-stage-host { position: fixed; inset: 0; z-index: 2147482000; }
    :fullscreen #dr-stage-host { position: absolute; }
    #dr-stage-host[hidden] { display: none !important; }
    /* (Safari on a phone: the tutor's own bar is at the bottom of the screen; the page ends above it) */
    html.yt2c-tutor-bar #dr-stage-host { bottom: var(--yt2c-bar-h, 0px); }
    html.dr-hide-cc-always .ytp-caption-window-container { display: none !important; }
    /* (a phone, "Subtitles off": no subtitles at all on the video, YouTube's own captions hidden too) */
    html.dr-cc-off.dr-hide-cc .ytp-caption-window-container { display: none !important; }
    /* (the full stop card: nothing over it, not even the small counter) */
    html.dr-fullcard #dr-stop-counter { display: none !important; }
    /* ---- the app, full screen (the phone turned, YouTube's full-screen button, the "Full screen" button): the video
       over the whole window, with the tutor's subtitles, card and page over it (never Apple's own player) ---- */
    html.dr-full, html.dr-full body { overflow: hidden !important; }
    html.dr-full :is(#player-container-id, ytm-player, .player-container) { position: fixed !important; inset: 0 !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; height: 100dvh !important; max-height: none !important; margin: 0 !important; padding: 0 !important; z-index: 2147481000 !important; background: #000 !important; transform: none !important; }
    html.dr-full :is(#player, #movie_player, .html5-video-player, .html5-video-container, video.html5-main-video) { width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; max-height: none !important; }
    html.dr-full video.html5-main-video { object-fit: contain !important; }
    html.dr-full :is(ytm-mobile-topbar-renderer, header.mobile-topbar-header, ytm-pivot-bar-renderer) { display: none !important; }
    html.dr-full #movie_player { touch-action: manipulation; }
    /* ---- an iPad, Video mode, the page on the screen: the video beside the page (on its side) or over it (upright) ---- */
    html.dr-split-r :is(#player-container-id, ytm-player, .player-container) { position: fixed !important; left: 0 !important; top: 0 !important; width: 58vw !important; height: calc(58vw * 9 / 16) !important; max-height: 100vh !important; z-index: 2147481000 !important; background: #000 !important; margin: 0 !important; }
    html.dr-split-r #dr-stage-host { left: 58vw !important; }
    html.dr-split-b :is(#player-container-id, ytm-player, .player-container) { position: fixed !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: calc(100vw * 9 / 16) !important; max-height: 45vh !important; z-index: 2147481000 !important; background: #000 !important; margin: 0 !important; }
    html.dr-split-b #dr-stage-host { top: min(calc(100vw * 9 / 16), 45vh) !important; }
    :is(html.dr-split-r, html.dr-split-b) :is(#player, #movie_player, .html5-video-player, .html5-video-container, video.html5-main-video) { width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; }
    :is(html.dr-split-r, html.dr-split-b) video.html5-main-video { object-fit: contain !important; }
    /* your video size (normal view): the video takes this share of the page width, the panel the rest */
    html.dr-vsize ytd-watch-flexy:not([theater]):not([fullscreen]) #primary.ytd-watch-flexy { flex: 0 0 auto !important; width: calc(var(--dr-vsize) - 24px) !important; max-width: none !important; min-width: 320px !important; }
    html.dr-vsize ytd-watch-flexy:not([theater]):not([fullscreen]) #secondary.ytd-watch-flexy { flex: 1 1 auto !important; width: auto !important; min-width: 260px !important; max-width: none !important; }
    html.dr-vsize ytd-watch-flexy:not([theater]):not([fullscreen]) { --ytd-watch-flexy-min-player-width: 280px !important; --ytd-watch-flexy-max-player-width: 4000px !important; }
  `;
  (document.head || document.documentElement).appendChild(st);
}

/**
 * Puts the panel in its place: YouTube's right column, or, on the phone page (m.youtube.com, the iPhone app) that has
 * no right column, right under the player. False = the page is not built yet.
 */
function placePanel(host: HTMLElement): boolean {
  const sec = document.querySelector('#secondary');
  if (sec) { sec.prepend(host); return true; }
  const player = document.querySelector('#player-container-id, ytm-player, .player-container');
  if (!player?.parentElement) return false;
  player.after(host);
  document.documentElement.classList.add('dr-panel-under');
  return true;
}

function makeHost(id: string): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement('div');
  host.id = id;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);
  return { host, root };
}

/** an explanation as shown / saved: a style's thinking pause is not a word */
const shown = (t: string) => t.replace(/\s*\[PAUSE\]\s*/gi, ' … ');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/**
 * A sentence in Chinese by the iPhone / iPad itself (Apple's Translation, on the device: free, no AI). null = not
 * here (the Chrome extension, an iOS before 18, the languages not downloaded, an error).
 */
const nativeTranslate = (text: string): Promise<string | null> => {
  try {
    const h = (window as unknown as { webkit?: { messageHandlers?: { ytc?: { postMessage(o: unknown): Promise<unknown> } } } }).webkit?.messageHandlers?.ytc;
    if (!h) return Promise.resolve(null);
    return Promise.resolve(h.postMessage({ kind: 'translate', text })).then((t) => (typeof t === 'string' && t.trim() ? t.trim() : null), () => null);
  } catch { return Promise.resolve(null); }
};
/** a touch app (the iPhone / iPad app, the Safari extension, a small touch screen): the page is a book of subtitles, always */
const TOUCH = ((): boolean => {
  try {
    const w = window as unknown as { __ytcShimYT?: unknown; __ytcSafari?: unknown };
    return !!w.__ytcShimYT || !!w.__ytcSafari || !!(self as unknown as { __ytcSafari?: unknown }).__ytcSafari || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 600);
  } catch { return false; }
})();
/** all the subtitles over the whole screen: Listening (the text moves with the sound) or Reading (pages) */
const bookView = (): boolean => extras.view === 'listening' || extras.view === 'reading' || extras.view === 'lyrics';
/** an iPad: the app says so (window.__ytcDevice, set by the app); otherwise a big touch screen */
const IPAD = ((): boolean => {
  if (!TOUCH) return false;
  try {
    const d = (window as unknown as { __ytcDevice?: string }).__ytcDevice;
    if (d === 'pad') return true;
    if (d === 'phone') return false;
    return navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) >= 600;
  } catch { return false; }
})();
/** an iPhone (a small touch screen) */
const PHONE = TOUCH && !IPAD;
/** which device: for the CSS (data-dev) and the debug info */
const DEVICE = IPAD ? 'pad' : PHONE ? 'phone' : 'desk';
type Lay = 'desk' | 'p-port' | 'p-land' | 't-narrow' | 't-port' | 't-land';
/**
 * The layout now. The window decides, not the device: an iPad in Split View / Slide Over is as small as a phone and
 * gets the phone layouts. (p = phone, t = tablet; port = upright, land = on its side)
 */
const lay = (): Lay => {
  if (!TOUCH) return 'desk';
  const w = innerWidth, h = innerHeight;
  if (Math.min(w, h) < 500) return w > h ? 'p-land' : 'p-port';
  if (w < 700) return 't-narrow';
  return w > h ? 't-land' : 't-port';
};
/** the page text on each layout, times your size (phoneSizePx is the iPhone upright size): 21 → 21 / 20 / 24 / 28 / 26 */
const PAGE_F: Record<Lay, number> = { 'p-port': 1, 'p-land': 0.95, 't-narrow': 1.15, 't-port': 1.33, 't-land': 1.25, desk: 1 };
/**
 * ONE text size for everything on a touch screen (the learner's "Text size", phoneSizePx): the Listening, Reading and
 * Lyrics pages, the subtitles on the video, the stop card and the explanations all follow it (an iPad shows it a
 * little bigger: PAGE_F). No size per mode any more (readSizePx and phoneBandPx are not used on a touch screen).
 */
const pagePx = (): number => Math.round(clamp(extras.phoneSizePx || 21, 14, 48) * PAGE_F[lay()]);
const bandPx = (): number => pagePx();
/** the text size of the reading page: on a touch screen its own (bigger on an iPad), and it never changes by itself */
const stageSize = (): number => (TOUCH ? pagePx() : clamp(extras.stageSizePx || 34, 16, 96));

// ---------------------------------------------------------------------------------------------------------------
// one video
// ---------------------------------------------------------------------------------------------------------------
/** My tutor (the AI explains, your key) or free mode (tutor off in the app: no AI, nothing paid) */
type Mode = 'tutor' | 'free';
interface Ui { host: HTMLElement; root: ShadowRoot; el: HTMLElement }
interface TalkLine { id: string; who: 'you' | 'tutor'; text: string; final: boolean }
interface Talk {
  live: LiveCall | null;
  /** the voice call with Claude (speech recognition + the tutor's voice), when there is no live call */
  chat: ChatCall | null;
  /** the sentence the talk is about: "go on" continues from its start (unless a window or a flow decides) */
  pos: Position;
  word?: string;
  explanation?: string;
  log: TalkLine[];
  hearing: boolean;
  started: number;
  timer: ReturnType<typeof setInterval>;
  error?: string;
  /** a real call: you opened it (📞, Space) or you started talking in it; it does not end after a few quiet seconds */
  call?: boolean;
  /** the OpenAI live call was reconnected once already */
  reconnected?: boolean;
}

/** the microphone is refused: where to allow it */
const micBlockedText = (): string => (navigator.maxTouchPoints > 1
  ? 'The microphone is blocked. iPhone Settings → this app → turn on Microphone and Speech Recognition (in Safari: aA → Website Settings → Microphone). You can type instead.'
  : 'The microphone is blocked for youtube.com: click the lock icon left of the address bar → Microphone → Allow. You can type instead.');

class Session {
  readonly videoId: string;
  mode: Mode;
  private vb: VideoBook | null = null;
  private ruleSentences: TimedSentence[] = [];
  // where the sentences come from: the rule-based first guess, the AI's complete sentences, the lyrics, or the
  // video's official subtitles made by people (used as they are: no AI split)
  private source: 'rule' | 'ai' | 'lyrics' | 'human' = 'rule';
  private dict: Dictionary | null = null;
  private names = new Set<string>();
  private hints: HintMap = {};
  private phrases: Record<string, PhraseHit[]> = {};
  private hardSentences: MarkedRange[] = [];
  /** sentence key -> its vocabulary key, for the sentences the AI found too hard */
  private hardKeys = new Map<string, string>();
  /** explanations asked for as soon as the video stopped (the voice starts right after the 5-second window) */
  private prefetched = new Map<string, { full: string; done: Promise<{ text: string; usage: { usd: number; dailyUsd: number; monthlyUsd: number } }>; cancel(): void; sink: ((full: string) => void) | null; at: number }>();
  private engine: VideoEngine;
  private mac: TtsEngine | null = null;
  private macRaw: TtsEngine | null = null;
  private macVoice = '';
  /** the Mac's English voices (picked in the quick settings) */
  private macVoices: { id: string; name: string; lang: string }[] = [];
  private zhMac: string | null = null;
  private tts: TtsEngine | null = null;
  private zhTts: TtsEngine | null = null;
  private router: SentenceFromVideo | null = null;
  /** what the teacher says, at the learner's volumes: the word / sentence taught, the explanation, the Chinese */
  private wordOut: WithVolume | null = null;
  private teachOut: WithVolume | null = null;
  private zhOut: WithVolume | null = null;
  private voiceKind: 'mac' | 'openai' | 'elevenlabs' | 'azure' = 'mac';
  /** why the good voice failed last (for the 🩺 check) */
  private lastVoiceError: string | null = null;
  private voiceId = '';
  private zhVoice: string | null = null;
  private keys: store.Keys = {};
  private playback: Playback | null = null;
  private controller: ListenController | null = null;
  private disposed = false;
  private offs: (() => void)[] = [];
  private pbOffs: (() => void)[] = [];
  private panel: Ui | null = null;
  private band: Ui | null = null;
  private stage: Ui | null = null;
  private stageShown = false;
  /** when the page last appeared (a click right after that was meant for the video) */
  private stageShownAt = 0;
  /**
   * The AI gets only what it needs: the sentence with a little before and after (not 700 words around it every
   * time), so each explanation costs less.
   */
  private leanOf: Settings | null = null;
  private leanCopy: Settings | null = null;
  private leanSettings(): Settings {
    if (this.leanOf !== settings || !this.leanCopy) {
      this.leanOf = settings;
      this.leanCopy = { ...settings, ai: { ...settings.ai, contextWordsBefore: Math.min(settings.ai.contextWordsBefore, 80), contextWordsAfter: Math.min(settings.ai.contextWordsAfter, 40) } };
    }
    return this.leanCopy;
  }
  /** memory of this video: the last save of where you are; the stops explained the times before */
  private spotSavedAt = 0;
  private doneBefore = new Set<string>();
  private partKeys: Set<string> | null = null;
  private cur: Position | null = null;
  private curWord = -1;
  private userScrollAt = 0;
  private cmdWin: CommandWindow | null = null;
  private windowOpen = false;
  private transcript: TranscriptEntry[] = [];
  private saved = new Set<number>();
  // (`full`: the stop card over the whole screen (a touch screen); `forcedStage`: it showed the page itself (page off),
  // so the page goes again when it closes; `openedAt`: a tap right after it opened is not "I know")
  private card: { lemma: string; word: string; pos: Position; token: number; kind: 'word' | 'phrase' | 'sentence'; entryId: number | null; full: boolean; forcedStage: boolean; openedAt: number; stop: boolean } | null = null;
  private cardTouchAt = 0;
  private cardClose: ReturnType<typeof setTimeout> | null = null;
  private followTimer: ReturnType<typeof setInterval> | null = null;
  private statusText = '';
  private statusBad = false;
  private talkOn = false;
  private lastAd = false;
  private talk: Talk | null = null;
  private pre: LiveCall | null = null;
  /** a flow of its own is running (you paused; ← a sentence; 📞): "go on" ends it */
  private flow: { kind: 'part' | 'sentence' | 'call'; part: Position[]; abort: boolean; resumeAt: Position | null; quietTo: Position | null; wake?: () => void } | null = null;
  /** no stops up to here (the part just explained is played again) */
  private quietUntil: Position | null = null;
  private zh: Record<string, string> = {};
  private zhPending = new Set<string>();
  private zhSave: ReturnType<typeof setTimeout> | null = null;
  private quickRoot: HTMLElement | null = null;
  private lastHeardAt = 0;
  private lastSelfResume = 0;
  private micToldBlocked = false;
  /** the online copy: when it was last looked at, and how it went (for Settings) */
  private gistPollAt = 0;
  private followTick = 0;
  gistText = '';
  /** an automatic stop is going on (its word is being asked or explained) */
  private inStop = false;
  /** about how many words the learner knows (shown on 📒) */
  private knownEstimate = 0;
  private knownTimer: ReturnType<typeof setTimeout> | null = null;
  /** counts the words you know again (soon, once) */
  countKnown(): void {
    if (this.knownTimer) clearTimeout(this.knownTimer);
    this.knownTimer = setTimeout(() => {
      this.knownTimer = null;
      void Promise.all([getDictData(), store.getEntries()]).then(([d, entries]) => {
        if (this.disposed) return;
        const progress = computeProgress(d, vocab.words, Object.values(entries));
        this.knownEstimate = estimateKnown(progress, settings.learnerLevel);
        // my level follows my own words
        // (with Level Check the tests set the level)
        // (3.8: the level is the learner's own slider, 0-100; it never moves by itself. The daily review only says what
        // the words suggest: see dailyReview)
        const next = null as ReturnType<typeof suggestLevel> | null;
        this.recomputeStops();
        if (next && next.level !== settings.learnerLevel) {
          void store.patchSettings({ learnerLevel: next.level });
          this.toast(`Your level is now ${next.level}: ${next.reason}. The tutor stops at what is above it.`, 9000);
        }
        this.levelText = levelNote(progress.levels, next?.level ?? settings.learnerLevel);
        this.renderHead();
      }).catch(() => undefined);
    }, 1500);
  }
  /** "B2 words you met: 40 of 52 known · …" for ⚙ */
  levelText = '';
  /** video time of the last automatic stop (stopGapSec counts from it) */
  private lastStopAt: number | null = null;
  private lastTtsEnd = 0;
  /** the last moment a voice of the tutor started or ended; a stop that stays silent plays on by itself */
  private lastVoiceAt = 0;
  private stopWatch: ReturnType<typeof setInterval> | null = null;
  private saveChain: Promise<unknown> = Promise.resolve();
  private get asleep(): boolean { return asleep; }
  // ---- Level Check ----
  private gate: LevelGate | null = null;
  private gateHold: (() => void) | null = null;
  /** the book is ready (false: this video has no subtitles) */
  private bookReady!: (ok: boolean) => void;
  private bookIsReady = new Promise<boolean>((r) => { this.bookReady = r; });
  private zipf: (word: string) => number | null = () => null;
  private scores = new Map<string, SentenceScore>();
  private stopSet = new Set<string>();
  /** automatic stops made, and the sentences heard, in this viewing (the small counter) */
  private autoStops = 0;
  /** … and by what they were for (each kind has its own share of the sentences) */
  private stopsBy: Record<StopGroup, number> = { word: 0, phrase: 0, sentence: 0 };
  /** per stop sentence: the word or phrase its written explanation is for (chosen once) */
  private stopFocus = new Map<string, { focus?: string; kind: 'word' | 'phrase' | 'sentence' }>();
  /** the stop being made: its sentence and what it is for */
  private trigger: { key: string; group: StopGroup } | null = null;
  /** where a word or phrase was last asked or explained, in words from the start (not again within extras.repeatWords) */
  /** the learner's "words heard" counter and the words asked lately: it goes on from one video to the next (heard.ts) */
  private wordsHeard = new HeardCounter();
  private offsets: ((pos: Position) => number) | null = null;
  private heardKeys = new Set<string>();
  private stopped = new Set<string>();
  private counterEl: HTMLElement | null = null;
  /** the explanations written once, ahead of the stops; the video waits for the first of them */
  private analysis: Analysis | null = null;
  private aiJobsDone = false;
  private gatePassed = false;
  private gateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(videoId: string, mode: Mode) {
    this.videoId = videoId;
    this.mode = mode;
    this.engine = new VideoEngine(() => (window.__ytcApi?.isAd() ? null : video()), () => this.vb);
    // the window changed size (the phone turned, an iPad split): the sizes and the layout follow; the mode, the view,
    // a card, a window or an explanation stay as they are
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (this.disposed) return;
        this.applyLook();
        if (this.vb) { this.placeBand(); this.scrollToCur(true); }
        this.fitFullCard();
      }, 150);
    };
    window.addEventListener('resize', onResize);
    this.offs.push(() => { window.removeEventListener('resize', onResize); if (resizeTimer) clearTimeout(resizeTimer); });
  }

  get book(): Book | null { return this.vb?.book ?? null; }
  /**
   * The AI may be used: My tutor is on. Free mode (the tutor off, in the app) still stops at hard words, says them,
   * shows the card with the dictionary and Apple's translation, but never asks the AI and never uses a paid voice.
   */
  ai(): boolean { return this.mode === 'tutor'; }
  /** something only the tutor does (an explanation, a call) was asked for in free mode */
  private freeNote(): void { this.toast('Free mode: turn My tutor on to explain.', 4000); }
  /** youtube.js must leave the video alone */
  owns(): boolean { return !this.disposed; }

  /**
   * The microphone is needed: a window waits for "I know / I don't know", a talk is open (the OpenAI call has its own
   * microphone), or you chose "always" (for "hi bro" while the video plays).
   */
  wantsMic(): boolean {
    if (this.disposed || this.pttActive || asleep) return false;
    if (extras.micAlways || extras.voiceMode) return true;
    if (this.inStop || this.playback?.state === 'explaining') return true;
    return !!this.cmdWin || this.windowOpen || !!(this.talk && !this.talk.live);
  }

  /** a real voice call with Claude is open: it listens even with voice commands off */
  callOpen(): boolean { return !this.disposed && !this.pttActive && !!this.talk?.call && !this.talk.live; }

  async start(): Promise<void> {
    pageStyle();
    this.openGate();
    this.mountPanel();
    // the vocabulary file: the other device's new words come in before this video (the Mac helper / the app merges them)
    void chrome.runtime.sendMessage({ type: 'dream-db-write' }).catch(() => undefined);
    this.setStatus('Reading the subtitles…');
    let info: YtcInfo;
    try {
      [info, this.dict] = await Promise.all([window.__ytcApi!.loadTranscript(), getDictionary()]);
      // YouTube draws the page (and its transcript) late, or answers slowly: try again a few times before giving up
      for (const wait of [4000, 8000, 15000]) {
        if (info.cues.length || this.disposed) break;
        this.setStatus('Reading the subtitles… (trying again)');
        await new Promise((r) => setTimeout(r, wait));
        if (this.disposed) return;
        info = await window.__ytcApi!.loadTranscript();
      }
    } catch (e) { this.setStatus(`Could not start: ${(e as Error).message}`, true); this.bookReady(false); return; }
    if (this.disposed) return;
    let sentences = info.cues.length ? window.__ytcApi!.buildSentences(info.cues, { human: !!info.human }) : [];
    // lyrics mode: the song's lyrics are the page (found once per video and kept: lyrics-find.ts; the subtitles stay when none is found)
    if (extras.view === 'lyrics') {
      this.setStatus('Finding the lyrics…');
      this.lyricsAsk = { title: info.title || document.title.replace(/ - YouTube$/, ''), channel: info.channel ?? '', captions: sentences };
      const found = await findSongLyrics({ videoId: this.videoId, ...this.lyricsAsk, duration: video()?.duration || 0, tutorOn: this.ai(), complete, alive: () => !this.disposed });
      if (this.disposed) return;
      if (found.lyrics) { this.lyrics = found.lyrics; sentences = lyricSentences(found.lyrics); }
      else { this.toast('No lyrics found for this song: its subtitles are shown. You can paste the lyrics (the button is at the top of the page).', 8000); if (!sentences.length) this.pasteLyrics(); }
    }
    if (!sentences.length) {
      this.setStatus('No subtitles could be read for this video. Turn on CC in the player, or load a subtitle file (.srt / .vtt) in the extension window.', true);
      this.bookReady(false);
      this.renderEmpty('No subtitles yet. The Dream Tutor needs the video’s subtitles.');
      return;
    }
    this.ruleSentences = sentences;
    if (this.lyrics) this.source = 'lyrics';
    else if (info.human) this.source = 'human';
    this.keys = await store.getKeys().catch(() => ({}));
    // the AI's complete sentences, when this video was read before (not for official subtitles: they are used as they are)
    let use = sentences;
    const split = this.source === 'rule' ? await store.getSplit(this.cacheId(), SPLIT_VERSION).catch(() => null) : null;
    const words = flatten(sentences);
    if (split && split.words === words.length) { use = regroup(words, split.ends.map((end, i) => ({ end, text: split.texts[i] ?? '' }))); this.source = 'ai'; }
    this.buildBook(use, this.lyrics ? `${this.lyrics.title} — ${this.lyrics.artist}` : info.title || document.title.replace(/ - YouTube$/, ''), info.channel);
    this.gate?.setTitle(this.vb!.book.title);
    this.zipf = await getZipf();
    void this.runDailyReview();
    this.bookReady(true);
    this.zh = await store.getZh(this.cacheId()).catch(() => ({}));
    this.doneBefore = new Set(await store.getDone(this.cacheId()).catch(() => []));
    this.wordsHeard = new HeardCounter(await store.getHeard().catch(() => null) as never);
    await this.loadHints();
    await this.prepareVoices();
    if (this.disposed) return;
    this.mountStage();
    this.render();
    this.setupController();
    this.listenVideo();
    this.followTimer = setInterval(() => this.follow(), 60);
    // tests only (the silent test voice is on): what the tutor is doing, readable from the page
    if (E2E()) { const t = setInterval(() => { if (this.disposed) clearInterval(t); else document.documentElement.dataset.drDebug = JSON.stringify(this.debug()); }, 150); }
    this.setStatus(this.readyText(this.lyrics ? lyricsNote(this.lyrics) : info.source));
    this.countKnown();
    this.applyView();
    await this.backWhereYouStopped();
    {
      const v = video();
      if (v && !v.paused) { this.engine.resumeHere = true; this.playback!.play(this.vb!.positionAt(v.currentTime) ?? undefined); }
      else if (v) this.playback!.seek(this.vb!.positionAt(v.currentTime) ?? this.vb!.order[0]);
      if (this.ai()) void this.checkKey();
    }
    void this.runAiJobs();
    if (this.lyrics) void this.songIntro();
  }

  /** lyrics mode: the song's lyrics (null = the video's subtitles), and what is known about the song */
  private lyrics: Lyrics | null = null;
  private song: string | null = null;
  /** lyrics mode: the song's story, its parts and the notes on its lines (written once per song by the AI) */
  private songData: SongNotes | null = null;
  private songIntroOn = false;
  /**
   * Lyrics mode, before the song plays: what the song is about, its background story, and how listeners understand
   * its lines (written once by the AI, saved with the song), shown and said; then the song plays.
   */
  private async songIntro(): Promise<void> {
    const lyr = this.lyrics, vb = this.vb;
    if (!lyr || !vb || this.disposed) return;
    const id = this.cacheId();
    // (the song's story, its parts and the notes on its lines: one AI request per song, kept with it; lyrics-notes.ts)
    this.songData = await loadSongNotes(id, lyr.lines.length);
    this.song = this.songData?.about || null;
    if (this.songData) this.lyricsPage();
    const v = video();
    const wasPlaying = !!v && !v.paused;
    if (v && !v.paused) { this.engine.markOwn('pause'); v.pause(); this.playback?.pause(); }
    const box = this.showSongBox(`${lyr.title} — ${lyr.artist}`, this.song ?? 'Reading about the song…');
    this.songIntroOn = true;
    // (anything that starts the video meanwhile is held until the introduction is over or "Play the song")
    const hold = () => { const vv = video(); if (this.songIntroOn && vv && !vv.paused) { this.engine.markOwn('pause'); vv.pause(); } };
    const holdTimer = setInterval(() => { if (!box.isConnected || this.disposed) { clearInterval(holdTimer); this.songIntroOn = false; } else hold(); }, 250);
    if (!this.songData) {
      if (!this.ai() || (!this.keys.anthropic && !this.keys.openai)) { this.songIntroOn = false; box.remove(); if (wasPlaying) void v?.play(); return; }
      const level = levelMeta.currentLevel || settings.learnerLevel || 'B2';
      try {
        this.songData = await askSongNotes(lyr, level, complete);
        this.song = this.songData?.about || null;
        if (this.songData) { void saveSongNotes(id, this.songData); this.lyricsPage(); }
        // (the explanations of this song now know about it: written again with it)
        this.analysis?.dispose();
        this.analysis = null;
        this.planAnalysis();
      } catch (e) { this.song = null; this.toast(`The song introduction failed: ${(e as Error).message}`, 6000); }
    }
    if (this.disposed) return;
    const text = this.song ?? '';
    // (no answer that can be used: no introduction, the song is as it was)
    if (!text) { this.songIntroOn = false; clearInterval(holdTimer); box.remove(); if (wasPlaying) void video()?.play().catch(() => undefined); return; }
    const p = box.querySelector('.songtext');
    if (p) p.textContent = text;
    // said by the tutor's voice; "Play the song" (or the end of it) starts the song
    let spoken: { cancel(): void } | null = null;
    const start = () => { spoken?.cancel(); this.songIntroOn = false; clearInterval(holdTimer); box.remove(); const vv = video(); if (vv) { this.engine.resumeHere = true; void vv.play().catch(() => undefined); this.playback?.play(vb.positionAt(vv.currentTime) ?? vb.order[0]); } };
    box.querySelector<HTMLButtonElement>('[data-act="play"]')!.onclick = start;
    if (text && this.tts) {
      const h = this.tts.speak(text, { voiceId: this.voiceId, rate: settings.voice.rate, volume: this.volumeOf('teacher') });
      spoken = h;
      void h.done.then((o) => { if (o === 'ended' && box.isConnected) start(); }, () => undefined);
    }
  }
  /** lyrics mode: what the lyrics were looked for with (the paste box times the learner's own lyrics with the captions) */
  private lyricsAsk: { title: string; channel: string; captions: TimedSentence[] } | null = null;
  /** "Paste the lyrics": the learner's own lyrics for this video, timed and kept; the page is made again with them */
  private pasteLyrics(): void {
    const ask = this.lyricsAsk;
    if (!ask) return;
    openPasteBox({
      title: this.lyrics ? `${this.lyrics.title}${this.lyrics.artist ? ` — ${this.lyrics.artist}` : ''}` : ask.title,
      why: this.lyrics ? '' : 'No lyrics were found for this song.',
      textSize: TOUCH ? clamp(extras.phoneSizePx || 21, 14, 30) : 16,
      use: async (text) => {
        const lyr = await usePastedLyrics({ videoId: this.videoId, text, ...ask, duration: video()?.duration || 0 });
        // (the notes were written for the other lyrics)
        if (lyr) { await dropSongNotes(`${this.videoId}~lyrics`); window.__ytcDream?.reload?.(); }
        return !!lyr;
      },
    });
  }
  /** lyrics mode: this module's parts of the page (lyrics-page.ts), after the lines were drawn */
  private lyricsPage(): void {
    if (extras.view !== 'lyrics' || !this.stage) return;
    const keys = this.lyrics && this.vb && this.vb.order.length === this.lyrics.lines.length ? this.vb.order.map((p) => sentenceKey(p)) : undefined;
    decorateLyricsPage(this.stage.el, { lyrics: this.lyrics, notes: this.songData, keys, paste: () => this.pasteLyrics(), say: (text) => this.sayLyricNote(text) });
  }
  private showSongBox(title: string, text: string): HTMLElement {
    const root = this.stage?.el ?? document.body;
    root.querySelector('.songbox')?.remove();
    const box = document.createElement('div');
    box.className = 'songbox';
    box.innerHTML = `<div class="songhead">🎵 ${esc(title)}</div><div class="songtext"></div><button type="button" class="primary" data-act="play">▶ Play the song</button>`;
    box.querySelector('.songtext')!.textContent = text;
    root.appendChild(box);
    return box;
  }

  /** the video opens where you stopped last time (not when the link asks for a time, or YouTube already went there) */
  private async backWhereYouStopped(): Promise<void> {
    const v = video();
    if (!v || this.disposed) return;
    if (/[?&#](t|start)=/.test(location.href) || v.currentTime > 20) return;
    const at = store.resumeAt(await store.getSpot(this.videoId).catch(() => null), Date.now(), v.duration || 0);
    if (at === null || this.disposed) return;
    v.currentTime = at;
    this.toast(`Back where you stopped (${clock(at)}). Press 0 for the start.`, 7000);
  }

  private readyText(src?: string | null): string {
    const n = this.vb?.order.length ?? 0;
    return `${n} sentences${this.source === 'ai' ? ' (complete, by the AI)' : this.source === 'human' ? ' (official subtitles, made by people)' : ''} · ${src ?? 'subtitles'} · your level ${settings.learnerLevel}: explains the hardest of what is at your level or above (${explainText()})${this.ai() ? '' : ' · free mode (no AI)'}`;
  }

  private buildBook(sentences: TimedSentence[], title?: string, channel?: string): void {
    this.vb = buildVideoBook({ id: this.videoId, title: title ?? this.vb?.book.title ?? '', channel: channel ?? undefined }, sentences);
    const names = detectNames(this.vb.book, this.dict!);
    this.vb.book.names = names;
    this.names = new Set(names);
  }

  private async loadHints(): Promise<void> {
    const cached = await store.getVideoHints(this.videoId).catch(() => null) as (store.VideoHints & { split?: string; sentences?: number[]; v?: number }) | null;
    if (!cached || !analysisCovers(cached.level)) return;
    this.hints = cached.hints;
    this.hereZh = new Map(Object.entries((cached as { here?: Record<string, string> }).here ?? {}));
    this.hardLevel = cached.level;
    if (cached.v === HINTS_VERSION && cached.split === this.source) {
      this.phrases = cached.phrases as Record<string, PhraseHit[]>;
      this.hardSentences = this.markedFrom(cached.sentences ?? []);
    }
  }

  private markedFrom(indices: number[]): MarkedRange[] {
    this.hardKeys.clear();
    if (!this.vb) return [];
    const out: MarkedRange[] = [];
    for (const i of indices) {
      const pos = this.vb.order[i];
      const s = pos && getSentence(this.vb.book, pos);
      if (!s) continue;
      out.push({ chapter: pos.chapter, paragraph: pos.paragraph, sentence: pos.sentence, start: s.sentence.start, end: s.sentence.end, text: s.text });
      this.hardKeys.set(sentenceKey(pos), sentenceLemma(s.text));
    }
    return out;
  }

  // ---- voices ---------------------------------------------------------------------------------------------------
  private async prepareVoices(): Promise<void> {
    if (E2E()) useFakeEngine(2);
    // Chrome's free online voices ("Google UK English …") stop after about 15 s: they get short pieces
    this.macRaw = getEngine('webspeech');
    this.mac = new ShortPieces(this.macRaw, (id) => /^Google /i.test(id));
    this.macVoice = settings.voice.voiceId || (await defaultVoiceFor('webspeech').catch(() => ''));
    this.zhMac = await chineseVoiceId().catch(() => null);
    // (the Mac's joke voices are left out, unless one is already yours)
    const good = (n: string) => (/premium|enhanced|siri/i.test(n) ? 0 : 1);
    const online = (n: string) => (/^Google /i.test(n) ? 1 : 0);
    const novelty = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Deranged|Hysterical|Pipe Organ)$/;
    this.macVoices = (await this.mac.listVoices().catch(() => []))
      .filter((v) => /^en\b|^en[-_]/i.test(v.lang) && (!novelty.test(v.name) || v.id === this.macVoice))
      // the better ones (Enhanced / Premium / Siri) first, Chrome's online voices last
      .sort((a, b) => online(a.name) - online(b.name) || good(a.name) - good(b.name) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))
      .map((v) => ({ id: v.id, name: online(v.name) ? `${v.name} · online` : v.name, lang: v.lang }));
    await this.loadAzureAvail();
    this.applyVoice();
  }

  /** the teacher's voice says the Chinese in a sentence itself (cloud voices; Microsoft only its multilingual ones) */
  private saysChineseItself(): boolean { return this.voiceKind !== 'mac' && (this.voiceKind !== 'azure' || isMultilingual(this.voiceId)); }

  /** the Microsoft voices the learner's region has (from the key test), for the list in ⚙ */
  azureAvail: string[] | null = null;
  async loadAzureAvail(): Promise<void> {
    const o = await chrome.storage.local.get('drAzureVoices').catch(() => ({} as Record<string, unknown>));
    this.azureAvail = Array.isArray(o.drAzureVoices) ? (o.drAzureVoices as string[]) : null;
  }

  /** the tutor's voice: OpenAI / ElevenLabs (with the Mac voice behind it) or the Mac voice */
  private applyVoice(): void {
    if (!this.mac) return;
    // (free mode: only the iOS voice, never a paid one)
    const kind = this.ai() ? resolveVoice(extras.voice, this.keys) : 'mac';
    this.tts?.cancelAll();
    this.voiceKind = kind;
    this.lastVoiceError = null;
    if (kind === 'mac') {
      this.tts = this.mac; this.zhTts = this.mac; this.voiceId = this.macVoice; this.zhVoice = this.zhMac;
    } else {
      const name = kind === 'openai' ? 'OpenAI' : kind === 'azure' ? 'Microsoft' : 'ElevenLabs';
      const plain = navigator.maxTouchPoints > 1 ? 'built-in' : 'Mac';
      const trouble = (e: Error, cooling: boolean) => {
        this.lastVoiceError = `${name} voice: ${e.message}`;
        // one failed sentence is said by the plain voice quietly; only a longer problem is shown
        if (cooling) this.toast(`The ${name} voice has a problem (${e.message}). The ${plain} voice speaks for 1 minute, then the ${name} voice again.`, 9000);
      };
      this.tts = new VoiceWithBackup(cloudEngine(kind, 'en'), this.mac, () => this.macVoice, trouble);
      this.zhTts = new VoiceWithBackup(cloudEngine(kind, 'zh'), this.mac, () => this.zhMac ?? '', trouble);
      this.voiceId = kind === 'openai' ? extras.openaiVoice : kind === 'azure' ? extras.azureVoice : extras.elevenVoice;
      this.zhVoice = kind === 'azure' ? azureZhVoice(this.voiceId) : this.voiceId;
    }
    // the sentence plays again from the video (after the explanation): the word card has done its job
    this.router = new SentenceFromVideo(() => this.tts!, this.engine, (t) => this.isTaught(t), () => { if (this.card) this.closeCard(); });
    const spoke = (text?: string) => { this.lastVoiceAt = Date.now(); if (text) this.showLineOf(text); };
    this.wordOut = new WithVolume(() => this.router!, () => this.volumeOf('word'), spoke);
    // the teacher's words: the AI's own sentences by the voice, the video's sentences it quotes by the video itself
    this.quotes = new QuotesFromVideo(() => this.tts!, this.engine, (t) => this.quotedSentence(t));
    this.teachOut = new WithVolume(() => this.quotes!, () => this.volumeOf('teacher'), spoke);
    this.zhOut = new WithVolume(() => this.zhTts!, () => this.volumeOf('teacher'));
  }

  /**
   * The learner's two volume sliders (the word / sentence taught, the teacher's explanation), squared so they feel
   * even; with "follow the video" 100 % is as loud as the video (YouTube's own volume, its loudness levelling too).
   */
  volumeOf(kind: 'word' | 'teacher'): number {
    const g = sliderGain(kind === 'word' ? extras.wordVolume : extras.teacherVolume);
    const v = video();
    const base = extras.followVideoVolume && v && !v.muted ? v.volume : 1;
    return Math.max(0, Math.min(1, g * base));
  }

  /** the teacher says the sentence being taught: it plays from the video */
  private quotes: QuotesFromVideo | null = null;
  /**
   * The sentence of the video near here that the teacher quotes (whole, in quotation marks or not): it is played
   * from the video. Short quotes (a phrase, a word) are said by the voice.
   */
  quotedSentence(text: string): Position | null {
    const vb = this.vb;
    if (!vb || !this.ai()) return null;
    const t = norm(text.replace(/^[\s"“”'‘’«»]+|[\s"“”'‘’«»]+$/g, ''));
    if (t.split(' ').length < 4) return null;
    const same = (p: Position) => { const s = getSentence(vb.book, p); return !!s && norm(s.text) === t; };
    // the part on the page; else the sentence being taught and the ones right around it
    if (this.partKeys) { for (const p of vb.order) if (this.partKeys.has(sentenceKey(p)) && same(p)) return p; return null; }
    const center = this.engine.target ?? this.playback?.position ?? null;
    const i0 = center ? vb.order.findIndex((p) => sentenceKey(p) === sentenceKey(center)) : -1;
    if (i0 < 0) return null;
    for (let i = Math.max(0, i0 - 2); i < Math.min(vb.order.length, i0 + 2); i++) if (same(vb.order[i])) return vb.order[i];
    return null;
  }

  private isTaught(text: string): boolean {
    const p = this.engine.target;
    const s = p && this.vb ? getSentence(this.vb.book, p) : null;
    return !!s && norm(s.text) === norm(text);
  }

  testVoice(): void {
    this.lastVoiceError = null;
    const h = this.teachOut?.speak('Hello! I am your English teacher. Let us learn with this video.', { voiceId: this.voiceId, rate: settings.voice.rate });
    // (a good voice that failed is said by the plain voice: the reason is shown all the same)
    void h?.done.then(() => { const why = h.error?.message ?? this.lastVoiceError; if (why) this.toast(why, 8000); });
  }

  /** a voice was chosen: it says the test sentence, unless the tutor is in the middle of something (or the page is hidden) */
  private testVoiceIfFree(): void {
    if (document.hidden || this.controller?.busy || this.flow || this.talk || this.cmdWin || this.gate?.open) return;
    this.testVoice();
  }

  /** the word voice at its volume (quick settings ▶) */
  testWord(): void {
    this.tts?.cancelAll();
    const h = this.wordOut?.speak('wonderful', { voiceId: this.voiceId, rate: Math.min(settings.voice.rate, 0.9) });
    void h?.done.then(() => { if (h.error) this.toast(h.error.message, 6000); });
  }

  // ---- Level Check -------------------------------------------------------------------------------------------------
  // (free mode always chooses its stops this way: it needs no AI)
  levelOn(): boolean { return this.mode === 'free' || (this.mode === 'tutor' && extras.levelMode !== false); }
  ruleRejects = 0;

  /**
   * Before the video plays: "Check my words" or "Skip, just play" (once per video in this tab), then the one analysis.
   * The video waits for both; when they are done it plays by itself, in Listening mode.
   */
  private openGate(): void {
    if (!this.levelOn()) { this.gatePassed = true; return; }
    const asked = `drLevelAsked:${this.videoId}`;
    let ask = extras.levelAsk !== false;
    if (ask) { try { if (sessionStorage.getItem(asked)) ask = false; else sessionStorage.setItem(asked, '1'); } catch { /* no storage here: it asks */ } }
    this.gate = new LevelGate({
      build: () => this.buildTest(),
      save: async (shown, known, scores) => (await store.saveTestResult(shown, known, this.vb?.book.title ?? '', scores)).label,
      done: () => this.afterGate(),
    }, document.title.replace(/ - YouTube$/, ''));
    // the video waits (YouTube starts it by itself); ads are not held
    const hold = () => { const v = video(); if (this.gateHold && v && !v.paused && !window.__ytcApi?.isAd()) { this.engine.markOwn('pause'); v.pause(); } };
    const t = setInterval(hold, 150);
    document.addEventListener('play', hold, true);
    this.gateHold = () => { clearInterval(t); document.removeEventListener('play', hold, true); this.gateHold = null; };
    hold();
    if (ask) this.gate.show(); else this.afterGate();
  }

  private afterGate(): void {
    if (this.disposed) return;
    this.gatePassed = true;
    this.gate?.wait('Reading the subtitles…', () => this.releaseGate());
    // (never longer than this: the analysis goes on while the video plays)
    this.gateTimer = setTimeout(() => this.releaseGate(), 120_000);
    void this.bookIsReady.then((ok) => { if (ok) this.startAnalysis(); else this.releaseGate(); });
  }

  /** the test is done and the AI knows the video's sentences and hard parts: now the explanations */
  private startAnalysis(): void {
    if (this.disposed || !this.gatePassed || !this.levelOn()) return;
    if (!this.aiJobsDone) { this.gate?.setWait('Finding the sentences and the hard parts…'); return; }
    // (free mode: no explanations to write; the stops come from the dictionary)
    if (!this.ai()) { this.recomputeStops(); this.releaseGate(); return; }
    if (!this.keys.anthropic && !this.keys.openai) { this.releaseGate(); return; }
    this.recomputeStops();
    this.planAnalysis();
  }

  private currentIndex(): number {
    const p = this.playback?.position ?? this.cur;
    return p ? this.scores.get(sentenceKey(p))?.index ?? 0 : 0;
  }

  /** the stops that may still come, for the analysis */
  private analysisStops(): AnalysisStop[] {
    if (!this.vb) return [];
    const out: AnalysisStop[] = [];
    const planned = new Map<string, number>();
    this.vb.order.forEach((pos, index) => {
      const key = sentenceKey(pos);
      if (!this.stopSet.has(key) || this.doneBefore.has(key)) return;
      const text = getSentence(this.vb!.book, pos)?.text ?? '';
      const sc = this.scores.get(key);
      // (the stop is for its first hard word or phrase of a group that is on, not known and not asked a moment ago;
      // else the sentence. Chosen once per sentence: a word known later must not make it a new stop to write again.)
      let f = this.stopFocus.get(key);
      const here = this.wordsBefore(pos);
      if (!f && sc) {
        const caps = this.caps(), win = extras.repeatWords ?? 1000;
        const soon = (l: string) => { const at = planned.get(l); return at !== undefined && win > 0 && here >= at && here - at < win; };
        const i = sc.lemmas.findIndex((l, j) => caps[sc.kinds[j]] > 0 && vocab.words[l] !== 'known' && vocab.words[l] !== 'ignored' && !this.askedLately(l, here) && !soon(l));
        if (i >= 0) f = { focus: sc.items[i], kind: sc.kinds[i] };
        else if (kindWith(sc, caps) === 'sentence') f = { kind: 'sentence' };
        // (nothing this stop would ask with the groups that are on: no explanation is written for it)
        if (!f) return;
        this.stopFocus.set(key, f);
      }
      if (!f) return;
      if (f.focus && sc) { const j = sc.items.indexOf(f.focus); if (j >= 0) planned.set(sc.lemmas[j], here); }
      out.push({ id: stopId(text, f.focus), index, text, items: sc?.items ?? [], focus: f.focus, kind: f.kind });
    });
    // (lyrics mode: a whole line that has its own note needs no written explanation: the note is read at its stop)
    if (this.songData) return out.filter((s) => s.focus || !this.lyricNote(this.vb!.order[s.index]));
    return out;
  }

  /** where this video's written explanations are kept: per rules version and length (lyrics apart) */
  private analysisKey(): string { return `${this.cacheId()}|v2|${teachLength()}`; }
  /** the video's id for its saved things (a lyrics book has its own) */
  cacheId(): string { return this.lyrics ? `${this.videoId}~lyrics` : this.videoId; }
  /** lyrics mode: what is known about the song, for the explanations */
  songNotes(pos?: Position | null): string | undefined { return this.songData ? songContext(this.songData, this.lyrics, pos === undefined ? undefined : this.lyricLine(pos)) : this.song ?? undefined; }
  /** lyrics mode: which line of the lyrics (from 0) a sentence of the page is; -1 = none */
  private lyricLine(pos: Position | null | undefined): number {
    if (!pos || !this.lyrics || !this.vb || this.vb.order.length !== this.lyrics.lines.length) return -1;
    const k = sentenceKey(pos);
    return this.vb.order.findIndex((p) => sentenceKey(p) === k);
  }
  /** lyrics mode: the note of this line, when it has one that explains it well enough to be read at its stop */
  private lyricNote(pos: Position | null | undefined): string | undefined {
    const i = this.songData ? this.lyricLine(pos) : -1;
    const note = i >= 0 ? notesByLine(this.songData, this.lyrics).get(i) : undefined;
    return noteIsEnough(note) ? note : undefined;
  }
  /** lyrics mode: a line's note is read by the tutor's voice (the song waits, and goes on after it) */
  private sayLyricNote(text: string): { cancel(): void } | null {
    if (!this.ai() || !this.tts || this.inStop || this.controller?.busy || this.talk || this.flow || this.songIntroOn) return null;
    const v = video();
    const was = !!v && !v.paused;
    if (v && was) { this.engine.markOwn('pause'); v.pause(); this.playback?.pause(); }
    const h = this.tts.speak(text, { voiceId: this.voiceId, rate: settings.voice.rate, volume: this.volumeOf('teacher') });
    let over = false;
    const back = () => {
      if (over) return;
      over = true;
      const vv = video();
      if (was && !this.disposed && vv && vv.paused && this.vb) { this.engine.resumeHere = true; void vv.play().catch(() => undefined); this.playback?.play(this.vb.positionAt(vv.currentTime) ?? undefined); }
    };
    void h.done.then(back, back);
    return { cancel: () => { h.cancel(); back(); } };
  }

  /** the explanations ahead of the learner: written once, saved with the video */
  private planAnalysis(): void {
    if (!this.ai() || !this.levelOn() || !this.gatePassed || !this.aiJobsDone || !this.vb || (!this.keys.anthropic && !this.keys.openai)) return;
    const akey = this.analysisKey();
    this.analysis ??= new Analysis({
      // (the learner's own rules, in their length: saved apart from older explanations of the same video)
      load: () => store.getAnalysis(akey),
      save: (texts) => store.setAnalysis(akey, texts),
      stops: () => this.analysisStops(),
      length: () => teachLength(),
      song: () => this.songNotes(),
      lineAt: (i) => (this.vb ? getSentence(this.vb.book, this.vb.order[i])?.text ?? '' : ''),
      total: () => this.vb?.order.length ?? 0,
      title: () => this.vb?.book.title ?? '',
      level: () => levelMeta.currentLevel || settings.learnerLevel,
      way: () => settings.ai.activeStyle,
      stream: (prompt, onDelta) => completeStream(prompt, onDelta, true),
      onChange: () => this.analysisChanged(),
    });
    const a = this.analysis;
    void a.ready.then(() => { if (this.analysis === a) a.plan(this.currentIndex()); });
  }

  /** a part of the analysis came in: the video starts as soon as its first stops can be explained */
  private analysisChanged(): void {
    const a = this.analysis;
    if (!a || !this.gateHold) return;
    const next = a.upcoming(this.currentIndex()).slice(0, 2);
    this.gate?.setWait(a.busy ? `Writing the explanations… ${next.filter((s) => a.settled(s.id)).length} of ${next.length} ready to start` : 'Almost ready…');
    if (next.every((s) => a.settled(s.id))) this.releaseGate();
  }

  private releaseGate(): void {
    if (!this.gateHold) return;
    if (this.gateTimer) clearTimeout(this.gateTimer);
    this.gateTimer = null;
    this.gateHold();
    this.gate?.close();
    this.gate = null;
    if (this.disposed) return;
    // every video goes on in Listening mode (🎬 Video on the page goes back to the picture)
    // (a phone keeps the mode you chose: Listening, Reading or Video)
    if (!TOUCH && extras.levelListening !== false && extras.view === 'normal' && this.vb) void store.patchExtras({ view: 'listening' });
    const v = video();
    // (lyrics mode: the song introduction starts the song itself when it is over)
    if (v && v.paused && !this.songIntroOn) void v.play().catch(() => this.toast('Press play on the video.', 5000));
  }

  private inDatabase = (key: string, sig: string): boolean => {
    if (vocab.words[key]) return true;
    return this.databaseSigs().has(sig);
  };
  /** the phrases of the learner's database, in a form that does not depend on "his / her", tense … */
  private databaseSigs(only?: (st: WordStatus) => boolean): Set<string> {
    const out = new Set<string>();
    if (!this.dict) return out;
    for (const [k, st] of Object.entries(vocab.words)) if (k.includes(' ') && !k.startsWith('sentence: ') && (!only || only(st))) out.add(phraseSig(this.dict, k));
    return out;
  }

  /** the tap test: only from this video's subtitles */
  private async buildTest(): Promise<TestGroups | null> {
    if (!(await this.bookIsReady) || !this.vb || !this.dict || this.disposed) return null;
    const book = this.vb.book;
    const lines = this.vb.order.map((p) => getSentence(book, p)?.text ?? '');
    let ai = await store.getLevelItems(this.cacheId()).catch(() => null);
    // (free mode: only the dictionary, and the AI's items saved before)
    if (!ai && this.ai() && (this.keys.anthropic || this.keys.openai)) {
      // (the idioms and slang by the AI; a slow answer does not hold up the test)
      const ask = complete(buildItemsPrompt(lines, book.title)).then((raw) => { const items = parseItems(raw, lines); void store.setLevelItems(this.cacheId(), items).catch(() => undefined); return items; });
      ai = await Promise.race([ask, new Promise<null>((r) => setTimeout(() => r(null), 15000))]).catch(() => null);
    }
    const sigs = this.databaseSigs();
    const all = collectItems({ book, dict: this.dict, names: this.names, inDatabase: (k, s) => !!vocab.words[k] || sigs.has(s), ai: ai ?? [], zipf: this.zipf });
    return pickForScreen(all, { width: window.innerWidth, height: window.innerHeight });
  }

  /** the score of every sentence and the sentences that stop, with what is known now */
  private recomputeStops(): void {
    if (!this.vb || !this.dict || !this.levelOn()) return;
    const done = this.databaseSigs((st) => st === 'known' || st === 'ignored');
    // MY LEVEL (A1 … C2, kept as a number too: level100.ts): nothing below it can stop. A word or phrase whose school
    // level is below mine never stops; the others only when their number is higher than my level's. A whole sentence
    // the analysis found hard has the number of the level it was found hard for, a little above it.
    // HOW MUCH TO EXPLAIN (0–100 %): of what is left, only the hardest share stays (keepHardest).
    const mine = myLevel();
    const cefrMine = settings.learnerLevel;
    const zipf = this.zipf;
    const hardNumber = Math.min(98, (CEFR_MID[(this.hardLevel || settings.learnerLevel) as CefrLevel] ?? 56) + 10);
    const numbers = new Map<string, number>();
    // (the share is taken of the hard things as they were WHEN THE VIDEO OPENED: a word that this video's own stops
    // made "learning" or "known" must not move the next-hardest word into the share, or the share would creep up)
    this.rankWords ??= { ...vocab.words };
    this.rankDone ??= done;
    const atStart = this.rankWords, doneAtStart = this.rankDone;
    const all = scoreSentences({
      book: this.vb.book, order: this.vb.order, dict: this.dict, names: this.names,
      status: (l) => atStart[l], phraseDone: (sig) => doneAtStart.has(sig), phrases: this.phrases,
      hard: harderThan(hardNumber, mine) ? new Set(this.hardKeys.keys()) : new Set<string>(),
      chance: unknownChance(levelMeta.tests), zipf,
      harder: (kind, text, lemma, cefr) => {
        if (belowLevel(cefr, cefrMine)) return false;
        const n = kind === 'phrase' ? phraseDifficulty(cefr) : wordNumber(zipf(text), zipf(lemma), cefr);
        if (n === null || !harderThan(n, mine)) return false;
        numbers.set(`${kind}:${lemma}`, Math.max(n, numbers.get(`${kind}:${lemma}`) ?? 0));
        return true;
      },
    });
    const kept = keepHardest(all, explainPcts(), (lemma, kind) => numbers.get(`${kind}:${lemma}`) ?? 0, (lemma) => atStart[lemma] === 'learning');
    // (what is known by now, or set aside, goes out; nothing comes in)
    const gone = (l: string) => vocab.words[l] === 'known' || vocab.words[l] === 'ignored' || done.has(phraseSig(this.dict!, l));
    const list = kept.map((sc) => {
      const idx = sc.lemmas.map((_, i) => i).filter((i) => !gone(sc.lemmas[i]));
      if (idx.length === sc.lemmas.length) return sc;
      const kinds = idx.map((i) => sc.kinds[i]);
      return { ...sc, items: idx.map((i) => sc.items[i]), lemmas: idx.map((i) => sc.lemmas[i]), kinds, kind: stopKindOf(kinds) };
    });
    this.scores = new Map(list.map((s) => [s.key, s]));
    this.stopSet = selectStopsByLevel(list, this.caps());
    this.paintCounter();
  }
  /** the learner's words (and the phrases known or set aside) as they were when this video opened: the share is taken of these */
  private rankWords: Record<string, WordStatus> | null = null;
  private rankDone: Set<string> | null = null;
  /** the school level the video's hard sentences were found for (with the analysis; '' = not known) */
  private hardLevel = '';
  levelChanged(): void { this.recomputeStops(); }
  /** the device went dark or light (Look: Auto follows it) */
  lookChanged(): void { this.applyLook(); }

  private heardSentence(pos: Position): void {
    // (the "words heard" counter: a sentence counts once; it is saved with where you are in the video)
    const s = this.vb ? getSentence(this.vb.book, pos) : null;
    if (s) this.wordsHeard.hear(sentenceKey(pos), this.wordsBefore(pos), s.sentence.tokens.filter((t) => t.kind === 'word').length);
    if (!this.levelOn()) return;
    this.heardKeys.add(sentenceKey(pos));
    this.paintCounter();
    this.planAnalysis();
  }

  /** the three switches: Words, Phrases, Sentences (1 = on, 0 = off: never explained by itself) */
  private caps(): StopCaps {
    const c = (on: boolean | undefined) => (on === false ? 0 : 1);
    return { word: c(extras.stopItemsOn), phrase: c(extras.stopPhrasesOn), sentence: c(extras.stopHardOn) };
  }
  private wordsBefore(pos: Position): number {
    if (!this.vb) return 0;
    this.offsets ??= wordOffsets(this.vb.book);
    return this.offsets(pos);
  }
  /**
   * asked or explained within the last extras.repeatWords (1,000) words HEARD: not again so soon. The words are counted
   * across videos: a word explained near the end of one video is not explained again early in the next (heard.ts).
   */
  private askedLately(lemma: string, here: number): boolean {
    return this.wordsHeard.lately(lemma, here, extras.repeatWords ?? 1000);
  }
  /**
   * The daily review of the whole word list (review.ts): once a day, when a video opens; plain counting, no AI. Its
   * changes are saved like any other (and go to the online copy at once); the learner is told in one calm line.
   */
  private async runDailyReview(): Promise<void> {
    try {
      const o = await chrome.storage.local.get(REVIEW_KEY);
      const last = (o[REVIEW_KEY] as { day?: string } | undefined)?.day;
      const now = new Date();
      if (!reviewDue(last, now) || !this.dict) return;
      // (the day is written first: two windows open at once review once)
      await chrome.storage.local.set({ [REVIEW_KEY]: { day: dayKey(now) } });
      const entries = await store.getEntries();
      const dict = this.dict, zipf = this.zipf, mine = myLevel();
      const r = dailyReview({
        words: vocab.words, entries, knownAfter: extras.knownAfter ?? 7, now, myLevel: mine, statusAt: (lemma) => levelMeta.log?.[lemma]?.date,
        numberOf: (lemma) => wordNumber(zipf(lemma), null, dict.lookup(lemma)?.entry.level ?? null),
      });
      for (const lemma of r.nowKnown) { this.controller?.markKnown(lemma); await this.changeStatus(lemma, 'known'); }
      for (const lemma of r.backToLearn) await this.changeStatus(lemma, 'learning');
      await chrome.storage.local.set({ [REVIEW_KEY]: { day: dayKey(now), nowKnown: r.nowKnown.length, back: r.backToLearn.length, suggested: r.suggested, known: r.known, learning: r.learning } });
      const text = reviewText(r, mine);
      if (text && !this.disposed) setTimeout(() => { if (!this.disposed) this.toast(text, 9000); }, 6000);
    } catch { /* tomorrow again */ }
  }
  heardCameIn(state: unknown): void { this.wordsHeard.merge(state as never); }
  private saveHeard(): void {
    if (!this.wordsHeard.dirty) return;
    this.wordsHeard.dirty = false;
    void store.setHeard(this.wordsHeard.state(extras.repeatWords ?? 1000)).catch(() => undefined);
  }

  /**
   * This sentence stops now, or not: one of the hardest of its kind, not stopped at before, and never over the share
   * of its kind so far. With hard words or phrases in it the stop asks them one by one ("Do you know …?").
   */
  private levelStopAt(pos: Position): { lemma: string; items: { kind: 'word' | 'phrase'; target: string; lemma: string }[] } | null {
    const key = sentenceKey(pos);
    this.heardKeys.add(key);
    const text = this.vb ? getSentence(this.vb.book, pos)?.text : null;
    if (!text || !this.stopSet.has(key) || this.doneBefore.has(key) || this.stopped.has(key)) return null;
    // (no API key yet: nothing could be explained, so no stop; free mode explains nothing and needs none)
    if (this.ai() && !this.keys.anthropic && !this.keys.openai) return null;
    if (this.asleep) return null;
    const sc = this.scores.get(key);
    if (!sc) return null;
    const here = this.wordsBefore(pos);
    const caps = this.caps();
    // (only the groups that are on: words off = no stop for a word)
    const items = sc.lemmas.map((lemma, i) => ({ kind: sc.kinds[i], target: sc.items[i], lemma }))
      .filter((it) => caps[it.kind] > 0 && vocab.words[it.lemma] !== 'known' && vocab.words[it.lemma] !== 'ignored' && !this.askedLately(it.lemma, here));
    // (its hard words were all asked a moment ago, or are known by now: nothing to stop for)
    const sentenceStop = kindWith(sc, caps) === 'sentence';
    if (!items.length && !sentenceStop) return null;
    const group: StopGroup = items.length ? stopKindOf(items.map((it) => it.kind)) : 'sentence';
    if (!(this.caps()[group] > 0)) return null;
    this.trigger = { key, group };
    return { lemma: sentenceLemma(text), items };
  }

  private countStop(pos: Position): void {
    const key = sentenceKey(pos);
    if (!this.stopped.has(key)) {
      this.stopped.add(key); this.autoStops++;
      this.stopsBy[this.trigger?.key === key ? this.trigger.group : 'sentence']++;
    }
    this.paintCounter();
    // what it explains is to learn now, with this sentence
    const sc = this.scores.get(key);
    const text = this.vb ? getSentence(this.vb.book, pos)?.text ?? '' : '';
    sc?.lemmas.forEach((lemma, i) => { if (!vocab.words[lemma]) { vocab.words[lemma] = 'learning'; void store.setWordStatus(lemma, 'learning', { word: sc.items[i], sentence: text }); } });
  }

  /** the small counter: stops made / sentences so far */
  private paintCounter(): void {
    if (!this.levelOn() || this.disposed) { this.counterEl?.remove(); this.counterEl = null; return; }
    if (!this.counterEl || !this.counterEl.isConnected) {
      const el = document.createElement('div');
      el.id = 'dr-stop-counter';
      el.title = 'Stops made / sentences so far';
      el.style.cssText = TOUCH
        ? 'position:fixed;top:calc(3px + env(safe-area-inset-top));right:6px;z-index:2147483000;background:rgba(31,35,40,.6);color:#fff;border-radius:8px;padding:0 6px;font:10px/1.5 -apple-system,system-ui,sans-serif;pointer-events:none;opacity:.6'
        : 'position:fixed;top:60px;right:10px;z-index:2147483000;background:rgba(31,35,40,.82);color:#fff;border-radius:10px;padding:2px 8px;font:12px/1.5 -apple-system,system-ui,sans-serif;pointer-events:none';
      document.body.appendChild(el);
      this.counterEl = el;
    }
    this.counterEl.textContent = counterText(this.autoStops, this.heardKeys.size);
  }

  /** (Level Check) the hard rule goes with the request of an explanation */
  private withRule(req: ExplainRequest): ExplainRequest {
    if (!this.levelOn()) return req;
    if (req.question || (req.kind !== 'word' && req.kind !== 'phrase' && req.kind !== 'sentence')) return { ...req, levelCheap: true } as RuleRequest;
    const sc = req.position ? this.scores.get(sentenceKey(req.position)) : undefined;
    const known = new Set<string>();
    if (req.position && this.vb && this.dict) for (const t of getSentence(this.vb.book, req.position)?.sentence.tokens ?? []) if (t.kind === 'word' && vocab.words[this.dict.lemmaOf(t.text)] === 'known') known.add(t.text.toLowerCase());
    const levelRule: LevelRule = { items: req.kind === 'sentence' ? sc?.items ?? [] : [req.target], known: [...known], level: levelMeta.currentLevel || settings.learnerLevel, way: settings.ai.activeStyle, length: teachLength(), song: this.songNotes(req.position ?? null) };
    return { ...req, levelRule } as RuleRequest;
  }

  private async checkKey(): Promise<void> {
    const keys = await store.getKeys();
    if (!keys.anthropic && !keys.openai) this.toast('Add your Claude or OpenAI API key (⚙ → API keys), so the tutor can explain.', 9000);
  }

  keysChanged(keys: store.Keys): void {
    const before = JSON.stringify(this.keys);
    this.keys = keys;
    if (before !== JSON.stringify(keys)) { this.applyVoice(); this.renderQuickIfOpen(); this.renderTalk(); }
  }

  // ---- the teacher ------------------------------------------------------------------------------------------
  private setupController(): void {
    const vb = this.vb!;
    const start = vb.order[0];
    this.playback = new Playback(vb.book, { engine: () => this.engine, voice: () => ({ voiceId: this.voiceId, rate: settings.voice.rate }), pauseMs: () => 0 }, start);
    this.controller = new ListenController(this.playback, {
      book: vb.book, dict: this.dict!, names: this.names,
      settings: () => this.leanSettings(), vocab: () => vocab,
      marked: () => [],
      sentenceTrigger: (pos) => { const l = extras.stopSentences ? this.hardKeys.get(sentenceKey(pos)) : undefined; return l ? { lemma: l } : null; },
      engine: () => this.wordOut!, explainEngine: () => this.teachOut!, zhEngine: () => this.zhOut!,
      voice: () => ({ voiceId: this.voiceId, rate: settings.voice.rate }),
      explainVoice: () => ({ voiceId: this.voiceKind === 'mac' ? (settings.voice.explainVoiceId || this.voiceId) : this.voiceId, rate: Math.min(settings.voice.rate, 1.2) }),
      // (Chinese Bridge speaks Chinese on purpose)
      // (Level Check: the explanations have no Chinese)
      zhVoiceId: () => (this.levelOn() ? null : settings.ai.speakChinese || settings.ai.activeStyle === 'way-bridge' ? this.zhVoice : null),
      mixedVoice: () => this.saysChineseItself(),
      contextZh: (lemma) => this.hints[lemma],
      explain: (req0, onDelta0) => {
        // (never in free mode: nothing there asks for an explanation; this is the last guard against a cost)
        if (!this.ai()) throw new Error('free mode: no AI');
        const req = this.withRule(req0);
        (window as unknown as { __drRequests?: ExplainRequest[] }).__drRequests?.push(structuredClone(req));
        // (Level Check) nothing reaches the voice before it passed the rule's check
        const guard = this.levelOn() && req.kind !== 'question' ? new RuleGuard((req as RuleRequest).levelRule ? { sentence: req.sentence, items: req.kind === 'sentence' ? [] : [req.target] } : {}) : null;
        const onDelta = guard ? (full: string) => onDelta0(guard.push(full)) : onDelta0;
        const checked = <T extends { done: Promise<{ text: string; usage: { usd: number; dailyUsd: number; monthlyUsd: number } }>; cancel(): void }>(job: T) => (guard ? { done: job.done.then((res) => { const text = guard.finish(res.text); this.ruleRejects += guard.rejected; return { ...res, text }; }), cancel: () => job.cancel() } : job);
        // (lyrics mode: a stop for a whole line that has its own note = the note is read; no AI request)
        const lineNote = req.kind === 'sentence' && req.target === req.sentence && !req.again && !req.question ? this.lyricNote(req.position) : undefined;
        if (lineNote) { onDelta0(`${lineNote} `); return { done: Promise.resolve({ text: lineNote, usage: { usd: 0, dailyUsd: 0, monthlyUsd: 0 } }), cancel: () => undefined }; }
        // (Level Check) the explanation was written once, ahead of the stop: no AI call here
        const analysis = this.analysis;
        if (analysis && (req.kind === 'word' || req.kind === 'phrase' || (req.kind === 'sentence' && req.target === req.sentence)) && (req as RuleRequest).levelRule && !req.again) {
          const id = stopId(req.sentence, req.kind === 'sentence' ? undefined : req.target);
          let cancelled = false;
          let live: { done: Promise<{ text: string; usage: { usd: number; dailyUsd: number; monthlyUsd: number } }>; cancel(): void } | null = null;
          return {
            // (still being written after a few seconds: this one is asked for alone, so the stop is never silent for long)
            done: Promise.race([analysis.wait(id), new Promise<null>((r) => setTimeout(() => r(null), ANALYSIS_WAIT_MS))]).then((text) => {
              if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
              if (text !== null) { onDelta0(`${text} `); return { text, usage: { usd: 0, dailyUsd: 0, monthlyUsd: 0 } }; }
              // (the analysis did not write this one: only this one is asked for)
              live = checked(aiExplain(req, onDelta));
              return live.done;
            }),
            cancel: () => { cancelled = true; live?.cancel(); },
          };
        }
        // asked for already when the video stopped: the voice starts at once
        const pre = this.takePrefetch(req, onDelta);
        if (pre) return checked(pre);
        const r = req.kind === 'passage' ? { ...req, seconds: settings.listen.lastSecondsWindow } as ExplainRequest : req;
        return checked(aiExplain(r, onDelta));
      },
      directStop: () => this.levelOn(),
      directTrigger: (pos) => this.levelStopAt(pos),
      // free mode: the word (or the sentence) once, the card for a few seconds, never an explanation
      freeStop: () => !this.ai(),
      freeWindowMs: () => clamp(extras.freeWindowSec ?? 7, 3, 20) * 1000,
      mode: () => 'listening',
      onCommandWindow: (w) => this.onWindow(w),
      onPauseWindow: (open) => { this.windowOpen = open; },
      onStopTarget: (t) => this.onStopTarget(t),
      // (after the explanation the word is said again. The card stays for that, the big one of a stop and the small
      // one of a tapped word alike: it closes when the sentence starts to play again (the learner's rule of 13 Nov))
      onWordAgain: () => undefined,
      // (the word was said three times: the card closes NOW, before the sentence plays again (the learner's rule of 14 Nov))
      onSentenceAgain: () => { if (this.card) this.closeCard(); },
      // (the learner's rule of 14 Nov: the word once, the explanation, the word three times, the sentence once)
      sayBefore: () => clamp(extras.sayBefore ?? 1, 0, 10),
      sayAfter: () => clamp(extras.sayAfter ?? 3, 0, 10),
      // no talk after explanations: a short moment ("I don't know" = explain again), then the video goes on
      afterWindowMs: () => (talkAfter() ? (settings.listen.commandWindowMs || 5000) : 1500),
      thinkPauseMs: () => (/^A/i.test(settings.learnerLevel) ? 3000 : 4500),
      // stopping now and then (not at every hard word): one item per stop, the hardest
      maxItemsPerStop: () => ((extras.stopGapSec ?? 45) > 0 ? 1 : 0),
      // every phrase and hard sentence above your level stops; single words at most every stopGapSec seconds
      stopFilter: (kind, pos) => {
        const gap = extras.stopGapSec ?? 45;
        if (gap < 0) return false;
        // explained the last time this video was watched
        if ((kind === 'phrase' || kind === 'sentence') && this.doneBefore.has(sentenceKey(pos))) return false;
        if (kind !== 'word' || gap === 0 || this.lastStopAt === null) return true;
        const at = this.vb?.timingOf(pos)?.start;
        return at === undefined || Math.abs(at - this.lastStopAt) >= gap;
      },
      onTranscript: (e) => this.onTranscript(e),
      onMarkLearning: (lemma) => { if (!vocab.words[lemma]) void this.changeStatus(lemma, 'learning'); },
      onBudget: (daily, monthly) => { if (settings.ai.dailyWarnUsd > 0 && daily >= settings.ai.dailyWarnUsd) this.toast(`AI spending today: $${daily.toFixed(2)} (this month $${monthly.toFixed(2)})`); },
      chapterPhrases: (pos) => (this.phrases[sentenceKey(pos)] as unknown as ChapterPhrase[] | undefined),
      streamProse: () => true,
      phraseAsSentence: () => true,
    });
    this.controller.enabled = true;
    this.autoStops = 0; this.stopsBy = { word: 0, phrase: 0, sentence: 0 }; this.trigger = null; this.offsets = null; this.heardKeys.clear(); this.stopped.clear();
    this.recomputeStops();
    const pb = this.playback;
    // the part just explained plays again: no stops in it
    const stopAt = pb.hooks.stopAt;
    pb.hooks.stopAt = (pos) => {
      if (this.quietUntil) { if (comparePositions(pos, this.quietUntil) <= 0) return null; this.quietUntil = null; }
      // "Stops by itself: Off" = only when you pause (the older stops only; Level Check has its three switches)
      if ((extras.stopGapSec ?? 45) < 0 && !this.levelOn()) return null;
      return stopAt ? stopAt(pos) : null;
    };
    this.pbOffs.push(
      pb.on('sentence', (pos) => { this.engine.target = pos; this.setCurrent(pos); this.prefetchVoice(pos); this.heardSentence(pos); }),
      pb.on('word', (pos, ti) => this.setWord(pos, ti)),
      pb.on('state', (st) => this.onState(st)),
      pb.on('error', (e) => this.toast(e.message, 8000)),
      pb.on('finished', () => this.toast('End of the video.')),
    );
  }

  private onState(st: PlaybackState): void {
    // a stop at the end of a sentence: Playback waited for the sentence to end, the video plays on unless held here
    if (st === 'explaining') { this.engine.hold(); this.watchStop(); }
    // (a card kept for "the word again": whatever ends the explanation without the sentence playing closes it too)
    else if (this.cardKept && this.card) this.closeCard();
    if (st === 'playing') {
      // the reading goes on: the talk and the stop are over, the video comes back (normal mode); no card stays open
      if (this.card) this.closeCard();
      if (this.talk) this.closeTalk();
      if (!this.flow) { this.partKeys = null; if (!bookView()) this.hideStage(); else this.markPart(); }
    }
  }

  /**
   * The tutor explains a part (the last 20 s, "hello"): the line it is talking about goes on the play line, so you
   * always see what is being explained. It says each original sentence before it explains it, and hard words in
   * quotation marks.
   */
  private showLineOf(text: string): void {
    const vb = this.vb;
    if (!vb || !this.partKeys || this.partKeys.size < 2 || !this.stageVisible() || !this.controller?.busy) return;
    let pos = this.quotedSentence(text);
    if (!pos) {
      const part = vb.order.filter((p) => this.partKeys!.has(sentenceKey(p)));
      for (const m of text.matchAll(/["\u201C]([^"\u201D]{2,120})["\u201D]/g)) {
        const q = norm(m[1]);
        if (!q) continue;
        pos = part.find((p) => { const s = getSentence(vb.book, p); return !!s && ` ${norm(s.text)} `.includes(` ${q} `); }) ?? null;
        if (pos) break;
      }
    }
    if (!pos || (this.cur && sentenceKey(pos) === sentenceKey(this.cur))) return;
    this.userScrollAt = 0;
    this.setCurrent(pos);
    this.scrollToCur(true);
  }

  /** a stop where nothing is said for a long time (the voice or the AI did not come): the video plays on by itself */
  private watchStop(): void {
    if (this.stopWatch) return;
    this.lastVoiceAt = Date.now();
    this.stopWatch = setInterval(() => {
      if (this.disposed || this.playback?.state !== 'explaining') { if (this.stopWatch) clearInterval(this.stopWatch); this.stopWatch = null; return; }
      if (this.cmdWin || this.windowOpen || this.talk || this.flow || this.heldTalk || this.pttActive) { this.lastVoiceAt = Date.now(); return; }
      if (Date.now() - this.lastVoiceAt < SILENT_STOP_MS) return;
      this.lastVoiceAt = Date.now();
      this.trail('a silent stop: playing on');
      this.toast('The tutor stayed silent here: the video plays on.', 5000);
      this.byeBye(false);
    }, 2000);
  }

  /** the sleep timer ran out: everything stops, the microphone too */
  sleepNow(): void {
    if (!this.playback) { const v = video(); if (v && !v.paused) v.pause(); return; }
    this.closeTalk();
    this.stopAll();
    this.toast('Sleep timer: the video is paused. Good night.', 8000);
  }

  // ---- the AI reads the video first: complete sentences, then the hard words, phrases and sentences --------------
  private async runAiJobs(): Promise<void> {
    // (free mode: nothing is asked of the AI; the stops come from the dictionary)
    if (!this.ai()) { this.aiJobsDone = true; this.startAnalysis(); return; }
    const keys = await store.getKeys().catch(() => ({} as store.Keys));
    if (!keys.anthropic && !keys.openai) {
      // (said once, clearly: without a key the sentences stay as YouTube cut them)
      if (this.source === 'rule') this.toast('No AI key: the sentences stay as YouTube cut them (not complete). Add a key in Settings → API keys.', 8000);
      this.aiJobsDone = true; this.startAnalysis(); return;
    }
    // COMPLETE sentences for EVERY video: always done (once per video, then kept), whenever the subtitles are not good
    // official ones; a failed part is tried again, and the learner is told when it could not be done
    if (this.source === 'rule' && this.vb) {
      try {
        this.setStatus(`${this.statusText} · the AI is finding the complete sentences…`);
        const out = await splitWithAi(this.ruleSentences, complete, (d, n) => { if (n > 1) this.setStatus(`${this.statusText.split(' · the AI')[0]} · the AI is finding the complete sentences… ${d}/${n}`); });
        if (this.disposed) return;
        const words = flatten(this.ruleSentences);
        const ends: number[] = [];
        let k = -1;
        for (const s of out) { k += s.words?.length ?? 0; ends.push(k); }
        if (k === words.length - 1) await store.setSplit(this.cacheId(), { version: SPLIT_VERSION, words: words.length, ends, texts: out.map((s) => s.text) }).catch(() => undefined);
        await this.whenCalm();
        if (this.disposed) return;
        this.rebuild(out);
        this.setStatus(this.readyText());
        const failed = splitReport.filter((l) => !/: ok$/.test(l) && /^chunk \d+(:| \()/.test(l));
        const parts = new Set(failed.map((l) => /^chunk (\d+)/.exec(l)?.[1])).size;
        const okParts = splitReport.filter((l) => /: ok$/.test(l)).length;
        if (parts > 0 && okParts + parts > 0 && parts > okParts && !this.disposed) this.toast('The AI could not make complete sentences for most of this video: some lines are as YouTube cut them.', 8000);
      } catch (e) {
        if (!this.disposed) {
          this.setStatus(`${this.statusText.split(' · the AI')[0]} · complete sentences: ${(e as Error).message}`);
          this.toast(`Complete sentences could not be made for this video (${(e as Error).message.slice(0, 80)}). The lines are as YouTube cut them.`, 9000);
        }
      }
    }
    await this.runHintsJob();
    this.aiJobsDone = true;
    this.startAnalysis();
  }

  /** waits until nothing is going on (no stop, no explanation, no talk), so the book can change */
  private async whenCalm(): Promise<void> {
    for (let i = 0; i < 600 && !this.disposed; i++) {
      const c = this.controller;
      if (!c || (!c.busy && !this.cmdWin && !this.talk && !this.flow && this.playback?.state !== 'explaining')) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** the AI's sentences replace the first guess: a new book, the reading goes on where the video is */
  private rebuild(sentences: TimedSentence[]): void {
    const v = video();
    const t = v?.currentTime ?? 0;
    const playing = !!v && !v.paused && this.playback?.state === 'playing';
    this.pbOffs.forEach((f) => f());
    this.pbOffs = [];
    this.controller?.dispose();
    this.engine.target = null;
    this.playback?.stop();
    this.buildBook(sentences);
    this.source = 'ai';
    this.phrases = {};
    this.hardSentences = [];
    this.cur = null;
    this.render();
    this.setupController();
    const pos = this.vb!.positionAt(t) ?? this.vb!.order[0];
    if (playing) { this.engine.resumeHere = true; this.playback!.play(pos); }
    else this.playback!.seek(pos);
  }

  // ---- the learner uses YouTube's own controls ----------------------------------------------------------------
  private listenVideo(): void {
    const v = video();
    if (!v) return;
    const onPlay = () => {
      if (this.engine.isOwn('play') || window.__ytcApi?.isAd()) return;
      // play during a stop, a talk or your own part: that is "go on"
      if (this.talk || this.flow || this.cmdWin) { this.goOn(); return; }
      const pb = this.playback!, c = this.controller!;
      if (pb.state === 'playing') return;
      if (c.busy || pb.state === 'explaining') c.skip();
      this.engine.resumeHere = true;
      pb.play(this.vb!.positionAt(v.currentTime) ?? undefined);
    };
    const onPause = () => {
      if (this.engine.isOwn('pause') || v.ended || window.__ytcApi?.isAd()) return;
      const pb = this.playback!;
      const pausedAt = Date.now();
      setTimeout(() => {
        if (!v.paused || v.seeking || this.disposed) return;
        if (this.flow) { if (this.flow.wake) this.flow.wake(); return; } // paused during the replay: straight to the explanation
        if (pb.state !== 'playing') return; // already stopped (an explanation, a stop)
        // you stopped the video: the part plays again on the page, the teacher breaks it down (or just pause)
        this.trail('you paused the video');
        // (a phone: the microphone going on or off can stop the video's sound for a moment: that was not you)
        const micAt = window.__ytcApi?.micChangedAt?.() ?? 0;
        if (TOUCH && !asleep && pausedAt >= micAt && pausedAt - micAt < 1500 && Date.now() - this.lastSelfResume > 6000) {
          this.lastSelfResume = Date.now();
          this.trail('the video stopped as the microphone changed: playing on');
          void v.play().catch(() => undefined);
          return;
        }
        // (Level Check: a pause is a pause, no AI; "Explain 30 s" asks for it)
        if (extras.explainOnStop && !this.levelOn()) void this.partFlow(v.currentTime, extras.replayPart, true);
        else { pb.pause(); if (TOUCH && !asleep) this.toast('The video is paused. ⏯ plays on.', 4000); }
      }, 120);
    };
    const onSeeking = () => {
      if (this.engine.isOwn('seek') || window.__ytcApi?.isAd()) return;
      const pb = this.playback!;
      const pos = this.vb!.positionAt(v.currentTime);
      if (!pos) return;
      this.endFlow();
      this.closeTalk();
      if (this.controller!.busy || this.cmdWin) this.controller!.skip();
      if (!v.paused) { this.engine.resumeHere = true; pb.play(pos); } else pb.seek(pos);
    };
    const onFs = () => this.placeStage();
    const onPlayState = () => { if (!v.paused) asleep = false; this.updateStopButton(); };
    v.addEventListener('play', onPlayState);
    v.addEventListener('pause', onPlayState);
    this.offs.push(() => { v.removeEventListener('play', onPlayState); v.removeEventListener('pause', onPlayState); });
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeking', onSeeking);
    document.addEventListener('fullscreenchange', onFs);
    this.offs.push(() => { v.removeEventListener('play', onPlay); v.removeEventListener('pause', onPause); v.removeEventListener('seeking', onSeeking); document.removeEventListener('fullscreenchange', onFs); });
    // One button mode: a touch on the video (or on its subtitles) = explain the last N seconds, like a touch on the page
    const onVideoTap = (ev: Event) => {
      if (!this.oneTap() || window.__ytcApi?.isAd()) return;
      const path = ev.composedPath();
      const onPlayer = path.some((n) => n instanceof HTMLElement && (n.id === 'movie_player' || n.id === 'player-container-id' || n.id === 'dr-band-host' || n.tagName === 'YTM-PLAYER' || n.tagName === 'VIDEO'));
      if (!onPlayer || path.some((n) => n instanceof HTMLElement && n.id === 'dr-stage-host')) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      this.oneTapExplain();
    };
    // (a finger: YouTube's player may stop the click of a touch, so a short, still touch counts by itself)
    let vDown: { x: number; y: number; at: number } | null = null;
    const onVideoDown = (ev: TouchEvent) => { const t = ev.touches[0]; vDown = t ? { x: t.clientX, y: t.clientY, at: Date.now() } : null; };
    const onVideoUp = (ev: TouchEvent) => {
      const d = vDown, t = ev.changedTouches[0];
      vDown = null;
      if (!d || !t || Date.now() - d.at > 500 || Math.hypot(t.clientX - d.x, t.clientY - d.y) > 12) return;
      onVideoTap(ev);
    };
    window.addEventListener('click', onVideoTap, true);
    window.addEventListener('touchstart', onVideoDown, { capture: true, passive: true });
    window.addEventListener('touchend', onVideoUp, true);
    this.offs.push(() => { window.removeEventListener('click', onVideoTap, true); window.removeEventListener('touchstart', onVideoDown, true); window.removeEventListener('touchend', onVideoUp, true); });
    // where you are is kept at once when the video stops or the app goes away (not only every 5 s while it plays),
    // so a paused video, or the app closed, opens there next time; never the time of an advert
    const onStopped = () => { if (!window.__ytcApi?.isAd() && v.currentTime > 0) this.keepSpot(v); };
    const onHidden = () => { if (document.visibilityState === 'hidden') onStopped(); };
    v.addEventListener('pause', onStopped);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onStopped);
    this.offs.push(() => { v.removeEventListener('pause', onStopped); document.removeEventListener('visibilitychange', onHidden); window.removeEventListener('pagehide', onStopped); });
  }

  /** where you are in this video, saved (next time it goes on from here: store.resumeAt) */
  private keepSpot(v: HTMLVideoElement): void {
    this.spotSavedAt = Date.now();
    void store.setSpot(this.videoId, { t: v.currentTime, d: v.duration || 0, at: Date.now() }).catch(() => undefined);
    this.saveHeard();
  }

  /** the panel follows the video when the teacher is not reading it (call mode, ads, paused, replays) */
  private follow(): void {
    if (this.disposed || !this.vb) return;
    // YouTube redrew its right column and dropped the panel: put it back
    if (this.panel && !this.panel.host.isConnected && placePanel(this.panel.host)) this.scrollToCur(true);
    const v = video();
    if (!v) return;
    const ad = !!window.__ytcApi?.isAd();
    if (ad !== this.lastAd) {
      this.lastAd = ad;
      // an advert plays in the same video element: the teacher waits, then picks the video up where it is
      if (ad) { this.engine.target = null; this.playback?.stop(); }
      if (!ad && !v.paused) { this.engine.resumeHere = true; this.playback?.play(this.vb.positionAt(v.currentTime) ?? undefined); }
    }
    if (ad) return;
    // where you are in this video (so next time it goes on from here)
    if (!v.paused && v.currentTime > 0 && Date.now() - this.spotSavedAt > 5000) this.keepSpot(v);
    const reading = this.playback?.state === 'playing';
    // (where the subtitles sit and the One button flag: a few times a second is enough; the words follow every time)
    if (++this.followTick % 5 === 0) { this.placeBand(); this.paintOneButton(); this.applySplit(); }
    // (the online copy: a look every 20 s while the page is in front; free when nothing changed. Changes made HERE
    // go online at once, by themselves.)
    if (this.keys.github && document.visibilityState === 'visible' && Date.now() - this.gistPollAt > 20_000) {
      this.gistPollAt = Date.now();
      void chrome.runtime.sendMessage({ type: 'dream-gist-poll' }).catch(() => undefined);
    }
    // (the microphone was refused: said once, where to allow it)
    const blocked = !!window.__ytcApi?.micBlocked?.();
    if (blocked && !this.micToldBlocked && this.wantsMic()) this.toast(micBlockedText(), 12000);
    this.micToldBlocked = blocked;
    // (the learner scrolled a moment ago: the page goes back to the line being heard by itself, like Speechify)
    if (this.userScrollAt && Date.now() - this.userScrollAt > 2000 && !this.card) { this.userScrollAt = 0; this.scrollToCur(true); }
    // (the tutor reads: its own word-by-word marks lead; the video's time still decides when they lag behind)
    if (reading && v.paused) return;
    if (v.paused && (this.playback?.state === 'explaining' || this.controller?.busy)) return; // the stop's sentence stays marked
    const pos = this.vb.positionAt(v.currentTime);
    if (!pos) return;
    if (!this.cur || sentenceKey(this.cur) !== sentenceKey(pos)) this.setCurrent(pos);
    const t = this.vb.timingOf(pos);
    if (t) {
      let wi = -1;
      for (let i = 0; i < t.tokenStart.length; i++) { const s = t.tokenStart[i]; if (s !== null && s <= v.currentTime + 0.03) wi = i; }
      if (wi !== this.curWord) this.setWord(pos, wi);
    }
  }

  // ---- the last N seconds, in complete sentences ------------------------------------------------------------------
  /** the sentences from about `seconds` before `time` up to the one being heard at `time` (whole sentences) */
  partAt(time: number, seconds: number): Position[] {
    const vb = this.vb;
    if (!vb) return [];
    const order = vb.order;
    const r = partRange(order.map((p) => vb.timingOf(p)!), time, seconds);
    return r ? order.slice(r[0], r[1] + 1) : [];
  }

  // ---- your own flows: you paused (the part), ← (a sentence), 📞 (talk) -------------------------------------------
  /** You stopped the video: the part plays again on the page, the teacher breaks it down, you talk, then the video goes back to the start of the part. */
  async partFlow(time?: number, playFirst = extras.replayPart, resumeAfter?: boolean): Promise<void> {
    const v = video(), pb = this.playback, c = this.controller;
    if (!v || !pb || !c || !this.vb) return;
    if (!this.ai()) { this.freeNote(); return; }
    // (after the explanation: back to how it was. Playing = it plays on; stopped = it stays stopped)
    const wasPlaying = resumeAfter ?? (pb.state === 'playing' || pb.state === 'explaining' || !v.paused);
    this.closeCard();
    this.endFlow();
    this.closeTalk();
    if (c.busy || this.cmdWin) c.skip();
    const at = time ?? v.currentTime;
    this.trail(`part at ${at.toFixed(1)}${playFirst ? ' (replay)' : ''}`);
    const part = this.partAt(at, settings.listen.lastSecondsWindow);
    if (!part.length) { pb.pause(); return; }
    pb.pause();
    const flow = this.flow = { kind: 'part' as const, part, abort: false, resumeAt: part[0], quietTo: part[part.length - 1] };
    this.showStage(part);
    // the page jumps to the part (the line being explained follows the tutor: showLineOf)
    this.userScrollAt = 0;
    this.setCurrent(part[0]);
    this.scrollToCur(true);
    this.preconnect();
    void playFirst;
    const text = part.map((p) => getSentence(this.vb!.book, p)?.text ?? '').filter(Boolean).join(' ');
    await c.explainNow('passage', text, part[0], null, undefined, undefined, false);
    if (flow.abort || this.flow !== flow) return;
    if (talkAfter() && !(flow as { bye?: boolean }).bye) await this.talkUntilGoOn(part[part.length - 1], undefined, this.lastExplanation());
    if (flow.abort || this.flow !== flow) return;
    // the whole part once more from the video (10, 20 or 30 s), then on after it (it was playing); stopped = it stays stopped
    if (!(flow as { bye?: boolean }).bye) { this.setCurrent(part[0]); this.scrollToCur(true); await this.replayPart(part, flow); }
    if (flow.abort || this.flow !== flow) return;
    this.flow = null;
    const last = part[part.length - 1], after = nextPosition(this.vb!.book, last);
    if (wasPlaying || (flow as { bye?: boolean }).bye) { if (after) this.continueFrom(after); else this.continueFrom(last, last); }
    else { this.setCurrent(last); if (normalView()) this.hideStage(); }
  }

  /** the part plays from the video once (you see it on the page); pausing or "go on" skips to the explanation */
  private replayPart(part: Position[], flow: NonNullable<Session['flow']>): Promise<void> {
    const v = video(), vb = this.vb;
    if (!v || !vb) return Promise.resolve();
    const a = vb.timingOf(part[0])!, b = vb.timingOf(part[part.length - 1])!;
    this.engine.markOwn('seek'); v.currentTime = Math.max(0, a.start - 0.15);
    this.engine.markOwn('play'); void v.play().catch(() => undefined);
    this.setTalkStatus('Listen again… (Enter = skip)');
    return new Promise<void>((resolve) => {
      const done = () => { clearInterval(tm); flow.wake = undefined; if (!v.paused) { this.engine.markOwn('pause'); v.pause(); } this.setTalkStatus(''); resolve(); };
      flow.wake = done;
      const tm = setInterval(() => { if (flow.abort || this.disposed || v.currentTime >= b.end - 0.02 || v.ended) done(); }, 50);
    });
  }

  /** ←: the last sentence is played, explained (RULE TWO) and played again, then the video goes on after it */
  explainSentence(): void {
    const v = video(), c = this.controller, vb = this.vb;
    if (!v || !c || !vb) return;
    if (!this.ai()) { this.freeNote(); return; }
    this.endFlow();
    this.closeTalk();
    // the LAST sentence: the newest one that has finished (not the one being heard now)
    const now = v.currentTime;
    let pos = vb.order[0];
    for (const p of vb.order) { const tm = vb.timingOf(p); if (tm && tm.end <= now + 0.15) pos = p; else break; }
    this.trail(`last sentence: ${getSentence(vb.book, pos)?.text.slice(0, 40) ?? '?'}`);
    const st = this.playback?.state;
    this.explainSentenceAt(pos, st === 'playing' || st === 'explaining' || !v.paused, true);
  }

  /**
   * One sentence, taught: played from the video, explained (RULE TWO, the original line first), played again. From ←
   * (the page shows the part around it) or from the Explain button of a sentence on the page (the page stays).
   */
  explainSentenceAt(pos: Position, wasPlaying = false, showPart = false): void {
    const v = video(), c = this.controller, vb = this.vb;
    if (!v || !c || !vb) return;
    if (!this.ai()) { this.freeNote(); return; }
    const s = getSentence(vb.book, pos);
    if (!s) return;
    this.closeCard();
    this.endFlow();
    this.closeTalk();
    if (c.busy || this.cmdWin) c.skip();
    this.playback?.pause();
    if (showPart || !this.stageVisible()) this.showStage(this.partAt(vb.timingOf(pos)!.end - 0.01, settings.listen.lastSecondsWindow));
    this.setCurrent(pos);
    // the page jumps to this sentence: all of it on the screen, on the play line
    this.userScrollAt = 0;
    this.scrollToCur(true);
    this.engine.target = pos;
    const next = nextPosition(vb.book, pos) ?? pos;
    const flow = this.flow = { kind: 'sentence' as const, part: [pos], abort: false, resumeAt: next, quietTo: null };
    this.preconnect();
    void (async () => {
      // (the learner's rules: the sentence is heard from the video, explained, heard again; Level Check's own
      // script has no sentence steps, so they are played here)
      if (this.levelOn()) await this.replayPart([pos], flow);
      if (flow.abort || this.flow !== flow) return;
      // (the big card: the sentence and its translation, no pronunciation; it closes before the sentence plays again)
      if (TOUCH && cardBig()) this.openCard(pos, -1, sentenceLemma(s.text), s.text, 'sentence', null);
      await c.explainNow('sentence', s.text, pos, null, sentenceLemma(s.text), undefined, false);
      if (this.card?.kind === 'sentence' && sentenceKey(this.card.pos) === sentenceKey(pos)) this.closeCard();
      if (flow.abort || this.flow !== flow) return;
      if (talkAfter() && !(flow as { bye?: boolean }).bye) await this.talkUntilGoOn(pos, undefined, this.lastExplanation());
      if (flow.abort || this.flow !== flow) return;
      this.flow = null;
      // playing before: the sentence again, then on; stopped before: it stays stopped (bye bye: from the sentence)
      // (without Level Check the sentence script already played it before and after: on after it)
      if ((flow as { bye?: boolean }).bye) this.continueFrom(pos);
      else if (wasPlaying) { if (this.levelOn()) this.continueFrom(pos, pos); else this.continueFrom(next); }
      else { this.setCurrent(pos); if (normalView()) this.hideStage(); }
    })().catch(() => { if (this.flow === flow) this.flow = null; });
  }

  /** 📞 / Shift+T: talk to the tutor about what is on the screen now */
  async callTutor(): Promise<void> {
    if (!this.vb) return;
    if (!this.ai()) { this.freeNote(); return; }
    this.trail('call');
    if (this.talk) { this.goOn(); return; }
    const v = video();
    const c = this.controller!;
    if (c.busy || this.cmdWin) c.skip();
    this.endFlow();
    this.playback?.pause();
    const pos = this.playback?.position ?? this.vb.positionAt(v?.currentTime ?? 0) ?? this.vb.order[0];
    const part = this.partAt(v?.currentTime ?? 0, settings.listen.lastSecondsWindow);
    const flow = this.flow = { kind: 'call' as const, part, abort: false, resumeAt: pos, quietTo: null };
    // (a phone: a call shows nothing but its End call button)
    if (!TOUCH) this.showStage(part.length ? part : [pos]);
    this.closeCard();
    await this.talkUntilGoOn(pos, undefined, undefined, true);
    if (flow.abort || this.flow !== flow) return;
    this.flow = null;
    this.continueFrom(pos);
  }

  private lastExplanation(): string | undefined {
    const e = [...this.transcript].reverse().find((x) => x.kind !== 'question' && x.status === 'done');
    return e?.text;
  }

  /** back to the video: from the start of `pos`, no stops up to `quietTo` */
  private continueFrom(pos: Position, quietTo?: Position): void {
    if (!this.playback || this.disposed) return;
    this.trail(`continue from ${this.vb?.timingOf(pos)?.start.toFixed(1) ?? '?'}`);
    this.quietUntil = quietTo ?? null;
    this.engine.resumeHere = false;
    this.playback.play(pos);
  }

  private endFlow(): void {
    const f = this.flow;
    if (!f) return;
    f.abort = true;
    this.flow = null;
    f.wake?.();
  }

  /** "go on" / Enter / ▶ / play / continue_video: whatever is open ends and the video goes on */
  goOn(): void {
    const c = this.controller;
    if (!c) return;
    const t = this.talk;
    this.trail(`go on${this.heldTalk ? ' (held)' : ''}${this.talkWaiter ? ' (waiter)' : ''}${this.flow ? ` (flow ${this.flow.kind})` : ''}`);
    if (this.heldTalk) { this.heldTalk = false; this.closeTalk(); c.release(true); if (this.playback?.state !== 'playing' && t?.pos) this.continueFrom(t.pos); return; }
    if (this.talkWaiter) { const w = this.talkWaiter; this.talkWaiter = null; this.closeTalk(); w(); return; }
    if (this.flow?.wake) { this.flow.wake(); return; } // the replay: on to the explanation
    this.closeTalk();
    if (this.flow && c.busy) { c.skip(); return; } // your own flow: the explanation stops, the flow goes on
    if (c.stopWindow) { c.answerWindow('bye'); return; }
    if (this.cmdWin) { c.continueNow(); const pos = t?.pos ?? this.playback?.position; setTimeout(() => { if (this.playback?.state !== 'playing' && !c.busy && !this.cmdWin && pos) this.continueFrom(pos); }, 120); return; }
    if (c.busy) { c.skip(); return; }
    const pos = t?.pos ?? this.playback?.position ?? null;
    if (pos && this.playback?.state !== 'playing') this.continueFrom(pos);
  }

  // ---- the talk: a live voice call (OpenAI realtime) or the speech recognition + the tutor ---------------------------
  private talkWaiter: (() => void) | null = null;

  /** OpenAI realtime: chosen, with an OpenAI key */
  private liveAvailable(): boolean { return !!this.keys.openai && extras.liveOn && extras.callEngine === 'openai'; }
  /** the call with Claude: any AI key (the voice is the tutor's own) */
  private chatAvailable(): boolean { return extras.liveOn && (!!this.keys.anthropic || !!this.keys.openai); }

  private newChat(): ChatCall {
    const chat: ChatCall = new ChatCall({
      system: () => { const t = this.talk; return this.liveContext(t?.word, t?.explanation, true); },
      speak: (text, lang) => {
        if (lang === 'zh') return this.zhVoice ? this.zhOut?.speak(text, { voiceId: this.zhVoice, rate: settings.voice.rate }) ?? null : null;
        return this.teachOut?.speak(text, { voiceId: this.voiceId, rate: settings.voice.rate }) ?? null;
      },
      mixed: () => this.saysChineseItself() && !!this.zhVoice,
      prefetch: (text, lang) => {
        if (lang === 'zh') { if (this.zhVoice) this.zhOut?.prefetch(text, this.zhVoice, settings.voice.rate); }
        else this.teachOut?.prefetch(text, this.voiceId, settings.voice.rate);
      },
      cancelSpeech: () => { this.tts?.cancelAll(); this.zhTts?.cancelAll(); },
      line: (id, text, final) => { const t = this.talk; if (t?.chat === chat) this.putLine(t, { id, who: 'tutor', text, final }); },
      changed: () => { if (this.talk?.chat === chat) this.renderTalk(); },
      error: (m) => { this.toast(m, 9000); },
      spoke: () => { this.lastTtsEnd = Date.now(); },
    });
    return chat;
  }
  private liveVoice(): string { return LIVE_VOICES.has(extras.openaiVoice) ? extras.openaiVoice : 'marin'; }

  /** what the live tutor knows right now */
  private liveContext(word?: string, explanation?: string, byText = false): string {
    const vb = this.vb!;
    const part = this.partKeys && this.partKeys.size ? vb.order.filter((p) => this.partKeys!.has(sentenceKey(p))) : this.partAt(video()?.currentTime ?? 0, settings.listen.lastSecondsWindow);
    const lines = part.map((p) => getSentence(vb.book, p)?.text ?? '').filter(Boolean);
    const a = part.length ? vb.timingOf(part[0])!.start : 0, b = part.length ? vb.timingOf(part[part.length - 1])!.end : 0;
    const hints = Object.entries(this.hints).filter(([l]) => lines.some((x) => x.toLowerCase().includes(l))).slice(0, 12).map(([l, z]) => `${l} = ${z.filter(Boolean).join('，')}`).join('; ');
    return liveInstructions({ teacher: extras.teacher, level: settings.learnerLevel, title: vb.book.title, part: lines, from: clock(a), to: clock(b), word, explanation, hints, byText });
  }

  private newCall(word?: string, explanation?: string): LiveCall {
    const call: LiveCall = new LiveCall({ model: extras.liveModel, voice: this.liveVoice(), instructions: this.liveContext(word, explanation), transcribe: true, mic: extras.micLevel ?? 2, volume: this.volumeOf('teacher') }, {
      state: (s, detail) => {
        const t = this.talk;
        // the connection dropped during a talk: one automatic reconnect with the same context
        if (s === 'error' && t?.live === call && !t.reconnected && /lost|did not open|connection/i.test(detail ?? '')) {
          t.reconnected = true;
          this.toast('The live voice dropped. Reconnecting…', 4000);
          const again = this.newCall(t.word, t.explanation);
          t.live = again;
          again.setMic(true);
          this.renderTalk();
          return;
        }
        if (s === 'error' && detail) {
          if (t?.live === call) {
            t.live = null; t.error = detail;
            // the OpenAI call does not work (no credit, no microphone…): talk with Claude instead
            if (this.chatAvailable() && !t.chat) { t.chat = this.newChat(); t.chat.greet(); this.toast(`The OpenAI live call did not work (${detail}). You talk with Claude now.`, 9000); }
            this.renderTalk();
          } else this.toast(detail, 9000);
          if (this.pre === call) this.pre = null;
        } else if (detail) this.toast(detail, 6000);
        if (t?.live === call) this.renderTalk();
      },
      user: (text, final, id) => {
        const t = this.talk;
        if (!t || t.live !== call) return;
        this.putLine(t, { id: `u${id}`, who: 'you', text, final });
        // a short "go on" said in the call (the tutor calls continue_video too)
        if (final) { const d = detectCommand(text); if (d.intent === 'bye' && text.split(/\s+/).length <= 5 && d.score >= 0.8) setTimeout(() => { if (this.talk === t) this.goOn(); }, 600); }
      },
      ai: (text, final, id) => { const t = this.talk; if (t && t.live === call) this.putLine(t, { id: `a${id}`, who: 'tutor', text, final }); },
      speaking: () => this.renderTalk(),
      hearing: (on) => { const t = this.talk; if (t && t.live === call) { t.hearing = on; this.renderTalk(); } },
      tool: (name, args) => {
        if (name === 'continue_video') { setTimeout(() => this.goOn(), 400); return { ok: true }; }
        if (name === 'mark_word') {
          const w = String(args.word ?? '').trim();
          const lemma = (w.includes(' ') ? w.toLowerCase() : this.dict?.lemmaOf(w)) || w.toLowerCase();
          if (lemma) { const st = args.status === 'known' ? 'known' : 'learning'; if (st === 'known') this.controller?.markKnown(lemma); void this.changeStatus(lemma, st); }
          return { ok: true, saved: lemma };
        }
        return { ok: false };
      },
      usage: (usage, model) => { void chrome.runtime.sendMessage({ type: 'dream-usage', model, usage }).catch(() => undefined); },
    });
    return call;
  }

  /** the explanation is starting: connect the live call now (mic off), so it is ready when the talk opens */
  private preconnect(): void {
    if (!talkAfter() || !this.liveAvailable() || this.pre || (this.talk && this.talk.live)) return;
    this.pre = this.newCall();
  }

  /** opens the talk (or turns the mic back on): after an explanation, or 📞 */
  private openTalk(pos: Position, word?: string, explanation?: string, greet = false): void {
    if (!this.ai()) return;
    if (!TOUCH && normalView() && extras.stageOn && !this.stageShown) this.showStage(this.partAt((this.vb?.timingOf(pos)?.end ?? 0) - 0.01, settings.listen.lastSecondsWindow));
    let t = this.talk;
    const fresh = !t;
    if (!t) {
      t = this.talk = { live: null, chat: null, pos, word, explanation, log: [], hearing: false, started: Date.now(), timer: setInterval(() => this.talkTick(), 1000) };
    } else { t.pos = pos; if (word) t.word = word; if (explanation) t.explanation = explanation; t.started = Date.now(); }
    if (this.liveAvailable() && !t.live && !t.error) {
      const call = this.pre && !this.pre.isClosed ? this.pre : this.newCall(word, explanation);
      this.pre = null;
      t.live = call;
      // the call may still be connecting: what is on the screen and the explanation go in once it is open
      const tk = t;
      void call.ready.then(() => {
        if (tk.live !== call) return;
        call.update(this.liveContext(tk.word, tk.explanation));
        if (greet) call.say('Greet the learner in a few words, in easy English, and ask what they would like to know about this part of the video.');
      }, () => undefined);
    } else if (t.live) t.live.update(this.liveContext(t.word, t.explanation));
    else if (!t.chat && this.chatAvailable()) { t.chat = this.newChat(); if (greet) t.chat.greet(); }
    t.live?.setMic(true);
    if (greet || this.heldTalk) t.call = true;
    if (fresh && this.cmdWin?.phase === 'after') this.controller?.keepWaiting(20_000);
    this.showCommandWindow(this.cmdWin);
    this.renderTalk();
  }

  /** your own flow waits here until you go on (or the quiet seconds pass) */
  private talkUntilGoOn(pos: Position, word?: string, explanation?: string, greet = false): Promise<void> {
    return new Promise<void>((resolve) => {
      this.talkWaiter = resolve;
      this.openTalk(pos, word, explanation, greet);
    });
  }

  private closeTalk(): void {
    const t = this.talk;
    if (!t) return;
    this.trail('the talk closes');
    this.talk = null;
    clearInterval(t.timer);
    if (this.still) { clearTimeout(this.still.timer); this.still = null; }
    t.live?.close();
    t.chat?.close();
    if (this.pre) { this.pre.close(); this.pre = null; }
    this.renderTalk();
  }

  /** the explanation (or the next one) is talking: the live call does not listen meanwhile (no echo) */
  private muteTalk(): void { const t = this.talk; if (t?.live) { t.live.setMic(false); if (t.live.speaking) t.live.interrupt(); } t?.chat?.interrupt(); }

  /** the microphone was refused when the talk bar was drawn last */
  private micWasBlocked = false;

  private talkTick(): void {
    const t = this.talk;
    if (!t) return;
    // the microphone was refused just now: the talk bar says so
    const blocked = !!window.__ytcApi?.micBlocked?.();
    if (blocked !== this.micWasBlocked) { this.micWasBlocked = blocked; this.renderTalk(); }
    // keep the stop's window open while we talk (Dream Read's window would end after a few seconds)
    if (this.cmdWin && this.cmdWin.phase === 'after') this.controller?.keepWaiting(20_000);
    // the short moment after an explanation ends after a few quiet seconds; a real call waits a minute for you
    const quiet = extras.talkSilenceSec > 0 && t.call ? Math.max(60, extras.talkSilenceSec) : extras.talkSilenceSec;
    if (quiet > 0 && !this.controller?.busy && !t.live?.speaking && !t.chat?.busy && !t.hearing) {
      const last = Math.max(t.started, t.live?.lastActivity ?? 0, t.chat?.lastActivity ?? 0, this.lastHeardAt, this.lastTtsEnd);
      if (Date.now() - last > quiet * 1000) this.goOn();
    }
  }

  private putLine(t: Talk, line: TalkLine): void {
    const i = t.log.findIndex((x) => x.id === line.id);
    if (i >= 0) t.log[i] = line; else t.log.push(line);
    if (t.log.length > 40) t.log.splice(0, t.log.length - 40);
    this.renderTalk();
  }

  /** the talk bar on the page and in the panel: who is talking, what was said */
  private renderTalk(): void {
    const t = this.talk;
    // (a phone: nothing of the talk is shown, only one "End call" button while a call is on)
    if (TOUCH) { this.renderCallButton(); return; }
    for (const r of [this.stage?.el, this.panel?.el]) {
      const box = r?.querySelector<HTMLElement>('.talk');
      if (!box) continue;
      if (!t) { box.hidden = true; box.innerHTML = ''; continue; }
      const live = t.live;
      const noLive = !live && !t.error && extras.liveOn && !this.keys.openai ? 'No live call: it needs your OpenAI key (⚙ → API keys). ' : '';
      const chat = t.chat;
      const blocked = !live && !!window.__ytcApi?.micBlocked?.();
      // (a real call opens the microphone even with voice commands off)
      const voiceOn = !blocked && (!!window.__ytcApi?.settings().voiceOn || this.callOpen());
      const state = chat ? (chat.lastError && !chat.busy ? `Claude did not answer: ${chat.lastError} · try again or type` : chat.thinking && !chat.speaking ? 'Asking Claude… (one moment)' : chat.speaking ? 'Your tutor is talking (say “stop” or press Space to interrupt)' : voiceOn ? 'Your turn: just talk, I am listening · or type · “go on” = back to the video' : blocked ? micBlockedText() : 'Type your question (voice: turn on Voice commands in the extension window)')
        : live ? (live.state === 'connecting' ? 'Connecting the live voice…' : live.speaking ? 'Your tutor is talking (just talk to interrupt)' : t.hearing ? 'Listening to you…' : 'Live call · talk to me') : t.error ? `Live voice off: ${t.error}` : blocked ? micBlockedText() : noLive + (voiceOn ? 'Talk to me (I am listening) · or type' : 'Type your question');
      const lines = t.log.slice(-6).map((l) => `<div class="tl ${l.who}${l.final ? '' : ' partial'}"><b>${l.who === 'you' ? 'You' : 'Tutor'}</b> ${esc(l.text)}</div>`).join('');
      // you are being heard (the words still change): Send gives them to the tutor now
      const lastLine = t.log[t.log.length - 1];
      const hearingYou = !!chat && !chat.busy && lastLine?.who === 'you' && !lastLine.final;
      box.hidden = false;
      box.innerHTML = `<div class="tlog">${lines}</div><div class="tbar"><span class="mic ${(live && live.state === 'ready') || (chat && voiceOn) ? 'on' : ''} ${t.hearing || (chat && !chat.busy && voiceOn) ? 'hot' : ''}"></span><span class="tstate">${esc(state)}</span><span class="grow"></span>
        ${hearingYou ? '<button data-act="send" class="primary" title="Send what I heard to your tutor now">Send ➤</button>' : ''}<button data-act="go" class="${hearingYou ? '' : 'primary'}">Go on ▶ <kbd>${esc(comboLabel(shortcutMap(extras.shortcuts).continue))}</kbd></button><button data-act="end" class="quiet" title="End the talk (the video stays paused)">✕</button></div>`;
      // (Send on press: the bar is drawn again with every word heard, a click could land on a button that is gone)
      box.onpointerdown = (ev) => { if ((ev.target as HTMLElement).closest('button')?.dataset.act === 'send') { ev.preventDefault(); this.sendHeard(); } };
      box.onclick = (ev) => {
        const act = (ev.target as HTMLElement).closest('button')?.dataset.act;
        if (act === 'go') this.goOn();
        else if (act === 'end') { const w = this.talkWaiter; this.talkWaiter = null; this.closeTalk(); if (w) { this.endFlow(); } }
      };
      const log = box.querySelector('.tlog');
      if (log) log.scrollTop = log.scrollHeight;
    }
  }

  private callBtn: HTMLButtonElement | null = null;
  /**
   * One button mode: NOTHING on the screen changes (the same page, the same text size, the same mode, the video, the
   * line moving); only a touch anywhere on the page or the video = explain the last N seconds. While the tutor
   * explains, asks, or a call or a card is open, touches do what they always do.
   */
  private oneTap(): boolean {
    return !!extras.oneButton && this.ai() && !this.flow && !this.controller?.busy && !this.cmdWin && !this.talk && !this.card && !this.quickRoot && this.playback?.state !== 'explaining';
  }
  /** a touch in One button mode: the last N seconds, explained (two touches at once count as one) */
  private oneTapExplain(): void {
    if (Date.now() - this.oneTapAt < 700) return;
    this.oneTapAt = Date.now();
    this.trail('one button: a touch = explain the last part');
    this.explainLast();
  }
  private oneTapAt = 0;
  private paintOneButton(): void {
    const el = this.stage?.el;
    if (el) el.dataset.one = this.oneTap() ? '1' : '0';
  }

  /** the one button of a call on a phone: at the bottom of the screen, gone when the call ends */
  private renderCallButton(): void {
    for (const r of [this.stage?.el, this.panel?.el]) { const box = r?.querySelector<HTMLElement>('.talk'); if (box) { box.hidden = true; box.innerHTML = ''; } }
    const on = !!this.talk?.call && !this.disposed;
    if (!on) { this.callBtn?.remove(); this.callBtn = null; return; }
    if (!this.callBtn || !this.callBtn.isConnected) {
      const b = document.createElement('button');
      b.id = 'dr-end-call';
      b.textContent = 'End call';
      // (big: at least 60 pt high and 200 wide, clear of the home line at the bottom)
      b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom) + var(--yt2c-bar-h, 0px));z-index:2147483200;border:0;border-radius:30px;min-height:60px;min-width:200px;padding:14px 32px;font:600 18px -apple-system,system-ui,sans-serif;color:#fff;background:#d93025;box-shadow:0 4px 16px rgba(0,0,0,.35);touch-action:manipulation';
      // (bye: the call ends and the video plays)
      b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); this.byeBye(false); };
      (document.fullscreenElement ?? document.body).appendChild(b);
      this.callBtn = b;
    }
  }

  private setTalkStatus(text: string): void {
    for (const r of [this.stage?.el]) { const el = r?.querySelector<HTMLElement>('.flowstate'); if (el) { el.textContent = text; el.hidden = !text; } }
  }

  // ---- answers (voice, keys, buttons) ----------------------------------------------------------------------
  answerKnow(): void {
    const c = this.controller; if (!c) return;
    if (c.stopWindow === 'before') this.dropPrefetch();
    const l = c.lastExplained;
    let cut = false;
    if (l?.lemma) { cut = c.markKnown(l.lemma); void this.changeStatus(l.lemma, 'known'); if (this.card?.lemma === l.lemma) this.closeCard(); }
    // (a stop whose word was still being said or explained: the stop goes on by itself, to its next word or to the video)
    if (cut && this.inStop && !c.stopWindow) return;
    if (this.talk && !c.stopWindow) { this.goOn(); return; }
    if (!c.answerWindow('know')) this.goOn();
  }
  answerDontKnow(): void {
    const c = this.controller; if (!c) return;
    if (c.answerWindow('dont_know')) return;
    const l = c.lastExplained;
    if (l?.lemma) void this.changeStatus(l.lemma, 'learning');
    if (this.ai()) void c.explainAgain();
  }
  answerGoOn(): void {
    const c = this.controller; if (!c) return;
    if (c.stopWindow === 'before') { c.answerWindow('bye'); return; }
    this.goOn();
  }
  /** "bye bye": the AI stops whatever it does, and the video plays again from the start of what was explained */
  /** "know" / "I know" / "bye" / "bye bye", said: a call ends (the video plays); a stop: known, the sentence again, on */
  knowBye(): void {
    const c = this.controller;
    if (!c) return;
    this.trail('know / bye');
    if (this.talk) { this.byeBye(false); return; }
    this.byeBye(true);
  }

  byeBye(know = true): void {
    const c = this.controller;
    if (!c) return;
    // "bye bye" at a stop is also "I know": its word, phrase or sentence is known from now on
    if (know && this.inStop && (c.busy || c.stopWindow)) {
      const l = c.lastExplained;
      if (l?.lemma) { c.markKnown(l.lemma); void this.changeStatus(l.lemma, 'known'); if (this.card?.lemma === l.lemma) this.closeCard(); }
    }
    this.dropPrefetch();
    if (this.flow) (this.flow as { bye?: boolean }).bye = true;
    if (this.talkWaiter) { const w = this.talkWaiter; this.talkWaiter = null; this.closeTalk(); w(); return; }
    this.closeTalk();
    if (this.flow?.wake) { this.flow.wake(); return; }
    if (c.busy || c.stopWindow) { this.engine.forceStart = true; c.skip(); return; } // a stop: back to the start of its sentence (played again)
    this.goOn();
  }

  // ---- voice mode: you talk, the tutor listens all the time ------------------------------------------------------
  /** a short command said alone; not when the video or the tutor itself just said that word */
  private voiceCommand(lower: string, final: boolean): (() => void) | null {
    if (!final) return null;
    const words = lower.replace(/[^a-z' ]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 4) return null;
    const first = words[0], two = words.slice(0, 2).join(' ');
    const echo = (re: RegExp) => this.videoSaying(re) || this.tutorSaying(re);
    // "hello" (said alone) = ALWAYS explain the last 10 / 20 / 30 s; a lone "hi" or "hey" is nothing ("hi bro" = the call: heard())
    if (/^(hello|hallo)$/.test(first) && words.length <= 2 && (extras.voiceMode || extras.micAlways) && !echo(/\b(hello|hallo)\b/i)) return () => this.voiceHello();
    if (!extras.voiceMode) return null;
    if (/^(stop|pause)$/.test(first) && !echo(/\b(stop|pause)\b/i)) return () => this.voiceStop();
    if ((/^(play|continue|resume)$/.test(first) || /^(go on|let'?s go)$/.test(two)) && !echo(/\b(play|continue|resume|go on|let'?s go)\b/i)) return () => this.voicePlay();
    return null;
  }

  /** the video's own subtitles around now contain this word (the microphone heard the video) */
  private videoSaying(re: RegExp): boolean {
    const v = video(), vb = this.vb;
    if (!v || !vb || v.paused) return false;
    const now = v.currentTime;
    return vb.order.some((p) => { const tm = vb.timingOf(p); return !!tm && tm.start <= now + 1 && tm.end >= now - 6 && re.test(getSentence(vb.book, p)?.text ?? ''); });
  }

  /** the tutor is saying (or just said) this word (the microphone heard the speaker) */
  private tutorSaying(re: RegExp): boolean {
    if (!(this.controller?.busy || this.talk?.chat?.busy || Date.now() - this.lastTtsEnd < 4000)) return false;
    const last = this.transcript[this.transcript.length - 1]?.text ?? '';
    const said = this.talk?.log.filter((l) => l.who === 'tutor').slice(-1)[0]?.text ?? '';
    return re.test(last.slice(-400)) || re.test(said.slice(-400));
  }

  /**
   * "hello" = ALWAYS the explanation of the last 10 / 20 / 30 s (the same as the Explain button), whether the video
   * plays or is stopped; it never opens a call. (The same "hello" twice within 2 s counts once.)
   */
  voiceHello(): void {
    if (!this.ai()) { this.freeNote(); return; }
    if (Date.now() - this.helloAt < 2000) return;
    this.helloAt = Date.now();
    if (!extras.voiceMode) {
      extras.voiceMode = true;
      void store.patchExtras({ voiceMode: true });
      this.toast(VOICE_HELP, 9000);
    }
    if (this.talk) return; // (in a call "hello" is just a word said to the tutor)
    if (this.flow?.kind === 'part') return; // (it is explaining a part already)
    this.trail('voice: hello = explain the last part');
    this.toast(`“hello”: the last ${settings.listen.lastSecondsWindow} s, explained`, 2500);
    void this.partFlow(video()?.currentTime, true);
  }
  private helloAt = 0;

  /** "hi bro" = ALWAYS a voice call with the tutor (the same as the Call button; "bye" ends it); never the explanation */
  voiceCall(): void {
    if (!this.ai()) { this.freeNote(); return; }
    if (this.talk) return; // (a call is open already)
    this.trail('voice: hi bro = the call');
    this.toast('“hi bro”: the call (say “bye” to end it)', 2500);
    void this.callTutor();
  }

  /** the quick control moved the tutor's volume: said on the screen; a live call follows at once */
  volumeStepped(pct: number): void {
    this.toast(`Tutor volume ${pct}%`, 1500);
    const v = this.volumeOf('teacher');
    this.talk?.live?.setVolume(v);
    this.pre?.setVolume(v);
  }

  /** 🎙 button: voice mode on / off */
  toggleVoiceMode(): void {
    const on = !extras.voiceMode;
    extras.voiceMode = on;
    void store.patchExtras({ voiceMode: on });
    this.toast(on ? VOICE_HELP : 'Voice off: the microphone only listens when the tutor waits for you.', on ? 9000 : 4000);
  }

  /** "stop": the video and the tutor stop; you can ask now ("play" goes on) */
  voiceStop(): void {
    const c = this.controller;
    this.talk?.chat?.interrupt();
    if (c?.busy) { this.interrupt(); return; } // the teacher stops; the talk opens
    this.tts?.cancelAll();
    this.endFlow();
    const v = video();
    if (v && !v.paused) { this.engine.markOwn('pause'); v.pause(); }
    this.playback?.pause();
    const pos = this.playback?.position ?? this.cur;
    if (pos && !this.talk) this.openTalk(pos);
    if (this.talk) this.talk.call = true;
    this.toast('Stopped. Ask me anything, or say “play”.', 4000);
  }

  /** "play": the tutor stops talking and the video plays */
  voicePlay(): void {
    const c = this.controller;
    this.talk?.chat?.interrupt();
    this.tts?.cancelAll();
    if (this.talk || this.flow || this.cmdWin || c?.busy) { this.goOn(); return; }
    const v = video();
    const pos = this.vb?.positionAt(v?.currentTime ?? 0);
    if (pos && this.playback) { this.engine.resumeHere = true; this.playback.play(pos); }
  }

  /** ✋ / Space while the teacher explains: the explanation stops and you can ask (then the video goes on) */
  interrupt(): void {
    const c = this.controller;
    if (!c || !this.ai() || !c.busy) return;
    const pos = this.playback?.position ?? this.cur;
    const l = c.lastExplained;
    c.hold();
    this.tts?.cancelAll();
    if (!pos) return;
    this.heldTalk = true;
    this.openTalk(l?.pos ?? pos, l?.target, this.lastExplanation());
  }
  private heldTalk = false;

  /** the Explain button / Shift+E / "hello": explain the last part */
  explainLast(): void {
    if (!this.controller) return;
    if (!this.ai()) { this.freeNote(); return; }
    const v = video();
    void this.partFlow(v?.currentTime, false);
  }
  /** "shut up": the tutor stops talking */
  shutUp(): void {
    if (this.talk?.live?.speaking) { this.talk.live.interrupt(); return; }
    this.controller?.skip();
    this.tts?.cancelAll();
  }

  /** recognition results already acted on (a result grows while you speak; it acts once) */
  private acted = new Set<string>();
  /** how many words of a heard piece were used when it was acted on */
  private usedWords = new Map<string, number>();
  /** what the tutor did last (flows, the call, back to the video), for the diagnostics */
  private trailLog: string[] = [];
  private trail(what: string): void {
    const v = video();
    this.trailLog.push(`${new Date().toTimeString().slice(0, 8)} ${v ? v.currentTime.toFixed(1) : '-'}${v?.paused ? 'P' : '>'} ${what}`);
    if (this.trailLog.length > 40) this.trailLog.splice(0, this.trailLog.length - 40);
  }
  /** what the microphone is hearing now (not closed yet by Chrome) */
  private still: { key: string; text: string; timer: ReturnType<typeof setTimeout> } | null = null;

  /**
   * Chrome sometimes never closes what you said (sound around you, a fan, a TV): when the words stand still for a
   * moment, the microphone is told to close them (they come back as final); if nothing comes, they count as final here.
   */
  private watchStill(text: string, final: boolean, key?: string): void {
    if (this.still) { clearTimeout(this.still.timer); this.still = null; }
    if (final || !key) return;
    const still = { key, text, timer: setTimeout(() => {
      if (this.still !== still || this.disposed) return;
      window.__ytcApi?.finishSpeech?.();
      still.timer = setTimeout(() => { if (this.still === still && !this.acted.has(key)) { this.still = null; this.heard(text, true, key); } }, 1200);
    }, 1300) };
    this.still = still;
  }

  /** Send ➤ in the call: what is being heard now goes to the tutor at once */
  private sendHeard(): void {
    const t = this.talk;
    const line = t?.log[t.log.length - 1];
    if (!t || !line || line.who !== 'you' || line.final) return;
    const key = this.still?.key ?? line.id.replace(/^u/, '');
    if (this.still) { clearTimeout(this.still.timer); this.still = null; }
    window.__ytcApi?.finishSpeech?.();
    this.heard(line.text, true, key);
  }
  heard(text: string, final: boolean, key?: string): boolean {
    const full = text.trim();
    if (!full) return false;
    const allWords = full.split(/\s+/);
    // a piece that was acted on already (the phone gives one piece until you pause): only the words after that count,
    // and only as a command ("I know" … "I know" for two words of one stop)
    const used = key ? this.usedWords.get(key) ?? 0 : 0;
    if (key && (used ? allWords.length <= used : this.acted.has(key))) return true;
    const tail = used > 0;
    const t = tail ? allWords.slice(used).join(' ') : full;
    this.watchStill(full, final, key);
    const act = (fn: () => void) => {
      if (key) { this.acted.add(key); this.usedWords.set(key, allWords.length); if (this.acted.size > 300) { this.acted.clear(); this.usedWords.clear(); } }
      fn();
    };
    const lower = t.toLowerCase();
    // voice mode: hello / stop / play (said alone, not the video's or the tutor's own words)
    const cmd = this.voiceCommand(lower, final);
    if (cmd) { act(cmd); return true; }
    // "know" (often heard as "no"), "I know", "bye", "bye bye": all the same. At a stop: known, no explanation, the
    // sentence again, on. In a call: the call ends, the video plays. (Not the tutor's own "no" from the speaker.)
    if (final && (this.talk || this.controller?.stopWindow || (this.inStop && this.controller?.busy))) {
      const tail3 = lower.split(/\s+/).slice(-3).join(' ');
      if (saysBye(lower) || ((saysKnow(lower) || saysKnow(tail3)) && !this.tutorSaying(/\b(know|no|now)\b/i))) { act(() => this.knowBye()); return true; }
    }
    // while the video plays its own sound reaches the microphone too, so what is heard never ends: "hello" counts as
    // soon as it is the newest word (not when the video or the tutor says it)
    if (!final && this.ai() && (extras.voiceMode || extras.micAlways) && !this.talk && !this.flow && !this.controller?.busy && /\b(hello|hallo)[.!?,]*$/.test(lower)) {
      const v = video();
      if (v && !v.paused && !this.videoSaying(/\b(hello|hallo)\b/i) && !this.tutorSaying(/\b(hello|hallo)\b/i)) { act(() => this.voiceHello()); return true; }
    }
    // "hi bro" = the call, always (never the explanation of the last part); not the video's or the tutor's own words
    if (HI_BRO.test(lower) && !this.talk && (final || /\b(bro|bruh|brah|bra)[.!?,]*$/.test(lower)) && !this.videoSaying(HI_BRO) && !this.tutorSaying(HI_BRO)) { act(() => this.voiceCall()); return true; }
    // the live call hears you itself (with echo cancelling); the page's recognition could hear the tutor
    if (this.talk?.live && this.talk.live.state !== 'error') return true;
    // the call with Claude: while the tutor talks only "stop" / "bye bye" count (its own voice must not be taken for yours)
    const chat = this.talk?.chat;
    if (chat && !chat.closed && this.talk) {
      const talk = this.talk;
      if (saysBye(lower) && final) { act(() => this.byeBye()); return true; }
      const nWords = t.split(/\s+/).filter(Boolean).length;
      // the tutor is talking: only a clear "stop" interrupts (its own voice from the speaker must not count as you)
      if (chat.speaking || (chat.busy && !chat.thinking)) {
        if (final && nWords <= 4 && /\b(stop|wait|hold on|shut up)\b/.test(lower)) { chat.note(`you: stop (${t})`); act(() => chat.interrupt()); }
        return true;
      }
      // Claude is thinking about your question: a short word ("bro", "ok", "sorry") does not throw the answer away;
      // more words are added to your question
      if (chat.thinking) {
        if (!final) return true;
        if (nWords < 3) { chat.note(`ignored while thinking: ${t}`); return true; }
      }
      // "let's go" right after the tutor stops is you (unless the tutor itself just said it: then it is its echo)
      const goOnWords = /\b(let'?s go|go on|continue|back to the video|play the video)\b/.test(lower) && nWords <= 6;
      const tutorLast = talk.log.filter((l) => l.who === 'tutor').slice(-1)[0]?.text.toLowerCase() ?? '';
      const goOnNow = goOnWords && !/\b(let'?s go|go on|continue)\b/.test(tutorLast);
      if (Date.now() - this.lastTtsEnd < 900 && !goOnNow) { if (final) chat.note(`ignored (just after the tutor spoke): ${t}`); return true; }
      // the microphone heard the end of the tutor's own voice from the speaker (an echo), not you
      if (Date.now() - this.lastTtsEnd < 4000) {
        const said = new Set(talk.log.filter((l) => l.who === 'tutor').slice(-2).map((l) => l.text).join(' ').toLowerCase().match(/[a-z']+/g) ?? []);
        const words = lower.match(/[a-z']+/g) ?? [];
        if (words.length >= 2 && words.filter((w) => said.has(w)).length / words.length >= 0.8) { if (final) chat.note(`ignored (echo of the tutor): ${t}`); return true; }
      }
      // you are talking: the call waits for you (and becomes a real call)
      this.lastHeardAt = Date.now();
      talk.call = true;
      this.putLine(talk, { id: `u${key ?? 'h'}`, who: 'you', text: t, final });
      if (!final) return true;
      if (/\b(let'?s go|go on|continue|back to the video|play the video)\b/.test(lower) && t.split(/\s+/).length <= 6) { act(() => this.goOn()); return true; }
      if (tail) return true;
      chat.note(`heard: ${t}`);
      act(() => chat.ask(t));
      return true;
    }
    const inWindow = this.windowOpen || !!this.cmdWin;
    // "bye bye" stops the AI whatever it does (it is never in an explanation, so it is safe while the tutor talks)
    // ("bye" said alone is the same as "bye bye"; at a stop both are also "I know")
    if (saysBye(lower) && (final || /bye[\s-]*bye/.test(lower))) { act(() => this.byeBye()); return true; }
    // the tutor's own voice must not be taken for the learner's: only a clear "I know", said alone, counts while it talks
    if (this.controller?.busy || Date.now() - this.lastTtsEnd < 700) {
      if (/\bshut\s*up\b/.test(lower)) act(() => this.shutUp());
      else if (this.inStop && this.controller?.busy && !this.tutorSaying(/\bi know\b/i)) {
        // (a stop: its own word or sentence can be answered while the tutor still says or explains it)
        const d = commandIn(t);
        if (d.intent === 'know' && (final || d.score >= 0.92)) act(() => this.answerKnow());
      }
      return true;
    }
    if (final) this.lastHeardAt = Date.now();
    if (/\bshut\s*up\b/.test(lower)) { act(() => this.shutUp()); return true; }
    if (this.talk) {
      // the talk without the live call: commands, or a question for the tutor
      if (!final) return true;
      const d = detectCommand(t);
      if (d.intent === 'bye' || /\b(let'?s go|go on|continue)\b/.test(lower)) act(() => this.goOn());
      else if (d.intent === 'know' && t.split(/\s+/).length <= 4) act(() => this.answerKnow());
      else if (d.intent === 'dont_know' && t.split(/\s+/).length <= 5) act(() => this.answerDontKnow());
      else if (!tail) act(() => this.ask(t, true));
      return true;
    }
    if (inWindow) {
      // (the microphone also heard the tutor say the word just before: the answer is at the end)
      const d = commandIn(t);
      if (d.intent === 'know' || d.intent === 'dont_know' || d.intent === 'bye') {
        if (final || d.score >= 0.92) act(() => { if (d.intent === 'know') this.answerKnow(); else if (d.intent === 'dont_know') this.answerDontKnow(); else this.answerGoOn(); });
        return true;
      }
      if (final) this.controller?.answerWindow({ text: t }); // swallowed: never sent to the AI
      return true;
    }
    // talking to the tutor (🎙 on), only while the video is stopped and nobody is talking
    if (this.ai() && this.talkOn && final && !tail && this.controller && !this.controller.busy && this.playback?.state !== 'playing') {
      const d = detectCommand(t);
      act(() => { if (d.intent === 'bye') this.answerGoOn(); else this.ask(t, true); });
      return true;
    }
    return true;
  }

  ask(question: string, spoken = false): void {
    const c = this.controller; if (!c || !this.vb) return;
    if (!this.ai()) { this.freeNote(); return; }
    const pos = this.talk?.pos ?? this.playback?.position ?? this.cur ?? this.vb.order[0];
    // in the live call, a typed question goes to the call
    if (this.talk?.live && this.talk.live.state === 'ready') { this.talk.live.ask(question); this.putLine(this.talk, { id: `t${Date.now()}`, who: 'you', text: question, final: true }); return; }
    if (this.talk?.chat && !this.talk.chat.closed) { this.talk.call = true; this.putLine(this.talk, { id: `t${Date.now()}`, who: 'you', text: question, final: true }); this.talk.chat.ask(question); return; }
    const sent = getSentence(this.vb.book, pos)?.text ?? '';
    void c.explainNow('question', sent, pos, null, undefined, question, undefined, undefined, spoken);
  }

  // ---- vocabulary ----------------------------------------------------------------------------------------------
  async changeStatus(lemma: string, status: WordStatus | null): Promise<void> {
    if (status) vocab.words[lemma] = status; else delete vocab.words[lemma];
    await store.setWordStatus(lemma, status);
    const hint = !status && this.dict && settings.appearance.showHints !== false ? (this.hints[lemma]?.[0] || hintText(this.dict.lookup(lemma)?.entry.zh ?? '')) : undefined;
    for (const r of [this.panel?.el, this.band?.el, this.stage?.el]) if (r) restyleLemma(r, lemma, status, settings.learnerLevel, hint);
  }

  private onTranscript(e: TranscriptEntry): void {
    const i = this.transcript.findIndex((x) => x.id === e.id);
    if (i >= 0) this.transcript[i] = e; else this.transcript = [...this.transcript.slice(-30), e];
    // a new explanation: the page jumps to its sentence on the play line, whatever was scrolled to
    if (i < 0 && e.position && this.stageVisible() && (this.inStop || (e.kind !== 'word' && e.kind !== 'phrase'))) { this.userScrollAt = 0; this.setCurrent(e.position); this.scrollToCur(true); }
    this.renderTranscript();
    if (this.card && this.card.entryId === null && (e.kind === 'word' || e.kind === 'phrase') && e.status === 'thinking') this.card.entryId = e.id;
    if (this.card && this.card.entryId === e.id) this.updateCardExplain(e);
    // an explanation starts: the live call gets ready (mic off) / stops listening while the teacher talks
    if (e.status === 'thinking' && e.kind !== 'question' && this.ai()) { this.preconnect(); this.muteTalk(); }
    if (e.status === 'speaking' && this.talk) this.muteTalk();
    if (e.status === 'done' || e.status === 'error' || e.status === 'skipped') {
      this.lastTtsEnd = Date.now();
      // (the learner's rule: after every explanation the dictionary card closes by itself)
      // (the big card of a stop on a word or phrase stays a little longer: the word is said again, and the card
      // closes when the sentence starts to play; if anything goes wrong, the end of the stop closes it)
      const staysForWord = !!this.card && this.levelOn() && e.status === 'done' && (e.kind === 'word' || e.kind === 'phrase') && e.lemma === this.card.lemma && (this.playback?.state === 'explaining' || this.playback?.state === 'paused');
      this.cardKept = staysForWord;
      if (this.card && !staysForWord && e.kind !== 'question' && e.status !== 'skipped' && (!e.lemma || e.lemma === this.card.lemma || e.kind === 'sentence' || e.kind === 'passage') && !this.controller?.stopWindow) this.closeCard();
      if (e.status === 'skipped' && !this.talk && this.pre && !this.flow) { this.pre.close(); this.pre = null; }
      if (this.talk && e.status === 'done') { this.talk.explanation = e.text; this.talk.live?.update(this.liveContext(this.talk.word, e.text)); this.talk.live?.setMic(true); }
    }
    // every explained word or phrase goes into My Vocabulary, with its sentence, explanation and where in the video
    // (also when "bye bye" cut it short: the word was met and stays to learn)
    if (e.lemma && (e.kind === 'word' || e.kind === 'phrase' || e.kind === 'sentence') && (e.status === 'done' || (e.status === 'skipped' && e.text.length > 40)) && e.text && !this.saved.has(e.id) && this.vb) {
      this.saved.add(e.id);
      const t = e.position ? this.vb.timingOf(e.position) : null;
      const input = { lemma: e.lemma, word: e.target, sentence: e.sentence, explanation: shown(e.text), chinese: e.chinese ?? (this.hints[e.lemma]?.join('，') ?? ''), bookId: this.vb.book.id, bookTitle: this.vb.book.title, chapter: t ? clock(t.start) : '', position: e.position, level: e.level as CefrLevel | undefined, again: e.again };
      const word = e.kind === 'word' || e.kind === 'phrase';
      if (word && e.position) { this.wordsHeard.ask(e.lemma, this.wordsBefore(e.position)); this.saveHeard(); }
      this.saveChain = this.saveChain.then(() => store.upsertEntry(input)).then((entry) => { if (word) this.knownAfterMany(entry.lemma, entry.timesExplained, e.target); }).catch(() => undefined);
      if (this.levelOn() && e.kind === 'sentence' && e.position && e.status === 'done') this.countExplained(e.position, e);
    }
    this.renderBandSay();
  }

  /**
   * (Level Check) a sentence was explained: its hard words and phrases were explained once more. They are not asked
   * again for a while (extras.repeatWords), and one explained extras.knownAfter times is known from now on.
   */
  private countExplained(pos: Position, e: TranscriptEntry): void {
    const sc = this.scores.get(sentenceKey(pos));
    const vb = this.vb;
    if (!sc || !vb) return;
    const here = this.wordsBefore(pos);
    const t = vb.timingOf(pos);
    const n = extras.knownAfter ?? 7;
    sc.lemmas.forEach((lemma, i) => {
      if (vocab.words[lemma] === 'known' || vocab.words[lemma] === 'ignored') return;
      this.wordsHeard.ask(lemma, here);
      this.saveChain = this.saveChain
        .then(() => store.upsertEntry({ lemma, word: sc.items[i], sentence: e.sentence, explanation: shown(e.text), chinese: this.hints[lemma]?.join('，') ?? '', bookId: vb.book.id, bookTitle: vb.book.title, chapter: t ? clock(t.start) : '', position: pos }))
        .then((entry) => this.knownAfterMany(lemma, entry.timesExplained, sc.items[i]))
        .catch(() => undefined);
    });
    void n;
  }

  /** explained extras.knownAfter times (7) in all: known from now on, never explained again */
  private knownAfterMany(lemma: string, times: number, word: string): void {
    const n = extras.knownAfter ?? 7;
    if (n > 0 && times >= n && vocab.words[lemma] !== 'known' && vocab.words[lemma] !== 'ignored' && !this.disposed) {
      this.controller?.markKnown(lemma);
      void this.changeStatus(lemma, 'known');
      this.toast(`“${word}” was explained ${n} times: it counts as known now.`, 5000);
    }
  }

  /** a stop starts on a word, phrase or sentence (the page shows the last part; the card opens) / is over */
  private onStopTarget(t: { kind: string; target: string; lemma?: string } | null): void {
    // (Level Check: a stop always ends with its sentence from the video; "I know" = no explanation, so it is played now)
    // (the stop is over: the card closes at once, before the sentence plays again)
    // (the full card: closed a moment later, so the next word of the same stop changes it in place, without a flash)
    if (!t) { this.inStop = false; if (this.levelOn()) this.engine.replayUnlessHeard(); if (this.card?.stop) { if (this.card.full) this.closeCardLater(); else this.closeCard(); } return; }
    this.inStop = true;
    const pos = this.playback?.position ?? this.cur;
    if (pos && this.levelOn()) this.countStop(pos);
    // remembered: next time this video is watched, this hard phrase / sentence is not stopped at again
    if (pos && (t.kind === 'phrase' || t.kind === 'sentence' || this.levelOn())) void store.addDone(this.cacheId(), sentenceKey(pos)).catch(() => undefined);
    if (pos && t.lemma && t.kind !== 'sentence') { this.wordsHeard.ask(t.lemma, this.wordsBefore(pos)); this.saveHeard(); }
    // the page jumps to the stop's sentence, whatever was scrolled to
    this.userScrollAt = 0;
    this.lastStopAt = pos && this.vb ? this.vb.timingOf(pos)?.start ?? null : null;
    if (pos && this.vb && extras.stageOn) {
      const tm = this.vb.timingOf(pos);
      if (tm) this.showStage(this.partAt(tm.end - 0.01, settings.listen.lastSecondsWindow));
    }
    if (pos) this.engine.target = pos;
    if (pos && t.lemma && !this.levelOn()) this.prefetchExplain(t.kind as 'word' | 'phrase' | 'sentence', t.target, pos, t.lemma);
    if (pos) { this.setCurrent(pos); this.markStopSentence(pos); this.scrollToCur(true); }
    if (t.lemma && t.kind !== 'sentence') this.anchorStopCard(t.kind, t.target, t.lemma);
    else this.closeCard();
  }

  // ---- no waiting: the explanation is asked for when the video stops, its first sentences are voiced ahead ----------
  private prefetchKey(kind: string, target: string, pos: Position | undefined): string { return `${kind}|${norm(target)}|${pos ? sentenceKey(pos) : ''}`; }

  private prefetchExplain(kind: 'word' | 'phrase' | 'sentence', target: string, pos: Position, lemma: string): void {
    if (!this.ai() || !this.vb || (!this.keys.anthropic && !this.keys.openai)) return;
    const key = this.prefetchKey(kind, target, pos);
    if (this.prefetched.has(key)) return;
    for (const [k, p] of this.prefetched) if (Date.now() - p.at > 90_000) { p.cancel(); this.prefetched.delete(k); }
    const cur = getSentence(this.vb.book, pos);
    const ctx = contextAround(this.vb.book, pos, settings.ai.contextWordsBefore, settings.ai.contextWordsAfter);
    const look = kind === 'word' ? this.dict?.lookup(target)?.entry : null;
    const req: ExplainRequest = this.withRule({
      kind, target, sentence: cur?.text ?? target, before: ctx.before, after: ctx.after,
      book: { title: this.vb.book.title, chapter: this.vb.book.chapters[pos.chapter]?.title ?? '' },
      dict: look ? { ipa: look.ipa, zh: look.zh.split('\n')[0], level: look.level } : undefined,
      history: [], position: { chapter: pos.chapter, paragraph: pos.paragraph, sentence: pos.sentence }, styleId: settings.ai.activeStyle, again: false,
    });
    const splitter = new StreamSentenceSplitter();
    let voiced = 0;
    const entry = { full: '', done: null as unknown as Promise<{ text: string; usage: { usd: number; dailyUsd: number; monthlyUsd: number } }>, cancel: () => undefined as void, sink: null as ((full: string) => void) | null, at: Date.now() };
    const r = aiExplain(req, (full) => {
      entry.full = full;
      entry.sink?.(full);
      // the first two sentences get their voice ready too (cloud voices), so speaking starts at once
      if (voiced < 2 && this.voiceKind !== 'mac') for (const sen of splitter.push(full)) { if (voiced++ >= 2) break; const tx = cleanSpokenProse(sen).replace(/\[PAUSE\]/gi, ' ').trim(); if (tx && !/[\u3400-\u9FFF]/.test(tx)) this.tts?.prefetch?.(tx, this.voiceId, settings.voice.rate); }
    });
    entry.done = r.done;
    entry.cancel = r.cancel;
    this.prefetched.set(key, entry);
    void lemma;
  }

  private takePrefetch(req: ExplainRequest, onDelta: (full: string) => void): { done: Promise<{ text: string; usage: { usd: number; dailyUsd: number; monthlyUsd: number } }>; cancel(): void } | null {
    if (req.question || req.kind === 'question' || req.kind === 'passage') return null;
    const key = this.prefetchKey(req.kind, req.target, req.position);
    const p = this.prefetched.get(key);
    if (!p) return null;
    this.prefetched.delete(key);
    p.sink = onDelta;
    if (p.full) onDelta(p.full);
    return { done: p.done, cancel: () => p.cancel() };
  }

  private dropPrefetch(): void { for (const p of this.prefetched.values()) p.cancel(); this.prefetched.clear(); }

  /** the hard words of the sentence that starts now: their voice is made ahead (said 3 times at the stop) */
  private prefetchVoice(pos: Position): void {
    // (not Microsoft's free plan: 20 requests a minute are kept for what the tutor really says)
    if (this.voiceKind === 'mac' || this.voiceKind === 'azure' || !this.ai() || !this.controller || this.levelOn()) return;
    for (const t of this.controller.triggersFor(pos)) if (t.lemma && t.kind !== 'sentence') this.tts?.prefetch?.(t.target, this.voiceId, Math.min(settings.voice.rate, 0.9));
  }

  /** a commands window opened / closed: after an explanation the talk opens instead of a countdown */
  private onWindow(w: CommandWindow | null): void {
    this.showCommandWindow(w);
    if (!w) return;
    // a hard sentence (a touch screen): its full card, after the sentence was played; it stays during the explanation
    // and closes when the sentence plays again
    if (TOUCH && w.phase === 'before' && w.kind === 'sentence' && !this.card) {
      const pos = this.playback?.position ?? this.cur;
      if (pos) this.openCard(pos, -1, sentenceLemma(w.target), w.target, 'sentence', null, undefined, { full: true });
    }
    if (w.phase === 'before') { this.muteTalk(); return; }
    if (w.phase === 'after' && talkAfter() && !this.flow && !this.levelOn()) {
      // (keeping the window open while we talk reports it again: the talk is only opened once)
      if (this.talk) { this.talk.live?.setMic(true); return; }
      const pos = this.playback?.position ?? this.cur;
      const l = this.controller?.lastExplained;
      if (pos) this.openTalk(l?.pos ?? pos, l?.target, this.lastExplanation());
    }
  }

  // ---- background jobs: Chinese meanings in context, the AI's hard phrases and hard sentences (cheap model, once per video) ----
  private async runHintsJob(): Promise<void> {
    if (!this.ai()) return;
    const keys = await store.getKeys().catch(() => ({} as store.Keys));
    if ((!keys.anthropic && !keys.openai) || !this.vb || !this.dict) return;
    const cached = await store.getVideoHints(this.videoId).catch(() => null) as (store.VideoHints & { split?: string; v?: number }) | null;
    // (analysed once: an analysis made for the same or an easier level holds everything a higher level needs; only a
    // level that went DOWN a school band needs more words, once)
    if (cached && analysisCovers(cached.level) && cached.v === HINTS_VERSION && cached.split === this.source) return;
    const book = this.vb.book;
    const known = new Set(Object.entries(vocab.words).filter(([, s]) => s === 'known' || s === 'ignored').map(([l]) => l));
    const hints: HintMap = { ...(cached && analysisCovers(cached.level) ? cached.hints : {}) };
    const vbAtStart = this.vb;
    try {
      if (!cached || !analysisCovers(cached.level)) {
        for (const batch of batchHardWords(collectHardWords(book, 0, this.dict, settings.learnerLevel, this.names, known))) {
          if (this.disposed) return;
          Object.assign(hints, parseHints(await complete(buildHintsPrompt(batch, { title: book.title, chapter: 'YouTube video', level: settings.learnerLevel }))));
          this.hints = { ...this.hints, ...hints };
        }
      }
      const chunks = chunkChapter(book, 0);
      // every phrase above the level: a generous cap per part (the AI picks only the ones above the level)
      const quota = phraseQuota(chunks).map((q) => q * 3);
      const items = [];
      for (let i = 0; i < chunks.length; i++) {
        if (this.disposed || this.vb !== vbAtStart) return;
        const raw = parsePhrases(await complete(buildPhrasesPrompt(chunks[i], { title: book.title, chapter: '', level: settings.learnerLevel, max: quota[i], part: [i + 1, chunks.length] })));
        items.push(...validatePhrases(raw, chapterText(book, 0), { max: quota[i], isFree: (w, zh) => looksLikeFreeCombination(this.dict!, w, zh) }));
      }
      this.phrases = mapPhraseHits(book, 0, items, (w) => this.dict!.lemmaOf(w));
      // whole sentences that are hard to understand by ear at this level
      const hard: number[] = [];
      const order = this.vb.order;
      for (let from = 0; from < order.length; from += 60) {
        if (this.disposed || this.vb !== vbAtStart) return;
        const slice = order.slice(from, from + 60);
        const lines = slice.map((p) => getSentence(book, p)?.text ?? '');
        const secs = this.vb.timingOf(slice[slice.length - 1])!.end - this.vb.timingOf(slice[0])!.start;
        const max = Math.max(1, Math.round(secs / HARD_PER_SECONDS));
        try { hard.push(...parseHardSentences(await complete(buildHardSentencesPrompt(lines, { level: settings.learnerLevel, title: book.title, max })), lines.length, max).map((i) => from + i)); } catch { /* this part keeps no sentence stops */ }
      }
      this.hardSentences = this.markedFrom(hard);
      this.hardLevel = settings.learnerLevel;
      this.recomputeStops();
      await store.setVideoHints(this.cacheId(), { version: store.HINTS_VERSION, level: settings.learnerLevel, hints: Object.fromEntries(Object.entries(this.hints).filter(([l]) => !this.liveHints.has(l))), phrases: this.phrases, split: this.source, sentences: hard, v: HINTS_VERSION, here: Object.fromEntries(this.hereZh) } as store.VideoHints);
      if (!this.disposed) { this.render(); this.setStatus(`${this.statusText.split(' · AI')[0]} · AI: hard words, phrases and ${hard.length} sentences ready`); }
    } catch (e) {
      if (!this.disposed) this.setStatus(`${this.statusText} · AI meanings: ${(e as Error).message}`);
    }
  }

  // ---- live Chinese translation of the lines ------------------------------------------------------------------
  private zhKey(pos: Position): string { const s = this.vb ? getSentence(this.vb.book, pos) : null; return s ? norm(s.text) : ''; }

  /** translates the lines that are not translated yet (a few at a time; each appears when the AI writes it) */
  private ensureZh(positions: Position[]): void {
    if (!extras.zhLines || !this.vb) return;
    // (free mode: the device translates them, one by one; nothing asked of the AI)
    if (!this.ai()) { for (const p of positions.slice(0, 24)) this.translateHere(p); return; }
    if (!this.keys.anthropic && !this.keys.openai) return;
    const todo = positions.filter((p) => { const k = this.zhKey(p); return k && !this.zh[k] && !this.zhPending.has(k); }).slice(0, 24);
    if (!todo.length) return;
    const texts = todo.map((p) => getSentence(this.vb!.book, p)!.text);
    const keys = todo.map((p) => this.zhKey(p));
    keys.forEach((k) => this.zhPending.add(k));
    const apply = (raw: string, final: boolean) => {
      for (const [n, zh] of parseLines(raw, texts.length, final)) {
        const k = keys[n - 1];
        if (this.zh[k] === zh) continue;
        this.zh[k] = zh;
        this.paintZh(todo[n - 1], zh);
      }
    };
    const job = completeStream(buildLinesPrompt(texts, this.vb.book.title), (full) => apply(full, false));
    void job.done.then((full) => { apply(full, true); this.saveZhSoon(); }, () => undefined).finally(() => keys.forEach((k) => this.zhPending.delete(k)));
  }
  /** sentences the device could not translate (not asked again in this video) */
  private zhFailed = new Set<string>();
  /**
   * One sentence translated by the device (Apple's Translation: free). Each sentence once: kept with the video's other
   * translations, so a second stop at it, or the next viewing, asks nothing.
   */
  private translateHere(pos: Position): void {
    const k = this.zhKey(pos);
    const text = this.vb ? getSentence(this.vb.book, pos)?.text : null;
    if (!k || !text || this.zh[k] || this.zhPending.has(k) || this.zhFailed.has(k)) return;
    this.zhPending.add(k);
    void nativeTranslate(text).then((zh) => {
      this.zhPending.delete(k);
      if (this.disposed) return;
      if (!zh) { this.zhFailed.add(k); return; }
      this.zh[k] = zh;
      this.paintZh(pos, zh);
      this.saveZhSoon();
    });
  }
  private saveZhSoon(): void {
    if (this.zhSave) clearTimeout(this.zhSave);
    this.zhSave = setTimeout(() => void store.setZh(this.cacheId(), this.zh).catch(() => undefined), 1500);
  }
  private paintZh(pos: Position, zh: string): void {
    // (the full card of this very sentence: its translation came now, so it shows on the card too)
    if (this.card?.full && this.card.kind === 'sentence' && sentenceKey(this.card.pos) === sentenceKey(pos)) this.paintFullCard();
    const el = this.sentenceEl(this.stage?.el, pos);
    if (!el) return;
    let z = el.querySelector<HTMLElement>('.zh-line');
    if (!z) { z = document.createElement('span'); z.className = 'zh-line'; el.appendChild(z); }
    z.textContent = zh;
    if (this.partKeys) this.fitPart();
  }

  // =============================================================================================================
  // the screen
  // =============================================================================================================
  private mountPanel(): void {
    if (!extras.panel) return;
    const { host, root } = makeHost('dr-panel-host');
    if (!placePanel(host)) { setTimeout(() => { if (!this.disposed && !this.panel) this.mountPanel(); }, 800); return; }
    const el = document.createElement('div');
    el.className = 'panel';
    el.innerHTML = `<div class="head"></div><div class="status"></div><div class="lines"><div class="doc-inner"></div></div><div class="talk" hidden></div><div class="transcript"></div>
      <form class="ask"><input type="text" placeholder="Type a question (pronunciation does not matter)" aria-label="Question for the tutor"><button type="button" class="speak" data-act="speak" title="Speak your question: Chrome writes it down">🎤 Speak</button><button type="submit">Ask</button></form>
      <div class="cmd" hidden></div><div class="card" hidden></div><div class="quick" hidden></div><div class="toast" hidden></div><button type="button" class="selx" hidden></button>`;
    root.appendChild(el);
    document.documentElement.classList.add('dr-panel');
    this.panel = { host, root, el };
    this.applyLook();
    this.renderHead();
    const lines = el.querySelector<HTMLElement>('.lines')!;
    lines.addEventListener('wheel', () => { this.userScrollAt = Date.now(); }, { passive: true });
    lines.addEventListener('touchmove', () => { this.userScrollAt = Date.now(); }, { passive: true });
    this.wireWords(lines);
    this.wireAsk(el);
    // YouTube built its right column late (a slow page load): the subtitles were read meanwhile, so show them now
    if (this.statusText) this.setStatus(this.statusText, this.statusBad);
    if (this.vb && this.dict) { this.render(); this.renderTranscript(); this.renderTalk(); }
  }

  private wireAsk(el: HTMLElement): void {
    el.querySelector('form.ask [data-act="speak"]')?.addEventListener('click', (ev) => { ev.preventDefault(); this.pushToTalk(el); });
    el.querySelector('form.ask')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const inp = el.querySelector<HTMLInputElement>('form.ask input')!;
      const q = inp.value.trim();
      if (!q) return;
      inp.value = '';
      this.ask(q);
    });
    // typing in our boxes must not reach YouTube's shortcuts (k = pause, f = full screen, …)
    for (const ev of ['keydown', 'keyup', 'keypress']) el.addEventListener(ev, (e) => { if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) e.stopPropagation(); });
  }

  /** the reading page over the whole screen (Dream Read): all subtitles (listening mode) or the last part (a stop) */
  private mountStage(): void {
    if (this.stage) return;
    const { host, root } = makeHost('dr-stage-host');
    host.hidden = true;
    const el = document.createElement('div');
    el.className = 'stage';
    el.innerHTML = `<div class="top"></div><div class="flowstate" hidden></div><div class="page"><div class="doc-inner"></div></div><div class="pager"><button type="button" class="quiet" data-act="prev" title="The page before">‹</button><span class="pg"></span><button type="button" class="quiet" data-act="next" title="The next page">›</button></div>
      <div class="dock"><div class="sayrow"><div class="say"></div><button class="quiet hand" data-act="hand" hidden title="Pause the teacher and ask (Space)">✋ Ask</button><button class="quiet hand" data-act="bye" hidden title="Bye bye: stop the AI and play again (Esc)">Bye bye</button></div><div class="talk" hidden></div>${TOUCH ? '' : '<form class="ask"><input type="text" placeholder="Type or speak a question for your tutor" aria-label="Question for the tutor"><button type="button" class="speak" data-act="speak" title="Speak your question: Chrome writes it down">🎤 Speak</button><button type="submit" title="Send to my tutor">Ask</button></form>'}</div>
      <div class="cmd" hidden></div><div class="card" hidden></div><div class="quick" hidden></div><div class="toast" hidden></div><button type="button" class="selx" hidden></button>`;
    root.appendChild(el);
    this.stage = { host, root, el };
    // you clicked the video to pause it and the page appeared under the mouse: that same click must not tap a word
    // (only the text: the buttons of the page work at once)
    for (const type of ['click', 'dblclick']) el.addEventListener(type, (e) => { if (Date.now() - this.stageShownAt < 600 && (e.target as HTMLElement).closest?.('.page')) { e.stopPropagation(); e.preventDefault(); } }, true);
    this.placeStage();
    const page = el.querySelector<HTMLElement>('.page')!;
    page.addEventListener('wheel', () => { this.userScrollAt = Date.now(); }, { passive: true });
    page.addEventListener('touchmove', () => { this.userScrollAt = Date.now(); }, { passive: true });
    // the window, the dock (explanation, talk) or the commands window changed size: the part is fitted again
    const ro = new ResizeObserver(() => { this.fitPart(); this.padPage(); this.layoutRead(); this.scrollToCur(this.playback?.state === 'explaining' || !!this.cmdWin); });
    ro.observe(page);
    this.offs.push(() => ro.disconnect());
    this.wireWords(page);
    this.wireAsk(el);
    // the reading pages: ‹ › and a swipe to the side turn the page
    // One button mode: a touch anywhere on the page = explain the last N seconds (before any word or line sees the tap;
    // scrolling the page is not a tap and still works)
    el.addEventListener('click', (ev) => {
      if (!this.oneTap()) return;
      // (the page's own controls keep working: the settings, a window, the page-turn buttons, any button)
      if ((ev.target as HTMLElement).closest?.('.quick, .toast, .cmd, .card, .top, .pager, .dock, button, input, select, textarea, a')) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      this.oneTapExplain();
    }, true);
    el.querySelector('.pager')!.addEventListener('click', (ev) => {
      const act = (ev.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'prev') this.turnPage(-1); else if (act === 'next') this.turnPage(1);
    });
    let swipe: { x: number; y: number } | null = null;
    page.addEventListener('touchstart', (ev) => { const t = ev.touches[0]; swipe = t && ev.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null; }, { passive: true });
    page.addEventListener('touchend', (ev) => {
      const t = ev.changedTouches[0];
      if (!swipe || !t || !this.readView() || Date.now() - this.touchSelectedAt < 700) { swipe = null; return; }
      const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) this.turnPage(dx < 0 ? 1 : -1);
    }, { passive: true });
    el.querySelector('.sayrow')!.addEventListener('click', (ev) => {
      const act = (ev.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'hand') this.interrupt(); else if (act === 'bye') this.byeBye();
    });
    this.applyLook();
    this.renderStageTop();
  }

  /** in full screen the page lives inside the player (else it would be hidden) */
  private placeStage(): void {
    const h = this.stage?.host;
    if (!h) return;
    const parent = document.fullscreenElement ?? document.body;
    if (h.parentElement !== parent) parent.appendChild(h);
  }

  private renderStageTop(): void {
    const top = this.stage?.el.querySelector<HTMLElement>('.top');
    if (!top) return;
    const listening = bookView();
    const range = this.partKeys && this.vb ? (() => { const ps = this.vb.order.filter((p) => this.partKeys!.has(sentenceKey(p))); return ps.length ? `${clock(this.vb.timingOf(ps[0])!.start)} – ${clock(this.vb.timingOf(ps[ps.length - 1])!.end)}` : ''; })() : '';
    const sc = shortcutMap(extras.shortcuts);
    const playing = !!video() && !video()!.paused;
    top.innerHTML = `<span class="brand">Dream</span><button data-act="stop" class="stopbtn" title="${playing ? 'Stop everything' : 'Play on'} (${esc(comboLabel(sc.stop))})">${playing ? '⏸' : '▶'}</button><span class="ttl">${esc(this.vb?.book.title ?? '')}</span>${range ? `<span class="range">${range}</span>` : ''}<span class="grow"></span>
      <span class="seg" data-name="secs">${[10, 20, 30].map((n) => `<button data-secs="${n}" class="${settings.listen.lastSecondsWindow === n ? 'on' : ''}">${n}s</button>`).join('')}</span>
      <button data-act="smaller" title="Smaller text (${esc(comboLabel(sc.smaller))})">A−</button><button data-act="bigger" title="Bigger text (${esc(comboLabel(sc.bigger))})">A+</button>
      <button data-act="zh" aria-pressed="${extras.zhLines}" title="Chinese under each line (${esc(comboLabel(sc.zh))})">中文</button>
      ${this.ai() ? `<button data-act="talk" title="Talk to my tutor (${esc(comboLabel(sc.talk))})">📞 Talk</button><button data-act="voice" aria-pressed="${extras.voiceMode}" title="Voice mode: say hello (explain the last part) / hi bro (call) / stop / play / bye">🎙 Voice${extras.voiceMode ? ' on' : ''}</button>` : ''}
      <button data-act="view" title="${listening ? 'Back to the normal video' : 'Listening mode: all subtitles'} (${esc(comboLabel(sc.listening))})">${listening ? '🎬 Video' : '📖 Listening'}</button>
      ${listening ? '' : `<button data-act="pageAuto" aria-pressed="${extras.stageOn}" title="This big page at stops and pauses: on / off (off = you only watch the video)">📄 Page ${extras.stageOn ? 'on' : 'off'}</button>`}
      <button data-act="quick" title="Quick settings">⚙</button>${listening ? '' : '<button data-act="close" class="quiet" title="Back to the video">✕</button>'}`;
    top.onclick = (ev) => {
      const b = (ev.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.secs) { void store.patchSettings({ listen: { ...settings.listen, lastSecondsWindow: Number(b.dataset.secs) as Settings['listen']['lastSecondsWindow'] } }); return; }
      const act = b.dataset.act;
      if (act === 'smaller' || act === 'bigger') this.resize(act === 'bigger' ? 1 : -1);
      else if (act === 'zh') void store.patchExtras({ zhLines: !extras.zhLines });
      else if (act === 'talk') void this.callTutor();
      else if (act === 'voice') this.toggleVoiceMode();
      else if (act === 'view') void store.patchExtras({ view: listening ? 'normal' : 'listening' });
      else if (act === 'quick') this.toggleQuick(this.stage!.el);
      else if (act === 'stop') this.stopOrPlay();
      else if (act === 'pageAuto') this.togglePageAuto();
      else if (act === 'close') { if (this.talk || this.flow || this.cmdWin) this.goOn(); else this.hideStage(); }
    };
  }

  /** 📄: the big page at stops and pauses on / off (off = only the video, the explanation is in the panel) */
  togglePageAuto(): void {
    const on = !extras.stageOn;
    extras.stageOn = on;
    void store.patchExtras({ stageOn: on });
    if (!on && normalView() && this.stageVisible()) this.hideStage();
    this.renderHead();
    this.renderStageTop();
    this.toast(on ? 'The big page opens at stops again.' : 'Big page off: you only watch the video (📄 turns it on again).');
  }

  /** ⏸ / ▶ (Shift+P): everything stops (the video, the explanation, the talk) with no "you paused" explanation */
  private stoppedAt: Position | null = null;
  stopOrPlay(): void {
    const v = video();
    if (!v || !this.playback) return;
    const busy = !v.paused || !!this.controller?.busy || !!this.flow || !!this.talk || !!this.cmdWin;
    if (busy) this.stopAll(); else this.playOn();
  }

  private stopAll(): void {
    const v = video(), pb = this.playback!;
    this.trail('stop (⏸)');
    this.stoppedAt = pb.position ?? (v && this.vb ? this.vb.positionAt(v.currentTime) : null);
    this.dropPrefetch();
    this.endFlow();
    this.talkWaiter = null;
    this.closeTalk();
    pb.pause(); // the explanation sees the change and stops (it does not go on by itself)
    if (this.controller?.busy || this.cmdWin) this.controller?.skip();
    this.tts?.cancelAll();
    this.zhTts?.cancelAll();
    if (v && !v.paused) this.engine.hold();
    this.updateStopButton();
  }

  private playOn(): void {
    asleep = false; // (you pressed play: awake again)
    const pos = this.stoppedAt ?? this.playback?.position ?? null;
    this.stoppedAt = null;
    this.trail('play (▶)');
    if (pos) this.continueFrom(pos); else void video()?.play();
    this.updateStopButton();
  }

  private updateStopButton(): void {
    const b = this.stage?.el.querySelector<HTMLElement>('.top [data-act="stop"]');
    const v = video();
    if (!b) return;
    const playing = !!v && !v.paused;
    b.textContent = playing ? '⏸' : '▶';
    b.title = `${playing ? 'Stop everything' : 'Play on'} (${comboLabel(shortcutMap(extras.shortcuts).stop)})`;
  }

  /**
   * shows the page; `part` = only these sentences (a stop, a pause); none = all subtitles.
   * `force`: shown even with the big page off (the full stop card: the learner asked for it)
   */
  private showStage(part?: Position[], force = false): void {
    if (!this.stage || !this.vb) return;
    if (!force && normalView() && !extras.stageOn && part) return;
    this.partKeys = part && part.length ? new Set(part.map((p) => sentenceKey(p))) : null;
    this.partEnd = part && part.length ? part[part.length - 1] : null;
    this.stageShown = true;
    if (this.stage.host.hidden) this.stageShownAt = Date.now();
    this.placeStage();
    this.stage.host.hidden = false;
    document.documentElement.classList.add('dr-stage');
    document.documentElement.classList.toggle('dr-hide-cc', extras.hideYtCaptions || (TOUCH && extras.band === 'off'));
    this.markPart();
    this.renderStageTop();
    this.showCommandWindow(this.cmdWin);
    this.renderTalk();
    this.applySplit();
    if (part?.length) { this.ensureZh(part); this.scrollToCur(true); }
  }

  /**
   * An iPad, Video mode, the page on the screen: the video stays in sight. The window on its side: the video on the
   * left, the page on the right; upright (or an iPad split in half): the video on top, the page under it. The full
   * stop card and the app's full screen take the whole window as always. (Settings: "iPad: the page beside the video".)
   */
  private applySplit(): void {
    if (!IPAD) return;
    const root = document.documentElement;
    const on = extras.padSplit !== false && normalView() && this.stageVisible() && !this.card?.full && !root.classList.contains('dr-full') && location.pathname === '/watch';
    const l = lay();
    const side = on && l === 't-land', under = on && (l === 't-port' || l === 't-narrow');
    if (root.classList.contains('dr-split-r') === side && root.classList.contains('dr-split-b') === under) return;
    root.classList.toggle('dr-split-r', side);
    root.classList.toggle('dr-split-b', under);
    // (the page has another size now: its text is laid out again)
    window.dispatchEvent(new Event('resize'));
  }

  /** the last sentence of the part on the page (20 / 30 / 40 / 60 changes the part from there, at once) */
  private partEnd: Position | null = null;

  private hideStage(): void {
    if (!this.stage || bookView()) return;
    this.stageShown = false;
    this.partKeys = null;
    this.partEnd = null;
    this.stage.host.hidden = true;
    document.documentElement.classList.remove('dr-stage');
    this.applySplit();
    if (this.quickRoot === this.stage.el) this.closeQuick();
    this.showCommandWindow(this.cmdWin);
    if (this.card) this.closeCard();
  }

  private markPart(): void {
    const el = this.stage?.el;
    if (!el) return;
    // (a phone never shrinks the text to fit a part: at a stop in Video mode the book is shown)
    el.dataset.view = extras.view === 'reading' ? 'read' : this.partKeys && normalView() && !TOUCH ? 'part' : 'all';
    el.dataset.lyrics = this.lyrics ? '1' : '0';
    el.querySelectorAll<HTMLElement>('.s').forEach((s) => s.classList.toggle('in-part', !!this.partKeys?.has(s.dataset.key ?? '')));
    // all subtitles: your own text size at once (the playing line is placed right after this)
    if (el.dataset.view !== 'part') el.querySelector<HTMLElement>('.page')?.style.removeProperty('font-size');
    this.fitPart();
    this.padPage();
    this.layoutRead();
  }

  private fitFrame = 0;
  /** soon (once per frame): the part is fitted to the page again (the dock, the card or the Chinese lines changed) */
  private fitPart(): void {
    if (this.fitFrame) return;
    this.fitFrame = requestAnimationFrame(() => { this.fitFrame = 0; this.fitNow(); });
  }
  /**
   * A stop / a pause: the whole part (20 / 30 / 40 / 60 s) is on the screen at once, every word. The text is as big
   * as your text size (A− / A+), and smaller only when the part would not fit; the page never needs scrolling.
   */
  private fitNow(): void {
    const el = this.stage?.el;
    const page = el?.querySelector<HTMLElement>('.page');
    if (!el || !page || !this.stageVisible()) return;
    if (el.dataset.view !== 'part') { page.style.removeProperty('font-size'); return; }
    const max = stageSize();
    const fits = (px: number): boolean => { page.style.fontSize = `${px}px`; return page.scrollHeight <= page.clientHeight + 1; };
    if (!page.clientHeight || fits(max)) { page.scrollTop = 0; return; }
    let lo = 9, hi = max;
    while (hi - lo > 0.5) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
    fits(Math.floor(lo * 2) / 2);
    page.scrollTop = 0;
  }

  private markStopSentence(pos: Position): void {
    for (const r of [this.stage?.el, this.panel?.el]) { r?.querySelectorAll('.s.stop-s').forEach((e) => e.classList.remove('stop-s')); this.sentenceEl(r, pos)?.classList.add('stop-s'); }
  }

  /** listening mode (all subtitles over the screen) or the normal video */
  applyView(): void {
    if (!this.stage) return;
    if (bookView()) this.showStage();
    else if (!this.talk && !this.flow && !this.cmdWin && !(this.playback?.state === 'explaining')) this.hideStage();
    else this.markPart();
    this.renderStageTop();
    this.renderHead();
    this.scrollToCur(true);
  }

  stageVisible(): boolean { return !!this.stage && !this.stage.host.hidden; }

  private resize(dir: number): void {
    if (TOUCH) void store.patchExtras({ phoneSizePx: clamp((extras.phoneSizePx || 21) + dir, 14, 48) });
    else if (this.stageVisible() && extras.view === 'reading') void store.patchExtras({ readSizePx: clamp((extras.readSizePx || 22) + dir, 12, 60) });
    else if (this.stageVisible()) void store.patchExtras(TOUCH ? { phoneSizePx: clamp((extras.phoneSizePx || 21) + dir, 14, 48) } : { stageSizePx: clamp(extras.stageSizePx + dir * 2, 16, 96) });
    else if (this.bandVisible()) void store.patchSettings({ appearance: { ...settings.appearance, subtitleSizePx: clamp((settings.appearance.subtitleSizePx || 26) + dir * 2, 16, 96) } });
    else void store.patchSettings({ appearance: { ...settings.appearance, fontSizePx: clamp((settings.appearance.fontSizePx || 19) + dir, 12, 48) } });
  }

  // ---- quick settings, on the page ----------------------------------------------------------------------------
  private toggleQuick(root: HTMLElement): void {
    if (this.quickRoot === root) { this.closeQuick(); return; }
    this.closeQuick();
    this.quickRoot = root;
    this.renderQuickIfOpen();
  }
  renderQuickIfOpen(): void {
    const root = this.quickRoot;
    const q = root?.querySelector<HTMLElement>('.quick');
    if (!root || !q) return;
    q.hidden = false;
    const scroll = q.querySelector('.q-body')?.scrollTop ?? 0;
    // a box the learner is typing in (or a slider being dragged) keeps its value: no re-render under the cursor;
    // after a button or a list choice it is drawn again at once, so the change shows
    const focused = (root.getRootNode() as ShadowRoot).activeElement as HTMLElement | null;
    if (focused?.closest?.('.quick') && /^(INPUT|TEXTAREA)$/.test(focused.tagName)) return;
    renderQuick(q, { gist: this.gistText, phone: TOUCH, pad: IPAD, sleepMin: sleepMinutes(), setSleep: (m) => setSleep(m), settings, extras, keys: this.keys, voiceNow: this.voiceKind, azureAvail: this.azureAvail, levelText: this.levelText, macVoices: this.macVoices, macVoice: this.macVoice, testVoice: () => this.testVoice(), testWord: () => this.testWord(), testCall: () => void this.callTutor(), close: () => this.closeQuick(), toast: (t, ms) => this.toast(t, ms) });
    const body = q.querySelector('.q-body');
    if (body) body.scrollTop = scroll;
  }
  private closeQuick(): void {
    const q = this.quickRoot?.querySelector<HTMLElement>('.quick');
    if (q) { q.hidden = true; q.innerHTML = ''; }
    this.quickRoot = null;
  }

  private applyLook(): void {
    for (const h of [this.panel?.host, this.band?.host, this.stage?.host]) {
      if (!h) continue;
      h.dataset.hints = settings.appearance.showHints !== false ? '1' : '0';
      h.dataset.zh = extras.zhLines ? '1' : '0';
      h.style.setProperty('--reader-size', `${clamp(settings.appearance.fontSizePx || 19, 12, 48)}px`);
      // (a phone: the subtitles on the video a little smaller, so they never cover the picture)
      h.style.setProperty('--subtitle-size', `${TOUCH ? bandPx() : clamp(settings.appearance.subtitleSizePx || 26, 16, 96)}px`);
      h.style.setProperty('--text-weight', String(clamp(extras.textWeight || 400, 200, 800)));
      // (ONE look for every mode: day, night, or as the device is set)
      h.dataset.look = store.lookOf(extras);
      // (a kind that is switched off, or at 0 %, is not marked in the text either)
      { const p = explainPcts(); h.dataset.hlw = extras.stopItemsOn === false || p.word <= 0 ? '0' : '1'; h.dataset.hlp = extras.stopPhrasesOn === false || p.phrase <= 0 ? '0' : '1'; h.dataset.hls = extras.stopHardOn === false || p.sentence <= 0 ? '0' : '1'; }
      h.style.setProperty('--explain-size', `${clamp(settings.appearance.explainSizePx || 14, 12, 24)}px`);
      h.style.setProperty('--stage-size', `${stageSize()}px`);
      h.style.setProperty('--read-size', `${TOUCH ? stageSize() : clamp(extras.readSizePx || 22, 12, 60)}px`);
      // ("phone" means touch: the iPad gets the touch page too; dev and lay tell the sizes apart)
      h.dataset.phone = TOUCH ? '1' : '0';
      h.dataset.dev = DEVICE;
      h.dataset.lay = lay();
      // (a phone: what the tutor says is heard, not read, unless you turn the text on)
      h.dataset.say = !TOUCH || extras.showSay ? '1' : '0';
      // (the E button on every sentence: a switch in Settings; on a desktop always)
      h.dataset.e = !TOUCH || extras.sentenceButtons ? '1' : '0';
      h.style.setProperty('--band-bottom', `${clamp(extras.bandBottom ?? 7, 0, 60)}%`);
    }
    applyPageLook();
    this.fitPart();
    this.padPage();
    this.layoutRead();
  }

  renderHead(): void {
    const head = this.panel?.el.querySelector<HTMLElement>('.head');
    if (!head) return;
    const tutor = this.ai();
    const sc = shortcutMap(extras.shortcuts);
    head.innerHTML = `<span class="brand">Dream</span><span class="mode tutor">My tutor</span><span class="grow"></span>
      ${tutor ? `<button data-act="last" title="Explain what was just said (${esc(comboLabel(sc.explainLast))}, or say “hello”); ${esc(comboLabel(sc.explainSentence))} = the last sentence">Explain ${settings.listen.lastSecondsWindow} s</button><button data-act="talk" title="Talk to my tutor (${esc(comboLabel(sc.talk))})">📞</button>` : ''}
      <button data-act="view" title="Listening mode: all subtitles over the screen (${esc(comboLabel(sc.listening))})">📖</button>
      ${tutor ? `<button data-act="pageAuto" aria-pressed="${extras.stageOn}" title="The big page at stops and pauses: on / off (off = you only watch the video)">📄 ${extras.stageOn ? 'on' : 'off'}</button>` : ''}
      <button data-act="zh" aria-pressed="${settings.ai.speakChinese}" title="Say the two Chinese meanings at the end of explanations">中文 ${settings.ai.speakChinese ? 'on' : 'off'}</button>
      <button data-act="smaller" title="Smaller text">A−</button><button data-act="bigger" title="Bigger text">A+</button>
      <button data-act="voice" aria-pressed="${extras.voiceMode}" title="Voice mode: say hello (explain the last part) / hi bro (call) / stop / play / bye">🎙${extras.voiceMode ? ' on' : ''}</button>
      <button data-act="vocab" title="My Vocabulary: you know about ${this.knownEstimate.toLocaleString()} English words">📒${this.knownEstimate ? ` ${this.knownEstimate.toLocaleString()}` : ''}</button><button data-act="quick" title="Quick settings: sizes, voice, talk, teacher, keys, shortcuts">⚙</button>`;
    head.onclick = (ev) => {
      const b = (ev.target as HTMLElement).closest('button');
      const act = b?.dataset.act;
      if (!act) return;
      if (act === 'last') this.explainLast();
      else if (act === 'talk') void this.callTutor();
      else if (act === 'view') void store.patchExtras({ view: extras.view === 'listening' ? 'normal' : 'listening' });
      else if (act === 'zh') void store.patchSettings({ ai: { ...settings.ai, speakChinese: !settings.ai.speakChinese } });
      else if (act === 'smaller' || act === 'bigger') void store.patchSettings({ appearance: { ...settings.appearance, fontSizePx: clamp((settings.appearance.fontSizePx || 19) + (act === 'bigger' ? 1 : -1), 12, 48) } });
      else if (act === 'vocab') void chrome.runtime.sendMessage({ type: 'dream-open', page: 'vocab' });
      else if (act === 'voice') this.toggleVoiceMode();
      else if (act === 'pageAuto') this.togglePageAuto();
      else if (act === 'quick') this.toggleQuick(this.panel!.el);
    };
  }

  private setStatus(text: string, bad = false): void {
    this.statusText = text;
    this.statusBad = bad;
    const el = this.panel?.el.querySelector<HTMLElement>('.status');
    if (el) { el.textContent = text; el.classList.toggle('bad', bad); }
  }

  private renderEmpty(msg: string): void {
    const doc = this.panel?.el.querySelector<HTMLElement>('.doc-inner');
    if (doc) doc.innerHTML = `<div class="empty">${esc(msg)}</div>`;
  }

  private renderOpts() {
    return {
      dict: this.dict!, names: this.names, learner: settings.learnerLevel, vocab: vocab.words,
      marked: extras.stopSentences ? this.hardSentences.filter((m) => { const st = vocab.words[sentenceLemma(m.text)]; return st !== 'known' && st !== 'ignored'; }) : [],
      hints: settings.appearance.showHints !== false,
      hintOverrides: Object.fromEntries(Object.entries(this.hints).map(([l, v]) => [l, v[0]])),
      phrases: (key: string) => this.phrases[key],
    };
  }

  /** the whole video as lines (Dream Read's renderer: one span per sentence and per word, highlights, hints) */
  render(): void {
    if (!this.vb || !this.dict) return;
    const { html } = renderChapter(this.vb.book.chapters[0], this.renderOpts());
    const doc = this.panel?.el.querySelector<HTMLElement>('.doc-inner');
    if (doc) doc.innerHTML = html;
    const sdoc = this.stage?.el.querySelector<HTMLElement>('.doc-inner');
    if (sdoc) {
      sdoc.innerHTML = html;
      // every sentence on the page has its own Explain button (play it, explain it, play it again)
      sdoc.querySelectorAll<HTMLElement>('.s').forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'sx'; b.textContent = TOUCH ? 'E' : '▶ Explain'; b.title = 'Explain this sentence';
        b.title = 'Explain this sentence: it plays, the teacher explains it, it plays again';
        s.prepend(b);
      });
      for (const p of this.vb.order) { const zh = this.zh[this.zhKey(p)]; if (zh) this.paintZh(p, zh); }
      this.lyricsPage();
      this.markPart();
    }
    if (this.cur) { const c = this.cur; this.cur = null; this.setCurrent(c); }
    this.renderBandLine();
  }

  /**
   * A sentence's element on a page. A long video's page holds thousands of sentences, and this is asked several times
   * a second (the word being said, the line being heard): the elements are found once per drawing of the page and
   * kept, instead of searching the whole page every time (the 3.7 slowness while playing).
   */
  private sentenceEl(root: HTMLElement | undefined, pos: Position): HTMLElement | null {
    if (!root) return null;
    const key = sentenceKey(pos);
    const first = root.querySelector<HTMLElement>('.s[data-key]');
    let c = this.sEls.get(root);
    const hit = c && c.first === first ? c.map.get(key) : undefined;
    if (hit && hit.isConnected) return hit;
    if (!c || c.first !== first || hit) {
      const map = new Map<string, HTMLElement>();
      // (the first one of a key wins, like querySelector)
      root.querySelectorAll<HTMLElement>('.s[data-key]').forEach((e) => { const k = e.dataset.key!; if (!map.has(k)) map.set(k, e); });
      c = { first, map, n: map.size };
      this.sEls.set(root, c);
      return c.map.get(key) ?? null;
    }
    // (the same page as before and the key was not on it: a part of the video is shown; a look, in case lines were added)
    const again = root.querySelector<HTMLElement>(`.s[data-key="${key}"]`);
    if (again) c.map.set(key, again);
    return again;
  }
  private sEls = new WeakMap<HTMLElement, { first: HTMLElement | null; map: Map<string, HTMLElement>; n: number }>();
  /** the sentence and the word marked now on each page (so the old marks come off without searching the whole page) */
  private marks = new WeakMap<HTMLElement, { s?: HTMLElement | null; w?: Element | null }>();

  private setCurrent(pos: Position): void {
    const prev = this.cur;
    this.cur = pos;
    this.curWord = -1;
    for (const root of [this.panel?.el, this.stage?.el]) {
      if (!root) continue;
      const back = prev && this.vb && comparePositions(pos, prev) < 0;
      const m = this.marks.get(root) ?? {};
      // (the marks put on last time come off; only a page drawn again is searched whole)
      if (m.s && m.s.isConnected && m.s.classList.contains('cur')) { m.s.classList.remove('cur'); m.s.classList.add('past'); }
      else root.querySelectorAll('.s.cur').forEach((e) => { e.classList.remove('cur'); e.classList.add('past'); });
      if (m.w && m.w.isConnected) m.w.classList.remove('cur-w');
      else root.querySelectorAll('.w.cur-w').forEach((e) => e.classList.remove('cur-w'));
      m.w = null;
      if (back || !prev) {
        const keys = new Set<string>();
        for (const p of this.vb!.order) { if (sentenceKey(p) === sentenceKey(pos)) break; keys.add(sentenceKey(p)); }
        root.querySelectorAll<HTMLElement>('.s').forEach((e) => e.classList.toggle('past', keys.has(e.dataset.key ?? '')));
      }
      const el = this.sentenceEl(root, pos);
      if (el) { el.classList.remove('past'); el.classList.add('cur'); }
      m.s = el;
      this.marks.set(root, m);
    }
    this.scrollToCur();
    this.renderBandLine();
    // listening mode: the Chinese of the lines coming up is ready before they are heard
    if (this.stageVisible() && extras.zhLines && this.vb) {
      const i = this.vb.order.findIndex((p) => sentenceKey(p) === sentenceKey(pos));
      if (i >= 0) this.ensureZh(this.vb.order.slice(Math.max(0, i - 3), i + 12));
    }
  }

  /** the play line as a part of the page's height from its top (the setting: 0 = the bottom, 100 = the top) */
  private lineAt(): number { return 1 - clamp(extras.playLine ?? 40, 0, 100) / 100; }
  /** room above the first and under the last sentence, so that every sentence can reach the play line */
  private padPage(): void {
    const page = this.stage?.el.querySelector<HTMLElement>('.page');
    const inner = page?.querySelector<HTMLElement>('.doc-inner');
    if (!page || !inner) return;
    if (!page.clientHeight || this.stage!.el.dataset.view !== 'all') { for (const e of [page, inner]) { e.style.removeProperty('padding-top'); e.style.removeProperty('padding-bottom'); } return; }
    // (the room is in the scrolled text, not on the page itself: the page must be able to get shorter when the
    // "I know" window or the keyboard comes)
    const f = this.lineAt(), h = page.clientHeight;
    const set = (e: HTMLElement, k: 'paddingTop' | 'paddingBottom', v: string) => { if (e.style[k] !== v) e.style[k] = v; };
    set(page, 'paddingTop', '0px'); set(page, 'paddingBottom', '0px');
    set(inner, 'paddingTop', `${Math.round(h * f)}px`); set(inner, 'paddingBottom', `${Math.round(h * (1 - f))}px`);
  }
  /** the playing sentence stays on the play line (its middle on the line, all of it on the page), unless you scrolled a moment ago */
  private scrollToCur(force = false): void {
    if (!this.cur || (!force && Date.now() - this.userScrollAt < 2000)) return;
    // (Reading: an explanation never turns the page; only a sentence that is not on this page brings its page)
    if (this.readView()) { this.followRead(this.sentenceEl(this.stage!.el, this.cur), false); void force; }
    const f = this.lineAt();
    for (const [root, sel] of [[this.panel?.el, '.lines'], [this.stage?.el, '.page']] as const) {
      if (!root) continue;
      const box = root.querySelector<HTMLElement>(sel);
      const el = this.sentenceEl(root, this.cur);
      if (!box || !el || !box.clientHeight || (root === this.stage?.el && this.readView())) continue;
      const h = box.clientHeight, eh = el.offsetHeight;
      // (a sentence longer than the page: from its first line)
      const y = eh + 16 > h ? eh / 2 + 8 : clamp(h * f, eh / 2 + 8, h - eh / 2 - 8);
      const top = box.scrollTop + (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - y + eh / 2;
      box.scrollTo({ top: Math.max(0, top), behavior: force ? 'auto' : 'smooth' });
    }
  }

  private setWord(pos: Position, ti: number): void {
    this.curWord = ti;
    for (const root of [this.panel?.el, this.band?.el, this.stage?.el]) {
      if (!root) continue;
      const m = this.marks.get(root) ?? {};
      // (the word marked last time; the small subtitle line, and a page drawn again, are searched whole)
      if (root !== this.band?.el && m.w && m.w.isConnected && m.w.classList.contains('cur-w')) m.w.classList.remove('cur-w');
      else root.querySelectorAll('.w.cur-w').forEach((e) => e.classList.remove('cur-w'));
      const w = ti >= 0 ? this.sentenceEl(root, pos)?.querySelector(`.w[data-t="${ti}"]`) ?? null : null;
      w?.classList.add('cur-w');
      m.w = w;
      this.marks.set(root, m);
    }
    this.showBandPiece();
    // (the reading pages: the page turns when the word being read is on the next one)
    if (ti >= 0 && this.readView()) this.followRead(this.stage!.el.querySelector<HTMLElement>('.page .w.cur-w'));
  }

  // ---- Reading mode: pages like an e-reader. The text does not move; a thin line follows the word; the page turns by itself ----
  private readPage = 0;
  private readPages = 1;
  /** you turned a page yourself: the pages do not follow the sound for a moment */
  private userPageAt = 0;
  private readView(): boolean { return !!this.stage && this.stage.el.dataset.view === 'read' && this.stageVisible(); }
  /** the pages are laid out again (the screen, the text size or the text changed); the page with the sound is shown */
  private layoutRead(): void {
    const page = this.stage?.el.querySelector<HTMLElement>('.page');
    const inner = page?.querySelector<HTMLElement>('.doc-inner');
    if (!page || !inner) return;
    if (this.stage!.el.dataset.view !== 'read') { inner.style.removeProperty('transform'); inner.style.removeProperty('column-width'); return; }
    const w = page.clientWidth;
    if (!w) return;
    if (inner.style.columnWidth !== `${w}px`) inner.style.columnWidth = `${w}px`;
    this.readPages = Math.max(1, Math.round(inner.scrollWidth / w));
    const at = this.stage!.el.querySelector<HTMLElement>('.page .w.cur-w') ?? (this.cur ? this.sentenceEl(this.stage!.el, this.cur) : null);
    const p = at ? this.pageOf(at) : Math.min(this.readPage, this.readPages - 1);
    // (the same page stays: only its place is set again, nothing slides)
    if (p !== this.readPage || inner.style.transform !== `translateX(${-this.readPage * w}px)`) this.gotoPage(p);
  }
  private pageOf(el: Element): number {
    const page = this.stage!.el.querySelector<HTMLElement>('.page')!;
    const inner = page.querySelector<HTMLElement>('.doc-inner')!;
    const r = el.getClientRects()[0] ?? el.getBoundingClientRect();
    return clamp(Math.floor((r.left - inner.getBoundingClientRect().left + 2) / Math.max(1, page.clientWidth)), 0, this.readPages - 1);
  }
  private gotoPage(n: number): void {
    const page = this.stage?.el.querySelector<HTMLElement>('.page');
    const inner = page?.querySelector<HTMLElement>('.doc-inner');
    if (!page || !inner) return;
    const turned = clamp(n, 0, this.readPages - 1) !== this.readPage;
    this.readPage = clamp(n, 0, this.readPages - 1);
    inner.style.transform = `translateX(${-this.readPage * page.clientWidth}px)`;
    const pg = this.stage!.el.querySelector<HTMLElement>('.pager .pg');
    if (pg) pg.textContent = `${this.readPage + 1} / ${this.readPages}`;
    if (turned && this.card) this.closeCard();
  }
  /** the page with this word or sentence, unless you turned a page yourself a moment ago */
  private followRead(el: Element | null | undefined, force = false): void {
    if (!el || (!force && Date.now() - this.userPageAt < 3000)) return;
    const p = this.pageOf(el);
    if (p !== this.readPage) this.gotoPage(p);
  }
  /** ‹ › or a swipe: one page back or on (the sound goes on; the pages follow it again after a moment, or tap a sentence to play from there) */
  turnPage(dir: number): void {
    if (!this.readView()) return;
    this.userPageAt = Date.now();
    this.gotoPage(this.readPage + dir);
  }
  /** the three modes in turn: Listening, Reading, Video */
  nextMode(): void {
    const next = extras.view === 'listening' ? 'reading' : extras.view === 'reading' ? 'lyrics' : extras.view === 'lyrics' ? 'normal' : 'listening';
    void store.patchExtras({ view: next });
    if (next === 'lyrics') { this.toast('Lyrics mode: the song\'s lyrics, a song introduction first, and explanations about the lyrics.', 5000); return; }
    this.toast(next === 'listening' ? 'Listening mode: all the subtitles, the text moves with the sound.' : next === 'reading' ? 'Reading mode: pages like a book; a thin line follows the word, the pages turn by themselves.' : 'Video mode: the video, with the page at a stop.', 5000);
  }

  /** clicks on the text: a word = explain it (card + voice), double click = I know, a sentence = go there */
  private wireWords(container: HTMLElement): void {
    let clickTimer: ReturnType<typeof setTimeout> | null = null;
    const selectionOf = (): Selection | null => { const r = container.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null }; return r.getSelection?.() ?? document.getSelection(); };
    container.addEventListener('mouseup', () => setTimeout(() => this.onSelection(container, selectionOf()), 0));
    if (TOUCH) this.wireTouchSelect(container);
    container.addEventListener('click', (ev) => {
      // (the end of a finger selection is not a tap)
      if (Date.now() - this.touchSelectedAt < 700) { ev.preventDefault(); ev.stopPropagation(); return; }
      const sx = (ev.target as HTMLElement).closest<HTMLElement>('.sx');
      if (sx) {
        ev.stopPropagation();
        const p = keyToPos(sx.closest<HTMLElement>('.s')?.dataset.key ?? '');
        // (after it: back to how it was, playing or stopped)
        const st = this.playback?.state;
        if (p) this.explainSentenceAt(p, st === 'playing' || st === 'explaining' || !video()?.paused);
        return;
      }
      // the end of selecting words is not a tap on a word
      const sel = selectionOf();
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 1) return;
      const w = (ev.target as HTMLElement).closest<HTMLElement>('.w[data-lemma]');
      const s = (ev.target as HTMLElement).closest<HTMLElement>('.s');
      if (!s) return;
      const pos = keyToPos(s.dataset.key ?? '');
      if (!pos) return;
      if (!w) { this.seekTo(pos); return; }
      // a second tap in time = a double tap = "I know" (a touch screen does not always send its own double-click)
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; if (TOUCH) know(w); return; }
      clickTimer = setTimeout(() => { clickTimer = null; this.tapWord(w, pos); }, TOUCH ? 330 : 260);
    });
    let knownAt = 0, knownLemma = '';
    const know = (w: HTMLElement): void => {
      const lemma = w.dataset.lemma!;
      if (lemma === knownLemma && Date.now() - knownAt < 700) return; // (the double-click of the same two taps)
      knownAt = Date.now(); knownLemma = lemma;
      this.controller?.markKnown(lemma);
      void this.changeStatus(lemma, 'known');
      this.toast(`“${lemma}” marked known`);
      if (this.card?.lemma === lemma) this.closeCard();
    };
    container.addEventListener('dblclick', (ev) => {
      const w = (ev.target as HTMLElement).closest<HTMLElement>('.w[data-lemma]');
      if (!w) return;
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      know(w);
    });
  }

  /** words selected on the page or in the panel: a button "Explain …" appears next to them */
  private onSelection(container: HTMLElement, sel: Selection | null): void {
    const host = container.closest<HTMLElement>('.stage, .panel');
    const btn = host?.querySelector<HTMLButtonElement>(':scope > .selx');
    if (!host || !btn) return;
    // a selection that starts or ends inside a word takes the whole word ("k it up" -> "kick it up")
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const wordOf = (n: Node) => (n.nodeType === 1 ? n as Element : n.parentElement)?.closest<HTMLElement>('.w') ?? null;
      const a = wordOf(range.startContainer), b = wordOf(range.endContainer);
      const whole = range.cloneRange();
      if (a && container.contains(a)) whole.setStartBefore(a);
      if (b && container.contains(b)) whole.setEndAfter(b);
      if (whole.compareBoundaryPoints(Range.START_TO_START, range) !== 0 || whole.compareBoundaryPoints(Range.END_TO_END, range) !== 0) { sel.removeAllRanges(); sel.addRange(whole); }
    }
    const text = sel && !sel.isCollapsed ? sel.toString().replace(/▶ Explain/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const node = sel?.anchorNode ?? null;
    const sEl = node ? (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>('.s') ?? null : null;
    const pos = sEl ? keyToPos(sEl.dataset.key ?? '') : null;
    if (!text || text.length < 2 || text.length > 300 || !pos || !sel?.rangeCount) { btn.hidden = true; return; }
    const r = sel.getRangeAt(0).getBoundingClientRect(), hr = host.getBoundingClientRect();
    btn.textContent = `Explain “${text.length > 30 ? `${text.slice(0, 28)}…` : text}”`;
    btn.hidden = false;
    btn.style.left = `${Math.max(8, Math.min(hr.width - btn.offsetWidth - 8, r.left - hr.left))}px`;
    btn.style.top = `${Math.max(8, r.top - hr.top - btn.offsetHeight - 8)}px`;
    btn.onclick = (ev) => { ev.stopPropagation(); btn.hidden = true; sel.removeAllRanges(); this.explainSelection(text, pos); };
  }

  /** exactly what you selected: one word (its card and RULE ONE) or a phrase / part of a sentence (RULE TWO) */
  /** when a finger selection ended (the tap and the swipe right after it are not theirs) */
  touchSelectedAt = 0;
  /**
   * Select to explain (a phone, every mode): a finger rests on a word for a moment, then slides to the last word, and
   * lifts: those words are explained at once. A whole sentence (or more) gets the sentence steps, a few words the
   * word / phrase steps. A quick move stays a scroll (or a page turn), a quick tap stays a tap.
   */
  private wireTouchSelect(container: HTMLElement): void {
    type Sel = { start: HTMLElement; x: number; y: number; armed: boolean; last: HTMLElement; timer: ReturnType<typeof setTimeout> };
    let sel: Sel | null = null;
    const words = () => Array.from(container.querySelectorAll<HTMLElement>('.s .w'));
    const clear = () => container.querySelectorAll('.w.selw').forEach((e) => e.classList.remove('selw'));
    const range = (a: HTMLElement, b: HTMLElement) => { const all = words(); let i = all.indexOf(a), j = all.indexOf(b); if (i > j) [i, j] = [j, i]; return i < 0 || j < 0 ? [] : all.slice(i, j + 1); };
    const paint = (a: HTMLElement, b: HTMLElement) => { clear(); for (const w of range(a, b)) w.classList.add('selw'); };
    const wordAt = (x: number, y: number): HTMLElement | null => {
      const root = container.getRootNode() as ShadowRoot & { elementFromPoint?: (x: number, y: number) => Element | null };
      const el = root.elementFromPoint?.(x, y) ?? document.elementFromPoint(x, y);
      return (el as HTMLElement | null)?.closest<HTMLElement>('.w') ?? null;
    };
    container.addEventListener('touchstart', (ev) => {
      if (sel) clearTimeout(sel.timer);
      sel = null;
      const t = ev.touches[0];
      const w = (ev.target as HTMLElement).closest<HTMLElement>('.s .w');
      if (ev.touches.length !== 1 || !t || !w) return;
      const s: Sel = { start: w, x: t.clientX, y: t.clientY, armed: false, last: w, timer: setTimeout(() => { if (sel === s) { s.armed = true; paint(w, w); } }, 260) };
      sel = s;
    }, { passive: true });
    container.addEventListener('touchmove', (ev) => {
      if (!sel) return;
      const t = ev.touches[0];
      if (!t) return;
      if (!sel.armed) { if (Math.hypot(t.clientX - sel.x, t.clientY - sel.y) > 8) { clearTimeout(sel.timer); sel = null; } return; }
      // (selecting: no scroll, no page turn)
      if (ev.cancelable) ev.preventDefault();
      const w = wordAt(t.clientX, t.clientY);
      if (w && w !== sel.last) { sel.last = w; paint(sel.start, w); }
    }, { passive: false });
    const end = (ev: TouchEvent) => {
      const s = sel;
      sel = null;
      if (!s) return;
      clearTimeout(s.timer);
      if (!s.armed) return;
      if (ev.cancelable) ev.preventDefault();
      this.touchSelectedAt = Date.now();
      const picked = range(s.start, s.last);
      setTimeout(clear, 600);
      const text = picked.map((w) => w.textContent ?? '').join(' ').replace(/\s+([,.!?;:'’”)])/g, '$1').replace(/([“(])\s+/g, '$1').replace(/\s+/g, ' ').trim();
      const sents = [...new Set(picked.map((w) => w.closest<HTMLElement>('.s')).filter((x): x is HTMLElement => !!x))];
      const first = sents[0] ? keyToPos(sents[0].dataset.key ?? '') : null;
      if (!text || !first) return;
      if (!this.ai()) { this.freeNote(); return; }
      const st = this.playback?.state;
      const wasPlaying = st === 'playing' || st === 'explaining' || !video()?.paused;
      const sentWords = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('.w[data-lemma]'));
      const whole = sents.length === 1 && (() => { const ws = sentWords(sents[0]); return ws.length > 0 && picked.includes(ws[0]) && picked.includes(ws[ws.length - 1]); })();
      this.trail(`selected: ${text.slice(0, 40)}`);
      if (whole) this.explainSentenceAt(first, wasPlaying);
      else if (sents.length > 1) { this.closeCard(); void this.controller?.explainNow('sentence', text, first, null, sentenceLemma(text), undefined, wasPlaying); }
      else this.explainSelection(text, first, wasPlaying);
    };
    container.addEventListener('touchend', end, { passive: false });
    container.addEventListener('touchcancel', () => { if (sel) clearTimeout(sel.timer); sel = null; clear(); });
  }

  explainSelection(text: string, pos: Position, resumeAfter?: boolean): void {
    const c = this.controller;
    if (!c || !this.vb) return;
    if (!this.ai()) { this.freeNote(); return; }
    const st = this.playback?.state;
    const wasPlaying = resumeAfter ?? (st === 'playing' || st === 'explaining' || !video()?.paused);
    this.endFlow();
    this.closeTalk();
    if (c.busy || this.cmdWin) c.skip();
    this.playback?.pause();
    this.engine.target = pos;
    this.setCurrent(pos);
    const word = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (word && !/\s/.test(word)) {
      const entry = this.dict?.lookup(word)?.entry;
      const lemma = this.dict?.lemmaOf(word) || word.toLowerCase();
      // (a touch screen with the big card: what was selected gets its card too: the word, or the phrase with its translation)
      if (TOUCH && cardBig()) this.openCard(pos, -1, lemma, word, 'word', null);
      this.explainByHand('word', word, pos, entry ? { ipa: entry.ipa, zh: entry.zh.split('\n')[0], level: entry.level } : null, lemma, wasPlaying);
    } else {
      if (TOUCH && cardBig()) this.openCard(pos, -1, text.toLowerCase(), text, 'phrase', null);
      this.explainByHand('phrase', text, pos, null, text.toLowerCase(), wasPlaying);
    }
  }

  /** 🎤 Speak: one question by voice (Chrome writes it down into the box), sent when you stop talking */
  private ptt: { stop(): void } | null = null;
  private pttActive = false;
  private pushToTalk(el: HTMLElement): void {
    if (this.ptt) { this.ptt.stop(); return; }
    const SR = (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (!SR) { this.toast('Speech recognition is not available in this browser. Type your question.', 6000); return; }
    const btn = el.querySelector<HTMLButtonElement>('form.ask [data-act="speak"]');
    const inp = el.querySelector<HTMLInputElement>('form.ask input');
    this.pttActive = true; // the page's other listening pauses meanwhile (one microphone user at a time)
    if (btn) btn.textContent = '● Listening… (click = send)';
    this.talk?.chat?.interrupt();
    this.tts?.cancelAll();
    let said = '';
    const r = new SR();
    r.lang = 'en-US'; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    r.onresult = (e) => {
      said = Array.from({ length: e.results.length }, (_, i) => e.results[i][0].transcript).join(' ').replace(/\s+/g, ' ').trim();
      if (inp) inp.value = said;
    };
    r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.toast('The microphone is blocked for youtube.com: click the icon left of the address bar → Microphone → Allow.', 9000); };
    r.onend = () => {
      this.ptt = null; this.pttActive = false;
      if (btn) btn.textContent = '🎤 Speak';
      const q = said.trim();
      if (q) { if (inp) inp.value = ''; this.ask(q, true); }
    };
    const handle = { stop: () => { try { r.stop(); } catch { /* already over */ } } };
    this.ptt = handle;
    // a moment for the page's own listening to let go of the microphone
    setTimeout(() => { try { r.start(); } catch { r.onend?.(); } }, 350);
    // never keep the microphone longer than one question (a recognizer that never ends)
    setTimeout(() => { if (this.ptt === handle) { try { r.stop(); } catch { /* over */ } setTimeout(() => { if (this.ptt === handle) r.onend?.(); }, 1500); } }, 20000);
  }

  private seekTo(pos: Position): void {
    const t = this.vb?.timingOf(pos), v = video();
    if (!t || !v) return;
    if (this.playback) {
      this.endFlow();
      this.closeTalk();
      if (this.controller?.busy || this.cmdWin) this.controller?.skip();
      this.playback.seek(pos);
      if (v.paused) this.playback.play(pos); // the engine jumps to the sentence start
    } else { v.currentTime = Math.max(0, t.start - 0.15); this.setCurrent(pos); }
  }

  private tapWord(w: HTMLElement, pos: Position): void {
    if (!this.vb) return;
    const ti = Number(w.dataset.t);
    const lemma = w.dataset.lemma!;
    const target = w.textContent?.trim() ?? lemma;
    this.openCard(pos, ti, lemma, target, 'word', null, w);
    // a single tap = "don't know": it is to learn now, with the sentence where it was met
    if (this.levelOn() && !vocab.words[lemma]) { vocab.words[lemma] = 'learning'; void store.setWordStatus(lemma, 'learning', { word: target, sentence: getSentence(this.vb.book, pos)?.text ?? '' }); this.countKnown(); }
    // (free mode: only the card, from the dictionary)
    if (this.ai() && this.controller) {
      const entry = this.dict?.lookup(target)?.entry;
      this.engine.target = pos;
      this.explainByHand('word', target, pos, entry ? { ipa: entry.ipa, zh: entry.zh.split('\n')[0], level: entry.level } : null, lemma);
    }
  }

  /**
   * A word or phrase asked for by hand is explained. Its card stays for "the word again" and closes when the sentence
   * plays; should no sentence play (the word IS the sentence, the video was stopped), it closes when all is over.
   */
  private explainByHand(kind: 'word' | 'phrase', target: string, pos: Position, dict: { ipa: string; zh: string; level: string } | null, lemma: string, resume?: boolean, again?: boolean): void {
    const c = this.controller;
    if (!c) return;
    // (also when it was cut short, "bye", with the video stopped: a big card must never stay over the page; not when a
    // newer explanation of the same word has taken over)
    const over = () => { if (this.card?.lemma === lemma && (this.cardKept || this.card.full) && !c.busy) this.closeCard(); };
    void c.explainNow(kind, target, pos, dict as never, lemma, undefined, resume, again).then(over, over);
  }

  // ---- the word card ---------------------------------------------------------------------------------------------
  private anchorStopCard(kind: string, target: string, lemma?: string): void {
    const pos = this.playback?.position ?? this.cur;
    if (!pos || !lemma) return;
    const root = this.visibleRoot();
    const sEl = this.sentenceEl(root, pos);
    const words = Array.from(sEl?.querySelectorAll<HTMLElement>('.w[data-lemma]') ?? []);
    const el = words.find((w) => w.dataset.lemma === lemma) ?? words.find((w) => (w.textContent ?? '').trim().toLowerCase() === target.toLowerCase().split(' ')[0]);
    this.openCard(pos, el ? Number(el.dataset.t) : 0, lemma, target, kind === 'phrase' ? 'phrase' : 'word', null, el ?? undefined, { full: true });
  }

  private visibleRoot(): HTMLElement | undefined {
    if (this.stageVisible()) return this.stage!.el;
    return this.bandVisible() ? this.band?.el : this.panel?.el ?? this.band?.el;
  }

  private openCard(pos: Position, token: number, lemma: string, target: string, kind: 'word' | 'phrase' | 'sentence', entryId: number | null, anchor?: HTMLElement, opts?: { full?: boolean }): void {
    if (this.cardClose) { clearTimeout(this.cardClose); this.cardClose = null; }
    // (Settings → Card: Big = the whole screen, for a stop and for what the learner taps or selects alike; Small =
    // the small card everywhere. A computer always has the small card.)
    // (`opts.full` now only says: a STOP opened this card. Free mode, with no AI: a word tapped by hand keeps the
    // small card, which has its own buttons and closes by its own ✕; a stop there has the big one.)
    const byStop = !!opts?.full;
    const full = TOUCH && cardBig() && (this.ai() || byStop);
    const prev = this.card;
    // (page off: the full card shows the page under it, as its background; it goes again when the card closes)
    let forcedStage = !!(full && prev?.full && prev.forcedStage);
    if (full && !this.stageVisible() && this.stage) { this.showStage(undefined, true); forcedStage = this.stageVisible(); }
    this.card = { lemma, word: target, pos, token, kind, entryId, full, forcedStage, openedAt: Date.now(), stop: byStop };
    if (full) return this.paintFullCard();
    if (prev?.full) { this.stage?.el.classList.remove('fullcard'); document.documentElement.classList.remove('dr-fullcard'); }
    if (kind === 'sentence') return;
    const root = this.visibleRoot();
    for (const r of [this.panel?.el, this.band?.el, this.stage?.el]) { if (r && r !== root) { const c = r.querySelector<HTMLElement>('.card'); if (c) c.hidden = true; } }
    const cardEl = root?.querySelector<HTMLElement>('.card');
    if (!root || !cardEl) return;
    for (const r of [this.panel?.el, this.band?.el, this.stage?.el]) r?.querySelectorAll('.stop-target').forEach((e) => e.classList.remove('stop-target'));
    const el = (anchor && root.contains(anchor) ? anchor : undefined) ?? this.sentenceEl(root, pos)?.querySelector<HTMLElement>(`.w[data-t="${token}"]`) ?? undefined;
    el?.classList.add('stop-target');
    const look = this.dict?.lookup(kind === 'word' ? target : lemma) ?? (kind === 'phrase' ? this.dict?.lookupPhrase(target.split(/\s+/)) : null) ?? null;
    const entry = look?.entry;
    // (the AI's meaning in THIS sentence; another sentence's meaning shows for the moment while the AI is asked)
    const hx = this.zhHere(pos, lemma, target, kind);
    const here: [string, string?] | undefined = hx.sure ? [hx.zh, this.hints[lemma]?.[0] === hx.zh ? this.hints[lemma]?.[1] : undefined] : this.hints[lemma];
    // (a computer's Level Check card shows no Chinese: nothing is asked for it)
    if (!hx.sure && this.hints[lemma] && !(this.levelOn() && !TOUCH)) this.askHere(pos, lemma, target);
    const glosses = entry?.zh ? parseGloss(entry.zh).slice(0, here ? 1 : 2) : [];
    const level = entry?.level ?? (this.phrases[sentenceKey(pos)]?.find((p) => p.lemma === lemma)?.level as string | undefined) ?? '';
    const status = vocab.words[lemma];
    // (Level Check: the explanation has no Chinese and no IPA, so neither has its card)
    // (Level Check: the explanation has no Chinese and no IPA; a phone's card is the Chinese dictionary: the word and its Chinese)
    const plain = this.levelOn() && !TOUCH;
    const noIpa = this.levelOn() || TOUCH;
    cardEl.innerHTML = `<div class="hw"><span class="word">${esc(target)}</span>${entry?.ipa && !noIpa ? `<span class="ipa">${esc(entry.ipa)}</span>` : ''}<button class="quiet" data-act="say" title="Say the word">▶</button><span class="grow"></span>${level ? `<span class="lvl">${esc(level)}</span>` : ''}</div>
      ${plain ? '' : `<div class="zh here"${here ? '' : ' data-ai="1"'}>${here ? `<span><span class="pos">here</span>${esc(here[0])}${here[1] ? `<span class="pos"> · ${esc(here[1])}</span>` : ''}</span>` : '<span class="muted">AI 中文…</span>'}</div>
      ${glosses.length ? `<div class="zh">${glosses.map((g) => `<span>${g.pos ? `<span class="pos">${esc(g.pos)}</span>` : ''}${esc(g.zh)}</span>`).join('')}</div>` : '<div class="muted">Not in the offline dictionary.</div>'}`}
      <div class="en"></div>
      <div class="row"><button data-act="known" class="${status === 'known' ? 'active' : ''}">I know</button><button data-act="dontknow" class="${status === 'learning' ? 'active' : ''}">I don't know</button><button data-act="ignore">Ignore</button>
      ${plain || TOUCH ? '' : `<button data-act="zh" class="${settings.ai.speakChinese ? 'active' : ''}">中文 ${settings.ai.speakChinese ? 'on' : 'off'}</button>`}<span class="grow"></span><button class="quiet" data-act="close" title="Close">✕</button></div>`;
    cardEl.hidden = false;
    cardEl.classList.remove('full', 'sentence', 'one');
    cardEl.removeAttribute('role');
    cardEl.removeAttribute('aria-label');
    cardEl.ontouchstart = cardEl.ontouchend = null;
    // the AI's meaning in this very sentence, written live (when the video's hints do not have this word)
    // (on every device: the card's Chinese is always the AI's meaning in context, the learner's rule of 13 Nov)
    if (!plain && !here && this.vb && this.ai() && (this.keys.anthropic || this.keys.openai)) {
      const sent = getSentence(this.vb.book, pos)?.text ?? '';
      const row = cardEl.querySelector<HTMLElement>('.zh.here');
      const job = completeStream(buildWordPrompt(target, sent), (full) => { if (row && this.card?.lemma === lemma) row.innerHTML = `<span><span class="pos">here</span>${esc(full.trim())}</span>`; });
      void job.done.then((full) => {
        const m = parseWordMeanings(full);
        if (!m) { if (row) row.innerHTML = ''; return; }
        this.hints[lemma] = m;
        this.liveHints.add(lemma);
        this.hereZh.set(`${lemma}@${sentenceKey(pos)}`, m[0]);
        this.saveHereSoon();
        if (row && this.card?.lemma === lemma) row.innerHTML = `<span><span class="pos">here</span>${esc(m[0])}${m[1] ? `<span class="pos"> · ${esc(m[1])}</span>` : ''}</span>`;
      }, () => { if (row) row.innerHTML = ''; });
    } else if (!here) cardEl.querySelector('.zh.here')?.remove();
    // the page with the part: the card gets its own column on the right (it must not hide a word of the part)
    const side = root === this.stage?.el && root.dataset.view === 'part' && root.clientWidth >= 760;
    this.stage?.el.classList.toggle('card-side', side);
    if (side) {
      cardEl.style.left = '';
      cardEl.style.top = `${(root.querySelector<HTMLElement>('.page')?.offsetTop ?? 56) + 14}px`;
      this.fitPart();
    } else {
      // under the word, inside the visible area
      const rr = root.getBoundingClientRect();
      const wr = el?.getBoundingClientRect();
      const x = wr ? wr.left - rr.left + wr.width / 2 : rr.width / 2;
      // (a phone: under the whole sentence, so the sentence stays readable)
      const ar = (TOUCH ? this.sentenceEl(root, pos)?.getBoundingClientRect() : undefined) ?? wr;
      let y = ar ? ar.bottom - rr.top + 8 : 60;
      cardEl.style.left = `${Math.max(8, Math.min(rr.width - 308, x - 150))}px`;
      if (y + 220 > rr.height && ar) y = Math.max(8, ar.top - rr.top - 8 - cardEl.offsetHeight);
      cardEl.style.top = `${y}px`;
      cardEl.style.removeProperty('bottom');
      if (TOUCH) {
        // (a phone: the whole width, at the top, or at the bottom when the sentence is in the upper half: the page
        // may move under it, but the sentence on the play line / on this page is never covered)
        cardEl.style.left = '8px';
        const upper = ar ? (ar.top + ar.bottom) / 2 - rr.top < rr.height * 0.45 : false;
        const cmd = this.stage?.el.querySelector<HTMLElement>('.cmd');
        const below = (this.stage?.el.querySelector<HTMLElement>('.dock')?.offsetHeight ?? 0) + (cmd && !cmd.hidden ? cmd.offsetHeight + 16 : 0);
        if (upper) { cardEl.style.top = 'auto'; cardEl.style.bottom = `${8 + below}px`; }
        else cardEl.style.top = 'calc(8px + env(safe-area-inset-top))';
      }
    }
    cardEl.onclick = (ev) => {
      ev.stopPropagation();
      const act = (ev.target as HTMLElement).closest('button')?.dataset.act;
      if (!act || !this.card) return;
      const c = this.card;
      if (act === 'close') this.closeCard();
      else if (act === 'say') { const h = this.wordOut?.speak(c.word, { voiceId: this.voiceId, rate: Math.min(settings.voice.rate, 0.9) }); void h; }
      else if (act === 'known') { this.controller?.markKnown(c.lemma); void this.changeStatus(c.lemma, 'known'); if (this.controller?.stopWindow) this.answerKnow(); this.closeCard(); }
      else if (act === 'dontknow') { if (this.controller?.stopWindow) this.answerDontKnow(); else if (this.cardKept) this.answerDontKnow(); else if (this.inStop && this.levelOn()) { this.controller?.answerEarly(); } else { void this.changeStatus(c.lemma, 'learning'); if (this.ai()) { this.engine.target = c.pos; void this.controller?.explainNow(c.kind, c.word, c.pos, null, c.lemma, undefined, undefined, true); } } }
      else if (act === 'ignore') { this.controller?.markKnown(c.lemma); void this.changeStatus(c.lemma, 'ignored'); this.closeCard(); if (this.controller?.stopWindow) this.answerGoOn(); }
      else if (act === 'zh') { void store.patchSettings({ ai: { ...settings.ai, speakChinese: !settings.ai.speakChinese } }); }
    };
  }

  /**
   * The full stop card (a touch screen): the word, phrase or sentence very big in the middle of the screen and its
   * Chinese big under it; nothing else (the learner's rule: no buttons, no labels, no small text). The whole card is
   * the "I know" button; no tap = "I don't know" (the window runs out, the tutor explains). Only what costs nothing:
   * the dictionary, the video's Chinese meanings and translations already made; never the AI.
   */
  private paintFullCard(): void {
    const c = this.card;
    const root = this.stage?.el;
    const cardEl = root?.querySelector<HTMLElement>('.card');
    if (!c || !root || !cardEl) return;
    for (const r of [this.panel?.el, this.band?.el]) { const o = r?.querySelector<HTMLElement>('.card'); if (o) o.hidden = true; }
    for (const r of [this.panel?.el, this.band?.el, root]) r?.querySelectorAll('.stop-target').forEach((e) => e.classList.remove('stop-target'));
    root.classList.remove('card-side');
    root.classList.add('fullcard');
    document.documentElement.classList.add('dr-fullcard');
    const { lemma, word: target, kind, pos } = c;
    let zh = '';
    // (a WORD shows its pronunciation too; a phrase or a sentence: only the text and its translation)
    let ipa = '';
    if (kind === 'sentence') {
      // the sentence: its translation when one was made already, otherwise the Chinese of its hard words (up to 3)
      // while the device translates it (Apple's Translation, free; the card shows it as soon as it comes)
      zh = esc(this.zh[this.zhKey(pos)] ?? '');
      if (!zh) this.translateHere(pos);
      if (!zh) {
        const seen = new Set<string>();
        const parts: string[] = [];
        for (const w of Array.from(this.sentenceEl(root, pos)?.querySelectorAll<HTMLElement>('.w.hl-unknown[data-lemma], .w.hl-learning[data-lemma]') ?? [])) {
          const l = w.dataset.lemma!;
          if (seen.has(l) || parts.length >= 3) continue;
          seen.add(l);
          const e = this.dict?.lookup(l)?.entry;
          const g = this.hints[l]?.[0] || (e?.zh ? parseGloss(e.zh)[0]?.zh : '') || '';
          if (g) parts.push(`${esc((w.textContent ?? l).trim())} ${esc(g)}`);
        }
        zh = parts.join('<br>');
      }
    } else {
      // a word or phrase: ONE meaning, the AI's meaning in this sentence (zhHere); when only another sentence's
      // meaning or the dictionary's is there, that shows for the moment and the AI is asked now
      const h = this.zhHere(pos, lemma, target, kind);
      zh = esc(h.zh);
      if (!h.sure) this.askHere(pos, lemma, target);
      if (kind === 'word') ipa = (this.dict?.lookup(target) ?? this.dict?.lookup(lemma))?.entry.ipa ?? '';
    }
    cardEl.innerHTML = `<div class="word">${esc(target)}</div>${ipa ? `<div class="ipa">${esc(/^[\/\[]/.test(ipa) ? ipa : `/${ipa}/`)}</div>` : ''}${zh ? `<div class="zh here">${zh}</div>` : ''}`;
    cardEl.style.removeProperty('left');
    cardEl.style.removeProperty('top');
    cardEl.style.removeProperty('bottom');
    cardEl.classList.add('full');
    cardEl.classList.toggle('sentence', kind === 'sentence');
    cardEl.classList.toggle('one', !zh);
    cardEl.setAttribute('role', 'button');
    cardEl.setAttribute('aria-label', `I know: ${target}`);
    cardEl.hidden = false;
    this.fitFullCard();
    // (the tap is ours alone: the page under it never sees it, and iOS makes no click of its own after it)
    // Guards, so that "I know" is never said by accident: a real tap is short (under half a second) and does not
    // move; a touch that starts in the outer 16 pt at the left or right (the edge swipe, the hand holding the phone)
    // does not count.
    let down: { x: number; y: number; at: number } | null = null;
    const pointOf = (ev: Event): { x: number; y: number } | null => {
      const t = (ev as TouchEvent).changedTouches?.[0] ?? (ev as TouchEvent).touches?.[0];
      if (t) return { x: t.clientX, y: t.clientY };
      const m = ev as MouseEvent;
      return typeof m.clientX === 'number' && (m.clientX || m.clientY) ? { x: m.clientX, y: m.clientY } : null;
    };
    const tap = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.type === 'touchstart') { const p = pointOf(ev); down = p ? { ...p, at: Date.now() } : null; return; }
      if (ev.type === 'click' && Date.now() - this.cardTouchAt < 700) return;
      const p = pointOf(ev);
      if (ev.type === 'touchend') {
        this.cardTouchAt = Date.now();
        const d = down; down = null;
        if (d && p && (Date.now() - d.at > 500 || Math.hypot(p.x - d.x, p.y - d.y) > 12)) return;
        if (d && (d.x < 16 || d.x > innerWidth - 16)) return;
      } else if (p && (p.x < 16 || p.x > innerWidth - 16)) return;
      this.tapFullCard();
    };
    cardEl.ontouchstart = tap;
    cardEl.ontouchend = tap;
    cardEl.onclick = tap;
  }

  // ---- the card's Chinese: the AI's meaning of the word IN THIS SENTENCE ------------------------------------------
  /** by word + sentence: meanings asked for in real time (the video's analysis has one meaning per word, for the
   *  sentence the word first comes in) */
  private hereZh = new Map<string, string>();
  private hereAsked = new Set<string>();
  /** words whose hint was made in real time, for the sentence of that moment (not by the video's analysis) */
  private liveHints = new Set<string>();
  private firstAt: Map<string, string> | null = null;
  private firstAtOf: unknown = null;
  /** the sentence a word first comes in (the one the video's analysis translated it for) */
  private firstSentenceOf(lemma: string): string | undefined {
    if (!this.vb || !this.dict) return undefined;
    if (!this.firstAt || this.firstAtOf !== this.vb) {
      const m = new Map<string, string>();
      for (const pos of this.vb.order) {
        const key = sentenceKey(pos);
        for (const t of getSentence(this.vb.book, pos)?.sentence.tokens ?? []) { if (t.kind !== 'word') continue; const l = this.dict.lemmaOf(t.text); if (!m.has(l)) m.set(l, key); }
      }
      this.firstAt = m; this.firstAtOf = this.vb;
    }
    return this.firstAt.get(lemma);
  }
  /**
   * The Chinese of a word or phrase for the card: `sure` = made by the AI for this very sentence. Not sure (the
   * analysis translated it for another sentence, or only the dictionary has it): that is shown for the moment, and
   * the AI is asked now for the meaning here (once per word and sentence; askHere).
   */
  private zhHere(pos: Position, lemma: string, target: string, kind: 'word' | 'phrase' | 'sentence'): { zh: string; sure: boolean } {
    const key = sentenceKey(pos);
    const asked = this.hereZh.get(`${lemma}@${key}`);
    if (asked) return { zh: asked, sure: true };
    if (kind === 'phrase') { const z = this.phrases[key]?.find((p) => p.lemma === lemma)?.zh; if (z) return { zh: z, sure: true }; }
    const hint = this.hints[lemma]?.[0];
    // (the analysis made it for the sentence the word first comes in; one made in real time was made for the sentence
    // of that moment, which is in hereZh already)
    if (hint && !this.liveHints.has(lemma) && (kind === 'phrase' || this.firstSentenceOf(lemma) === key)) return { zh: hint, sure: true };
    if (hint) return { zh: hint, sure: false };
    const look = this.dict?.lookup(kind === 'word' ? target : lemma) ?? (kind === 'phrase' ? this.dict?.lookupPhrase(target.split(/\s+/)) : null) ?? null;
    const z = look?.entry.zh;
    return { zh: z ? parseGloss(z).slice(0, 1).map((g) => g.zh).filter(Boolean).join('；') : '', sure: false };
  }
  /** the AI is asked for the meaning in this sentence (a small request, once); the card on the screen takes it */
  private askHere(pos: Position, lemma: string, target: string): void {
    const k = `${lemma}@${sentenceKey(pos)}`;
    if (this.hereAsked.has(k) || !this.vb || !this.ai() || (!this.keys.anthropic && !this.keys.openai)) return;
    this.hereAsked.add(k);
    const sent = getSentence(this.vb.book, pos)?.text ?? '';
    if (!sent) return;
    void complete(buildWordPrompt(target, sent)).then((full) => {
      const m = parseWordMeanings(full);
      if (!m?.[0] || this.disposed) return;
      this.hereZh.set(k, m[0]);
      if (!this.hints[lemma]) { this.hints[lemma] = m; this.liveHints.add(lemma); }
      this.saveHereSoon();
      const c = this.card;
      if (!c || c.lemma !== lemma || sentenceKey(c.pos) !== sentenceKey(pos)) return;
      if (c.full) this.paintFullCard();
      else { const row = this.visibleRoot()?.querySelector<HTMLElement>('.card .zh.here'); if (row) row.innerHTML = `<span><span class="pos">here</span>${esc(m[0])}</span>`; }
    }, () => { this.hereAsked.delete(k); });
  }
  private hereSave: ReturnType<typeof setTimeout> | null = null;
  /** kept with the video's analysis: the next stop at it, or the next viewing, asks nothing */
  private saveHereSoon(): void {
    if (this.hereSave) clearTimeout(this.hereSave);
    this.hereSave = setTimeout(() => {
      this.hereSave = null;
      const id = this.cacheId();
      void store.getVideoHints(id).then((h) => { if (h) return store.setVideoHints(id, { ...h, here: Object.fromEntries(this.hereZh) } as store.VideoHints); return undefined; }).catch(() => undefined);
    }, 2500);
  }

  /** the full card's text fits the screen: smaller, step by step, until nothing is cut (a long sentence, a turned phone) */
  private fitFullCard(): void {
    const cardEl = this.card?.full ? this.stage?.el.querySelector<HTMLElement>('.card.full') : null;
    if (!cardEl) return;
    const parts = Array.from(cardEl.querySelectorAll<HTMLElement>('.word, .ipa, .zh'));
    for (const p of parts) p.style.removeProperty('font-size');
    const base = parts.map((p) => parseFloat(getComputedStyle(p).fontSize) || 20);
    const over = () => cardEl.scrollHeight > cardEl.clientHeight + 1 || parts.some((p) => p.scrollWidth > p.clientWidth + 1);
    for (let k = 0.92; over() && k > 0.3; k *= 0.92) parts.forEach((p, i) => { p.style.fontSize = `${Math.max(14, Math.round(base[i] * k))}px`; });
  }

  /** a tap on the full card = "I know" (not in the first 450 ms: that tap was meant for what was there before) */
  private tapFullCard(): void {
    const c = this.card;
    if (!c?.full || Date.now() - c.openedAt < 450) return;
    this.trail(`full card: I know (${c.word.slice(0, 40)})`);
    const ctl = this.controller;
    // (the stop's or the running explanation's own word: the stop takes the answer. Any other card, e.g. a word tapped
    // by hand long after the last stop: THIS word is known, and the video stays as it is.)
    if (ctl && ctl.lastExplained?.lemma === c.lemma && (this.inStop || ctl.busy || ctl.stopWindow)) this.answerKnow();
    else { ctl?.markKnown(c.lemma); void this.changeStatus(c.lemma, 'known'); }
    if (this.card === c) this.closeCard();
  }

  private closeCardLater(): void {
    if (this.cardClose) clearTimeout(this.cardClose);
    this.cardClose = setTimeout(() => this.closeCard(), 0);
  }
  private updateCardExplain(e: TranscriptEntry): void {
    const en = this.visibleRoot()?.querySelector<HTMLElement>('.card .en');
    if (!en) return;
    if (e.status === 'error') en.textContent = e.error ?? 'The explanation failed.';
    else en.textContent = e.text ? firstSentences(shown(e.text), 180) : e.status === 'thinking' ? 'Explaining…' : '';
  }

  private closeCardSoon(): void {
    if (this.cardClose) clearTimeout(this.cardClose);
    this.cardClose = setTimeout(() => this.closeCard(), 1500);
  }
  /** the card stays after the explanation, until the sentence plays again (or the explanation ends another way) */
  private cardKept = false;
  private closeCard(): void {
    this.cardKept = false;
    if (this.cardClose) { clearTimeout(this.cardClose); this.cardClose = null; }
    const was = this.card;
    this.card = null;
    for (const r of [this.panel?.el, this.band?.el, this.stage?.el]) {
      if (!r) continue;
      const c = r.querySelector<HTMLElement>('.card');
      // (a closed card is nothing: not big, no tap of its own, no text left in it)
      if (c) { c.hidden = true; c.classList.remove('full', 'sentence', 'one'); c.ontouchstart = c.ontouchend = null; c.onclick = null; c.removeAttribute('role'); c.removeAttribute('aria-label'); }
      r.querySelectorAll('.stop-target').forEach((e) => e.classList.remove('stop-target'));
    }
    this.stage?.el.classList.remove('fullcard');
    document.documentElement.classList.remove('dr-fullcard');
    if (this.stage?.el.classList.contains('card-side')) { this.stage.el.classList.remove('card-side'); this.fitPart(); }
    // (page off: the page the full card showed goes again, unless something else needs it now)
    if (was?.forcedStage && normalView() && !this.flow && !this.talk) this.hideStage();
  }

  // ---- the commands window ---------------------------------------------------------------------------------------
  private showCommandWindow(w: CommandWindow | null): void {
    this.cmdWin = w;
    const target = this.visibleRoot();
    const sc = shortcutMap(extras.shortcuts);
    for (const r of [this.panel?.el, this.band?.el, this.stage?.el]) {
      const el = r?.querySelector<HTMLElement>('.cmd');
      if (!el) continue;
      // the talk replaces the countdown after an explanation
      if (!w || r !== target || (w.phase === 'after' && this.talk)) { el.hidden = true; el.innerHTML = ''; continue; }
      // before the explanation: only "I know" / "I don't know"; after it: no buttons, a moment to ask
      const label = w.phase === 'before' ? (w.kind === 'sentence' ? 'Do you understand this sentence?' : `Do you know “${esc(w.target)}”?`) : 'Ask me now, or the video goes on…';
      el.innerHTML = `<div class="label">${label}</div>${w.phase === 'before' ? `<div class="buttons"><button class="c know" data-act="know">I know <kbd>${esc(comboLabel(sc.know))}</kbd></button><button class="c" data-act="dont">I don’t know <kbd>${esc(comboLabel(sc.dontKnow))}</kbd></button></div>` : ''}<div class="count"><span style="animation-duration:${Math.max(0, w.ms)}ms"></span></div>`;
      el.hidden = false;
      el.onclick = (ev) => {
        const act = (ev.target as HTMLElement).closest('button')?.dataset.act;
        if (act === 'know') this.answerKnow(); else if (act === 'dont') this.answerDontKnow(); else if (act === 'go') this.answerGoOn();
      };
    }
  }

  private renderTranscript(): void {
    const box = this.panel?.el.querySelector<HTMLElement>('.transcript');
    if (box) {
      const items = this.transcript.slice(-12).map((e) => {
        // (Level Check: only the explanation, no heading over it)
        const ruled = this.levelOn() && e.kind !== 'question' && e.kind !== 'passage';
        const head = ruled ? '' : e.kind === 'question' ? `You: ${esc(e.question ?? '')}` : e.kind === 'passage' ? 'The last part' : esc(e.target);
        const st = e.status === 'thinking' ? 'thinking…' : e.status === 'speaking' ? 'speaking' : e.status === 'error' ? 'error' : '';
        const zh = e.chinese && !ruled ? `<div class="zh">${esc(e.chinese.split('\n')[0])}</div>` : '';
        return `<div class="entry ${e.status === 'error' ? 'error' : ''}"><div class="target">${head} <span class="st">${st}</span></div>${zh}<div class="body">${esc(e.status === 'error' ? e.error ?? '' : shown(e.text))}</div></div>`;
      });
      box.innerHTML = items.join('');
      box.scrollTop = box.scrollHeight;
    }
    // the page: what the teacher is saying now
    const say = this.stage?.el.querySelector<HTMLElement>('.dock .say');
    if (say) {
      const last = this.transcript[this.transcript.length - 1];
      const live = last && (last.status === 'thinking' || last.status === 'speaking');
      const ruled = !!last && this.levelOn() && last.kind !== 'question' && last.kind !== 'passage';
      say.innerHTML = live ? `${ruled ? '' : `<b>${last.kind === 'question' ? 'Tutor' : last.kind === 'passage' ? 'Your teacher' : esc(last.target)}</b> `}${esc(shown(last.text) || 'thinking…')}` : last?.status === 'error' ? `<span class="bad">${esc(last.error ?? 'The explanation failed.')}</span>` : '';
      say.scrollTop = say.scrollHeight;
      this.stage!.el.querySelectorAll<HTMLElement>('.sayrow .hand').forEach((b) => { b.hidden = !live || !this.ai(); });
    }
  }

  // ---- big subtitles over the video ----------------------------------------------------------------------------
  private bandVisible(): boolean {
    if (!this.band) return false;
    return this.band.host.style.display !== 'none';
  }
  private placeBand(): void {
    const player = document.querySelector<HTMLElement>('#movie_player');
    const want = !this.stageVisible() && (TOUCH ? extras.view === 'normal' && extras.band !== 'off' : extras.band === 'on' || (extras.band === 'auto' && (!!document.fullscreenElement || !!document.querySelector('ytd-watch-flexy[theater]') || !this.panel)));
    if (!player) return;
    let fresh = false;
    if (!this.band) {
      fresh = true;
      const { host, root } = makeHost('dr-band-host');
      const el = document.createElement('div');
      el.className = 'band-wrap';
      el.innerHTML = '<div class="band"><div class="say"></div><div class="line"></div></div><div class="cmd" hidden></div><div class="card" hidden></div><div class="toast" hidden></div>';
      root.appendChild(el);
      this.band = { host, root, el };
      el.style.cssText = 'position:absolute;inset:0;pointer-events:none';
      this.wireWords(el.querySelector<HTMLElement>('.line')!);
      this.applyLook();
    }
    if (this.band.host.parentElement !== player) player.appendChild(this.band.host);
    const shown = this.bandVisible();
    this.band.host.style.display = want ? '' : 'none';
    document.documentElement.classList.toggle('dr-band', want);
    // (a phone: subtitles off = off, YouTube's own captions stay hidden too, whatever the page shows)
    const ccOff = TOUCH && extras.band === 'off';
    document.documentElement.classList.toggle('dr-cc-off', ccOff);
    document.documentElement.classList.toggle('dr-hide-cc', ((want || this.stageVisible()) && extras.hideYtCaptions) || ccOff);
    // (also the very first time: the line being said is on the video at once, not only from the next sentence on)
    if (want !== shown || (fresh && want)) { this.renderBandLine(); this.showCommandWindow(this.cmdWin); }
  }
  private renderBandLine(): void {
    const line = this.band?.el.querySelector<HTMLElement>('.line');
    if (!line || !this.vb || !this.dict || !this.cur) return;
    const cur = getSentence(this.vb.book, this.cur);
    if (!cur) return;
    line.innerHTML = renderSentence(cur.para, cur.sentence, 0, this.renderOpts());
    if (this.curWord >= 0) line.querySelector(`.w[data-t="${this.curWord}"]`)?.classList.add('cur-w');
    this.bandPieces = null;
    if (TOUCH) this.cutBandLine(line);
  }
  /** a touch screen: which piece of the sentence each word of the subtitle line is in (null = the line is one piece) */
  private bandPieces: { of: Map<number, number>; shown: number } | null = null;
  /**
   * Film-like subtitles (a touch screen): a sentence too long for two lines is shown in pieces, the piece being said
   * now on the screen (subtitle-chunks.ts). Every bit of text of the line belongs to the piece of the word before it.
   */
  private cutBandLine(line: HTMLElement): void {
    const words = Array.from(line.querySelectorAll<HTMLElement>('.w[data-t]'));
    if (words.length < 2) return;
    const fontPx = parseFloat(getComputedStyle(line).fontSize) || bandPx();
    const width = (line.parentElement?.clientWidth || innerWidth) * 0.9 - 24;
    const budget = lettersPerLine(width, fontPx) * 2 - 4;
    // (the text between two words, a comma or a space, counts for the word before it)
    const tail = (w: HTMLElement): string => { let t = '', n: Node | null = w.nextSibling; while (n && n.nodeType === Node.TEXT_NODE) { t += n.textContent ?? ''; n = n.nextSibling; } return t; };
    const lengths = words.map((w) => (w.textContent ?? '').length + Math.max(1, tail(w).length));
    const pieces = chunkWords(lengths, budget, words.map((w) => /[,.;:!?\u2014]/.test(tail(w))));
    if (!pieces.some((p) => p > 0)) return;
    const of = new Map<number, number>();
    words.forEach((w, i) => { of.set(Number(w.dataset.t), pieces[i]); w.dataset.c = String(pieces[i]); });
    // every loose bit of text gets its own element, so it can be shown and hidden with its piece
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const loose: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!(n.parentElement?.closest('.w'))) loose.push(n as Text);
    let last = 0;
    const order = Array.from(line.querySelectorAll<HTMLElement>('.w[data-t]'));
    for (const t of loose) {
      const before = order.filter((w) => (w.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).pop();
      last = before ? Number(before.dataset.c) : 0;
      const span = document.createElement('span');
      span.className = 'gap';
      span.dataset.c = String(last);
      t.replaceWith(span);
      span.appendChild(t);
    }
    this.bandPieces = { of, shown: -1 };
    this.showBandPiece();
  }
  /** the piece with the word being said now is the one on the screen */
  private showBandPiece(): void {
    const bp = this.bandPieces;
    const line = this.band?.el.querySelector<HTMLElement>('.line');
    if (!bp || !line) return;
    const want = this.curWord >= 0 ? bp.of.get(this.curWord) ?? (bp.shown >= 0 ? bp.shown : 0) : 0;
    if (want === bp.shown) return;
    bp.shown = want;
    line.dataset.piece = String(want);
    line.querySelectorAll<HTMLElement>('[data-c]').forEach((e) => { e.hidden = Number(e.dataset.c) !== want; });
  }
  private renderBandSay(): void {
    const say = this.band?.el.querySelector<HTMLElement>('.say');
    if (!say) return;
    const last = this.transcript[this.transcript.length - 1];
    say.textContent = last && (last.status === 'thinking' || last.status === 'speaking') ? (last.text ? firstSentences(shown(last.text), 220) : 'Thinking…') : '';
  }

  toast(text: string, ms = 3500): void {
    const shown = this.visibleRoot();
    for (const r of [this.panel?.el, this.band?.el, this.stage?.el]) {
      const t = r?.querySelector<HTMLElement>('.toast');
      if (!t) continue;
      if (r !== shown && r !== this.panel?.el) continue;
      t.textContent = text;
      t.hidden = false;
      clearTimeout((t as unknown as { _tm?: ReturnType<typeof setTimeout> })._tm);
      (t as unknown as { _tm?: ReturnType<typeof setTimeout> })._tm = setTimeout(() => { t.hidden = true; }, ms);
    }
  }

  settingsChanged(prev: Settings): void {
    this.applyLook();
    // 20 / 30 / 40 / 60 changed while a part is on the page: the page shows the new part at once
    if (prev.listen.lastSecondsWindow !== settings.listen.lastSecondsWindow && this.partKeys && this.partEnd && this.vb && this.stageVisible()) {
      const t = this.vb.timingOf(this.partEnd);
      if (t) this.showStage(this.partAt(t.end - 0.01, settings.listen.lastSecondsWindow));
    }
    if (prev.learnerLevel !== settings.learnerLevel) { this.countKnown(); this.recomputeStops(); }
    // short / mid / long or another teacher: the explanations are written again that way
    if (prev.ai.explanationLength !== settings.ai.explanationLength || prev.ai.activeStyle !== settings.ai.activeStyle) { this.analysis?.dispose(); this.analysis = null; this.planAnalysis(); }
    if (prev.learnerLevel !== settings.learnerLevel || prev.appearance.showHints !== settings.appearance.showHints) {
      this.render();
      if (prev.learnerLevel !== settings.learnerLevel) void this.runHintsJob();
    }
    if (prev.voice.voiceId !== settings.voice.voiceId && settings.voice.voiceId) {
      this.macVoice = settings.voice.voiceId;
      // a new voice says a test sentence
      if (this.voiceKind === 'mac') { this.voiceId = this.macVoice; setTimeout(() => this.testVoiceIfFree(), 50); }
    }
    if (prev.voice.rate !== settings.voice.rate) (this.tts as { setRate?: (r: number) => void } | null)?.setRate?.(settings.voice.rate);
    this.renderHead();
    this.renderStageTop();
    this.renderQuickIfOpen();
  }

  extrasChanged(prev: store.YtExtras): void {
    this.applyLook();
    if (prev.teacherVolume !== extras.teacherVolume || prev.followVideoVolume !== extras.followVideoVolume) { const v = this.volumeOf('teacher'); this.talk?.live?.setVolume(v); this.pre?.setVolume(v); }
    const voiceChanged = prev.openaiVoice !== extras.openaiVoice || prev.elevenVoice !== extras.elevenVoice || prev.azureVoice !== extras.azureVoice || prev.azureRegion !== extras.azureRegion;
    if (prev.voice !== extras.voice || voiceChanged) {
      this.applyVoice();
      // the voice you hear changed: it says a test sentence (not when only the live call's voice changed)
      const k = this.voiceKind;
      if (k === 'openai' ? prev.openaiVoice !== extras.openaiVoice : k === 'elevenlabs' ? prev.elevenVoice !== extras.elevenVoice : k === 'azure' && (prev.azureVoice !== extras.azureVoice || prev.azureRegion !== extras.azureRegion)) this.testVoiceIfFree();
    }
    if (prev.view !== extras.view) this.applyView();
    if (prev.stopSentences !== extras.stopSentences) this.render();
    if (prev.zhLines !== extras.zhLines && extras.zhLines && this.stageVisible() && this.vb) {
      const ps = this.partKeys ? this.vb.order.filter((p) => this.partKeys!.has(sentenceKey(p))) : this.cur ? [this.cur] : [];
      this.ensureZh(ps);
      if (this.cur) this.setCurrent(this.cur);
    }
    if (prev.playLine !== extras.playLine) { this.padPage(); this.scrollToCur(true); }
    if (prev.myLevel !== extras.myLevel || prev.explainPct !== extras.explainPct || prev.pctWords !== extras.pctWords || prev.pctPhrases !== extras.pctPhrases || prev.pctSentences !== extras.pctSentences || prev.stopItemsOn !== extras.stopItemsOn || prev.stopPhrasesOn !== extras.stopPhrasesOn || prev.stopHardOn !== extras.stopHardOn) { this.recomputeStops(); this.planAnalysis(); }

    this.renderHead();
    this.renderStageTop();
    this.renderTalk();
    this.renderQuickIfOpen();
  }

  /** a key press: the learner's shortcuts (window answers only while a window or card is open) */
  keydown(e: KeyboardEvent): void {
    const t = (e.composedPath()[0] ?? e.target) as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const a = actionFor(e, extras.shortcuts);
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.code === 'Escape' && this.quickRoot) { swallow(); this.closeQuick(); return; }
    if (a?.id === 'goOn' && this.ai() && (this.controller?.busy || this.flow) && !this.cmdWin) { swallow(); this.byeBye(); return; }
    if (a && this.runAction(a)) swallow();
  }

  /** a shortcut's action (from a key or, on the iPhone, a button); true = it acted (the key is then swallowed) */
  private runAction(a: ShortcutAction): boolean {
    const windowOpen = !!this.cmdWin || !!this.card;
    const tutor = this.ai();
    if (a.when === 'window') {
      if (!windowOpen && !(tutor && this.talk)) return false;
      if (a.id === 'know') { if (this.card && !this.cmdWin && !this.talk) { this.controller?.markKnown(this.card.lemma); void this.changeStatus(this.card.lemma, 'known'); this.closeCard(); } else this.answerKnow(); }
      else if (a.id === 'dontKnow') this.answerDontKnow();
      else if (a.id === 'goOn') { if (this.cmdWin) this.answerGoOn(); else if (this.talk) this.byeBye(); else this.closeCard(); }
      return true;
    }
    if (a.when === 'explaining') {
      // Space pauses the teacher (only while it explains or talks in the call; otherwise YouTube's play / pause)
      if (tutor && this.talk?.chat?.busy) { this.talk.chat.interrupt(); return true; }
      if (!tutor || !this.controller?.busy) return false;
      this.interrupt();
      return true;
    }
    if (a.when === 'page') {
      if (!tutor || !(this.talk || this.flow || this.cmdWin || (this.stageVisible() && normalView()))) return false;
      if (this.talk || this.flow || this.cmdWin) this.goOn(); else this.hideStage();
      return true;
    }
    // the rest; in the website-call mode only the look changes (YouTube keeps ← and the others)
    // (free mode: play / stop too; the explanations and the call say how to have them)
    const lookOnly = ['listening', 'page', 'bigger', 'smaller', 'zh', 'band', 'stop'];
    if (!tutor && (a.id === 'explainSentence' || a.id === 'explainLast' || a.id === 'talk')) { this.freeNote(); return true; }
    if (!tutor && !lookOnly.includes(a.id)) return false;
    if (a.id === 'explainSentence') this.explainSentence();
    else if (a.id === 'explainLast') this.explainLast();
    else if (a.id === 'stop') this.stopOrPlay();
    else if (a.id === 'talk') void this.callTutor();
    else if (a.id === 'listening') void store.patchExtras({ view: extras.view === 'listening' ? 'normal' : 'listening' });
    else if (a.id === 'page') { if (this.stageVisible()) this.hideStage(); else this.showStage(this.partAt(video()?.currentTime ?? 0, settings.listen.lastSecondsWindow)); }
    else if (a.id === 'bigger' || a.id === 'smaller') this.resize(a.id === 'bigger' ? 1 : -1);
    else if (a.id === 'zh') void store.patchExtras({ zhLines: !extras.zhLines });
    // (a phone: the switch itself, not what is seen now; the band is hidden while the page is up at a stop)
    else if (a.id === 'band') { const on = TOUCH ? extras.band === 'off' : !this.bandVisible(); void store.patchExtras({ band: on ? 'on' : 'off' }); this.toast(on ? 'Subtitles on the video: on' : 'Subtitles on the video: off'); }
    else return false;
    return true;
  }

  /**
   * A button of the iPhone app's bar (there is no keyboard): the shortcut of the same name, or one of the panel's
   * buttons. False = nothing to do now (e.g. "I know" with no window open).
   */
  action(id: string): boolean {
    if (id === 'voiceMode') { this.toggleVoiceMode(); return true; }
    if (id === 'mode') { this.nextMode(); return true; }
    if (id === 'oneButton') {
      const on = !extras.oneButton;
      // (nothing else changes: the same mode, the same page, the same text size)
      void store.patchExtras({ oneButton: on });
      this.toast(on ? `One button mode: touch anywhere on the page or the video = explain the last ${settings.listen.lastSecondsWindow} s. Everything else stays as it is. “One button” again = off.` : 'One button mode off.', 6000);
      return true;
    }
    if (id === 'pageAuto') { this.togglePageAuto(); return true; }
    // (the app's reader or browser comes in front: the video and the tutor go quiet, with no "you paused" explanation)
    if (id === 'hush') { const v = video(); if (!this.playback) return false; if ((v && !v.paused) || this.controller?.busy || this.flow || this.talk || this.cmdWin) this.stopAll(); return true; }
    if (id === 'vocab') { void chrome.runtime.sendMessage({ type: 'dream-open', page: 'vocab' }); return true; }
    if (id === 'quick') {
      const el = this.stageVisible() ? this.stage?.el : this.panel?.el;
      if (!el) return false;
      this.toggleQuick(el);
      return true;
    }
    const a = SHORTCUTS.find((x) => x.id === id);
    return !!a && this.runAction(a);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gate?.close();
    this.gateHold?.();
    if (this.gateTimer) clearTimeout(this.gateTimer);
    this.analysis?.dispose();
    this.counterEl?.remove();
    this.bookReady(false);
    this.endFlow();
    this.closeTalk();
    if (this.followTimer) clearInterval(this.followTimer);
    this.offs.forEach((f) => f());
    this.pbOffs.forEach((f) => f());
    this.controller?.dispose();
    this.engine.target = null;
    this.playback?.stop();
    this.tts?.cancelAll();
    this.panel?.host.remove();
    this.band?.host.remove();
    this.stage?.host.remove();
    document.documentElement.classList.remove('dr-panel', 'dr-panel-under', 'dr-band', 'dr-hide-cc', 'dr-cc-off', 'dr-stage', 'dr-fullcard', 'dr-split-r', 'dr-split-b');
    applyPageLook(false);
  }

  diag(): Record<string, unknown> {
    return {
      mode: this.mode, sentences: this.vb?.order.length ?? 0, split: this.source, view: extras.view, voice: this.voiceKind, phone: TOUCH, device: DEVICE, lay: lay(), justTalk: !!extras.voiceMode, microphone: window.__ytcApi?.micBlocked?.() ? 'blocked' : this.wantsMic() ? `wanted (level ${extras.micLevel ?? 3})` : 'off now', micState: window.__ytcApi?.micState?.(), stops: `my level ${settings.learnerLevel} (${myLevel()}) · explain ${explainText()}`, wordsHeard: this.wordsHeard.total, voiceProblem: this.lastVoiceError, dictionary: this.dict ? `loaded (unpacked by ${gunzipVia || '?'})` : 'not loaded',
      talk: this.talk ? (this.talk.live ? `live ${this.talk.live.state}` : this.talk.error ? `no live: ${this.talk.error}` : 'speech recognition') : 'closed',
      state: this.playback?.state ?? null, hardSentences: this.hardSentences.length, hints: Object.keys(this.hints).length, status: this.statusText.slice(0, 160),
      ...(this.statusBad ? { problem: `My tutor: ${this.statusText}` } : {}),
    };
  }

  /** tests: is every word of the part inside the page (no scrolling), and does the card cover any of them? */
  private partLayout(): { fits: boolean; covered: number; words: number; fontPx: number } | null {
    const el = this.stage?.el, page = el?.querySelector<HTMLElement>('.page');
    if (!el || !page || !this.stageVisible() || el.dataset.view !== 'part') return null;
    const pr = page.getBoundingClientRect();
    const card = el.querySelector<HTMLElement>(':scope > .card');
    const cr = card && !card.hidden ? card.getBoundingClientRect() : null;
    const words = Array.from(page.querySelectorAll<HTMLElement>('.s.in-part .w'));
    let out = 0, covered = 0;
    for (const w of words) {
      const r = w.getBoundingClientRect();
      if (r.top < pr.top - 1 || r.bottom > pr.bottom + 1 || r.left < pr.left - 1 || r.right > pr.right + 1) out++;
      if (cr && r.right > cr.left && r.left < cr.right && r.bottom > cr.top && r.top < cr.bottom) covered++;
    }
    return { fits: out === 0 && page.scrollHeight <= page.clientHeight + 1, covered, words: words.length, fontPx: parseFloat(getComputedStyle(page).fontSize) };
  }

  /** diagnostics for the 🩺 check and the developer (no keys): the voices and the call */
  voiceState(): Record<string, unknown> {
    const mac = this.macRaw as unknown as { state?: () => unknown } | null;
    return { kind: this.voiceKind, voiceId: this.voiceId, mac: mac?.state?.() ?? null, teacherVol: this.volumeOf('teacher'), wordVol: this.volumeOf('word'), talk: this.talk ? { chat: this.talk.chat ? { thinking: this.talk.chat.thinking, speaking: this.talk.chat.speaking, busy: this.talk.chat.busy, error: this.talk.chat.lastError, events: this.talk.chat.events.slice(-25) } : null, live: this.talk.live?.state ?? null, call: !!this.talk.call } : null, mic: this.wantsMic(), trail: this.trailLog.slice(-25), split: splitReport.slice(-30) };
  }

  debug() {
    const stage = this.stage?.el;
    return {
      layout: this.partLayout(),
      mode: this.mode, sentences: this.vb?.order.length ?? 0, state: this.playback?.state ?? null, cur: this.cur, window: this.cmdWin, card: this.card,
      transcript: this.transcript.map((e) => ({ kind: e.kind, target: e.target, status: e.status, text: e.text.slice(0, 80) })),
      spoken: (this.macRaw as unknown as { spoken?: { text: string }[] })?.spoken?.map((s) => s.text) ?? null,
      spokenVol: (this.macRaw as unknown as { spoken?: { text: string; volume?: number }[] })?.spoken?.slice(-60).map((s) => [s.text.slice(0, 60), s.volume ?? null]) ?? null,
      callOpen: this.callOpen(),
      volume: { teacher: this.volumeOf('teacher'), word: this.volumeOf('word') },
      cloud: cloudSpoken.slice(-30), voiceClips: { ...voiceStats },
      hints: Object.keys(this.hints).length, phrases: Object.keys(this.phrases).length, hardSentences: this.hardSentences.map((m) => m.text),
      split: this.source, voice: this.voiceKind, view: extras.view,
      stage: stage ? { page: this.readPage + 1, pages: this.readPages, shown: this.stageVisible(), view: stage.dataset.view, part: this.partKeys ? this.partKeys.size : 0, visibleLines: Array.from(stage.querySelectorAll<HTMLElement>('.s')).filter((s) => s.offsetParent !== null).length, zhLines: stage.querySelectorAll('.zh-line').length, size: getComputedStyle(this.stage!.host).getPropertyValue('--stage-size').trim() } : null,
      phone: TOUCH, device: DEVICE, lay: lay(), sleep: sleepMinutes(), asleep,
      level: { mine: myLevel(), cefr: settings.learnerLevel, pct: explainPcts(), why: Object.fromEntries([...this.stopped].map((k) => [k, (this.scores.get(k)?.items ?? []).join('+') + (this.scores.get(k)?.hard ? ' (hard sentence)' : '')])), byKind: { ...this.stopsBy }, caps: this.caps(), stops: this.autoStops, heard: this.heardKeys.size, chosen: this.stopSet.size, total: this.vb?.order.length ?? 0, rejected: this.ruleRejects + (this.analysis?.rejected ?? 0), gate: !!this.gate?.open, held: !!this.gateHold, aiCalls: this.analysis?.calls ?? 0, saved: this.analysis?.count ?? 0, stoppedAt: this.vb ? this.vb.order.filter((p) => this.stopped.has(sentenceKey(p))).map((p) => getSentence(this.vb!.book, p)?.text ?? '') : [] },
      talk: this.talk ? { live: this.talk.live ? this.talk.live.state : null, chat: this.talk.chat ? (this.talk.chat.thinking ? 'thinking' : this.talk.chat.speaking ? 'speaking' : 'listening') : null, log: this.talk.log.map((l) => `${l.who}: ${l.text}`), error: this.talk.error ?? null, events: this.talk.chat?.events.slice(-30) ?? null } : null,
      trail: this.trailLog.slice(-25),
      flow: this.flow ? this.flow.kind : null, quiet: this.quietUntil ? sentenceKey(this.quietUntil) : null,
    };
  }
}

function normalView(): boolean { return !bookView(); }

/**
 * A command at the end of what was heard: the whole of it, else its last three, two or one words (the microphone
 * also hears the tutor's own word just before the answer: "ubiquitous ubiquitous I know").
 */
function commandIn(text: string): ReturnType<typeof detectCommand> {
  const whole = detectCommand(text);
  const isCmd = (i: string) => i === 'know' || i === 'dont_know' || i === 'bye';
  if (isCmd(whole.intent)) return whole;
  const w = text.trim().split(/\s+/);
  for (const n of [3, 2, 1]) {
    if (w.length <= n) continue;
    const d = detectCommand(w.slice(-n).join(' '));
    // (one word alone at the end only counts as "bye"; "what", "again", "next" are too easily part of something else)
    if (n === 1 ? d.intent === 'bye' && saysBye(w[w.length - 1].toLowerCase()) : d.intent === 'know' || d.intent === 'dont_know' || (d.intent === 'bye' && saysBye(w.slice(-n).join(' ').toLowerCase()))) return d;
  }
  return whole;
}

/** "bye bye", or "bye" (also heard as "by", "buy", "goodbye", "ok bye") said alone: the tutor goes */
/** the finder's voice note is listening (the tutor's microphone waits) */
let finderMic = false;
/** "Find me a video" (the Find button, on any YouTube page): talk or type what you want to learn; videos at your level */
function openVideoFinder(): boolean {
  const api = window.__ytcApi;
  if (!api?.searchVideos || !api.cuesFor) return false;
  const W = window as unknown as { SpeechRecognition?: new () => never; webkitSpeechRecognition?: new () => never };
  // (a video plays meanwhile: it stops, so the voice note is heard)
  const v = video();
  if (v && !v.paused) { session?.stopOrPlay(); }
  openFinder({
    complete: (p) => complete(p),
    search: (q) => api.searchVideos!(q),
    cuesFor: (id) => api.cuesFor!(id),
    buildSentences: (cues) => api.buildSentences(cues),
    getDictionary,
    getZipf,
    // (the tutor off or no key: no AI at all, the first 10 in YouTube's order)
    aiOn: async () => { if (!extras.tutorOn) return false; const k = await store.getKeys().catch(() => ({} as store.Keys)); return !!(k.anthropic || k.openai); },
    myLevel: () => learnerLevelOf(extras, settings.learnerLevel),
    textSize: () => (TOUCH ? clamp(extras.phoneSizePx || 21, 14, 30) : 16),
    currentId: () => (location.pathname === '/watch' ? api.videoId() : null),
    speech: () => (W.SpeechRecognition ?? W.webkitSpeechRecognition ?? null) as never,
    cache: { get: (id) => store.getVideoLevel<FinderLevel>(id), set: (id, lv) => store.setVideoLevel(id, lv) },
    micBusy: (on) => { finderMic = on; },
    onClose: () => { finderMic = false; },
  });
  return true;
}

/** "know" / "no" / "now" said alone (one to three times), "I know", "yes I know" (not "I don't know", "no idea") */
function saysKnow(lower: string): boolean {
  const w = lower.replace(/[^a-z' ]/g, ' ').trim().split(/\s+/).filter((x) => x && !/^(ok|okay|oh|um|uh|yes|yeah|ya|well)$/.test(x));
  const k = (x: string) => /^(know|no|now|knew)$/.test(x);
  return w.length >= 1 && w.length <= 3 && (w.every(k) || (w[0] === 'i' && w.length >= 2 && w.slice(1).every(k)));
}

/** the tutor's volume steps of the quick control (the slider's %; about 4 dB apart, the lowest clearly quieter) */
const VOLUME_STEPS = [20, 32, 40, 50, 63, 79, 100];
/** one step quieter (-1) or louder (+1) from any slider value */
function stepVolume(now: number, dir: 1 | -1): number {
  if (dir > 0) return VOLUME_STEPS.find((s) => s > now + 0.5) ?? 100;
  return [...VOLUME_STEPS].reverse().find((s) => s < now - 0.5) ?? VOLUME_STEPS[0];
}
/** a video's analysis made for this school level also serves the learner's level now (the same or a higher one) */
const analysisCovers = (cachedLevel: string | undefined): boolean => {
  const a = CEFR_ORDER.indexOf(cachedLevel ?? ''), b = CEFR_ORDER.indexOf(settings.learnerLevel);
  return a >= 0 && b >= 0 && a <= b;
};
const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
/** MY LEVEL, 0 (easiest) … 100 (hardest): the slider's number (before it was ever moved: the old A1–C2 level as a number) */
const myLevel = (): number => myLevelOf(extras, settings.learnerLevel);
/** how much of what is at my level or above is explained by itself, % */
/** a phone or iPad shows the big card (the whole screen) unless Settings says Small */
const cardBig = (): boolean => extras.cardSize !== 'small';
const explainPcts = (): StopCaps => {
  const all = clampPct(extras.explainPct ?? DEFAULT_EXPLAIN_PCT);
  return { word: clampPct(extras.pctWords ?? all), phrase: clampPct(extras.pctPhrases ?? all), sentence: clampPct(extras.pctSentences ?? all) };
};
/** "words 100% · phrases 50% · sentences off" (a kind switched off, or at 0 %, is off) */
const explainText = (): string => {
  const p = explainPcts();
  const one = (name: string, on: boolean | undefined, n: number) => `${name} ${on === false || n <= 0 ? 'off' : `${n}%`}`;
  return `${one('words', extras.stopItemsOn, p.word)} · ${one('phrases', extras.stopPhrasesOn, p.phrase)} · ${one('sentences', extras.stopHardOn, p.sentence)}`;
};
/** "hi bro" (also heard as "hey bro", "high bro", "hi bruh") = the voice call */
const HI_BRO = /\b(hi|hey|high)\s*(bro|bruh|brah|bra)\b/i;
const VOICE_HELP = 'Voice on: “hello” = explain the last part · “hi bro” = call the tutor · “I know” · “stop” · “play” · “bye” = the tutor goes, the video plays.';
function saysBye(lower: string): boolean {
  if (/\b(bye|buy|by)[\s-]*(bye|buy|by)\b/.test(lower)) return true;
  const words = lower.replace(/[^a-z' ]/g, ' ').trim().split(/\s+/).filter((w) => w && !/^(ok|okay|oh|um|uh|well|so|and)$/.test(w));
  return words.length === 1 && /^(bye|by|buy|goodbye|bai)$/.test(words[0]) || (words.length === 2 && words[0] === 'good' && /^(bye|by|buy)$/.test(words[1]));
}

/** how long a stop waits for its explanation from the one analysis before it asks for this one alone */
const ANALYSIS_WAIT_MS = 6000;
/** a stop with no voice and no window for this long plays on by itself */
const SILENT_STOP_MS = 30_000;

// ---- the sleep timer: after 30 or 60 minutes everything stops (the video, the tutor, the microphone) ----
let asleep = false;
let sleepUntil = 0;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
/** the minutes left on the sleep timer (0 = off) */
function sleepMinutes(): number { return sleepUntil ? Math.max(1, Math.ceil((sleepUntil - Date.now()) / 60_000)) : 0; }
function setSleep(minutes: number): void {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null; sleepUntil = 0; asleep = false;
  if (minutes > 0) {
    sleepUntil = Date.now() + minutes * 60_000;
    sleepTimer = setTimeout(() => { sleepTimer = null; sleepUntil = 0; asleep = true; if (session) session.sleepNow(); else { const v = video(); if (v && !v.paused) v.pause(); } }, minutes * 60_000);
  }
  session?.toast(minutes > 0 ? `Sleep timer: everything stops in ${minutes} minutes.` : 'Sleep timer off.', 5000);
  session?.renderQuickIfOpen();
}

/** after an explanation a moment to talk: your setting, or always in voice mode */
/** a talk opens after an explanation only when the learner asked for it (Settings); "just talk" only listens */
function talkAfter(): boolean { return !!extras.talkAfterExplain; }
/** short / mid / long */
function teachLength(): TeachLength { const l = settings.ai.explanationLength as string; return l === 'short' || l === 'long' ? l : 'normal'; }

/** page-wide choices while the tutor is on: YouTube's own captions always hidden, your video size */
function applyPageLook(on = !!session): void {
  const html = document.documentElement;
  // (the device and the layout, for the page CSS: data-ytc-phone / data-ytc-dev / data-ytc-lay)
  if (on) { html.dataset.ytcPhone = TOUCH ? '1' : '0'; html.dataset.ytcDev = DEVICE; html.dataset.ytcLay = lay(); }
  else { delete html.dataset.ytcPhone; delete html.dataset.ytcDev; delete html.dataset.ytcLay; }
  html.classList.toggle('dr-hide-cc-always', on && extras.hideYtAlways);
  const size = on ? clamp(extras.videoSize || 0, 0, 90) : 0;
  if (size === appliedVideoSize) return;
  appliedVideoSize = size;
  html.classList.toggle('dr-vsize', size > 0);
  if (size > 0) html.style.setProperty('--dr-vsize', `${Math.max(35, size)}%`); else html.style.removeProperty('--dr-vsize');
  // the player measures its box again (it listens to the window size)
  window.dispatchEvent(new Event('resize'));
}
let appliedVideoSize = 0;

function keyToPos(key: string): Position | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(key);
  return m ? { chapter: +m[1], paragraph: +m[2], sentence: +m[3] } : null;
}

function firstSentences(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > 40 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

function video(): HTMLVideoElement | null {
  return window.__ytcApi?.video() ?? document.querySelector<HTMLVideoElement>('video.html5-main-video') ?? document.querySelector('video');
}

// ---------------------------------------------------------------------------------------------------------------
// which mode, which video
// ---------------------------------------------------------------------------------------------------------------
/** My tutor on: the tutor; off in the iPhone / iPad app: free mode (no AI); off in Chrome / Safari: nothing (as before) */
/** the tutor off = a normal YouTube page, nothing of the tutor (the learner's rule of 13 Nov); free mode (the app only:
 *  the book of subtitles and the dictionary card, no AI) only when Settings asks for it */
function wantedMode(): Mode | null { return extras.tutorOn ? 'tutor' : (window as unknown as { __ytcShimYT?: unknown }).__ytcShimYT && extras.offMode === 'free' ? 'free' : null; }

// ---------------------------------------------------------------------------------------------------------------
// full screen both ways (the app): the video over the whole window (class dr-full). The phone turned on its side =
// full screen by itself (an iPad: only with its switch, landscape is its normal way); YouTube's own full-screen
// button and the app's "Full screen" button switch it by hand, which holds until the device is turned again.
// ---------------------------------------------------------------------------------------------------------------
let fullManual: boolean | null = null;
let fullWasLand: boolean | null = null;
/** when a full-screen button was pressed (the phone may turn right after it: that turn must not undo the press) */
let fullToggledAt = 0;
const wantFull = (): boolean => TOUCH && location.pathname === '/watch' && !!wantedMode() && (fullManual ?? (innerWidth > innerHeight && (extras.fullOnTurn ?? !IPAD)));
function postLayout(): void {
  try {
    const h = (window as unknown as { webkit?: { messageHandlers?: { ytc?: { postMessage(o: unknown): unknown } } } }).webkit?.messageHandlers?.ytc;
    void Promise.resolve(h?.postMessage({ kind: 'layout', full: document.documentElement.classList.contains('dr-full'), lay: lay() })).catch(() => undefined);
  } catch { /* not the app */ }
}
function applyFull(): void {
  if (!TOUCH) return;
  const land = innerWidth > innerHeight;
  // (the device was turned: the choice by hand is over, the turn decides again)
  if (fullWasLand !== null && fullWasLand !== land && Date.now() - fullToggledAt > 1500) fullManual = null;
  fullWasLand = land;
  if (location.pathname !== '/watch') fullManual = null;
  const on = wantFull();
  const root = document.documentElement;
  if (root.classList.contains('dr-full') === on) return;
  root.classList.toggle('dr-full', on);
  postLayout();
  window.dispatchEvent(new Event('resize'));
}
/** the "Full screen" button, YouTube's full-screen button: the other way round */
function toggleFull(): boolean {
  if (!TOUCH || location.pathname !== '/watch') return false;
  fullManual = !wantFull();
  fullToggledAt = Date.now();
  applyFull();
  return true;
}
function wireFull(): void {
  if (!TOUCH) return;
  window.addEventListener('resize', () => applyFull());
  setInterval(applyFull, 700);
  // YouTube's own full-screen button: our full screen instead (its own would open Apple's player, without the tutor)
  const onTap = (ev: Event) => {
    if (location.pathname !== '/watch') return;
    const FS = '.ytp-fullscreen-button, .fullscreen-icon, .ytmFullscreenButtonHost, button[aria-label*="ull screen" i], button[aria-label*="ullscreen" i]';
    let hit = ev.composedPath().some((n) => n instanceof Element && n.matches(FS));
    if (!hit) {
      // (the tutor's subtitle line can lie over that corner of the video: a touch ON the button's place is the
      // button's, whatever is drawn over it)
      const t = (ev as TouchEvent).changedTouches?.[0];
      const x = t ? t.clientX : (ev as MouseEvent).clientX, y = t ? t.clientY : (ev as MouseEvent).clientY;
      if (typeof x === 'number' && typeof y === 'number' && (x || y)) {
        hit = Array.from(document.querySelectorAll<HTMLElement>(FS)).some((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden' && x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4;
        });
      }
    }
    if (!hit) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    // (a finger: iOS makes no click after a touchend that was stopped, so the touch itself switches; a click that
    // still follows it within a moment is the same press)
    if (ev.type === 'click' && Date.now() - fullTouchAt < 700) return;
    if (ev.type === 'touchend') fullTouchAt = Date.now();
    toggleFull();
  };
  let fullTouchAt = 0;
  for (const type of ['click', 'touchend'] as const) window.addEventListener(type, onTap, true);
  // (a new page: the app is told at once whether the video is full screen, so its bar is never left hidden)
  applyFull();
  postLayout();
  // (the page's own script asked for Apple's player: page-hooks.js stopped it and tells us)
  document.addEventListener('ytc-fs-request', () => { if (!document.documentElement.classList.contains('dr-full')) { fullManual = true; applyFull(); } });
  document.documentElement.dataset.ytcTutor = '1';
  // (the last guard: Apple's player opened anyway: out of it, into ours)
  document.addEventListener('webkitbeginfullscreen', (ev) => {
    const v = ev.target as (HTMLVideoElement & { webkitExitFullscreen?: () => void }) | null;
    try { v?.webkitExitFullscreen?.(); } catch { /* it stays */ }
    fullManual = true; applyFull();
  }, true);
}

function refresh(): void {
  const api = window.__ytcApi;
  if (!api) return;
  const id = location.pathname === '/watch' ? api.videoId() : null;
  const mode = wantedMode();
  // (no tutor on this page: YouTube's own full screen is YouTube's again, see page-hooks.js)
  document.documentElement.dataset.ytcTutor = id && mode ? '1' : '0';
  // (the tutor turned off while the video was over the whole window: the page is YouTube's own again)
  if (!(id && mode)) { fullManual = null; applyFull(); }
  if (!id || !mode) { session?.dispose(); session = null; paintTutorButton(); return; }
  // (another video, or the tutor turned on / off: a new session in the other mode)
  if (session && (session.videoId !== id || session.mode !== mode)) { session.dispose(); session = null; }
  if (!session) { session = new Session(id, mode); window.__drDebug = () => session?.debug(); void session.start(); }
  paintTutorButton();
}

function paintTutorButton(): void {
  if (!tutorBtn) return;
  const on = extras.tutorOn;
  tutorBtn.style.background = on ? GREEN : RED;
  tutorBtn.textContent = on ? 'My tutor ● on' : 'My tutor ○ off';
  tutorBtn.title = on ? 'Dream Tutor is on: the video stops at hard words, phrases and sentences and your AI explains them (your API key). Click to turn off.' : 'Turn on the Dream Tutor: stops at what is hard for you, explanations with your own API key (ChatGPT / Claude turn off).';
}

async function setTutor(on: boolean): Promise<void> {
  await store.patchExtras({ tutorOn: on });
  extras.tutorOn = on;
  refresh();
}

/**
 * A copy of your settings and My Vocabulary (never the API keys) in this browser's storage for youtube.com: it outlives
 * the extension, so after the extension is removed and loaded again, everything comes back by itself.
 */
const BACKUP_KEY = 'dreamTutorBackup.v1';
const BACKUP_PARTS = [store.STORAGE_KEYS.settings, store.STORAGE_KEYS.extras, store.STORAGE_KEYS.vocab, store.STORAGE_KEYS.entries];
async function restoreIfFresh(): Promise<boolean> {
  try {
    const now = await chrome.storage.local.get(BACKUP_PARTS);
    if (Object.keys(now).length) return false; // not a fresh install
    const raw = localStorage.getItem(BACKUP_KEY);
    if (!raw) return false;
    const b = JSON.parse(raw) as Record<string, unknown>;
    const put: Record<string, unknown> = {};
    for (const k of BACKUP_PARTS) if (b[k]) put[k] = b[k];
    if (!Object.keys(put).length) return false;
    await chrome.storage.local.set(put);
    return true;
  } catch { return false; }
}
let backupTimer: ReturnType<typeof setTimeout> | null = null;
function backupSoon(): void {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    void chrome.storage.local.get(BACKUP_PARTS).then((o) => {
      const save = (data: Record<string, unknown>) => localStorage.setItem(BACKUP_KEY, JSON.stringify({ at: new Date().toISOString(), ...data }));
      try { save(o); } catch {
        // too big for the page's storage: keep the words, drop the long explanations
        try {
          const entries = (o[store.STORAGE_KEYS.entries] ?? {}) as Record<string, Record<string, unknown>>;
          const slim = Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, { ...e, explanation: String(e.explanation ?? '').slice(0, 300) }]));
          save({ ...o, [store.STORAGE_KEYS.entries]: slim });
        } catch { /* no room at all */ }
      }
    }).catch(() => undefined);
  }, 4000);
}

/** (unpacked) a newer build is in the extension's folder: it reloads itself and then this page */
function devCheck(): void {
  try {
    void chrome.runtime.sendMessage({ type: 'dream-dev-check', build: typeof __DREAM_BUILD__ === 'string' ? __DREAM_BUILD__ : '' })
      // the extension reloads itself now: this page then loads the new tutor
      .then((r: { reloading?: boolean } | undefined) => { if (r?.reloading) setTimeout(() => location.reload(), 1500); })
      .catch(() => undefined);
  } catch { /* the extension was reloaded */ }
}

/** this page's tutor lost its extension (reloaded, updated or removed) */
function extensionGone(): boolean {
  try { return !chrome.runtime?.id || !chrome.runtime.getManifest(); } catch { return true; }
}

async function boot(): Promise<void> {
  devCheck();
  const restored = await restoreIfFresh();
  [settings, extras, vocab, levelMeta] = await Promise.all([store.getSettings(), store.getExtras(), store.getVocab(), store.getLevel()]);
  const raw = await store.getRawExtras();
  const mig = store.migrateExtras({ ...raw } as store.YtExtras);
  if (mig) extras = await store.patchExtras(mig);
  // (once: "Explain N s" is 10, 20 or 30 seconds now, 20 the usual one)
  if (mig && (raw.migrated ?? 0) < 3 && settings.listen.lastSecondsWindow !== 10 && settings.listen.lastSecondsWindow !== 20) settings = await store.patchSettings({ listen: { ...settings.listen, lastSecondsWindow: 20 } });
  if (TOUCH) {
    const first = store.phoneDefaults(extras);
    if (first) {
      extras = await store.patchExtras(first);
    }
  }
  // 3.8, once: ONE level 0-100 (the old A1–C2 level as a number, B2 = 56) with the three switches (no shares any more);
  // on a phone or iPad the big page is off in Video mode until its switch turns it on (the learner's wish of 7 Nov)
  if ((raw.migrated ?? 0) < 4) {
    const p: Partial<store.YtExtras> = {};
    if (typeof raw.myLevel !== 'number') p.myLevel = myLevelOf(null, settings.learnerLevel);
    if (TOUCH && raw.migrated !== undefined) p.stageOn = false;
    if (Object.keys(p).length) extras = await store.patchExtras(p);
  }
  // 3.9, once: the level is a school level again (A1 … C2): the old slider's number becomes the start of its level
  if ((raw.migrated ?? 0) < 5 && typeof extras.myLevel === 'number') {
    const snapped = cefrToLevel(levelToCefr(extras.myLevel));
    if (snapped !== extras.myLevel) extras = await store.patchExtras({ myLevel: snapped });
  }
  if (TOUCH && raw.migrated === undefined && raw.stageOn === undefined) extras = await store.patchExtras({ stageOn: false });
  // (the school level the prompts use always follows the slider)
  if (typeof extras.myLevel === 'number' && levelToCefr(extras.myLevel) !== settings.learnerLevel) settings = await store.patchSettings({ learnerLevel: levelToCefr(extras.myLevel) as Settings['learnerLevel'] });
  window.__ytcDream = {
    owns: () => !!session && session.owns(),
    // (the finder's voice note has the microphone: the tutor lets it go meanwhile)
    wantsMic: () => !finderMic && !finderIsOpen() && !!session && session.wantsMic(),
    micLevel: () => extras.micLevel ?? 3,
    headsetMic: () => !!extras.headsetMic,
    callOpen: () => !!session && session.callOpen(),
    heard: (text, final, key) => (session ? session.heard(text, final, key) : false),
    decorateBar: (bar) => {
      if (bar.querySelector('#yt2c-b-tutor')) return;
      const b = document.createElement('button');
      b.id = 'yt2c-b-tutor';
      b.style.cssText = 'border:0;border-radius:14px;padding:6px 12px;font:inherit;cursor:pointer;color:#fff;background:' + RED;
      b.onclick = () => void setTutor(!extras.tutorOn);
      bar.insertBefore(b, bar.firstChild);
      tutorBtn = b;
      paintTutorButton();
    },
    diag: () => (session ? session.diag() : { mode: 'off', on: extras.tutorOn }),
    reload: () => { session?.dispose(); session = null; refresh(); },
    action: (id) => {
      if (id === 'tutor') { if (location.pathname !== '/watch') return false; void setTutor(!extras.tutorOn); return true; }
      if (id === 'check') { window.__ytcApi?.showReport?.(); return !!window.__ytcApi?.showReport; }
      if (id === 'find') return openVideoFinder();
      if (id === 'full') return toggleFull();
      // the tutor quieter / louder, one step (the app's quick control): it counts at once, also during an explanation or a call
      if (id === 'quieter' || id === 'louder') {
        const now = extras.teacherVolume ?? 60;
        const next = stepVolume(now, id === 'louder' ? 1 : -1);
        extras = { ...extras, teacherVolume: next, wordVolume: next };
        void store.patchExtras({ teacherVolume: next, wordVolume: next });
        session?.volumeStepped(next);
        return true;
      }
      // (the playlist of "Find a video": the next / the video before, in the order the list shows)
      if (id === 'findNext') return finderNext();
      if (id === 'findPrev') return finderPrev();
      if (id === 'oneButton' && !session) { void store.patchExtras({ oneButton: false }); return true; }
      if (id === 'sleep') { if (!session) return false; const m = sleepMinutes() > 30 ? 0 : sleepMinutes() > 0 ? 60 : 30; setSleep(m); return true; }
      // (the tutor off: "Play / stop" is the page's own video, as on a normal YouTube page)
      if (id === 'stop' && !session) { const v = video(); if (!v) return false; if (v.paused) void v.play().catch(() => undefined); else v.pause(); return true; }
      return session ? session.action(id) : false;
    },
  };
  // "Find a video" is a playlist: when a video of the list ends, the next one opens by itself (finder-list.ts)
  installFinderPlaylist({
    currentId: () => (location.pathname === '/watch' ? window.__ytcApi?.videoId() ?? null : null),
    isAd: () => !!window.__ytcApi?.isAd(),
    myLevel: () => learnerLevelOf(extras, settings.learnerLevel),
    open: (id) => { location.assign(`/watch?v=${encodeURIComponent(id)}`); },
    busy: () => !!session && session.diag().state === 'explaining',
  });
  const bar = document.getElementById('yt2c-bar');
  if (bar) window.__ytcDream.decorateBar(bar);
  try { window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => session?.lookChanged()); } catch { /* an old browser: the look follows at the next page */ }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (BACKUP_PARTS.some((k) => ch[k])) backupSoon();
    if (ch[store.STORAGE_KEYS.settings]) { const prev = settings; settings = store.mergeSettings(ch[store.STORAGE_KEYS.settings].newValue); session?.settingsChanged(prev); }
    if (ch[store.STORAGE_KEYS.extras]) {
      const prev = extras; extras = { ...store.DEFAULT_EXTRAS, ...ch[store.STORAGE_KEYS.extras].newValue };
      // (into or out of lyrics mode: another book, the page is made again)
      if ((prev.view === 'lyrics') !== (extras.view === 'lyrics') && session) { session.dispose(); session = null; }
      session?.extrasChanged(prev); refresh();
    }
    if (ch[store.STORAGE_KEYS.vocab]) { vocab = { words: { ...(ch[store.STORAGE_KEYS.vocab].newValue?.words ?? {}) }, marked: {} }; session?.countKnown(); }
    if (ch[store.STORAGE_KEYS.keys]) session?.keysChanged({ ...(ch[store.STORAGE_KEYS.keys].newValue ?? {}) });
    // (another device's "words heard" came in with the online copy)
    if (ch[store.HEARD_KEY]?.newValue) session?.heardCameIn(ch[store.HEARD_KEY].newValue);
    if (ch[store.LEVEL_KEY]) { levelMeta = { ...EMPTY_META, ...(ch[store.LEVEL_KEY].newValue as Partial<LevelMeta> | undefined) }; session?.levelChanged(); }
    if (ch.drAzureVoices) void session?.loadAzureAvail().then(() => session?.renderQuickIfOpen());
  });
  // capture on window: before YouTube's own keys (← would jump back 5 s)
  window.addEventListener('keydown', (e) => {
    const t = (e.composedPath()[0] ?? e.target) as HTMLElement | null;
    if (!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) {
      const a = actionFor(e, extras.shortcuts);
      if (a?.id === 'tutor' && location.pathname === '/watch') { e.preventDefault(); e.stopImmediatePropagation(); void setTutor(!extras.tutorOn); return; }
    }
    session?.keydown(e);
  }, true);
  // the extension was reloaded, updated or removed: this page's tutor can do nothing any more, so it takes itself off the
  // page (no dark reading page, no empty panel, YouTube's own look back); a reload of the page brings the new one
  const alive = setInterval(() => {
    if (!extensionGone()) return;
    clearInterval(alive);
    try { session?.dispose(); } catch { /* already half gone */ }
    session = null;
    try { speechSynthesis.cancel(); } catch { /* no speech */ }
    for (const id of ['dr-panel-host', 'dr-band-host', 'dr-stage-host', 'dr-page-style', 'yt2c-overlay', 'yt2c-bar', 'dr-level-host', 'dr-stop-counter']) document.getElementById(id)?.remove();
    document.documentElement.classList.remove('dr-panel', 'dr-band', 'dr-hide-cc', 'dr-cc-off', 'dr-stage', 'dr-hide-cc-always', 'dr-vsize', 'dr-fullcard');
    document.documentElement.style.removeProperty('--dr-vsize');
    window.dispatchEvent(new Event('resize'));
    // a note: reloading the page brings the new tutor
    const note = document.createElement('div');
    note.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:2147483000;background:#1f2328;color:#fff;border:1px solid #d9a441;border-radius:12px;padding:10px 16px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);cursor:pointer';
    note.textContent = 'My tutor was updated. Click here (or press ⌘R) to reload this page.';
    note.onclick = () => location.reload();
    document.body.appendChild(note);
  }, 2000);
  // diagnostics on request from the page (developer tools): the voice and call state, nothing private
  window.addEventListener('message', (e) => {
    if (e.source !== window || (e.data as { type?: string } | null)?.type !== 'dr-debug-request') return;
    window.postMessage({ type: 'dr-debug', build: typeof __DREAM_BUILD__ === 'string' ? __DREAM_BUILD__ : '', voice: session?.voiceState() ?? null }, '*');
  });
  // YouTube is a single-page app: a new video = a new session
  document.addEventListener('yt-navigate-finish', () => { setTimeout(refresh, 300); devCheck(); });
  wireFull();
  setInterval(() => { const id = location.pathname === '/watch' ? window.__ytcApi?.videoId() : null; if ((session?.videoId ?? null) !== (id && wantedMode() ? id : null)) refresh(); }, 1500);
  refresh();
  backupSoon();
  if (restored) setTimeout(() => session?.toast('Your settings and My Vocabulary are back (from the backup). Add your API keys again: ⚙ → API keys.', 12000), 3000);
}

(function wait(tries = 0) {
  if (window.__ytcApi) { void boot(); return; }
  if (tries < 100) setTimeout(() => wait(tries + 1), 100);
})();

/** the vocabulary key of a whole sentence (its words, lower case) */
function sentenceLemma(text: string): string { return `sentence: ${norm(text).replace(/[^\p{L}\p{N}' ]/gu, '').slice(0, 120)}`; }
