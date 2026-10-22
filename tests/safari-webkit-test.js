// Runs the SAFARI build of the extension (safari/Extension) in WebKit, Safari's engine, with a stand-in for
// Safari's promise-based "browser" API. Checks: the shim switches to "browser", the buttons work, a pause sends
// the ~30 s part, the chat page types and sends the text, and the background script answers like on Safari.
const pw = require(process.env.PWMOD || 'playwright');
const path = require('path'); const fs = require('fs'); const http = require('http');
const EXT = path.resolve(__dirname, '../safari/Extension') + '/';
const rd = (f) => fs.readFileSync(EXT + f, 'utf8');
let fails = 0;
const ok = (name, cond, info) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (info ? '  ' + String(info).slice(0, 300) : '')); if (!cond) fails++; };

const cues = Array.from({ length: 30 }, (_, i) => ({ tStartMs: i * 4000, dDurationMs: 4000, segs: [{ utf8: 'This is sentence number ' + (i + 1) + ' of the&nbsp;lesson.' + (i % 5 === 4 ? '&#39;' : '') }] }));
const json3 = JSON.stringify({ events: cues });
const pr = JSON.stringify({ videoDetails: { videoId: 'abc12345678', title: 'English Lesson 1', lengthSeconds: '120' }, playabilityStatus: { status: 'OK' },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'http://localhost:8771/timedtext?lang=en', languageCode: 'en', kind: 'asr' }] } } });
const ytHtml = `<!doctype html><title>English Lesson 1 - YouTube</title><div id="movie_player" style="position:relative;width:800px;height:450px;background:#246"><video muted playsinline src="/v.wav" class="html5-main-video" style="width:100%;height:100%"></video></div><div id="below"><h1 class="ytd-watch-metadata"><yt-formatted-string>English Lesson 1</yt-formatted-string></h1></div><script>var ytInitialPlayerResponse = ${pr};</script>`;
const chatHtml = `<!doctype html><title>Claude</title><div id="box" class="ProseMirror" contenteditable="true" style="min-height:40px;border:1px solid #999"></div><input type="file" multiple id="f"><div id="slot"></div>
<script>window.__sent=[];const b=document.getElementById('box'),f=document.getElementById('f'),slot=document.getElementById('slot');
function mkSend(){ if(slot.firstChild) return; const x=document.createElement('button');x.setAttribute('aria-label','Send message');x.textContent='Send';x.onclick=()=>{window.__sent.push({text:b.textContent,files:[...f.files].map(y=>y.name)});f.value='';b.textContent='';slot.innerHTML=''};slot.appendChild(x)}b.addEventListener('input',()=>{ if(b.textContent.trim()) mkSend(); else if(!f.files.length) slot.innerHTML=''; });f.addEventListener('change',()=>setTimeout(mkSend,300));</script>`;
const voiceHtml = `<!doctype html><title>Reading - Claude</title><div id="box" class="ProseMirror" contenteditable="true" style="min-height:40px;border:1px solid #999"></div><input type="file" multiple id="f"><div id="slot"></div>
<button aria-label="Reading, rename session: End the voice session to continue">Reading</button><button aria-label="Good response: End the voice session to continue">👍</button><button aria-label="Retry: End the voice session to continue">↻</button>
<div id="vc"><button id="endv" aria-label="End voice session">■</button></div>
<script>window.__sent=[];window.__events=[];let on=true;const b=document.getElementById('box'),f=document.getElementById('f'),slot=document.getElementById('slot'),vc=document.getElementById('vc');
function lockAll(x){document.querySelectorAll('button[aria-label]').forEach(e=>{const l=e.getAttribute('aria-label');if(x&&!/End the voice/.test(l)&&e.id!=='endv'&&e.id!=='startv')e.setAttribute('aria-label',l+': End the voice session to continue');if(!x)e.setAttribute('aria-label',l.replace(': End the voice session to continue',''));});}
function endV(){on=false;window.__events.push('end');lockAll(false);vc.innerHTML='<button id="startv" aria-label="Start voice session">🎙</button>';document.getElementById('startv').onclick=startV;}
function startV(){on=true;window.__events.push('start');lockAll(true);vc.innerHTML='<button id="endv" aria-label="End voice session">■</button>';document.getElementById('endv').onclick=endV;}
document.getElementById('endv').onclick=endV;
function mkSend(){ if(slot.firstChild) return; const x=document.createElement('button');x.setAttribute('aria-label','Send message');x.textContent='Send';x.onclick=()=>{ if(on) return; window.__events.push('sent'); window.__sent.push({text:b.textContent,files:[...f.files].map(y=>y.name)});f.value='';b.textContent='';slot.innerHTML=''};slot.appendChild(x)}b.addEventListener('input',()=>{ if(b.textContent.trim()) mkSend(); });f.addEventListener('change',()=>setTimeout(mkSend,300));</script>`;
const wav = (() => { const n = 8000 * 120, b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; })();
const server = http.createServer((q, r) => {
  if (q.url.startsWith('/v.wav')) { const rg = q.headers.range; if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], e = m[2] ? +m[2] : wav.length - 1; r.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${e}/${wav.length}`, 'content-length': e - a + 1 }); return r.end(wav.slice(a, e + 1)); } r.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': wav.length }); return r.end(wav); }
  if (q.url.startsWith('/timedtext') || q.url.startsWith('/api/timedtext')) { r.setHeader('content-type', 'application/json'); return r.end(json3); }
  r.setHeader('content-type', 'text/html'); r.end(q.url.startsWith('/voice') ? voiceHtml : q.url.startsWith('/chat') ? chatHtml : ytHtml);
}).listen(8771);

// Safari's API: everything returns a promise. "chrome" is a decoy WITHOUT promises, so the test fails if the shim is not used.
const fakeSafari = (store) => {
  window.__calls = []; window.__listeners = []; window.__recStarts = 0;
  window.webkitSpeechRecognition = function () { window.__recStarts++; this.start = () => {}; this.stop = () => {}; this.abort = () => {}; };
  const changed = [];
  window.browser = {
    runtime: { id: 'safari-ext', getURL: (p) => p,
      sendMessage: (m) => { window.__calls.push(m); return Promise.resolve(window.__reply ? window.__reply(m) : {}); },
      onMessage: { addListener: (f) => window.__listeners.push(f) } },
    storage: { local: {
      get: (k) => { const keys = k == null ? Object.keys(store) : [].concat(k); const o = {}; for (const x of keys) if (x in store) o[x] = store[x]; return Promise.resolve(o); },
      set: (o) => { const ch = {}; for (const x in o) { ch[x] = { newValue: o[x], oldValue: store[x] }; store[x] = o[x]; } changed.forEach((f) => f(ch, 'local')); return Promise.resolve(); } },
      onChanged: { addListener: (f) => changed.push(f) } }
  };
  window.chrome = { runtime: { sendMessage: () => undefined, onMessage: { addListener: () => {} } }, storage: { local: { get: () => undefined, set: () => undefined }, onChanged: { addListener: () => {} } } };
  window.__deliver = (msg) => new Promise((res) => { let done = false; const send = (x) => { if (!done) { done = true; res(x); } };
    for (const f of window.__listeners) { const r = f(msg, {}, send); if (r && r.then) r.then(send); } setTimeout(() => send(undefined), 8000); });
};

setTimeout(() => { console.log('FAIL  test took longer than 5 minutes (stuck) - stopping'); process.exit(1); }, 5 * 60 * 1000).unref();
(async () => {
  const engine = process.env.ENGINE || 'webkit'; // webkit = Safari's engine (CI); chromium for a quick local run
  const browser = engine === 'webkit' ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  console.log('engine:', engine, browser.version(), '| Safari extension version', JSON.parse(rd('manifest.json')).version);
  const m = JSON.parse(rd('manifest.json'));
  ok('Safari manifest: no Chrome-only permissions, no page-world script, browser-shim.js loads first',
    !m.permissions.includes('debugger') && !m.permissions.includes('tts') && m.content_scripts.every((c) => !c.world && c.js[0] === 'browser-shim.js') &&
    m.content_scripts.flatMap((c) => c.js).concat(['background.js', 'popup.js', 'popup.html']).every((f) => fs.existsSync(EXT + f)), JSON.stringify(m.content_scripts.map((c) => c.js)));
  const ctx = await browser.newContext();
  const yt = await ctx.newPage();
  yt.on('pageerror', (e) => console.log('PAGE ERROR (yt):', String(e.message || e).slice(0, 300)));
  await yt.addInitScript(fakeSafari, { pauseOn: true, replayOn: true, voiceOn: false, imageOn: true, barOn: true, sendOn: false, target: 'claude' });
  await yt.goto('http://localhost:8771/watch?v=abc12345678');
  for (const f of m.content_scripts[0].js) await yt.addScriptTag({ content: rd(f) });
  await yt.evaluate(() => { window.__reply = (msg) => msg.type === 'call-state' ? { inCall: false } : msg.type === 'capture' ? { dataUrl: null } : msg.type === 'diagnose' ? { report: 'PROBLEMS FOUND (1):\n1. test report' } : { result: 'Sent to Claude: ok' }; });
  ok('the shim uses Safari\'s "browser" API', await yt.evaluate(() => window.__ytcSafari === true && window.chrome === window.browser));
  await yt.waitForSelector('#yt2c-bar', { timeout: 8000 }).catch(() => {});
  const bar = await yt.evaluate(() => { const c = document.getElementById('yt2c-b-claude'); return c ? { text: c.textContent, bg: getComputedStyle(c).backgroundColor, under: document.getElementById('yt2c-bar').parentElement.id } : null; });
  ok('two buttons under the video (red = off)', bar && bar.under === 'below' && /off/.test(bar.text) && bar.bg === 'rgb(217, 48, 37)', JSON.stringify(bar));
  await yt.click('#yt2c-b-claude'); await yt.waitForTimeout(1500);
  const after = await yt.evaluate(() => ({ calls: window.__calls.map((c) => c.type), text: document.getElementById('yt2c-b-claude').textContent, bg: getComputedStyle(document.getElementById('yt2c-b-claude')).backgroundColor }));
  ok('press Claude: green, and the full transcript is sent once', after.calls.filter((t) => t === 'send').length === 1 && /on/.test(after.text) && after.bg === 'rgb(30, 142, 62)', JSON.stringify(after));
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.muted = true; v.currentTime = 50; try { await Promise.race([v.play(), new Promise((r) => setTimeout(r, 3000))]); } catch (e) { /* ignore */ } });
  await yt.waitForTimeout(600);
  await yt.evaluate(() => document.querySelector('video').pause());
  await yt.waitForTimeout(4000);
  const ps = await yt.evaluate(() => { const p = window.__calls.find((c) => c.type === 'pause-send'); return p ? { start: p.seg.start, end: p.seg.end, lines: p.lines.length, first: p.lines[0], inCall: p.inCall } : null; });
  ok('pause: the ~30 s part is sent (complete sentences), not the whole video', ps && ps.end - ps.start >= 24 && ps.end - ps.start <= 36 && /^This is sentence number \d+ of the lesson\./.test(ps.first) && ps.inCall === false, JSON.stringify(ps));
  ok('pause: the subtitles show on screen', await yt.evaluate(() => !!document.getElementById('yt2c-overlay')));
  const pc = await yt.evaluate(() => { const p = window.__calls.find((c) => c.type === 'pause-send'); return p ? { pictureOnly: p.pictureOnly, card: !!(p.card && /^data:image\/jpeg/.test(p.card)), image: p.image } : null; });
  ok('iPad + Claude: the pause sends ONE picture (sentences + question in it), no screenshot, no text', pc && pc.pictureOnly === true && pc.card && !pc.image, JSON.stringify(pc));
  // the play / pause button on the subtitle screen: plays and pauses only, sends nothing
  const nSent = await yt.evaluate(() => window.__calls.filter((c) => c.type === 'pause-send').length);
  await yt.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 52; });
  await yt.waitForTimeout(31000); // let the replay end (stopped, waiting)
  const w0 = await yt.evaluate(() => ({ paused: document.querySelector('video').paused, pp: !!document.getElementById('yt2c-pp') }));
  await yt.click('#yt2c-pp'); await yt.waitForTimeout(1500);
  const w1 = await yt.evaluate(() => { const v = document.querySelector('video'); return { paused: v.paused, t: +v.currentTime.toFixed(1), overlay: !!document.getElementById('yt2c-overlay'), icon: document.getElementById('yt2c-pp') && document.getElementById('yt2c-pp').textContent }; });
  await yt.click('#yt2c-pp'); await yt.waitForTimeout(1500);
  const w2 = await yt.evaluate(() => ({ paused: document.querySelector('video').paused, overlay: !!document.getElementById('yt2c-overlay'), sent: window.__calls.filter((c) => c.type === 'pause-send').length }));
  ok('play/pause button on the subtitle screen: plays, then pauses, and sends NOTHING', w0.pp && w0.paused && !w1.paused && w1.overlay && w1.icon === '❚❚' && w2.paused && w2.overlay && w2.sent === nSent, JSON.stringify([w0, w1, w2, nSent]));
  await yt.click('#yt2c-b-check'); await yt.waitForTimeout(800);
  const rep = await yt.evaluate(() => { const p = document.getElementById('yt2c-report-text'); return p ? p.textContent : null; });
  ok('🩺 Check under the video opens the report (with a Copy button)', /PROBLEMS FOUND/.test(rep || '') && !!(await yt.$('#yt2c-report button')), rep);
  await yt.evaluate(() => document.getElementById('yt2c-report').remove());
  const ovText = await yt.evaluate(() => (document.getElementById('yt2c-overlay') || {}).innerText || '');
  ok('subtitles have no "code" (&nbsp; &#39; ...)', ovText.length > 20 && !/&[#a-z0-9]+;?/i.test(ovText) && /of the lesson\./.test(ovText), ovText.slice(0, 120));
  ok('iPad: the microphone is NOT used by the YouTube page (free for the Claude voice call)', await yt.evaluate(() => window.__recStarts === 0), 'started ' + await yt.evaluate(() => window.__recStarts));
  await yt.waitForTimeout(2500);
  const st = await yt.evaluate(() => document.getElementById('yt2c-b-status').textContent);
  ok('the result of sending shows under the video', /^Sent to Claude ✓ \(\d+:\d\d–\d+:\d\d\)$/.test(st), st);
  const fs0 = await yt.evaluate(() => parseFloat(getComputedStyle(document.getElementById('yt2c-body')).fontSize));
  await yt.click('#yt2c-b-bigger'); await yt.click('#yt2c-b-bigger'); await yt.waitForTimeout(400);
  const fs1 = await yt.evaluate(() => parseFloat(getComputedStyle(document.getElementById('yt2c-body')).fontSize));
  await yt.click('#yt2c-b-smaller'); await yt.click('#yt2c-b-smaller'); await yt.click('#yt2c-b-smaller'); await yt.click('#yt2c-b-smaller'); await yt.waitForTimeout(400);
  const fs2 = await yt.evaluate(() => parseFloat(getComputedStyle(document.getElementById('yt2c-body')).fontSize));
  const lvl = await yt.evaluate(() => window.browser.storage.local.get('textLevel').then((o) => o.textLevel));
  ok('A+ / A− under the video make the subtitles bigger / smaller (and it is saved)', fs1 > fs0 && fs2 < fs0 && lvl === 3.5, [fs0, fs1, fs2, lvl].join(' / '));

  // ---- iPad: touch the video. 1st touch: back to the start of the ~30 s part, play it once, stop, send. 2nd touch: back to its start, play to the end ----
  const tp = await ctx.newPage();
  tp.on('pageerror', (e) => console.log('PAGE ERROR (tap):', String(e.message || e).slice(0, 300)));
  await tp.addInitScript(fakeSafari, { pauseOn: true, replayOn: true, voiceOn: false, imageOn: true, barOn: true, sendOn: true, target: 'claude' });
  await tp.goto('http://localhost:8771/watch?v=abc12345678');
  for (const f of m.content_scripts[0].js) await tp.addScriptTag({ content: rd(f) });
  await tp.evaluate(() => { window.__reply = (msg) => msg.type === 'call-state' ? { inCall: false } : msg.type === 'capture' ? { dataUrl: null } : { result: 'Sent to Claude: ok' }; });
  const vs = () => tp.evaluate(() => { const v = document.querySelector('video'); return { t: +v.currentTime.toFixed(1), paused: v.paused, overlay: !!document.getElementById('yt2c-overlay'), sent: window.__calls.filter((c) => c.type === 'pause-send').length }; });
  await tp.evaluate(async () => { const v = document.querySelector('video'); v.muted = true; v.currentTime = 50; try { await Promise.race([v.play(), new Promise((r) => setTimeout(r, 3000))]); } catch (e) { /* ignore */ } });
  await tp.waitForTimeout(1500);
  ok('Safari: the touch area is on (tap control is on by default)', !!(await tp.$('#yt2c-tap')));
  const tTap = Date.now();
  await tp.click('#yt2c-tap');
  let startMs = null;
  for (let i = 0; i < 40 && startMs === null; i++) { const q = await vs(); if (!q.paused && q.t < 30) startMs = Date.now() - tTap; else await tp.waitForTimeout(50); }
  ok('fast: the replay starts playing soon after the touch (under 1.2 s)', startMs !== null && startMs < 1200, startMs + ' ms');
  await tp.waitForTimeout(Math.max(0, 3000 - (Date.now() - tTap)));
  const a1 = await vs();
  ok('1st touch: back to the start of the ~30 s part and playing it, sentences on screen', !a1.paused && a1.t >= 24 && a1.t < 30 && a1.overlay, JSON.stringify(a1));
  await tp.waitForTimeout(29000);
  const a2 = await vs();
  ok('...then it stops by itself at the end of the part, and the part was sent to Claude once', a2.paused && a2.t >= 50 && a2.t <= 54 && a2.sent === 1, JSON.stringify(a2));
  await tp.click('#yt2c-tap');
  await tp.waitForTimeout(1500);
  const a3 = await vs();
  await tp.waitForTimeout(4000);
  const a4 = await vs();
  ok('2nd touch: back to the start of the part again, plays on (no new message)', !a3.paused && a3.t >= 23 && a3.t < 28 && !a3.overlay && a4.t > a3.t + 2 && a4.sent === 1, JSON.stringify([a3, a4]));
  const fsr = await tp.evaluate(async () => { try { await document.getElementById('movie_player').requestFullscreen(); } catch (e) { return 'no fullscreen here: ' + e.message; } await new Promise((r) => setTimeout(r, 900)); const t = document.getElementById('yt2c-tap'); return { fs: !!document.fullscreenElement, inside: !!(t && document.fullscreenElement && document.fullscreenElement.contains(t)) }; });
  if (typeof fsr === 'string' || !fsr.fs) console.log('SKIP  full screen test (this test browser has no full screen): ' + JSON.stringify(fsr));
  else ok('full screen: the touch area is inside the full-screen video (taps work in full screen)', fsr.inside, JSON.stringify(fsr));
  await tp.evaluate(() => document.fullscreenElement && document.exitFullscreen().catch(() => {}));
  await tp.waitForTimeout(600);
  await tp.close();

  const chat = await ctx.newPage();
  chat.on('pageerror', (e) => console.log('PAGE ERROR (chat):', String(e.message || e).slice(0, 300)));
  await chat.addInitScript(fakeSafari, {});
  await chat.goto('http://localhost:8771/chat');
  for (const f of m.content_scripts[1].js) await chat.addScriptTag({ content: rd(f) });
  const cardC = await yt.evaluate(() => window.__calls.find((c) => c.type === 'pause-send').card);
  const pr2 = await chat.evaluate((c) => window.__deliver({ type: 'chat-send', text: 'x', pictureOnly: true, card: { name: 'question-2.jpg', dataUrl: c } }), cardC);
  await chat.waitForTimeout(600);
  const ps2 = await chat.evaluate(() => window.__sent.slice());
  ok('Claude page: picture only is sent (no text)', pr2 && pr2.ok && ps2.length === 1 && ps2[0].text === '' && ps2[0].files.join() === 'question-2.jpg', JSON.stringify({ ok: pr2 && pr2.ok, err: pr2 && pr2.error, steps: pr2 && pr2.steps, sent: ps2 }));
  await chat.evaluate(() => { window.__sent.length = 0; });
  const res = await chat.evaluate(() => window.__deliver({ type: 'chat-send', text: 'Paused at 0:50. Please explain this part.' }));
  await chat.waitForTimeout(1500);
  const sent = await chat.evaluate(() => window.__sent);
  ok('Claude page: the text is typed and sent', res && res.ok && sent.length === 1 && /Please explain this part/.test(sent[0].text), JSON.stringify(res).slice(0, 150) + ' ' + JSON.stringify(sent));

  // Claude's new voice screen (text box visible but locked): step out of the session, send, the background goes back in
  const vp = await ctx.newPage();
  vp.on('pageerror', (e) => console.log('PAGE ERROR (voice):', String(e.message || e).slice(0, 300)));
  await vp.addInitScript(fakeSafari, {});
  await vp.goto('http://localhost:8771/voice');
  for (const f of m.content_scripts[1].js) await vp.addScriptTag({ content: rd(f) });
  const vr = await vp.evaluate(() => window.__deliver({ type: 'chat-send', text: 'Paused at 1:10. Please explain this part.', voiceBridge: true }));
  await vp.waitForTimeout(500);
  await vp.evaluate(() => window.__deliver({ type: 'voice-restart' }));
  await vp.waitForTimeout(300);
  const card = await yt.evaluate(() => window.__calls.find((c) => c.type === 'pause-send').card);
  const vpic = await vp.evaluate((c) => window.__deliver({ type: 'chat-send', text: 'x', pictureOnly: true, card: { name: 'question-1.jpg', dataUrl: c }, voiceBridge: true }), card);
  await vp.waitForTimeout(500);
  const vpicState = await vp.evaluate(() => ({ sent: window.__sent.slice(-1)[0], events: window.__events.join(',') }));
  ok('voice session + picture only: leaves it for a moment, the PICTURE is sent (no text)', vpic && vpic.ok && vpic.bridged && vpicState.sent && vpicState.sent.text === '' && vpicState.sent.files.join() === 'question-1.jpg', JSON.stringify({ r: vpic && { ok: vpic.ok, err: vpic.error, steps: vpic.steps }, st: vpicState }));
  await vp.waitForTimeout(800);
  const back = await vp.evaluate(() => window.__deliver({ type: 'voice-restart' }));
  await vp.waitForTimeout(300);
  const vs2 = await vp.evaluate(() => ({ sent: window.__sent, events: window.__events }));
  ok('Claude voice session (new screen): leaves it for a moment, the text IS sent, then back into the voice session',
    vr && vr.ok && vr.bridged && vs2.sent.length >= 1 && /Please explain/.test(vs2.sent[0].text) && back && back.ok && vs2.events.join(',').startsWith('end,sent,start'),
    JSON.stringify({ ok: vr && vr.ok, bridged: vr && vr.bridged, err: vr && vr.error, steps: vr && vr.steps, back: back && back.label, events: vs2.events }));
  await vp.close();

  const bg = await ctx.newPage();
  bg.on('pageerror', (e) => console.log('PAGE ERROR (background):', String(e.message || e).slice(0, 300)));
  await bg.addInitScript(fakeSafari, {});
  await bg.goto('http://localhost:8771/chat');
  await bg.evaluate(() => { window.browser.tabs = { query: () => Promise.resolve([{ id: 5, url: 'https://claude.ai/new' }]), sendMessage: () => Promise.resolve({ inCall: true }) }; window.browser.action = {}; });
  await bg.addScriptTag({ content: rd('background.js') });
  const cs = await bg.evaluate(() => window.__deliver({ type: 'call-state', target: 'claude' }));
  ok('background runs on Safari; never plays into a call (Safari cannot), so the text is sent instead', cs && cs.inCall === false, JSON.stringify(cs));
  await bg.evaluate(() => {
    window.browser.runtime.getManifest = () => ({ version: '9.9' });
    window.browser.tabs = { query: () => Promise.resolve([{ id: 1, url: 'https://www.youtube.com/watch?v=x' }, { id: 2, url: 'https://claude.ai/chat/1' }]),
      sendMessage: (id, m) => Promise.resolve(id === 1 ? { video: true, muted: false, subtitles: '120 sentences', touch: true, settings: { sendOn: false, voiceOn: false } }
        : { voiceSession: true, endButton: null, buttons: ['Reading', 'Share'], imageInput: true, composer: 'div', visible: 'visible' }) };
  });
  const dg = await bg.evaluate(() => window.__deliver({ type: 'diagnose' }));
  ok('🩺 Check report names the problems in plain words', dg && /PROBLEMS FOUND \(2\)/.test(dg.report) && /both OFF/.test(dg.report) && /voice session and its End button was not found/.test(dg.report) && /Extension: 9\.9 \(Safari\)/.test(dg.report), (dg && dg.report || '').slice(0, 400));

  await browser.close(); server.close();
  console.log(fails ? fails + ' FAILED' : 'SAFARI BUILD: ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
