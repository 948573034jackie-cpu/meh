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
import { getSentence, nextPosition, prevPosition, comparePositions, contextAround } from '@core/nav';
import { StreamSentenceSplitter } from '@core/listen/sentences';
import { cleanSpokenProse } from '@core/ai/prompts';
import { detectNames } from '@core/dict/names';
import { parseGloss, looksLikeFreeCombination } from '@core/dict/dictionary';
import { detectCommand } from '@core/voice/commands';
import { collectHardWords, batchHardWords, buildHintsPrompt, parseHints, chunkChapter, phraseQuota, buildPhrasesPrompt, parsePhrases, validatePhrases, mapPhraseHits, chapterText, type HintMap } from '@core/ai/hints';
import { renderChapter, renderSentence, restyleLemma } from '../vendor/renderer/render';
import { hintText } from '../vendor/renderer/hints';
import { buildVideoBook, type VideoBook, type TimedSentence } from './video-book';
import { VideoEngine } from './video-engine';
import { explain as aiExplain, complete, completeStream, getDictionary, getDictData } from './ai-client';
import * as store from './store';
import { clock, computeProgress, estimateKnown, suggestLevel, levelNote } from './vocab';
import { cloudEngine, resolveVoice, azureZhVoice, isMultilingual, QuotesFromVideo, VoiceWithBackup, SentenceFromVideo, WithVolume, sliderGain, LIVE_VOICES, cloudSpoken } from './voice';
import { LiveCall, liveInstructions } from './live';
import { ChatCall } from './chat-call';
import { splitWithAi, flatten, regroup, SPLIT_VERSION, splitReport } from './sentences-ai';
import { buildLinesPrompt, parseLines, buildWordPrompt, parseWordMeanings } from './zh';
import { buildHardSentencesPrompt, parseHardSentences, HARD_PER_SECONDS } from './hard-sentences';
import { actionFor, comboLabel, shortcutMap, SHORTCUTS, type ShortcutAction } from './shortcuts';
import { renderQuick } from './quick';

interface YtcInfo { title: string; channel?: string; url: string; cues: unknown[]; errors: string[]; source: string | null }
interface YtcApi {
  loadTranscript(): Promise<YtcInfo>;
  video(): HTMLVideoElement | null;
  videoId(): string | null;
  isAd(): boolean;
  settings(): { sendOn: boolean; target: string; voiceOn: boolean };
  buildSentences(cues: unknown[]): TimedSentence[];
  setBarStatus(text: string, bad?: boolean): void;
  /** the microphone closes what it is hearing now (it comes as final) and listens again */
  finishSpeech?(): void;
}
interface DreamHook {
  /** the Dream Tutor handles the video now: youtube.js leaves pauses, plays and voice commands alone */
  owns(): boolean;
  /** the tutor wants the microphone now (it waits for an answer or a talk is open) */
  wantsMic?(): boolean;
  /** something the microphone heard; true = handled here */
  heard(text: string, final: boolean, key?: string): boolean;
  /** youtube.js built its bar: add the Tutor button */
  decorateBar(bar: HTMLElement): void;
  /** ChatGPT or Claude was turned on in youtube.js: the tutor goes off */
  callChanged(): void;
  /** for the 🩺 check */
  diag(): Record<string, unknown> | null;
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
    html.dr-hide-cc-always .ytp-caption-window-container { display: none !important; }
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

// ---------------------------------------------------------------------------------------------------------------
// one video
// ---------------------------------------------------------------------------------------------------------------
type Mode = 'tutor' | 'call';
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
}

class Session {
  readonly videoId: string;
  mode: Mode;
  private vb: VideoBook | null = null;
  private ruleSentences: TimedSentence[] = [];
  private source: 'rule' | 'ai' = 'rule';
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
  private card: { lemma: string; word: string; pos: Position; token: number; kind: 'word' | 'phrase'; entryId: number | null } | null = null;
  private cardClose: ReturnType<typeof setTimeout> | null = null;
  private followTimer: ReturnType<typeof setInterval> | null = null;
  private callStop: { pos: Position; lemma: string; target: string; waiting: boolean; resolve?: (a: 'know' | 'dont_know' | 'bye' | 'timeout') => void } | null = null;
  private callHandled = new Map<string, number>();
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
        const next = extras.levelAuto !== false ? suggestLevel(progress.levels, settings.learnerLevel) : null;
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

  constructor(videoId: string, mode: Mode) {
    this.videoId = videoId;
    this.mode = mode;
    this.engine = new VideoEngine(() => (window.__ytcApi?.isAd() ? null : video()), () => this.vb);
  }

  get book(): Book | null { return this.vb?.book ?? null; }
  /** youtube.js must leave the video alone */
  owns(): boolean { return !this.disposed && (this.mode === 'tutor' || !!this.callStop); }

  /**
   * The microphone is needed: a window waits for "I know / I don't know", a talk is open (the OpenAI call has its own
   * microphone), or you chose "always" (for "hi bro" while the video plays).
   */
  wantsMic(): boolean {
    if (this.disposed || this.pttActive) return false;
    if (extras.micAlways || extras.voiceMode) return true;
    return !!this.cmdWin || this.windowOpen || !!this.callStop || !!(this.talk && !this.talk.live);
  }

  async start(): Promise<void> {
    pageStyle();
    this.mountPanel();
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
    } catch (e) { this.setStatus(`Could not start: ${(e as Error).message}`, true); return; }
    if (this.disposed) return;
    const sentences = info.cues.length ? window.__ytcApi!.buildSentences(info.cues) : [];
    if (!sentences.length) {
      this.setStatus('No subtitles could be read for this video. Turn on CC in the player, or load a subtitle file (.srt / .vtt) in the extension window.', true);
      this.renderEmpty('No subtitles yet. The Dream Tutor needs the video’s subtitles.');
      return;
    }
    this.ruleSentences = sentences;
    this.keys = await store.getKeys().catch(() => ({}));
    // the AI's complete sentences, when this video was read before
    let use = sentences;
    const split = extras.aiSentences ? await store.getSplit(this.videoId, SPLIT_VERSION).catch(() => null) : null;
    const words = flatten(sentences);
    if (split && split.words === words.length) { use = regroup(words, split.ends.map((end, i) => ({ end, text: split.texts[i] ?? '' }))); this.source = 'ai'; }
    this.buildBook(use, info.title || document.title.replace(/ - YouTube$/, ''), info.channel);
    this.zh = await store.getZh(this.videoId).catch(() => ({}));
    this.doneBefore = new Set(await store.getDone(this.videoId).catch(() => []));
    await this.loadHints();
    await this.prepareVoices();
    if (this.disposed) return;
    this.mountStage();
    this.render();
    this.setupController();
    this.listenVideo();
    this.followTimer = setInterval(() => this.follow(), 150);
    // tests only (the silent test voice is on): what the tutor is doing, readable from the page
    if (E2E()) { const t = setInterval(() => { if (this.disposed) clearInterval(t); else document.documentElement.dataset.drDebug = JSON.stringify(this.debug()); }, 150); }
    this.setStatus(this.readyText(info.source));
    this.countKnown();
    this.applyView();
    await this.backWhereYouStopped();
    if (this.mode === 'tutor') {
      const v = video();
      if (v && !v.paused) { this.engine.resumeHere = true; this.playback!.play(this.vb!.positionAt(v.currentTime) ?? undefined); }
      else if (v) this.playback!.seek(this.vb!.positionAt(v.currentTime) ?? this.vb!.order[0]);
      void this.checkKey();
    }
    void this.runAiJobs();
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
    return `${n} sentences${this.source === 'ai' ? ' (complete, by the AI)' : ''} · ${src ?? 'subtitles'}${this.mode === 'tutor' ? ` · stops at what is above ${settings.learnerLevel}` : ''}`;
  }

  private buildBook(sentences: TimedSentence[], title?: string, channel?: string): void {
    this.vb = buildVideoBook({ id: this.videoId, title: title ?? this.vb?.book.title ?? '', channel: channel ?? undefined }, sentences);
    const names = detectNames(this.vb.book, this.dict!);
    this.vb.book.names = names;
    this.names = new Set(names);
  }

  private async loadHints(): Promise<void> {
    const cached = await store.getVideoHints(this.videoId).catch(() => null) as (store.VideoHints & { split?: string; sentences?: number[]; v?: number }) | null;
    if (!cached || cached.level !== settings.learnerLevel) return;
    this.hints = cached.hints;
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
    this.mac = getEngine('webspeech');
    this.macVoice = settings.voice.voiceId || (await defaultVoiceFor('webspeech').catch(() => ''));
    this.zhMac = await chineseVoiceId().catch(() => null);
    // (the Mac's joke voices are left out, unless one is already yours)
    const novelty = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Deranged|Hysterical|Pipe Organ)$/;
    this.macVoices = (await this.mac.listVoices().catch(() => []))
      .filter((v) => /^en\b|^en[-_]/i.test(v.lang) && (!novelty.test(v.name) || v.id === this.macVoice))
      .map((v) => ({ id: v.id, name: v.name, lang: v.lang }))
      .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
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
    const kind = resolveVoice(extras.voice, this.keys);
    this.tts?.cancelAll();
    this.voiceKind = kind;
    if (kind === 'mac') {
      this.tts = this.mac; this.zhTts = this.mac; this.voiceId = this.macVoice; this.zhVoice = this.zhMac;
    } else {
      const name = kind === 'openai' ? 'OpenAI' : kind === 'azure' ? 'Microsoft' : 'ElevenLabs';
      this.tts = new VoiceWithBackup(cloudEngine(kind, 'en'), this.mac, () => this.macVoice, (e) => this.toast(`The ${name} voice failed (${e.message}) · the Mac voice speaks now.`, 9000));
      this.zhTts = new VoiceWithBackup(cloudEngine(kind, 'zh'), this.mac, () => this.zhMac ?? '', () => undefined);
      this.voiceId = kind === 'openai' ? extras.openaiVoice : kind === 'azure' ? extras.azureVoice : extras.elevenVoice;
      this.zhVoice = kind === 'azure' ? azureZhVoice(this.voiceId) : this.voiceId;
    }
    // the sentence plays again from the video (after the explanation): the word card has done its job
    this.router = new SentenceFromVideo(() => this.tts!, this.engine, (t) => this.isTaught(t), () => { if (this.card) this.closeCard(); });
    this.wordOut = new WithVolume(() => this.router!, () => this.volumeOf('word'));
    // the teacher's words: the AI's own sentences by the voice, the video's sentences it quotes by the video itself
    this.quotes = new QuotesFromVideo(() => this.tts!, this.engine, (t) => this.quotedSentence(t));
    this.teachOut = new WithVolume(() => this.quotes!, () => this.volumeOf('teacher'));
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
    if (!vb || this.mode !== 'tutor') return null;
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
    const h = this.teachOut?.speak('Hello! I am your English teacher. Let us learn with this video.', { voiceId: this.voiceId, rate: settings.voice.rate });
    void h?.done.then(() => { if (h.error) this.toast(h.error.message, 6000); });
  }

  /** the word voice at its volume (quick settings ▶) */
  testWord(): void {
    this.tts?.cancelAll();
    const h = this.wordOut?.speak('wonderful', { voiceId: this.voiceId, rate: Math.min(settings.voice.rate, 0.9) });
    void h?.done.then(() => { if (h.error) this.toast(h.error.message, 6000); });
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
      zhVoiceId: () => (settings.ai.speakChinese || settings.ai.activeStyle === 'way-bridge' ? this.zhVoice : null),
      mixedVoice: () => this.saysChineseItself(),
      contextZh: (lemma) => this.hints[lemma],
      explain: (req, onDelta) => {
        (window as unknown as { __drRequests?: ExplainRequest[] }).__drRequests?.push(structuredClone(req));
        // asked for already when the video stopped: the voice starts at once
        const pre = this.takePrefetch(req, onDelta);
        if (pre) return pre;
        const r = req.kind === 'passage' ? { ...req, seconds: settings.listen.lastSecondsWindow } as ExplainRequest : req;
        return aiExplain(r, onDelta);
      },
      mode: () => 'listening',
      onCommandWindow: (w) => this.onWindow(w),
      onPauseWindow: (open) => { this.windowOpen = open; },
      onStopTarget: (t) => this.onStopTarget(t),
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
    this.controller.enabled = this.mode === 'tutor';
    const pb = this.playback;
    // the part just explained plays again: no stops in it
    const stopAt = pb.hooks.stopAt;
    pb.hooks.stopAt = (pos) => {
      if (this.quietUntil) { if (comparePositions(pos, this.quietUntil) <= 0) return null; this.quietUntil = null; }
      // "Stops by itself: Off" = only when you pause
      if ((extras.stopGapSec ?? 45) < 0) return null;
      return stopAt ? stopAt(pos) : null;
    };
    this.pbOffs.push(
      pb.on('sentence', (pos) => { this.engine.target = pos; this.setCurrent(pos); this.prefetchVoice(pos); }),
      pb.on('word', (pos, ti) => this.setWord(pos, ti)),
      pb.on('state', (st) => this.onState(st)),
      pb.on('error', (e) => this.toast(e.message, 8000)),
      pb.on('finished', () => this.toast('End of the video.')),
    );
  }

  private onState(st: PlaybackState): void {
    // a stop at the end of a sentence: Playback waited for the sentence to end, the video plays on unless held here
    if (st === 'explaining') this.engine.hold();
    if (st === 'playing') {
      // the reading goes on: the talk and the stop are over, the video comes back (normal mode)
      if (this.talk) this.closeTalk();
      if (!this.flow) { this.partKeys = null; if (extras.view !== 'listening') this.hideStage(); else this.markPart(); }
    }
  }

  /** the learner switched between the tutor and the website call */
  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (!this.controller || !this.playback || !this.vb) return;
    this.controller.enabled = mode === 'tutor';
    if (mode === 'call') { this.endFlow(); this.closeTalk(); this.controller.skip(); this.engine.target = null; this.playback.stop(); this.tts?.cancelAll(); if (extras.view !== 'listening') this.hideStage(); }
    else {
      const v = video();
      if (v && !v.paused) { this.engine.resumeHere = true; this.playback.play(this.vb.positionAt(v.currentTime) ?? undefined); }
      void this.checkKey();
    }
    this.renderHead();
    this.renderStageTop();
  }

  // ---- the AI reads the video first: complete sentences, then the hard words, phrases and sentences --------------
  private async runAiJobs(): Promise<void> {
    const keys = await store.getKeys().catch(() => ({} as store.Keys));
    if (!keys.anthropic && !keys.openai) return;
    if (extras.aiSentences && this.source === 'rule' && this.vb) {
      try {
        this.setStatus(`${this.statusText} · the AI is finding the complete sentences…`);
        const out = await splitWithAi(this.ruleSentences, complete, (d, n) => { if (n > 1) this.setStatus(`${this.statusText.split(' · the AI')[0]} · the AI is finding the complete sentences… ${d}/${n}`); });
        if (this.disposed) return;
        const words = flatten(this.ruleSentences);
        const ends: number[] = [];
        let k = -1;
        for (const s of out) { k += s.words?.length ?? 0; ends.push(k); }
        if (k === words.length - 1) await store.setSplit(this.videoId, { version: SPLIT_VERSION, words: words.length, ends, texts: out.map((s) => s.text) }).catch(() => undefined);
        await this.whenCalm();
        if (this.disposed) return;
        this.rebuild(out);
        this.setStatus(this.readyText());
      } catch (e) {
        if (!this.disposed) this.setStatus(`${this.statusText.split(' · the AI')[0]} · complete sentences: ${(e as Error).message}`);
      }
    }
    await this.runHintsJob();
  }

  /** waits until nothing is going on (no stop, no explanation, no talk), so the book can change */
  private async whenCalm(): Promise<void> {
    for (let i = 0; i < 600 && !this.disposed; i++) {
      const c = this.controller;
      if (!c || (!c.busy && !this.cmdWin && !this.talk && !this.flow && !this.callStop && this.playback?.state !== 'explaining')) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** the AI's sentences replace the first guess: a new book, the reading goes on where the video is */
  private rebuild(sentences: TimedSentence[]): void {
    const v = video();
    const t = v?.currentTime ?? 0;
    const playing = !!v && !v.paused && this.mode === 'tutor' && this.playback?.state === 'playing';
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
      if (this.mode !== 'tutor' || this.engine.isOwn('play') || window.__ytcApi?.isAd()) return;
      // play during a stop, a talk or your own part: that is "go on"
      if (this.talk || this.flow || this.cmdWin) { this.goOn(); return; }
      const pb = this.playback!, c = this.controller!;
      if (pb.state === 'playing') return;
      if (c.busy || pb.state === 'explaining') c.skip();
      this.engine.resumeHere = true;
      pb.play(this.vb!.positionAt(v.currentTime) ?? undefined);
    };
    const onPause = () => {
      if (this.mode !== 'tutor' || this.engine.isOwn('pause') || v.ended || window.__ytcApi?.isAd()) return;
      const pb = this.playback!;
      setTimeout(() => {
        if (!v.paused || v.seeking || this.disposed || this.mode !== 'tutor') return;
        if (this.flow) { if (this.flow.wake) this.flow.wake(); return; } // paused during the replay: straight to the explanation
        if (pb.state !== 'playing') return; // already stopped (an explanation, a stop)
        // you stopped the video: the part plays again on the page, the teacher breaks it down (or just pause)
        this.trail('you paused the video');
        if (extras.explainOnStop) void this.partFlow(v.currentTime);
        else pb.pause();
      }, 120);
    };
    const onSeeking = () => {
      if (this.mode !== 'tutor' || this.engine.isOwn('seek') || window.__ytcApi?.isAd()) return;
      const pb = this.playback!;
      const pos = this.vb!.positionAt(v.currentTime);
      if (!pos) return;
      this.endFlow();
      this.closeTalk();
      if (this.controller!.busy || this.cmdWin) this.controller!.skip();
      if (!v.paused) { this.engine.resumeHere = true; pb.play(pos); } else pb.seek(pos);
    };
    const onFs = () => this.placeStage();
    const onPlayState = () => this.updateStopButton();
    v.addEventListener('play', onPlayState);
    v.addEventListener('pause', onPlayState);
    this.offs.push(() => { v.removeEventListener('play', onPlayState); v.removeEventListener('pause', onPlayState); });
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeking', onSeeking);
    document.addEventListener('fullscreenchange', onFs);
    this.offs.push(() => { v.removeEventListener('play', onPlay); v.removeEventListener('pause', onPause); v.removeEventListener('seeking', onSeeking); document.removeEventListener('fullscreenchange', onFs); });
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
      if (ad && this.mode === 'tutor') { this.engine.target = null; this.playback?.stop(); }
      if (!ad && this.mode === 'tutor' && !v.paused) { this.engine.resumeHere = true; this.playback?.play(this.vb.positionAt(v.currentTime) ?? undefined); }
    }
    if (ad) return;
    // where you are in this video (so next time it goes on from here)
    if (!v.paused && v.currentTime > 0 && Date.now() - this.spotSavedAt > 5000) {
      this.spotSavedAt = Date.now();
      void store.setSpot(this.videoId, { t: v.currentTime, d: v.duration || 0, at: Date.now() }).catch(() => undefined);
    }
    const reading = this.mode === 'tutor' && this.playback?.state === 'playing';
    this.placeBand();
    if (reading) return;
    if (v.paused && this.mode === 'tutor' && (this.playback?.state === 'explaining' || this.controller?.busy)) return; // the stop's sentence stays marked
    const pos = this.vb.positionAt(v.currentTime);
    if (!pos) return;
    if (!this.cur || sentenceKey(this.cur) !== sentenceKey(pos)) this.setCurrent(pos);
    const t = this.vb.timingOf(pos);
    if (t) {
      let wi = -1;
      for (let i = 0; i < t.tokenStart.length; i++) { const s = t.tokenStart[i]; if (s !== null && s <= v.currentTime + 0.03) wi = i; }
      if (wi !== this.curWord) this.setWord(pos, wi);
      if (this.mode === 'call' && extras.stopInCall && !v.paused && !this.callStop) this.maybeCallStop(pos, v.currentTime);
    }
  }

  // ---- the last N seconds, in complete sentences ------------------------------------------------------------------
  /** the sentences from about `seconds` before `time` up to the one being heard at `time` (whole sentences) */
  partAt(time: number, seconds: number): Position[] {
    const vb = this.vb;
    if (!vb) return [];
    const order = vb.order;
    let end = -1;
    for (let i = 0; i < order.length; i++) { const t = vb.timingOf(order[i])!; if (t.start <= time + 0.05) end = i; else break; }
    if (end < 0) return order.length ? [order[0]] : [];
    // a sentence that has only just started is not part of what was heard
    const te = vb.timingOf(order[end])!;
    if (end > 0 && time - te.start < 0.8) end--;
    let start = end;
    while (start > 0 && vb.timingOf(order[start - 1])!.end > time - seconds) start--;
    return order.slice(start, end + 1);
  }

  // ---- your own flows: you paused (the part), ← (a sentence), 📞 (talk) -------------------------------------------
  /** You stopped the video: the part plays again on the page, the teacher breaks it down, you talk, then the video goes back to the start of the part. */
  async partFlow(time?: number, playFirst = extras.replayPart): Promise<void> {
    const v = video(), pb = this.playback, c = this.controller;
    if (!v || !pb || !c || !this.vb || this.mode !== 'tutor') return;
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
    this.preconnect();
    if (playFirst) await this.replayPart(part, flow);
    if (flow.abort || this.flow !== flow) return;
    const text = part.map((p) => getSentence(this.vb!.book, p)?.text ?? '').filter(Boolean).join(' ');
    await c.explainNow('passage', text, part[0], null, undefined, undefined, false);
    if (flow.abort || this.flow !== flow) return;
    if (talkAfter() && !(flow as { bye?: boolean }).bye) await this.talkUntilGoOn(part[part.length - 1], undefined, this.lastExplanation());
    if (flow.abort || this.flow !== flow) return;
    this.flow = null;
    this.continueFrom(part[0], part[part.length - 1]);
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
    if (!v || !c || !vb || this.mode !== 'tutor') return;
    this.endFlow();
    this.closeTalk();
    let pos = vb.positionAt(v.currentTime) ?? vb.order[0];
    const t = vb.timingOf(pos)!;
    if (v.currentTime - t.start < 1.2) pos = prevPosition(vb.book, pos) ?? pos;
    this.explainSentenceAt(pos, this.playback?.state === 'playing' || !v.paused, true);
  }

  /**
   * One sentence, taught: played from the video, explained (RULE TWO, the original line first), played again. From ←
   * (the page shows the part around it) or from the Explain button of a sentence on the page (the page stays).
   */
  explainSentenceAt(pos: Position, wasPlaying = false, showPart = false): void {
    const v = video(), c = this.controller, vb = this.vb;
    if (!v || !c || !vb || this.mode !== 'tutor') return;
    const s = getSentence(vb.book, pos);
    if (!s) return;
    this.endFlow();
    this.closeTalk();
    if (c.busy || this.cmdWin) c.skip();
    this.playback?.pause();
    if (showPart || !this.stageVisible()) this.showStage(this.partAt(vb.timingOf(pos)!.end - 0.01, settings.listen.lastSecondsWindow));
    this.setCurrent(pos);
    this.engine.target = pos;
    const next = nextPosition(vb.book, pos) ?? pos;
    const flow = this.flow = { kind: 'sentence' as const, part: [pos], abort: false, resumeAt: next, quietTo: null };
    this.preconnect();
    void c.explainNow('sentence', s.text, pos, null, undefined, undefined, false).then(async () => {
      if (flow.abort || this.flow !== flow) return;
      if (talkAfter() && !(flow as { bye?: boolean }).bye) await this.talkUntilGoOn(pos, undefined, this.lastExplanation());
      if (flow.abort || this.flow !== flow) return;
      this.flow = null;
      // bye bye: from the start of the sentence; otherwise on after it (it was just played twice)
      if ((flow as { bye?: boolean }).bye) this.continueFrom(pos);
      else if (wasPlaying || talkAfter()) this.continueFrom(next);
    });
  }

  /** 📞 / Shift+T: talk to the tutor about what is on the screen now */
  async callTutor(): Promise<void> {
    if (this.mode !== 'tutor' || !this.vb) return;
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
    this.showStage(part.length ? part : [pos]);
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
    if (this.mode !== 'tutor') return;
    if (normalView() && extras.stageOn && !this.stageShown) this.showStage(this.partAt((this.vb?.timingOf(pos)?.end ?? 0) - 0.01, settings.listen.lastSecondsWindow));
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

  private talkTick(): void {
    const t = this.talk;
    if (!t) return;
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
    for (const r of [this.stage?.el, this.panel?.el]) {
      const box = r?.querySelector<HTMLElement>('.talk');
      if (!box) continue;
      if (!t) { box.hidden = true; box.innerHTML = ''; continue; }
      const live = t.live;
      const noLive = !live && !t.error && extras.liveOn && !this.keys.openai ? 'No live call: it needs your OpenAI key (⚙ → API keys). ' : '';
      const chat = t.chat;
      const voiceOn = !!window.__ytcApi?.settings().voiceOn;
      const state = chat ? (chat.lastError && !chat.busy ? `Claude did not answer: ${chat.lastError} · try again or type` : chat.thinking && !chat.speaking ? 'Asking Claude… (one moment)' : chat.speaking ? 'Your tutor is talking (say “stop” or press Space to interrupt)' : voiceOn ? 'Your turn: just talk, I am listening · or type · “go on” = back to the video' : 'Type your question (voice: turn on Voice commands in the extension window)')
        : live ? (live.state === 'connecting' ? 'Connecting the live voice…' : live.speaking ? 'Your tutor is talking (just talk to interrupt)' : t.hearing ? 'Listening to you…' : 'Live call · talk to me') : t.error ? `Live voice off: ${t.error}` : noLive + (window.__ytcApi?.settings().voiceOn ? 'Talk to me (I am listening) · or type' : 'Type your question');
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

  private setTalkStatus(text: string): void {
    for (const r of [this.stage?.el]) { const el = r?.querySelector<HTMLElement>('.flowstate'); if (el) { el.textContent = text; el.hidden = !text; } }
  }

  // ---- call mode: optional stops at hard words (silent card; the word goes to the call) -------------------------
  private maybeCallStop(pos: Position, now: number): void {
    const c = this.controller, t = this.vb?.timingOf(pos);
    if (!c || !t) return;
    for (const tr of c.triggersFor(pos)) {
      if (!tr.lemma) continue;
      const end = t.tokenEnd[tr.end] ?? t.tokenStart[tr.end];
      if (end === null || end === undefined || now < end || now > end + 1.2) continue;
      const key = `${sentenceKey(pos)}:${tr.lemma}`;
      if (this.callHandled.has(key)) continue;
      this.callHandled.set(key, Date.now());
      void this.runCallStop(pos, tr.lemma, tr.target, tr.kind === 'phrase' ? 'phrase' : 'word', tr.token);
      return;
    }
  }

  private async runCallStop(pos: Position, lemma: string, target: string, kind: 'word' | 'phrase', token: number): Promise<void> {
    const v = video();
    if (!v) return;
    this.callStop = { pos, lemma, target, waiting: false };
    this.engine.hold();
    this.openCard(pos, token, lemma, target, kind, null);
    const ms = settings.listen.commandWindowMs || 5000;
    const answer = await new Promise<'know' | 'dont_know' | 'bye' | 'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), ms);
      this.callStop!.resolve = (a) => { clearTimeout(t); resolve(a); };
      this.showCommandWindow({ phase: 'before', ms, target, kind });
    });
    this.showCommandWindow(null);
    const sentence = getSentence(this.vb!.book, pos)?.text ?? '';
    if (answer === 'know') { await this.changeStatus(lemma, 'known'); this.closeCard(); this.callStop = null; this.replayFrom(pos); return; }
    if (answer === 'bye') { await this.changeStatus(lemma, 'learning'); this.closeCard(); this.callStop = null; this.replayFrom(pos); return; }
    // send the word to the call; the video waits for you (play, "go on" or "shut up")
    await this.changeStatus(lemma, 'learning');
    const s = window.__ytcApi?.settings();
    const text = `In this video I just heard: "${sentence}"\n\nWhat does "${target}" mean here? Explain it in easy spoken English, in this exact context, in a few short sentences. At the end, give its two Chinese meanings that fit this sentence. No headings, no lists, no filler.`;
    this.toast(`Asking ${s?.target === 'chatgpt' ? 'ChatGPT' : 'Claude'} about “${target}”… press play (or say “go on”) to continue.`, 7000);
    chrome.runtime.sendMessage({ type: 'ask', text, target: s?.target }).then((r: { result?: string } | undefined) => {
      if (r?.result && !/^Sent /.test(r.result)) window.__ytcApi?.setBarStatus(`⚠ NOT sent: ${r.result.slice(0, 160)}`, true);
    }).catch(() => undefined);
    this.callStop.waiting = true;
    const resume = () => { v.removeEventListener('play', onPlay); if (this.callStop?.pos === pos) this.callStop = null; this.closeCard(); this.replayFrom(pos); };
    const onPlay = () => { if (!this.engine.isOwn('play')) resume(); };
    v.addEventListener('play', onPlay);
    this.callStop.resolve = () => resume();
  }

  private replayFrom(pos: Position): void {
    const v = video(), t = this.vb?.timingOf(pos);
    if (!v || !t) return;
    // back to the start of the interrupted sentence, then on
    this.engine.markOwn('seek'); v.currentTime = Math.max(0, t.start - 0.15);
    if (v.paused) { this.engine.markOwn('play'); void v.play().catch(() => undefined); }
  }

  // ---- answers (voice, keys, buttons) ----------------------------------------------------------------------
  answerKnow(): void {
    if (this.callStop) { this.callStop.resolve?.('know'); return; }
    const c = this.controller; if (!c) return;
    if (c.stopWindow === 'before') this.dropPrefetch();
    const l = c.lastExplained;
    if (l?.lemma) { c.markKnown(l.lemma); void this.changeStatus(l.lemma, 'known'); if (this.card?.lemma === l.lemma) this.closeCard(); }
    if (this.talk && !c.stopWindow) { this.goOn(); return; }
    if (!c.answerWindow('know')) this.goOn();
  }
  answerDontKnow(): void {
    if (this.callStop) { this.callStop.resolve?.('dont_know'); return; }
    const c = this.controller; if (!c) return;
    if (c.answerWindow('dont_know')) return;
    const l = c.lastExplained;
    if (l?.lemma) void this.changeStatus(l.lemma, 'learning');
    void c.explainAgain();
  }
  answerGoOn(): void {
    if (this.callStop) { this.callStop.resolve?.('bye'); return; }
    const c = this.controller; if (!c) return;
    if (c.stopWindow === 'before') { c.answerWindow('bye'); return; }
    this.goOn();
  }
  /** "bye bye": the AI stops whatever it does, and the video plays again from the start of what was explained */
  byeBye(): void {
    const c = this.controller;
    if (!c || this.mode !== 'tutor') return;
    if (extras.voiceMode) { void store.patchExtras({ voiceMode: false }); this.toast('Voice mode off. Say “hello” (or click 🎙) to turn it on again.', 6000); }
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
    if (/^(hello|hallo|hi|hey)$/.test(first) && (extras.voiceMode || extras.micAlways) && !echo(/\b(hello|hallo|hi|hey)\b/i)) return () => this.voiceHello();
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

  /** "hello": voice mode on; the video playing = stop, play the part again, explain it, play it again; stopped = the call */
  voiceHello(): void {
    if (!extras.voiceMode) {
      extras.voiceMode = true;
      void store.patchExtras({ voiceMode: true });
      this.toast('Voice mode on: “hello” = explain, “stop”, “play”, ask anything, “bye bye” = off.', 9000);
    }
    const v = video();
    if (v && !v.paused && !this.flow) void this.partFlow(v.currentTime, true);
    else if (!this.talk) void this.callTutor();
  }

  /** 🎙 button: voice mode on / off */
  toggleVoiceMode(): void {
    const on = !extras.voiceMode;
    extras.voiceMode = on;
    void store.patchExtras({ voiceMode: on });
    this.toast(on ? 'Voice mode on: “hello” = explain, “stop”, “play”, ask anything, “bye bye” = off.' : 'Voice mode off.', on ? 9000 : 3000);
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
    if (!c || this.mode !== 'tutor' || !c.busy) return;
    const pos = this.playback?.position ?? this.cur;
    const l = c.lastExplained;
    c.hold();
    this.tts?.cancelAll();
    if (!pos) return;
    this.heldTalk = true;
    this.openTalk(l?.pos ?? pos, l?.target, this.lastExplanation());
  }
  private heldTalk = false;

  /** "hi bro" / Shift+E: explain the last part */
  explainLast(): void {
    if (this.mode !== 'tutor' || !this.controller) return;
    const v = video();
    void this.partFlow(v?.currentTime, false);
  }
  /** "shut up": the tutor stops talking */
  shutUp(): void {
    if (this.callStop) { this.callStop.resolve?.('bye'); return; }
    if (this.talk?.live?.speaking) { this.talk.live.interrupt(); return; }
    this.controller?.skip();
    this.tts?.cancelAll();
  }

  /** recognition results already acted on (a result grows while you speak; it acts once) */
  private acted = new Set<string>();
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
    if (final || !key || this.mode !== 'tutor') return;
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
    const t = text.trim();
    if (!t) return false;
    if (key && this.acted.has(key)) return true;
    this.watchStill(t, final, key);
    const act = (fn: () => void) => { if (key) { this.acted.add(key); if (this.acted.size > 300) this.acted.clear(); } fn(); };
    const lower = t.toLowerCase();
    if (this.mode !== 'tutor' && !this.callStop) return false; // call mode: youtube.js handles "hi bro" / "shut up"
    // voice mode: hello / stop / play (said alone, not the video's or the tutor's own words)
    const cmd = this.mode === 'tutor' ? this.voiceCommand(lower, final) : null;
    if (cmd) { act(cmd); return true; }
    // the live call hears you itself (with echo cancelling); the page's recognition could hear the tutor
    if (this.talk?.live && this.talk.live.state !== 'error') return true;
    // the call with Claude: while the tutor talks only "stop" / "bye bye" count (its own voice must not be taken for yours)
    const chat = this.talk?.chat;
    if (chat && !chat.closed && this.talk) {
      const talk = this.talk;
      if (/\b(bye|buy|by)[\s-]*(bye|buy|by)\b/.test(lower) && final) { act(() => this.byeBye()); return true; }
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
      chat.note(`heard: ${t}`);
      act(() => chat.ask(t));
      return true;
    }
    const inWindow = this.windowOpen || !!this.cmdWin || !!this.callStop;
    // "bye bye" stops the AI whatever it does (it is never in an explanation, so it is safe while the tutor talks)
    if (/\b(bye|buy|by)[\s-]*(bye|buy|by)\b/.test(lower) && (final || /bye[\s-]*bye/.test(lower))) { act(() => this.byeBye()); return true; }
    // the tutor's own voice must not be taken for the learner's
    if (this.controller?.busy || Date.now() - this.lastTtsEnd < 700) { if (/\bshut\s*up\b/.test(lower)) act(() => this.shutUp()); return true; }
    if (final) this.lastHeardAt = Date.now();
    if (/\bshut\s*up\b/.test(lower)) { act(() => this.shutUp()); return true; }
    if (/\b(hi|hey|high)\s*(bro|bruh|brah|bra)\b/.test(lower)) { if (!this.callStop) act(() => this.explainLast()); return true; }
    if (this.talk) {
      // the talk without the live call: commands, or a question for the tutor
      if (!final) return true;
      const d = detectCommand(t);
      if (d.intent === 'bye' || /\b(let'?s go|go on|continue)\b/.test(lower)) act(() => this.goOn());
      else if (d.intent === 'know' && t.split(/\s+/).length <= 4) act(() => this.answerKnow());
      else if (d.intent === 'dont_know' && t.split(/\s+/).length <= 5) act(() => this.answerDontKnow());
      else act(() => this.ask(t, true));
      return true;
    }
    if (inWindow) {
      const d = detectCommand(t);
      if (d.intent === 'know' || d.intent === 'dont_know' || d.intent === 'bye') {
        if (final || d.score >= 0.92) act(() => { if (d.intent === 'know') this.answerKnow(); else if (d.intent === 'dont_know') this.answerDontKnow(); else this.answerGoOn(); });
        return true;
      }
      if (final) this.controller?.answerWindow({ text: t }); // swallowed: never sent to the AI
      return true;
    }
    // talking to the tutor (🎙 on), only while the video is stopped and nobody is talking
    if (this.mode === 'tutor' && this.talkOn && final && this.controller && !this.controller.busy && this.playback?.state !== 'playing') {
      const d = detectCommand(t);
      act(() => { if (d.intent === 'bye') this.answerGoOn(); else this.ask(t, true); });
      return true;
    }
    return this.mode === 'tutor';
  }

  ask(question: string, spoken = false): void {
    const c = this.controller; if (!c || !this.vb) return;
    const pos = this.talk?.pos ?? this.playback?.position ?? this.cur ?? this.vb.order[0];
    if (this.mode === 'call') { void chrome.runtime.sendMessage({ type: 'ask', text: question, target: window.__ytcApi?.settings().target }); this.toast('Sent to the call.'); return; }
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
    this.renderTranscript();
    if (this.card && this.card.entryId === null && (e.kind === 'word' || e.kind === 'phrase') && e.status === 'thinking') this.card.entryId = e.id;
    if (this.card && this.card.entryId === e.id) this.updateCardExplain(e);
    // an explanation starts: the live call gets ready (mic off) / stops listening while the teacher talks
    if (e.status === 'thinking' && e.kind !== 'question' && this.mode === 'tutor') { this.preconnect(); this.muteTalk(); }
    if (e.status === 'speaking' && this.talk) this.muteTalk();
    if (e.status === 'done' || e.status === 'error' || e.status === 'skipped') {
      this.lastTtsEnd = Date.now();
      if (e.status === 'skipped' && !this.talk && this.pre && !this.flow) { this.pre.close(); this.pre = null; }
      if (this.talk && e.status === 'done') { this.talk.explanation = e.text; this.talk.live?.update(this.liveContext(this.talk.word, e.text)); this.talk.live?.setMic(true); }
    }
    // every explained word or phrase goes into My Vocabulary, with its sentence, explanation and where in the video
    // (also when "bye bye" cut it short: the word was met and stays to learn)
    if (e.lemma && (e.kind === 'word' || e.kind === 'phrase' || e.kind === 'sentence') && (e.status === 'done' || (e.status === 'skipped' && e.text.length > 40)) && e.text && !this.saved.has(e.id) && this.vb) {
      this.saved.add(e.id);
      const t = e.position ? this.vb.timingOf(e.position) : null;
      void store.upsertEntry({ lemma: e.lemma, word: e.target, sentence: e.sentence, explanation: shown(e.text), chinese: e.chinese ?? (this.hints[e.lemma]?.join('，') ?? ''), bookId: this.vb.book.id, bookTitle: this.vb.book.title, chapter: t ? clock(t.start) : '', position: e.position, level: e.level as CefrLevel | undefined, again: e.again }).catch(() => undefined);
    }
    this.renderBandSay();
  }

  /** a stop starts on a word, phrase or sentence (the page shows the last part; the card opens) / is over */
  private onStopTarget(t: { kind: string; target: string; lemma?: string } | null): void {
    if (!t) { this.closeCardSoon(); return; }
    const pos = this.playback?.position ?? this.cur;
    // remembered: next time this video is watched, this hard phrase / sentence is not stopped at again
    if (pos && (t.kind === 'phrase' || t.kind === 'sentence')) void store.addDone(this.videoId, sentenceKey(pos)).catch(() => undefined);
    this.lastStopAt = pos && this.vb ? this.vb.timingOf(pos)?.start ?? null : null;
    if (pos && this.vb && extras.stageOn) {
      const tm = this.vb.timingOf(pos);
      if (tm) this.showStage(this.partAt(tm.end - 0.01, settings.listen.lastSecondsWindow));
    }
    if (pos) this.engine.target = pos;
    if (pos && t.lemma) this.prefetchExplain(t.kind as 'word' | 'phrase' | 'sentence', t.target, pos, t.lemma);
    if (t.lemma && t.kind !== 'sentence') this.anchorStopCard(t.kind, t.target, t.lemma);
    else if (pos) { this.closeCard(); this.setCurrent(pos); this.markStopSentence(pos); }
  }

  // ---- no waiting: the explanation is asked for when the video stops, its first sentences are voiced ahead ----------
  private prefetchKey(kind: string, target: string, pos: Position | undefined): string { return `${kind}|${norm(target)}|${pos ? sentenceKey(pos) : ''}`; }

  private prefetchExplain(kind: 'word' | 'phrase' | 'sentence', target: string, pos: Position, lemma: string): void {
    if (this.mode !== 'tutor' || !this.vb || (!this.keys.anthropic && !this.keys.openai)) return;
    const key = this.prefetchKey(kind, target, pos);
    if (this.prefetched.has(key)) return;
    for (const [k, p] of this.prefetched) if (Date.now() - p.at > 90_000) { p.cancel(); this.prefetched.delete(k); }
    const cur = getSentence(this.vb.book, pos);
    const ctx = contextAround(this.vb.book, pos, settings.ai.contextWordsBefore, settings.ai.contextWordsAfter);
    const look = kind === 'word' ? this.dict?.lookup(target)?.entry : null;
    const req: ExplainRequest = {
      kind, target, sentence: cur?.text ?? target, before: ctx.before, after: ctx.after,
      book: { title: this.vb.book.title, chapter: this.vb.book.chapters[pos.chapter]?.title ?? '' },
      dict: look ? { ipa: look.ipa, zh: look.zh.split('\n')[0], level: look.level } : undefined,
      history: [], position: { chapter: pos.chapter, paragraph: pos.paragraph, sentence: pos.sentence }, styleId: settings.ai.activeStyle, again: false,
    };
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
    if (this.voiceKind === 'mac' || this.voiceKind === 'azure' || this.mode !== 'tutor' || !this.controller) return;
    for (const t of this.controller.triggersFor(pos)) if (t.lemma && t.kind !== 'sentence') this.tts?.prefetch?.(t.target, this.voiceId, Math.min(settings.voice.rate, 0.9));
  }

  /** a commands window opened / closed: after an explanation the talk opens instead of a countdown */
  private onWindow(w: CommandWindow | null): void {
    this.showCommandWindow(w);
    if (!w || this.mode !== 'tutor') return;
    if (w.phase === 'before') { this.muteTalk(); return; }
    if (w.phase === 'after' && talkAfter() && !this.flow) {
      // (keeping the window open while we talk reports it again: the talk is only opened once)
      if (this.talk) { this.talk.live?.setMic(true); return; }
      const pos = this.playback?.position ?? this.cur;
      const l = this.controller?.lastExplained;
      if (pos) this.openTalk(l?.pos ?? pos, l?.target, this.lastExplanation());
    }
  }

  // ---- background jobs: Chinese meanings in context, the AI's hard phrases and hard sentences (cheap model, once per video) ----
  private async runHintsJob(): Promise<void> {
    const keys = await store.getKeys().catch(() => ({} as store.Keys));
    if ((!keys.anthropic && !keys.openai) || !this.vb || !this.dict) return;
    const cached = await store.getVideoHints(this.videoId).catch(() => null) as (store.VideoHints & { split?: string; v?: number }) | null;
    if (cached && cached.level === settings.learnerLevel && cached.v === HINTS_VERSION && cached.split === this.source) return;
    const book = this.vb.book;
    const known = new Set(Object.entries(vocab.words).filter(([, s]) => s === 'known' || s === 'ignored').map(([l]) => l));
    const hints: HintMap = { ...(cached && cached.level === settings.learnerLevel ? cached.hints : {}) };
    const vbAtStart = this.vb;
    try {
      if (!cached || cached.level !== settings.learnerLevel) {
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
      await store.setVideoHints(this.videoId, { version: store.HINTS_VERSION, level: settings.learnerLevel, hints: this.hints, phrases: this.phrases, split: this.source, sentences: hard, v: HINTS_VERSION } as store.VideoHints);
      if (!this.disposed) { this.render(); this.setStatus(`${this.statusText.split(' · AI')[0]} · AI: hard words, phrases and ${hard.length} sentences ready`); }
    } catch (e) {
      if (!this.disposed) this.setStatus(`${this.statusText} · AI meanings: ${(e as Error).message}`);
    }
  }

  // ---- live Chinese translation of the lines ------------------------------------------------------------------
  private zhKey(pos: Position): string { const s = this.vb ? getSentence(this.vb.book, pos) : null; return s ? norm(s.text) : ''; }

  /** translates the lines that are not translated yet (a few at a time; each appears when the AI writes it) */
  private ensureZh(positions: Position[]): void {
    if (!extras.zhLines || (!this.keys.anthropic && !this.keys.openai) || !this.vb) return;
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
  private saveZhSoon(): void {
    if (this.zhSave) clearTimeout(this.zhSave);
    this.zhSave = setTimeout(() => void store.setZh(this.videoId, this.zh).catch(() => undefined), 1500);
  }
  private paintZh(pos: Position, zh: string): void {
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
    el.querySelector('form.ask')!.addEventListener('submit', (ev) => {
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
    el.innerHTML = `<div class="top"></div><div class="flowstate" hidden></div><div class="page"><div class="doc-inner"></div></div>
      <div class="dock"><div class="sayrow"><div class="say"></div><button class="quiet hand" data-act="hand" hidden title="Pause the teacher and ask (Space)">✋ Ask</button><button class="quiet hand" data-act="bye" hidden title="Bye bye: stop the AI and play again (Esc)">Bye bye</button></div><div class="talk" hidden></div><form class="ask"><input type="text" placeholder="Type or speak a question for your tutor" aria-label="Question for the tutor"><button type="button" class="speak" data-act="speak" title="Speak your question: Chrome writes it down">🎤 Speak</button><button type="submit">Ask</button></form></div>
      <div class="cmd" hidden></div><div class="card" hidden></div><div class="quick" hidden></div><div class="toast" hidden></div><button type="button" class="selx" hidden></button>`;
    root.appendChild(el);
    this.stage = { host, root, el };
    // you clicked the video to pause it and the page appeared under the mouse: that same click must not tap a word
    for (const type of ['click', 'dblclick']) el.addEventListener(type, (e) => { if (Date.now() - this.stageShownAt < 600) { e.stopPropagation(); e.preventDefault(); } }, true);
    this.placeStage();
    const page = el.querySelector<HTMLElement>('.page')!;
    page.addEventListener('wheel', () => { this.userScrollAt = Date.now(); }, { passive: true });
    page.addEventListener('touchmove', () => { this.userScrollAt = Date.now(); }, { passive: true });
    // the window, the dock (explanation, talk) or the commands window changed size: the part is fitted again
    const ro = new ResizeObserver(() => this.fitPart());
    ro.observe(page);
    this.offs.push(() => ro.disconnect());
    this.wireWords(page);
    this.wireAsk(el);
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
    const listening = extras.view === 'listening';
    const range = this.partKeys && this.vb ? (() => { const ps = this.vb.order.filter((p) => this.partKeys!.has(sentenceKey(p))); return ps.length ? `${clock(this.vb.timingOf(ps[0])!.start)} – ${clock(this.vb.timingOf(ps[ps.length - 1])!.end)}` : ''; })() : '';
    const sc = shortcutMap(extras.shortcuts);
    const playing = !!video() && !video()!.paused;
    top.innerHTML = `<span class="brand">Dream</span>${this.mode === 'tutor' ? `<button data-act="stop" class="stopbtn" title="${playing ? 'Stop everything' : 'Play on'} (${esc(comboLabel(sc.stop))})">${playing ? '⏸' : '▶'}</button>` : ''}<span class="ttl">${esc(this.vb?.book.title ?? '')}</span>${range ? `<span class="range">${range}</span>` : ''}<span class="grow"></span>
      <span class="seg" data-name="secs">${[20, 30, 40, 60].map((n) => `<button data-secs="${n}" class="${settings.listen.lastSecondsWindow === n ? 'on' : ''}">${n}s</button>`).join('')}</span>
      <button data-act="smaller" title="Smaller text (${esc(comboLabel(sc.smaller))})">A−</button><button data-act="bigger" title="Bigger text (${esc(comboLabel(sc.bigger))})">A+</button>
      <button data-act="zh" aria-pressed="${extras.zhLines}" title="Chinese under each line (${esc(comboLabel(sc.zh))})">中文</button>
      ${this.mode === 'tutor' ? `<button data-act="talk" title="Talk to my tutor (${esc(comboLabel(sc.talk))})">📞 Talk</button><button data-act="voice" aria-pressed="${extras.voiceMode}" title="Voice mode: say hello / stop / play / anything / bye bye">🎙 Voice${extras.voiceMode ? ' on' : ''}</button>` : ''}
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
    if (!v || this.mode !== 'tutor' || !this.playback) return;
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

  /** shows the page; `part` = only these sentences (a stop, a pause); none = all subtitles */
  private showStage(part?: Position[]): void {
    if (!this.stage || !this.vb) return;
    if (normalView() && !extras.stageOn && part) return;
    this.partKeys = part && part.length ? new Set(part.map((p) => sentenceKey(p))) : null;
    this.stageShown = true;
    if (this.stage.host.hidden) this.stageShownAt = Date.now();
    this.placeStage();
    this.stage.host.hidden = false;
    document.documentElement.classList.add('dr-stage');
    document.documentElement.classList.toggle('dr-hide-cc', extras.hideYtCaptions);
    this.markPart();
    this.renderStageTop();
    this.showCommandWindow(this.cmdWin);
    this.renderTalk();
    if (part?.length) { this.ensureZh(part); this.scrollToCur(true); }
  }

  private hideStage(): void {
    if (!this.stage || extras.view === 'listening') return;
    this.stageShown = false;
    this.partKeys = null;
    this.stage.host.hidden = true;
    document.documentElement.classList.remove('dr-stage');
    if (this.quickRoot === this.stage.el) this.closeQuick();
    this.showCommandWindow(this.cmdWin);
    if (this.card) this.closeCard();
  }

  private markPart(): void {
    const el = this.stage?.el;
    if (!el) return;
    el.dataset.view = this.partKeys && normalView() ? 'part' : 'all';
    el.querySelectorAll<HTMLElement>('.s').forEach((s) => s.classList.toggle('in-part', !!this.partKeys?.has(s.dataset.key ?? '')));
    // all subtitles: your own text size at once (the playing line is placed right after this)
    if (el.dataset.view !== 'part') el.querySelector<HTMLElement>('.page')?.style.removeProperty('font-size');
    this.fitPart();
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
    const max = clamp(extras.stageSizePx || 34, 16, 96);
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
    if (extras.view === 'listening') this.showStage();
    else if (!this.talk && !this.flow && !this.cmdWin && !(this.playback?.state === 'explaining')) this.hideStage();
    else this.markPart();
    this.renderStageTop();
    this.renderHead();
    this.scrollToCur(true);
  }

  stageVisible(): boolean { return !!this.stage && !this.stage.host.hidden; }

  private resize(dir: number): void {
    if (this.stageVisible()) void store.patchExtras({ stageSizePx: clamp(extras.stageSizePx + dir * 2, 16, 96) });
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
    renderQuick(q, { settings, extras, keys: this.keys, voiceNow: this.voiceKind, azureAvail: this.azureAvail, levelText: this.levelText, macVoices: this.macVoices, macVoice: this.macVoice, testVoice: () => this.testVoice(), testWord: () => this.testWord(), close: () => this.closeQuick(), toast: (t, ms) => this.toast(t, ms) });
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
      h.style.setProperty('--subtitle-size', `${clamp(settings.appearance.subtitleSizePx || 26, 16, 96)}px`);
      h.style.setProperty('--explain-size', `${clamp(settings.appearance.explainSizePx || 14, 12, 24)}px`);
      h.style.setProperty('--stage-size', `${clamp(extras.stageSizePx || 34, 16, 96)}px`);
      h.style.setProperty('--band-bottom', `${clamp(extras.bandBottom ?? 7, 0, 60)}%`);
    }
    applyPageLook();
    this.fitPart();
  }

  renderHead(): void {
    const head = this.panel?.el.querySelector<HTMLElement>('.head');
    if (!head) return;
    const tutor = this.mode === 'tutor';
    const sc = shortcutMap(extras.shortcuts);
    const callName = window.__ytcApi?.settings().target === 'chatgpt' ? 'ChatGPT call' : 'Claude call';
    head.innerHTML = `<span class="brand">Dream</span><span class="mode ${tutor ? 'tutor' : ''}">${tutor ? 'My tutor' : esc(callName)}</span><span class="grow"></span>
      ${tutor ? `<button data-act="last" title="Explain what was just said (${esc(comboLabel(sc.explainLast))}, or say “hi bro”); ${esc(comboLabel(sc.explainSentence))} = the last sentence">Explain ${settings.listen.lastSecondsWindow} s</button><button data-act="talk" title="Talk to my tutor (${esc(comboLabel(sc.talk))})">📞</button>` : ''}
      <button data-act="view" title="Listening mode: all subtitles over the screen (${esc(comboLabel(sc.listening))})">📖</button>
      ${tutor ? `<button data-act="pageAuto" aria-pressed="${extras.stageOn}" title="The big page at stops and pauses: on / off (off = you only watch the video)">📄 ${extras.stageOn ? 'on' : 'off'}</button>` : ''}
      <button data-act="zh" aria-pressed="${settings.ai.speakChinese}" title="Say the two Chinese meanings at the end of explanations">中文 ${settings.ai.speakChinese ? 'on' : 'off'}</button>
      <button data-act="smaller" title="Smaller text">A−</button><button data-act="bigger" title="Bigger text">A+</button>
      <button data-act="voice" aria-pressed="${extras.voiceMode}" title="Voice mode: say hello / stop / play / anything / bye bye">🎙${extras.voiceMode ? ' on' : ''}</button>
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
        b.type = 'button'; b.className = 'sx'; b.textContent = '▶ Explain';
        b.title = 'Explain this sentence: it plays, the teacher explains it, it plays again';
        s.prepend(b);
      });
      for (const p of this.vb.order) { const zh = this.zh[this.zhKey(p)]; if (zh) this.paintZh(p, zh); }
      this.markPart();
    }
    if (this.cur) { const c = this.cur; this.cur = null; this.setCurrent(c); }
    this.renderBandLine();
  }

  private sentenceEl(root: HTMLElement | undefined, pos: Position): HTMLElement | null {
    return root?.querySelector<HTMLElement>(`.s[data-key="${sentenceKey(pos)}"]`) ?? null;
  }

  private setCurrent(pos: Position): void {
    const prev = this.cur;
    this.cur = pos;
    this.curWord = -1;
    for (const root of [this.panel?.el, this.stage?.el]) {
      if (!root) continue;
      const back = prev && this.vb && comparePositions(pos, prev) < 0;
      root.querySelectorAll('.s.cur').forEach((e) => { e.classList.remove('cur'); e.classList.add('past'); });
      root.querySelectorAll('.w.cur-w').forEach((e) => e.classList.remove('cur-w'));
      if (back || !prev) {
        const keys = new Set<string>();
        for (const p of this.vb!.order) { if (sentenceKey(p) === sentenceKey(pos)) break; keys.add(sentenceKey(p)); }
        root.querySelectorAll<HTMLElement>('.s').forEach((e) => e.classList.toggle('past', keys.has(e.dataset.key ?? '')));
      }
      const el = this.sentenceEl(root, pos);
      if (el) { el.classList.remove('past'); el.classList.add('cur'); }
    }
    this.scrollToCur();
    this.renderBandLine();
    // listening mode: the Chinese of the lines coming up is ready before they are heard
    if (this.stageVisible() && extras.zhLines && this.vb) {
      const i = this.vb.order.findIndex((p) => sentenceKey(p) === sentenceKey(pos));
      if (i >= 0) this.ensureZh(this.vb.order.slice(Math.max(0, i - 3), i + 12));
    }
  }

  /** the playing line stays at about `followAt` % from the top (Dream Read), unless you scrolled a moment ago */
  private scrollToCur(force = false): void {
    if (!this.cur || (!force && Date.now() - this.userScrollAt < 4000)) return;
    const f = clamp(extras.followAt ?? 42, 10, 85) / 100;
    for (const [root, sel] of [[this.panel?.el, '.lines'], [this.stage?.el, '.page']] as const) {
      if (!root) continue;
      const box = root.querySelector<HTMLElement>(sel);
      const el = this.sentenceEl(root, this.cur);
      if (!box || !el || !box.clientHeight) continue;
      const top = box.scrollTop + (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - box.clientHeight * f + el.offsetHeight / 2;
      box.scrollTo({ top: Math.max(0, top), behavior: force ? 'auto' : 'smooth' });
    }
  }

  private setWord(pos: Position, ti: number): void {
    this.curWord = ti;
    for (const root of [this.panel?.el, this.band?.el, this.stage?.el]) {
      if (!root) continue;
      root.querySelectorAll('.w.cur-w').forEach((e) => e.classList.remove('cur-w'));
      if (ti >= 0) this.sentenceEl(root, pos)?.querySelector(`.w[data-t="${ti}"]`)?.classList.add('cur-w');
    }
  }

  /** clicks on the text: a word = explain it (card + voice), double click = I know, a sentence = go there */
  private wireWords(container: HTMLElement): void {
    let clickTimer: ReturnType<typeof setTimeout> | null = null;
    const selectionOf = (): Selection | null => { const r = container.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null }; return r.getSelection?.() ?? document.getSelection(); };
    container.addEventListener('mouseup', () => setTimeout(() => this.onSelection(container, selectionOf()), 0));
    container.addEventListener('click', (ev) => {
      const sx = (ev.target as HTMLElement).closest<HTMLElement>('.sx');
      if (sx) {
        ev.stopPropagation();
        const p = keyToPos(sx.closest<HTMLElement>('.s')?.dataset.key ?? '');
        if (p) this.explainSentenceAt(p);
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
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => { clickTimer = null; this.tapWord(w, pos); }, 260);
    });
    container.addEventListener('dblclick', (ev) => {
      const w = (ev.target as HTMLElement).closest<HTMLElement>('.w[data-lemma]');
      if (!w) return;
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      const lemma = w.dataset.lemma!;
      this.controller?.markKnown(lemma);
      void this.changeStatus(lemma, 'known');
      this.toast(`“${lemma}” marked known`);
      if (this.card?.lemma === lemma) this.closeCard();
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
  explainSelection(text: string, pos: Position): void {
    const c = this.controller;
    if (!c || !this.vb || this.mode !== 'tutor') return;
    this.endFlow();
    this.closeTalk();
    if (c.busy || this.cmdWin) c.skip();
    this.playback?.pause();
    this.engine.target = pos;
    this.setCurrent(pos);
    const word = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (word && !/\s/.test(word)) {
      const entry = this.dict?.lookup(word)?.entry;
      void c.explainNow('word', word, pos, entry ? { ipa: entry.ipa, zh: entry.zh.split('\n')[0], level: entry.level } : null, this.dict?.lemmaOf(word) || word.toLowerCase());
    } else void c.explainNow('phrase', text, pos, null, text.toLowerCase());
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
    if (this.mode === 'tutor' && this.playback) {
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
    if (this.mode === 'tutor' && this.controller) {
      const entry = this.dict?.lookup(target)?.entry;
      this.engine.target = pos;
      void this.controller.explainNow('word', target, pos, entry ? { ipa: entry.ipa, zh: entry.zh.split('\n')[0], level: entry.level } : null, lemma, undefined, undefined, undefined, undefined);
    }
  }

  // ---- the word card ---------------------------------------------------------------------------------------------
  private anchorStopCard(kind: string, target: string, lemma?: string): void {
    const pos = this.playback?.position ?? this.cur;
    if (!pos || !lemma) return;
    const root = this.visibleRoot();
    const sEl = this.sentenceEl(root, pos);
    const words = Array.from(sEl?.querySelectorAll<HTMLElement>('.w[data-lemma]') ?? []);
    const el = words.find((w) => w.dataset.lemma === lemma) ?? words.find((w) => (w.textContent ?? '').trim().toLowerCase() === target.toLowerCase().split(' ')[0]);
    this.openCard(pos, el ? Number(el.dataset.t) : 0, lemma, target, kind === 'phrase' ? 'phrase' : 'word', null, el ?? undefined);
  }

  private visibleRoot(): HTMLElement | undefined {
    if (this.stageVisible()) return this.stage!.el;
    return this.bandVisible() ? this.band?.el : this.panel?.el ?? this.band?.el;
  }

  private openCard(pos: Position, token: number, lemma: string, target: string, kind: 'word' | 'phrase', entryId: number | null, anchor?: HTMLElement): void {
    if (this.cardClose) { clearTimeout(this.cardClose); this.cardClose = null; }
    this.card = { lemma, word: target, pos, token, kind, entryId };
    const root = this.visibleRoot();
    for (const r of [this.panel?.el, this.band?.el, this.stage?.el]) { if (r && r !== root) { const c = r.querySelector<HTMLElement>('.card'); if (c) c.hidden = true; } }
    const cardEl = root?.querySelector<HTMLElement>('.card');
    if (!root || !cardEl) return;
    for (const r of [this.panel?.el, this.band?.el, this.stage?.el]) r?.querySelectorAll('.stop-target').forEach((e) => e.classList.remove('stop-target'));
    const el = (anchor && root.contains(anchor) ? anchor : undefined) ?? this.sentenceEl(root, pos)?.querySelector<HTMLElement>(`.w[data-t="${token}"]`) ?? undefined;
    el?.classList.add('stop-target');
    const look = this.dict?.lookup(kind === 'word' ? target : lemma) ?? (kind === 'phrase' ? this.dict?.lookupPhrase(target.split(/\s+/)) : null) ?? null;
    const entry = look?.entry;
    const here = this.hints[lemma];
    const glosses = entry?.zh ? parseGloss(entry.zh).slice(0, here ? 1 : 2) : [];
    const level = entry?.level ?? (this.phrases[sentenceKey(pos)]?.find((p) => p.lemma === lemma)?.level as string | undefined) ?? '';
    const status = vocab.words[lemma];
    const call = this.mode === 'call';
    cardEl.innerHTML = `<div class="hw"><span class="word">${esc(target)}</span>${entry?.ipa ? `<span class="ipa">${esc(entry.ipa)}</span>` : ''}<button class="quiet" data-act="say" title="Say the word">▶</button><span class="grow"></span>${level ? `<span class="lvl">${esc(level)}</span>` : ''}</div>
      <div class="zh here"${here ? '' : ' data-ai="1"'}>${here ? `<span><span class="pos">here</span>${esc(here[0])}${here[1] ? `<span class="pos"> · ${esc(here[1])}</span>` : ''}</span>` : '<span class="muted">AI 中文…</span>'}</div>
      ${glosses.length ? `<div class="zh">${glosses.map((g) => `<span>${g.pos ? `<span class="pos">${esc(g.pos)}</span>` : ''}${esc(g.zh)}</span>`).join('')}</div>` : '<div class="muted">Not in the offline dictionary.</div>'}
      <div class="en"></div>
      <div class="row"><button data-act="known" class="${status === 'known' ? 'active' : ''}">I know</button><button data-act="dontknow" class="${status === 'learning' ? 'active' : ''}">I don't know</button><button data-act="ignore">Ignore</button>
      ${call ? '<button data-act="ask">Ask in the call</button>' : `<button data-act="zh" class="${settings.ai.speakChinese ? 'active' : ''}">中文 ${settings.ai.speakChinese ? 'on' : 'off'}</button>`}<span class="grow"></span><button class="quiet" data-act="close" title="Close">✕</button></div>`;
    cardEl.hidden = false;
    // the AI's meaning in this very sentence, written live (when the video's hints do not have this word)
    if (!here && this.vb && (this.keys.anthropic || this.keys.openai)) {
      const sent = getSentence(this.vb.book, pos)?.text ?? '';
      const row = cardEl.querySelector<HTMLElement>('.zh.here');
      const job = completeStream(buildWordPrompt(target, sent), (full) => { if (row && this.card?.lemma === lemma) row.innerHTML = `<span><span class="pos">here</span>${esc(full.trim())}</span>`; });
      void job.done.then((full) => {
        const m = parseWordMeanings(full);
        if (!m) { if (row) row.innerHTML = ''; return; }
        this.hints[lemma] = m;
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
      let y = wr ? wr.bottom - rr.top + 8 : 60;
      cardEl.style.left = `${Math.max(8, Math.min(rr.width - 308, x - 150))}px`;
      if (y + 220 > rr.height && wr) y = Math.max(8, wr.top - rr.top - 8 - cardEl.offsetHeight);
      cardEl.style.top = `${y}px`;
    }
    cardEl.onclick = (ev) => {
      ev.stopPropagation();
      const act = (ev.target as HTMLElement).closest('button')?.dataset.act;
      if (!act || !this.card) return;
      const c = this.card;
      if (act === 'close') this.closeCard();
      else if (act === 'say') { const h = this.wordOut?.speak(c.word, { voiceId: this.voiceId, rate: Math.min(settings.voice.rate, 0.9) }); void h; }
      else if (act === 'known') { if (this.callStop) this.answerKnow(); else { this.controller?.markKnown(c.lemma); void this.changeStatus(c.lemma, 'known'); if (this.controller?.stopWindow) this.answerKnow(); this.closeCard(); } }
      else if (act === 'dontknow') { if (this.callStop || this.controller?.stopWindow) this.answerDontKnow(); else if (this.mode === 'tutor') { void this.changeStatus(c.lemma, 'learning'); this.engine.target = c.pos; void this.controller?.explainNow(c.kind, c.word, c.pos, null, c.lemma, undefined, undefined, true); } }
      else if (act === 'ignore') { this.controller?.markKnown(c.lemma); void this.changeStatus(c.lemma, 'ignored'); this.closeCard(); if (this.controller?.stopWindow) this.answerGoOn(); }
      else if (act === 'zh') { void store.patchSettings({ ai: { ...settings.ai, speakChinese: !settings.ai.speakChinese } }); }
      else if (act === 'ask') {
        const sent = this.vb ? getSentence(this.vb.book, c.pos)?.text ?? '' : '';
        void chrome.runtime.sendMessage({ type: 'ask', text: `In this video I just heard: "${sent}"\n\nWhat does "${c.word}" mean here? Explain it in easy spoken English in this context, then give its two Chinese meanings that fit this sentence.`, target: window.__ytcApi?.settings().target });
        this.toast('Sent to the call.');
      }
    };
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
  private closeCard(): void {
    if (this.cardClose) { clearTimeout(this.cardClose); this.cardClose = null; }
    this.card = null;
    for (const r of [this.panel?.el, this.band?.el, this.stage?.el]) {
      if (!r) continue;
      const c = r.querySelector<HTMLElement>('.card');
      if (c) c.hidden = true;
      r.querySelectorAll('.stop-target').forEach((e) => e.classList.remove('stop-target'));
    }
    if (this.stage?.el.classList.contains('card-side')) { this.stage.el.classList.remove('card-side'); this.fitPart(); }
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
        const head = e.kind === 'question' ? `You: ${esc(e.question ?? '')}` : e.kind === 'passage' ? 'The last part' : esc(e.target);
        const st = e.status === 'thinking' ? 'thinking…' : e.status === 'speaking' ? 'speaking' : e.status === 'error' ? 'error' : '';
        const zh = e.chinese ? `<div class="zh">${esc(e.chinese.split('\n')[0])}</div>` : '';
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
      say.innerHTML = live ? `<b>${last.kind === 'question' ? 'Tutor' : last.kind === 'passage' ? 'Your teacher' : esc(last.target)}</b> ${esc(shown(last.text) || 'thinking…')}` : last?.status === 'error' ? `<span class="bad">${esc(last.error ?? 'The explanation failed.')}</span>` : '';
      say.scrollTop = say.scrollHeight;
      this.stage!.el.querySelectorAll<HTMLElement>('.sayrow .hand').forEach((b) => { b.hidden = !live || this.mode !== 'tutor'; });
    }
  }

  // ---- big subtitles over the video ----------------------------------------------------------------------------
  private bandVisible(): boolean {
    if (!this.band) return false;
    return this.band.host.style.display !== 'none';
  }
  private placeBand(): void {
    const player = document.querySelector<HTMLElement>('#movie_player');
    const want = !this.stageVisible() && (extras.band === 'on' || (extras.band === 'auto' && (!!document.fullscreenElement || !!document.querySelector('ytd-watch-flexy[theater]') || !this.panel)));
    if (!player) return;
    if (!this.band) {
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
    document.documentElement.classList.toggle('dr-hide-cc', (want || this.stageVisible()) && extras.hideYtCaptions);
    if (want !== shown) { this.renderBandLine(); this.showCommandWindow(this.cmdWin); }
  }
  private renderBandLine(): void {
    const line = this.band?.el.querySelector<HTMLElement>('.line');
    if (!line || !this.vb || !this.dict || !this.cur) return;
    const cur = getSentence(this.vb.book, this.cur);
    if (!cur) return;
    line.innerHTML = renderSentence(cur.para, cur.sentence, 0, this.renderOpts());
    if (this.curWord >= 0) line.querySelector(`.w[data-t="${this.curWord}"]`)?.classList.add('cur-w');
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
    if (prev.learnerLevel !== settings.learnerLevel) this.countKnown();
    if (prev.learnerLevel !== settings.learnerLevel || prev.appearance.showHints !== settings.appearance.showHints) {
      this.render();
      if (prev.learnerLevel !== settings.learnerLevel) void this.runHintsJob();
    }
    if (prev.voice.voiceId !== settings.voice.voiceId && settings.voice.voiceId) { this.macVoice = settings.voice.voiceId; if (this.voiceKind === 'mac') this.voiceId = this.macVoice; }
    if (prev.voice.rate !== settings.voice.rate) (this.tts as { setRate?: (r: number) => void } | null)?.setRate?.(settings.voice.rate);
    this.renderHead();
    this.renderStageTop();
    this.renderQuickIfOpen();
  }

  extrasChanged(prev: store.YtExtras): void {
    this.applyLook();
    if (prev.teacherVolume !== extras.teacherVolume || prev.followVideoVolume !== extras.followVideoVolume) { const v = this.volumeOf('teacher'); this.talk?.live?.setVolume(v); this.pre?.setVolume(v); }
    if (prev.voice !== extras.voice || prev.openaiVoice !== extras.openaiVoice || prev.elevenVoice !== extras.elevenVoice || prev.azureVoice !== extras.azureVoice || prev.azureRegion !== extras.azureRegion) this.applyVoice();
    if (prev.view !== extras.view) this.applyView();
    if (prev.stopSentences !== extras.stopSentences) this.render();
    if (prev.zhLines !== extras.zhLines && extras.zhLines && this.stageVisible() && this.vb) {
      const ps = this.partKeys ? this.vb.order.filter((p) => this.partKeys!.has(sentenceKey(p))) : this.cur ? [this.cur] : [];
      this.ensureZh(ps);
      if (this.cur) this.setCurrent(this.cur);
    }
    if (prev.followAt !== extras.followAt) this.scrollToCur(true);
    if (prev.aiSentences !== extras.aiSentences && extras.aiSentences && this.source === 'rule') void this.runAiJobs();
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
    if (a?.id === 'goOn' && this.mode === 'tutor' && (this.controller?.busy || this.flow) && !this.cmdWin) { swallow(); this.byeBye(); return; }
    if (a && this.runAction(a)) swallow();
  }

  /** a shortcut's action (from a key or, on the iPhone, a button); true = it acted (the key is then swallowed) */
  private runAction(a: ShortcutAction): boolean {
    const windowOpen = !!this.cmdWin || !!this.callStop || !!this.card;
    const tutor = this.mode === 'tutor';
    if (a.when === 'window') {
      if (!windowOpen && !(tutor && this.talk)) return false;
      if (a.id === 'know') { if (this.card && !this.cmdWin && !this.callStop && !this.talk) { this.controller?.markKnown(this.card.lemma); void this.changeStatus(this.card.lemma, 'known'); this.closeCard(); } else this.answerKnow(); }
      else if (a.id === 'dontKnow') this.answerDontKnow();
      else if (a.id === 'goOn') { if (this.cmdWin || this.callStop) this.answerGoOn(); else if (this.talk) this.byeBye(); else this.closeCard(); }
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
    const lookOnly = ['listening', 'page', 'bigger', 'smaller', 'zh', 'band'];
    if (!tutor && !lookOnly.includes(a.id)) return false;
    if (a.id === 'explainSentence') this.explainSentence();
    else if (a.id === 'explainLast') this.explainLast();
    else if (a.id === 'stop') this.stopOrPlay();
    else if (a.id === 'talk') void this.callTutor();
    else if (a.id === 'listening') void store.patchExtras({ view: extras.view === 'listening' ? 'normal' : 'listening' });
    else if (a.id === 'page') { if (this.stageVisible()) this.hideStage(); else this.showStage(this.partAt(video()?.currentTime ?? 0, settings.listen.lastSecondsWindow)); }
    else if (a.id === 'bigger' || a.id === 'smaller') this.resize(a.id === 'bigger' ? 1 : -1);
    else if (a.id === 'zh') void store.patchExtras({ zhLines: !extras.zhLines });
    else if (a.id === 'band') { const on = !this.bandVisible(); void store.patchExtras({ band: on ? 'on' : 'off' }); this.toast(on ? 'Subtitles on the video: on' : 'Subtitles on the video: off'); }
    else return false;
    return true;
  }

  /**
   * A button of the iPhone app's bar (there is no keyboard): the shortcut of the same name, or one of the panel's
   * buttons. False = nothing to do now (e.g. "I know" with no window open).
   */
  action(id: string): boolean {
    if (id === 'voiceMode') { this.toggleVoiceMode(); return true; }
    if (id === 'pageAuto') { this.togglePageAuto(); return true; }
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
    document.documentElement.classList.remove('dr-panel', 'dr-panel-under', 'dr-band', 'dr-hide-cc', 'dr-stage');
    applyPageLook(false);
  }

  diag(): Record<string, unknown> {
    return {
      mode: this.mode, sentences: this.vb?.order.length ?? 0, split: this.source, view: extras.view, voice: this.voiceKind,
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
    const mac = this.mac as unknown as { state?: () => unknown } | null;
    return { kind: this.voiceKind, voiceId: this.voiceId, mac: mac?.state?.() ?? null, teacherVol: this.volumeOf('teacher'), wordVol: this.volumeOf('word'), talk: this.talk ? { chat: this.talk.chat ? { thinking: this.talk.chat.thinking, speaking: this.talk.chat.speaking, busy: this.talk.chat.busy, error: this.talk.chat.lastError, events: this.talk.chat.events.slice(-25) } : null, live: this.talk.live?.state ?? null, call: !!this.talk.call } : null, mic: this.wantsMic(), trail: this.trailLog.slice(-25), split: splitReport.slice(-30) };
  }

  debug() {
    const stage = this.stage?.el;
    return {
      layout: this.partLayout(),
      mode: this.mode, sentences: this.vb?.order.length ?? 0, state: this.playback?.state ?? null, cur: this.cur, window: this.cmdWin, card: this.card,
      transcript: this.transcript.map((e) => ({ kind: e.kind, target: e.target, status: e.status, text: e.text.slice(0, 80) })),
      spoken: (this.mac as unknown as { spoken?: { text: string }[] })?.spoken?.map((s) => s.text) ?? null,
      spokenVol: (this.mac as unknown as { spoken?: { text: string; volume?: number }[] })?.spoken?.slice(-60).map((s) => [s.text.slice(0, 60), s.volume ?? null]) ?? null,
      cloud: cloudSpoken.slice(-30),
      hints: Object.keys(this.hints).length, phrases: Object.keys(this.phrases).length, hardSentences: this.hardSentences.map((m) => m.text), callStop: this.callStop ? this.callStop.target : null,
      split: this.source, voice: this.voiceKind, view: extras.view,
      stage: stage ? { shown: this.stageVisible(), view: stage.dataset.view, part: this.partKeys ? this.partKeys.size : 0, visibleLines: Array.from(stage.querySelectorAll<HTMLElement>('.s')).filter((s) => s.offsetParent !== null).length, zhLines: stage.querySelectorAll('.zh-line').length, size: getComputedStyle(this.stage!.host).getPropertyValue('--stage-size').trim() } : null,
      talk: this.talk ? { live: this.talk.live ? this.talk.live.state : null, chat: this.talk.chat ? (this.talk.chat.thinking ? 'thinking' : this.talk.chat.speaking ? 'speaking' : 'listening') : null, log: this.talk.log.map((l) => `${l.who}: ${l.text}`), error: this.talk.error ?? null, events: this.talk.chat?.events.slice(-30) ?? null } : null,
      trail: this.trailLog.slice(-25),
      flow: this.flow ? this.flow.kind : null, quiet: this.quietUntil ? sentenceKey(this.quietUntil) : null,
    };
  }
}

function normalView(): boolean { return extras.view !== 'listening'; }

/** after an explanation a moment to talk: your setting, or always in voice mode */
function talkAfter(): boolean { return extras.talkAfterExplain || extras.voiceMode; }

/** page-wide choices while the tutor is on: YouTube's own captions always hidden, your video size */
function applyPageLook(on = !!session): void {
  const html = document.documentElement;
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
function wantedMode(): Mode | null {
  if (extras.tutorOn) return 'tutor';
  const s = window.__ytcApi?.settings();
  return s?.sendOn ? 'call' : null;
}

function refresh(): void {
  const api = window.__ytcApi;
  if (!api) return;
  const id = location.pathname === '/watch' ? api.videoId() : null;
  const mode = wantedMode();
  if (!id || !mode) { session?.dispose(); session = null; paintTutorButton(); return; }
  if (session && session.videoId !== id) { session.dispose(); session = null; }
  if (!session) { session = new Session(id, mode); window.__drDebug = () => session?.debug(); void session.start(); }
  else session.setMode(mode);
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
  // one voice at a time: the website call goes off when the tutor comes on
  if (on) await chrome.storage.local.set({ sendOn: false });
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
  [settings, extras, vocab] = await Promise.all([store.getSettings(), store.getExtras(), store.getVocab()]);
  const mig = store.migrateExtras(extras);
  if (mig) extras = await store.patchExtras(mig);
  window.__ytcDream = {
    owns: () => !!session && session.owns(),
    wantsMic: () => !!session && session.wantsMic(),
    heard: (text, final, key) => (session ? session.heard(text, final, key) : false),
    decorateBar: (bar) => {
      if (bar.querySelector('#yt2c-b-tutor')) return;
      const b = document.createElement('button');
      b.id = 'yt2c-b-tutor';
      b.style.cssText = 'border:0;border-radius:14px;padding:6px 12px;font:inherit;cursor:pointer;color:#fff;background:' + RED;
      b.onclick = () => void setTutor(!extras.tutorOn);
      const claude = bar.querySelector('#yt2c-b-claude');
      if (claude && claude.nextSibling) bar.insertBefore(b, claude.nextSibling); else bar.appendChild(b);
      tutorBtn = b;
      paintTutorButton();
    },
    callChanged: () => { if (window.__ytcApi?.settings().sendOn && extras.tutorOn) void setTutor(false); else refresh(); },
    diag: () => (session ? session.diag() : { mode: 'off', on: extras.tutorOn }),
    action: (id) => {
      if (id === 'tutor') { if (location.pathname !== '/watch') return false; void setTutor(!extras.tutorOn); return true; }
      return session ? session.action(id) : false;
    },
  };
  const bar = document.getElementById('yt2c-bar');
  if (bar) window.__ytcDream.decorateBar(bar);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (BACKUP_PARTS.some((k) => ch[k])) backupSoon();
    if (ch[store.STORAGE_KEYS.settings]) { const prev = settings; settings = store.mergeSettings(ch[store.STORAGE_KEYS.settings].newValue); session?.settingsChanged(prev); }
    if (ch[store.STORAGE_KEYS.extras]) { const prev = extras; extras = { ...store.DEFAULT_EXTRAS, ...ch[store.STORAGE_KEYS.extras].newValue }; session?.extrasChanged(prev); refresh(); }
    if (ch[store.STORAGE_KEYS.vocab]) { vocab = { words: { ...(ch[store.STORAGE_KEYS.vocab].newValue?.words ?? {}) }, marked: {} }; session?.countKnown(); }
    if (ch[store.STORAGE_KEYS.keys]) session?.keysChanged({ ...(ch[store.STORAGE_KEYS.keys].newValue ?? {}) });
    if (ch.drAzureVoices) void session?.loadAzureAvail().then(() => session?.renderQuickIfOpen());
    if (ch.sendOn || ch.target) setTimeout(refresh, 50); // youtube.js reads the same change first
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
    for (const id of ['dr-panel-host', 'dr-band-host', 'dr-stage-host', 'dr-page-style', 'yt2c-overlay', 'yt2c-bar']) document.getElementById(id)?.remove();
    document.documentElement.classList.remove('dr-panel', 'dr-band', 'dr-hide-cc', 'dr-stage', 'dr-hide-cc-always', 'dr-vsize');
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
