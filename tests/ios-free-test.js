// Free mode in the iPhone app (My tutor off = no AI, nothing paid), in WebKit.
// The video still stops by itself at what is hard (chosen from the dictionary, no AI): the word (or the sentence) is
// said once by the iOS voice, the full-screen card shows it with its Chinese (the dictionary; a sentence: Apple's
// Translation on the device), one tap = "I know", no tap = still to learn, and the video plays on. Never an
// explanation, never a request to the AI or to a paid voice, with or without a key.
// Then "Explain" says how to have it (turn My tutor on), and turning the tutor on brings the AI back.
// Run ios/sync-scripts.sh first (the CI does). The fake video, the fake AI and the app's window are in tests/ios-harness.js.
const path = require('path');
const fs = require('fs');
const H = require('./ios-harness');
const { pw, IOS, ok, until, sleep, source, ytScripts, LINES, apiLog, nativeLog, stores, keychain } = H;
H.watchdog(6);
const api = H.startServer();

// what the app has saved: My tutor off, the old stops (Level Check off: free mode chooses its stops itself anyway)
const extrasFree = (more = {}) => ({ tutorOn: false, levelMode: false, levelAsk: false, phoneSet: true, view: 'listening', fakeVoice: false, panel: true, band: 'auto', explainOnStop: true,
  stopItemsOn: true, capWords: 100, stopPhrasesOn: false, capPhrases: 0, stopHardOn: true, capSentences: 100, stopSentences: true, stopGapSec: 0, talkAfterExplain: false, voiceMode: false, zhLines: false,
  migrated: 9, callEngine: 'claude', talkSilenceSec: 0, freeWindowSec: 3, ...more });
// the AI's hard sentence of a video, kept from an earlier time with the tutor (free mode only reads what is saved)
const savedHard = (index) => ({ version: 1, level: 'B2', hints: {}, phrases: {}, split: 'rule', sentences: [index], v: 4 });

(async () => {
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());

  // ---- the app's side: the bar of free mode, Apple's Translation ----
  const cv = fs.readFileSync(path.join(IOS, 'ContentView.swift'), 'utf8');
  const free = /\} else \{\s*\/\/ free mode[^\n]*\n([\s\S]*?)if !\(model\.tutorOn && model\.oneButton\)/.exec(cv);
  ok('the bar of free mode: play / stop, the Video mode switches, Mode, Find (no Explain, no Call)', !!free && /tutorButton\("stop"/.test(free[1]) && /tutorButton\("band"/.test(free[1]) && /tutorButton\("pageAuto"/.test(free[1]) && /tutorButton\("mode"/.test(free[1]) && /tutorButton\("find"/.test(free[1]) && !/explainLast|"talk"/.test(free[1]) && /Free mode \(no AI\): turn My tutor on/.test(cv), free && free[1].trim().slice(0, 200));
  const tr = fs.existsSync(path.join(IOS, 'Translator.swift')) ? fs.readFileSync(path.join(IOS, 'Translator.swift'), 'utf8') : '';
  const bridge = fs.readFileSync(path.join(IOS, 'Bridge.swift'), 'utf8');
  ok('Apple\'s Translation in the app: English to Chinese on the device (iOS 18), answered through the bridge, left out of older builds', /#if canImport\(Translation\) && compiler\(>=6\.0\)/.test(tr) && /\.translationTask\(/.test(tr) && /zh-Hans/.test(tr) && /case "translate":/.test(bridge) && /func translate\(/.test(H.swift) && /TranslatorHost\(translator:/.test(cv));

  // ---- 1. no key at all: the tutor off is free mode ----
  Object.assign(stores.local, {
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 }, // (no starting data: these tests have their own words)
    drExtras: extrasFree(),
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 3, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 20 } },
    'drHints:iosfree0001': savedHard(4),
  });
  delete keychain.drKeys;
  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const nApi = apiLog.length;
  const yt = await ctx.newPage();
  yt.on('pageerror', (e) => console.log('PAGE ERROR', String(e.message || e).slice(0, 300)));
  yt.on('dialog', (d) => d.dismiss());
  await yt.goto('https://m.youtube.com/watch?v=iosfree0001');
  await yt.addScriptTag({ content: source(ytScripts) });
  const dbg = () => yt.evaluate(() => (window.__drDebug ? window.__drDebug() : null));
  const vstate = () => yt.evaluate(() => { const v = document.querySelector('video'); return { t: +v.currentTime.toFixed(2), paused: v.paused }; });
  const act = (id) => yt.evaluate((x) => window.__ytcDream.action(x), id);
  const toastText = () => yt.evaluate(() => { const t = document.getElementById('dr-stage-host')?.shadowRoot?.querySelector('.toast'); return t && !t.hidden ? t.textContent : ''; });
  const said = (re) => nativeLog.filter((l) => l.kind === 'speak' && re.test(l.text || ''));
  const card = () => yt.evaluate(() => { const c = document.getElementById('dr-stage-host').shadowRoot.querySelector('.card'); if (!c || c.hidden || !c.classList.contains('full')) return null; const r = c.getBoundingClientRect();
    return { word: (c.querySelector('.word') || {}).textContent, zh: (c.querySelector('.zh') || {}).textContent || '', ipa: !!c.querySelector('.ipa'), buttons: c.querySelectorAll('button').length, parts: c.children.length, sentence: c.classList.contains('sentence'), covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1 }; });

  const ready = await until(async () => { const d = await dbg(); return d && d.sentences === 10 ? d : null; }, 30000);
  const diag = await yt.evaluate(() => window.__ytcDream.diag());
  ok('My tutor off in the app = free mode: the tutor reads the video, with the iOS voice', !!ready && diag.mode === 'free' && diag.voice === 'mac', JSON.stringify({ mode: diag.mode, voice: diag.voice, n: ready && ready.sentences }));
  // (the video starts by itself, as with the tutor)
  await until(async () => !(await vstate()).paused, 15000);

  // a stop at "meticulous": said once by the iOS voice, the full card with the dictionary's Chinese
  const win = await until(async () => { const d = await dbg(); return d && d.window && d.window.target === 'meticulous' ? d : null; }, 30000, 60);
  await sleep(150);
  const c1 = await card();
  const v1 = await vstate();
  const sayM = said(/^meticulous$/);
  ok('a hard word stops the video by itself, with no AI: "meticulous" said once, by an iOS voice', !!win && v1.paused && v1.t > 5 && v1.t < 8.5 && sayM.length === 1 && /^com\.apple\.voice\./.test(sayM[0].voice || ''), JSON.stringify({ v1, says: sayM.map((l) => l.voice) }));
  ok('...the full-screen card: the word, its pronunciation and its Chinese from the dictionary, nothing else', !!c1 && c1.covers && c1.word === 'meticulous' && /[一-鿿]/.test(c1.zh) && c1.ipa && c1.buttons === 0 && c1.parts === 3, JSON.stringify(c1));
  ok('...the window waits the free mode seconds (3 s here)', win && win.window.ms === 3000 && win.window.phase === 'before', JSON.stringify(win && win.window));
  // no tap: the window runs out = still to learn, the video plays on; nothing explained
  const on1 = await until(async () => { const d = await dbg(); const v = await vstate(); return d && !d.window && !d.card && d.state === 'playing' && !v.paused ? d : null; }, 10000, 100);
  ok('no tap: after the seconds "meticulous" is still to learn, the card goes, the video plays on, nothing explained', !!on1 && (stores.local.drVocab || { words: {} }).words.meticulous === 'learning' && said(/^meticulous$/).length === 1 && !said(/means/i).length && !on1.transcript.length,
    JSON.stringify({ st: stores.local.drVocab && stores.local.drVocab.words.meticulous, says: said(/meticulous/).length, transcript: on1 && on1.transcript }));

  // "ephemeral": one tap on the card = I know
  const win2 = await until(async () => { const d = await dbg(); return d && d.window && d.window.target === 'ephemeral' && d.card ? d : null; }, 20000, 60);
  await sleep(Math.max(0, 520 - (Date.now() - win2.card.openedAt)));
  const vp = yt.viewportSize();
  await yt.touchscreen.tap(Math.round(vp.width * 0.5), Math.round(vp.height * 0.7));
  const on2 = await until(async () => { const d = await dbg(); const v = await vstate(); return d && !d.card && !d.window && !v.paused && stores.local.drVocab.words.ephemeral === 'known' ? d : null; }, 8000, 80);
  ok('one tap on the card = "I know": known, the video plays on', !!win2 && !!on2, JSON.stringify({ st: stores.local.drVocab.words.ephemeral, d: on2 ? null : await dbg().then((d) => d && { w: d.window, card: d.card, state: d.state }) }));

  // the hard sentence (5, saved from an earlier time with the tutor): played once, its card with Apple's translation
  const nTr = nativeLog.filter((l) => l.kind === 'translate').length;
  const swin = await until(async () => { const d = await dbg(); return d && d.window && d.window.kind === 'sentence' ? d : null; }, 20000, 60);
  const sc = await until(async () => { const c = await card(); return c && c.sentence && /这是测试译文/.test(c.zh) ? c : null; }, 3000, 50);
  const trs = nativeLog.filter((l) => l.kind === 'translate').slice(nTr);
  ok('a hard sentence: its card shows the sentence and Apple\'s translation (on the device, free)', !!swin && !!sc && sc.word === LINES[4] && sc.covers && trs.length === 1 && trs[0].text === LINES[4], JSON.stringify({ w: swin && swin.window, sc: sc || await card(), trs }));
  const on3 = await until(async () => { const d = await dbg(); const v = await vstate(); return d && !d.window && !d.card && !v.paused && v.t > 20 ? d : null; }, 12000, 100);
  ok('...no tap: still to learn, the video goes on after it (nothing explained)', !!on3 && stores.local.drVocab.words[`sentence: ${LINES[4].toLowerCase().replace(/[^a-z' ]/g, '')}`] === 'learning' && !on3.transcript.length, JSON.stringify(Object.keys(stores.local.drVocab.words).filter((k) => /^sentence/.test(k))));
  const spotFree = await until(() => { const s = (stores.local.drSpots || {}).iosfree0001; return s && s.t > 20 && s.d > 0 && Date.now() - s.at < 8000 ? s : null; }, 8000, 100);
  ok('free mode keeps where you are in the video too (back where you stopped)', !!spotFree, JSON.stringify((stores.local.drSpots || {}).iosfree0001));
  const zhSaved = await until(() => { const z = stores.local['drZh:iosfree0001']; return z && Object.values(z).includes('这是测试译文') ? z : null; }, 5000);
  ok('...the translation is kept with the video', !!zhSaved, JSON.stringify(zhSaved));

  // the buttons of the tutor: a note, nothing asked of the AI
  const ex = await act('explainLast');
  const note = await until(async () => /Free mode/.test(await toastText()) ? toastText() : null, 3000, 60);
  await act('explainSentence');
  await act('talk');
  await sleep(500);
  ok('"Explain 20 s", "Last sentence" and "Call" in free mode: "turn My tutor on to explain", no flow, nothing asked', ex === true && !!note && !(await dbg()).flow && !(await dbg()).talk, String(note));
  ok('free mode, no key: not one request to the AI or to a paid voice, nothing from the page itself, no key warning', apiLog.length === nApi && !ctx.pageHits.length && !/API key/.test(await toastText()), JSON.stringify({ asked: apiLog.slice(nApi).map((r) => r.kind), hits: ctx.pageHits.slice(0, 3) }));
  await yt.close();
  await ctx.close();

  // ---- 2. with a Claude key and a Microsoft key saved: free mode still asks nothing; the same sentence again: no new translation ----
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key', azure: 'azure-test-key-1234' });
  stores.local.drExtras = extrasFree({ voice: 'auto' });
  delete stores.local.drDone;
  delete stores.local.drSpots;
  const ctx2 = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const nApi2 = apiLog.length;
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => console.log('PAGE ERROR (2)', String(e.message || e).slice(0, 300)));
  await p2.goto('https://m.youtube.com/watch?v=iosfree0001');
  await p2.addScriptTag({ content: source(ytScripts) });
  const dbg2 = () => p2.evaluate(() => (window.__drDebug ? window.__drDebug() : null));
  await until(async () => { const d = await dbg2(); return d && d.sentences === 10 ? d : null; }, 30000);
  const diag2 = await p2.evaluate(() => window.__ytcDream.diag());
  // (straight to the hard sentence)
  await until(async () => !(await p2.evaluate(() => document.querySelector('video').paused)), 15000);
  await p2.evaluate(() => { document.querySelector('video').currentTime = 15.6; });
  const nTr2 = nativeLog.filter((l) => l.kind === 'translate').length;
  const swin2 = await until(async () => { const d = await dbg2(); return d && d.window && d.window.kind === 'sentence' ? d : null; }, 20000, 60);
  const sc2 = await p2.evaluate(() => { const c = document.getElementById('dr-stage-host').shadowRoot.querySelector('.card.full'); return c && !c.hidden ? (c.querySelector('.zh') || {}).textContent || '' : null; });
  ok('the same sentence another time: its translation at once, from what was kept (Translation not asked again)', !!swin2 && /这是测试译文/.test(sc2 || '') && nativeLog.filter((l) => l.kind === 'translate').length === nTr2, JSON.stringify({ sc2, asked: nativeLog.filter((l) => l.kind === 'translate').length - nTr2 }));
  await until(async () => { const d = await dbg2(); return d && !d.window && d.state === 'playing'; }, 10000, 100);
  ok('with keys saved, free mode still asks nothing: no AI, no Microsoft voice (the iOS voice)', diag2.mode === 'free' && diag2.voice === 'mac' && apiLog.length === nApi2 && !ctx2.pageHits.length, JSON.stringify({ voice: diag2.voice, asked: apiLog.slice(nApi2).map((r) => r.kind) }));
  await p2.close();
  await ctx2.close();

  // ---- 3. Translation fails (an older iPhone, no languages downloaded): the card shows the dictionary; then the tutor on ----
  H.setTranslate(new Error('Translation needs iOS 18'));
  stores.local.drExtras = extrasFree({ stopItemsOn: false, capWords: 0 }); // (only the hard sentence stops: "gregarious" is in it)
  stores.local.drVocab = { ...stores.local.drVocab, words: { ...stores.local.drVocab.words, gregarious: 'learning' } };
  stores.local['drHints:iosfree0002'] = savedHard(6);
  const ctx3 = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const p3 = await ctx3.newPage();
  const errs = [];
  p3.on('pageerror', (e) => { errs.push(String(e.message || e)); console.log('PAGE ERROR (3)', String(e.message || e).slice(0, 300)); });
  await p3.goto('https://m.youtube.com/watch?v=iosfree0002');
  await p3.addScriptTag({ content: source(ytScripts) });
  const dbg3 = () => p3.evaluate(() => (window.__drDebug ? window.__drDebug() : null));
  await until(async () => { const d = await dbg3(); return d && d.sentences === 10 ? d : null; }, 30000);
  await until(async () => !(await p3.evaluate(() => document.querySelector('video').paused)), 15000);
  await p3.evaluate(() => { document.querySelector('video').currentTime = 23.6; });
  const nTr3 = nativeLog.filter((l) => l.kind === 'translate').length;
  const swin3 = await until(async () => { const d = await dbg3(); return d && d.window && d.window.kind === 'sentence' ? d : null; }, 20000, 60);
  await sleep(400);
  const sc3 = await p3.evaluate(() => { const c = document.getElementById('dr-stage-host').shadowRoot.querySelector('.card.full'); return c && !c.hidden ? { word: (c.querySelector('.word') || {}).textContent, zh: (c.querySelector('.zh') || {}).textContent || '' } : null; });
  ok('Translation not there: the sentence card shows the dictionary\'s Chinese of its hard word, nothing breaks', !!swin3 && !!sc3 && sc3.word === LINES[6] && /gregarious/.test(sc3.zh) && /[一-鿿]/.test(sc3.zh) && nativeLog.filter((l) => l.kind === 'translate').length === nTr3 + 1 && !errs.length, JSON.stringify({ sc3, errs }));
  const on4 = await until(async () => { const d = await dbg3(); return d && !d.window && d.state === 'playing'; }, 10000, 100);
  ok('...and the video goes on', !!on4);
  H.setTranslate('这是测试译文');

  // My tutor on again (the dot of the bar): the tutor is back, with the AI
  const nApi3 = apiLog.length;
  ok('the dot of the bar turns My tutor on', await p3.evaluate(() => window.__ytcDream.action('tutor')) === true);
  const back = await until(async () => { const d = await p3.evaluate(() => window.__ytcDream.diag()); return d && d.mode === 'tutor' && d.sentences === 10 ? d : null; }, 30000);
  const aiAgain = await until(() => apiLog.slice(nApi3).find((r) => r.kind === 'split' || r.kind === 'hints'), 20000);
  ok('...the tutor reads the video again, with the AI (its one analysis)', !!back && !!aiAgain, JSON.stringify({ mode: back && back.mode, asked: apiLog.slice(nApi3).map((r) => r.kind) }));
  await p3.close();
  await ctx3.close();

  await browser.close();
  api.close();
  console.log(H.fails() ? `\n${H.fails()} FAILED` : '\nALL PASSED');
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
