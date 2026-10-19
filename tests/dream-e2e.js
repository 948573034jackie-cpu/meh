// End-to-end test of the Dream Tutor: the REAL unpacked Chrome extension, a fake youtube.com (routed), and a fake
// Anthropic API on localhost (the extension's background worker calls it through the official SDK).
// Checks the Dream Read listening rule on a video, the voice / key commands, "explain the last part", the Chinese
// hints job, My Vocabulary, the settings page and that the tutor and the website call never run together.
const pw = require(process.env.PWMOD || 'playwright');
const path = require('path');
const http = require('http');
const EXT = path.resolve(__dirname, '../youtube-to-claude');
let fails = 0;
const trace = [];
const ok = (n, c, x) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  ' + String(x).slice(0, 400) : '')); if (!c) console.log('   trace: ' + trace.slice(-12).join(' | ')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 15000, step = 150) { const end = Date.now() + ms; for (;;) { const v = await cond(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const LINES = [
  'Hello everyone and welcome back to the channel.',          // 0-4
  'Today my friend was very meticulous about her work.',      // 4-8   meticulous (C2)
  'She checked every small detail twice.',                    // 8-12
  'It was an ephemeral moment of joy.',                       // 12-16 ephemeral (C2)
  'This is complete sentence number five of the lesson.',     // 16-20
  'This is complete sentence number six of the lesson.',      // 20-24
  'My uncle is a gregarious man who loves big parties.',      // 24-28
  'This is complete sentence number eight of the lesson.',    // 28-32
  'This is complete sentence number nine of the lesson.',     // 32-36
  'We will talk about it again very soon.',                   // 36-40
];
const SEC = 4;
const json3 = JSON.stringify({ events: LINES.map((t, i) => ({ tStartMs: i * SEC * 1000, dDurationMs: SEC * 1000, segs: [{ utf8: t }] })) });
const DUR = 60;
const pr = JSON.stringify({ videoDetails: { videoId: 'drm00000001', title: 'Dream Lesson', lengthSeconds: String(DUR) }, playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=drm00000001&lang=en', languageCode: 'en' }] } } });
const wav = (() => { const n = 8000 * DUR, b = Buffer.alloc(44 + n, 128); for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(50 * Math.sin(2 * Math.PI * 330 * i / 8000)); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; })();
const ytHtml = `<!doctype html><title>Dream Lesson - YouTube</title><body style="background:#fff;margin:0">
<ytd-watch-flexy><div id="columns" style="display:flex;gap:16px;padding:8px">
  <div id="primary" style="flex:1"><div id="movie_player" class="html5-video-player" style="position:relative;width:800px;height:450px;background:#123">
    <video muted playsinline src="https://www.youtube.com/v.wav" class="html5-main-video" style="width:100%;height:100%"></video>
    <div class="ytp-caption-window-container" style="position:absolute;bottom:40px;left:0;right:0;color:#fff">youtube captions</div></div>
    <div id="below"><h1 class="ytd-watch-metadata">Dream Lesson</h1></div></div>
  <div id="secondary" style="width:420px"><div id="secondary-inner">related videos</div></div>
</div></ytd-watch-flexy><script>var ytInitialPlayerResponse = ${pr};</script>`;
const claudeHtml = `<!doctype html><title>Claude</title><div id="box" class="ProseMirror" contenteditable="true" style="min-height:40px;border:1px solid #999"></div><input type="file" id="files" multiple><div id="slot"></div>
<script>window.__sent=[];const b=document.getElementById('box'),slot=document.getElementById('slot');b.addEventListener('input',()=>{ if(b.textContent.trim()&&!slot.firstChild){const x=document.createElement('button');x.setAttribute('aria-label','Send message');x.textContent='Send';x.onclick=()=>{__sent.push(b.textContent);b.textContent='';slot.innerHTML='';};slot.appendChild(x);} });</script>`;

// ---- a fake Anthropic Messages API (server-sent events, like the real one) ----
const apiLog = [];
const sse = (res, text) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  const parts = text.match(/.{1,24}/gs) || [''];
  let i = 0;
  const tick = () => {
    if (i < parts.length) { ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: parts[i++] } }); setTimeout(tick, 15); return; }
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } });
    ev('message_stop', {});
    res.end();
  };
  tick();
};
const api = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-max-age': '600' }); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch (e) { /* not json */ }
    const sys = JSON.stringify(j.system || '');
    const user = JSON.stringify(j.messages || '');
    const kind = /Word Wise/.test(sys) ? 'hints' : /multi-word expressions/.test(sys) ? 'phrases' : 'explain';
    apiLog.push({ path: req.url, kind, model: j.model, user, sys, key: req.headers['x-api-key'], stream: j.stream, cache: JSON.stringify(j.system || '').includes('ephemeral'), effort: j.output_config && j.output_config.effort, fallbacks: j.fallbacks });
    if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' }); res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } })); return; }
    if (kind === 'hints') return sse(res, JSON.stringify({ meticulous: ['一丝不苟的', '细致的'], ephemeral: ['短暂的', '转瞬即逝的'], gregarious: ['爱交际的', '合群的'] }));
    if (kind === 'phrases') return sse(res, '{"phrases":[]}');
    // answer about the sentence being read now (the context around it holds the other hard words too)
    const cur = (/The sentence being read now:\\n(.*?)(?:\\n|")/.exec(user) || [])[1] || '';
    return sse(res, /meticulous/.test(cur) ? 'Meticulous means very careful about every small detail. Your friend checks her work again and again so that nothing is wrong.' : /gregarious/.test(cur) ? 'Gregarious means a person who loves being with other people.' : 'In this part the speaker says hello, and talks about a friend who is very careful with her work.');
  });
}).listen(8790);

(async () => {
  const ctx = await pw.chromium.launchPersistentContext(require('os').tmpdir() + '/dr-profile-' + Date.now(), {
    executablePath: process.env.CHROME || undefined, headless: true,
    args: ['--headless=new', '--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  await ctx.route('https://www.youtube.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/v.wav')) { const rg = route.request().headers()['range']; if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], e = m[2] ? +m[2] : wav.length - 1; return route.fulfill({ status: 206, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${e}/${wav.length}` }, body: wav.slice(a, e + 1) }); } return route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' }, body: wav }); }
    if (u.includes('/api/timedtext')) return route.fulfill({ status: 200, contentType: 'application/json', body: json3 });
    return route.fulfill({ status: 200, contentType: 'text/html', body: ytHtml });
  });
  await ctx.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: claudeHtml }));
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  console.log('extension loaded, version', await sw.evaluate(() => chrome.runtime.getManifest().version));
  const store = (k) => sw.evaluate((key) => chrome.storage.local.get(key).then((o) => o[key]), k);
  await sw.evaluate(() => chrome.storage.local.set({
    drKeys: { anthropic: 'sk-ant-test-key' },
    drExtras: { tutorOn: true, fakeVoice: true, explainOnStop: true, stopInCall: false, panel: true, band: 'auto', hideYtCaptions: true },
    drTestBaseUrls: { anthropic: 'http://localhost:8790' },
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 1500, pauseAfterExplainMs: 1500, wordRepeats: 3, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 30 } },
    voiceOn: false,
  }));

  const yt = await ctx.newPage();
  yt.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  yt.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 200)); });
  await yt.goto('https://www.youtube.com/watch?v=drm00000001');
  const dbg = () => yt.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const panel = (fn) => yt.evaluate(fn);
  const vstate = () => yt.evaluate(() => { const v = document.querySelector('video'); return { t: +v.currentTime.toFixed(2), paused: v.paused }; });
  let tracing = true;
  (async () => { while (tracing) { try { const x = await yt.evaluate(() => { const v = document.querySelector('video'); let d = null; try { d = JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { /* none */ } return `${v.currentTime.toFixed(2)}${v.paused ? 'P' : '>'} ${d ? d.state : '-'}${d && d.window ? ':' + d.window.phase + '/' + d.window.target : ''}${d && d.cur ? ' s' + d.cur.paragraph + '.' + d.cur.sentence : ''}`; }); if (trace[trace.length - 1] !== x) trace.push(x); } catch (e) { /* page busy */ } await sleep(250); } })();

  // ---- 1. the panel: the whole video as lines, hard words highlighted with their Chinese meaning ----
  const ready = await until(async () => { const d = await dbg(); return d && d.sentences > 0 ? d : null; }, 20000);
  ok('Dream panel loads the subtitles as a book (10 sentences)', ready && ready.sentences === 10, JSON.stringify(ready && { s: ready.sentences, mode: ready.mode }));
  const tutorBtn = await yt.evaluate(() => { const b = document.getElementById('yt2c-b-tutor'); return b ? { text: b.textContent, bg: getComputedStyle(b).backgroundColor } : null; });
  ok('the bar has the My tutor button, green (on)', tutorBtn && /on/.test(tutorBtn.text) && tutorBtn.bg === 'rgb(30, 142, 62)', JSON.stringify(tutorBtn));
  const look = await panel(() => {
    const host = document.getElementById('dr-panel-host'); const r = host && host.shadowRoot;
    if (!r) return null;
    const w = r.querySelector('.w[data-lemma="meticulous"]');
    return { inSecondary: host.parentElement.id, relatedHidden: getComputedStyle(document.getElementById('secondary-inner')).display === 'none', lines: r.querySelectorAll('.s').length, hard: w && w.classList.contains('hl-unknown'), hint: w && w.dataset.hint, easyHighlighted: !!r.querySelector('.w[data-lemma="channel"].hl-unknown'), hintsOn: host.dataset.hints };
  });
  ok('panel takes the place of the related videos', look && look.inSecondary === 'secondary' && look.relatedHidden && look.lines === 10, JSON.stringify(look));
  ok('a word above B2 is highlighted, an easy one is not', look && look.hard && !look.easyHighlighted, JSON.stringify(look));
  // the AI job: Chinese meanings in this video's context (cheap model, once per video)
  const hintsReq = await until(() => apiLog.find((r) => r.kind === 'hints'), 10000);
  ok('Chinese-hints job asked the cheap model (Haiku) once, with the key', hintsReq && hintsReq.model === 'claude-haiku-5-5' && hintsReq.key === 'sk-ant-test-key', JSON.stringify(hintsReq && { m: hintsReq.model, k: hintsReq.key }));
  const aiHint = await until(() => panel(() => { const r = document.getElementById('dr-panel-host').shadowRoot; const w = r.querySelector('.w[data-lemma="gregarious"]'); return w && w.dataset.hint; }), 8000);
  ok('the AI\'s Chinese meaning is written under the hard word', aiHint === '爱交际的', aiHint);

  // ---- 2. the listening rule at "meticulous" ----
  await yt.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 0; return v.play(); });
  const win = await until(async () => { const d = await dbg(); return d && d.window && d.window.target === 'meticulous' ? d : null; }, 20000);
  const v1 = await vstate();
  ok('the video stopped right after "meticulous" (not at the sentence end)', win && v1.paused && v1.t > 5.8 && v1.t < 7.6, JSON.stringify(v1));
  ok('the word was said 3 times before the window, with the dictionary card open', win && win.spoken && win.spoken.slice(0, 3).every((s) => s === 'meticulous') && win.card && win.card.lemma === 'meticulous', JSON.stringify(win && { spoken: win.spoken, card: win.card }));
  const cardLook = await panel(() => { const r = document.getElementById('dr-panel-host').shadowRoot; const c = r.querySelector('.card'); const cmd = r.querySelector('.cmd'); return { card: c && !c.hidden ? c.innerText : null, cmd: cmd && !cmd.hidden ? cmd.innerText : null }; });
  ok('card shows the word, its level and the Chinese meaning; the commands window asks', cardLook.card && /meticulous/.test(cardLook.card) && /C2/.test(cardLook.card) && /一丝不苟/.test(cardLook.card) && cardLook.cmd && /I know/.test(cardLook.cmd) && /I don.t know/.test(cardLook.cmd) && /Go on/.test(cardLook.cmd), JSON.stringify(cardLook));
  ok('nothing was sent to the AI during the window', !apiLog.some((r) => r.kind === 'explain'));
  const exp = await until(() => apiLog.find((r) => r.kind === 'explain' && r.user.includes('meticulous')), 10000);
  ok('after the window: the explanation request (word, its sentence, the video title, effort low, cached system prompt, refusal fallback)', exp && /"kind":"word"|meticulous/.test(exp.user) && /Today my friend was very meticulous about her work/.test(exp.user) && /Dream Lesson/.test(exp.user) && exp.effort === 'low' && exp.cache && exp.fallbacks === 'default' && exp.model === 'claude-opus-5-5', JSON.stringify(exp && { model: exp.model, effort: exp.effort, cache: exp.cache, fallbacks: exp.fallbacks, path: exp.path }));
  const spokeExp = await until(async () => { const d = await dbg(); return d && d.spoken && d.spoken.some((s) => /very careful/.test(s)) ? d : null; }, 10000);
  ok('the tutor spoke the explanation', !!spokeExp, JSON.stringify(spokeExp && spokeExp.spoken));
  const after = await until(async () => { const d = await dbg(); return d && d.window && d.window.phase === 'after' ? d : null; }, 10000);
  ok('a second window after the explanation', !!after);
  const back = await until(async () => { const v = await vstate(); return !v.paused && v.t < 5.5 ? v : null; }, 8000, 60);
  ok('then the video went back to the START of the interrupted sentence (about 4 s) and played', !!back, JSON.stringify(back));
  const entries = await until(async () => { const e = await store('drEntries'); return e && e.meticulous ? e : null; }, 8000);
  ok('"meticulous" is in My Vocabulary with its sentence, explanation and the time in the video', entries && /very careful/.test(entries.meticulous.explanation) && entries.meticulous.sentence === LINES[1] && entries.meticulous.chapter === '0:04' && entries.meticulous.bookTitle === 'Dream Lesson', JSON.stringify(entries && entries.meticulous));
  const vocab1 = await store('drVocab');
  ok('it is marked "learning" (yellow)', vocab1 && vocab1.words.meticulous === 'learning', JSON.stringify(vocab1));

  // ---- 3. "I know" by voice at "ephemeral" ----
  const win2 = await until(async () => { const d = await dbg(); return d && d.window && d.window.target === 'ephemeral' ? d : null; }, 20000);
  ok('stops again at the next hard word ("ephemeral")', !!win2);
  const before = apiLog.filter((r) => r.kind === 'explain').length;
  await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' }); await chrome.tabs.sendMessage(tab.id, { type: 'heard', text: 'I know', final: true, key: 'v1:0' }); });
  const goOn = await until(async () => { const v = await vstate(); return !v.paused && v.t >= 11.8 && v.t < 14 ? v : null; }, 6000, 60);
  await sleep(800);
  const vocab2 = await store('drVocab');
  ok('"I know" (said aloud): no explanation, marked known, reading goes on from the sentence start', goOn && apiLog.filter((r) => r.kind === 'explain').length === before && vocab2.words.ephemeral === 'known', JSON.stringify({ goOn, known: vocab2.words.ephemeral }));
  const hl = await panel(() => !!document.getElementById('dr-panel-host').shadowRoot.querySelector('.w[data-lemma="ephemeral"].hl-unknown'));
  ok('…and its highlight is gone', !hl);

  // ---- 4. K / D keys and Go on (Esc) at "gregarious" ----
  const win3 = await until(async () => { const d = await dbg(); return d && d.window && d.window.target === 'gregarious' && d.window.phase === 'before' ? d : null; }, 25000);
  ok('stops at "gregarious"', !!win3);
  await yt.keyboard.press('KeyD');
  const exp3 = await until(() => apiLog.find((r) => r.kind === 'explain' && /The sentence being read now:\\nMy uncle/.test(r.user)), 6000);
  ok('D ("I don\'t know") starts the fuller explanation at once', exp3 && /still do not understand/.test(exp3.user), exp3 && exp3.user.slice(-300));
  const after3 = await until(async () => { const d = await dbg(); return d && d.window && d.window.phase === 'after' && d.window.target === 'gregarious' ? d : null; }, 10000);
  // "I don't know" in the window after the explanation: explained again, deeper, then the window comes back
  const nG = apiLog.filter((r) => r.kind === 'explain' && /The sentence being read now:\\nMy uncle/.test(r.user)).length;
  await yt.keyboard.press('KeyD');
  const deeper = await until(() => { const g = apiLog.filter((r) => r.kind === 'explain' && /The sentence being read now:\\nMy uncle/.test(r.user)); return g.length > nG ? g[g.length - 1] : null; }, 8000);
  ok('D in the window after the explanation: explained again, deeper', deeper && /still do not understand/.test(deeper.user));
  await sleep(300);
  const after3b = await until(async () => { const d = await dbg(); return d && d.window && d.window.phase === 'after' && d.window.target === 'gregarious' ? d : null; }, 10000);
  ok('…and then another window opens', !!after3b);
  await yt.keyboard.press('Escape');
  const goOn3 = await until(async () => { const v = await vstate(); return !v.paused && v.t >= 23.8 && v.t < 26 ? v : null; }, 6000, 60);
  ok('Esc ("go on") in the second window: back to the sentence start, playing', after3 && goOn3, JSON.stringify(goOn3));

  // ---- 5. you stop the video yourself: "explain the last part" ----
  await until(async () => (await vstate()).t > 30.5, 12000);
  const nBefore = apiLog.length;
  await yt.evaluate(() => document.querySelector('video').pause());
  const passage = await until(() => apiLog.slice(nBefore).find((r) => r.kind === 'explain'), 8000);
  ok('pausing the video yourself explains the last part (a passage of whole sentences)', passage && /sentence number eight/.test(passage.user) && /Explain this passage/.test(passage.user), passage && passage.user.slice(0, 200));
  const resumed = await until(async () => { const v = await vstate(); return !v.paused ? v : null; }, 12000);
  ok('after that explanation the video plays on by itself, from the start of the sentence', resumed && resumed.t >= 27.8 && resumed.t < 32.5, JSON.stringify(resumed));

  // ---- 6. typed question ----
  await yt.evaluate(() => document.querySelector('video').pause());
  await until(async () => { const d = await dbg(); return d && d.state !== 'playing' && !d.window; }, 8000);
  await sleep(1500);
  const nQ = apiLog.length;
  await panel(() => { const r = document.getElementById('dr-panel-host').shadowRoot; r.querySelector('form.ask input').value = 'What is a gregarious man?'; r.querySelector('form.ask button').click(); });
  const q = await until(() => apiLog.slice(nQ).find((r) => r.user.includes('What is a gregarious man?')), 8000);
  ok('a typed question goes to the tutor with the video context', !!q, q && q.user.slice(0, 160));

  // ---- 6b. single tap = explain the word here; double tap = known ----
  const nT = apiLog.length;
  await yt.locator('#dr-panel-host .w[data-lemma="meticulous"]').first().click();
  const tapReq = await until(() => apiLog.slice(nT).find((r) => r.kind === 'explain' && /The sentence being read now:\\nToday my friend/.test(r.user)), 8000);
  const tapCard = await panel(() => { const c = document.getElementById('dr-panel-host').shadowRoot.querySelector('.card'); return c && !c.hidden ? c.innerText.split('\n')[0] : null; });
  ok('single tap on a word: its card opens and it is explained in its sentence', tapReq && tapCard === 'meticulous', tapCard);
  await until(async () => { const d = await dbg(); return d && d.transcript && d.transcript.length && d.transcript[d.transcript.length - 1].status === 'done' ? d : null; }, 10000);
  await sleep(500);
  const nD = apiLog.length;
  await yt.locator('#dr-panel-host .w[data-lemma="gregarious"]').first().dblclick();
  const dbl = await until(async () => { const vv = await store('drVocab'); return vv && vv.words.gregarious === 'known' ? vv : null; }, 5000);
  await sleep(600);
  const dblHl = await panel(() => !!document.getElementById('dr-panel-host').shadowRoot.querySelector('.w[data-lemma="gregarious"].hl-unknown, .w[data-lemma="gregarious"].hl-learning'));
  ok('double tap on a word: known, no explanation, highlight gone', dbl && !dblHl && !apiLog.slice(nD).some((r) => r.kind === 'explain'), JSON.stringify({ known: dbl && dbl.words.gregarious, hl: dblHl, sent: apiLog.length - nD }));

  // ---- 7. one voice at a time: turning Claude (the website call) on turns the tutor off ----
  await yt.evaluate(() => document.getElementById('yt2c-b-claude').click());
  const off = await until(async () => { const b = await yt.evaluate(() => document.getElementById('yt2c-b-tutor').textContent); const d = await dbg(); return /off/.test(b) && d && d.mode === 'call' ? { b, mode: d.mode } : null; }, 8000);
  ok('Claude on → My tutor off, the panel stays in call mode (highlights, no stops)', !!off, JSON.stringify(off));
  await yt.evaluate(() => document.getElementById('yt2c-b-tutor').click());
  const tutorAgain = await until(async () => { const s = await yt.evaluate(() => ({ t: document.getElementById('yt2c-b-tutor').textContent, c: document.getElementById('yt2c-b-claude').textContent })); return /on/.test(s.t) && /off/.test(s.c) ? s : null; }, 8000);
  ok('My tutor on → Claude off', !!tutorAgain, JSON.stringify(tutorAgain));

  // ---- 8. the settings page and My Vocabulary ----
  const opt = await ctx.newPage();
  opt.on('pageerror', (e) => console.log('OPTIONS PAGE ERROR', e.message));
  await opt.goto(`chrome-extension://${extId}/dream/options.html`);
  await opt.waitForTimeout(800);
  const o1 = await opt.evaluate(() => ({ level: document.getElementById('learnerLevel').value, model: document.getElementById('anthropicModel').value, styles: document.querySelectorAll('#style-list button').length, keyPh: document.getElementById('key-anthropic').placeholder, rules: document.getElementById('contextRules').value.length }));
  ok('settings page: level, model, the 10 Dream Read styles, saved key, rules', o1.level === 'B2' && o1.model === 'claude-opus-5-5' && o1.styles >= 10 && /saved/.test(o1.keyPh) && o1.rules > 100, JSON.stringify(o1));
  await opt.selectOption('#learnerLevel', 'C1');
  await opt.waitForTimeout(400);
  ok('changing the level is saved', ((await store('drSettings')) || {}).learnerLevel === 'C1');
  await opt.click('#style-list button:nth-child(2)');
  await opt.click('#st-use');
  await opt.waitForTimeout(400);
  const st = (await store('drSettings')).ai.activeStyle;
  ok('picking another explanation style is saved', st && st !== 'custom', st);
  await opt.click('[data-test="anthropic"]');
  const tested = await until(() => opt.evaluate(() => document.getElementById('msg-anthropic').textContent).then((t) => (/Connected|rejected|error/i.test(t) ? t : null)), 8000);
  ok('Test key button talks to the API through the background', /Connected/.test(tested || ''), tested);
  const voc = await ctx.newPage();
  await voc.goto(`chrome-extension://${extId}/dream/vocab.html`);
  await voc.waitForTimeout(800);
  const vrows = await voc.evaluate(() => [...document.querySelectorAll('#rows tr')].map((r) => r.dataset.lemma));
  ok('My Vocabulary lists the explained words', vrows.includes('meticulous') && vrows.includes('gregarious'), JSON.stringify(vrows));
  const [download] = await Promise.all([voc.waitForEvent('download', { timeout: 5000 }).catch(() => null), voc.click('#csv')]);
  let csv = '';
  if (download) { const p = await download.path(); csv = require('fs').readFileSync(p, 'utf8'); }
  ok('CSV download has the words, Chinese and a link to the moment in the video', /meticulous/.test(csv) && /watch\?v=drm00000001&t=4s/.test(csv), csv.slice(0, 300));
  await voc.click('[data-tab="progress"]');
  await voc.waitForTimeout(1500);
  const lv = await voc.evaluate(() => document.querySelectorAll('#levels .level').length);
  ok('Progress shows the six levels', lv === 6, lv);

  tracing = false;
  await ctx.close();
  api.close();
  console.log(fails ? fails + ' FAILED' : 'DREAM TUTOR: ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
