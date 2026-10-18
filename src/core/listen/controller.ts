import type { Book, Position, CefrLevel } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { VocabState, MarkedRange, Settings } from '@shared/settings';
import type { ExplainRequest, ExplainKind } from '@shared/api';
import type { TtsEngine } from '@core/tts/engine';
import { samePosition } from '@core/model';
import { getSentence, nextPosition, prevPosition, comparePositions } from '@core/nav';
import { parseExplanation, type ExplanationParts } from '@core/ai/prompts';
import { annotateSentence } from '@core/vocab/analysis';
import type { Playback } from './playback';
import { wordScript, sentenceScript, plainScript, aiSteps, type ScriptStep, type ScriptSettings } from './script';

function scriptSettings(s: Settings): ScriptSettings { return { ...s.listen, speakChinese: s.ai.speakChinese }; }

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
}

interface Trigger { kind: 'word' | 'phrase' | 'sentence'; token: number; end: number; target: string; lemma?: string; dict?: ExplainRequest['dict'] }

/**
 * Listening mode: decides where reading stops, runs the explanation scripts through the TTS engine,
 * and lets the learner interrupt. Also serves manual explanations (popup, E key, "last 30 seconds").
 */
export class ListenController {
  enabled = false;
  private explainedThisChapter = new Map<number, Set<string>>();
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
    const seen = this.explainedThisChapter.get(pos.chapter) ?? new Set<string>();
    if (s.listen.autoExplainWords) {
      for (const ti of ann.hardTokens) {
        const info = ann.infos[ti];
        if (!info) continue;
        const status = vocab[info.lemma];
        if (status === 'known' || status === 'ignored' || status === 'learning' || this.dismissed.has(info.lemma)) continue;
        if (s.listen.firstOccurrencePerChapterOnly && seen.has(info.lemma)) continue;
        if (out.some((t) => t.lemma === info.lemma)) continue; // the same word twice in one sentence: one stop
        const tok = cur.sentence.tokens[ti];
        out.push({ kind: 'word', token: ti, end: ti, target: tok.text, lemma: info.lemma, dict: info.entry ? { ipa: info.entry.ipa, zh: info.entry.zh.split('\n')[0], level: info.entry.level } : null });
      }
    }
    if (s.listen.autoExplainPhrases) {
      for (const ph of ann.phrases) {
        const lemma = ph.result.lemma;
        const status = vocab[lemma];
        if (status === 'known' || status === 'ignored' || status === 'learning' || this.dismissed.has(lemma)) continue;
        if (!isAbove(ph.result.entry.level, s.learnerLevel)) continue;
        if (s.listen.firstOccurrencePerChapterOnly && seen.has(lemma)) continue;
        if (out.some((t) => t.lemma === lemma)) continue;
        const text = cur.para.text.slice(cur.sentence.tokens[ph.start].start, cur.sentence.tokens[ph.end].end);
        out.push({ kind: 'phrase', token: ph.start, end: ph.end, target: text, lemma, dict: { ipa: '', zh: ph.result.entry.zh.split('\n')[0], level: ph.result.entry.level } });
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
      const script = t.kind === 'word' ? wordScript(t.target, cur.text, scriptSettings(s)) : sentenceScript(cur.text, scriptSettings(s));
      const res = await this.runExplanation(t.kind, t.target, pos, cur.text, t.dict ?? null, script, t.lemma);
      if (res === 'aborted') return 'stop'; // the learner paused, seeked or stopped: the reading loop that asked is stale
      if (this.skipRequested) break;
    }
    return 'next';
  }

  /** Manual explanation from the popup, the E key or a selection. Pauses reading, explains, resumes. */
  async explainNow(kind: ExplainKind, target: string, pos: Position, dict: ExplainRequest['dict'], lemma?: string, question?: string, resumeAfter?: boolean): Promise<void> {
    const wasPlaying = this.beginManual(resumeAfter);
    const resumeAt = this.playback.position;
    const cur = getSentence(this.deps.book, pos);
    const sentence = cur?.text ?? target;
    const s = this.deps.settings();
    const script = kind === 'word' ? wordScript(target, sentence, scriptSettings(s)) : kind === 'phrase' || kind === 'sentence' ? sentenceScript(sentence, scriptSettings(s)) : plainScript();
    const res = await this.runExplanation(kind, target, pos, sentence, dict, script, lemma, question);
    const readOn = kind === 'word' || kind === 'phrase' || kind === 'sentence' ? nextPosition(this.deps.book, pos) ?? pos : pos;
    this.endManual(wasPlaying, res, resumeAt, readOn);
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
    this.pendingResume = wasPlaying;
    return wasPlaying;
  }

  private endManual(wasPlaying: boolean, res: 'done' | 'skipped' | 'aborted', resumeAt: Position, readOn: Position): void {
    if (this.current) return; // a newer explanation took over and resumes the reading when it ends
    this.pendingResume = false;
    // Resume only if the learner did not meanwhile navigate (seek) or start playing by other means.
    if (!wasPlaying || res === 'aborted') return;
    const st = this.playback.state;
    if (st === 'playing' || st === 'explaining' || !samePosition(this.playback.position, resumeAt)) return;
    this.playback.play(readOn);
  }

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
  private async runExplanation(kind: ExplainKind, target: string, pos: Position, sentence: string, dict: ExplainRequest['dict'], script: ScriptStep[], lemma?: string, question?: string): Promise<'done' | 'skipped' | 'aborted'> {
    if (this.historyChapter !== pos.chapter) { this.history = []; this.historyChapter = pos.chapter; }
    const entry: TranscriptEntry = { id: ++this.transcriptId, kind, target, sentence, text: '', parts: null, status: 'thinking' };
    this.deps.onTranscript({ ...entry });
    const before = prevPosition(this.deps.book, pos);
    const after = nextPosition(this.deps.book, pos);
    const req: ExplainRequest = {
      kind, target, sentence,
      before: before ? getSentence(this.deps.book, before)?.text ?? '' : '',
      after: after ? getSentence(this.deps.book, after)?.text ?? '' : '',
      book: { title: this.deps.book.title, chapter: this.deps.book.chapters[pos.chapter]?.title ?? '' },
      dict: dict ?? undefined, question, history: this.history,
    };
    let cancelled = false;
    let aborted = false;
    let activeHandle: { cancel(): void } | null = null;
    const ai = this.deps.explain(req, (full) => { entry.text = full; this.deps.onTranscript({ ...entry }); });
    ai.done.catch(() => undefined); // a cancelled reply may never be awaited (interrupted before the AI step)
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      ai.cancel(); activeHandle?.cancel(); this.deps.explainEngine().cancelAll(); this.deps.zhEngine().cancelAll();
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
    const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    let aiParts: ExplanationParts | null = null;
    const runSteps = async (steps: ScriptStep[]): Promise<boolean> => {
      for (const st of steps) {
        if (cancelled) return false;
        if (st.type === 'pause') { await pause(st.ms); continue; }
        if (st.type === 'say') { if (!(await say(st.text, st.lang, st.role))) return false; continue; }
        // AI step: wait for the reply (it was started before the script began)
        try {
          const res = await ai.done;
          entry.text = res.text; entry.usd = res.usage.usd;
          aiParts = parseExplanation(res.text, kind);
          entry.parts = aiParts; entry.status = 'speaking';
          this.deps.onTranscript({ ...entry });
          this.history.push({ role: 'user', text: `${kind}: ${target}` }, { role: 'assistant', text: res.text });
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
        if (!(await runSteps(aiSteps(aiParts!, scriptSettings(s), !!this.deps.zhVoiceId())))) return false;
      }
      return true;
    };
    const completed = await runSteps(script);
    offState();
    if (this.current === mine) this.current = null;
    if (lemma) {
      // whatever happened, do not stop again for this word in this chapter
      this.explainedThisChapter.set(pos.chapter, (this.explainedThisChapter.get(pos.chapter) ?? new Set()).add(lemma));
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
    const seen = new Set<string>();
    let n = 0;
    for (const para of ch.paragraphs) for (const sent of para.sentences) {
      const ts = this.triggersFor({ chapter, paragraph: para.index, sentence: sent.index })
        .filter((t) => !t.lemma || !s.listen.firstOccurrencePerChapterOnly || !seen.has(t.lemma));
      for (const t of ts) if (t.lemma) seen.add(t.lemma);
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
