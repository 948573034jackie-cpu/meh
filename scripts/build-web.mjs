// Builds the web (iPad / Safari) version into dist/web: the unchanged renderer (src/renderer) with a browser
// implementation of window.readalong (src/web), plus the static shell (web/), the dictionary, the pdf.js
// worker and a versioned service worker. Usage: node scripts/build-web.mjs [--watch] [--no-minify]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const watch = process.argv.includes('--watch');
const minify = !process.argv.includes('--no-minify');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'dist/web');

const alias = { '@core': path.join(root, 'src/core'), '@shared': path.join(root, 'src/shared') };

/** Browser stand-ins for the few Node-only imports of the shared importers (see src/web/shims). */
const browserShims = {
  name: 'web-shims',
  setup(build) {
    build.onResolve({ filter: /^(node:)?path$/ }, () => ({ path: path.join(root, 'src/web/shims/path.ts') }));
    build.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf\.mjs$/ }, () => ({ path: path.join(root, 'src/web/shims/pdfjs.mjs') }));
    build.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf\.mjs\?real$/ }, () => ({ path: path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs') }));
  },
};

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: { main: path.join(root, 'src/web/main.ts') },
  outdir: out,
  bundle: true,
  splitting: true, // epub / pdf importers (pdf.js) load on demand as separate chunks
  format: 'esm',
  platform: 'browser',
  // DecompressionStream (dictionary) needs Safari 16.4 / iPadOS 16.4
  target: ['safari16.4', 'chrome111'],
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  minify,
  sourcemap: 'linked',
  logLevel: 'info',
  alias,
  plugins: [browserShims],
  loader: { '.css': 'css', '.woff2': 'file', '.svg': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true,
};

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function listFiles(dir, base = dir) {
  const outList = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) outList.push(...listFiles(p, base));
    else outList.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return outList;
}

function copyStatic() {
  const web = path.join(root, 'web');
  for (const f of listFiles(web)) if (f !== 'sw.js') copy(path.join(web, f), path.join(out, f));
  copy(path.join(root, 'resources/dict/dict.json.gz'), path.join(out, 'dict.json.gz'));
  copy(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'), path.join(out, 'pdf.worker.mjs'));
}

/** sw.js with the list of files to precache and a version derived from their contents. */
function writeServiceWorker() {
  const files = listFiles(out).filter((f) => f !== 'sw.js' && !f.endsWith('.map')).sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(f).update(fs.readFileSync(path.join(out, f)));
  const version = hash.digest('hex').slice(0, 12);
  const assets = ['./', ...files];
  const sw = fs.readFileSync(path.join(root, 'web/sw.js'), 'utf8')
    .replace("const VERSION = '__VERSION__';", `const VERSION = '${version}';`)
    .replace('const ASSETS = __ASSETS__;', `const ASSETS = ${JSON.stringify(assets, null, 1)};`);
  if (sw.includes("'__VERSION__';") || sw.includes('= __ASSETS__')) throw new Error('sw.js placeholders not replaced');
  fs.writeFileSync(path.join(out, 'sw.js'), sw);
  return { version, count: assets.length };
}

function report(result) {
  const rows = listFiles(out).filter((f) => !f.endsWith('.map')).map((f) => [f, fs.statSync(path.join(out, f)).size]).sort((a, b) => b[1] - a[1]);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log('\ndist/web:');
  for (const [f, n] of rows.slice(0, 14)) console.log(`  ${kb(n).padStart(10)}  ${f}`);
  console.log(`  ${kb(rows.reduce((s, r) => s + r[1], 0)).padStart(10)}  total (${rows.length} files, source maps excluded)`);
  if (result?.metafile) {
    const initial = Object.entries(result.metafile.outputs).filter(([f]) => /main\.(js|css)$/.test(f)).reduce((s, [, o]) => s + o.bytes, 0);
    console.log(`  initial load (main.js + main.css): ${kb(initial)}`);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [...options.plugins, { name: 'after', setup(b) { b.onEnd(() => { copyStatic(); writeServiceWorker(); }); } }],
  });
  await ctx.watch();
  console.log('watching (dist/web)...');
} else {
  const result = await esbuild.build(options);
  copyStatic();
  const sw = writeServiceWorker();
  report(result);
  console.log(`  service worker version ${sw.version}, ${sw.count} files precached`);
}
