// End-to-end test: loads the real extension into Chromium and drives it on a
// fake YouTube watch page (test/fake-youtube.html) that streams the fixture
// media through MSE the way YouTube does, with YouTube's Trusted Types CSP.
//
// Run: npm run e2e      (needs: node tools/make-fixtures.js)
// Env: CHROME=/path/to/chrome  SHOTS=/dir/for/screenshots  HEADED=1
//      USERSCRIPT=1  test the userscript build (userscript/wave-looper.user.js)
//                    instead of the extension
import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { installFakeLyrics } from './fake-lyrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'test', 'fixtures');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'ytl-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const Core = createRequire(import.meta.url)('../src/core.js');
const manifest = JSON.parse(fs.readFileSync(path.join(FX, 'manifest.json'), 'utf8'));
const DUR = manifest.duration;

let failures = 0;
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    results.push(`  FAIL ${name}: ${e.message}`);
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`);
    if (page) await page.screenshot({ path: path.join(SHOTS, `fail-${name.replace(/\W+/g, '_')}.png`) }).catch(() => {});
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, msg) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timeout: ${msg} (last=${JSON.stringify(last)})`);
}

const USERSCRIPT = !!process.env.USERSCRIPT;
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytl-profile-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: CHROME,
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 860 },
  args: [
    ...(USERSCRIPT ? [] : [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`]),
    '--autoplay-policy=no-user-gesture-required',
  ],
});
// Userscript managers inject at document-start in the page's own world; an
// init script does the same.
if (USERSCRIPT) await ctx.addInitScript({ path: path.join(ROOT, 'userscript', 'wave-looper.user.js') });

const pageHtml = fs.readFileSync(path.join(ROOT, 'test', 'fake-youtube.html'));
await ctx.route('https://www.youtube.com/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname.startsWith('/__fx/')) {
    const f = path.join(FX, decodeURIComponent(u.pathname.slice(6)));
    if (!f.startsWith(FX) || !fs.existsSync(f)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: fs.readFileSync(f), contentType: f.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
  }
  if (u.pathname === '/watch') {
    return route.fulfill({
      body: pageHtml,
      contentType: 'text/html',
      // Same Trusted Types rule YouTube uses: innerHTML from scripts throws.
      headers: { 'content-security-policy': "require-trusted-types-for 'script'" },
    });
  }
  return route.fulfill({ status: 404, body: 'not found' });
});

const lyricsRequests = await installFakeLyrics(ctx);
let page = ctx.pages()[0] || (await ctx.newPage());
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

// ---- helpers that look inside the panel (open shadow root) ----
const host = () => page.evaluate(() => {
  const h = document.getElementById('ytl-wave-looper');
  return h ? { ...h.dataset, display: h.style.display } : null;
});
const vstate = () => page.evaluate(() => {
  const v = document.querySelector('#movie_player video');
  return { t: v.currentTime, rate: v.playbackRate, muted: v.muted, paused: v.paused, ended: v.ended, pitch: v.preservesPitch };
});
const shadowClick = (selector, text) => page.evaluate(([sel, txt]) => {
  const root = document.getElementById('ytl-wave-looper').shadowRoot;
  const els = [...root.querySelectorAll(sel)].filter((e) => !txt || e.textContent.trim() === txt || e.title === txt);
  if (!els.length) throw new Error('no element ' + sel + ' ' + txt);
  els[0].click();
}, [selector, text]);
const shadowSelect = (title, value) => page.evaluate(([t, v]) => {
  const root = document.getElementById('ytl-wave-looper').shadowRoot;
  const s = [...root.querySelectorAll('select')].find((e) => e.title === t);
  s.value = String(v);
  s.dispatchEvent(new Event('change'));
}, [title, value]);
const waveBox = () => page.evaluate(() => {
  const r = document.getElementById('ytl-wave-looper').shadowRoot.querySelector('canvas').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
async function clickWaveAt(t, d = DUR) {
  const b = await waveBox();
  await page.mouse.click(b.x + Math.min(b.w - 1, (t / d) * b.w), b.y + 18 + (b.h - 18) * 0.5);
}

// =============================================================================
if (!USERSCRIPT) await step('service worker starts', async () => {
  const sw = ctx.serviceWorkers().length ? ctx.serviceWorkers()[0] : await ctx.waitForEvent('serviceworker', { timeout: 5000 });
  assert(sw.url().endsWith('src/background.js'), sw.url());
});

await step('page loads and plays', async () => {
  await page.goto('https://www.youtube.com/watch?v=VIDAAAA1');
  await waitFor(async () => (await vstate()).t > 0.5, 15000, 'video playing');
});

await step('player button opens the panel (and help shows the first time)', async () => {
  await page.waitForSelector('#movie_player .ytl-yt-btn', { timeout: 5000 });
  await page.click('#movie_player .ytl-yt-btn');
  await waitFor(async () => (await host())?.display === 'block', 3000, 'panel visible');
  const helpVisible = await page.evaluate(() => !document.getElementById('ytl-wave-looper').shadowRoot.querySelector('.help').hidden);
  assert(helpVisible, 'help should show on first open');
  await page.keyboard.press('Escape');
  const helpHidden = await page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelector('.help').hidden);
  assert(helpHidden, 'Esc closes help');
});

let tBeforeScan = 0;
await step('button below the video (next to Like/Share) opens and closes the panel', async () => {
  await page.waitForSelector('ytd-watch-metadata #actions-inner > .ytl-below-btn', { timeout: 5000 });
  const txt = await page.textContent('.ytl-below-btn');
  assert(txt.includes('Wave Looper'), `label "${txt}"`);
  const box = await page.evaluate(() => {
    const r = document.querySelector('.ytl-below-btn').getBoundingClientRect();
    const v = document.getElementById('movie_player').getBoundingClientRect();
    return { below: r.top >= v.bottom, rightHalf: r.left > v.left + v.width / 2 };
  });
  assert(box.below && box.rightHalf, `placed below the video on the right: ${JSON.stringify(box)}`);
  await page.click('.ytl-below-btn');
  await waitFor(async () => (await host()).display === 'none', 2000, 'closed');
  await page.click('.ytl-below-btn');
  await waitFor(async () => (await host()).display === 'block', 2000, 'open again');
});

await step('auto scan reads the whole song and puts playback back', async () => {
  tBeforeScan = (await vstate()).t;
  await waitFor(async () => (await host()).scanning === 'true', 5000, 'scan started');
  await page.screenshot({ path: path.join(SHOTS, '1-scanning.png') });
  await waitFor(async () => (await host()).scanning === 'false', 40000, 'scan finished');
  const h = await host();
  assert(Number(h.cov) > 0.97, `coverage ${h.cov}`);
  const v = await vstate();
  assert(!v.muted, 'sound restored');
  assert(Math.abs(v.rate - 1) < 0.001, `rate restored (got ${v.rate})`);
  assert(v.t < tBeforeScan + 6 && v.t >= tBeforeScan - 0.5, `position restored near ${tBeforeScan.toFixed(1)} (got ${v.t.toFixed(1)})`);
  assert(!v.paused, 'still playing');
});

await step('waveform shows loud and quiet parts in the right places', async () => {
  await sleep(300);
  const heights = await page.evaluate((D) => {
    const cv = document.getElementById('ytl-wave-looper').shadowRoot.querySelector('canvas');
    const g = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const top = 18 * dpr;
    const out = {};
    for (const t of [1, 3, 9, 11, 21, 23]) {
      const x = Math.round((t / D) * cv.width);
      const col = g.getImageData(x, top, 1, cv.height - top).data;
      let n = 0;
      for (let i = 0; i < col.length; i += 4) if (col[i] + col[i + 1] + col[i + 2] > 140) n++;
      out[t] = n;
    }
    return out;
  }, DUR);
  for (const [loud, quiet] of [[1, 3], [9, 11], [21, 23]]) {
    assert(heights[loud] > heights[quiet] * 2, `t=${loud}s should be much taller than t=${quiet}s: ${JSON.stringify(heights)}`);
  }
  await page.screenshot({ path: path.join(SHOTS, '2-full-wave.png') });
});

await step('the wave can be made bigger and smaller', async () => {
  const h0 = (await waveBox()).h;
  await shadowClick('button', 'Make the wave bigger (or drag the top edge of the panel)');
  const h1 = (await waveBox()).h;
  assert(h1 > h0 + 40, `bigger: ${h0} -> ${h1}`);
  await shadowClick('button', 'Make the wave smaller');
  const h2 = (await waveBox()).h;
  assert(Math.abs(h2 - h0) < 2, `back: ${h2} vs ${h0}`);
  // dragging the top edge up also makes it bigger
  const top = await page.evaluate(() => document.getElementById('ytl-wave-looper').getBoundingClientRect().top);
  await page.mouse.move(640, top + 1);
  await page.mouse.down();
  await page.mouse.move(640, top - 120, { steps: 6 });
  await page.mouse.up();
  const h3 = (await waveBox()).h;
  assert(h3 > h0 + 100, `drag: ${h0} -> ${h3}`);
  await page.screenshot({ path: path.join(SHOTS, '2b-big-wave.png') });
  await shadowClick('button', 'Make the wave smaller');
});

await step('two clicks on the wave make a loop that repeats', async () => {
  await clickWaveAt(5);
  let h = await host();
  assert(Math.abs(Number(h.pending) - 5) < 0.2, `pending A ~5 (got ${h.pending})`);
  await clickWaveAt(7);
  h = await host();
  assert(Math.abs(Number(h.a) - 5) < 0.2 && Math.abs(Number(h.b) - 7) < 0.2, `loop 5-7 (got ${h.a}-${h.b})`);
  assert(h.loop === 'true', 'loop on');
  const a = Number(h.a), b = Number(h.b);
  await sleep(500);
  let outside = 0;
  for (let i = 0; i < 50; i++) {
    const v = await vstate();
    if (v.t < a - 0.05 || v.t > b + 0.12) outside++;
    await sleep(100);
  }
  h = await host();
  assert(outside === 0, `playhead left the loop ${outside} times`);
  assert(Number(h.reps) >= 2, `should have repeated at least twice (reps=${h.reps})`);
  await page.screenshot({ path: path.join(SHOTS, '3-loop.png') });
});

await step('loop end is tight (overshoot under 80 ms)', async () => {
  const h = await host();
  const b = Number(h.b);
  const maxT = await page.evaluate(async () => {
    const v = document.querySelector('#movie_player video');
    let m = 0;
    const end = performance.now() + 4500;
    await new Promise((res) => {
      const f = () => { m = Math.max(m, v.currentTime); if (performance.now() < end) requestAnimationFrame(f); else res(); };
      f();
    });
    return m;
  });
  assert(maxT - b < 0.08, `max time ${maxT.toFixed(3)} vs B ${b.toFixed(3)}`);
});

await step('speed buttons 30% / 50% / 75% / 100% and keep-pitch', async () => {
  await shadowClick('button.speed', '30%');
  assert(Math.abs((await vstate()).rate - 0.3) < 0.001, '30%');
  await shadowClick('button.speed', '50%');
  let v = await vstate();
  assert(Math.abs(v.rate - 0.5) < 0.001, `rate ${v.rate}`);
  assert(v.pitch === true, 'pitch kept');
  await shadowClick('button.speed', '75%');
  v = await vstate();
  assert(Math.abs(v.rate - 0.75) < 0.001, `rate ${v.rate}`);
  await shadowClick('button', 'Faster by 5%');
  assert(Math.abs((await vstate()).rate - 0.8) < 0.001, '+5%');
  await shadowClick('button', 'Slower by 5%');
  assert(Math.abs((await vstate()).rate - 0.75) < 0.001, '-5%');
});

await step('speed survives YouTube resetting it, but follows YouTube menu choices', async () => {
  await page.evaluate(() => { document.querySelector('#movie_player video').playbackRate = 1; });
  await sleep(200);
  assert(Math.abs((await vstate()).rate - 0.75) < 0.001, 'our 75% comes back');
  await page.evaluate(() => window.__ytResetSpeed());
  await sleep(200);
  assert(Math.abs((await vstate()).rate - 0.75) < 0.001, 'a click on a player button is not a speed choice');
  await page.evaluate(() => window.__ytSpeedMenu(1.5));
  await sleep(200);
  assert(Math.abs((await vstate()).rate - 1.5) < 0.001, 'user choice in YouTube menu wins');
  assert((await host()).rate === '1.5', 'panel shows 150%');
  await shadowClick('button.speed', '100%');
});

await step('Trainer: one tap starts it at 30% over 50 loops, another tap stops it at normal speed', async () => {
  await shadowClick('button', 'Trainer');
  await sleep(200);
  let h = await host();
  assert(h.trainer.startsWith('1/50'), `running from loop 1 of 50 (got "${h.trainer}")`);
  assert(Math.abs((await vstate()).rate - 0.3) < 0.001, `starts at 30% (got ${(await vstate()).rate})`);
  const opts = await page.evaluate(() => Object.fromEntries([...document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('select')]
    .filter((e) => e.title === 'Starting speed' || e.title === 'How many loops to reach 100%')
    .map((e) => [e.title, [...e.options].map((o) => o.value)])));
  assert(JSON.stringify(opts['Starting speed']) === '["30","50","75"]', `start choices ${opts['Starting speed']}`);
  assert(JSON.stringify(opts['How many loops to reach 100%']) === '["25","50","75"]', `loop choices ${opts['How many loops to reach 100%']}`);
  await shadowClick('button', 'Trainer');
  h = await host();
  assert(h.trainer === '', 'stopped');
  assert(Math.abs((await vstate()).rate - 1) < 0.001, 'back to normal speed');
});

await step('speed trainer: 50% to 100% over 25 loops', async () => {
  // A short 1 s loop keeps the test quick. (Not at 5 s: clicking right on the
  // existing A flag would grab the flag instead of starting a new loop.)
  await clickWaveAt(3);
  await clickWaveAt(4);
  const h0 = await host();
  assert(Math.abs(Number(h0.a) - 3) < 0.2 && Math.abs(Number(h0.b) - 4) < 0.2, `loop 3-4 (got ${h0.a}-${h0.b})`);
  await shadowClick('button', 'Trainer');
  await shadowSelect('Starting speed', 50); // changing a choice restarts the training with it
  await shadowSelect('How many loops to reach 100%', 25);
  const seen = [];
  await waitFor(async () => {
    const r = (await vstate()).rate;
    if (!seen.length || seen[seen.length - 1] !== r) seen.push(r);
    const h = await host();
    return h.trainer === '' || Number(h.trainer.split('/')[0]) >= 26;
  }, 60000, 'trainer reaches 100%');
  await page.screenshot({ path: path.join(SHOTS, '4-trainer.png') });
  const want = [...new Set(Array.from({ length: 25 }, (_, i) => Core.trainerRate(0.5, 1, 25, i + 1)))];
  assert(JSON.stringify(seen.slice(0, want.length)) === JSON.stringify(want), `rates ${JSON.stringify(seen)} want ${JSON.stringify(want)}`);
  const h = await host();
  assert(h.loop === 'true', 'loop still set');
});

await step('speed trainer: after 100%, plays 10 times at full speed and then stops', async () => {
  if ((await host()).trainer) await shadowClick('button', 'Trainer'); // stop
  await shadowClick('button', 'Trainer'); // start again: always 30% over 50 loops...
  let h0 = await host();
  assert(h0.trainer.startsWith('1/50') && Math.abs((await vstate()).rate - 0.3) < 0.001, 'every start is 30% over 50 loops');
  await shadowSelect('Starting speed', 75); // ...shorter for the test: 75% over 25 loops
  await shadowSelect('How many loops to reach 100%', 25);
  const start = Number((await host()).reps);
  await waitFor(async () => (await host()).trainer === '', 90000, 'trainer finishes by itself');
  const h = await host();
  const v = await vstate();
  // 24 ramp loops + 10 full-speed loops = 34 plays, then it stops at A.
  assert(Number(h.reps) - start === 34, `plays ${Number(h.reps) - start}`);
  assert(v.paused, 'stopped (paused)');
  assert(Math.abs(v.t - Number(h.a)) < 0.15, `waiting at the loop start (t=${v.t.toFixed(2)}, A=${h.a})`);
  assert(Math.abs(v.rate - 1) < 0.001, 'at full speed');
  await page.screenshot({ path: path.join(SHOTS, '4b-trainer-done.png') });
  await page.evaluate(() => document.querySelector('#movie_player video').play());
  await sleep(300);
});

await step('picking a speed when the trainer is off just sets it', async () => {
  await shadowClick('button.speed', '75%');
  const h = await host();
  assert(h.trainer === '', 'trainer stopped');
  assert(Math.abs((await vstate()).rate - 0.75) < 0.001, 'rate 75%');
  await shadowClick('button.speed', '100%');
});

await step('drag the B flag to make the loop longer', async () => {
  if ((await host()).zoom) await shadowClick('button', 'Show the whole song');
  const b = await waveBox();
  const h = await host();
  const xb = b.x + (Number(h.b) / DUR) * b.w;
  const y = b.y + 18 + (b.h - 18) * 0.6;
  await page.mouse.move(xb, y);
  await page.mouse.down();
  await page.mouse.move(xb + 30, y, { steps: 5 });
  await page.mouse.move(b.x + (9 / DUR) * b.w, y, { steps: 5 });
  await page.mouse.up();
  const h2 = await host();
  const zoomedNow = (await host()).zoom;
  assert(Math.abs(Number(h2.b) - 9) < 0.2, `B dragged to ~9 (got ${h2.b})`);
  assert(Math.abs(Number(h2.a) - Number(h.a)) < 0.001, `A unchanged (before ${h.a}-${h.b}, after ${h2.a}-${h2.b}, view zoomed=${zoomedNow})`);
});

await step('nudge buttons move A by 0.05 s', async () => {
  const a0 = Number((await host()).a);
  await shadowClick('button', 'Move start later (Shift = fine, Alt = big)');
  const a1 = Number((await host()).a);
  assert(Math.abs(a1 - a0 - 0.05) < 0.002, `${a0} -> ${a1}`);
});

await step('undo restores the previous loop', async () => {
  const before = await host();
  await shadowClick('button', 'Undo the last loop change');
  const after = await host();
  assert(after.a !== before.a, `undo changed A (${before.a} -> ${after.a})`);
});

await step('zoom with the mouse wheel and back to the whole song', async () => {
  const b = await waveBox();
  await page.mouse.move(b.x + b.w * 0.25, b.y + b.h * 0.6);
  // Synthetic wheel events: CDP mouse wheels are unreliable in headless mode.
  await page.evaluate(([x, y]) => {
    const cv = document.getElementById('ytl-wave-looper').shadowRoot.querySelector('canvas');
    for (let i = 0; i < 6; i++) cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, [b.x + b.w * 0.25, b.y + b.h * 0.6]);
  await sleep(200);
  const zoomed = !!(await host()).zoom;
  assert(zoomed, 'zoomed in');
  await page.screenshot({ path: path.join(SHOTS, '5-zoomed.png') });
  await shadowClick('button', 'Zoom to the loop');
  await sleep(150);
  await page.screenshot({ path: path.join(SHOTS, '6-zoom-loop.png') });
  await shadowClick('button', 'Show the whole song');
});

await step('Zoom in button: short window that scrolls with the song; Whole song zooms out', async () => {
  if ((await host()).loop === 'true') await page.keyboard.press('Backslash'); // free playback so the view scrolls
  await page.evaluate(() => { const v = document.querySelector('#movie_player video'); v.currentTime = 2; v.play().catch(() => {}); });
  await shadowClick('button.zoom-toggle');
  let h = await host();
  assert(Math.abs(Number(h.zoom) - DUR / 2) < 0.1, `zoomed to half of a short song (got ${h.zoom})`);
  const label = await page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelector('button.zoom-toggle').textContent);
  assert(label === 'Whole song', `button now says "${label}"`);
  // The window follows the playhead: it is always inside the view, about a quarter of the way in.
  for (let i = 0; i < 3; i++) {
    await sleep(1500);
    const pos = await page.evaluate(() => {
      const h = document.getElementById('ytl-wave-looper');
      return { t: document.querySelector('#movie_player video').currentTime };
    });
    const b = await waveBox();
    const px = await page.evaluate(([bx, bw]) => {
      // read the white playhead column from the ruler row
      const cv = document.getElementById('ytl-wave-looper').shadowRoot.querySelector('canvas');
      const g = cv.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const row = g.getImageData(0, Math.round(10 * dpr), cv.width, 1).data;
      for (let x = 0; x < cv.width; x++) if (row[x * 4] > 240 && row[x * 4 + 1] > 240 && row[x * 4 + 2] > 240) return x / cv.width;
      return -1;
    }, [b.x, b.w]);
    if (pos.t > DUR / 2 * 0.3 && pos.t < DUR - DUR / 2 * 0.8) assert(px > 0.15 && px < 0.4, `playhead at ${px.toFixed(2)} of the view (t=${pos.t.toFixed(1)})`);
  }
  await page.screenshot({ path: path.join(SHOTS, '5b-zoom-in.png') });
  await shadowClick('button.zoom-toggle');
  h = await host();
  assert(h.zoom === '', 'zoomed out to the whole song');
});

await step('keyboard: [ and ] set the loop from the playhead, \\ toggles it', async () => {
  if ((await host()).loop === 'true') await page.keyboard.press('Backslash'); // else the loop bounces the seek back
  await waitFor(async () => (await host()).loop === 'false', 2000, 'loop off before seeking');
  await page.evaluate(() => (document.querySelector('#movie_player video').currentTime = 12));
  await sleep(300);
  await page.keyboard.press('BracketLeft');
  await sleep(1500);
  const mid = await host();
  await page.keyboard.press('BracketRight');
  const h = await host();
  assert(Number(h.a) > 11.8 && Number(h.a) < 12.8, `A from playhead (${h.a}) mid=${JSON.stringify(mid)} t=${(await vstate()).t}`);
  assert(Number(h.b) - Number(h.a) > 1 && Number(h.b) - Number(h.a) < 2.5, `B from playhead (${h.b})`);
  await page.keyboard.press('Backslash');
  assert((await host()).loop === 'false', 'loop toggled off');
  await page.keyboard.press('Backslash');
  assert((await host()).loop === 'true', 'loop toggled on');
});

await step('breath pause between loops', async () => {
  // Away from the previous loop's flags (clicking a flag grabs it instead).
  await clickWaveAt(17);
  await clickWaveAt(18.5);
  const hl = await host();
  assert(Math.abs(Number(hl.a) - 17) < 0.2 && Math.abs(Number(hl.b) - 18.5) < 0.2, `loop 17-18.5 (got ${hl.a}-${hl.b})`);
  await shadowClick('button', 'Settings');
  await shadowSelect('Pause before each repeat (time to breathe)', 1);
  const r0 = Number((await host()).reps);
  await waitFor(async () => Number((await host()).reps) > r0, 6000, 'wrap happened');
  const v = await vstate();
  assert(v.paused, 'paused during the breath');
  await waitFor(async () => !(await vstate()).paused, 2500, 'plays again after the pause');
  await shadowSelect('Pause before each repeat (time to breathe)', 0);
});

await step('saved loops: save, clear, reload', async () => {
  await shadowClick('.chip.add button');
  const saved = await host();
  await shadowClick('button', 'Clear the loop');
  assert((await host()).a === '', 'cleared');
  await shadowClick('.chip button', 'Part 1');
  const h = await host();
  assert(h.a === saved.a && h.b === saved.b, 'saved loop restored');
});

await step('clicking the ruler past the loop jumps there and pauses the loop', async () => {
  const b = await waveBox();
  await page.mouse.click(b.x + (25 / DUR) * b.w, b.y + 8);
  const h = await host();
  assert(h.loop === 'false', 'loop paused');
  const v = await vstate();
  assert(Math.abs(v.t - 25) < 0.6, `seeked to ~25 (got ${v.t})`);
});

await step('a loop at the very end never lets the video end', async () => {
  await clickWaveAt(26.5);
  await clickWaveAt(DUR);
  const h = await host();
  assert(Number(h.b) > 29.5, `B at the end (${h.b})`);
  let ended = false;
  for (let i = 0; i < 70; i++) {
    const v = await vstate();
    if (v.ended || v.t > DUR - 0.05) ended = true;
    await sleep(100);
  }
  assert(!ended, 'video reached its end');
  assert(Number((await host()).reps) >= 1, 'wrapped');
});

await step('play / pause button', async () => {
  await page.evaluate(() => document.querySelector('#movie_player video').play());
  await sleep(200);
  await shadowClick('button.play-btn');
  assert((await vstate()).paused, 'paused');
  const title = await page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelector('button.play-btn').title);
  assert(title === 'Play', `button now offers Play (${title})`);
  await shadowClick('button.play-btn');
  await waitFor(async () => !(await vstate()).paused, 2000, 'playing again');
});

const lyr = () => page.evaluate(() => {
  const root = document.getElementById('ytl-wave-looper').shadowRoot;
  const pane = root.querySelector('.lyrics');
  const lines = [...root.querySelectorAll('.lyr-body p')];
  return {
    visible: !pane.hidden && pane.getBoundingClientRect().width > 100,
    meta: root.querySelector('.lyr-meta').textContent,
    count: lines.length,
    now: lines.findIndex((p) => p.classList.contains('now')),
    msg: (root.querySelector('.lyr-msg') || {}).textContent || '',
  };
});

await step('lyrics: found automatically from the YouTube title and shown next to the wave', async () => {
  if ((await host()).loop === 'true') await page.keyboard.press('Backslash');
  await page.evaluate(() => { const v = document.querySelector('#movie_player video'); v.currentTime = 6.5; v.play().catch(() => {}); });
  const before = lyricsRequests.length;
  await shadowClick('button', 'Lyrics');
  const L = await waitFor(async () => { const x = await lyr(); return x.count > 0 ? x : null; }, 5000, 'lyrics shown');
  assert(L.visible, 'lyrics pane visible beside the wave');
  const first = lyricsRequests[before];
  assert(first && first.track_name === 'Song VIDAAAA1' && first.artist_name === 'Test Artist', `searched by song and artist: ${JSON.stringify(first)}`);
  assert(L.meta.startsWith('Song VIDAAAA1 — Test Artist') && L.meta.includes('follows the song'), `meta "${L.meta}"`);
  const wave = await waveBox();
  assert(wave.w > 600, `wave still big (${wave.w}px)`);
  // The highlighted line follows the song: lines are 2 s apart.
  const t = (await vstate()).t;
  const x = await waitFor(async () => { const y = await lyr(); return y.now >= 0 ? y : null; }, 2000, 'a line is highlighted');
  const want = Math.floor((t + 0.15) / 2);
  assert(Math.abs(x.now - want) <= 1, `highlighted line ${x.now}, want ~${want} (t=${t.toFixed(1)})`);
  await page.screenshot({ path: path.join(SHOTS, '8-lyrics.png') });
});

await step('lyrics: tap a line to jump there; next match; search by hand', async () => {
  await page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('.lyr-body p')[10].click());
  const v = await vstate();
  assert(Math.abs(v.t - 20) < 0.5, `jumped to line 11 at 20 s (t=${v.t.toFixed(2)})`);
  await shadowClick('button', 'Wrong song? Show the next match');
  let L = await lyr();
  assert(L.meta.includes('(Live)') && L.meta.includes('match 2 of'), `next match "${L.meta}"`);
  await shadowClick('button', 'Lyrics are early: show them later');
  const off = await page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelector('.lyr-off').textContent);
  assert(off === 'timing +0.2s', `timing nudged by 0.2 s (${off})`);
  await page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('.lyr-body p')[5].click());
  assert(Math.abs((await vstate()).t - 10.2) < 0.15, `tapping a line uses the nudged timing (t=${(await vstate()).t.toFixed(2)})`);
  await page.evaluate(() => {
    const input = document.getElementById('ytl-wave-looper').shadowRoot.querySelector('.lyr-head input');
    input.focus();
  });
  await page.keyboard.type('Another Tune');
  await page.keyboard.press('Enter');
  L = await waitFor(async () => { const y = await lyr(); return y.meta.startsWith('Another Tune') ? y : null; }, 4000, 'manual search result');
  assert(lyricsRequests.some((p) => p.q === 'Another Tune'), 'searched what I typed');
  assert(!(await vstate()).paused, 'typing did not trigger YouTube shortcuts (k would pause)');
});

const lineBtn = (i) => page.evaluate((k) => {
  const p = document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('.lyr-body p')[k];
  p.querySelector('.lyr-loop').click();
}, i);

await step('line practice: ⟳ plays one line 30 times (30% → 100% over 20, then 10 at 100%), then stops and puts the speed back', async () => {
  if ((await host()).loop === 'true') await page.keyboard.press('Backslash');
  await shadowClick('button.speed', '75%'); // the speed from before, to be restored
  const abBefore = await host();
  await page.evaluate(() => { const v = document.querySelector('#movie_player video'); v.currentTime = 2; v.play().catch(() => {}); });
  await lineBtn(4);
  let h = await host();
  assert(h.lineLoop === '8.00,10.00' && h.lineRep === '1', `line 5 (8 s to 10 s), play 1 (${h.lineLoop} / ${h.lineRep})`);
  assert(Math.abs((await vstate()).rate - 0.3) < 0.001, 'starts at 30%');
  const r0 = Number(h.reps);
  const rates = [];
  let outside = 0;
  await waitFor(async () => {
    const v = await vstate();
    if (!rates.length || rates[rates.length - 1] !== v.rate) rates.push(v.rate);
    const x = await host();
    if (x.lineLoop && (v.t < 7.95 || v.t > 10.15)) outside++;
    return x.lineLoop === '' ? x : null;
  }, 220000, 'line practice finishes by itself');
  h = await host();
  const v = await vstate();
  const want = [...new Set(Array.from({ length: 20 }, (_, i) => Core.trainerRate(0.3, 1, 20, i + 1))), 0.75];
  assert(JSON.stringify(rates) === JSON.stringify(want), `speeds ${JSON.stringify(rates)} want ${JSON.stringify(want)}`);
  assert(outside === 0, `stayed on the line (${outside})`);
  assert(Number(h.reps) - r0 === 30, `30 plays (${Number(h.reps) - r0})`);
  assert(v.paused && Math.abs(v.t - 8) < 0.15, `stopped at the start of the line (paused=${v.paused}, t=${v.t.toFixed(2)})`);
  assert(Math.abs(v.rate - 0.75) < 0.001, 'speed back to 75%');
  assert(h.a === abBefore.a && h.b === abBefore.b, 'A-B loop untouched');
});

await step('line practice: tap ⟳ again to stop early; speed comes back and it plays on', async () => {
  await page.evaluate(() => document.querySelector('#movie_player video').play().catch(() => {}));
  await lineBtn(1);
  let h = await host();
  assert(h.lineLoop === '2.00,4.00', `line 2 (${h.lineLoop})`);
  assert(Math.abs((await vstate()).rate - 0.3) < 0.001, '30%');
  await page.screenshot({ path: path.join(SHOTS, '9-line-loop.png') });
  await sleep(500);
  await lineBtn(1);
  h = await host();
  assert(h.lineLoop === '', 'stopped');
  const v = await vstate();
  assert(Math.abs(v.rate - 0.75) < 0.001 && !v.paused, `75% again and still playing (${v.rate}, paused=${v.paused})`);
  await waitFor(async () => (await vstate()).t > 4.2, 5000, 'plays on into the next line');
  await shadowClick('button.speed', '100%');
});

await step('play / pause button is a little bigger than the other buttons', async () => {
  const m = await page.evaluate(() => {
    const root = document.getElementById('ytl-wave-looper').shadowRoot;
    const p = root.querySelector('button.play-btn').getBoundingClientRect();
    const o = root.querySelector('button.speed').getBoundingClientRect();
    return { ph: p.height, pw: p.width, oh: o.height, big: !!root.querySelector('.big-play') };
  });
  assert(m.ph > m.oh && m.pw >= 40, `bigger (${m.pw}x${m.ph} vs ${m.oh})`);
  assert(!m.big, 'only one play button');
});

await step('Trainer: a slower speed steps the trainer back (more loops); 30% starts the climb again', async () => {
  if ((await host()).trainer) await shadowClick('button', 'Trainer');
  await shadowClick('button', 'Trainer'); // 30% over 50 loops
  const check = async (pct, rep, start = 0.3) => {
    const h = await host();
    const v = await vstate();
    assert(h.trainer === `${rep}/50`, `${pct}%: loop ${rep} of 50 (got ${h.trainer})`);
    assert(Math.abs(v.rate - Core.trainerRate(start, 1, 50, rep)) < 0.001, `${pct}%: speed ${v.rate}`);
  };
  await shadowClick('button.speed', '75%');
  await check(75, Core.trainerRepFor(0.3, 1, 50, 0.75)); // loop 33: 17 to go
  await shadowClick('button.speed', '50%');
  await check(50, 15); // stepped back: 35 loops to go again
  const hint = await page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelector('.hint').textContent);
  assert(hint.includes('35 more loops to 100%'), `tells me how many loops are left ("${hint}")`);
  await shadowClick('button.speed', '100%');
  await check(100, 50);
  await shadowClick('button.speed', '30%');
  await check(30, 1);
  // Trainer started at 50%: picking 30% starts the climb again from 30% with all 50 loops.
  await shadowSelect('Starting speed', 50);
  await check(50, 1, 0.5);
  await shadowClick('button.speed', '30%');
  await check(30, 1, 0.3);
  const startSel = await page.evaluate(() => [...document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('select')].find((e) => e.title === 'Starting speed').value);
  assert(startSel === '30', 'the start box shows 30%');
  assert((await host()).trainer !== '', 'trainer still running');
  await shadowClick('button', 'Trainer');
  assert(Math.abs((await vstate()).rate - 1) < 0.001, 'off: normal speed');
});

await step('switching videos resets, coming back restores loop and cached wave', async () => {
  const before = await host();
  await page.evaluate(() => window.__navigate('VIDBBBB2'));
  await waitFor(async () => (await host()).vid === 'VIDBBBB2', 5000, 'new video id');
  let h = await host();
  assert(h.a === '' && h.b === '' && h.rate === '1', `reset state ${JSON.stringify(h)}`);
  await waitFor(async () => (await lyr()).meta.startsWith('Song VIDBBBB2'), 5000, 'lyrics for the new song');
  // let the new video scan so the first video's scan state is not involved
  await waitFor(async () => (await host()).scanning === 'false', 40000, 'scan of video 2 done');
  await page.evaluate(() => window.__navigate('VIDAAAA1'));
  await waitFor(async () => (await host()).vid === 'VIDAAAA1', 5000, 'back to video 1');
  h = await waitFor(async () => { const x = await host(); return x.a ? x : null; }, 3000, 'loop restored');
  assert(h.a === before.a && h.b === before.b, `restored ${h.a}-${h.b} vs ${before.a}-${before.b}`);
  await waitFor(async () => Number((await host()).cov) > 0.95, 3000, 'cached waveform shown right away');
});

await step('a cappella video: lyrics line up with where the singing starts, by themselves', async () => {
  await page.evaluate(() => window.__navigate('ACAPELLA'));
  await waitFor(async () => (await lyr()).meta.startsWith('Song — Test Artist'), 6000, 'lyrics found without the word "acapella"');
  const off = await waitFor(async () => {
    const t = await page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelector('.lyr-off').textContent);
    return /\(auto\)$/.test(t) ? t : null;
  }, 40000, 'auto timing');
  assert(off === 'timing −3.0s (auto)', `lyrics moved 3 s earlier to meet the singing (${off})`);
  await waitFor(async () => (await host()).scanning === 'false', 40000, 'whole-song read finished');
  await page.evaluate(() => { const v = document.querySelector('#movie_player video'); v.currentTime = 4.5; v.play().catch(() => {}); });
  // Line 3 is at 7 s in the original = 4 s in this video (lit from 4 s to 6 s).
  await waitFor(async () => { const y = await lyr(); const t = (await vstate()).t; return t < 5.6 && y.now === 2; }, 3000, 'the line being sung is lit');
  await page.evaluate(() => window.__navigate('VIDAAAA1'));
  await waitFor(async () => (await host()).vid === 'VIDAAAA1', 5000, 'back');
});

await step('close turns everything off', async () => {
  await shadowClick('button.speed', '50%');
  await shadowClick('button', 'Close the looper (turns loop and speed off)');
  const h = await host();
  assert(h.display === 'none', 'hidden');
  assert(h.loop === 'false', 'loop off');
  assert(Math.abs((await vstate()).rate - 1) < 0.001, 'speed back to 100%');
});

await step('a closed looper stays off when you come back to a video', async () => {
  await page.evaluate(() => window.__navigate('VIDBBBB2'));
  await waitFor(async () => (await host()).vid === 'VIDBBBB2', 5000, 'video 2');
  await page.evaluate(() => window.__navigate('VIDAAAA1'));
  await waitFor(async () => (await host()).vid === 'VIDAAAA1', 5000, 'video 1');
  await sleep(800);
  const h = await host();
  assert(h.loop === 'false', 'loop must not run while closed');
  assert(Math.abs((await vstate()).rate - 1) < 0.001, 'speed must stay 100% while closed');
});

await step('ads: the loop never touches an ad', async () => {
  await page.click('#movie_player .ytl-yt-btn');
  await waitFor(async () => (await host()).display === 'block', 3000, 'panel open again');
  await waitFor(async () => (await host()).scanning === 'false', 30000, 'no scan running');
  await clickWaveAt(3);
  await clickWaveAt(5);
  await page.evaluate(() => document.getElementById('movie_player').classList.add('ad-showing'));
  await page.evaluate(() => (document.querySelector('#movie_player video').currentTime = 10));
  await sleep(1200);
  const t = (await vstate()).t;
  assert(t > 10, `during an ad playback is left alone (t=${t.toFixed(2)})`);
  await page.evaluate(() => document.getElementById('movie_player').classList.remove('ad-showing'));
  await waitFor(async () => { const v = await vstate(); return v.t >= 2.9 && v.t <= 5.2; }, 3000, 'loop resumes after the ad');
});

await step('fullscreen: panel moves inside the player and its clicks do not pause the video', async () => {
  await page.click('#fs-btn');
  await waitFor(() => page.evaluate(() => !!document.fullscreenElement), 3000, 'fullscreen');
  await sleep(700);
  const inside = await page.evaluate(() => document.getElementById('ytl-wave-looper').parentElement.id);
  assert(inside === 'movie_player', `panel parent is ${inside}`);
  const before = await page.evaluate(() => window.__fake.playerClicks);
  const box = await page.evaluate(() => {
    const b = [...document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('button.speed')].find((x) => x.textContent === '75%');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  const after = await page.evaluate(() => window.__fake.playerClicks);
  assert(after === before, 'click leaked to the player');
  assert(Math.abs((await vstate()).rate - 0.75) < 0.001, '75% applied in fullscreen');
  await page.screenshot({ path: path.join(SHOTS, '7-fullscreen.png') });
  await page.evaluate(() => document.exitFullscreen());
  await sleep(500);
  const back = await page.evaluate(() => document.getElementById('ytl-wave-looper').parentElement.tagName);
  assert(back === 'BODY', `panel back in body (${back})`);
});

await step('no errors in the console (Trusted Types etc.)', async () => {
  const bad = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  assert(bad.length === 0, bad.join('\n'));
});

await ctx.close();
fs.rmSync(userDir, { recursive: true, force: true });
console.log('\n' + results.join('\n'));
console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${results.length - failures}/${results.length} steps. Screenshots: ${SHOTS}`);
process.exit(failures ? 1 : 0);
