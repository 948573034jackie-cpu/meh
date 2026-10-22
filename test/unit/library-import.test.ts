import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// a fresh userData for this file; the dictionary comes from the repo's resources/ (app.getAppPath)
const ctx = vi.hoisted(() => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  return { userData: fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-import-')) };
});
vi.mock('electron', () => ({ app: { getPath: () => ctx.userData, getAppPath: () => process.cwd() }, dialog: {}, BrowserWindow: class {} }));

const dataDir = path.join(ctx.userData, 'data');
const libraryFile = path.join(dataDir, 'library.json');
const bookFile = (id: string) => path.join(dataDir, 'books', `${id}.json.gz`);
const onDisk = (): { id: string }[] => JSON.parse(fs.readFileSync(libraryFile, 'utf8')).items;

describe('library: a book added or removed survives the app ending right after (library.json is written at once)', () => {
  it('an import writes the book file and its library item at once; removing writes the item first, then deletes the file', async () => {
    const library = await import('../../src/main/library');
    const book = await library.importText('Cat', 'The cat sat on the mat. It was a warm day.');
    expect(fs.existsSync(bookFile(book.id))).toBe(true);
    expect(onDisk().map((it) => it.id)).toEqual([book.id]); // not 0.5-2 s later
    library.removeBook(book.id);
    expect(onDisk()).toEqual([]);
    expect(fs.existsSync(bookFile(book.id))).toBe(false);
  }, 30_000);

  it('a book file left without its item (the app ended in between): importing the book again puts it back in the library', async () => {
    vi.resetModules();
    const lib1 = await import('../../src/main/library');
    const text = 'The dog ran in the park. Then it slept.';
    const book = await lib1.importText('Dog', text);
    // the state an older version could leave after a crash: the book file on disk, library.json without it
    fs.writeFileSync(libraryFile, JSON.stringify({ items: [] }));
    vi.resetModules(); // a new start of the app
    const lib2 = await import('../../src/main/library');
    expect(lib2.listLibrary()).toEqual([]);
    const again = await lib2.importText('Dog', text);
    expect(again.id).toBe(book.id);
    expect(lib2.listLibrary().map((it) => it.id)).toEqual([book.id]);
    expect(onDisk().map((it) => it.id)).toEqual([book.id]);
    // its progress is saved again
    lib2.saveProgress(book.id, { chapter: 0, paragraph: 0, sentence: 1 }, 50);
    expect(lib2.listLibrary()[0]).toMatchObject({ id: book.id, percent: 50 });
  }, 30_000);
});
