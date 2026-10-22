/** Content-script side of the Dream Tutor AI: requests go to the background worker over a port (the key stays there). */
import type { ExplainRequest } from '@shared/api';
import type { PromptBundle } from '@core/ai/prompts';
import type { DictData } from '@shared/api';
import { createDictionary } from '@core/dict/dictionary';
import type { Dictionary } from '@core/dict/types';

export interface ExplainUsage { usd: number; dailyUsd: number; monthlyUsd: number }

export function explain(req: ExplainRequest, onDelta: (full: string) => void): { done: Promise<{ text: string; usage: ExplainUsage }>; cancel(): void } {
  let full = '';
  let settled = false;
  let resolve!: (v: { text: string; usage: ExplainUsage }) => void;
  let reject!: (e: Error & { code?: string }) => void;
  const done = new Promise<{ text: string; usage: ExplainUsage }>((res, rej) => { resolve = res; reject = rej; });
  done.catch(() => undefined);
  let port: chrome.runtime.Port | null = null;
  const fail = (message: string, code: string) => { if (settled) return; settled = true; const e = new Error(message) as Error & { code?: string }; e.code = code; reject(e); try { port?.disconnect(); } catch { /* gone */ } };
  try {
    port = chrome.runtime.connect({ name: 'dream-ai' });
    port.onMessage.addListener((m: { type: string; text?: string; usage?: ExplainUsage; message?: string; code?: string }) => {
      if (settled) return;
      if (m.type === 'delta') { full += m.text ?? ''; onDelta(full); }
      else if (m.type === 'done') { settled = true; resolve({ text: m.text ?? full, usage: m.usage ?? { usd: 0, dailyUsd: 0, monthlyUsd: 0 } }); try { port?.disconnect(); } catch { /* gone */ } }
      else if (m.type === 'error') fail(m.message ?? 'AI error', m.code ?? 'other');
    });
    port.onDisconnect.addListener(() => fail('The extension stopped (reload the YouTube page).', 'network'));
    port.postMessage({ type: 'explain', req });
  } catch (e) { fail(`The extension is not reachable: ${(e as Error).message}. Reload the YouTube page.`, 'network'); }
  return { done, cancel: () => fail('cancelled', 'cancelled') };
}

/** A completion with the cheap model whose text arrives piece by piece (live Chinese translation). */
export function completeStream(prompt: PromptBundle, onDelta: (full: string) => void): { done: Promise<string>; cancel(): void } {
  let port: chrome.runtime.Port | null = null;
  let full = '';
  let settled = false;
  let resolve!: (t: string) => void, reject!: (e: Error) => void;
  const done = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  done.catch(() => undefined);
  const end = (fn: () => void) => { if (settled) return; settled = true; fn(); try { port?.disconnect(); } catch { /* gone */ } };
  try {
    port = chrome.runtime.connect({ name: 'dream-ai' });
    port.onMessage.addListener((m: { type: string; text?: string; message?: string; code?: string }) => {
      if (settled) return;
      if (m.type === 'delta') { full += m.text ?? ''; onDelta(full); }
      else if (m.type === 'done') end(() => resolve(m.text ?? full));
      else end(() => reject(Object.assign(new Error(m.message ?? 'AI error'), { code: m.code })));
    });
    port.onDisconnect.addListener(() => end(() => reject(new Error('The extension stopped.'))));
    port.postMessage({ type: 'complete', prompt, stream: true });
  } catch (e) { end(() => reject(e as Error)); }
  return { done, cancel: () => end(() => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))) };
}

/** One background completion with the cheap hints model (Chinese meanings, phrases). */
export function complete(prompt: PromptBundle): Promise<string> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port;
    try { port = chrome.runtime.connect({ name: 'dream-ai' }); } catch (e) { reject(e); return; }
    let settled = false;
    port.onMessage.addListener((m: { type: string; text?: string; message?: string; code?: string }) => {
      if (settled) return;
      settled = true;
      if (m.type === 'done') resolve(m.text ?? '');
      else reject(Object.assign(new Error(m.message ?? 'AI error'), { code: m.code }));
      try { port.disconnect(); } catch { /* gone */ }
    });
    port.onDisconnect.addListener(() => { if (!settled) { settled = true; reject(new Error('The extension stopped.')); } });
    port.postMessage({ type: 'complete', prompt });
  });
}

let dictData: Promise<DictData> | null = null;
let dictionary: Promise<Dictionary> | null = null;

/** The offline dictionary (ECDICT + British IPA + CEFR levels, 2.3 MB) that ships with the extension. */
export function getDictData(): Promise<DictData> {
  dictData ??= (async () => {
    const res = await fetch(chrome.runtime.getURL('dream/dict.json.gz'));
    if (!res.ok) throw new Error(`The dictionary could not be loaded (HTTP ${res.status}).`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) return JSON.parse(new TextDecoder().decode(buf)) as DictData;
    const text = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(text) as DictData;
  })();
  dictData.catch(() => { dictData = null; });
  return dictData;
}
export function getDictionary(): Promise<Dictionary> {
  dictionary ??= getDictData().then((d) => createDictionary(d));
  dictionary.catch(() => { dictionary = null; });
  return dictionary;
}
