import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** Small JSON-file store under userData with atomic writes. One file per collection. */
export class JsonStore<T> {
  private cache: T | null = null;
  constructor(private name: string, private defaults: () => T) {}
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
    writeAtomic(this.file, JSON.stringify(value, null, 1));
  }
  update(fn: (current: T) => T): T {
    const next = fn(this.get());
    this.set(next);
    return next;
  }
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

export function readJsonFile<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}
