import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** A store is written once it had no change for this long ... */
export const WRITE_QUIET_MS = 500;
/** ... and a store that keeps changing is still written at the latest this long after its first unsaved change. */
export const WRITE_MAX_DELAY_MS = 2000;
/** A failed background write is tried again after this long (the value stays in memory meanwhile). */
const WRITE_RETRY_MS = 5000;

/** Every file written in the background, so quitting can write what is still unsaved. */
const files = new Set<BackgroundFile>();

/**
 * One file that is written in the background (write-behind). markDirty() says the contents changed; the file is
 * written once nothing changed for `quietMs`, at the latest `maxDelayMs` after the first unsaved change: the contents
 * are built, written asynchronously to a temporary file, and the temporary file is renamed over the old one (a reader
 * of the file sees the old or the new version, never half of one). One write runs at a time; a change made during a
 * write is written by the next one. Quitting writes what is still unsaved synchronously (flushStoresSync).
 */
export class BackgroundFile {
  /** time of the first change not written yet; 0 = the file has the latest contents (or a write of them is running) */
  private dirtySince = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** the background write running now, if any */
  private writing: Promise<void> | null = null;
  /** every write takes the next number; an older background write never replaces a newer file */
  private seq = 0;
  private committed = 0;

  constructor(private target: () => string, private contents: () => string | Buffer, private opts: { quietMs: number; maxDelayMs: number; label: string }) {
    files.add(this);
  }

  /** a change is not on disk yet (or its write is still running) */
  get pending(): boolean { return this.dirtySince !== 0 || this.writing !== null; }
  /** a background write is waiting for the changes to stop */
  get scheduled(): boolean { return this.timer !== null; }

  markDirty(): void {
    const now = Date.now();
    if (!this.dirtySince) this.dirtySince = now;
    this.schedule(Math.min(this.opts.quietMs, this.dirtySince + this.opts.maxDelayMs - now));
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, Math.max(0, ms));
    // a pending write never keeps the process alive: quitting writes it synchronously
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Writes the latest contents in the background now (when they are not on disk yet); resolves when the file has them. */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.writing) return this.writing.then(() => this.flush());
    if (!this.dirtySince) return Promise.resolve();
    const seq = ++this.seq;
    this.dirtySince = 0;
    let tmp = '';
    const job = (async () => {
      try {
        const file = this.target();
        tmp = `${file}.${process.pid}.${seq}.tmp`;
        await fs.promises.writeFile(tmp, this.contents());
        // a synchronous write (quitting, an export) put newer contents in place meanwhile: keep them
        if (this.committed > seq) { await fs.promises.unlink(tmp).catch(() => undefined); return; }
        // a synchronous rename: no other write of this file can come between the check above and the rename
        fs.renameSync(tmp, file);
        this.committed = seq;
      } catch (e) {
        console.error(`storage: could not write ${this.opts.label}; trying again later`, e);
        if (tmp) await fs.promises.unlink(tmp).catch(() => undefined);
        if (this.committed < seq && !this.dirtySince) { this.dirtySince = Date.now(); this.schedule(WRITE_RETRY_MS); }
      }
    })();
    const done: Promise<void> = job.finally(() => { if (this.writing === done) this.writing = null; });
    this.writing = done;
    return done;
  }

  /**
   * Writes the latest contents now, synchronously: when they are not on disk yet (quitting), or always with `force`
   * (an export the learner asked for). Throws when the write fails.
   */
  writeSync(force = false): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // also when only a background write is running: it may not reach its rename before the process ends
    if (!force && !this.dirtySince && !this.writing) return;
    const seq = ++this.seq;
    const wasDirty = this.dirtySince;
    this.dirtySince = 0;
    try {
      writeAtomic(this.target(), this.contents());
      this.committed = seq;
    } catch (e) {
      if (wasDirty && !this.dirtySince) this.dirtySince = wasDirty;
      throw e;
    }
  }
}

/**
 * Small JSON-file store under userData, one file per collection. Reads come from memory, so a reader always sees the
 * latest value; set() keeps the value and the file is written in the background (BackgroundFile: after 500 ms without
 * a change, at the latest 2 s after the first one). Before, every change rewrote the whole file synchronously on the
 * main process: 5 rewrites per explained word, 10-20 ms each at 1,000-3,000 vocabulary entries.
 */
export class JsonStore<T> {
  private cache: T | null = null;
  private out: BackgroundFile;
  constructor(private name: string, private defaults: () => T) {
    this.out = new BackgroundFile(() => this.file, () => JSON.stringify(this.cache, null, 1), { quietMs: WRITE_QUIET_MS, maxDelayMs: WRITE_MAX_DELAY_MS, label: `${name}.json` });
  }
  /** resolved lazily: stores are created at import time, before main/index.ts may redirect userData */
  private get file(): string { return path.join(dataDir(), `${this.name}.json`); }
  get(): T {
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.cache = { ...this.defaults(), ...JSON.parse(raw) } as T;
    } catch {
      this.cache = this.defaults();
    }
    return this.cache;
  }
  set(value: T): void {
    this.cache = value;
    this.out.markDirty();
  }
  /** fn returns a new value, or the current one unchanged (then nothing is written) */
  update(fn: (current: T) => T): T {
    const cur = this.get();
    const next = fn(cur);
    if (next !== cur) this.set(next);
    return next;
  }
  /** a change is not on disk yet (tests) */
  get pending(): boolean { return this.out.pending; }
}

/** Writes every file that has unsaved changes, synchronously: the app is quitting. */
export function flushStoresSync(): void {
  for (const f of files) {
    try { f.writeSync(); } catch (e) { console.error('storage: a write at quit failed', e); }
  }
}

/** Resolves when every store has its latest value on disk (tests). */
export async function flushStores(): Promise<void> {
  await Promise.all([...files].map((f) => f.flush()));
}

export function dataDir(): string {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function booksDir(): string {
  const dir = path.join(dataDir(), 'books');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeAtomic(file: string, contents: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

/** writeAtomic in the background: a temporary file written asynchronously, then renamed over `file`. */
export async function writeAtomicAsync(file: string, contents: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await fs.promises.writeFile(tmp, contents);
    await fs.promises.rename(tmp, file);
  } catch (e) {
    fs.promises.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

export function readJsonFile<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}
