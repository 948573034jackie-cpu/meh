/**
 * The small "background" of the app's browser pages: only what an explanation needs, the AI port ('dream-ai':
 * explain / complete) and the tutor's voice ('dream-tts'). It runs in the same private script world as web.ts; the
 * page's own JavaScript cannot reach it. Nothing happens here until web.ts asks (a tap, "Explain", "hello").
 */
import './web-flag';
import type { ExplainRequest } from '@shared/api';
import type { PromptBundle } from '@core/ai/prompts';
import { runExplain, runCompletion, synthesize, keepAwake } from './bg';

let installed = false;
export function installWebBackground(): void {
  if (installed || typeof chrome === 'undefined' || !chrome.runtime?.onConnect) return;
  installed = true;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'dream-ai') return;
    const ctrl = new AbortController();
    port.onDisconnect.addListener(() => ctrl.abort());
    const post = (m: unknown) => { try { port.postMessage(m); } catch { /* the page went away */ } };
    port.onMessage.addListener((msg: { type: string; req?: ExplainRequest; prompt?: PromptBundle; stream?: boolean; analysis?: boolean }) => {
      if (msg?.type === 'explain' && msg.req) {
        keepAwake(runExplain(msg.req, ctrl.signal, (t) => post({ type: 'delta', text: t })))
          .then((r) => post({ type: 'done', text: r.text, usage: r.usage }))
          .catch((e: Error & { code?: string }) => post({ type: 'error', message: e.message, code: e.code ?? 'other' }));
      } else if (msg?.type === 'complete' && msg.prompt) {
        keepAwake(runCompletion(msg.prompt, ctrl.signal, msg.stream ? (t) => post({ type: 'delta', text: t }) : undefined, msg.analysis))
          .then((r) => post({ type: 'done', text: r.text, usd: r.usd }))
          .catch((e: Error & { code?: string }) => post({ type: 'error', message: e.message, code: e.code ?? 'other' }));
      }
    });
  });
  chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
    if (msg?.type === 'dream-tts') { void keepAwake(synthesize(msg as unknown as Parameters<typeof synthesize>[0])).then(sendResponse, (e: Error) => sendResponse({ error: e.message })); return true; }
    return false;
  });
}
