// End-to-end test: loads the real extension into Chromium and drives it on a
// fake YouTube watch page (test/fake-youtube.html) that streams the fixture
// media through MSE the way YouTube does, with YouTube's Trusted Types CSP.
//
// Run: npm run e2e      (needs: node tools/make-fixtures.js)
// Env: CHROME=/path/to/chrome  SHOTS=/dir/for/screenshots  HEADED=1
import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'test', 'fixtures');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'ytl-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
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

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytl-profile-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: CHROME,
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 860 },
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

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
await step('service worker starts', async () => {
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

await step('speed buttons 50% / 75% / 100% and keep-pitch', async () => {
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

await step('speed trainer: 50% to 100% over 5 loops', async () => {
  await shadowClick('button', 'Auto speed-up: start slow and reach full speed over N loops');
  await shadowSelect('Starting speed', 50);
  await shadowSelect('Goal speed', 100);
  await shadowSelect('How many loops to reach the goal', 5);
  await shadowClick('button', 'Start the speed trainer');
  const seen = [];
  await waitFor(async () => {
    const r = (await vstate()).rate;
    if (!seen.length || seen[seen.length - 1] !== r) seen.push(r);
    const h = await host();
    return h.trainer === '' || Number(h.trainer.split('/')[0]) >= 6;
  }, 30000, 'trainer reaches goal');
  await page.screenshot({ path: path.join(SHOTS, '4-trainer.png') });
  const want = [0.5, 0.63, 0.75, 0.88, 1];
  assert(JSON.stringify(seen.slice(0, 5)) === JSON.stringify(want), `rates ${JSON.stringify(seen)}`);
  const h = await host();
  assert(h.loop === 'true', 'still looping at the goal');
});

await step('picking a speed by hand stops the trainer', async () => {
  await shadowClick('button.speed', '75%');
  const h = await host();
  assert(h.trainer === '', 'trainer stopped');
  assert(Math.abs((await vstate()).rate - 0.75) < 0.001, 'rate 75%');
  await shadowClick('button.speed', '100%');
});

await step('drag the B flag to make the loop longer', async () => {
  await page.evaluate(() => document.getElementById('ytl-wave-looper').shadowRoot.querySelector('button[title="Show the whole song"]').click());
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
  assert(Math.abs(Number(h2.b) - 9) < 0.2, `B dragged to ~9 (got ${h2.b})`);
  assert(Math.abs(Number(h2.a) - Number(h.a)) < 0.001, 'A unchanged');
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
  const zoomed = await page.evaluate(() => !document.getElementById('ytl-wave-looper').shadowRoot.querySelector('button[title="Show the whole song"]').disabled);
  assert(zoomed, 'zoomed in');
  await page.screenshot({ path: path.join(SHOTS, '5-zoomed.png') });
  await shadowClick('button', 'Zoom to the loop');
  await sleep(150);
  await page.screenshot({ path: path.join(SHOTS, '6-zoom-loop.png') });
  await shadowClick('button', 'Show the whole song');
});

await step('keyboard: [ and ] set the loop from the playhead, \\ toggles it', async () => {
  if ((await host()).loop === 'true') await page.keyboard.press('Backslash'); // else the loop bounces the seek back
  await page.evaluate(() => (document.querySelector('#movie_player video').currentTime = 12));
  await sleep(300);
  await page.keyboard.press('BracketLeft');
  await sleep(1500);
  await page.keyboard.press('BracketRight');
  const h = await host();
  assert(Number(h.a) > 11.8 && Number(h.a) < 12.8, `A from playhead (${h.a})`);
  assert(Number(h.b) - Number(h.a) > 1 && Number(h.b) - Number(h.a) < 2.5, `B from playhead (${h.b})`);
  await page.keyboard.press('Backslash');
  assert((await host()).loop === 'false', 'loop toggled off');
  await page.keyboard.press('Backslash');
  assert((await host()).loop === 'true', 'loop toggled on');
});

await step('breath pause between loops', async () => {
  await clickWaveAt(14);
  await clickWaveAt(15.5);
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

await step('switching videos resets, coming back restores loop and cached wave', async () => {
  const before = await host();
  await page.evaluate(() => window.__navigate('VIDBBBB2'));
  await waitFor(async () => (await host()).vid === 'VIDBBBB2', 5000, 'new video id');
  let h = await host();
  assert(h.a === '' && h.b === '' && h.rate === '1', `reset state ${JSON.stringify(h)}`);
  // let the new video scan so the first video's scan state is not involved
  await waitFor(async () => (await host()).scanning === 'false', 40000, 'scan of video 2 done');
  await page.evaluate(() => window.__navigate('VIDAAAA1'));
  await waitFor(async () => (await host()).vid === 'VIDAAAA1', 5000, 'back to video 1');
  h = await waitFor(async () => { const x = await host(); return x.a ? x : null; }, 3000, 'loop restored');
  assert(h.a === before.a && h.b === before.b, `restored ${h.a}-${h.b} vs ${before.a}-${before.b}`);
  await waitFor(async () => Number((await host()).cov) > 0.95, 3000, 'cached waveform shown right away');
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
