// The Speechify voice in Settings, in WebKit (the iPhone's engine), iPhone 13, with the FAKE Speechify server of
// tests/ios-harness.js (no real Speechify, no real key):
//  I Know Book: the voice choice has "Speechify (natural)" next to the old voices; its rows are on the screen (server
//  address, app code, voice, Test, the counter, the daily limit, the help line, "How to set up Speechify"); each row
//  saves its value (the app code goes to the Keychain stand-in, never into the store or the page); the voice picker
//  lists the server's voices with the British one first and marked; Test shows the server's answer; the counter
//  shows the usage; a sentence is said by Speechify, and by the device's voice when the server fails; Listening
//  asks for nothing across a paragraph's end.
//  I Know: the same rows in the tutor's settings on the YouTube page.
// What counts is what is really on the screen (computed style, rectangles, elementFromPoint).
// Run ios/sync-scripts.sh first.
process.env.IOS_TEST_PORT = process.env.IOS_TEST_PORT || '8871';
const fs = require('fs'); const path = require('path'); const http = require('http');
const H = require('./ios-harness');
const { pw, IOS, MIME, ok, until, sleep, source, sheetScripts, ytScripts, stores, keychain, speechifyLog, SPEECHIFY_CODE } = H;
const PAGES_PORT = +process.env.SFY_PAGES_PORT || 8873;
H.watchdog(8);
H.startServer();

const SERVER = 'https://iknow-speech.tester.workers.dev';
const dayStart = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()).toISOString(); };
const monthStart = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1).toISOString(); };
const usage = () => {
  const early = new Date(new Date(monthStart()).getTime() + 60_000).toISOString();
  return [
    { date: new Date().toISOString(), provider: 'openai', model: 'speechify', inputTokens: 1234, outputTokens: 0, cachedTokens: 0, usd: 0.02 },
    { date: early, provider: 'openai', model: 'speechify', inputTokens: 4000, outputTokens: 0, cachedTokens: 0, usd: 0.06 },
  ];
};
const resetStores = (local) => { for (const k of Object.keys(stores.local)) delete stores.local[k]; for (const k of Object.keys(stores.sync)) delete stores.sync[k]; Object.assign(stores.local, JSON.parse(JSON.stringify(local))); };
const BOOK_STORE = () => ({ drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 }, drExtras: { tutorOn: true, fakeVoice: true, phoneSet: true, myLevel: 50, migrated: 9, knownAfter: 7 }, drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500 } }, drVocab: { words: {}, marked: {} }, drUsage: usage() });
const n = (x) => x.toLocaleString('en-US');

/** in the page: an element is drawn, inside the screen once scrolled to, and on top at its middle */
function onScreen(sel) {
  const root = window.__sfyRoot ? window.__sfyRoot() : document;
  const el = root.querySelector(sel);
  if (!el) return { sel, there: false };
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const x = r.left + Math.min(r.width / 2, 20), y = r.top + r.height / 2;
  const top = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
  return { sel, there: true, display: cs.display, h: Math.round(r.height), w: Math.round(r.width), inside: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1, onTop: !!top && (el === top || el.contains(top) || top.contains(el) && top.tagName === 'LABEL') };
}
const ROWS = ['[data-sfy="url"]', '[data-sfy="code"]', '[data-sfy="voice"]', '[data-sfy-act="test"]', '[data-sfy-out="usage"]', '[data-sfy="limit"]', '.sfy-help', '[data-sfy-act="steps"]'];

async function bookPart(browser) {
  resetStores(BOOK_STORE());
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });
  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGE ERROR (book)', String(e.message || e).slice(0, 300)));
  await p.addInitScript({ content: source(sheetScripts) });
  await p.goto(`http://localhost:${PAGES_PORT}/book.html`);
  await until(() => p.evaluate(() => document.body.dataset.ready === '1'), 20000);
  const dbg = () => p.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  // (the settings: the Settings tab when the page has one, else the tutor sheet of the library)
  const openSettings = () => p.evaluate(() => { const t = document.getElementById('tab-settings'); if (t) t.click(); else document.getElementById('lib-set').click(); });
  await p.evaluate(() => { window.__sfyRoot = () => document; });
  await openSettings();
  await sleep(400);
  const choices = await p.evaluate(() => [...document.querySelectorAll('.opts[data-name="voice"] button')].map((b) => [b.dataset.v, b.textContent]));
  ok('I Know Book: the voice choice has "Speechify (natural)" next to every voice it had (Auto, Microsoft, OpenAI, ElevenLabs, iPhone)',
    choices.map((c) => c[0]).join(' ') === 'auto azure openai elevenlabs speechify mac' && choices.find((c) => c[0] === 'speechify')[1] === 'Speechify (natural)', JSON.stringify(choices));
  await p.evaluate(() => document.querySelector('.opts[data-name="voice"] button[data-v="speechify"]').click());
  ok('...choosing it is saved (drExtras.voice = speechify)', !!(await until(() => stores.local.drExtras && stores.local.drExtras.voice === 'speechify', 4000)), JSON.stringify(stores.local.drExtras && stores.local.drExtras.voice));
  await until(() => p.evaluate(() => !!document.querySelector('[data-sfy-box]')), 4000);
  const rows = [];
  for (const sel of ROWS) rows.push(await p.evaluate(onScreen, sel));
  ok('...its rows are really on the screen: Server address, App code, Voice, Test, the counter, Daily limit, the help line, How to set up Speechify',
    rows.every((r) => r.there && r.display !== 'none' && r.h > 0 && r.inside && r.onTop), JSON.stringify(rows));
  const look = await p.evaluate(() => { const b = document.querySelector('[data-sfy-box]'); const btn = b.querySelector('[data-sfy-act="test"]'); const inp = b.querySelector('[data-sfy="url"]'); return { btnH: btn.getBoundingClientRect().height, inpH: inp.getBoundingClientRect().height, font: parseFloat(getComputedStyle(b.querySelector('.sfy-help')).fontSize), help: b.querySelector('.sfy-help').textContent, warn: (b.querySelector('.sfy-warn') || {}).textContent || '', labels: [...b.querySelectorAll('.sfy-l')].map((l) => l.textContent).join(' | ') }; });
  ok('...44 pt buttons and boxes, readable text; the labels; the help line says the key is NOT typed here; a warning until it is set up',
    look.btnH >= 44 && look.inpH >= 44 && look.font >= 13 && look.labels === 'Server address | App code | Voice | Daily limit' && look.help === 'Your Speechify key is NOT typed here: it is kept on your own small server. See the steps in Setup.' && /server address and the app code/.test(look.warn), JSON.stringify(look));

  // the server address
  await p.fill('[data-sfy="url"]', SERVER + '/');
  await p.click('[data-sfy-act="save-url"]');
  ok('Server address: Save keeps it (extras.speechifyUrl, without the last /)', !!(await until(() => stores.local.drExtras.speechifyUrl === SERVER, 4000)), String(stores.local.drExtras.speechifyUrl));
  // the app code
  await until(() => p.evaluate(() => !!document.querySelector('[data-sfy="code"]')), 3000);
  await p.fill('[data-sfy="code"]', SPEECHIFY_CODE);
  await p.click('[data-sfy-act="save-code"]');
  const saved = await until(() => { try { return JSON.parse(keychain.drKeys).speechify === SPEECHIFY_CODE; } catch (e) { return false; } }, 4000);
  await sleep(500);
  const leak = await p.evaluate((code) => ({ html: document.documentElement.outerHTML.includes(code), text: document.body.innerText.includes(code), fields: [...document.querySelectorAll('input')].some((i) => i.value.includes(code) || (i.placeholder || '').includes(code)), type: (document.querySelector('[data-sfy="code"]') || {}).type, ph: (document.querySelector('[data-sfy="code"]') || {}).placeholder }), SPEECHIFY_CODE);
  ok('App code: Save puts it in the Keychain (the stand-in), with the other keys', !!saved && /sk-ant-test-key/.test(keychain.drKeys), String(!!saved));
  ok('...it is never in the store, nor anywhere on the page (the box is a password box, empty, "saved (hidden)")',
    !JSON.stringify(stores).includes(SPEECHIFY_CODE) && !leak.html && !leak.text && !leak.fields && leak.type === 'password' && /saved \(hidden\)/.test(leak.ph), JSON.stringify(leak));
  // the voice picker, from the server
  const list = await until(async () => { const o = await p.evaluate(() => [...document.querySelectorAll('[data-sfy="voice"] option')].map((x) => [x.value, x.textContent])); return o.length >= 4 ? o : null; }, 8000);
  ok('Voice: the picker lists the server\'s voices, the British default first and marked ★ (and "Default (British)" on top)',
    !!list && list.map((o) => o[0]).join(' ') === ' gb-emma gb-oliver us-ava' && /^Emma \(British, woman\) ★ default$/.test(list[1][1]) && /British/.test(list[2][1]) && /American/.test(list[3][1]) && list[0][1] === 'Default (British)', JSON.stringify(list));
  await p.selectOption('[data-sfy="voice"]', 'gb-oliver');
  ok('...a voice chosen is saved (extras.speechifyVoice)', !!(await until(() => stores.local.drExtras.speechifyVoice === 'gb-oliver', 4000)), String(stores.local.drExtras.speechifyVoice));
  const shown = await until(() => p.evaluate(() => { const s = document.querySelector('[data-sfy="voice"]'); return s && s.value === 'gb-oliver' && s.options.length >= 4 ? s.value : null; }), 6000);
  ok('...and stays chosen when the settings are drawn again', shown === 'gb-oliver', String(shown));
  // Test
  const before = speechifyLog.length;
  await p.click('[data-sfy-act="test"]');
  const test = await until(() => p.evaluate(() => { const m = document.querySelector('[data-sfy-out="test"]'); return m && /works/.test(m.textContent) ? { text: m.textContent, ok: m.classList.contains('ok'), color: getComputedStyle(m).color } : null; }), 6000);
  const health = speechifyLog.slice(before).find((e) => e.path === '/health');
  ok('Test: shows the fake server\'s answer (it works, model simba-3.5, 20,000 characters a day), with the app code sent', !!test && test.ok && /The Speechify Worker works \(model simba-3\.5, at most 20,000 characters a day\)/.test(test.text) && !!health && health.code === SPEECHIFY_CODE, JSON.stringify({ test, health }));
  // the counter
  const today = 1234 + (new Date(new Date(monthStart()).getTime() + 60_000).toISOString() >= dayStart() ? 4000 : 0);
  const line = await until(async () => { const t = await p.evaluate(() => (document.querySelector('[data-sfy-out="usage"]') || {}).textContent || ''); return /your server/.test(t) ? t : null; }, 6000);
  ok('The counter: "Speechify today: N of 20,000 characters · this month: M" (this device) and the server\'s own count (both apps)',
    !!line && line.startsWith(`Speechify today: ${n(today)} of 20,000 characters · this month: ${n(5234)}`) && /your server \(both apps\): today 2,345, this month 9,876/.test(line), String(line));
  // the daily limit
  await p.fill('[data-sfy="limit"]', '15000');
  await p.click('[data-sfy-act="save-limit"]');
  ok('Daily limit: Save keeps it (extras.speechifyDailyChars)', !!(await until(() => stores.local.drExtras.speechifyDailyChars === 15000, 4000)), String(stores.local.drExtras.speechifyDailyChars));
  const line2 = await until(async () => { const t = await p.evaluate(() => (document.querySelector('[data-sfy-out="usage"]') || {}).textContent || ''); return / of 15,000 characters/.test(t) ? t : null; }, 6000);
  ok('...and the counter follows it', !!line2, String(line2));
  // the steps
  await p.click('[data-sfy-act="steps"]');
  const steps = await p.evaluate(() => { const o = document.querySelector('[data-sfy-out="steps"]'); o.scrollIntoView({ block: 'start' }); const r = o.getBoundingClientRect(); return { h: Math.round(r.height), display: getComputedStyle(o).display, n: o.querySelectorAll('li').length, text: o.innerText }; });
  ok('"How to set up Speechify" shows the steps of speech-proxy/SETUP.md in the app (the key goes into the server: SPEECHIFY_API_KEY, Variables and Secrets)',
    steps.display !== 'none' && steps.h > 100 && steps.n >= 10 && /SPEECHIFY_API_KEY/.test(steps.text) && /Variables and Secrets/.test(steps.text) && /wrangler deploy/.test(steps.text), JSON.stringify({ ...steps, text: steps.text.slice(0, 120) }));

  // the voice: Speechify says it; when the server fails, the device's own voice says it at once
  const HELLO = 'Hello! I am your English tutor. Let us read this book together.';
  let mark = speechifyLog.length;
  await p.evaluate(() => document.querySelector('[data-a="test-voice"]').click());
  const said = await until(() => speechifyLog.slice(mark).find((e) => e.path === '/speak' && e.text === HELLO), 6000);
  await sleep(2200);
  const d1 = await dbg();
  ok('"Hear the voice": the sentence is sent to the server with the chosen voice and the app code, and the device does not say it', !!said && said.voice === 'gb-oliver' && said.code === SPEECHIFY_CODE && d1.voice === 'speechify' && !d1.deviceSaid.includes(HELLO), JSON.stringify({ said, voice: d1.voice, device: d1.deviceSaid, err: d1.voiceError }));
  // (another voice: the clip of that sentence in the chosen voice is kept on the device, so it would not be asked again)
  await p.selectOption('[data-sfy="voice"]', 'us-ava');
  await until(() => stores.local.drExtras.speechifyVoice === 'us-ava', 4000);
  await until(() => p.evaluate(() => (document.querySelector('[data-sfy="voice"]') || {}).value === 'us-ava'), 6000);
  H.failSpeechify(50);
  mark = speechifyLog.length;
  await p.evaluate(() => document.querySelector('[data-a="test-voice"]').click());
  const fell = await until(async () => { const d = await dbg(); return d && d.deviceSaid.includes(HELLO) ? d : null; }, 8000);
  const toast = await p.evaluate(() => { const t = document.getElementById('toast'); return t.hidden ? '' : t.textContent; });
  ok('the server fails: the device\'s own voice says the sentence at once, and the learner is told why (once)', !!fell && speechifyLog.slice(mark).some((e) => e.path === '/speak' && e.failed) && /iPhone voice reads instead|Speechify voice:/.test(toast + (fell && fell.voiceError)), JSON.stringify({ device: fell && fell.deviceSaid, toast, err: fell && fell.voiceError, log: speechifyLog.slice(mark).map((e) => [e.path, e.voice, e.failed, String(e.text).slice(0, 20)]), now: fell ? null : await dbg() }));
  H.failSpeechify(0);
  await p.evaluate(() => document.getElementById('veil').click());

  // Listening: one paragraph at a time (nothing is asked across a paragraph's end before it is needed)
  // (no stops: only the reading itself)
  await p.evaluate(async () => { const o = await chrome.storage.local.get('drExtras'); await chrome.storage.local.set({ drExtras: { ...o.drExtras, stopItemsOn: false, stopPhrasesOn: false, stopHardOn: false } }); });
  const A2 = 'The second line is the last one here.';
  const B1 = 'The next part starts with this line.';
  await p.evaluate(([t]) => window.__iknowBook.openText('Two parts', t), [`The first line is a quiet one. ${A2}\n\n${B1} It ends with this one.\n\nThe end is here now.`]);
  await until(async () => { const d = await dbg(); return d && d.open && d.sentences >= 5 ? d : null; }, 15000);
  mark = speechifyLog.length;
  await p.evaluate(() => window.__iknowBook.play(true));
  const atA2 = await until(async () => { const d = await dbg(); return d && d.playing && d.index === 1 ? d : null; }, 15000);
  const early = speechifyLog.slice(mark).filter((e) => e.path === '/speak').map((e) => e.text);
  await sleep(600);
  const stillA2 = await dbg();
  const during = speechifyLog.slice(mark).filter((e) => e.path === '/speak').map((e) => e.text);
  const later = await until(() => speechifyLog.slice(mark).some((e) => e.path === '/speak' && e.text === B1), 15000);
  ok('Listening with Speechify: the next sentence of the same paragraph is made ahead, but nothing of the next paragraph while its last sentence is said',
    !!atA2 && early.includes(A2) && stillA2.index === 1 && !during.includes(B1) && !!later, JSON.stringify({ early, during, index: stillA2 && stillA2.index }));
  await p.evaluate(() => window.__iknowBook.play(false));
  await ctx.close();
}

async function knowPart(browser) {
  resetStores({
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 }, drVocab: { words: {}, marked: {} }, drUsage: usage(),
    drExtras: { phoneSet: true, view: 'listening', levelAsk: false, levelMode: true, tutorOn: true, fakeVoice: true, voiceMode: false, oneButton: false, teacherVolume: 60, wordVolume: 80, myLevel: 50, migrated: 9, stageOn: false, talkAfterExplain: false, voice: 'speechify', speechifyUrl: SERVER },
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 20 } },
  });
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key', speechify: SPEECHIFY_CODE });
  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGE ERROR (yt)', String(e.message || e).slice(0, 300)));
  await p.goto('https://m.youtube.com/watch?v=ios00000001');
  await p.addScriptTag({ content: source(ytScripts) });
  const d = await until(async () => { const x = await p.evaluate(() => { try { return JSON.parse(JSON.stringify((window.__drDebug && window.__drDebug()) || null)); } catch (e) { return null; } }); return x && x.sentences === 10 ? x : null; }, 30000);
  const diag = await until(async () => { const g = await p.evaluate(() => window.__ytcDream.diag()); return g && g.voice === 'speechify' ? g : null; }, 8000) || await p.evaluate(() => window.__ytcDream.diag());
  ok('I Know: with the server address and the app code saved, the tutor speaks with the Speechify voice', !!d && diag.voice === 'speechify', JSON.stringify({ voice: diag.voice }));
  await p.evaluate(() => window.__ytcDream.action('quick'));
  const host = await until(() => p.evaluate(() => ['dr-stage-host', 'dr-panel-host'].find((h) => { const r = document.getElementById(h); const q = r && r.shadowRoot && r.shadowRoot.querySelector('.quick'); return q && !q.hidden && q.getClientRects().length; }) || null), 5000);
  await p.evaluate((h) => { window.__sfyRoot = () => document.getElementById(h).shadowRoot; }, host);
  const seg = await p.evaluate(() => [...window.__sfyRoot().querySelectorAll('.quick .seg[data-name="voice"] button')].map((b) => [b.dataset.v, b.textContent, b.classList.contains('on')]));
  ok('I Know quick settings: the voice choice has "Speechify (natural)" (chosen) next to every old voice', seg.map((s) => s[0]).join(' ') === 'auto azure openai elevenlabs speechify mac' && seg.find((s) => s[0] === 'speechify')[1] === 'Speechify (natural)' && seg.find((s) => s[0] === 'speechify')[2], JSON.stringify(seg));
  // (the "Analyzing this video, once" cover goes away first)
  let rows = [];
  await until(async () => { rows = []; for (const sel of ROWS) rows.push(await p.evaluate(onScreen, `.quick ${sel}`)); return rows.every((r) => r.onTop); }, 20000, 400);
  ok('...the same Speechify rows are on the screen there', rows.every((r) => r.there && r.display !== 'none' && r.h > 0 && r.inside && r.onTop), JSON.stringify(rows));
  const list = await until(async () => { const o = await p.evaluate(() => [...window.__sfyRoot().querySelectorAll('.quick [data-sfy="voice"] option')].map((x) => x.value)); return o.length >= 4 ? o : null; }, 8000);
  ok('...its voice picker lists the server\'s voices, the British default first', !!list && list.join(' ') === ' gb-emma gb-oliver us-ava', JSON.stringify(list));
  await p.evaluate(() => window.__sfyRoot().querySelector('.quick [data-sfy-act="test"]').click());
  const test = await until(() => p.evaluate(() => { const m = window.__sfyRoot().querySelector('.quick [data-sfy-out="test"]'); return m && /works/.test(m.textContent) ? m.textContent : null; }), 6000);
  ok('...Test shows the server\'s answer', !!test && /The Speechify Worker works/.test(test), String(test));
  const NEW = 'second-code-for-the-test-42';
  await p.evaluate((c) => { const i = window.__sfyRoot().querySelector('.quick [data-sfy="code"]'); i.value = c; window.__sfyRoot().querySelector('.quick [data-sfy-act="save-code"]').click(); }, NEW);
  const saved = await until(() => { try { return JSON.parse(keychain.drKeys).speechify === NEW; } catch (e) { return false; } }, 4000);
  await sleep(400);
  const leak = await p.evaluate(([a, b]) => { const html = window.__sfyRoot().innerHTML + document.documentElement.outerHTML; return html.includes(a) || html.includes(b); }, [NEW, SPEECHIFY_CODE]);
  ok('...a new app code goes to the Keychain, never into the store or the page', !!saved && !leak && !JSON.stringify(stores).includes(NEW), JSON.stringify({ saved: !!saved, leak }));
  await ctx.close();
}

(async () => {
  const pages = http.createServer((q, r) => { const f = path.join(IOS, 'Web/dream', path.basename(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f)); }).listen(PAGES_PORT);
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());
  await bookPart(browser);
  await knowPart(browser);
  await browser.close();
  pages.close();
  console.log(H.fails() ? `SPEECHIFY SETTINGS: ${H.fails()} FAILED` : 'SPEECHIFY SETTINGS: ALL PASSED');
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
