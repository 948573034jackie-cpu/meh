import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// The Mac voice path: an utterance whose onend never arrives must not leave seconds of silence before the next sentence.
class FakeUtterance {
  rate = 1; volume = 1; lang = ''; voice: unknown = null;
  onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: ((e: { error: string }) => void) | null = null; onboundary: ((e: { name: string; charIndex: number; charLength?: number }) => void) | null = null;
  constructor(public text: string) {}
}
const DANIEL = { voiceURI: 'daniel', name: 'Daniel', lang: 'en-GB', localService: true, default: true };
const synth = {
  spoken: [] as FakeUtterance[], speaking: false, pending: false, paused: false,
  getVoices: () => [DANIEL],
  speak(u: FakeUtterance) { this.spoken.push(u); this.speaking = true; },
  cancel() { this.speaking = false; for (const u of this.spoken.splice(0)) u.onerror?.({ error: 'canceled' }); },
  pause() { this.paused = true; }, resume() { this.paused = false; },
  addEventListener() { /* voices are there */ }, removeEventListener() { /* noop */ },
};
Object.assign(globalThis, { window: globalThis, speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance });
const { WebSpeechEngine, IDLE_END_MS } = await import('@core/tts/webspeech');

describe('WebSpeechEngine: lost onend', () => {
  beforeEach(() => { vi.useFakeTimers({ now: 0 }); synth.spoken.length = 0; synth.speaking = false; });
  afterEach(() => { vi.useRealTimers(); });

  it('ends soon after the synthesizer goes idle instead of waiting for the end watchdog', async () => {
    const e = new WebSpeechEngine();
    const text = 'one two three four five six seven eight nine ten'; // 4 s expected; watchdog at 13 s
    const h = e.speak(text, { voiceId: 'daniel', rate: 1 });
    await vi.advanceTimersByTimeAsync(5);
    synth.spoken[0].onstart?.();
    let settled: string | null = null; void h.done.then((o) => { settled = o; });
    await vi.advanceTimersByTimeAsync(3800);
    expect(settled).toBeNull(); // speaking: never cut
    synth.speaking = false; // finished talking, but onend was lost
    await vi.advanceTimersByTimeAsync(IDLE_END_MS + 600);
    expect(settled).toBe('ended');
    expect(Date.now()).toBeLessThan(7000);
  });

  it('never ends early while the synthesizer is still speaking or before half the expected time', async () => {
    const e = new WebSpeechEngine();
    const h = e.speak('one two three four five six seven eight nine ten', { voiceId: 'daniel', rate: 1 });
    await vi.advanceTimersByTimeAsync(5);
    synth.spoken[0].onstart?.();
    synth.speaking = false; // some engines report idle for a moment right after start
    let settled: string | null = null; void h.done.then((o) => { settled = o; });
    await vi.advanceTimersByTimeAsync(1900);
    expect(settled).toBeNull(); // < half of the expected 4 s
    synth.spoken[0].onend?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('ended');
  });
});
