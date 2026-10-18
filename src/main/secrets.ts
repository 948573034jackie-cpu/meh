import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, writeAtomic } from './storage';

type SecretName = 'anthropic' | 'openai' | 'elevenlabs';

/**
 * API keys are encrypted with Electron's safeStorage (macOS Keychain-backed) and stored as base64 in
 * secrets.json. When encryption is unavailable (some Linux CI boxes) the value is stored obfuscated
 * only, and getDiagnostics() reports it so the user knows.
 */
function file(): string { return path.join(dataDir(), 'secrets.json'); }

function readAll(): Record<string, { enc: boolean; data: string }> {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; }
}

export function encryptionAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

export function setSecret(name: SecretName, value: string): void {
  const all = readAll();
  if (!value) { delete all[name]; writeAtomic(file(), JSON.stringify(all)); return; }
  if (encryptionAvailable()) {
    all[name] = { enc: true, data: safeStorage.encryptString(value).toString('base64') };
  } else {
    all[name] = { enc: false, data: Buffer.from(value, 'utf8').toString('base64') };
  }
  writeAtomic(file(), JSON.stringify(all));
}

export function getSecret(name: SecretName): string | null {
  const rec = readAll()[name];
  if (!rec) return null;
  try {
    if (rec.enc) return safeStorage.decryptString(Buffer.from(rec.data, 'base64'));
    return Buffer.from(rec.data, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function hasSecret(name: SecretName): boolean { return !!readAll()[name]; }
export function secretStatus(): Record<string, boolean> {
  const all = readAll();
  return { anthropic: !!all.anthropic, openai: !!all.openai, elevenlabs: !!all.elevenlabs };
}
