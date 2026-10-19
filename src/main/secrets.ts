import { safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SECRET_NAMES, SECRET_LABELS, type SecretName, type SecretStatus, type SecretStatusMap } from '@shared/api';
import { dataDir, writeAtomic } from './storage';

export type { SecretName, SecretStatus, SecretStatusMap };

/**
 * API keys are encrypted with AES-256-GCM under a random key that lives next to them in the app's own
 * data folder (`<userData>/data/secret.key`, mode 0600). This deliberately does not use Electron's
 * safeStorage: that ties the Keychain item to the app's code signature, and this app is unsigned and
 * re-signed ad hoc, so every re-sign or update made the saved keys unreadable ("the app forgets my key").
 *
 * File layout (secrets.json): { [name]: { v: 2, iv, tag, data } } with base64 fields.
 * Records in the pre-v2 format ({ enc: true|false, data }) are migrated on first load: those that still
 * decrypt with safeStorage are re-encrypted, the others are dropped and reported through
 * secretStatus().lostAtStartup so the UI can ask for the key again, once.
 *
 * The azure secret is a JSON string {"key": "...", "region": "..."}; a plain key string is tolerated
 * and then the region defaults to DEFAULT_AZURE_REGION. See getAzureCredentials().
 */

interface RecordV2 { v: 2; iv: string; tag: string; data: string }
interface RecordV1 { enc: boolean; data: string }
type AnyRecord = RecordV2 | RecordV1;

interface State {
  records: Partial<Record<SecretName, RecordV2>>;
  lost: Set<SecretName>;
  /** cached contents of secret.key */
  key: Buffer | null;
}

const DEFAULT_AZURE_REGION = 'uksouth';
const KEY_BYTES = 32;

let state: State | null = null;

export function secretsFilePath(): string { return path.join(dataDir(), 'secrets.json'); }
export function keyFilePath(): string { return path.join(dataDir(), 'secret.key'); }

/** Forgets the in-memory cache so the next call re-reads the files (tests, or after userData changes). */
export function resetSecretsCache(): void { state = null; }

function isV2(rec: AnyRecord | undefined): rec is RecordV2 {
  return !!rec && (rec as RecordV2).v === 2 && typeof (rec as RecordV2).iv === 'string' && typeof (rec as RecordV2).tag === 'string' && typeof (rec as RecordV2).data === 'string';
}

function readRawFile(): Partial<Record<string, AnyRecord>> {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretsFilePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/** Loads (or creates) the 32-byte master key. The file is created with mode 0600 and the mode is re-asserted on every load. */
function loadKey(st: State): Buffer {
  if (st.key) return st.key;
  const file = keyFilePath();
  let key: Buffer | null = null;
  try {
    const existing = fs.readFileSync(file);
    if (existing.length === KEY_BYTES) key = existing;
    else console.error(`secrets: ${file} has an unexpected size (${existing.length} bytes); a new key will be generated and stored keys will not decrypt`);
  } catch { /* no key yet */ }
  if (!key) {
    key = crypto.randomBytes(KEY_BYTES);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, key, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  try { if (process.platform !== 'win32') fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  st.key = key;
  return key;
}

function encrypt(st: State, plain: string): RecordV2 {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(st), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { v: 2, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(st: State, rec: RecordV2): string | null {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(st), Buffer.from(rec.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(rec.data, 'base64')), decipher.final()]).toString('utf8');
  } catch { return null; }
}

function persist(st: State): void {
  writeAtomic(secretsFilePath(), JSON.stringify(st.records, null, 1));
}

/** Reads secrets.json once, migrating pre-v2 records. Never logs or returns key values. */
function load(): State {
  if (state) return state;
  const st: State = { records: {}, lost: new Set(), key: null };
  const raw = readRawFile();
  let changed = false;
  for (const name of SECRET_NAMES) {
    const rec = raw[name];
    if (!rec) continue;
    if (isV2(rec)) { st.records[name] = rec; continue; }
    changed = true;
    const old = rec as RecordV1;
    let plain: string | null = null;
    try {
      plain = old.enc ? safeStorage.decryptString(Buffer.from(old.data, 'base64')) : Buffer.from(old.data, 'base64').toString('utf8');
    } catch { plain = null; }
    if (plain) {
      st.records[name] = encrypt(st, plain);
      console.log(`secrets: migrated the ${name} key from the Keychain format`);
    } else {
      st.lost.add(name);
      console.error(`secrets: the ${name} key could not be read from the Keychain (app re-signed?); it was dropped and must be pasted again`);
    }
  }
  state = st;
  if (changed) persist(st);
  return st;
}

/**
 * Decrypts every stored key, drops the unreadable ones (reported as lostAtStartup) and logs a one-line summary.
 * Called once after app ready; safe to call again.
 */
export function checkSecrets(): SecretStatusMap {
  const st = load();
  let changed = false;
  const parts: string[] = [];
  for (const name of SECRET_NAMES) {
    const rec = st.records[name];
    if (!rec) { parts.push(`${name}=${st.lost.has(name) ? 'lost' : 'none'}`); continue; }
    if (decrypt(st, rec) === null) {
      delete st.records[name];
      st.lost.add(name);
      changed = true;
      parts.push(`${name}=lost`);
    } else parts.push(`${name}=ok`);
  }
  if (changed) persist(st);
  console.log(`secrets: ${parts.join(' ')} (${secretsFilePath()})`);
  return secretStatus();
}

/** Removes leading/trailing whitespace; inside a plain key (not JSON) also removes line breaks a PDF or email wrap may have added. */
export function normalizeSecret(value: string): string {
  const t = (value ?? '').trim();
  if (t.startsWith('{')) return t;
  return t.replace(/\s+/g, '');
}

/** A short, user-facing warning when a key does not look like what the service issues; null when it looks fine. */
export function formatWarning(name: SecretName, value: string): string | null {
  const v = normalizeSecret(value);
  switch (name) {
    case 'anthropic':
      return v.startsWith('sk-ant-') ? null : 'This does not look like an Anthropic key: they start with "sk-ant-". It was saved anyway; use Test to check it.';
    case 'openai':
      if (v.startsWith('sk-ant-')) return 'This looks like an Anthropic key, not an OpenAI key. It was saved anyway; use Test to check it.';
      return v.startsWith('sk-') ? null : 'This does not look like an OpenAI key: they start with "sk-". It was saved anyway; use Test to check it.';
    case 'elevenlabs':
      return /^(sk_)?[0-9a-f]{32,}$/i.test(v) ? null : 'This does not look like an ElevenLabs key: they are 32 or more hexadecimal characters (newer ones start with "sk_"). It was saved anyway; use Test to check it.';
    case 'azure': {
      const creds = parseAzure(v);
      if (!creds) return 'The Azure entry could not be read. Paste the key, or a JSON object {"key": "...", "region": "uksouth"}. It was saved anyway; use Test to check it.';
      if (!/^[A-Za-z0-9]{32,}$/.test(creds.key)) return 'This does not look like an Azure Speech key: they are 32 or more letters and digits. It was saved anyway; use Test to check it.';
      if (!/^[a-z0-9]+$/.test(creds.region)) return `"${creds.region}" does not look like an Azure region (for example "uksouth" or "westeurope"). It was saved anyway; use Test to check it.`;
      return null;
    }
    case 'google':
      return /^AIza[0-9A-Za-z_-]{35}$/.test(v) ? null : 'This does not look like a Google Cloud API key: they start with "AIza" and are 39 characters long. It was saved anyway; use Test to check it.';
  }
}

function parseAzure(value: string): { key: string; region: string } | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith('{')) {
    try {
      const o = JSON.parse(v) as { key?: unknown; region?: unknown };
      const key = typeof o.key === 'string' ? o.key.trim() : '';
      const region = typeof o.region === 'string' && o.region.trim() ? o.region.trim().toLowerCase() : DEFAULT_AZURE_REGION;
      return key ? { key, region } : null;
    } catch { return null; }
  }
  return { key: v, region: DEFAULT_AZURE_REGION };
}

/** The Azure Speech key and region, or null when no Azure secret is saved. */
export function getAzureCredentials(): { key: string; region: string } | null {
  const v = getSecret('azure');
  return v ? parseAzure(v) : null;
}

/**
 * Saves a key (an empty value removes it). The value is written, read back from disk and decrypted; a
 * mismatch throws so the UI never shows "saved" for a key that would be forgotten. Resolves with a
 * warning string when the key does not look like what the service issues (it is still saved).
 */
export function setSecret(name: SecretName, value: string): { warning: string | null } {
  if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret "${name}"`);
  const st = load();
  const v = normalizeSecret(value);
  if (!v) {
    delete st.records[name];
    st.lost.delete(name);
    persist(st);
    return { warning: null };
  }
  const rec = encrypt(st, v);
  st.records[name] = rec;
  persist(st);
  // verify: fresh read from disk, decrypt, compare
  const onDisk = readRawFile()[name];
  const back = isV2(onDisk) ? decrypt(st, onDisk) : null;
  if (back !== v) {
    delete st.records[name];
    try { persist(st); } catch { /* the folder is probably unwritable; nothing more to do */ }
    throw new Error(`The ${SECRET_LABELS[name]} key was written but could not be read back from ${secretsFilePath()}. Check that the folder is writable and not synced or locked by another program, then try again.`);
  }
  st.lost.delete(name);
  return { warning: formatWarning(name, v) };
}

export function getSecret(name: SecretName): string | null {
  const st = load();
  const rec = st.records[name];
  return rec ? decrypt(st, rec) : null;
}

export function hasSecret(name: SecretName): boolean { return !!load().records[name]; }

export function secretStatus(): SecretStatusMap {
  const st = load();
  const out = {} as SecretStatusMap;
  for (const name of SECRET_NAMES) {
    const rec = st.records[name];
    out[name] = { saved: !!rec, verified: !!rec && decrypt(st, rec) !== null, lostAtStartup: st.lost.has(name) };
  }
  return out;
}

/** The user has seen the "could not be recovered" notices; stop reporting them for this session. */
export function dismissLostKeys(): void { load().lost.clear(); }
