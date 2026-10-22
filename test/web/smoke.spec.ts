import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'dist/web');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.gz': 'application/gzip', '.map': 'application/json', '.woff2': 'font/woff2',
};

let server: http.Server;
let base = '';

/** A tiny static server for dist/web (no compression, like a plain static host). */
function serve(dir: string): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test.beforeAll(async () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-web.mjs')], { cwd: root, stdio: 'pipe' });
  server = await serve(dist);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => { await new Promise((r) => server?.close(r)); });

/** First start: skip the level test, finish the settings tour, land in the library. */
async function onboard(page: Page): Promise<void> {
  await expect(page.getByTestId('level-intro')).toBeVisible();
  await page.getByTestId('level-skip').tap();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.getByTestId('finish-onboarding').tap();
  await expect(page.getByTestId('library')).toBeVisible();
}

const TEXT = `The Lighthouse

Mara climbed the narrow stairs of the old lighthouse every evening. The wind was fierce, and the sea below was restless and grey.

She lit the lamp and watched the beam sweep across the water. Somewhere out there, a small boat was searching for the harbour.

When the boat finally reached the shore, the fisherman waved to her. Mara smiled, because the light had done its quiet work again.`;

test('web build: paste a text, read it, switch Reading <-> Listening, data survives a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/index.html?e2e=1`);

  // the browser API is installed, and unknown methods resolve harmlessly
  expect(await page.evaluate(() => typeof window.readalong.importText)).toBe('function');
  expect(await page.evaluate(async () => (await (window.readalong as unknown as Record<string, () => Promise<unknown>>).someFutureMethod()) ?? 'undefined')).toBe('undefined');
  // local speech recognition is feature-detected by the renderer and must look absent (typed questions remain)
  expect(await page.evaluate(() => [typeof window.readalong.sttStatus, typeof window.readalong.onSttEvent])).toEqual(['undefined', 'undefined']);

  await onboard(page);

  // the gzipped dictionary inflates in the browser
  const dictWords = await page.evaluate(async () => { const d = await window.readalong.loadDictionary(); return Object.keys((typeof d === 'string' ? JSON.parse(d) : d).w).length; });
  expect(dictWords).toBeGreaterThan(10_000);

  // paste a text
  await page.getByTestId('paste-text').tap();
  await page.getByTestId('paste-title').fill('The Lighthouse');
  await page.getByTestId('paste-body').fill(TEXT);
  await page.getByTestId('paste-import').tap();

  // the reader opens in Reading mode with the text
  await expect(page.getByTestId('reading')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('doc')).toContainText('narrow stairs');

  // Reading -> Listening -> Reading
  const showBars = async () => { if (!(await page.getByTestId('topbar').isVisible())) await page.getByTestId('doc').tap({ position: { x: 500, y: 600 } }); };
  await showBars();
  await page.getByTestId('switch-mode').first().tap();
  await expect(page.getByTestId('listening')).toBeVisible();
  await expect(page.getByTestId('listening')).toContainText('lighthouse');
  await page.getByTestId('listening').getByTestId('switch-mode').tap();
  await expect(page.getByTestId('reading')).toBeVisible();

  // touch targets in the reader bar are at least 44 px high
  await showBars();
  const box = await page.getByTestId('switch-mode').first().boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  // the book, settings and onboarding live in IndexedDB: after a reload the library still has it
  await page.goto(`${base}/index.html?e2e=1`);
  await expect(page.getByTestId('library')).toBeVisible();
  await expect(page.getByTestId('book-card')).toHaveCount(1);
  await expect(page.getByTestId('book-card')).toContainText('The Lighthouse');

  // the web defaults use the browser's own voices, not the Mac-only Dream voice
  expect(await page.evaluate(async () => (await window.readalong.getSettings()).voice.engine)).toBe('webspeech');

  expect(errors).toEqual([]);
});

test('web build: shell files for the home screen are served', async ({ request }) => {
  const manifest = await (await request.get(`${base}/manifest.webmanifest`)).json();
  expect(manifest.name).toBe('Dream Read');
  expect(manifest.display).toBe('standalone');
  for (const icon of ['icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'pdf.worker.mjs', 'dict.json.gz']) {
    expect((await request.get(`${base}/${icon}`)).status(), icon).toBe(200);
  }
  const sw = await (await request.get(`${base}/sw.js`)).text();
  expect(sw).not.toContain("const VERSION = '__VERSION__'");
  expect(sw).toContain('dict.json.gz');
});

test('web build: EPUB and PDF import through the file picker (pdf.js worker in the browser)', async ({ page }) => {
  const errors: string[] = [];
  const logs: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(`${base}/index.html?e2e=1`);
  await onboard(page);
  for (const file of ['book.epub', 'prose.pdf']) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('open-book').tap();
    await (await chooser).setFiles(path.join(root, 'test/fixtures', file));
    await expect(page.getByTestId('reading')).toBeVisible({ timeout: 30_000 });
    const words = await page.evaluate(async () => (await window.readalong.listLibrary())[0]?.words ?? 0);
    expect(words, file).toBeGreaterThan(50);
    await page.goto(`${base}/index.html?e2e=1`);
    await expect(page.getByTestId('library')).toBeVisible();
  }
  await expect(page.getByTestId('book-card')).toHaveCount(2);
  expect(errors).toEqual([]);
  // pdf.js ran in its worker (pdf.worker.mjs), not the main-thread fallback
  expect(logs.filter((l) => /fake worker/i.test(l))).toEqual([]);
});

test('web build: AI explanation streams from the browser (Anthropic SSE, mocked)', async ({ page }) => {
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  await page.route('https://api.anthropic.com/v1/messages', async (route) => {
    headers = route.request().headers();
    body = route.request().postDataJSON();
    const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' },
      body: ev('message_start', { message: { usage: { input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 1 } } })
        + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Fierce means ' } })
        + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'very strong. 猛烈的' } })
        + ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } })
        + ev('message_stop', {}),
    });
  });
  await page.goto(`${base}/index.html?e2e=1`);
  await onboard(page);
  const result = await page.evaluate(async () => {
    const api = window.readalong;
    const noKey = await new Promise<string>((resolve) => {
      const off = api.onAiEvent((ev) => { if (ev.type === 'error') { off(); resolve(ev.code ?? ''); } });
      void api.aiExplain({ kind: 'word', target: 'fierce', sentence: 'The wind was fierce.', before: '', after: '', book: { title: 'T', chapter: '1' }, history: [] });
    });
    await api.setSecret('anthropic', 'sk-ant-test-key');
    const deltas: string[] = [];
    const done = await new Promise<{ text: string; usd: number; input: number }>((resolve, reject) => {
      const off = api.onAiEvent((ev) => {
        if (ev.type === 'delta') deltas.push(ev.text);
        else if (ev.type === 'done') { off(); resolve({ text: ev.text, usd: ev.usage.usd, input: ev.usage.inputTokens }); }
        else { off(); reject(new Error(ev.message)); }
      });
      void api.aiExplain({ kind: 'word', target: 'fierce', sentence: 'The wind was fierce.', before: '', after: '', book: { title: 'T', chapter: '1' }, history: [] });
    });
    return { noKey, deltas, done, usage: (await api.getUsage()).length };
  });
  expect(result.noKey).toBe('no_key');
  expect(result.deltas.join('')).toBe('Fierce means very strong. 猛烈的');
  expect(result.done.input).toBe(1000);
  expect(result.done.usd).toBeGreaterThan(0);
  expect(result.usage).toBe(1);
  expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  expect(headers['x-api-key']).toBe('sk-ant-test-key');
  expect(body.stream).toBe(true);
});

test('web build: the service worker precaches the app shell and the dictionary', async ({ page }) => {
  await page.goto(`${base}/index.html`);
  const cached = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 100; i++) {
      const keys = await caches.keys();
      const name = keys.find((k) => k.startsWith('dream-read-'));
      if (name) {
        const urls = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
        if (urls.some((u) => u.endsWith('dict.json.gz'))) return urls;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return [];
  });
  expect(cached).toContain('/main.js');
  expect(cached).toContain('/dict.json.gz');
  expect(cached).toContain('/pdf.worker.mjs');
});
