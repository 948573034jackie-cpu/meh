// I Know 3.13, step 1 (the learner's plan of 28 Nov): the smooth Speechify voice, in WebKit with an iPhone, with the
// FAKE Speechify server of tests/ios-harness.js (no real Speechify, no real key):
//  - a stop on a hard word: the word's sound is asked for while the video still plays (before the stop), and the first
//    sentence of the explanation while the "I know?" window is open (before the explanation starts); nothing is asked
//    for twice; the device's own voice says nothing
//  - the server fails: NO other voice takes over (the device voice stays silent), the stop still ends and the video
//    plays on, every failed try is in the voice log with its reason, and the learner is told why
//  - the server works again: the next stop is spoken by Speechify again, by itself
//  - Settings ▸ Voice shows the voice log, with Copy and Clear
// Run ios/sync-scripts.sh first. The fake video, the fake AI and the app's window are in tests/ios-harness.js.
process.env.IOS_TEST_PORT = process.env.IOS_TEST_PORT || '8881';
const fs = require('fs'); const path = require('path'); const http = require('http');
const H = require('./ios-harness');
const { pw, IOS, MIME, ok, until, sleep, source, sheetScripts, ytScripts, stores, keychain, speechifyLog, SPEECHIFY_CODE } = H;
const PAGES_PORT = +process.env.V313_PAGES_PORT || 8883;
H.watchdog(8);
H.startServer();
const SERVER = 'https://iknow-speech.tester.workers.dev';

async function open(browser, id) {
  for (const k of Object.keys(stores.local)) delete stores.local[k];
  H.resetVocab();
  Object.assign(stores.local, {
    barOn: true,
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 },
    drVocab: { words: {}, marked: {} },
    drExtras: { phoneSet: true, view: 'listening', levelAsk: false, levelMode: true, tutorOn: true, fakeVoice: true, voiceMode: false, oneButton: false, teacherVolume: 100, wordVolume: 100, myLevel: 50, migrated: 9, stageOn: false, talkAfterExplain: false, voice: 'speechify', speechifyUrl: SERVER },
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 10 } },
  });
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key', speechify: SPEECHIFY_CODE });
  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`PAGE ERROR (${id})`, String(e.message || e).slice(0, 300)));
  await page.goto(`https://m.youtube.com/watch?v=${id}`);
  await page.addScriptTag({ content: source(ytScripts) });
  const dbg = () => page.evaluate(() => { try { return JSON.parse(JSON.stringify((window.__drDebug && window.__drDebug()) || null)); } catch (e) { return null; } });
  const ready = await until(async () => { const x = await dbg(); return x && x.sentences === 10 && x.voice === 'speechify' ? x : null; }, 30000);
  // what the page does, a few times a second: is the video playing, the tutor's state, the window of a stop
  await page.evaluate(() => {
    window.__log = [];
    setInterval(() => {
      const d = window.__drDebug && window.__drDebug();
      window.__log.push({ at: Date.now(), playing: !document.querySelector('video').paused, state: d && d.state, win: d && d.window ? d.window.phase : '' });
    }, 40);
  });
  return { ctx, page, dbg, ready };
}
const vlog = (page) => page.evaluate(() => (window.__ytcDream.diag().voiceLog || []));
const speaks = (from) => speechifyLog.slice(from).filter((e) => e.path === '/speak');

(async () => {
  const pages = http.createServer((q, r) => { const f = path.join(IOS, 'Web/dream', path.basename(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f)); }).listen(PAGES_PORT);
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());

  // ---- 1. a stop with the Speechify voice: everything is ready before it is needed -------------------------------------
  {
    const mark = speechifyLog.length;
    const { ctx, page, dbg, ready } = await open(browser, 'ios31300001');
    const started = await until(() => page.evaluate(() => !document.querySelector('video').paused), 30000);
    const done = await until(async () => { const d = await dbg(); return d && d.level && d.level.stops >= 1 && d.state === 'playing' && d.cloud.filter((x) => x === 'meticulous').length >= 1 && d.cloud.some((x) => x.length > 25) ? d : null; }, 60000, 100);
    const log = await page.evaluate(() => window.__log);
    const sp = speaks(mark);
    const firstPlay = log.findIndex((s) => s.playing);
    const stopAt = log.find((s, i) => i > firstPlay && s.state === 'explaining');
    const winOpen = log.find((s) => s.win === 'before');
    const winLast = [...log].reverse().find((s) => s.win === 'before');
    const word = sp.find((e) => e.text === 'meticulous');
    const sentence = sp.find((e) => e.text && e.text.length > 25);
    ok('the Speechify voice is the tutor\'s voice, the video plays and stops at the hard word', !!ready && !!started && !!done && !!stopAt, JSON.stringify({ ready: !!ready, started: !!started, done: !!done }));
    ok('the hard word\'s sound is asked for BEFORE the stop (while the video still plays): no wait at the stop', !!word && !!stopAt && word.at < stopAt.at, JSON.stringify({ wordAt: word && word.at, stopAt: stopAt && stopAt.at }));
    ok('the first sentence of the explanation is asked for while the "I know?" window is open (before the explanation starts)', !!sentence && !!winOpen && !!winLast && sentence.at >= winOpen.at - 200 && sentence.at <= winLast.at, JSON.stringify({ text: sentence && sentence.text, at: sentence && sentence.at, open: winOpen && winOpen.at, close: winLast && winLast.at }));
    { const texts = sp.map((e) => e.text); const twice = texts.filter((t, i) => texts.indexOf(t) !== i);
      ok('nothing is asked for twice (what was made ahead is exactly what is said)', twice.length === 0 && texts.length >= 2, JSON.stringify({ twice, texts })); }
    ok('the device\'s own voice says nothing (Speechify is the only voice)', !!done && done.spoken.length === 0, JSON.stringify(done && done.spoken));
    ok('nothing went wrong, so the voice log has no "not spoken" line', !(await vlog(page)).some((l) => /not spoken|failed/.test(l)), JSON.stringify(await vlog(page)));
    await ctx.close();
  }

  // ---- 2. the server fails: no other voice, the stop ends, the reason is kept; then the voice comes back by itself ------
  {
    H.failSpeechify(100000);
    const mark = speechifyLog.length;
    const { ctx, page, dbg, ready } = await open(browser, 'ios31300002');
    await until(() => page.evaluate(() => !document.querySelector('video').paused), 30000);
    // the first stop: nothing can be said. It must still end, and the video must play on
    const over = await until(async () => { const d = await dbg(); return d && d.level && d.level.stops >= 1 && d.state === 'playing' ? d : null; }, 90000, 100);
    await sleep(1600);   // (the log is saved a moment after its last line)
    const lines = (stores.local.drVoiceLog || []).map((l) => [l.what, l.why, l.text].join(' · '));
    const failed = speaks(mark).filter((e) => e.failed);
    const first = failed.length ? failed[0].text : '';
    ok('the server fails at a stop: the stop still ends and the video plays on (nothing hangs)', !!ready && !!over, JSON.stringify(over ? null : await dbg().then((d) => d && { st: d.state, stops: d.level && d.level.stops })));
    ok('...NO other voice takes over: the device\'s own voice says nothing at all', !!over && over.spoken.length === 0, JSON.stringify(over && over.spoken));
    ok('...the sentence was tried again quietly (3 tries for the first one, then one short try for each next one)', failed.length >= 3 && failed.slice(0, 6).filter((e) => e.text === first).length === 3, JSON.stringify(failed.map((e) => e.text)));
    ok('...every failed try is in the voice log with its reason, and what was not spoken', lines.some((l) => /try 1 of 3 failed · .*Speechify did not answer/.test(l)) && lines.some((l) => /try 3 of 3 failed/.test(l)) && lines.some((l) => /not spoken · .*Speechify did not answer/.test(l)) && lines.length < 60, JSON.stringify({ n: lines.length, first: lines.slice(0, 8) }));
    const toldText = await page.evaluate(() => ['dr-stage-host', 'dr-panel-host'].map((h) => { const r = document.getElementById(h); return r && r.shadowRoot ? r.shadowRoot.textContent : ''; }).join(' '));
    ok('...the learner was told why, and that the sentence was not spoken (no word about another voice)', /This sentence was not spoken/.test(toldText) && !/iPhone voice reads/.test(toldText), toldText.match(/.{0,80}not spoken.{0,20}/) ? toldText.match(/.{0,80}not spoken.{0,20}/)[0] : 'no such text on the page');
    // the server is back: the next stop is the Speechify voice again, by itself
    H.failSpeechify(0);
    const mark2 = speechifyLog.length;
    const back = await until(async () => { const d = await dbg(); return d && d.level && d.level.stops >= 2 && speaks(mark2).some((e) => !e.failed && e.text && e.text.length > 25) ? d : null; }, 90000, 100);
    const lines2 = await vlog(page);
    ok('the server works again: the Speechify voice speaks at the next stop, by itself', !!back && speaks(mark2).some((e) => !e.failed && e.text && e.text.length > 25), JSON.stringify(speaks(mark2).map((e) => [e.text, !!e.failed])));
    ok('...the log says that it answers again, and the device voice still never spoke', lines2.some((l) => /Speechify answers again/.test(l)) && !!back && back.spoken.length === 0, JSON.stringify({ lines: lines2.slice(-4), spoken: back && back.spoken }));
    await ctx.close();
  }

  // ---- 3. Settings ▸ Voice: the voice log on the screen, Copy and Clear -------------------------------------------------
  {
    H.failSpeechify(0);
    const at = Date.now();
    stores.local.drVoiceLog = [
      { at: at - 60000, what: 'try 1 of 3 failed', why: 'Speechify voice: the Worker did not answer in time.', ms: 12003, text: 'Meticulous means very careful about' },
      { at: at - 30000, what: 'not spoken', why: 'Speechify voice: the Worker did not answer in time.', ms: 37650, text: 'Meticulous means very careful about' },
      { at: at - 1000, what: 'iOS: sound output changed', why: 'a new output was connected; sound: JBL Flip; microphone: off' },
    ];
    const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGE ERROR (settings)', String(e.message || e).slice(0, 300)));
    await p.addInitScript({ content: source(sheetScripts) });
    await p.goto(`http://localhost:${PAGES_PORT}/settings.html#voice`);
    await until(() => p.evaluate(() => document.body.dataset.ready === '1'), 20000);
    const box = await until(() => p.evaluate(() => {
      const r = document.getElementById('dr-settings-host').shadowRoot;
      const s = r.querySelector('.vlog'), pre = s && s.querySelector('[data-vlog]');
      if (!s || !pre || !/not spoken/.test(pre.textContent)) return null;
      s.scrollIntoView({ block: 'center' });
      const rect = (el) => { const b = el.getBoundingClientRect(); return { h: Math.round(b.height), w: Math.round(b.width), inside: b.left >= -1 && b.right <= innerWidth + 1 }; };
      const btn = [...s.querySelectorAll('button')].map((b) => ({ text: b.textContent, ...rect(b), font: parseFloat(getComputedStyle(b).fontSize) }));
      return { shown: getComputedStyle(s).display !== 'none', text: pre.textContent, font: parseFloat(getComputedStyle(pre).fontSize), pre: rect(pre), btn, title: s.querySelector('h3').textContent };
    }), 8000);
    ok('Settings ▸ Voice: the "Voice log" is on the screen with its lines (the time, what, why, how long, the first words)', !!box && box.shown && box.title === 'Voice log' && /try 1 of 3 failed · Speechify voice: the Worker did not answer in time\. · 12\.0 s · “Meticulous means very careful about”/.test(box.text) && /iOS: sound output changed · a new output was connected; sound: JBL Flip/.test(box.text), JSON.stringify(box));
    ok('...readable (13 px or more), inside the screen, with Copy and Clear buttons of 44 pt', !!box && box.font >= 13 && box.pre.inside && box.btn.length === 2 && box.btn.every((b) => b.h >= 44 && b.inside && b.font >= 15) && /Copy/.test(box.btn[0].text) && /Clear/.test(box.btn[1].text), JSON.stringify(box && { font: box.font, btn: box.btn }));
    await p.evaluate(() => { document.body.dataset.part = 'x'; window.__drSettings.show('tutor'); });
    const hidden = await until(() => p.evaluate(() => document.body.dataset.part === 'tutor' && getComputedStyle(document.getElementById('dr-settings-host').shadowRoot.querySelector('.vlog')).display === 'none'), 5000);
    ok('...it is only in the Voice part (not under the tutor\'s settings)', !!hidden, String(hidden));
    await p.evaluate(() => window.__drSettings.show('voice'));
    await until(() => p.evaluate(() => getComputedStyle(document.getElementById('dr-settings-host').shadowRoot.querySelector('.vlog')).display !== 'none'), 5000);
    await p.evaluate(() => document.getElementById('dr-settings-host').shadowRoot.querySelector('[data-vlog-act="clear"]').click());
    const cleared = await until(async () => !('drVoiceLog' in stores.local) && (await p.evaluate(() => /Nothing yet/.test(document.getElementById('dr-settings-host').shadowRoot.querySelector('[data-vlog]').textContent))), 5000);
    ok('...Clear empties it (also in the app\'s storage)', !!cleared, JSON.stringify({ kept: stores.local.drVoiceLog }));
    await ctx.close();
  }

  await browser.close();
  pages.close();
  console.log(H.fails() ? `I KNOW 3.13: ${H.fails()} FAILED` : 'I KNOW 3.13: ALL PASSED');
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
