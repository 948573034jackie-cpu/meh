import { useEffect, useState } from 'react';
import type { Dictionary } from '@core/dict/types';
import { createDictionary } from '@core/dict/dictionary';

let promise: Promise<Dictionary> | null = null;

export function loadDictionary(): Promise<Dictionary> {
  if (!promise) promise = window.readalong.loadDictionary().then((data) => createDictionary(data));
  return promise;
}

export function useDictionary(): Dictionary | null {
  const [dict, setDict] = useState<Dictionary | null>(null);
  useEffect(() => { let on = true; loadDictionary().then((d) => { if (on) setDict(d); }); return () => { on = false; }; }, []);
  return dict;
}
