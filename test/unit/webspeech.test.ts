import { describe, it, expect, beforeEach } from 'vitest';

/** Minimal stand-in for window.speechSynthesis: records spoken utterances, cancel() fires 'canceled' on them. */
class FakeUtterance {
  rate = 1; lang = ''; voice: unknown = null;
  onstart: (() => void) | null = null; onend: (() => void) | null = null; onboundary: ((e: unknown) => void) | null = null; onerror: ((e: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}
const synth = {
  spoken: [] as FakeUtterance[], speaking: false, paused: false,
  getVoices: () => [] as never[],
  speak(u: FakeUtterance) { this.spoken.push(u); this.speaking = true; },
  cancel() { const q = this.spoken.filter((u) => !u.onend); void q; this.speaking = false; for (const u of this.spoken.splice(0)) u.onerror?.({ error: 'canceled' }); },
  pause() { this.paused = true; }, resume() { this.paused = false; },
};
Object.assign(globalThis, { window: globalThis, speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance });

const { WebSpeechEngine } = await import('@core/tts/webspeech');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WebSpeechEngine', () => {
  beforeEach(() => { synth.spoken.length = 0; synth.speaking = false; });

  it('speaks and resolves when the utterance ends', async () => {
    const e = new WebSpeechEngine();
    const h = e.speak('Hello there', { voiceId: 'x', rate: 1 });
    await sleep(5);
    expect(synth.spoken.map((u) => u.text)).toEqual(['Hello there']);
    synth.spoken[0].onend?.();
    expect(await h.done).toBe('ended');
  });

  it('after cancelling one utterance (stop at a hard word) the next speak waits for the engine to settle', async () => {
    const e = new WebSpeechEngine();
    const a = e.speak('The sanguine man laughed.', { voiceId: 'x', rate: 1 });
    await sleep(5);
    a.cancel();
    expect(await a.done).toBe('cancelled');
    const b = e.speak('sanguine', { voiceId: 'x', rate: 1 });
    await sleep(10);
    expect(synth.spoken.map((u) => u.text)).toEqual([]); // Chromium drops a speak() issued right after cancel()
    await sleep(80);
    expect(synth.spoken.map((u) => u.text)).toEqual(['sanguine']);
    synth.spoken[0].onend?.();
    expect(await b.done).toBe('ended');
  });

  it('cancelAll() also cancels utterances still waiting to be spoken', async () => {
    const e = new WebSpeechEngine();
    e.cancelAll(); // opens the settle window
    const b = e.speak('ghost sentence', { voiceId: 'x', rate: 1 });
    e.cancelAll();
    expect(await Promise.race([b.done, sleep(20).then(() => 'pending')])).toBe('cancelled');
    await sleep(100);
    expect(synth.spoken.map((u) => u.text)).toEqual([]);
  });
});
