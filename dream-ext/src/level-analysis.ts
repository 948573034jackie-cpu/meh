/**
 * Analyze once: the AI writes the explanations of the coming stops in one go, they are saved with the video, and the
 * stops only read them: no AI call at a stop, none when the video is watched again. It works ahead of where the learner
 * is, a part at a time, so a video left after two minutes does not pay for the rest.
 */
import type { PromptBundle } from '@core/ai/prompts';
import { RuleGuard, ruleSystem } from './level-rule';

export interface AnalysisStop { id: string; index: number; text: string; items: string[] }

/** explanations written in one call */
export const STOPS_PER_PART = 20;
/** the next part starts when fewer explained stops than this are left ahead */
export const LOOK_AHEAD = 6;

/** what identifies a sentence (its words): the same however the video's sentences are numbered later */
export function analysisId(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** All the sentences around these stops, numbered; the stops marked with * and what is hard in them. */
export function buildAnalysisPrompt(o: { title: string; level: string; part: readonly AnalysisStop[]; lineAt: (index: number) => string; total: number }): PromptBundle {
  const stops = new Map(o.part.map((s) => [s.index, s]));
  const from = Math.max(0, o.part[0].index - 2);
  const to = Math.min(o.total - 1, o.part[o.part.length - 1].index + 1);
  const lines: string[] = [];
  for (let i = from; i <= to; i++) {
    const s = stops.get(i);
    lines.push(s ? `*${i + 1}. ${o.lineAt(i)}${s.items.length ? `  [hard: ${s.items.join(', ')}]` : ''}` : `${i + 1}. ${o.lineAt(i)}`);
  }
  return {
    system: ruleSystem(o.level),
    user: `Source: ${o.title || 'Untitled'}

These are numbered sentences in order. The sentences marked with * are the hard ones, and [hard: ...] says what is hard in them for this learner. Write one explanation for EACH marked sentence, following the rules. Use the other sentences only to understand the story. Write only this, for every marked sentence, in order:
@@<its number>
<the explanation>

${lines.join('\n')}`,
    maxTokens: Math.min(16000, o.part.length * 320 + 200),
  };
}

/** "@@12\n…" sections. The last one is still being written unless the reply is complete. */
export function parseAnalysis(raw: string, complete: boolean): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  const re = /^[ \t]*@@[ \t]*(\d+)[ \t]*$/gm;
  const heads: { n: number; start: number; end: number }[] = [];
  for (let m = re.exec(raw); m; m = re.exec(raw)) heads.push({ n: Number(m[1]), start: m.index, end: m.index + m[0].length });
  heads.forEach((h, i) => {
    if (i === heads.length - 1 && !complete) return;
    const text = raw.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : raw.length).trim();
    if (text) out.push({ n: h.n, text });
  });
  return out;
}

export interface AnalysisOpts {
  load(): Promise<Record<string, string>>;
  save(texts: Record<string, string>): Promise<void>;
  /** the stops of this text, in order (also the one going on now, whose explanation may still be coming) */
  stops(): AnalysisStop[];
  lineAt(index: number): string;
  total(): number;
  title(): string;
  level(): string;
  stream(prompt: PromptBundle, onDelta: (full: string) => void): { done: Promise<string>; cancel(): void };
  onChange?(): void;
}

export class Analysis {
  private texts: Record<string, string> = {};
  private inFlight = new Set<string>();
  private missing = new Set<string>();
  private waiters = new Map<string, ((t: string | null) => void)[]>();
  private running = false;
  private nextFrom: number | null = null;
  private job: { cancel(): void } | null = null;
  private disposed = false;
  /** AI calls made for this text in this viewing */
  calls = 0;
  rejected = 0;
  readonly ready: Promise<void>;

  constructor(private o: AnalysisOpts) {
    this.ready = o.load().then((t) => { this.texts = { ...t }; }, () => undefined);
  }

  get count(): number { return Object.keys(this.texts).length; }
  get busy(): boolean { return this.running; }
  /** written, or known not to come */
  settled(id: string): boolean { return id in this.texts || this.missing.has(id); }
  upcoming(from: number): AnalysisStop[] { return this.o.stops().filter((s) => s.index >= from); }

  /** the learner is at this sentence: is a new part needed yet? */
  plan(from: number): void {
    if (this.disposed) return;
    if (!this.running) {
      const ahead = this.upcoming(from);
      const first = ahead.findIndex((s) => !this.settled(s.id));
      if (first >= 0 && first < LOOK_AHEAD) void this.run(ahead.slice(first).filter((s) => !this.settled(s.id)).slice(0, STOPS_PER_PART));
    }
    this.o.onChange?.();
  }

  /** the explanation of this sentence, when it is written; null: it will not come (the caller asks the AI for this one) */
  wait(id: string): Promise<string | null> {
    if (id in this.texts) return Promise.resolve(this.texts[id]);
    if (this.missing.has(id) || this.disposed) return Promise.resolve(null);
    // (being written right now: it comes in a moment)
    const stop = this.inFlight.has(id) ? null : this.o.stops().find((s) => s.id === id);
    if (!stop && !this.inFlight.has(id)) return Promise.resolve(null);
    const p = new Promise<string | null>((res) => { this.waiters.set(id, [...(this.waiters.get(id) ?? []), res]); });
    if (stop) {
      if (this.running) this.nextFrom = stop.index;
      else void this.run(this.upcoming(stop.index).filter((s) => !this.settled(s.id)).slice(0, STOPS_PER_PART));
    }
    return p;
  }

  private settle(id: string, text: string | null): void {
    if (text !== null) this.texts[id] = text; else this.missing.add(id);
    this.inFlight.delete(id);
    for (const w of this.waiters.get(id) ?? []) w(text);
    this.waiters.delete(id);
  }

  private async run(part: AnalysisStop[]): Promise<void> {
    if (!part.length) return;
    this.running = true;
    this.calls++;
    for (const s of part) this.inFlight.add(s.id);
    const byNumber = new Map(part.map((s) => [s.index + 1, s]));
    const take = (raw: string, complete: boolean) => {
      let got = false;
      for (const { n, text } of parseAnalysis(raw, complete)) {
        const s = byNumber.get(n);
        if (!s || s.id in this.texts) continue;
        // (the rule's check: nothing the rule forbids is saved or said)
        const guard = new RuleGuard({ sentence: s.text, items: s.items });
        const clean = guard.finish(text);
        this.rejected += guard.rejected;
        if (clean) { this.settle(s.id, clean); got = true; }
      }
      if (got) this.o.onChange?.();
    };
    try {
      const job = this.o.stream(buildAnalysisPrompt({ title: this.o.title(), level: this.o.level(), part, lineAt: (i) => this.o.lineAt(i), total: this.o.total() }), (full) => take(full, false));
      this.job = job;
      take(await job.done, true);
      await this.o.save(this.texts).catch(() => undefined);
    } catch { /* below: these stops ask the AI one by one, if at all */ }
    this.job = null;
    this.running = false;
    for (const s of part) if (!(s.id in this.texts)) this.settle(s.id, null);
    this.o.onChange?.();
    const next = this.nextFrom;
    this.nextFrom = null;
    if (next !== null && !this.disposed) this.plan(next);
  }

  dispose(): void {
    this.disposed = true;
    this.job?.cancel();
    for (const list of this.waiters.values()) for (const w of list) w(null);
    this.waiters.clear();
  }
}
