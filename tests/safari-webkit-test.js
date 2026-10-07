// Runs the SAFARI build of the extension (safari/Extension) in WebKit, Safari's engine, with a stand-in for
// Safari's promise-based "browser" API. Checks: the shim switches to "browser", the buttons work, a pause sends
// the ~30 s part, the chat page types and sends the text, and the background script answers like on Safari.
const pw = require(process.env.PWMOD || 'playwright');
const path = require('path'); const fs = require('fs'); const http = require('http');
const EXT = path.resolve(__dirname, '../safari/Extension') + '/';
const rd = (f) => fs.readFileSync(EXT + f, 'utf8');
let fails = 0;
const ok = (name, cond, info) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (info ? '  ' + String(info).slice(0, 300) : '')); if (!cond) fails++; };

const cues = Array.from({ length: 30 }, (_, i) => ({ tStartMs: i * 4000, dDurationMs: 4000, segs: [{ utf8: 'This is sentence number ' + (i + 1) + ' of the lesson.' }] }));
const json3 = JSON.stringify({ events: cues });
const pr = JSON.stringify({ videoDetails: { videoId: 'abc12345678', title: 'English Lesson 1', lengthSeconds: '120' }, playabilityStatus: { status: 'OK' },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'http://localhost:8771/timedtext?lang=en', languageCode: 'en', kind: 'asr' }] } } });
const ytHtml = `<!doctype html><title>English Lesson 1 - YouTube</title><div id="movie_player" style="position:relative;width:800px;height:450px;background:#246"><video muted playsinline src="/v.wav" class="html5-main-video" style="width:100%;height:100%"></video></div><div id="below"><h1 class="ytd-watch-metadata"><yt-formatted-string>English Lesson 1</yt-formatted-string></h1></div><script>var ytInitialPlayerResponse = ${pr};</script>`;
const chatHtml = `<!doctype html><title>Claude</title><div id="box" class="ProseMirror" contenteditable="true" style="min-height:40px;border:1px solid #999"></div><input type="file" multiple id="f"><div id="slot"></div>
<script>window.__sent=[];const b=document.getElementById('box'),f=document.getElementById('f'),slot=document.getElementById('slot');
b.addEventListener('input',()=>{ if(b.textContent.trim()&&!slot.firstChild){const x=document.createElement('button');x.setAttribute('aria-label','Send message');x.textContent='Send';x.onclick=()=>{window.__sent.push({text:b.textContent,files:[...f.files].map(y=>y.name)});f.value='';b.textContent='';slot.innerHTML=''};slot.appendChild(x)} else if(!b.textContent.trim()) slot.innerHTML=''; });</script>`;
const wav = (() => { const n = 8000 * 120, b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; })();
const server = http.createServer((q, r) => {
  if (q.url.startsWith('/v.wav')) { const rg = q.headers.range; if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], e = m[2] ? +m[2] : wav.length - 1; r.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${e}/${wav.length}`, 'content-length': e - a + 1 }); return r.end(wav.slice(a, e + 1)); } r.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': wav.length }); return r.end(wav); }
  if (q.url.startsWith('/timedtext') || q.url.startsWith('/api/timedtext')) { r.setHeader('content-type', 'application/json'); return r.end(json3); }
  r.setHeader('content-type', 'text/html'); r.end(q.url.startsWith('/chat') ? chatHtml : ytHtml);
}).listen(8771);

// Safari's API: everything returns a promise. "chrome" is a decoy WITHOUT promises, so the test fails if the shim is not used.
const fakeSafari = (store) => {
  window.__calls = []; window.__listeners = [];
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
  await yt.evaluate(() => { window.__reply = (msg) => msg.type === 'call-state' ? { inCall: false } : msg.type === 'capture' ? { dataUrl: null } : { result: 'Sent to Claude: ok' }; });
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

  const chat = await ctx.newPage();
  chat.on('pageerror', (e) => console.log('PAGE ERROR (chat):', String(e.message || e).slice(0, 300)));
  await chat.addInitScript(fakeSafari, {});
  await chat.goto('http://localhost:8771/chat');
  for (const f of m.content_scripts[1].js) await chat.addScriptTag({ content: rd(f) });
  const res = await chat.evaluate(() => window.__deliver({ type: 'chat-send', text: 'Paused at 0:50. Please explain this part.' }));
  await chat.waitForTimeout(1500);
  const sent = await chat.evaluate(() => window.__sent);
  ok('Claude page: the text is typed and sent', res && res.ok && sent.length === 1 && /Please explain this part/.test(sent[0].text), JSON.stringify(res).slice(0, 150) + ' ' + JSON.stringify(sent));

  const bg = await ctx.newPage();
  bg.on('pageerror', (e) => console.log('PAGE ERROR (background):', String(e.message || e).slice(0, 300)));
  await bg.addInitScript(fakeSafari, {});
  await bg.goto('http://localhost:8771/chat');
  await bg.evaluate(() => { window.browser.tabs = { query: () => Promise.resolve([{ id: 5, url: 'https://claude.ai/new' }]), sendMessage: () => Promise.resolve({ inCall: true }) }; window.browser.action = {}; });
  await bg.addScriptTag({ content: rd('background.js') });
  const cs = await bg.evaluate(() => window.__deliver({ type: 'call-state', target: 'claude' }));
  ok('background runs on Safari; never plays into a call (Safari cannot), so the text is sent instead', cs && cs.inCall === false, JSON.stringify(cs));

  await browser.close(); server.close();
  console.log(fails ? fails + ' FAILED' : 'SAFARI BUILD: ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
