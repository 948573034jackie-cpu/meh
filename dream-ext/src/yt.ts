/**
 * Dream Tutor on YouTube (content script, runs after lib.js and youtube.js in the same isolated world).
 *
 * Two ways to learn with a video, never both at once (one voice at a time):
 *  - "My tutor" (your own API key): Dream Read's listening teacher reads the video. The video stops right after
 *    every word, phrase or slang above your level (and every yellow "learning" word), the dictionary card shows,
 *    the word is said 3 times, a 5-second commands window opens (I know / I don't know / Go on; nothing you say
 *    there is sent to the AI), the tutor explains in easy English with the two Chinese meanings at the end in a
 *    Chinese voice, a second window, then the video goes back to the start of the interrupted sentence.
 *  - "ChatGPT" / "Claude" (the website call, youtube.js): unchanged. The Dream panel still shows the subtitles
 *    with hard words highlighted and their Chinese meaning; tapping a word opens its card and can send it to the
 *    call. Stops at hard words in the call are an option (silent card, the word goes to the call).
 */
import css from './dream.css';
import type { Book, Position, CefrLevel } from '@core/model';
import { sentenceKey } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { Settings, VocabState, WordStatus } from '@shared/settings';
import type { PhraseHit, ExplainRequest } from '@shared/api';
import { Playback, type PlaybackState } from '@core/listen/playback';
import { ListenController, type TranscriptEntry, type CommandWindow, type ChapterPhrase } from '@core/listen/controller';
import { getEngine, useFakeEngine, defaultVoiceFor, chineseVoiceId } from '@core/tts/registry';
import type { TtsEngine } from '@core/tts/engine';
import { getSentence } from '@core/nav';
import { detectNames } from '@core/dict/names';
import { parseGloss, looksLikeFreeCombination } from '@core/dict/dictionary';
import { detectCommand } from '@core/voice/commands';
import { collectHardWords, batchHardWords, buildHintsPrompt, parseHints, chunkChapter, phraseQuota, buildPhrasesPrompt, parsePhrases, validatePhrases, mapPhraseHits, chapterText, type HintMap } from '@core/ai/hints';
import { renderChapter, renderSentence, restyleLemma } from '../vendor/renderer/render';
import { hintText } from '../vendor/renderer/hints';
import { buildVideoBook, type VideoBook, type TimedSentence } from './video-book';
import { VideoEngine } from './video-engine';
import { explain as aiExplain, complete, getDictionary } from './ai-client';
import * as store from './store';
import { clock } from './vocab';

interface YtcInfo { title: string; channel?: string; url: string; cues: unknown[]; errors: string[]; source: string | null }
interface YtcApi {
  loadTranscript(): Promise<YtcInfo>;
  video(): HTMLVideoElement | null;
  videoId(): string | null;
  isAd(): boolean;
  settings(): { sendOn: boolean; target: string; voiceOn: boolean };
  buildSentences(cues: unknown[]): TimedSentence[];
  setBarStatus(text: string, bad?: boolean): void;
}
interface DreamHook {
  /** the Dream Tutor handles the video now: youtube.js leaves pauses, plays and voice commands alone */
  owns(): boolean;
  /** something the microphone heard; true = handled here */
  heard(text: string, final: boolean, key?: string): boolean;
  /** youtube.js built its bar: add the Tutor button */
  decorateBar(bar: HTMLElement): void;
  /** ChatGPT or Claude was turned on in youtube.js: the tutor goes off */
  callChanged(): void;
}
declare global { interface Window { __ytcApi?: YtcApi; __ytcDream?: DreamHook; __drDebug?: unknown } }

const GREEN = '#1e8e3e', RED = '#d93025';
const E2E = () => !!extras.fakeVoice;

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
    html.dr-band.dr-hide-cc .ytp-caption-window-container { display: none !important; }
    #dr-band-host { position: absolute; inset: 0; pointer-events: none; z-index: 61; }
  `;
  (document.head || document.documentElement).appendChild(st);
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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------------------------------------------
// one video
// ---------------------------------------------------------------------------------------------------------------
type Mode = 'tutor' | 'call';

class Session {
  readonly videoId: string;
  mode: Mode;
  private vb: VideoBook | null = null;
  private dict: Dictionary | null = null;
  private names = new Set<string>();
  private hints: HintMap = {};
  private phrases: Record<string, PhraseHit[]> = {};
  private engine: VideoEngine;
  private tts: TtsEngine | null = null;
  private voiceId = '';
  private zhVoice: string | null = null;
  private playback: Playback | null = null;
  private controller: ListenController | null = null;
  private disposed = false;
  private offs: (() => void)[] = [];
  private panel: { host: HTMLElement; root: ShadowRoot; el: HTMLElement } | null = null;
  private band: { host: HTMLElement; root: ShadowRoot; el: HTMLElement } | null = null;
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
  private talkOn = false;
  private lastAd = false;

  constructor(videoId: string, mode: Mode) {
    this.videoId = videoId;
    this.mode = mode;
    this.engine = new VideoEngine(() => (window.__ytcApi?.isAd() ? null : video()), () => this.vb);
  }

  get book(): Book | null { return this.vb?.book ?? null; }
  /** youtube.js must leave the video alone */
  owns(): boolean { return !this.disposed && (this.mode === 'tutor' || !!this.callStop); }

  async start(): Promise<void> {
    pageStyle();
    this.mountPanel();
    this.setStatus('Reading the subtitles…');
    let info: YtcInfo;
    try {
      [info, this.dict] = await Promise.all([window.__ytcApi!.loadTranscript(), getDictionary()]);
    } catch (e) { this.setStatus(`Could not start: ${(e as Error).message}`, true); return; }
    if (this.disposed) return;
    const sentences = info.cues.length ? window.__ytcApi!.buildSentences(info.cues) : [];
    if (!sentences.length) {
      this.setStatus('No subtitles could be read for this video. Turn on CC in the player, or load a subtitle file (.srt / .vtt) in the extension window.', true);
      this.renderEmpty('No subtitles yet. The Dream Tutor needs the video’s subtitles.');
      return;
    }
    this.vb = buildVideoBook({ id: this.videoId, title: info.title || document.title.replace(/ - YouTube$/, ''), channel: info.channel }, sentences);
    const names = detectNames(this.vb.book, this.dict!);
    this.vb.book.names = names;
    this.names = new Set(names);
    const cached = await store.getVideoHints(this.videoId).catch(() => null);
    if (cached && cached.level === settings.learnerLevel) { this.hints = cached.hints; this.phrases = cached.phrases as Record<string, PhraseHit[]>; }
    await this.prepareVoices();
    if (this.disposed) return;
    this.render();
    this.setupController();
    this.listenVideo();
    this.followTimer = setInterval(() => this.follow(), 150);
    // tests only (the silent test voice is on): what the tutor is doing, readable from the page
    if (E2E()) { const t = setInterval(() => { if (this.disposed) clearInterval(t); else document.documentElement.dataset.drDebug = JSON.stringify(this.debug()); }, 150); }
    const n = this.vb.order.length;
    this.setStatus(`${n} sentences · ${info.source ?? 'subtitles'}${this.mode === 'tutor' ? ` · stops at words above ${settings.learnerLevel}` : ''}`);
    if (this.mode === 'tutor') {
      const v = video();
      if (v && !v.paused) { this.engine.resumeHere = true; this.playback!.play(this.vb.positionAt(v.currentTime) ?? undefined); }
      else if (v) this.playback!.seek(this.vb.positionAt(v.currentTime) ?? this.vb.order[0]);
      void this.checkKey();
    }
    void this.runHintsJob();
  }

  private async prepareVoices(): Promise<void> {
    if (E2E()) useFakeEngine(2);
    this.tts = getEngine('webspeech');
    this.voiceId = settings.voice.voiceId || (await defaultVoiceFor('webspeech').catch(() => ''));
    this.zhVoice = await chineseVoiceId().catch(() => null);
  }

  private async checkKey(): Promise<void> {
    const keys = await store.getKeys();
    if (!keys[settings.ai.provider]) this.toast(`Add your ${settings.ai.provider === 'anthropic' ? 'Claude (Anthropic)' : 'OpenAI'} API key in ⚙ settings, so the tutor can explain.`, 9000);
  }

  // ---- the teacher ------------------------------------------------------------------------------------------
  private setupController(): void {
    const vb = this.vb!;
    const start = vb.order[0];
    this.playback = new Playback(vb.book, { engine: () => this.engine, voice: () => ({ voiceId: this.voiceId, rate: settings.voice.rate }), pauseMs: () => 0 }, start);
    const tts = () => this.tts!;
    this.controller = new ListenController(this.playback, {
      book: vb.book, dict: this.dict!, names: this.names,
      settings: () => settings, vocab: () => vocab, marked: () => [],
      engine: tts, explainEngine: tts, zhEngine: tts,
      voice: () => ({ voiceId: this.voiceId, rate: settings.voice.rate }),
      explainVoice: () => ({ voiceId: settings.voice.explainVoiceId || this.voiceId, rate: Math.min(settings.voice.rate, 1.2) }),
      zhVoiceId: () => (settings.ai.speakChinese ? this.zhVoice : null),
      contextZh: (lemma) => this.hints[lemma],
      explain: (req, onDelta) => { (window as unknown as { __drRequests?: ExplainRequest[] }).__drRequests?.push(structuredClone(req)); return aiExplain(req, onDelta); },
      mode: () => 'listening',
      onCommandWindow: (w) => this.showCommandWindow(w),
      onPauseWindow: (open) => { this.windowOpen = open; },
      onStopTarget: (t) => { if (!t) this.closeCardSoon(); else this.anchorStopCard(t.kind, t.target, t.lemma); },
      onTranscript: (e) => this.onTranscript(e),
      onMarkLearning: (lemma) => { if (!vocab.words[lemma]) void this.changeStatus(lemma, 'learning'); },
      onBudget: (daily, monthly) => { if (settings.ai.dailyWarnUsd > 0 && daily >= settings.ai.dailyWarnUsd) this.toast(`AI spending today: $${daily.toFixed(2)} (this month $${monthly.toFixed(2)})`); },
      chapterPhrases: (pos) => (this.phrases[sentenceKey(pos)] as unknown as ChapterPhrase[] | undefined),
    });
    this.controller.enabled = this.mode === 'tutor';
    const pb = this.playback;
    this.offs.push(
      pb.on('sentence', (pos) => { this.engine.target = pos; this.setCurrent(pos); }),
      pb.on('word', (pos, ti) => this.setWord(pos, ti)),
      pb.on('state', (st) => this.onState(st)),
      pb.on('error', (e) => this.toast(e.message, 8000)),
      pb.on('finished', () => this.toast('End of the video.')),
    );
  }

  private onState(st: PlaybackState): void {
    // a stop at the end of a sentence: Playback waited for the sentence to end, the video plays on unless held here
    if (st === 'explaining') this.engine.hold();
  }

  /** the learner switched between the tutor and the website call */
  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (!this.controller || !this.playback || !this.vb) return;
    this.controller.enabled = mode === 'tutor';
    if (mode === 'call') { this.controller.skip(); this.engine.target = null; this.playback.stop(); this.tts?.cancelAll(); }
    else {
      const v = video();
      if (v && !v.paused) { this.engine.resumeHere = true; this.playback.play(this.vb.positionAt(v.currentTime) ?? undefined); }
      void this.checkKey();
    }
    this.renderHead();
  }

  // ---- the learner uses YouTube's own controls ----------------------------------------------------------------
  private listenVideo(): void {
    const v = video();
    if (!v) return;
    const onPlay = () => {
      if (this.mode !== 'tutor' || this.engine.isOwn('play') || window.__ytcApi?.isAd()) return;
      const pb = this.playback!, c = this.controller!;
      if (pb.state === 'playing') return;
      if (c.busy || pb.state === 'explaining') c.skip();
      this.engine.resumeHere = true;
      pb.play(this.vb!.positionAt(v.currentTime) ?? undefined);
    };
    const onPause = () => {
      if (this.mode !== 'tutor' || this.engine.isOwn('pause') || v.ended || window.__ytcApi?.isAd()) return;
      const pb = this.playback!, c = this.controller!;
      setTimeout(() => {
        if (!v.paused || v.seeking || this.disposed || this.mode !== 'tutor') return;
        if (pb.state !== 'playing') return; // already stopped (an explanation, a stop)
        // you stopped the video: explain the last part (YouTube rule), or just pause
        if (extras.explainOnStop) void c.explainLast(settings.listen.lastSecondsWindow);
        else pb.pause();
      }, 120);
    };
    const onSeeking = () => {
      if (this.mode !== 'tutor' || this.engine.isOwn('seek') || window.__ytcApi?.isAd()) return;
      const pb = this.playback!;
      const pos = this.vb!.positionAt(v.currentTime);
      if (!pos) return;
      if (this.controller!.busy) this.controller!.skip();
      if (!v.paused) { this.engine.resumeHere = true; pb.play(pos); } else pb.seek(pos);
    };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeking', onSeeking);
    this.offs.push(() => { v.removeEventListener('play', onPlay); v.removeEventListener('pause', onPause); v.removeEventListener('seeking', onSeeking); });
  }

  /** the panel follows the video when the teacher is not reading it (call mode, ads, paused) */
  private follow(): void {
    if (this.disposed || !this.vb) return;
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
    const reading = this.mode === 'tutor' && this.playback && this.playback.state !== 'idle' && this.playback.state !== 'paused';
    this.placeBand();
    if (reading) return;
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
    const l = c.lastExplained;
    if (l?.lemma) { c.markKnown(l.lemma); void this.changeStatus(l.lemma, 'known'); if (this.card?.lemma === l.lemma) this.closeCard(); }
    if (!c.answerWindow('know')) c.continueNow();
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
    if (!c.answerWindow('bye')) c.continueNow();
  }
  /** "hi bro" / Shift+E: explain the last part */
  explainLast(): void {
    if (this.mode !== 'tutor' || !this.controller) return;
    void this.controller.explainLast(settings.listen.lastSecondsWindow);
  }
  /** "shut up": the tutor stops talking, the reading goes on from the start of the sentence */
  shutUp(): void {
    if (this.callStop) { this.callStop.resolve?.('bye'); return; }
    this.controller?.skip();
    this.tts?.cancelAll();
  }

  /** recognition results already acted on (a result grows while you speak; it acts once) */
  private acted = new Set<string>();
  heard(text: string, final: boolean, key?: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (key && this.acted.has(key)) return true;
    const act = (fn: () => void) => { if (key) { this.acted.add(key); if (this.acted.size > 300) this.acted.clear(); } fn(); };
    const lower = t.toLowerCase();
    const inWindow = this.windowOpen || !!this.cmdWin || !!this.callStop;
    if (this.mode !== 'tutor' && !this.callStop) return false; // call mode: youtube.js handles "hi bro" / "shut up"
    if (/\bshut\s*up\b/.test(lower)) { act(() => this.shutUp()); return true; }
    if (/\b(hi|hey|high)\s*(bro|bruh|brah|bra)\b/.test(lower)) { if (!this.callStop) act(() => this.explainLast()); return true; }
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
    const pos = this.playback?.position ?? this.cur ?? this.vb.order[0];
    if (this.mode === 'call') { void chrome.runtime.sendMessage({ type: 'ask', text: question, target: window.__ytcApi?.settings().target }); this.toast('Sent to the call.'); return; }
    const sent = getSentence(this.vb.book, pos)?.text ?? '';
    void c.explainNow('question', sent, pos, null, undefined, question, undefined, undefined, spoken);
  }

  // ---- vocabulary ----------------------------------------------------------------------------------------------
  async changeStatus(lemma: string, status: WordStatus | null): Promise<void> {
    if (status) vocab.words[lemma] = status; else delete vocab.words[lemma];
    await store.setWordStatus(lemma, status);
    const hint = !status && this.dict && settings.appearance.showHints !== false ? (this.hints[lemma]?.[0] || hintText(this.dict.lookup(lemma)?.entry.zh ?? '')) : undefined;
    for (const r of [this.panel?.el, this.band?.el]) if (r) restyleLemma(r, lemma, status, settings.learnerLevel, hint);
  }

  private onTranscript(e: TranscriptEntry): void {
    const i = this.transcript.findIndex((x) => x.id === e.id);
    if (i >= 0) this.transcript[i] = e; else this.transcript = [...this.transcript.slice(-30), e];
    this.renderTranscript();
    if (this.card && this.card.entryId === null && (e.kind === 'word' || e.kind === 'phrase') && e.status === 'thinking') this.card.entryId = e.id;
    if (this.card && this.card.entryId === e.id) this.updateCardExplain(e);
    // every explained word or phrase goes into My Vocabulary, with its sentence, explanation and where in the video
    if (e.lemma && (e.kind === 'word' || e.kind === 'phrase') && e.status === 'done' && e.text && !this.saved.has(e.id) && this.vb) {
      this.saved.add(e.id);
      const t = e.position ? this.vb.timingOf(e.position) : null;
      void store.upsertEntry({ lemma: e.lemma, word: e.target, sentence: e.sentence, explanation: e.text, chinese: e.chinese ?? (this.hints[e.lemma]?.join('，') ?? ''), bookId: this.vb.book.id, bookTitle: this.vb.book.title, chapter: t ? clock(t.start) : '', position: e.position, level: e.level as CefrLevel | undefined, again: e.again }).catch(() => undefined);
    }
    this.renderBandSay();
  }

  // ---- background job: Chinese meanings in context + the AI's hard phrases (your key, cheap model, once per video) ----
  private async runHintsJob(): Promise<void> {
    const keys = await store.getKeys().catch(() => ({} as store.Keys));
    if (!keys[settings.ai.provider] || !this.vb || !this.dict) return;
    const cached = await store.getVideoHints(this.videoId).catch(() => null);
    if (cached && cached.level === settings.learnerLevel) return;
    const book = this.vb.book;
    const known = new Set(Object.entries(vocab.words).filter(([, s]) => s === 'known' || s === 'ignored').map(([l]) => l));
    const hints: HintMap = {};
    try {
      for (const batch of batchHardWords(collectHardWords(book, 0, this.dict, settings.learnerLevel, this.names, known))) {
        if (this.disposed) return;
        Object.assign(hints, parseHints(await complete(buildHintsPrompt(batch, { title: book.title, chapter: 'YouTube video', level: settings.learnerLevel }))));
        this.hints = { ...this.hints, ...hints };
      }
      const chunks = chunkChapter(book, 0);
      const quota = phraseQuota(chunks);
      const items = [];
      for (let i = 0; i < chunks.length; i++) {
        if (this.disposed) return;
        const raw = parsePhrases(await complete(buildPhrasesPrompt(chunks[i], { title: book.title, chapter: '', level: settings.learnerLevel, max: quota[i], part: [i + 1, chunks.length] })));
        items.push(...validatePhrases(raw, chapterText(book, 0), { max: quota[i], isFree: (w, zh) => looksLikeFreeCombination(this.dict!, w, zh) }));
      }
      this.phrases = mapPhraseHits(book, 0, items, (w) => this.dict!.lemmaOf(w));
      await store.setVideoHints(this.videoId, { version: store.HINTS_VERSION, level: settings.learnerLevel, hints: this.hints, phrases: this.phrases });
      if (!this.disposed) { this.render(); this.setStatus(`${this.statusText.split(' · AI')[0]} · AI meanings ready`); }
    } catch (e) {
      if (!this.disposed) this.setStatus(`${this.statusText} · AI meanings: ${(e as Error).message}`);
    }
  }

  // =============================================================================================================
  // the screen
  // =============================================================================================================
  private mountPanel(): void {
    if (!extras.panel) return;
    const sec = document.querySelector('#secondary');
    if (!sec) { setTimeout(() => { if (!this.disposed && !this.panel) this.mountPanel(); }, 800); return; }
    const { host, root } = makeHost('dr-panel-host');
    const el = document.createElement('div');
    el.className = 'panel';
    el.innerHTML = `<div class="head"></div><div class="status"></div><div class="lines"><div class="doc-inner"></div></div><div class="transcript"></div>
      <form class="ask"><input type="text" placeholder="Type a question (pronunciation does not matter)" aria-label="Question for the tutor"><button type="submit">Ask</button></form>
      <div class="cmd" hidden></div><div class="card" hidden></div><div class="toast" hidden></div>`;
    root.appendChild(el);
    sec.prepend(host);
    document.documentElement.classList.add('dr-panel');
    this.panel = { host, root, el };
    this.applyLook();
    this.renderHead();
    const lines = el.querySelector<HTMLElement>('.lines')!;
    lines.addEventListener('wheel', () => { this.userScrollAt = Date.now(); }, { passive: true });
    lines.addEventListener('touchmove', () => { this.userScrollAt = Date.now(); }, { passive: true });
    this.wireWords(lines);
    el.querySelector('form.ask')!.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const inp = el.querySelector<HTMLInputElement>('form.ask input')!;
      const q = inp.value.trim();
      if (!q) return;
      inp.value = '';
      this.ask(q);
    });
    // typing in our boxes must not reach YouTube's shortcuts (k = pause, f = full screen, …)
    for (const ev of ['keydown', 'keyup', 'keypress']) el.addEventListener(ev, (e) => { if ((e.target as HTMLElement).tagName === 'INPUT') e.stopPropagation(); });
  }

  private applyLook(): void {
    for (const h of [this.panel?.host, this.band?.host]) {
      if (!h) continue;
      h.dataset.hints = settings.appearance.showHints !== false ? '1' : '0';
      h.style.setProperty('--reader-size', `${Math.max(14, Math.min(28, settings.appearance.fontSizePx || 19))}px`);
      h.style.setProperty('--subtitle-size', `${Math.max(18, Math.min(40, settings.appearance.subtitleSizePx || 26))}px`);
      h.style.setProperty('--explain-size', `${Math.max(12, Math.min(20, settings.appearance.explainSizePx || 14))}px`);
    }
  }

  renderHead(): void {
    const head = this.panel?.el.querySelector<HTMLElement>('.head');
    if (!head) return;
    const tutor = this.mode === 'tutor';
    const callName = window.__ytcApi?.settings().target === 'chatgpt' ? 'ChatGPT call' : 'Claude call';
    head.innerHTML = `<span class="brand">Dream</span><span class="mode ${tutor ? 'tutor' : ''}">${tutor ? 'My tutor' : esc(callName)}</span><span class="grow"></span>
      ${tutor ? `<button data-act="last" title="Explain what was just said (Shift+E, or say “hi bro”)">Explain last ${settings.listen.lastSecondsWindow} s</button>` : ''}
      <button data-act="zh" aria-pressed="${settings.ai.speakChinese}" title="Say the two Chinese meanings at the end of explanations">中文 ${settings.ai.speakChinese ? 'on' : 'off'}</button>
      <button data-act="hints" aria-pressed="${settings.appearance.showHints !== false}" title="Chinese meaning under hard words">Hints</button>
      ${tutor ? `<button data-act="talk" aria-pressed="${this.talkOn}" title="Talk to the tutor while the video is stopped (the microphone must be on in the extension window)">🎙</button>` : ''}
      <button data-act="vocab" title="My Vocabulary and progress">📒</button><button data-act="settings" title="Dream Tutor settings: API key, level, styles, voices">⚙</button>`;
    head.onclick = (ev) => {
      const b = (ev.target as HTMLElement).closest('button');
      const act = b?.dataset.act;
      if (!act) return;
      if (act === 'last') this.explainLast();
      else if (act === 'zh') void store.patchSettings({ ai: { ...settings.ai, speakChinese: !settings.ai.speakChinese } });
      else if (act === 'hints') void store.patchSettings({ appearance: { ...settings.appearance, showHints: settings.appearance.showHints === false } });
      else if (act === 'talk') { this.talkOn = !this.talkOn; this.renderHead(); this.toast(this.talkOn ? 'Talk to the tutor: stop the video and ask your question out loud.' : 'Talking to the tutor is off (you can still type).'); }
      else if (act === 'vocab') void chrome.runtime.sendMessage({ type: 'dream-open', page: 'vocab' });
      else if (act === 'settings') void chrome.runtime.sendMessage({ type: 'dream-open', page: 'options' });
    };
  }

  private setStatus(text: string, bad = false): void {
    this.statusText = text;
    const el = this.panel?.el.querySelector<HTMLElement>('.status');
    if (el) { el.textContent = text; el.classList.toggle('bad', bad); }
  }

  private renderEmpty(msg: string): void {
    const doc = this.panel?.el.querySelector<HTMLElement>('.doc-inner');
    if (doc) doc.innerHTML = `<div class="empty">${esc(msg)}</div>`;
  }

  private renderOpts() {
    return {
      dict: this.dict!, names: this.names, learner: settings.learnerLevel, vocab: vocab.words, marked: [],
      hints: settings.appearance.showHints !== false,
      hintOverrides: Object.fromEntries(Object.entries(this.hints).map(([l, v]) => [l, v[0]])),
      phrases: (key: string) => this.phrases[key],
    };
  }

  /** the whole video as lines (Dream Read's renderer: one span per sentence and per word, highlights, hints) */
  render(): void {
    if (!this.vb || !this.dict) return;
    const doc = this.panel?.el.querySelector<HTMLElement>('.doc-inner');
    if (doc) {
      const { html } = renderChapter(this.vb.book.chapters[0], this.renderOpts());
      doc.innerHTML = html;
      if (this.cur) { const c = this.cur; this.cur = null; this.setCurrent(c); }
    }
    this.renderBandLine();
  }

  private sentenceEl(root: HTMLElement | undefined, pos: Position): HTMLElement | null {
    return root?.querySelector<HTMLElement>(`.s[data-key="${sentenceKey(pos)}"]`) ?? null;
  }

  private setCurrent(pos: Position): void {
    const prev = this.cur;
    this.cur = pos;
    this.curWord = -1;
    const root = this.panel?.el;
    if (root) {
      const back = prev && this.vb && this.vb.order.findIndex((p) => sentenceKey(p) === sentenceKey(pos)) < this.vb.order.findIndex((p) => sentenceKey(p) === sentenceKey(prev));
      root.querySelectorAll('.s.cur').forEach((e) => { e.classList.remove('cur'); e.classList.add('past'); });
      root.querySelectorAll('.w.cur-w').forEach((e) => e.classList.remove('cur-w'));
      if (back || !prev) {
        const keys = new Set<string>();
        for (const p of this.vb!.order) { if (sentenceKey(p) === sentenceKey(pos)) break; keys.add(sentenceKey(p)); }
        root.querySelectorAll<HTMLElement>('.s').forEach((e) => e.classList.toggle('past', keys.has(e.dataset.key ?? '')));
      }
      const el = this.sentenceEl(root, pos);
      if (el) {
        el.classList.remove('past');
        el.classList.add('cur');
        if (Date.now() - this.userScrollAt > 4000) {
          const lines = root.querySelector<HTMLElement>('.lines')!;
          const top = el.offsetTop - lines.clientHeight * 0.33;
          lines.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        }
      }
    }
    this.renderBandLine();
  }

  private setWord(pos: Position, ti: number): void {
    this.curWord = ti;
    for (const root of [this.panel?.el, this.band?.el]) {
      if (!root) continue;
      root.querySelectorAll('.w.cur-w').forEach((e) => e.classList.remove('cur-w'));
      if (ti >= 0) this.sentenceEl(root, pos)?.querySelector(`.w[data-t="${ti}"]`)?.classList.add('cur-w');
    }
  }

  /** clicks on the text: a word = explain it (card + voice), double click = I know, a sentence = go there */
  private wireWords(container: HTMLElement): void {
    let clickTimer: ReturnType<typeof setTimeout> | null = null;
    container.addEventListener('click', (ev) => {
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

  private seekTo(pos: Position): void {
    const t = this.vb?.timingOf(pos), v = video();
    if (!t || !v) return;
    if (this.mode === 'tutor' && this.playback) {
      if (this.controller?.busy) this.controller.skip();
      this.playback.seek(pos);
      if (v.paused) this.playback.play(pos); // the engine jumps to the sentence start
    } else { v.currentTime = Math.max(0, t.start - 0.15); this.setCurrent(pos); }
  }

  private tapWord(w: HTMLElement, pos: Position): void {
    if (!this.vb) return;
    const ti = Number(w.dataset.t);
    const lemma = w.dataset.lemma!;
    const sent = getSentence(this.vb.book, pos);
    const target = w.textContent?.trim() ?? lemma;
    this.openCard(pos, ti, lemma, target, 'word', null, w);
    if (this.mode === 'tutor' && this.controller) {
      const entry = this.dict?.lookup(target)?.entry;
      void this.controller.explainNow('word', target, pos, entry ? { ipa: entry.ipa, zh: entry.zh.split('\n')[0], level: entry.level } : null, lemma, undefined, undefined, undefined, undefined);
      void sent;
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
    return this.bandVisible() ? this.band?.el : this.panel?.el ?? this.band?.el;
  }

  private openCard(pos: Position, token: number, lemma: string, target: string, kind: 'word' | 'phrase', entryId: number | null, anchor?: HTMLElement): void {
    if (this.cardClose) { clearTimeout(this.cardClose); this.cardClose = null; }
    this.card = { lemma, word: target, pos, token, kind, entryId };
    const root = this.visibleRoot();
    const cardEl = root?.querySelector<HTMLElement>('.card');
    if (!root || !cardEl) return;
    for (const r of [this.panel?.el, this.band?.el]) r?.querySelectorAll('.stop-target').forEach((e) => e.classList.remove('stop-target'));
    const el = anchor ?? this.sentenceEl(root, pos)?.querySelector<HTMLElement>(`.w[data-t="${token}"]`) ?? undefined;
    el?.classList.add('stop-target');
    const look = this.dict?.lookup(kind === 'word' ? target : lemma) ?? (kind === 'phrase' ? this.dict?.lookupPhrase(target.split(/\s+/)) : null) ?? null;
    const entry = look?.entry;
    const here = this.hints[lemma];
    const glosses = entry?.zh ? parseGloss(entry.zh).slice(0, here ? 1 : 2) : [];
    const level = entry?.level ?? (this.phrases[sentenceKey(pos)]?.find((p) => p.lemma === lemma)?.level as string | undefined) ?? '';
    const status = vocab.words[lemma];
    const call = this.mode === 'call';
    cardEl.innerHTML = `<div class="hw"><span class="word">${esc(target)}</span>${entry?.ipa ? `<span class="ipa">${esc(entry.ipa)}</span>` : ''}<button class="quiet" data-act="say" title="Say the word">▶</button><span class="grow"></span>${level ? `<span class="lvl">${esc(level)}</span>` : ''}</div>
      ${here ? `<div class="zh here"><span><span class="pos">here</span>${esc(here[0])}${here[1] ? `<span class="pos"> · ${esc(here[1])}</span>` : ''}</span></div>` : ''}
      ${glosses.length ? `<div class="zh">${glosses.map((g) => `<span>${g.pos ? `<span class="pos">${esc(g.pos)}</span>` : ''}${esc(g.zh)}</span>`).join('')}</div>` : '<div class="muted">Not in the offline dictionary.</div>'}
      <div class="en"></div>
      <div class="row"><button data-act="known" class="${status === 'known' ? 'active' : ''}">I know</button><button data-act="dontknow" class="${status === 'learning' ? 'active' : ''}">I don't know</button><button data-act="ignore">Ignore</button>
      ${call ? '<button data-act="ask">Ask in the call</button>' : `<button data-act="zh" class="${settings.ai.speakChinese ? 'active' : ''}">中文 ${settings.ai.speakChinese ? 'on' : 'off'}</button>`}<span class="grow"></span><button class="quiet" data-act="close" title="Close">✕</button></div>`;
    cardEl.hidden = false;
    // under the word, inside the visible area
    const rr = root.getBoundingClientRect();
    const wr = el?.getBoundingClientRect();
    const x = wr ? wr.left - rr.left + wr.width / 2 : rr.width / 2;
    let y = wr ? wr.bottom - rr.top + 8 : 60;
    cardEl.style.left = `${Math.max(8, Math.min(rr.width - 308, x - 150))}px`;
    if (y + 220 > rr.height && wr) y = Math.max(8, wr.top - rr.top - 8 - cardEl.offsetHeight);
    cardEl.style.top = `${y}px`;
    cardEl.onclick = (ev) => {
      ev.stopPropagation();
      const act = (ev.target as HTMLElement).closest('button')?.dataset.act;
      if (!act || !this.card) return;
      const c = this.card;
      if (act === 'close') this.closeCard();
      else if (act === 'say') { const h = this.tts?.speak(c.word, { voiceId: this.voiceId, rate: Math.min(settings.voice.rate, 0.9) }); void h; }
      else if (act === 'known') { if (this.callStop) this.answerKnow(); else { this.controller?.markKnown(c.lemma); void this.changeStatus(c.lemma, 'known'); if (this.controller?.stopWindow) this.answerKnow(); this.closeCard(); } }
      else if (act === 'dontknow') { if (this.callStop || this.controller?.stopWindow) this.answerDontKnow(); else if (this.mode === 'tutor') { void this.changeStatus(c.lemma, 'learning'); void this.controller?.explainNow(c.kind, c.word, c.pos, null, c.lemma, undefined, undefined, true); } }
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
    else en.textContent = e.text ? firstSentences(e.text, 180) : e.status === 'thinking' ? 'Explaining…' : '';
  }

  private closeCardSoon(): void {
    if (this.cardClose) clearTimeout(this.cardClose);
    this.cardClose = setTimeout(() => this.closeCard(), 1500);
  }
  private closeCard(): void {
    if (this.cardClose) { clearTimeout(this.cardClose); this.cardClose = null; }
    this.card = null;
    for (const r of [this.panel?.el, this.band?.el]) {
      if (!r) continue;
      const c = r.querySelector<HTMLElement>('.card');
      if (c) c.hidden = true;
      r.querySelectorAll('.stop-target').forEach((e) => e.classList.remove('stop-target'));
    }
  }

  // ---- the commands window ---------------------------------------------------------------------------------------
  private showCommandWindow(w: CommandWindow | null): void {
    this.cmdWin = w;
    for (const r of [this.panel?.el, this.band?.el]) {
      const el = r?.querySelector<HTMLElement>('.cmd');
      if (!el) continue;
      if (!w || (r === this.panel?.el && this.bandVisible()) || (r === this.band?.el && !this.bandVisible())) { el.hidden = true; el.innerHTML = ''; continue; }
      const label = w.phase === 'before' ? `Do you know “${esc(w.target)}”?` : 'Again, deeper? Or go on.';
      el.innerHTML = `<div class="label">${label}</div><div class="buttons"><button class="c know" data-act="know">I know <kbd>K</kbd></button><button class="c" data-act="dont">I don’t know <kbd>D</kbd></button><button class="c" data-act="go">Go on <kbd>Esc</kbd></button></div><div class="count"><span style="animation-duration:${Math.max(0, w.ms)}ms"></span></div>`;
      el.hidden = false;
      el.onclick = (ev) => {
        const act = (ev.target as HTMLElement).closest('button')?.dataset.act;
        if (act === 'know') this.answerKnow(); else if (act === 'dont') this.answerDontKnow(); else if (act === 'go') this.answerGoOn();
      };
    }
  }

  private renderTranscript(): void {
    const box = this.panel?.el.querySelector<HTMLElement>('.transcript');
    if (!box) return;
    const items = this.transcript.slice(-12).map((e) => {
      const head = e.kind === 'question' ? `You: ${esc(e.question ?? '')}` : e.kind === 'passage' ? 'The last part' : esc(e.target);
      const st = e.status === 'thinking' ? 'thinking…' : e.status === 'speaking' ? 'speaking' : e.status === 'error' ? 'error' : '';
      const zh = e.chinese ? `<div class="zh">${esc(e.chinese.split('\n')[0])}</div>` : '';
      return `<div class="entry ${e.status === 'error' ? 'error' : ''}"><div class="target">${head} <span class="st">${st}</span></div>${zh}<div class="body">${esc(e.status === 'error' ? e.error ?? '' : e.text)}</div></div>`;
    });
    box.innerHTML = items.join('');
    box.scrollTop = box.scrollHeight;
  }

  // ---- big subtitles over the video ----------------------------------------------------------------------------
  private bandVisible(): boolean {
    if (!this.band) return false;
    return this.band.host.style.display !== 'none';
  }
  private placeBand(): void {
    const player = document.querySelector<HTMLElement>('#movie_player');
    const want = extras.band === 'on' || (extras.band === 'auto' && (!!document.fullscreenElement || !!document.querySelector('ytd-watch-flexy[theater]') || !this.panel));
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
    document.documentElement.classList.toggle('dr-hide-cc', want && extras.hideYtCaptions);
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
    say.textContent = last && (last.status === 'thinking' || last.status === 'speaking') ? (last.text ? firstSentences(last.text, 220) : 'Thinking…') : '';
  }

  toast(text: string, ms = 3500): void {
    for (const r of [this.panel?.el, this.band?.el]) {
      const t = r?.querySelector<HTMLElement>('.toast');
      if (!t) continue;
      t.textContent = text;
      t.hidden = false;
      clearTimeout((t as unknown as { _tm?: ReturnType<typeof setTimeout> })._tm);
      (t as unknown as { _tm?: ReturnType<typeof setTimeout> })._tm = setTimeout(() => { t.hidden = true; }, ms);
    }
  }

  settingsChanged(prev: Settings): void {
    this.applyLook();
    if (prev.learnerLevel !== settings.learnerLevel || prev.appearance.showHints !== settings.appearance.showHints) {
      this.render();
      if (prev.learnerLevel !== settings.learnerLevel) void this.runHintsJob();
    }
    if (prev.voice.voiceId !== settings.voice.voiceId && settings.voice.voiceId) this.voiceId = settings.voice.voiceId;
    this.renderHead();
  }

  keydown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const open = !!this.cmdWin || !!this.callStop || !!this.card;
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (open && (e.code === 'KeyK' && !e.shiftKey)) { swallow(); if (this.card && !this.cmdWin && !this.callStop) { this.controller?.markKnown(this.card.lemma); void this.changeStatus(this.card.lemma, 'known'); this.closeCard(); } else this.answerKnow(); return; }
    if (open && e.code === 'KeyD') { swallow(); this.answerDontKnow(); return; }
    if ((this.cmdWin || this.callStop) && e.code === 'Escape') { swallow(); this.answerGoOn(); return; }
    if (this.card && e.code === 'Escape') { swallow(); this.closeCard(); return; }
    if (this.mode === 'tutor' && e.shiftKey && e.code === 'KeyE') { swallow(); this.explainLast(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.followTimer) clearInterval(this.followTimer);
    this.offs.forEach((f) => f());
    this.controller?.dispose();
    this.engine.target = null;
    this.playback?.stop();
    this.tts?.cancelAll();
    this.panel?.host.remove();
    this.band?.host.remove();
    document.documentElement.classList.remove('dr-panel', 'dr-band', 'dr-hide-cc');
  }

  debug() {
    return {
      mode: this.mode, sentences: this.vb?.order.length ?? 0, state: this.playback?.state ?? null, cur: this.cur, window: this.cmdWin, card: this.card,
      transcript: this.transcript.map((e) => ({ kind: e.kind, target: e.target, status: e.status, text: e.text.slice(0, 80) })),
      spoken: (this.tts as unknown as { spoken?: { text: string }[] })?.spoken?.map((s) => s.text) ?? null,
      hints: Object.keys(this.hints).length, phrases: Object.keys(this.phrases).length, callStop: this.callStop ? this.callStop.target : null,
    };
  }
}

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
  tutorBtn.title = on ? 'Dream Tutor is on: the video stops at hard words and your AI explains them (your API key). Click to turn off.' : 'Turn on the Dream Tutor: stops at hard words, explanations with your own API key (ChatGPT / Claude turn off).';
}

async function setTutor(on: boolean): Promise<void> {
  await store.patchExtras({ tutorOn: on });
  extras.tutorOn = on;
  // one voice at a time: the website call goes off when the tutor comes on
  if (on) await chrome.storage.local.set({ sendOn: false });
  refresh();
}

async function boot(): Promise<void> {
  [settings, extras, vocab] = await Promise.all([store.getSettings(), store.getExtras(), store.getVocab()]);
  window.__ytcDream = {
    owns: () => !!session && session.owns(),
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
  };
  const bar = document.getElementById('yt2c-bar');
  if (bar) window.__ytcDream.decorateBar(bar);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch[store.STORAGE_KEYS.settings]) { const prev = settings; settings = store.mergeSettings(ch[store.STORAGE_KEYS.settings].newValue); session?.settingsChanged(prev); }
    if (ch[store.STORAGE_KEYS.extras]) { extras = { ...store.DEFAULT_EXTRAS, ...ch[store.STORAGE_KEYS.extras].newValue }; refresh(); }
    if (ch[store.STORAGE_KEYS.vocab]) { vocab = { words: { ...(ch[store.STORAGE_KEYS.vocab].newValue?.words ?? {}) }, marked: {} }; }
    if (ch.sendOn || ch.target) setTimeout(refresh, 50); // youtube.js reads the same change first
  });
  document.addEventListener('keydown', (e) => session?.keydown(e), true);
  // YouTube is a single-page app: a new video = a new session
  document.addEventListener('yt-navigate-finish', () => setTimeout(refresh, 300));
  setInterval(() => { const id = location.pathname === '/watch' ? window.__ytcApi?.videoId() : null; if ((session?.videoId ?? null) !== (id && wantedMode() ? id : null)) refresh(); }, 1500);
  refresh();
}

(function wait(tries = 0) {
  if (window.__ytcApi) { void boot(); return; }
  if (tries < 100) setTimeout(() => wait(tries + 1), 100);
})();
