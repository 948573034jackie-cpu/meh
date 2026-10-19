import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const userData = vi.hoisted(() => { const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); return fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-phrases-')); });
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); } },
  BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false },
  app: { getPath: () => userData, getAppPath: () => process.cwd() }, dialog: {},
}));

import { HintsJob, HINTS_CACHE_VERSION, registerHintsHandlers, hintsDir } from '../../src/main/hints';
import type { HintsJobDeps } from '../../src/main/hints';
import { createDictionary } from '@core/dict/dictionary';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { DictData, HintsProgress, PhraseMap } from '@shared/api';
import { makeBook } from './helpers';

const raw = (t: string, l: string): DictData['w'][string] => ({ i: '', t, g: '', f: 5000, b: 5000, c: 3, o: 0, l, s: 'cefrj' });
const dict = createDictionary({
  w: { take: raw('vt. 拿', 'A1'), for: raw('prep. 为了', 'A1'), granted: raw('a. 同意的', 'B2'), old: raw('a. 老的', 'A1'), man: raw('n. 男人, 人', 'A1'), give: raw('vt. 给', 'A1'), up: raw('adv. 向上', 'A1') },
  f: { took: 'take', gave: 'give' },
});
const book = makeBook([{ title: 'One', paragraphs: ['The old man took it for granted.', 'He gave up. Later he takes it for granted again.'] }]);
book.id = 'pbook';

const REPLY = JSON.stringify({ phrases: [
  { text: 'took it for granted', lemma: 'take for granted', level: 'B2', zh: '视为理所当然' },
  { text: 'gave up', lemma: 'give up', level: 'A2', zh: '放弃' },
  { text: 'old man', lemma: 'old man', level: 'B1', zh: '老人' },            // free combination
  { text: 'kick the bucket', lemma: 'kick the bucket', level: 'C1', zh: '死' }, // not in the chapter
  { text: 'take for granted', lemma: 'take for granted', level: 'X1', zh: '' }, // bad level
] });

function setup(dir: string, reply = REPLY) {
  const events: HintsProgress[] = [];
  const users: string[] = [];
  const s = structuredClone(DEFAULT_SETTINGS); s.learnerLevel = 'B1';
  const deps: HintsJobDeps = {
    complete: async (_p, _m, prompt) => { users.push(prompt.user); return { text: prompt.user.startsWith('Phrases.') ? reply : '{}', inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }; },
    loadBook: (id) => (id === 'pbook' ? book : null),
    getDictionary: async () => dict,
    getSettings: () => s,
    getVocab: () => ({ words: {}, marked: {} }),
    addUsage: () => {},
    usdSpent: () => 0,
    dir: () => dir,
    send: (ev) => { events.push(ev); },
  };
  return { job: new HintsJob(deps), events, users };
}

describe('HintsJob phrases', () => {
  it('asks for the chapter phrases, keeps the valid ones and maps them to token spans per sentence', async () => {
    const dir = fs.mkdtempSync(path.join(userData, 'job-'));
    const { job, events, users } = setup(dir);
    expect(job.phrases('pbook', 0)).toBeNull();
    job.request('pbook', 0);
    await job.idle();
    expect(events.map((e) => e.state)).toEqual(['queued', 'running', 'done']);
    const phrasePrompts = users.filter((u) => u.startsWith('Phrases.'));
    expect(phrasePrompts).toHaveLength(1);
    expect(phrasePrompts[0]).toContain('The old man took it for granted.');
    const map = job.phrases('pbook', 0)!;
    expect(Object.keys(map).sort()).toEqual(['0.0.0', '0.1.0', '0.1.1']);
    expect(map['0.0.0']).toEqual([{ sentenceKey: '0.0.0', start: 3, end: 6, text: 'took it for granted', lemma: 'take for granted', level: 'B2', zh: '视为理所当然' }]);
    expect(map['0.1.0'].map((h) => [h.text, h.level])).toEqual([['gave up', 'A2']]);
    expect(map['0.1.1'].map((h) => h.text)).toEqual(['takes it for granted']);   // inflected, found by the lemma
  });

  it('round-trips the cache file and recomputes an older cache version', async () => {
    const dir = fs.mkdtempSync(path.join(userData, 'cache-'));
    const first = setup(dir);
    first.job.request('pbook', 0);
    await first.job.idle();
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'pbook.json'), 'utf8'));
    expect(stored.version).toBe(HINTS_CACHE_VERSION);
    expect(stored.phrases['0']).toEqual(first.job.phrases('pbook', 0));
    const again = setup(dir);
    expect(again.job.phrases('pbook', 0)).toEqual(first.job.phrases('pbook', 0));
    again.job.request('pbook', 0);
    await again.job.idle();
    expect(again.users).toHaveLength(0);
    // a version-1 cache (hints only, no phrases) is dropped and the chapter is computed again
    fs.writeFileSync(path.join(dir, 'pbook.json'), JSON.stringify({ version: 1, chapters: { '0': {} } }));
    const old = setup(dir);
    expect(old.job.get('pbook', 0)).toBeNull();
    expect(old.job.phrases('pbook', 0)).toBeNull();
    old.job.request('pbook', 0);
    await old.job.idle();
    expect(old.users.some((u) => u.startsWith('Phrases.'))).toBe(true);
    expect(old.job.phrases('pbook', 0)).not.toBeNull();
  });

  it('stores an empty map when the model finds nothing usable', async () => {
    const dir = fs.mkdtempSync(path.join(userData, 'none-'));
    const { job } = setup(dir, 'Sorry, nothing here.');
    job.request('pbook', 0);
    await job.idle();
    expect(job.phrases('pbook', 0)).toEqual({});
  });

  it('serves hints:phrases over IPC from the cache', async () => {
    const map: PhraseMap = { '2.0.1': [{ sentenceKey: '2.0.1', start: 0, end: 1, text: 'gave up', lemma: 'give up', level: 'A2', zh: '放弃' }] };
    fs.writeFileSync(path.join(hintsDir(), 'ipcbook.json'), JSON.stringify({ version: HINTS_CACHE_VERSION, chapters: { '2': {} }, phrases: { '2': map } }));
    registerHintsHandlers(() => null);
    const h = handlers.get('hints:phrases')!;
    expect(h).toBeTypeOf('function');
    expect(await h({}, 'ipcbook', 2)).toEqual(map);
    expect(await h({}, 'ipcbook', 3)).toBeNull();
    expect(await h({}, 'nobook', 0)).toBeNull();
  });
});
