import type { Book, Position, CefrLevel } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { VocabState, MarkedRange, Settings } from '@shared/settings';
import type { ExplainRequest, ExplainKind } from '@shared/api';
import type { TtsEngine } from '@core/tts/engine';
import { samePosition } from '@core/model';
import { getSentence, nextPosition, prevPosition, comparePositions, contextAround, wordOffsets } from '@core/nav';
import { parseExplanation, type ExplanationParts } from '@core/ai/prompts';
import { annotateSentence } from '@core/vocab/analysis';
import { resolveStyle } from '@shared/styles';
import type { Playback } from './playback';
import { styledWordScript, styledSentenceScript, plainScript, aiSteps, proseSteps, type ScriptStep, type AnyStep, type ScriptSettings } from './script';
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
  /** called while the script waits for the learner (quiz question); true = waiting */
  onWaiting?: (waiting: boolean) => void;
  /**
   * The learner may answer now: the pause after an explanation (Listening), a quiz wait, or a short moment after
   * an explanation in Reading mode. Voice chat opens the mic for "I know" / "I don't know" / a question while
   * it is open. Calls come in pairs (true, then false).
   */
  onPauseWindow?: (open: boolean) => void;
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
    const ann = annotateSentence(cur.para, cur.sentence, this.deps.dict, this.deps.names, s.learnerLevel);
    const out: Trigger[] = [];
    const here = this.offsetOf(pos);
    const recently = (lemma: string) => { const at = this.lastExplainedAt.get(lemma); return at !== undefined && s.listen.repeatWindowWords > 0 && here >= at && here - at < s.listen.repeatWindowWords; };
    if (s.listen.autoExplainWords) {
      for (const ti of ann.hardTokens) {
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
      for (const ph of ann.phrases) {
        const lemma = ph.result.lemma;
        const status = vocab[lemma];
        if (status === 'known' || status === 'ignored' || this.dismissed.has(lemma)) continue;
        if (!isAbove(ph.result.entry.level, s.learnerLevel)) continue;
        if (recently(lemma)) continue;
        if (out.some((t) => t.lemma === lemma)) continue;
        // PhraseSpan.end is exclusive (the last word is tokens[end - 1]); Trigger.end is inclusive like word triggers
        const text = cur.para.text.slice(cur.sentence.tokens[ph.start].start, cur.sentence.tokens[ph.end - 1].end);
        out.push({ kind: 'phrase', token: ph.start, end: ph.end - 1, target: text, lemma, dict: { ipa: '', zh: ph.result.entry.zh.split('\n')[0], level: ph.result.entry.level } });
      }
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
    if (!this.enabled) return null;
    const s = this.deps.settings();
    if (s.listen.maxStopsPer10Min > 0) {
      const cutoff = Date.now() - 10 * 60 * 1000;
      this.stopTimes = this.stopTimes.filter((t) => t > cutoff);
      if (this.stopTimes.length >= s.listen.maxStopsPer10Min) return null;
    }
    const triggers = this.triggersFor(pos);
    if (!triggers.length) return null;
    const first = triggers[0];
    if (first.kind === 'word') return first.token;
    return 'end';
  }

  private async onStop(pos: Position, stoppedAtToken: number | null): Promise<'next' | 'stop'> {
    const triggers = this.triggersFor(pos);
    if (!triggers.length) return 'next';
    this.stopTimes.push(Date.now());
    const cur = getSentence(this.deps.book, pos)!;
    const s = this.deps.settings();
    void stoppedAtToken;
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

  /** Listening: a short silence, then the book continues. Reading: stop and wait for the learner. */
  private async afterExplanation(): Promise<'next' | 'stop'> {
    if ((this.deps.mode?.() ?? 'listening') === 'reading') { this.readingWindow(); return 'stop'; }
    const ms = this.deps.settings().listen.pauseAfterExplainMs;
    if (ms > 0 && !this.skipRequested) {
      const startState = this.playback.state;
      let changed = false;
      const off = this.playback.on('state', (st) => { if (st !== startState) changed = true; });
      this.deps.onPauseWindow?.(true);
      let wakeMine: (() => void) | null = null;
      let extendMine: ((more: number) => void) | null = null;
      await new Promise<void>((r) => {
        let t = setTimeout(r, ms);
        wakeMine = this.wakeAfter = () => { clearTimeout(t); r(); };
        extendMine = this.extendAfter = (more) => { clearTimeout(t); t = setTimeout(r, more); };
      });
      if (this.wakeAfter === wakeMine) this.wakeAfter = null;
      if (this.extendAfter === extendMine) this.extendAfter = null;
      off();
      this.deps.onPauseWindow?.(false);
      if (changed || this.playback.state === 'idle') return 'stop';
    }
    return 'next';
  }

  /** Reading mode: no pause (the book stays stopped), but the learner may still answer for a moment. */
  private readingWindow(): void {
    const ms = this.deps.settings().listen.pauseAfterExplainMs;
    if (!this.deps.onPauseWindow || ms <= 0) return;
    if (this.readingWindowTimer) clearTimeout(this.readingWindowTimer); else this.deps.onPauseWindow(true);
    this.readingWindowTimer = setTimeout(() => { this.readingWindowTimer = null; this.deps.onPauseWindow?.(false); }, ms);
  }
  private readingWindowTimer: ReturnType<typeof setTimeout> | null = null;

  /** Ends the current wait (the pause after an explanation, or a quiz wait) without cancelling anything. */
  continueNow(): void { this.wakeAfter?.(); this.wakeWait?.(); this.closeReadingWindow(); }
  /** The learner started talking during the pause: give them `ms` more before the book goes on. */
  keepWaiting(ms = 5000): void { this.extendAfter?.(ms); }
  private closeReadingWindow(): void { if (this.readingWindowTimer) { clearTimeout(this.readingWindowTimer); this.readingWindowTimer = null; this.deps.onPauseWindow?.(false); } }
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
    if (!resume || !was || this.current) return;
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
    if (this.current) return; // a newer explanation took over and resumes the reading when it ends
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

  /** Interrupts the current explanation; reading continues with the next sentence. */
  skip(): void { this.skipRequested = true; this.current?.cancel(); }

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
    const entry: TranscriptEntry = { id: ++this.transcriptId, kind, target, sentence, text: '', parts: null, status: 'thinking', ...(kind === 'question' ? { question, spoken } : {}) };
    this.deps.onTranscript({ ...entry });
    const s0 = this.deps.settings();
    const ctx = contextAround(this.deps.book, pos, s0.ai.contextWordsBefore, s0.ai.contextWordsAfter);
    const req: ExplainRequest = {
      kind, target, sentence,
      before: ctx.before, after: ctx.after,
      book: { title: this.deps.book.title, chapter: this.deps.book.chapters[pos.chapter]?.title ?? '' },
      dict: dict ?? undefined, question, history: [...this.history],
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
      const engine = lang === 'zh' ? this.deps.zhEngine() : role === 'sentence' || role === 'word' ? this.deps.engine() : this.deps.explainEngine();
      const v = role === 'sentence' || role === 'word' ? this.deps.voice() : this.deps.explainVoice();
      const voiceId = lang === 'zh' ? this.deps.zhVoiceId() ?? v.voiceId : v.voiceId;
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
        const spoken = prose ? proseSteps(aiParts!.free ?? '', { zh: dict?.zh, speakChinese: s.ai.speakChinese, zhAvailable: !!this.deps.zhVoiceId() }) : aiSteps(aiParts!, scriptSettings(s), !!this.deps.zhVoiceId());
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
