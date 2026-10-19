import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

/**
 * Minimal streaming tar extractor (ustar / GNU, as produced by `tar` on macOS and Linux): enough for the
 * sherpa-onnx model archives, which are plain files inside one top-level directory. Handles regular files,
 * directories, GNU long names ('L') and pax 'path' records ('x'); everything else is skipped. Entry names
 * are sanitised: absolute paths and '..' components are rejected.
 */
export interface TarEntryInfo { name: string; size: number }

export interface ExtractOptions {
  /** return false to skip an entry (its bytes are discarded) */
  filter?: (entry: TarEntryInfo) => boolean;
  /** called with the running total of bytes written to disk */
  onProgress?: (written: number) => void;
}

const BLOCK = 512;

function parseOctal(buf: Buffer, off: number, len: number): number {
  const s = buf.toString('latin1', off, off + len).replace(/\0.*$/s, '').trim();
  if (!s) return 0;
  // GNU base-256 encoding for large sizes
  if (buf[off] & 0x80) { let v = 0; for (let i = 1; i < len; i++) v = v * 256 + buf[off + i]; return v; }
  return parseInt(s, 8) || 0;
}

function cstr(buf: Buffer, off: number, len: number): string {
  const end = buf.indexOf(0, off);
  return buf.toString('utf8', off, end === -1 || end > off + len ? off + len : end);
}

export function safeRelative(name: string): string | null {
  const parts = name.replace(/\\/g, '/').split('/').filter((p) => p.length > 0 && p !== '.');
  if (!parts.length || name.startsWith('/') || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/** Extracts a tar stream into `dest`; resolves with the relative paths of the files written. */
export function extractTar(input: NodeJS.ReadableStream, dest: string, opts: ExtractOptions = {}): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const written: string[] = [];
    let pending: Buffer = Buffer.alloc(0);
    let remaining = 0; // data bytes left in the current entry
    let padding = 0; // bytes to the next 512 boundary after the entry data
    let out: fs.WriteStream | null = null;
    let outPath = '';
    let longName: string | null = null;
    let paxPath: string | null = null;
    let total = 0;
    let finished = false;

    const fail = (e: Error): void => { if (finished) return; finished = true; out?.destroy(); reject(e); };

    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        void consume().then(() => cb(), (e: Error) => { fail(e); cb(e); });
      },
      final(cb) {
        if (out) { fail(new Error('tar: archive ended inside a file')); cb(); return; }
        if (!finished) { finished = true; resolve(written); }
        cb();
      },
    });
    sink.on('error', fail);
    input.on('error', fail);

    async function consume(): Promise<void> {
      for (;;) {
        if (remaining > 0) {
          if (!pending.length) return;
          const take = Math.min(remaining, pending.length);
          const data = pending.subarray(0, take);
          pending = pending.subarray(take);
          remaining -= take;
          if (out) {
            if (!out.write(data)) await new Promise<void>((r) => out!.once('drain', r));
            total += take;
            opts.onProgress?.(total);
          } else if (longName !== null) longName += data.toString('utf8');
          else if (paxPath !== null) paxPath += data.toString('utf8');
          if (remaining === 0 && out) {
            const ws = out; out = null;
            await new Promise<void>((r, j) => ws.end((e?: Error | null) => (e ? j(e) : r())));
            written.push(outPath);
          }
          continue;
        }
        if (padding > 0) {
          const take = Math.min(padding, pending.length);
          pending = pending.subarray(take); padding -= take;
          if (padding > 0) return;
        }
        if (pending.length < BLOCK) return;
        const header = pending.subarray(0, BLOCK);
        pending = pending.subarray(BLOCK);
        if (header.every((b) => b === 0)) continue; // end-of-archive blocks
        const type = String.fromCharCode(header[156]);
        const size = parseOctal(header, 124, 12);
        remaining = size;
        padding = (BLOCK - (size % BLOCK)) % BLOCK;
        if (type === 'L') { longName = ''; continue; }
        if (type === 'x') { paxPath = ''; continue; }
        if (type === 'g') { continue; }
        let name = cstr(header, 0, 100);
        const prefix = header.toString('latin1', 257, 263) === 'ustar\0' || header.toString('latin1', 257, 262) === 'ustar' ? cstr(header, 345, 155) : '';
        if (prefix) name = `${prefix}/${name}`;
        if (longName !== null) { name = longName.replace(/\0+$/, ''); longName = null; }
        if (paxPath !== null) {
          const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(paxPath);
          if (m) name = m[1];
          paxPath = null;
        }
        const rel = safeRelative(name);
        if (rel === null) throw new Error(`tar: refusing entry "${name}"`);
        const isFile = type === '0' || type === '\0' || type === '7';
        if (type === '5') { await fs.promises.mkdir(path.join(dest, rel), { recursive: true }); continue; }
        if (!isFile || (opts.filter && !opts.filter({ name: rel, size }))) continue;
        outPath = rel;
        const full = path.join(dest, rel);
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        out = fs.createWriteStream(full);
        out.on('error', fail);
        if (size === 0) {
          const ws = out; out = null;
          await new Promise<void>((r, j) => ws.end((e?: Error | null) => (e ? j(e) : r())));
          written.push(outPath);
        }
      }
    }

    input.pipe(sink);
  });
}
