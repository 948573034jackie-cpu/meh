import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// a fresh userData for this file; the dictionary comes from the repo's resources/ (app.getAppPath)
const ctx = vi.hoisted(() => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  return { userData: fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-library-')) };
});
vi.mock('electron', () => ({ app: { getPath: () => ctx.userData, getAppPath: () => process.cwd() }, dialog: {}, BrowserWindow: class {} }));

import * as library from '../../src/main/library';
import { flushStores } from '../../src/main/storage';
import { makeBook } from './helpers';

const dataDir = path.join(ctx.userData, 'data');
const libraryFile = path.join(dataDir, 'library.json');
const OLD = '2020-01-01T00:00:00.000Z';
const book = makeBook([{ title: 'One', paragraphs: ['The house was serene.'] }]);
book.id = 'b1';

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'books'), { recursive: true });
  fs.writeFileSync(libraryFile, JSON.stringify({ items: [{ id: 'b1', title: 'Test Book', author: '', kind: 'text', addedAt: OLD, lastOpenedAt: OLD, position: null, percent: 0, words: 4 }] }));
  fs.writeFileSync(path.join(dataDir, 'books', 'b1.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(book), 'utf8')));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('library: the book and the dictionary go to the renderer as JSON text', () => {
  it('loadBook resolves with the book as a string, reads asynchronously and does not write library.json', async () => {
    const readSync = vi.spyOn(fs, 'readFileSync');
    const writeSync = vi.spyOn(fs, 'writeFileSync');
    const renameSync = vi.spyOn(fs, 'renameSync');
    const before = fs.readFileSync(libraryFile, 'utf8');
    readSync.mockClear();
    const raw = await library.loadBook('b1');
    expect(typeof raw).toBe('string');
    expect(JSON.parse(raw!)).toEqual(book);
    // the book file is read without blocking (the library list itself is read once, on its first use)
    expect(readSync.mock.calls.map((c) => String(c[0])).filter((f) => f.endsWith('.json.gz'))).toEqual([]);
    expect(writeSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(libraryFile, 'utf8')).toBe(before);
    // opening it still puts it first in the library: in memory now, on disk in the background
    expect(library.listLibrary()[0].lastOpenedAt > OLD).toBe(true);
    await flushStores();
    expect(JSON.parse(fs.readFileSync(libraryFile, 'utf8')).items[0].lastOpenedAt > OLD).toBe(true);
  });

  it('a book that is not in the library is null', async () => {
    expect(await library.loadBook('missing')).toBeNull();
  });

  it('readBook shares the parse of the last book read (the hints job and imports)', async () => {
    const a = await library.readBook('b1');
    const b = await library.readBook('b1');
    expect(a).toEqual(book);
    expect(b).toBe(a);
  });

  it('dict:load sends the dictionary as JSON text; the main process parses it only for its own uses', async () => {
    const json = await library.getDictJson();
    expect(typeof json).toBe('string');
    expect(json.startsWith('{')).toBe(true);
    expect(await library.getDictJson()).toBe(json);
    const data = await library.getDictData();
    expect(Object.keys(data.w).length).toBeGreaterThan(10_000);
  });
});
