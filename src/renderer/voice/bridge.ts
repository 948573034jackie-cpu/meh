/**
 * The stt IPC for VoiceChat: the preload bridge (window.readalong.stt*), a stand-in where there is no local
 * speech engine (the web build), and the e2e fake (no real mic: transcripts are injected by the spec).
 */
import type { ExplainRequest, SttStatus } from '@shared/api';
import type { SttEngineEvent } from '@core/voice/session';
import type { SttBridge, VoiceChat, VoiceSnapshot } from './VoiceChat';

const base: SttStatus = { state: 'ready', variant: 'moonshine-base', modelDir: '', downloadBytes: 0, progress: null, error: null, sessions: 0, version: '', confidence: false };

export function sttBridge(): SttBridge {
  const api = window.readalong;
  if (typeof api.sttStatus !== 'function' || !api.sttStart || !api.sttPush || !api.sttStop || !api.onSttEvent || !api.onSttProgress || !api.sttDownload || !api.sttCancelDownload) {
    const none: SttStatus = { ...base, state: 'error', error: 'Talking by voice needs the Mac app. You can type your question.' };
    return {
      status: async () => none, download: async () => none, cancelDownload: async () => undefined,
      start: async () => { throw new Error(none.error!); }, push: async () => undefined, stop: async () => undefined,
      onEvent: () => () => undefined, onProgress: () => () => undefined,
    };
  }
  return {
    status: () => api.sttStatus!(),
    download: () => api.sttDownload!(),
    cancelDownload: () => api.sttCancelDownload!(),
    start: (id, opts) => api.sttStart!(id, opts),
    push: (id, pcm) => api.sttPush!(id, pcm),
    stop: (id) => api.sttStop!(id),
    onEvent: (cb) => api.onSttEvent!((ev) => cb(ev as SttEngineEvent)),
    onProgress: (cb) => api.onSttProgress!(cb),
  };
}

/** e2e: the model is "ready", start/push/stop do nothing; events come from window.__dreamVoice.inject. */
export function e2eSttBridge(): SttBridge {
  const ready: SttStatus = { ...base, version: 'e2e' };
  return {
    status: async () => ready, download: async () => ready, cancelDownload: async () => undefined,
    start: async () => ready, push: async () => undefined, stop: async () => undefined,
    onEvent: () => () => undefined, onProgress: () => () => undefined,
  };
}

export interface DreamVoiceHooks {
  /** feeds a transcript event as if the speech engine had sent it, e.g. { type: 'final', text: 'I know', segmentId: 's1' } */
  inject(ev: { type: SttEngineEvent['type']; text?: string; segmentId?: string; message?: string }): void;
  snapshot(): VoiceSnapshot;
  /** every AI request the reader sent so far */
  requests: ExplainRequest[];
}

declare global { interface Window { __dreamVoice?: DreamVoiceHooks } }

/** Exposes window.__dreamVoice (e2e builds only); returns the uninstall function. */
export function installE2eHooks(chat: VoiceChat, requests: ExplainRequest[]): () => void {
  const hooks: DreamVoiceHooks = {
    inject: (ev) => chat.inject({ text: '', ...ev } as SttEngineEvent),
    snapshot: () => chat.snapshot,
    requests,
  };
  window.__dreamVoice = hooks;
  return () => { if (window.__dreamVoice === hooks) delete window.__dreamVoice; };
}
