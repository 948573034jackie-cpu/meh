import type { Book, Position, CefrLevel } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { VocabState, MarkedRange, Settings } from '@shared/settings';
import type { ExplainRequest, ExplainKind } from '@shared/api';
import type { TtsEngine, SpeakHandle, PrepareHandle } from '@core/tts/engine';
import { samePosition, sentenceKey } from '@core/model';
import type { PhraseHit } from '@shared/api';
import { getSentence, nextPosition, prevPosition, comparePositions, contextAround, wordOffsets } from '@core/nav';
import { parseExplanation, type ExplanationParts } from '@core/ai/prompts';
import { annotateSentence } from '@core/vocab/analysis';
import { resolveStyle } from '@shared/styles';
import type { Playback } from './playback';
import { styledWordScript, styledSentenceScript, plainScript, aiSteps, splitByScript, twoMeanings, SpokenPlan, englishTexts, type SpokenPart, type ScriptStep, type AnyStep, type ScriptSettings } from './script';
import { StreamSentenceSplitter, type SentencePiece } from './sentences';
import { PreparedExplanation } from './prepared';

/** sentences of a prepared explanation synthesized while the commands window runs (the first ones the learner hears) */
const PRESYNTH_SENTENCES = 2;
/** English texts of one explanation synthesized ahead and not yet spoken, at most (every sentence as it arrives) */
const PRESYNTH_MAX = 12;
/** a cloud explanation voice costs money per character: only the first two texts of an explanation are fetched ahead */
const CLOUD_PRESYNTH = 2;
/** the first sentence of a spoken reply longer than this is cut at a comma, so its audio is ready sooner */
const FIRST_PIECE_CHARS = 120;
/** silence before each further sentence of a streamed reply, and before a new paragraph */
const SENTENCE_PAUSE_MS = 300;
const PARAGRAPH_PAUSE_MS = 450;
/** the transcript gets at most one text-only update per this many ms (status changes are sent at once) */
const TRANSCRIPT_MS = 200;
/**
 * The commands window ends at a fixed time; only a command still being said then is waited for: until its speech
 * ended SPEECH_GRACE_MS ago (the recogniser needs that to deliver the words), at most MAX_GRACE_MS past the end.
 */
const SPEECH_GRACE_MS = 1200;
const MAX_GRACE_MS = 2500;
const GRACE_POLL_MS = 200;
/** a tap on the word of a Listening stop is "I don't know" once this passed without a second tap (a double tap = "I know") */
const DOUBLE_TAP_MS = 250;

/** runExplanation's optional inputs */
interface RunOpts {
  /** kind 'question': what the learner asked */
  question?: string;
  /** the second, deeper explanation ("I don't know" after an explanation) */
  again?: boolean;
  /** kind 'question': spoken (voice chat) rather than typed */
  spoken?: boolean;
  /** Listening stop: the request started when the book paused at the word (it is not sent again) */
  prepared?: PreparedExplanation;
  /** the first of its sentences starts being said (the learner heard some of it) */
  onHeard?: () => void;
}

function scriptSettings(s: Settings): ScriptSettings { return { ...s.listen, speakChinese: s.ai.speakChinese }; }

/** Reading mode stops after an explanation and waits; Listening mode pauses briefly and carries on. */
export type ReadMode = 'reading' | 'listening';

function scriptFor(kind: ExplainKind, target: string, sentence: string, s: Settings): ScriptStep[] {
  const shape = resolveStyle(s.ai.activeStyle, s.ai.styles).shape;
  if (kind === 'word') return styledWordScript(target, sentence, shape);
  if (kind === 'phrase' || kind === 'sentence') return styledSentenceScript(sentence, shape);
  return plainScript();
}

/**
 * Listening stop at a word or phrase: the target was already said `wordRepeats` times before the commands
 * window, so the script starts with the explanation (the style may still add the word / sentence after it).
 * Marked phrases and sentences (no lemma) keep their sentence script.
 */
function listenScriptFor(kind: ExplainKind, target: string, sentence: string, s: Settings, lemma: string | undefined): ScriptStep[] {
  if (!lemma || (kind !== 'word' && kind !== 'phrase')) return scriptFor(kind, target, sentence, s);
  const shape = resolveStyle(s.ai.activeStyle, s.ai.styles).shape;
  return styledWordScript(target, sentence, { ...shape, wordBefore: 0 });
}

/** What the learner answered in a commands window (voice, K / D / Esc, or the buttons); `text` = anything else they said. */
export type WindowAnswer = 'know' | 'dont_know' | 'bye' | { text: string };
type WindowResult = WindowAnswer | 'timeout' | 'aborted';
/**
 * an open commands window of a Listening stop: resolve() ends it; speech(active) = the learner is talking / stopped;
 * heard() = the words of an utterance arrived and were not a command (ignored)
 */
interface FlowWindow { phase: 'before' | 'after'; resolve: (r: WindowResult) => void; speech: (active: boolean) => void; heard: () => void }

/**
 * A commands window is open: 'before' = the word was just said (Listening), 'after' = an explanation just
 * ended (Listening stop, a manual explanation, or Reading's answer window). `ms` is the time left.
 */
export interface CommandWindow { phase: 'before' | 'after'; ms: number; target: string; kind: ExplainKind | null }

/** A phrase found for a chapter by the AI phrase job (token indices within the sentence, end inclusive). */
export interface ChapterPhrase { start: number; end: number; text: string; lemma: string; level: string; zh?: string }

export interface TranscriptEntry {
  id: number;
  kind: ExplainKind;
  target: string;
  sentence: string;
  text: string;
  parts: ExplanationParts | null;
  status: 'thinking' | 'speaking' | 'done' | 'error' | 'skipped';
  error?: string;
  usd?: number;
  /** kind 'question': what the learner asked (typed or spoken) */
  question?: string;
  /** kind 'question': the learner spoke it (voice chat) rather than typed it */
  spoken?: boolean;
  /** word/phrase explanations: what to save in My Vocabulary */
  lemma?: string;
  position?: Position;
  chinese?: string;
  level?: string;
  /** the second, deeper explanation after "I don't know" */
  again?: boolean;
}

export interface ListenDeps {
  book: Book;
  dict: Dictionary;
  names: Set<string>;
  settings: () => Settings;
  vocab: () => VocabState;
  marked: () => MarkedRange[];
  engine: () => TtsEngine;
  explainEngine: () => TtsEngine;
  voice: () => { voiceId: string; rate: number };
  explainVoice: () => { voiceId: string; rate: number };
  zhVoiceId: () => string | null;
  /** engine used for Chinese fragments (normally the system voices) */
  zhEngine: () => TtsEngine;
  explain: (req: ExplainRequest, onDelta: (full: string) => void) => { done: Promise<{ text: string; usage: { usd: number; dailyUsd: number; monthlyUsd: number } }>; cancel(): void };
  onTranscript: (entry: TranscriptEntry) => void;
  onMarkLearning: (lemma: string) => void;
  onBudget?: (daily: number, monthly: number) => void;
  /** which screen the learner is on; default 'listening' */
  mode?: () => ReadMode;
  /** the AI's context-chosen Chinese meanings for a lemma in this chapter (chapter hints), if ready */
  contextZh?: (lemma: string) => string[] | undefined;
  /** a Listening stop starts on this word/phrase (show its dictionary card now) / is finished with it (hide the card) */
  onStopTarget?: (t: { kind: ExplainKind; target: string; lemma?: string } | null) => void;
  /** called while the script waits for the learner (quiz question); true = waiting */
  onWaiting?: (waiting: boolean) => void;
  /**
   * The learner may answer now: the pause after an explanation (Listening), a quiz wait, or a short moment after
   * an explanation in Reading mode. Voice chat opens the mic for "I know" / "I don't know" / a question while
   * it is open. Calls come in pairs (true, then false).
   */
  onPauseWindow?: (open: boolean) => void;
  /** the commands window opened / closed: the bottom bar with I know / I don't know / Go on (its end never moves) */
  onCommandWindow?: (w: CommandWindow | null) => void;
  /** above-level phrases of the sentence found by the chapter phrase job (none when absent) */
  chapterPhrases?: (pos: Position) => ChapterPhrase[] | null | undefined;
}

/** The last word/phrase/sentence explanation (what "I know" and "I don't know" refer to). */
export interface LastExplained { kind: ExplainKind; target: string; pos: Position; lemma?: string }

interface Trigger { kind: 'word' | 'phrase' | 'sentence'; token: number; end: number; target: string; lemma?: string; dict?: ExplainRequest['dict'] }

/**
 * Listening mode: decides where reading stops, runs the explanation scripts through the TTS engine,
 * and lets the learner interrupt. Also serves manual explanations (popup, E key, "last 30 seconds").
 */
export class ListenController {
  private _enabled = false;
  /** stops at hard words (the Listening screen, auto-stop on); switched off, a stop in progress ends at once */
  get enabled(): boolean { return this._enabled; }
  set enabled(v: boolean) { this._enabled = v; if (!v) this.stopInterrupt?.(); }
  /** lemma -> word offset of the sentence where it was last explained (the "not again within N words" rule) */
  private lastExplainedAt = new Map<string, number>();
  private offsetOf: (pos: Position) => number;
  /** the last word/phrase/sentence explanation, for "I don't know" (explain again) */
  private last: { kind: ExplainKind; target: string; pos: Position; dict: ExplainRequest['dict']; lemma?: string } | null = null;
  private stopTimes: number[] = [];
  private current: { cancel: () => void; lemma?: string } | null = null;
  /** lemmas the learner tapped away during a stop: known now, never explained or marked again */
  private dismissed = new Set<string>();
  /** skip() asked to end the whole stop for the current sentence, not just the current explanation */
  private skipRequested = false;
  /** a manual explanation paused the reading and will resume it when it ends */
  private pendingResume = false;
  private transcriptId = 0;
  private history: { role: 'user' | 'assistant'; text: string }[] = [];
  private historyChapter = -1;
  /** the lemma of the Listening stop being handled (tapping it away during its window = "I know") and its prepared explanation */
  private stopLemma: string | null = null;
  private stopPrepared: PreparedExplanation | null = null;
  /** ends the word repeats of the stop at once (the stop was aborted) */
  private sayStop: (() => void) | null = null;
  /** "I don't know" (the word tapped) while the stop's word was still being said: no window, the prepared explanation at once */
  private stopEarly = false;
  /** a tap on the stop's word waits DOUBLE_TAP_MS for a second tap before it counts as "I don't know" (until tapDue) */
  private tapTimer: ReturnType<typeof setTimeout> | null = null;
  private tapDue = 0;
  /** ends the Listening stop in progress at once (the controller was switched off: Reading, or auto-stop off) */
  private stopInterrupt: (() => void) | null = null;
  /**
   * per explanation (its PreparedExplanation, or a token for a live request): the texts handed to prepareSoon (the
   * window and the speaker share them), those of them already spoken, and the handles, released when it is dropped
   */
  private presynthState = new WeakMap<object, { sent: Set<string>; said: Set<string>; handles: PrepareHandle[] }>();

  constructor(private playback: Playback, private deps: ListenDeps) {
    this.offsetOf = wordOffsets(deps.book);
    playback.hooks = {
      stopAt: (pos) => this.stopAt(pos),
      stopTargets: (pos) => this.stopTargets(pos),
      onStop: (pos, token) => this.onStop(pos, token),
    };
  }

  /** Words/phrases in the sentence that would make listening mode stop. */
  triggersFor(pos: Position): Trigger[] {
    const cur = getSentence(this.deps.book, pos);
    if (!cur) return [];
    const s = this.deps.settings();
    const vocab = this.deps.vocab().words;
    // the chapter phrase job's phrases of this sentence (validated: whatever the bridge returned)
    let found: ChapterPhrase[] = [];
    try { found = this.deps.chapterPhrases?.(pos) ?? []; } catch { found = []; }
    const n = cur.sentence.tokens.length;
    const hits: PhraseHit[] = found
      .filter((h) => h && typeof h.text === 'string' && h.text.trim() && typeof h.level === 'string' && Number.isInteger(h.start) && Number.isInteger(h.end) && h.start >= 0 && h.end < n && h.start <= h.end)
      .map((h) => ({ sentenceKey: sentenceKey(pos), start: h.start, end: h.end, text: h.text.trim(), lemma: (h.lemma || h.text).toLowerCase().trim(), level: h.level as CefrLevel, zh: h.zh ?? '' }));
    const ann = annotateSentence(cur.para, cur.sentence, this.deps.dict, this.deps.names, s.learnerLevel, hits);
    const out: Trigger[] = [];
    const here = this.offsetOf(pos);
    const recently = (lemma: string) => { const at = this.lastExplainedAt.get(lemma); return at !== undefined && s.listen.repeatWindowWords > 0 && here >= at && here - at < s.listen.repeatWindowWords; };
    if (s.listen.autoExplainWords) {
      // stop at every word above the learner's level AND at every yellow "learning" word, even an easy one the
      // learner tapped: a learning word is a word they said they do not know yet
      const hard = new Set(ann.hardTokens);
      const candidates = ann.infos.map((info, i) => (info && (hard.has(i) || vocab[info.lemma] === 'learning') ? i : -1)).filter((i) => i >= 0);
      for (const ti of candidates) {
        const info = ann.infos[ti];
        if (!info) continue;
        const status = vocab[info.lemma];
        // 'learning' words (heard once, learner silent or "I don't know") are explained again, outside the window
        if (status === 'known' || status === 'ignored' || this.dismissed.has(info.lemma)) continue;
        if (recently(info.lemma)) continue;
        if (out.some((t) => t.lemma === info.lemma)) continue; // the same word twice in one sentence: one stop
        const tok = cur.sentence.tokens[ti];
        out.push({ kind: 'word', token: ti, end: ti, target: tok.text, lemma: info.lemma, dict: info.entry ? { ipa: info.entry.ipa, zh: info.entry.zh.split('\n')[0], level: info.entry.level } : null });
      }
    }
    if (s.listen.autoExplainPhrases) {
      const addPhrase = (lemma: string, start: number, end: number, above: boolean, zh: string, level: CefrLevel) => {
        const status = vocab[lemma];
        if (status === 'known' || status === 'ignored' || this.dismissed.has(lemma)) return;
        if (!above && status !== 'learning') return;
        if (recently(lemma)) return;
        if (out.some((t) => t.lemma === lemma)) return;
        const text = cur.para.text.slice(cur.sentence.tokens[start].start, cur.sentence.tokens[end].end);
        out.push({ kind: 'phrase', token: start, end, target: text, lemma, dict: { ipa: '', zh: zh.split('\n')[0], level } });
      };
      // dictionary phrases (PhraseSpan.end is exclusive; Trigger.end is inclusive like word triggers), their level
      // confirmed by the chapter job when it found them too
      for (const ph of ann.phrases) addPhrase(ph.result.lemma, ph.start, ph.end - 1, ph.above, ph.result.entry.zh, ph.level);
      // the chapter job's other phrases (idioms, phrasal verbs, slang): they stop exactly like words
      for (const h of ann.aiPhrases) addPhrase(h.lemma, h.start, h.end, h.above, h.zh ?? '', h.level);
    }
    for (const m of this.deps.marked()) {
      if (m.chapter === pos.chapter && m.paragraph === pos.paragraph && m.sentence === pos.sentence) {
        const whole = m.start <= cur.sentence.start && m.end >= cur.sentence.end;
        out.push({ kind: whole ? 'sentence' : 'phrase', token: 0, end: cur.sentence.tokens.length - 1, target: m.text, lemma: undefined });
      }
    }
    out.sort((a, b) => a.token - b.token);
    return out;
  }

  private stopAt(pos: Position): number | 'end' | null {
    // the re-read of a sentence after its stop: everything in it has been handled
    const guard = this.rereadGuard;
    this.rereadGuard = null;
    if (guard && samePosition(guard, pos)) return null;
    if (!this.enabled || this.tooManyStops()) return null;
    const triggers = this.triggersFor(pos);
    if (!triggers.length) return null;
    // stop right after the first word or phrase (a phrase after its last word); marked ranges at the sentence end
    const at = Math.min(...triggers.map((t) => (t.kind === 'word' ? t.token : t.kind === 'phrase' && t.lemma ? t.end : Infinity)));
    return Number.isFinite(at) ? at : 'end';
  }

  /**
   * The words and phrases a Listening stop in the sentence at `pos` would say `wordRepeats` times, in the order
   * listenStop() takes them, so Playback has them synthesized before the cut (the first repeat then starts at once):
   * asked for the sentence that starts (when stopAt() stops it) and for the one after it. Nothing when the controller
   * is off or in Reading mode (its stops do not repeat the word first).
   */
  private stopTargets(pos: Position): string[] {
    if (!this.enabled || (this.deps.mode?.() ?? 'listening') !== 'listening' || !(this.deps.settings().listen.wordRepeats > 0) || this.tooManyStops()) return [];
    const out: string[] = [];
    for (const t of this.triggersFor(pos).filter((t) => t.lemma).sort((a, b) => a.end - b.end)) if (t.target.trim() && !out.includes(t.target)) out.push(t.target);
    return out;
  }

  /** the learner's limit of stops per 10 minutes (Settings) is reached: the reading goes on without stopping */
  private tooManyStops(): boolean {
    const max = this.deps.settings().listen.maxStopsPer10Min;
    if (!(max > 0)) return false;
    const cutoff = Date.now() - 10 * 60 * 1000;
    this.stopTimes = this.stopTimes.filter((t) => t > cutoff);
    return this.stopTimes.length >= max;
  }

  private async onStop(pos: Position, stoppedAtToken: number | null): Promise<'next' | 'stop'> {
    const triggers = this.triggersFor(pos);
    if (!triggers.length) return 'next';
    this.stopTimes.push(Date.now());
    void stoppedAtToken;
    if ((this.deps.mode?.() ?? 'listening') === 'listening') return this.listenStop(pos, triggers);
    const cur = getSentence(this.deps.book, pos)!;
    const s = this.deps.settings();
    this.skipRequested = false;
    // Explain every hard word of the sentence in order, then phrases/sentence marks.
    const ordered = [...triggers.filter((t) => t.kind === 'word'), ...triggers.filter((t) => t.kind !== 'word')];
    for (const t of ordered) {
      if (t.lemma && (this.dismissed.has(t.lemma) || this.deps.vocab().words[t.lemma] === 'known')) continue; // tapped away meanwhile
      const script = scriptFor(t.kind, t.target, cur.text, s);
      this.last = { kind: t.kind, target: t.target, pos, dict: t.dict ?? null, lemma: t.lemma };
      const res = await this.runExplanation(t.kind, t.target, pos, cur.text, t.dict ?? null, script, t.lemma);
      if (res === 'aborted') return 'stop'; // the learner paused, seeked or stopped: the reading loop that asked is stale
      if (this.skipRequested) break;
    }
    return this.afterExplanation();
  }

  /**
   * Listening mode, the stop at a hard word or phrase (docs/RULES.md 1): the card, and at that moment the explanation
   * request (prepareExplanation: the same request the silent case needs, sent before anything is said, so it is ready
   * when the window ends); the target 3 times; a commands-only window with a fixed end ("I know" = known, the prepared
   * explanation is dropped; "go on" = dropped, the word stays learning; "I don't know", silence or anything else =
   * the prepared explanation at once, spoken as it streams); after it another window ("I don't know" = again, deeper:
   * a new request; "I know" = known; "go on" or nothing = it stays learning). The reading then goes back to the start
   * of the interrupted sentence (never the next one) and does not stop in it again.
   * Returns 'stop' always: the reading loop that asked is ended and, unless the learner paused, seeked, switched
   * to Reading or closed the reader meanwhile, a new one is started here at the sentence start.
   */
  private async listenStop(pos: Position, triggers: Trigger[]): Promise<'next' | 'stop'> {
    const cur = getSentence(this.deps.book, pos)!;
    const s = this.deps.settings();
    this.skipRequested = false;
    this.rereadGuard = pos;
    let aborted = false;
    let interrupted = false;
    let prepared: PreparedExplanation | null = null;
    /** the trigger being handled, and whether any of its explanation was heard */
    let trigger: Trigger | null = null;
    let heard = false;
    // over at once: the prepared request is dropped (synchronously), the word is not said again, the window ends. A
    // trigger none of whose explanation was heard yet is not explained: the reading stops at it again when it comes back
    // here (a resume re-reads the sentence), instead of skipping it for the repeat window. Done here, not later: a seek or
    // replay to this same sentence asks stopAt() synchronously, before this loop's finally runs.
    const interrupt = () => {
      interrupted = true;
      if (trigger && !heard) {
        if (trigger.lemma) this.lastExplainedAt.delete(trigger.lemma);
        if (this.rereadGuard && samePosition(this.rereadGuard, pos)) this.rereadGuard = null;
      }
      prepared?.cancel(); this.sayStop?.(); this.flowWin?.resolve('aborted');
    };
    // pause, seek, stop, play from elsewhere, hold (barge-in) or a manual explanation; or (stopInterrupt) the
    // controller was switched off: Reading, or auto-stop off
    const off = this.playback.on('state', (st) => { if (st !== 'explaining') { aborted = true; interrupt(); } });
    this.stopInterrupt = interrupt;
    const listening = () => (this.deps.mode?.() ?? 'listening') === 'listening';
    const over = () => aborted || interrupted || this.disposed || this.skipRequested || !listening();
    // words and phrases in reading order, marked ranges (no lemma) last
    const ordered = [...triggers.filter((t) => t.lemma).sort((a, b) => a.end - b.end), ...triggers.filter((t) => !t.lemma)];
    try {
      for (const t of ordered) {
        if (over()) break;
        if (t.lemma && (this.dismissed.has(t.lemma) || this.deps.vocab().words[t.lemma] === 'known')) continue;
        this.deps.onStopTarget?.({ kind: t.kind, target: t.target, lemma: t.lemma });
        // only this trigger is asked for now: the next one of the sentence is asked for when its own stop starts, with
        // this explanation in the history if it was heard
        prepared = null;
        trigger = t; heard = false;
        const onHeard = () => { heard = true; };
        try {
          this.last = { kind: t.kind, target: t.target, pos, dict: t.dict ?? null, lemma: t.lemma };
          this.stopLemma = t.lemma ?? null;
          this.stopEarly = false;
          // recorded now: whatever the learner answers, this word does not stop again within the repeat window
          if (t.lemma) this.lastExplainedAt.set(t.lemma, this.offsetOf(pos));
          if (t.lemma) {
            // the learner's rule: the word and its context go to the AI the moment the book pauses; the reply streams in
            // silently while the word is said 3 times and the window runs (nothing the learner says is ever added)
            prepared = this.stopPrepared = this.prepareExplanation(t, pos, cur.text);
            const said = await this.sayTarget(t.target, t.lemma, Math.max(0, s.listen.wordRepeats), over);
            if (over()) break;
            // "I don't know" (the word tapped) while it was said: no window, the prepared explanation at once
            const early = this.stopEarly && !this.dismissed.has(t.lemma);
            this.stopEarly = false;
            if (said === 'skipped' && !early) continue; // tapped away (known) while it was said
            const a: WindowResult = early ? 'dont_know' : await this.commandWindow('before', t);
            if (a === 'aborted' || over()) break;
            // "I know" (or the word tapped away / marked known meanwhile): no explanation, the prepared one is dropped
            if (a === 'know' || this.dismissed.has(t.lemma) || this.deps.vocab().words[t.lemma] === 'known') { this.dismissed.add(t.lemma); continue; }
            // "go on": no explanation, but the word is still one to learn
            if (a === 'bye') { this.deps.onMarkLearning(t.lemma); continue; }
            // "I don't know" (at once), silence or anything else (when the window ends): the prepared explanation
          }
          let res = await this.runExplanation(t.kind, t.target, pos, cur.text, t.dict ?? null, listenScriptFor(t.kind, t.target, cur.text, s, t.lemma), t.lemma, { prepared: prepared ?? undefined, onHeard });
          if (res === 'aborted' || over()) break;
          if (res === 'skipped') continue;
          for (;;) {
            const a = await this.commandWindow('after', t);
            if (a === 'aborted' || over()) break;
            if (a === 'dont_know') {
              // again, harder and deeper: a new request, spoken as it streams
              res = await this.runExplanation(t.kind, t.target, pos, cur.text, t.dict ?? null, listenScriptFor(t.kind, t.target, cur.text, s, t.lemma), t.lemma, { again: true, onHeard });
              if (res !== 'done' || over()) break;
              continue;
            }
            if (a === 'know' && t.lemma) this.dismissed.add(t.lemma);
            break; // "go on", nothing, or "I know": the word stays as it is (learning unless known now)
          }
        } finally {
          // interrupted before any of its explanation was heard (interrupt() made the reading stop at it again):
          // runExplanation, ending after that, recorded the word as explained once more
          if (interrupted && t.lemma && !heard) this.lastExplainedAt.delete(t.lemma);
          prepared?.cancel(); // not taken: "I know", "go on", tapped away, or the stop was aborted (no-op once taken)
          this.stopLemma = null; this.stopPrepared = null; this.stopEarly = false;
          if (this.tapTimer) { clearTimeout(this.tapTimer); this.tapTimer = null; }
          trigger = null;
          this.deps.onStopTarget?.(null);
        }
      }
    } finally {
      off();
      if (this.stopInterrupt === interrupt) this.stopInterrupt = null;
    }
    if (aborted || this.disposed || !listening()) return 'stop';
    if (this.held || this.current) return 'stop'; // the learner is talking / a newer explanation resumes the reading
    // back to the start of the interrupted sentence (the guard keeps it from stopping there again)
    this.rereadGuard = pos;
    this.playback.play(pos);
    return 'stop';
  }

  /** Says the word or phrase `times` times with the reading voice (slowly); 'skipped' when it was cancelled. */
  private async sayTarget(target: string, lemma: string | undefined, times: number, over: () => boolean = () => false): Promise<'done' | 'skipped'> {
    let cancelled = false;
    let handle: SpeakHandle | null = null;
    let wake: (() => void) | null = null;
    const mine = { cancel: () => { if (cancelled) return; cancelled = true; handle?.cancel(); wake?.(); this.deps.engine().cancelAll(); }, lemma };
    this.current = mine;
    // the stop was aborted (pause, seek, stop: the engine was already cancelled): end now, without touching the engine
    const stop = () => { if (cancelled) return; cancelled = true; handle?.cancel(); wake?.(); };
    this.sayStop = stop;
    try {
      for (let i = 0; i < times && !cancelled; i++) {
        if (i > 0) await new Promise<void>((r) => { const tm = setTimeout(r, 350); wake = () => { clearTimeout(tm); r(); }; });
        wake = null;
        // paused, seeked or stopped meanwhile (that cancelled the word being said): no more repeats
        if (cancelled || over()) break;
        const v = this.deps.voice();
        const h = this.deps.engine().speak(target, { voiceId: v.voiceId, rate: Math.min(v.rate, 0.9) });
        handle = h;
        await h.done;
        handle = null;
      }
    } finally { if (this.current === mine) this.current = null; if (this.sayStop === stop) this.sayStop = null; }
    return cancelled ? 'skipped' : 'done';
  }

  /**
   * The commands window of a Listening stop: the mic listens, nothing is said; ends on an answer or after
   * commandWindowMs. The end is fixed: speech does not move it (docs/RULES.md 1.3), only a command still being said
   * then is waited for (SPEECH_GRACE_MS after the speech ended, at most MAX_GRACE_MS more).
   */
  private async commandWindow(phase: 'before' | 'after', t: Trigger): Promise<WindowResult> {
    if (this.disposed) return 'aborted';
    const ms = this.deps.settings().listen.commandWindowMs ?? 5000;
    if (!(ms > 0)) return 'timeout';
    this.deps.onPauseWindow?.(true);
    this.deps.onCommandWindow?.({ phase, ms, target: t.target, kind: t.kind });
    const res = await new Promise<WindowResult>((resolve) => {
      const deadline = Date.now() + ms;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let speaking = false;
      let lastSpeechEnd = -Infinity;
      /** utterances that ended during the window, and how many of them brought words that were not a command */
      let ended = 0;
      let ignored = 0;
      const check = () => {
        timer = undefined;
        const now = Date.now();
        // a tap on the word waits for its double-tap time (at most DOUBLE_TAP_MS): the window ends with its answer
        if (this.tapTimer) { timer = setTimeout(check, Math.max(1, Math.min(GRACE_POLL_MS, this.tapDue - now))); return; }
        const graceEnd = Math.min(speaking ? Infinity : lastSpeechEnd + SPEECH_GRACE_MS, deadline + MAX_GRACE_MS);
        if (now >= graceEnd) win.resolve('timeout');
        else timer = setTimeout(check, Math.min(GRACE_POLL_MS, graceEnd - now));
      };
      const win: FlowWindow = {
        phase,
        resolve: (r: WindowResult) => { if (timer) clearTimeout(timer); timer = undefined; if (this.flowWin === win) this.flowWin = null; resolve(r); },
        speech: (active: boolean) => { speaking = active; if (!active) { lastSpeechEnd = Date.now(); ended++; } },
        heard: () => {
          ignored = Math.min(ignored + 1, ended);
          // the words of every utterance are in and none was a command: no reason to wait past the end (repeating the
          // word does not make the window longer); past it, the window ends now
          if (speaking || ignored < ended) return;
          lastSpeechEnd = -Infinity;
          if (Date.now() >= deadline) { if (timer) clearTimeout(timer); check(); }
        },
      };
      this.flowWin = win;
      timer = setTimeout(check, ms);
    });
    this.deps.onPauseWindow?.(false);
    this.deps.onCommandWindow?.(null);
    return res;
  }
  private flowWin: FlowWindow | null = null;
  /** the sentence a Listening stop resumes at: its next read does not stop again */
  private rereadGuard: Position | null = null;

  /**
   * The learner answered in the commands window of a Listening stop. Returns false when no such window is open
   * (or, after the explanation, for a question: that is answered as a question), so the caller does what it does
   * outside a stop. The caller saves "I know" (vocabulary) itself.
   */
  answerWindow(a: WindowAnswer): boolean {
    const w = this.flowWin;
    if (!w) return false;
    // anything other than the three commands (the learner repeating the word, a question) is swallowed: the window
    // only takes commands and never sends speech to the AI
    if (typeof a === 'object') { w.heard(); return true; }
    w.resolve(a);
    return true;
  }

  /** Which commands window of a Listening stop is open, if any. */
  get stopWindow(): 'before' | 'after' | null { return this.flowWin?.phase ?? null; }

  /** Listening: a short silence, then the book continues. Reading: stop and wait for the learner. */
  private async afterExplanation(): Promise<'next' | 'stop'> {
    if ((this.deps.mode?.() ?? 'listening') === 'reading') { this.readingWindow(); return 'stop'; }
    const ms = this.deps.settings().listen.pauseAfterExplainMs;
    if (ms > 0 && !this.skipRequested) {
      const startState = this.playback.state;
      let changed = false;
      let wakeMine: (() => void) | null = null;
      let extendMine: ((more: number) => void) | null = null;
      // pause, seek, a chapter change or play from elsewhere ends the pause at once: the reading that waits here is
      // stale, and the voice window must not stay open (listening to the book) while the new reading goes on
      const off = this.playback.on('state', (st) => { if (st !== startState) { changed = true; (wakeMine as (() => void) | null)?.(); } });
      const info = (left: number): CommandWindow => ({ phase: 'after', ms: left, target: this.last?.target ?? '', kind: this.last?.kind ?? null });
      this.deps.onPauseWindow?.(true);
      this.deps.onCommandWindow?.(info(ms));
      await new Promise<void>((r) => {
        let t = setTimeout(r, ms);
        wakeMine = this.wakeAfter = () => { clearTimeout(t); r(); };
        extendMine = this.extendAfter = (more) => { clearTimeout(t); t = setTimeout(r, more); this.deps.onCommandWindow?.(info(more)); };
      });
      if (this.wakeAfter === wakeMine) this.wakeAfter = null;
      if (this.extendAfter === extendMine) this.extendAfter = null;
      off();
      this.deps.onPauseWindow?.(false);
      this.deps.onCommandWindow?.(null);
      if (changed || this.playback.state === 'idle') return 'stop';
      // the learner switched to Reading during the pause: Reading stays where it is
      if ((this.deps.mode?.() ?? 'listening') === 'reading') return 'stop';
    }
    return 'next';
  }

  /** Reading mode: no pause (the book stays stopped), but the learner may still answer for a moment. */
  private readingWindow(): void {
    const ms = this.deps.settings().listen.pauseAfterExplainMs;
    if (!this.deps.onPauseWindow || ms <= 0 || this.disposed) return;
    if (this.readingWindowTimer) clearTimeout(this.readingWindowTimer); else this.deps.onPauseWindow(true);
    this.deps.onCommandWindow?.({ phase: 'after', ms, target: this.last?.target ?? '', kind: this.last?.kind ?? null });
    this.readingWindowTimer = setTimeout(() => { this.readingWindowTimer = null; this.deps.onPauseWindow?.(false); this.deps.onCommandWindow?.(null); }, ms);
  }
  private readingWindowTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /**
   * The reader closed (or the book changed): the running explanation is cancelled and every wait (the pause after
   * an explanation, a quiz wait, the Reading answer window) ends now, so no timer fires into a closed screen.
   */
  dispose(): void {
    if (this.disposed) return;
    this.skip();
    this.wakeAfter?.(); this.wakeWait?.();
    this.flowWin?.resolve('aborted');
    if (this.tapTimer) { clearTimeout(this.tapTimer); this.tapTimer = null; }
    if (this.readingWindowTimer) { clearTimeout(this.readingWindowTimer); this.readingWindowTimer = null; this.deps.onPauseWindow?.(false); this.deps.onCommandWindow?.(null); }
    this.disposed = true;
    this.rereadGuard = null;
    this.held = false; this.heldResume = false; this.pendingResume = false;
  }

  /** Ends the current wait (the pause after an explanation, or a quiz wait) without cancelling anything. */
  continueNow(): void { this.flowWin?.resolve('bye'); this.wakeAfter?.(); this.wakeWait?.(); this.closeReadingWindow(); }
  /**
   * The learner started talking during a pause. A stop's commands window only notes it (its end does not move; a
   * command still being said when it ends is waited for); the pause after a manual explanation waits `ms` more.
   */
  keepWaiting(ms = 5000): void { if (this.flowWin) this.flowWin.speech(true); else this.extendAfter?.(ms); }
  /** The learner stopped talking (voice chat): a stop's commands window may end once their words had time to arrive. */
  windowSpeechEnded(): void { this.flowWin?.speech(false); }
  private closeReadingWindow(): void { if (this.readingWindowTimer) { clearTimeout(this.readingWindowTimer); this.readingWindowTimer = null; this.deps.onPauseWindow?.(false); this.deps.onCommandWindow?.(null); } }
  private wakeAfter: (() => void) | null = null;
  private extendAfter: ((ms: number) => void) | null = null;
  private wakeWait: (() => void) | null = null;
  /** the learner is talking (voice chat): no explanation may resume the reading until they asked or gave up */
  private held = false;

  /** What "I know" / "I don't know" refer to: the last word, phrase or sentence explained. */
  get lastExplained(): LastExplained | null { const l = this.last; return l ? { kind: l.kind, target: l.target, pos: l.pos, lemma: l.lemma } : null; }

  /**
   * The learner started talking (voice chat barge-in): the explanation or reply being spoken is cancelled and
   * the reading pauses. Returns whether the reading was going on (so the reply to the learner's question can
   * resume it in Listening mode). Ended by the next explainNow() or by release().
   */
  hold(): boolean {
    const st = this.playback.state;
    const wasPlaying = st === 'playing' || st === 'explaining' || (this.current !== null && this.pendingResume) || (this.held && this.heldResume);
    this.held = true; this.heldResume = wasPlaying;
    this.current?.cancel();
    this.wakeAfter?.(); this.wakeWait?.();
    this.playback.pause();
    return wasPlaying;
  }
  private heldResume = false;

  /**
   * The learner said nothing after all (noise) or ended the call: the reading resumes if it was going when
   * hold() paused it and `resume` allows it (Listening yes, Reading no).
   */
  release(resume = true): void {
    if (!this.held) return;
    const was = this.heldResume;
    this.held = false; this.heldResume = false;
    if (!resume || !was || this.current || this.disposed) return;
    const st = this.playback.state;
    if (st === 'playing' || st === 'explaining') return;
    this.playback.play();
  }

  /** true between hold() and the next explanation / release() */
  get holding(): boolean { return this.held; }

  /** Manual explanation from the popup, the E key or a selection. Pauses reading, explains, resumes. */
  async explainNow(kind: ExplainKind, target: string, pos: Position, dict: ExplainRequest['dict'], lemma?: string, question?: string, resumeAfter?: boolean, again?: boolean, spoken?: boolean): Promise<void> {
    // the word of a Listening stop tapped while it is said or a window of the stop is open: that is "I don't know"
    // inside the stop (before the explanation the prepared one at once, after it again and deeper; then the sentence
    // again). Pausing for a manual explanation would drop the prepared reply, ask again and go on at the next sentence.
    if (lemma && lemma === this.stopLemma && !question && (kind === 'word' || kind === 'phrase') && (this.flowWin || this.stopRepeating)) { this.tapStopWord(lemma); return; }
    if (this.held) { resumeAfter = (resumeAfter ?? false) || this.heldResume; this.held = false; this.heldResume = false; }
    this.closeReadingWindow();
    const wasPlaying = this.beginManual(resumeAfter);
    const resumeAt = this.playback.position;
    const cur = getSentence(this.deps.book, pos);
    const sentence = cur?.text ?? target;
    const s = this.deps.settings();
    const script = scriptFor(kind, target, sentence, s);
    if (kind === 'word' || kind === 'phrase' || kind === 'sentence') this.last = { kind, target, pos, dict, lemma };
    const res = await this.runExplanation(kind, target, pos, sentence, dict, script, lemma, { question, again, spoken });
    const readOn = kind === 'word' || kind === 'phrase' || kind === 'sentence' ? nextPosition(this.deps.book, pos) ?? pos : pos;
    // Reading mode: stop and wait. Listening mode: the pause, then on with the book.
    const listening = (this.deps.mode?.() ?? 'listening') === 'listening';
    const resume = wasPlaying && listening && res !== 'aborted' && (res !== 'done' || (await this.afterExplanation()) === 'next');
    // nothing to resume (Reading, or the book was not playing): the learner may still answer for a moment
    // ('aborted' with an idle playback = the book was never started, e.g. a word tapped before pressing play)
    const finished = res === 'done' || (res === 'aborted' && !wasPlaying && this.playback.state === 'idle');
    if (finished && !this.current && (!wasPlaying || !listening)) this.readingWindow();
    this.endManual(resume, res, resumeAt, readOn);
  }

  /** "Explain the last N seconds": the sentences spoken recently, extended to whole sentences. */
  async explainLast(seconds: number): Promise<void> {
    const wasPlaying = this.beginManual();
    const resumeAt = this.playback.position;
    let positions = this.playback.sentencesInLast(seconds);
    if (!positions.length) positions = [this.playback.position];
    // extend backwards to at least two sentences for context
    while (positions.length < 2) { const p = prevPosition(this.deps.book, positions[0]); if (!p) break; positions.unshift(p); }
    const texts = positions.map((p) => getSentence(this.deps.book, p)?.text ?? '').filter(Boolean);
    const passage = texts.join(' ');
    const first = positions[0];
    const res = await this.runExplanation('passage', passage, first, passage, null, plainScript());
    this.endManual(wasPlaying, res, resumeAt, resumeAt);
  }

  /** Pauses the reading for a manual explanation; returns whether it should resume afterwards. */
  private beginManual(resumeAfter?: boolean): boolean {
    const st = this.playback.state;
    // a manual explanation that interrupts another one inherits its promise to resume the reading
    const wasPlaying = resumeAfter ?? (st === 'playing' || st === 'explaining' || (this.current !== null && this.pendingResume));
    this.current?.cancel();
    this.playback.pause();
    this.wakeAfter?.(); // a pause after an explanation ends here (the playback state changed: it will not resume by itself)
    this.pendingResume = wasPlaying;
    return wasPlaying;
  }

  private endManual(wasPlaying: boolean, res: 'done' | 'skipped' | 'aborted', resumeAt: Position, readOn: Position): void {
    if (this.current || this.disposed) return; // a newer explanation took over and resumes the reading when it ends
    if (this.held) { this.heldResume = this.heldResume || wasPlaying; this.pendingResume = false; return; } // the learner is talking: their question decides
    this.pendingResume = false;
    // Resume only if the learner did not meanwhile navigate (seek) or start playing by other means.
    if (!wasPlaying || res === 'aborted') return;
    const st = this.playback.state;
    if (st === 'playing' || st === 'explaining' || !samePosition(this.playback.position, resumeAt)) return;
    this.playback.play(readOn);
  }

  /**
   * "I don't know": the last explanation again, deeper; the word stays learning and will be explained again later.
   * During a Listening stop (the card's button, the Listening button, E) it answers the stop instead.
   */
  async explainAgain(): Promise<void> {
    if (this.stopDontKnow()) return;
    const l = this.last;
    if (!l) return;
    await this.explainNow(l.kind, l.target, l.pos, l.dict, l.lemma, undefined, undefined, true);
  }

  /** the stop's word is being said (its repeats), the prepared explanation not taken yet */
  private get stopRepeating(): boolean { return this.sayStop !== null && this.stopPrepared?.status === 'running'; }

  /** The word of a Listening stop is being said (its repeats), so the card's ▶ has nothing to add. */
  get sayingStopWord(): boolean { return this.sayStop !== null; }

  /**
   * "I don't know" during a Listening stop: an open window of the stop ends with it (before the explanation: the
   * prepared one at once; after it: again and deeper, inside the stop); while the word is still being said the repeats
   * end and the window is skipped. False when no stop waits for an answer.
   */
  private stopDontKnow(): boolean {
    if (this.flowWin) { this.flowWin.resolve('dont_know'); return true; }
    if (this.stopRepeating) { this.stopEarly = true; this.sayStop?.(); return true; }
    return false;
  }

  /** A tap on the stop's word: "I don't know" once DOUBLE_TAP_MS passed without the second tap of a double tap ("I know"). */
  private tapStopWord(lemma: string): void {
    if (this.tapTimer) clearTimeout(this.tapTimer);
    this.tapDue = Date.now() + DOUBLE_TAP_MS;
    this.tapTimer = setTimeout(() => {
      this.tapTimer = null;
      if (this.stopLemma === lemma && !this.dismissed.has(lemma) && this.deps.vocab().words[lemma] !== 'known') this.stopDontKnow();
    }, DOUBLE_TAP_MS);
  }

  /** "I know": known now, never explained or highlighted again. */
  markKnown(lemma: string): void { this.dismiss(lemma); }

  /** Interrupts the current explanation (or the commands window of a stop); Listening re-reads the interrupted sentence and goes on. */
  skip(): void { this.skipRequested = true; this.current?.cancel(); this.flowWin?.resolve('bye'); }

  /** true while an explanation (automatic or manual) is being fetched or spoken */
  get busy(): boolean { return this.current !== null; }

  /** The learner tapped a highlighted word while listening: it is known now, and never stops again. */
  dismiss(lemma: string): void {
    this.dismissed.add(lemma);
    if (this.current && this.current.lemma === lemma) this.current.cancel();
    // tapped away (or "I know") during its stop: the prepared explanation is dropped, and an open window ends as "I know"
    if (this.stopLemma === lemma) { this.stopPrepared?.cancel(); this.flowWin?.resolve('know'); }
  }

  /** The request runExplanation sends (and a Listening stop prepares): the book context, the chapter history, the style. */
  private buildRequest(kind: ExplainKind, target: string, pos: Position, sentence: string, dict: ExplainRequest['dict'], opts: { question?: string; again?: boolean } = {}): ExplainRequest {
    if (this.historyChapter !== pos.chapter) { this.history = []; this.historyChapter = pos.chapter; }
    const s0 = this.deps.settings();
    const ctx = contextAround(this.deps.book, pos, s0.ai.contextWordsBefore, s0.ai.contextWordsAfter);
    const { question, again } = opts;
    return {
      kind, target, sentence,
      before: ctx.before, after: ctx.after,
      book: { title: this.deps.book.title, chapter: this.deps.book.chapters[pos.chapter]?.title ?? '' },
      dict: dict ?? undefined, question,
      // what the learner said before a word explanation: the styled prompt reads the history, so it goes there too
      // (the rules tell the AI it may be badly recognised)
      history: question && kind !== 'question' ? [...this.history, { role: 'user', text: `(said aloud just now, speech recognition may be wrong) ${question}` }] : [...this.history],
      position: { chapter: pos.chapter, paragraph: pos.paragraph, sentence: pos.sentence },
      styleId: s0.ai.activeStyle,
      again,
    };
  }

  /**
   * Listening stop: starts the explanation request now (the same request the silent case would send after the window)
   * and synthesizes its first sentences as they arrive, so the explanation can start the moment the window ends.
   * Its usage reaches the budget warning when it completes, spoken or not (the tokens are spent either way).
   */
  private prepareExplanation(t: Trigger, pos: Position, sentence: string): PreparedExplanation {
    const req = this.buildRequest(t.kind, t.target, pos, sentence, t.dict ?? null);
    const splitter = new StreamSentenceSplitter({ firstMaxChars: FIRST_PIECE_CHARS });
    const plan = new SpokenPlan({ pauses: true });
    let sentences = 0;
    let prepared: PreparedExplanation | null = null;
    const feed = (pieces: SentencePiece[]) => {
      if (!prepared || prepared.status !== 'running') return; // once taken, the speaker prepares the rest itself
      const texts: string[] = [];
      for (const p of pieces) {
        if (sentences >= PRESYNTH_SENTENCES) break;
        const en = englishTexts(plan.parts(p.text));
        if (en.length) { sentences++; texts.push(...en); }
      }
      this.presynth(prepared, texts);
    };
    prepared = new PreparedExplanation(this.deps.explain, req, {
      onText: (full) => feed(splitter.pushPieces(full)),
      onDone: (text, usage) => { feed(splitter.flushPieces(text)); this.deps.onBudget?.(usage.dailyUsd, usage.monthlyUsd); },
      // "I know", "go on", tapped away or the stop was aborted: its sentences queued for synthesis go too
      onCancel: () => { if (prepared) this.releasePresynth(prepared); },
    });
    return prepared;
  }

  /**
   * Hands these English texts of an explanation (exactly as its speaker will say them) to the explanation voice's
   * prepareSoon, each text once per explanation (`owner`): a local voice at most PRESYNTH_MAX ahead of the speaker,
   * a voice that costs money per character only the first CLOUD_PRESYNTH of the explanation.
   */
  private presynth(owner: object, texts: string[]): void {
    if (!texts.length) return;
    const eng = this.deps.explainEngine();
    if (!eng.prepareSoon) return;
    let st = this.presynthState.get(owner);
    if (!st) { st = { sent: new Set(), said: new Set(), handles: [] }; this.presynthState.set(owner, st); }
    let room = eng.kind === 'local' ? PRESYNTH_MAX - (st.sent.size - st.said.size) : CLOUD_PRESYNTH - st.sent.size;
    const fresh: string[] = [];
    for (const text of texts) {
      if (room <= 0) break;
      if (st.sent.has(text)) continue;
      st.sent.add(text); fresh.push(text); room--;
    }
    if (fresh.length) st.handles.push(eng.prepareSoon(fresh, this.deps.explainVoice().voiceId));
  }

  /** The speaker started this text of the explanation: one more may be synthesized ahead. */
  private presynthSaid(owner: object, text: string): void {
    const st = this.presynthState.get(owner);
    if (st?.sent.has(text)) st.said.add(text);
  }

  /** The explanation was dropped or cut short: what was queued for synthesis for it is dropped too. */
  private releasePresynth(owner: object): void {
    const st = this.presynthState.get(owner);
    if (st) for (const h of st.handles.splice(0)) h.release();
  }

  /**
   * Fetches and speaks one explanation. 'skipped' = the learner interrupted it (skip, dismiss, a newer
   * explanation); 'aborted' = the playback state changed underneath it (pause, seek, stop, play), so the
   * caller must not continue the stop it belongs to. Word, phrase, sentence and question replies are spoken sentence
   * by sentence as they arrive, with every arrived sentence synthesized ahead; a prepared request (Listening stop) is
   * taken over instead of sending a new one. Only an explanation that was heard joins the chapter history.
   */
  private async runExplanation(kind: ExplainKind, target: string, pos: Position, sentence: string, dict: ExplainRequest['dict'], script: ScriptStep[], lemma?: string, opts: RunOpts = {}): Promise<'done' | 'skipped' | 'aborted'> {
    const { question, again, spoken } = opts;
    const entry: TranscriptEntry = { id: ++this.transcriptId, kind, target, sentence, text: '', parts: null, status: 'thinking', ...(kind === 'question' ? { question, spoken } : {}), ...(lemma ? { lemma, position: { chapter: pos.chapter, paragraph: pos.paragraph, sentence: pos.sentence }, chinese: dict?.zh ?? undefined, level: dict?.level ?? undefined, again: !!again } : {}) };
    // the transcript: every status change at once (the first 'thinking' links the card, 'done' saves the word), the
    // streamed text at most every TRANSCRIPT_MS (each update re-renders the reader)
    let sentAt = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const publish = (status: boolean) => {
      if (trailing) { clearTimeout(trailing); trailing = null; }
      const wait = status ? 0 : sentAt + TRANSCRIPT_MS - Date.now();
      if (wait <= 0) { sentAt = Date.now(); this.deps.onTranscript({ ...entry }); return; }
      trailing = setTimeout(() => { trailing = null; sentAt = Date.now(); this.deps.onTranscript({ ...entry }); }, wait);
    };
    publish(true);
    let cancelled = false;
    let aborted = false;
    let ended = false;
    let activeHandle: { cancel(): void } | null = null;
    const prose = kind === 'word' || kind === 'phrase' || kind === 'sentence';
    // questions and prose explanations are spoken sentence by sentence as the reply streams in
    const streamed = kind === 'question' || prose;
    const splitter = new StreamSentenceSplitter({ firstMaxChars: FIRST_PIECE_CHARS });
    const plan = new SpokenPlan({ pauses: prose });
    const ready: { parts: SpokenPart[]; paragraph: boolean; text: string }[] = [];
    let notify: (() => void) | null = null;
    // whose sentences are synthesized ahead: the prepared request's (the window already sent the first ones)
    const owner: object = opts.prepared ?? {};
    // every sentence that has arrived is synthesized ahead, so none waits for its audio when its turn comes
    const lookAhead = () => this.presynth(owner, ready.flatMap((r) => englishTexts(r.parts)));
    const arrive = (pieces: SentencePiece[]) => {
      if (!pieces.length) return;
      for (const p of pieces) ready.push({ parts: plan.parts(p.text), paragraph: p.paragraph, text: p.text });
      lookAhead();
      notify?.();
    };
    const onDelta = (full: string) => {
      if (ended) return;
      entry.text = full; publish(false);
      if (streamed) arrive(splitter.pushPieces(full));
    };
    // a prepared request (Listening stop) is taken over (its usage went to the budget warning when it completed);
    // a live one goes through PreparedExplanation too, for the same usage report and stall guard
    const ai = opts.prepared?.take(onDelta)
      ?? new PreparedExplanation(this.deps.explain, this.buildRequest(kind, target, pos, sentence, dict, { question, again }), { onDone: (_t, u) => this.deps.onBudget?.(u.dailyUsd, u.monthlyUsd) }).take(onDelta)!;
    let settled = false;
    ai.done.then(() => { settled = true; }, () => { settled = true; }); // (a cancelled reply may never be awaited)
    let wake: (() => void) | null = null;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      ai.cancel(); activeHandle?.cancel(); wake?.(); this.deps.explainEngine().cancelAll(); this.deps.zhEngine().cancelAll();
      this.releasePresynth(owner);
    };
    const mine = { cancel, lemma };
    this.current = mine;
    // the chapter history only holds explanations the learner actually heard: added once the reply is complete and
    // its first sentence has started (a reply dropped by "I know" never reaches the next request)
    let reply: string | null = null;
    let heard = false;
    const hear = () => { if (heard) return; heard = true; opts.onHeard?.(); };
    let committed = false;
    const commit = () => {
      if (committed || reply === null || !heard) return;
      committed = true;
      if (this.historyChapter !== pos.chapter) return; // the history moved on to another chapter meanwhile
      this.history.push({ role: 'user', text: kind === 'question' ? question || target : `${kind}: ${target}` }, { role: 'assistant', text: reply });
      if (this.history.length > 12) this.history.splice(0, this.history.length - 12);
    };
    // Any change of the playback state while the explanation runs comes from outside (pause, seek, stop,
    // play, a new reading loop): the explanation must not keep talking over it.
    const startState = this.playback.state;
    const offState = this.playback.on('state', (st) => { if (st !== startState) { aborted = true; cancel(); } });
    const s = this.deps.settings();
    const chineseOn = () => this.deps.settings().ai.speakChinese && !!this.deps.zhVoiceId();
    const say = async (text: string, lang: 'en' | 'zh', role: string): Promise<boolean> => {
      if (cancelled || !text.trim()) return !cancelled;
      // any English text that still contains Chinese (answers to questions, older styles): Chinese parts go to the
      // Chinese voice, or are left out when Chinese is off; an English voice would read them as "Chinese letter"
      if (lang === 'en' && /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(text)) {
        for (const run of splitByScript(text)) {
          if (!(await say(run.text, run.zh ? 'zh' : 'en', run.zh ? 'chinese' : role))) return false;
        }
        return !cancelled;
      }
      const engine = lang === 'zh' ? this.deps.zhEngine() : role === 'sentence' || role === 'word' ? this.deps.engine() : this.deps.explainEngine();
      const v = role === 'sentence' || role === 'word' ? this.deps.voice() : this.deps.explainVoice();
      const zhVoice = lang === 'zh' ? this.deps.zhVoiceId() : null;
      if (lang === 'zh' && !zhVoice) return !cancelled; // never let an English voice read Chinese characters
      const voiceId = zhVoice ?? v.voiceId;
      const rate = role === 'word' ? Math.min(v.rate, 0.9) : v.rate;
      const h = engine.speak(text, { voiceId, rate });
      activeHandle = h;
      const out = await h.done;
      activeHandle = null;
      return out === 'ended' && !cancelled;
    };
    const pause = (ms: number) => (cancelled ? Promise.resolve() : new Promise<void>((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; }));
    const wait = async (): Promise<void> => {
      // quiz: give the learner time to answer (voice chat or the typed box ends it early via continueNow)
      this.deps.onWaiting?.(true);
      this.deps.onPauseWindow?.(true);
      await new Promise<void>((r) => { const t = setTimeout(r, s.listen.quizWaitMs); this.wakeWait = () => { clearTimeout(t); r(); }; wake = this.wakeWait; });
      this.wakeWait = null; wake = null;
      this.deps.onPauseWindow?.(false);
      this.deps.onWaiting?.(false);
    };
    /**
     * The reply is spoken sentence by sentence as it arrives: a short pause between sentences (longer at a new
     * paragraph), [PAUSE] waits for the learner (prose), Chinese goes to the Chinese voice. A reply that fails before
     * anything was said falls back to the dictionary meaning; after that it just stops (what was heard counts).
     */
    const runStreamed = async (): Promise<boolean> => {
      let finished = false;
      let failure: (Error & { code?: string }) | null = null;
      ai.done.then((res) => {
        if (ended) return;
        entry.text = res.text; entry.usd = res.usage.usd;
        arrive(splitter.flushPieces(res.text));
        reply = res.text; commit();
      }, (e: Error & { code?: string }) => { failure = e; }).finally(() => { finished = true; notify?.(); });
      let saidAny = false;
      /** the sentences the learner has heard (begun), what is kept of a reply the AI cut short */
      let saidText = '';
      for (;;) {
        if (cancelled) return false;
        const next = ready.shift();
        if (next) {
          let gap = saidAny ? (next.paragraph ? PARAGRAPH_PAUSE_MS : SENTENCE_PAUSE_MS) : 0;
          let begun = false;
          for (const part of next.parts) {
            if (part === null) { await wait(); if (cancelled) return false; gap = 0; continue; }
            for (const st of part) {
              if (st.type !== 'say' || (st.lang === 'zh' && !chineseOn())) continue;
              if (gap) { await pause(gap); gap = 0; if (cancelled) return false; }
              if (entry.status === 'thinking') { entry.status = 'speaking'; publish(true); }
              hear(); commit();
              if (!begun) { begun = true; saidText += (saidText ? (next.paragraph ? '\n\n' : ' ') : '') + next.text.trim(); }
              if (st.lang === 'en') { this.presynthSaid(owner, st.text); lookAhead(); }
              if (!(await say(st.text, st.lang, st.role))) return false;
              saidAny = true;
            }
          }
          continue;
        }
        if (finished) break;
        await new Promise<void>((r) => { notify = r; wake = r; });
        notify = null; wake = null;
      }
      const err = failure as (Error & { code?: string }) | null;
      if (err) {
        // cut short by the AI after some of it was said (it failed or stopped answering): like an explanation the learner
        // cut short, it was heard. It stays 'speaking' (the word is learning) and what was said is what is saved.
        if (heard && err.code !== 'cancelled') { entry.error = err.message; entry.text = saidText || entry.text; entry.parts = { free: entry.text }; return false; }
        entry.status = err.code === 'cancelled' ? 'skipped' : 'error'; entry.error = err.message;
        publish(true);
        // nothing of it was said (no key, offline, the AI stopped answering): at least the dictionary meaning
        if (prose && err.code !== 'cancelled' && !cancelled && !heard && dict?.zh) await say(`${target}. ${dict.zh}`, 'en', 'explanation');
        return false;
      }
      entry.parts = { free: entry.text };
      if (prose) {
        // the two Chinese meanings that fit here, with the Chinese voice, at the end
        const zh = (lemma ? this.deps.contextZh?.(lemma)?.filter(Boolean).join('，') : undefined) || dict?.zh;
        const two = zh ? twoMeanings(zh) : '';
        if (chineseOn() && two) { await pause(300); if (!(await say(two, 'zh', 'chinese'))) return false; await pause(250); }
      }
      return true;
    };
    /** Passages ("explain the last 30 seconds"): the whole reply is parsed into its parts, then spoken. */
    const runParsed = async (): Promise<boolean> => {
      let res: { text: string; usage: { usd: number; dailyUsd: number; monthlyUsd: number } };
      try {
        res = await ai.done;
      } catch (e) {
        const err = e as Error & { code?: string };
        entry.status = err.code === 'cancelled' ? 'skipped' : 'error'; entry.error = err.message;
        publish(true);
        return false;
      }
      entry.text = res.text; entry.usd = res.usage.usd;
      entry.parts = parseExplanation(res.text, kind); entry.status = 'speaking';
      publish(true);
      reply = res.text; if (!cancelled) hear(); commit();
      return runSteps(aiSteps(entry.parts, scriptSettings(s), !!this.deps.zhVoiceId()));
    };
    const runSteps = async (steps: AnyStep[]): Promise<boolean> => {
      for (const st of steps) {
        if (cancelled) return false;
        if (st.type === 'wait') { await wait(); continue; }
        if (st.type === 'pause') { await pause(st.ms); continue; }
        if (st.type === 'say') { if (!(await say(st.text, st.lang, st.role))) return false; continue; }
        // AI step: the reply (it was requested before the script began)
        if (!(await (streamed ? runStreamed() : runParsed()))) return false;
      }
      return true;
    };
    const completed = await runSteps(script);
    ended = true;
    offState();
    // stopped mid-way without a cancel (the voice failed): the rest of the reply and its synthesis are not needed
    if (!completed && !cancelled) { if (!settled) ai.cancel(); this.releasePresynth(owner); }
    if (this.current === mine) this.current = null;
    if (lemma) {
      // whatever happened, do not stop again for this word within the repeat window
      this.lastExplainedAt.set(lemma, this.offsetOf(pos));
      if (!this.dismissed.has(lemma) && (completed || entry.status === 'speaking' || entry.status === 'done')) this.deps.onMarkLearning(lemma);
    }
    if (entry.status !== 'error') entry.status = cancelled ? 'skipped' : 'done';
    publish(true);
    if (aborted || this.playback.state === 'idle') return 'aborted';
    return cancelled ? 'skipped' : 'done';
  }

  /** For the UI: how many times listening mode would stop in a chapter from its start. */
  countStops(chapter: number): number {
    const ch = this.deps.book.chapters[chapter];
    if (!ch) return 0;
    const s = this.deps.settings();
    const lastAt = new Map<string, number>();
    let n = 0;
    for (const para of ch.paragraphs) for (const sent of para.sentences) {
      const pos = { chapter, paragraph: para.index, sentence: sent.index };
      const here = this.offsetOf(pos);
      const ts = this.triggersFor(pos).filter((t) => !t.lemma || s.listen.repeatWindowWords === 0 || !lastAt.has(t.lemma) || here - lastAt.get(t.lemma)! >= s.listen.repeatWindowWords);
      for (const t of ts) if (t.lemma) lastAt.set(t.lemma, here);
      if (ts.length) n += 1;
    }
    return n;
  }
}

function isAbove(level: CefrLevel | null | undefined, learner: CefrLevel): boolean {
  const order = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  return !!level && order.indexOf(level) > order.indexOf(learner);
}

export { comparePositions };
