/*
 * DJ Wave Looper: the offscreen page that separates a song into stems
 * (vocals / drums / bass) with the MDX-Net models, using ONNX Runtime Web:
 * on the graphics chip (WebGPU) when the browser has it and it gives the
 * same answer as the processor, else in WebAssembly on a few threads (never
 * more than half the cores: the song must keep playing while the models run).
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
  const sessions = {}; // `${engine}:${stem}` -> InferenceSession
  const loading = {}; // same keys -> Promise
  const bytesOf = {}; // stem -> Promise<Uint8Array> (the model file)
  let queue = Promise.resolve();
  let current = null; // the job running now
  const cancelled = new Set(); // ids of jobs not wanted any more

  ort.env.wasm.wasmPaths = ORT_PATH;
  const cores = navigator.hardwareConcurrency || 2;
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor(cores / 2))) : 1;
  ort.env.wasm.numThreads = threads;
  const gpuPossible = globalThis.YTL_ORT_BUNDLE === 'webgpu' && !!navigator.gpu && !!ort.env.webgpu;
  if (gpuPossible) ort.env.webgpu.powerPreference = 'high-performance';
  let gpu = gpuPossible ? null : 'no'; // null = not decided yet, 'ok' | 'no'
  let gpuWhy = '';

  const send = (tabId, msg) => chrome.runtime.sendMessage({ type: 'ytl-stems-out', tabId, ...msg }).catch(() => {});
  const engine = () => (gpu === 'ok' ? 'webgpu' : 'wasm');

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
  async function fetchModel(stem, base, tabId, id) {
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

  function modelBytes(stem, base, tabId, id) {
    if (!bytesOf[stem]) {
      bytesOf[stem] = fetchModel(stem, base, tabId, id).catch((e) => {
        delete bytesOf[stem];
        throw e;
      });
    }
    return bytesOf[stem];
  }

  function session(stem, eng, base, tabId, id) {
    const key = `${eng}:${stem}`;
    if (sessions[key]) return Promise.resolve(sessions[key]);
    if (!loading[key]) {
      loading[key] = (async () => {
        const bytes = await modelBytes(stem, base, tabId, id);
        send(tabId, { id, stage: 'load', stem });
        const s = await ort.InferenceSession.create(bytes, { executionProviders: [eng] });
        sessions[key] = s;
        return s;
      })().catch((e) => {
        delete loading[key];
        throw e;
      });
    }
    return loading[key];
  }

  function freeSession(key) {
    const s = sessions[key];
    delete sessions[key];
    delete loading[key];
    if (s) s.release().catch(() => {});
  }

  // How closely two answers agree (dB; the processor's answer as the reference).
  function agreement(ref, got) {
    let e = 0;
    let p = 0;
    for (let i = 0; i < ref.length; i++) {
      const d = ref[i] - got[i];
      e += d * d;
      p += ref[i] * ref[i];
    }
    return 10 * Math.log10((p + 1e-12) / (e + 1e-12));
  }

  // (This page has only chrome.runtime: the content script keeps the GPU
  // verdict in storage and sends it with each job as job.gpu.)
  async function rememberGpu(ok, why) {
    gpu = ok ? 'ok' : 'no';
    gpuWhy = why || '';
  }

  async function runJob(tabId, job) {
    const id = job.id;
    const l = floatFromInt16(b64ToInt16(job.l));
    const r = floatFromInt16(b64ToInt16(job.r));
    const sr = job.sr;
    const n = l.length;
    const mix = sr === ST.SAMPLE_RATE ? [l, r] : [ST.resample(l, sr, ST.SAMPLE_RATE), ST.resample(r, sr, ST.SAMPLE_RATE)];
    const stems = job.stems || ['vocals', 'drums', 'bass'];
    if (gpu === null && (job.gpu === 'ok' || job.gpu === 'no')) {
      gpu = job.gpu;
      gpuWhy = job.gpuWhy || 'from the last time';
    }
    for (const stem of stems) {
      if (current !== job) return; // cancelled
      const m = ST.MODELS[stem];
      const feed = async (sess, spec) => {
        const res = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', spec, [1, 4, m.dimF, m.dimT]) });
        return res[sess.outputNames[0]].data;
      };
      // the model is loaded before the first chunk, so the progress means something
      await session(stem, gpu === 'no' ? 'wasm' : 'webgpu', job.modelBase, tabId, id).catch(async (e) => {
        if (gpu === 'no') throw e;
        await rememberGpu(false, `no GPU session (${(e && e.message) || e})`);
        return session(stem, 'wasm', job.modelBase, tabId, id);
      });
      if (current !== job) return;
      send(tabId, { id, stage: 'progress', stem, frac: 0 });
      const run = async (spec) => {
        if (current !== job) throw new Error('cancelled');
        if (gpu === 'ok') {
          try {
            return await feed(await session(stem, 'webgpu', job.modelBase, tabId, id), spec);
          } catch (e) {
            await rememberGpu(false, `GPU failed (${(e && e.message) || e})`);
            freeSession(`webgpu:${stem}`);
          }
        } else if (gpu === null) {
          // First time: the graphics chip must give the same answer as the processor.
          try {
            const outG = await feed(await session(stem, 'webgpu', job.modelBase, tabId, id), spec);
            const outC = await feed(await session(stem, 'wasm', job.modelBase, tabId, id), spec);
            const dB = agreement(outC, outG);
            if (dB > 25) {
              await rememberGpu(true, `agrees with the processor (${dB.toFixed(1)} dB)`);
              freeSession(`wasm:${stem}`);
              return outG;
            }
            await rememberGpu(false, `GPU answer off (${dB.toFixed(1)} dB)`);
            freeSession(`webgpu:${stem}`);
            return outC;
          } catch (e) {
            await rememberGpu(false, `GPU check failed (${(e && e.message) || e})`);
            freeSession(`webgpu:${stem}`);
          }
        }
        return feed(await session(stem, 'wasm', job.modelBase, tabId, id), spec);
      };
      const out = await ST.separate(mix, m, run, (frac) => send(tabId, { id, stage: 'progress', stem, frac }));
      const back = sr === ST.SAMPLE_RATE ? out : [ST.resample(out[0], ST.SAMPLE_RATE, sr, n), ST.resample(out[1], ST.SAMPLE_RATE, sr, n)];
      send(tabId, { id, stage: 'stem', stem, l: int16ToB64(back[0]), r: int16ToB64(back[1]) });
    }
    send(tabId, { id, stage: 'done', threads, engine: engine(), gpuWhy });
  }

  function onJob(msg) {
    const { tabId, job } = msg;
    if (job.op === 'cancel') {
      cancelled.add(job.id);
      if (current && current.id === job.id) current = null;
      return;
    }
    if (job.op === 'ping') {
      send(tabId, { id: job.id, stage: 'pong', threads, engine: engine(), gpuWhy, isolated: !!self.crossOriginIsolated });
      return;
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
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'ytl-stems-job' || !msg.job) return false;
    onJob(msg);
    return false;
  });
  // jobs that came in while ONNX Runtime was still loading
  if (globalThis.YTL_EARLY_LISTENER) chrome.runtime.onMessage.removeListener(globalThis.YTL_EARLY_LISTENER);
  for (const msg of globalThis.YTL_EARLY || []) if (msg.job) onJob(msg);
  globalThis.YTL_EARLY = [];
})();
