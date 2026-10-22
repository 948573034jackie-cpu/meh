import { DroppedError, type KokoroEngine } from './engine';

/** an item of kokoro:prepare (see the channel list in ./ipc.ts) */
export interface KokoroPrepareItem { text: string; voice?: string; speed?: number; priority?: number; wait?: boolean; replace?: boolean; release?: boolean; drop?: string[] }

/**
 * Applies one kokoro:prepare call. With `wait` items it resolves true once they are synthesized, or false when they
 * were dropped from the queue before (a later replace, clear or drop): the renderer then no longer needs them.
 */
export function handlePrepare(eng: Pick<KokoroEngine, 'prepare' | 'releaseWaiters' | 'dropTexts'>, items: KokoroPrepareItem[]): Promise<boolean> | void {
  if (!Array.isArray(items)) return;
  const replace = items.some((i) => i?.replace === true);
  if (items.some((i) => i?.release === true)) eng.releaseWaiters();
  // an explanation prepared ahead was dropped: its queued jobs go (a running one finishes)
  for (const i of items) if (Array.isArray(i?.drop)) eng.dropTexts(i.drop.filter((t): t is string => typeof t === 'string'), { voice: i.voice, speed: i.speed ?? 1 });
  const jobs = items.filter((i) => i && typeof i.text === 'string' && i.text.trim());
  const waited = jobs.filter((i) => i.wait === true);
  const rest = jobs.filter((i) => i.wait !== true);
  // a replacing call keeps its own waited items
  if (rest.length || replace) void eng.prepare(replace ? [...rest, ...waited] : rest, { replace }).catch(() => undefined);
  if (waited.length) return eng.prepare(waited, { wait: true }).then(() => true, (e: Error) => (e instanceof DroppedError ? false : Promise.reject(e)));
}
