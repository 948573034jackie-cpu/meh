import { describe, it, expect, vi, beforeEach } from 'vitest';

const ctx = vi.hoisted(() => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  return { userData: fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-aitest-')), keys: {} as Record<string, string | null> };
});
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: class {}, app: { getPath: () => ctx.userData }, safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock('../../src/main/secrets', async (orig) => {
  const real = await orig<typeof import('../../src/main/secrets')>();
  return { ...real, getSecret: (n: string) => ctx.keys[n] ?? null, hasSecret: (n: string) => n in ctx.keys, getAzureCredentials: () => (ctx.keys.azure ? JSON.parse(ctx.keys.azure) : null) };
});
import { testProvider } from '../../src/main/ai';

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(() => { ctx.keys = {}; vi.unstubAllGlobals(); });

describe('testProvider messages', () => {
  it('says when no key is saved', async () => {
    expect(await testProvider('elevenlabs')).toEqual({ ok: false, message: 'No ElevenLabs API key is saved yet. Paste it in Settings and click Save.' });
    expect((await testProvider('anthropic')).message).toMatch(/No Anthropic API key is saved yet/);
  });

  it('ElevenLabs: connected, rejected, out of characters, offline, timeout, overloaded', async () => {
    ctx.keys.elevenlabs = 'sk_0123456789abcdef0123456789abcdef';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(respond(200, { subscription: { tier: 'starter', character_count: 1200, character_limit: 30000 } }));
    expect(await testProvider('elevenlabs')).toEqual({ ok: true, message: 'Connected to ElevenLabs (starter plan, 1,200 of 30,000 characters used this month).' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.elevenlabs.io/v1/user');
    expect(fetchMock.mock.calls[0][1].headers['xi-api-key']).toBe(ctx.keys.elevenlabs);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    fetchMock.mockResolvedValueOnce(respond(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }));
    const rejected = await testProvider('elevenlabs');
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toBe('ElevenLabs rejected the key (HTTP 401). Check it and paste it again.');
    expect(rejected.detail).toMatch(/HTTP 401/);

    fetchMock.mockResolvedValueOnce(respond(200, { subscription: { tier: 'free', character_count: 10000, character_limit: 10000 } }));
    expect((await testProvider('elevenlabs')).message).toMatch(/monthly character allowance is used up \(10,000 of 10,000\)/);

    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    expect((await testProvider('elevenlabs')).message).toBe('No internet connection, or the AI service is unreachable.');

    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect((await testProvider('elevenlabs')).message).toBe('The service did not answer in time. Check your internet connection and try again.');

    fetchMock.mockResolvedValueOnce(respond(503, 'Service Unavailable'));
    expect((await testProvider('elevenlabs')).message).toBe('ElevenLabs is overloaded or down for maintenance right now; try again in a moment.');

    fetchMock.mockResolvedValueOnce(respond(418, 'teapot'));
    const unknown = await testProvider('elevenlabs');
    expect(unknown.message).toBe('Unexpected reply from ElevenLabs (HTTP 418): teapot');
  });

  it('flags a key that looks wrong when the service rejects it', async () => {
    ctx.keys.elevenlabs = 'sk-ant-this-is-not-elevenlabs';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(respond(401, { detail: 'nope' })));
    const r = await testProvider('elevenlabs');
    expect(r.ok).toBe(false);
    expect(r.message).toBe('The key looks wrong: This does not look like an ElevenLabs key: they are 32 or more hexadecimal characters (newer ones start with "sk_"). Check that you pasted the whole key.');
  });

  it('Azure: connected, wrong key or region, out of quota, bad region', async () => {
    ctx.keys.azure = JSON.stringify({ key: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6', region: 'uksouth' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(respond(200, 'eyJ.token'));
    expect(await testProvider('azure')).toEqual({ ok: true, message: 'Connected to Azure Speech in region "uksouth".' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://uksouth.api.cognitive.microsoft.com/sts/v1.0/issueToken');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][1].headers['Ocp-Apim-Subscription-Key']).toBe('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6');

    fetchMock.mockResolvedValueOnce(respond(401, 'Access denied due to invalid subscription key or wrong API endpoint.'));
    expect((await testProvider('azure')).message).toBe('Azure rejected the key (HTTP 401). Check the key, and that the region "uksouth" matches your Speech resource.');

    fetchMock.mockResolvedValueOnce(respond(403, 'Out of call volume quota.'));
    expect((await testProvider('azure')).message).toBe('Azure says this key is out of quota or the resource is disabled (HTTP 403). Check the Speech resource in the Azure portal.');

    ctx.keys.azure = JSON.stringify({ key: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6', region: 'nowhere' });
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', hostname: 'nowhere.api.cognitive.microsoft.com' } }));
    expect((await testProvider('azure')).message).toBe('Azure region "nowhere" does not exist. Check the region of your Speech resource (for example "uksouth").');
  });

  it('Google: connected, invalid key, API not enabled, restricted key, quota', async () => {
    ctx.keys.google = 'AIzaSyA-0123456789abcdefghijklmnopqrstu';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(respond(200, { voices: [{ name: 'en-GB-Neural2-A' }, { name: 'en-GB-Neural2-B' }] }));
    expect(await testProvider('google')).toEqual({ ok: true, message: 'Connected to Google Cloud Text-to-Speech (2 British English voices available).' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://texttospeech.googleapis.com/v1/voices?key=AIzaSyA-0123456789abcdefghijklmnopqrstu&languageCode=en-GB');

    fetchMock.mockResolvedValueOnce(respond(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }));
    expect((await testProvider('google')).message).toBe('Google rejected the key (API key not valid). Check it and paste it again.');

    fetchMock.mockResolvedValueOnce(respond(403, { error: { code: 403, message: 'Cloud Text-to-Speech API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }));
    expect((await testProvider('google')).message).toMatch(/Text-to-Speech API is not enabled for this key's project/);

    fetchMock.mockResolvedValueOnce(respond(403, { error: { code: 403, message: 'Requests to this API texttospeech.googleapis.com method google.cloud.texttospeech.v1.TextToSpeech.ListVoices are blocked.', status: 'PERMISSION_DENIED', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } }));
    expect((await testProvider('google')).message).toMatch(/may not call the Text-to-Speech API \(permission denied\)/);

    fetchMock.mockResolvedValueOnce(respond(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }));
    expect((await testProvider('google')).message).toMatch(/quota for this project is used up/);
  });

  it('LLM providers: rejected key, no credit, unavailable model, overloaded', async () => {
    ctx.keys.anthropic = 'sk-ant-api03-test';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const anthropicErr = (status: number, type: string, message: string) => respond(status, { type: 'error', error: { type, message } }, { 'request-id': 'r' });
    fetchMock.mockResolvedValueOnce(anthropicErr(401, 'authentication_error', 'invalid x-api-key'));
    expect((await testProvider('anthropic')).message).toBe('The API key was rejected. Check it in Settings.');
    fetchMock.mockResolvedValueOnce(anthropicErr(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'));
    expect((await testProvider('anthropic')).message).toBe('Your API account has no credit left or reached its spending limit.');
    fetchMock.mockResolvedValueOnce(anthropicErr(404, 'not_found_error', 'model: claude-opus-5-5'));
    expect((await testProvider('anthropic')).message).toBe('Model claude-opus-5-5 is not available for your key; pick another model.');
    fetchMock.mockResolvedValueOnce(anthropicErr(529, 'overloaded_error', 'Overloaded'));
    expect((await testProvider('anthropic')).message).toBe('The AI service is overloaded right now; try again in a moment.');
    fetchMock.mockResolvedValueOnce(respond(200, { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
    expect(await testProvider('anthropic')).toEqual({ ok: true, message: 'Connected. claude-opus-5-5 replied: OK' });

    ctx.keys.openai = 'sk-proj-test';
    fetchMock.mockResolvedValueOnce(respond(404, { error: { message: "The model 'gpt-5.4-mini' does not exist or you do not have access to it.", type: 'invalid_request_error', code: 'model_not_found' } }));
    expect((await testProvider('openai')).message).toBe('Model gpt-5.4-mini is not available for your key; pick another model.');
    fetchMock.mockResolvedValueOnce(respond(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota' } }));
    expect((await testProvider('openai')).message).toBe('Your API account has no credit left or reached its spending limit.');
  });
});
