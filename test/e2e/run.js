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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(intervalSec, extra = {}) {
  const events = [];
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-e2e-')), 's.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ intervalSec, paste: true }));
  const t0 = Date.now();
  const pasteCalls = [];
  const handle = require('../../src/app').start({
    settingsFile, notify: false, manageLoginItem: false, allowMultiple: true,
    paste: async (a) => { pasteCalls.push(a); return { ok: true }; },
    ...extra,
    onEvent: (e) => { if (e.type !== 'level') events.push({ ...e, at: Date.now() - t0 }); else events.levelCount = (events.levelCount || 0) + 1; },
  });
  return { events, handle, pasteCalls, t0 };
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

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('E2E CRASH', e); app.exit(2); });
setTimeout(() => { console.error('E2E TIMEOUT'); app.exit(3); }, 150000);
