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

/** Name of the data folder the app used before it was renamed to Dream Read. */
export const LEGACY_APP_NAME = 'ReadAlong';

/**
 * The product rename moved userData from ".../ReadAlong" to ".../Dream Read". On the first start with the new
 * name, when the new folder has no data/ yet and the old one does, the old data/ (settings, library, books,
 * vocab, usage, secrets.json and secret.key) is copied over once. The old folder is left untouched.
 * Returns the source folder when a copy happened, null otherwise.
 */
export function migrateLegacyUserData(): string | null {
  try {
    const target = path.join(app.getPath('userData'), 'data');
    if (fs.existsSync(target)) return null;
    const legacy = path.join(app.getPath('appData'), LEGACY_APP_NAME, 'data');
    if (!fs.existsSync(legacy) || path.resolve(legacy) === path.resolve(target)) return null;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(legacy, target, { recursive: true, errorOnExist: false, force: false });
    try { fs.chmodSync(path.join(target, 'secret.key'), 0o600); } catch { /* no key file */ }
    console.log(`data: copied the ${LEGACY_APP_NAME} data folder to ${target}`);
    return legacy;
  } catch (e) {
    console.error('data: could not copy the old data folder', e);
    return null;
  }
}

/** ~/Documents/Dream Read: where exports (vocabulary CSV) are written. Created on demand. */
export function exportDir(): string {
  const dir = path.join(app.getPath('documents'), 'Dream Read');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
