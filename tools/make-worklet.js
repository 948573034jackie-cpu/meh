// Writes src/vendor/stretch-worklet.js: the Signalsmith Stretch AudioWorklet
// module as a file of its own. The library normally loads it from a blob:
// URL, which YouTube's script policy (strict-dynamic) refuses; the extension
// loads this file by its own URL instead (web_accessible_resources).
// Run after updating src/vendor/signalsmith-stretch.js:  node tools/make-worklet.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'vendor', 'signalsmith-stretch.js'), 'utf8');
let code = null;
const sandbox = {
  console,
  Blob: class { constructor(parts) { this.text = parts.join(''); } },
  URL: { createObjectURL: (b) => { code = b.text; return 'blob:captured'; } },
  AudioWorkletNode: class { constructor() { throw new Error('module not loaded yet'); } },
  window: null,
  self: null,
  globalThis: null,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const fn = sandbox.SignalsmithStretch;
if (typeof fn !== 'function') throw new Error('SignalsmithStretch not found in the vendor file');
const ctx = { audioWorklet: { addModule: () => Promise.reject(new Error('captured')) } };
fn(ctx).catch(() => {}).then(() => {
  if (!code) throw new Error('the worklet code was not captured');
  const out = path.join(ROOT, 'src', 'vendor', 'stretch-worklet.js');
  const head = '/* Signalsmith Stretch (MIT, Geraint Luff / Signalsmith Audio): the AudioWorklet processor, made by tools/make-worklet.js from signalsmith-stretch.js. */\n';
  fs.writeFileSync(out, head + code + '\n');
  console.log(`wrote ${out} (${Math.round((head.length + code.length) / 1024)} KB)`);
});
