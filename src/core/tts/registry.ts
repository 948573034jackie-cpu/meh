import type { TtsEngineId } from '@shared/settings';
import type { TtsEngine } from './engine';
import { WebSpeechEngine } from './webspeech';
import { AudioTtsEngine } from './audio';
import { FakeTtsEngine } from './fake';
import { KokoroTtsEngine } from './kokoro';

const engines = new Map<TtsEngineId, TtsEngine>();
let fake: FakeTtsEngine | null = null;

/** In tests (READALONG_E2E) or on machines without system voices the fake engine stands in for Web Speech. */
export function useFakeEngine(msPerChar = 2): FakeTtsEngine {
  fake = new FakeTtsEngine(msPerChar);
  engines.set('webspeech', fake);
  return fake;
}

export function getEngine(id: TtsEngineId): TtsEngine {
  let e = engines.get(id);
  if (e) return e;
  if (id === 'webspeech') e = fake ?? new WebSpeechEngine();
  else if (id === 'kokoro') e = new KokoroTtsEngine();
  else e = new AudioTtsEngine(id, (engine, text, voiceId, rate) => window.readalong.ttsSynthesize(engine, text, voiceId, rate), (engine) => window.readalong.ttsListVoices(engine), id === 'edge' || id === 'elevenlabs' || id === 'google');
  engines.set(id, e);
  return e;
}

export function cancelAllEngines(): void { for (const e of engines.values()) e.cancelAll(); }

/** Sensible default voice per engine when the learner has not picked one. */
export async function defaultVoiceFor(id: TtsEngineId): Promise<string> {
  if (id === 'webspeech') return fake ? 'fake-gb' : WebSpeechEngine.defaultVoiceId();
  const fallback: Record<TtsEngineId, string> = { webspeech: '', edge: 'en-GB-SoniaNeural', openai: 'ballad', elevenlabs: 'JBFqnCBsd6RMkjVDRZzb', kokoro: 'bf_emma', azure: 'en-GB-SoniaNeural', google: 'en-GB-Neural2-A' };
  try {
    const voices = await getEngine(id).listVoices();
    const gb = voices.find((v) => v.lang.toLowerCase() === 'en-gb');
    return gb?.id ?? voices[0]?.id ?? fallback[id];
  } catch { return fallback[id]; }
}

/** A Chinese system voice for speaking word meanings, if the Mac has one. */
export async function chineseVoiceId(): Promise<string | null> {
  const voices = await getEngine('webspeech').listVoices();
  const zh = voices.filter((v) => /^zh[-_]?(cn|hans)?$/i.test(v.lang) || v.lang.toLowerCase() === 'zh-cn');
  const preferred = zh.find((v) => /tingting|ting-ting|meijia|lili/i.test(v.name)) ?? zh[0];
  return preferred?.id ?? null;
}
