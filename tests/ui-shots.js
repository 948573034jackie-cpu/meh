// "Before" / "after" pictures of every web page of the two apps, in WebKit (the iPhone's engine), iPhone 13, light
// AND dark: node tests/ui-shots.js <out dir>
// Nothing here checks anything: it only takes pictures, so the look can be compared before and after a change.
// The pages get exactly the app's scripts (AppModel.swift's lists) and the stand-in for the Swift side from
// tests/ios-harness.js; the AI is the harness's fake server on localhost. No network, no real key.
// Files: <app>-<screen>-<light|dark>.png, app = book (I Know Book) or iknow (I Know).
process.env.IOS_TEST_PORT = process.env.IOS_TEST_PORT || '8851';   // (its own ports: it can run beside the tests)
const fs = require('fs'); const path = require('path'); const http = require('http');
const H = require('./ios-harness');
const { pw, IOS, MIME, until, sleep, source, sheetScripts, ytScripts, stores, keychain } = H;
const OUT = path.resolve(process.argv[2] || 'shots');
const PAGES_PORT = +process.env.UI_SHOTS_PAGES_PORT || 8853;
fs.mkdirSync(OUT, { recursive: true });
H.watchdog(9);
H.startServer();
const made = [];

const resetStores = (local) => { for (const k of Object.keys(stores.local)) delete stores.local[k]; for (const k of Object.keys(stores.sync)) delete stores.sync[k]; Object.assign(stores.local, JSON.parse(JSON.stringify(local))); };
const now = new Date().toISOString();
const ENTRIES = {
  meticulous: { word: 'meticulous', lemma: 'meticulous', chinese: '一丝不苟的', sentence: 'Today my friend was very meticulous about her work.', explanation: 'Very careful about every small detail.', level: 'C1', status: 'learning', bookId: 'yt:ios00000001', bookTitle: 'Dream Lesson', chapter: '', position: null, createdAt: now, lastSeenAt: now, timesExplained: 2, again: 1 },
  gregarious: { word: 'gregarious', lemma: 'gregarious', chinese: '爱交际的', sentence: 'My uncle is a gregarious man who loves big parties.', explanation: 'A person who loves being with other people.', level: 'C2', status: 'learning', bookId: 'yt:ios00000001', bookTitle: 'Dream Lesson', chapter: '', position: null, createdAt: now, lastSeenAt: now, timesExplained: 1, again: 0 },
  ephemeral: { word: 'ephemeral', lemma: 'ephemeral', chinese: '短暂的', sentence: 'It was an ephemeral moment of joy.', explanation: 'Lasting a very short time.', level: 'C1', status: 'known', bookId: 'book:lighthouse', bookTitle: 'The Lighthouse Keeper', chapter: '', position: null, createdAt: now, lastSeenAt: now, timesExplained: 3, again: 0 },
};
const BOOK_STORE = { drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 }, drExtras: { tutorOn: true, fakeVoice: true, phoneSet: true, myLevel: 50, migrated: 9 }, drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500 } }, drVocab: { words: {}, marked: {} } };
const YT_STORE = (view) => ({
  barOn: true,
  drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 },
  drVocab: { words: {}, marked: {} },
  drEntries: ENTRIES,
  drExtras: { phoneSet: true, view, levelAsk: false, levelMode: true, tutorOn: true, fakeVoice: true, voiceMode: false, oneButton: false, teacherVolume: 60, wordVolume: 80, myLevel: 50, migrated: 9, stageOn: false, talkAfterExplain: false, panel: true },
  drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 20 } },
});
const SECOND_BOOK = 'The old lighthouse stood at the end of the harbour. Every night its keeper climbed the narrow stairs and lit the great lamp. Ships far away saw the light and found their way home. One winter the storm was so fierce that the keeper could not reach the door. He waited, and he listened to the wind.';

async function newPage(browser, scheme, label) {
  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const p = await ctx.newPage();
  await p.emulateMedia({ colorScheme: scheme });
  p.on('pageerror', (e) => console.log(`PAGE ERROR (${label})`, String(e.message || e).slice(0, 300)));
  return { ctx, p };
}
const shotOf = (p, scheme) => async (name, opts = {}) => {
  await sleep(opts.wait ?? 400);
  const file = path.join(OUT, `${name}-${scheme}.png`);
  await p.screenshot({ path: file, fullPage: !!opts.full });
  made.push(path.basename(file));
  console.log('shot', path.basename(file));
};
// (one picture that did not come must not stop the others)
const tryStep = async (what, fn) => { try { await fn(); } catch (e) { console.log(`MISSED ${what}:`, String(e && e.message || e).slice(0, 300)); } };

// ---------- I Know Book: the library, the pages, the bars, the sheets, the card ----------
async function book(browser, scheme) {
  resetStores(BOOK_STORE);
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const { ctx, p } = await newPage(browser, scheme, 'book');
  const shot = shotOf(p, scheme);
  await p.addInitScript({ content: source(sheetScripts) });
  await p.goto(`http://localhost:${PAGES_PORT}/book.html`);
  await until(() => p.evaluate(() => document.body.dataset.ready === '1'), 15000);
  const dbg = () => p.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  await shot('book-library-empty');
  await tryStep('book settings from the library', async () => { await p.evaluate(() => document.getElementById('lib-set').click()); await shot('book-library-settings'); await p.evaluate(() => document.getElementById('veil').click()); });
  await p.evaluate(() => document.getElementById('e-sample').click());
  await until(async () => { const d = await dbg(); return d && d.open && d.sentences > 5 ? d : null; }, 20000);
  await shot('book-reading-bars');
  await sleep(2800);
  await shot('book-reading');
  await tryStep('text settings', async () => { await p.evaluate(() => document.getElementById('b-look').click()); await shot('book-text-settings'); await p.evaluate(() => document.getElementById('veil').click()); });
  await tryStep('tutor sheet', async () => { await p.evaluate(() => document.getElementById('b-tutor').click()); await shot('book-tutor-sheet'); await p.evaluate(() => document.getElementById('veil').click()); });
  await tryStep('word card', async () => {
    await sleep(300);
    const box = await p.evaluate(() => { const w = [...document.querySelectorAll('#flow .w.hard')].find((x) => { const r = x.getBoundingClientRect(); return r.left > 0 && r.right < innerWidth && r.top > 60; }); if (!w) return null; const r = w.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    if (!box) throw new Error('no hard word on the page');
    await p.touchscreen.tap(box[0], box[1]);
    await until(() => p.evaluate(() => !document.getElementById('card').hidden || !document.getElementById('small').hidden), 4000);
    await shot('book-card', { wait: 700 });
    await sleep(4500);
    // (the card goes: a tap on it = I know)
    await p.evaluate(() => { const c = document.getElementById('card'); if (!c.hidden) c.click(); const s = document.getElementById('small'); if (!s.hidden) s.querySelector('[data-a="close"]').click(); });
  });
  await tryStep('listening', async () => {
    await p.evaluate(() => document.getElementById('mode-listen') && document.getElementById('mode-listen').click());
    await p.evaluate(() => window.__iknowBook.play(true));
    await sleep(1500);
    await shot('book-listening');
    await p.evaluate(() => window.__iknowBook.play(false));
    await p.evaluate(() => document.getElementById('mode-read') && document.getElementById('mode-read').click());
  });
  await tryStep('library with books', async () => {
    await p.evaluate((t) => window.__iknowBook.openText('The Lighthouse Keeper', t, 'A. Writer'), SECOND_BOOK);
    await until(async () => { const d = await dbg(); return d && d.open ? d : null; }, 10000);
    await sleep(600);
    await p.evaluate(() => window.__iknowBook.library());
    await until(() => p.evaluate(() => !document.getElementById('lib').hidden && !document.getElementById('shelf').hidden), 8000);
    await shot('book-library-books', { wait: 700 });
    await p.evaluate(() => document.querySelector('#hero [data-a="more"]').click());
    await shot('book-book-sheet');
    await p.evaluate(() => document.getElementById('veil').click());
    await p.evaluate(() => document.querySelector('#grid [data-a="add"]').click());
    await shot('book-add-sheet');
  });
  await ctx.close();
}

// ---------- I Know: the tutor on the YouTube test page (Listening and Video mode), its quick settings ----------
async function youtube(browser, scheme, view, name) {
  resetStores(YT_STORE(view));
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const { ctx, p } = await newPage(browser, scheme, name);
  const shot = shotOf(p, scheme);
  await p.goto('https://m.youtube.com/watch?v=ios00000001');
  await p.addScriptTag({ content: source(ytScripts) });
  const dbg = () => p.evaluate(() => { try { return JSON.parse(JSON.stringify((window.__drDebug && window.__drDebug()) || null)); } catch (e) { return null; } });
  const ready = await until(async () => { const x = await dbg(); return x && x.sentences === 10 ? x : null; }, 30000);
  if (!ready) console.log(`MISSED ${name}: the tutor did not read the subtitles`);
  await sleep(800);
  await shot(name);
  await tryStep(`${name} quick settings`, async () => {
    const opened = await p.evaluate(() => window.__ytcDream.action('quick'));
    if (!opened) throw new Error('the quick settings did not open');
    await shot(`${name}-quick`);
    // (Advanced opened: the long rest of the sheet)
    await p.evaluate(() => { for (const h of ['dr-stage-host', 'dr-panel-host']) { const r = document.getElementById(h); const q = r && r.shadowRoot && r.shadowRoot.querySelector('.quick:not([hidden])'); if (q) { const d = q.querySelector('details.adv.main'); if (d) d.open = true; } } });
    await shot(`${name}-quick-advanced`);
    await p.evaluate(() => window.__ytcDream.action('quick'));
  });
  await ctx.close();
}

// ---------- I Know: the app's own pages in the sheet / the reader (options.html, vocab.html, reader.html) ----------
async function appPage(browser, scheme, file, name, after) {
  resetStores(YT_STORE('listening'));
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const { ctx, p } = await newPage(browser, scheme, name);
  const shot = shotOf(p, scheme);
  await p.addInitScript({ content: source(sheetScripts) });
  await p.goto(`http://localhost:${PAGES_PORT}/${file}`);
  await sleep(1500);
  await shot(name);
  if (after) await tryStep(`${name} (after)`, () => after(p, shot));
  await ctx.close();
}

(async () => {
  const pages = http.createServer((q, r) => { const f = path.join(IOS, 'Web/dream', path.basename(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f)); }).listen(PAGES_PORT);
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version(), '· pictures in', OUT);
  for (const scheme of ['light', 'dark']) {
    await tryStep(`book (${scheme})`, () => book(browser, scheme));
    await tryStep(`listening (${scheme})`, () => youtube(browser, scheme, 'listening', 'iknow-tutor-listening'));
    await tryStep(`video (${scheme})`, () => youtube(browser, scheme, 'normal', 'iknow-tutor-video'));
    await tryStep(`options (${scheme})`, () => appPage(browser, scheme, 'options.html', 'iknow-options', async (p, shot) => { await shot('iknow-options-full', { full: true }); }));
    await tryStep(`vocab (${scheme})`, () => appPage(browser, scheme, 'vocab.html', 'iknow-vocab'));
    await tryStep(`reader (${scheme})`, () => appPage(browser, scheme, 'reader.html', 'iknow-reader', async (p, shot) => {
      await p.evaluate((t) => window.__iknowReader.openText('The Lighthouse Keeper', t), SECOND_BOOK);
      await until(() => p.evaluate(() => !document.getElementById('reader').hidden), 8000);
      await shot('iknow-reader-book', { wait: 900 });
    }));
  }
  await browser.close();
  pages.close();
  console.log(`DONE ${made.length} pictures`);
  process.exit(0);
})().catch((e) => { console.log('crashed', e && e.stack || e); process.exit(1); });
