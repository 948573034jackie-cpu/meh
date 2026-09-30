'use strict';
// Real Chromium + the real extension + the real bridge, against mock claude.ai / chatgpt.com pages.
// Proves the picture is attached in the BACKGROUND (the page you're reading stays in front).
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const { Bridge } = require('../../src/bridge');
const { EXT_ID } = require('../../src/ext-id');

const CHROME = require('./chrome-path');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- mock chat pages -------------------------------------------------------
const CLAUDE_HTML = `<!doctype html><title>Claude</title><body>
<form><div class="ProseMirror" contenteditable="true" data-testid="chat-input"></div>
<input type="file" accept="image/*,.pdf,.txt" hidden data-testid="file-upload"></form><div id="thumbs"></div>
<script>window.__attached=[];
// delegated listener at the document, like React does
document.addEventListener('change', async (e) => { if (e.target.type !== 'file') return;
  for (const f of e.target.files) { const buf = new Uint8Array(await f.arrayBuffer());
    const h = await crypto.subtle.digest('SHA-256', buf);
    window.__attached.push({name:f.name,type:f.type,size:f.size,sha:[...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('')}); } });
</script>`;
// ChatGPT-like: NO file input, only a message box that understands paste
const CHATGPT_HTML = `<!doctype html><title>ChatGPT</title><body>
<div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>
<script>window.__attached=[];
document.getElementById('prompt-textarea').addEventListener('paste', async (e) => { e.preventDefault();
  for (const f of e.clipboardData.files) { const buf = new Uint8Array(await f.arrayBuffer());
    const h = await crypto.subtle.digest('SHA-256', buf);
    window.__attached.push({name:f.name,type:f.type,size:f.size,sha:[...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('')}); } });
</script>`;
const READER_HTML = `<!doctype html><title>Reader</title><body><textarea id=t>reading this page</textarea>`;

(async () => {
  const bridge = new Bridge();
  await bridge.start();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-chrome-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: CHROME, headless: false,
    args: ['--no-sandbox', '--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${path.resolve('extension')}`, `--load-extension=${path.resolve('extension')}`],
  });
  const serve = (host, html) => ctx.route(`https://${host}/**`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await serve('claude.ai', CLAUDE_HTML); await serve('chatgpt.com', CHATGPT_HTML); await serve('reader.example', READER_HTML);

  for (let i = 0; i < 50 && !bridge.connected; i++) await sleep(200);
  check('extension connected to the app by itself', bridge.connected);

  // a screenshot-like JPEG made by the browser itself
  const shotPage = await ctx.newPage();
  await shotPage.setContent('<body style="margin:0;background:#f0f"><h1>SCREENSHOT</h1>');
  const jpg = await shotPage.screenshot({ type: 'jpeg', quality: 85 });
  await shotPage.close();
  const sha = crypto.createHash('sha256').update(jpg).digest('hex');
  const payload = { mime: 'image/jpeg', data: jpg.toString('base64'), name: 'screenshot.jpg' };

  const claude = await ctx.newPage(); await claude.goto('https://claude.ai/chat/1');
  const gpt = await ctx.newPage(); await gpt.goto('https://chatgpt.com/');
  const reader = await ctx.newPage(); await reader.goto('https://reader.example/');
  // ask Chrome itself which tab is the active one in the window
  const sw = () => ctx.serviceWorkers()[0];
  // the extension can only see chat tabs, so: "a chat tab is active" == the reader is NOT in front
  const chatIsActive = () => sw().evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: ['https://claude.ai/*', 'https://chatgpt.com/*'] })).length > 0);
  const vis = async (p) => { const chat = await chatIsActive(); return p === reader ? (chat ? 'hidden' : 'visible') : (chat ? 'visible' : 'hidden'); };

  // ---- 1. Claude tab used most recently -> picture goes to Claude, reader stays in front
  await claude.bringToFront(); await sleep(300); await reader.bringToFront(); await sleep(300);
  await reader.evaluate(() => { const t = document.getElementById('t'); t.focus(); t.setSelectionRange(2, 6); });
  let r = await bridge.send(payload);
  await sleep(500);
  const att = await claude.evaluate(() => window.__attached);
  check('picture attached in the claude.ai tab (file input)', r.ok && r.where === 'claude.ai' && r.method === 'file-input' && att.length === 1, JSON.stringify(r));
  check('...and it is exactly the picture that was sent (byte for byte)', att[0] && att[0].sha === sha && att[0].type === 'image/jpeg', att[0] && att[0].size + ' bytes');
  check('BACKGROUND: the page you read is still the one in front', (await vis(reader)) === 'visible' && (await vis(claude)) === 'hidden');
  const st = await reader.evaluate(() => { const t = document.getElementById('t'); return { f: document.hasFocus(), el: document.activeElement === t, s: t.selectionStart, e: t.selectionEnd }; });
  check('BACKGROUND: your cursor/selection on the page is untouched', st.f && st.el && st.s === 2 && st.e === 6, JSON.stringify(st));
  check('a small green note confirms it in the chat tab', await claude.evaluate(() => !!document.getElementById('claude-eyes-toast')));

  // ---- 2. ChatGPT tab used most recently -> picture goes to ChatGPT (no file input: paste route)
  await gpt.bringToFront(); await sleep(300); await reader.bringToFront(); await sleep(300);
  r = await bridge.send(payload);
  await sleep(500);
  const att2 = await gpt.evaluate(() => window.__attached);
  check('picture attached in the chatgpt.com tab (paste route)', r.ok && r.where === 'chatgpt.com' && r.method === 'paste' && att2.length === 1 && att2[0].sha === sha, JSON.stringify(r));
  check('BACKGROUND: still on the page you read', (await vis(reader)) === 'visible');

  // ---- 3. no chat tab open
  await claude.close(); await gpt.close(); await sleep(300);
  r = await bridge.send(payload);
  check('no claude/chatgpt tab open -> clear "no-tab" answer, nothing else touched', !r.ok && r.error === 'no-tab', JSON.stringify(r));

  // ---- 4. security: only the real extension may connect
  const tryConnect = (origin) => new Promise((res) => {
    const c = new WebSocket(`ws://127.0.0.1:${bridge.port}`, origin ? { origin } : {});
    c.on('open', () => { c.close(); res('accepted'); });
    c.on('error', () => res('refused'));
    c.on('unexpected-response', () => res('refused'));
  });
  check('a website cannot connect (Origin https://evil.example)', (await tryConnect('https://evil.example')) === 'refused');
  check('a program with no Origin cannot connect', (await tryConnect(null)) === 'refused');
  check('another Chrome extension cannot connect', (await tryConnect('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) === 'refused');

  // ---- 5. extension survives the app restarting (reconnects by itself)
  bridge.close(); await sleep(500);
  check('app closed -> bridge reports not connected', !bridge.connected);
  const bridge2 = new Bridge(); await bridge2.start();
  for (let i = 0; i < 60 && !bridge2.connected; i++) await sleep(250);
  check('app restarted -> extension reconnects on its own (<15s)', bridge2.connected);
  bridge2.close();

  await ctx.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(3); }, 120000).unref();
