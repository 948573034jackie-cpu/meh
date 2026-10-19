import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandListener, ConversationTurn, type CommandEvent, type QuestionEvent, type TurnState } from '@core/voice/turns';

function collect(listener: CommandListener) {
  const commands: CommandEvent[] = [];
  const questions: QuestionEvent[] = [];
  const suppressed: CommandEvent[] = [];
  listener.on('command', (e) => commands.push(e));
  listener.on('question', (e) => questions.push(e));
  listener.on('suppressed', (e) => suppressed.push(e));
  return { commands, questions, suppressed };
}

describe('CommandListener', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires immediately on a final transcript', () => {
    const l = new CommandListener();
    const { commands } = collect(l);
    const r = l.push({ type: 'final', text: 'I know', segmentId: 1 });
    expect(r).toMatchObject({ intent: 'know', via: 'final', segmentId: 1, matched: 'i know' });
    expect(commands).toHaveLength(1);
  });

  it('needs two agreeing partials before firing', () => {
    const l = new CommandListener();
    const { commands } = collect(l);
    expect(l.push({ type: 'partial', text: 'bye', segmentId: 's1' })).toBeNull();
    expect(commands).toHaveLength(0);
    const r = l.push({ type: 'partial', text: 'bye bye', segmentId: 's1' });
    expect(r).toMatchObject({ intent: 'bye', via: 'partials' });
    expect(commands).toHaveLength(1);
  });

  it('does not fire on partials that disagree, and a non-command partial resets agreement', () => {
    const l = new CommandListener();
    const { commands } = collect(l);
    l.push({ type: 'partial', text: 'I know', segmentId: 1 });
    l.push({ type: 'partial', text: "I don't know", segmentId: 1 });
    expect(commands).toHaveLength(0);
    l.push({ type: 'partial', text: 'I', segmentId: 1 }); // not a command: resets agreement
    l.push({ type: 'partial', text: "I don't know", segmentId: 1 });
    expect(commands).toHaveLength(0);
    l.push({ type: 'partial', text: "I don't know", segmentId: 1 });
    expect(commands).toHaveLength(1);
    expect(commands[0].intent).toBe('dont_know');
  });

  it('emits at most one command per segment', () => {
    const l = new CommandListener();
    const { commands } = collect(l);
    l.push({ type: 'partial', text: 'I know', segmentId: 7 });
    l.push({ type: 'partial', text: 'I know', segmentId: 7 });
    vi.advanceTimersByTime(2000);
    expect(l.push({ type: 'final', text: 'I know', segmentId: 7 })).toBeNull();
    expect(commands).toHaveLength(1);
  });

  it('debounces: a second command within 1 s is suppressed, after 1 s it fires', () => {
    const l = new CommandListener();
    const { commands, suppressed } = collect(l);
    l.push({ type: 'final', text: 'I know', segmentId: 1 });
    vi.advanceTimersByTime(500);
    expect(l.push({ type: 'final', text: 'bye bye', segmentId: 2 })).toBeNull();
    expect(suppressed).toHaveLength(1);
    expect(commands).toHaveLength(1);
    vi.advanceTimersByTime(600); // 1100 ms after the first command
    expect(l.push({ type: 'final', text: 'bye bye', segmentId: 3 })).toMatchObject({ intent: 'bye' });
    expect(commands.map((c) => c.intent)).toEqual(['know', 'bye']);
  });

  it('a suppressed segment stays consumed', () => {
    const l = new CommandListener({ debounceMs: 1000 });
    const { commands } = collect(l);
    l.push({ type: 'final', text: 'I know', segmentId: 1 });
    vi.advanceTimersByTime(200);
    l.push({ type: 'partial', text: 'bye bye', segmentId: 2 });
    l.push({ type: 'partial', text: 'bye bye', segmentId: 2 }); // suppressed
    vi.advanceTimersByTime(2000);
    expect(l.push({ type: 'final', text: 'bye bye', segmentId: 2 })).toBeNull();
    expect(commands).toHaveLength(1);
  });

  it('honours a custom debounce and clock', () => {
    let t = 0;
    const l = new CommandListener({ debounceMs: 250, now: () => t });
    const { commands } = collect(l);
    l.push({ type: 'final', text: 'I know', segmentId: 1 });
    t = 200;
    l.push({ type: 'final', text: 'I know', segmentId: 2 });
    t = 260;
    l.push({ type: 'final', text: 'I know', segmentId: 3 });
    expect(commands.map((c) => c.segmentId)).toEqual([1, 3]);
  });

  it('emits question for a non-command final and nothing for an empty final', () => {
    const l = new CommandListener();
    const { commands, questions } = collect(l);
    l.push({ type: 'partial', text: 'what does', segmentId: 1 });
    expect(questions).toHaveLength(0);
    l.push({ type: 'final', text: 'what does this word mean', segmentId: 1, confidence: 0.9 });
    expect(questions).toEqual([{ text: 'what does this word mean', segmentId: 1, confidence: 0.9 }]);
    l.push({ type: 'final', text: '', segmentId: 2 });
    expect(questions).toHaveLength(1);
    expect(commands).toHaveLength(0);
    // the segment is consumed: a late command final for it is ignored
    expect(l.push({ type: 'final', text: 'I know', segmentId: 1 })).toBeNull();
  });

  it('passes confidence through to the classifier', () => {
    const l = new CommandListener();
    const { commands, questions } = collect(l);
    l.push({ type: 'final', text: 'i kno', segmentId: 1, confidence: 0.3 });
    expect(commands).toHaveLength(0);
    expect(questions).toHaveLength(1);
    l.push({ type: 'final', text: 'i kno', segmentId: 2, confidence: 0.9 });
    expect(commands).toHaveLength(1);
  });

  it('reset forgets pending partials and consumed segments', () => {
    const l = new CommandListener();
    const { commands } = collect(l);
    l.push({ type: 'partial', text: 'I know', segmentId: 1 });
    l.reset();
    l.push({ type: 'partial', text: 'I know', segmentId: 1 });
    expect(commands).toHaveLength(0);
    l.push({ type: 'partial', text: 'I know', segmentId: 1 });
    expect(commands).toHaveLength(1);
    l.reset();
    vi.advanceTimersByTime(1500);
    expect(l.push({ type: 'final', text: 'I know', segmentId: 1 })).not.toBeNull();
  });

  it('supports an injected classifier and unsubscribing', () => {
    const detect = vi.fn(() => ({ intent: 'bye' as const, score: 1, matched: 'stub' }));
    const l = new CommandListener({ detect });
    const seen: string[] = [];
    const off = l.on('command', (e) => seen.push(e.matched ?? ''));
    l.push({ type: 'final', text: 'anything', segmentId: 'a' });
    off();
    vi.advanceTimersByTime(1500);
    l.push({ type: 'final', text: 'anything', segmentId: 'b' });
    expect(seen).toEqual(['stub']);
    expect(detect).toHaveBeenCalledWith('anything', { confidence: undefined, minRatio: undefined });
  });
});

describe('ConversationTurn', () => {
  it('walks idle → listening → thinking → speaking → listening', () => {
    const t = new ConversationTurn();
    const log: string[] = [];
    t.on('state', (to, from) => log.push(`${from}>${to}`));
    expect(t.state).toBe('idle');
    expect(t.listen()).toBe(true);
    expect(t.think()).toBe(true);
    expect(t.speak()).toBe(true);
    expect(t.done()).toBe(true);
    expect(t.state).toBe('listening');
    expect(log).toEqual(['idle>listening', 'listening>thinking', 'thinking>speaking', 'speaking>listening']);
  });

  it('ignores invalid transitions', () => {
    const t = new ConversationTurn();
    const states: TurnState[] = [];
    t.on('state', (to) => states.push(to));
    expect(t.speak()).toBe(false);
    expect(t.think()).toBe(false);
    expect(t.done()).toBe(false);
    expect(t.listen()).toBe(true);
    expect(t.listen()).toBe(false);
    expect(t.speak()).toBe(false); // listening → speaking is not allowed
    expect(t.state).toBe('listening');
    expect(states).toEqual(['listening']);
  });

  it('interrupt() on VAD speech start while speaking returns to listening and emits interrupt', () => {
    const t = new ConversationTurn();
    const interrupted: TurnState[] = [];
    t.on('interrupt', (from) => interrupted.push(from));
    t.listen(); t.think(); t.speak();
    expect(t.onSpeechStart()).toBe(true);
    expect(t.state).toBe('listening');
    expect(interrupted).toEqual(['speaking']);
    expect(t.done()).toBe(false); // nothing left to finish
  });

  it('interrupt() is a no-op while listening or idle, but cancels thinking', () => {
    const t = new ConversationTurn();
    const interrupted: TurnState[] = [];
    t.on('interrupt', (from) => interrupted.push(from));
    expect(t.interrupt()).toBe(false);
    t.listen();
    expect(t.interrupt()).toBe(false);
    t.think();
    expect(t.interrupt()).toBe(true);
    expect(t.state).toBe('listening');
    expect(interrupted).toEqual(['thinking']);
  });

  it('bye() ends the conversation from any active state and emits bye', () => {
    for (const setup of [(t: ConversationTurn) => t.listen(), (t: ConversationTurn) => { t.listen(); t.think(); }, (t: ConversationTurn) => { t.listen(); t.think(); t.speak(); }]) {
      const t = new ConversationTurn();
      const byes: TurnState[] = [];
      t.on('bye', (from) => byes.push(from));
      setup(t);
      const from = t.state;
      expect(t.bye()).toBe(true);
      expect(t.state).toBe('idle');
      expect(byes).toEqual([from]);
      expect(t.bye()).toBe(false);
    }
  });

  it('once() fires a single time and off() removes a listener', () => {
    const t = new ConversationTurn();
    const seen: TurnState[] = [];
    t.once('state', (to) => seen.push(to));
    const fn = (to: TurnState) => seen.push(to);
    t.on('state', fn);
    t.listen();
    t.off('state', fn);
    t.think();
    expect(seen).toEqual(['listening', 'listening']);
  });
});
