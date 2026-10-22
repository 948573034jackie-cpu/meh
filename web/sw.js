// Dream Read service worker: cache-first for the app shell and the dictionary, versioned per build.
// scripts/build-web.mjs replaces __VERSION__ and __ASSETS__ when it copies this file to dist/web/sw.js.
// Requests to other origins (AI and voice providers) are never touched.
const VERSION = '__VERSION__';
const CACHE = `dream-read-${VERSION}`;
const ASSETS = __ASSETS__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dream-read-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // navigations (and "?e2e" style variants) are served by the cached index.html
    const key = req.mode === 'navigate' ? new URL('index.html', self.registration.scope).href : url.origin + url.pathname;
    const hit = await cache.match(key);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(key, res.clone()).catch(() => undefined);
      return res;
    } catch (e) {
      if (req.mode === 'navigate') {
        const shell = await cache.match(new URL('index.html', self.registration.scope).href);
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
