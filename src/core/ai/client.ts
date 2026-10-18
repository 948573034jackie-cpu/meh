import type { ExplainRequest, AiEvent } from '@shared/api';

export interface ExplainStream {
  done: Promise<{ text: string; usage: Extract<AiEvent, { type: 'done' }>['usage'] }>;
  cancel(): void;
}

/** Renderer-side client: starts an explanation in the main process and relays its streamed text. */
export function explain(req: ExplainRequest, onDelta?: (text: string, full: string) => void): ExplainStream {
  let streamId: string | null = null;
  let cancelled = false;
  let full = '';
  let resolve!: (v: { text: string; usage: Extract<AiEvent, { type: 'done' }>['usage'] }) => void;
  let reject!: (e: Error & { code?: string }) => void;
  const done = new Promise<{ text: string; usage: Extract<AiEvent, { type: 'done' }>['usage'] }>((res, rej) => { resolve = res; reject = rej; });
  const pending: AiEvent[] = [];
  const handle = (ev: AiEvent) => {
    if (ev.type === 'delta') { full += ev.text; onDelta?.(ev.text, full); }
    else if (ev.type === 'done') { off(); resolve({ text: ev.text, usage: ev.usage }); }
    else if (ev.type === 'error') { off(); const e = new Error(ev.message) as Error & { code?: string }; e.code = ev.code; reject(e); }
  };
  const off = window.readalong.onAiEvent((ev) => {
    if (!streamId) { pending.push(ev); return; }
    if (ev.streamId === streamId) handle(ev);
  });
  window.readalong.aiExplain(req).then(({ streamId: id }) => {
    streamId = id;
    for (const ev of pending.splice(0)) if (ev.streamId === id) handle(ev);
    if (cancelled) void window.readalong.aiCancel(id);
  }).catch((e) => { off(); reject(e as Error); });
  done.catch(() => undefined);
  return {
    done,
    cancel: () => { cancelled = true; if (streamId) void window.readalong.aiCancel(streamId); off(); const e = new Error('cancelled') as Error & { code?: string }; e.code = 'cancelled'; reject(e); },
  };
}
