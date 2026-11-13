// The reader of the iPhone / iPad app (wish 26), tested in WebKit (the iPhone's engine) without Xcode.
// The page is the app's own ytlearn://app/dream/reader.html with the scripts the app gives it (AppModel.sheetScripts)
// and the stand-in for the app's Swift side (tests/ios-harness.js). The AI is a fake server on localhost.
// Checks: the import screen (EPUB accepted, the plain words about locked books), a pasted text and an EPUB go into the
// small library, hard words are marked by the one level (known words are not, words still being learned stronger), a
// tap on a word = its card (pronunciation + Chinese) and ONE request with its sentence, saved as learning, a tap on
// the card = known, the sentence button and a selection = the sentence, the place (chapter + sentence) is remembered
// after a reload, reading aloud still works, a book can be removed, and free mode asks nothing of the AI.
// Run ios/sync-scripts.sh first (the CI does). Ports: IOS_TEST_PORT (the fake AI) and READER_PAGES_PORT (the pages).
const path = require('path');
const fs = require('fs');
const http = require('http');
const H = require('./ios-harness');
const { pw, IOS, MIME, ok, until, sleep, source, sheetScripts, apiLog, nativeLog, stores, keychain } = H;
const { zipSync, strToU8 } = require(path.resolve(__dirname, '../dream-ext/node_modules/fflate'));
const PAGES_PORT = +process.env.READER_PAGES_PORT || 8815;
H.watchdog(6);
const api = H.startServer();

// ---- a long text (the place test needs something to scroll) and a tiny EPUB of two chapters ----
const HARD = 'My friend was very meticulous about her work.';
const FILL = (i) => `This is easy sentence number ${i} of the story. The children played in the garden after school. We had some bread and a cup of tea.`;
const PARAS = [`${HARD} She walked to the shop and bought some bread.`, 'It was a lugubrious moment of joy. My uncle is an obsequious man.', ...Array.from({ length: 40 }, (_, i) => FILL(i + 1))];
const TEXT = PARAS.join('\n\n');
const xhtml = (body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`;
const epub = (extra = {}) => Buffer.from(zipSync(Object.fromEntries(Object.entries({
  mimetype: 'application/epub+zip',
  'META-INF/container.xml': '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'OEBPS/content.opf': '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Tiny Book</dc:title><dc:creator>Ann Writer</dc:creator></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
  'OEBPS/toc.ncx': '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="a"><navLabel><text>The Start</text></navLabel><content src="c1.xhtml"/></navPoint><navPoint id="b"><navLabel><text>The End</text></navLabel><content src="c2.xhtml"/></navPoint></navMap></ncx>',
  'OEBPS/c1.xhtml': xhtml('<h1>The Start</h1><p>The old man had a gregarious dog. It liked every person in the town.</p><p>They walked to the sea every morning.</p>'),
  'OEBPS/c2.xhtml': xhtml('<h1>The End</h1><p>It was an ephemeral summer. Then the rain came back.</p>'),
  ...extra,
}).map(([k, v]) => [k, strToU8(v)]))));

(async () => {
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());
  const pages = http.createServer((q, r) => { const f = path.join(IOS, 'Web/dream', path.basename(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f)); }).listen(PAGES_PORT);
  const URL0 = `http://localhost:${PAGES_PORT}/reader.html`;

  const extras = (more = {}) => ({ tutorOn: true, fakeVoice: true, levelAsk: false, levelMode: true, phoneSet: true, phoneSizePx: 21, myLevel: 55, knownAfter: 7, migrated: 9, readLook: 'day', ...more });
  Object.assign(stores.local, {
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 },
    drExtras: extras(),
    drSettings: { learnerLevel: 'B2' },
    drVocab: { words: { obsequious: 'known', bread: 'learning' }, marked: {} },
  });
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const rules = () => apiLog.filter((r) => /These rules are absolute/.test(r.sys) && !/@@<its number>/.test(r.user));

  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const open = async (c = ctx) => {
    const p = await c.newPage();
    p.on('pageerror', (e) => console.log('PAGE ERROR (reader)', String(e.message || e).slice(0, 300)));
    await p.addInitScript({ content: source(sheetScripts) });
    await p.goto(URL0);
    return p;
  };
  const dbgOf = (p) => () => p.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const tapAt = (p, r) => p.touchscreen.tap(r[0] + r[2] / 2, r[1] + Math.min(r[3] / 2, 24));
  const tapWord = async (p, word) => {
    const box = await p.evaluate((w) => { const e = [...document.querySelectorAll('#text .w')].find((x) => x.textContent === w); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }, word);
    if (!box) return false;
    await p.touchscreen.tap(box[0] + box[2] / 2, box[1] + box[3] / 2);
    return true;
  };

  // ---- 1. the import screen ----
  let rd = await open();
  let dbg = dbgOf(rd);
  const imp = await rd.evaluate(() => ({ accept: document.getElementById('file').accept, text: document.getElementById('open').innerText, fileH: document.getElementById('file').getBoundingClientRect().height, goH: document.getElementById('paste-go').getBoundingClientRect().height }));
  ok('the import screen takes EPUB, PDF and text files', /\.epub/.test(imp.accept) && /\.pdf/.test(imp.accept) && /\.txt/.test(imp.accept) && /\.md/.test(imp.accept), imp.accept);
  ok('...and says plainly that bought books are locked', /Books bought in Kindle or Apple Books are locked and cannot be opened\./.test(imp.text));
  ok('...its buttons are big enough for a finger (44 pt)', imp.fileH >= 44 && imp.goH >= 44, JSON.stringify({ file: imp.fileH, go: imp.goH }));

  // ---- 2. a pasted text: into the library, on the page, nothing asked of the AI, nothing read aloud by itself ----
  const api0 = apiLog.length;
  await rd.fill('#paste', TEXT);
  await rd.fill('#paste-title', 'My Story');
  await rd.tap('#paste-go');
  const opened = await until(() => rd.evaluate(() => document.body.dataset.sentences), 20000);
  ok('a pasted text opens with all its sentences', Number(opened) === 4 + 40 * 3, String(opened) + ' · ' + await rd.evaluate(() => document.getElementById('open-msg').textContent));
  ok('...the text is exactly the original', (await rd.evaluate(() => [...document.querySelectorAll('#text p')].map((p) => p.textContent).join('\n\n'))) === TEXT);
  await sleep(700);
  const d0 = await dbg();
  ok('opening a book asks nothing of the AI and nothing is read aloud by itself', apiLog.length === api0 && d0 && !d0.playing && d0.spoken.length === 0, JSON.stringify({ api: apiLog.length - api0, playing: d0 && d0.playing }));
  ok('the book is kept in the page\'s own database (IndexedDB)', d0 && d0.store === 'idb', d0 && d0.store);

  // ---- 3. the page: the one Text size, the line height, the Play button, day / night ----
  const look = await rd.evaluate(() => { const t = document.getElementById('text'), cs = getComputedStyle(t), p = document.getElementById('play').getBoundingClientRect(); return { size: parseFloat(cs.fontSize), lh: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize), playH: p.height, playW: p.width, day: document.body.classList.contains('day'), bg: getComputedStyle(document.body).backgroundColor, wide: document.documentElement.scrollWidth > innerWidth + 1 }; });
  ok('the text is as big as the Text size setting (21) with a line height of 1.5 to 1.6', look.size === 21 && look.lh >= 1.5 && look.lh <= 1.6, JSON.stringify(look));
  ok('Play / Stop is at least 60 pt, nothing is wider than the screen', look.playH >= 60 && look.playW >= 60 && !look.wide, JSON.stringify(look));
  await rd.tap('#look');
  const nightNow = await until(() => rd.evaluate(() => !document.body.classList.contains('day')), 3000);
  ok('day / night: one button, and it is remembered', look.day && !!nightNow && (await until(() => stores.local.drExtras.readLook === 'night', 3000)), JSON.stringify({ was: look.day, saved: stores.local.drExtras.readLook }));
  await rd.tap('#look');
  await until(() => stores.local.drExtras.readLook === 'day', 3000);

  // ---- 4. the marks: harder than my level and not known ----
  const marks = await rd.evaluate(() => { const c = (w) => { const e = [...document.querySelectorAll('#text .w')].find((x) => x.textContent === w); return e ? e.className : null; }; const e = [...document.querySelectorAll('#text .w')].find((x) => x.textContent === 'meticulous'); return { meticulous: c('meticulous'), lugubrious: c('lugubrious'), friend: c('friend'), obsequious: c('obsequious'), bread: c('bread'), line: e ? getComputedStyle(e).textDecorationLine + ' ' + getComputedStyle(e).textDecorationStyle : '' }; });
  ok('hard words are marked with a dotted line, easy words are not', /\bhard\b/.test(marks.meticulous) && /\bhard\b/.test(marks.lugubrious) && marks.friend === 'w' && /underline dotted/.test(marks.line), JSON.stringify(marks));
  ok('a known word is not marked; a word still being learned is marked stronger', marks.obsequious === 'w' && /\blearning\b/.test(marks.bread), JSON.stringify(marks));

  // ---- 5. a tap on a word: the card, ONE request with the sentence, saved as learning ----
  const r0 = rules().length;
  ok('tap a hard word', await tapWord(rd, 'meticulous'));
  const card = await until(async () => { const d = await dbg(); return d && d.card && d.card.word === 'meticulous' ? d : null; }, 5000);
  ok('the card: the word, its pronunciation and its Chinese meaning', card && /^\/.+\/$/.test(card.card.ipa) && /[一-鿿]/.test(card.card.zh), JSON.stringify(card && card.card));
  const asked = await until(() => rules().length > r0, 8000);
  const req = rules()[r0];
  ok('ONE request goes to the AI, with the word and its sentence', !!asked && req && req.user.includes('meticulous') && req.user.includes(HARD.replace(/"/g, '\\"')) && /does not know/.test(req.user), req && req.user.slice(0, 300));
  const told = await until(async () => { const d = await dbg(); return d && d.card && d.card.text && !d.card.busy ? d : null; }, 15000);
  ok('the explanation is on the card and was said by the tutor\'s voice', told && told.spoken.length >= 1 && told.card.text.length > 10, JSON.stringify(told && { text: told.card.text, spoken: told.spoken.slice(-2) }));
  const learned = await until(() => stores.local.drVocab.words.meticulous === 'learning' && stores.local.drEntries && stores.local.drEntries.meticulous, 5000);
  ok('the word is saved as learning in the same vocabulary as the videos (sentence, book, 1 explanation)', learned && learned.timesExplained === 1 && learned.sentence === HARD && learned.bookTitle === 'My Story', JSON.stringify(learned || stores.local.drVocab.words));
  ok('...and only one request was made for the tap', rules().length === r0 + 1, String(rules().length - r0));
  ok('the card is big: the word 30 px or more, the card inside the screen', told.cardRect && told.cardRect[1] + told.cardRect[3] <= 844 && told.cardRect[2] >= 300, JSON.stringify(told.cardRect));

  // ---- 6. a tap on the card = I know ----
  await tapAt(rd, told.cardRect);
  const known = await until(() => stores.local.drVocab.words.meticulous === 'known', 5000);
  const after = await rd.evaluate(() => { const e = [...document.querySelectorAll('#text .w')].find((x) => x.textContent === 'meticulous'); return e.className; });
  ok('a tap on the card = "I know": saved as known, the mark goes, the card closes', !!known && after === 'w' && !(await dbg()).card, JSON.stringify({ after, card: (await dbg()).card }));

  // ---- 7. the sentence: the card's button, and a selection ----
  await tapWord(rd, 'lugubrious');
  const c2 = await until(async () => { const d = await dbg(); return d && d.card && d.card.word === 'lugubrious' && d.buttonRect ? d : null; }, 5000);
  ok('the card has one button for the whole sentence (48 pt)', c2 && c2.card.button === 'Explain the sentence' && c2.buttonRect[3] >= 48, JSON.stringify(c2 && c2.buttonRect));
  await until(() => rules().length >= r0 + 2, 8000);
  const r1 = rules().length;
  await rd.touchscreen.tap(c2.buttonRect[0] + c2.buttonRect[2] / 2, c2.buttonRect[1] + c2.buttonRect[3] / 2);
  const sent = await until(() => rules().find((r, i) => i >= r1 && /Explain this sentence/.test(r.user)), 8000);
  ok('the button asks for the sentence (one request, the sentence in it)', sent && sent.user.includes('It was a lugubrious moment of joy.'), sent && sent.user.slice(0, 200));
  const c3 = await until(async () => { const d = await dbg(); return d && d.card && d.card.kind === 'sentence' && d.card.text && !d.card.busy ? d : null; }, 15000);
  ok('...and the card shows its explanation', !!c3, JSON.stringify(c3 && c3.card));
  await tapAt(rd, c3.cardRect);
  await until(async () => !(await dbg()).card, 3000);
  const r2 = rules().length;
  await rd.evaluate(() => { const s = [...document.querySelectorAll('#text .s')].find((x) => /walked to the shop/.test(x.textContent)); const w = s.querySelectorAll('.w'); const sel = getSelection(); sel.removeAllRanges(); const rg = document.createRange(); rg.setStart(w[1].firstChild, 0); rg.setEnd(w[4].firstChild, w[4].textContent.length); sel.addRange(rg); });
  const picked = await until(() => rules().find((r, i) => i >= r2 && /the learner selected them/.test(r.user)), 8000);
  ok('selected words are explained too (one request with the selection)', picked && /walked to the shop/.test(picked.user) && rules().length === r2 + 1, picked && picked.user.slice(0, 200));
  await rd.evaluate(() => getSelection().removeAllRanges());
  await until(async () => { const d = await dbg(); return d && d.card && !d.card.busy; }, 15000);

  // ---- 8. the place is remembered (chapter + sentence), the library lists the book ----
  await rd.evaluate(() => { const s = [...document.querySelectorAll('#text .s')].find((x) => /easy sentence number 25 /.test(x.textContent)); s.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); });
  const placed = await until(async () => { const d = await dbg(); return d && d.place && d.place.paragraph === 26 ? d : null; }, 6000);
  ok('scrolling moves the remembered place', !!placed, JSON.stringify((await dbg()).place));
  await sleep(300);
  await rd.reload();
  dbg = dbgOf(rd);
  // (3.9: the book that was open opens again by itself, at its place; "Library" goes back to the list)
  const reopened = await until(() => rd.evaluate(() => (document.body.dataset.sentences && !document.getElementById('reader').hidden && scrollY > 500 ? document.getElementById('title').textContent : null)), 15000);
  ok('after a reload (the app was closed and opened) the book that was open opens again by itself, where it was', /My Story/.test(String(reopened)), String(reopened));
  await rd.tap('#back');
  const shelf = await until(() => rd.evaluate(() => { const b = document.querySelector('#shelf .book'); return b ? { n: document.querySelectorAll('#shelf .book').length, text: b.innerText, h: b.querySelector('.go').getBoundingClientRect().height, rm: b.querySelector('.rm').getBoundingClientRect().height } : null; }), 8000);
  ok('after a reload the library lists the book with its title and how far it was read', shelf && shelf.n === 1 && /My Story/.test(shelf.text) && /(\d+)% read/.test(shelf.text) && Number(/(\d+)% read/.exec(shelf.text)[1]) > 40, JSON.stringify(shelf));
  ok('...its row and its Remove button are big enough', shelf && shelf.h >= 60 && shelf.rm >= 44, JSON.stringify(shelf));
  await rd.tap('#shelf .book .go');
  await until(() => rd.evaluate(() => document.body.dataset.sentences), 15000);
  const back = await until(() => rd.evaluate(() => { const bar = document.getElementById('bar').getBoundingClientRect().bottom; const s = [...document.querySelectorAll('#text .s')].find((x) => x.getBoundingClientRect().bottom > bar + 2); return s && scrollY > 500 ? s.dataset.key : null; }), 5000);
  ok('the book opens again where it was (the same paragraph)', back && back.split('.')[1] === '26', String(back));
  ok('...the known word is still not marked', (await rd.evaluate(() => [...document.querySelectorAll('#text .w')].find((x) => x.textContent === 'meticulous').className)) === 'w');

  // ---- 9. reading aloud still works: Play reads the sentences in order from the place, Stop stops ----
  await rd.tap('#play');
  const reads = await until(async () => { const d = await dbg(); return d && d.playing && d.spoken.filter((s) => /easy sentence number/.test(s)).length >= 2 ? d : null; }, 20000);
  ok('Play reads on from the place where I am', reads && /number 2[5-7] /.test(reads.spoken.find((s) => /easy sentence number/.test(s))), JSON.stringify(reads && reads.spoken.slice(0, 4)));
  await rd.tap('#play');
  const quiet = await until(async () => { const d = await dbg(); return d && !d.playing ? d.spoken.length : null; }, 4000);
  await sleep(500);
  ok('Stop stops it at once', quiet !== null && (await dbg()).spoken.length === quiet);

  // ---- 10. an EPUB: its chapters, one on the page at a time, the chapter is remembered; a locked book is refused ----
  await rd.tap('#back');
  await rd.setInputFiles('#file', { name: 'tiny.epub', mimeType: 'application/epub+zip', buffer: epub() });
  const ep = await until(() => rd.evaluate(() => (document.getElementById('title').textContent === 'The Tiny Book' && document.body.dataset.sentences ? { n: document.body.dataset.sentences, text: document.getElementById('text').textContent, nav: !document.getElementById('chapnav').hidden, opts: [...document.getElementById('chapters').options].map((o) => o.textContent) } : null)), 20000);
  ok('an EPUB opens: its title, its first chapter only, the list of chapters', ep && ep.n === '4' && /gregarious dog/.test(ep.text) && !/ephemeral/.test(ep.text) && ep.nav && ep.opts.join('|') === '1. The Start|2. The End', JSON.stringify(ep) + ' · ' + await rd.evaluate(() => document.getElementById('open-msg').textContent));
  const navBtn = await rd.evaluate(() => { const b = document.getElementById('chap-next').getBoundingClientRect(); return b.height; });
  await rd.tap('#chap-next');
  const ch2 = await until(() => rd.evaluate(() => (document.body.dataset.chapter === '1' ? document.getElementById('text').textContent : null)), 5000);
  ok('Next chapter (a big button) shows the next chapter', ch2 && /ephemeral summer/.test(ch2) && !/gregarious/.test(ch2) && navBtn >= 48, String(ch2).slice(0, 80));
  ok('...its hard word is marked there too', /\bhard\b/.test(await rd.evaluate(() => [...document.querySelectorAll('#text .w')].find((x) => x.textContent === 'ephemeral').className)));
  await until(async () => { const d = await dbg(); return d && d.place && d.place.chapter === 1; }, 5000);
  await rd.reload();
  dbg = dbgOf(rd);
  await until(() => rd.evaluate(() => !!document.body.dataset.sentences && !document.getElementById('reader').hidden), 15000);
  await rd.tap('#back');
  ok('the library, once chosen, is where the reader opens next time (not the last book)', (await until(() => stores.local.drReaderOpen === '', 3000)) === true, JSON.stringify(stores.local.drReaderOpen));
  await until(() => rd.evaluate(() => document.querySelectorAll('#shelf .book').length === 2), 8000);
  const first = await rd.evaluate(() => document.querySelector('#shelf .book').innerText);
  ok('the library has both books, the one read last first, with its chapter', /The Tiny Book/.test(first) && /chapter 2 of 2/.test(first) && /Ann Writer/.test(first), first);
  await rd.tap('#shelf .book .go');
  const again = await until(() => rd.evaluate(() => (document.body.dataset.sentences ? document.body.dataset.chapter : null)), 15000);
  ok('the EPUB opens again in its chapter', again === '1' && /ephemeral/.test(await rd.evaluate(() => document.getElementById('text').textContent)), String(again));
  await rd.tap('#back');
  const lock = '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><enc:EncryptedData xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/c1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>';
  await rd.setInputFiles('#file', { name: 'bought.epub', mimeType: 'application/epub+zip', buffer: epub({ 'META-INF/encryption.xml': lock }) });
  const refused = await until(() => rd.evaluate(() => { const m = document.getElementById('open-msg').textContent; return /locked/i.test(m) ? m : null; }), 8000);
  ok('a locked book is refused with plain words, and is not put into the library', !!refused && (await rd.evaluate(() => document.querySelectorAll('#shelf .book').length)) === 2 && (await rd.evaluate(() => !document.getElementById('open').hidden)), String(refused));

  // ---- 11. a book can be removed (asked once more) ----
  await rd.tap('#shelf .book .rm');
  const sure = await rd.evaluate(() => document.querySelector('#shelf .book .rm').textContent);
  await rd.tap('#shelf .book .rm');
  const left = await until(() => rd.evaluate(() => (document.querySelectorAll('#shelf .book').length === 1 ? document.querySelector('#shelf .book').innerText : null)), 5000);
  ok('Remove takes a book out of the library (after "Really?")', sure === 'Really?' && /My Story/.test(left), `${sure} · ${left}`);
  await rd.close();

  // ---- 12. free mode (My tutor off): the card from the dictionary, the sentence by the device, never the AI ----
  stores.local.drExtras = extras({ tutorOn: false });
  const fr = await open();
  const fdbg = dbgOf(fr);
  await until(() => fr.evaluate(() => document.querySelectorAll('#shelf .book').length === 1), 8000);
  const apiFree = apiLog.length, speakFree = nativeLog.length;
  await fr.tap('#shelf .book .go');
  await until(() => fr.evaluate(() => document.body.dataset.sentences), 15000);
  await fr.evaluate(() => window.scrollTo(0, 0));
  await tapWord(fr, 'lugubrious');
  const fc = await until(async () => { const d = await fdbg(); return d && d.card && d.card.word === 'lugubrious' ? d : null; }, 5000);
  ok('free mode: a tap on a word shows the card from the dictionary (pronunciation + Chinese)', fc && /^\/.+\/$/.test(fc.card.ipa) && /[一-鿿]/.test(fc.card.zh) && fc.card.button === 'Translate the sentence' && !fc.card.busy, JSON.stringify(fc && fc.card));
  await fr.touchscreen.tap(fc.buttonRect[0] + fc.buttonRect[2] / 2, fc.buttonRect[1] + fc.buttonRect[3] / 2);
  const tr = await until(async () => { const d = await fdbg(); return d && d.card && d.card.kind === 'sentence' && d.card.zh ? d : null; }, 6000);
  ok('...the sentence is translated on the device (Apple\'s Translation)', tr && tr.card.zh === '这是测试译文' && nativeLog.slice(speakFree).some((l) => l.kind === 'translate' && /lugubrious/.test(l.text)), JSON.stringify(tr && tr.card));
  await tapAt(fr, tr.cardRect);
  await fr.tap('#play');
  await until(async () => { const d = await fdbg(); return d && d.spoken.length >= 3; }, 15000);
  await fr.tap('#play');
  await sleep(400);
  ok('...and nothing at all was asked of the AI or of a paid voice (the card, the sentence, reading aloud)', apiLog.length === apiFree && ctx.pageHits.filter((u) => !u.includes(`:${PAGES_PORT}/`)).length === 0, JSON.stringify({ api: apiLog.slice(apiFree).map((r) => r.kind), page: ctx.pageHits.filter((u) => !u.includes(`:${PAGES_PORT}/`)).slice(0, 3) }));
  ok('...the word tapped in free mode is kept as learning', stores.local.drVocab.words.lugubrious === 'learning');
  await fr.close();
  await ctx.close();

  // ---- 13. an iPad: a column of 50 to 75 letters ----
  stores.local.drExtras = extras();
  const pad = await H.newAppContext(browser, 'iPad (gen 7)', { device: 'pad' });
  const pd = await open(pad);
  await until(() => pd.evaluate(() => document.querySelectorAll('#shelf .book').length >= 0 && document.readyState === 'complete'), 8000);
  await pd.fill('#paste', TEXT);
  await pd.tap('#paste-go');
  await until(() => pd.evaluate(() => document.body.dataset.sentences), 20000);
  const col = await pd.evaluate(() => {
    const p = [...document.querySelectorAll('#text p')].find((x) => x.textContent.length > 120);
    // the letters of the paragraph's first line: the words whose top is the first word's top
    const ws = [...p.querySelectorAll('.w')]; const top = ws[0].getBoundingClientRect().top;
    const firstLine = ws.filter((w) => Math.abs(w.getBoundingClientRect().top - top) < 4);
    const last = firstLine[firstLine.length - 1];
    const rg = document.createRange(); rg.setStart(p, 0); rg.setEnd(last.firstChild, last.textContent.length);
    return { letters: rg.toString().length, width: Math.round(document.getElementById('text').getBoundingClientRect().width), screen: innerWidth };
  });
  ok('on an iPad the text is a column of 50 to 75 letters', col.letters >= 50 && col.letters <= 75, JSON.stringify(col));
  // the browser's "Reader" button hands an article's text to this page (ReaderHost.openText in the app)
  const art = await pd.evaluate(() => window.__iknowReader.openText('An article of the web', 'The headline of the article\n\nIts first paragraph is short. It has a ubiquitous word.\n\nIts second paragraph ends here.'));
  const web = await until(() => pd.evaluate(() => (document.getElementById('title').textContent === 'An article of the web' ? { n: document.body.dataset.sentences, text: document.getElementById('text').textContent, mark: [...document.querySelectorAll('#text .w')].find((x) => x.textContent === 'ubiquitous').className } : null)), 15000);
  ok('an article sent by the browser opens here as a book (its title, its paragraphs, the marks)', art === true && web && web.n === '4' && /^The headline of the article/.test(web.text) && /\bhard\b/.test(web.mark), JSON.stringify(web));
  await pd.tap('#back');
  const both = await until(() => pd.evaluate(() => (document.querySelectorAll('#shelf .book').length >= 2 ? document.getElementById('shelf').innerText : null)), 5000);
  ok('...and it is kept in the library like any other text', /An article of the web/.test(String(both)), String(both).replace(/\n/g, ' | '));
  await pd.close();
  await pad.close();

  await browser.close();
  pages.close();
  api.close();
  console.log(H.fails() ? `\n${H.fails()} FAILED` : '\nREADER: ALL PASSED');
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
