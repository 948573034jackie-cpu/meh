// I Know 3.8, the second round (the learner's list of 7-11 Nov), in WebKit with an iPhone / iPad:
//  - full screen both ways: the phone on its side = the video over the whole window; YouTube's own full-screen button
//    and the app's "Full screen" button switch our full screen (never Apple's player); an iPad only by the button
//  - One button mode: nothing on the screen changes; a touch on the page or on the video = explain the last N seconds
//  - the tutor's volume: quieter / louder in steps, kept, and the bar has it; "hello" / "hi bro" are in dream-e2e.js
// Run ios/sync-scripts.sh first. The fake video, the fake AI and the app's window are in tests/ios-harness.js.
const fs = require('fs');
const path = require('path');
const H = require('./ios-harness');
const { pw, ok, until, sleep, source, ytScripts, stores, keychain, apiLog, layoutLog } = H;
H.watchdog(6);
const api = H.startServer();
const cv = fs.readFileSync(path.join(H.IOS, 'ContentView.swift'), 'utf8');

const baseExtras = (more = {}) => ({ capWords: 100, stopPhrasesOn: false, capPhrases: 100, capSentences: 0, stopItemsOn: false, stopHardOn: false, stopSentences: false, phoneSet: true, view: 'listening', levelAsk: false, levelMode: false, tutorOn: true, fakeVoice: true, explainOnStop: false, voiceMode: false, oneButton: false, teacherVolume: 60, wordVolume: 80, ...more });

async function open(browser, deviceName, device, extras, viewport) {
  Object.assign(stores.local, {
    barOn: true,
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 },
    drExtras: baseExtras(extras),
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 10 } },
  });
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const ctx = await H.newAppContext(browser, deviceName, { device, viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`PAGE ERROR (${deviceName})`, String(e.message || e).slice(0, 300)));
  await page.goto('https://m.youtube.com/watch?v=ios00000001');
  await page.addScriptTag({ content: source(ytScripts) });
  const dbg = () => page.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const ready = await until(async () => { const x = await dbg(); return x && x.sentences === 10 ? x : null; }, 30000);
  return { ctx, page, dbg, ready };
}
const fullOf = (page) => page.evaluate(() => {
  const p = document.getElementById('player-container-id').getBoundingClientRect();
  const v = document.querySelector('video').getBoundingClientRect();
  return { full: document.documentElement.classList.contains('dr-full'), player: [Math.round(p.left), Math.round(p.top), Math.round(p.width), Math.round(p.height)], video: [Math.round(v.width), Math.round(v.height)], win: [innerWidth, innerHeight], nativeFs: window.__nativeFs || 0, nativeCalled: window.__nativeFsCalled || 0 };
});
const covers = (f) => f && f.full && f.player[0] === 0 && f.player[1] === 0 && Math.abs(f.player[2] - f.win[0]) <= 1 && Math.abs(f.player[3] - f.win[1]) <= 1;
const vstate = (page) => page.evaluate(() => { const v = document.querySelector('video'); return { t: v.currentTime, paused: v.paused }; });
const act = (page, id) => page.evaluate((i) => window.__ytcDream.action(i), id);

(async () => {
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());

  // ---- 1. full screen both ways ----
  {
    const { ctx, page, ready } = await open(browser, 'iPhone 13', 'phone', { view: 'normal' });
    // (Apple's own player would be asked for through this; the app's page-hooks.js must stop it)
    await page.evaluate(() => { const P = HTMLVideoElement.prototype; if (!P.webkitEnterFullscreen || !window.__ytcHooks) { /* (the hook wraps the real one; WebKit on the desktop may have none) */ } });
    const f0 = await fullOf(page);
    ok('an iPhone upright: the video is not full screen (the page as YouTube shows it)', !!ready && !f0.full && f0.player[3] < f0.win[1] / 2, JSON.stringify(f0));
    const n0 = layoutLog.length;
    await page.setViewportSize({ width: 664, height: 390 });
    const fl = await until(async () => { const f = await fullOf(page); return covers(f) ? f : null; }, 3000, 50);
    ok('the iPhone turned on its side: the video goes full screen by itself (over the whole window)', !!fl, JSON.stringify(fl || await fullOf(page)));
    const told = await until(() => layoutLog.slice(n0).find((l) => l.full === true && l.lay === 'p-land'), 2000, 50);
    ok('...and the app is told (it hides its bar and shows the side buttons)', !!told, JSON.stringify(layoutLog.slice(n0)));
    await page.setViewportSize({ width: 390, height: 664 });
    const back = await until(async () => { const f = await fullOf(page); return !f.full ? f : null; }, 3000, 50);
    ok('upright again: full screen is over', !!back && back.player[3] < back.win[1] / 2 && layoutLog[layoutLog.length - 1].full === false, JSON.stringify(back));
    // YouTube's own full-screen button (the 3.7 bug: it did nothing)
    await page.evaluate(() => document.querySelector('.ytp-fullscreen-button').click());
    const fb = await until(async () => { const f = await fullOf(page); return covers(f) ? f : null; }, 3000, 50);
    ok('YouTube\'s own full-screen button, upright: our full screen (the video over the whole window), not Apple\'s player', !!fb && fb.nativeFs === 0, JSON.stringify(fb || await fullOf(page)));
    await page.evaluate(() => document.querySelector('.ytp-fullscreen-button').click());
    const fb2 = await until(async () => { const f = await fullOf(page); return !f.full ? f : null; }, 3000, 50);
    ok('...the same button again: back', !!fb2, JSON.stringify(fb2));
    // the same with a FINGER (a real touch: iOS makes no click after a touch that was stopped, so the touch itself must switch)
    const fsBox = await page.evaluate(() => { const r = document.querySelector('.ytp-fullscreen-button').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.touchscreen.tap(fsBox.x, fsBox.y);
    const ft = await until(async () => { const f = await fullOf(page); return covers(f) ? f : null; }, 3000, 50);
    await sleep(900); // (a click that follows the touch must not switch it back)
    const ftStill = await fullOf(page);
    ok('YouTube\'s full-screen button touched with a finger: full screen, once (the click after the touch does not undo it)', !!ft && covers(ftStill) && ftStill.nativeFs === 0, JSON.stringify({ ft, ftStill }));
    const fsBox2 = await page.evaluate(() => { const r = document.querySelector('.ytp-fullscreen-button').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.touchscreen.tap(fsBox2.x, fsBox2.y);
    ok('...touched again: back', !!(await until(async () => { const f = await fullOf(page); return !f.full ? f : null; }, 3000, 50)), JSON.stringify(await fullOf(page)));
    await sleep(900);
    // the page's own script asks for Apple's player directly: stopped, ours instead
    const hooked = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (typeof v.webkitEnterFullscreen !== 'function') return 'none';
      try { v.webkitEnterFullscreen(); } catch (e) { return 'threw ' + e.message; }
      return 'called';
    });
    if (hooked === 'none') ok('(this WebKit has no Apple player to ask for: the hook is checked in the source)', /webkitEnterFullscreen/.test(source(['page-hooks'])));
    else { const fh = await until(async () => { const f = await fullOf(page); return covers(f) ? f : null; }, 3000, 50); ok('the page asks for Apple\'s player: stopped, our full screen instead', !!fh, JSON.stringify({ hooked, f: fh || await fullOf(page) })); await act(page, 'full'); }
    // the app's "Full screen" button
    await until(async () => !(await fullOf(page)).full, 2000, 50);
    const r1 = await act(page, 'full');
    const fa = await until(async () => { const f = await fullOf(page); return covers(f) ? f : null; }, 3000, 50);
    ok('the app\'s "Full screen" button: full screen; again: back', r1 === true && !!fa && (await act(page, 'full')) === true && !!(await until(async () => !(await fullOf(page)).full, 3000, 50)), JSON.stringify(fa));
    // the tutor's subtitles come along: the band is inside the player
    await page.setViewportSize({ width: 664, height: 390 });
    await until(async () => covers(await fullOf(page)), 3000, 50);
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 5; return v.play(); });
    const band = await until(() => page.evaluate(() => { const h = document.getElementById('dr-band-host'); const line = h && h.shadowRoot.querySelector('.band .line'); if (!line || !line.textContent.trim()) return null; const r = line.getBoundingClientRect(); return { text: line.textContent.trim().slice(0, 30), in: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, h: r.height }; }), 8000, 100);
    ok('full screen on its side: the tutor\'s subtitles are on the video, inside the picture', !!band && band.in, JSON.stringify(band));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, 'iPad (gen 7) landscape', 'pad', { view: 'normal' });
    const f0 = await fullOf(page);
    ok('an iPad on its side: not full screen by itself (landscape is its normal way)', !f0.full, JSON.stringify(f0));
    await act(page, 'full');
    const f1 = await until(async () => { const f = await fullOf(page); return covers(f) ? f : null; }, 3000, 50);
    ok('...the "Full screen" button gives full screen on the iPad too', !!f1, JSON.stringify(f1 || await fullOf(page)));
    await ctx.close();
  }
  ok('the app: the bar hides and a side rail of 60 pt buttons shows in full screen on an iPhone on its side; the status bar goes; a "Full screen" button is in the bar',
    /statusBarHidden\(compactFull\)/.test(cv) && /private var sideRail/.test(cv) && /frame\(width: 60, height: 60\)/.test(cv) && /private var fullButton/.test(cv) && /case "layout"/.test(fs.readFileSync(path.join(H.IOS, 'Bridge.swift'), 'utf8')) && /pageScripts = \["page-hooks"\]/.test(H.swift) && /in: \.page\)\)/.test(H.swift));

  // ---- 1b. an iPad, Video mode, the page on: the video stays in sight (beside the page, or over it) ----
  {
    const { ctx, page, dbg } = await open(browser, 'iPad (gen 7) landscape', 'pad', { view: 'normal', stageOn: true });
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 20.5; return v.play(); });
    await until(async () => { const v = await vstate(page); return !v.paused && v.t > 21.2; }, 8000, 100);
    await act(page, 'explainLast');
    const split = await until(() => page.evaluate(() => {
      if (!document.documentElement.classList.contains('dr-split-r')) return null;
      const st = document.getElementById('dr-stage-host').getBoundingClientRect(), pl = document.getElementById('player-container-id').getBoundingClientRect();
      const cur = document.getElementById('dr-stage-host').shadowRoot.querySelector('.s.cur');
      const cr = cur ? cur.getBoundingClientRect() : null;
      return { stage: [Math.round(st.left), Math.round(st.width)], player: [Math.round(pl.left), Math.round(pl.width), Math.round(pl.height)], win: innerWidth, cur: cr ? cr.left >= st.left - 1 && cr.right <= innerWidth + 1 : null };
    }), 6000, 100);
    ok('an iPad on its side, Video mode, the page on: the video on the left (58%), the page on the right, the line being explained on the page',
      !!split && Math.abs(split.stage[0] - split.win * 0.58) < 3 && split.player[0] === 0 && Math.abs(split.player[1] - split.win * 0.58) < 3 && split.player[2] > 200 && split.cur === true, JSON.stringify(split || await page.evaluate(() => document.documentElement.className)));
    await page.setViewportSize({ width: 810, height: 1080 });
    const under = await until(() => page.evaluate(() => {
      if (!document.documentElement.classList.contains('dr-split-b')) return null;
      const st = document.getElementById('dr-stage-host').getBoundingClientRect(), pl = document.getElementById('player-container-id').getBoundingClientRect();
      return { stageTop: Math.round(st.top), playerH: Math.round(pl.height), playerW: Math.round(pl.width), win: [innerWidth, innerHeight] };
    }), 6000, 100);
    ok('...the iPad upright: the video on top, the page under it', !!under && under.playerW === under.win[0] && Math.abs(under.stageTop - under.playerH) <= 1 && under.playerH > 300 && under.playerH <= under.win[1] * 0.46, JSON.stringify(under));
    await page.evaluate(() => chrome.storage.local.get('drExtras').then((o) => chrome.storage.local.set({ drExtras: { ...o.drExtras, padSplit: false } })));
    const off = await until(() => page.evaluate(() => { const c = document.documentElement.classList; const st = document.getElementById('dr-stage-host').getBoundingClientRect(); return !c.contains('dr-split-r') && !c.contains('dr-split-b') && st.top === 0 && Math.abs(st.height - innerHeight) <= 1 ? true : null; }), 4000, 100);
    ok('..."the page beside the video" off: the page over the whole screen', !!off);
    await page.evaluate(() => window.__ytcDream.heard('bye bye', true, 't:split'));
    await until(async () => { const d = await dbg(); return d && !d.flow; }, 15000, 100);
    await ctx.close();
  }
  {
    // an iPhone never splits
    const { ctx, page } = await open(browser, 'iPhone 13', 'phone', { view: 'normal', stageOn: true });
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 20.5; return v.play(); });
    await until(async () => { const v = await vstate(page); return !v.paused && v.t > 21.2; }, 8000, 100);
    await act(page, 'explainLast');
    await sleep(1200);
    ok('an iPhone: no split (the page is over the whole screen)', await page.evaluate(() => { const c = document.documentElement.classList; return !c.contains('dr-split-r') && !c.contains('dr-split-b'); }));
    await ctx.close();
  }

  // ---- 1c. film-like subtitles in Video mode: one or two lines, only the piece being said now ----
  {
    const LONG = 'When I was a child my grandmother used to tell me every single evening that patience is not only the ability to wait for something, but also the ability to keep a good attitude while you are waiting for it because nothing good comes quickly.';
    const words = LONG.split(' ');
    // (one long line of subtitles with a time for every word: 0.5 s each, from 2 s on; then a short one)
    const longJson = JSON.stringify({ events: [
      { tStartMs: 2000, dDurationMs: words.length * 500, segs: words.map((w, i) => ({ utf8: (i ? ' ' : '') + w, tOffsetMs: i * 500 })) },
      { tStartMs: 2000 + words.length * 500 + 1000, dDurationMs: 3000, segs: [{ utf8: 'We will talk about it again very soon.' }] },
    ] });
    Object.assign(stores.local, { barOn: true, drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 }, drExtras: baseExtras({ view: 'normal', stageOn: false, aiSentences: false }), drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 10 } } });
    keychain.drKeys = JSON.stringify({});
    const id = 'ioslong0001';
    const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone', video: { id, tracks: [{ baseUrl: `https://m.youtube.com/api/timedtext?v=${id}&lang=en`, languageCode: 'en', vssId: '.en' }], json3ByUrl: () => longJson } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGE ERROR (long line)', String(e.message || e).slice(0, 300)));
    await page.goto(`https://m.youtube.com/watch?v=${id}`);
    await page.addScriptTag({ content: source(ytScripts) });
    const dbg = () => page.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
    await until(async () => { const x = await dbg(); return x && x.sentences >= 1 ? x : null; }, 30000);
    const lineNow = () => page.evaluate(() => {
      const h = document.getElementById('dr-band-host'); const line = h && h.shadowRoot.querySelector('.band .line');
      if (!line || !line.textContent.trim()) return null;
      const vis = Array.from(line.querySelectorAll('.w')).filter((w) => !w.hidden && w.offsetParent !== null);
      const r = line.getBoundingClientRect(), lh = parseFloat(getComputedStyle(line).lineHeight) || 27;
      return { shown: vis.map((w) => w.textContent.trim().split(/\s/)[0]).join(' '), words: vis.length, all: line.querySelectorAll('.w').length, piece: line.dataset.piece, lines: Math.round(r.height / lh * 10) / 10, cur: (line.querySelector('.w.cur-w') || {}).textContent || '', curShown: !!line.querySelector('.w.cur-w') && !line.querySelector('.w.cur-w').hidden };
    });
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 3; return v.play(); });
    const first = await until(async () => { const l = await lineNow(); return l && l.all > 30 && l.cur ? l : null; }, 10000, 100);
    ok('Video mode, a very long sentence: the subtitle shows only a piece of it (one or two lines), with the word being said', !!first && first.words < first.all && first.words >= 4 && first.lines <= 2.4 && first.curShown && /^When I was/.test(first.shown), JSON.stringify(first || await lineNow()));
    await page.evaluate(() => { document.querySelector('video').currentTime = 2 + 30 * 0.5 + 0.2; });
    const later = await until(async () => { const l = await lineNow(); return l && l.all > 30 && l.piece !== (first && first.piece) && l.curShown ? l : null; }, 10000, 100);
    ok('...later in the sentence the next piece is on the screen (never the whole sentence, never a cut-off end)', !!later && later.words < later.all && later.lines <= 2.4 && !/^When I was/.test(later.shown), JSON.stringify(later || await lineNow()));
    await ctx.close();
  }

  // ---- 2. One button mode: nothing changes on the screen; a touch = explain the last N seconds ----
  {
    const { ctx, page, dbg } = await open(browser, 'iPhone 13', 'phone', { view: 'reading' });
    const look = () => page.evaluate(() => { const host = document.getElementById('dr-stage-host'); const st = host.shadowRoot.querySelector('.stage'); const pg = st.querySelector('.page'); const r = pg.getBoundingClientRect(); return { view: st.dataset.view, px: getComputedStyle(pg).fontSize, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], lines: st.querySelectorAll('.s').length, bg: getComputedStyle(st).backgroundColor, one: st.dataset.one, dark: !!st.querySelector('.onebtn') }; });
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 20.5; return v.play(); });
    await until(async () => { const v = await vstate(page); return !v.paused && v.t > 21.5; }, 8000, 100);
    const before = await look();
    await act(page, 'oneButton');
    await until(() => stores.local.drExtras.oneButton === true, 3000, 50);
    await sleep(600);
    const after = await look();
    ok('One button mode on: the screen is exactly as it was (the same mode, text size, page, colours; nothing dark over it)',
      after.view === before.view && after.px === before.px && JSON.stringify(after.rect) === JSON.stringify(before.rect) && after.lines === before.lines && after.bg === before.bg && !after.dark && stores.local.drExtras.view === 'reading' && after.one === '1',
      JSON.stringify({ before, after, view: stores.local.drExtras.view }));
    const n0 = apiLog.length;
    // a touch on a word of the page: not that word, the last 10 s
    await page.evaluate(() => { const st = document.getElementById('dr-stage-host').shadowRoot.querySelector('.stage'); const w = Array.from(st.querySelectorAll('.w')).find((x) => x.offsetParent !== null); w.click(); });
    const part = await until(async () => { const d = await dbg(); return d && d.flow === 'part' ? d : null; }, 5000, 50);
    const req = await until(() => apiLog.slice(n0).find((r) => r.kind === 'explain' && /The learner just paused the video/.test(r.user)), 20000, 100);
    ok('...a touch anywhere on the page = the last 10 s are explained (not the word that was touched)', !!part && !!req && !apiLog.slice(n0).some((r) => r.kind === 'explain' && /does not know/.test(r.user)), JSON.stringify({ flow: part && part.flow, req: !!req }));
    await page.evaluate(() => window.__ytcDream.heard('bye bye', true, 't:one1'));
    await until(async () => { const d = await dbg(); return d && !d.flow && !d.talk; }, 15000, 100);
    await act(page, 'oneButton');
    await until(() => stores.local.drExtras.oneButton === false, 3000, 50);
    await ctx.close();
  }
  {
    // Video mode: a touch on the video
    const { ctx, page, dbg } = await open(browser, 'iPhone 13', 'phone', { view: 'normal', oneButton: true, stageOn: false });
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 20.5; return v.play(); });
    await until(async () => { const v = await vstate(page); return !v.paused && v.t > 21.5; }, 8000, 100);
    const n0 = apiLog.length;
    await page.evaluate(() => document.querySelector('video').click());
    const part = await until(async () => { const d = await dbg(); return d && d.flow === 'part' ? d : null; }, 5000, 50);
    ok('One button mode in Video mode: a touch on the video = the last 10 s are explained', !!part && !!(await until(() => apiLog.slice(n0).find((r) => r.kind === 'explain'), 20000, 100)), JSON.stringify({ flow: part && part.flow }));
    await ctx.close();
  }
  ok('the app\'s bar is the same in One button mode (no "Leave one-button mode" bar; its button says it is on)', !/Leave one-button mode/.test(cv) && /One button on/.test(cv) && !/model\.tutorOn && model\.oneButton/.test(cv));

  // ---- 3. the tutor's volume: quieter / louder ----
  {
    const { ctx, page, dbg } = await open(browser, 'iPhone 13', 'phone', { view: 'listening', teacherVolume: 60, wordVolume: 80 });
    const steps = [];
    for (let i = 0; i < 6; i++) { await act(page, 'quieter'); await until(() => stores.local.drExtras.teacherVolume !== (steps[steps.length - 1] ?? 60) || i > 3, 1500, 30); steps.push(stores.local.drExtras.teacherVolume); }
    ok('"quieter": the tutor\'s volume goes down a step at a time (50, 40, 32, 20) and stops at the lowest; the words read to you follow', JSON.stringify(steps) === JSON.stringify([50, 40, 32, 20, 20, 20]) && stores.local.drExtras.wordVolume === 20, JSON.stringify({ steps, word: stores.local.drExtras.wordVolume }));
    await sleep(250);
    const low = (await dbg()).volume;
    const up = [];
    for (let i = 0; i < 7; i++) { await act(page, 'louder'); await sleep(120); up.push(stores.local.drExtras.teacherVolume); }
    await sleep(250);
    const high = (await dbg()).volume;
    ok('"louder": up a step at a time to 100', JSON.stringify(up) === JSON.stringify([32, 40, 50, 63, 79, 100, 100]), JSON.stringify(up));
    ok('20% is clearly quieter than 100% (the sound level the voices get)', low && high && low.teacher > 0 && low.teacher <= high.teacher * 0.06 && low.word <= high.word * 0.06, JSON.stringify({ low, high }));
    // the volume reaches the voice that speaks (the iPhone's own voice here)
    await act(page, 'quieter'); await act(page, 'quieter'); await act(page, 'quieter'); // 50
    await sleep(300);
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 20.5; return v.play(); });
    await until(async () => { const v = await vstate(page); return !v.paused && v.t > 21.2; }, 8000, 100);
    await act(page, 'explainLast');
    const said = await until(async () => { const d = await dbg(); const s = d && d.spokenVol && d.spokenVol.length ? d.spokenVol[d.spokenVol.length - 1] : null; return s && s[1] !== null ? s : null; }, 20000, 100);
    ok('...what the tutor says next is said at that volume (50% of the slider = a quarter of the sound)', !!said && Math.abs(said[1] - 0.25) < 0.02, JSON.stringify(said));
    await ctx.close();
  }
  ok('the app\'s bar has a Volume button that opens two 60 pt buttons, quieter and louder', /private var volumeButton/.test(cv) && /volumeStep\("quieter"\)/.test(cv) && /volumeStep\("louder"\)/.test(cv) && /frame\(width: 64, height: 60\)/.test(cv) && /teacherVolume/.test(H.swift));
  ok('the live call\'s voice gets its volume through a gain where the element\'s own volume is ignored (an iPhone); cloud voices get it in the sound itself',
    /createMediaStreamSource\(stream\)\.connect\(gain\)/.test(fs.readFileSync(path.join(__dirname, '../dream-ext/src/live.ts'), 'utf8')) && /bakeVolume\(res\.audio, volume, k\)/.test(fs.readFileSync(path.join(__dirname, '../dream-ext/vendor/core/tts/audio.ts'), 'utf8')));

  await browser.close();
  api.close();
  console.log(H.fails() ? `\n${H.fails()} FAILED` : '\nALL PASSED');
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
