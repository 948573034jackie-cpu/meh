import JSZip from 'jszip';

/**
 * Reads the voice style vectors from kokoro-onnx's voices-v1.0.bin, which is a NumPy .npz archive: a zip of
 * `<voice>.npy` entries, each a little-endian float32 array of shape (510, 1, 256): one 256-float style
 * vector per phoneme count. Row n-1 is used for an input of n phonemes.
 */
export async function readVoicesNpz(data: Buffer): Promise<Map<string, Float32Array>> {
  const zip = await JSZip.loadAsync(data);
  const out = new Map<string, Float32Array>();
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith('.npy')) continue;
    const npy = await zip.files[name].async('nodebuffer');
    out.set(name.slice(0, -4), parseNpy(npy));
  }
  return out;
}

/** Parses a .npy file of little-endian float32 (any shape) into a flat Float32Array. */
export function parseNpy(buf: Buffer): Float32Array {
  if (buf.readUInt8(0) !== 0x93 || buf.toString('ascii', 1, 6) !== 'NUMPY') throw new Error('not a .npy file');
  const major = buf.readUInt8(6);
  const headerLen = major >= 2 ? buf.readUInt32LE(8) : buf.readUInt16LE(8);
  const headerStart = major >= 2 ? 12 : 10;
  const header = buf.toString('latin1', headerStart, headerStart + headerLen);
  if (!/'descr':\s*'<f4'/.test(header)) throw new Error(`unsupported .npy dtype: ${header}`);
  if (/'fortran_order':\s*True/.test(header)) throw new Error('fortran-ordered .npy not supported');
  const dataStart = headerStart + headerLen;
  const bytes = buf.subarray(dataStart);
  const aligned = Buffer.from(bytes); // copy: a Float32Array view needs 4-byte alignment
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length >> 2);
}

/** A plain float32 voice file (kokoro-js / onnx-community `voices/<id>.bin`, 510*256 floats). */
export function parseRawVoice(buf: Buffer): Float32Array {
  const aligned = Buffer.from(buf);
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length >> 2);
}
