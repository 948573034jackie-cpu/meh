import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

/**
 * Model files, downloaded on first use into <userData>/models/kokoro/. They come from the kokoro-onnx
 * GitHub release "model-files-v1.1" (thewh1teagle/kokoro-onnx): these exports have the `duration` output
 * (one frame count per input token) that gives us word timings. The onnx-community Hugging Face exports used
 * by kokoro-js only output the waveform.
 *
 * Variants (same weights, different precision), measured on a 4-core x86 Xeon with onnxruntime-node 1.30:
 *  - fp16: 164 MB, runs at fp32 speed on CPU (ORT casts to fp32), RTF ~0.3. DEFAULT.
 *  - fp32: 326 MB, same speed, reference quality.
 *  - int8: 114 MB, dynamic quantization (ConvInteger/MatMulInteger): ~6x SLOWER than fp32 on x86 CPUs with
 *    ORT's CPU provider, and needs ORT >= 1.30 (int8 ConvInteger kernel). Kept for experiments only.
 */
export type ModelVariant = 'fp16' | 'fp32' | 'int8';

export interface ModelFile { name: string; url: string; size: number; sha256: string }

const RELEASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1';

export const MODEL_FILES: Record<ModelVariant, ModelFile> = {
  fp16: { name: 'kokoro-v1.0.fp16.onnx', url: `${RELEASE}/kokoro-v1.0.fp16.onnx`, size: 163527961, sha256: 'f3a290d384fbb27966d462905c71a46cef9e5fd00516b40df32a0b4afe77ac96' },
  fp32: { name: 'kokoro-v1.0.onnx', url: `${RELEASE}/kokoro-v1.0.onnx`, size: 325505369, sha256: 'beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a' },
  int8: { name: 'kokoro-v1.0.int8.onnx', url: `${RELEASE}/kokoro-v1.0.int8.onnx`, size: 114119327, sha256: 'ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c' },
};
export const VOICES_FILE: ModelFile = { name: 'voices-v1.0.bin', url: `${RELEASE}/voices-v1.0.bin`, size: 28214398, sha256: 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d' };

/** Bumped whenever the model files change; part of every cache key. */
export const MODEL_VERSION = 'kokoro-v1.0/model-files-v1.1';

export const DEFAULT_VARIANT: ModelVariant = 'fp16';

export interface DownloadProgress { file: string; received: number; total: number; /** all files together */ overallReceived: number; overallTotal: number }

export function filesFor(variant: ModelVariant): ModelFile[] { return [MODEL_FILES[variant], VOICES_FILE]; }

export function isPresent(dir: string, variant: ModelVariant): boolean {
  return filesFor(variant).every((f) => { try { return fs.statSync(path.join(dir, f.name)).size === f.size; } catch { return false; } });
}

/** Any variant whose files are complete on disk (the preferred one first). */
export function presentVariant(dir: string, preferred: ModelVariant): ModelVariant | null {
  for (const v of [preferred, 'fp16', 'fp32', 'int8'] as ModelVariant[]) if (isPresent(dir, v)) return v;
  return null;
}

/**
 * Downloads the files of a variant that are missing, resuming partial `.part` files with HTTP Range requests,
 * verifying sha256 before the file is put in place. `signal` aborts; progress is reported after every chunk.
 */
export async function downloadModel(dir: string, variant: ModelVariant, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const files = filesFor(variant);
  const overallTotal = files.reduce((s, f) => s + f.size, 0);
  let done = 0;
  for (const f of files) {
    const target = path.join(dir, f.name);
    if (fs.existsSync(target) && fs.statSync(target).size === f.size) { done += f.size; continue; }
    await downloadFile(f, target, (received) => onProgress?.({ file: f.name, received, total: f.size, overallReceived: done + received, overallTotal }), signal);
    done += f.size;
  }
  onProgress?.({ file: '', received: 0, total: 0, overallReceived: overallTotal, overallTotal });
}

async function downloadFile(f: ModelFile, target: string, onProgress: (received: number) => void, signal?: AbortSignal): Promise<void> {
  const part = `${target}.part`;
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* no partial file */ }
  if (have >= f.size) { have = 0; fs.rmSync(part, { force: true }); }
  const headers: Record<string, string> = { 'user-agent': 'ReadAlong (Electron; Kokoro model download)' };
  if (have > 0) headers.range = `bytes=${have}-`;
  const res = await fetch(f.url, { headers, signal, redirect: 'follow' });
  if (have > 0 && res.status !== 206) { have = 0; fs.rmSync(part, { force: true }); }
  if (!res.ok || !res.body) throw new Error(`download of ${f.name} failed: HTTP ${res.status}`);
  const total = have + Number(res.headers.get('content-length') ?? 0);
  if (total && total !== f.size) throw new Error(`download of ${f.name}: unexpected size ${total} (expected ${f.size})`);
  let received = have;
  const counter = new Transform({ transform(chunk: Buffer, _enc, cb) { received += chunk.length; onProgress(received); cb(null, chunk); } });
  await pipeline(Readable.fromWeb(res.body as never), counter, fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' }), { signal });
  if (fs.statSync(part).size !== f.size) throw new Error(`download of ${f.name} incomplete (${fs.statSync(part).size} of ${f.size} bytes)`);
  const hash = await sha256File(part);
  if (hash !== f.sha256) { fs.rmSync(part, { force: true }); throw new Error(`${f.name}: checksum mismatch (got ${hash})`); }
  fs.renameSync(part, target);
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
