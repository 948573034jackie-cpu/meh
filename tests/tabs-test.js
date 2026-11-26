// "Simpler to use" (step 2), checked on the screen in WebKit (the iPhone's engine), iPhone 13:
//  I Know Book: three tabs (Books · Words · Settings); the empty library has ONE clear main action ("Open a book"),
//  the other two are quiet; Words and Settings are one tap; the tab bar is gone while a book is open and back in the
//  library; Play / pause is one tap in Reading (bars shown: in the bar; bars away: a small Play under the text, never
//  on it) and in Listening; every setting of the old tutor sheet, the keys (GitHub too) and "Text and colours" are on
//  the Settings page; the reading page's 💬 still opens the same settings.
//  I Know: the tutor's settings page of the Settings tab (settings.html): the tutor part and the voice part, each
//  setting once (My level and "Explain the last" are native rows there, the keys too); a change is saved at once.
//  My Vocabulary's "Settings" link opens the Settings tab. The native tab bar, the Watch bar, its More sheet and the
//  Settings tab are Swift: their source is checked (3 tabs, every old bar action in More, the sections in order,
//  the level numbers the same as the tutor's), as this Mac cannot run the app.
// What counts is what is really on the screen (computed style, rectangles, elementFromPoint).
// Run ios/sync-scripts.sh first.
process.env.IOS_TEST_PORT = process.env.IOS_TEST_PORT || '8891';
const fs = require('fs'); const path = require('path'); const http = require('http');
const H = require('./ios-harness');
const { pw, IOS, MIME, ok, until, sleep, source, sheetScripts, stores, keychain, nativeLog } = H;
const PAGES_PORT = +process.env.TABS_PAGES_PORT || 8893;
H.watchdog(8);
H.startServer();

const now = new Date().toISOString();
const ENTRIES = {
  meticulous: { word: 'meticulous', lemma: 'meticulous', chinese: '一丝不苟的', sentence: 'Today my friend was very meticulous about her work.', explanation: 'Very careful about every small detail.', level: 'C1', status: 'learning', bookId: 'book:x', bookTitle: 'The Lighthouse Keeper', chapter: '', position: null, createdAt: now, lastSeenAt: now, timesExplained: 2, again: 1 },
};
const resetStores = (local) => { for (const k of Object.keys(stores.local)) delete stores.local[k]; Object.assign(stores.local, JSON.parse(JSON.stringify(local))); };
const BOOK_STORE = { drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 }, drExtras: { tutorOn: true, fakeVoice: true, phoneSet: true, myLevel: 50, migrated: 9, stopItemsOn: false, stopPhrasesOn: false, stopHardOn: false }, drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500 } }, drVocab: { words: { meticulous: 'learning' }, marked: {} }, drEntries: ENTRIES };

/** in the page: what is really on the screen of one element */
function look(sel) {
  const el = document.querySelector(sel);
  if (!el) return { sel, there: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const top = r.width && r.height ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  return { sel, there: true, shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0, h: Math.round(r.height), w: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom), onTop: !!top && (el === top || el.contains(top)), bg: cs.backgroundColor, color: cs.color, text: (el.innerText || '').trim().slice(0, 60) };
}

async function bookPart(browser) {
  resetStores(BOOK_STORE);
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGE ERROR (book)', String(e.message || e).slice(0, 300)));
  await p.addInitScript({ content: source(sheetScripts) });
  await p.goto(`http://localhost:${PAGES_PORT}/book.html`);
  await until(() => p.evaluate(() => document.body.dataset.ready === '1'), 20000);
  const dbg = () => p.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });

  // the library: three tabs, the one main action
  const tabs = await p.evaluate(() => [...document.querySelectorAll('#tabs [data-tab]')].map((b) => { const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { t: b.dataset.tab, text: b.textContent.trim(), on: b.classList.contains('on'), h: Math.round(r.height), bottom: Math.round(r.bottom), onTop: b.contains(top), color: getComputedStyle(b).color }; }));
  const accent = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--t-accent').trim());
  ok('I Know Book: three tabs at the bottom, no more (Books · Words · Settings), Books open, each a 44 pt target on top of the page',
    tabs.length === 3 && tabs.map((t) => t.text).join(' ') === 'Books Words Settings' && tabs[0].on && tabs.every((t) => t.h >= 44 && t.onTop && t.bottom <= 844), JSON.stringify(tabs));
  const main = await p.evaluate(() => { const r = (id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { h: Math.round(b.height), bg: cs.backgroundColor, border: cs.borderTopColor, text: e.textContent.trim() }; }; return { file: r('e-file'), paste: r('e-paste'), sample: r('e-sample'), gear: !!document.getElementById('lib-set') }; });
  const filled = (c) => c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
  ok('...no book yet: ONE clear main action, a big filled "Open a book" (52 pt); "Paste a text" and "Try a short story" are quiet (no fill), 44 pt; no settings button of its own any more (Settings is a tab)',
    main.file.text === 'Open a book' && main.file.h >= 52 && filled(main.file.bg) && !filled(main.paste.bg) && !filled(main.sample.bg) && main.paste.h >= 44 && main.sample.h >= 44 && !main.gear, JSON.stringify(main));

  // Words: one tap
  await p.tap('#tab-words');
  const words = await until(() => p.evaluate(() => { const w = document.getElementById('words'); const row = document.querySelector('#v-rows tr[data-lemma="meticulous"]'); const lib = getComputedStyle(document.getElementById('lib')).display; if (!row || !/You know about/.test(document.getElementById('v-know-big').textContent)) return null; row.scrollIntoView({ block: 'center' }); const r = row.getBoundingClientRect(); const top = document.elementFromPoint(r.left + 20, r.top + 10); return { shown: getComputedStyle(w).display !== 'none', lib, onTop: row.contains(top), text: row.innerText.replace(/\s+/g, ' ').slice(0, 80), know: document.getElementById('v-know-big').textContent, wide: document.documentElement.scrollWidth <= innerWidth + 1 }; }), 8000);
  ok('Words is ONE tap: My Vocabulary is on the screen (the saved word, "You know about … words"), the library is gone, nothing wider than the phone',
    !!words && words.shown && words.lib === 'none' && words.onTop && /meticulous/.test(words.text) && /You know about/.test(words.know) && words.wide, JSON.stringify(words));
  const tabOn = await p.evaluate(() => document.querySelector('#tabs .on').dataset.tab);
  ok('...its tab is the open one (in the accent colour)', tabOn === 'words' && (await p.evaluate(() => getComputedStyle(document.querySelector('#tabs .on')).color)) !== (await p.evaluate(() => getComputedStyle(document.querySelector('#tabs [data-tab="books"]')).color)), tabOn);
  // the Settings link of My Vocabulary = the Settings tab
  await p.evaluate(() => document.getElementById('v-settings').click());
  ok('...its "Settings" link opens the Settings tab (not the old All settings page)', !!(await until(() => p.evaluate(() => getComputedStyle(document.getElementById('set')).display !== 'none' && document.querySelector('#tabs .on').dataset.tab === 'settings'), 3000)));

  // Settings: one tap, everything of the old sheet, the keys, the text look
  await p.tap('#tab-books');
  await p.tap('#tab-settings');
  const set = await until(() => p.evaluate(() => { const s = document.getElementById('set'); if (getComputedStyle(s).display === 'none') return null; const heads = [...s.querySelectorAll('h4')].map((h) => h.textContent); const g = (n) => !!s.querySelector(`.opts[data-name="${n}"]`); return { heads, level: g('learnerLevel'), tutor: g('tutorOn'), kinds: ['stopItemsOn', 'stopPhrasesOn', 'stopHardOn'].every(g), card: g('cardSize'), say: g('showSay'), voice: [...s.querySelectorAll('.opts[data-name="voice"] button')].map((b) => b.dataset.v).join(' '), keys: [...new Set([...s.querySelectorAll('input[data-key]')].map((i) => i.dataset.key))].sort().join(' '), region: !!s.querySelector('input[data-name="azureRegion"]'), test: !!s.querySelector('[data-a="test-azure"]'), lookBtn: !!s.querySelector('[data-a="look"]'), hear: !!s.querySelector('[data-a="test-voice"]'), vol: !!s.querySelector('input[data-name="teacherVolume"]'), rate: !!s.querySelector('input[data-name="rate"]'), lib: getComputedStyle(document.getElementById('lib')).display }; }), 5000);
  ok('Settings is ONE tap: one page with every setting of the old tutor sheet, the most used first (My tutor, My level, what to explain, the voice), then the card, "Text and colours", the keys (GitHub too) and the region with its Test',
    !!set && set.heads.slice(0, 3).join('|') === 'My tutor|Explain by itself when listening|Voice' && set.level && set.tutor && set.kinds && set.card && set.say && set.voice === 'auto azure openai elevenlabs speechify mac'
    && set.keys === 'anthropic azure elevenlabs github openai' && set.region && set.test && set.lookBtn && set.hear && set.vol && set.rate && set.lib === 'none', JSON.stringify(set));
  await p.evaluate(() => document.querySelector('#set [data-a="look"]').click());
  ok('...its "Text and colours" opens the text look (the same sheet as Aa)', !!(await until(() => p.evaluate(() => !document.getElementById('sheet').hidden && !!document.querySelector('#sheet .fonts')), 3000)));
  await p.evaluate(() => document.getElementById('veil').click());
  await p.evaluate(() => document.querySelector('#set .opts[data-name="learnerLevel"] button[data-v="C1"]').click());
  ok('...a setting changed there is saved at once (My level C1)', !!(await until(() => stores.local.drSettings && stores.local.drSettings.learnerLevel === 'C1' && stores.local.drExtras.myLevel === 66, 3000)), JSON.stringify(stores.local.drSettings && stores.local.drSettings.learnerLevel));

  // a book: the tab bar goes (full-screen page, as in Apple Books), and comes back in the library
  await p.tap('#tab-books');
  await p.evaluate(() => document.getElementById('e-sample').click());
  await until(async () => { const d = await dbg(); return d && d.open && d.sentences > 5 ? d : null; }, 20000);
  await sleep(400);
  const reading = await p.evaluate(() => { const t = document.getElementById('tabs'); const bottom = document.elementFromPoint(innerWidth / 4, innerHeight - 20); return { display: getComputedStyle(t).display, bottomIsTabs: !!bottom && t.contains(bottom) }; });
  ok('a book open: no tab bar (the page is the book alone)', reading.display === 'none' && !reading.bottomIsTabs, JSON.stringify(reading));

  // Play in Reading: the bars are there at the start: Play is in the bar
  const bar = await until(async () => { const d = await dbg(); if (!d.chrome || d.mode !== 'read') return null; return { play: await p.evaluate(look, '#t-play'), mode: await p.evaluate(() => document.getElementById('rd').dataset.mode) }; }, 4000);
  ok('Reading, the bars shown: Play is in the bar (66 pt, on top), not hidden any more', !!bar && bar.mode === 'read' && bar.play.shown && bar.play.h >= 60 && bar.play.onTop, JSON.stringify(bar));
  await p.evaluate(() => document.getElementById('t-play').click());
  const playing1 = await until(async () => { const d = await dbg(); return d && d.playing && d.spoken.length ? d : null; }, 6000);
  ok('...one tap on it reads the book aloud', !!playing1, JSON.stringify(playing1 && { playing: playing1.playing, mode: playing1.mode, spoken: playing1.spoken.slice(-1) }));
  // pause: one tap (Listening, the bars away: the small player)
  await until(async () => { const d = await dbg(); return d && !d.chrome; }, 4000);
  const mini = await p.evaluate(look, '#m-play');
  await p.evaluate(() => document.getElementById('m-play').click());
  const paused = await until(async () => { const d = await dbg(); return d && !d.playing ? d : null; }, 4000);
  ok('Listening: pause is one tap (the small player, on top)', mini.shown && mini.onTop && !!paused, JSON.stringify(mini));
  // back to Reading, the bars away: the small Play under the text
  await p.evaluate(() => document.getElementById('mode-read').click());
  await p.evaluate(() => document.getElementById('rd').classList.add('plain'));
  await sleep(400);
  const rp = { rplay: await p.evaluate(look, '#rplay'), ...(await p.evaluate(() => { const words = [...document.querySelectorAll('#flow .w')].filter((w) => { const r = w.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > 0; }); return { lowest: Math.round(Math.max(...words.map((w) => w.getBoundingClientRect().bottom))), mode: document.getElementById('rd').dataset.mode }; })) };
  ok('Reading, the bars away: a small Play (44 pt) is on the screen, under the text and never on it',
    rp.mode === 'read' && rp.rplay.shown && rp.rplay.h >= 44 && rp.rplay.onTop && rp.rplay.top >= rp.lowest && rp.rplay.bottom <= 844, JSON.stringify(rp));
  await p.evaluate(() => document.getElementById('rplay').click());
  const playing2 = await until(async () => { const d = await dbg(); return d && d.playing ? d : null; }, 5000);
  ok('...one tap on it reads aloud (and the tutor goes on as in Listening)', !!playing2, JSON.stringify(playing2 && { playing: playing2.playing, mode: playing2.mode }));
  await p.evaluate(() => window.__iknowBook.play(false));
  // the reading page's 💬 still opens the same settings, as a sheet over the book
  await p.evaluate(() => document.getElementById('b-tutor').click());
  const sheet = await p.evaluate(() => { const b = document.getElementById('sheet-body'); return { shown: !document.getElementById('sheet').hidden, keys: [...new Set([...b.querySelectorAll('input[data-key]')].map((i) => i.dataset.key))].sort().join(' '), look: !!b.querySelector('[data-a="look"]') }; });
  ok('the reading page\'s 💬 opens the same settings (a sheet over the book)', sheet.shown && sheet.keys === 'anthropic azure elevenlabs github openai' && sheet.look, JSON.stringify(sheet));
  await p.evaluate(() => document.getElementById('veil').click());
  // back in the library: the tab bar is back
  await p.evaluate(() => document.getElementById('b-lib').click());
  const back = await until(() => p.evaluate(() => { const t = document.getElementById('tabs'); return getComputedStyle(t).display !== 'none' && getComputedStyle(document.getElementById('lib')).display !== 'none' ? document.querySelector('#tabs .on').dataset.tab : null; }), 4000);
  ok('back in the library: the tab bar is back, on Books', back === 'books', String(back));
  await ctx.close();
}

async function knowPages(browser) {
  resetStores({ drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 }, drVocab: { words: {}, marked: {} }, drEntries: ENTRIES, drExtras: { phoneSet: true, tutorOn: true, fakeVoice: true, myLevel: 50, migrated: 9, view: 'listening' }, drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, lastSecondsWindow: 20 } } });
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGE ERROR (settings)', String(e.message || e).slice(0, 300)));
  await p.addInitScript({ content: source(sheetScripts) });
  await p.goto(`http://localhost:${PAGES_PORT}/settings.html#tutor`);
  await until(() => p.evaluate(() => document.body.dataset.ready === '1'), 15000);
  const read = () => p.evaluate(() => { const q = document.getElementById('dr-settings-host').shadowRoot.querySelector('.quick'); const has = (n) => !!q.querySelector(`[data-name="${n}"]`); return { part: document.body.dataset.part, text: q.innerText, vol: has('allVolume'), size: has('phoneSize'), kinds: has('pctWords') && has('pctPhrases') && has('pctSentences'), card: has('cardSize'), look: has('readLook'), mode: has('view'), level: has('learnerLevel'), seconds: has('seconds'), voice: [...q.querySelectorAll('.seg[data-name="voice"] button')].map((b) => b.dataset.v).join(' '), keys: q.querySelectorAll('input[data-key]').length, adv: !!q.querySelector('details.adv.main'), head: !!q.querySelector('.q-head'), links: !!q.querySelector('.links'), sleep: has('sleep'), wide: document.documentElement.scrollWidth <= innerWidth + 1 }; });
  const t = await read();
  ok('I Know Settings ▸ My tutor ▸ Tutor settings (settings.html, no video needed): the card, the look, the mode and Advanced; nothing that has its own row on the Settings tab (volume, text size, My level, what to explain, Explain the last, the voice, the keys), no head, no links',
    t.part === 'tutor' && t.card && t.look && t.mode && t.adv && !t.vol && !t.size && !t.kinds && !t.level && !t.seconds && !t.voice && t.keys === 0 && !t.head && !t.links && !t.sleep && t.wide, JSON.stringify({ ...t, text: undefined }));
  await p.evaluate(() => document.getElementById('dr-settings-host').shadowRoot.querySelector('.seg[data-name="cardSize"] button[data-v="small"]').click());
  ok('...a change there is saved at once (the card: Small)', !!(await until(() => stores.local.drExtras && stores.local.drExtras.cardSize === 'small', 3000)), JSON.stringify(stores.local.drExtras && stores.local.drExtras.cardSize));
  await p.evaluate(() => window.__drSettings.show('voice'));
  await until(async () => (await read()).part === 'voice', 3000);
  const v = await read();
  const seg = await p.evaluate(() => [...document.getElementById('dr-settings-host').shadowRoot.querySelectorAll('.seg[data-name="voice"] button')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.height)]; }));
  ok('I Know Settings ▸ Voice: the voice choice (with Speechify), Test the voice; nothing else; the six choices fit the phone, each whole and 44 pt',
    v.voice === 'auto azure openai elevenlabs speechify mac' && /Test the voice/.test(v.text) && !v.vol && !v.kinds && !v.level && !v.adv && v.wide && seg.every((s) => s[0] >= 0 && s[1] <= 390 && s[2] >= 44 && s[1] - s[0] >= 80), JSON.stringify({ voice: v.voice, seg }));
  await p.evaluate(() => document.getElementById('dr-settings-host').shadowRoot.querySelector('.seg[data-name="voice"] button[data-v="speechify"]').click());
  const rows = await until(() => p.evaluate(() => !!document.getElementById('dr-settings-host').shadowRoot.querySelector('[data-sfy-box] [data-sfy="url"]')), 4000);
  ok('...choosing Speechify there shows its rows (saved: drExtras.voice)', !!rows && stores.local.drExtras.voice === 'speechify', String(stores.local.drExtras.voice));
  // My Vocabulary in the app: its Settings link asks for the Settings tab
  const vp = await ctx.newPage();
  await vp.addInitScript({ content: source(sheetScripts) });
  await vp.goto(`http://localhost:${PAGES_PORT}/vocab.html`);
  await until(() => vp.evaluate(() => !!document.querySelector('#rows tr')), 8000);
  const mark = nativeLog.length;
  await vp.evaluate(() => document.getElementById('settings').click());
  const asked = await until(() => nativeLog.slice(mark).find((l) => l.kind === 'showTab'), 3000);
  ok('I Know\'s Words tab (vocab.html): the same page as before; its "Settings" link opens the Settings tab', !!asked && vp.url().endsWith('/vocab.html'), JSON.stringify(asked));
  await ctx.close();
}

function swiftChecks() {
  const read = (f) => fs.readFileSync(path.join(IOS, f), 'utf8');
  const tabs = read('Tabs.swift'), cv = read('ContentView.swift'), am = read('AppModel.swift'), bridge = read('Bridge.swift'), shot = read('ShotLaunch.swift');
  const lvl = fs.readFileSync(path.join(__dirname, '../dream-ext/src/level100.ts'), 'utf8');
  const cases = /enum AppTab: String, CaseIterable \{\s*case ([^\n]+)\n/.exec(tabs);
  ok('I Know (Swift): three tabs, no more: Watch · Words · Settings', !!cases && cases[1].trim() === 'watch, words, settings' && /\(\.watch, "play\.rectangle", "Watch"\), \(\.words, "character\.book\.closed", "Words"\), \(\.settings, "gearshape", "Settings"\)/.test(tabs) && /AppTabBar\(tab: \$model\.tab\)/.test(cv), cases && cases[1]);
  ok('...Watch with no video: ONE main action, "Paste a YouTube link" (the primary style, 52 pt), and "Find a video" as the one quiet action',
    /Label\("Paste a YouTube link", systemImage: "link"\)[\s\S]{0,120}ThemeButtonStyle\(kind: \.primary, main: true\)/.test(tabs) && /Label\("Find a video", systemImage: "magnifyingglass"\)[\s\S]{0,120}ThemeButtonStyle\(kind: \.quiet\)/.test(tabs) && /if model\.videoOpen \{ tutorBar \} else \{ WatchStartPanel\(model: model\) \}/.test(cv));
  const bar = (/private var tutorBar: some View \{([\s\S]*?)\n    \}\n/.exec(cv) || [])[1] || '';
  const ids = [...bar.matchAll(/tutorButton\("(\w+)"/g)].map((m) => m[1]);
  ok('...the bar under a video: the tutor\'s dot (where you wanted it), Play / stop, Explain, Last sentence, Call, and More: each one tap, no swipe needed',
    /model\.dream\("tutor"\)/.test(bar) && ids.slice(0, 4).join(' ') === 'stop explainLast explainSentence talk' && /appButton\("ellipsis\.circle", "More"\) \{ model\.moreOpen = true \}/.test(bar) && !/appButton\("(house|book|safari|link|gearshape)"/.test(bar), ids.join(' '));
  const more = (/private var items: \[Item\] \{([\s\S]*?)\n    \}\n/.exec(tabs) || [])[1] || '';
  const need = ['band', 'pageAuto', 'full', 'find', 'voiceMode', 'mode', 'oneButton', 'sleep', 'quick', 'paste', 'home'];
  ok('...More (two taps) has every other button of the old bar: the tutor\'s volume (quieter / louder on top, the old volume panel), subtitles, page, full screen, find, voice, mode, One button, sleep, quick settings, paste link, YouTube home',
    need.every((n) => new RegExp(`id: "${n}"`).test(more)) && /model\.dream\("quieter"\)/.test(tabs) && /model\.dream\("louder"\)/.test(tabs) && /frame\(width: 64, height: 60\)/.test(tabs) && /if model\.tutorOn \|\| model\.freeMode \{ volumeRow/.test(tabs) && /\$0\.dream\("sleep"\)/.test(more) && /\$0\.pasteLink\(\)/.test(more) && /\$0\.goHome\(\)/.test(more) && /\.sheet\(isPresented: \$model\.moreOpen\)/.test(cv), need.filter((n) => !new RegExp(`id: "${n}"`).test(more)).join(' '));
  const st = (/struct SettingsTab: View \{([\s\S]*?)\n\}\n/.exec(tabs) || [])[1] || '';
  const heads = [...st.matchAll(/Section\(header: Text\("([^"]+)"\)/g)].map((m) => m[1]);
  ok('...Settings: one place, the most used first: My tutor (volume, text size), My level, What to explain, Voice, Explain the last (each 2 taps); then the keys, the word file and More settings',
    heads.join(' | ') === 'My tutor | My level | What to explain | Voice | Explain the last' && /sliderRow\("Tutor volume", key: "teacherVolume"/.test(st) && /sliderRow\("Text size", key: "phoneSizePx"/.test(st) && /kindRows\("Words", on: "stopItemsOn", pct: "pctWords"\)/.test(st) && /kindRows\("Sentences", on: "stopHardOn", pct: "pctSentences"\)/.test(st) && /KeysSection\(model: model\)\s*WordFileSection\(model: model\)/.test(st) && /MoreSettingsScreen\(model: model\)/.test(st) && /"Tutor settings"/.test(st) && /part: "voice"/.test(st), heads.join(' | '));
  const ms = (/struct MoreSettingsScreen: View \{([\s\S]*?)\n\}\n/.exec(tabs) || [])[1] || '';
  ok('...More settings keeps the rare things: the All settings page, Check the app, the reader, the browser, the help', /options\.html/.test(ms) && /model\.dream\("check"\)/.test(ms) && /model\.showReader = true/.test(ms) && /model\.showBrowser = true/.test(ms) && /MicHelpSection\(\)/.test(ms));
  const swiftLv = /static let levelStart: \[String: Int\] = \[([^\]]+)\]/.exec(tabs);
  const tsLv = /export const CEFR_START: Record<CefrLevel, number> = \{([^}]+)\}/.exec(lvl);
  const norm = (s) => s.replace(/["\s]/g, '');
  ok('...My level on the Settings tab saves the same as the tutor\'s own buttons (the numbers = level100.ts CEFR_START)', !!swiftLv && !!tsLv && norm(swiftLv[1]) === norm(tsLv[1]) && /x\["levelAuto"\] = false/.test(tabs) && /s\["learnerLevel"\] = level/.test(tabs), `${swiftLv && swiftLv[1]} / ${tsLv && tsLv[1]}`);
  ok('...My Vocabulary opens as the Words tab (one tap) wherever it is asked for; its Settings link opens the Settings tab', /if url\.path\.hasSuffix\("\/vocab\.html"\) \{ tab = \.words; return \}/.test(am) && /case "showTab":/.test(bridge) && /WebHost\(webView: model\.wordsView\(\)\)/.test(tabs));
  ok('...leaving Watch, the video and the tutor go quiet (as for the reader and the browser)', /if old == \.watch \{ coverOpened\(\) \}/.test(tabs));
  ok('the build server\'s pictures can open the new screens (-shot main, words, settings, more)', /case "words": self\.tab = \.words/.test(shot) && /case "more": self\.moreOpen = true/.test(shot) && /case "settings": showSettings\(\)/.test(shot) && /window\.__iknowBook\.tab/.test(shot));
}

(async () => {
  const pages = http.createServer((q, r) => { const f = path.join(IOS, 'Web/dream', path.basename(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f)); }).listen(PAGES_PORT);
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());
  swiftChecks();
  await bookPart(browser);
  await knowPages(browser);
  await browser.close();
  pages.close();
  console.log(H.fails() ? `TABS: ${H.fails()} FAILED` : 'TABS: ALL PASSED');
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
