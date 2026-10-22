import { useEffect, useState } from 'react';
import type { Dictionary } from '@core/dict/types';
import { createDictionary } from '@core/dict/dictionary';
import { loadDictData } from '../state/useDictData';

let promise: Promise<Dictionary> | null = null;

export function loadDictionary(): Promise<Dictionary> {
  if (!promise) {
    promise = loadDictData().then((data) => createDictionary(data));
    promise.catch(() => { promise = null; });
  }
  return promise;
}

/**
 * Starts loading the dictionary when the page is idle (the Library screen), so opening the first book does not wait
 * for it (about 0.3 s of transfer, parsing and indexing). Returns a cancel for a load that has not started yet.
 */
export function loadDictionaryWhenIdle(): () => void {
  if (promise) return () => undefined;
  const start = () => { void loadDictionary().catch(() => undefined); };
  // Safari (the iPad build) has no requestIdleCallback
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(start, { timeout: 3000 });
    return () => window.cancelIdleCallback(id);
  }
  const t = setTimeout(start, 800);
  return () => clearTimeout(t);
}

export function useDictionary(): Dictionary | null {
  const [dict, setDict] = useState<Dictionary | null>(null);
  useEffect(() => { let on = true; loadDictionary().then((d) => { if (on) setDict(d); }, () => undefined); return () => { on = false; }; }, []);
  return dict;
}
