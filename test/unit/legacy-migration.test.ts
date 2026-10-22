import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// <appData>/ReadAlong/data (the old app) and <appData>/Dream Read (the new userData)
const ctx = vi.hoisted(() => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-read-migrate-'));
  return { appData, userData: path.join(appData, 'Dream Read') };
});
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: (n: string) => (n === 'appData' ? ctx.appData : ctx.userData) },
  safeStorage: { isEncryptionAvailable: () => false, decryptString: () => { throw new Error('no keychain'); } },
}));

import { migrateLegacyUserData } from '../../src/main/paths';
import * as secrets from '../../src/main/secrets';
import { SECRET_NAMES } from '../../src/shared/api';

describe('ReadAlong -> Dream Read data folder', () => {
  it('copies settings and both secrets.json and secret.key, so every saved key still decrypts; runs once', () => {
    // the old app saves its keys
    const old = ctx.userData;
    ctx.userData = path.join(ctx.appData, 'ReadAlong');
    secrets.resetSecretsCache();
    for (const n of SECRET_NAMES) secrets.setSecret(n, n === 'azure' ? '{"key":"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6","region":"uksouth"}' : `key-for-${n}-0123456789`);
    fs.writeFileSync(path.join(ctx.userData, 'data', 'settings.json'), JSON.stringify({ learnerLevel: 'C1' }));
    // first start of Dream Read
    ctx.userData = old;
    secrets.resetSecretsCache();
    expect(migrateLegacyUserData()).toBe(path.join(ctx.appData, 'ReadAlong', 'data'));
    expect(fs.existsSync(path.join(ctx.userData, 'data', 'secret.key'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(ctx.userData, 'data', 'settings.json'), 'utf8')).learnerLevel).toBe('C1');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(ctx.userData, 'data', 'secret.key')).mode & 0o777).toBe(0o600);
    const status = secrets.checkSecrets();
    for (const n of SECRET_NAMES) expect(status[n]).toMatchObject({ saved: true, verified: true, lostAtStartup: false });
    expect(secrets.getSecret('openai')).toBe('key-for-openai-0123456789');
    // the second start leaves the new folder alone
    expect(migrateLegacyUserData()).toBeNull();
  });
});
