import { describe, it, expect } from 'vitest';
import { cutParts, packVocab } from '../src/vocab-sync';

describe('the online copy (chrome.storage.sync)', () => {
  it('every part fits one sync item as Chrome counts it (the key plus the JSON of the value), and the parts give the text back', () => {
    const words: Record<string, 'known' | 'learning'> = {};
    for (let i = 0; i < 1300; i++) words[`word${i} "x"`] = i % 3 ? 'learning' : 'known';
    const entries = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`w${i}`, { lemma: `w${i}`, word: `w${i}`, chinese: '仔细的，小心的', level: 'C1', status: 'learning', lastSeenAt: '2026-11-05' }])) as never;
    const text = packVocab(words, entries);
    const parts = cutParts(text);
    const enc = new TextEncoder();
    for (const [k, v] of Object.entries(parts)) expect(k.length + enc.encode(JSON.stringify(v)).length).toBeLessThanOrEqual(8192);
    expect(Object.values(parts).join('')).toBe(text);
    expect(Object.keys(parts).length).toBeGreaterThan(2);
  });
  it('the whole copy stays under Chrome\'s 102,400 bytes, Chinese and quotes counted as Chrome counts them', () => {
    const words: Record<string, 'learning'> = {};
    for (let i = 0; i < 1250; i++) words[`w${i}`] = 'learning';
    const entries = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`e${i}`, { lemma: `e${i}`, word: `e${i}`, chinese: '仔细的，小心的', level: 'B2', status: 'learning', lastSeenAt: '2026-11-05' }])) as never;
    const parts = cutParts(packVocab(words, entries));
    const enc = new TextEncoder();
    const total = Object.entries(parts).reduce((n, [k, v]) => n + k.length + enc.encode(JSON.stringify(v)).length, 0);
    expect(total).toBeLessThanOrEqual(100_000);
  });
  it('a part never ends between the two halves of one character', () => {
    const text = 'x'.repeat(7550) + '😀'.repeat(400);
    const parts = Object.values(cutParts(text));
    for (const p of parts) expect(/[\uD800-\uDBFF]$/.test(p) || /^[\uDC00-\uDFFF]/.test(p)).toBe(false);
    expect(parts.join('')).toBe(text);
  });
});
