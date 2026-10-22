import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// a fresh userData for this file; electron is mocked like in vocabulary.test.ts
const ctx = vi.hoisted(() => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  return { userData: fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-storage-')) };
});
vi.mock('electron', () => ({ app: { getPath: () => ctx.userData, getAppPath: () => process.cwd() } }));

import { JsonStore, BackgroundFile, flushStores, flushStoresSync, WRITE_QUIET_MS, WRITE_MAX_DELAY_MS } from '../../src/main/storage';

const dataFile = (name: string) => path.join(ctx.userData, 'data', `${name}.json`);
const onDisk = (name: string) => JSON.parse(fs.readFileSync(dataFile(name), 'utf8'));

beforeAll(() => { fs.mkdirSync(path.join(ctx.userData, 'data'), { recursive: true }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('JsonStore: write-behind', () => {
  it('many changes in a row make one background write, 500 ms after the last one; readers see the latest at once', async () => {
    vi.useFakeTimers();
    const writes = vi.spyOn(fs.promises, 'writeFile');
    const sync = vi.spyOn(fs, 'writeFileSync');
    const store = new JsonStore<{ n: number }>('burst', () => ({ n: 0 }));
    for (let i = 1; i <= 20; i++) { store.update((v) => ({ n: v.n + 1 })); vi.advanceTimersByTime(10); }
    expect(store.get().n).toBe(20);
    expect(fs.existsSync(dataFile('burst'))).toBe(false);
    vi.advanceTimersByTime(WRITE_QUIET_MS - 11);
    expect(writes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(writes).toHaveBeenCalledTimes(1);
    await flushStores();
    expect(onDisk('burst')).toEqual({ n: 20 });
    expect(sync).not.toHaveBeenCalled();
    expect(store.pending).toBe(false);
  });

  it('a store that keeps changing is still written within 2 s of its first unsaved change', async () => {
    vi.useFakeTimers();
    const writes = vi.spyOn(fs.promises, 'writeFile');
    const store = new JsonStore<{ n: number }>('stream', () => ({ n: 0 }));
    for (let t = 0; t < WRITE_MAX_DELAY_MS; t += 100) { store.set({ n: t }); vi.advanceTimersByTime(100); }
    expect(writes).toHaveBeenCalledTimes(1);
    await flushStores();
    expect(onDisk('stream').n).toBeGreaterThanOrEqual(WRITE_MAX_DELAY_MS - 200);
  });

  it('writes a temporary file, then renames it over the old one', async () => {
    const calls: string[] = [];
    const wf = fs.promises.writeFile;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (f, d) => { calls.push(`write ${path.basename(String(f))}`); return wf(f as string, d as string); });
    const rn = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => { calls.push(`rename ${path.basename(String(a))} -> ${path.basename(String(b))}`); return rn(a, b); });
    const store = new JsonStore<{ v: string }>('order', () => ({ v: '' }));
    store.set({ v: 'x' });
    await flushStores();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^write order\.json\.\d+\.\d+\.tmp$/);
    expect(calls[1]).toMatch(/^rename order\.json\.\d+\.\d+\.tmp -> order\.json$/);
    expect(onDisk('order')).toEqual({ v: 'x' });
    expect(fs.readdirSync(path.join(ctx.userData, 'data')).filter((f) => f.startsWith('order') && f.endsWith('.tmp'))).toEqual([]);
  });

  it('an unchanged value (update returns the same object) is not written', async () => {
    vi.useFakeTimers();
    const store = new JsonStore<{ a: number }>('same', () => ({ a: 1 }));
    store.update((v) => v);
    expect(store.pending).toBe(false);
    vi.advanceTimersByTime(WRITE_MAX_DELAY_MS * 2);
    expect(fs.existsSync(dataFile('same'))).toBe(false);
  });

  it('quitting writes every unsaved store synchronously, and nothing is lost', () => {
    vi.useFakeTimers();
    const a = new JsonStore<{ v: number }>('quit-a', () => ({ v: 0 }));
    const b = new JsonStore<{ v: number }>('quit-b', () => ({ v: 0 }));
    a.set({ v: 1 }); b.set({ v: 2 }); a.set({ v: 3 });
    expect(fs.existsSync(dataFile('quit-a'))).toBe(false);
    flushStoresSync();
    expect(onDisk('quit-a')).toEqual({ v: 3 });
    expect(onDisk('quit-b')).toEqual({ v: 2 });
    expect(a.pending).toBe(false);
    // nothing left for the timers to do
    const writes = vi.spyOn(fs.promises, 'writeFile');
    vi.advanceTimersByTime(WRITE_MAX_DELAY_MS * 2);
    expect(writes).not.toHaveBeenCalled();
  });

  it('a background write still running at quit never replaces the newer file written at quit', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const wf = fs.promises.writeFile;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (f, d) => { await gate; return wf(f as string, d as string); });
    const store = new JsonStore<{ v: string }>('race', () => ({ v: '' }));
    store.set({ v: 'old' });
    const bg = flushStores(); // the background write of 'old' starts and waits at the gate
    store.set({ v: 'new' });
    flushStoresSync();
    expect(onDisk('race')).toEqual({ v: 'new' });
    release();
    await bg;
    expect(onDisk('race')).toEqual({ v: 'new' });
    expect(fs.readdirSync(path.join(ctx.userData, 'data')).filter((f) => f.startsWith('race') && f.endsWith('.tmp'))).toEqual([]);
  });

  it('a write still running at quit with the latest value is made sure of synchronously', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const wf = fs.promises.writeFile;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (f, d) => { await gate; return wf(f as string, d as string); });
    const store = new JsonStore<{ v: string }>('inflight', () => ({ v: '' }));
    store.set({ v: 'latest' });
    const bg = flushStores();
    // the process may end before the background rename: quitting writes it now
    flushStoresSync();
    expect(onDisk('inflight')).toEqual({ v: 'latest' });
    release();
    await bg;
    expect(onDisk('inflight')).toEqual({ v: 'latest' });
  });

  it('a change made during a background write is written by the next write', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const wf = fs.promises.writeFile;
    let first = true;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (f, d) => { if (first) { first = false; await gate; } return wf(f as string, d as string); });
    const store = new JsonStore<{ v: number }>('during', () => ({ v: 0 }));
    store.set({ v: 1 });
    const bg = flushStores();
    store.set({ v: 2 });
    release();
    await bg;
    await flushStores();
    expect(onDisk('during')).toEqual({ v: 2 });
  });

  it('BackgroundFile.writeSync(true) writes even without a change (an export)', () => {
    const file = path.join(ctx.userData, 'export.txt');
    let n = 0;
    const out = new BackgroundFile(() => file, () => `n=${++n}`, { quietMs: 100, maxDelayMs: 1000, label: 'export.txt' });
    out.writeSync();
    expect(fs.existsSync(file)).toBe(false);
    out.writeSync(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('n=1');
  });
});
