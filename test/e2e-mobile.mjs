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
// A stand-in for Safari's share sheet: records what would be sent (e.g. to Claude).
await ctx.addInitScript(() => {
  window.__shares = [];
  navigator.canShare = (d) => !!(d && d.files && d.files.length);
  navigator.share = async (d) => {
    for (const f of d.files) {
      const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
      window.__shares.push({ name: f.name, type: f.type, size: f.size, url });
    }
  };
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
      lyr: (() => { const r = root.querySelector('.lyrics').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, w: r.width, on: root.querySelector('.lyrics').classList.contains('top') }; })(),
    };
  });
  assert(m.lyr.on && m.lyr.top <= 1 && m.lyr.w >= 380, `lyrics on by default, across the top (${JSON.stringify(m.lyr)})`);
  assert(Math.abs(m.lyr.bottom - m.panelTop) <= 2, `lyrics fill the top half down to the panel (${m.lyr.bottom} vs ${m.panelTop})`);
  assert(m.overflow <= 1, `no sideways overflow (${m.overflow}px)`);
  assert(m.minBtn >= 36, `buttons at least 36px tall (${m.minBtn})`);
  assert(m.panelH > 844 * 0.42 && m.panelH < 844 * 0.56, `panel takes about half the screen (${m.panelH})`);
  assert(m.rows <= 4, `two short button rows above and beside the wave (${m.rows})`);
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

await step('a quick tap on the wave pauses, another tap plays; a long hold just holds', async () => {
  await page.evaluate(() => document.querySelector('#movie_player video').play());
  await sleep(300);
  const b = await waveBox();
  const x = b.x + b.w * 0.3;
  const y = b.y + 18 + (b.h - 18) * 0.5;
  await page.touchscreen.tap(x, y);
  await sleep(600); // slower than a double tap
  assert((await vstate()).paused, 'tap paused it, and it stays paused');
  await page.touchscreen.tap(x, y);
  await waitFor(async () => !(await vstate()).paused, 2000, 'second tap plays');
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await sleep(700);
  assert((await vstate()).paused, 'holding stops the music');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitFor(async () => !(await vstate()).paused, 2000, 'lifting after a hold plays on');
  assert(!(await host()).a, 'no loop made by tapping');
});

await step('double-tap the wave: first sets A there, the next sets B and the loop starts', async () => {
  await page.evaluate(() => { const v = document.querySelector('#movie_player video'); v.currentTime = 12; v.play().catch(() => {}); });
  await sleep(500);
  const b = await waveBox();
  const y = b.y + 18 + (b.h - 18) * 0.5;
  const timeAtX = async (x) => { const [vs, ve] = (await host()).view.split(',').map(Number); return vs + ((x - b.x) / b.w) * (ve - vs); };
  const doubleTap = async (x) => { await page.touchscreen.tap(x, y); await sleep(90); await page.touchscreen.tap(x, y); };
  const xa = b.x + b.w * 0.3;
  const ta = await timeAtX(xa);
  await doubleTap(xa);
  let h = await host();
  assert(h.pending && Math.abs(Number(h.pending) - ta) < 0.6, `A waits at the double-tapped spot (${h.pending} vs ~${ta.toFixed(2)})`);
  await sleep(300);
  assert(!(await vstate()).paused, 'double tap does not pause the song');
  await page.evaluate(() => document.querySelector('#movie_player video').pause());
  await sleep(700);
  const xb = b.x + b.w * 0.75;
  const tb = await timeAtX(xb);
  await doubleTap(xb);
  h = await host();
  assert(!h.pending && h.loop === 'true', 'second double tap makes the loop');
  assert(Math.abs(Number(h.b) - tb) < 0.6 && Number(h.b) > Number(h.a), `B at the double-tapped spot (${h.a}-${h.b} vs ~${tb.toFixed(2)})`);
  await waitFor(async () => !(await vstate()).paused, 2000, 'loop plays');
  const t = (await vstate()).t;
  assert(t >= Number(h.a) - 0.05 && t <= Number(h.b) + 0.15, `playing inside the loop (t=${t.toFixed(2)})`);
  await tap('button', 'Clear the loop');
  await sleep(500);
  assert(!(await host()).a, 'cleared');
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
  const b0 = Number((await host()).b);
  await tap('button', 'Move end later by 1 second');
  const b1 = Number((await host()).b);
  assert(Math.abs(b1 - b0 - 1) < 0.01, `› moves B by 1 second (${b0} -> ${b1})`);
  await tap('button', 'Move end earlier by 1 second');
  h = await host();
  assert(Math.abs(Number(h.b) - b0) < 0.01, '‹ moves it back');
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
  assert(rows <= 4, `buttons still fit while it says "Whole song" (${rows})`);
  await tap('button.zoom-toggle');
  assert((await host()).zoom === '', 'whole song');
  await tap('button.zoom-toggle');
  assert(Number((await host()).zoom) > 0, 'back to the DJ view');
});

await step('speed buttons by tap (30 / 50 / 75 / 100%)', async () => {
  await tap('button.speed', '30%');
  assert(Math.abs((await vstate()).rate - 0.3) < 0.001, '30%');
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

await step('play / pause button by tap (big)', async () => {
  const w = await page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelector('button.play-btn').getBoundingClientRect().width);
  assert(w >= 50, `play button is big (${w}px wide)`);
  await tap('button.play-btn');
  assert((await vstate()).paused, 'paused');
  await tap('button.play-btn');
  await waitFor(async () => !(await vstate()).paused, 2000, 'playing');
});

await step('lyrics: on by default at the top of the screen, big text, A−/A+ and a drag bar to resize', async () => {
  await waitFor(() => page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('.lyr-body p').length > 0), 5000, 'lyrics shown without tapping anything');
  assert(lyricsRequests.some((p) => p.track_name === 'Song PHONE001' && p.artist_name === 'Test Artist'), 'searched by song and artist');
  const info = () => page.evaluate(() => {
    const root = document.getElementById('ytl-wave-looper').shadowRoot;
    const pane = root.querySelector('.lyrics');
    const r = pane.getBoundingClientRect();
    const p = root.querySelector('.lyr-body p');
    return { top: r.top, h: r.height, font: parseFloat(getComputedStyle(p).fontSize),
      inputFont: parseFloat(getComputedStyle(root.querySelector('.lyr-head input')).fontSize),
      cvTop: root.querySelector('canvas').getBoundingClientRect().top,
      overflow: root.querySelector('.panel').scrollWidth - root.querySelector('.panel').clientWidth };
  });
  let m = await info();
  assert(m.top <= 1 && m.h > 844 * 0.38, `top of the screen, about half of it (${m.h}px)`);
  assert(m.font >= 22, `big words (${m.font}px)`);
  assert(m.inputFont >= 16, 'search box text ≥16px so iPhone does not zoom in when typing');
  assert(m.top + m.h <= m.cvTop, 'the wave stays visible below the lyrics');
  await waitFor(() => page.evaluate(() => [...document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('.lyr-body p')].some((p) => p.classList.contains('now'))), 3000, 'current line highlighted');
  await page.screenshot({ path: path.join(SHOTS, 'm5-lyrics.png') });
  const f0 = m.font;
  await tap('button', 'Bigger lyrics text');
  m = await info();
  assert(m.font > f0, `A+ makes the words bigger (${f0} -> ${m.font})`);
  await tap('button', 'Smaller lyrics text');
  await tap('button', 'Smaller lyrics text');
  m = await info();
  assert(m.font < f0, `A− makes them smaller (${m.font})`);
  await tap('button', 'Bigger lyrics text');
  // Drag the bar under the lyrics up: the lyrics area gets shorter.
  const grip = await page.evaluate(() => { const r = document.getElementById('ytl-wave-looper').shadowRoot.querySelector('.lyr-resize').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const h0 = m.h;
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: grip.x, y: grip.y, id: 1 }] });
  for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: grip.x, y: grip.y - i * 20, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  m = await info();
  assert(m.h < h0 - 80, `drag bar resizes the lyrics (${h0} -> ${m.h})`);
  assert(m.overflow <= 1, 'still no sideways scrolling');
});

await step('lyrics: tap the left side of a line to practise it (from 30%), tap again to stop', async () => {
  const where = async () => {
    await page.evaluate(() => {
      const body = document.getElementById('ytl-wave-looper').shadowRoot.querySelector('.lyr-body');
      body.dispatchEvent(new WheelEvent('wheel')); // like a finger on the lyrics: pauses auto-scroll
      const p = body.querySelectorAll('p')[3];
      body.scrollTo({ top: p.offsetTop - body.clientHeight / 2 + p.offsetHeight / 2, behavior: 'instant' });
    });
    await sleep(400); // let any smooth scroll settle
    return page.evaluate(() => {
      const r = document.getElementById('ytl-wave-looper').shadowRoot.querySelectorAll('.lyr-body p')[3].getBoundingClientRect();
      return { x: r.left + 24, y: r.top + r.height / 2 };
    });
  };
  let box = await where();
  await page.touchscreen.tap(box.x, box.y);
  let h = await host();
  assert(h.lineLoop === '6.00,8.00', `line 4 (${h.lineLoop}) ${JSON.stringify(h)}`);
  assert(Math.abs((await vstate()).rate - 0.3) < 0.001, 'starts at 30%');
  await sleep(1500);
  const t = (await vstate()).t;
  assert(t >= 5.95 && t <= 8.15, `on that line (t=${t.toFixed(2)})`);
  await page.screenshot({ path: path.join(SHOTS, 'm6-line-loop.png') });
  box = await where();
  await page.touchscreen.tap(box.x, box.y);
  h = await host();
  assert(h.lineLoop === '', 'stopped');
  assert(Math.abs((await vstate()).rate - 1) < 0.001, 'speed back to 100%');
});

await step('play / pause: one button, a little bigger than the others', async () => {
  const m = await page.evaluate(() => {
    const root = document.getElementById('ytl-wave-looper').shadowRoot;
    const p = root.querySelector('button.play-btn').getBoundingClientRect();
    const o = root.querySelector('button.speed').getBoundingClientRect();
    return { x: p.left + p.width / 2, y: p.top + p.height / 2, ph: p.height, oh: o.height, big: !!root.querySelector('.big-play') };
  });
  assert(m.ph > m.oh, `taller than the other buttons (${m.ph} vs ${m.oh})`);
  assert(!m.big, 'only one play button');
  const was = (await vstate()).paused;
  await page.touchscreen.tap(m.x, m.y);
  assert((await vstate()).paused !== was, 'tap toggles play/pause');
  if ((await vstate()).paused) await page.touchscreen.tap(m.x, m.y);
});

await step('voice call helper: pause, and 1 s later a lyrics picture goes to the share sheet (for Claude)', async () => {
  const shares = () => page.evaluate(() => window.__shares.map(({ name, type, size }) => ({ name, type, size })));
  await page.evaluate(() => { window.__shares.length = 0; document.querySelector('#movie_player video').play().catch(() => {}); });
  await sleep(1500);
  const m = await page.evaluate(() => {
    const p = document.getElementById('ytl-wave-looper').shadowRoot.querySelector('button.play-btn').getBoundingClientRect();
    return { x: p.left + p.width / 2, y: p.top + p.height / 2 };
  });
  await page.touchscreen.tap(m.x, m.y);
  assert((await vstate()).paused, 'paused');
  await sleep(500);
  assert((await shares()).length === 0, 'waits a second first');
  await waitFor(async () => (await shares()).length === 1, 2500, 'picture sent to the share sheet');
  const sh = (await shares())[0];
  assert(sh.type === 'image/png' && sh.size > 15000 && /^lyrics-.*\.png$/.test(sh.name), `a picture (${JSON.stringify(sh)})`);
  const url = await page.evaluate(() => window.__shares[0].url);
  fs.writeFileSync(path.join(SHOTS, 'm7-lyrics-picture.png'), Buffer.from(url.split(',')[1], 'base64'));
  await tap('button', 'Send a picture of the lyrics (to Claude or any app)');
  await waitFor(async () => (await shares()).length === 2, 2000, '📷 sends one right away');
  // The looper pausing by itself (breath pause, trainer finished...) sends nothing.
  await page.evaluate(() => document.querySelector('#movie_player video').play().catch(() => {}));
  await sleep(1600);
  await page.evaluate(() => document.querySelector('#movie_player video').pause());
  await sleep(1600);
  assert((await shares()).length === 2, 'no picture when you did not pause it yourself');
  // Holding the wave with a finger is not a pause.
  await page.evaluate(() => document.querySelector('#movie_player video').play().catch(() => {}));
  await sleep(500);
  const b = await waveBox();
  const cdp = await ctx.newCDPSession(page);
  const x = b.x + b.w * 0.5;
  const y = b.y + 18 + (b.h - 18) * 0.5;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await sleep(1600);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
  assert((await shares()).length === 2, 'holding the wave sends nothing');
  assert(!(await vstate()).paused, 'plays on');
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
