// The one look of both apps (design/theme.json), checked on the screen: WebKit (the iPhone's engine), iPhone 13, the
// iPhone set to light AND to dark. For every page (I Know Book: the library, the reading page with its bars, the text
// settings, the tutor sheet, the add sheet; I Know: All settings, My Vocabulary, the reader, the tutor on the YouTube
// page with its quick settings, in Listening and in Video mode):
//   - the background follows the iPhone (the token's light or dark colour, as computed on the screen)
//   - the accent is the token's (a real button or chosen option, as computed)
//   - no text smaller than 13 px (the caption size; the book covers are pictures and do not count)
//   - every button at least 44 px tall (the tutor's small "E" before a sentence has a 44 px touch area of its own)
//   - nothing wider than the screen (no sideways scrolling)
// node tests/ios-look-test.js
process.env.IOS_TEST_PORT = process.env.IOS_TEST_PORT || '8861';
const fs = require('fs'); const path = require('path'); const http = require('http');
const H = require('./ios-harness');
const { pw, IOS, MIME, ok, until, sleep, source, sheetScripts, ytScripts, stores, keychain } = H;
const PAGES_PORT = +process.env.LOOK_PAGES_PORT || 8863;
H.watchdog(10);
H.startServer();

const theme = JSON.parse(fs.readFileSync(path.join(__dirname, '../design/theme.json'), 'utf8'));
const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
const tok = (scheme, name) => rgb(theme.colors[name][scheme]);

const resetStores = (local) => { for (const k of Object.keys(stores.local)) delete stores.local[k]; for (const k of Object.keys(stores.sync)) delete stores.sync[k]; Object.assign(stores.local, JSON.parse(JSON.stringify(local))); };
const now = new Date().toISOString();
const ENTRIES = {
  meticulous: { word: 'meticulous', lemma: 'meticulous', chinese: '一丝不苟的', sentence: 'Today my friend was very meticulous about her work.', explanation: 'Very careful about every small detail.', level: 'C1', status: 'learning', bookId: 'yt:ios00000001', bookTitle: 'Dream Lesson', chapter: '', position: null, createdAt: now, lastSeenAt: now, timesExplained: 2, again: 1 },
  ephemeral: { word: 'ephemeral', lemma: 'ephemeral', chinese: '短暂的', sentence: 'It was an ephemeral moment of joy.', explanation: 'Lasting a very short time.', level: 'C1', status: 'known', bookId: 'book:lighthouse', bookTitle: 'The Lighthouse Keeper', chapter: '', position: null, createdAt: now, lastSeenAt: now, timesExplained: 3, again: 0 },
};
const BOOK_STORE = { drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 }, drExtras: { tutorOn: true, fakeVoice: true, phoneSet: true, myLevel: 50, migrated: 9 }, drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500 } }, drVocab: { words: {}, marked: {} } };
const YT_STORE = (view) => ({
  barOn: true, drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 }, drVocab: { words: {}, marked: {} }, drEntries: ENTRIES,
  drExtras: { phoneSet: true, view, levelAsk: false, levelMode: true, tutorOn: true, fakeVoice: true, voiceMode: false, oneButton: false, teacherVolume: 60, wordVolume: 80, myLevel: 50, migrated: 9, stageOn: false, talkAfterExplain: false, panel: true },
  drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 20 } },
});
const TEXT = 'The old lighthouse stood at the end of the harbour. Every night its keeper climbed the narrow stairs and lit the great lamp. Ships far away saw the light and found their way home.';

/**
 * Runs in the page: what is on the screen in one place. `host`: a shadow root's host id (the tutor); `scope`: the part
 * checked (default the whole page); `bg` / `accent`: [selector, CSS property] read as computed.
 */
function audit({ host, scope, bg, accent, skip }) {
  const root = host ? document.getElementById(host)?.shadowRoot : document;
  if (!root) return { error: `no ${host}` };
  const area = scope ? root.querySelector(scope) : document.body;
  if (!area) return { error: `no ${scope}` };
  const shown = (el) => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  const skipped = (el) => !!(skip && el.closest(skip));
  const read = (sel, prop) => { const el = root.querySelector(sel); return el ? getComputedStyle(el)[prop] : `no ${sel}`; };
  const small = [];
  const short = [];
  const walk = (el) => {
    if (!shown(el) || skipped(el)) return;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own) { const px = parseFloat(getComputedStyle(el).fontSize); if (px < 12.95) small.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} ${px}px "${el.textContent.trim().slice(0, 30)}"`); }
    if (el.tagName === 'BUTTON') { const h = el.getBoundingClientRect().height; if (h > 0 && h < 43.5) short.push(`${el.id || el.dataset.act || el.dataset.a || el.className || el.textContent.trim().slice(0, 20)} ${Math.round(h)}px`); }
    for (const c of el.children) walk(c);
  };
  walk(area);
  const box = area.getBoundingClientRect();
  return {
    bg: bg ? read(bg[0], bg[1]) : null, accent: accent ? read(accent[0], accent[1]) : null,
    small: small.slice(0, 12), short: short.slice(0, 12),
    pageWide: document.documentElement.scrollWidth > innerWidth + 1 ? document.documentElement.scrollWidth : 0,
    areaWide: box.left < -1 || box.right > innerWidth + 1 ? [Math.round(box.left), Math.round(box.right)] : 0,
  };
}

const results = [];
async function check(p, scheme, name, spec) {
  const a = await p.evaluate(audit, spec);
  const want = { bg: spec.bg ? tok(scheme, spec.wantBg || 'bg') : null, accent: spec.accent ? tok(scheme, spec.wantAccent || 'accent') : null };
  const good = !a.error && (!spec.bg || a.bg === want.bg) && (!spec.accent || a.accent === want.accent) && !a.small.length && !a.short.length && !a.pageWide && !a.areaWide;
  results.push(good);
  ok(`${name} (${scheme}): background ${spec.bg ? `= ${spec.wantBg || 'bg'}` : '-'}, accent ${spec.accent ? '= token' : '-'}, no text under 13 px, buttons 44 px or more, not wider than the phone`, good,
    JSON.stringify({ ...a, want }));
}

async function newPage(browser, scheme, label) {
  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const p = await ctx.newPage();
  await p.emulateMedia({ colorScheme: scheme });
  p.on('pageerror', (e) => console.log(`PAGE ERROR (${label})`, String(e.message || e).slice(0, 300)));
  return { ctx, p };
}

async function book(browser, scheme) {
  resetStores(BOOK_STORE);
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const { ctx, p } = await newPage(browser, scheme, 'book');
  await p.addInitScript({ content: source(sheetScripts) });
  await p.goto(`http://localhost:${PAGES_PORT}/book.html`);
  await until(() => p.evaluate(() => document.body.dataset.ready === '1'), 15000);
  const dbg = () => p.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  await check(p, scheme, 'I Know Book: the library', { scope: '#lib', bg: ['#lib', 'backgroundColor'], accent: ['#e-file', 'backgroundColor'], skip: '.cover' });
  await p.evaluate(() => document.getElementById('lib-set').click());
  await sleep(300);
  await check(p, scheme, 'I Know Book: the tutor sheet from the library', { scope: '#sheet', bg: ['#sheet', 'backgroundColor'], wantBg: 'raised', accent: ['#sheet .opts button.on', 'color'] });
  await p.evaluate(() => document.getElementById('veil').click());
  await p.evaluate(() => document.getElementById('e-sample').click());
  await until(async () => { const d = await dbg(); return d && d.open && d.sentences > 5 ? d : null; }, 20000);
  await sleep(400);
  // (the bars come at the start; the reading page itself keeps the reader's own theme: Auto = Paper / Night)
  await check(p, scheme, 'I Know Book: the reading page with its bars', { scope: '#rd', bg: ['#top', 'backgroundColor'], skip: '#flow' });
  const page = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(`I Know Book (${scheme}): the reading page is still the reader's theme (Auto = Paper by day, Night by night)`, page === (scheme === 'dark' ? 'rgb(27, 26, 30)' : 'rgb(250, 246, 236)'), page);
  await p.evaluate(() => document.getElementById('mode-listen').click());
  await sleep(300);
  await check(p, scheme, 'I Know Book: Listening, the player', { scope: '#bar', accent: ['#t-play', 'backgroundColor'] });
  await p.evaluate(() => document.getElementById('mode-read').click());
  await p.evaluate(() => document.getElementById('b-look').click());
  await sleep(300);
  await check(p, scheme, 'I Know Book: the text settings sheet', { scope: '#sheet', bg: ['#sheet', 'backgroundColor'], wantBg: 'raised', accent: ['#sheet .fonts button.on', 'color'] });
  await p.evaluate(() => document.getElementById('veil').click());
  await p.evaluate(() => document.getElementById('b-tutor').click());
  await sleep(300);
  await check(p, scheme, 'I Know Book: the tutor sheet', { scope: '#sheet', bg: ['#sheet', 'backgroundColor'], wantBg: 'raised', accent: ['#sheet .opts button.on', 'color'] });
  await p.evaluate(() => document.getElementById('veil').click());
  await p.evaluate(() => window.__iknowBook.library());
  await until(() => p.evaluate(() => !document.getElementById('lib').hidden && !document.getElementById('shelf').hidden), 8000);
  await sleep(300);
  await check(p, scheme, 'I Know Book: the library with a book', { scope: '#lib', bg: ['#lib', 'backgroundColor'], accent: ['#hero .pill.go', 'backgroundColor'], skip: '.cover' });
  await p.evaluate(() => document.querySelector('#grid [data-a="add"]').click());
  await sleep(300);
  await check(p, scheme, 'I Know Book: the add sheet', { scope: '#sheet', bg: ['#sheet', 'backgroundColor'], wantBg: 'raised', accent: ['#sheet .big.go', 'backgroundColor'] });
  await ctx.close();
}

async function appPage(browser, scheme, file, name, spec, after) {
  resetStores(YT_STORE('listening'));
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const { ctx, p } = await newPage(browser, scheme, name);
  await p.addInitScript({ content: source(sheetScripts) });
  await p.goto(`http://localhost:${PAGES_PORT}/${file}`);
  await sleep(1200);
  if (after) await after(p);
  await check(p, scheme, name, spec);
  await ctx.close();
}

async function youtube(browser, scheme, view, name) {
  resetStores(YT_STORE(view));
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const { ctx, p } = await newPage(browser, scheme, name);
  await p.goto('https://m.youtube.com/watch?v=ios00000001');
  await p.addScriptTag({ content: source(ytScripts) });
  await until(async () => { const x = await p.evaluate(() => { try { return JSON.parse(JSON.stringify((window.__drDebug && window.__drDebug()) || null)); } catch (e) { return null; } }); return x && x.sentences === 10 ? x : null; }, 30000);
  await sleep(600);
  if (view === 'listening') await check(p, scheme, `${name}: the page`, { host: 'dr-stage-host', scope: '.stage', bg: ['.stage', 'backgroundColor'] });
  const opened = await p.evaluate(() => window.__ytcDream.action('quick'));
  await sleep(400);
  const host = await p.evaluate(() => ['dr-stage-host', 'dr-panel-host'].find((h) => { const r = document.getElementById(h); const q = r && r.shadowRoot && r.shadowRoot.querySelector('.quick'); return q && !q.hidden && q.getClientRects().length; }) || null);
  ok(`${name} (${scheme}): the quick settings open`, !!opened && !!host, String(host));
  if (host) {
    await check(p, scheme, `${name}: quick settings`, { host, scope: '.quick', bg: ['.quick', 'backgroundColor'], wantBg: 'raised', accent: ['.quick .seg button.on', 'color'], skip: '.sx' });
    // (Advanced open: the long rest)
    await p.evaluate((h) => { const d = document.getElementById(h).shadowRoot.querySelector('.quick details.adv.main'); if (d) d.open = true; }, host);
    await sleep(300);
    await check(p, scheme, `${name}: quick settings, Advanced`, { host, scope: '.quick', accent: ['.quick .seg button.on', 'color'] });
  }
  await ctx.close();
}

(async () => {
  const pages = http.createServer((q, r) => { const f = path.join(IOS, 'Web/dream', path.basename(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f)); }).listen(PAGES_PORT);
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());
  for (const scheme of ['light', 'dark']) {
    await book(browser, scheme);
    await appPage(browser, scheme, 'options.html', 'I Know: All settings (options.html)', { bg: ['body', 'backgroundColor'], accent: ['button.primary', 'backgroundColor'] });
    await appPage(browser, scheme, 'vocab.html', 'I Know: My Vocabulary (vocab.html)', { bg: ['body', 'backgroundColor'], accent: ['#csv', 'backgroundColor'] });
    await appPage(browser, scheme, 'reader.html', 'I Know: the reader, its shelf (reader.html)', { bg: ['body', 'backgroundColor'], accent: ['#paste-go', 'backgroundColor'] });
    await appPage(browser, scheme, 'reader.html', 'I Know: the reader, a text open', { bg: ['body', 'backgroundColor'], accent: ['#play', 'backgroundColor'] }, async (p) => {
      await p.evaluate((t) => window.__iknowReader.openText('The Lighthouse Keeper', t), TEXT);
      await until(() => p.evaluate(() => !document.getElementById('reader').hidden), 8000);
      await sleep(600);
    });
    await youtube(browser, scheme, 'listening', 'I Know: the tutor, Listening');
    await youtube(browser, scheme, 'normal', 'I Know: the tutor, Video');
  }
  await browser.close();
  pages.close();
  console.log(`${results.filter(Boolean).length} of ${results.length} screens in the one look`);
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
