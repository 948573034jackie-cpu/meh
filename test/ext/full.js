'use strict';
// FULL CHAIN: fake speech -> real app -> real screenshot -> real Chrome link -> real extension -> mock claude.ai tab.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLAUDE_HTML = `<!doctype html><title>Claude</title><body><div class="ProseMirror" contenteditable="true"></div>
<input type="file" accept="image/*" hidden><script>window.__attached=[];
document.addEventListener('change', async (e) => { if (e.target.type !== 'file') return;
  for (const f of e.target.files) { const bm = await createImageBitmap(f); window.__attached.push({type:f.type,size:f.size,w:bm.width,h:bm.height}); } });</script>`;

(async () => {
  const wav = path.join(os.tmpdir(), 'ce-full.wav');
  require('../e2e/make-wav')(wav);
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-chrome-')), {
    executablePath: require('./chrome-path'), headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${path.resolve('extension')}`, `--load-extension=${path.resolve('extension')}`],
  });
  await ctx.route('https://claude.ai/**', (r) => r.fulfill({ contentType: 'text/html', body: CLAUDE_HTML }));
  await ctx.route('https://reader.example/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>Reader</title><textarea id=t>hello</textarea>' }));
  const claude = await ctx.newPage(); await claude.goto('https://claude.ai/chat/x');
  const reader = await ctx.newPage(); await reader.goto('https://reader.example/'); await reader.bringToFront();

  const electron = require('electron');
  const app = spawn(electron, ['test/ext/app-harness.js', '--no-sandbox', '--disable-gpu'], { env: { ...process.env, MIC_WAV: wav }, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];
  app.stdout.on('data', (d) => String(d).split('\n').filter((l) => l.startsWith('APP ')).forEach((l) => { try { events.push(JSON.parse(l.slice(4))); } catch (_) {} }));

  let att = [];
  for (let i = 0; i < 100 && !att.length; i++) { await sleep(250); att = await claude.evaluate(() => window.__attached).catch(() => []); }
  const sent = events.find((e) => e.type === 'sent');
  check('the app heard speech and the picture arrived in the claude.ai tab by itself', att.length === 1, JSON.stringify(att));
  check('it is a real screenshot (JPEG, full screen size)', att[0] && att[0].type === 'image/jpeg' && att[0].w >= 1000 && att[0].h >= 600 && att[0].size > 5000, att[0] && `${att[0].w}x${att[0].h}, ${att[0].size} bytes`);
  check('the app reports "sent to Chrome"', sent && sent.route === 'chrome' && sent.ok, sent && JSON.stringify({ route: sent.route, where: sent.where, ms: sent.totalMs }));
  const chatActive = await ctx.serviceWorkers()[0].evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: ['https://claude.ai/*'] })).length > 0);
  check('the page you were reading stayed in front the whole time', !chatActive);
  console.log(`   total time speech-start -> picture in chat: capture ${sent && sent.captureMs}ms, all ${sent && sent.totalMs}ms`);

  app.kill('SIGKILL');
  await ctx.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(3); }, 100000).unref();
