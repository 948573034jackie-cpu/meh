import { describe, it, expect, vi } from 'vitest';
import { PreparedExplanation, FIRST_TEXT_MS, NEXT_TEXT_MS, type ExplainFn } from '@core/listen/prepared';
import type { ExplainRequest } from '@shared/api';
import { pauseParts, sentenceSteps, SpokenPlan, englishTexts } from '@core/listen/script';
import { cleanSpokenProse } from '@core/ai/prompts';

const REQ = { kind: 'word', target: 'sanguine', sentence: 'He was sanguine.', before: '', after: '', book: { title: '', chapter: '' }, history: [] } as unknown as ExplainRequest;
function fake() {
  const c = { cancelled: 0, delta: (_: string) => undefined as void, resolve: (_: string) => undefined as void, reject: (_: Error) => undefined as void };
  const explain: ExplainFn = (_req, onDelta) => {
    c.delta = onDelta;
    const done = new Promise<{ text: string; usage: { usd: number; dailyUsd: number; monthlyUsd: number } }>((res, rej) => { c.resolve = (text) => res({ text, usage: { usd: 0.01, dailyUsd: 0.5, monthlyUsd: 2 } }); c.reject = rej; });
    done.catch(() => undefined);
    return { done, cancel: () => { c.cancelled++; c.reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })); } };
  };
  return { c, explain };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PreparedExplanation', () => {
  it('streams silently, then take() replays the text so far and every later update', async () => {
    const { c, explain } = fake();
    const seen: string[] = [];
    const p = new PreparedExplanation(explain, REQ, { onText: (t) => seen.push(t) });
    c.delta('Sanguine');
    c.delta('Sanguine means');
    expect(seen).toEqual(['Sanguine', 'Sanguine means']);
    const got: string[] = [];
    const s = p.take((t) => got.push(t))!;
    expect(got).toEqual(['Sanguine means']);
    c.delta('Sanguine means hopeful.');
    expect(got).toEqual(['Sanguine means', 'Sanguine means hopeful.']);
    expect(seen).toHaveLength(2); // onText is for the time before take()
    c.resolve('Sanguine means hopeful.');
    expect((await s.done).text).toBe('Sanguine means hopeful.');
    expect(p.status).toBe('taken');
  });

  it('cancel() stops the request once; take() after it returns null; cancel() after take() does nothing', async () => {
    const a = fake();
    const p = new PreparedExplanation(a.explain, REQ);
    p.cancel(); p.cancel();
    expect(a.c.cancelled).toBe(1);
    expect(p.take(() => undefined)).toBeNull();
    const b = fake();
    const q = new PreparedExplanation(b.explain, REQ);
    q.take(() => undefined);
    q.cancel();
    expect(b.c.cancelled).toBe(0);
  });

  it('onDone reports the usage of a complete reply even when nobody takes it', async () => {
    const { c, explain } = fake();
    const done: number[] = [];
    const p = new PreparedExplanation(explain, REQ, { onDone: (_t, u) => done.push(u.dailyUsd) });
    c.resolve('All of it.');
    await tick();
    expect(p.settled).toBe('done');
    p.cancel();
    expect(done).toEqual([0.5]);
  });

  it('a failure is kept for take(): the caller sees the rejected reply (offline fallback there)', async () => {
    const { c, explain } = fake();
    const p = new PreparedExplanation(explain, REQ);
    c.reject(Object.assign(new Error('offline'), { code: 'network' }));
    await tick();
    expect(p.settled).toBe('error');
    await expect(p.take(() => undefined)!.done).rejects.toThrow('offline');
  });
});

describe('PreparedExplanation: hooks and the stall guard after take()', () => {
  it('onCancel runs once when it is dropped before take(), never after take()', () => {
    const a = fake();
    let dropped = 0;
    const p = new PreparedExplanation(a.explain, REQ, { onCancel: () => dropped++ });
    p.cancel(); p.cancel();
    expect(dropped).toBe(1);
    const b = fake();
    const q = new PreparedExplanation(b.explain, REQ, { onCancel: () => dropped++ });
    q.take(() => undefined)!.cancel();
    q.cancel();
    expect(dropped).toBe(1);
    expect(b.c.cancelled).toBe(1); // the taken stream's own cancel
  });

  it('no text FIRST_TEXT_MS after take(): cancelled, done rejects with code timeout (the time before take() does not count)', async () => {
    vi.useFakeTimers();
    try {
      const { c, explain } = fake();
      const p = new PreparedExplanation(explain, REQ);
      await vi.advanceTimersByTimeAsync(FIRST_TEXT_MS + 5000); // the word and the window: the guard is not running yet
      expect(c.cancelled).toBe(0);
      const s = p.take(() => undefined)!;
      const failed = s.done.catch((e: Error & { code?: string }) => e.code);
      await vi.advanceTimersByTimeAsync(FIRST_TEXT_MS - 10);
      expect(c.cancelled).toBe(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(c.cancelled).toBe(1);
      expect(await failed).toBe('timeout');
    } finally { vi.useRealTimers(); }
  });

  it('text that stops for NEXT_TEXT_MS once started: given up; every new piece of text restarts that wait; done clears it', async () => {
    vi.useFakeTimers();
    try {
      const a = fake();
      const p = new PreparedExplanation(a.explain, REQ);
      a.c.delta('Sanguine');
      const s = p.take(() => undefined)!;
      const failed = s.done.catch((e: Error & { code?: string }) => e.code);
      await vi.advanceTimersByTimeAsync(NEXT_TEXT_MS - 100);
      a.c.delta('Sanguine means');
      await vi.advanceTimersByTimeAsync(NEXT_TEXT_MS - 100);
      expect(a.c.cancelled).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(a.c.cancelled).toBe(1);
      expect(await failed).toBe('timeout');
      // a reply that completes in time: nothing fires later
      const b = fake();
      const q = new PreparedExplanation(b.explain, REQ);
      const t = q.take(() => undefined)!;
      b.c.delta('Sanguine means hopeful.');
      b.c.resolve('Sanguine means hopeful.');
      expect((await t.done).text).toBe('Sanguine means hopeful.');
      await vi.advanceTimersByTimeAsync(FIRST_TEXT_MS * 2);
      expect(b.c.cancelled).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('streamed prose pieces', () => {
  it('pauseParts splits at the first [PAUSE] token and drops further ones', () => {
    expect(pauseParts('Was he happy?')).toEqual(['Was he happy?']);
    expect(pauseParts('[PAUSE]')).toEqual([null]);
    expect(pauseParts('Happy or sad? [PAUSE] He was happy. [PAUSE]')).toEqual(['Happy or sad?', null, 'He was happy.']);
  });
  it('sentenceSteps: markdown and labels removed, opening filler only for the first sentence, Chinese only when on', () => {
    expect(sentenceSteps('Great question! **Sanguine** means hopeful.', { first: true, chinese: false })).toEqual([{ type: 'say', text: 'Sanguine means hopeful.', lang: 'en', role: 'explanation' }]);
    expect(sentenceSteps('Now, he is calm.', { first: false, chinese: false }).map((s) => s.type === 'say' && s.text)).toEqual(['Now, he is calm.']);
    expect(sentenceSteps('It means 乐观的 here.', { first: false, chinese: true }).map((s) => s.type === 'say' && `${s.lang}:${s.text}`)).toEqual(['en:It means', 'zh:乐观的', 'en:here.']);
    expect(sentenceSteps('It means 乐观的 here.', { first: false, chinese: false }).map((s) => s.type === 'say' && s.text)).toEqual(['It means', 'here.']);
  });
  it('cleanSpokenProse({ opening: false }) keeps the start of a later sentence', () => {
    expect(cleanSpokenProse('Now, look again.')).toBe('Look again.');
    expect(cleanSpokenProse('Now, look again.', { opening: false })).toBe('Now, look again.');
  });
});

describe('SpokenPlan: what each streamed sentence says, fixed when it arrives', () => {
  it('opening filler only before anything was said; a filler-only or number-only sentence says nothing; one [PAUSE] wait', () => {
    const plan = new SpokenPlan({ pauses: true });
    const say = (piece: string) => plan.parts(piece).map((p) => (p === null ? 'WAIT' : p.map((st) => st.type === 'say' && `${st.lang}:${st.text}`).join(' | ')));
    expect(say('Great question!')).toEqual([]);
    expect(say('Now, sanguine means hopeful.')).toEqual(['en:Sanguine means hopeful.']);
    expect(say('Now, look at him.')).toEqual(['en:Now, look at him.']);
    expect(say('12.')).toEqual([]);
    expect(say('Is he happy? [PAUSE] Yes.')).toEqual(['en:Is he happy?', 'WAIT', 'en:Yes.']);
    expect(say('[PAUSE] He is.')).toEqual(['en:He is.']); // a later token is no second wait
    expect(say('In Chinese 乐观的 here.')).toEqual(['en:In Chinese | zh:乐观的 | en:here.']);
  });
  it('englishTexts: what the explanation voice will be asked for, in order (no Chinese, no waits)', () => {
    const plan = new SpokenPlan({ pauses: false });
    expect(englishTexts([...plan.parts('It means 乐观的 here.'), null, ...plan.parts('Then [PAUSE] more.')])).toEqual(['It means', 'here.', 'Then [PAUSE] more.']);
  });
});
