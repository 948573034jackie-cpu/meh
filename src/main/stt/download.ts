import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import unbzip2 from 'unbzip2-stream';
import { extractTar } from './tar';

/**
 * Speech-to-text model files, downloaded on first use into <userData>/models/stt/. All of them are GitHub
 * release assets of k2-fsa/sherpa-onnx (tag "asr-models"), pinned by size and sha256 (computed from the
 * assets downloaded on 2026-10-19). The archives are .tar.bz2 (bzip2 is not in Node's zlib, so a pure-JS
 * decoder streams them: ~4 MB/s, i.e. ~35 s for the default model, once).
 *
 * Variants (measured on a 4-core x86 Xeon 2.8 GHz, sherpa-onnx 1.13.8 / its onnxruntime 1.28, 3 threads):
 *  - moonshine-base  Moonshine v2 base, int8 "quantized" (2026-02-27 release): 111 MB download, 135 MB on
 *                    disk, ~300 MB RSS, RTF ≈ 0.06 (a 6 s sentence decodes in ~0.35 s). English only.
 *                    No token confidences. DEFAULT.
 *  - moonshine-tiny  30 MB download, 43 MB on disk, ~170 MB RSS, RTF ≈ 0.04; noticeably weaker on accents.
 *  - parakeet-v3     NVIDIA Parakeet TDT 0.6B v3 int8 (25 European languages, best accented-English
 *                    accuracy, per-token log-probs → confidence): 487 MB download, 641 MB on disk, ~930 MB
 *                    RSS, RTF ≈ 0.3 on the 4-core Intel (a 6 s sentence takes ~1.8 s), fine on Apple Silicon.
 */
export type SttVariant = 'moonshine-base' | 'moonshine-tiny' | 'parakeet-v3';

export interface ModelFile { name: string; url: string; size: number; sha256: string }

export interface SttModelSpec {
  variant: SttVariant;
  kind: 'moonshine' | 'nemo_transducer';
  archive: ModelFile;
  /** the directory inside the archive (and under the model dir) */
  dir: string;
  /** files needed at runtime, relative to `dir`, with their sizes */
  files: { name: string; size: number }[];
  /** bytes on disk after extraction */
  diskBytes: number;
}

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

export const VAD_FILE: ModelFile = { name: 'silero_vad.onnx', url: `${RELEASE}/silero_vad.onnx`, size: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6' };

export const MODELS: Record<SttVariant, SttModelSpec> = {
  'moonshine-base': {
    variant: 'moonshine-base', kind: 'moonshine',
    archive: { name: 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2', url: `${RELEASE}/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`, size: 111266225, sha256: '43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891' },
    dir: 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27',
    files: [{ name: 'encoder_model.ort', size: 31326816 }, { name: 'decoder_model_merged.ort', size: 109424400 }, { name: 'tokens.txt', size: 549350 }],
    diskBytes: 141313910,
  },
  'moonshine-tiny': {
    variant: 'moonshine-tiny', kind: 'moonshine',
    archive: { name: 'sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2', url: `${RELEASE}/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2`, size: 29858559, sha256: '9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d' },
    dir: 'sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27',
    files: [{ name: 'encoder_model.ort', size: 13281600 }, { name: 'decoder_model_merged.ort', size: 30412256 }, { name: 'tokens.txt', size: 549350 }],
    diskBytes: 44256550,
  },
  'parakeet-v3': {
    variant: 'parakeet-v3', kind: 'nemo_transducer',
    archive: { name: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2', url: `${RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`, size: 487170055, sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf' },
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    files: [{ name: 'encoder.int8.onnx', size: 652184281 }, { name: 'decoder.int8.onnx', size: 11845275 }, { name: 'joiner.int8.onnx', size: 6355277 }, { name: 'tokens.txt', size: 93939 }],
    diskBytes: 670478772,
  },
};

export const DEFAULT_VARIANT: SttVariant = 'moonshine-base';

/** Bumped whenever the pinned model files change. */
export const MODEL_VERSION = 'sherpa-onnx-1.13.8/asr-models-2026-10-19';

export function isVariant(v: unknown): v is SttVariant { return typeof v === 'string' && v in MODELS; }

export interface DownloadProgress {
  phase: 'download' | 'extract' | 'done';
  file: string;
  received: number;
  total: number;
  /** all downloads together (archive + VAD), bytes */
  overallReceived: number;
  overallTotal: number;
}

export function vadPresent(dir: string): boolean { return sizeIs(path.join(dir, VAD_FILE.name), VAD_FILE.size); }

export function modelPresent(dir: string, variant: SttVariant): boolean {
  const spec = MODELS[variant];
  return spec.files.every((f) => sizeIs(path.join(dir, spec.dir, f.name), f.size));
}

/** Both the recogniser files of `variant` and the VAD model are on disk. */
export function isPresent(dir: string, variant: SttVariant): boolean { return vadPresent(dir) && modelPresent(dir, variant); }

/** The preferred variant when complete, else any complete one, else null. */
export function presentVariant(dir: string, preferred: SttVariant): SttVariant | null {
  if (!vadPresent(dir)) return null;
  for (const v of [preferred, ...(Object.keys(MODELS) as SttVariant[])]) if (modelPresent(dir, v)) return v;
  return null;
}

export function downloadBytes(dir: string, variant: SttVariant): number {
  return (vadPresent(dir) ? 0 : VAD_FILE.size) + (modelPresent(dir, variant) ? 0 : MODELS[variant].archive.size);
}

function sizeIs(file: string, size: number): boolean { try { return fs.statSync(file).size === size; } catch { return false; } }

/**
 * Downloads what is missing for `variant` (the VAD model and the recogniser archive), resuming partial
 * `.part` files with Range requests, verifying sha256, then extracts the archive (only the runtime files and
 * the LICENSE) and deletes it. `signal` aborts; progress is reported after every chunk.
 */
export async function downloadModel(dir: string, variant: SttVariant, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const spec = MODELS[variant];
  const needVad = !vadPresent(dir);
  const needModel = !modelPresent(dir, variant);
  const overallTotal = (needVad ? VAD_FILE.size : 0) + (needModel ? spec.archive.size : 0);
  let done = 0;
  if (needVad) {
    await downloadFile(VAD_FILE, path.join(dir, VAD_FILE.name), (received) => onProgress?.({ phase: 'download', file: VAD_FILE.name, received, total: VAD_FILE.size, overallReceived: done + received, overallTotal }), signal);
    done += VAD_FILE.size;
  }
  if (needModel) {
    const archive = path.join(dir, spec.archive.name);
    if (!sizeIs(archive, spec.archive.size)) {
      await downloadFile(spec.archive, archive, (received) => onProgress?.({ phase: 'download', file: spec.archive.name, received, total: spec.archive.size, overallReceived: done + received, overallTotal }), signal);
    }
    done += spec.archive.size;
    const wanted = new Set(spec.files.map((f) => `${spec.dir}/${f.name}`));
    wanted.add(`${spec.dir}/LICENSE`);
    const input = fs.createReadStream(archive, { signal });
    await extractTar(input.pipe(unbzip2()), dir, {
      filter: (e) => wanted.has(e.name),
      onProgress: (written) => onProgress?.({ phase: 'extract', file: spec.dir, received: written, total: spec.diskBytes, overallReceived: done, overallTotal }),
    });
    if (!modelPresent(dir, variant)) throw new Error(`${spec.archive.name}: extracted files are incomplete`);
    fs.rmSync(archive, { force: true });
  }
  onProgress?.({ phase: 'done', file: '', received: 0, total: 0, overallReceived: overallTotal, overallTotal });
}

async function downloadFile(f: ModelFile, target: string, onProgress: (received: number) => void, signal?: AbortSignal): Promise<void> {
  const part = `${target}.part`;
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* no partial file */ }
  if (have >= f.size) { have = 0; fs.rmSync(part, { force: true }); }
  const headers: Record<string, string> = { 'user-agent': 'DreamRead (Electron; speech model download)' };
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
