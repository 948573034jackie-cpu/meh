import type { ExplainRequest } from '@shared/api';

export interface ExplainUsage { usd: number; dailyUsd: number; monthlyUsd: number }
/** What ListenDeps.explain returns: the streamed reply (`done`) and a way to stop it. */
export interface ExplainStream { done: Promise<{ text: string; usage: ExplainUsage }>; cancel(): void }
export type ExplainFn = (req: ExplainRequest, onDelta: (full: string) => void) => ExplainStream;

export interface PreparedHooks {
  /** every update of the reply while nobody speaks it yet (pre-synthesis of its first sentences) */
  onText?: (full: string) => void;
  /** the reply is complete (taken or not: its tokens are spent either way) */
  onDone?: (text: string, usage: ExplainUsage) => void;
  /** cancel() dropped it before it was taken (what was prepared for it can go too) */
  onCancel?: () => void;
}

/**
 * Once taken, a reply that stalls is given up: no text this long after take() (the request itself started earlier,
 * while the word was said: the time before take() never counts, so a retried request is not cut short)...
 */
export const FIRST_TEXT_MS = 25_000;
/** ...or no new text this long once the text has started. */
export const NEXT_TEXT_MS = 15_000;

/**
 * Listening stop (docs/RULES.md 1.2): the explanation is asked for the moment the book pauses at the word, while the
 * word is said 3 times and the commands window runs. The reply streams in silently: nothing is spoken, shown in the
 * transcript, added to the chapter history or saved to My Vocabulary until take() hands it to runExplanation.
 * cancel() drops it ("I know", "go on", the stop was aborted); the tokens generated so far are still billed.
 * runExplanation also takes its own live requests through here (at once), for the same stall guard.
 */
export class PreparedExplanation {
  readonly req: ExplainRequest;
  private readonly stream: ExplainStream;
  private text = '';
  private listener: ((full: string) => void) | null = null;
  private state: 'running' | 'taken' | 'cancelled' = 'running';
  private outcome: 'pending' | 'done' | 'error' = 'pending';

  constructor(explain: ExplainFn, req: ExplainRequest, private readonly hooks: PreparedHooks = {}) {
    this.req = req;
    this.stream = explain(req, (full) => {
      this.text = full;
      if (this.state === 'running') this.hooks.onText?.(full);
      this.listener?.(full);
    });
    this.stream.done.then((res) => { this.outcome = 'done'; this.hooks.onDone?.(res.text, res.usage); }, () => { this.outcome = 'error'; });
  }

  /** the text received so far */
  get partial(): string { return this.text; }
  /** 'done' = the whole reply is here; 'error' = it failed (or was cancelled) */
  get settled(): 'pending' | 'done' | 'error' { return this.outcome; }
  get status(): 'running' | 'taken' | 'cancelled' { return this.state; }

  /**
   * The reply becomes the explanation that is spoken: `onDelta` gets the text received so far at once, then every
   * update. Returns null when it was cancelled before (the caller then asks again). From now on a stalled reply
   * (FIRST_TEXT_MS, NEXT_TEXT_MS) is cancelled and the returned `done` rejects with code 'timeout'.
   */
  take(onDelta: (full: string) => void): ExplainStream | null {
    if (this.state !== 'running') return null;
    this.state = 'taken';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let over = false;
    let fail!: (e: Error) => void;
    const disarm = () => { over = true; if (timer) { clearTimeout(timer); timer = null; } };
    const arm = (ms: number) => {
      if (over) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        disarm();
        fail(Object.assign(new Error('The AI stopped answering. Try again in a moment.'), { code: 'timeout' }));
        this.stream.cancel();
      }, ms);
    };
    const done = new Promise<{ text: string; usage: ExplainUsage }>((resolve, reject) => {
      fail = reject;
      this.stream.done.then((r) => { disarm(); resolve(r); }, (e: Error) => { disarm(); reject(e); });
    });
    done.catch(() => undefined); // a reply cancelled before its caller awaits it
    this.listener = (full) => { arm(NEXT_TEXT_MS); onDelta(full); };
    if (this.outcome === 'pending') arm(this.text ? NEXT_TEXT_MS : FIRST_TEXT_MS);
    if (this.text) onDelta(this.text);
    return { done, cancel: () => { disarm(); this.stream.cancel(); } };
  }

  /** Not needed after all. Idempotent; does nothing once taken (the explanation's own cancel stops it then). */
  cancel(): void {
    if (this.state !== 'running') return;
    this.state = 'cancelled';
    this.listener = null;
    this.stream.cancel();
    this.hooks.onCancel?.();
  }
}
