// Builds the Dream Tutor parts of the Chrome extension into ../youtube-to-claude/dream/ (committed, so the
// extension loads unpacked without a build step). `node build.mjs --watch` rebuilds on every change.
// The same files run in the iPhone / iPad app (ios/sync-scripts.sh copies them), so the target is Safari 16.4 too.
import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(root, '../youtube-to-claude/dream');
const alias = { '@core': path.join(root, 'vendor/core'), '@shared': path.join(root, 'vendor/shared') };
const entries = [
  ['src/bg.ts', 'dream-bg.js'],
  ['src/yt.ts', 'dream-yt.js'],
  ['src/options.ts', 'options.js'],
  ['src/vocab-page.ts', 'vocab-page.js'],
  ['src/reader.ts', 'reader.js'],
].filter(([src]) => fs.existsSync(path.join(root, src)));

// The build's stamp comes from the sources themselves: the same sources give exactly the same files (the build server
// checks that the committed files match), and any change gives a new stamp, which an unpacked extension notices and
// reloads itself on (see devReload in src/bg.ts). The YouTube script carries it, and the folder has it in build-stamp.txt.
function hashInto(h, dir) {
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) hashInto(h, p);
    else { h.update(path.relative(root, p)); h.update(fs.readFileSync(p)); }
  }
}
const hash = crypto.createHash('sha1');
for (const d of ['src', 'vendor', 'static']) hashInto(hash, path.join(root, d));
for (const f of ['build.mjs', 'package-lock.json']) hash.update(fs.readFileSync(path.join(root, f)));
const stamp = hash.digest('hex').slice(0, 10);
const common = {
  bundle: true, format: 'iife', platform: 'browser', target: ['chrome116', 'safari16.4'], alias, logLevel: 'info', legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"', __DREAM_BUILD__: JSON.stringify(stamp) }, sourcemap: false, minify: true, loader: { '.css': 'text' },
};
fs.mkdirSync(out, { recursive: true });
const watch = process.argv.includes('--watch');
for (const [src, file] of entries) {
  const opts = { ...common, entryPoints: [path.join(root, src)], outfile: path.join(out, file) };
  if (watch) await (await esbuild.context(opts)).watch();
  else await esbuild.build(opts);
}
for (const f of fs.readdirSync(path.join(root, 'static'))) fs.copyFileSync(path.join(root, 'static', f), path.join(out, f));
// a new build on disk: an unpacked extension notices it and reloads itself (see devReload in src/bg.ts)
if (!watch) fs.writeFileSync(path.join(out, 'build-stamp.txt'), `${stamp}\n`);
