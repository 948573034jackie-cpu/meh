'use strict';
// Runs the "attach the picture to the chat" script (shared with the Chrome extension) in a real browser
// engine against the same mock chat pages the iPad app's self-test uses.
//   ENGINE=webkit   -> Safari's engine (what the iPad/iPhone app uses)   [default]
//   ENGINE=chromium -> Chrome's engine
const path = require('path');
const fs = require('fs');
const { chromium, webkit } = require('playwright-core');

const ENGINE = process.env.ENGINE || 'webkit';
const RES = path.join(__dirname, '..', 'ClaudeEyes', 'Resources');
const ATTACH = path.join(RES, 'attach.js');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  [${ENGINE}] ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
  const browser = ENGINE === 'chromium'
    ? await chromium.launch({ executablePath: require('../../test/ext/chrome-path'), args: ['--no-sandbox'] })
    : await webkit.launch();
  const context = await browser.newContext();

  // a screenshot-like JPEG made inside the page (magenta, 1200 x 800)
  const makeJpeg = (page) => page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 800;
    const x = c.getContext('2d'); x.fillStyle = '#ff00ff'; x.fillRect(0, 0, 1200, 800);
    x.fillStyle = '#fff'; x.font = '60px sans-serif'; x.fillText('TEST', 40, 100);
    return c.toDataURL('image/jpeg', 0.8).split(',')[1];
  });

  // ---- a chat page with a hidden "attach a file" input ----
  let page = await context.newPage();
  await page.goto('file://' + path.join(RES, 'selftest-chat.html'));
  const caps = await page.evaluate(() => ({
    DataTransfer: typeof DataTransfer, File: typeof File, createImageBitmap: typeof createImageBitmap,
    filesSetter: (() => { try { const i = document.createElement('input'); i.type = 'file'; const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.txt')); i.files = dt.files; return i.files.length === 1; } catch (e) { return 'error: ' + e.message; } })(),
  }));
  check('the browser engine supports what the script needs (File, DataTransfer, input.files = ...)', caps.DataTransfer === 'function' && caps.File === 'function' && caps.filesSetter === true, JSON.stringify(caps));

  await page.addScriptTag({ path: ATTACH });
  const b64 = await makeJpeg(page);
  // exactly how the app calls it: the function text + (b64, mime, name)
  const r = await page.evaluate(([b, m, n]) => claudeEyesAttach(b, m, n), [b64, 'image/jpeg', 'screenshot.jpg']);
  check('picture goes into the chat through its file input', r.ok === true && r.method === 'file-input', JSON.stringify(r));
  for (let i = 0; i < 40 && !(await page.evaluate(() => window.__attached.length)); i++) await page.waitForTimeout(100);
  const got = await page.evaluate(() => window.__attached);
  check('the chat received exactly one picture', got.length === 1, `count=${got.length}`);
  check('it is a JPEG, full size', got[0] && got[0].type === 'image/jpeg' && got[0].w === 1200 && got[0].h === 800, JSON.stringify(got[0]));
  check('it shows the magenta page (colour survived)', got[0] && got[0].r > 200 && got[0].g < 60 && got[0].b > 200, got[0] && `rgb=${got[0].r},${got[0].g},${got[0].b}`);
  check('a confirmation note appears on the chat page', await page.evaluate(() => !!document.getElementById('claude-eyes-toast')));

  // the picture can be large: ~1 MB of base64 still works
  const big = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1000; const x = c.getContext('2d'); for (let i = 0; i < 4000; i++) { x.fillStyle = `rgb(${i % 255},${(i * 7) % 255},${(i * 13) % 255})`; x.fillRect((i * 37) % 1600, (i * 91) % 1000, 40, 40); } return c.toDataURL('image/jpeg', 0.95).split(',')[1]; });
  const r2 = await page.evaluate(([b]) => claudeEyesAttach(b, 'image/jpeg', 'screenshot.jpg'), [big]);
  for (let i = 0; i < 40 && (await page.evaluate(() => window.__attached.length)) < 2; i++) await page.waitForTimeout(100);
  check(`a large picture (${Math.round(big.length / 1024)} KB of base64) also works`, r2.ok === true && (await page.evaluate(() => window.__attached.length)) === 2);

  // ---- a page without a message box (for example a sign-in page) ----
  page = await context.newPage();
  await page.goto('file://' + path.join(RES, 'selftest-chat-nobox.html'));
  await page.addScriptTag({ path: ATTACH });
  const r3 = await page.evaluate(([b]) => claudeEyesAttach(b, 'image/jpeg', 'screenshot.jpg'), [b64]);
  check('no message box -> honest "no-message-box" answer, nothing attached', r3.ok === false && r3.error === 'no-message-box' && (await page.evaluate(() => window.__attached.length)) === 0, JSON.stringify(r3));

  // ---- garbage input never crashes the page ----
  const r4 = await page.evaluate(() => claudeEyesAttach('***not base64***', 'image/jpeg', 'x.jpg'));
  check('broken data -> a clear error, not an exception', r4.ok === false && typeof r4.error === 'string', JSON.stringify(r4));

  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n[${ENGINE}] ${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
