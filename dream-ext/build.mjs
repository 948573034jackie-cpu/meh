// Builds the Dream Tutor parts of the Chrome extension into ../youtube-to-claude/dream/ (committed, so the
// extension loads unpacked without a build step). `node build.mjs --watch` rebuilds on every change.
// The same files run in the iPhone / iPad app (ios/sync-scripts.sh copies them), so the target is Safari 16.4 too.
import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(root, '../youtube-to-claude/dream');
const alias = { '@core': path.join(root, 'vendor/core'), '@shared': path.join(root, 'vendor/shared') };
const entries = [
  ['src/bg.ts', 'dream-bg.js'],
  ['src/yt.ts', 'dream-yt.js'],
  ['src/options.ts', 'options.js'],
  ['src/vocab-page.ts', 'vocab-page.js'],
].filter(([src]) => fs.existsSync(path.join(root, src)));

// every build gets its own stamp: the YouTube script carries it, and the folder has it in build-stamp.txt
const stamp = Date.now().toString(36);
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
