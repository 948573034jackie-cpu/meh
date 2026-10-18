import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/** resources/ (dictionary data) lives next to the app in development and under process.resourcesPath when packaged. */
export function resourcesDir(): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'resources'),
    path.join(app.getAppPath(), 'resources'),
    path.join(__dirname, '..', '..', 'resources'),
  ];
  for (const c of candidates) if (c && fs.existsSync(path.join(c, 'dict', 'dict.json.gz'))) return c;
  return candidates[1];
}

export function rendererDir(): string { return path.join(__dirname, '..', 'renderer'); }
export function preloadPath(): string { return path.join(__dirname, '..', 'preload', 'index.js'); }
