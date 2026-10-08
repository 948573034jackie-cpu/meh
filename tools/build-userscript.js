// Builds userscript/wave-looper.user.js: the same looper as one script file,
// for Safari on iPhone/iPad (with the free "Userscripts" app) or for
// Tampermonkey/Violentmonkey on any desktop browser.
// Run: node tools/build-userscript.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// @inject-into auto: run in the page's own world (needed to read the audio for
// the waveform). If the site's security policy blocks that, the script manager
// falls back to its sandbox: loop, speed and trainer still work there, and the
// wave fills in as the song plays where the browser allows it.
const header = `// ==UserScript==
// @name         DJ Wave Looper for YouTube
// @namespace    https://github.com/948573034jackie-cpu/meh
// @version      ${version}
// @description  Whole-song DJ waveform, click-click A-B loop, 50/75/100% speed and an auto speed-up trainer for practising music on YouTube.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://music.youtube.com/*
// @run-at       document-start
// @inject-into  auto
// @grant        none
// @noframes
// ==/UserScript==
`;

// Storage for the userscript: IndexedDB on the YouTube site (the extension
// uses chrome.storage instead). Same get/set/remove shape as chrome.storage.
const storageShim = `
globalThis.YTL_STORAGE = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('ytl-wave-looper', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const list = (k) => (Array.isArray(k) ? k : [k]);
  return {
    get(keys) {
      return open().then((db) => new Promise((resolve) => {
        const out = {};
        const t = db.transaction('kv', 'readonly');
        const st = t.objectStore('kv');
        for (const k of list(keys)) {
          const r = st.get(k);
          r.onsuccess = () => { if (r.result !== undefined) out[k] = r.result; };
        }
        t.oncomplete = () => resolve(out);
        t.onerror = t.onabort = () => resolve(out);
      })).catch(() => ({}));
    },
    set(obj) {
      open().then((db) => {
        const st = db.transaction('kv', 'readwrite').objectStore('kv');
        for (const [k, v] of Object.entries(obj)) st.put(v, k);
      }).catch(() => {});
    },
    remove(keys) {
      open().then((db) => {
        const st = db.transaction('kv', 'readwrite').objectStore('kv');
        for (const k of list(keys)) st.delete(k);
      }).catch(() => {});
    },
  };
})();
`;

const body = `${header}
/* Built from src/ by tools/build-userscript.js. Edit the files in src/, not this one. */

if (/(^|\.)youtube\.com$/.test(location.hostname)) {
// ---- page-world audio tap (src/inject.js): must run before YouTube's player ----
${read('inject.js')}

// ---- panel, loop engine, speed and trainer: start once the page has a body ----
(function () {
  'use strict';
  function start() {
${storageShim}
${read('core.js')}
${read('panel-css.js')}
${read('vendor/signalsmith-stretch.js')}
${read('content.js')}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
}
`;

const outDir = path.join(ROOT, 'userscript');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'wave-looper.user.js');
fs.writeFileSync(out, body);
console.log(`wrote ${out} (${(body.length / 1024).toFixed(0)} KB)`);
