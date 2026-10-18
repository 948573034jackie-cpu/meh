// Builds main, preload and renderer bundles with esbuild and copies static assets into dist/.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(path.join(dist, 'renderer'), { recursive: true });

const alias = { '@core': path.join(root, 'src/core'), '@shared': path.join(root, 'src/shared') };

// While core modules are still being written, resolve missing ones to an empty module so the app builds.
const missingModulePlugin = {
  name: 'missing-core-modules',
  setup(build) {
    build.onResolve({ filter: /^@core\/(import\/(epub|pdf|text)|dict\/(dictionary|names)|vocab\/analysis)$/ }, (args) => {
      const rel = `src/core/${args.path.slice('@core/'.length)}.ts`;
      if (fs.existsSync(path.join(root, rel))) return null;
      console.warn(`[build] ${rel} is missing; using an empty stub`);
      return { path: rel, namespace: 'stub' };
    });
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export {};', loader: 'js' }));
  },
};
const common = { bundle: true, sourcemap: true, logLevel: 'info', alias, plugins: [missingModulePlugin], define: { 'process.env.NODE_ENV': '"production"' } };

const main = {
  ...common,
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(dist, 'main/index.js'),
  platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'],
};
const preload = {
  ...common,
  entryPoints: [path.join(root, 'src/preload/index.ts')],
  outfile: path.join(dist, 'preload/index.js'),
  platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'],
};
const renderer = {
  ...common,
  entryPoints: [path.join(root, 'src/renderer/main.tsx')],
  outfile: path.join(dist, 'renderer/main.js'),
  platform: 'browser', format: 'esm', target: 'chrome150',
  loader: { '.css': 'css', '.woff2': 'file', '.svg': 'dataurl' },
};

function copyStatic() {
  for (const f of ['index.html']) fs.copyFileSync(path.join(root, 'src/renderer', f), path.join(dist, 'renderer', f));
  // main.css is emitted by esbuild from the CSS imports in main.tsx.
}

if (watch) {
  const ctxs = await Promise.all([main, preload, renderer].map((o) => esbuild.context(o)));
  await Promise.all(ctxs.map((c) => c.watch()));
  copyStatic();
  console.log('watching...');
} else {
  await Promise.all([main, preload, renderer].map((o) => esbuild.build(o)));
  copyStatic();
}
