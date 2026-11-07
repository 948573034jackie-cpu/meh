import { describe, it, expect } from 'vitest';
import { findGist, createGist, readGist, writeGist, GIST_DESCRIPTION, GIST_FILE } from '../src/gist-sync';
import type { VocabularyDoc } from '../src/level-db';

const doc: VocabularyDoc = { version: 1, updatedAt: '2026-11-07T04:00:00.000Z', currentLevel: 'B2', tests: [], known: [{ item: 'familiar', date: '2026-11-04' }], stillLearning: [] };
const res = (status: number, body: unknown, etag?: string) => new Response(status === 304 ? null : JSON.stringify(body), { status, headers: etag ? { ETag: etag } : {} });

describe('the online database (a private GitHub gist)', () => {
  it('finds the learner\'s gist by its description, makes a private one when there is none', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/gists?per_page=100')) return res(200, [{ id: 'other', description: 'x', files: {} }, { id: 'g1', description: GIST_DESCRIPTION, files: { [GIST_FILE]: {} } }]);
      if (url.endsWith('/gists') && init?.method === 'POST') return res(201, { id: 'new1' });
      return res(404, {});
    }) as typeof fetch;
    expect(await findGist('t', f)).toBe('g1');
    expect(calls[0].init?.headers).toMatchObject({ Authorization: 'Bearer t' });
    expect(await createGist('t', doc, f)).toBe('new1');
    const body = JSON.parse(String(calls[1].init?.body));
    expect(body.public).toBe(false);
    expect(JSON.parse(body.files[GIST_FILE].content).known[0].item).toBe('familiar');
  });
  it('reads with the last ETag: an unchanged gist is "not changed" (free), a changed one gives its document', async () => {
    const f = (async (_url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (h['If-None-Match'] === '"e1"') return res(304, null);
      return res(200, { files: { [GIST_FILE]: { content: JSON.stringify(doc) } } }, '"e2"');
    }) as typeof fetch;
    expect(await readGist('t', 'g1', '"e1"', f)).toEqual({ doc: null, etag: '"e1"', changed: false });
    const r = await readGist('t', 'g1', undefined, f);
    expect(r.changed).toBe(true);
    expect(r.etag).toBe('"e2"');
    expect(r.doc?.known[0].item).toBe('familiar');
  });
  it('a wrong token says so plainly', async () => {
    const f = (async () => res(401, { message: 'Bad credentials' })) as unknown as typeof fetch;
    await expect(writeGist('bad', 'g1', doc, f)).rejects.toThrow(/token is wrong or expired/);
  });
});
