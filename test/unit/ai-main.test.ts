import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const userData = vi.hoisted(() => { const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); return fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-ai-test-')); });
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false }, app: { getPath: () => userData } }));
vi.mock('../../src/main/secrets', () => ({ getSecret: () => 'sk-ant-test', hasSecret: () => true, formatWarning: () => null, getAzureCredentials: () => null }));
// the Anthropic SDK with its streaming replaced: the request params are recorded and the stream is driven by the test
const sdk = vi.hoisted(() => ({ params: [] as Record<string, unknown>[], aborted: 0, finish: null as null | { textAfterMs: number; endAfterMs: number; text: string } }));
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  const stream = (params: Record<string, unknown>, opts: { signal: AbortSignal }) => {
    sdk.params.push(params);
    const texts: ((t: string) => void)[] = [];
    let current: { usage: Record<string, number> } | undefined;
    const s = {
      get currentMessage() { return current; },
      on(ev: string, cb: (t: string) => void) { if (ev === 'text') texts.push(cb); return s; },
      finalMessage: () => new Promise((resolve, reject) => {
        const finish = sdk.finish;
        if (finish) {
          // a reply that completes: its first text after textAfterMs, the whole message after endAfterMs
          setTimeout(() => { for (const cb of texts) cb(finish.text); }, finish.textAfterMs);
          setTimeout(() => resolve({ content: [{ type: 'text', text: finish.text }], stop_reason: 'end_turn', usage: { input_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 40 } }), finish.endAfterMs);
          return;
        }
        // message_start (input and cache reads), then 37 characters of text, then nothing until the request is aborted
        current = { usage: { input_tokens: 1200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 3 } };
        setTimeout(() => { for (const cb of texts) cb('Sanguine means hopeful, full of hope.'); }, 5);
        opts.signal.addEventListener('abort', () => { sdk.aborted++; reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })); });
      }),
    };
    return s;
  };
  class FakeAnthropic extends real.default {
    constructor(o: ConstructorParameters<typeof real.default>[0]) {
      super(o);
      Object.assign(this, { messages: { stream }, beta: { messages: { stream } } });
    }
  }
  return { ...real, default: FakeAnthropic };
});
import { ipcMain } from 'electron';
import { estimateUsd, classifyError, periodStarts, registerAiHandlers, partialUsage, anthropicModelParams } from '../../src/main/ai';
import { getUsage, setSettings } from '../../src/main/settings';
import type { AiEvent, ExplainRequest } from '@shared/api';

describe('AI main helpers', () => {
  it('prices models by prefix and charges cached tokens at the cache rate', () => {
    expect(estimateUsd('claude-opus-5-5-20260601', 1_000_000, 0, 0)).toBeCloseTo(4);
    expect(estimateUsd('claude-opus-5-5', 1_000_000, 0, 1_000_000)).toBeCloseTo(0.2);
    expect(estimateUsd('gpt-5-mini-2026-01-01', 0, 1_000_000, 0)).toBeCloseTo(2);
  });
  it('classifies provider errors the learner can act on', () => {
    expect(classifyError(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })).code).toBe('cancelled');
    expect(classifyError({ status: 400, message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.' }).code).toBe('spend_limit');
    expect(classifyError({ status: 429, message: 'You exceeded your current quota, please check your plan and billing details.' }).code).toBe('spend_limit');
    expect(classifyError({ status: 529, message: 'Overloaded' }).code).toBe('rate_limit');
    expect(classifyError({ status: 401, message: 'invalid x-api-key' }).code).toBe('auth');
    expect(classifyError(new TypeError('fetch failed')).code).toBe('network');
  });
  it('measures the daily and monthly budget from local midnight', () => {
    const { day, month } = periodStarts();
    const d = new Date(day), m = new Date(month), now = new Date();
    expect([d.getHours(), d.getMinutes(), d.getDate(), d.getMonth()]).toEqual([0, 0, now.getDate(), now.getMonth()]);
    expect([m.getHours(), m.getDate(), m.getMonth()]).toEqual([0, 1, now.getMonth()]);
    expect(day <= now.toISOString()).toBe(true);
    expect(fs.existsSync(userData) || os.platform() === 'win32' || path.isAbsolute(userData)).toBe(true);
  });
});

describe('AI main: cancelled requests and per-model options', () => {
  const REQ = { kind: 'word', target: 'sanguine', sentence: 'He was sanguine.', before: '', after: '', book: { title: 'T', chapter: 'C' }, history: [] } as unknown as ExplainRequest;
  function handlers() {
    const events: AiEvent[] = [];
    registerAiHandlers(() => ({ isDestroyed: () => false, webContents: { send: (_ch: string, ev: AiEvent) => events.push(ev) } }) as never);
    const calls = vi.mocked(ipcMain.handle).mock.calls;
    const get = (ch: string) => calls.filter((c) => c[0] === ch).at(-1)![1] as (...a: unknown[]) => Promise<unknown>;
    return { events, explain: get('ai:explain'), cancel: get('ai:cancel') };
  }
  const until = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); if (!cond()) throw new Error('timeout'); };

  it('a stream cancelled mid-way still records what it used (marked partial), before the cancelled error is sent', async () => {
    const h = handlers();
    const before = getUsage().length;
    const { streamId } = await h.explain({}, REQ) as { streamId: string };
    await until(() => h.events.some((e) => e.type === 'delta'));
    await h.cancel({}, streamId);
    await until(() => h.events.some((e) => e.type === 'error'));
    expect(h.events.at(-1)).toMatchObject({ type: 'error', streamId, code: 'cancelled' });
    const rec = getUsage().slice(before);
    expect(rec).toHaveLength(1);
    // input and cache reads exactly; output at least the streamed characters / 4 (hidden thinking is not known)
    expect(rec[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 2200, cachedTokens: 1000, outputTokens: 10, partial: true });
    expect(rec[0].usd).toBeCloseTo(estimateUsd('claude-opus-5-5', 2200, 10, 1000), 10);
    expect(sdk.params.at(-1)).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low' } });
    expect(sdk.params.at(-1)).not.toHaveProperty('thinking'); // Opus 5.5 cannot turn thinking off
  });

  it('claude-haiku-5-5 is asked with thinking disabled (allowed at effort low); other models keep adaptive thinking', async () => {
    expect(anthropicModelParams('claude-haiku-5-5')).toEqual({ thinking: { type: 'disabled' } });
    expect(anthropicModelParams('claude-opus-5-5')).toEqual({});
    expect(anthropicModelParams('claude-sonnet-5-5')).toEqual({});
    setSettings({ ai: { ...(await import('../../src/main/settings')).getSettings().ai, anthropicModel: 'claude-haiku-5-5' } });
    const h = handlers();
    const { streamId } = await h.explain({}, { ...REQ, kind: 'question', question: 'why?' }) as { streamId: string };
    await until(() => sdk.params.length > 0 && sdk.params.at(-1)!.model === 'claude-haiku-5-5');
    expect(sdk.params.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, output_config: { effort: 'low' } });
    await h.cancel({}, streamId);
    await until(() => h.events.some((e) => e.type === 'error'));
  });

  it('the done usage and the usage record carry the time to the first words and to the whole reply (Diagnostics)', async () => {
    sdk.finish = { textAfterMs: 60, endAfterMs: 120, text: 'Sanguine means hopeful.' };
    try {
      const h = handlers();
      const before = getUsage().length;
      const { streamId } = await h.explain({}, REQ) as { streamId: string };
      await until(() => h.events.some((e) => e.type === 'done' && e.streamId === streamId));
      const done = h.events.find((e) => e.type === 'done' && e.streamId === streamId) as Extract<AiEvent, { type: 'done' }>;
      expect(done.text).toBe('Sanguine means hopeful.');
      const { ttftMs, totalMs } = done.usage;
      expect(ttftMs).toBeGreaterThanOrEqual(50);
      expect(totalMs).toBeGreaterThanOrEqual(110);
      expect(totalMs! - ttftMs!).toBeGreaterThanOrEqual(40);
      const rec = getUsage().slice(before);
      expect(rec).toHaveLength(1);
      expect(rec[0]).toMatchObject({ ttftMs, totalMs, inputTokens: 1200, outputTokens: 40, cachedTokens: 1000 });
      expect(rec[0]).not.toHaveProperty('partial');
    } finally { sdk.finish = null; }
  });

  it('a cancelled request keeps its time to the first words, but has no total', async () => {
    const h = handlers();
    const before = getUsage().length;
    const { streamId } = await h.explain({}, REQ) as { streamId: string };
    await until(() => h.events.some((e) => e.type === 'delta' && e.streamId === streamId));
    await h.cancel({}, streamId);
    await until(() => h.events.some((e) => e.type === 'error' && e.streamId === streamId));
    const rec = getUsage().slice(before);
    expect(rec).toHaveLength(1);
    expect(rec[0].partial).toBe(true);
    expect(rec[0].ttftMs).toBeGreaterThanOrEqual(0);
    expect(rec[0]).not.toHaveProperty('totalMs');
  });

  it('partialUsage: nothing before the reply started; output never below the reported count', () => {
    expect(partialUsage(undefined, 400)).toBeUndefined();
    expect(partialUsage({ input_tokens: 10, output_tokens: 50 }, 40)).toEqual({ text: '', inputTokens: 10, outputTokens: 50, cachedTokens: 0 });
  });
});
