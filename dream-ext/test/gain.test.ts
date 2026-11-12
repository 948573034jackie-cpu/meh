import { describe, it, expect } from 'vitest';
import { encodeWav, elementVolumeIgnored } from '@core/tts/gain';

const peak = (wav: ArrayBuffer): number => {
  const v = new DataView(wav);
  let p = 0;
  for (let at = 44; at + 1 < wav.byteLength; at += 2) p = Math.max(p, Math.abs(v.getInt16(at, true)));
  return p;
};

describe("the tutor's volume in the sound itself (an iPhone ignores audio.volume)", () => {
  const tone = Float32Array.from({ length: 2400 }, (_, i) => Math.sin(i / 8));
  it('a WAV file with the right header', () => {
    const wav = encodeWav([tone], 24000);
    const v = new DataView(wav);
    const tag = (at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(24000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(wav.byteLength).toBe(44 + tone.length * 2);
  });
  it('20% is clearly quieter than 100% (the slider squared: 0.04 of the sound)', () => {
    const full = peak(encodeWav([tone], 24000, 1));
    const low = peak(encodeWav([tone], 24000, 0.04));
    expect(full).toBeGreaterThan(32000);
    expect(low).toBeLessThan(full * 0.05);
    expect(low).toBeGreaterThan(full * 0.03);
    // half the slider (0.25 of the sound) sits between them
    const mid = peak(encodeWav([tone], 24000, 0.25));
    expect(mid).toBeGreaterThan(low * 4);
    expect(mid).toBeLessThan(full * 0.3);
  });
  it('never louder than the file can hold; two channels stay two', () => {
    const loud = encodeWav([Float32Array.from([2, -2, 0.5])], 8000, 1);
    const v = new DataView(loud);
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32768);
    const st = encodeWav([tone, tone], 24000, 0.5);
    expect(new DataView(st).getUint16(22, true)).toBe(2);
    expect(st.byteLength).toBe(44 + tone.length * 4);
  });
  it('the test switch says which way the device is', () => {
    (globalThis as { __ytcBakeVolume?: boolean }).__ytcBakeVolume = true;
    expect(elementVolumeIgnored()).toBe(true);
    (globalThis as { __ytcBakeVolume?: boolean }).__ytcBakeVolume = false;
    expect(elementVolumeIgnored()).toBe(false);
    delete (globalThis as { __ytcBakeVolume?: boolean }).__ytcBakeVolume;
  });
});
