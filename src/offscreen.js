/*
 * DJ Wave Looper: the offscreen page that separates a song into stems
 * (vocals / drums / bass) with the MDX-Net models, using ONNX Runtime Web
 * (wasm, several threads when the page is cross-origin isolated).
 *
 * The content script sends jobs through the service worker (see
 * background.js): { id, sr, len, l, r (16-bit samples as base64), stems,
 * modelBase }. Each finished stem goes back on its own, then "done".
 */
(() => {
  'use strict';
  const ST = globalThis.YTLStems;
  const ORT_PATH = chrome.runtime.getURL('src/vendor/ort/');
  const CACHE = 'ytl-stem-models-1';
  const sessions = {}; // stem -> InferenceSession
  const loading = {}; // stem -> Promise
  let queue = Promise.resolve();
  let current = null; // the job running now
  const cancelled = new Set(); // ids of jobs not wanted any more

  ort.env.wasm.wasmPaths = ORT_PATH;
  // (one core is left for the page and its audio thread: the song keeps playing while the model runs)
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  ort.env.wasm.numThreads = threads;

  const send = (tabId, msg) => chrome.runtime.sendMessage({ type: 'ytl-stems-out', tabId, ...msg }).catch(() => {});

  // --- 16-bit samples <-> base64 (the message bus takes JSON only) ---
  function b64ToInt16(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return new Int16Array(u8.buffer, 0, u8.length >> 1);
  }
  function floatFromInt16(a) {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] / 32768;
    return out;
  }
  function int16ToB64(f) {
    const a = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const v = Math.max(-1, Math.min(1, f[i]));
      a[i] = v < 0 ? v * 32768 : v * 32767;
    }
    const u8 = new Uint8Array(a.buffer);
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }

  // --- the models: downloaded once, kept in the extension's cache ---
  async function modelBytes(stem, base, tabId, id) {
    const url = base + ST.MODELS[stem].file;
    const cache = await caches.open(CACHE);
    let res = await cache.match(url);
    if (!res) {
      res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      let lastAt = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (Date.now() - lastAt > 200) {
          lastAt = Date.now();
          send(tabId, { id, stage: 'download', stem, got, total });
        }
      }
      const blob = new Blob(parts, { type: 'application/octet-stream' });
      try {
        await cache.put(url, new Response(blob, { headers: { 'content-type': 'application/octet-stream' } }));
      } catch (e) {
        /* no room to keep it: it downloads again next time */
      }
      return new Uint8Array(await blob.arrayBuffer());
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  function session(stem, base, tabId, id) {
    if (sessions[stem]) return Promise.resolve(sessions[stem]);
    if (!loading[stem]) {
      loading[stem] = (async () => {
        const bytes = await modelBytes(stem, base, tabId, id);
        send(tabId, { id, stage: 'load', stem });
        const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
        sessions[stem] = s;
        return s;
      })().catch((e) => {
        delete loading[stem];
        throw e;
      });
    }
    return loading[stem];
  }

  async function runJob(tabId, job) {
    const id = job.id;
    const l = floatFromInt16(b64ToInt16(job.l));
    const r = floatFromInt16(b64ToInt16(job.r));
    const sr = job.sr;
    const n = l.length;
    const mix = sr === ST.SAMPLE_RATE ? [l, r] : [ST.resample(l, sr, ST.SAMPLE_RATE), ST.resample(r, sr, ST.SAMPLE_RATE)];
    const stems = job.stems || ['vocals', 'drums', 'bass'];
    for (const stem of stems) {
      if (current !== job) return; // cancelled
      const m = ST.MODELS[stem];
      const sess = await session(stem, job.modelBase, tabId, id);
      if (current !== job) return;
      send(tabId, { id, stage: 'progress', stem, frac: 0 });
      const out = await ST.separate(mix, m, async (spec) => {
        if (current !== job) throw new Error('cancelled');
        const res = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', spec, [1, 4, m.dimF, m.dimT]) });
        return res[sess.outputNames[0]].data;
      }, (frac) => send(tabId, { id, stage: 'progress', stem, frac }));
      const back = sr === ST.SAMPLE_RATE ? out : [ST.resample(out[0], ST.SAMPLE_RATE, sr, n), ST.resample(out[1], ST.SAMPLE_RATE, sr, n)];
      send(tabId, { id, stage: 'stem', stem, l: int16ToB64(back[0]), r: int16ToB64(back[1]) });
    }
    send(tabId, { id, stage: 'done', threads });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'ytl-stems-job' || !msg.job) return false;
    const { tabId, job } = msg;
    if (job.op === 'cancel') {
      cancelled.add(job.id);
      if (current && current.id === job.id) current = null;
      return false;
    }
    if (job.op === 'ping') {
      send(tabId, { id: job.id, stage: 'pong', threads, isolated: !!self.crossOriginIsolated });
      return false;
    }
    queue = queue
      .then(async () => {
        if (cancelled.has(job.id)) {
          cancelled.delete(job.id);
          return;
        }
        current = job;
        try {
          await runJob(tabId, job);
        } catch (e) {
          if (current === job) send(tabId, { id: job.id, stage: 'error', why: String((e && e.message) || e) });
        }
        if (current === job) current = null;
      })
      .catch(() => {});
    return false;
  });
})();
