// End-to-end test: real extension + Chromium + a mock open.spotify.com.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const core = require('../src/core.js');

const EXT = path.resolve(__dirname, '..');
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-spotify.html'));
// MODE=extension (default) | userscript (injected at document-start) | late (userscript injected after the page loaded)
const MODE = process.env.MODE || 'extension';
const USERSCRIPT = MODE === 'extension' ? null : fs.readFileSync(path.join(__dirname, '..', 'dist', 'spotify-line-trainer.user.js'), 'utf8');

function wav(seconds) {
  const rate = 8000, n = rate * seconds, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 220 * i / rate)), 44 + i * 2);
  return buf;
}
const AUDIO = wav(30);

const L = (ms, words) => ({ startTimeMs: String(ms), words, endTimeMs: '0', syllables: [] });
const LYRICS = {
  TRACKAAAAAAAAAAAAAAAAA: { lyrics: { syncType: 'LINE_SYNCED', lines: [L(1000, 'First line'), L(2000, 'Second line'), L(3000, 'Third line'), L(4000, '♪'), L(20000, 'Far line'), L(21000, '')] } },
  TRACKBBBBBBBBBBBBBBBBB: { lyrics: { syncType: 'LINE_SYNCED', lines: [L(1000, 'B one'), L(2000, 'B two'), L(3000, '')] } },
  TRACKUNSYNCEDAAAAAAAAA: { lyrics: { syncType: 'UNSYNCED', lines: [L(0, 'x'), L(0, 'y')] } }
};

// serve audio with HTTP Range support so the media element is seekable (like Spotify's streams)
function fulfillRange(route, buf) {
  const range = route.request().headers()['range'];
  const m = range && range.match(/bytes=(\d+)-(\d*)/);
  if (!m) return route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'accept-ranges': 'bytes' }, body: buf });
  const start = +m[1], end = m[2] ? Math.min(+m[2], buf.length - 1) : buf.length - 1;
  return route.fulfill({ status: 206, contentType: 'audio/wav', body: buf.subarray(start, end + 1),
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${buf.length}` } });
}

let lyricsRequests = [];
async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slt-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true, channel: 'chromium',
    args: [...(MODE === 'extension' ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : []), '--autoplay-policy=no-user-gesture-required']
  });
  if (MODE === 'userscript') await ctx.addInitScript({ content: USERSCRIPT });
  await ctx.route('https://open.spotify.com/**', route => {
    const url = route.request().url();
    if (url.includes('/audio/')) return fulfillRange(route, AUDIO);
    return route.fulfill({ status: 200, contentType: 'text/html', body: MOCK });
  });
  await ctx.route('https://spclient.wg.spotify.com/**', route => {
    const req = route.request();
    const url = req.url();
    const m = url.match(/color-lyrics\/v2\/track\/(\w{22})/);
    if (m) {
      lyricsRequests.push({ url, auth: req.headers()['authorization'] });
      if (req.headers()['authorization'] !== 'Bearer TESTTOKEN') return route.fulfill({ status: 401, body: '' });
      if (!LYRICS[m[1]]) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(LYRICS[m[1]]) });
    }
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: '{}' });
  });
  return ctx;
}

async function openPage(ctx, query = '') {
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('PAGE ERROR', e); process.exitCode = 1; });
  await page.goto('https://open.spotify.com/' + query);
  await afterLoad(page);
  return page;
}
async function afterLoad(page) {
  await page.waitForFunction(() => window.__player && window.__player.readyState >= 1);
  if (MODE === 'late') await page.evaluate(USERSCRIPT);
  await page.locator('#slt-root').waitFor({ state: 'attached' });
}
const ui = (page, testid) => page.locator(`#slt-root [data-testid="${testid}"]`);
const chip = (page, text) => page.locator('#slt-root .chip', { hasText: new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') });

// Sample the engine every 10ms and collapse samples into "steps".
async function record(page, until, timeoutMs) {
  return page.evaluate(async ({ until, timeoutMs }) => {
    const D = window.__SLT_DEBUG__, v = window.__player;
    const steps = []; let cur = null; const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const S = D.state;
      if (S.active) {
        const key = S.line + ':' + S.stage + ':' + S.rep;
        if (!cur || cur.key !== key) {
          cur = { key, line: S.line, stage: S.stage, rep: S.rep, rate: S.rate, wallStart: performance.now(), tMin: v.currentTime, tMax: v.currentTime, rates: new Set() };
          steps.push(cur);
        }
        cur.wallEnd = performance.now();
        cur.tMin = Math.min(cur.tMin, v.currentTime); cur.tMax = Math.max(cur.tMax, v.currentTime);
        cur.rates.add(v.playbackRate);
      }
      if (new Function('S', 'v', 'return ' + until)(S, v)) break;
      await new Promise(r => setTimeout(r, 10));
    }
    return { steps: steps.map(s => ({ ...s, rates: [...s.rates] })), final: JSON.parse(JSON.stringify({ ...D.state, timer: null })), rate: v.playbackRate, t: v.currentTime, paused: v.paused };
  }, { until, timeoutMs });
}

function checkSteps(steps, lines, settings, label) {
  const p = core.plan(settings);
  const expected = [];
  let pos = { line: 0, stage: 0, rep: 0 };
  while (!pos.done) { expected.push(pos); pos = core.advance(pos, lines.length, p); }
  assert.strictEqual(steps.length, expected.length, `${label}: expected ${expected.length} steps, got ${steps.length}: ${steps.map(s => s.key).join(' ')}`);
  steps.forEach((s, i) => {
    const e = expected[i], ln = lines[e.line], rate = p.stages[e.stage];
    assert.deepStrictEqual([s.line, s.stage, s.rep], [e.line, e.stage, e.rep], `${label}: step ${i} order`);
    assert.strictEqual(s.rate, rate, `${label}: step ${i} rate`);
    assert.ok(s.rates.every(r => Math.abs(r - rate) < 1e-6), `${label}: step ${i} element rate ${s.rates} vs ${rate}`);
    assert.ok(s.tMin >= ln.start - core.LEAD_IN - 0.12 && s.tMin <= ln.start + 0.05, `${label}: step ${i} starts at ${s.tMin.toFixed(3)} expected ~${ln.start}`);
    assert.ok(s.tMax >= ln.end - core.TAIL - 0.1 && s.tMax <= ln.end - core.TAIL + 0.1, `${label}: step ${i} ends at ${s.tMax.toFixed(3)} expected ~${ln.end - core.TAIL}`);
    if (i < steps.length - 1) {
      const wall = (steps[i + 1].wallStart - s.wallStart) / 1000;
      const want = (ln.end - core.TAIL - Math.max(s.tMin, 0)) / rate;
      assert.ok(Math.abs(wall - want) < 0.25 + want * 0.08, `${label}: step ${i} took ${wall.toFixed(2)}s wall, expected ~${want.toFixed(2)}s at ${rate}x`);
    }
  });
}

const results = [];
async function run(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(['PASS', name]); console.log(`PASS ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push(['FAIL', name]); console.log(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
}

(async () => {
  const ctx = await launch();
  const lines = core.parseLyrics(LYRICS.TRACKAAAAAAAAAAAAAAAAA, 30).lines;
  const only = process.argv[2];
  const T = (n, f) => (!only || n.includes(only)) ? run(n, f) : null;

  await T('panel appears and Start begins at line 1 (repeat 3x @ 50%)', async () => {
    const page = await openPage(ctx);
    await chip(page, '3×').click();
    await chip(page, '50%').click();
    await ui(page, 'slt-toggle').click();
    const settings = { mode: 'repeat', reps: 3, speed: 0.5 };
    // only the first two lines, then stop to keep this fast
    const r = await record(page, 'S.line === 2', 20000);
    checkSteps(r.steps.filter(s => s.line < 2), lines.slice(0, 2), settings, 'repeat');
    assert.match(await ui(page, 'slt-meta').innerText(), /Line 3\/4 · 50% · play 1\/3/);
    assert.strictEqual(await ui(page, 'slt-lyric').innerText(), 'Third line');
    await ui(page, 'slt-toggle').click(); // stop
    await page.waitForFunction(() => !window.__SLT_DEBUG__.state.active);
    assert.strictEqual(await page.evaluate(() => window.__player.playbackRate), 1, 'speed restored after stop');
    assert.strictEqual(await ui(page, 'slt-toggle').innerText(), '▶ Start');
    await page.close();
  });

  await T('training mode runs the full ladder and finishes the song', async () => {
    const page = await openPage(ctx);
    await chip(page, '🏋️ Training').click();
    await chip(page, '3×').click();
    // speed ladder: keep all 4 speeds (default)
    // Use a 2-line song to keep runtime short
    await page.evaluate(() => window.__changeTrack('TRACKBBBBBBBBBBBBBBBBB'));
    await ui(page, 'slt-toggle').click();
    const r = await record(page, 'S.fullPlay', 90000);
    const linesB = core.parseLyrics(LYRICS.TRACKBBBBBBBBBBBBBBBBB, 30).lines;
    checkSteps(r.steps, linesB, { mode: 'training', trainingReps: 3 }, 'training');
    // after the ladder: the whole song plays again from the very beginning at 100%
    assert.ok(r.t < 0.3, 'whole song restarts from 0:00, t=' + r.t);
    assert.strictEqual(r.rate, 1, 'whole-song replay at 100%');
    assert.strictEqual(r.paused, false, 'whole song is playing');
    assert.match(await ui(page, 'slt-msg').innerText(), /whole song/i);
    assert.strictEqual(await ui(page, 'slt-toggle').innerText(), '■ Stop');
    await page.waitForTimeout(2000);
    let s = await page.evaluate(() => ({ t: window.__player.currentTime, rate: window.__player.playbackRate, fp: window.__SLT_DEBUG__.state.fullPlay }));
    assert.ok(s.fp && s.t > 1.7 && s.t < 2.6 && s.rate === 1, 'plays straight through without looping: ' + JSON.stringify(s));
    // jump near the end of the song and let it finish
    await page.evaluate(() => { window.__player.currentTime = window.__player.duration - 1; });
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.finished && !window.__SLT_DEBUG__.state.fullPlay, null, { timeout: 5000 });
    assert.match(await ui(page, 'slt-msg').innerText(), /finished/i);
    assert.strictEqual(await ui(page, 'slt-toggle').innerText(), '▶ Start');
    await page.close();
  });

  await T('training without whole-song replay (option off) just finishes', async () => {
    const page = await openPage(ctx);
    await chip(page, '🏋️ Training').click();
    await chip(page, '3×').click();
    await chip(page, '30%').click(); await chip(page, '50%').click(); await chip(page, '75%').click(); // ladder = 100% only
    await ui(page, 'slt-fullsong').uncheck();
    await page.evaluate(() => window.__changeTrack('TRACKBBBBBBBBBBBBBBBBB'));
    await ui(page, 'slt-toggle').click();
    const r = await record(page, '!S.active && S.finished', 30000);
    checkSteps(r.steps, core.parseLyrics(LYRICS.TRACKBBBBBBBBBBBBBBBBB, 30).lines, { mode: 'training', trainingReps: 3, trainingSpeeds: [1] }, 'training-100');
    assert.ok(r.t > 2.5, 'no jump back to the start');
    assert.strictEqual(r.final.fullPlay, false);
    await ui(page, 'slt-fullsong').check();
    for (const c of ['30%', '50%', '75%']) await chip(page, c).click();
    await page.close();
  });

  await T('full song in repeat mode incl. long instrumental gap + ending', async () => {
    const page = await openPage(ctx);
    await chip(page, '🔁 Repeat').click();
    await chip(page, '3×').click();
    await chip(page, '100%').click();
    await ui(page, 'slt-toggle').click();
    const r = await record(page, '!S.active && S.finished', 60000);
    checkSteps(r.steps, lines, { mode: 'repeat', reps: 3, speed: 1 }, 'repeat-full');
    await page.close();
  });

  await T('next / prev / restart buttons and live settings change', async () => {
    const page = await openPage(ctx);
    await chip(page, '🔁 Repeat').click();
    await chip(page, '10×').click();
    await chip(page, '75%').click();
    await ui(page, 'slt-toggle').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active);
    await ui(page, 'slt-next').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.line === 1);
    await ui(page, 'slt-next').click();
    await ui(page, 'slt-next').click();
    await ui(page, 'slt-next').click(); // clamp at last
    await page.waitForTimeout(150);
    let s = await page.evaluate(() => ({ line: window.__SLT_DEBUG__.state.line, t: window.__player.currentTime }));
    assert.strictEqual(s.line, 3);
    assert.ok(Math.abs(s.t - (20 - core.LEAD_IN)) < 0.3, 'seeked to last line, t=' + s.t);
    await ui(page, 'slt-prev').click();
    await page.waitForTimeout(150);
    s = await page.evaluate(() => ({ line: window.__SLT_DEBUG__.state.line, t: window.__player.currentTime }));
    assert.strictEqual(s.line, 2);
    assert.ok(Math.abs(s.t - (3 - core.LEAD_IN)) < 0.3);
    // live speed change while running
    await chip(page, '30%').click();
    await page.waitForTimeout(100);
    assert.strictEqual(await page.evaluate(() => window.__player.playbackRate), 0.3);
    // restart line
    await page.waitForTimeout(600);
    await ui(page, 'slt-restart').click();
    await page.waitForTimeout(80);
    s = await page.evaluate(() => ({ line: window.__SLT_DEBUG__.state.line, rep: window.__SLT_DEBUG__.state.rep, t: window.__player.currentTime }));
    assert.strictEqual(s.line, 2); assert.strictEqual(s.rep, 0);
    assert.ok(s.t < 3.05, 'restart rewinds, t=' + s.t);
    await ui(page, 'slt-toggle').click();
    await page.close();
  });

  await T('fix timing: nudge start/end, set now, whole-song offset, join/split, saved per song', async () => {
    const page = await openPage(ctx);
    await page.evaluate(() => localStorage.clear());
    await chip(page, '🔁 Repeat').click();
    await chip(page, '10×').click();
    await chip(page, '100%').click();
    await ui(page, 'slt-toggle').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active);
    const st = () => page.evaluate(() => { const S = window.__SLT_DEBUG__.state, l = S.lines[S.line]; return { line: S.line, start: l.start, end: l.end, text: l.text, count: S.lines.length, t: window.__player.currentTime, adj: S.adj }; });
    const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg}: ${a} vs ${b}`);
    assert.strictEqual(await ui(page, 'slt-start-time').innerText(), '0:01.00');
    assert.strictEqual(await ui(page, 'slt-end-time').innerText(), '0:02.00');

    // line 1 is "cut in half": push its end later by 0.5s and check playback really goes to the new end
    await ui(page, 'slt-end+0.5').click();
    let s = await st();
    near(s.end, 2.5, 'end +0.5');
    assert.strictEqual(await ui(page, 'slt-end-time').innerText(), '0:02.50');
    assert.ok(s.t < 1.05, 'replays the line right away so you hear the change, t=' + s.t);
    let r = await record(page, 'S.rep >= 2', 6000);
    const full = r.steps.filter(x => x.rep === 1)[0];
    assert.ok(full.tMax >= 2.5 - core.TAIL - 0.1 && full.tMax <= 2.5 - core.TAIL + 0.1, 'loop now reaches the new end: ' + full.tMax);
    await ui(page, 'slt-end-0.1').click();
    await ui(page, 'slt-start+0.1').click();
    await ui(page, 'slt-start-0.5').click();
    s = await st(); near(s.start, 0.6, 'start'); near(s.end, 2.4, 'end');

    // whole-song offset moves every line
    await ui(page, 'slt-offset+0.1').click();
    await ui(page, 'slt-offset+0.1').click();
    assert.strictEqual(await ui(page, 'slt-offset').innerText(), '+0.2s');
    s = await st(); near(s.start, 0.8, 'start with offset'); near(s.end, 2.6, 'end with offset');
    const l2 = await page.evaluate(() => window.__SLT_DEBUG__.state.lines[1].start); near(l2, 2.2, 'other lines shifted too');
    await ui(page, 'slt-offset-0.1').click();
    await ui(page, 'slt-offset-0.1').click();

    // ⏺ now: set the end to the current moment
    await page.waitForFunction(() => window.__player.currentTime > 1.5 && window.__player.currentTime < 2.2);
    const t0 = await page.evaluate(() => window.__player.currentTime);
    await ui(page, 'slt-end-now').click();
    s = await st(); assert.ok(s.end > t0 - 0.01 && s.end < t0 + 0.1, `end set to now ${s.end} ~ ${t0}`);

    // join with next line, then split again
    await ui(page, 'slt-join').click();
    s = await st();
    assert.strictEqual(s.text, 'First line Second line'); assert.strictEqual(s.count, 3); near(s.end, 3, 'joined end');
    assert.strictEqual(await ui(page, 'slt-lyric').innerText(), 'First line Second line');
    await ui(page, 'slt-join').click();
    s = await st(); assert.strictEqual(s.text, 'First line Second line Third line'); assert.strictEqual(s.count, 2);
    await ui(page, 'slt-split').click();
    s = await st(); assert.strictEqual(s.text, 'First line'); assert.strictEqual(s.count, 4);
    await ui(page, 'slt-join').click();

    // saved per song: reload and start again -> same fixes
    await page.reload(); await afterLoad(page);
    await ui(page, 'slt-toggle').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active);
    s = await st();
    assert.strictEqual(s.text, 'First line Second line'); near(s.start, 0.6, 'saved start');
    // a different song is not affected
    await page.evaluate(() => window.__changeTrack('TRACKBBBBBBBBBBBBBBBBB'));
    await page.waitForFunction(() => !window.__SLT_DEBUG__.state.active);
    await ui(page, 'slt-toggle').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active);
    s = await st(); assert.strictEqual(s.text, 'B one'); near(s.start, 1, 'other song untouched');
    // reset song
    await page.evaluate(() => window.__changeTrack('TRACKAAAAAAAAAAAAAAAAA'));
    await page.waitForFunction(() => !window.__SLT_DEBUG__.state.active);
    await ui(page, 'slt-toggle').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active);
    await ui(page, 'slt-reset-song').click();
    s = await st(); assert.strictEqual(s.text, 'First line'); near(s.start, 1, 'reset'); near(s.end, 2, 'reset end');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('slt-adj:TRACKAAAAAAAAAAAAAAAAA')), null);
    // panel can fold the fix section away
    await ui(page, 'slt-fix-toggle').click();
    assert.strictEqual(await ui(page, 'slt-end+0.5').count(), 0);
    await ui(page, 'slt-fix-toggle').click();
    await ui(page, 'slt-toggle').click();
    await page.close();
  });

  await T('Spotify resetting speed and user seeking are handled', async () => {
    const page = await openPage(ctx);
    await chip(page, '🔁 Repeat').click();
    await chip(page, '5×').click();
    await chip(page, '50%').click();
    await ui(page, 'slt-toggle').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active);
    await page.evaluate(() => { window.__player.playbackRate = 1; });
    await page.waitForTimeout(80);
    assert.strictEqual(await page.evaluate(() => window.__player.playbackRate), 0.5, 'speed re-applied');
    await page.waitForTimeout(900);
    await page.evaluate(() => { window.__player.currentTime = 20.3; }); // user drags progress bar
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.line === 3, null, { timeout: 3000 });
    const s = await page.evaluate(() => ({ rep: window.__SLT_DEBUG__.state.rep, t: window.__player.currentTime }));
    assert.strictEqual(s.rep, 0);
    assert.ok(s.t < 20.2, 'snapped to start of that line, t=' + s.t);
    // pausing: engine waits, doesn't advance
    await page.evaluate(() => window.__player.pause());
    const before = await page.evaluate(() => JSON.stringify([window.__SLT_DEBUG__.state.line, window.__SLT_DEBUG__.state.rep]));
    await page.waitForTimeout(1500);
    assert.strictEqual(await page.evaluate(() => JSON.stringify([window.__SLT_DEBUG__.state.line, window.__SLT_DEBUG__.state.rep])), before);
    await page.close();
  });

  await T('start from current line; starts playback if paused', async () => {
    const page = await openPage(ctx);
    await page.evaluate(() => { window.__player.pause(); window.__player.currentTime = 2.5; });
    await chip(page, 'Current line').click();
    await ui(page, 'slt-toggle').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active);
    const s = await page.evaluate(() => ({ line: window.__SLT_DEBUG__.state.line, paused: window.__player.paused }));
    assert.strictEqual(s.line, 1);
    await page.waitForFunction(() => !window.__player.paused, null, { timeout: 2000 });
    await chip(page, 'First line').click();
    await ui(page, 'slt-toggle').click();
    await page.close();
  });

  await T('song change: stops (default) or auto-continues (option on)', async () => {
    const page = await openPage(ctx);
    await ui(page, 'slt-toggle').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active);
    await page.evaluate(() => window.__changeTrack('TRACKBBBBBBBBBBBBBBBBB'));
    await page.waitForFunction(() => !window.__SLT_DEBUG__.state.active);
    assert.match(await ui(page, 'slt-msg').innerText(), /Song changed/);
    assert.strictEqual(await page.evaluate(() => window.__player.playbackRate), 1);

    await ui(page, 'slt-autonext').check();
    await ui(page, 'slt-toggle').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active && window.__SLT_DEBUG__.state.trackId === 'TRACKBBBBBBBBBBBBBBBBB');
    await page.evaluate(() => window.__changeTrack('TRACKAAAAAAAAAAAAAAAAA'));
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active && window.__SLT_DEBUG__.state.trackId === 'TRACKAAAAAAAAAAAAAAAAA' && window.__SLT_DEBUG__.state.line === 0);
    // whole-song replay, then Spotify moves to the next song -> training continues on it
    await page.evaluate(() => { const S = window.__SLT_DEBUG__.state; S.settings.mode = 'training'; });
    await page.evaluate(() => { const S = window.__SLT_DEBUG__.state; S.active = false; S.fullPlay = true; });
    await page.evaluate(() => window.__changeTrack('TRACKBBBBBBBBBBBBBBBBB'));
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active && window.__SLT_DEBUG__.state.trackId === 'TRACKBBBBBBBBBBBBBBBBB' && !window.__SLT_DEBUG__.state.fullPlay);
    await ui(page, 'slt-autonext').uncheck();
    await ui(page, 'slt-toggle').click();
    await page.close();
  });

  await T('error messages: no lyrics, unsynced lyrics', async () => {
    const page = await openPage(ctx);
    await page.evaluate(() => window.__changeTrack('TRACKNOLYRICSAAAAAAAAA'));
    await ui(page, 'slt-toggle').click();
    await ui(page, 'slt-msg').filter({ hasText: 'no lyrics' }).waitFor();
    await page.evaluate(() => window.__changeTrack('TRACKUNSYNCEDAAAAAAAAA'));
    await ui(page, 'slt-toggle').click();
    await ui(page, 'slt-msg').filter({ hasText: 'not time-synced' }).waitFor();
    assert.strictEqual(await ui(page, 'slt-toggle').innerText(), '▶ Start');
    await page.close();
  });

  await T('fallback: no token captured -> uses Spotify lyrics button', async () => {
    lyricsRequests = [];
    const page = await openPage(ctx, '?noauth');
    await ui(page, 'slt-toggle').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.active, null, { timeout: 8000 });
    assert.ok(lyricsRequests.some(r => r.url.includes('/image/')), 'lyrics came from Spotify\'s own request');
    await ui(page, 'slt-toggle').click();
    await page.close();
  });

  await T('settings persist after reload + minimize', async () => {
    const page = await openPage(ctx);
    await chip(page, '🏋️ Training').click();
    await chip(page, '7×').click();
    await chip(page, '50%').click(); // remove 50% from ladder
    await page.reload();
    await afterLoad(page);
    await page.locator('#slt-root .chip.sel').first().waitFor();
    const sel = await page.locator('#slt-root .chip.sel').allInnerTexts();
    assert.deepStrictEqual(sel, ['🏋️ Training', '7×', '30%', '75%', '100%', 'First line']);
    assert.strictEqual(await ui(page, 'slt-fullsong').isChecked(), true);
    await page.locator('#slt-root .icon').click();
    await ui(page, 'slt-fab').click();
    await ui(page, 'slt-panel').waitFor();
    await page.close();
  });

  if (only === 'screenshot') await run('screenshot', async () => {
    const page = await openPage(ctx);
    await page.setViewportSize({ width: 420, height: 1000 });
    await chip(page, '🏋️ Training').click();
    await chip(page, '5×').click();
    await ui(page, 'slt-toggle').click();
    await page.waitForFunction(() => window.__SLT_DEBUG__.state.rep === 1);
    await page.locator('#slt-root .panel').screenshot({ path: path.join(__dirname, '..', 'screenshot.png') });
    await page.close();
  });

  await ctx.close();
  console.log(`\n[${MODE}] ${results.filter(r => r[0] === 'PASS').length}/${results.length} e2e tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
