// I Know Book (the reading and listening app), in WebKit with an iPhone 13:
//  the library, opening a text, pages (tap, swipe, the place kept over a restart), the text settings (size, font,
//  colours, spacing: the same sentence stays on the page), a tapped word (the big card, the explanation, the word three
//  times, the card gone, nothing plays by itself), "I know", listening with the stop of I Know, the tutor's settings.
// What counts is what is REALLY on the screen (computed style, elementFromPoint), never only a hidden flag.
// Run ios/sync-scripts.sh first. The fake AI and the app's bridge are in tests/ios-harness.js.
const fs = require('fs'); const path = require('path'); const http = require('http');
const H = require('./ios-harness');
const { pw, IOS, MIME, ok, until, sleep, source, sheetScripts, stores, keychain, apiLog } = H;
const PORT = +process.env.BOOK_PAGES_PORT || 8817;
H.watchdog(7);
const api = H.startServer();

const HARD = 'My friend was very meticulous about her work.';
const FILL = (i) => `This is easy sentence number ${i} of the story. The children played in the garden after school. We had some bread and a cup of tea.`;
const PARAS = [`The morning was quiet and the street was empty. ${HARD} She walked to the shop and bought some bread.`, 'It was a lugubrious moment of joy. My uncle is a gregarious man who loves big parties.', ...Array.from({ length: 30 }, (_, i) => FILL(i + 1))];
const TEXT = PARAS.join('\n\n');

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
  await sleep(470);
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
