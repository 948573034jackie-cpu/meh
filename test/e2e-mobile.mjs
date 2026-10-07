// Phone test: the userscript build on an emulated iPhone (touch, small screen)
// visiting a simulated m.youtube.com watch page.
// Run: npm run e2e:mobile   (needs fixtures and: node tools/build-userscript.js)
import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { installFakeLyrics } from './fake-lyrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'test', 'fixtures');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'ytl-shots-mobile');
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const DUR = JSON.parse(fs.readFileSync(path.join(FX, 'manifest.json'), 'utf8')).duration;

let failures = 0;
const results = [];
let page;
async function step(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    results.push(`  FAIL ${name}: ${e.message}`);
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`);
    if (page) await page.screenshot({ path: path.join(SHOTS, `fail-${name.replace(/\W+/g, '_')}.png`) }).catch(() => {});
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
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

const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
});
await ctx.addInitScript({ path: path.join(ROOT, 'userscript', 'wave-looper.user.js') });
const html = fs.readFileSync(path.join(ROOT, 'test', 'fake-youtube.html'));
await ctx.route('https://m.youtube.com/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname.startsWith('/__fx/')) {
    const f = path.join(FX, decodeURIComponent(u.pathname.slice(6)));
    if (!f.startsWith(FX) || !fs.existsSync(f)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: fs.readFileSync(f), contentType: f.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
  }
  if (u.pathname === '/watch') return route.fulfill({ body: html, contentType: 'text/html', headers: { 'content-security-policy': "require-trusted-types-for 'script'" } });
  return route.fulfill({ status: 404 });
});
const lyricsRequests = await installFakeLyrics(ctx);
page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const host = () => page.evaluate(() => {
  const h = document.getElementById('ytl-wave-looper');
  return h ? { ...h.dataset, display: h.style.display } : null;
});
const vstate = () => page.evaluate(() => {
  const v = document.querySelector('#movie_player video');
  return { t: v.currentTime, rate: v.playbackRate, paused: v.paused, muted: v.muted };
});
// Finds a button in the panel by its text or title and taps its centre.
async function tap(selector, text) {
  const box = await page.evaluate(([sel, txt]) => {
    const root = document.getElementById('ytl-wave-looper').shadowRoot;
    const el = [...root.querySelectorAll(sel)].find((e) => !txt || e.textContent.trim() === txt || e.title === txt);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, [selector, text]);
  assert(box, `no ${selector} ${text || ''}`);
  await page.touchscreen.tap(box.x, box.y);
  return box;
}
const waveBox = () => page.evaluate(() => {
  const r = document.getElementById('ytl-wave-looper').shadowRoot.querySelector('canvas').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
async function tapWave(t) {
  const b = await waveBox();
  await page.touchscreen.tap(b.x + Math.min(b.w - 2, (t / DUR) * b.w), b.y + 18 + (b.h - 18) * 0.5);
}

await step('page loads and plays on the phone', async () => {
  await page.goto('https://m.youtube.com/watch?v=PHONE001');
  await waitFor(async () => (await vstate()).t > 0.5, 15000, 'playing');
});

await step('floating button appears and opens the panel', async () => {
  await page.waitForSelector('.ytl-fab', { state: 'visible', timeout: 5000 });
  const b = await page.$eval('.ytl-fab', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; });
  assert(b.w >= 44, `big enough to tap (${b.w}px)`);
  await page.touchscreen.tap(b.x, b.y);
  await waitFor(async () => (await host())?.display === 'block', 3000, 'panel open');
  assert(!(await page.isVisible('.ytl-fab')), 'floating button hides while the panel is open');
  await page.screenshot({ path: path.join(SHOTS, 'm1-help.png') });
  await tap('button', 'Close help');
});

await step('panel fits the phone: big buttons, no sideways scrolling, video still visible', async () => {
  const m = await page.evaluate(() => {
    const h = document.getElementById('ytl-wave-looper');
    const root = h.shadowRoot;
    const panel = root.querySelector('.panel');
    const btns = [...root.querySelectorAll('.bar button')].filter((b) => b.getClientRects().length);
    return {
      panelH: h.getBoundingClientRect().height,
      rows: btns.map((b) => b.getBoundingClientRect().top).sort((x, y) => x - y).filter((t, i, a) => i === 0 || t - a[i - 1] > 8).length,
      overflow: panel.scrollWidth - panel.clientWidth,
      minBtn: Math.min(...btns.map((b) => b.getBoundingClientRect().height)),
      videoBottom: document.getElementById('movie_player').getBoundingClientRect().bottom,
      panelTop: h.getBoundingClientRect().top,
    };
  });
  assert(m.overflow <= 1, `no sideways overflow (${m.overflow}px)`);
  assert(m.minBtn >= 36, `buttons at least 36px tall (${m.minBtn})`);
  assert(m.panelH < 844 * 0.5, `panel not taller than half the screen (${m.panelH})`);
  assert(m.rows <= 3, `toolbar fits in 3 rows (${m.rows})`);
  assert(m.videoBottom <= m.panelTop, `video not covered (${m.videoBottom} vs ${m.panelTop})`);
});

await step('reads the whole song (scan) and goes back', async () => {
  await waitFor(async () => (await host()).scanning === 'true', 6000, 'scan started');
  await waitFor(async () => (await host()).scanning === 'false', 40000, 'scan done');
  assert(Number((await host()).cov) > 0.97, 'whole wave');
  const v = await vstate();
  assert(!v.muted && Math.abs(v.rate - 1) < 0.001, 'sound and speed restored');
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, 'm2-wave.png') });
});

await step('DJ view: the wave is zoomed in and scrolls under a playhead in the middle', async () => {
  const h = await host();
  assert(h.zoom && Number(h.zoom) < DUR, `zoomed (window ${h.zoom}s)`);
  const t = (await vstate()).t;
  const [s, e] = h.view.split(',').map(Number);
  const pos = (t - s) / (e - s);
  if (t > (e - s) / 2 + 0.5) assert(Math.abs(pos - 0.5) < 0.1, `playhead in the middle (at ${pos.toFixed(2)})`);
});

await step('drag the wave like a DJ: finger holds the song, moving it moves the song, lifting plays on', async () => {
  await page.evaluate(() => { const v = document.querySelector('#movie_player video'); v.currentTime = 8; v.play(); });
  await sleep(600);
  const b = await waveBox();
  const cdp = await ctx.newCDPSession(page);
  const x = b.x + b.w * 0.6;
  const y = b.y + 18 + (b.h - 18) * 0.5;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await sleep(400);
  let v = await vstate();
  assert(v.paused, 'finger on the wave stops the music');
  const t0 = v.t;
  const span = Number((await host()).zoom);
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - i * 15, y, id: 1 }] });
    await sleep(30);
  }
  await sleep(200);
  v = await vstate();
  const want = t0 + (120 / b.w) * span;
  assert(Math.abs(v.t - want) < 0.4, `pulling the wave left moves the song forward (${t0.toFixed(2)} -> ${v.t.toFixed(2)}, want ~${want.toFixed(2)})`);
  assert(v.paused, 'still holding');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitFor(async () => !(await vstate()).paused, 2000, 'plays on after lifting the finger');
  assert(!(await host()).a, 'dragging the wave did not make a loop');
});

await step('A button makes a 3-second loop right away, B sets the end', async () => {
  await page.evaluate(() => { const v = document.querySelector('#movie_player video'); v.currentTime = 9; v.play(); });
  await sleep(150);
  await tap('button', 'A');
  let h = await host();
  assert(Math.abs(Number(h.a) - 9) < 0.3, `A at the playhead (${h.a})`);
  assert(Math.abs(Number(h.b) - Number(h.a) - 3) < 0.01, `3-second loop (${h.a}-${h.b})`);
  assert(h.loop === 'true', 'looping straight away');
  await waitFor(async () => (await vstate()).t > Number(h.a) + 1.6, 4000, 'played a bit');
  const t = (await vstate()).t; // B goes where the playhead is when you tap (then it loops back to A)
  await tap('button', 'B');
  h = await host();
  assert(Math.abs(Number(h.b) - t) < 0.35 && Number(h.b) < Number(h.a) + 2.8, `B moved to the playhead (${h.b} vs t=${t.toFixed(2)})`);
  await waitFor(async () => Number((await host()).reps) >= 2, 8000, 'repeats');
  const tt = (await vstate()).t;
  assert(tt >= Number(h.a) - 0.05 && tt <= Number(h.b) + 0.15, `inside loop (t=${tt})`);
});

await step('drag a flag with a finger', async () => {
  await page.evaluate(() => document.querySelector('#movie_player video').pause());
  await sleep(700); // DJ view settles on the paused playhead
  const b = await waveBox();
  const h = await host();
  const [vs, ve] = h.view.split(',').map(Number);
  const x = b.x + ((Number(h.b) - vs) / (ve - vs)) * b.w + 10; // a little off the line: fingers are not precise
  const y = b.y + b.h * 0.6;
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 8, y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const h2 = await host();
  assert(Number(h2.b) > Number(h.b) + 0.5, `B moved right (${h.b} -> ${h2.b})`);
  assert(h2.a === h.a, 'A unchanged');
  await page.evaluate(() => document.querySelector('#movie_player video').play());
});

await step('pinch with two fingers zooms in; Whole song / Zoom in button', async () => {
  const b = await waveBox();
  const cdp = await ctx.newCDPSession(page);
  const y = b.y + b.h * 0.6;
  const cx = b.x + b.w / 2;
  const before = Number((await host()).zoom);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 30, y, id: 1 }, { x: cx + 30, y, id: 2 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 30 - i * 15, y, id: 1 }, { x: cx + 30 + i * 15, y, id: 2 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
  const h = await host();
  assert(h.zoom && Number(h.zoom) < before - 1, `zoomed in more (${before}s -> ${h.zoom}s)`);
  assert(Number(h.a) > 8 && Number(h.b) > Number(h.a), 'pinch did not change the loop');
  assert(!(await vstate()).paused, 'pinching does not stop the music');
  await page.screenshot({ path: path.join(SHOTS, 'm3-pinch.png') });
  const rows = await page.evaluate(() => {
    const btns = [...document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('.bar button')].filter((b) => b.getClientRects().length);
    return btns.map((b) => b.getBoundingClientRect().top).sort((x, y) => x - y).filter((t, i, a) => i === 0 || t - a[i - 1] > 8).length;
  });
  assert(rows <= 3, `toolbar still 3 rows while it says "Whole song" (${rows})`);
  await tap('button.zoom-toggle');
  assert((await host()).zoom === '', 'whole song');
  await tap('button.zoom-toggle');
  assert(Number((await host()).zoom) > 0, 'back to the DJ view');
});

await step('speed buttons by tap', async () => {
  await tap('button.speed', '50%');
  assert(Math.abs((await vstate()).rate - 0.5) < 0.001, '50%');
  await tap('button.speed', '75%');
  assert(Math.abs((await vstate()).rate - 0.75) < 0.001, '75%');
  await tap('button.speed', '100%');
});

await step('Trainer: one tap starts it at 30% over 50 loops, another tap stops it at normal speed', async () => {
  await tap('button', 'Trainer');
  await sleep(300);
  assert(Math.abs((await vstate()).rate - 0.3) < 0.001, `starts at 30% (got ${(await vstate()).rate})`);
  assert((await host()).trainer.startsWith('1/50'), 'trainer running, 50 loops');
  await page.screenshot({ path: path.join(SHOTS, 'm4-trainer.png') });
  await tap('button', 'Trainer');
  assert((await host()).trainer === '', 'stopped');
  assert(Math.abs((await vstate()).rate - 1) < 0.001, 'back to normal speed');
});

await step('play / pause button by tap', async () => {
  await tap('button.play-btn');
  assert((await vstate()).paused, 'paused');
  await tap('button.play-btn');
  await waitFor(async () => !(await vstate()).paused, 2000, 'playing');
});

await step('lyrics on the phone: above the wave, following the song', async () => {
  await tap('button', 'Lyrics');
  await waitFor(() => page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('.lyr-body p').length > 0), 5000, 'lyrics shown');
  assert(lyricsRequests.some((p) => p.track_name === 'Song PHONE001' && p.artist_name === 'Test Artist'), 'searched by song and artist');
  const m = await page.evaluate(() => {
    const h = document.getElementById('ytl-wave-looper');
    const root = h.shadowRoot;
    const ly = root.querySelector('.lyrics').getBoundingClientRect();
    const cv = root.querySelector('canvas').getBoundingClientRect();
    const btns = [...root.querySelectorAll('.bar button')].filter((b) => b.getClientRects().length);
    return {
      lyTop: ly.top, lyBottom: ly.bottom, lyH: ly.height, cvTop: cv.top, cvH: cv.height,
      panelH: h.getBoundingClientRect().height,
      panelTop: h.getBoundingClientRect().top,
      videoBottom: document.getElementById('movie_player').getBoundingClientRect().bottom,
      rows: btns.map((b) => b.getBoundingClientRect().top).sort((x, y) => x - y).filter((t, i, a) => i === 0 || t - a[i - 1] > 8).length,
      overflow: root.querySelector('.panel').scrollWidth - root.querySelector('.panel').clientWidth,
      fontPx: parseFloat(getComputedStyle(root.querySelector('.lyr-head input')).fontSize),
    };
  });
  assert(m.lyBottom <= m.cvTop + 1, 'lyrics sit above the wave');
  assert(m.lyH >= 120 && m.cvH >= 80, `both big enough (lyrics ${m.lyH}px, wave ${m.cvH}px)`);
  assert(m.videoBottom <= m.panelTop + 1, `video still visible (${m.videoBottom} vs ${m.panelTop})`);
  assert(m.rows <= 3 && m.overflow <= 1, `toolbar 3 rows, no sideways scroll (${m.rows}, ${m.overflow})`);
  assert(m.fontPx >= 16, 'search box text ≥16px so iPhone does not zoom in when typing');
  await waitFor(() => page.evaluate(() => [...document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('.lyr-body p')].some((p) => p.classList.contains('now'))), 3000, 'current line highlighted');
  await page.screenshot({ path: path.join(SHOTS, 'm5-lyrics.png') });
});

await step('loop and wave are remembered after reloading the page', async () => {
  const before = await host();
  await sleep(1200); // let the save land
  await page.reload();
  await waitFor(async () => (await host())?.vid === 'PHONE001', 8000, 'panel back');
  const h = await waitFor(async () => { const x = await host(); return x.a ? x : null; }, 5000, 'loop restored');
  assert(h.a === before.a && h.b === before.b, `loop ${h.a}-${h.b} vs ${before.a}-${before.b}`);
  await waitFor(async () => Number((await host()).cov) > 0.95, 5000, 'saved wave shown without scanning');
});

await step('close with ✕ brings the floating button back', async () => {
  await tap('button', 'Close the looper (turns loop and speed off)');
  assert((await host()).display === 'none', 'closed');
  await page.waitForSelector('.ytl-fab', { state: 'visible', timeout: 3000 });
});

await step('no console errors', async () => {
  const bad = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  assert(!bad.length, bad.join('\n'));
});

await browser.close();
console.log('\n' + results.join('\n'));
console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${results.length - failures}/${results.length} steps. Screenshots: ${SHOTS}`);
process.exit(failures ? 1 : 0);
