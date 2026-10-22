import { describe, it, expect, vi, beforeEach } from 'vitest';

const ctx = vi.hoisted(() => ({ keys: {} as Record<string, string | null> }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, safeStorage: { isEncryptionAvailable: () => false }, app: { getPath: () => '/tmp' } }));
vi.mock('../../src/main/kokoro/ipc', () => ({ kokoroSynthesize: vi.fn(), kokoroVoices: vi.fn(), registerKokoroIpc: vi.fn() }));
vi.mock('../../src/main/secrets', () => ({
  getSecret: (n: string) => ctx.keys[n] ?? null,
  getAzureCredentials: () => (ctx.keys.azure ? JSON.parse(ctx.keys.azure) : null),
}));
import { synthAzure, synthGoogle, buildAzureSsml, buildGoogleMarkedSsml, googleTimepointsToWords, buildGoogleRequest } from '../../src/main/tts';
import { ENGINE_LABELS, AVAILABLE_ENGINES, CHARS_PER_HOUR } from '@core/tts/engine';

beforeEach(() => { ctx.keys = {}; vi.unstubAllGlobals(); });

describe('Azure Speech REST', () => {
  it('posts SSML with the mp3 output format to the region endpoint and returns no timings', async () => {
    ctx.keys.azure = JSON.stringify({ key: 'k'.repeat(32), region: 'uksouth' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await synthAzure('Tom & Jerry <3', 'en-GB-RyanNeural', 1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://uksouth.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(init.method).toBe('POST');
    expect(init.headers['Ocp-Apim-Subscription-Key']).toBe('k'.repeat(32));
    expect(init.headers['Content-Type']).toBe('application/ssml+xml');
    expect(init.headers['X-Microsoft-OutputFormat']).toBe('audio-24khz-48kbitrate-mono-mp3');
    expect(init.body).toBe('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-GB"><voice name="en-GB-RyanNeural">Tom &amp; Jerry &lt;3</voice></speak>');
    expect(r.timings).toBeNull();
    expect(r.mime).toBe('audio/mpeg');
    expect(r.audio.byteLength).toBe(3);
  });
  it('adds prosody for a non-normal rate and explains a missing key or HTTP failure', async () => {
    expect(buildAzureSsml('Hi', 'en-US-AvaNeural', 1.5)).toContain('xml:lang="en-US"><voice name="en-US-AvaNeural"><prosody rate="+50%">Hi</prosody>');
    await expect(synthAzure('Hi', 'en-GB-SoniaNeural', 1)).rejects.toThrow(/Azure Speech key/);
    ctx.keys.azure = JSON.stringify({ key: 'x', region: 'westeurope' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 401 })));
    await expect(synthAzure('Hi', 'en-GB-SoniaNeural', 1)).rejects.toThrow(/HTTP 401.*region/);
  });
});

describe('Google Cloud Text-to-Speech REST', () => {
  it('marks every word in the SSML (escaped) and records its position', () => {
    const { ssml, words } = buildGoogleMarkedSsml('Hi, Mr & Mrs Smith!');
    expect(ssml).toBe('<speak><mark name="w0"/>Hi, <mark name="w1"/>Mr &amp; <mark name="w2"/>Mrs <mark name="w3"/>Smith!</speak>');
    expect(words).toEqual([{ charIndex: 0, charLength: 2 }, { charIndex: 4, charLength: 2 }, { charIndex: 9, charLength: 3 }, { charIndex: 13, charLength: 5 }]);
  });
  it('turns mark timepoints into word timings (end = next start)', () => {
    const { words } = buildGoogleMarkedSsml('one two three');
    const t = googleTimepointsToWords([{ markName: 'w0', timeSeconds: 0.05 }, { markName: 'w1', timeSeconds: 0.4 }, { markName: 'w2', timeSeconds: 0.8 }, { markName: 'other', timeSeconds: 9 }], words)!;
    expect(t.map((w) => [w.charIndex, w.charLength, w.start])).toEqual([[0, 3, 0.05], [4, 3, 0.4], [8, 5, 0.8]]);
    expect(t[0].end).toBe(0.4); expect(t[1].end).toBe(0.8); expect(t[2].end).toBeGreaterThan(0.8);
    expect(googleTimepointsToWords([], words)).toBeNull();
    expect(googleTimepointsToWords(undefined, words)).toBeNull();
  });
  it('posts to v1beta1 with SSML_MARK time pointing for Neural2 and returns aligned timings', async () => {
    ctx.keys.google = 'AIza-test';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ audioContent: Buffer.from('mp3!').toString('base64'), timepoints: [{ markName: 'w0', timeSeconds: 0.1 }, { markName: 'w1', timeSeconds: 0.5 }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await synthGoogle('Hello world', 'en-GB-Neural2-B', 1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=AIza-test');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ input: { ssml: '<speak><mark name="w0"/>Hello <mark name="w1"/>world</speak>' }, voice: { languageCode: 'en-GB', name: 'en-GB-Neural2-B' }, audioConfig: { audioEncoding: 'MP3' }, enableTimePointing: ['SSML_MARK'] });
    expect(Buffer.from(r.audio).toString()).toBe('mp3!');
    expect(r.timings).toEqual([{ start: 0.1, end: 0.5, charIndex: 0, charLength: 5 }, { start: 0.5, end: expect.any(Number), charIndex: 6, charLength: 5 }]);
  });
  it('sends plain text without marks to Chirp 3 HD voices (timing is then estimated)', async () => {
    const { body, words } = buildGoogleRequest('Hello world', 'en-GB-Chirp3-HD-Aoede', 1.25);
    expect(body).toEqual({ input: { text: 'Hello world' }, voice: { languageCode: 'en-GB', name: 'en-GB-Chirp3-HD-Aoede' }, audioConfig: { audioEncoding: 'MP3', speakingRate: 1.25 } });
    expect(words).toBeNull();
    ctx.keys.google = 'AIza-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ audioContent: 'AAAA' }), { status: 200 })));
    expect((await synthGoogle('Hello world', 'en-GB-Chirp3-HD-Aoede', 1)).timings).toBeNull();
  });
  it('reports Google errors and a missing key', async () => {
    await expect(synthGoogle('Hi', 'en-GB-Neural2-A', 1)).rejects.toThrow(/Google Cloud API key/);
    ctx.keys.google = 'AIza-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'API key not valid.' } }), { status: 400 })));
    await expect(synthGoogle('Hi', 'en-GB-Neural2-A', 1)).rejects.toThrow('Google Text-to-Speech: HTTP 400 API key not valid.');
  });
});

describe('engine labels', () => {
  it('offers azure and google with a price per hour', () => {
    expect(AVAILABLE_ENGINES).toEqual(expect.arrayContaining(['azure', 'google']));
    expect(CHARS_PER_HOUR).toBe(54_000);
    expect(ENGINE_LABELS.azure.perHour).toBe('≈ $0.81/h');
    expect(ENGINE_LABELS.google.perHour).toBe('≈ $0.86–1.62/h');
    expect(ENGINE_LABELS.edge.perHour).toBe('free');
    expect(ENGINE_LABELS.kokoro.perHour).toBe('free');
    for (const id of AVAILABLE_ENGINES) expect(ENGINE_LABELS[id].perHour).toMatch(/^(free|≈ \$[\d.–]+\/h)$/);
  });
});
