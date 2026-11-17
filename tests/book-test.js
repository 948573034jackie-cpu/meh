// I Know Book (the reading and listening app), in WebKit with an iPhone 13:
//  the library, opening a text, pages (tap, swipe, the place kept over a restart), the text settings (size, font,
//  colours, spacing: the same sentence stays on the page), a tapped word (the big card, the explanation, the word three
//  times, the card gone, nothing plays by itself), "I know", listening with the stop of I Know, the tutor's settings.
//  Version 1.1, speed: a book of 600,000 letters is kept in light parts (an old stored book is cut when it opens, the
//  place kept); a tap on a word -> the card painted, a tap on the card -> the card gone, a page turn: each timed in the
//  page (performance.now() and two animation frames); taps that were lost before (the bars showing, a slow tap, a
//  long press that selects the word, the small card open, the card's first half second).
// What counts is what is REALLY on the screen (computed style, elementFromPoint), never only a hidden flag.
// Run ios/sync-scripts.sh first. The fake AI and the app's bridge are in tests/ios-harness.js.
const fs = require('fs'); const path = require('path'); const http = require('http');
const H = require('./ios-harness');
const { pw, IOS, MIME, ok, until, sleep, source, sheetScripts, stores, keychain, apiLog } = H;
const PORT = +process.env.BOOK_PAGES_PORT || 8817;
H.watchdog(9);
const api = H.startServer();

const HARD = 'My friend was very meticulous about her work.';
const FILL = (i) => `This is easy sentence number ${i} of the story. The children played in the garden after school. We had some bread and a cup of tea.`;
const PARAS = [`The morning was quiet and the street was empty. ${HARD} She walked to the shop and bought some bread.`, 'It was a lugubrious moment of joy. My uncle is a gregarious man who loves big parties.', ...Array.from({ length: 30 }, (_, i) => FILL(i + 1))];
const TEXT = PARAS.join('\n\n');
// a big book: about 600,000 letters (300 pages). Every paragraph and sentence says which one it is.
const NOUNS = ['garden', 'kitchen', 'market', 'village', 'teacher', 'flower', 'mountain', 'summer', 'winter', 'letter', 'music', 'river', 'window', 'evening', 'brother', 'sister', 'doctor', 'farmer', 'bridge', 'forest', 'island', 'castle', 'candle', 'basket', 'button', 'pocket', 'ticket', 'blanket', 'pillow', 'mirror'];
const bigPara = (i) => `Paragraph ${i} begins here. ${Array.from({ length: 8 }, (_, k) => `In part ${i} line ${k + 1} the ${NOUNS[(i + k) % NOUNS.length]} was near the ${NOUNS[(i * 7 + k * 3 + 1) % NOUNS.length]} and the old ${NOUNS[(i * 3 + k * 5 + 2) % NOUNS.length]}.`).join(' ')}`;
const BIG_PARAS = Array.from({ length: 1040 }, (_, i) => bigPara(i));
const BIG = BIG_PARAS.join('\n\n');

(async () => {
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());
  const pages = http.createServer((q, r) => { const f = path.join(IOS, 'Web/dream', path.basename(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f)); }).listen(PORT);
  const URL0 = `http://localhost:${PORT}/book.html`;
  for (const k of Object.keys(stores.local)) delete stores.local[k];
  H.resetVocab();
  Object.assign(stores.local, {
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 },
    drExtras: { tutorOn: true, fakeVoice: true, phoneSet: true, myLevel: 50, migrated: 9, knownAfter: 7 },
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500 } },
    drVocab: { words: {}, marked: {} },
  });
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const pageErrors = [];
  const open = async () => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => { pageErrors.push(String(e.message || e)); console.log('PAGE ERROR (book)', String(e.message || e).slice(0, 300)); });
    await p.addInitScript({ content: source(sheetScripts) });
    await p.goto(URL0);
    await until(() => p.evaluate(() => document.body.dataset.ready === '1'), 20000);
    return p;
  };
  const dbgOf = (p) => () => p.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  // what is really there: drawn, and on top at the middle of the screen
  const seen = (p, id) => p.evaluate((i) => { const el = document.getElementById(i); const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2); const r = el.getBoundingClientRect(); return { display: getComputedStyle(el).display, onTop: !!(top && el.contains(top)), w: Math.round(r.width), h: Math.round(r.height) }; }, id);
  const pageWords = (p) => p.evaluate(() => [...document.querySelectorAll('#flow .w')].filter((w) => { const r = w.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }).map((w) => w.textContent));
  const onPage = (p, start) => p.evaluate((t) => { const s = [...document.querySelectorAll('#flow .s')].find((x) => x.textContent.startsWith(t)); if (!s) return false; const r = s.getClientRects()[0]; return !!r && r.left >= 0 && r.left < innerWidth; }, start);
  const barsOff = async (p) => { if ((await dbgOf(p)()).chrome) { await p.evaluate(() => document.getElementById('rd').classList.add('plain')); await sleep(350); } };
  const firstSentence = (p) => p.evaluate(() => { const s = [...document.querySelectorAll('#flow .s')].find((x) => { const r = x.getClientRects()[0]; return r && r.left >= 0 && r.left < innerWidth; }); return s ? s.textContent.slice(0, 50) : null; });
  const tapWord = async (p, word) => {
    const box = await p.evaluate((w) => { const e = [...document.querySelectorAll('#flow .w')].find((x) => { if (x.textContent !== w) return false; const r = x.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, word);
    if (!box) return false;
    await p.touchscreen.tap(box[0], box[1]);
    return true;
  };

  // ---- 1. the first screen: no book yet ----
  let p = await open();
  let dbg = dbgOf(p);
  const first = await p.evaluate(() => { const b = (id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return { h: r.height, shown: getComputedStyle(e).display !== 'none' && r.height > 0 }; }; return { empty: getComputedStyle(document.getElementById('empty')).display, file: b('e-file'), paste: b('e-paste'), sample: b('e-sample'), accept: document.getElementById('file').accept, rd: getComputedStyle(document.getElementById('rd')).display, text: document.getElementById('empty').innerText }; });
  ok('the first screen is calm: one line of what the app does, and three big buttons (open a file, paste a text, try a story)', first.empty !== 'none' && first.rd === 'none' && first.file.shown && first.paste.shown && first.sample.shown && first.file.h >= 44 && first.paste.h >= 44 && first.sample.h >= 44 && /tutor/.test(first.text), JSON.stringify(first));
  ok('...it takes EPUB, PDF and text files', /\.epub/.test(first.accept) && /\.pdf/.test(first.accept) && /\.txt/.test(first.accept), first.accept);

  // ---- 2. a text opens as a book with pages ----
  await p.evaluate(([t, x]) => window.__iknowBook.openText(t, x, 'Ann Writer'), ['My Story', TEXT]);
  const opened = await until(async () => { const d = await dbg(); return d && d.open && d.sentences > 20 ? d : null; }, 20000);
  const lay = await p.evaluate(() => { const f = document.getElementById('flow'); const c = getComputedStyle(f); const ws = [...document.querySelectorAll('#flow .w')]; const on = ws.filter((w) => { const r = w.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }); const cut = on.filter((w) => { const r = w.getBoundingClientRect(); const pg = document.getElementById('page').getBoundingClientRect(); return r.top < pg.top - 1 || r.bottom > pg.bottom + 1; }); const xs = on.map((w) => w.getBoundingClientRect()); return { font: c.fontFamily, size: c.fontSize, lh: parseFloat(c.lineHeight) / parseFloat(c.fontSize), col: parseFloat(c.columnWidth), win: innerWidth, words: on.length, cut: cut.length, left: Math.min(...xs.map((r) => r.left)), right: Math.max(...xs.map((r) => r.right)), lib: getComputedStyle(document.getElementById('lib')).display, scroll: document.documentElement.scrollWidth }; });
  ok('a text opens as a book: the page shows only the text, in pages (no word cut at the top or the bottom, nothing wider than the screen)', !!opened && opened.pages >= 3 && lay.lib === 'none' && lay.words > 40 && lay.cut === 0 && lay.left >= 16 && lay.right <= lay.win - 16 && lay.scroll <= lay.win, JSON.stringify({ pages: opened && opened.pages, lay }));
  ok('...the usual look: Charter, 18 px on an iPhone, line spacing 1.5, the paper page', /^Charter/.test(lay.font) && lay.size === '18px' && Math.abs(lay.lh - 1.5) < 0.02 && opened.look.theme === 'paper', JSON.stringify({ font: lay.font, size: lay.size, lh: lay.lh, theme: opened.look.theme }));
  const barsGone = await until(async () => { const d = await dbg(); if (!d || d.chrome) return null; const t = await p.evaluate(() => { const r = document.getElementById('top').getBoundingClientRect(); const b = document.getElementById('bar').getBoundingClientRect(); return { top: r.bottom, bar: b.top, h: innerHeight }; }); return t.top <= 1 && t.bar >= t.h - 1 ? t : null; }, 6000);
  ok('...the bars show for a moment and then go away by themselves: the page is the text alone', !!barsGone, JSON.stringify(barsGone));
  const foot = await p.evaluate(() => ({ l: document.getElementById('foot-l').textContent, r: document.getElementById('foot-r').textContent }));
  ok('...a small quiet line says where I am (page 1 of N, 0 %)', /^1 \/ \d+$/.test(foot.l) && foot.r === '0%', JSON.stringify(foot));

  // ---- 3. pages: a tap in the margin, a swipe; the place is kept ----
  const w0 = await pageWords(p);
  await p.touchscreen.tap(p.viewportSize().width - 6, 420);
  const p2 = await until(async () => { const d = await dbg(); return d.page === 1 ? d : null; }, 3000);
  await sleep(400);
  const w1 = await pageWords(p);
  ok('a tap at the right edge turns the page: other words, none from the page before', !!p2 && w1.length > 30 && w1.join(' ') !== w0.join(' ') && lay.cut === 0, JSON.stringify({ page: p2 && p2.page, a: w0.slice(0, 4), b: w1.slice(0, 4) }));
  const swipe = (dir) => p.evaluate((d) => { const el = document.getElementById('page'); const y = 400, x0 = d > 0 ? 300 : 90, x1 = d > 0 ? 90 : 300; const ev = (type, x, live) => { const e = new Event(type, { bubbles: true }); Object.defineProperty(e, 'touches', { value: live ? [{ clientX: x, clientY: y }] : [] }); Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] }); return e; }; try { el.dispatchEvent(ev('touchstart', x0, true)); el.dispatchEvent(ev('touchend', x1, false)); return true; } catch (e) { return String(e); } }, dir);
  const sw = await swipe(1);
  const p3 = await until(async () => { const d = await dbg(); return d.page === 2 ? d : null; }, 3000);
  await swipe(-1);
  const p2b = await until(async () => { const d = await dbg(); return d.page === 1 ? d : null; }, 3000);
  ok('a swipe to the left turns the page on, a swipe to the right turns it back', sw === true && !!p3 && !!p2b, JSON.stringify({ sw, p3: !!p3, p2b: !!p2b }));
  await sleep(900);
  const keptSentence = await firstSentence(p);
  const placeSaved = await until(async () => { const d = await dbg(); return d.place && (d.place.paragraph > 0 || d.place.sentence > 0) && d.percent > 0 ? d : null; }, 4000);
  await p.close();
  p = await open(); dbg = dbgOf(p);
  const back = await until(async () => { const d = await dbg(); return d && d.open && d.sentences > 20 ? d : null; }, 20000);
  ok('the app closed and opened again: the same book, on the same page, by itself', !!placeSaved && !!back && back.page === 1 && (await firstSentence(p)) === keptSentence && (await seen(p, 'rd')).display !== 'none', JSON.stringify({ page: back && back.page, was: keptSentence, now: await firstSentence(p) }));

  // ---- 4. the text settings: live, and the same sentence stays on the page ----
  await p.evaluate(() => document.getElementById('b-look').click());
  const sheet1 = await p.evaluate(() => { const s = document.getElementById('sheet'); const b = document.getElementById('sheet-body'); return { display: getComputedStyle(s).display, themes: [...b.querySelectorAll('.sw')].map((x) => x.dataset.theme).join(' '), fonts: b.querySelectorAll('.fonts button').length, sliders: [...b.querySelectorAll('input[type=range]')].map((x) => x.dataset.name).join(' '), h: Math.min(...[...b.querySelectorAll('.sw i, .fonts button')].map((x) => x.getBoundingClientRect().height)), pageSeen: document.getElementById('sheet').getBoundingClientRect().top > 120 }; });
  ok('"Aa" opens the text settings over the lower part of the page (the text stays in view): page colours, fonts, and sliders for size, line spacing, margins, letters, words, paragraphs', sheet1.display !== 'none' && sheet1.themes === 'auto white paper sepia green grey night black custom' && sheet1.fonts >= 8 && sheet1.sliders === 'size line margin letter word para' && sheet1.h >= 44 && sheet1.pageSeen, JSON.stringify(sheet1));
  const setRange = (name, v) => p.evaluate(([n, val]) => { const i = document.querySelector(`#sheet-body input[data-name="${n}"]`); i.value = String(val); i.dispatchEvent(new Event('input', { bubbles: true })); }, [name, v]);
  const anchorBefore = await firstSentence(p);
  await setRange('size', 24);
  await sleep(300);
  const big = await p.evaluate(() => { const c = getComputedStyle(document.getElementById('flow')); return { size: c.fontSize, out: document.querySelector('#sheet-body input[data-name="size"]').parentElement.querySelector('output').textContent }; });
  const dBig = await dbg();
  ok('bigger text at once: 24 px, more pages, and the sentence I was at is still on the page', big.size === '24px' && big.out === '24' && dBig.pages > back.pages && (await onPage(p, anchorBefore)), JSON.stringify({ big, pages: [back.pages, dBig.pages], now: await firstSentence(p), was: anchorBefore }));
  await setRange('line', 1.8); await setRange('margin', 40); await setRange('letter', 0.04); await setRange('word', 0.1);
  await p.evaluate(() => document.querySelector('#sheet-body .fonts button[data-font="georgia"]').click());
  await p.evaluate(() => document.querySelector('#sheet-body .sw[data-theme="night"]').click());
  await sleep(350);
  const styled = await p.evaluate(() => { const f = document.getElementById('flow'); const c = getComputedStyle(f); const bg = getComputedStyle(document.body).backgroundColor; const xs = [...document.querySelectorAll('#flow .w')].map((w) => w.getBoundingClientRect()).filter((r) => r.left >= 0 && r.right <= innerWidth); return { lh: parseFloat(c.lineHeight) / parseFloat(c.fontSize), letter: c.letterSpacing, word: c.wordSpacing, font: c.fontFamily, bg, left: Math.min(...xs.map((r) => r.left)), fg: c.color }; });
  const lum = (c) => { const m = /(\d+), (\d+), (\d+)/.exec(c); return m ? (+m[1] + +m[2] + +m[3]) / 3 : -1; };
  ok('line spacing, margins, letter and word spacing, the font and the page colour all change the page at once (Georgia, night: a dark page with light text)',
    Math.abs(styled.lh - 1.8) < 0.02 && Math.abs(parseFloat(styled.letter) - 0.96) < 0.1 && Math.abs(parseFloat(styled.word) - 2.4) < 0.2 && /^Georgia/.test(styled.font) && lum(styled.bg) < 60 && lum(styled.fg) > 150 && styled.left >= 39, JSON.stringify(styled));
  ok('...and the sentence I was at is still on the page', (await onPage(p, anchorBefore)), `${await firstSentence(p)} / ${anchorBefore}`);
  await p.evaluate(() => { document.querySelector('#sheet-body .sw[data-theme="custom"]').click(); });
  await p.evaluate(() => { const set = (n, v) => { const i = document.querySelector(`#sheet-body input[data-name="${n}"]`); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }; set('bg', '#103050'); set('fg', '#183858'); });
  await sleep(300);
  const own = await p.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.getElementById('flow')).color }));
  const contrastOf = (a, b) => { const L = (c) => { const m = /(\d+), (\d+), (\d+)/.exec(c).slice(1).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; }; const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  ok('my own colours: the page takes my colour; a text colour too close to it is made readable (never text that cannot be read)', own.bg === 'rgb(16, 48, 80)' && contrastOf(own.bg, own.fg) >= 4.5, JSON.stringify({ own, contrast: contrastOf(own.bg, own.fg) }));
  await p.evaluate(() => document.querySelector('#sheet-body [data-a="reset"]').click());
  await sleep(300);
  await p.evaluate(() => document.getElementById('veil').click());
  const reset = await p.evaluate(() => ({ size: getComputedStyle(document.getElementById('flow')).fontSize, sheet: getComputedStyle(document.getElementById('sheet')).display, saved: null }));
  ok('"Back to the usual look" puts everything back; the sheet closes with a tap outside it and is really gone', reset.size === '18px' && reset.sheet === 'none' && (await until(() => stores.local.bkLook && stores.local.bkLook.size === 18 && stores.local.bkLook.theme === 'auto', 3000)) === true, JSON.stringify({ reset, look: stores.local.bkLook }));

  // ---- 5. Reading: a tapped word = the big card, the explanation, the word three times, the card gone; nothing plays ----
  await p.evaluate(() => window.__iknowBook.turn(-1));
  await until(async () => (await dbg()).page === 0, 3000);
  await sleep(400);
  await barsOff(p);
  const nRule = apiLog.length;
  ok('the hard words of the page carry a quiet mark (a thin dotted line), easy words none', await p.evaluate(() => { const m = [...document.querySelectorAll('#flow .w')].find((x) => x.textContent === 'meticulous'); const e = [...document.querySelectorAll('#flow .w')].find((x) => x.textContent === 'friend'); return m.classList.contains('hard') && /dotted/.test(getComputedStyle(m).textDecorationStyle + getComputedStyle(m).textDecoration) && !e.classList.contains('hard') && getComputedStyle(e).textDecorationLine === 'none'; }));
  await tapWord(p, 'meticulous');
  const card1 = await until(async () => { const d = await dbg(); return d.card && d.card.word === 'meticulous' ? d : null; }, 5000, 40);
  const cardSeen = await seen(p, 'card');
  ok('a tap on a word: the big card over the whole screen: the word, how it sounds, and its meaning', !!card1 && card1.card.big && cardSeen.display !== 'none' && cardSeen.onTop && cardSeen.w >= 389 && cardSeen.h >= 660 && /\//.test(card1.card.ipa) && /[一-鿿]/.test(card1.card.zh) && !/[;；,，]/.test(card1.card.zh), JSON.stringify({ card: card1 && card1.card, cardSeen }));
  const zhAi = await until(async () => { const d = await dbg(); return d.card && d.card.zh === '细致的' ? d : !d.card ? 'gone' : null; }, 6000, 40);
  ok('...the meaning becomes the AI\'s meaning in this sentence (one small request, kept with the book)', zhAi !== null && apiLog.slice(nRule).filter((r) => r.kind === 'zhword').length === 1 && (await until(() => stores.local['bkHere:' + back.open] && Object.values(stores.local['bkHere:' + back.open]).includes('细致的'), 4000)) === true, JSON.stringify({ zhAi: zhAi && (zhAi.card || zhAi), asks: apiLog.slice(nRule).filter((r) => r.kind === 'zhword').length }));
  const after1 = await until(async () => { const d = await dbg(); return !d.card && d.spoken.filter((x) => x === 'meticulous').length >= 4 ? d : null; }, 30000, 80);
  const sp1 = after1 ? after1.spoken : (await dbg()).spoken;
  const iExp = sp1.findIndex((x) => /Meticulous means|It means something/.test(x));
  ok('...the tutor says the word once, explains it, then says the word three times', !!after1 && iExp >= 1 && sp1.slice(0, iExp).filter((x) => x === 'meticulous').length === 1 && sp1.slice(iExp).filter((x) => x === 'meticulous').length === 3, JSON.stringify(sp1));
  const gone1 = await seen(p, 'card');
  const under = await p.evaluate(() => { const t = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return t ? (t.closest('#page') ? 'page' : t.id || t.className) : null; });
  ok('...then the card closes by itself and is REALLY gone: the page of the book is on the screen again', gone1.display === 'none' && !gone1.onTop && under === 'page', JSON.stringify({ gone1, under }));
  await sleep(1500);
  const quiet = await dbg();
  ok('...and nothing plays by itself afterwards (silent reading stays silent; the sentence is not read aloud)', !quiet.playing && quiet.spoken.length === sp1.length && !quiet.spoken.includes(HARD), JSON.stringify({ playing: quiet.playing, n: [sp1.length, quiet.spoken.length] }));
  ok('...the word is on my list as still learning, with its sentence', (stores.local.drVocab.words || {}).meticulous === 'learning');

  // ---- 6. one tap on the card = I know ----
  const nBefore = apiLog.filter((r) => /These rules are absolute/.test(r.sys)).length;
  await tapWord(p, 'lugubrious');
  await until(async () => { const d = await dbg(); return d.card && d.card.word === 'lugubrious' ? d : null; }, 5000, 40);
  // (1.1: the card takes a tap from its first moment: no wait before this tap)
  await p.touchscreen.tap(195, 600);
  const known = await until(async () => { const d = await dbg(); return !d.card && (stores.local.drVocab.words || {}).lugubrious === 'known' ? d : null; }, 5000, 60);
  await sleep(700);
  const k2 = await dbg();
  ok('one tap anywhere on the card = I know: the word is known, the card is gone, the tutor stops (not another word is said)', !!known && (await seen(p, 'card')).display === 'none' && k2.spoken.length === known.spoken.length && k2.spoken.filter((x) => x === 'lugubrious').length < 4 && !k2.playing, JSON.stringify({ st: (stores.local.drVocab.words || {}).lugubrious, said: k2.spoken.slice(-4) }));
  ok('...a known word loses its mark in the text', await p.evaluate(() => { const m = [...document.querySelectorAll('#flow .w')].find((x) => x.textContent === 'lugubrious'); return !m.classList.contains('hard') && !m.classList.contains('learning'); }));

  // ---- 7. Listening: the book is read aloud, and the stop is the one of I Know ----
  const s0 = (await dbg()).spoken.length;
  await p.evaluate(() => window.__iknowBook.play(true));
  await p.evaluate(() => { window.__log = []; setInterval(() => { const d = JSON.parse(document.documentElement.dataset.drDebug || 'null'); const c = document.getElementById('card'); const cur = document.querySelector('#flow .s.cur'); window.__log.push({ card: getComputedStyle(c).display !== 'none' ? c.querySelector('.word').textContent : '', cur: cur ? cur.textContent.slice(0, 30) : '', n: d ? d.spoken.length : 0, wait: d && d.waiting, idx: d && d.index }); }, 40); });
  const stopSeen = await until(async () => { const d = await dbg(); return d.card && d.card.word === 'gregarious' ? d : null; }, 30000, 40);
  const curNow = await p.evaluate(() => { const c = document.querySelector('#flow .s.cur'); return c ? { text: c.textContent.slice(0, 40), bg: getComputedStyle(c).backgroundColor } : null; });
  ok('Listen: the book is read aloud sentence by sentence, the sentence being read is softly marked, and the mode is "listen"', !!stopSeen && stopSeen.mode === 'listen' && stopSeen.playing && !!curNow && curNow.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify({ curNow, mode: stopSeen && stopSeen.mode }));
  const spokenAtStop = stopSeen ? stopSeen.spoken.slice(s0) : [];
  ok('...it reads over words I know and words explained a moment ago, and stops after the sentence with the next hard word ("gregarious"): the card shows it', !!stopSeen && spokenAtStop.some((x) => /lugubrious moment/.test(x)) && spokenAtStop.some((x) => /gregarious man/.test(x)) && !spokenAtStop.slice(0, -2).includes('meticulous') && (await seen(p, 'card')).onTop, JSON.stringify(spokenAtStop.slice(-5)));
  const waited = await until(async () => { const d = await dbg(); return d.waiting ? d : null; }, 5000, 30);
  ok('...the word is said once, then the app waits (a thin line at the bottom of the card runs out): a tap now = I know', !!waited && waited.spoken.slice(s0).filter((x) => x === 'gregarious').length === 1 && (await p.evaluate(() => { const b = document.querySelector('#card .wait'); return b.classList.contains('run') && b.getBoundingClientRect().height >= 2; })), JSON.stringify(waited && waited.spoken.slice(-3)));
  const onAgain = await until(async () => { const d = await dbg(); return !d.card && d.index > stopSeen.index && d.playing ? d : null; }, 40000, 80);
  const sp7 = onAgain ? onAgain.spoken.slice(s0) : (await dbg()).spoken.slice(s0);
  const g = sp7.map((x, i) => (x === 'gregarious' ? i : -1)).filter((i) => i >= 0);
  const iSent = sp7.map((x, i) => (/gregarious man/.test(x) ? i : -1)).filter((i) => i >= 0);
  const iEx = sp7.findIndex((x, i) => i > g[0] && /Gregarious means|It means something/.test(x));
  ok('...nothing tapped: the explanation, the word three times, then the sentence once again, and the reading goes on', !!onAgain && g.length === 4 && iEx > g[0] && g[1] > iEx && iSent.length === 2 && iSent[1] > g[3], JSON.stringify(sp7.slice(-9)));
  const log = await p.evaluate(() => window.__log);
  const again = log.filter((x) => x.n >= s0 + (iSent[1] ?? 9e9) + 1);
  ok('...the card closed BEFORE the sentence was heard again, and never showed while the book was read', again.length > 0 && again.every((x) => !x.card) && log.filter((x) => x.card === 'gregarious').length > 5, JSON.stringify({ shown: log.filter((x) => x.card).length, during: again.filter((x) => x.card).length }));
  await p.evaluate(() => window.__iknowBook.play(false));
  const stoppedNow = await until(async () => { const d = await dbg(); return !d.playing ? d : null; }, 3000);
  await sleep(800);
  ok('Pause stops it at once', !!stoppedNow && (await dbg()).spoken.length === stoppedNow.spoken.length);

  // ---- 8. the bars, the player and the tutor's settings ----
  await barsOff(p);
  await p.touchscreen.tap(195, p.viewportSize().height - 12);
  await sleep(450);
  const bars = await until(async () => { const d = await dbg(); if (!d.chrome) return null; return p.evaluate(() => { const r = (id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return { h: Math.round(b.height), w: Math.round(b.width), shown: getComputedStyle(e).display !== 'none' && b.height > 0 }; }; return { play: r('t-play'), back: r('t-back'), fwd: r('t-fwd'), speed: r('t-speed'), voice: r('t-voice'), read: r('mode-read'), listen: r('mode-listen'), look: r('b-look'), tutor: r('b-tutor'), lib: r('b-lib'), top: document.getElementById('top').getBoundingClientRect().top }; }); }, 4000);
  ok('a tap on the narrow band under the text (or above it) calls the bars: back to my books, "Aa", the tutor, Read / Listen, and the player (a 66 pt play button, sentence back and forward, speed, voice)', !!bars && bars.play.shown && bars.play.h >= 60 && [bars.back, bars.fwd, bars.speed, bars.voice, bars.read, bars.listen, bars.look, bars.tutor, bars.lib].every((b) => b.shown && b.h >= 44) && bars.top >= 0, JSON.stringify(bars));
  await p.evaluate(() => document.getElementById('t-speed').click());
  ok('...the speed button steps the speed (it is remembered)', (await until(() => stores.local.drSettings && stores.local.drSettings.voice && Math.abs(stores.local.drSettings.voice.rate - 1.1) < 0.001, 3000)) === true, JSON.stringify(stores.local.drSettings && stores.local.drSettings.voice));
  await p.evaluate(() => document.getElementById('b-tutor').click());
  const ts = await p.evaluate(() => { const b = document.getElementById('sheet-body'); const g = (n) => b.querySelector(`.opts[data-name="${n}"]`); return { level: [...g('learnerLevel').querySelectorAll('button')].map((x) => x.textContent).join(' '), levelOn: g('learnerLevel').querySelector('.on').textContent, kinds: ['pctWords', 'pctPhrases', 'pctSentences'].map((n) => (b.querySelector(`input[data-name="${n}"]`) || {}).value).join(' '), sw: ['stopItemsOn', 'stopPhrasesOn', 'stopHardOn'].every((n) => !!g(n)), card: g('cardSize').querySelector('.on').dataset.v, voice: [...g('voice').querySelectorAll('button')].map((x) => x.dataset.v).join(' '), keys: [...b.querySelectorAll('input[data-key]')].map((x) => x.dataset.key).join(' '), types: [...b.querySelectorAll('input[data-key]')].every((x) => x.type === 'password'), text: b.innerText }; });
  ok('the tutor\'s settings are the ones of I Know: my level A1 to C2, Words / Phrases / Sentences each with a switch and its own "how much", the card Big or Small, the voice, the keys',
    ts.level === 'A1 A2 B1 B2 C1 C2' && ts.levelOn === 'B2' && ts.kinds === '100 100 100' && ts.sw && ts.card === 'big' && ts.voice === 'auto azure openai elevenlabs mac' && /anthropic/.test(ts.keys) && /azure/.test(ts.keys) && ts.types && !ts.text.includes('sk-ant-test-key'), JSON.stringify({ ...ts, text: undefined }));
  const chosen0 = (await dbg()).chosen;
  await p.evaluate(() => { const i = document.querySelector('#sheet-body input[data-name="pctWords"]'); i.value = '0'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const none = await until(async () => { const d = await dbg(); return stores.local.drExtras.pctWords === 0 && d.chosen < chosen0 ? d : null; }, 4000);
  await p.evaluate(() => { const i = document.querySelector('#sheet-body input[data-name="pctWords"]'); i.value = '100'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(() => stores.local.drExtras.pctWords === 100, 3000);
  ok('...words at 0 %: fewer stops at once (the same store as I Know: it counts there too)', !!none, JSON.stringify({ chosen0, now: none && none.chosen }));
  await p.evaluate(() => document.querySelector('#sheet-body .opts[data-name="cardSize"] button[data-v="small"]').click());
  await until(() => stores.local.drExtras.cardSize === 'small', 3000);
  await p.evaluate(() => document.getElementById('veil').click());
  await p.evaluate(() => window.__iknowBook.turn(-1));
  await p.evaluate(() => window.__iknowBook.turn(-1));
  await sleep(500);
  await barsOff(p);
  await tapWord(p, 'empty');
  const small = await until(async () => { const d = await dbg(); return d.card && !d.card.big ? d : null; }, 5000, 40);
  const smallSeen = small ? await p.evaluate(() => { const s = document.getElementById('small'); const r = s.getBoundingClientRect(); return { display: getComputedStyle(s).display, big: getComputedStyle(document.getElementById('card')).display, btns: [...s.querySelectorAll('.row button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => Math.round(b.getBoundingClientRect().height)), bottom: innerHeight - r.bottom, top: r.top }; }) : null;
  ok('the card set to Small: a small card at the bottom with its own buttons (I know, Explain, close), the page stays in view', !!small && smallSeen.display !== 'none' && smallSeen.big === 'none' && smallSeen.btns.length >= 2 && smallSeen.btns.every((h) => h >= 44) && smallSeen.top > 300, JSON.stringify(smallSeen));
  await p.evaluate(() => document.querySelector('#small [data-a="close"]').click());
  await sleep(300);
  ok('...its close button takes it away, really', (await p.evaluate(() => getComputedStyle(document.getElementById('small')).display)) === 'none' && !(await dbg()).card);
  await p.evaluate(() => { document.getElementById('b-tutor').click(); });
  await p.evaluate(() => document.querySelector('#sheet-body .opts[data-name="cardSize"] button[data-v="big"]').click());
  await until(() => stores.local.drExtras.cardSize === 'big', 3000);
  await p.evaluate(() => document.getElementById('veil').click());

  // ---- 9. my books ----
  await p.evaluate(() => document.getElementById('b-lib').click());
  const lib = await until(() => p.evaluate(() => { const h = document.getElementById('hero'); if (getComputedStyle(document.getElementById('lib')).display === 'none' || getComputedStyle(h).display === 'none') return null; const cv = h.querySelector('.cover').getBoundingClientRect(); return { title: h.querySelector('h2').textContent, by: h.querySelector('.by').textContent, eyebrow: h.querySelector('.eyebrow').textContent, cover: [Math.round(cv.width), Math.round(cv.height)], acts: [...h.querySelectorAll('.acts .pill')].map((b) => b.textContent.trim()).join(' | '), add: !!document.querySelector('#grid .tile.add'), rd: getComputedStyle(document.getElementById('rd')).display }; }), 5000);
  ok('My books: the book I am reading is first, with a cover made from its title, how far I am, and Read / Listen; "Add a book" beside it', !!lib && lib.title === 'My Story' && /Ann Writer/.test(lib.by) && /\d+%/.test(lib.by) && lib.eyebrow === 'Continue' && lib.cover[0] > 80 && Math.abs(lib.cover[1] / lib.cover[0] - 1.5) < 0.05 && lib.acts === 'Read | Listen' && lib.add && lib.rd === 'none', JSON.stringify(lib));
  ok('...leaving the book to the list is remembered too (the app opens on the list next time)', (await until(() => stores.local.bkOpen === '', 3000)) === true, JSON.stringify(stores.local.bkOpen));
  await p.evaluate(() => document.querySelector('#hero [data-a="more"]').click());
  await p.evaluate(() => document.querySelector('#sheet-body [data-a="remove"]').click());
  const sure = await p.evaluate(() => document.querySelector('#sheet-body [data-a="remove"]').textContent);
  await p.evaluate(() => document.querySelector('#sheet-body [data-a="remove"]').click());
  const emptied = await until(() => p.evaluate(() => (getComputedStyle(document.getElementById('empty')).display !== 'none' && getComputedStyle(document.getElementById('hero')).display === 'none' ? true : null)), 5000);
  ok('a book can be removed (asked once more); the words I learned from it stay', /again/i.test(sure) && !!emptied && (stores.local.drVocab.words || {}).meticulous === 'learning', sure);
  await p.evaluate(() => document.getElementById('e-sample').click());
  const sample = await until(async () => { const d = await dbg(); return d && d.open && d.sentences > 20 ? d : null; }, 20000);
  ok('"Try a short story" opens a story that comes with the app (The Happy Prince)', !!sample && /Happy Prince/.test(await p.evaluate(() => document.getElementById('ttl').textContent)) && /High above the city/.test(await firstSentence(p)), JSON.stringify(sample && { pages: sample.pages }));

  // ---- 9b. what the review found: the small player, a narrow phone, a closed card, the end of the book, the tutor off ----
  {
  await p.evaluate(() => document.getElementById('mode-listen').click());
  await sleep(500);
  await barsOff(p);
  const mini = await p.evaluate(() => { const m = document.getElementById('mini'); const r = m.getBoundingClientRect(); const ws = [...document.querySelectorAll('#flow .w')].map((w) => w.getBoundingClientRect()).filter((x) => x.left >= 0 && x.right <= innerWidth && x.width > 0); return { display: getComputedStyle(m).display, top: Math.round(r.top), lowest: Math.round(Math.max(...ws.map((x) => x.bottom))), words: ws.length }; });
  ok('Listening: the small player is under the text, never on it (the last line of the page is above it)', mini.display !== 'none' && mini.words > 30 && mini.lowest <= mini.top, JSON.stringify(mini));
  const vp = p.viewportSize();
  await p.setViewportSize({ width: 320, height: 568 });
  await p.evaluate(() => document.getElementById('rd').classList.remove('plain'));
  await sleep(700);
  const row = await p.evaluate(() => { const xs = [...document.querySelector('.transport').children].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), e.id, Math.round(r.height)]; }); return { xs, w: innerWidth, overlap: xs.some((x, i) => i > 0 && x[0] < xs[i - 1][1]) }; });
  ok('a narrow phone (320 wide): the row of the player fits: speed, back, play, on, voice, none cut and none over another', row.xs.length === 5 && row.xs.every((x) => x[0] >= 0 && x[1] <= row.w && x[3] >= 44 && x[1] - x[0] >= 44) && row.xs[4][1] - row.xs[4][0] >= 62 && !row.overlap, JSON.stringify(row));
  await p.setViewportSize(vp);
  await sleep(500);
  await p.evaluate(() => { document.getElementById('b-tutor').click(); });
  await p.evaluate(() => document.querySelector('#sheet-body .opts[data-name="cardSize"] button[data-v="small"]').click());
  await until(() => stores.local.drExtras.cardSize === 'small', 3000);
  await p.evaluate(() => document.getElementById('veil').click());
  await p.evaluate(() => window.__iknowBook.openText('Short', 'The morning was quiet and the street was empty. Phones are ubiquitous in every city now. We had some bread and a cup of tea. The dog ran home. The day came to its end.', ''));
  const short = await until(async () => { const d = await dbg(); return d && d.open && d.sentences === 5 ? d : null; }, 20000);
  await p.evaluate(() => window.__iknowBook.play(true));
  const stopCard = await until(async () => { const d = await dbg(); return d.card && !d.card.big && d.card.word === 'ubiquitous' ? d : null; }, 20000, 40);
  await p.evaluate(() => document.querySelector('#small [data-a="close"]').click());
  const wentOn = await until(async () => { const d = await dbg(); return d.spoken.some((x) => /cup of tea/.test(x)) ? d : null; }, 8000, 40);
  ok('Listening, the card closed by hand at a stop: the book goes on with the next sentence (it does not hang)', !!short && !!stopCard && !!wentOn && !wentOn.card, JSON.stringify({ short: !!short, stop: stopCard && stopCard.card, index: wentOn && wentOn.index }));
  const ended = await until(async () => { const d = await dbg(); return !d.playing && d.spoken.some((x) => /came to its end/.test(x)) ? d : null; }, 20000);
  const errs0 = pageErrors.length;
  const saidAtEnd = ended ? ended.spoken.filter((x) => /came to its end/.test(x)).length : -1;
  await p.evaluate(() => document.getElementById('m-play').click());
  const again = await until(async () => { const d = await dbg(); return d.spoken.filter((x) => /came to its end/.test(x)).length > saidAtEnd ? d : null; }, 8000, 40);
  await until(async () => !(await dbg()).playing, 8000);
  await p.evaluate(() => { document.getElementById('m-fwd').click(); document.getElementById('m-back').click(); });
  await sleep(300);
  await p.evaluate(() => window.__iknowBook.play(false));
  ok('the end of the book: the reading stops on the last sentence; Play and the step buttons still work there (no error)', !!ended && ended.index === 4 && !!again && pageErrors.length === errs0, JSON.stringify({ index: ended && ended.index, again: !!again, errors: pageErrors.slice(errs0) }));
  await p.evaluate(() => { document.getElementById('b-tutor').click(); });
  await p.evaluate(() => document.querySelector('#sheet-body .opts[data-name="cardSize"] button[data-v="big"]').click());
  await until(() => stores.local.drExtras.cardSize === 'big', 3000);
  await p.evaluate(() => document.querySelector('#sheet-body .opts[data-name="tutorOn"] button[data-v="off"]').click());
  await until(() => stores.local.drExtras.tutorOn === false, 3000);
  await sleep(400);
  await p.evaluate(() => document.getElementById('veil').click());
  await p.evaluate(() => document.getElementById('mode-read').click());
  await sleep(400);
  await barsOff(p);
  const rule0 = apiLog.length;
  await tapWord(p, 'street');
  const offCard = await until(async () => { const d = await dbg(); return d.card && d.card.big && d.card.word === 'street' ? d : null; }, 5000, 40);
  await sleep(1800);
  const stays = await seen(p, 'card');
  await p.touchscreen.tap(195, 300);
  const offGone = await until(async () => { const d = await dbg(); return !d.card ? d : null; }, 3000, 40);
  ok('the tutor off: a tapped word still gets its card (the dictionary, no AI), it stays until I tap it, and one tap takes it away, really', !!offCard && stays.display !== 'none' && !!offGone && (await seen(p, 'card')).display === 'none' && apiLog.length === rule0 && (stores.local.drVocab.words || {}).street === 'learning' && !offGone.playing, JSON.stringify({ card: offCard && offCard.card, stays: stays.display, gone: !!offGone, ai: apiLog.length - rule0, word: (stores.local.drVocab.words || {}).street }));
  ok('no error on the page in the whole run', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));
  }

  // ---- 11. version 1.1, speed: light parts, and taps that answer at once ----
  {
  const errs1 = pageErrors.length;
  await p.evaluate(() => { document.getElementById('b-tutor').click(); });
  await p.evaluate(() => document.querySelector('#sheet-body .opts[data-name="tutorOn"] button[data-v="on"]').click());
  await until(() => stores.local.drExtras.tutorOn === true, 3000);
  await sleep(400);
  await p.evaluate(() => document.getElementById('veil').click());
  // what is in the app's store for a book: the letters of each part, its titles, the shelf row
  const inStore = (id) => p.evaluate((bookId) => new Promise((res) => { const r = indexedDB.open('iknowBooks', 1); r.onerror = () => res(null); r.onsuccess = () => { const db = r.result; const tx = db.transaction(['shelf', 'texts']); const a = tx.objectStore('shelf').get(bookId), b = tx.objectStore('texts').get(bookId); tx.oncomplete = () => { db.close(); const t = b.result; res(t ? { shelf: a.result || null, sizes: t.chapters.map((c) => c.blocks.reduce((n, x) => n + x.text.length, 0)), titles: t.chapters.map((c) => c.title), longest: Math.max(...t.chapters.map((c) => Math.max(...c.blocks.map((x) => x.text.length)))), first: t.chapters.map((c) => c.blocks[0].text.slice(0, 24)) } : null); }; }; }), id);
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  // a big book, added now: cut into light parts as it comes in
  const tAdd = Date.now();
  await p.evaluate(([t, x]) => window.__iknowBook.openText(t, x, ''), ['Big Book', BIG]);
  const bigOpen = await until(async () => { const d = await dbg(); return d && d.open && d.chapters > 20 && d.sentences > 20 ? d : null; }, 30000, 40);
  const addMs = Date.now() - tAdd;
  const bigStore = bigOpen ? await inStore(bigOpen.open) : null;
  const letters = sum(BIG_PARAS.map((x) => x.length));
  ok(`a big book (${letters} letters, about 300 pages) is kept in light parts: about 14,000 letters each, none over 20,000, and every letter is there`,
    !!bigStore && bigStore.sizes.length > 30 && Math.max(...bigStore.sizes) <= 20000 && Math.min(...bigStore.sizes) > 2500 && sum(bigStore.sizes) === letters && bigStore.shelf.split === 2 && bigStore.shelf.chapterChars.length === bigStore.sizes.length,
    JSON.stringify(bigStore && { parts: bigStore.sizes.length, biggest: Math.max(...bigStore.sizes), smallest: Math.min(...bigStore.sizes), letters: sum(bigStore.sizes), addMs }));
  const sel0 = await p.evaluate(() => { const s = document.getElementById('chapters'); return { n: s.options.length, a: s.options[0].textContent, b: s.options[1].textContent, shown: getComputedStyle(document.querySelector('.where')).display !== 'none' }; });
  ok('...the list of parts says "Part 2 of N"; the part on the page is small (a few hundred sentences, not the whole book)', !!bigStore && sel0.n === bigStore.sizes.length && sel0.a === `Part 1 of ${sel0.n}` && sel0.b === `Part 2 of ${sel0.n}` && bigOpen.sentences < 400 && /~2#0$/.test(bigOpen.ai), JSON.stringify({ sel0, sentences: bigOpen && bigOpen.sentences, pages: bigOpen && bigOpen.pages, ai: bigOpen && bigOpen.ai }));

  // the meter: from the end of a touch (before the app sees it) to the second animation frame after it = it is painted
  await p.evaluate(() => {
    window.__runs = [];
    window.addEventListener('touchend', () => {
      const t0 = performance.now();
      const flow = document.getElementById('flow');
      const was = new DOMMatrix(getComputedStyle(flow).transform).m41;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const card = document.getElementById('card');
        const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        window.__runs.push({ ms: Math.round((performance.now() - t0) * 10) / 10, card: getComputedStyle(card).display !== 'none' && card.getBoundingClientRect().height > 600, onTop: !!(top && card.contains(top)), under: top ? (top.closest('#page') ? 'page' : top.id || top.className) : '', word: card.querySelector('.word').textContent, was, now: new DOMMatrix(getComputedStyle(flow).transform).m41, goal: flow.style.transform });
      }));
    }, true);
  });
  const runs = () => p.evaluate(() => window.__runs.length);
  const lastRun = async (n) => { await until(async () => (await runs()) > n, 3000, 20); return p.evaluate(() => window.__runs[window.__runs.length - 1]); };
  // a word on the page that I never touched, in the middle of the screen
  const freshWord = (skip = []) => p.evaluate(([known, no]) => { const pg = document.getElementById('page').getBoundingClientRect(); const e = [...document.querySelectorAll('#flow .w')].find((x) => { const t = x.textContent; if (!/^[a-z]{5,}$/.test(t) || known.includes(t) || no.includes(t) || x.classList.contains('hard') || x.classList.contains('learning')) return false; const r = x.getBoundingClientRect(); return r.left >= 30 && r.right <= innerWidth - 30 && r.top > pg.top + 150 && r.bottom < pg.bottom - 220; }); if (!e) return null; const r = e.getBoundingClientRect(); return { word: e.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, [Object.keys(stores.local.drVocab.words || {}), skip]);
  await until(async () => !(await dbg()).chrome, 6000);
  await sleep(300);

  // tap a word -> the card painted; tap the card -> the card gone. Three words, each one new to me (the slow path before).
  const heavy0 = (await dbg()).heavy;
  const opened = [], closed = [];
  for (let i = 0; i < 3; i++) {
    const w = await freshWord();
    if (!w) break;
    let n = await runs();
    await p.touchscreen.tap(w.x, w.y);
    const a = await lastRun(n);
    opened.push({ word: w.word, ms: a.ms, ok: a.card && a.onTop && a.word === w.word });
    // (the third one: tapped while the tutor is in the middle of saying it, where the card used to wait 350 ms)
    if (i === 2) await until(async () => { const d = await dbg(); return d.spoken.filter((x) => x === w.word).length >= 1 ? d : null; }, 5000, 20);
    n = await runs();
    await p.touchscreen.tap(195, 520);
    const b = await lastRun(n);
    closed.push({ word: w.word, ms: b.ms, ok: !b.card && !b.onTop && b.under === 'page' });
    await until(() => (stores.local.drVocab.words || {})[w.word] === 'known', 4000, 40);
  }
  ok(`a tap on a word of the big book: its card is painted in ${opened.map((x) => x.ms).join(' / ')} ms (limit 150)`, opened.length === 3 && opened.every((x) => x.ok && x.ms < 150), JSON.stringify(opened));
  ok(`a tap on the card: the card is gone, the page is back, in ${closed.map((x) => x.ms).join(' / ')} ms (limit 150)`, closed.length === 3 && closed.every((x) => x.ok && x.ms < 150), JSON.stringify(closed));
  ok('...and the words are known in my list a moment later (written after the card is gone), their marks stay off', opened.length === 3 && opened.every((x) => (stores.local.drVocab.words || {})[x.word] === 'known') && (await p.evaluate((ws) => [...document.querySelectorAll('#flow .w')].filter((x) => ws.includes(x.textContent)).every((x) => !x.classList.contains('learning') && !x.classList.contains('hard')), opened.map((x) => x.word))), JSON.stringify(opened.map((x) => [x.word, (stores.local.drVocab.words || {})[x.word]])));
  await sleep(500);
  const quietNow = await dbg();
  ok('...and none of these taps started a pass over the whole part (the page\'s own writes to my word list come back and cost nothing)', heavy0 >= 1 && quietNow.heavy === heavy0, JSON.stringify({ before: heavy0, after: quietNow.heavy }));
  await sleep(700);
  ok('...and the tutor is silent after "I know" (nothing more is said)', !quietNow.card && (await dbg()).spoken.length === quietNow.spoken.length && !quietNow.playing, JSON.stringify(quietNow.spoken.slice(-3)));

  // a page turn: the slide has started by the second frame
  const turns = [];
  for (let i = 0; i < 3; i++) {
    const before = (await dbg()).page;
    const n = await runs();
    await p.touchscreen.tap(p.viewportSize().width - 6, 380);
    const r = await lastRun(n);
    const d = await until(async () => { const x = await dbg(); return x.page === before + 1 ? x : null; }, 2000, 20);
    turns.push({ ms: r.ms, ok: !!d && r.goal !== '' && r.now !== r.was && /translate3d\(-\d+px/.test(r.goal), moved: Math.round(r.was - r.now) });
    await sleep(380);
  }
  const shiftVar = await p.evaluate(() => ({ html: document.documentElement.style.getPropertyValue('--shift') + document.documentElement.style.getPropertyValue('--col'), flow: document.getElementById('flow').style.transform, col: document.getElementById('flow').style.columnWidth, blur: [...document.querySelectorAll('.chrome, #mini, #caption, #card, #small')].map((e) => getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter || 'none').join(' '), touch: ['rd', 'card', 'small', 'sheet'].map((id) => getComputedStyle(document.getElementById(id)).touchAction).join(' ') }));
  ok(`a page turn of the big book starts in ${turns.map((x) => x.ms).join(' / ')} ms (limit 100): the page is already sliding at the second frame`, turns.length === 3 && turns.every((x) => x.ok && x.ms < 100), JSON.stringify(turns));
  ok('...the page is moved on the text block itself (no variable on <html>), nothing is blurred behind the bars or the cards, and a tap is not held back for a second tap', shiftVar.html === '' && /translate3d/.test(shiftVar.flow) && /px$/.test(shiftVar.col) && /^(none ?)+$/.test(shiftVar.blur) && shiftVar.touch === 'manipulation manipulation manipulation manipulation', JSON.stringify(shiftVar));

  // the turn into the next part, and the text size on a big book
  const part0 = await dbg();
  const cross = await p.evaluate(() => new Promise((res) => { const d0 = JSON.parse(document.documentElement.dataset.drDebug); const sel = document.getElementById('chapters'); sel.value = String(d0.chapter + 1); const t0 = performance.now(); sel.dispatchEvent(new Event('change', { bubbles: true })); requestAnimationFrame(() => requestAnimationFrame(() => { const d = JSON.parse(document.documentElement.dataset.drDebug); const f = [...document.querySelectorAll('#flow .s')].find((x) => { const r = x.getClientRects()[0]; return r && r.left >= 0 && r.left < innerWidth; }); res({ ms: Math.round(performance.now() - t0), chapter: d.chapter, first: f ? f.textContent.slice(0, 22) : '', sentences: d.sentences }); })); }));
  ok(`the next part of the big book is on the page in ${cross.ms} ms (limit 400)`, cross.chapter === part0.chapter + 1 && /^Paragraph \d+ begins/.test(cross.first) && cross.ms < 400, JSON.stringify(cross));
  await p.evaluate(() => document.getElementById('b-look').click());
  const sized = await p.evaluate(() => new Promise((res) => { const flow = document.getElementById('flow'); const pages0 = JSON.parse(document.documentElement.dataset.drDebug).pages; const i = document.querySelector('#sheet-body input[data-name="size"]'); const t0 = performance.now(); let steps = 0; const step = (v) => { i.value = String(v); i.dispatchEvent(new Event('input', { bubbles: true })); steps++; }; step(19); step(20); step(21); step(22); const out = i.parentElement.querySelector('output').textContent; const at0 = getComputedStyle(flow).fontSize; const tick = () => { const d = JSON.parse(document.documentElement.dataset.drDebug); if (getComputedStyle(flow).fontSize === '22px' && d.pages > pages0) res({ ms: Math.round(performance.now() - t0), out, at0, pages: [pages0, d.pages], steps }); else if (performance.now() - t0 > 3000) res({ ms: -1, out, at0, pages: [pages0, d.pages] }); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }));
  ok(`the text size slider on the big book: the number follows the finger at once, the page follows within a moment (${sized.ms} ms for four steps, one layout; limit 600)`, sized.out === '22' && sized.at0 === '18px' && sized.ms > 100 && sized.ms < 600, JSON.stringify(sized));
  await p.evaluate(() => document.querySelector('#sheet-body [data-a="reset"]').click());
  await sleep(300);
  await p.evaluate(() => document.getElementById('veil').click());

  // taps that were lost before
  await p.evaluate(() => document.getElementById('rd').classList.remove('plain'));
  await sleep(400);
  const wBars = await freshWord();
  let n1 = await runs();
  await p.touchscreen.tap(wBars.x, wBars.y);
  const rBars = await lastRun(n1);
  const barsAfter = await p.evaluate(() => ({ plain: document.getElementById('rd').classList.contains('plain') }));
  ok('the bars are showing and I tap a word: the bars go AND the word opens, in the same tap (before: that tap only sent the bars away)', rBars.card && rBars.onTop && rBars.word === wBars.word && barsAfter.plain && rBars.ms < 150, JSON.stringify({ rBars, barsAfter }));
  // (a long, slow press on the card counts too: 900 ms, moved 12 px)
  const slowCard = await p.evaluate(async () => { const c = document.getElementById('card'); const ev = (type, x, y, live) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'touches', { value: live ? [{ clientX: x, clientY: y }] : [] }); Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] }); return e; }; c.dispatchEvent(ev('touchstart', 190, 500, true)); await new Promise((r) => setTimeout(r, 900)); c.dispatchEvent(ev('touchend', 198, 509, false)); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return getComputedStyle(c).display; });
  ok('a slow press on the card (0.9 s, the finger moved a little) is "I know" too: the card is gone', slowCard === 'none' && !(await dbg()).card, slowCard);
  await sleep(300);
  // (a slow tap on a word: 600 ms, moved 11 px)
  const wSlow = await freshWord();
  const slowTap = await p.evaluate(async (w) => { const el = document.elementFromPoint(w.x, w.y); const ev = (type, x, y, live) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'touches', { value: live ? [{ clientX: x, clientY: y }] : [] }); Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] }); return e; }; el.dispatchEvent(ev('touchstart', w.x, w.y, true)); await new Promise((r) => setTimeout(r, 600)); const end = ev('touchend', w.x + 8, w.y + 8, false); el.dispatchEvent(end); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const c = document.getElementById('card'); return { shown: getComputedStyle(c).display !== 'none', word: c.querySelector('.word').textContent, prevented: end.defaultPrevented }; }, wSlow);
  ok('a slow tap on a word (0.6 s, the finger moved a little) opens it; the page took the touch, so no click follows it', slowTap.shown && slowTap.word === wSlow.word && slowTap.prevented, JSON.stringify({ slowTap, word: wSlow.word }));
  await p.touchscreen.tap(195, 520);
  await until(async () => !(await dbg()).card, 3000, 30);
  await sleep(300);
  // (a long press selects the word: that is a tap on it)
  const wSel = await freshWord();
  const tSel = Date.now();
  await p.evaluate((w) => { const el = document.elementFromPoint(w.x, w.y); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, wSel);
  const selCard = await until(async () => { const d = await dbg(); return d.card && d.card.word === wSel.word ? d : null; }, 2500, 25);
  const selMs = Date.now() - tSel;
  ok(`a long press that selects one word opens that word (${selMs} ms after the selection; before: nothing, and the next tap was lost)`, !!selCard && selMs < 900 && (await p.evaluate(() => getSelection().toString())) === '' && (await seen(p, 'card')).onTop, JSON.stringify({ card: selCard && selCard.card, selMs }));
  await p.touchscreen.tap(195, 520);
  await until(async () => !(await dbg()).card, 3000, 30);
  await sleep(300);
  // (a selection left on the page does not block the next tap)
  const wA = await freshWord();
  const wB = await freshWord([wA.word]);
  const left = await p.evaluate(async ([a, b]) => { const ea = document.elementFromPoint(a.x, a.y), eb = document.elementFromPoint(b.x, b.y); const r = document.createRange(); r.selectNodeContents(ea); const s = getSelection(); s.removeAllRanges(); s.addRange(r); const ev = (type, live) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'touches', { value: live ? [{ clientX: b.x, clientY: b.y }] : [] }); Object.defineProperty(e, 'changedTouches', { value: [{ clientX: b.x, clientY: b.y }] }); return e; }; eb.dispatchEvent(ev('touchstart', true)); eb.dispatchEvent(ev('touchend', false)); await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); const c = document.getElementById('card'); const first = c.querySelector('.word').textContent; await new Promise((res) => setTimeout(res, 500)); return { shown: getComputedStyle(c).display !== 'none', first, later: c.querySelector('.word').textContent, sel: getSelection().toString() }; }, [wA, wB]);
  ok('a selection left on the page does not block the next tap: the tapped word opens (and not the selected one a moment later)', left.shown && left.first === wB.word && left.later === wB.word && left.sel === '', JSON.stringify({ left, a: wA.word, b: wB.word }));
  await p.touchscreen.tap(195, 520);
  await until(async () => !(await dbg()).card, 3000, 30);
  await sleep(300);
  // (a few words selected: the phrase is asked a moment after, not 0.9 s later)
  const tPh = Date.now();
  const phrase = await p.evaluate(() => { const pg = document.getElementById('page').getBoundingClientRect(); const s = [...document.querySelectorAll('#flow .s')].find((x) => { const r = x.getClientRects()[0]; return r && r.left >= 0 && r.left < innerWidth && r.top > pg.top + 100 && x.querySelectorAll('.w').length >= 8; }); const ws = s.querySelectorAll('.w'); const r = document.createRange(); r.setStartBefore(ws[3]); r.setEndAfter(ws[5]); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return sel.toString(); });
  const phCard = await until(async () => { const d = await dbg(); return d.card && d.card.word === phrase ? d : null; }, 2500, 25);
  const phMs = Date.now() - tPh;
  ok(`a few selected words open as a phrase ${phMs} ms after the selection (before: 900 ms and more)`, !!phCard && phCard.card.kind === 'sentence' && phrase.split(' ').length === 3 && phMs < 800, JSON.stringify({ phrase, card: phCard && phCard.card, phMs }));
  await p.touchscreen.tap(195, 520);
  await until(async () => !(await dbg()).card, 3000, 30);
  await sleep(300);
  // (the finger that selected the words lifts: asked in that moment, no wait at all)
  const lift = await p.evaluate(async () => { const pg = document.getElementById('page').getBoundingClientRect(); const s = [...document.querySelectorAll('#flow .s')].filter((x) => { const r = x.getClientRects()[0]; return r && r.left >= 0 && r.left < innerWidth && r.top > pg.top + 100 && x.querySelectorAll('.w').length >= 10; })[1]; const ws = s.querySelectorAll('.w'); const b = ws[6].getBoundingClientRect(); const ev = (type, live) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'touches', { value: live ? [{ clientX: b.left + 4, clientY: b.top + 6 }] : [] }); Object.defineProperty(e, 'changedTouches', { value: [{ clientX: b.left + 60, clientY: b.top + 6 }] }); return e; }; ws[6].dispatchEvent(ev('touchstart', true)); await new Promise((res) => setTimeout(res, 700)); const r = document.createRange(); r.setStartBefore(ws[6]); r.setEndAfter(ws[8]); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); const phrase = sel.toString(); const t0 = performance.now(); ws[6].dispatchEvent(ev('touchend', false)); await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); const c = document.getElementById('card'); return { ms: Math.round(performance.now() - t0), shown: getComputedStyle(c).display !== 'none', word: c.querySelector('.word').textContent, phrase, page: JSON.parse(document.documentElement.dataset.drDebug).page, sel: getSelection().toString() }; });
  const pageNow = (await dbg()).page;
  ok(`...and when the finger that selected them lifts, they are asked in that moment (${lift.ms} ms; the long sideways move is no page turn)`, lift.shown && lift.word === lift.phrase && lift.phrase.split(' ').length === 3 && lift.ms < 150 && lift.sel === '' && lift.page === pageNow, JSON.stringify(lift));
  await p.touchscreen.tap(195, 520);
  await until(async () => !(await dbg()).card, 3000, 30);
  // (the small card is open and I tap another word: that word opens in the same tap)
  await p.evaluate(() => { document.getElementById('b-tutor').click(); });
  await p.evaluate(() => document.querySelector('#sheet-body .opts[data-name="cardSize"] button[data-v="small"]').click());
  await until(() => stores.local.drExtras.cardSize === 'small', 3000);
  await p.evaluate(() => document.getElementById('veil').click());
  await barsOff(p);
  const s1 = await freshWord();
  await p.touchscreen.tap(s1.x, s1.y);
  const small1 = await until(async () => { const d = await dbg(); return d.card && !d.card.big && d.card.word === s1.word ? d : null; }, 3000, 25);
  const s2 = await freshWord([s1.word]);
  await p.touchscreen.tap(s2.x, s2.y);
  await p.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
  const small2 = await p.evaluate(() => { const s = document.getElementById('small'); return { shown: getComputedStyle(s).display !== 'none' && s.getBoundingClientRect().height > 80, word: s.querySelector('.word').textContent }; });
  ok('the small card is open and I tap another word: that word\'s card is there in the same tap (before: the tap only closed the card)', !!small1 && small2.shown && small2.word === s2.word && s2.word !== s1.word, JSON.stringify({ first: s1.word, second: s2.word, small2 }));
  // (the small card's "I know": gone at once)
  const smallKnow = await p.evaluate(() => new Promise((res) => { const s = document.getElementById('small'); const t0 = performance.now(); s.querySelector('[data-a="know"]').click(); requestAnimationFrame(() => requestAnimationFrame(() => res({ ms: Math.round(performance.now() - t0), display: getComputedStyle(s).display }))); }));
  ok(`the small card's "I know": the card is gone in ${smallKnow.ms} ms (limit 150), the word is known`, smallKnow.display === 'none' && smallKnow.ms < 150 && (await until(() => (stores.local.drVocab.words || {})[s2.word] === 'known', 4000, 40)) === true, JSON.stringify(smallKnow));
  await p.evaluate(() => { document.getElementById('b-tutor').click(); });
  await p.evaluate(() => document.querySelector('#sheet-body .opts[data-name="cardSize"] button[data-v="big"]').click());
  await until(() => stores.local.drExtras.cardSize === 'big', 3000);
  await p.evaluate(() => document.getElementById('veil').click());

  // Listening, "I know" at a stop: the card goes in the tap, the book reads on
  await p.evaluate(() => window.__iknowBook.openText('Know Stop', 'The morning was quiet and the street was empty. Phones are ephemeral in every city now. We had some bread and a cup of tea. The dog ran home. The day came to its end.', ''));
  await until(async () => { const d = await dbg(); return d && d.open && d.sentences === 5 ? d : null; }, 20000);
  await p.evaluate(() => { window.__runs = []; });
  await p.evaluate(() => window.__iknowBook.play(true));
  const stopWait = await until(async () => { const d = await dbg(); return d.card && d.card.big && d.card.word === 'ephemeral' && d.waiting ? d : null; }, 20000, 30);
  const nStop = await runs();
  await p.touchscreen.tap(195, 520);
  const rStop = await lastRun(nStop);
  const readOn = await until(async () => { const d = await dbg(); return d.spoken.some((x) => /cup of tea/.test(x)) ? d : null; }, 8000, 40);
  ok(`Listening, a tap on the card at a stop = I know: the card is gone in ${rStop.ms} ms (limit 150), nothing is explained, and the book reads on`, !!stopWait && !rStop.card && rStop.under === 'page' && rStop.ms < 150 && !!readOn && readOn.playing && readOn.spoken.filter((x) => x === 'ephemeral').length === 1 && !readOn.spoken.some((x) => /means/.test(x) && /phemeral/.test(x)) && (await until(() => (stores.local.drVocab.words || {}).ephemeral === 'known', 4000, 40)) === true, JSON.stringify({ stop: stopWait && stopWait.card, rStop, said: readOn && readOn.spoken.slice(-4) }));
  await p.evaluate(() => window.__iknowBook.play(false));
  await sleep(300);

  // a book stored the old way (version 1.0: a whole PDF as ONE chapter), written straight into the store
  const OLD_ID = 'text-0ldway000000001';
  const oldChars = sum(BIG_PARAS.map((x) => x.length));
  await p.evaluate(() => window.__iknowBook.library());
  await until(() => p.evaluate(() => getComputedStyle(document.getElementById('lib')).display !== 'none'), 4000);
  const wrote = await p.evaluate(([id, paras, chars]) => new Promise((res) => { const r = indexedDB.open('iknowBooks', 1); r.onerror = () => res('no db'); r.onsuccess = () => { const db = r.result; const tx = db.transaction(['shelf', 'texts'], 'readwrite'); const now = new Date(Date.now() + 60000).toISOString(); tx.objectStore('shelf').put({ id, title: 'Old Heavy Book', author: '', kind: 'pdf', addedAt: now, openedAt: now, chapterChars: [chars], chapterTitles: [''], place: { chapter: 0, paragraph: 612, sentence: 2 }, percent: 59 }); tx.objectStore('texts').put({ id, chapters: [{ title: '', blocks: paras.map((text) => ({ kind: 'p', text })) }] }); tx.oncomplete = () => { db.close(); res('ok'); }; tx.onerror = () => res('failed'); }; }), [OLD_ID, BIG_PARAS, oldChars]);
  const oldBefore = await inStore(OLD_ID);
  await p.close();
  stores.local.bkOpen = OLD_ID;
  const tOld = Date.now();
  p = await open(); dbg = dbgOf(p);
  const oldOpen = await until(async () => { const d = await dbg(); return d && d.open === OLD_ID && d.sentences > 20 ? d : null; }, 30000, 40);
  const oldMs = Date.now() - tOld;
  const oldAfter = await inStore(OLD_ID);
  const want = 'In part 612 line 2 the';
  const here = await p.evaluate(() => [...document.querySelectorAll('#flow .s')].filter((x) => { const r = x.getClientRects()[0]; return r && r.left >= 0 && r.left < innerWidth; }).map((x) => x.textContent.slice(0, 22)));
  ok('a book stored the old way (one chapter of 600,000 letters) is cut into light parts when it opens, and stored again that way',
    wrote === 'ok' && !!oldBefore && oldBefore.sizes.length === 1 && oldBefore.sizes[0] === oldChars && !!oldOpen && oldOpen.chapters > 30 && !!oldAfter && oldAfter.sizes.length === oldOpen.chapters && Math.max(...oldAfter.sizes) <= 20000 && sum(oldAfter.sizes) === oldChars && oldAfter.shelf.split === 2 && /~2#\d+$/.test(oldOpen.ai),
    JSON.stringify({ wrote, before: oldBefore && oldBefore.sizes.length, after: oldAfter && { parts: oldAfter.sizes.length, biggest: Math.max(...oldAfter.sizes) }, ai: oldOpen && oldOpen.ai, openMs: oldMs }));
  ok('...and I am still at the same paragraph and sentence (paragraph 612, its third sentence), now in a part of its own', !!oldOpen && oldOpen.chapter > 20 && here.includes(want) && oldOpen.place.chapter === oldOpen.chapter && oldOpen.place.sentence === 2 && oldAfter.shelf.place.chapter === oldOpen.chapter && (await p.evaluate(() => getComputedStyle(document.getElementById('busy')).display)) === 'none',
    JSON.stringify({ chapter: oldOpen && oldOpen.chapter, place: oldOpen && oldOpen.place, stored: oldAfter && oldAfter.shelf.place, here: here.slice(0, 4) }));
  await p.close();
  p = await open(); dbg = dbgOf(p);
  const oldAgain = await until(async () => { const d = await dbg(); return d && d.open === OLD_ID && d.sentences > 20 ? d : null; }, 30000, 40);
  ok('...opened once more: it is not cut a second time, and the place is the same', !!oldAgain && oldAgain.chapters === oldOpen.chapters && oldAgain.chapter === oldOpen.chapter && (await onPage(p, 'In part 612 line 2')) && JSON.stringify((await inStore(OLD_ID)).sizes) === JSON.stringify(oldAfter.sizes), JSON.stringify({ chapter: oldAgain && oldAgain.chapter, chapters: oldAgain && oldAgain.chapters }));
  ok('no error on the page in the speed checks', pageErrors.length === errs1, pageErrors.slice(errs1).join(' | ').slice(0, 400));
  }

  // ---- 10. the app itself ----
  const yml = fs.readFileSync(path.join(IOS, '..', 'project.yml'), 'utf8');
  const bs = fs.readFileSync(path.join(IOS, 'BookScreen.swift'), 'utf8');
  const appSwift = fs.readFileSync(path.join(IOS, 'YTLearnApp.swift'), 'utf8');
  ok('I Know Book is its own app beside I Know (its own name and identity, the same code): it opens straight on the book page, over the whole screen', /IKnowBook:/.test(yml) && /PRODUCT_BUNDLE_IDENTIFIER: local\.ytlearn\.book/.test(yml) && /CFBundleDisplayName: "I Know Book"/.test(yml) && /BOOK/.test(yml) && /#if BOOK\s+BookRootView\(\)/.test(appSwift) && /ytlearn:\/\/app\/dream\/book\.html/.test(bs) && /\.ignoresSafeArea\(\)/.test(bs));
  ok('...a page that iOS stopped in the background is loaded again (the book opens on its page); the app\'s own settings come when the page asks', /webViewWebContentProcessDidTerminate/.test(bs) && /backInFront/.test(bs) && /case "appSettings"/.test(fs.readFileSync(path.join(IOS, 'Bridge.swift'), 'utf8')) && /showAppSettings/.test(bs));

  await browser.close();
  api.close(); pages.close();
  console.log(H.fails() ? `\n${H.fails()} FAILED` : '\nBOOK: ALL PASSED');
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
