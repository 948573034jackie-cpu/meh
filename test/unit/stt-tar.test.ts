import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { extractTar, safeRelative } from '../../src/main/stt/tar';
import { confidenceOf } from '../../src/main/stt/engine';
import { MODELS, VAD_FILE, isPresent, modelPresent, presentVariant, downloadBytes } from '../../src/main/stt/download';

/** Build a ustar header by hand so the test does not depend on the tar CLI. */
function header(name: string, size: number, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
function entry(name: string, data: Buffer, type = '0'): Buffer {
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header(name, data.length, type), data, Buffer.alloc(pad)]);
}

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'stt-tar-')); }

describe('extractTar', () => {
  it('extracts files and directories, honours the filter, reports progress', async () => {
    const big = Buffer.alloc(70000); for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const tar = Buffer.concat([
      entry('model/', Buffer.alloc(0), '5'),
      entry('model/a.bin', big),
      entry('model/tokens.txt', Buffer.from('hello\nworld\n')),
      entry('model/skip.wav', Buffer.from('xxxx')),
      entry('model/empty', Buffer.alloc(0)),
      Buffer.alloc(1024),
    ]);
    const dest = tmp();
    const progress: number[] = [];
    // tiny chunks so headers and data straddle chunk boundaries
    const chunks: Buffer[] = []; for (let i = 0; i < tar.length; i += 1000) chunks.push(tar.subarray(i, i + 1000));
    const written = await extractTar(Readable.from(chunks), dest, { filter: (e) => !e.name.endsWith('.wav'), onProgress: (n) => progress.push(n) });
    expect(written.sort()).toEqual(['model/a.bin', 'model/empty', 'model/tokens.txt']);
    expect(fs.readFileSync(path.join(dest, 'model/a.bin')).equals(big)).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'model/tokens.txt'), 'utf8')).toBe('hello\nworld\n');
    expect(fs.existsSync(path.join(dest, 'model/skip.wav'))).toBe(false);
    expect(fs.statSync(path.join(dest, 'model/empty')).size).toBe(0);
    expect(progress[progress.length - 1]).toBe(70000 + 12);
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('handles GNU long names and pax path records', async () => {
    const long = 'd/' + 'x'.repeat(120) + '/file.txt';
    const pax = '30 path=p/renamed-by-pax.txt\n';
    const tar = Buffer.concat([
      entry('././@LongLink', Buffer.from(long + '\0'), 'L'),
      entry('d/truncated', Buffer.from('long')),
      entry('./PaxHeaders/x', Buffer.from(pax), 'x'),
      entry('p/original.txt', Buffer.from('pax')),
      Buffer.alloc(1024),
    ]);
    const dest = tmp();
    const written = await extractTar(Readable.from([tar]), dest, {});
    expect(written.sort()).toEqual([long, 'p/renamed-by-pax.txt']);
    expect(fs.readFileSync(path.join(dest, long), 'utf8')).toBe('long');
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('rejects entries that escape the destination', async () => {
    const dest = tmp();
    await expect(extractTar(Readable.from([Buffer.concat([entry('../evil', Buffer.from('x')), Buffer.alloc(1024)])]), dest, {})).rejects.toThrow(/refusing/);
    expect(safeRelative('/abs')).toBeNull();
    expect(safeRelative('a/../b')).toBeNull();
    expect(safeRelative('./a//b/')).toBe('a/b');
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('reads an archive produced by the system tar, when available', async () => {
    let tarBin: string | null = 'tar';
    try { execFileSync(tarBin, ['--version'], { stdio: 'ignore' }); } catch { tarBin = null; }
    if (!tarBin) return;
    const src = tmp(); const dest = tmp();
    fs.mkdirSync(path.join(src, 'm/test_wavs'), { recursive: true });
    fs.writeFileSync(path.join(src, 'm/tokens.txt'), 'a 0\nb 1\n');
    fs.writeFileSync(path.join(src, 'm/test_wavs/0.wav'), 'RIFF');
    const archive = path.join(src, 'm.tar');
    execFileSync(tarBin, ['-cf', archive, '-C', src, 'm']);
    const written = await extractTar(fs.createReadStream(archive), dest, { filter: (e) => e.name === 'm/tokens.txt' });
    expect(written).toEqual(['m/tokens.txt']);
    expect(fs.readFileSync(path.join(dest, 'm/tokens.txt'), 'utf8')).toBe('a 0\nb 1\n');
    fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true });
  });
});

describe('stt download bookkeeping', () => {
  it('reports presence from file sizes and what is left to download', () => {
    const dir = tmp();
    const spec = MODELS['moonshine-tiny'];
    expect(isPresent(dir, 'moonshine-tiny')).toBe(false);
    expect(downloadBytes(dir, 'moonshine-tiny')).toBe(VAD_FILE.size + spec.archive.size);
    fs.writeFileSync(path.join(dir, VAD_FILE.name), Buffer.alloc(VAD_FILE.size));
    expect(downloadBytes(dir, 'moonshine-tiny')).toBe(spec.archive.size);
    fs.mkdirSync(path.join(dir, spec.dir));
    for (const f of spec.files) fs.writeFileSync(path.join(dir, spec.dir, f.name), Buffer.alloc(f.size));
    expect(modelPresent(dir, 'moonshine-tiny')).toBe(true);
    expect(isPresent(dir, 'moonshine-tiny')).toBe(true);
    expect(presentVariant(dir, 'moonshine-base')).toBe('moonshine-tiny');
    expect(downloadBytes(dir, 'moonshine-tiny')).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('confidence is the mean token probability, absent without log-probs', () => {
    expect(confidenceOf({ ys_log_probs: [] })).toBeUndefined();
    expect(confidenceOf({ ys_log_probs: [0, 0] })).toBe(1);
    expect(confidenceOf({ ys_log_probs: [Math.log(0.5), Math.log(0.5)] })).toBeCloseTo(0.5, 6);
  });
});
