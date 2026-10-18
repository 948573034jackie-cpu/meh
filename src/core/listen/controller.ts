import type { Book, Position, CefrLevel } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { VocabState, MarkedRange, Settings } from '@shared/settings';
import type { ExplainRequest, ExplainKind } from '@shared/api';
import type { TtsEngine } from '@core/tts/engine';
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
  private current: { cancel: () => void } | null = null;
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
        if (status === 'known' || status === 'ignored' || status === 'learning') continue;
        if (s.listen.firstOccurrencePerChapterOnly && seen.has(info.lemma)) continue;
        const tok = cur.sentence.tokens[ti];
        out.push({ kind: 'word', token: ti, end: ti, target: tok.text, lemma: info.lemma, dict: info.entry ? { ipa: info.entry.ipa, zh: info.entry.zh.split('\n')[0], level: info.entry.level } : null });
      }
    }
    if (s.listen.autoExplainPhrases) {
      for (const ph of ann.phrases) {
        const lemma = ph.result.lemma;
        const status = vocab[lemma];
        if (status === 'known' || status === 'ignored' || status === 'learning') continue;
        if (!isAbove(ph.result.entry.level, s.learnerLevel)) continue;
        if (s.listen.firstOccurrencePerChapterOnly && seen.has(lemma)) continue;
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
    // Explain every hard word of the sentence in order, then phrases/sentence marks.
    const words = triggers.filter((t) => t.kind === 'word');
    const rest = triggers.filter((t) => t.kind !== 'word');
    for (const t of words) {
      const ok = await this.runExplanation('word', t.target, pos, cur.text, t.dict ?? null, wordScript(t.target, cur.text, scriptSettings(s)), t.lemma);
      if (ok === 'aborted') return 'stop';
    }
    for (const t of rest) {
      const ok = await this.runExplanation(t.kind, t.target, pos, cur.text, t.dict ?? null, sentenceScript(cur.text, scriptSettings(s)), t.lemma);
      if (ok === 'aborted') return 'stop';
    }
    return 'next';
  }

  /** Manual explanation from the popup, the E key or a selection. Pauses reading, explains, resumes. */
  async explainNow(kind: ExplainKind, target: string, pos: Position, dict: ExplainRequest['dict'], lemma?: string, question?: string, resumeAfter?: boolean): Promise<void> {
    const wasPlaying = resumeAfter ?? this.playback.state === 'playing';
    this.current?.cancel();
    this.playback.pause();
    const cur = getSentence(this.deps.book, pos);
    const sentence = cur?.text ?? target;
    const s = this.deps.settings();
    const script = kind === 'word' ? wordScript(target, sentence, scriptSettings(s)) : kind === 'phrase' || kind === 'sentence' ? sentenceScript(sentence, scriptSettings(s)) : plainScript();
    await this.runExplanation(kind, target, pos, sentence, dict, script, lemma, question);
    if (wasPlaying) this.playback.play(kind === 'word' || kind === 'phrase' || kind === 'sentence' ? nextPosition(this.deps.book, pos) ?? pos : pos);
  }

  /** "Explain the last N seconds": the sentences spoken recently, extended to whole sentences. */
  async explainLast(seconds: number): Promise<void> {
    const wasPlaying = this.playback.state === 'playing';
    this.playback.pause();
    let positions = this.playback.sentencesInLast(seconds);
    if (!positions.length) positions = [this.playback.position];
    // extend backwards to at least two sentences for context
    while (positions.length < 2) { const p = prevPosition(this.deps.book, positions[0]); if (!p) break; positions.unshift(p); }
    const texts = positions.map((p) => getSentence(this.deps.book, p)?.text ?? '').filter(Boolean);
    const passage = texts.join(' ');
    const first = positions[0];
    await this.runExplanation('passage', passage, first, passage, null, plainScript());
    if (wasPlaying) this.playback.play(this.playback.position);
  }

  /** Interrupts the current explanation; reading continues with the next sentence. */
  skip(): void { this.current?.cancel(); }

  /** true while an explanation (automatic or manual) is being fetched or spoken */
  get busy(): boolean { return this.current !== null; }

  /** The learner tapped a highlighted word while listening: it is known now, and never stops again. */
  dismiss(lemma: string): void {
    this.current?.cancel();
    void lemma;
  }

  private async runExplanation(kind: ExplainKind, target: string, pos: Position, sentence: string, dict: ExplainRequest['dict'], script: ScriptStep[], lemma?: string, question?: string): Promise<'done' | 'aborted'> {
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
    let activeHandle: { cancel(): void } | null = null;
    const ai = this.deps.explain(req, (full) => { entry.text = full; this.deps.onTranscript({ ...entry }); });
    this.current = { cancel: () => { cancelled = true; ai.cancel(); activeHandle?.cancel(); this.deps.explainEngine().cancelAll(); this.deps.zhEngine().cancelAll(); } };
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
    this.current = null;
    if (lemma) {
      // whatever happened, do not stop again for this word in this chapter
      this.explainedThisChapter.set(pos.chapter, (this.explainedThisChapter.get(pos.chapter) ?? new Set()).add(lemma));
      if (completed || entry.status === 'speaking' || entry.status === 'done') this.deps.onMarkLearning(lemma);
    }
    if (entry.status !== 'error') entry.status = cancelled ? 'skipped' : 'done';
    this.deps.onTranscript({ ...entry });
    return cancelled && this.playback.state === 'idle' ? 'aborted' : 'done';
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
