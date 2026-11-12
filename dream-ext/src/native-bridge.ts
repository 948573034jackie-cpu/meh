/**
 * The small things the iPhone / iPad app does for a page that is not the YouTube window (the reader, the browser):
 * Apple's own translation on the device (free, no AI). Nothing here ever sees an API key.
 */
type Handler = { postMessage(o: unknown): Promise<unknown> };
const handler = (): Handler | null => {
  try { return (window as unknown as { webkit?: { messageHandlers?: { ytc?: Handler } } }).webkit?.messageHandlers?.ytc ?? null; } catch { return null; }
};

/** the page runs inside the app (its bridge is there) */
export const inApp = (): boolean => !!handler();

/** a message to the app; null when there is no app or it did not answer */
export function appPost(msg: Record<string, unknown>): Promise<unknown> {
  const h = handler();
  if (!h) return Promise.resolve(null);
  try { return Promise.resolve(h.postMessage(msg)).catch(() => null); } catch { return Promise.resolve(null); }
}

/** a sentence in Chinese by the device itself (iOS 18); null = not here, or it could not */
export async function nativeTranslate(text: string): Promise<string | null> {
  const t = await appPost({ kind: 'translate', text });
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}
