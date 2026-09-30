// The mixer on the chat page: the call's microphone = your voice + sound the app feeds in (iPhone/iPad: its voice).
const pw = require(process.env.PWMOD || 'playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const mic = (() => { const rate = 16000, n = rate * 5, b = Buffer.alloc(44 + n * 2, 0); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return b; })();
const micPath = path.join(os.tmpdir(), 'ytc-mic-silent.wav'); fs.writeFileSync(micPath, mic);
let fails = 0; const ok = (n, c, x) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  ' + x : '')); };
(async () => {
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + micPath] });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.route('https://claude.ai/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>call</title>' }));
  await page.addInitScript({ path: path.resolve(__dirname, '../youtube-to-claude/mic-mix.js') }); // (like the app: before the page's code)
  await page.goto('https://claude.ai/new');
  await page.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ac = new AudioContext(); const an = ac.createAnalyser(); an.fftSize = 2048; ac.createMediaStreamSource(s).connect(an);
    window.__level = () => { const d = new Float32Array(2048); an.getFloatTimeDomainData(d); let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); return m; };
  });
  const level = async (ms) => { let m = 0; const end = Date.now() + ms; while (Date.now() < end) { m = Math.max(m, await page.evaluate(() => window.__level())); await page.waitForTimeout(100); } return +m.toFixed(3); };
  const before = await level(800);
  // what the app sends: 16-bit little-endian mono, base64, in several pieces (like the voice arriving bit by bit)
  await page.evaluate(() => {
    const rate = 22050;
    for (let piece = 0; piece < 4; piece++) {
      const n = rate / 4, bytes = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) { const v = Math.round(20000 * Math.sin(2 * Math.PI * 300 * (piece * n + i) / rate)); bytes[2 * i] = v & 255; bytes[2 * i + 1] = (v >> 8) & 255; }
      let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
      window.__ytcFeedPCM(btoa(bin), rate);
    }
  });
  const during = await level(900);
  await page.waitForTimeout(800);
  const after = await level(800);
  ok('the call microphone goes through the mixer', await page.evaluate(() => window.__ytcMixedCount === 1));
  ok('silence before', before < 0.02, String(before));
  ok('the call HEARS the sound the app reads into it', during > 0.3, String(during));
  ok('silence again after it ends', after < 0.02, String(after));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'MIXER: ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
