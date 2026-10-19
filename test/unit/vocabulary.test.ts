import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A fresh userData and Documents folder for this file; electron is mocked like in secrets.test.ts.
const ctx = vi.hoisted(() => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-vocab-'));
  return { userData: path.join(root, 'userData'), documents: path.join(root, 'Documents') };
});
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: (name: string) => (name === 'documents' ? ctx.documents : ctx.userData), getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import * as vocab from '../../src/main/vocabulary';
import * as settings from '../../src/main/settings';
import type { DictData, VocabEntry, VocabEntryInput } from '../../src/shared/api';

const input = (lemma: string, extra: Partial<VocabEntryInput> = {}): VocabEntryInput => ({
  lemma, word: lemma, sentence: `A sentence with ${lemma}.`, explanation: `${lemma} means something.`, chinese: '意思',
  bookId: 'b1', bookTitle: 'Pride and Prejudice', chapter: 'Chapter 1', position: { chapter: 0, paragraph: 1, sentence: 2 }, ...extra,
});

const FAKE_DICT: DictData = {
  w: {
    house: { i: 'haʊs', t: 'n. 房子, 住宅\nvt. 给...房子住', g: '', f: 300, b: 250, c: 5, o: 1, l: 'A1', s: 'cefrj' },
    cat: { i: 'kæt', t: 'n. 猫', g: '', f: 1200, b: 1100, c: 4, o: 1, l: 'A1', s: 'cefrj' },
    dog: { i: 'dɒɡ', t: 'n. 狗', g: '', f: 900, b: 800, c: 4, o: 1, l: 'A1', s: 'oct' },
    apple: { i: 'ˈæpl', t: 'n. 苹果', g: '', f: 0, b: 0, c: 3, o: 1, l: 'A1', s: 'cefrj' },
    serene: { i: 'sɪˈriːn', t: 'a. 平静的', g: '', f: 9000, b: 8000, c: 2, o: 0, l: 'C1', s: 'oct' },
    ubiquitous: { i: '', t: 'a. 无处不在的', g: '', f: 11000, b: 0, c: 1, o: 0, l: 'C2', s: 'cefrj' },
    // estimated level: not a CEFR-list word, so never "unknown"
    zymurgy: { i: '', t: 'n. 酿造学', g: '', f: 0, b: 0, c: 0, o: 0, l: 'C2', s: 'est' },
    // a phrase: left out of the level counts
    'in spite of': { i: '', t: '尽管', g: '', f: 0, b: 0, c: 0, o: 0, l: 'B1', s: 'cefrj' },
  },
  f: {},
};

beforeAll(() => { fs.mkdirSync(ctx.userData, { recursive: true }); fs.mkdirSync(ctx.documents, { recursive: true }); });
afterEach(() => { vi.useRealTimers(); vocab.setDictionaryProvider(null); });

describe('My Vocabulary store', () => {
  it('saves an entry to data/vocabulary.json and marks the word learning', async () => {
    const e = await vocab.upsertEntry(input('serendipity'), new Date('2026-10-01T10:00:00Z'));
    expect(e).toMatchObject({ lemma: 'serendipity', timesExplained: 1, status: 'learning', again: 0, createdAt: '2026-10-01T10:00:00.000Z' });
    const file = path.join(ctx.userData, 'data', 'vocabulary.json');
    expect(fs.existsSync(file)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Record<string, VocabEntry> };
    expect(saved.entries.serendipity.sentence).toBe('A sentence with serendipity.');
    expect(settings.getVocab().words.serendipity).toBe('learning');
    expect(vocab.listEntries().map((x) => x.lemma)).toContain('serendipity');
  });

  it('merges a second explanation: counts, latest explanation, first sentence, "again"', async () => {
    await vocab.upsertEntry(input('candid', { sentence: 'He was candid.', explanation: 'first' }), new Date('2026-10-01T10:00:00Z'));
    const e = await vocab.upsertEntry(input('candid', { sentence: 'Another candid remark.', explanation: 'second, deeper', chinese: '坦率的', bookId: 'b2', bookTitle: 'Other', chapter: 'Chapter 9', again: true }), new Date('2026-10-02T10:00:00Z'));
    expect(e.timesExplained).toBe(2);
    expect(e.again).toBe(1);
    expect(e.sentence).toBe('He was candid.');
    expect(e.explanation).toBe('second, deeper');
    expect(e.chinese).toBe('坦率的');
    expect(e.bookTitle).toBe('Pride and Prejudice');
    expect(e.createdAt).toBe('2026-10-01T10:00:00.000Z');
    expect(e.lastSeenAt).toBe('2026-10-02T10:00:00.000Z');
    // an empty explanation never overwrites a saved one
    const e3 = await vocab.upsertEntry(input('candid', { explanation: '' }));
    expect(e3.explanation).toBe('second, deeper');
    expect(e3.timesExplained).toBe(3);
  });

  it('keeps the status map in sync: known stays known on upsert, setEntryStatus and delete mirror', async () => {
    await vocab.upsertEntry(input('ledger'));
    vocab.setEntryStatus('ledger', 'known');
    expect(vocab.getEntry('ledger')?.status).toBe('known');
    expect(settings.getVocab().words.ledger).toBe('known');
    await vocab.upsertEntry(input('ledger'));
    expect(settings.getVocab().words.ledger).toBe('known');
    expect(vocab.getEntry('ledger')?.status).toBe('known');
    vocab.setEntryStatus('ledger', 'learning');
    expect(settings.getVocab().words.ledger).toBe('learning');
    vocab.deleteEntry('ledger');
    expect(vocab.getEntry('ledger')).toBeNull();
    expect(settings.getVocab().words.ledger).toBeUndefined();
    // unknown lemma: no-op
    vocab.setEntryStatus('nothing-here', 'known');
    expect(vocab.getEntry('nothing-here')).toBeNull();
  });

  it('fills the level from the dictionary when the reader did not send one', async () => {
    vocab.setDictionaryProvider(async () => FAKE_DICT);
    const e = await vocab.upsertEntry(input('serene'));
    expect(e.level).toBe('C1');
    const e2 = await vocab.upsertEntry(input('nowhere-word'));
    expect(e2.level).toBeUndefined();
  });

  it('rejects an empty lemma', async () => {
    await expect(vocab.upsertEntry(input(''))).rejects.toThrow(/lemma/);
  });
});

describe('CSV mirror', () => {
  it('writes UTF-8 with a BOM, the eight columns, Chinese and quoted fields', async () => {
    await vocab.upsertEntry(input('quote', { sentence: 'She said, "hello, world".', explanation: 'A greeting;\nsimple.', chinese: '问候' }), new Date('2026-09-30T09:00:00Z'));
    const file = vocab.writeCsv();
    expect(file).toBe(path.join(ctx.documents, 'Dream Read', 'my-vocabulary.csv'));
    const bytes = fs.readFileSync(file);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    const lines = text.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('word,chinese,explanation,sentence,book,chapter,date,status');
    const row = lines.find((l) => l.startsWith('quote,'))!;
    expect(row).toBe('quote,问候,"A greeting; simple.","She said, ""hello, world"".",Pride and Prejudice,Chapter 1,2026-09-30,learning');
    expect(text).toContain('意思');
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('orders rows oldest first and quotes nothing it does not have to', () => {
    const mk = (lemma: string, createdAt: string): VocabEntry => ({ lemma, word: lemma, sentence: 's', explanation: 'e', chinese: 'c', bookId: 'b', bookTitle: 'B', chapter: '1', position: null, createdAt, lastSeenAt: createdAt, timesExplained: 1, status: 'known', again: 0 });
    const csv = vocab.toCsv([mk('late', '2026-10-05T00:00:00Z'), mk('early', '2026-10-01T00:00:00Z')]);
    expect(csv).toBe('﻿word,chinese,explanation,sentence,book,chapter,date,status\r\nearly,c,e,s,B,1,2026-10-01,known\r\nlate,c,e,s,B,1,2026-10-05,known\r\n');
  });

  it('rewrites the file automatically about two seconds after a change', async () => {
    vi.useFakeTimers();
    const file = vocab.csvPath();
    fs.rmSync(file, { force: true });
    await vocab.upsertEntry(input('debounced'));
    expect(vocab.csvWritePending()).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    vi.advanceTimersByTime(vocab.CSV_DEBOUNCE_MS - 1);
    expect(fs.existsSync(file)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(vocab.csvWritePending()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toContain('debounced,');
  });
});

describe('progress', () => {
  const words = { house: 'known', cat: 'learning', apple: 'ignored', serene: 'known', zymurgy: 'known', 'in spite of': 'known' } as const;

  it('counts known / learning / unknown per level over the CEFR-tagged single words', () => {
    const p = vocab.computeProgress(FAKE_DICT, words, [], new Date('2026-10-19T12:00:00Z'));
    const byLevel = Object.fromEntries(p.levels.map((l) => [l.level, l]));
    expect(p.levels.map((l) => l.level)).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
    // A1: house known, cat learning, dog unknown, apple ignored (left out)
    expect(byLevel.A1).toEqual({ level: 'A1', known: 1, learning: 1, unknown: 1, total: 4 });
    expect(byLevel.B1).toEqual({ level: 'B1', known: 0, learning: 0, unknown: 0, total: 0 }); // the phrase is skipped
    expect(byLevel.C1).toEqual({ level: 'C1', known: 1, learning: 0, unknown: 0, total: 1 });
    expect(byLevel.C2).toEqual({ level: 'C2', known: 0, learning: 0, unknown: 1, total: 1 }); // zymurgy is estimated
    // totals count every marked word, tagged or not
    expect(p.totals).toEqual({ known: 4, learning: 1, unknown: 2, entries: 0 });
    expect(p.streakDays).toBe(0);
    expect(p.lastActiveDay).toBeNull();
  });

  it('counts this week and the streak from the entry dates', () => {
    const now = new Date(2026, 9, 19, 12, 0, 0); // local time
    const at = (daysAgo: number): string => new Date(now.getTime() - daysAgo * 86400_000).toISOString();
    const mk = (lemma: string, created: number, seen = created): VocabEntry => ({ lemma, word: lemma, sentence: '', explanation: '', chinese: '', bookId: '', bookTitle: '', chapter: '', position: null, createdAt: at(created), lastSeenAt: at(seen), timesExplained: 1, status: 'learning', again: 0 });
    const entries = [mk('a', 0), mk('b', 1), mk('c', 2), mk('d', 10, 2), mk('e', 30)];
    const p = vocab.computeProgress(FAKE_DICT, {}, entries, now);
    expect(p.learnedThisWeek).toBe(3);
    expect(p.streakDays).toBe(3);
    expect(p.lastActiveDay).toBe(vocab.dayKey(now));
    expect(p.totals.entries).toBe(5);
    // nothing today yet: the streak still counts from yesterday
    expect(vocab.streakFrom([vocab.dayKey(new Date(now.getTime() - 86400_000)), vocab.dayKey(new Date(now.getTime() - 2 * 86400_000))], now)).toBe(2);
    expect(vocab.streakFrom([vocab.dayKey(new Date(now.getTime() - 2 * 86400_000))], now)).toBe(0);
  });

  it('lists the unknown words of a level, most frequent first, unranked last', () => {
    const list = vocab.unknownAtLevel(FAKE_DICT, { house: 'known' }, 'A1');
    expect(list.map((w) => w.word)).toEqual(['dog', 'cat', 'apple']);
    expect(list[1]).toEqual({ word: 'cat', zh: 'n. 猫', ipa: '/kæt/', level: 'A1', frq: 1200 });
    expect(vocab.unknownAtLevel(FAKE_DICT, {}, 'A1').find((w) => w.word === 'house')?.zh).toBe('n. 房子, 住宅');
    expect(vocab.unknownAtLevel(FAKE_DICT, {}, 'B2')).toEqual([]);
  });

  it('getProgress and getUnknownAtLevel use the dictionary provider and the status map', async () => {
    vocab.setDictionaryProvider(async () => FAKE_DICT);
    settings.setWordStatus('dog', 'known');
    const p = await vocab.getProgress();
    expect(p.levels[0].known).toBeGreaterThanOrEqual(1);
    expect((await vocab.getUnknownAtLevel('A1')).map((w) => w.word)).not.toContain('dog');
    settings.setWordStatus('dog', null);
    vocab.setDictionaryProvider(null);
    expect(await vocab.getUnknownAtLevel('A1')).toEqual([]);
    expect((await vocab.getProgress()).levels.every((l) => l.total === 0)).toBe(true);
  });
});
