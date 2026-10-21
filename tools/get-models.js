// Downloads the stem separation models (MDX-Net, as published by Ultimate
// Vocal Remover) into test/fixtures/models for the stem tests:
//   npm run fixtures:models
// The extension itself downloads the same files the first time Stems is used.
const fs = require('fs');
const path = require('path');
const { MODELS } = require('../src/stems.js');
const USED = ['vocals', 'drums', 'bass']; // "other" is the song minus these

const BASE = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/';
const DIR = process.env.MODELS_DIR || path.join(__dirname, '..', 'test', 'fixtures', 'models');

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  for (const k of USED) {
    const file = MODELS[k].file;
    const dest = path.join(DIR, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1e6) {
      console.log(`${file}: already there`);
      continue;
    }
    process.stdout.write(`${file}: downloading… `);
    const res = await fetch(BASE + file);
    if (!res.ok) throw new Error(`${file}: ${res.status} ${res.statusText}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    fs.writeFileSync(dest, bytes);
    console.log(`${(bytes.length / 1048576).toFixed(1)} MB`);
  }
  console.log(`models in ${DIR}`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
