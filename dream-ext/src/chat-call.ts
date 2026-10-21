/**
 * The voice call without OpenAI: what the learner says (Chrome's speech recognition, through youtube.js) or types goes
 * to Claude with the whole conversation and what is on the screen; the answer is spoken by the tutor's own voice
 * (Mac / OpenAI / ElevenLabs, at the teacher's volume) sentence by sentence while it is still being written, so the
 * tutor starts talking at once. A new question, "stop" or Space stops the current answer.
 */
import { StreamSentenceSplitter } from '@core/listen/sentences';
import { cleanSpokenProse } from '@core/ai/prompts';
import { splitByScript } from '@core/listen/script';
import type { SpeakHandle } from '@core/tts/engine';
import { chatStream } from './ai-client';

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export interface ChatCallDeps {
  /** the tutor's instructions: the learner's rules, the part on the screen, the explanation just given */
  system(): string;
  /** speaks one piece (English with the teacher's voice, Chinese with the Chinese voice); null = cannot be spoken */
  speak(text: string, lang: 'en' | 'zh'): SpeakHandle | null;
  /** (cloud voices) the teacher's voice says English with Chinese in it in one go (no small pieces) */
  mixed?(): boolean;
  /** (cloud voices) starts making the audio of a piece now, so it plays without a gap when its turn comes */
  prefetch?(text: string, lang: 'en' | 'zh'): void;
  cancelSpeech(): void;
  /** what the tutor is saying, for the page (grows while it is written) */
  line(id: string, text: string, final: boolean): void;
  /** thinking / speaking changed */
  changed(): void;
  error(message: string): void;
  /** the tutor stopped speaking (the microphone may now take the learner's words again) */
  spoke(): void;
}

const GREETINGS = [
  "Hi! I'm here. What would you like to know about this part?",
  'Hello! Ask me anything about what you just heard.',
  'Hi there! Which word or sentence should we look at together?',
];

export class ChatCall {
  history: ChatTurn[] = [];
  thinking = false;
  speaking = false;
  closed = false;
  /** the last error of Claude or the voice ('' = none), shown in the call */
  lastError = '';
  /** what happened in the call, for the 🩺 check / diagnostics (time + event) */
  events: string[] = [];
  /** last time someone said something (for "go on after N quiet seconds") */
  lastActivity = Date.now();
  private job: { cancel(): void } | null = null;
  private queue: { text: string; lang: 'en' | 'zh' }[] = [];
  private handle: SpeakHandle | null = null;
  private pumping = false;
  private turn = 0;

  constructor(private deps: ChatCallDeps) {}

  note(event: string): void {
    const d = new Date();
    this.events.push(`${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')} ${event.slice(0, 140)}`);
    if (this.events.length > 60) this.events.splice(0, this.events.length - 60);
  }

  /** the tutor is thinking, talking, or has more to say */
  get busy(): boolean { return this.thinking || this.speaking || this.queue.length > 0; }

  /** the tutor speaks first (📞): a short, friendly opening, no waiting for the AI */
  greet(): void {
    const g = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    // the conversation must start with the learner: the call button counts as their first turn
    this.history.push({ role: 'user', content: '(The learner pressed the call button to talk to you.)' }, { role: 'assistant', content: g });
    this.deps.line(`a${++this.turn}`, g, true);
    this.note('greeting');
    this.enqueue(g);
  }

  /** what the learner said or typed */
  ask(text: string): void {
    const q = text.trim();
    if (this.closed || !q) return;
    if (this.job) this.note('a new question replaces the one Claude was answering');
    this.interrupt();
    this.lastError = '';
    // two learner turns in a row (the last answer was cut): one turn
    const last = this.history[this.history.length - 1];
    if (last?.role === 'user') last.content = `${last.content}\n${q}`;
    else this.history.push({ role: 'user', content: q });
    this.lastActivity = Date.now();
    this.run(false);
  }

  /** Claude answers the conversation so far (once more when the answer came back empty) */
  private run(again: boolean): void {
    const id = `a${++this.turn}`;
    this.thinking = true;
    this.note(again ? 'asking Claude again (the answer was empty)' : 'asking Claude');
    this.deps.changed();
    const splitter = new StreamSentenceSplitter();
    let written = '';
    const job = chatStream(this.deps.system(), this.history.slice(-16), (full) => {
      if (this.job !== job) return;
      written = full;
      this.deps.line(id, cleanSpokenProse(full), false);
      for (const sentence of splitter.push(full)) this.enqueue(sentence);
    });
    this.job = job;
    void job.done.then((text) => {
      if (this.job !== job) return;
      this.job = null;
      this.note(`Claude answered (${text.length} characters)`);
      if (!text.trim()) {
        if (!again && !this.closed) { this.run(true); return; }
        this.thinking = false;
        this.lastError = 'Claude gave no answer';
        this.deps.error(this.lastError);
        this.deps.changed();
        return;
      }
      this.thinking = false;
      for (const sentence of splitter.flush(text)) this.enqueue(sentence);
      this.history.push({ role: 'assistant', content: text });
      this.deps.line(id, cleanSpokenProse(text), true);
      this.deps.changed();
    }, (e: Error & { code?: string }) => {
      if (this.job !== job) return;
      this.job = null;
      this.thinking = false;
      // what was said before it broke still counts as the tutor's turn
      if (written.trim()) this.history.push({ role: 'assistant', content: written });
      this.note(`Claude: ${e.code === 'cancelled' ? 'cancelled' : `error ${e.message}`}`);
      if (e.code !== 'cancelled') { this.lastError = e.message; this.deps.error(e.message); }
      this.deps.changed();
    });
  }

  private enqueue(sentence: string): void {
    const t = cleanSpokenProse(sentence).trim();
    if (!t || this.closed) return;
    for (const run of this.deps.mixed?.() ? [{ text: t, zh: false }] : splitByScript(t)) {
      const text = run.text.trim();
      if (!text) continue;
      const lang = run.zh ? 'zh' as const : 'en' as const;
      this.queue.push({ text, lang });
      this.deps.prefetch?.(text, lang);
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.closed) {
        const next = this.queue.shift()!;
        const h = this.deps.speak(next.text, next.lang);
        if (!h) { this.note(`not spoken (no ${next.lang} voice): ${next.text.slice(0, 30)}`); continue; }
        this.handle = h;
        if (!this.speaking) { this.speaking = true; this.deps.changed(); }
        this.note(`say: ${next.text.slice(0, 50)}`);
        const outcome = await h.done;
        this.note(`said (${outcome})`);
        if (outcome === 'error') { this.note(`voice error: ${h.error?.message ?? '?'}`); this.lastError = `the voice failed (${h.error?.message ?? 'no details'})`; }
        this.handle = null;
        this.lastActivity = Date.now();
      }
    } finally {
      this.pumping = false;
      if (this.speaking) { this.speaking = false; this.deps.spoke(); this.deps.changed(); }
    }
  }

  /** the learner interrupts: the answer stops (what was already said stays in the conversation) */
  interrupt(): void {
    if (this.job || this.speaking) this.note('interrupted');
    if (this.job) { this.job.cancel(); this.job = null; }
    this.thinking = false;
    this.queue = [];
    if (this.handle) { this.handle.cancel(); this.handle = null; }
    this.deps.cancelSpeech();
  }

  close(): void {
    if (this.closed) return;
    this.interrupt();
    this.closed = true;
  }
}
