// Builds the Dream Tutor parts of the Chrome extension into ../youtube-to-claude/dream/ (committed, so the
// extension loads unpacked without a build step). `node build.mjs --watch` rebuilds on every change.
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

const common = {
  bundle: true, format: 'iife', platform: 'browser', target: ['chrome116'], alias, logLevel: 'info', legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' }, sourcemap: false, minify: true, loader: { '.css': 'text' },
};
fs.mkdirSync(out, { recursive: true });
const watch = process.argv.includes('--watch');
for (const [src, file] of entries) {
  const opts = { ...common, entryPoints: [path.join(root, src)], outfile: path.join(out, file) };
  if (watch) await (await esbuild.context(opts)).watch();
  else await esbuild.build(opts);
}
for (const f of fs.readdirSync(path.join(root, 'static'))) fs.copyFileSync(path.join(root, 'static', f), path.join(out, f));
