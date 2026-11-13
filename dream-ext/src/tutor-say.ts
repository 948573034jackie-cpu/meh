/**
 * The tutor's voice for the browser (and any page that is not a video): an explanation is asked once, shown and said
 * sentence by sentence while it is written, with the same rule check as the videos (RuleGuard). stop() ends the voice
 * and the request at once. Free mode (My tutor off): only the device's own voice, never the AI, nothing paid.
 */
import type { TtsEngine, SpeakHandle } from '@core/tts/engine';
import type { PromptBundle } from '@core/ai/prompts';
import { getEngine, useFakeEngine, defaultVoiceFor } from '@core/tts/registry';
import { StreamSentenceSplitter } from '@core/listen/sentences';
import { explain as aiExplain, completeStream } from './ai-client';
import * as store from './store';
import { cloudEngine, resolveVoice, VoiceWithBackup } from './voice';
import { RuleGuard, type RuleRequest } from './level-rule';
import { NativeAudioEngine } from './native-audio';

type Job = { done: Promise<string>; cancel(): void };

export class TutorSay {
  private tts: TtsEngine | null = null;
  private voiceId = '';
  private rate = 1;
  private run = 0;
  private speaking: SpeakHandle | null = null;
  private job: { cancel(): void } | null = null;
  private active = 0;
  /** what was given to the voice (the tests read it) */
  readonly spoken: string[] = [];
  /** the sentence being said now (the microphone must not take it for a command) */
  nowSaying = '';

  /** `appPlays`: a cloud voice's sound is played by the app itself, not by the page (the app's browser: see native-audio.ts) */
  constructor(private onBusy: (busy: boolean) => void = () => undefined, private appPlays = false) {}

  /** talking now: something was started and not stopped since (a stopped one may still be winding down: it is not
   *  "talking" any more, so the next tap on Explain starts a new explanation instead of stopping again) */
  get busy(): boolean { return this.active > 0 && this.began === this.run; }
  /** the run of the last thing started */
  private began = -1;

  /** the voice of the settings; `free` = the device's own voice only */
  async prepare(free: boolean): Promise<void> {
    const [extras, settings, keys] = await Promise.all([store.getExtras(), store.getSettings(), free ? Promise.resolve({} as store.Keys) : store.getKeys()]);
    if (extras.fakeVoice) useFakeEngine(2);
    const mac = getEngine('webspeech');
    const macVoice = settings.voice.voiceId || (await defaultVoiceFor('webspeech').catch(() => ''));
    this.rate = settings.voice.rate;
    const kind = free ? 'mac' : resolveVoice(extras.voice, keys);
    if (kind === 'mac') { this.tts = mac; this.voiceId = macVoice; return; }
    this.tts = new VoiceWithBackup(this.appPlays ? new NativeAudioEngine(kind) : cloudEngine(kind, 'en'), mac, () => macVoice, () => undefined);
    this.voiceId = kind === 'openai' ? extras.openaiVoice : kind === 'azure' ? extras.azureVoice : extras.elevenVoice;
  }

  private begin(): number { this.active++; this.began = this.run; this.onBusy(true); return this.run; }
  private end(): void { this.active = Math.max(0, this.active - 1); if (this.active === 0) { this.nowSaying = ''; this.onBusy(false); } }

  /** everything stops at once: the voice and the request that is still being written */
  stop(): void {
    // (said at once: the app and the page know it is quiet now, before the stopped request has wound down)
    if (this.busy) { this.nowSaying = ''; this.onBusy(false); }
    this.run++;
    this.job?.cancel();
    this.job = null;
    this.speaking?.cancel();
    this.speaking = null;
    this.tts?.cancelAll();
  }

  private speak(text: string): Promise<boolean> {
    if (!this.tts) return Promise.resolve(false);
    this.spoken.push(text);
    if (this.spoken.length > 200) this.spoken.splice(0, 100);
    this.nowSaying = text;
    const h = this.tts.speak(text, { voiceId: this.voiceId, rate: this.rate });
    this.speaking = h;
    return h.done.then((o) => { if (this.speaking === h) this.speaking = null; return o === 'ended'; });
  }

  /** a ready text (a word, a saved explanation), sentence by sentence; false = it was stopped */
  async say(text: string): Promise<boolean> {
    this.stop();
    const mine = this.begin();
    try {
      for (const s of new StreamSentenceSplitter().flush(text)) if (mine !== this.run || !(await this.speak(s))) return false;
      return mine === this.run;
    } finally { this.end(); }
  }

  /** one request, said while it is written; `show` gets the text that may be shown so far */
  private async stream(start: (onDelta: (full: string) => void) => Job, guard: RuleGuard, show: (t: string) => void): Promise<{ text: string; error: string; stopped: boolean }> {
    this.stop();
    const mine = this.begin();
    const splitter = new StreamSentenceSplitter();
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let finished = false, failed = '', final = '';
    const job = start((full) => { const t = guard.push(full); if (t.trim()) show(t.trim()); queue.push(...splitter.push(t)); wake?.(); });
    this.job = job;
    void job.done.then((text) => { final = guard.finish(text); if (final) show(final); queue.push(...splitter.flush(final)); }, (e: Error & { code?: string }) => { if (e.code !== 'cancelled') failed = e.message; }).finally(() => { finished = true; wake?.(); });
    try {
      for (;;) {
        if (mine !== this.run) { job.cancel(); return { text: '', error: '', stopped: true }; }
        const next = queue.shift();
        if (next !== undefined) {
          const said = this.speak(next);
          // (the sentence after this one is made while this one is said: no gap between them)
          if (queue.length) this.tts?.prefetch?.(queue[0], this.voiceId, this.rate);
          if (!(await said)) { job.cancel(); return { text: '', error: '', stopped: true }; }
          continue;
        }
        if (finished) break;
        await new Promise<void>((r) => { wake = r; });
        wake = null;
      }
      return { text: failed ? '' : final, error: failed, stopped: false };
    } finally { if (this.job === job) this.job = null; this.end(); }
  }

  /** a word or a sentence by the learner's rule (the cheap model, like every Level Check explanation) */
  explain(req: RuleRequest, show: (t: string) => void): Promise<{ text: string; error: string; stopped: boolean }> {
    const guard = new RuleGuard({ sentence: req.sentence, items: req.kind === 'sentence' ? req.levelRule?.items ?? [] : [req.target] });
    return this.stream((onDelta) => { const j = aiExplain(req, onDelta); return { done: j.done.then((r) => r.text), cancel: () => j.cancel() }; }, guard, show);
  }

  /** a free request (what is on the screen now): one call to the cheap model */
  tell(prompt: PromptBundle, show: (t: string) => void): Promise<{ text: string; error: string; stopped: boolean }> {
    return this.stream((onDelta) => completeStream(prompt, onDelta, true), new RuleGuard({}), show);
  }
}
