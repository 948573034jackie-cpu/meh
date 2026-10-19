/**
 * VoiceChat: the voice line between the learner and the tutor. Joins the microphone (MicCapture), the local
 * speech-to-text engine (stt IPC), the VoiceSession (commands / conversation) and the reader (ListenController
 * through the `tutor` callbacks). No DOM here: the UI (VoiceChatUI.tsx) renders `snapshot` and calls the
 * public methods; tests drive it with fakes.
 *
 * Lines:
 *  - 'closed'  the mic is off.
 *  - 'window'  the pause after an explanation (or a quiz wait): the mic is open in 'commands' mode for
 *              "I know" / "I don't know" / "bye bye" / a question. Opens and closes with the pause.
 *  - 'call'    the learner pressed the mic (or Always on): every sentence they say is a question for the
 *              tutor; speaking interrupts the tutor and pauses the book; "bye bye" ends the call.
 */
import { Emitter } from '@core/voice/turns';
import { VoiceSession, type SttEngineEvent } from '@core/voice/session';
import type { CommandListenerOptions } from '@core/voice/turns';
import type { SttStatus } from '@shared/api';
import type { MicLike } from './mic';
import { MicError } from './mic';

export type VoiceLine = 'closed' | 'window' | 'call';
/** what the round mic button shows */
export type VoiceUiState = 'off' | 'listening' | 'thinking' | 'speaking';
/** what the tutor (ListenController) is doing */
export type TutorState = 'idle' | 'thinking' | 'speaking';

/** The stt IPC as VoiceChat uses it (window.readalong.stt*, or a fake under e2e / in tests). */
export interface SttBridge {
  status(): Promise<SttStatus>;
  download(): Promise<SttStatus>;
  cancelDownload(): Promise<void>;
  start(sessionId: string, opts?: { sampleRate?: number }): Promise<SttStatus>;
  push(sessionId: string, pcm: ArrayBuffer): Promise<void>;
  stop(sessionId: string): Promise<void>;
  onEvent(cb: (ev: SttEngineEvent) => void): () => void;
  onProgress(cb: (s: SttStatus) => void): () => void;
}

/** What the voice line does to the reader; implemented by ReaderView with the ListenController. */
export interface TutorActions {
  /** "I know": the word of the last explanation is known now; the book continues at once (Listening) */
  know(): void;
  /** "I don't know": the last explanation again, deeper */
  dontKnow(): void;
  /** a question about the current sentence, sent with the chapter's history; the reply is spoken as it streams */
  ask(text: string, spoken: boolean): void;
  /** the learner started talking: the tutor goes quiet and the book pauses */
  hold(): void;
  /** the learner said nothing after all: the book goes on if it was going (Listening) */
  release(): void;
  /** the learner started talking during the pause: keep the pause open a little longer */
  keepWaiting(): void;
  /** "bye bye" during the pause: the book goes on (Listening); Reading stays where it is */
  continueBook(): void;
}

export interface VoiceTurn { id: number; who: 'you' | 'tutor'; text: string; spoken: boolean }

export interface VoiceSnapshot {
  line: VoiceLine;
  ui: VoiceUiState;
  /** mic input level 0..1 */
  level: number;
  /** live transcript of what the learner is saying */
  partial: string;
  /** the speech model is missing: the consent card asks before downloading */
  consent: boolean;
  /** download / model status (null until known) */
  model: SttStatus | null;
  /** a message for the learner (mic denied, model failed); null when all is well */
  error: string | null;
  alwaysOn: boolean;
}

export interface VoiceChatEvents {
  change: (s: VoiceSnapshot) => void;
  /** the learner said something that was sent to the tutor, or a command was recognised */
  heard: (e: { text: string; command?: 'know' | 'dont_know' | 'bye' }) => void;
}

export interface VoiceChatOptions {
  stt: SttBridge;
  mic: MicLike;
  tutor: TutorActions;
  /** start with Always on */
  alwaysOn?: boolean;
  /** after the learner stopped speaking without a question arriving, the book goes on after this long (ms) */
  noQuestionMs?: number;
  /** the pause closed while the learner was still talking: their sentence is still taken for this long (ms) */
  windowGraceMs?: number;
  /** passed to the CommandListener (debounce, clock) */
  listener?: CommandListenerOptions;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

let nextSession = 0;

export class VoiceChat extends Emitter<VoiceChatEvents> {
  readonly session: VoiceSession;
  private line: VoiceLine = 'closed';
  private tutorState: TutorState = 'idle';
  private userSpeaking = false;
  private level = 0;
  private partial = '';
  private consent = false;
  private model: SttStatus | null = null;
  private error: string | null = null;
  private alwaysOn: boolean;
  /** the pause after an explanation is open (nested opens are counted) */
  private windows = 0;
  /** the call should start once the model is downloaded */
  private callAfterDownload = false;
  /** the book was paused because the learner started talking (barge-in) and no question has gone out yet */
  private holding = false;
  private sid: string | null = null;
  private opening: Promise<void> | null = null;
  private noQuestionTimer: unknown = null;
  private graceTimer: unknown = null;
  private offs: (() => void)[] = [];
  private disposed = false;
  private readonly st: (fn: () => void, ms: number) => unknown;
  private readonly ct: (t: unknown) => void;

  constructor(private readonly opts: VoiceChatOptions) {
    super();
    this.session = new VoiceSession({ mode: 'off', listener: opts.listener });
    this.alwaysOn = !!opts.alwaysOn;
    this.st = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.ct = opts.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    // only events of the mic session that is open now
    this.session.attach((listener) => opts.stt.onEvent((ev) => { if (this.sid && ev.sessionId === this.sid) listener(ev); }));
    this.offs.push(
      opts.stt.onProgress((s) => { this.model = s; this.afterModelChange(); this.changed(); }),
      opts.mic.on('frame', (pcm) => { const id = this.sid; if (id) void opts.stt.push(id, pcm).catch(() => undefined); }),
      opts.mic.on('level', (l) => { this.level = l; this.changed(); }),
      opts.mic.on('ended', () => { this.error = 'The microphone was disconnected.'; this.closeLine(); }),
      this.session.on('speechStart', () => this.onSpeechStart()),
      this.session.on('speechEnd', () => this.onSpeechEnd()),
      this.session.on('partial', (p) => { this.partial = p.text; this.changed(); }),
      this.session.on('question', (q) => this.onQuestion(q.text)),
      this.session.on('command', (c) => this.onCommand(c.intent, c.text)),
      this.session.on('error', (e) => { this.error = `Speech recognition failed (${e.message}).`; this.changed(); }),
    );
    void opts.stt.status().then((s) => { this.model = s; this.afterModelChange(); this.changed(); }).catch(() => undefined);
  }

  get snapshot(): VoiceSnapshot {
    return { line: this.line, ui: this.uiState(), level: this.line === 'closed' ? 0 : this.level, partial: this.partial, consent: this.consent, model: this.model, error: this.error, alwaysOn: this.alwaysOn };
  }

  get sessionId(): string | null { return this.sid; }

  // ---- what the learner does -------------------------------------------------------------------

  /** The mic button / M key: opens the call, or hangs up. */
  toggle(): void { if (this.line === 'call') this.hangUp(); else this.call(); }

  /** Opens the call (asks to download the speech model first when it is missing). */
  call(): void {
    this.error = null;
    if (!this.model) { void this.opts.stt.status().then((st) => { this.model = st; this.call(); }, (e: Error) => { this.error = e.message; this.changed(); }); return; }
    if (this.model.state === 'error' && !this.model.downloadBytes) { this.error = this.model.error ?? 'Speech recognition is not available.'; this.changed(); return; }
    if (!this.modelReady()) {
      this.callAfterDownload = true;
      this.consent = true;
      this.changed();
      return;
    }
    this.consent = false;
    this.line = 'call';
    this.applyMode();
    this.changed();
    void this.openMic();
  }

  /** Ends the call without a word to the tutor (the button, M, or "bye bye"). */
  hangUp(): void {
    this.callAfterDownload = false;
    if (this.line === 'closed') return;
    if (this.holding) { this.holding = false; this.opts.tutor.release(); }
    if (this.windows > 0) { this.line = 'window'; this.applyMode(); this.changed(); return; }
    this.closeLine();
  }

  setAlwaysOn(on: boolean): void {
    this.alwaysOn = on;
    if (on && this.line !== 'call') this.call();
    this.changed();
  }

  /** The typed box: the same as saying it (pronunciation does not matter). */
  askTyped(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.emit('heard', { text: t });
    this.clearNoQuestion();
    this.holding = false;
    this.opts.tutor.ask(t, false);
  }

  /** The consent card: download the speech model now. */
  acceptDownload(): void {
    this.consent = true;
    this.error = null;
    this.changed();
    this.opts.stt.download().then((s) => { this.model = s; this.consent = false; this.afterModelChange(); this.changed(); }, (e: Error) => {
      if (/abort|cancel/i.test(e.message)) { this.consent = false; this.callAfterDownload = false; } else this.error = `The speech model could not be downloaded (${e.message}).`;
      this.changed();
    });
  }

  declineDownload(): void {
    if (this.model?.state === 'downloading') void this.opts.stt.cancelDownload().catch(() => undefined);
    this.consent = false; this.callAfterDownload = false; this.changed();
  }

  dismissError(): void { this.error = null; this.changed(); }

  // ---- what the reader tells it ----------------------------------------------------------------

  /** ListenController's onPauseWindow: the pause after an explanation (or a quiz wait) opens / closes. */
  pauseWindow(open: boolean): void {
    if (open) {
      this.windows++;
      if (this.graceTimer !== null) { this.ct(this.graceTimer); this.graceTimer = null; }
      if (this.line === 'closed') {
        if (!this.modelReady() || this.error) return; // never ask for a download or a permission by itself
        this.line = 'window';
        void this.openMic();
      }
      this.applyMode();
      this.changed();
      return;
    }
    this.windows = Math.max(0, this.windows - 1);
    if (this.windows > 0) return;
    if (this.line === 'call') { this.applyMode(); this.changed(); return; }
    if (this.line !== 'window') return;
    if (this.userSpeaking) {
      // the learner is in the middle of a sentence: take it, then close
      this.graceTimer = this.st(() => { this.graceTimer = null; if (this.line === 'window' && this.windows === 0) this.closeLine(); }, this.opts.windowGraceMs ?? 4000);
      return;
    }
    this.closeLine();
  }

  /** The tutor (ListenController) is thinking / speaking / done. */
  setTutorState(s: TutorState): void {
    if (s === this.tutorState) return;
    this.tutorState = s;
    this.changed();
  }

  /** Feeds one STT event as if it came from the engine (e2e: `window.__dreamVoice.inject`). */
  inject(ev: Partial<SttEngineEvent> & { type: SttEngineEvent['type'] }): void {
    const sid = this.sid ?? 'injected';
    const segmentId = (ev as { segmentId?: string }).segmentId ?? `${sid}:${++nextSession}`;
    this.session.handle({ ...ev, sessionId: sid, segmentId } as SttEngineEvent);
  }

  dispose(): void {
    this.disposed = true;
    this.clearNoQuestion();
    if (this.graceTimer !== null) { this.ct(this.graceTimer); this.graceTimer = null; }
    this.closeMic();
    this.session.detach();
    for (const off of this.offs) off();
    this.offs = [];
    this.removeAllListeners();
  }

  // ---- internals -------------------------------------------------------------------------------

  private modelReady(): boolean { const st = this.model?.state; return st === 'ready' || st === 'loading'; }

  private afterModelChange(): void {
    if (this.disposed || !this.modelReady()) return;
    if (this.consent && this.model?.state !== 'downloading') this.consent = false;
    if (this.callAfterDownload || (this.alwaysOn && this.line !== 'call')) { this.callAfterDownload = false; this.call(); }
  }

  private uiState(): VoiceUiState {
    if (this.line === 'closed') return this.tutorState === 'idle' ? 'off' : this.tutorState;
    if (this.userSpeaking) return 'listening';
    if (this.tutorState !== 'idle') return this.tutorState;
    return 'listening';
  }

  /** commands while the pause is open (also during a call: "I know" there means the word), conversation otherwise */
  private applyMode(): void {
    const mode = this.line === 'closed' ? 'off' : this.windows > 0 ? 'commands' : this.line === 'call' ? 'conversation' : 'off';
    this.session.setMode(mode);
  }

  private onSpeechStart(): void {
    this.userSpeaking = true;
    this.partial = '';
    this.clearNoQuestion();
    if (this.session.mode === 'commands') this.opts.tutor.keepWaiting();
    else if (this.line === 'call' && !this.holding) { this.holding = true; this.opts.tutor.hold(); }
    this.changed();
  }

  private onSpeechEnd(): void {
    this.userSpeaking = false;
    this.changed();
    if (!this.holding) return;
    // noise, a cough, or words the recogniser could not make out: the book goes on after a moment
    this.clearNoQuestion();
    this.noQuestionTimer = this.st(() => { this.noQuestionTimer = null; if (this.holding) { this.holding = false; this.opts.tutor.release(); } }, this.opts.noQuestionMs ?? 2500);
  }

  private clearNoQuestion(): void { if (this.noQuestionTimer !== null) { this.ct(this.noQuestionTimer); this.noQuestionTimer = null; } }

  private onQuestion(text: string): void {
    const t = text.trim();
    this.userSpeaking = false;
    this.partial = '';
    this.clearNoQuestion();
    if (!t) { this.changed(); return; }
    this.holding = false;
    this.emit('heard', { text: t });
    this.opts.tutor.ask(t, true);
    this.afterTurnInWindow();
    this.changed();
  }

  private onCommand(intent: 'know' | 'dont_know' | 'bye', text: string): void {
    this.userSpeaking = false;
    this.partial = '';
    this.clearNoQuestion();
    this.emit('heard', { text, command: intent });
    if (intent === 'know') { this.opts.tutor.know(); this.afterTurnInWindow(); }
    else if (intent === 'dont_know') { this.opts.tutor.dontKnow(); this.afterTurnInWindow(); }
    else {
      // "bye bye": the voice line closes; Listening carries on, Reading stays where it is
      const inWindow = this.windows > 0;
      const wasHolding = this.holding;
      this.callAfterDownload = false;
      this.holding = false;
      this.windows = 0;
      this.closeLine();
      if (wasHolding) this.opts.tutor.release();
      if (inWindow) this.opts.tutor.continueBook();
    }
    this.changed();
  }

  /** a window line has done its job once the learner answered: the next pause opens a new one */
  private afterTurnInWindow(): void {
    if (this.line !== 'window') return;
    this.windows = 0;
    if (this.graceTimer !== null) { this.ct(this.graceTimer); this.graceTimer = null; }
    this.closeLine();
  }

  private closeLine(): void {
    this.line = 'closed';
    this.userSpeaking = false;
    this.partial = '';
    this.level = 0;
    this.session.setMode('off');
    this.closeMic();
    this.changed();
  }

  private async openMic(): Promise<void> {
    if (this.opening) {
      // a session is still starting (the model may take seconds to load); if the line was closed and opened
      // again meanwhile, that one gives up when it is ready, so a fresh one is opened after it
      await this.opening;
      if (this.sid || this.disposed || this.line === 'closed') return;
      return this.openMic();
    }
    if (this.sid) return;
    const sid = `voice-${Date.now().toString(36)}-${++nextSession}`;
    this.opening = (async () => {
      try {
        this.sid = sid;
        await this.opts.stt.start(sid, { sampleRate: 16000 });
        if (this.sid !== sid || this.lineNow() === 'closed') { void this.opts.stt.stop(sid).catch(() => undefined); return; }
        await this.opts.mic.start();
        if (this.sid !== sid || this.lineNow() === 'closed') this.opts.mic.stop();
      } catch (e) {
        this.error = e instanceof MicError ? e.message : `The microphone could not be opened (${(e as Error).message}).`;
        if (this.sid === sid) { this.sid = null; void this.opts.stt.stop(sid).catch(() => undefined); }
        this.callAfterDownload = false;
        this.line = 'closed'; this.session.setMode('off');
        this.changed();
      } finally { this.opening = null; }
    })();
    return this.opening;
  }

  /** the line as it is now (read again after an await) */
  private lineNow(): VoiceLine { return this.line; }

  private closeMic(): void {
    this.opts.mic.stop();
    const sid = this.sid;
    this.sid = null;
    if (sid) void this.opts.stt.stop(sid).catch(() => undefined);
  }

  private changed(): void { if (!this.disposed) this.emit('change', this.snapshot); }
}
