import type { ChapterPhrase } from '@core/listen/controller';

/** sentenceKey ("c.p.s") -> the chapter phrase job's hits in that sentence */
export type ChapterPhraseMap = Record<string, ChapterPhrase[]>;

/**
 * Turns whatever the chapter phrase bridge (window.readalong.hintsPhrases) returned into sentenceKey -> hits,
 * tolerantly: a map keyed by "c.p.s" (or "p.s" within the chapter), the same map nested under the chapter
 * number, or a flat list of hits that carry their sentenceKey. Malformed entries are dropped; null gives {}.
 */
export function toChapterPhraseMap(data: unknown, chapter: number): ChapterPhraseMap {
  const out: ChapterPhraseMap = {};
  const add = (key: string, raw: unknown) => {
    const hit = toHit(raw);
    if (!hit) return;
    const parts = key.split('.');
    const full = parts.length === 2 ? `${chapter}.${key}` : key;
    if (!/^\d+\.\d+\.\d+$/.test(full)) return;
    (out[full] ??= []).push(hit);
  };
  if (!data || typeof data !== 'object') return out;
  if (Array.isArray(data)) {
    for (const h of data) { const k = (h as { sentenceKey?: unknown })?.sentenceKey; if (typeof k === 'string') add(k, h); }
    return out;
  }
  let map = data as Record<string, unknown>;
  const nested = map[String(chapter)];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) map = nested as Record<string, unknown>;
  for (const [key, list] of Object.entries(map)) {
    if (!Array.isArray(list)) continue;
    for (const h of list) add(typeof (h as { sentenceKey?: unknown })?.sentenceKey === 'string' ? (h as { sentenceKey: string }).sentenceKey : key, h);
  }
  return out;
}

function toHit(raw: unknown): ChapterPhrase | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const start = Number(r.start), end = Number(r.end);
  const text = typeof r.text === 'string' ? r.text : '';
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || !text.trim()) return null;
  const level = typeof r.level === 'string' ? r.level : '';
  if (!level) return null;
  const lemma = typeof r.lemma === 'string' && r.lemma.trim() ? r.lemma : text.toLowerCase();
  const zh = typeof r.zh === 'string' ? r.zh : undefined;
  return { start, end, text, lemma, level, ...(zh ? { zh } : {}) };
}
