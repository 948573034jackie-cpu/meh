import { describe, it, expect, vi } from 'vitest';
import { VoiceSession, type SttEngineEvent, type SttEventSource } from '../../src/core/voice/session';
import type { CommandEvent, QuestionEvent } from '../../src/core/voice/turns';

/** A fake stt:event stream: `emit` pushes to every attached listener. */
function fakeSource(): { source: SttEventSource; emit: (e: SttEngineEvent) => void; listeners: number } {
  const set = new Set<(e: SttEngineEvent) => void>();
  const api = {
    source: ((l: (e: SttEngineEvent) => void) => { set.add(l); return () => set.delete(l); }) as SttEventSource,
    emit: (e: SttEngineEvent) => { for (const l of [...set]) l(e); },
    get listeners() { return set.size; },
  };
  return api;
}

const S = 'mic1';
const final = (text: string, segmentId: string, confidence?: number): SttEngineEvent => ({ type: 'final', text, segmentId, sessionId: S, confidence });
const partial = (text: string, segmentId: string): SttEngineEvent => ({ type: 'partial', text, segmentId, sessionId: S });

function setup(mode: 'commands' | 'conversation' | 'off', now = { t: 0 }) {
  const src = fakeSource();
  const vs = new VoiceSession({ mode, listener: { now: () => now.t } });
  const commands: CommandEvent[] = [], questions: QuestionEvent[] = [], starts: string[] = [], partials: string[] = [], modes: string[] = [];
  vs.on('command', (c) => commands.push(c));
  vs.on('question', (q) => questions.push(q));
  vs.on('speechStart', (e) => starts.push(e.segmentId));
  vs.on('partial', (p) => partials.push(p.text));
  vs.on('mode', (to, from) => modes.push(`${from}>${to}`));
  vs.attach(src.source);
  return { src, vs, commands, questions, starts, partials, modes, now };
}

describe('VoiceSession in commands mode', () => {
  it('fires the three commands from finals', () => {
    const { src, commands, questions } = setup('commands');
    const now = { t: 0 };
    void now;
    src.emit(final('I know', 's1'));
    expect(commands.map((c) => c.intent)).toEqual(['know']);
    expect(questions).toEqual([]);
  });

  it('fires once per segment, debounced, and from two agreeing partials', () => {
    const { src, commands, now } = setup('commands');
    src.emit(partial('i don', 's1'));
    src.emit(partial("i don't know", 's1'));
    src.emit(partial("i don't know", 's1'));
    expect(commands.map((c) => [c.intent, c.via])).toEqual([['dont_know', 'partials']]);
    src.emit(final("I don't know", 's1')); // same segment: nothing more
    expect(commands).toHaveLength(1);
    now.t = 500;
    src.emit(final('I know', 's2')); // inside the 1 s debounce: dropped
    expect(commands).toHaveLength(1);
    now.t = 2000;
    src.emit(final('I know', 's3'));
    expect(commands.map((c) => c.intent)).toEqual(['dont_know', 'know']);
  });

  it('turns any other final into a question and ignores empty finals', () => {
    const { src, commands, questions } = setup('commands');
    src.emit(final('What does this word mean?', 's1', 0.9));
    src.emit(final('', 's2'));
    src.emit(final('um', 's3'));
    expect(commands).toEqual([]);
    expect(questions).toEqual([{ text: 'What does this word mean?', segmentId: 's1', confidence: 0.9 }]);
  });

  it('"bye bye" fires and switches to off; nothing fires afterwards', () => {
    const { src, vs, commands, questions, starts, modes, now } = setup('commands');
    src.emit(final('bye bye', 's1'));
    expect(commands.map((c) => c.intent)).toEqual(['bye']);
    expect(vs.mode).toBe('off');
    expect(modes).toEqual(['commands>off']);
    now.t = 5000;
    src.emit({ type: 'speechStart', sessionId: S, segmentId: 's2' });
    src.emit(final('I know', 's2'));
    src.emit(final('tell me more', 's3'));
    expect(commands).toHaveLength(1);
    expect(questions).toEqual([]);
    expect(starts).toEqual([]);
  });

  it('re-emits speechStart / speechEnd and partial text for the UI', () => {
    const { src, starts, partials, vs } = setup('commands');
    const ends: string[] = [];
    vs.on('speechEnd', (e) => ends.push(e.segmentId));
    src.emit({ type: 'speechStart', sessionId: S, segmentId: 's1' });
    src.emit(partial('hello th', 's1'));
    src.emit(partial('  ', 's1'));
    src.emit({ type: 'speechEnd', sessionId: S, segmentId: 's1' });
    expect(starts).toEqual(['s1']);
    expect(ends).toEqual(['s1']);
    expect(partials).toEqual(['hello th']);
  });
});

describe('VoiceSession in conversation mode', () => {
  it('routes "I know" / "I don\'t know" finals to the AI as questions, keeps "bye bye" as a command', () => {
    const { src, vs, commands, questions, now } = setup('conversation');
    src.emit(final('I know', 's1'));
    now.t = 3000;
    src.emit(final("I don't know", 's2'));
    expect(commands).toEqual([]);
    expect(questions.map((q) => q.text)).toEqual(['I know', "I don't know"]);
    now.t = 6000;
    src.emit(final('bye bye', 's3'));
    expect(commands.map((c) => c.intent)).toEqual(['bye']);
    expect(vs.mode).toBe('off');
  });

  it('does not let agreeing partials swallow the final', () => {
    const { src, commands, questions } = setup('conversation');
    src.emit(partial('i know', 's1'));
    src.emit(partial('i know', 's1'));
    expect(commands).toEqual([]);
    src.emit(final('I know the answer is seven', 's1'));
    expect(questions.map((q) => q.text)).toEqual(['I know the answer is seven']);
  });
});

describe('VoiceSession plumbing', () => {
  it('filters by session id and forwards errors even when off', () => {
    const src = fakeSource();
    const vs = new VoiceSession({ mode: 'commands', sessionId: 'a' });
    const commands: CommandEvent[] = []; const errors: string[] = [];
    vs.on('command', (c) => commands.push(c));
    vs.on('error', (e) => errors.push(e.message));
    vs.attach(src.source);
    src.emit({ type: 'final', text: 'I know', segmentId: 'x', sessionId: 'b' });
    expect(commands).toEqual([]);
    src.emit({ type: 'final', text: 'I know', segmentId: 'y', sessionId: 'a' });
    expect(commands).toHaveLength(1);
    vs.setMode('off');
    src.emit({ type: 'error', sessionId: 'a', message: 'boom' });
    expect(errors).toEqual(['boom']);
  });

  it('setMode resets pending partials and detach unsubscribes', () => {
    const { src, vs, commands } = setup('commands');
    src.emit(partial('i know', 's1'));
    vs.setMode('conversation');
    vs.setMode('commands');
    src.emit(partial('i know', 's1'));
    expect(commands).toEqual([]); // the pending partial from before the mode change was forgotten
    expect(src.listeners).toBe(1);
    vs.detach();
    expect(src.listeners).toBe(0);
    const spy = vi.fn();
    vs.on('command', spy);
    src.emit(final('I know', 's9'));
    expect(spy).not.toHaveBeenCalled();
  });
});
