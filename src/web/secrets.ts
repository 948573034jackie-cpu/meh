/**
 * API keys in the web build. Unlike the Mac app (AES-256-GCM in secrets.json under a key file in the app's
 * data folder, src/main/secrets.ts), the keys are kept as plain strings in this site's IndexedDB: a web page
 * has no place to hide an encryption key that its own scripts could not also read, so encrypting would add
 * nothing. They never leave the device except in the requests to the provider they belong to.
 * Anyone who can use this iPad profile (or script on this origin) can read them; see docs/IPAD.md.
 */
import { SECRET_NAMES, SECRET_LABELS, type SecretName, type SecretStatusMap } from '@shared/api';
import { KvDoc } from './idb';

const doc = new KvDoc<Partial<Record<SecretName, string>>>('secrets', () => ({}));
const DEFAULT_AZURE_REGION = 'uksouth';

export async function loadSecrets(): Promise<void> { await doc.load(); }

/** Removes surrounding whitespace; inside a plain key (not JSON) also line breaks (as src/main/secrets.ts). */
export function normalizeSecret(value: string): string {
  const t = (value ?? '').trim();
  if (t.startsWith('{')) return t;
  return t.replace(/\s+/g, '');
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

/** Same user-facing warnings as the Mac app. */
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
  return null;
}

export async function setSecret(name: SecretName, value: string): Promise<{ warning: string | null }> {
  if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret "${name}"`);
  const v = normalizeSecret(value);
  await doc.update((d) => {
    const next = { ...d };
    if (v) next[name] = v; else delete next[name];
    return next;
  });
  if (!v) return { warning: null };
  if ((await getSecret(name)) !== v) throw new Error(`The ${SECRET_LABELS[name]} key could not be saved in this browser's storage. Check that the site may store data (not a private window) and try again.`);
  return { warning: formatWarning(name, v) };
}

export async function getSecret(name: SecretName): Promise<string | null> { return (await doc.load())[name] ?? null; }
export async function hasSecret(name: SecretName): Promise<boolean> { return !!(await getSecret(name)); }

export async function getAzureCredentials(): Promise<{ key: string; region: string } | null> {
  const v = await getSecret('azure');
  return v ? parseAzure(v) : null;
}

export async function secretStatus(): Promise<SecretStatusMap> {
  const d = await doc.load();
  const out = {} as SecretStatusMap;
  for (const name of SECRET_NAMES) out[name] = { saved: !!d[name], verified: !!d[name], lostAtStartup: false };
  return out;
}
