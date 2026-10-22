// End-to-end test of the Dream Tutor: the REAL unpacked Chrome extension, a fake youtube.com (routed), a fake
// Anthropic + OpenAI API on localhost (the extension's background worker calls it through the official SDKs), and a
// fake OpenAI realtime server: a second page that answers the WebRTC call (real WebRTC, real data channel).
// Checks the learner's stop rules (word 3 times, 5-second window with I know / I don't know only, the explanation
// starts at once, the word again, the sentence from the video, a moment to ask, then on), hard sentences, "bye bye",
// the pause flow (the part played again on the full-screen page, explained, back to its start), ← (play, explain,
// play), listening mode, sizes, live Chinese, quick settings, the OpenAI voice, the live voice call, the check report,
// My Vocabulary and the settings page.
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
  'She checked every small detail twice.',                    // 8-12  (the AI adds a comma)
  'It was an ephemeral moment of joy.',                       // 12-16 ephemeral (C2)
  'This is complete sentence number five of the lesson.',     // 16-20
  'This is complete sentence number six of the lesson.',      // 20-24 a hard sentence (the AI says so)
  'My uncle is a gregarious man who loves big parties.',      // 24-28 gregarious (C2)
  'This is complete sentence number eight of the lesson.',    // 28-32
  'This is complete sentence number nine of the lesson.',     // 32-36
  'We will talk about it again very soon.',                   // 36-40
];
const SEC = 4;
const json3 = JSON.stringify({ events: LINES.map((t, i) => ({ tStartMs: i * SEC * 1000, dDurationMs: SEC * 1000, segs: [{ utf8: t }] })) });
const DUR = 60;
const pr = JSON.stringify({ videoDetails: { videoId: 'drm00000001', title: 'Dream Lesson', lengthSeconds: String(DUR) }, playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=drm00000001&lang=en', languageCode: 'en' }] } } });
const makeWav = (sec, tone) => { const n = Math.round(8000 * sec), b = Buffer.alloc(44 + n, 128); if (tone) for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(50 * Math.sin(2 * Math.PI * 330 * i / 8000)); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; };
const wav = makeWav(DUR, true);
const ttsWav = makeWav(0.25, false);
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
// the fake OpenAI realtime server: answers the WebRTC offer, keeps the data channel, plays a tone as the voice
const peerHtml = `<!doctype html><title>peer</title><script>
window.got = []; window.dcs = [];
window.answer = async (offer) => {
  const pc = new RTCPeerConnection();
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); const dst = ctx.createMediaStreamDestination(); osc.connect(dst); osc.start();
  pc.addTrack(dst.stream.getAudioTracks()[0], dst.stream);
  pc.ondatachannel = (e) => { const dc = e.channel; window.dc = dc; window.dcs.push(dc); dc.onmessage = (m) => { try { window.got.push(JSON.parse(m.data)); } catch (x) {} }; };
  await pc.setRemoteDescription({ type: 'offer', sdp: offer });
  const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
  await new Promise((r) => { if (pc.iceGatheringState === 'complete') return r(); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') r(); }; setTimeout(r, 2500); });
  window.pc = pc;
  return pc.localDescription.sdp;
};
window.send = (ev) => { if (window.dc && window.dc.readyState === 'open') { window.dc.send(JSON.stringify(ev)); return true; } return false; };
</script>`;

// ---- a fake Anthropic + OpenAI API (server-sent events, like the real ones) ----
const apiLog = [];
const liveLog = [];
let peer = null;
const cors = (req) => ({ 'access-control-allow-origin': '*', 'access-control-allow-headers': req.headers['access-control-request-headers'] || '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-expose-headers': '*' });
const sse = (req, res, text) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...cors(req) });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  const parts = text.match(/[\s\S]{1,24}/g) || [''];
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
let failNextTts = 0;
const kindOf = (sys, url) => (url.includes('/cognitiveservices/v1') ? 'azure' : url.includes('/audio/speech') ? 'tts' : url.includes('/realtime/calls') ? 'live' : /Word Wise/.test(sys) ? 'hints' : /multi-word expressions/.test(sys) ? 'phrases' : /well-punctuated sentences/.test(sys) ? 'split' : /judge which spoken sentences/.test(sys) ? 'hard' : /translate the English subtitles/.test(sys) ? 'zhlines' : /Simplified Chinese meaning of an English word/.test(sys) ? 'zhword' : 'explain');
const api = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors(req), 'access-control-max-age': '600' }); res.end(); return; }
  if (req.url === '/peer.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(peerHtml); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let j = {};
    try { j = JSON.parse(body); } catch (e) { /* not json */ }
    const sys = JSON.stringify(j.system || '');
    const user = JSON.stringify(j.messages || '');
    const kind = kindOf(sys, req.url);
    apiLog.push({ path: req.url, kind, model: j.model, user, sys, body: kind === 'azure' ? body : '', key: req.headers['x-api-key'] || req.headers.authorization || req.headers['ocp-apim-subscription-key'], stream: j.stream, cache: sys.includes('ephemeral'), effort: j.output_config && j.output_config.effort, fallbacks: j.fallbacks, voice: j.voice, input: j.input, at: Date.now() });
    if (kind === 'tts' && failNextTts > 0) { failNextTts--; apiLog[apiLog.length - 1].failed = true; res.writeHead(400, { 'content-type': 'application/json', ...cors(req) }); res.end('{"error":{"message":"test hiccup","type":"invalid_request_error"}}'); return; }
    if (kind === 'tts' || kind === 'azure') { res.writeHead(200, { 'content-type': 'audio/mpeg', ...cors(req) }); res.end(ttsWav); return; }
    if (kind === 'live') {
      const sdp = (/name="sdp"\r\n\r\n([\s\S]*?)\r\n--/.exec(body) || [])[1];
      const session = (/name="session"\r\n\r\n([\s\S]*?)\r\n--/.exec(body) || [])[1];
      let s = null; try { s = JSON.parse(session); } catch (e) { /* bad */ }
      liveLog.push({ session: s, auth: req.headers.authorization });
      try { const answer = await peer.evaluate((o) => window.answer(o), sdp); res.writeHead(201, { 'content-type': 'application/sdp', ...cors(req) }); res.end(answer); } catch (e) { res.writeHead(500, cors(req)); res.end(String(e)); }
      return;
    }
    if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json', ...cors(req) }); res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } })); return; }
    if (kind === 'hints') return sse(req, res, JSON.stringify({ meticulous: ['一丝不苟的', '细致的'], ephemeral: ['短暂的', '转瞬即逝的'], gregarious: ['爱交际的', '合群的'] }));
    if (kind === 'phrases') return sse(req, res, '{"phrases":[]}');
    if (kind === 'split') {
      // the complete sentences, one line each; the third gets a comma (so the AI's text shows)
      const words = [...user.matchAll(/(\d+):(\S+?)(?= \d+:|\\n|"|$)/g)].map((m) => [Number(m[1]), m[2]]);
      const out = []; let cur = [];
      for (const [n, w] of words) { cur.push(w); if (/[.?!]$/.test(w)) { let t = cur.join(' '); if (/twice\.$/.test(t)) t = t.replace(' twice.', ', twice.'); out.push(`${n}|${t}`); cur = []; } }
      return sse(req, res, out.join('\n'));
    }
    if (kind === 'hard') { const m = [...user.matchAll(/(\d+)\. ([^\\]*)/g)].find((x) => /number six/.test(x[2])); return sse(req, res, JSON.stringify({ hard: m ? [Number(m[1])] : [] })); }
    if (kind === 'zhlines') { const n = [...user.matchAll(/\\n(\d+)\. /g)].map((m) => Number(m[1])); return sse(req, res, n.map((k) => `${k}. 中文第${k}句`).join('\n')); }
    if (kind === 'zhword') return sse(req, res, '细致的；仔细的');
    // explanations: about the sentence being read now (the context around it holds the other hard words too)
    const cur = (/The sentence being read now:\\n(.*?)(?:\\n|")/.exec(user) || [])[1] || '';
    if (/The learner just paused the video/.test(user)) return sse(req, res, 'In this part the speaker counts the sentences of the lesson. That is the main point.');
    if (/What is a gregarious man/.test(user)) return sse(req, res, 'A gregarious man loves being with people.');
    return sse(req, res, /meticulous/.test(cur) ? 'Meticulous means very careful about every small detail. Your friend checks her work again and again so that nothing is wrong.' : /gregarious/.test(cur) ? 'Gregarious means a person who loves being with other people.' : /number six/.test(cur) ? 'This sentence simply says it is the sixth sentence.' : 'It means something simple.');
  });
}).listen(8790);

(async () => {
  const ctx = await pw.chromium.launchPersistentContext(require('os').tmpdir() + '/dr-profile-' + Date.now(), {
    executablePath: process.env.CHROME || undefined, headless: true,
    args: ['--headless=new', '--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
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
  const patch = (k, v) => sw.evaluate(([key, val]) => chrome.storage.local.get(key).then((o) => chrome.storage.local.set({ [key]: { ...(o[key] || {}), ...val } })), [k, v]);
  await sw.evaluate(() => chrome.storage.local.set({
    drKeys: { anthropic: 'sk-ant-test-key' },
    drExtras: { tutorOn: true, fakeVoice: true, explainOnStop: true, stopInCall: false, panel: true, band: 'auto', hideYtCaptions: true },
    drTestBaseUrls: { anthropic: 'http://localhost:8790', openai: 'http://localhost:8790/v1' },
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 1500, pauseAfterExplainMs: 1500, wordRepeats: 3, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 30 } },
    voiceOn: false,
  }));
  peer = await ctx.newPage();
  await peer.goto('http://localhost:8790/peer.html');

  const yt = await ctx.newPage();
  yt.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  yt.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND/.test(m.text())) console.log('console error:', m.text().slice(0, 200)); });
  await yt.goto('https://www.youtube.com/watch?v=drm00000001');
  const dbg = () => yt.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const panel = (fn, arg) => yt.evaluate(fn, arg);
  const vstate = () => yt.evaluate(() => { const v = document.querySelector('video'); return { t: +v.currentTime.toFixed(2), paused: v.paused }; });
  const vevents = () => yt.evaluate(() => window.__vev || []);
  const sroot = (fn) => yt.evaluate(fn);
  let tracing = true;
  (async () => { while (tracing) { try { const x = await yt.evaluate(() => { const v = document.querySelector('video'); let d = null; try { d = JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { /* none */ } return `${v.currentTime.toFixed(2)}${v.paused ? 'P' : '>'} ${d ? d.state : '-'}${d && d.window ? ':' + d.window.phase + '/' + d.window.target.slice(0, 14) : ''}${d && d.talk ? ' talk' : ''}${d && d.flow ? ' ' + d.flow : ''}${d && d.stage && d.stage.shown ? ' page' : ''}`; }); if (trace[trace.length - 1] !== x) trace.push(x); } catch (e) { /* page busy */ } await sleep(250); } })();
  // every jump of the video (the tests look for "back to the start of the sentence")
  await yt.evaluate(() => { window.__vev = []; const v = document.querySelector('video'); v.addEventListener('seeking', () => window.__vev.push('seek@' + v.currentTime.toFixed(2))); v.addEventListener('play', () => window.__vev.push('play@' + v.currentTime.toFixed(2))); });
  const seeksTo = async (t, tol = 0.3) => (await vevents()).filter((e) => e.startsWith('seek@') && Math.abs(Number(e.slice(5)) - t) <= tol).length;
  const explains = (re) => apiLog.filter((r) => r.kind === 'explain' && re.test(r.user));
  const speak = () => dbg().then((d) => (d && d.spoken) || []);

  // ---- 1. the AI reads the video first: complete sentences, hard words, hard sentences ----
  const ready = await until(async () => { const d = await dbg(); return d && d.sentences === 10 && d.split === 'ai' ? d : null; }, 25000);
  ok('the AI rebuilt the subtitles into complete sentences (10, its own punctuation shown)', ready && await panel(() => document.getElementById('dr-panel-host').shadowRoot.textContent.includes('She checked every small detail, twice.')), JSON.stringify(ready && { s: ready.sentences, split: ready.split }));
  const hard = await until(async () => { const d = await dbg(); return d && d.hardSentences && d.hardSentences.length ? d.hardSentences : null; }, 15000);
  ok('the AI marked the hard sentence for B2 (shown with a dashed mark)', hard && /number six/.test(hard[0]) && await panel(() => !!document.getElementById('dr-panel-host').shadowRoot.querySelector('.hl-marked')), JSON.stringify(hard));
  const tutorBtn = await yt.evaluate(() => { const b = document.getElementById('yt2c-b-tutor'); return b ? { text: b.textContent, bg: getComputedStyle(b).backgroundColor } : null; });
  ok('the bar has the My tutor button, green (on)', tutorBtn && /on/.test(tutorBtn.text) && tutorBtn.bg === 'rgb(30, 142, 62)', JSON.stringify(tutorBtn));
  const look = await panel(() => { const host = document.getElementById('dr-panel-host'); const r = host.shadowRoot; const w = r.querySelector('.w[data-lemma="meticulous"]'); return { inSecondary: host.parentElement && host.parentElement.id, relatedHidden: getComputedStyle(document.getElementById('secondary-inner')).display === 'none', lines: r.querySelectorAll('.s').length, hard: !!(w && w.classList.contains('hl-unknown')), easyHighlighted: !!r.querySelector('.w[data-lemma="friend"].hl-unknown') }; });
  ok('panel takes the place of the related videos; above-B2 words highlighted, easy ones not', look.inSecondary === 'secondary' && look.relatedHidden && look.lines === 10 && look.hard && !look.easyHighlighted, JSON.stringify(look));
  const aiHint = await until(() => panel(() => { const w = document.getElementById('dr-panel-host').shadowRoot.querySelector('.w[data-lemma="gregarious"]'); return w && w.dataset.hint; }), 8000);
  ok('the AI\'s Chinese meaning is written under the hard word', aiHint === '爱交际的', aiHint);
  ok('normal mode: the reading page is hidden while the video plays', !(await dbg()).stage.shown);

  // ---- 2. a hard word: 3 times, 5-second window (I know / I don't know only), explanation at once, 10 times, the sentence from the video, a moment to ask, on ----
  await yt.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 0; return v.play(); });
  const win = await until(async () => { const d = await dbg(); return d && d.window && d.window.target === 'meticulous' && d.window.phase === 'before' ? d : null; }, 20000);
  const v1 = await vstate();
  ok('the video stopped right after "meticulous" (not at the sentence end)', win && v1.paused && v1.t > 5.8 && v1.t < 7.6, JSON.stringify(v1));
  ok('the word was said 3 times before the window', win && win.spoken && win.spoken.slice(0, 3).every((s) => s === 'meticulous'), JSON.stringify(win && win.spoken));
  ok('the reading page shows the last part (the 2 sentences so far) over the screen', win && win.stage.shown && win.stage.view === 'part' && win.stage.visibleLines === 2, JSON.stringify(win && win.stage));
  const fits = () => sroot(() => { const r = document.getElementById('dr-stage-host').shadowRoot; const p = r.querySelector('.page').getBoundingClientRect(); const ls = [...r.querySelectorAll('.s.in-part')]; return ls.length > 0 && ls.every((x) => { const b = x.getBoundingClientRect(); return b.height > 0 && b.top >= p.top - 1 && b.bottom <= p.bottom + 1; }); });
  ok('every word of the part is on the screen (nothing hidden, nothing to scroll)', await fits());
  const cardLook = await sroot(() => { const r = document.getElementById('dr-stage-host').shadowRoot; const c = r.querySelector('.card'); const cmd = r.querySelector('.cmd'); return { card: c && !c.hidden ? c.innerText : null, cmd: cmd && !cmd.hidden ? cmd.innerText : null }; });
  ok('the card is on the page (word, level, Chinese); the window has only I know / I don\'t know', cardLook.card && /meticulous/.test(cardLook.card) && /C2/.test(cardLook.card) && /一丝不苟/.test(cardLook.card) && /I know/.test(cardLook.cmd) && /I don.t know/.test(cardLook.cmd) && !/Go on/.test(cardLook.cmd), JSON.stringify(cardLook));
  const pre = explains(/The sentence being read now:\\nToday my friend/);
  ok('no waiting: the explanation was asked for when the video stopped (nothing the learner said in it)', pre.length === 1 && pre[0].model === 'claude-opus-5-5' && pre[0].effort === 'low' && pre[0].cache && pre[0].fallbacks === 'default' && /RULE ONE/.test(pre[0].sys) && !/said aloud/.test(pre[0].user), JSON.stringify(pre.map((r) => ({ m: r.model, e: r.effort, c: r.cache, f: r.fallbacks }))));
  const spokeExp = await until(async () => { const s = await speak(); return s.some((x) => /very careful/.test(x)) ? s : null; }, 10000);
  ok('after the window the tutor explains at once (no second request)', !!spokeExp && explains(/The sentence being read now:\\nToday my friend/).length === 1, JSON.stringify(spokeExp && spokeExp.slice(-3)));
  const tenAfter = await until(async () => { const s = await speak(); const i = s.findIndex((x) => /very careful/.test(x)); return i >= 0 && s.slice(i + 1).filter((x) => x === 'meticulous').length >= 10 ? s : null; }, 20000);
  ok('then the word is said 10 more times (your RULE ONE)', !!tenAfter);
  const replay = await until(async () => (await seeksTo(3.85)) >= 1 ? await vstate() : null, 10000, 60);
  ok('then the sentence plays from the video (back to its start, about 4 s)', !!replay, JSON.stringify(replay));
  const cardGone = await until(() => sroot(() => { const c = document.getElementById('dr-stage-host').shadowRoot.querySelector('.card'); return !c || c.hidden; }), 3000, 60);
  ok('the dictionary card closes when the sentence plays again', !!cardGone);
  const talk1 = await until(async () => { const d = await dbg(); return d && d.talk ? d : null; }, 10000);
  const talkUi = talk1 && await sroot(() => { const r = document.getElementById('dr-stage-host').shadowRoot; const t = r.querySelector('.talk'); const cmd = r.querySelector('.cmd'); return { talk: t && !t.hidden ? t.innerText : null, cmd: cmd && !cmd.hidden ? cmd.innerText : null }; });
  ok('a moment to ask: the call with Claude opens (no I know / I don\'t know at the end)', talkUi && /Call with Claude|just talk/.test(talkUi.talk) && !talkUi.cmd, JSON.stringify(talkUi));
  const on1 = await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && v.t > 8.0 && !d.talk ? { v, d } : null; }, 12000, 100);
  ok('nobody asked: after 3 quiet seconds the video goes on after the sentence (heard just now), the page goes away', on1 && !on1.d.stage.shown && (await seeksTo(3.85)) === 1, JSON.stringify(on1 && on1.v));
  const entries = await until(async () => { const e = await store('drEntries'); return e && e.meticulous ? e : null; }, 8000);
  ok('"meticulous" is in My Vocabulary with its sentence, explanation and the time in the video', entries && /very careful/.test(entries.meticulous.explanation) && entries.meticulous.sentence === LINES[1] && entries.meticulous.chapter === '0:04', JSON.stringify(entries && entries.meticulous).slice(0, 200));
  ok('it stays highlighted ("learning"): explained again next time', ((await store('drVocab')) || { words: {} }).words.meticulous === 'learning');

  // ---- 3. "I know" (said aloud) at "ephemeral": unhighlighted, not explained, the sentence again, on ----
  const win2 = await until(async () => { const d = await dbg(); return d && d.window && d.window.target === 'ephemeral' ? d : null; }, 20000);
  ok('stops again at the next hard word ("ephemeral")', !!win2);
  await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' }); await chrome.tabs.sendMessage(tab.id, { type: 'heard', text: 'I know', final: true, key: 'v1:0' }); });
  const goOn = await until(async () => { const v = await vstate(); return !v.paused && v.t >= 11.8 && v.t < 14 ? v : null; }, 6000, 60);
  await sleep(800);
  const vocab2 = await store('drVocab');
  const hl = await panel(() => !!document.getElementById('dr-panel-host').shadowRoot.querySelector('.w[data-lemma="ephemeral"].hl-unknown'));
  ok('"I know": known and unhighlighted, nothing explained, the sentence plays again from its start', goOn && vocab2.words.ephemeral === 'known' && !hl && !(await speak()).some((x) => /something simple/.test(x)), JSON.stringify({ goOn, known: vocab2.words.ephemeral, hl }));

  // ---- 4. the hard sentence: played once, "Do you understand this sentence?", K = I know ----
  const win3 = await until(async () => { const d = await dbg(); return d && d.window && d.window.kind === 'sentence' && d.window.phase === 'before' ? d : null; }, 25000);
  const cmd3 = win3 && await sroot(() => { const c = document.getElementById('dr-stage-host').shadowRoot.querySelector('.cmd'); return c && !c.hidden ? c.innerText : null; });
  ok('stops after the hard sentence, plays it once from the video, then asks', win3 && /understand this sentence/.test(cmd3 || '') && (await seeksTo(19.85)) >= 1 && !win3.card, JSON.stringify({ cmd3, seeks: await vevents() }).slice(0, 300));
  await yt.keyboard.press('KeyK');
  const on3 = await until(async () => { const v = await vstate(); return !v.paused && v.t >= 24 ? v : null; }, 8000, 60);
  ok('K = I know: the sentence is known, the video goes on after it', on3 && ((await store('drVocab')).words['sentence: this is complete sentence number six of the lesson'] === 'known'), JSON.stringify(on3));

  // ---- 5. "gregarious": D = I don't know (explained at once), then "bye bye" (Esc): back to the start of the sentence ----
  const win4 = await until(async () => { const d = await dbg(); return d && d.window && d.window.target === 'gregarious' && d.window.phase === 'before' ? d : null; }, 15000);
  ok('stops at "gregarious"', !!win4);
  await yt.keyboard.press('KeyD');
  const exp4 = await until(async () => { const s = await speak(); return s.some((x) => /loves being with other people/.test(x)) ? s : null; }, 8000);
  ok('D ("I don\'t know") explains at once', !!exp4 && explains(/The sentence being read now:\\nMy uncle/).length === 1);
  const seeksBefore = await seeksTo(23.85);
  await yt.keyboard.press('Escape');
  const bye = await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && (await seeksTo(23.85)) > seeksBefore && v.t >= 23.8 && v.t < 27 && !d.talk ? v : null; }, 8000, 60);
  ok('"bye bye" (Esc) stops the AI at once and plays again from the start of the sentence', !!bye, JSON.stringify(bye));

  // ---- 6. you pause: the part (complete sentences) plays again on the page, the teacher breaks it down, back to its start ----
  await patch('drSettings', { listen: { ...(await store('drSettings')).listen, lastSecondsWindow: 20 } });
  await until(async () => (await vstate()).t > 30.6, 15000);
  await yt.evaluate(() => { document.querySelector('video').playbackRate = 3; });
  const nBefore = apiLog.length;
  await yt.evaluate(() => document.querySelector('video').pause());
  const part = await until(async () => { const d = await dbg(); return d && d.flow === 'part' && d.stage.shown ? d : null; }, 6000);
  ok('pausing: the page shows the last 20 s in complete sentences (6 lines)', part && part.stage.view === 'part' && part.stage.visibleLines === 6, JSON.stringify(part && part.stage));
  const replayed = await until(async () => (await seeksTo(7.85)) >= 1 ? await vstate() : null, 6000, 60);
  ok('the part plays again from its start (the audio, the page stays on)', !!replayed && (await dbg()).stage.shown, JSON.stringify(replayed));
  await sroot(() => document.getElementById('dr-stage-host').shadowRoot.querySelector('.top [data-secs="40"]').click());
  const more = await until(async () => { const d = await dbg(); return d && d.stage.visibleLines === 8 ? d : null; }, 4000, 80);
  ok('40 s on the page: at once the last 40 s (8 complete sentences), all on the screen', !!more && await fits(), JSON.stringify((await dbg()).stage));
  const passage = await until(() => apiLog.slice(nBefore).find((r) => r.kind === 'explain' && /The learner just paused the video/.test(r.user)), 20000);
  ok('after the replay: the teacher breaks the part down (your rules, the whole part)', passage && /sentence number eight/.test(passage.user) && /very easy English/.test(passage.user), passage && passage.user.slice(0, 160));
  await yt.evaluate(() => { document.querySelector('video').playbackRate = 1; });
  const spokePart = await until(async () => (await speak()).some((x) => /counts the sentences/.test(x)), 10000);
  ok('the explanation is spoken', !!spokePart);
  const back = await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && !d.flow && (await seeksTo(7.85)) >= 2 ? v : null; }, 15000, 80);
  ok('then back to the start of the part, playing (no stops inside it)', back && back.t < 10, JSON.stringify(back));
  await sleep(1500);
  ok('the part replays without stopping at "gregarious" again', !(await dbg()).window);

  // ---- 7. ← : the last sentence is played, explained, played again ----
  await yt.evaluate(() => { document.querySelector('video').playbackRate = 3; });
  await until(async () => { const v = await vstate(); return v.t > 33.6 && v.t < 35; }, 15000, 50);
  await yt.evaluate(() => { document.querySelector('video').playbackRate = 1; });
  const nL = apiLog.length;
  const seeks31 = await seeksTo(31.85);
  await yt.keyboard.press('ArrowLeft');
  const left = await until(() => apiLog.slice(nL).find((r) => r.kind === 'explain' && /The sentence being read now:\\nThis is complete sentence number nine/.test(r.user)), 8000);
  ok('← explains the last sentence (RULE TWO for sentences)', !!left && /RULE TWO/.test(left.user + left.sys));
  const twice = await until(async () => (await seeksTo(31.85)) >= seeks31 + 2 ? true : null, 20000, 80);
  ok('it was played from the video before and after the explanation', !!twice, JSON.stringify(await vevents()).slice(-200));
  const after7 = await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && !d.flow && v.t > 35.5 ? v : null; }, 15000, 80);
  ok('then the video goes on after it', !!after7, JSON.stringify(after7));

  // ---- 8. listening mode: all subtitles over the screen, the playing line near the middle; sizes, Chinese, quick settings ----
  await yt.keyboard.press('Shift+KeyL');
  const lis = await until(async () => { const d = await dbg(); return d && d.view === 'listening' && d.stage.shown && d.stage.view === 'all' ? d : null; }, 5000);
  ok('Shift+L: listening mode shows all 10 subtitles over the whole screen', lis && lis.stage.visibleLines === 10, JSON.stringify(lis && lis.stage));
  await sleep(1200);
  const pos = await sroot(() => { const r = document.getElementById('dr-stage-host').shadowRoot; const p = r.querySelector('.page'); const c = r.querySelector('.s.cur'); if (!p || !c) return null; const pr = p.getBoundingClientRect(), cr = c.getBoundingClientRect(); return (cr.top + cr.height / 2 - pr.top) / pr.height; });
  ok('the playing line sits near the middle (about 42% from the top), not at the top', pos !== null && pos > 0.25 && pos < 0.6, pos);
  const zh = await until(async () => { const d = await dbg(); return d && d.stage.zhLines >= 3 ? d.stage.zhLines : null; }, 10000);
  ok('live Chinese translation appears under the lines', !!zh && await sroot(() => /中文第/.test(document.getElementById('dr-stage-host').shadowRoot.querySelector('.zh-line').textContent)), zh);
  const size0 = (await store('drExtras')).stageSizePx || 34;
  await yt.keyboard.press(']');
  await until(async () => ((await store('drExtras')).stageSizePx || 34) > size0, 3000);
  ok('] makes the page text bigger (any size, saved)', ((await store('drExtras')).stageSizePx || 34) === size0 + 2, (await store('drExtras')).stageSizePx);
  await sroot(() => document.getElementById('dr-stage-host').shadowRoot.querySelector('.top [data-act="quick"]').click());
  await sleep(300);
  const quick = await sroot(() => { const q = document.getElementById('dr-stage-host').shadowRoot.querySelector('.quick'); return q && !q.hidden ? { text: q.innerText, teacher: (q.querySelector('textarea[data-name="teacher"]') || {}).value || '' } : null; });
  ok('⚙ quick settings open right on the page (sizes, voice, talk, my teacher\'s rules, keys, shortcuts)', quick && /Speaking now: Mac voice/i.test(quick.text) && /Mac voice/i.test(quick.text) && /Call with/i.test(quick.text) && /Reading page/i.test(quick.text) && /Tutor's voice/i.test(quick.text) && /Live voice call/i.test(quick.text) && /Microphone/i.test(quick.text) && /RULE ONE/.test(quick.teacher) && /Shortcuts/i.test(quick.text), quick && quick.text.slice(0, 120));
  await sroot(() => { const q = document.getElementById('dr-stage-host').shadowRoot.querySelector('.quick'); q.querySelector('.seg[data-name="seconds"] button[data-v="40"]').click(); });
  await sleep(500);
  ok('changing the part length there is saved at once', (await store('drSettings')).listen.lastSecondsWindow === 40);
  await sroot(() => document.getElementById('dr-stage-host').shadowRoot.querySelector('.quick [data-act="close"]').click());
  await yt.keyboard.press('Shift+KeyL');
  const norm = await until(async () => { const d = await dbg(); return d && d.view === 'normal' && !d.stage.shown ? d : null; }, 5000);
  ok('Shift+L again: back to the normal video', !!norm);

  // ---- 9. a typed question ----
  const nQ = apiLog.length;
  await panel(() => { const r = document.getElementById('dr-panel-host').shadowRoot; r.querySelector('form.ask input').value = 'What is a gregarious man?'; r.querySelector('form.ask button').click(); });
  const q = await until(() => apiLog.slice(nQ).find((r) => r.user.includes('What is a gregarious man?')), 8000);
  ok('a typed question goes to the tutor with the video context', !!q);
  await until(async () => { const d = await dbg(); const v = await vstate(); return !d.talk && !d.flow && !v.paused && d.state === 'playing'; }, 20000);

  // ---- 9b. 📞 call Claude: hello, you talk, Claude answers out loud, "bye bye" ----
  const nC = apiLog.length;
  await yt.keyboard.press('Shift+KeyT');
  const call = await until(async () => { const d = await dbg(); return d && d.talk && d.flow === 'call' && d.talk.log.some((l) => /tutor: Hi!/.test(l)) ? d : null; }, 6000);
  ok('Shift+T: a call with Claude opens on the page, Claude says hello', call && call.talk.live === null && call.stage.shown && (await speak()).some((x) => /What would you like to know/.test(x)), JSON.stringify(call && call.talk));
  ok('the call keeps the microphone on (even with voice commands off)', (await dbg()).mic === true);
  await sleep(1500);
  const say = (text, key) => sw.evaluate(async ([t, k]) => { const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' }); await chrome.tabs.sendMessage(tab.id, { type: 'heard', text: t, final: true, key: k }); }, [text, key]);
  await say('What is a gregarious man', 'c1:0');
  const cq = await until(() => apiLog.slice(nC).find((r) => /What is a gregarious man/.test(r.user)), 8000);
  ok('what you say goes to Claude (your Claude key) with the part on the screen', !!cq && /sk-ant-test-key/.test(cq.key));
  const ans = await until(async () => { const d = await dbg(); return d.talk && d.talk.log.some((l) => /tutor: A gregarious man/.test(l)) && (await speak()).some((x) => /A gregarious man loves/.test(x)) ? d : null; }, 10000);
  ok('Claude answers out loud; both show on the page', !!ans, JSON.stringify(ans && ans.talk.log));
  await sleep(1500);
  ok('the call waits for you (no going on after 3 quiet seconds when you called)', !!(await dbg()).talk);
  await say('bye bye', 'c2:0');
  const out = await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && !d.talk && !d.flow ? v : null; }, 8000, 80);
  ok('"bye bye": the call ends and the video plays on', !!out, JSON.stringify(out));

  // ---- 9c. the Microsoft (Azure) voice: official, free 9 hours a month ----
  await patch('drTestBaseUrls', { azure: 'http://localhost:8790' });
  await patch('drKeys', { azure: 'az-test-key' });
  await patch('drExtras', { voice: 'azure' });
  await until(async () => (await dbg()).voice === 'azure', 5000);
  ok('Microsoft voice chosen, with its Azure key: the tutor speaks with it', (await dbg()).voice === 'azure');
  const nAz = apiLog.filter((r) => r.kind === 'azure').length;
  await yt.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 20.5; return v.play(); });
  await until(async () => (await vstate()).t > 22.5, 8000);
  await yt.keyboard.press('ArrowLeft');
  const az = await until(() => { const a = apiLog.filter((r) => r.kind === 'azure'); return a.length > nAz ? a[a.length - 1] : null; }, 15000);
  ok('the explanation is spoken by the Microsoft voice (Ava), with the Azure key', az && /AvaMultilingualNeural/.test(az.body) && az.key === 'az-test-key', az && az.body.slice(0, 160));
  await until(async () => { const d = await dbg(); const v = await vstate(); return !d.talk && !d.flow && !v.paused; }, 25000);
  await patch('drKeys', { azure: '' });
  await patch('drExtras', { voice: 'auto' });

  // ---- 10. the OpenAI voice and the live voice call (real time) ----
  await patch('drExtras', { talkSilenceSec: 0, talkWith: 'openai' }); // the OpenAI live call; it waits for you (the test talks in it)
  await patch('drKeys', { openai: 'sk-openai-test' });
  await until(async () => (await dbg()).voice === 'openai', 5000);
  ok('with an OpenAI key the tutor uses the OpenAI voice (Auto)', (await dbg()).voice === 'openai');
  const nTts = apiLog.filter((r) => r.kind === 'tts').length;
  await yt.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 20.5; return v.play(); });
  await until(async () => (await vstate()).t > 22.5, 8000);
  failNextTts = 1; // the first sentence of the voice fails once (like a short internet hiccup)
  const macBefore = (await speak()).length;
  await yt.keyboard.press('ArrowLeft');
  const tts = await until(() => { const t = apiLog.filter((r) => r.kind === 'tts' && !r.failed); return t.length > nTts ? t[t.length - 1] : null; }, 15000);
  ok('the explanation is spoken by the OpenAI voice (gpt-4o-mini-tts, marin), through the background', tts && tts.model === 'gpt-4o-mini-tts' && tts.voice === 'marin' && /Bearer sk-openai-test/.test(tts.key), JSON.stringify(tts && { m: tts.model, v: tts.voice, i: tts.input }));
  await sleep(1500);
  const failed = apiLog.filter((r) => r.kind === 'tts' && r.failed);
  ok('a voice hiccup (one failed request) is tried again: the OpenAI voice keeps speaking, no switch to the Mac voice', failed.length === 1 && apiLog.filter((r) => r.kind === 'tts' && !r.failed && r.input === failed[0].input).length >= 1 && (await speak()).length === macBefore && (await dbg()).voice === 'openai', JSON.stringify({ failed: failed.map((r) => r.input), mac: (await speak()).slice(macBefore) }));
  const live = await until(() => liveLog[0], 20000);
  ok('the live call connects to OpenAI realtime with the key (from the background), the part, your rules, the tools', live && /Bearer sk-openai-test/.test(live.auth) && live.session.model === 'gpt-realtime-2.1' && live.session.audio.output.voice === 'marin' && /RULE ONE/.test(live.session.instructions) && /number six/.test(live.session.instructions) && live.session.tools.some((t) => t.name === 'continue_video'), JSON.stringify(live && { m: live.session.model, v: live.session.audio.output.voice }));
  ok('the microphone is sensitive (lower speech threshold, laptop-microphone noise setting)', live && live.session.audio.input.turn_detection.type === 'server_vad' && live.session.audio.input.turn_detection.threshold === 0.35 && live.session.audio.input.noise_reduction.type === 'far_field');
  const ready2 = await until(async () => { const d = await dbg(); return d && d.talk && d.talk.live === 'ready' ? d : null; }, 15000);
  ok('the WebRTC call is up (data channel open)', !!ready2, JSON.stringify((await dbg()).talk));
  const send = (ev) => peer.evaluate((e) => window.send(e), ev);
  await send({ type: 'input_audio_buffer.speech_started' });
  await send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'What does it mean?' });
  await send({ type: 'response.output_audio_transcript.delta', response_id: 'r1', delta: 'It means it is the ninth sentence.' });
  await send({ type: 'output_audio_buffer.started' });
  const logged = await until(async () => { const d = await dbg(); return d && d.talk && d.talk.log.some((l) => /you: What does it mean/.test(l)) && d.talk.log.some((l) => /tutor: It means/.test(l)) ? d.talk.log : null; }, 5000);
  ok('what you say and what the tutor answers show live on the page', !!logged, JSON.stringify(logged));
  await send({ type: 'output_audio_buffer.stopped' });
  await send({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name: 'continue_video', call_id: 'c1', arguments: '{}' }], usage: { input_tokens: 500, output_tokens: 300, input_token_details: { text_tokens: 400, audio_tokens: 100 }, output_token_details: { text_tokens: 50, audio_tokens: 250 } } } });
  const cont = await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && !d.talk ? v : null; }, 8000, 80);
  ok('"let\'s go" → the tutor calls continue_video → the video plays on', !!cont, JSON.stringify(cont));
  const got = await peer.evaluate(() => window.got.map((e) => e.type));
  ok('the call got its context update and the tool answer', got.includes('session.update') && got.includes('conversation.item.create'), JSON.stringify(got));
  const usage = await until(async () => ((await store('drUsage')) || []).find((u) => u.model === 'gpt-realtime-2.1'), 5000);
  ok('the live call\'s cost is counted in your budget', usage && usage.usd > 0, JSON.stringify(usage));

  // ---- 11. one voice at a time; the check report ----
  await yt.evaluate(() => document.getElementById('yt2c-b-claude').click());
  const off = await until(async () => { const b = await yt.evaluate(() => document.getElementById('yt2c-b-tutor').textContent); const d = await dbg(); return /off/.test(b) && d && d.mode === 'call' ? { b, mode: d.mode } : null; }, 8000);
  ok('Claude on → My tutor off, the panel stays in call mode (highlights, no stops)', !!off, JSON.stringify(off));
  await yt.evaluate(() => document.getElementById('yt2c-b-tutor').click());
  const tutorAgain = await until(async () => { const s = await yt.evaluate(() => ({ t: document.getElementById('yt2c-b-tutor').textContent, c: document.getElementById('yt2c-b-claude').textContent })); return /on/.test(s.t) && /off/.test(s.c) ? s : null; }, 8000);
  ok('My tutor on → Claude off', !!tutorAgain, JSON.stringify(tutorAgain));
  const report = await sw.evaluate(() => diagnose());
  ok('🩺 Check (Chrome): reports My tutor (keys saved, voice, live talk), no Safari advice', /My tutor: \{"on":true/.test(report) && /"keys":\["anthropic","openai"\]/.test(report) && !/Split View|Safari window|Safari pauses|Safari stops/.test(report) && /"tutor":\{/.test(report), report.slice(0, 400));

  // ---- 12. the settings page and My Vocabulary ----
  const opt = await ctx.newPage();
  opt.on('pageerror', (e) => console.log('OPTIONS PAGE ERROR', e.message));
  await opt.goto(`chrome-extension://${extId}/dream/options.html`);
  await opt.waitForTimeout(800);
  const o1 = await opt.evaluate(() => ({ level: document.getElementById('learnerLevel').value, model: document.getElementById('anthropicModel').value, styles: document.querySelectorAll('#style-list button').length, keyPh: document.getElementById('key-anthropic').placeholder, rules: document.getElementById('contextRules').value.length, mine: document.getElementById('style-list').textContent }));
  ok('settings page: level, model, the 10 styles ("My Teacher (my rules)" first), saved key, rules', o1.level === 'B2' && o1.model === 'claude-opus-5-5' && o1.styles >= 10 && /saved/.test(o1.keyPh) && o1.rules > 100 && /My Teacher/.test(o1.mine), JSON.stringify(o1).slice(0, 200));
  await opt.selectOption('#learnerLevel', 'C1');
  await opt.waitForTimeout(400);
  ok('changing the level is saved', ((await store('drSettings')) || {}).learnerLevel === 'C1');
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
  ok('CSV download has the words, Chinese and a link to the moment in the video', /meticulous/.test(csv) && /watch\?v=drm00000001&t=4s/.test(csv), csv.slice(0, 200));
  await voc.click('[data-tab="progress"]');
  await voc.waitForTimeout(1500);
  const lv = await voc.evaluate(() => document.querySelectorAll('#levels .level').length);
  ok('Progress shows the six levels', lv === 6, lv);

  tracing = false;
  await ctx.close();
  api.close();
  console.log(fails ? `${fails} FAILED` : 'DREAM TUTOR: ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
