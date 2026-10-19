import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A fresh userData folder per test; the mocked safeStorage can be switched between "works" and "broken" (the re-signed-app case).
const ctx = vi.hoisted(() => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const c = { userData: fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-secrets-')), safeWorks: true, decryptCalls: 0 };
  return c;
});
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => ctx.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`keychain:${s}`, 'utf8'),
    decryptString: (b: Buffer) => { ctx.decryptCalls++; if (!ctx.safeWorks) throw new Error('Decryption failed'); return b.toString('utf8').replace(/^keychain:/, ''); },
  },
}));

import * as secrets from '../../src/main/secrets';
import { SECRET_NAMES } from '../../src/shared/api';

const dataDir = () => path.join(ctx.userData, 'data');
const secretsFile = () => path.join(dataDir(), 'secrets.json');
const keyFile = () => path.join(dataDir(), 'secret.key');
const SAMPLE: Record<string, string> = {
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
  openai: 'sk-proj-0123456789abcdefghijklmnopqrstuvwxyz',
  elevenlabs: 'sk_0123456789abcdef0123456789abcdef',
  azure: JSON.stringify({ key: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6', region: 'uksouth' }),
  google: 'AIzaSyA-0123456789abcdefghijklmnopqrstu',
};

beforeEach(() => {
  ctx.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-secrets-'));
  ctx.safeWorks = true;
  ctx.decryptCalls = 0;
  secrets.resetSecretsCache();
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(ctx.userData, { recursive: true, force: true }); });

describe('secrets: app-folder encryption', () => {
  it('round-trips all five keys through AES-256-GCM and survives a cache reset', () => {
    for (const name of SECRET_NAMES) expect(secrets.setSecret(name, SAMPLE[name]).warning).toBeNull();
    for (const name of SECRET_NAMES) expect(secrets.getSecret(name)).toBe(SAMPLE[name]);
    // nothing on disk is plaintext or the old Keychain format
    const raw = fs.readFileSync(secretsFile(), 'utf8');
    for (const name of SECRET_NAMES) expect(raw).not.toContain(SAMPLE[name].slice(4, 20));
    const parsed = JSON.parse(raw) as Record<string, { v: number; iv: string; tag: string; data: string }>;
    for (const name of SECRET_NAMES) expect(parsed[name]).toMatchObject({ v: 2 });
    expect(parsed.anthropic.iv).not.toBe(parsed.openai.iv);
    // a fresh process (new cache) reads the same values back with the key file
    secrets.resetSecretsCache();
    for (const name of SECRET_NAMES) expect(secrets.getSecret(name)).toBe(SAMPLE[name]);
    const status = secrets.secretStatus();
    for (const name of SECRET_NAMES) expect(status[name]).toEqual({ saved: true, verified: true, lostAtStartup: false });
    expect(secrets.getAzureCredentials()).toEqual({ key: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6', region: 'uksouth' });
  });

  it('creates the key file with mode 0600 and 32 random bytes', () => {
    secrets.setSecret('openai', SAMPLE.openai);
    const st = fs.statSync(keyFile());
    expect(st.size).toBe(32);
    if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600);
    // a different key file means the stored value cannot be read (and is reported, not returned)
    fs.writeFileSync(keyFile(), Buffer.alloc(32, 7));
    secrets.resetSecretsCache();
    expect(secrets.getSecret('openai')).toBeNull();
    expect(secrets.secretStatus().openai).toEqual({ saved: true, verified: false, lostAtStartup: false });
    const after = secrets.checkSecrets();
    expect(after.openai).toEqual({ saved: false, verified: false, lostAtStartup: true });
  });

  it('trims pasted whitespace and warns about keys that look wrong, but still saves them', () => {
    expect(secrets.setSecret('anthropic', `  ${SAMPLE.anthropic}\n`).warning).toBeNull();
    expect(secrets.getSecret('anthropic')).toBe(SAMPLE.anthropic);
    expect(secrets.setSecret('anthropic', 'sk-proj-looks-like-openai').warning).toMatch(/start with "sk-ant-"/);
    expect(secrets.getSecret('anthropic')).toBe('sk-proj-looks-like-openai');
    expect(secrets.setSecret('openai', 'sk-ant-xyz').warning).toMatch(/looks like an Anthropic key/);
    expect(secrets.setSecret('elevenlabs', 'not-hex').warning).toMatch(/32 or more hexadecimal/);
    expect(secrets.setSecret('google', 'nope').warning).toMatch(/start with "AIza"/);
    expect(secrets.setSecret('azure', '{"key":"short","region":"uksouth"}').warning).toMatch(/32 or more letters/);
    expect(secrets.setSecret('azure', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6').warning).toBeNull();
    expect(secrets.getAzureCredentials()).toEqual({ key: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6', region: 'uksouth' });
    // a key wrapped over two lines by an email client is joined again
    expect(secrets.setSecret('openai', 'sk-proj-abc\ndef').warning).toBeNull();
    expect(secrets.getSecret('openai')).toBe('sk-proj-abcdef');
    // empty removes
    secrets.setSecret('openai', '   ');
    expect(secrets.hasSecret('openai')).toBe(false);
    expect(secrets.getSecret('openai')).toBeNull();
  });

  it('throws and keeps nothing when the written key cannot be read back', () => {
    secrets.setSecret('openai', SAMPLE.openai);
    const realRead = fs.readFileSync;
    // the verification read sees a file in which the fresh record was mangled on the way to disk
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      const out = realRead(p, o as never);
      if (String(p).endsWith('secrets.json')) {
        const j = JSON.parse(String(out)) as Record<string, { data: string }>;
        if (j.anthropic) j.anthropic.data = Buffer.from('tampered').toString('base64');
        return JSON.stringify(j);
      }
      return out;
    }) as never);
    expect(() => secrets.setSecret('anthropic', SAMPLE.anthropic)).toThrow(/could not be read back/);
    vi.restoreAllMocks();
    expect(secrets.hasSecret('anthropic')).toBe(false);
    expect(secrets.getSecret('openai')).toBe(SAMPLE.openai);
    secrets.resetSecretsCache();
    expect(secrets.hasSecret('anthropic')).toBe(false);
  });

  it('migrates old Keychain-format records when safeStorage still works', () => {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(secretsFile(), JSON.stringify({
      anthropic: { enc: true, data: Buffer.from(`keychain:${SAMPLE.anthropic}`).toString('base64') },
      elevenlabs: { enc: false, data: Buffer.from(SAMPLE.elevenlabs).toString('base64') },
    }));
    expect(secrets.getSecret('anthropic')).toBe(SAMPLE.anthropic);
    expect(secrets.getSecret('elevenlabs')).toBe(SAMPLE.elevenlabs);
    expect(ctx.decryptCalls).toBe(1);
    const parsed = JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) as Record<string, { v?: number; enc?: boolean }>;
    expect(parsed.anthropic.v).toBe(2); expect(parsed.anthropic.enc).toBeUndefined();
    expect(parsed.elevenlabs.v).toBe(2);
    const status = secrets.checkSecrets();
    expect(status.anthropic).toEqual({ saved: true, verified: true, lostAtStartup: false });
    expect(status.openai).toEqual({ saved: false, verified: false, lostAtStartup: false });
    // the next start no longer needs the Keychain at all
    ctx.safeWorks = false; secrets.resetSecretsCache();
    expect(secrets.getSecret('anthropic')).toBe(SAMPLE.anthropic);
  });

  it('drops unrecoverable Keychain records and reports them as lost until the key is pasted again', () => {
    ctx.safeWorks = false;
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(secretsFile(), JSON.stringify({
      anthropic: { enc: true, data: Buffer.from('keychain:gone').toString('base64') },
      openai: { enc: true, data: Buffer.from('keychain:gone').toString('base64') },
    }));
    const status = secrets.checkSecrets();
    expect(status.anthropic).toEqual({ saved: false, verified: false, lostAtStartup: true });
    expect(status.openai).toEqual({ saved: false, verified: false, lostAtStartup: true });
    expect(status.google.lostAtStartup).toBe(false);
    expect(secrets.getSecret('anthropic')).toBeNull();
    expect(JSON.parse(fs.readFileSync(secretsFile(), 'utf8'))).toEqual({});
    // pasting the key again clears the notice for that key only
    secrets.setSecret('anthropic', SAMPLE.anthropic);
    expect(secrets.secretStatus().anthropic).toEqual({ saved: true, verified: true, lostAtStartup: false });
    expect(secrets.secretStatus().openai.lostAtStartup).toBe(true);
    secrets.dismissLostKeys();
    expect(secrets.secretStatus().openai.lostAtStartup).toBe(false);
    // and the notice does not come back on the next start: the record is gone
    secrets.resetSecretsCache();
    expect(secrets.checkSecrets().openai).toEqual({ saved: false, verified: false, lostAtStartup: false });
  });
});
