import type { Book, Position, CefrLevel } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { VocabState, MarkedRange, Settings } from '@shared/settings';
import type { ExplainRequest, ExplainKind } from '@shared/api';
import type { TtsEngine, SpeakHandle } from '@core/tts/engine';
import { samePosition, sentenceKey } from '@core/model';
import type { PhraseHit } from '@shared/api';
import { getSentence, nextPosition, prevPosition, comparePositions, contextAround, wordOffsets } from '@core/nav';
import { parseExplanation, type ExplanationParts } from '@core/ai/prompts';
import { annotateSentence } from '@core/vocab/analysis';
import { resolveStyle } from '@shared/styles';
import type { Playback } from './playback';
import { styledWordScript, styledSentenceScript, plainScript, aiSteps, proseSteps, splitByScript, type ScriptStep, type AnyStep, type ScriptSettings } from './script';
import { StreamSentenceSplitter } from './sentences';
import { cleanSpokenProse } from '@core/ai/prompts';

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
  /** the commands window opened (or its countdown restarted) / closed: the bottom bar with I know / I don't know / Go on */
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
  enabled = false;
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

  constructor(private playback: Playback, private deps: ListenDeps) {
    this.offsetOf = wordOffsets(deps.book);
    playback.hooks = {
      stopAt: (pos) => this.stopAt(pos),
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
    if (!this.enabled) return null;
    const s = this.deps.settings();
    if (s.listen.maxStopsPer10Min > 0) {
      const cutoff = Date.now() - 10 * 60 * 1000;
      this.stopTimes = this.stopTimes.filter((t) => t > cutoff);
      if (this.stopTimes.length >= s.listen.maxStopsPer10Min) return null;
    }
    const triggers = this.triggersFor(pos);
    if (!triggers.length) return null;
    // stop right after the first word or phrase (a phrase after its last word); marked ranges at the sentence end
    const at = Math.min(...triggers.map((t) => (t.kind === 'word' ? t.token : t.kind === 'phrase' && t.lemma ? t.end : Infinity)));
    return Number.isFinite(at) ? at : 'end';
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
   * Listening mode, the stop at a hard word or phrase (docs/RULES.md): the target 3 times, a silent commands window
   * ("I know" = known, no explanation; "bye bye" = no explanation; anything else or silence = the explanation,
   * which also answers what the learner said), then after the explanation another window ("I don't know" = again,
   * deeper; "I know" = known; "bye bye" or nothing = it stays learning). The reading then goes back to the start
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
    // pause, seek, stop, play from elsewhere, hold (barge-in) or a manual explanation: this stop is over at once
    const off = this.playback.on('state', (st) => { if (st !== 'explaining') { aborted = true; this.flowWin?.resolve('aborted'); } });
    const listening = () => (this.deps.mode?.() ?? 'listening') === 'listening';
    const over = () => aborted || this.disposed || this.skipRequested || !listening();
    // words and phrases in reading order, marked ranges (no lemma) last
    const ordered = [...triggers.filter((t) => t.lemma).sort((a, b) => a.end - b.end), ...triggers.filter((t) => !t.lemma)];
    try {
      for (const t of ordered) {
        if (over()) break;
        if (t.lemma && (this.dismissed.has(t.lemma) || this.deps.vocab().words[t.lemma] === 'known')) continue;
        this.deps.onStopTarget?.({ kind: t.kind, target: t.target, lemma: t.lemma });
        try {
        this.last = { kind: t.kind, target: t.target, pos, dict: t.dict ?? null, lemma: t.lemma };
        // recorded now: whatever the learner answers, this word does not stop again within the repeat window
        if (t.lemma) this.lastExplainedAt.set(t.lemma, this.offsetOf(pos));
        // The 5-second window only listens for the three commands; nothing the learner says is sent to the AI.
        let deeper = false;
        if (t.lemma) {
          const said = await this.sayTarget(t.target, t.lemma, Math.max(0, s.listen.wordRepeats));
          if (over()) break;
          if (said === 'skipped') continue; // tapped away (known) while it was said
          const a = await this.commandWindow('before', t);
          if (a === 'aborted' || over()) break;
          if (a === 'know') { this.dismissed.add(t.lemma); continue; }
          // "go on": no explanation, but the word is still one to learn
          if (a === 'bye') { if (!this.dismissed.has(t.lemma) && this.deps.vocab().words[t.lemma] !== 'known') this.deps.onMarkLearning(t.lemma); continue; }
          if (a === 'dont_know') deeper = true; // "I don't know" straight away: the fuller explanation at once
        }
        let res = await this.runExplanation(t.kind, t.target, pos, cur.text, t.dict ?? null, listenScriptFor(t.kind, t.target, cur.text, s, t.lemma), t.lemma, undefined, deeper);
        if (res === 'aborted' || over()) break;
        if (res === 'skipped') continue;
        for (;;) {
          const a = await this.commandWindow('after', t);
          if (a === 'aborted' || over()) break;
          if (a === 'dont_know') {
            res = await this.runExplanation(t.kind, t.target, pos, cur.text, t.dict ?? null, listenScriptFor(t.kind, t.target, cur.text, s, t.lemma), t.lemma, undefined, true);
            if (res !== 'done' || over()) break;
            continue;
          }
          if (a === 'know' && t.lemma) this.dismissed.add(t.lemma);
          break; // "go on", nothing, or "I know": the word stays as it is (learning unless known now)
        }
        } finally { this.deps.onStopTarget?.(null); }
      }
    } finally { off(); }
    if (aborted || this.disposed || !listening()) return 'stop';
    if (this.held || this.current) return 'stop'; // the learner is talking / a newer explanation resumes the reading
    // back to the start of the interrupted sentence (the guard keeps it from stopping there again)
    this.rereadGuard = pos;
    this.playback.play(pos);
    return 'stop';
  }

  /** Says the word or phrase `times` times with the reading voice (slowly); 'skipped' when it was cancelled. */
  private async sayTarget(target: string, lemma: string | undefined, times: number): Promise<'done' | 'skipped'> {
    let cancelled = false;
    let handle: SpeakHandle | null = null;
    let wake: (() => void) | null = null;
    const mine = { cancel: () => { if (cancelled) return; cancelled = true; handle?.cancel(); wake?.(); this.deps.engine().cancelAll(); }, lemma };
    this.current = mine;
    try {
      for (let i = 0; i < times && !cancelled; i++) {
        if (i > 0) await new Promise<void>((r) => { const tm = setTimeout(r, 350); wake = () => { clearTimeout(tm); r(); }; });
        wake = null;
        if (cancelled) break;
        const v = this.deps.voice();
        const h = this.deps.engine().speak(target, { voiceId: v.voiceId, rate: Math.min(v.rate, 0.9) });
        handle = h;
        await h.done;
        handle = null;
      }
    } finally { if (this.current === mine) this.current = null; }
    return cancelled ? 'skipped' : 'done';
  }

  /** The commands window of a Listening stop: the mic listens, nothing is said; ends on an answer or after commandWindowMs. */
  private async commandWindow(phase: 'before' | 'after', t: Trigger): Promise<WindowResult> {
    if (this.disposed) return 'aborted';
    const ms = this.deps.settings().listen.commandWindowMs ?? 5000;
    if (!(ms > 0)) return 'timeout';
    this.deps.onPauseWindow?.(true);
    this.deps.onCommandWindow?.({ phase, ms, target: t.target, kind: t.kind });
    const res = await new Promise<WindowResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const win = {
        phase,
        resolve: (r: WindowResult) => { if (timer) clearTimeout(timer); if (this.flowWin === win) this.flowWin = null; resolve(r); },
        extend: (more: number) => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => win.resolve('timeout'), more);
          this.deps.onCommandWindow?.({ phase, ms: more, target: t.target, kind: t.kind });
        },
      };
      this.flowWin = win;
      timer = setTimeout(() => win.resolve('timeout'), ms);
    });
    this.deps.onPauseWindow?.(false);
    this.deps.onCommandWindow?.(null);
    return res;
  }
  private flowWin: { phase: 'before' | 'after'; resolve: (r: WindowResult) => void; extend: (ms: number) => void } | null = null;
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
    if (typeof a === 'object') return true;
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
    if (this.readingWindowTimer) { clearTimeout(this.readingWindowTimer); this.readingWindowTimer = null; this.deps.onPauseWindow?.(false); this.deps.onCommandWindow?.(null); }
    this.disposed = true;
    this.rereadGuard = null;
    this.held = false; this.heldResume = false; this.pendingResume = false;
  }

  /** Ends the current wait (the pause after an explanation, or a quiz wait) without cancelling anything. */
  continueNow(): void { this.flowWin?.resolve('bye'); this.wakeAfter?.(); this.wakeWait?.(); this.closeReadingWindow(); }
  /** The learner started talking during the pause: give them `ms` more before the book goes on. */
  keepWaiting(ms = 5000): void { if (this.flowWin) this.flowWin.extend(ms); else this.extendAfter?.(ms); }
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
    if (this.held) { resumeAfter = (resumeAfter ?? false) || this.heldResume; this.held = false; this.heldResume = false; }
    this.closeReadingWindow();
    const wasPlaying = this.beginManual(resumeAfter);
    const resumeAt = this.playback.position;
    const cur = getSentence(this.deps.book, pos);
    const sentence = cur?.text ?? target;
    const s = this.deps.settings();
    const script = scriptFor(kind, target, sentence, s);
    if (kind === 'word' || kind === 'phrase' || kind === 'sentence') this.last = { kind, target, pos, dict, lemma };
    const res = await this.runExplanation(kind, target, pos, sentence, dict, script, lemma, question, again, spoken);
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

  /** "I don't know": the last explanation again, deeper; the word stays learning and will be explained again later. */
  async explainAgain(): Promise<void> {
    const l = this.last;
    if (!l) return;
    await this.explainNow(l.kind, l.target, l.pos, l.dict, l.lemma, undefined, undefined, true);
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
  }

  /**
   * Fetches and speaks one explanation. 'skipped' = the learner interrupted it (skip, dismiss, a newer
   * explanation); 'aborted' = the playback state changed underneath it (pause, seek, stop, play), so the
   * caller must not continue the stop it belongs to.
   */
  private async runExplanation(kind: ExplainKind, target: string, pos: Position, sentence: string, dict: ExplainRequest['dict'], script: ScriptStep[], lemma?: string, question?: string, again?: boolean, spoken?: boolean): Promise<'done' | 'skipped' | 'aborted'> {
    if (this.historyChapter !== pos.chapter) { this.history = []; this.historyChapter = pos.chapter; }
    const entry: TranscriptEntry = { id: ++this.transcriptId, kind, target, sentence, text: '', parts: null, status: 'thinking', ...(kind === 'question' ? { question, spoken } : {}), ...(lemma ? { lemma, position: { chapter: pos.chapter, paragraph: pos.paragraph, sentence: pos.sentence }, chinese: dict?.zh ?? undefined, level: dict?.level ?? undefined, again: !!again } : {}) };
    this.deps.onTranscript({ ...entry });
    const s0 = this.deps.settings();
    const ctx = contextAround(this.deps.book, pos, s0.ai.contextWordsBefore, s0.ai.contextWordsAfter);
    const req: ExplainRequest = {
      kind, target, sentence,
      before: ctx.before, after: ctx.after,
      book: { title: this.deps.book.title, chapter: this.deps.book.chapters[pos.chapter]?.title ?? '' },
      dict: dict ?? undefined, question,
      // what the learner said in the commands window before a word explanation: the styled prompt reads the history,
      // so it goes there too (the rules tell the AI it may be badly recognised)
      history: question && kind !== 'question' ? [...this.history, { role: 'user', text: `(said aloud just now, speech recognition may be wrong) ${question}` }] : [...this.history],
      position: { chapter: pos.chapter, paragraph: pos.paragraph, sentence: pos.sentence },
      styleId: s0.ai.activeStyle,
      again,
    };
    let cancelled = false;
    let aborted = false;
    let activeHandle: { cancel(): void } | null = null;
    // questions (typed or spoken) are answered sentence by sentence as the reply streams in
    const streamed = kind === 'question';
    const splitter = new StreamSentenceSplitter();
    const ready: string[] = [];
    let notify: (() => void) | null = null;
    const ai = this.deps.explain(req, (full) => {
      entry.text = full; this.deps.onTranscript({ ...entry });
      if (streamed) { const got = splitter.push(full); if (got.length) { ready.push(...got); notify?.(); } }
    });
    ai.done.catch(() => undefined); // a cancelled reply may never be awaited (interrupted before the AI step)
    let wake: (() => void) | null = null;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      ai.cancel(); activeHandle?.cancel(); wake?.(); this.deps.explainEngine().cancelAll(); this.deps.zhEngine().cancelAll();
    };
    const mine = { cancel, lemma };
    this.current = mine;
    // Any change of the playback state while the explanation runs comes from outside (pause, seek, stop,
    // play, a new reading loop): the explanation must not keep talking over it.
    const startState = this.playback.state;
    const offState = this.playback.on('state', (st) => { if (st !== startState) { aborted = true; cancel(); } });
    const s = this.deps.settings();
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
    const pause = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
    let aiParts: ExplanationParts | null = null;
    const wait = async (): Promise<void> => {
      // quiz: give the learner time to answer (voice chat or the typed box ends it early via continueNow)
      this.deps.onWaiting?.(true);
      this.deps.onPauseWindow?.(true);
      await new Promise<void>((r) => { const t = setTimeout(r, s.listen.quizWaitMs); this.wakeWait = () => { clearTimeout(t); r(); }; wake = this.wakeWait; });
      this.wakeWait = null; wake = null;
      this.deps.onPauseWindow?.(false);
      this.deps.onWaiting?.(false);
    };
    const prose = kind === 'word' || kind === 'phrase' || kind === 'sentence';
    const runSteps = async (steps: AnyStep[]): Promise<boolean> => {
      for (const st of steps) {
        if (cancelled) return false;
        if (st.type === 'wait') { await wait(); continue; }
        if (st.type === 'pause') { await pause(st.ms); continue; }
        if (st.type === 'say') { if (!(await say(st.text, st.lang, st.role))) return false; continue; }
        // AI step: wait for the reply (it was started before the script began)
        try {
          const res = await ai.done;
          entry.text = res.text; entry.usd = res.usage.usd;
          aiParts = prose ? { free: res.text } : parseExplanation(res.text, kind);
          entry.parts = aiParts; entry.status = 'speaking';
          this.deps.onTranscript({ ...entry });
          this.history.push({ role: 'user', text: kind === 'question' && question ? question : `${kind}: ${target}` }, { role: 'assistant', text: res.text });
          if (this.history.length > 12) this.history.splice(0, this.history.length - 12);
          this.deps.onBudget?.(res.usage.dailyUsd, res.usage.monthlyUsd);
        } catch (e) {
          const err = e as Error & { code?: string };
          entry.status = err.code === 'cancelled' ? 'skipped' : 'error'; entry.error = err.message;
          this.deps.onTranscript({ ...entry });
          if (err.code !== 'cancelled' && dict?.zh) {
            // offline fallback: at least say the dictionary meaning
            await say(`${target}. ${dict.zh}`, 'en', 'explanation');
          }
          return false;
        }
        const spoken = prose ? proseSteps(aiParts!.free ?? '', { zh: (lemma ? this.deps.contextZh?.(lemma)?.filter(Boolean).join('，') : undefined) || dict?.zh, speakChinese: s.ai.speakChinese, zhAvailable: !!this.deps.zhVoiceId() }) : aiSteps(aiParts!, scriptSettings(s), !!this.deps.zhVoiceId());
        if (!(await runSteps(spoken))) return false;
      }
      return true;
    };
    /** A question: each sentence of the reply is spoken as soon as it has arrived. */
    const runStreamed = async (): Promise<boolean> => {
      let finished = false;
      let failure: (Error & { code?: string }) | null = null;
      ai.done.then((res) => {
        entry.text = res.text; entry.usd = res.usage.usd;
        ready.push(...splitter.flush(res.text));
        this.history.push({ role: 'user', text: question || target }, { role: 'assistant', text: res.text });
        if (this.history.length > 12) this.history.splice(0, this.history.length - 12);
        this.deps.onBudget?.(res.usage.dailyUsd, res.usage.monthlyUsd);
      }, (e: Error & { code?: string }) => { failure = e; }).finally(() => { finished = true; notify?.(); });
      for (;;) {
        if (cancelled) return false;
        const next = ready.shift();
        if (next !== undefined) {
          const text = cleanSpokenProse(next);
          if (entry.status === 'thinking') { entry.status = 'speaking'; this.deps.onTranscript({ ...entry }); }
          if (text && !(await say(text, 'en', 'explanation'))) return false;
          continue;
        }
        if (finished) break;
        await new Promise<void>((r) => { notify = r; wake = r; });
        notify = null; wake = null;
      }
      const err = failure as (Error & { code?: string }) | null;
      if (err) {
        entry.status = err.code === 'cancelled' ? 'skipped' : 'error'; entry.error = err.message;
        this.deps.onTranscript({ ...entry });
        return false;
      }
      entry.parts = { free: entry.text };
      return true;
    };
    const completed = streamed ? await runStreamed() : await runSteps(script);
    offState();
    if (this.current === mine) this.current = null;
    if (lemma) {
      // whatever happened, do not stop again for this word within the repeat window
      this.lastExplainedAt.set(lemma, this.offsetOf(pos));
      if (!this.dismissed.has(lemma) && (completed || entry.status === 'speaking' || entry.status === 'done')) this.deps.onMarkLearning(lemma);
    }
    if (entry.status !== 'error') entry.status = cancelled ? 'skipped' : 'done';
    this.deps.onTranscript({ ...entry });
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
