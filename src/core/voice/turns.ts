/**
 * Turn-taking glue for the voice loop: a CommandListener that debounces STT partials/finals into at most one
 * command per VAD segment, and a tiny ConversationTurn state machine (idle → listening → thinking → speaking)
 * with barge-in. Pure TypeScript; timing comes from an injectable clock so tests can use fake timers.
 */
import { detectCommand, isCommandIntent, type CommandIntent, type DetectOptions, type Detection } from './commands';

type Listener = (...args: never[]) => void;

/** Minimal typed on/off/emit. */
export class Emitter<E extends { [K in keyof E]: (...args: never[]) => void }> {
  private listeners = new Map<keyof E, Set<Listener>>();

  on<K extends keyof E>(event: K, fn: E[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(fn as Listener);
    return () => this.off(event, fn);
  }

  off<K extends keyof E>(event: K, fn: E[K]): void {
    this.listeners.get(event)?.delete(fn as Listener);
  }

  once<K extends keyof E>(event: K, fn: E[K]): () => void {
    const off = this.on(event, ((...args: Parameters<E[K]>) => { off(); (fn as (...a: Parameters<E[K]>) => void)(...args); }) as E[K]);
    return off;
  }

  protected emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) (fn as (...a: Parameters<E[K]>) => void)(...args);
  }

  removeAllListeners(): void { this.listeners.clear(); }
}

// ---------------------------------------------------------------------------------------------------------
// CommandListener
// ---------------------------------------------------------------------------------------------------------

export interface SttEvent {
  type: 'partial' | 'final';
  text: string;
  /** Utterance/word confidence 0..1 when the engine provides one (Deepgram, Parakeet); absent for Whisper/Moonshine. */
  confidence?: number;
  /** VAD segment this transcript belongs to; a command fires at most once per segment. */
  segmentId: string | number;
}

export interface CommandEvent {
  intent: CommandIntent;
  /** Raw transcript text that triggered the command. */
  text: string;
  score: number;
  matched?: string;
  segmentId: string | number;
  /** Whether a final transcript or two agreeing partials fired it. */
  via: 'final' | 'partials';
}

export interface QuestionEvent {
  text: string;
  segmentId: string | number;
  confidence?: number;
}

export interface CommandListenerEvents {
  /** A command was recognised (once per segment, debounced). */
  command: (e: CommandEvent) => void;
  /** A final transcript that is not a command: free conversation for the AI. */
  question: (e: QuestionEvent) => void;
  /** A command was recognised but dropped by the debounce window. */
  suppressed: (e: CommandEvent) => void;
}

export interface CommandListenerOptions {
  /** Minimum gap between two emitted commands in ms (default 1000). */
  debounceMs?: number;
  /** Clock in ms; defaults to Date.now so vitest fake timers work. */
  now?: () => number;
  /** Classifier, defaults to detectCommand (injectable for tests). */
  detect?: (text: string, opts?: DetectOptions) => Detection;
  /** Passed through to the classifier. */
  minRatio?: number;
  /** How many finished segment ids to remember (default 64). */
  remember?: number;
}

/**
 * Consumes STT events and emits `command` once per segment: a `final` fires immediately, partials need two
 * consecutive agreeing partials (same intent in the same segment). A 1 s debounce drops commands that arrive
 * too soon after the previous one. Non-command finals are emitted as `question` so the caller can hand them to
 * the AI; empty finals emit nothing.
 */
export class CommandListener extends Emitter<CommandListenerEvents> {
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly detect: (text: string, opts?: DetectOptions) => Detection;
  private readonly minRatio: number | undefined;
  private readonly remember: number;
  private lastFiredAt = Number.NEGATIVE_INFINITY;
  private pending: { segmentId: string; intent: CommandIntent } | null = null;
  private done: string[] = [];

  constructor(opts: CommandListenerOptions = {}) {
    super();
    this.debounceMs = opts.debounceMs ?? 1000;
    this.now = opts.now ?? (() => Date.now());
    this.detect = opts.detect ?? detectCommand;
    this.minRatio = opts.minRatio;
    this.remember = opts.remember ?? 64;
  }

  /** Feed one STT event. Returns the command that was emitted, or null. */
  push(ev: SttEvent): CommandEvent | null {
    const seg = String(ev.segmentId);
    if (this.done.includes(seg)) return null;
    if (this.pending && this.pending.segmentId !== seg) this.pending = null;

    const det = this.detect(ev.text, { confidence: ev.confidence, minRatio: this.minRatio });

    if (isCommandIntent(det.intent)) {
      const agreeing = this.pending !== null && this.pending.segmentId === seg && this.pending.intent === det.intent;
      if (ev.type === 'final' || agreeing) {
        const cmd: CommandEvent = { intent: det.intent, text: ev.text, score: det.score, matched: det.matched, segmentId: ev.segmentId, via: ev.type === 'final' ? 'final' : 'partials' };
        return this.fire(seg, cmd);
      }
      this.pending = { segmentId: seg, intent: det.intent };
      return null;
    }

    this.pending = null;
    if (ev.type === 'final') {
      this.finish(seg);
      if (det.intent === 'question') this.emit('question', { text: ev.text, segmentId: ev.segmentId, confidence: ev.confidence });
    }
    return null;
  }

  /** Forget pending partials and finished segments (e.g. when the mic window closes). */
  reset(): void {
    this.pending = null;
    this.done = [];
  }

  private fire(seg: string, cmd: CommandEvent): CommandEvent | null {
    this.finish(seg);
    const t = this.now();
    if (t - this.lastFiredAt < this.debounceMs) {
      this.emit('suppressed', cmd);
      return null;
    }
    this.lastFiredAt = t;
    this.emit('command', cmd);
    return cmd;
  }

  private finish(seg: string): void {
    this.pending = null;
    this.done.push(seg);
    if (this.done.length > this.remember) this.done.splice(0, this.done.length - this.remember);
  }
}

// ---------------------------------------------------------------------------------------------------------
// ConversationTurn
// ---------------------------------------------------------------------------------------------------------

export type TurnState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface ConversationTurnEvents {
  state: (to: TurnState, from: TurnState) => void;
  /** The user started talking while the assistant was thinking/speaking: stop TTS and listen. */
  interrupt: (from: TurnState) => void;
  /** The conversation ended (bye command or caller). */
  bye: (from: TurnState) => void;
}

const TRANSITIONS: Record<TurnState, readonly TurnState[]> = {
  idle: ['listening'],
  listening: ['thinking', 'idle'],
  thinking: ['speaking', 'listening', 'idle'],
  speaking: ['listening', 'idle'],
};

/**
 * idle → listening (mic open) → thinking (AI working) → speaking (TTS) → listening … ; `interrupt()` is the
 * barge-in path when VAD detects speech while the assistant is speaking (or still thinking); `bye()` ends
 * the conversation from any state. Invalid transitions are ignored and return false.
 */
export class ConversationTurn extends Emitter<ConversationTurnEvents> {
  private _state: TurnState = 'idle';

  get state(): TurnState { return this._state; }

  /** Open the mic for the user's turn. From idle, thinking (cancelled) or speaking (finished). */
  listen(): boolean { return this.go('listening'); }
  /** The user's turn ended; the AI is working on a reply. */
  think(): boolean { return this.go('thinking'); }
  /** The reply is being spoken. */
  speak(): boolean { return this.go('speaking'); }
  /** TTS finished naturally: back to listening. */
  done(): boolean { return this._state === 'speaking' && this.go('listening'); }

  /** VAD speech start while the assistant has the floor: cancel and listen. No-op in other states. */
  interrupt(): boolean {
    const from = this._state;
    if (from !== 'speaking' && from !== 'thinking') return false;
    this.go('listening');
    this.emit('interrupt', from);
    return true;
  }

  /** Convenience for wiring a VAD: only interrupts, never starts a turn. */
  onSpeechStart(): boolean { return this.interrupt(); }

  /** End the conversation from any state. */
  bye(): boolean {
    const from = this._state;
    if (from === 'idle') return false;
    this.go('idle');
    this.emit('bye', from);
    return true;
  }

  private go(to: TurnState): boolean {
    const from = this._state;
    if (from === to || !TRANSITIONS[from].includes(to)) return false;
    this._state = to;
    this.emit('state', to, from);
    return true;
  }
}
