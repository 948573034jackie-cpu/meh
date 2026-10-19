/**
 * The live voice call with the tutor: OpenAI's realtime model over WebRTC, so it hears you and answers at once,
 * and you can interrupt it (the server stops its answer when you start talking). The page makes the WebRTC offer;
 * the background worker sends it to /v1/realtime/calls with the learner's key and returns the answer, so the key
 * never reaches the page. Events come over the "oai-events" data channel. The tutor gets the part of the video
 * that is on the screen, the word just explained and the learner's own teacher instructions; it calls
 * continue_video when the learner wants to watch on, and mark_word when they say they know a word.
 */

export type LiveState = 'connecting' | 'ready' | 'ended' | 'error';

export interface LiveTool { type: 'function'; name: string; description: string; parameters: Record<string, unknown> }

export const LIVE_TOOLS: LiveTool[] = [
  {
    type: 'function', name: 'continue_video',
    description: 'Go back to the video and play it. Call this as soon as the learner wants to continue watching: they say go on, let\'s go, continue, next, play, OK I got it, back to the video, or bye bye.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function', name: 'mark_word',
    description: 'Save a word or phrase for the learner: "known" when they say they know it now or do not want it explained again, "learning" when they want to keep practising it.',
    parameters: { type: 'object', properties: { word: { type: 'string' }, status: { type: 'string', enum: ['known', 'learning'] } }, required: ['word', 'status'] },
  },
];

/** 1 = normal, 2 = sensitive, 3 = very sensitive (quiet voice, laptop microphone, lying in bed) */
export type MicLevel = 1 | 2 | 3;
export interface LiveConfig { model: string; voice: string; instructions: string; transcribe: boolean; mic?: MicLevel }

/** how much the voice is made louder before it is sent, per microphone level */
export const MIC_GAIN: Record<MicLevel, number> = { 1: 1, 2: 2.2, 3: 3.5 };

export interface LiveEvents {
  state(s: LiveState, detail?: string): void;
  /** what the learner said (from the call's own transcription) */
  user?(text: string, final: boolean, id: string): void;
  /** what the tutor is saying */
  ai?(text: string, final: boolean, id: string): void;
  /** the tutor's voice started / stopped playing */
  speaking?(on: boolean): void;
  /** the learner started / stopped talking */
  hearing?(on: boolean): void;
  tool?(name: string, args: Record<string, unknown>): unknown;
  usage?(usage: unknown, model: string): void;
}

export function sessionFor(cfg: LiveConfig): Record<string, unknown> {
  return {
    type: 'realtime',
    model: cfg.model,
    instructions: cfg.instructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        // normal: the model hears when you finished a thought; sensitive: a quieter voice already counts as speech
        turn_detection: (cfg.mic ?? 2) === 1
          ? { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true }
          : { type: 'server_vad', threshold: cfg.mic === 3 ? 0.25 : 0.35, prefix_padding_ms: 400, silence_duration_ms: 700, create_response: true, interrupt_response: true },
        ...(cfg.transcribe ? { transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' } } : {}),
        // a laptop microphone with the learner a little away from it
        noise_reduction: { type: 'far_field' },
      },
      output: { voice: cfg.voice },
    },
    tools: LIVE_TOOLS,
    tool_choice: 'auto',
  };
}

export class LiveCall {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private micOn = false;
  private closed = false;
  private userText = new Map<string, string>();
  private aiText = new Map<string, string>();
  private speakingNow = false;
  private speakTimer: ReturnType<typeof setTimeout> | null = null;
  /** the settings level the server accepted (0 = everything, higher = simpler) */
  level = 0;
  state: LiveState = 'connecting';
  readonly ready: Promise<void>;
  /** last time the learner or the tutor said something (for "go on after N quiet seconds") */
  lastActivity = Date.now();

  constructor(private cfg: LiveConfig, private ev: LiveEvents) {
    this.ready = this.connect();
    this.ready.catch(() => undefined);
  }

  get speaking(): boolean { return this.speakingNow; }

  private setState(s: LiveState, detail?: string): void {
    if (this.state === s && s !== 'error') return;
    this.state = s;
    this.ev.state(s, detail);
  }

  private async connect(): Promise<void> {
    this.setState('connecting');
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      const err = new Error(`The microphone is not allowed on youtube.com (${(e as Error).name || 'blocked'}). Click the lock icon left of the address bar → Microphone → Allow, then try again.`);
      this.fail(err);
      throw err;
    }
    if (this.closed) { this.stopMic(); return; }
    const pc = new RTCPeerConnection();
    this.pc = pc;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    this.audio = audio;
    pc.ontrack = (e) => { audio.srcObject = e.streams[0]; void audio.play().catch(() => undefined); };
    const track = this.louder(this.mic, MIC_GAIN[this.cfg.mic ?? 2]);
    this.sendTrack = track;
    track.enabled = this.micOn;
    pc.addTrack(track, this.mic);
    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.onmessage = (m) => { try { this.onEvent(JSON.parse(String(m.data))); } catch { /* not JSON */ } };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (pc.connectionState === 'failed') this.fail(new Error('The live voice connection was lost.'));
      if (pc.connectionState === 'closed' || pc.connectionState === 'disconnected') { if (!this.closed && pc.connectionState === 'closed') this.close(); }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r = (await chrome.runtime.sendMessage({ type: 'dream-live-sdp', sdp: offer.sdp, session: sessionFor(this.cfg) })) as { sdp?: string; level?: number; error?: string } | undefined;
    if (this.closed) return;
    if (!r?.sdp) { const err = new Error(r?.error ?? 'The live voice did not answer.'); this.fail(err); throw err; }
    this.level = r.level ?? 0;
    await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
    await new Promise<void>((resolve, reject) => {
      if (dc.readyState === 'open') { resolve(); return; }
      const t = setTimeout(() => reject(new Error('The live voice did not open in time.')), 15000);
      dc.onopen = () => { clearTimeout(t); resolve(); };
    }).catch((e: Error) => { this.fail(e); throw e; });
    if (this.closed) return;
    this.setState('ready');
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.setState('error', e.message);
    this.close();
  }

  private send(ev: Record<string, unknown>): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(ev));
  }

  /** the learner can talk now (the microphone is sent) / not (an explanation is being read to them) */
  setMic(on: boolean): void {
    this.micOn = on;
    for (const t of [this.sendTrack, ...(this.mic?.getAudioTracks() ?? [])]) if (t) t.enabled = on;
    if (on) this.lastActivity = Date.now();
  }

  /** new context (another part of the video, the explanation just given) */
  update(instructions: string): void {
    this.cfg = { ...this.cfg, instructions };
    this.send({ type: 'session.update', session: { type: 'realtime', instructions } });
  }

  /** the tutor speaks first (e.g. "What would you like to know?"), following `instructions` for this one answer */
  say(instructions?: string): void {
    this.send({ type: 'response.create', ...(instructions ? { response: { instructions } } : {}) });
  }

  /** a typed question: it goes into the call and the tutor answers out loud */
  ask(text: string): void {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.send({ type: 'response.create' });
    this.lastActivity = Date.now();
  }

  /** stop the tutor's current answer (the learner pressed a key) */
  interrupt(): void {
    this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
  }

  private setSpeaking(on: boolean): void {
    if (this.speakTimer) { clearTimeout(this.speakTimer); this.speakTimer = null; }
    if (this.speakingNow === on) return;
    this.speakingNow = on;
    this.lastActivity = Date.now();
    this.ev.speaking?.(on);
  }

  private onEvent(e: Record<string, unknown> & { type?: string }): void {
    const type = String(e.type ?? '');
    switch (type) {
      case 'input_audio_buffer.speech_started': this.lastActivity = Date.now(); this.ev.hearing?.(true); break;
      case 'input_audio_buffer.speech_stopped': this.lastActivity = Date.now(); this.ev.hearing?.(false); break;
      case 'conversation.item.input_audio_transcription.delta': {
        const id = String(e.item_id ?? ''), t = (this.userText.get(id) ?? '') + String(e.delta ?? '');
        this.userText.set(id, t);
        this.ev.user?.(t, false, id);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const id = String(e.item_id ?? '');
        this.userText.delete(id);
        this.lastActivity = Date.now();
        this.ev.user?.(String(e.transcript ?? ''), true, id);
        break;
      }
      case 'response.output_audio_transcript.delta': {
        const id = String(e.response_id ?? e.item_id ?? ''), t = (this.aiText.get(id) ?? '') + String(e.delta ?? '');
        this.aiText.set(id, t);
        this.lastActivity = Date.now();
        this.ev.ai?.(t, false, id);
        break;
      }
      case 'response.output_audio_transcript.done': {
        const id = String(e.response_id ?? e.item_id ?? '');
        this.aiText.delete(id);
        this.ev.ai?.(String(e.transcript ?? ''), true, id);
        break;
      }
      case 'output_audio_buffer.started': this.setSpeaking(true); break;
      case 'output_audio_buffer.stopped': case 'output_audio_buffer.cleared': this.setSpeaking(false); break;
      case 'response.created': this.lastActivity = Date.now(); break;
      case 'response.done': {
        const resp = (e.response ?? {}) as { output?: { type?: string; name?: string; call_id?: string; arguments?: string }[]; usage?: unknown; status?: string };
        if (resp.usage) this.ev.usage?.(resp.usage, this.cfg.model);
        // no audio buffer events (older servers): the answer is over a moment after its text
        if (this.speakingNow) this.speakTimer = setTimeout(() => this.setSpeaking(false), 1200);
        let more = false;
        for (const item of resp.output ?? []) {
          if (item.type !== 'function_call' || !item.name) continue;
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(item.arguments || '{}') as Record<string, unknown>; } catch { /* empty */ }
          const out = this.ev.tool?.(item.name, args);
          if (this.closed) return;
          this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(out ?? { ok: true }) } });
          if (item.name !== 'continue_video') more = true;
        }
        if (more) this.say();
        break;
      }
      case 'error': {
        const err = (e.error ?? {}) as { message?: string; code?: string };
        // harmless: cancelling when nothing is playing
        if (/response_cancel_not_active|no active response/i.test(`${err.code ?? ''} ${err.message ?? ''}`)) break;
        this.ev.state(this.state, `Live voice: ${err.message ?? 'error'}`);
        break;
      }
      default: break;
    }
  }

  private stopMic(): void {
    this.mic?.getTracks().forEach((t) => t.stop()); this.mic = null;
    this.sendTrack?.stop(); this.sendTrack = null;
    void this.ctx?.close().catch(() => undefined); this.ctx = null;
  }

  private ctx: AudioContext | null = null;
  private sendTrack: MediaStreamTrack | null = null;
  /** the microphone made louder (echo cancelling already happened in the capture); the plain track if that fails */
  private louder(stream: MediaStream, gain: number): MediaStreamTrack {
    const raw = stream.getAudioTracks()[0];
    if (gain <= 1.01) return raw;
    try {
      const ctx = new AudioContext();
      void ctx.resume().catch(() => undefined);
      const src = ctx.createMediaStreamSource(stream);
      const g = ctx.createGain();
      g.gain.value = gain;
      // a soft limiter, so a loud word is not distorted
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 10; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.15;
      const dest = ctx.createMediaStreamDestination();
      src.connect(g).connect(comp).connect(dest);
      this.ctx = ctx;
      return dest.stream.getAudioTracks()[0] ?? raw;
    } catch { return raw; }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.speakTimer) clearTimeout(this.speakTimer);
    try { this.dc?.close(); } catch { /* closed */ }
    try { this.pc?.close(); } catch { /* closed */ }
    this.stopMic();
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    if (this.state !== 'error') this.setState('ended');
  }
  get isClosed(): boolean { return this.closed; }
}

/** What the live tutor knows: the learner's rules, the part on the screen, the word just explained. */
export function liveInstructions(o: { teacher: string; level: string; title: string; part: string[]; from: string; to: string; word?: string; explanation?: string; hints?: string }): string {
  return [
    'You are the learner\'s own English teacher, in a live voice call while they watch a YouTube video. Their first language is Chinese; their English is about CEFR level ' + o.level + '.',
    'Talk like a real phone call: short turns of one to four sentences, warm and natural, easy spoken English. Never use lists, headings or labels. Never ask the learner to repeat; speech recognition may mishear them, so work out what they most likely meant. When you give a Chinese meaning, say it in Mandarin Chinese.',
    'Talk about the part of the video that is on the screen now (below). Explain only what is really there; never invent words of the video.',
    'When the learner wants to watch on (go on, let\'s go, continue, next, play, OK got it, bye bye), call continue_video right away. When they say they know a word now, call mark_word with status known.',
    o.teacher ? `The learner's own instructions for their teacher (follow them):\n${o.teacher}` : '',
    `Video: "${o.title}"`,
    `On the screen now (${o.from} to ${o.to} in the video):\n${o.part.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
    o.hints ? `Hard words on the screen, with their Chinese meaning here: ${o.hints}` : '',
    o.word ? `You just stopped the video at "${o.word}" and explained it.${o.explanation ? ` Your explanation was: "${o.explanation.slice(0, 1500)}"` : ''} The learner may ask about it now.` : (o.explanation ? `You just explained this part. Your explanation was: "${o.explanation.slice(0, 1500)}"` : ''),
  ].filter(Boolean).join('\n\n');
}
