// End-to-end tests for the standalone app at iPad size, against a mock LRCLIB.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const core = require('../../spotify-line-trainer/src/core.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'dist', 'line-trainer.html'));
const SR = 16000;

// Song with a quiet bass hum (ignored by analysis) and "voice" tone bursts starting `shift`
// seconds after each lyric timestamp (to test 🎯 auto-sync). extraShift moves single lines.
function makeSong(seconds, starts, shift, extraShift = {}, beat = 0) {
  const n = SR * seconds, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const bursts = starts.map((s, i) => s + shift + (extraShift[i] || 0));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0.15 * Math.sin(2 * Math.PI * 70 * t); // bass hum
    if (beat) { // drum: a sharp noisy hit every 0.5 s (kick + snare-ish), louder than the voice
      const d = (t + 0.13) % 0.5;
      if (d < 0.08) v += beat * Math.exp(-d * 60) * (Math.random() * 2 - 1);
    }
    for (const b of bursts) {
      const d = t - b;
      if (d >= 0 && d < 1.2) v += 0.5 * Math.min(1, d / 0.01) * Math.min(1, (1.2 - d) / 0.05) * (Math.sin(2 * Math.PI * 660 * t) + 0.5 * Math.sin(2 * Math.PI * 1320 * t));
    }
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 20000))), 44 + i * 2);
  }
  return buf;
}
const lrc = (pairs) => pairs.map(([t, w]) => `[${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}] ${w}`).join('\n');

const A_STARTS = [2, 5, 8, 11, 14];
const A_LRC = lrc([[2, 'First line here'], [5, 'Second line here'], [8, 'Third line here'], [11, 'Fourth line here'], [14, 'Fifth line here'], [17, '']]);
const SONG_A = makeSong(24, A_STARTS, 1.3, { 2: 0.2 });
const B_LRC = lrc([[1, 'Short one'], [2, 'Short two'], [3, '']]);
const SONG_B = makeSong(12, [1, 2], 0);
const SONG_A_EXACT = makeSong(24, A_STARTS, 0); // the YouTube "Topic" upload: same recording as Spotify

// Stand-in for YouTube's IFrame API: an <audio> inside #yt, with getCurrentTime only updated every 250 ms like the real one.
const YT_MOCK = `
window.YT = { Player: function (id, opts) {
  const host = document.getElementById(id); const a = document.createElement('audio'); host.appendChild(a);
  const self = this; let state = -1, reported = 0;
  const set = s => { state = s; opts.events.onStateChange && opts.events.onStateChange({ data: s, target: self }); };
  a.addEventListener('playing', () => set(1)); a.addEventListener('pause', () => { if (!a.ended) set(2); }); a.addEventListener('ended', () => set(0));
  setInterval(() => { reported = a.currentTime; }, 250);
  this.getCurrentTime = () => reported;
  this.seekTo = t => { a.currentTime = t; reported = t; };
  this.setPlaybackRate = r => { a.playbackRate = Math.round(r * 20) / 20; };
  this.getPlaybackRate = () => a.playbackRate;
  this.playVideo = () => { a.play(); }; this.pauseVideo = () => a.pause();
  this.getDuration = () => a.duration || 0;
  this.cueVideoById = v => { a.src = '/ytaudio/' + v + '.wav'; a.addEventListener('loadedmetadata', () => set(5), { once: true }); };
  window.__ytAudio = a; window.__ytVideo = opts.videoId;
  a.addEventListener('loadedmetadata', () => opts.events.onReady && opts.events.onReady({ target: self }), { once: true });
  a.src = '/ytaudio/' + opts.videoId + '.wav';
} };
setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 10);`;
const C_STARTS = [2.4, 6.1, 9.3, 13.7, 17.2, 21.9, 25.5];
const C_LRC = lrc(C_STARTS.map((t, i) => [t, 'Beat line ' + (i + 1)]).concat([[29, '']]));
const SONG_C = makeSong(32, C_STARTS, 0.8, {}, 0.9);

let lrclibCalls = 0, lrclibDown = false;
let nowPlaying = null; // what the fake Spotify (via fake Last.fm) is playing
const LRCLIB_DB = [
  { id: 1, trackName: 'Test Song', artistName: 'Test Artist', albumName: 'Album', duration: 24, syncedLyrics: A_LRC, plainLyrics: 'x' },
  { id: 2, trackName: 'Test Song (Live)', artistName: 'Test Artist', albumName: 'Live', duration: 260, syncedLyrics: '[00:01.00] wrong version', plainLyrics: 'x' },
  { id: 3, trackName: 'Test Song', artistName: 'Someone', albumName: '', duration: 24, syncedLyrics: null, plainLyrics: 'no timing' },
  { id: 5, trackName: 'Beat Song', artistName: 'Drums', albumName: '', duration: 32, syncedLyrics: C_LRC, plainLyrics: 'x' },
  { id: 4, trackName: 'Short Song', artistName: 'Band', albumName: '', duration: 12, syncedLyrics: B_LRC, plainLyrics: 'x' }
];

async function launch(existing) {
  const browser = existing || await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: false });
  await ctx.route('https://app.test/**', r => {
    if (r.request().url().includes('/ytaudio/')) return r.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'accept-ranges': 'bytes' }, body: SONG_A_EXACT });
    return r.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  });
  await ctx.route('https://www.youtube.com/iframe_api', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: YT_MOCK }));
  await ctx.route('https://open.spotify.com/oembed**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ title: 'Test Song', thumbnail_url: 'x' }) }));
  await ctx.route('https://pipedapi.kavin.rocks/**', r => r.fulfill({ status: 500, body: 'down' })); // first search server is down
  await ctx.route('https://pipedapi.adminforge.de/**', r => {
    const q = new URL(r.request().url()).searchParams.get('q').toLowerCase();
    const items = q.includes('short') ? [{ url: '/watch?v=SHORTxxxxx3', title: 'Short Song', uploaderName: 'Band - Topic', duration: 12 }] : [
      { url: '/watch?v=VIDEOxxxxx1', title: 'Test Song (Official Music Video)', uploaderName: 'TestVEVO', duration: 31 },
      { url: '/watch?v=TOPICxxxxx2', title: 'Test Song', uploaderName: 'Test Artist - Topic', duration: 24 }];
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ items }) });
  });
  await ctx.route('https://ws.audioscrobbler.com/**', r => {
    const u = new URL(r.request().url());
    const h = { 'access-control-allow-origin': '*' };
    if (u.searchParams.get('api_key') !== 'GOODKEY') return r.fulfill({ status: 403, contentType: 'application/json', headers: h, body: JSON.stringify({ error: 10, message: 'Invalid API key - You must be granted a valid key by last.fm' }) });
    const track = nowPlaying
      ? [{ name: nowPlaying[1], artist: { '#text': nowPlaying[0] }, album: { '#text': '' }, '@attr': { nowplaying: 'true' } }, { name: 'Old', artist: { '#text': 'Old' }, album: { '#text': '' } }]
      : [{ name: 'Old', artist: { '#text': 'Old' }, album: { '#text': '' }, date: { uts: '1' } }];
    return r.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ recenttracks: { track, '@attr': { user: 'me' } } }) });
  });
  await ctx.route('https://lrclib.net/**', r => {
    lrclibCalls++;
    if (lrclibDown) return r.abort();
    const q = new URL(r.request().url()).searchParams.get('q').toLowerCase();
    const hits = LRCLIB_DB.filter(x => q.split(/\s+/).some(w => w.length > 2 && x.trackName.toLowerCase().includes(w)));
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(hits) });
  });
  return { browser, ctx };
}

const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lt-'));
const fA = path.join(dir, 'Test Artist - Test Song.wav'); fs.writeFileSync(fA, SONG_A);
const fB = path.join(dir, '03 - Short Song.wav'); fs.writeFileSync(fB, SONG_B);
const fX = path.join(dir, 'Unknown Thing.wav'); fs.writeFileSync(fX, SONG_B);
const fC = path.join(dir, 'Drums - Beat Song.wav'); fs.writeFileSync(fC, SONG_C);

async function openApp(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('PAGE ERROR', e.message); process.exitCode = 1; });
  await page.goto('https://app.test/');
  return page;
}
async function openSong(page, file) {
  await page.setInputFiles('#file', file);
  await page.waitForFunction(() => window.__LT__.lines.length > 0, null, { timeout: 15000 });
  await page.waitForFunction(() => !/Listening/.test(window.__LT__.E.message), null, { timeout: 15000 });
}
const chip = (page, text) => page.locator('#panel .chip', { hasText: new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') });
const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
async function openFix(page) { if (!(await tid(page, 'offset').count())) await tid(page, 'fixopen').click(); }

async function record(page, until, timeoutMs) {
  return page.evaluate(async ({ until, timeoutMs }) => {
    const L = window.__LT__, a = L.audio; const steps = []; let cur = null; const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const E = L.E;
      if (E.active) {
        const key = E.line + ':' + E.stage + ':' + E.rep;
        if (!cur || cur.key !== key) { cur = { key, line: E.line, stage: E.stage, rep: E.rep, rate: E.rate, wallStart: performance.now(), tMin: a.currentTime, tMax: a.currentTime, rates: new Set() }; steps.push(cur); }
        cur.tMin = Math.min(cur.tMin, a.currentTime); cur.tMax = Math.max(cur.tMax, a.currentTime); cur.rates.add(a.playbackRate);
      }
      if (new Function('E', 'a', 'return ' + until)(E, a)) break;
      await new Promise(r => setTimeout(r, 10));
    }
    return { steps: steps.map(s => ({ ...s, rates: [...s.rates] })), lines: L.lines.map(l => ({ start: l.start, end: l.end })), t: a.currentTime, rate: a.playbackRate, paused: a.paused, fullPlay: L.E.fullPlay };
  }, { until, timeoutMs });
}
function checkSteps(steps, lines, settings, label) {
  const p = core.plan(settings);
  const expected = []; let pos = { line: 0, stage: 0, rep: 0 };
  while (!pos.done) { expected.push(pos); pos = core.advance(pos, lines.length, p); }
  assert.strictEqual(steps.length, expected.length, `${label}: expected ${expected.length} steps, got ${steps.length}: ${steps.map(s => s.key).join(' ')}`);
  steps.forEach((s, i) => {
    const e = expected[i], ln = lines[e.line], rate = p.stages[e.stage];
    assert.deepStrictEqual([s.line, s.stage, s.rep], [e.line, e.stage, e.rep], `${label}: step ${i}`);
    assert.ok(s.rates.every(r => Math.abs(r - rate) < 1e-6), `${label}: step ${i} rate ${s.rates} vs ${rate}`);
    assert.ok(Math.abs(s.tMin - (ln.start - core.LEAD_IN)) < 0.12, `${label}: step ${i} starts ${s.tMin.toFixed(3)} vs ${ln.start}`);
    assert.ok(Math.abs(s.tMax - (ln.end - core.TAIL)) < 0.12, `${label}: step ${i} ends ${s.tMax.toFixed(3)} vs ${ln.end - core.TAIL}`);
    if (i < steps.length - 1) {
      const wall = (steps[i + 1].wallStart - s.wallStart) / 1000, want = (ln.end - core.TAIL - s.tMin) / rate;
      assert.ok(Math.abs(wall - want) < 0.25 + want * 0.08, `${label}: step ${i} took ${wall.toFixed(2)}s, want ${want.toFixed(2)}s`);
    }
  });
}

const results = [];
async function run(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(1); console.log(`PASS ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push(0); console.log(`FAIL ${name}\n  ${e.message.split('\n').slice(0, 8).join(' | ')}`); process.exitCode = 1; }
}

(async () => {
  const { browser } = await launch();
  let ctx;
  const only = process.argv[2];
  // every test gets a fresh browser profile (no saved songs/settings from other tests)
  const T = async (n, f) => {
    if (only && !n.includes(only)) return;
    ctx = (await launch(browser)).ctx;
    await run(n, f);
    await ctx.close();
  };

  await T('open song: reads name, finds the right synced lyrics, auto-syncs to the voice (+1.3s)', async () => {
    const page = await openApp(ctx);
    await openSong(page, fA);
    const s = await page.evaluate(() => ({ n: window.__LT__.lines.length, off: window.__LT__.adj.offset, first: window.__LT__.lines[0], msg: window.__LT__.E.message }));
    assert.strictEqual(s.n, 5, 'picked the studio version (5 lines), not the live one');
    assert.ok(Math.abs(s.off - 1.3) <= 0.04, 'auto-sync offset ' + s.off);
    assert.ok(Math.abs(s.first.start - 3.3) <= 0.04);
    assert.match(s.msg, /Synced to the audio/);
    assert.match(await page.locator('#songinfo').innerText(), /Test Song — Test Artist/);
    assert.strictEqual(await page.locator('#lyrics .ly').count(), 5);
    await page.close();
  });

  await T('auto-sync with a loud drum beat in the mix: right offset or no change, never a wrong one', async () => {
    const page = await openApp(ctx);
    await openSong(page, fC);
    const off = await page.evaluate(() => window.__LT__.adj.offset);
    console.log('    drum-mix offset found:', off);
    assert.ok(off === undefined || Math.abs(off - 0.8) <= 0.04, 'offset ' + off);
    await page.close();
  });

  await T('Spotify link → right song → same-length YouTube upload → loops in sync (YouTube time is coarse)', async () => {
    const page = await openApp(ctx);
    await tid(page, 'spot').click();
    await tid(page, 'spot-in').fill('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc123');
    await tid(page, 'spot-go').click();
    await page.locator('#spotBody [data-pick]').first().waitFor();
    assert.match(await tid(page, 'spot-note').innerText(), /Spotify song: “Test Song”/);
    await page.locator('#spotBody [data-pick]', { hasText: 'Test Artist' }).first().click();
    await page.waitForFunction(() => window.__LT__.lines.length === 5 && window.__LT__.P.kind === 'yt', null, { timeout: 15000 });
    assert.strictEqual(await page.evaluate(() => window.__ytVideo), 'TOPICxxxxx2', 'picked the Topic upload (same length as Spotify)');
    assert.strictEqual(await page.locator('#spotModal').isHidden(), true);
    assert.ok(await page.locator('#ytwrap').isVisible(), 'YouTube player is shown');
    await chip(page, '3×').click(); await chip(page, '50%').click();
    await tid(page, 'toggle').click();
    const r = await page.evaluate(async () => {
      const L = window.__LT__, a = window.__ytAudio; const steps = []; let cur = null; const t0 = performance.now();
      while (performance.now() - t0 < 30000 && L.E.line < 1) {
        const key = L.E.line + ':' + L.E.rep;
        if (!cur || cur.key !== key) { cur = { key, tMin: a.currentTime, tMax: a.currentTime, rate: a.playbackRate }; steps.push(cur); }
        cur.tMin = Math.min(cur.tMin, a.currentTime); cur.tMax = Math.max(cur.tMax, a.currentTime);
        await new Promise(r => setTimeout(r, 10));
      }
      return { steps, line: L.lines[0] };
    });
    assert.deepStrictEqual(r.steps.map(x => x.key), ['0:0', '0:1', '0:2']);
    for (const st of r.steps) {
      assert.strictEqual(st.rate, 0.5);
      assert.ok(Math.abs(st.tMin - (r.line.start - core.LEAD_IN)) < 0.15, 'starts ' + st.tMin);
      assert.ok(Math.abs(st.tMax - (r.line.end - core.TAIL)) < 0.15, 'ends on time despite coarse YouTube clock: ' + st.tMax + ' vs ' + (r.line.end - core.TAIL));
    }
    await tid(page, 'toggle').click();
    // saved in the library as a YouTube song
    const lib = await page.evaluate(() => window.__LT__.library());
    assert.ok(lib.some(x => x.key === 'yt:TOPICxxxxx2' && x.type === 'yt'));
    await page.close();
  });

  await T('Follow my Spotify: detects what Spotify plays and loads it by itself', async () => {
    nowPlaying = null;
    const page = await openApp(ctx);
    await tid(page, 'follow').click();
    await tid(page, 'fm-user').fill('me');
    await tid(page, 'fm-key').fill('BADKEY');
    await tid(page, 'fm-start').click();
    await page.waitForFunction(() => /Invalid API key/.test(document.querySelector('[data-testid=fm-note]').textContent));
    await tid(page, 'fm-key').fill('GOODKEY');
    await tid(page, 'fm-start').click();
    await page.waitForFunction(() => /Waiting for Spotify/.test(document.querySelector('#npbar').textContent));
    // play a song in "Spotify"
    nowPlaying = ['Test Artist', 'Test Song'];
    await page.evaluate(() => window.__LT__.pollSpotify());
    await page.waitForFunction(() => window.__LT__.lines.length === 5 && window.__ytVideo === 'TOPICxxxxx2' && /ready/.test(document.querySelector('#npbar').textContent), null, { timeout: 15000 });
    assert.match(await page.locator('#songinfo').innerText(), /Test Song — Test Artist/);
    // next song in Spotify -> switches by itself
    nowPlaying = ['Band', 'Short Song'];
    await page.evaluate(() => window.__LT__.pollSpotify());
    await page.waitForFunction(() => window.__LT__.lines.length === 2 && /Short Song/.test(document.querySelector('#songinfo').textContent), null, { timeout: 15000 });
    // while training, a new Spotify song does not interrupt; it offers a switch
    await tid(page, 'toggle').click();
    nowPlaying = ['Test Artist', 'Test Song'];
    await page.evaluate(() => window.__LT__.pollSpotify());
    await tid(page, 'np-switch').waitFor();
    assert.strictEqual(await page.evaluate(() => window.__LT__.E.active), true, 'training kept going');
    await tid(page, 'np-switch').click();
    await page.waitForFunction(() => window.__LT__.lines.length === 5 && !window.__LT__.E.active, null, { timeout: 15000 });
    // remembered after reload
    await page.reload();
    await page.waitForFunction(() => /Following/.test(document.querySelector('[data-testid=follow]').textContent));
    nowPlaying = null;
    await page.close();
  });

  await T('Spotify box: bad links and YouTube fallback', async () => {
    const page = await openApp(ctx);
    const ids = await page.evaluate(() => [window.__LT__.spotifyTrackId('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC'), window.__LT__.spotifyTrackId('spotify:track:4uLU6hMCjMI75M1A2tKUQC'),
      window.__LT__.youtubeId('https://youtu.be/dQw4w9WgXcQ?t=3'), window.__LT__.youtubeId('https://www.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ'), window.__LT__.spotifyTrackId('https://example.com')]);
    assert.deepStrictEqual(ids, ['4uLU6hMCjMI75M1A2tKUQC', '4uLU6hMCjMI75M1A2tKUQC', 'dQw4w9WgXcQ', 'dQw4w9WgXcQ', null]);
    await tid(page, 'spot').click();
    await tid(page, 'spot-in').fill('https://example.com/whatever');
    await tid(page, 'spot-go').click();
    await page.waitForFunction(() => /isn't a Spotify song link/.test(document.querySelector('[data-testid=spot-note]')?.textContent || ''));
    // typed name; YouTube search fails -> paste a link instead
    await ctx.route('https://pipedapi.adminforge.de/**', r => r.fulfill({ status: 500, body: '' }));
    await tid(page, 'spot-in').fill('test song');
    await tid(page, 'spot-go').click();
    await page.locator('#spotBody [data-pick]', { hasText: 'Test Artist' }).first().click();
    await tid(page, 'yt-in').waitFor();
    await page.waitForFunction(() => /Paste a YouTube link/.test(document.querySelector('[data-testid=spot-note]')?.textContent || ''), null, { timeout: 30000 });
    await tid(page, 'yt-in').fill('https://www.youtube.com/watch?v=MANUALxxx33');
    await tid(page, 'yt-use').click();
    await page.waitForFunction(() => window.__LT__.lines.length === 5 && window.__ytVideo === 'MANUALxxx33', null, { timeout: 15000 });
    await page.close();
  });

  await T('practice: speeds up 30%→100% over N plays, then N at 100%, per line', async () => {
    const page = await openApp(ctx);
    await openSong(page, fB);
    await chip(page, '🎯 Practice').click();
    await page.locator('[data-act=pramp][data-v="5"]').click();
    await page.locator('[data-act=pnorm][data-v="5"]').click();
    await page.locator('[data-act=prest][data-v="0"]').click();
    await tid(page, 'toggle').click();
    const r = await record(page, '!E.active', 60000);
    checkSteps(r.steps, r.lines, { mode: 'practice', practiceRamp: 5, practiceNormal: 5, practiceRest: 0 }, 'practice');
    assert.deepStrictEqual(r.steps.slice(0, 10).map(x => x.rate), [0.3, 0.44, 0.58, 0.72, 0.86, 1, 1, 1, 1, 1]);
    assert.match(await tid(page, 'msg').innerText(), /finished/);
    await page.close();
  });

  await T('practice rest: pauses between lines with a countdown, skip works', async () => {
    const page = await openApp(ctx);
    await openSong(page, fB);
    await chip(page, '🎯 Practice').click();
    await page.locator('[data-act=pramp][data-v="5"]').click();
    await page.locator('[data-act=pnorm][data-v="5"]').click();
    await page.locator('[data-act=prest][data-v="20"]').click();
    await tid(page, 'toggle').click();
    await page.waitForFunction(() => window.__LT__.E.restUntil > 0, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => ({ paused: window.__LT__.audio.paused, line: window.__LT__.E.line, left: (window.__LT__.E.restUntil - performance.now()) / 1000 }));
    assert.ok(s.paused, 'music paused during rest'); assert.strictEqual(s.line, 1);
    assert.ok(s.left > 17 && s.left < 19, 'about 18s left: ' + s.left);
    assert.match(await tid(page, 'rest').innerText(), /Rest: 1[789]s/);
    await tid(page, 'skiprest').click();
    await page.waitForFunction(() => !window.__LT__.E.restUntil && !window.__LT__.audio.paused);
    const t = await page.evaluate(() => ({ t: window.__LT__.audio.currentTime, s: window.__LT__.lines[1].start, rate: window.__LT__.audio.playbackRate }));
    assert.ok(Math.abs(t.t - t.s) < 0.25 && t.rate === 0.3, 'line 2 starts again at 30%');
    await tid(page, 'toggle').click();
    await page.close();
  });

  await T('auto next song: finishing one song starts the next one in the Library', async () => {
    const page = await openApp(ctx);
    await openSong(page, fB);
    await openSong(page, fA);
    await tid(page, 'lib').click();
    await page.locator('#libList .res', { hasText: 'Short Song' }).locator('.t').click();
    await page.waitForFunction(() => window.__LT__.lines.length === 2);
    await chip(page, '🔁 Repeat').click(); await chip(page, '3×').click(); await chip(page, '100%').click();
    await tid(page, 'autonext').check();
    await tid(page, 'toggle').click();
    await page.waitForFunction(() => window.__LT__.E.active && window.__LT__.lines.length === 5, null, { timeout: 30000 });
    assert.match(await page.locator('#songinfo').innerText(), /Test Song/);
    assert.match(await tid(page, 'msg').innerText(), /Now training/);
    await tid(page, 'toggle').click();
    await page.close();
  });

  await T('repeat 3× at 50%: exact loops of each line', async () => {
    const page = await openApp(ctx);
    await openSong(page, fA);
    await chip(page, '3×').click(); await chip(page, '50%').click();
    await tid(page, 'toggle').click();
    const r = await record(page, 'E.line === 2', 60000);
    if (process.env.DBG) console.log(JSON.stringify(r.steps.map(x => [x.key, x.tMin.toFixed(2), x.tMax.toFixed(2), x.rates])), JSON.stringify(r.lines));
    checkSteps(r.steps.filter(s => s.line < 2), r.lines.slice(0, 2), { mode: 'repeat', reps: 3, speed: 0.5 }, 'repeat');
    assert.match(await tid(page, 'meta').innerText(), /Line 3\/5 · 50% · play 1\/3/);
    assert.strictEqual(await page.locator('#lyrics .ly.loop').innerText(), 'Third line here');
    await tid(page, 'toggle').click();
    assert.strictEqual(await page.evaluate(() => window.__LT__.audio.playbackRate), 1);
    await page.close();
  });

  await T('training: 30→50→75→100% ladder for every line, then the whole song once', async () => {
    const page = await openApp(ctx);
    await openSong(page, fB);
    await chip(page, '🏋️ Training').click(); await chip(page, '3×').click();
    await tid(page, 'toggle').click();
    const r = await record(page, 'E.fullPlay', 60000);
    checkSteps(r.steps, r.lines, { mode: 'training', trainingReps: 3 }, 'training');
    assert.ok(r.t < 0.3 && r.rate === 1 && !r.paused, 'whole song from 0:00 at 100%');
    await page.evaluate(() => { const a = window.__LT__.audio; a.currentTime = a.duration - 0.5; });
    await page.waitForFunction(() => !window.__LT__.E.fullPlay, null, { timeout: 5000 });
    assert.match(await tid(page, 'msg').innerText(), /complete/);
    await page.close();
  });

  await T('snap each line: finds the one line whose voice is 0.2s late', async () => {
    const page = await openApp(ctx);
    await openSong(page, fA);
    await openFix(page);
    await tid(page, 'snap').click();
    await page.waitForFunction(() => /Moved|already/.test(window.__LT__.E.message), null, { timeout: 15000 });
    const adj = await page.evaluate(() => window.__LT__.adj);
    const moved = Object.entries(adj.lines || {});
    assert.strictEqual(moved.length, 1, 'only one line moved: ' + JSON.stringify(adj.lines));
    assert.strictEqual(moved[0][0], '2');
    assert.ok(Math.abs(moved[0][1].ds - 0.2) <= 0.04, 'moved by ' + moved[0][1].ds);
    await tid(page, 'reset').click();
    await page.waitForFunction(() => window.__LT__.adj.offset === 1.3 && !window.__LT__.adj.lines, null, { timeout: 8000 });
    await page.close();
  });

  await T('fix timing buttons, join/split, tap a lyric to jump', async () => {
    const page = await openApp(ctx);
    await openSong(page, fA);
    await chip(page, '10×').click(); await chip(page, '100%').click();
    await tid(page, 'toggle').click();
    await openFix(page);
    const L = () => page.evaluate(() => { const l = window.__LT__.lines[window.__LT__.E.line]; return { i: window.__LT__.E.line, start: l.start, end: l.end, text: l.text, n: window.__LT__.lines.length, t: window.__LT__.audio.currentTime }; });
    let s0 = await L();
    await tid(page, 'end+0.5').click();
    let s = await L(); assert.ok(Math.abs(s.end - s0.end - 0.5) < 0.011, 'end +0.5');
    await tid(page, 'start-0.1').click();
    s = await L(); assert.ok(Math.abs(s.start - s0.start + 0.1) < 0.011, 'start -0.1');
    await tid(page, 'offset+0.1').click();
    assert.strictEqual(await tid(page, 'offset').innerText(), '+1.4s');
    await tid(page, 'join').click();
    s = await L(); assert.strictEqual(s.text, 'First line here Second line here'); assert.strictEqual(s.n, 4);
    await tid(page, 'split').click();
    s = await L(); assert.strictEqual(s.n, 5);
    // tap the 4th lyric line while training -> loops that line
    await page.locator('#lyrics .ly').nth(3).click();
    s = await L(); assert.strictEqual(s.i, 3); assert.ok(Math.abs(s.t - (s.start - core.LEAD_IN)) < 0.15, 'jumped to line 4');
    await tid(page, 'toggle').click();
    // tap a lyric while not training -> plays from there
    await page.locator('#lyrics .ly').nth(1).click();
    await page.waitForTimeout(100);
    const t = await page.evaluate(() => ({ t: window.__LT__.audio.currentTime, p: window.__LT__.audio.paused, s: window.__LT__.lines[1].start }));
    assert.ok(Math.abs(t.t - t.s) < 0.3 && !t.p, 'plays from tapped line');
    await page.close();
  });

  await T('library + saved lyrics/fixes: reopen after reload without picking the file or searching again', async () => {
    const page = await openApp(ctx);
    await openSong(page, fA);
    await openFix(page);
    await tid(page, 'offset+0.1').click();
    await page.reload();
    const before = lrclibCalls;
    await tid(page, 'lib').click();
    await page.locator('#libList .res', { hasText: 'Test Song' }).first().locator('.t').click();
    await page.waitForFunction(() => window.__LT__.lines.length === 5);
    assert.strictEqual(lrclibCalls, before, 'no new lyrics search');
    assert.ok(Math.abs(await page.evaluate(() => window.__LT__.adj.offset) - 1.4) < 0.05, 'fixes kept');
    await page.close();
  });

  await T('manual search, unsynced results disabled, paste LRC', async () => {
    const page = await openApp(ctx);
    await page.setInputFiles('#file', fX); // nothing matches "Unknown Thing"
    await page.waitForSelector('#findModal:not([hidden])');
    await tid(page, 'q').fill('test song');
    await tid(page, 'search').click();
    await page.waitForSelector('#results .res');
    assert.strictEqual(await page.locator('#results .res[disabled]').count(), 1, 'no-timing result disabled');
    await page.locator('#findModal summary').click();
    await tid(page, 'lrc').fill('[00:01.00] Pasted one\n[00:02.00] Pasted two\n[00:03.00]');
    await tid(page, 'paste').click();
    await page.waitForFunction(() => window.__LT__.lines.length === 2);
    assert.strictEqual(await page.locator('#findModal').isHidden(), true);
    assert.strictEqual(await page.locator('#lyrics .ly').first().innerText(), 'Pasted one');
    await page.close();
  });

  await T('lyrics service unreachable -> clear message', async () => {
    lrclibDown = true;
    const page = await openApp(ctx);
    await page.evaluate(() => localStorage.clear());
    await page.setInputFiles('#file', fB);
    await page.waitForFunction(() => /Couldn't reach/.test(window.__LT__.E.message), null, { timeout: 8000 });
    lrclibDown = false;
    await page.close();
  });

  await T('LRC parser handles multi-timestamps, offsets, word tags', async () => {
    const page = await openApp(ctx);
    const r = await page.evaluate(() => window.__LT__.parseLrc('[ar:x]\n[offset:+500]\n[00:10.00][00:20.50]Chorus <00:10.20>word\n[01:02.3]Late'));
    assert.deepStrictEqual(r.lyrics.lines, [
      { startTimeMs: '9500', words: 'Chorus word' }, { startTimeMs: '20000', words: 'Chorus word' }, { startTimeMs: '61800', words: 'Late' }]);
    const g = await page.evaluate(() => [window.__LT__.guessMeta('01 - Adele - Hello (Official Video).mp3'), window.__LT__.guessMeta('hello.m4a')]);
    assert.deepStrictEqual(g, [{ artist: 'Adele', title: 'Hello' }, { artist: '', title: 'hello' }]);
    await page.close();
  });

  if (only === 'screenshot') { ctx = (await launch(browser)).ctx; } if (only === 'screenshot') await run('screenshot', async () => {
    for (const [w, h, name] of [[1180, 820, 'ipad-landscape'], [820, 1180, 'ipad-portrait']]) {
      const page = await openApp(ctx);
      await page.setViewportSize({ width: w, height: h });
      await openSong(page, fA);
      await chip(page, '🏋️ Training').click(); await chip(page, '5×').click();
      if (name === 'ipad-landscape') await tid(page, 'fixopen').click();
      await tid(page, 'toggle').click();
      await page.waitForFunction(() => window.__LT__.E.rep === 1);
      await page.screenshot({ path: path.join(__dirname, '..', name + '.png') });
      await page.close();
    }
  });

  await browser.close();
  console.log(`\n${results.filter(Boolean).length}/${results.length} app tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
