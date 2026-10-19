/**
 * VoiceSession: joins the STT event stream (main process `stt:event`), the CommandListener and the app's
 * listening modes. Pure TypeScript; the event source is injected so the renderer can pass the IPC
 * subscription and tests can pass fake events.
 *
 * Modes:
 *  - 'commands'     the 7 s pause after an explanation: "I know" / "I don't know" / "bye bye" fire as
 *                   commands; any other final transcript becomes a `question` for the AI.
 *  - 'conversation' the learner is talking with the tutor: finals become `question`s (including "I know",
 *                   which may be part of an answer); only "bye bye" is still a command.
 *  - 'off'          nothing is emitted (the mic may stay open; events are dropped).
 * "bye bye" switches the mode to 'off' in both active modes.
 * `speechStart` is re-emitted in any active mode so the caller can interrupt the tutor's speech (barge-in).
 */
import { Emitter, CommandListener, type CommandEvent, type CommandListenerOptions, type QuestionEvent } from './turns';

export type VoiceMode = 'commands' | 'conversation' | 'off';

/** One event from the STT engine (main process), as broadcast on the `stt:event` channel. */
export type SttEngineEvent =
  | { type: 'partial' | 'final'; text: string; confidence?: number; segmentId: string; sessionId: string }
  | { type: 'speechStart' | 'speechEnd'; sessionId: string; segmentId: string }
  | { type: 'error'; sessionId: string; message: string };

/** Subscribes `listener`, returns the unsubscribe function (what `window.api.onSttEvent` would return). */
export type SttEventSource = (listener: (ev: SttEngineEvent) => void) => () => void;

export interface VoiceSessionEvents {
  command: (e: CommandEvent) => void;
  question: (e: QuestionEvent) => void;
  speechStart: (e: { sessionId: string; segmentId: string }) => void;
  speechEnd: (e: { sessionId: string; segmentId: string }) => void;
  /** live transcript for the UI */
  partial: (e: { text: string; segmentId: string; sessionId: string }) => void;
  mode: (to: VoiceMode, from: VoiceMode) => void;
  error: (e: { sessionId: string; message: string }) => void;
}

export interface VoiceSessionOptions {
  /** initial mode (default 'off') */
  mode?: VoiceMode;
  /** only events of this STT session are handled (default: all) */
  sessionId?: string;
  /** passed to the CommandListener (debounce, clock, classifier) */
  listener?: CommandListenerOptions;
}

export class VoiceSession extends Emitter<VoiceSessionEvents> {
  readonly listener: CommandListener;
  private _mode: VoiceMode;
  private readonly sessionId: string | undefined;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: VoiceSessionOptions = {}) {
    super();
    this._mode = opts.mode ?? 'off';
    this.sessionId = opts.sessionId;
    this.listener = new CommandListener(opts.listener);
    this.listener.on('command', (cmd) => this.onCommand(cmd));
    this.listener.on('question', (q) => this.emit('question', q));
  }

  get mode(): VoiceMode { return this._mode; }

  setMode(mode: VoiceMode): void {
    const from = this._mode;
    if (from === mode) return;
    this._mode = mode;
    // partials pending from the previous mode must not fire a command in the new one
    this.listener.reset();
    this.emit('mode', mode, from);
  }

  /** Start consuming an event source; returns (and remembers) the unsubscribe function. */
  attach(source: SttEventSource): () => void {
    this.detach();
    const off = source((ev) => this.handle(ev));
    this.unsubscribe = off;
    return () => this.detach();
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Feed one STT engine event (what `attach` does for every event of the source). */
  handle(ev: SttEngineEvent): void {
    if (this.sessionId !== undefined && ev.sessionId !== this.sessionId) return;
    if (ev.type === 'error') { this.emit('error', { sessionId: ev.sessionId, message: ev.message }); return; }
    if (this._mode === 'off') return;
    switch (ev.type) {
      case 'speechStart': this.emit('speechStart', { sessionId: ev.sessionId, segmentId: ev.segmentId }); return;
      case 'speechEnd': this.emit('speechEnd', { sessionId: ev.sessionId, segmentId: ev.segmentId }); return;
      case 'partial':
        if (ev.text.trim()) this.emit('partial', { text: ev.text, segmentId: ev.segmentId, sessionId: ev.sessionId });
        // In conversation mode commands may only come from finals (a partial-fired "I know" would otherwise
        // swallow the segment's final, which has to become a question).
        if (this._mode === 'commands') this.listener.push({ type: 'partial', text: ev.text, confidence: ev.confidence, segmentId: ev.segmentId });
        return;
      case 'final':
        this.listener.push({ type: 'final', text: ev.text, confidence: ev.confidence, segmentId: ev.segmentId });
        return;
    }
  }

  private onCommand(cmd: CommandEvent): void {
    if (cmd.intent === 'bye') {
      this.emit('command', cmd);
      this.setMode('off');
      return;
    }
    if (this._mode === 'conversation') {
      // "I know" while talking with the tutor is an answer, not a command.
      if (cmd.via === 'final') this.emit('question', { text: cmd.text, segmentId: cmd.segmentId });
      return;
    }
    this.emit('command', cmd);
  }
}
