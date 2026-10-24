/*
 * DJ Wave Looper: loads the right build of ONNX Runtime Web into the
 * offscreen page: the WebGPU build when the browser has WebGPU (the models
 * then run on the graphics chip, much faster), else the plain WebAssembly
 * build. Then offscreen.js. Jobs that arrive before offscreen.js is ready are
 * kept for it.
 */
(() => {
  'use strict';
  globalThis.YTL_EARLY = [];
  const early = (msg) => {
    if (msg && msg.type === 'ytl-stems-job') globalThis.YTL_EARLY.push(msg);
    return false;
  };
  chrome.runtime.onMessage.addListener(early);
  globalThis.YTL_EARLY_LISTENER = early;
  // (how far the page got, for the service worker's log)
  const boot = (what) => chrome.runtime.sendMessage({ type: 'ytl-stems-out', tabId: -1, stage: 'boot', what }).catch(() => {});
  globalThis.YTL_BOOT = boot;
  addEventListener('error', (e) => boot(`error: ${e.message} (${e.filename}:${e.lineno})`));
  addEventListener('unhandledrejection', (e) => boot(`unhandled: ${(e.reason && e.reason.message) || e.reason}`));
  const gpu = !!navigator.gpu;
  globalThis.YTL_ORT_BUNDLE = gpu ? 'webgpu' : 'wasm';
  boot(`listening; bundle ${globalThis.YTL_ORT_BUNDLE}`);
  const load = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
  load(gpu ? 'vendor/ort/ort.webgpu.min.js' : 'vendor/ort/ort.wasm.min.js')
    .catch((e) => {
      boot(`no WebGPU build (${e.message}); the plain one`);
      globalThis.YTL_ORT_BUNDLE = 'wasm';
      return load('vendor/ort/ort.wasm.min.js');
    })
    .then(() => {
      boot(`ONNX Runtime loaded (${typeof ort})`);
      return load('offscreen.js');
    })
    .catch((e) => {
      boot(`failed: ${e.message}`);
      console.error('stems:', e);
    });
})();
