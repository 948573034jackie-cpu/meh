/** 16-bit PCM WAV encoding/decoding (mono). */
export function encodeWav(pcm: Float32Array, sampleRate: number): Buffer {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), 44 + i * 2);
  }
  return buf;
}

export function decodeWav(buf: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let pos = 12; let sampleRate = 24000; let data: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4); const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') sampleRate = buf.readUInt32LE(pos + 12);
    if (id === 'data') { data = buf.subarray(pos + 8, pos + 8 + size); break; }
    pos += 8 + size + (size & 1);
  }
  if (!data) throw new Error('WAV without data chunk');
  const pcm = new Int16Array(data.length >> 1);
  for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2);
  return { pcm, sampleRate };
}
