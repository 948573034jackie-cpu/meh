/**
 * The call with Claude: an empty answer is asked once more (the learner never gets silence), and a sentence with
 * Chinese in it is one piece for a cloud voice.
 */
import { describe, it, expect, vi } from 'vitest';

const answers: string[] = [];
vi.mock('../src/ai-client', () => ({
  chatStream: (_system: string, _turns: unknown[], onDelta: (full: string) => void) => {
    const text = answers.shift() ?? '';
    // (like the real port: the words come a moment later)
    const done = new Promise<string>((r) => setTimeout(() => { if (text) onDelta(text); r(text); }, 0));
    return { done, cancel() { /* nothing */ } };
  },
}));

const { ChatCall } = await import('../src/chat-call');

function call(mixed: boolean) {
  const said: string[] = [];
  const errors: string[] = [];
  const c = new ChatCall({
    system: () => 'sys',
    speak: (text) => { said.push(text); return { done: Promise.resolve('ended' as const), cancel() { /* nothing */ } } as never; },
    cancelSpeech: () => undefined, line: () => undefined, changed: () => undefined,
    error: (m) => errors.push(m), spoke: () => undefined, mixed: () => mixed,
  });
  return { c, said, errors };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('the call with Claude', () => {
  it('an empty answer is asked once more', async () => {
    answers.push('', 'A major is your main subject.');
    const { c, said, errors } = call(true);
    c.ask('what is a major');
    await tick(); await tick();
    expect(said).toEqual(['A major is your main subject.']);
    expect(errors).toEqual([]);
    expect(c.events.some((e) => /asking Claude again/.test(e))).toBe(true);
  });
  it('two empty answers: an error is shown, not silence', async () => {
    answers.push('', '');
    const { c, errors } = call(true);
    c.ask('hello');
    await tick(); await tick();
    expect(errors).toEqual(['Claude gave no answer']);
    expect(c.thinking).toBe(false);
  });
  it('English with Chinese in it: one piece for a cloud voice, pieces for the Mac voices', async () => {
    answers.push('In Chinese, it means 主修, your main subject.');
    const cloud = call(true);
    cloud.c.ask('in Chinese?');
    await tick(); await tick();
    expect(cloud.said).toEqual(['In Chinese, it means 主修, your main subject.']);
    answers.push('In Chinese, it means 主修, your main subject.');
    const mac = call(false);
    mac.c.ask('in Chinese?');
    await tick(); await tick();
    expect(mac.said.length).toBeGreaterThan(1);
  });
});
