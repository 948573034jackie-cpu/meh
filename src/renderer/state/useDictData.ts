import { useEffect, useState } from 'react';
import type { DictData } from '@shared/api';
import type { LevelMaterials } from '@core/level/test';
import { prepareMaterials } from '@core/level/test';

/**
 * The raw dictionary data (DictData) for code that needs more than lookups, such as the level test's item
 * pools. Loaded once per renderer and cached in module scope, like reader/useDictionary.ts caches the
 * Dictionary built from the same data.
 */
let dataPromise: Promise<DictData> | null = null;
let materialsPromise: Promise<LevelMaterials> | null = null;

export function loadDictData(): Promise<DictData> {
  if (!dataPromise) dataPromise = window.readalong.loadDictionary();
  return dataPromise;
}

/** Item pools and pseudowords for the level test (prepareMaterials takes about half a second); built once. */
export function loadLevelMaterials(): Promise<LevelMaterials> {
  if (!materialsPromise) {
    materialsPromise = loadDictData().then((data) => prepareMaterials(data));
    materialsPromise.catch(() => { materialsPromise = null; });
  }
  return materialsPromise;
}

export function useDictData(): DictData | null {
  const [data, setData] = useState<DictData | null>(null);
  useEffect(() => { let on = true; loadDictData().then((d) => { if (on) setData(d); }); return () => { on = false; }; }, []);
  return data;
}

/** null while the dictionary loads or the materials are being prepared; the Error when loading failed. */
export function useLevelMaterials(): { materials: LevelMaterials | null; error: Error | null } {
  const [materials, setMaterials] = useState<LevelMaterials | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let on = true;
    loadLevelMaterials().then((m) => { if (on) setMaterials(m); }, (e: unknown) => { if (on) setError(e instanceof Error ? e : new Error(String(e))); });
    return () => { on = false; };
  }, []);
  return { materials, error };
}
