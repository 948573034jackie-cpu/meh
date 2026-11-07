/**
 * The vocabulary database online: one PRIVATE GitHub gist that holds vocabulary.json, shared by the iPhone app and
 * the Chrome extension on the Mac. The learner makes a GitHub token with only "Gists: read and write" and types it
 * into the settings (it is kept with the other keys; it never leaves the device except to api.github.com).
 *
 * The gist is found by its description, or made on the first use. Every change of the words is written to it within
 * seconds (level-db-bg.ts writeDatabase merges it like the shared file: only the other device's changes come in), and
 * it is read again every few seconds while the app is open: with the last ETag, an unchanged gist costs nothing.
 */
import { isDoc, type VocabularyDoc } from './level-db';

export const GIST_DESCRIPTION = 'My tutor: my vocabulary (vocabulary.json)';
export const GIST_FILE = 'vocabulary.json';
const API = 'https://api.github.com';
/** where the gist's id and last ETag are kept on this device */
export const GIST_STATE_KEY = 'drGist';

export interface GistState { id?: string; etag?: string; at?: string; error?: string; ok?: boolean; login?: string }

type Fetch = typeof fetch;
const headers = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  ...extra,
});

async function failed(res: Response, what: string): Promise<Error> {
  let msg = '';
  try { msg = ((await res.json()) as { message?: string }).message ?? ''; } catch { /* no body */ }
  const hint = res.status === 401 ? ' (the GitHub token is wrong or expired: make a new one)'
    : res.status === 403 || res.status === 404 ? ' (the token needs "Gists: Read and write")' : '';
  return Object.assign(new Error(`GitHub ${what}: ${res.status} ${msg}${hint}`.trim()), { status: res.status });
}

/** The learner's gist: the one with our description, among their newest 100 gists; null when there is none yet. */
export async function findGist(token: string, f: Fetch = fetch): Promise<string | null> {
  const res = await f(`${API}/gists?per_page=100`, { headers: headers(token) });
  if (!res.ok) throw await failed(res, 'list gists');
  const list = (await res.json()) as { id: string; description?: string | null; files?: Record<string, unknown> }[];
  const mine = list.find((g) => g.description === GIST_DESCRIPTION && g.files && GIST_FILE in g.files);
  return mine?.id ?? null;
}

/** A new private gist with this document. */
export async function createGist(token: string, doc: VocabularyDoc, f: Fetch = fetch): Promise<string> {
  const res = await f(`${API}/gists`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ description: GIST_DESCRIPTION, public: false, files: { [GIST_FILE]: { content: JSON.stringify(doc, null, 1) } } }),
  });
  if (!res.ok) throw await failed(res, 'make the gist');
  return ((await res.json()) as { id: string }).id;
}

/**
 * The gist's document. With `etag`: null when it did not change since (GitHub answers 304, which costs nothing).
 * A file over 1 MB comes cut in the answer: then it is fetched whole from its raw address.
 */
export async function readGist(token: string, id: string, etag?: string, f: Fetch = fetch): Promise<{ doc: VocabularyDoc | null; etag?: string; changed: boolean }> {
  const res = await f(`${API}/gists/${id}`, { headers: headers(token, etag ? { 'If-None-Match': etag } : {}) });
  if (res.status === 304) return { doc: null, etag, changed: false };
  if (!res.ok) throw await failed(res, 'read the gist');
  const g = (await res.json()) as { files?: Record<string, { content?: string; truncated?: boolean; raw_url?: string }> };
  const file = g.files?.[GIST_FILE];
  let text = file?.content ?? '';
  if (file?.truncated && file.raw_url) {
    const raw = await f(file.raw_url, { headers: { Authorization: `Bearer ${token}` } });
    if (raw.ok) text = await raw.text();
  }
  let doc: VocabularyDoc | null = null;
  try { const d = JSON.parse(text) as unknown; doc = isDoc(d) ? d : null; } catch { doc = null; }
  return { doc, etag: res.headers.get('ETag') ?? undefined, changed: true };
}

/** The document written to the gist; the new ETag (the next read of an unchanged gist is then free). */
export async function writeGist(token: string, id: string, doc: VocabularyDoc, f: Fetch = fetch): Promise<string | undefined> {
  const res = await f(`${API}/gists/${id}`, {
    method: 'PATCH',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(doc, null, 1) } } }),
  });
  if (!res.ok) throw await failed(res, 'save to the gist');
  return res.headers.get('ETag') ?? undefined;
}

/** The documents of two copies are the same words, tests and level (the time it was written does not count). */
export function sameWords(a: VocabularyDoc | null, b: VocabularyDoc | null): boolean {
  if (!a || !b) return false;
  const strip = (d: VocabularyDoc) => JSON.stringify({ ...d, updatedAt: '' });
  return strip(a) === strip(b);
}
