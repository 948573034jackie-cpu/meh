/**
 * The YouTube video as Dream Read's reading voice. Playback "speaks" one sentence at a time; for a video that
 * means: play the sentence's part of the video and report each word when the video reaches it. Consecutive
 * sentences just keep playing (no seek, no gap); a sentence started again after a stop, a pause or a jump starts
 * at its own beginning (Dream Read: "reading continues from the start of the interrupted sentence").
 * cancel() pauses the video: that is how Playback stops right after a hard word.
 */
import type { Position } from '@core/model';
import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle, SpeakOutcome } from '@core/tts/engine';
import type { TtsEngineId } from '@shared/settings';
import type { VideoBook } from './video-book';

/** the next sentence counts as "the same reading going on" when it is asked for within this time after the last one ended */
const CONTINUE_WINDOW_MS = 1500;
/** seek this much before a sentence so its first word is not cut */
const LEAD_IN_SEC = 0.15;
const POLL_MS = 40;
/** our own play/pause/seek: the video's events for them arrive within this time and are not the learner's */
const OWN_EVENT_MS = 700;

export interface VideoLike {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  play(): Promise<void>;
  pause(): void;
}

export class VideoEngine implements TtsEngine {
  readonly id = 'webspeech' as TtsEngineId; // (the registry is not used for the video; the field is only informative)
  readonly label = 'YouTube video';
  readonly kind = 'local' as const;
  readonly costNote = 'Free';
  readonly wordBoundaries = true;
  /** the sentence Playback is about to speak (set from its 'sentence' event, which comes right before speak) */
  target: Position | null = null;
  /** the learner pressed play or jumped: start where the video is, not at the sentence start */
  resumeHere = false;
  /** the teacher plays the sentence again: always from its start (even right after it ended) */
  forceStart = false;
  /** the teacher just played this sentence to its end: when the reading resumes on it, it goes on after it */
  private teacherPlayed: string | null = null;
  /** called when the teacher's play of the target sentence ended */
  markTeacherPlayed(): void { const p = this.target; this.teacherPlayed = p ? `${p.chapter}.${p.paragraph}.${p.sentence}` : null; }
  private current: { finish: (o: SpeakOutcome) => void } | null = null;
  private lastEnded = 0;
  private own: Record<'play' | 'pause' | 'seek', number> = { play: 0, pause: 0, seek: 0 };
  /** a cancel asked to pause the video; dropped when the next sentence starts in the same moment (play, seek) */
  private holdPending = false;

  constructor(private getVideo: () => VideoLike | null, private vb: () => VideoBook | null, private now: () => number = () => Date.now()) {}

  get paused(): boolean { return false; }
  /** true when a video event of this kind was caused by the engine itself a moment ago */
  isOwn(kind: 'play' | 'pause' | 'seek'): boolean { return this.now() - this.own[kind] < OWN_EVENT_MS; }
  /** the caller is about to play / pause / seek the video itself: its event is not the learner's */
  markOwn(kind: 'play' | 'pause' | 'seek'): void { this.own[kind] = this.now(); if (kind === 'play') this.holdPending = false; }
  /** pause the video as part of the reading (a stop at a hard word, an explanation) */
  hold(): void { this.holdPending = false; const v = this.getVideo(); if (v && !v.paused) { this.own.pause = this.now(); v.pause(); } }
  /** pause after a cancel, unless Playback goes straight on with another sentence (it cancels before every play
   *  and seek): pausing then would stutter the video and break the learner's own press of play */
  private holdSoon(): void {
    this.holdPending = true;
    queueMicrotask(() => { if (this.holdPending) this.hold(); });
  }

  async listVoices(): Promise<TtsVoice[]> { return []; }

  speak(_text: string, opts: SpeakOptions): SpeakHandle {
    this.finishCurrent('cancelled');
    this.holdPending = false;
    const video = this.getVideo();
    const book = this.vb();
    const pos = this.target;
    const timing = pos && book ? book.timingOf(pos) : null;
    let resolve!: (o: SpeakOutcome) => void;
    const done = new Promise<SpeakOutcome>((r) => { resolve = r; });
    const handle: SpeakHandle = { done, cancel: () => finish('cancelled') };
    let timer: ReturnType<typeof setInterval> | null = null;
    let finished = false;
    const finish = (o: SpeakOutcome, err?: Error) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      if (this.current === mine) this.current = null;
      if (o === 'cancelled') this.holdSoon();
      if (o === 'ended') this.lastEnded = this.now();
      if (err) handle.error = err;
      resolve(o);
    };
    const mine = { finish };
    this.current = mine;
    if (!video || !timing) { setTimeout(() => finish(video ? 'ended' : 'error', video ? undefined : new Error('No video on this page')), 0); return handle; }
    const key = pos ? `${pos.chapter}.${pos.paragraph}.${pos.sentence}` : '';
    const heard = this.teacherPlayed === key && !this.forceStart && !this.resumeHere;
    this.teacherPlayed = null;
    if (heard) {
      // heard a moment ago (the teacher played it after the explanation): the reading goes on after it
      this.own.seek = this.now();
      if (video.currentTime < timing.end - 0.05 || video.currentTime > timing.end + 0.5) video.currentTime = timing.end;
      setTimeout(() => finish('ended'), 0);
      return handle;
    }
    const ct = video.currentTime;
    const continuing = this.now() - this.lastEnded < CONTINUE_WINDOW_MS && ct <= timing.end + 0.3;
    const here = this.resumeHere;
    const fromStart = this.forceStart;
    this.resumeHere = false;
    this.forceStart = false;
    if ((!continuing && !here) || fromStart) { this.own.seek = this.now(); video.currentTime = Math.max(0, timing.start - LEAD_IN_SEC); }
    if (video.paused) {
      this.own.play = this.now();
      video.play().catch((e: unknown) => finish('error', new Error(`The video could not start (${(e as Error)?.message ?? 'blocked'}). Press play on the video.`)));
    }
    opts.onStart?.();
    let lastWord = -1;
    const tick = () => {
      if (finished) return;
      const t = video.currentTime;
      // the word being spoken: the last token that started at or before now
      let wi = -1;
      for (let i = 0; i < timing.tokenStart.length; i++) { const s = timing.tokenStart[i]; if (s !== null && s <= t + 0.03) wi = i; }
      if (wi >= 0 && wi !== lastWord) {
        // report every word passed since the last tick (Playback stops right after a hard word)
        for (let i = lastWord + 1; i <= wi; i++) if (timing.tokenStart[i] !== null) { opts.onWord?.(timing.tokenChar[i], 1); if (finished) return; }
        lastWord = wi;
      }
      if (t >= timing.end - 0.02 || video.ended) finish('ended');
    };
    timer = setInterval(tick, POLL_MS);
    setTimeout(tick, 0);
    return handle;
  }

  private finishCurrent(o: SpeakOutcome): void { this.current?.finish(o); }

  pause(): void { this.hold(); }
  resume(): void { const v = this.getVideo(); if (v && v.paused) { this.own.play = this.now(); void v.play().catch(() => undefined); } }
  cancelAll(): void { this.finishCurrent('cancelled'); this.holdSoon(); }
  stopReadAhead(): void { /* nothing is prepared ahead: the video is already there */ }
}
