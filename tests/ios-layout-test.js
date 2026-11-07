// The app's page on each device and way round (iPhone / iPad, portrait / landscape), in WebKit.
// The app tells the page which device it is (window.__ytcDevice); the window's size gives the layout:
// p-port / p-land (a phone, or an iPad split small), t-narrow (an iPad split in half), t-port / t-land (a whole iPad).
// Checks, on each device: the layout and the device on the page (data-lay, data-dev, data-phone = touch), the size of
// the page text (your 21 px, bigger on an iPad) and of the subtitles on the video, the same in the debug info. Then the phone and the iPad are turned:
// the layout follows at once, the view stays and the video goes on.
// Run ios/sync-scripts.sh first (the CI does). The fake video, the fake AI and the app's window are in tests/ios-harness.js.
const H = require('./ios-harness');
const { pw, ok, until, sleep, source, ytScripts, stores, keychain } = H;
H.watchdog(5);
const api = H.startServer();

// (no stops: these tests are only about the page; the video plays through)
const extrasNow = () => ({ capWords: 100, stopPhrasesOn: false, capPhrases: 100, capSentences: 0, stopItemsOn: false, stopHardOn: false, phoneSet: true, view: 'listening', levelAsk: false, levelMode: false, tutorOn: true, fakeVoice: true, explainOnStop: true, panel: true, band: 'auto', talkAfterExplain: false, migrated: 1, stopGapSec: 0, callEngine: 'claude', talkSilenceSec: 0, stopSentences: false });

const DEVICES = [
  { name: 'iPhone 13', device: 'phone', lay: 'p-port', px: 21, band: 17 },
  { name: 'iPhone 13 landscape', device: 'phone', lay: 'p-land', px: 20, band: 22 },
  { name: 'iPad (gen 7)', device: 'pad', lay: 't-port', px: 28, band: 26 },
  { name: 'iPad (gen 7) landscape', device: 'pad', lay: 't-land', px: 26, band: 30 },
  { name: 'iPad (gen 7)', label: 'iPad (gen 7) split in half (507 x 768)', viewport: { width: 507, height: 768 }, device: 'pad', lay: 't-narrow', px: 24, band: 22 },
  ...(pw.devices['iPad Pro 11'] ? [{ name: 'iPad Pro 11', device: 'pad', lay: 't-port', px: 28, band: 26 }] : []),
];

// the app's window on one device, the video loaded in Listening
async function open(browser, d) {
  Object.assign(stores.local, {
    barOn: true,
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 },
    drExtras: extrasNow(),
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 20 } },
  });
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const ctx = await H.newAppContext(browser, d.name, { device: d.device, viewport: d.viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`PAGE ERROR (${d.label || d.name})`, String(e.message || e).slice(0, 300)));
  await page.goto('https://m.youtube.com/watch?v=ios00000001');
  await page.addScriptTag({ content: source(ytScripts) });
  const dbg = () => page.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const ready = await until(async () => { const x = await dbg(); return x && x.sentences === 10 && x.stage && x.stage.shown ? x : null; }, 30000);
  return { ctx, page, dbg, ready };
}
// what the page shows: the stage's flags and the page text size, the flags on <html>, the window
const lookOf = (page) => page.evaluate(() => {
  const host = document.getElementById('dr-stage-host');
  const pg = host && host.shadowRoot.querySelector('.stage .page');
  const html = document.documentElement.dataset;
  return host ? { lay: host.dataset.lay, dev: host.dataset.dev, phone: host.dataset.phone, px: pg ? parseFloat(getComputedStyle(pg).fontSize) : 0, band: getComputedStyle(host).getPropertyValue('--subtitle-size').trim(), html: { phone: html.ytcPhone, dev: html.ytcDev, lay: html.ytcLay }, w: innerWidth, h: innerHeight } : null;
});
const vstate = (page) => page.evaluate(() => { const v = document.querySelector('video'); return { t: v.currentTime, paused: v.paused }; });

// turn the device: the layout follows within 500 ms, the view stays, the video goes on (no jump)
async function turn(page, dbg, to, want, what) {
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 1; return v.play(); });
  await until(async () => { const v = await vstate(page); return !v.paused && v.t > 1.3; }, 8000, 100);
  const before = await dbg();
  const v0 = await vstate(page), at = Date.now();
  await page.setViewportSize(to);
  const got = await until(() => lookOf(page).then((l) => (l && l.lay === want ? l : null)), 500, 25);
  const ms = Date.now() - at;
  await sleep(300);
  const v1 = await vstate(page), after = await dbg();
  const gone = (Date.now() - at) / 1000;
  const jump = Math.abs(v1.t - v0.t - gone);
  ok(`${what}: turned, the layout is ${want} within 500 ms, the view and the page stay, the video goes on (no jump)`,
    !!got && got.html.lay === want && after.lay === want && after.view === before.view && after.stage.shown && !v1.paused && jump < 1,
    JSON.stringify({ ms, got, view: [before.view, after.view], shown: after.stage && after.stage.shown, v0, v1, jump: +jump.toFixed(2) }));
}

(async () => {
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());

  for (const d of DEVICES) {
    const what = d.label || d.name;
    const { ctx, page, dbg, ready } = await open(browser, d);
    const l = await lookOf(page);
    ok(`${what}: the layout is ${d.lay}, the device ${d.device}, the touch page`, !!ready && l && l.lay === d.lay && l.dev === d.device && l.phone === '1'
      && l.html.lay === d.lay && l.html.dev === d.device && l.html.phone === '1', JSON.stringify({ l, ready: !!ready }));
    ok(`${what}: the page text is ${d.px} px (your 21 px on this layout), the subtitles on the video ${d.band} px (your 17 px)`, l && Math.abs(l.px - d.px) < 0.5 && ready && ready.stage.size === `${d.px}px` && l.band === `${d.band}px`, JSON.stringify({ px: l && l.px, size: ready && ready.stage.size, band: l && l.band }));
    const x = await dbg();
    ok(`${what}: the debug info says the same (device, lay; phone = touch)`, x && x.device === d.device && x.lay === d.lay && x.phone === true, JSON.stringify(x && { device: x.device, lay: x.lay, phone: x.phone }));
    if (d.name === 'iPhone 13' && !d.viewport) await turn(page, dbg, { width: 664, height: 390 }, 'p-land', 'the iPhone');
    if (d.name === 'iPad (gen 7)' && !d.viewport) await turn(page, dbg, { width: 1080, height: 810 }, 't-land', 'the iPad');
    await ctx.close();
  }

  await browser.close();
  api.close();
  console.log(H.fails() ? `\n${H.fails()} FAILED` : '\nALL PASSED');
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
