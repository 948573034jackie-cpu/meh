import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const userData = vi.hoisted(() => { const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); return fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-hints-')); });
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false }, app: { getPath: () => userData, getAppPath: () => process.cwd() }, dialog: {} }));

import { HintsJob, hintsModelFor, HINTS_CACHE_VERSION } from '../../src/main/hints';
import type { HintsJobDeps } from '../../src/main/hints';
import { createDictionary } from '@core/dict/dictionary';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { Settings, UsageRecord } from '@shared/settings';
import type { DictData, HintsProgress } from '@shared/api';
import { makeBook } from './helpers';

const raw = (t: string, l: DictData['w'][string]['l'], f = 5000): DictData['w'][string] => ({ i: '', t, g: '', f, b: f, c: 3, o: 0, l, s: 'cefrj' });
const dict = createDictionary({ w: { the: raw('这', 'A1', 1), house: raw('房子', 'A1'), was: raw('是', 'A1'), serene: raw('平静的', 'C1'), reluctant: raw('不情愿的', 'C1'), he: raw('他', 'A1'), left: raw('离开', 'A1') }, f: {} });
const book = makeBook([{ title: 'One', paragraphs: ['The house was serene.'] }, { title: 'Two', paragraphs: ['He was reluctant.'] }, { title: 'Three', paragraphs: ['The house.'] }]);
book.id = 'book1';

const isPhrasePrompt = (user: string): boolean => user.startsWith('Phrases.');

function setup(over: Partial<HintsJobDeps> = {}, settings: Partial<Settings['ai']> = {}) {
  const events: HintsProgress[] = [];
  const usage: UsageRecord[] = [];
  const calls: { provider: string; model: string; user: string }[] = [];
  const s = structuredClone(DEFAULT_SETTINGS); Object.assign(s.ai, settings);
  const dir = fs.mkdtempSync(path.join(userData, 'hints-'));
  const deps: HintsJobDeps = {
    complete: async (provider, model, prompt) => {
      calls.push({ provider, model, user: prompt.user });
      if (isPhrasePrompt(prompt.user)) return { text: '{"phrases":[]}', inputTokens: 500, outputTokens: 10, cachedTokens: 0 };
      const text = prompt.user.includes('"serene"') ? '```json\n{"serene": ["宁静的", "安详的"]}\n```' : '{"reluctant": ["不情愿的", ""]}';
      return { text, inputTokens: 300, outputTokens: 40, cachedTokens: 0 };
    },
    loadBook: (id) => (id === 'book1' ? book : null),
    getDictionary: async () => dict,
    getSettings: () => s,
    getVocab: () => ({ words: {}, marked: {} }),
    addUsage: (r) => { usage.push(r); },
    usdSpent: () => 0,
    dir: () => dir,
    send: (ev) => { events.push(ev); },
    ...over,
  };
  return { job: new HintsJob(deps), events, usage, calls, dir, settings: s };
}

describe('HintsJob', () => {
  it('computes a chapter with the injected completion, caches it on disk and reports progress', async () => {
    const { job, events, usage, calls, dir } = setup();
    expect(job.get('book1', 0)).toBeNull();
    job.request('book1', 0);
    await job.idle();
    expect(events.map((e) => e.state)).toEqual(['queued', 'running', 'done']);
    expect(job.get('book1', 0)).toEqual({ serene: ['宁静的', '安详的'] });
    // one hints request and one phrases request, both recorded
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => isPhrasePrompt(c.user))).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 300, outputTokens: 40 });
    expect(usage[0].usd).toBeCloseTo((300 * 0.10 + 40 * 0.50) / 1_000_000, 10);
    const file = path.join(dir, 'book1.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: HINTS_CACHE_VERSION, chapters: { '0': { serene: ['宁静的', '安详的'] } }, phrases: { '0': {} } });
    expect(job.phrases('book1', 0)).toEqual({});
    // a fresh job reads the file back; a cached chapter is not requested again
    const again = setup({ dir: () => dir });
    expect(again.job.get('book1', 0)).toEqual({ serene: ['宁静的', '安详的'] });
    again.job.request('book1', 0);
    await again.job.idle();
    expect(again.calls).toHaveLength(0);
    expect(again.events).toEqual([]);
    // clear forgets the file and the memory
    again.job.clear('book1');
    expect(again.job.get('book1', 0)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('runs one chapter at a time, the current one first, then the following, and dedupes requests', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const { job } = setup({ complete: async (_p, _m, prompt) => { if (!isPhrasePrompt(prompt.user)) order.push(prompt.user.split('\n')[0]); await gate; return { text: '{}', inputTokens: 1, outputTokens: 1, cachedTokens: 0 }; } });
    job.request('book1', 2); // first request starts immediately
    job.request('book1', 0);
    job.request('book1', 1);
    job.request('book1', 1);
    job.request('book1', 0); // the learner is reading chapter 0 now
    expect(job.pending.map((p) => p.chapter)).toEqual([0, 1]);
    release();
    await job.idle();
    // chapter 2 ran first (no hard words, so no model call), then the current chapter, then the next
    expect(order).toEqual(['Book: Test Book — One', 'Book: Test Book — Two']);
    expect(job.get('book1', 2)).toEqual({});
  });

  it('stores an empty map for a chapter without hard words and never asks the model for word hints', async () => {
    const { job, calls } = setup();
    job.request('book1', 2);
    await job.idle();
    expect(calls.filter((c) => !isPhrasePrompt(c.user))).toHaveLength(0);
    expect(job.get('book1', 2)).toEqual({});
  });

  it('stops at the monthly budget and reports an error without caching', async () => {
    const { job, events, calls } = setup({ usdSpent: () => 10 }, { monthlyStopUsd: 10 });
    job.request('book1', 0);
    await job.idle();
    expect(calls).toHaveLength(0);
    expect(job.get('book1', 0)).toBeNull();
    expect(events.at(-1)).toMatchObject({ state: 'error', code: 'budget' });
    // not retried right away
    job.request('book1', 0);
    await job.idle();
    expect(events.filter((e) => e.state === 'queued')).toHaveLength(1);
  });

  it('reports provider errors in the learner\'s words', async () => {
    const { job, events } = setup({ complete: async () => { throw Object.assign(new Error('Add your Anthropic API key in Settings.'), { code: 'no_key' }); } });
    job.request('book1', 0);
    await job.idle();
    expect(events.at(-1)).toMatchObject({ state: 'error', code: 'no_key', error: 'Add your Anthropic API key in Settings.' });
    const { job: j2, events: e2 } = setup({ complete: async () => { throw { status: 401, message: 'invalid x-api-key' }; } });
    j2.request('book1', 0);
    await j2.idle();
    expect(e2.at(-1)).toMatchObject({ state: 'error', code: 'auth' });
  });

  it('picks the hints model from settings', () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    expect(hintsModelFor(s)).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    s.ai.hintsModel = 'claude-sonnet-5-5';
    expect(hintsModelFor(s)).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    s.ai.provider = 'openai'; s.ai.hintsModel = null;
    expect(hintsModelFor(s)).toEqual({ provider: 'openai', model: s.ai.openaiModel });
  });
});
