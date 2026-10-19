import { describe, it, expect } from 'vitest';
import { VoiceChat, type SttBridge, type TutorActions } from '../../src/renderer/voice/VoiceChat';
import { SilentMic } from '../../src/renderer/voice/mic';
import type { SttStatus } from '@shared/api';
import type { SttEngineEvent } from '@core/voice/session';

const flush = () => new Promise((r) => setTimeout(r, 0));

function status(state: SttStatus['state'], extra: Partial<SttStatus> = {}): SttStatus {
  return { state, variant: 'moonshine-base', modelDir: '/m', downloadBytes: state === 'missing' ? 111_000_000 : 0, progress: null, error: null, sessions: 0, version: 't', confidence: false, ...extra };
}

function setup(initial: SttStatus['state'] = 'ready', opts: { alwaysOn?: boolean } = {}) {
  let st = status(initial);
  const evListeners = new Set<(e: SttEngineEvent) => void>();
  const progListeners = new Set<(s: SttStatus) => void>();
  const calls: string[] = [];
  let downloadResolve: ((s: SttStatus) => void) | null = null;
  const stt: SttBridge = {
    status: async () => st,
    download: () => { calls.push('download'); st = status('downloading'); for (const l of progListeners) l(st); return new Promise((r) => { downloadResolve = r; }); },
    cancelDownload: async () => { calls.push('cancelDownload'); },
    start: async (id) => { calls.push(`start:${id.startsWith('voice-') ? 'ok' : id}`); return st; },
    push: async () => undefined,
    stop: async () => { calls.push('stop'); },
    onEvent: (cb) => { evListeners.add(cb); return () => evListeners.delete(cb); },
    onProgress: (cb) => { progListeners.add(cb); return () => progListeners.delete(cb); },
  };
  const tutorCalls: string[] = [];
  const tutor: TutorActions = {
    know: () => tutorCalls.push('know'),
    dontKnow: () => tutorCalls.push('dontKnow'),
    ask: (t, spoken) => tutorCalls.push(`ask:${t}:${spoken ? 'spoken' : 'typed'}`),
    hold: () => tutorCalls.push('hold'),
    release: () => tutorCalls.push('release'),
    keepWaiting: () => tutorCalls.push('keepWaiting'),
    continueBook: () => tutorCalls.push('continueBook'),
  };
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let tid = 0;
  const mic = new SilentMic();
  const chat = new VoiceChat({
    stt, mic, tutor, alwaysOn: opts.alwaysOn, listener: { debounceMs: 0 },
    setTimeout: (fn, ms) => { const id = ++tid; timers.push({ fn, ms, id }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  });
  let seg = 0;
  /** an event from the engine for the session that is open now */
  const send = (ev: { type: SttEngineEvent['type']; text?: string }) => {
    const sessionId = chat.sessionId ?? 'none';
    for (const l of evListeners) l({ text: '', ...ev, sessionId, segmentId: `${sessionId}:${ev.type === 'speechStart' ? ++seg : seg}` } as SttEngineEvent);
  };
  const runTimers = () => { for (const t of timers.splice(0)) t.fn(); };
  const finishDownload = () => { st = status('ready'); downloadResolve?.(st); for (const l of progListeners) l(st); };
  return { chat, mic, calls, tutorCalls, send, runTimers, timers, finishDownload };
}

describe('VoiceChat state machine', () => {
  it('pause window: the mic opens in commands mode; "I know" marks known, continues, and closes the line', async () => {
    const t = setup();
    await flush();
    expect(t.chat.snapshot.line).toBe('closed');
    t.chat.pauseWindow(true);
    await flush();
    expect(t.chat.snapshot.line).toBe('window');
    expect(t.chat.session.mode).toBe('commands');
    expect(t.mic.active).toBe(true);
    expect(t.calls).toContain('start:ok');
    t.send({ type: 'speechStart' });
    expect(t.tutorCalls).toEqual(['keepWaiting']); // the learner is talking: the pause waits for them, nothing is interrupted
    t.send({ type: 'final', text: 'I know' });
    expect(t.tutorCalls).toEqual(['keepWaiting', 'know']);
    expect(t.chat.snapshot.line).toBe('closed');
    expect(t.mic.active).toBe(false);
    expect(t.calls).toContain('stop');
    t.chat.pauseWindow(false); // the controller's matching close is harmless
    expect(t.chat.snapshot.line).toBe('closed');
  });

  it('pause window: "I don\'t know" explains again; anything else is a question; "bye bye" lets the book go on', async () => {
    const t = setup();
    await flush();
    t.chat.pauseWindow(true); await flush();
    t.send({ type: 'final', text: "I don't know" });
    expect(t.tutorCalls).toEqual(['dontKnow']);
    t.chat.pauseWindow(false);
    t.chat.pauseWindow(true); await flush();
    t.send({ type: 'final', text: 'what does this mean' });
    expect(t.tutorCalls).toEqual(['dontKnow', 'ask:what does this mean:spoken']);
    t.chat.pauseWindow(false);
    t.chat.pauseWindow(true); await flush();
    t.send({ type: 'final', text: 'bye bye' });
    expect(t.tutorCalls.at(-1)).toBe('continueBook');
    expect(t.chat.snapshot.line).toBe('closed');
  });

  it('the window closes with the pause, but a sentence in progress is still taken', async () => {
    const t = setup();
    await flush();
    t.chat.pauseWindow(true); await flush();
    t.chat.pauseWindow(false);
    expect(t.chat.snapshot.line).toBe('closed');
    t.chat.pauseWindow(true); await flush();
    t.send({ type: 'speechStart' });
    t.chat.pauseWindow(false);
    expect(t.chat.snapshot.line).toBe('window');
    t.send({ type: 'final', text: 'why is he sad' });
    expect(t.tutorCalls).toContain('ask:why is he sad:spoken');
    expect(t.chat.snapshot.line).toBe('closed');
  });

  it('no window without the speech model, and never a download prompt by itself', async () => {
    const t = setup('missing');
    await flush();
    t.chat.pauseWindow(true); await flush();
    expect(t.chat.snapshot.line).toBe('closed');
    expect(t.chat.snapshot.consent).toBe(false);
    expect(t.mic.active).toBe(false);
  });

  it('call: speaking interrupts the tutor (hold), the final becomes a question; noise releases the book', async () => {
    const t = setup();
    await flush();
    t.chat.toggle(); await flush();
    expect(t.chat.snapshot.line).toBe('call');
    expect(t.chat.session.mode).toBe('conversation');
    expect(t.chat.snapshot.ui).toBe('listening');
    t.chat.setTutorState('speaking');
    expect(t.chat.snapshot.ui).toBe('speaking');
    t.send({ type: 'speechStart' });
    expect(t.tutorCalls).toEqual(['hold']);
    expect(t.chat.snapshot.ui).toBe('listening');
    t.send({ type: 'partial', text: 'I know what' });
    expect(t.chat.snapshot.partial).toBe('I know what');
    t.send({ type: 'speechEnd' });
    t.send({ type: 'final', text: 'I know what it means' }); // in a call "I know" is part of an answer
    expect(t.tutorCalls).toEqual(['hold', 'ask:I know what it means:spoken']);
    t.runTimers(); // the no-question timer was cleared by the question
    expect(t.tutorCalls).toEqual(['hold', 'ask:I know what it means:spoken']);
    t.chat.setTutorState('thinking');
    expect(t.chat.snapshot.ui).toBe('thinking');
    // a cough: speech but no words
    t.send({ type: 'speechStart' });
    t.send({ type: 'speechEnd' });
    expect(t.tutorCalls.at(-1)).toBe('hold');
    t.runTimers();
    expect(t.tutorCalls.at(-1)).toBe('release');
  });

  it('call: "bye bye" ends the call; the button ends it too', async () => {
    const t = setup();
    await flush();
    t.chat.toggle(); await flush();
    t.send({ type: 'speechStart' });
    t.send({ type: 'final', text: 'bye bye' });
    expect(t.chat.snapshot.line).toBe('closed');
    expect(t.tutorCalls).toEqual(['hold', 'release']);
    expect(t.mic.active).toBe(false);
    t.chat.toggle(); await flush();
    expect(t.chat.snapshot.line).toBe('call');
    t.chat.toggle();
    expect(t.chat.snapshot.line).toBe('closed');
  });

  it('call + pause window: commands during the pause, conversation again after it', async () => {
    const t = setup();
    await flush();
    t.chat.toggle(); await flush();
    t.chat.pauseWindow(true);
    expect(t.chat.session.mode).toBe('commands');
    t.send({ type: 'speechStart' });
    expect(t.tutorCalls).toEqual(['keepWaiting']);
    t.send({ type: 'final', text: 'I know' });
    expect(t.tutorCalls).toEqual(['keepWaiting', 'know']);
    expect(t.chat.snapshot.line).toBe('call'); // the call stays open
    t.chat.pauseWindow(false);
    expect(t.chat.session.mode).toBe('conversation');
  });

  it('model missing: the first mic press asks to download; the call starts when it is done', async () => {
    const t = setup('missing');
    await flush();
    t.chat.toggle();
    expect(t.chat.snapshot.consent).toBe(true);
    expect(t.chat.snapshot.line).toBe('closed');
    t.chat.askTyped('typing works meanwhile');
    expect(t.tutorCalls).toEqual(['ask:typing works meanwhile:typed']);
    t.chat.acceptDownload();
    expect(t.calls).toContain('download');
    expect(t.chat.snapshot.model?.state).toBe('downloading');
    t.finishDownload();
    await flush();
    expect(t.chat.snapshot.consent).toBe(false);
    expect(t.chat.snapshot.line).toBe('call');
  });

  it('"Not now" closes the card; Always on opens the call by itself once the model is there', async () => {
    const t = setup('missing');
    await flush();
    t.chat.toggle();
    t.chat.declineDownload();
    expect(t.chat.snapshot.consent).toBe(false);
    const on = setup('ready', { alwaysOn: true });
    await flush();
    expect(on.chat.snapshot.line).toBe('call');
    expect(on.chat.snapshot.alwaysOn).toBe(true);
  });

  it('inject (e2e) feeds the session like the engine', async () => {
    const t = setup();
    await flush();
    t.chat.pauseWindow(true); await flush();
    t.chat.inject({ type: 'final', text: 'I know', segmentId: 's1' });
    expect(t.tutorCalls).toEqual(['know']);
  });
  it('a window that closes and opens again while the speech model is still loading still gets a microphone', async () => {
    const gates: (() => void)[] = [];
    const listeners = new Set<(e: SttEngineEvent) => void>();
    let started = 0, stopped = 0;
    const stt: SttBridge = {
      status: async () => status('ready'), download: async () => status('ready'), cancelDownload: async () => undefined,
      start: () => { started++; return new Promise((r) => gates.push(() => r(status('ready')))); },
      push: async () => undefined, stop: async () => { stopped++; },
      onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }, onProgress: () => () => undefined,
    };
    const mic = new SilentMic();
    const noop = () => undefined;
    const chat = new VoiceChat({ stt, mic, tutor: { know: noop, dontKnow: noop, ask: noop, hold: noop, release: noop, keepWaiting: noop, continueBook: noop }, listener: { debounceMs: 0 } });
    await flush();
    chat.pauseWindow(true); // the first session starts loading the model
    chat.pauseWindow(false); // the learner tapped another word: the window closes...
    chat.pauseWindow(true); // ...and opens again when that explanation ends
    expect(started).toBe(1);
    gates.shift()!(); await flush(); await flush();
    expect(stopped).toBeGreaterThanOrEqual(1); // the stale session is closed
    expect(started).toBe(2); // and a fresh one is opened for the new window
    gates.shift()!(); await flush(); await flush();
    expect(chat.snapshot.line).toBe('window');
    expect(chat.sessionId).not.toBeNull();
    expect(mic.active).toBe(true);
    chat.dispose();
  });
});
