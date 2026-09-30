'use strict';
// End-to-end test: real Electron app, real hidden microphone page, real screen capture.
// The microphone is a fake device that plays test/e2e/out/mic.wav on a loop.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, clipboard } = require('electron');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const WAV = path.join(OUT, 'mic.wav');
require('./make-wav')(WAV);

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', WAV);

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
// The test creates many app instances in one process; Electron sometimes idles instead of
// exiting after app.exit(). Record the verdict, then make sure the process really ends.
function finish(code) {
  try { fs.writeFileSync(path.join(OUT, 'result'), String(code)); } catch (_) {}
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 2000).unref();
  app.exit(code);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(intervalSec, extra = {}) {
  const events = [];
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-e2e-')), 's.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ intervalSec, paste: true }));
  const t0 = Date.now();
  const pasteCalls = [];
  const handle = require('../../src/app').start({
    settingsFile, notify: false, manageLoginItem: false, allowMultiple: true, bridge: false,
    paste: async (a) => { pasteCalls.push(a); return { ok: true }; },
    ...extra,
    onEvent: (e) => { if (e.type !== 'level') events.push({ ...e, at: Date.now() - t0 }); else events.levelCount = (events.levelCount || 0) + 1; },
  });
  return { events, handle, pasteCalls, t0 };
}


// ---------------------------------------------------------------------------
// Focus: after the screenshot is pasted into "Claude", the user must land back
// on the SAME window, with their caret/text untouched, and quickly.
// Uses the real paste script (xdotool) with two real windows + a window manager.
// ---------------------------------------------------------------------------
async function focusScenarios() {
  const { execFileSync, execFile } = require('child_process');
  const { pasteIntoApp } = require('../../src/deliver');
  console.log('\n# Focus: back on the page you were reading');
  let haveXdotool = true;
  try { execFileSync('xdotool', ['getactivewindow'], { stdio: 'ignore' }); } catch (_) {
    try { execFileSync('xdotool', ['--version'], { stdio: 'ignore' }); } catch (e) { haveXdotool = false; }
  }
  if (!haveXdotool) { check('xdotool available for the focus test', false, 'install xdotool + openbox'); return; }

  const html = (title, extra) => 'data:text/html,' + encodeURIComponent(
    `<title>${title}</title><body style="margin:20px;background:#fff"><textarea id=t rows=6 cols=50 autofocus>${title} text</textarea>` +
    `<script>window.__pasted=0;document.addEventListener('paste',e=>{const it=[...e.clipboardData.items].some(i=>i.type.startsWith('image/'));if(it)window.__pasted++});${extra || ''}</script>`);
  const mk = async (title, x) => {
    const w = new BrowserWindow({ x, y: 100, width: 500, height: 300, title, show: true, webPreferences: { backgroundThrottling: false } });
    await w.loadURL(html(title));
    return w;
  };
  const reader = await mk('Reader', 20);
  const claude = await mk('Claude', 560);
  const id = (w) => w.getNativeWindowHandle().readUInt32LE(0);
  const active = () => Number(execFileSync('xdotool', ['getactivewindow']).toString().trim());
  const activate = async (w) => { execFileSync('xdotool', ['windowactivate', String(id(w))]); await sleep(400); };
  const js = (w, code) => w.webContents.executeJavaScript(code);
  const pastedCount = (w) => js(w, 'window.__pasted');

  // caret in the middle of the reader's text, so we can prove it is untouched
  await activate(reader);
  await js(reader, `(()=>{const t=document.getElementById('t');t.focus();t.setSelectionRange(3,7);})()`);

  const handleBox = launch(60, { paste: (a) => pasteIntoApp(a) });
  handleBox.handle.setEnabled(false);
  await sleep(500);
  const send = async () => {
    const before = handleBox.events.length;
    await handleBox.handle.sendScreenshot('test');
    return handleBox.events.slice(before).find((e) => e.type === 'sent' || e.type === 'error');
  };

  // 1. reader active -> paste lands in Claude -> reader active again, caret untouched
  check('setup: Reader window is in front', active() === id(reader));
  let ev = await send();
  await sleep(300);
  check('picture was pasted into the Claude window', (await pastedCount(claude)) === 1 && ev && ev.pasted && ev.pasted.ok, JSON.stringify(ev && ev.pasted));
  check('nothing was pasted into the page being read', (await pastedCount(reader)) === 0);
  check('back on the SAME window you were reading', active() === id(reader));
  const st = await js(reader, `(()=>{const t=document.getElementById('t');return {focus:document.hasFocus(),el:document.activeElement===t,s:t.selectionStart,e:t.selectionEnd,v:t.value}})()`);
  check('your text box still has focus, caret and text exactly as before', st.focus && st.el && st.s === 3 && st.e === 7 && st.v === 'Reader text', JSON.stringify(st));
  check('away from your page less than 1 second', ev.pasted.awayMs < 1000 && ev.pasted.focusRestored === true, `${ev.pasted.awayMs}ms`);
  console.log(`   away time: ${ev.pasted.awayMs}ms`);

  // 2. Claude already in front -> no switching at all
  await activate(claude);
  ev = await send();
  await sleep(300);
  check('Claude already in front: pasted without any switching', ev.pasted.ok && ev.pasted.awayMs === 0 && (await pastedCount(claude)) === 2 && active() === id(claude));

  // 3. Claude not open -> nothing touched
  claude.hide();
  await sleep(300);
  await activate(reader);
  ev = await send();
  await sleep(300);
  check('Claude app not open: reports it, does not touch your page', ev.pasted.reason === 'not-running' && active() === id(reader) && (await pastedCount(reader)) === 0);
  claude.show();
  await sleep(300);

  // 4. Claude is too slow to come forward -> must NOT paste into the page you are reading
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-shim-'));
  const real = execFileSync('which', ['xdotool']).toString().trim();
  fs.writeFileSync(path.join(shim, 'xdotool'), `#!/bin/sh\nif [ "$1" = windowactivate ] && [ "$2" = "${id(claude)}" ]; then exit 0; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
  const slowRun = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { env: { ...process.env, PATH: `${shim}:${process.env.PATH}` }, timeout: 8000 },
    (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })));
  await activate(reader);
  const beforeC = await pastedCount(claude);
  const res = await pasteIntoApp({ appName: 'Claude', run: slowRun });
  await sleep(300);
  check('Claude never came forward: nothing pasted anywhere (page you read is safe)', res.reason === 'wrong-window' && (await pastedCount(reader)) === 0 && (await pastedCount(claude)) === beforeC, JSON.stringify(res));
  check('...and you are still on your page', active() === id(reader));

  // 5. Several rounds in a row stay stable
  const away = [];
  for (let i = 0; i < 5; i++) {
    await activate(reader);
    const e = await send();
    await sleep(200);
    away.push(e.pasted.awayMs);
    if (active() !== id(reader) || !e.pasted.ok) { check(`round ${i + 1} returns to the page`, false, JSON.stringify(e.pasted)); break; }
  }
  check('5 rounds in a row: always back on the page, fast', away.length === 5 && Math.max(...away) < 1000, away.join(',') + 'ms');

  // ---- 6. Chrome route: the picture goes to the browser IN THE BACKGROUND (no switching, clipboard untouched)
  console.log('\n# Chrome route (stand-in extension)');
  const WebSocket = require('ws');
  const { Bridge } = require('../../src/bridge');
  const { EXT_ID } = require('../../src/ext-id');
  const br = new Bridge({ ports: [47690] });
  await br.start();
  const got = [];
  let mode = 'ok';
  const fake = new WebSocket('ws://127.0.0.1:47690', { origin: `chrome-extension://${EXT_ID}` });
  fake.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== 'shot') return;
    got.push(m);
    fake.send(JSON.stringify({ type: 'result', id: m.id, ...(mode === 'ok' ? { ok: true, where: 'claude.ai', method: 'file-input' } : { ok: false, error: 'no-tab' }) }));
  });
  for (let i = 0; i < 25 && !br.connected; i++) await sleep(200);
  check('Chrome link is up (extension connected)', br.connected);
  const C = launch(60, { bridge: br, paste: (a) => pasteIntoApp(a) });
  C.handle.setEnabled(false);
  await sleep(300);
  const sendC = async () => { const b = C.events.length; await C.handle.sendScreenshot('test'); return C.events.slice(b).find((e) => e.type === 'sent' || e.type === 'error'); };
  const { clipboard: cb } = require('electron');
  await activate(reader);
  cb.writeText('KEEP ME');
  const claudeCount0 = await pastedCount(claude);
  ev = await sendC();
  await sleep(300);
  const jpgHead = got[0] && Buffer.from(got[0].data, 'base64');
  check('picture went to Chrome as a real JPEG', ev.route === 'chrome' && ev.ok && jpgHead && jpgHead[0] === 0xff && jpgHead[1] === 0xd8 && jpgHead.length > 2000, `${jpgHead && jpgHead.length} bytes`);
  check('Chrome route never touched the desktop apps or your windows', !ev.pasted && active() === id(reader) && (await pastedCount(claude)) === claudeCount0 && (await pastedCount(reader)) === 0);
  check('Chrome route left your clipboard exactly as it was', cb.readText() === 'KEEP ME' && cb.readImage().isEmpty());

  // Chrome answers "no chat tab" -> falls back to the Claude desktop app, then returns to your page
  mode = 'no-tab';
  const claudeBefore = claudeCount0;
  ev = await sendC();
  await sleep(300);
  check('no chat tab in Chrome -> falls back to the Claude app', ev.ok && ev.route === 'claude' && (await pastedCount(claude)) === claudeBefore + 1, JSON.stringify(ev.chrome) + ' ' + ev.route);
  check('...and you are back on your page', active() === id(reader));
  check('...and your old clipboard is put back after a successful paste', await (async () => { await sleep(500); return cb.readText() === 'KEEP ME'; })());

  // Chrome not connected and no desktop app open -> nothing to paste into: picture stays on the clipboard
  fake.close();
  await sleep(500);
  claude.hide();
  await sleep(300);
  await activate(reader);
  cb.writeText('OLD');
  ev = await sendC();
  await sleep(500);
  check('nothing available: reported as not sent', ev.ok === false && ev.route === null);
  check('...but the picture is on your clipboard so you can paste it yourself', !cb.readImage().isEmpty());
  check('...and you are still on your page', active() === id(reader));
  claude.show();
  await sleep(300);

  // "Only copy it" option
  await activate(reader);
  C.handle.settings.set('target', 'clipboard');
  cb.writeText('X');
  ev = await sendC();
  check('"Only copy it" puts the picture on the clipboard and switches nothing', ev.ok && ev.route === 'clipboard' && !cb.readImage().isEmpty() && active() === id(reader));

  // Paste keystroke fails inside the desktop app -> you must STILL be sent back to your page
  const shim2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-shim2-'));
  fs.writeFileSync(path.join(shim2, 'xdotool'), `#!/bin/sh\nif [ "$1" = key ]; then exit 1; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
  const failRun = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { env: { ...process.env, PATH: `${shim2}:${process.env.PATH}` }, timeout: 8000 },
    (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  C.handle.settings.set('target', 'claude');
  await activate(reader);
  const F = launch(60, { paste: (a) => pasteIntoApp({ ...a, run: failRun }) });
  F.handle.setEnabled(false);
  F.handle.settings.set('target', 'claude');
  await sleep(300);
  const bF = F.events.length;
  await F.handle.sendScreenshot('test');
  const evF = F.events.slice(bF).find((e) => e.type === 'sent');
  await sleep(400);
  check('paste failed inside Claude -> reported as failed, not "sent"', evF && evF.ok === false && evF.pasted && evF.pasted.reason === 'failed', JSON.stringify(evF && evF.pasted));
  check('paste failed -> you are STILL sent back to your page', active() === id(reader));
  check('paste failed -> the picture stays on the clipboard for a manual paste', !cb.readImage().isEmpty());

  br.close();
  handleBox.handle.setEnabled(false);
  reader.destroy(); claude.destroy();
}

async function main() {
  // A visible window with known text, so we can prove the screenshot shows the real screen.
  await app.whenReady();
  const win = new BrowserWindow({ x: 0, y: 0, width: 1280, height: 800, frame: false });
  await win.loadURL('data:text/html,<body style="margin:0;background:%23ff00ff;color:white;font:80px sans-serif">CLAUDE EYES TEST SCREEN</body>');
  await sleep(500);

  // ---- Screen Recording permission (macOS behaviour, simulated) ----
  console.log('\n# Permission gate: macOS without Screen Recording must send NOTHING');
  {
    const P = launch(1, { platform: 'darwin', screenAccess: () => 'denied' });
    await sleep(7000);
    const blocked = P.events.filter((e) => e.type === 'blocked');
    check('speech while permission is denied -> blocked, nothing sent', blocked.length >= 1 && P.events.filter((e) => e.type === 'sent').length === 0, `blocked=${blocked.length}`);
    check('nothing was pasted into Claude', P.pasteCalls.length === 0);
    check('user was told what to do', P.events.some((e) => e.type === 'notice' && /Screen Recording/.test(e.body)));
    P.handle.setEnabled(false);
    await sleep(500);

    let captures = 0;
    const N = launch(1, { platform: 'darwin', screenAccess: () => 'not-determined', capture: async () => { captures++; throw new Error('x'); } });
    await sleep(5000);
    check('first time (not asked yet): triggers the macOS permission prompt, sends nothing', captures >= 1 && N.events.filter((e) => e.type === 'sent').length === 0, `captures=${captures}`);
    N.handle.setEnabled(false);
    await sleep(500);

    const G = launch(60, { platform: 'darwin', screenAccess: () => 'granted' });
    await sleep(5000);
    check('permission granted on macOS -> screenshot sent normally', G.events.some((e) => e.type === 'sent'));
    G.handle.setEnabled(false);
    await sleep(500);
  }

  // ---- Capture directly: all screens vs one screen ----
  console.log('\n# Capture function');
  {
    const { captureScreen } = require('../../src/screenshot');
    const all = await captureScreen({ all: true });
    const one = await captureScreen({ all: false });
    check('all-screens capture works (single monitor here: same as one screen)', all.getSize().width === 1280 && all.getSize().height === 800 && one.getSize().width === 1280, JSON.stringify(all.getSize()));
    const bm = all.toBitmap(); const sz = all.getSize();
    const o2 = (Math.floor(sz.height * 0.9) * sz.width + Math.floor(sz.width * 0.9)) * 4;
    check('all-screens capture shows the real screen content', bm[o2 + 2] > 230 && bm[o2 + 1] < 30 && bm[o2] > 230);
  }

  // ---- Scenario A: default-style 60s wait. Many sentences, exactly ONE screenshot. ----
  console.log('\n# Scenario A: 60-second wait (18s of audio containing 4 speech bursts)');
  let A = launch(60);
  await sleep(19000);
  const sentA = A.events.filter((e) => e.type === 'sent');
  const startsA = A.events.filter((e) => e.type === 'vad-start');
  const supA = A.events.filter((e) => e.type === 'vad-suppressed');
  check('mic went live', A.events.some((e) => e.type === 'mic' && e.state === 'listening'));
  check('exactly one screenshot in the first minute', sentA.length === 1, `sent=${sentA.length}`);
  check('further speech was noticed but NOT screenshotted', supA.length >= 2, `suppressed=${supA.length}`);
  if (sentA[0]) {
    check('screenshot has the real screen size', sentA[0].size.width >= 1000 && sentA[0].size.height >= 600, JSON.stringify(sentA[0].size));
    check('capture is fast (< 800ms)', sentA[0].captureMs < 800, `${sentA[0].captureMs}ms`);
    check('paste into Claude app was requested once', A.pasteCalls.length === 1 && A.pasteCalls[0].appName === 'Claude');
    const img = clipboard.readImage();
    check('screenshot was placed on the clipboard', !img.isEmpty());
    fs.writeFileSync(path.join(OUT, 'screenshot.png'), img.toPNG());
    // proof it is the magenta screen we drew
    const bm = img.toBitmap(); const s = img.getSize();
    const off = (Math.floor(s.height * 0.9) * s.width + Math.floor(s.width * 0.9)) * 4; // bottom-right, no text
    const [b, g, r] = [bm[off], bm[off + 1], bm[off + 2]];
    check('screenshot content matches what was on screen (magenta)', r > 230 && g < 30 && b > 230, `rgb=${r},${g},${b}`);
  }
  // first trigger must be at the START of the first sentence, not the end
  const firstStart = startsA[0];
  const sinceMic = firstStart ? firstStart.at : -1;
  console.log(`   first trigger at ${sinceMic}ms after launch`);
  check('first trigger is the start of sentence 1 (~2.0s in); the 1.0s click was ignored', sinceMic > 1700 && sinceMic < 3000, `${sinceMic}ms`);

  // ---- On/off switch ----
  console.log('\n# On/off switch');
  A.handle.setEnabled(false);
  await sleep(1000);
  check('OFF: microphone released', A.events.some((e) => e.type === 'mic' && e.state === 'stopped'));
  check('OFF: app reports not working (yellow)', A.handle.getState().working === false);
  const nBefore = A.events.filter((e) => e.type === 'sent').length;
  A.handle.settings.set('intervalSec', 1); A.handle.vad.setMinInterval(1000);
  await sleep(10000);
  check('OFF: no screenshots even while audio has speech', A.events.filter((e) => e.type === 'sent').length === nBefore);
  A.handle.setEnabled(true);
  await sleep(11000);
  check('ON again: working (green)', A.handle.getState().working === true);
  check('ON again: screenshots resume when speaking', A.events.filter((e) => e.type === 'sent').length > nBefore);
  check('settings persisted (enabled=true)', JSON.parse(fs.readFileSync(A.handle.settings.file, 'utf8')).enabled === true);

  // ---- Scenario B: short wait, verify timing of each trigger vs. the audio script ----
  console.log('\n# Scenario B: 3-second wait — trigger timing vs audio script (18s)');
  A.handle.setEnabled(false);
  await sleep(500);
  const B = launch(3);
  await sleep(19000);
  const sB = B.events.filter((e) => e.type === 'vad-start').map((e) => e.at);
  console.log('   trigger times (ms after launch):', sB.join(', '));
  check('at least 3 triggers in 18s of audio (2 per 9s loop)', sB.length >= 3, `count=${sB.length}`);
  const gaps = sB.slice(1).map((t, i) => t - sB[i]);
  // script: speech at 2.0 and 6.5 in a 9s loop => gaps alternate 4.5s and 4.5s (6.5->11.0)... both 4.5
  check('triggers land on sentence starts (gaps ≈ 4.5s, never 1s clicks or mid-sentence pause)', gaps.length > 0 && gaps.every((g) => Math.abs(g - 4500) < 700), gaps.join(','));
  check('nothing extra fired for the 0.4s pause inside sentence 1 or the click', sB.length <= 5, `count=${sB.length}`);
  B.handle.setEnabled(false);

  await focusScenarios();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  finish(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('E2E CRASH', e); finish(2); });
setTimeout(() => { console.error('E2E TIMEOUT'); finish(3); }, 150000);
