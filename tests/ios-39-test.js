// I Know 3.9 (the learner's list of 13 Nov), in WebKit with an iPhone:
//  - Settings, first page: the Microsoft key box and the voice list are right under the voice buttons (not hidden);
//    the keys have their own box; my level is A1 … C2; "how much to explain" 0–100 % keeps only the hardest share
//  - the big card of a stop shows ONE meaning, stays while the tutor explains and says the word again, and closes
//    when the sentence starts to play again
//  - a clip made again at the learner's volume that will not play: the original plays instead, at once
// Run ios/sync-scripts.sh first. The fake video, the fake AI and the app's window are in tests/ios-harness.js.
const fs = require('fs');
const path = require('path');
const H = require('./ios-harness');
const { pw, ok, until, sleep, source, ytScripts, stores, keychain, apiLog } = H;
H.watchdog(6);
H.startServer();
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

async function open(browser, id, extras, keys = { anthropic: 'sk-ant-test-key' }, listen = {}, words = {}, scheme = 'light') {
  // (each part starts as a new learner: the "words heard" of the part before would hide its words for 1,000 words)
  for (const k of Object.keys(stores.local)) delete stores.local[k];
  H.resetVocab();
  Object.assign(stores.local, {
    barOn: true,
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 },
    drVocab: { words: { ...words }, marked: {} },
    drExtras: { phoneSet: true, view: 'listening', levelAsk: false, levelMode: true, tutorOn: true, fakeVoice: true, voiceMode: false, oneButton: false, teacherVolume: 60, wordVolume: 80, myLevel: 50, migrated: 9, stageOn: false, talkAfterExplain: false, ...extras },
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 10, ...listen } },
  });
  keychain.drKeys = JSON.stringify(keys);
  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const page = await ctx.newPage();
  await page.emulateMedia({ colorScheme: scheme });
  page.on('pageerror', (e) => console.log(`PAGE ERROR (${id})`, String(e.message || e).slice(0, 300)));
  await page.goto(`https://m.youtube.com/watch?v=${id}`);
  await page.addScriptTag({ content: source(ytScripts) });
  const dbg = () => page.evaluate(() => { try { return JSON.parse(JSON.stringify((window.__drDebug && window.__drDebug()) || null)); } catch (e) { return null; } });
  const ready = await until(async () => { const x = await dbg(); return x && x.sentences === 10 && (await page.evaluate(() => { const h = document.getElementById('dr-stage-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('.stage')); })) ? x : null; }, 30000);
  return { ctx, page, dbg, ready };
}
const act = (page, id) => page.evaluate((i) => window.__ytcDream.action(i), id);
const inQuick = (page, fn, arg) => page.evaluate(`(${fn})(document.getElementById('dr-stage-host').shadowRoot.querySelector('.stage > .quick'), ${JSON.stringify(arg ?? null)})`);

(async () => {
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());

  // ---- 1. Settings: the Microsoft key and voice are on the first page; my level; how much to explain ----
  {
    const { ctx, page, dbg, ready } = await open(browser, 'ios39000001', { voice: 'azure' });
    await act(page, 'quick');
    const q1 = await inQuick(page, (q) => {
      const first = q.querySelector('section.first');
      const box = first.querySelector('input[data-key="azure"]');
      return { text: first.textContent, box: !!box, type: box && box.type, save: !!(box && box.closest('label').querySelector('button[data-act="save-key"][data-k="azure"]')), region: !!first.querySelector('input[data-name="azureRegion"]'), h: box ? box.getBoundingClientRect().height : 0, advOpen: q.querySelector('details.adv.main').open };
    });
    ok('Microsoft chosen and no key saved: the first page says so and has the key box, its Save button and the region right there (Advanced stays closed)',
      !!ready && !!q1 && /No Microsoft key is saved/.test(q1.text) && q1.box && q1.type === 'password' && q1.save && q1.region && q1.advOpen === false, JSON.stringify(q1 && { ...q1, text: q1.text.slice(-260) }));
    // the key is typed into that box and saved
    const n0 = apiLog.length;
    await inQuick(page, (q) => { const i = q.querySelector('section.first input[data-key="azure"]'); i.focus(); i.value = 'azure-test-key-0001'; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); i.closest('label').querySelector('button[data-act="save-key"]').click(); });
    const saved = await until(() => JSON.parse(keychain.drKeys || '{}').azure === 'azure-test-key-0001', 5000);
    ok('...a key typed there and saved goes to the Keychain (never to the settings file), and it is tested at once', !!saved && !JSON.stringify(stores).includes('azure-test-key') && !!(await until(() => apiLog.slice(n0).find((r) => r.kind === 'azure-list'), 5000)), JSON.stringify(Object.keys(JSON.parse(keychain.drKeys || '{}'))));
    const q2 = await until(async () => { const x = await inQuick(page, (q) => { const first = q.querySelector('section.first'); const pick = first.querySelector('select[data-name="azureVoice"]'); return { pick: !!pick, voices: pick ? pick.options.length : 0, warn: /No Microsoft key is saved/.test(first.textContent), test: !!first.querySelector('button[data-act="test"]') }; }); return x && x.pick ? x : null; }, 5000);
    ok('...then the Microsoft voice list is on the first page too, with a Test button (the warning is gone)', !!q2 && q2.voices >= 1 && !q2.warn && q2.test && (await dbg()).voice === 'azure', JSON.stringify(q2 || await dbg().then((d) => d && d.voice)));
    // how much to explain: 100 % = all three hard words of this video, 50 % = the two hardest, 10 % = one, 0 = none
    const chosenAt = async (pct) => {
      await inQuick(page, (q, v) => { const lv = q.querySelector('input[data-name="pctWords"]'); lv.value = String(v); lv.dispatchEvent(new Event('input', { bubbles: true })); lv.blur(); }, pct);
      await until(() => stores.local.drExtras.pctWords === pct, 4000);
      await sleep(250);
      const d = await dbg();
      return d && d.level ? d.level.chosen : null;
    };
    const all = (await dbg()).level.chosen;
    const c50 = await chosenAt(50), c10 = await chosenAt(10), c0 = await chosenAt(0), c100 = await chosenAt(100);
    ok('how much to explain: 100 % = every hard thing of the video, 50 % = the harder half, 10 % = only the hardest, 0 = nothing', all === 3 && c100 === 3 && c50 === 2 && c10 === 1 && c0 === 0, JSON.stringify({ all, c100, c50, c10, c0 }));
    // 3.10: Words, Phrases and Sentences each have their switch and their own "how much"; a kind that is off is not marked
    const rows = await inQuick(page, (q) => ['pctWords', 'pctPhrases', 'pctSentences'].map((n) => { const i = q.querySelector(`section.first input[type=range][data-name="${n}"]`); return i ? { v: i.value, sw: !!i.closest('label').querySelector('.seg'), off: i.disabled } : null; }));
    ok('Settings: Words, Phrases and Sentences each have On / Off and their own slider 0 to 100 %', rows.every((r) => r && r.sw && !r.off) && rows.map((r) => r.v).join(' ') === '100 100 100', JSON.stringify(rows));
    await inQuick(page, (q, v) => { const lv = q.querySelector('input[data-name="pctPhrases"]'); lv.value = String(v); lv.dispatchEvent(new Event('input', { bubbles: true })); lv.blur(); }, 40);
    const p40 = await until(() => stores.local.drExtras.pctPhrases === 40 && stores.local.drExtras.pctWords === 100, 4000);
    const marks = () => page.evaluate(() => { const h = document.getElementById('dr-stage-host'); const w = h.shadowRoot.querySelector('.page .w.hl-unknown, .page .w.hl-learning'); return { hlw: h.dataset.hlw, hlp: h.dataset.hlp, hls: h.dataset.hls, word: w ? w.textContent : null, bg: w ? getComputedStyle(w).backgroundColor : null }; });
    const m1 = await marks();
    await inQuick(page, (q) => q.querySelector('.seg[data-name="stopItemsOn"] button[data-v="off"]').click());
    const m2 = await until(async () => { const m = await marks(); return m.hlw === '0' ? m : null; }, 4000);
    await inQuick(page, (q) => q.querySelector('.seg[data-name="stopPhrasesOn"] button[data-v="off"]').click());
    const m3 = await until(async () => { const m = await marks(); return m.hlp === '0' ? m : null; }, 4000);
    const offRow = await inQuick(page, (q) => q.querySelector('input[data-name="pctWords"]').disabled);
    ok('...phrases at 40 % is kept by itself; Words off: the hard words are no longer marked in the text (and its slider rests); Phrases off: the phrases neither',
      !!p40 && m1.hlw === '1' && !!m1.word && m1.bg !== 'rgba(0, 0, 0, 0)' && !!m2 && m2.bg === 'rgba(0, 0, 0, 0)' && !!m3 && m3.hls === '1' && offRow === true, JSON.stringify({ m1, m2, m3, offRow }));
    await inQuick(page, (q) => q.querySelector('.seg[data-name="stopItemsOn"] button[data-v="on"]').click());
    await inQuick(page, (q) => q.querySelector('.seg[data-name="stopPhrasesOn"] button[data-v="on"]').click());
    await until(() => stores.local.drExtras.stopItemsOn === true && stores.local.drExtras.stopPhrasesOn === true, 4000);
    // my level: C2 = none of these words is at my level or above... (they stay for a learner at B2)
    await inQuick(page, (q) => q.querySelector('.seg[data-name="learnerLevel"] button[data-v="C2"]').click());
    const atC2 = await until(async () => { const d = await dbg(); return stores.local.drSettings.learnerLevel === 'C2' && d && d.level && d.level.cefr === 'C2' ? d.level : null; }, 5000);
    await inQuick(page, (q) => q.querySelector('.seg[data-name="learnerLevel"] button[data-v="A2"]').click());
    const atA2 = await until(async () => { const d = await dbg(); return stores.local.drSettings.learnerLevel === 'A2' && d && d.level && d.level.cefr === 'A2' ? d.level : null; }, 5000);
    ok('my level: a higher level stops at fewer things, a lower one at more (nothing below my level is explained)', !!atC2 && !!atA2 && atC2.chosen < 3 && atA2.chosen >= 3 && atC2.mine === 84 && atA2.mine === 18, JSON.stringify({ c2: atC2 && atC2.chosen, a2: atA2 && atA2.chosen }));
    await ctx.close();
  }

  // ---- 2. the big card: one meaning; it stays for the explanation and the word again; gone when the sentence plays ----
  {
    // (3.10: the word is said ONCE before the explanation and THREE times after it, then the sentence once)
    const { ctx, page, dbg, ready } = await open(browser, 'ios39000002', {});
    await page.evaluate(() => {
      const r = document.getElementById('dr-stage-host').shadowRoot;
      window.__log = [];
      setInterval(() => {
        const c = r.querySelector('.card'), d = window.__drDebug && window.__drDebug();
        const shown = !!c && !c.hidden && c.classList.contains('full');
        window.__log.push({ at: Date.now(), card: shown ? (c.querySelector('.word') || {}).textContent : '', zh: shown ? (c.querySelector('.zh') || {}).textContent || '' : '', playing: !document.querySelector('video').paused, state: d && d.state, win: d && d.window ? d.window.phase : '', said: d ? d.spoken.join(' | ') : '' });
      }, 40);
    });
    const started = await until(() => page.evaluate(() => !document.querySelector('video').paused), 30000);
    // the first stop ("meticulous"): nothing tapped, so the tutor explains
    const done = await until(async () => { const d = await dbg(); return d && d.level && d.level.stops >= 1 && d.state === 'playing' && d.spoken.some((x) => /It means something simple/.test(x)) ? d : null; }, 40000, 100);
    const log = await page.evaluate(() => window.__log);
    const from = log.findIndex((s) => s.card === 'meticulous');
    const stop = from >= 0 ? log.slice(from) : [];
    const end = stop.findIndex((s) => s.state === 'playing');
    const part = end >= 0 ? stop.slice(0, end + 1) : stop;
    const explaining = part.filter((s) => /It means something simple/.test(s.said) && !/It means something simple.*\| meticulous$/.test(s.said));
    const wordAgain = part.filter((s) => /It means something simple.*\| meticulous$/.test(s.said));
    ok('a stop on a hard word: the big card shows the word with ONE meaning (the one for this sentence)', !!ready && !!started && !!done && from >= 0 && !/[；;]/.test(stop[0].zh), JSON.stringify(stop[0] || null));
    ok('...it stays on the screen while the tutor explains', explaining.length > 0 && explaining.every((s) => s.card === 'meticulous'), JSON.stringify(explaining.filter((s) => !s.card).slice(0, 2)));
    ok('...and while the word is said again (the video still stopped)', wordAgain.some((s) => !s.playing && s.card === 'meticulous'), JSON.stringify(wordAgain.slice(0, 3).map((s) => ({ c: s.card, p: s.playing }))));
    ok('...it closes when the sentence starts to play again, and never shows while the video plays', wordAgain.some((s) => s.playing) && part.filter((s) => s.playing).every((s) => !s.card), JSON.stringify(part.filter((s) => s.playing && s.card).slice(0, 2)));
    { const sp = done ? done.spoken : []; const i1 = sp.findIndex((x) => /This part is the hard one|It means something simple/.test(x)); const i2 = sp.map((x) => /It means something simple/.test(x)).lastIndexOf(true);
      const before = sp.slice(0, i1).filter((x) => x === 'meticulous').length, after = sp.slice(i2 + 1).filter((x) => x === 'meticulous').length;
      ok('the word is said once, then the explanation, then the word three times (then the sentence plays once from the video)', i1 > 0 && before === 1 && after === 3, JSON.stringify(sp.slice(0, 12))); }
    ok('...after the stop the page is as before (the listening page, no card, the video playing)', !!done && !done.card && !(await page.evaluate(() => document.documentElement.classList.contains('dr-fullcard'))), JSON.stringify(done && done.card));
    await ctx.close();
  }

  // ---- 3. the volume in the sound: a clip that will not play is replaced by the original at once ----
  {
    const audio = src('dream-ext/vendor/core/tts/audio.ts'), gain = src('dream-ext/vendor/core/tts/gain.ts');
    ok('a clip made again at my volume has a time limit (1.5 s to make, 2.5 s to start); if it fails the original plays; a device where it never worked is not asked again for a while, one where it has worked keeps it',
      /BAKE_TIMEOUT_MS = 1500/.test(gain) && /decoding took too long/.test(gain) && /BAKED_START_MS = 2500/.test(audio) && /bakeFailed\(\); this\.lastBaked = null; this\.bakeFails\+\+; voiceStats\.bakeFails\+\+; plain\(\);/.test(audio) && /if \(bakeResting\(\)\) return false;/.test(gain) && /if \(bakeWorked\) return;/.test(gain));
    const { ctx, page } = await open(browser, 'ios39000003', { fakeVoice: false, voice: 'azure' }, { anthropic: 'sk-ant-test-key', azure: 'azure-test-key-0001' });
    // (this device ignores the element's volume, and the sound made again will not play: its address is broken)
    await page.evaluate(() => {
      window.__ytcBakeVolume = true;
      const make = URL.createObjectURL.bind(URL);
      window.__wavs = 0;
      URL.createObjectURL = (b) => { if (b && b.type === 'audio/wav' && b.size > 44 && window.__breakWav) { window.__wavs++; return 'blob:https://m.youtube.com/00000000-0000-0000-0000-000000000000'; } return make(b); };
      window.__breakWav = true;
    });
    const dbg = () => page.evaluate(() => { try { return JSON.parse(JSON.stringify((window.__drDebug && window.__drDebug()) || null)); } catch (e) { return null; } });
    const press = async () => { await act(page, 'quick'); await page.evaluate(() => document.getElementById('dr-stage-host').shadowRoot.querySelector('.stage > .quick section.first button[data-act="test"]').click()); await act(page, 'quick'); };
    const t0 = Date.now();
    await press();
    const first = await until(async () => { const d = await dbg(); return d && d.voiceClips && d.voiceClips.started >= 1 ? d.voiceClips : null; }, 9000, 80);
    const took = Date.now() - t0;
    ok('the clip made again at my volume will not play: the Microsoft voice is heard all the same (the original clip), within a few seconds, not after a long silence',
      !!first && first.bakeFails === 1 && first.baked === 0 && took < 6000 && (await page.evaluate(() => window.__wavs)) === 1, JSON.stringify({ first, took, d: await dbg().then((d) => d && { v: d.voice, p: d.voiceProblem }) }));
    // (from then on this device is not asked again: the next sentence plays at once, as it is)
    await sleep(3500);
    await press();
    const second = await until(async () => { const d = await dbg(); return d && d.voiceClips && d.voiceClips.started >= 2 ? d.voiceClips : null; }, 9000, 80);
    ok('...and the next sentence plays at once, as it is (no second try on this device)', !!second && second.bakeFails === 1 && (await page.evaluate(() => window.__wavs)) === 1, JSON.stringify(second || await dbg().then((d) => d && d.voiceClips)));
    await ctx.close();
  }

  // ---- 2b. the share does not creep: at 10 % one hard word of this video is explained, and it stays one ----
  {
    const { ctx, page, dbg, ready } = await open(browser, 'ios39000007', { explainPct: 10 });
    const c0 = ready && ready.level ? ready.level.chosen : null;
    await until(() => page.evaluate(() => !document.querySelector('video').paused), 30000);
    // (to the end of the last hard sentence, 28 s, whatever stops on the way)
    const end = await until(async () => { const t = await page.evaluate(() => document.querySelector('video').currentTime); const d = await dbg(); return t > 33 && d && d.state === 'playing' ? d : null; }, 90000, 200);
    ok('how much to explain, 10 %: only the hardest of the three hard words stops (and one I am still learning); after those stops the next-hardest word does NOT move up', c0 !== null && c0 >= 1 && c0 < 3 && !!end && end.level.stops === c0 && end.level.chosen <= c0, JSON.stringify({ c0, stops: end && end.level.stops, chosen: end && end.level.chosen, why: end && end.level.why }));
    await ctx.close();
  }

  // ---- 3b. the card's Chinese is the AI's meaning IN THIS SENTENCE: asked in real time when the analysis has none ----
  {
    // ("detail" is on my own list: it stops; the video's analysis gave no meaning for it)
    const { ctx, page, dbg, ready } = await open(browser, 'ios39000004', {}, undefined, {}, { detail: 'learning' });
    const n0 = apiLog.length;
    await until(() => page.evaluate(() => !document.querySelector('video').paused), 30000);
    const card = () => page.evaluate(() => { const c = document.getElementById('dr-stage-host').shadowRoot.querySelector('.card.full'); return c && !c.hidden ? { word: (c.querySelector('.word') || {}).textContent, zh: (c.querySelector('.zh') || {}).textContent || '' } : null; });
    // (the first stop is "meticulous": its meaning came with the video's analysis, for this very sentence: nothing is asked)
    const c1 = await until(async () => { const c = await card(); return c && c.word === 'meticulous' ? c : null; }, 30000, 60);
    const asked1 = apiLog.slice(n0).filter((r) => r.kind === 'zhword').length;
    ok('a word the video\'s analysis translated for this very sentence: its card shows that meaning, nothing more is asked', !!ready && !!c1 && c1.zh === '一丝不苟的' && asked1 === 0, JSON.stringify({ c1, asked1 }));
    // (one tap on the card = I know: the video plays on to the next stop)
    await sleep(650);
    { const vp = page.viewportSize(); await page.touchscreen.tap(Math.round(vp.width * 0.5), Math.round(vp.height * 0.7)); }
    const c2 = await until(async () => { const c = await card(); return c && c.word === 'detail' && c.zh === '细致的' ? c : null; }, 30000, 60);
    const asks = apiLog.slice(n0).filter((r) => r.kind === 'zhword');
    ok('a word the analysis has no meaning for: the AI is asked at once for its meaning in this sentence (one small request) and the card shows it', !!c2 && asks.length === 1 && /detail/.test(asks[0].user) && /She checked every small detail/.test(asks[0].user), JSON.stringify({ c2: c2 || await card(), asks: asks.length }));
    await ctx.close();
  }

  // ---- 3c. ONE look for every mode: Auto (as the device is set), Day, Night ----
  {
    const { ctx, page, ready } = await open(browser, 'ios39000005', {}, undefined, {}, {}, 'dark');
    const look = () => page.evaluate(() => { const h = document.getElementById('dr-stage-host'); const st = h.shadowRoot.querySelector('.stage'); return { look: h.dataset.look, bg: getComputedStyle(st).backgroundColor, view: st.dataset.view }; });
    const dark = (c) => { const m = /(\d+), (\d+), (\d+)/.exec(c || ''); return !!m && (+m[1] + +m[2] + +m[3]) / 3 < 80; };
    const l0 = await look();
    ok('Look "Auto" on a device set to dark: the Listening page is dark', !!ready && l0.look === 'night' && dark(l0.bg) && l0.view === 'all', JSON.stringify(l0));
    await page.emulateMedia({ colorScheme: 'light' });
    const l1 = await until(async () => { const l = await look(); return l.look === 'day' ? l : null; }, 3000);
    ok('...the device goes light: the page follows at once, light, in Listening mode too (not only Reading)', !!l1 && !dark(l1.bg), JSON.stringify(l1 || await look()));
    await act(page, 'quick');
    const seg = await inQuick(page, (q) => { const sg = q.querySelector('section.first .seg[data-name="readLook"]'); return sg ? { opts: Array.from(sg.querySelectorAll('button')).map((b) => b.dataset.v).join(' '), on: (sg.querySelector('button.on') || {}).dataset.v } : null; });
    ok('Settings, first page: Look has Auto, Day and Night (Auto at first)', !!seg && seg.opts === 'auto day night' && seg.on === 'auto', JSON.stringify(seg));
    await inQuick(page, (q) => q.querySelector('.seg[data-name="readLook"] button[data-v="night"]').click());
    const l2 = await until(async () => { const l = await look(); return l.look === 'night' ? l : null; }, 3000);
    await inQuick(page, (q) => q.querySelector('.seg[data-name="view"] button[data-v="reading"]').click());
    const l3 = await until(async () => { const l = await look(); return l.view === 'read' ? l : null; }, 5000);
    { const rd = await page.evaluate(() => { const r = document.getElementById('dr-stage-host').shadowRoot; const pg = r.querySelector('.stage .page'), para = r.querySelector('.stage .page .para'), w = r.querySelector('.stage .page .w'); return { ws: parseFloat(getComputedStyle(pg).wordSpacing), side: parseFloat(getComputedStyle(para).paddingLeft), wpad: parseFloat(getComputedStyle(w).paddingLeft), top: parseFloat(getComputedStyle(pg).paddingTop) }; });
      ok('Reading (3.10): the words stand a little closer and the text uses more of the screen (14 pt at the sides, 10 at the top)', rd.ws < 0 && rd.wpad === 0 && rd.side <= 14 && rd.top <= 10, JSON.stringify(rd)); }
    ok('"Night" by hand: dark whatever the device says, and the same in Reading mode', !!l2 && dark(l2.bg) && stores.local.drExtras.readLook === 'night' && !!l3 && l3.look === 'night' && dark(l3.bg), JSON.stringify({ l2, l3: l3 || await look() }));
    await ctx.close();
  }

  // ---- 3d. the tutor off = a normal YouTube page ----
  {
    const { ctx, page, ready } = await open(browser, 'ios39000006', {});
    await until(() => page.evaluate(() => !document.querySelector('video').paused), 30000);
    await page.evaluate(() => window.__ytcDream.action('tutor'));
    const off = await until(() => page.evaluate(() => { const d = window.__ytcDream.diag(); return d && d.mode === 'off' ? { flag: document.documentElement.dataset.ytcTutor, stage: !!document.getElementById('dr-stage-host'), full: document.documentElement.classList.contains('dr-full') || document.documentElement.classList.contains('dr-fullcard') } : null; }), 5000);
    ok('the tutor turned off: nothing of the tutor is on the page (no book of subtitles, no card), YouTube\'s own full screen is YouTube\'s again', !!ready && !!off && stores.local.drExtras.tutorOn === false && off.flag === '0' && !off.stage && !off.full, JSON.stringify(off));
    // the video is YouTube's own: it plays on by itself, and nothing stops it at the hard words
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 2; return v.play(); });
    await sleep(9000);
    const v = await page.evaluate(() => { const x = document.querySelector('video'); return { paused: x.paused, t: x.currentTime }; });
    ok('...the video plays like on a normal page: no stop at "meticulous", it just goes on', !v.paused && v.t > 8.5, JSON.stringify(v));
    await page.evaluate(() => window.__ytcDream.action('tutor'));
    const on = await until(() => page.evaluate(() => { const d = window.__ytcDream.diag(); return d && d.mode === 'tutor' && document.documentElement.dataset.ytcTutor === '1' && !!document.getElementById('dr-stage-host'); }), 15000);
    ok('...turned on again: the tutor is back on the same video', !!on && stores.local.drExtras.tutorOn === true);
    const cvx = fs.readFileSync(path.join(H.IOS, 'ContentView.swift'), 'utf8');
    ok('the app\'s bar with the tutor off: one big "Tutor off" button to turn it on (free mode only when Settings asks for it)', /barLabel\("power", "Tutor off", big: true\)/.test(cvx) && /if model\.freeMode \{/.test(cvx) && /offMode === 'free'/.test(src('dream-ext/src/yt.ts')));
    await ctx.close();
  }

  // ---- 4. the app: back where you stopped, and the keys in the app's own settings ----
  {
    const am = H.swift, cv = fs.readFileSync(path.join(H.IOS, 'ContentView.swift'), 'utf8'), rs = fs.readFileSync(path.join(H.IOS, 'ReaderScreen.swift'), 'utf8');
    ok('iOS stopped the page while the app was away: the last page opens again at its minute (now, or when the app is back in front)',
      /func webViewWebContentProcessDidTerminate[\s\S]{0,400}pageLost = true[\s\S]{0,200}backInFront\(\)/.test(am) && /didBecomeActiveNotification[\s\S]{0,120}backInFront\(\)/.test(am) && /func openLastPage/.test(am));
    ok('the app remembers which screen was in front (the video, the reader, the browser) and opens there again; the video\'s page waits unloaded behind it',
      /"appScreen": screen/.test(am) && /screen == "reader" \|\| screen == "browser"/.test(am) && /pageWaits = true/.test(am) && /pageWanted\(\)/.test(rs));
    ok('any YouTube address counts as the last page (not only m.youtube.com)', /static func isYouTube/.test(am) && /AppModel\.isYouTube\(parts\.host\)/.test(am));
    ok('the reader opens the book that was open again, at its place', /drReaderOpen/.test(src('dream-ext/src/reader.ts')) && /openBook\(id, false\)/.test(src('dream-ext/src/reader.ts')));
    ok('App settings has the API keys: a box for each key (typed by the learner, kept in the Keychain), the region, Save and Test',
      /Section\(header: Text\("API keys"\)/.test(cv) && /SecureField/.test(cv) && /model\.saveKeys\(keyText, region: region\)/.test(cv) && /model\.testMicrosoft/.test(cv) && /Keys\.set\("drKeys", text\)/.test(am) && !/print\(.*drKeys/.test(am));
  }

  await browser.close();
  console.log(H.fails() ? `\n${H.fails()} FAILED` : '\nALL PASSED');
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
