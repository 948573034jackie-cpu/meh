/**
 * Speech segmentation on top of a frame-level voice-activity model (Silero): pure TypeScript, fed one speech
 * probability per fixed window (512 samples = 32 ms at 16 kHz) and producing speech start/end events with
 * absolute sample positions. The audio itself is kept elsewhere (see RingBuffer in ./audio.ts).
 *
 * Rules (defaults in the options):
 *  - speech starts when prob ≥ threshold; it is confirmed (speechStart emitted) once it has lasted minSpeechMs,
 *    with padMs of audio before the first speech window included in the segment;
 *  - it ends when prob has stayed < negThreshold (hysteresis) for minSilenceMs; the end is padded by padMs
 *    after the last speech window;
 *  - a segment longer than maxSpeechMs is cut ('max') and, as speech is still going on, a new segment starts
 *    right away;
 *  - flush() ends any open segment ('flush').
 */

export interface SegmenterOptions {
  sampleRate?: number;
  /** samples per probability window (Silero: 512 at 16 kHz) */
  windowSamples?: number;
  /** speech starts at or above this probability (default 0.5) */
  threshold?: number;
  /** speech continues while at or above this (default threshold - 0.15) */
  negThreshold?: number;
  /** shorter bursts are ignored (default 200 ms) */
  minSpeechMs?: number;
  /** silence needed to end a segment (default 600 ms) */
  minSilenceMs?: number;
  /** longest segment (default 15 000 ms) */
  maxSpeechMs?: number;
  /** audio kept before the first / after the last speech window (default 300 ms) */
  padMs?: number;
}

export type SegmentEndReason = 'silence' | 'max' | 'flush';

export type SegmenterEvent =
  | { type: 'speechStart'; segmentId: number; start: number }
  | { type: 'speechEnd'; segmentId: number; start: number; end: number; reason: SegmentEndReason };

type State = 'silence' | 'maybe' | 'speech';

export class SpeechSegmenter {
  readonly windowSamples: number;
  readonly threshold: number;
  readonly negThreshold: number;
  readonly minSpeechSamples: number;
  readonly minSilenceSamples: number;
  readonly maxSpeechSamples: number;
  readonly padSamples: number;
  private state: State = 'silence';
  /** absolute index of the next window's first sample */
  private pos = 0;
  /** unpadded start of the tentative/current segment */
  private speechAt = 0;
  /** padded start of the current segment */
  private segStart = 0;
  /** end of the last window that was speech */
  private lastSpeechEnd = 0;
  /** end of the previous segment (padding never reaches back into it) */
  private prevEnd = 0;
  private nextId = 1;
  private currentId = 0;

  constructor(opts: SegmenterOptions = {}) {
    const sr = opts.sampleRate ?? 16000;
    const ms = (v: number): number => Math.round((v / 1000) * sr);
    this.windowSamples = opts.windowSamples ?? 512;
    this.threshold = opts.threshold ?? 0.5;
    this.negThreshold = opts.negThreshold ?? Math.max(0.01, this.threshold - 0.15);
    this.minSpeechSamples = ms(opts.minSpeechMs ?? 200);
    this.minSilenceSamples = ms(opts.minSilenceMs ?? 600);
    this.maxSpeechSamples = ms(opts.maxSpeechMs ?? 15000);
    this.padSamples = ms(opts.padMs ?? 300);
  }

  /** samples consumed so far (absolute index of the next window) */
  get position(): number { return this.pos; }

  /** The confirmed segment in progress, for partial decodes of [start, position). */
  get active(): { segmentId: number; start: number } | null {
    return this.state === 'speech' ? { segmentId: this.currentId, start: this.segStart } : null;
  }

  get inSpeech(): boolean { return this.state === 'speech'; }

  /** Feed the speech probability of the next window. */
  push(prob: number): SegmenterEvent[] {
    const events: SegmenterEvent[] = [];
    const winStart = this.pos;
    const winEnd = winStart + this.windowSamples;
    this.pos = winEnd;
    const speech = prob >= this.threshold;
    const stillSpeech = prob >= this.negThreshold;

    switch (this.state) {
      case 'silence':
        if (speech) {
          this.state = 'maybe';
          this.speechAt = winStart;
          this.lastSpeechEnd = winEnd;
          if (winEnd - this.speechAt >= this.minSpeechSamples) this.confirm(events);
        }
        break;
      case 'maybe':
        if (stillSpeech) {
          this.lastSpeechEnd = winEnd;
          if (winEnd - this.speechAt >= this.minSpeechSamples) this.confirm(events);
        } else {
          this.state = 'silence';
        }
        break;
      case 'speech':
        if (stillSpeech) this.lastSpeechEnd = winEnd;
        if (winEnd - this.lastSpeechEnd >= this.minSilenceSamples) {
          this.end(events, Math.min(this.lastSpeechEnd + this.padSamples, winEnd), 'silence');
        } else if (winEnd - this.segStart >= this.maxSpeechSamples) {
          this.end(events, winEnd, 'max');
          if (stillSpeech) {
            // speech goes on: open the next segment immediately, without padding into the cut one
            this.state = 'maybe';
            this.speechAt = winEnd;
            this.lastSpeechEnd = winEnd;
            this.confirm(events);
          }
        }
        break;
    }
    return events;
  }

  /** End an open segment at the current position (mic closed, stream stopped). */
  flush(): SegmenterEvent[] {
    const events: SegmenterEvent[] = [];
    if (this.state === 'speech') this.end(events, this.pos, 'flush');
    this.state = 'silence';
    return events;
  }

  /** Forget everything, including the sample position. */
  reset(): void {
    this.state = 'silence';
    this.pos = 0; this.speechAt = 0; this.segStart = 0; this.lastSpeechEnd = 0; this.prevEnd = 0; this.currentId = 0;
  }

  private confirm(events: SegmenterEvent[]): void {
    this.state = 'speech';
    this.currentId = this.nextId++;
    this.segStart = Math.max(this.prevEnd, this.speechAt - this.padSamples);
    events.push({ type: 'speechStart', segmentId: this.currentId, start: this.segStart });
  }

  private end(events: SegmenterEvent[], end: number, reason: SegmentEndReason): void {
    events.push({ type: 'speechEnd', segmentId: this.currentId, start: this.segStart, end, reason });
    this.prevEnd = end;
    this.state = 'silence';
  }
}
