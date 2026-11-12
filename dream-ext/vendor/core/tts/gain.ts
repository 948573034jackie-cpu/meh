/**
 * The learner's volume, baked into the sound itself. An iPhone ignores `audio.volume` (it always stays 1), and a Web
 * Audio gain only works while its audio context runs, which on an iPhone it often does not (the microphone, a call or
 * another app interrupts it): then the tutor played at full loudness whatever the slider said. So where the element's
 * own volume does not work, the clip is decoded once, every sample is multiplied by the volume, and the result is
 * played as a WAV file. Nothing depends on a running audio context; the speed slider (playbackRate) still works.
 */

/** 16-bit PCM WAV of the channels (each -1..1), interleaved */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number, gain = 1): ArrayBuffer {
  const n = channels[0]?.length ?? 0, ch = Math.max(1, channels.length);
  const buf = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * ch * 2, true);
  let at = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, (channels[c]?.[i] ?? 0) * gain));
    v.setInt16(at, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    at += 2;
  }
  return buf;
}

let probed: boolean | null = null;
/** this device ignores an audio element's volume (an iPhone / iPad); `__ytcBakeVolume` forces the answer (tests) */
export function elementVolumeIgnored(): boolean {
  const forced = (globalThis as { __ytcBakeVolume?: boolean }).__ytcBakeVolume;
  if (typeof forced === 'boolean') return forced;
  if (probed !== null) return probed;
  try { const a = new Audio(); a.volume = 0.5; probed = Math.abs(a.volume - 0.5) > 0.01; } catch { probed = false; }
  return probed;
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;
const baked = new Map<string, Promise<Blob | null>>();

/**
 * The clip at this volume (0..1) as a WAV blob, or null when it cannot be decoded here (then it plays as it is: never
 * silent). `key` names the clip (the same clip at the same volume is made once and kept for a while).
 */
export function bakeVolume(audio: ArrayBuffer, volume: number, key?: string): Promise<Blob | null> {
  const k = key ? `${key}\u0000${volume.toFixed(3)}` : '';
  const had = k ? baked.get(k) : undefined;
  if (had) return had;
  const job = (async (): Promise<Blob | null> => {
    try {
      const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
      const OC = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
      if (!OC) return null;
      let ctx: OfflineAudioContext;
      try { ctx = new OC(1, 1, 24000); } catch { ctx = new OC(1, 1, 44100); }
      // (decodeAudioData takes the bytes away: it gets a copy)
      const copy = audio.slice(0);
      const buf = await new Promise<AudioBuffer>((resolve, reject) => {
        const p = ctx.decodeAudioData(copy, resolve, reject) as Promise<AudioBuffer> | undefined;
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
      if (!buf.length) return null;
      const channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
      return new Blob([encodeWav(channels, buf.sampleRate, volume)], { type: 'audio/wav' });
    } catch { return null; }
  })();
  if (k) {
    baked.set(k, job);
    while (baked.size > 12) baked.delete(baked.keys().next().value as string);
  }
  return job;
}
