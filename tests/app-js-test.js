// Runs the iOS-app JavaScript in Chromium with a stand-in for the Swift side ("native").
const pw = require(process.env.PWMOD || 'playwright');
const engine = process.env.ENGINE || 'chromium'; // chromium or webkit (Safari's engine, what the iPhone uses)
const path = require('path');
const http = require('http'); const fs = require('fs');
const SC = path.resolve(__dirname, '../ios/YTLearn/Scripts') + '/';
const rd = (f) => fs.readFileSync(SC + f, 'utf8');
const swap = (s) => s.replace(/https:\/\/www\.youtube\.com/g, 'http://localhost:8767').replace(/https:\/\/claude\.ai/g, 'http://localhost:8765').replace(/https:\/\/chatgpt\.com/g, 'http://localhost:8768');

const json3 = JSON.stringify({ events: [
  { tStartMs: 0, dDurationMs: 2500, segs: [{utf8:'Hello everyone, welcome'}] },
  { tStartMs: 2500, dDurationMs: 2500, segs: [{utf8:'to the show. Today we'}] },
  { tStartMs: 5000, dDurationMs: 2500, segs: [{utf8:'learn English. It is really'}] },
  { tStartMs: 7500, dDurationMs: 2500, segs: [{utf8:'fun, I think. Let us start'}] },
  { tStartMs: 10000, dDurationMs: 2500, segs: [{utf8:'with a story about a small'}] },
  { tStartMs: 12500, dDurationMs: 2500, segs: [{utf8:'dog. Once upon a time.'}] } ] });
const pr = JSON.stringify({ captions:{ playerCaptionsTracklistRenderer:{ captionTracks:[{ baseUrl:'http://localhost:8767/timedtext?lang=en', languageCode:'en', kind:'asr'}] } } });
const ytHtml = `<!doctype html><title>English Lesson 1 - YouTube</title><div id="movie_player" style="position:relative;width:800px;height:450px;background:#246"><video muted playsinline src="/v.wav" class="html5-main-video" style="width:100%;height:100%"></video></div><div id="below"><h1 class="ytd-watch-metadata"><yt-formatted-string>English Lesson 1</yt-formatted-string></h1></div><script>var ytInitialPlayerResponse = ${pr};</script>`;
const chatHtml = (kind) => `<!doctype html><title>${kind}</title><div id="box" class="ProseMirror" contenteditable="true" style="min-height:40px;border:1px solid #999"></div><input type="file" accept="image/*" id="fimg"><input type="file" multiple id="f"><div id="slot"></div>
<script>window.__sent=[];const b=document.getElementById('box'),f=document.getElementById('f'),slot=document.getElementById('slot');
function upd(){ if(b.textContent.trim()){ if(!slot.firstChild){const x=document.createElement('button');x.setAttribute('aria-label','${kind==='claude'?'Send message':'Send prompt'}');${kind==='chatgpt'?"x.setAttribute('data-testid','send-button');":''}x.textContent='Send';x.onclick=()=>{window.__sent.push({text:b.textContent,files:[...f.files].map(y=>y.name),imgs:[...document.getElementById('fimg').files].map(y=>y.name+':'+y.size)});const fi=document.getElementById('fimg');fi.value='';f.value='';b.textContent='';slot.innerHTML=''};slot.appendChild(x)} } else slot.innerHTML='' }
b.addEventListener('input',upd);</script>`;
// 40 s of silence as a WAV file (8 kHz, 8-bit mono) so the <video> element has something to play
const wav = (() => { const n = 8000 * 40, b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; })();
const serve = (port, fn) => http.createServer(fn).listen(port);
// pages for the "which source is used, and are the times right" tests
const prFor = (len, track) => JSON.stringify(Object.assign({ videoDetails: { videoId: 'abc12345678', title: 'Long Lesson', lengthSeconds: String(len) }, playabilityStatus: { status: 'OK' } },
  track ? { captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'http://localhost:8767/timedtext-empty?lang=en', languageCode: 'en', kind: 'asr' }] } } } : {}));
const apiPage = `<!doctype html><title>Long Lesson - YouTube</title><div id="movie_player" style="position:relative;width:800px;height:450px"><video muted src="/v.wav" class="html5-main-video"></video></div>
<script>var ytInitialPlayerResponse = ${prFor(600, true)};</script><script>var cfg = {"INNERTUBE_API_KEY":"testkey","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.2024"}; var d = {"getTranscriptEndpoint":{"params":"abc\\u003d\\u003d"}};</script>`;
const playerPage = `<!doctype html><title>Player Lesson - YouTube</title><div id="movie_player" style="position:relative;width:800px;height:450px"><video muted src="/v.wav" class="html5-main-video"></video><button class="ytp-subtitles-button" aria-pressed="false">CC</button></div>
<script>var ytInitialPlayerResponse = ${prFor(600, true)};
document.querySelector('.ytp-subtitles-button').onclick=(e)=>{ const b=e.currentTarget; const on=b.getAttribute('aria-pressed')!=='true'; b.setAttribute('aria-pressed', on?'true':'false'); if(on) fetch('/api/timedtext?v=abc12345678&lang=en&kind=asr&pot=XYZ&fmt=srv3'); };</script>`;
const transcriptJson = JSON.stringify({ actions: [{ updateEngagementPanelAction: { content: { transcriptSearchPanelRenderer: { body: { transcriptSegmentListRenderer: { initialSegments:
  Array.from({ length: 40 }, (_, i) => ({ transcriptSegmentRenderer: { startMs: String(i * 15000), endMs: String(i * 15000 + 14000), snippet: { runs: [{ text: 'This is sentence number ' + (i + 1) + ' of the long lesson.' }] } } })) } } } } } }] });
const segHtml = (i, clock, words) => `<ytd-transcript-segment-renderer><div class="segment-timestamp">${clock}</div><yt-formatted-string class="segment-text">Sentence ${i} of the panel lesson ${words}.</yt-formatted-string></ytd-transcript-segment-renderer>`;
const clockText = (sec) => { const m = Math.floor(sec / 60), ss = sec % 60; return m + ':' + String(ss).padStart(2, '0') + ' ' + m + ' minutes, ' + ss + ' seconds'; }; // clock + the same time in words
const panelPage = (len, maxSec) => `<!doctype html><title>Panel Lesson - YouTube</title><div id="movie_player" style="position:relative;width:800px;height:450px"><video muted src="/v.wav" class="html5-main-video"></video></div>
<script>var ytInitialPlayerResponse = ${prFor(len, false)};</script><button id="st">Show transcript</button><div id="panel"></div>
<script>const clock=${clockText.toString()}; const seg=${segHtml.toString()};
document.getElementById('st').onclick=()=>{ const all=[]; for(let i=0;i<40;i++) all.push(i*${Math.floor(maxSec / 40)});
 [0,15,30].forEach((from,bi)=>setTimeout(()=>{ all.slice(from,bi===2?40:from+15).forEach((sec,k)=>document.getElementById('panel').insertAdjacentHTML('beforeend',seg(from+k+1,clock(sec),'x'))); }, 300+bi*700)); };</script>`;
const s1 = serve(8767, (q, r) => {
  if (q.method === 'POST' && q.url.startsWith('/youtubei/v1/get_transcript')) { let b = ''; q.on('data', (c) => b += c); q.on('end', () => { let ok = false; try { ok = JSON.parse(b).params === 'abc=='; } catch (e) { /* no */ } r.setHeader('content-type', 'application/json'); r.end(ok ? transcriptJson : '{"error":"bad params"}'); }); return; }
  if (q.method === 'POST' && q.url.startsWith('/youtubei/v1/player')) { r.setHeader('content-type', 'application/json'); return r.end('{"playabilityStatus":{"status":"LOGIN_REQUIRED"}}'); }
  if (q.url.startsWith('/timedtext-empty')) { r.setHeader('content-type', 'application/json'); return r.end(''); }
  if (q.url.startsWith('/api/timedtext')) { r.setHeader('content-type', 'application/json'); return r.end(/pot=XYZ/.test(q.url) ? json3 : ''); }
  if (q.url.startsWith('/apitest')) { r.setHeader('content-type', 'text/html'); return r.end(apiPage); }
  if (q.url.startsWith('/player')) { r.setHeader('content-type', 'text/html'); return r.end(playerPage); }
  if (q.url.startsWith('/newpanel')) { r.setHeader('content-type', 'text/html'); return r.end(`<!doctype html><title>New Panel - YouTube</title><div id="movie_player" style="position:relative;width:800px;height:450px"><video muted src="/v.wav" class="html5-main-video"></video></div><script>var ytInitialPlayerResponse = ${prFor(300, false)};</script><button id="st">Show transcript</button><div id="panel"></div>
<script>document.getElementById('st').onclick=()=>{ for(let i=0;i<20;i++){ const sec=i*14, m=Math.floor(sec/60), ss=sec%60; document.getElementById('panel').insertAdjacentHTML('beforeend','<transcript-segment-view-model><div class="ytwTranscriptSegmentViewModelTimestamp">'+m+':'+String(ss).padStart(2,'0')+'</div><span class="ytwTranscriptSegmentViewModelTimestampA11yLabel" style="display:none">'+m+' minutes, '+ss+' seconds</span><span class="ytAttributedStringHost">New design sentence '+(i+1)+' of the lesson.</span></transcript-segment-view-model>'); } };</script>`); }
  if (q.url.startsWith('/panelok')) { r.setHeader('content-type', 'text/html'); return r.end(panelPage(600, 585)); }
  if (q.url.startsWith('/stale')) { r.setHeader('content-type', 'text/html'); return r.end(panelPage(60, 1800)); }
  if (q.url.startsWith('/v.wav')) { const rg = q.headers.range; if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], e = m[2] ? +m[2] : wav.length - 1; r.writeHead(206, {'content-type':'audio/wav','accept-ranges':'bytes','content-range':`bytes ${a}-${e}/${wav.length}`,'content-length':e-a+1}); return r.end(wav.slice(a, e+1)); } r.writeHead(200, {'content-type':'audio/wav','accept-ranges':'bytes','content-length':wav.length}); return r.end(wav); }
  if (q.url.startsWith('/timedtext')) { r.setHeader('content-type','application/json'); return r.end(json3); }
  r.setHeader('content-type','text/html'); r.end(q.url.startsWith('/odd') ? oddYtHtml : ytHtml); });
const mobileHtml = `<!doctype html><title>mobile chat</title><textarea id="mobile-composer-prompt" style="width:300px;height:60px"></textarea><input type="file" accept="image/*"><input type="file" accept="image/avif,image/bmp,image/gif,image/jpeg,image/png"><div id="slot"></div>
<script>window.__sent=[];const t=document.getElementById('mobile-composer-prompt'),slot=document.getElementById('slot');
t.addEventListener('input',()=>{ if(t.value.trim()){ if(!slot.firstChild){const x=document.createElement('button');x.setAttribute('data-testid','send-button');x.textContent='Send';x.onclick=()=>{window.__sent.push({text:t.value,files:[...document.querySelectorAll('input[type=file]')].reduce((n,i)=>n+i.files.length,0)});t.value='';slot.innerHTML=''};slot.appendChild(x)} } else slot.innerHTML='' });</script>`;
const oddYtHtml = ytHtml.replace(/<div id="movie_player"[^>]*>/, '<div id="plain-wrapper" style="height:0">').replace('style="width:100%;height:100%"', 'style="width:600px;height:340px"');
const voiceHtml = `<!doctype html><title>Claude voice</title><div>Voice call in progress…</div><input type="file" accept="image/*,.pdf,.txt" id="fimg" multiple>
<script>window.__sent=[];const f=document.getElementById('fimg');f.addEventListener('change',()=>{window.__sent.push({voice:true,imgs:[...f.files].map(y=>y.name+':'+y.size+':'+y.type)});});</script>`;
const s2 = serve(8765, (q, r) => { r.setHeader('content-type','text/html'); r.end(q.url.startsWith('/voice') ? voiceHtml : chatHtml('claude')); });
const s3 = serve(8768, (q, r) => { r.setHeader('content-type','text/html'); r.end(q.url.startsWith('/mobile') ? mobileHtml : chatHtml('chatgpt')); });

(async () => {
  const browser = engine === 'webkit'
    ? await pw.webkit.launch()
    : await pw.chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  console.log('engine:', engine, browser.version());
  const ctx = await browser.newContext();
  const yt = await ctx.newPage(), chat = await ctx.newPage();
  for (const [n, p] of [['yt', yt], ['chat', chat]]) { p.on('pageerror', (e) => console.log('PAGE ERROR (' + n + '):', String(e.message || e).slice(0, 300), '|', String(e.stack || '').split('\n').slice(0, 3).join(' <- '))); }
  const store = { target: 'chatgpt', pauseOn: true, replayOn: true, sendTranscript: true, voiceOn: true, textLevel: 6, tapOn: true, badgeOn: true, sendOn: true };
  const nativeLog = [];
  const native = async (m) => {
    nativeLog.push(m.kind + (m.op ? ':' + m.op : ''));
    switch (m.kind) {
      case 'chatInfo': return { url: chat.url() };
      case 'tabsSend': return await chat.evaluate((x) => window.__ytcDeliver(x), m.msg);
      case 'navigateChat': await chat.goto(swap(m.url).replace(/\/new$/, '/')); await injectChat(); return null;
      case 'storageSet': Object.assign(store, m.obj); return null;
      case 'speech': return null;
      default: return null;
    }
  };
  const bridgeInit = `window.webkit = { messageHandlers: { ytc: { postMessage: (m) => window.__native(m) } } };`;
  for (const p of [yt, chat]) { await p.exposeFunction('__native', native); await p.addInitScript(bridgeInit); }
  async function injectChat() { await chat.evaluate(swap(rd('shim-common.js') + rd('shim-chat.js') + rd('chat.js'))); }
  async function injectYT() { await yt.evaluate(`window.__ytcStorageInit=${JSON.stringify(store)};` + swap(rd('shim-common.js') + rd('shim-youtube.js') + rd('lib.js') + rd('background.js') + rd('youtube.js'))); }
  await chat.goto('http://localhost:8768/'); await injectChat();
  await yt.goto('http://localhost:8767/watch?v=abc12345678'); await injectYT();
  const sent = (p) => p.evaluate(() => window.__sent);
  const vid = () => yt.evaluate(() => { const v = document.querySelector('video'); return { t: +v.currentTime.toFixed(2), paused: v.paused }; });
  const ov = () => yt.evaluate(() => { const e = document.getElementById('yt2c-overlay'); return e ? { text: document.getElementById('yt2c-body').innerText.replace(/\n+/g, ' | '), font: getComputedStyle(document.getElementById('yt2c-body')).fontSize, foot: document.getElementById('yt2c-foot').textContent } : null; });
  let failures = 0;
  const ok = (name, cond, extra) => { if (!cond) failures++; console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); };

  await yt.waitForTimeout(3500);
  console.log('subtitle preload:', JSON.stringify(await yt.evaluate(() => window.__ytcDebug.load())));

  // 1) pause -> subtitles, replay, message in the last second
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.muted = true; await v.play(); v.currentTime = 5; });
  await yt.waitForTimeout(300);
  await yt.evaluate(() => document.querySelector('video').pause());
  await yt.waitForTimeout(700);
  const o1 = await ov();
  ok('subtitles shown after pause', !!(o1 && /Hello everyone/.test(o1.text)), JSON.stringify(o1));
  ok('nothing sent yet (replay running)', (await sent(chat)).length === 0);
  await yt.waitForTimeout(8500);
  const got = await sent(chat);
  ok('replay finished and video stopped', (await vid()).paused === true, JSON.stringify(await vid()));
  ok('ChatGPT mock got exactly 1 message', got.length === 1, got.length);
  ok('first pause: only the paused part, NO full transcript (that goes only with the button)', got[0] && got[0].files.length === 0 && !/Link:|TRANSCRIPT|transcript is attached/.test(got[0].text) && /explain this part to me like an English teacher/.test(got[0].text), got[0] && got[0].text.slice(0, 120));
  ok('speech listening started for "let\'s go"', nativeLog.includes('speech:start'), nativeLog.filter(x => x.startsWith('speech')).join(','));
  // 2) say "let's go" (iOS speech result comes from Swift)
  await yt.evaluate(() => window.__ytcSpeech({ type: 'result', text: "okay let's go" }));
  await yt.waitForTimeout(1200);
  const v2 = await vid();
  ok('"let\'s go" -> back to start of the part and playing', v2.paused === false && v2.t < 3, JSON.stringify(v2));
  ok('speech recogniser stopped', nativeLog.includes('speech:stop'));
  await yt.waitForTimeout(6000);
  ok('keeps playing past the end of the part', (await vid()).t > 6.6 && !(await vid()).paused, JSON.stringify(await vid()));
  ok('overlay gone', (await ov()) === null);

  // 3) second pause in the same chat: passage only (no second transcript)
  await yt.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 9; });
  await yt.waitForTimeout(300);
  await yt.evaluate(() => document.querySelector('video').pause());
  await yt.waitForTimeout(3000);
  console.log('   2nd pause: replay running:', JSON.stringify(await vid()), '| overlay', !!(await ov()));
  await yt.waitForTimeout(10500);
  console.log('   2nd pause: after replay :', JSON.stringify(await vid()), '| last:', store.last);
  const got2 = await sent(chat);
  ok('2nd pause sends a 2nd message', got2.length === 2, got2.length);
  ok('2nd message: passage only, no link/intro', got2[1] && !/Link:/.test(got2[1].text) && /English teacher/.test(got2[1].text));
  // wait until the 2nd replay has stopped, then resume by voice like a user would
  for (let i = 0; i < 60 && !(await vid()).paused; i++) await yt.waitForTimeout(250);
  ok('2nd replay stopped by itself', (await vid()).paused, JSON.stringify(await vid()));
  await yt.evaluate(() => window.__ytcSpeech({ type: 'result', text: 'lets go' }));
  await yt.waitForTimeout(700);
  const v3 = await vid();
  ok('"lets go" (no apostrophe) also resumes from the start of the part', !v3.paused && v3.t < 5, JSON.stringify(v3));

  // 4) toolbar button (Send video) + mode switch to Claude
  await yt.evaluate(() => window.__ytcStorageChanged({ target: 'claude', replayOn: false }));
  const resObj = await yt.evaluate(() => chrome.runtime.sendMessage({ type: 'send', target: 'claude' }));
  const res = resObj && resObj.result;
  ok('button send while chat shows ChatGPT: switches to Claude and sends', /^Sent to Claude/.test(res || ''), res);
  await chat.waitForTimeout(500);
  const claudeMsgs = await sent(chat);
  ok('Claude mock got the video message with the transcript', claudeMsgs.length === 1 && claudeMsgs[0].files.length === 1, JSON.stringify(claudeMsgs).slice(0, 120));

  // 5) pause with replay off -> sends at once, to Claude, passage only; text size setting reaches the page
  await yt.evaluate(() => window.__ytcStorageChanged({ textLevel: 10 }));
  await yt.evaluate(() => { document.querySelector('video').currentTime = 5; });
  await yt.waitForTimeout(300);
  await yt.evaluate(() => document.querySelector('video').pause()); await yt.waitForTimeout(1500);
  const o5 = await ov();
  ok('text size level 10 applied', o5 && parseFloat(o5.font) > 38, o5 && o5.font);
  await yt.waitForTimeout(3000); // Claude gets a picture too: the message goes out 3 s after the stop
  const c5 = await sent(chat);
  ok('replay off: message sent (after the 3 s picture), passage only, to Claude', c5.length === 2 && !/Link:/.test(c5[1].text), c5.length);
  ok('video stayed paused where you paused (no replay)', (await vid()).paused && Math.abs((await vid()).t - 5) < 0.6, JSON.stringify(await vid()));

  // 6) mobile ChatGPT: only image file inputs -> the transcript must be pasted into the message instead
  await yt.goto('http://localhost:8767/watch?v=abc12345678'); await injectYT();
  await chat.goto('http://localhost:8768/mobile'); await injectChat();
  await yt.evaluate(() => window.__ytcStorageChanged({ target: 'chatgpt' }));
  const resM = await yt.evaluate(() => chrome.runtime.sendMessage({ type: 'send', target: 'chatgpt' }));
  const gotM = await sent(chat);
  ok('image-only file inputs: message still sent', /^Sent to ChatGPT/.test((resM && resM.result) || ''), resM && resM.result);
  ok('transcript pasted into the message (not attached)', gotM.length === 1 && /--- TRANSCRIPT ---/.test(gotM[0].text) && gotM[0].files === 0 && /pasted at the end of this message/.test(gotM[0].text) && !/is attached/.test(gotM[0].text), gotM[0] && gotM[0].text.slice(-120).replace(/\n/g, ' | '));

  // 7) a page layout where the player box has no size: the subtitles must still cover the video
  await yt.goto('http://localhost:8767/odd?v=abc12345678'); await injectYT();
  await yt.evaluate(() => window.__ytcStorageChanged({ replayOn: false, target: 'chatgpt' }));
  await yt.waitForTimeout(3500);
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.muted = true; await v.play(); v.currentTime = 5; });
  await yt.waitForTimeout(300);
  await yt.evaluate(() => document.querySelector('video').pause());
  await yt.waitForTimeout(1200);
  const odd = await yt.evaluate(() => { const o = document.getElementById('yt2c-overlay'); const v = document.querySelector('video'); if (!o) return null; const a = o.getBoundingClientRect(), b = v.getBoundingClientRect(); return { pos: getComputedStyle(o).position, overlay: [Math.round(a.left), Math.round(a.top), Math.round(a.width), Math.round(a.height)], video: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], font: getComputedStyle(document.getElementById('yt2c-body')).fontSize }; });
  ok('zero-size player box: subtitles use a fixed overlay exactly over the video', odd && odd.pos === 'fixed' && JSON.stringify(odd.overlay) === JSON.stringify(odd.video), JSON.stringify(odd));
  ok('...and the text is a sane size there', odd && parseFloat(odd.font) >= 14 && parseFloat(odd.font) <= 120, odd && odd.font);

  // 8) touching the video (iPhone / iPad app): pause + send, touch again = "let's go"; the status label tells what happens
  await yt.goto('http://localhost:8767/watch?v=abc12345678'); await injectYT();
  await yt.evaluate(() => window.__ytcStorageChanged({ replayOn: true, target: 'chatgpt' }));
  await yt.waitForTimeout(3500);
  const badge1 = await yt.evaluate(() => { const b = document.getElementById('yt2c-badge'); return b && b.textContent; });
  ok('status label shows video found + subtitles read', !!badge1 && /video ✓/.test(badge1) && /subtitles: \d+ sentences/.test(badge1), badge1);
  const rect = await yt.evaluate(() => { const r = document.querySelector('video').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const hit = (fx, fy) => yt.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.id || e.tagName : null; }, [rect.x + rect.w * fx, rect.y + rect.h * fy]);
  ok('middle of the picture is the touch area', (await hit(0.5, 0.45)) === 'yt2c-tap', await hit(0.5, 0.45));
  ok('bottom bar of the player is NOT covered', (await hit(0.5, 0.95)) !== 'yt2c-tap', await hit(0.5, 0.95));
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.muted = true; await v.play(); v.currentTime = 5; });
  await yt.waitForTimeout(400);
  const before = (await sent(chat)).length;
  await yt.mouse.click(rect.x + rect.w * 0.5, rect.y + rect.h * 0.45);
  await yt.waitForTimeout(900);
  ok('touch on a playing video pauses it and shows the sentences', /Hello everyone/.test(((await ov()) || {}).text || ''), JSON.stringify(await ov()));
  await yt.waitForTimeout(9500);
  ok('...and the sentences were sent (exactly one new message)', (await sent(chat)).length === before + 1, (await sent(chat)).length + ' vs ' + before);
  const badge2 = await yt.evaluate(() => document.getElementById('yt2c-badge').textContent);
  ok('status label says sent', /sent to ChatGPT ✓/.test(badge2), badge2);
  ok('replay stopped by itself', (await vid()).paused, JSON.stringify(await vid()));
  await yt.mouse.click(rect.x + rect.w * 0.5, rect.y + rect.h * 0.45);
  await yt.waitForTimeout(900);
  const v8 = await vid();
  ok('touch on the stopped video = "let\'s go" (start of the part, playing)', !v8.paused && v8.t < 4, JSON.stringify(v8));
  ok('overlay gone after "let\'s go"', (await ov()) === null);

  // 9) talking with the AI: a spoken question goes into the same chat; the app can read the newest answer
  const countBefore = (await sent(chat)).length;
  const askRes = await yt.evaluate(() => chrome.runtime.sendMessage({ type: 'ask', text: 'What does dangling mean?', target: 'chatgpt' }));
  const afterAsk = await sent(chat);
  ok('spoken question is sent to the chat', /^Sent to ChatGPT/.test((askRes && askRes.result) || '') && afterAsk.length === countBefore + 1, askRes && askRes.result);
  const last = afterAsk[afterAsk.length - 1];
  ok('question: your words + "simple English", no transcript again', last && /What does dangling mean\?/.test(last.text) && /simple English/.test(last.text) && !/TRANSCRIPT/.test(last.text) && last.files === 0, last && last.text.slice(0, 160));
  const st0 = await chat.evaluate(() => window.__ytcReplyState());
  ok('reply reader: no answer yet', st0.count === 0 && st0.text === '' && st0.busy === false, JSON.stringify(st0));
  await chat.evaluate(() => { const d = document.createElement('div'); d.setAttribute('data-message-author-role', 'assistant'); d.textContent = 'Dangling means hanging.'; document.body.appendChild(d); const b = document.createElement('button'); b.id = 'stopper'; b.setAttribute('data-testid', 'stop-button'); document.body.appendChild(b); });
  const st1 = await chat.evaluate(() => window.__ytcReplyState());
  ok('reply reader: sees the newest answer and that it is still being written', st1.count === 1 && st1.text === 'Dangling means hanging.' && st1.busy === true, JSON.stringify(st1));
  await chat.evaluate(() => document.getElementById('stopper').remove());
  const st2 = await chat.evaluate(() => window.__ytcReplyState());
  ok('reply reader: finished when the stop button is gone', st2.busy === false, JSON.stringify(st2));

  // 10) a question with no video open: only the question is sent (no transcript, no link)
  await yt.goto('http://localhost:8767/'); await injectYT();
  await yt.waitForTimeout(500);
  const n10 = (await sent(chat)).length;
  const ask10 = await yt.evaluate(() => chrome.runtime.sendMessage({ type: 'ask', text: 'How do I say hello politely?', target: 'chatgpt' }));
  const after10 = await sent(chat);
  const m10 = after10[after10.length - 1];
  ok('question without a video: sent, question only', /^Sent to ChatGPT/.test((ask10 && ask10.result) || '') && after10.length === n10 + 1 && m10 && /polite/.test(m10.text) && !/TRANSCRIPT|Link:|transcript/.test(m10.text) && m10.files === 0, ask10 && ask10.result);

  // 11) Claude gets a picture of the paused video together with the words; ChatGPT gets the words only
  await yt.goto('http://localhost:8767/watch?v=abc12345678'); await injectYT();
  await yt.evaluate(() => { Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { get: () => 640 }); Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get: () => 360 }); });
  await chat.goto('http://localhost:8765/'); await injectChat();
  await yt.evaluate(() => window.__ytcStorageChanged({ target: 'claude', replayOn: false, imageOn: true }));
  await yt.waitForTimeout(3500);
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.muted = true; await v.play(); v.currentTime = 5; });
  await yt.waitForTimeout(300);
  await yt.evaluate(() => document.querySelector('video').pause());
  await yt.waitForTimeout(500);
  const early = await sent(chat);
  await yt.waitForTimeout(4200); // the picture is taken 3 s after the stop, then the message goes out
  const cl = await sent(chat);
  const lastCl = cl[cl.length - 1];
  ok('Claude: nothing is sent before the 3-second picture is ready (replay off)', early.length === 0, String(early.length));
  ok('Claude: pause sends the words AND a picture together', cl.length === 1 && lastCl && /English teacher/.test(lastCl.text) && lastCl.imgs.length === 1 && /^video-\d+\.jpg:[1-9]/.test(lastCl.imgs[0]), JSON.stringify(cl).slice(0, 200));
  const pic = await yt.evaluate(async () => {
    const seg = { items: [{ text: 'Hello everyone, welcome to the show today.' }, { text: 'Today we are going to learn English together.' }] };
    const url = await window.__ytcDebug.picture(seg);
    if (!url) return null;
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let white = 0, yellow = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) { const r = d[i], gg = d[i + 1], b = d[i + 2]; if (r > 200 && gg > 200 && b > 200) white++; else if (r > 200 && gg > 170 && b < 90) yellow++; else if (r < 40 && gg < 40 && b < 40) dark++; }
    return { w: img.width, h: img.height, white, yellow, dark };
  });
  ok('subtitle picture: 16:9 black screen with white text and the last sentence in yellow', pic && pic.w === 1280 && pic.h === 720 && pic.white > 2000 && pic.yellow > 500 && pic.dark > pic.w * pic.h * 0.6, JSON.stringify(pic));
  await chat.goto('http://localhost:8768/'); await injectChat();
  await yt.evaluate(() => { document.querySelector('video').play(); });
  await yt.waitForTimeout(400);
  await yt.evaluate(() => window.__ytcStorageChanged({ target: 'chatgpt' }));
  await yt.evaluate(() => { document.querySelector('video').currentTime = 6; });
  await yt.waitForTimeout(300);
  await yt.evaluate(() => document.querySelector('video').pause());
  await yt.waitForTimeout(2500);
  const gp = await sent(chat);
  ok('ChatGPT: words only, no picture', gp.length === 1 && gp[0].imgs.length === 0 && /English teacher/.test(gp[0].text), JSON.stringify(gp).slice(0, 200));
  await chat.goto('http://localhost:8765/'); await injectChat();
  await yt.evaluate(() => window.__ytcStorageChanged({ target: 'claude', imageOn: false }));
  await yt.evaluate(() => { document.querySelector('video').play(); });
  await yt.waitForTimeout(400);
  await yt.evaluate(() => { document.querySelector('video').currentTime = 7; });
  await yt.waitForTimeout(300);
  await yt.evaluate(() => document.querySelector('video').pause());
  await yt.waitForTimeout(2500);
  const off = await sent(chat);
  ok('Claude with the picture option off: words only', off.length === 1 && off[0].imgs.length === 0, JSON.stringify(off).slice(0, 160));

  // 12) which source is used, and are the times right? (long videos, hidden time copies, wrong-video panel)
  const loadOn = async (url) => { delete store.subsCache; await yt.goto(url); await injectYT(); await yt.waitForTimeout(400); return yt.evaluate(() => window.__ytcDebug.load()); };
  const viaApi = await loadOn('http://localhost:8767/apitest?v=abc12345678');
  ok('captions refused (empty file): the transcript service gives all 40 lines with exact times', viaApi.source === 'YouTube transcript service' && viaApi.lines === 40 && Math.round(viaApi.lastStart) === 585, JSON.stringify(viaApi).slice(0, 260));
  const viaPanel = await loadOn('http://localhost:8767/panelok?v=abc12345678');
  ok('panel filled in 3 pieces: ALL 40 lines are read (waits until it stops growing)', /transcript panel \(40 lines\)/.test(viaPanel.source || ''), JSON.stringify(viaPanel).slice(0, 260));
  ok('panel: times read from the clock only (not "9 minutes, 45 seconds")', Math.round(viaPanel.lastStart) === 546, 'last start ' + viaPanel.lastStart);
  const viaNew = await loadOn('http://localhost:8767/newpanel?v=abc12345678');
  ok('newer YouTube panel design is read too (20 lines, right times, no doubled/hidden text)', /transcript panel \(20 lines\)/.test(viaNew.source || '') && Math.round(viaNew.lastStart) === 266 && /New design sentence 1 of the lesson/.test(viaNew.first || ''), JSON.stringify(viaNew).slice(0, 260));
  const viaStale = await loadOn('http://localhost:8767/stale?v=abc12345678');
  ok('wrong-video panel (times run to 30 min in a 1-min video) is refused, not used', viaStale.lines === 0 && /run past the end of the video/.test(viaStale.errors.join(' ')), JSON.stringify(viaStale).slice(0, 300));
  const viaPlayer = await loadOn('http://localhost:8767/player?v=abc12345678');
  const ccAfter = await yt.evaluate(() => document.querySelector('.ytp-subtitles-button').getAttribute('aria-pressed'));
  ok('captions refused everywhere else: reads the subtitles the PLAYER downloaded (CC switched on for a moment)', /the subtitles the player loaded \(en\)/.test(viaPlayer.source || '') && viaPlayer.lines === 6, JSON.stringify(viaPlayer).slice(0, 300));
  ok('...and the CC button is put back to off', ccAfter === 'false', ccAfter);
  store.manualSubs = { abc12345678: [{ start: 0, text: 'Loaded by hand line one.' }, { start: 4, text: 'Loaded by hand line two.' }, { start: 8, text: 'Loaded by hand line three.' }] };
  const viaFile = await loadOn('http://localhost:8767/stale?v=abc12345678');
  ok('a subtitle file you loaded is always used first (even if the panel is wrong)', /subtitle file you loaded \(3 lines\)/.test(viaFile.source || '') && viaFile.lines === 3 && /Loaded by hand line one/.test(viaFile.first || ''), JSON.stringify(viaFile).slice(0, 260));
  delete store.manualSubs;
  ok('title comes from the video data, with its own length known', viaApi.title === 'Long Lesson', viaApi.title);

  // 13) saved copy ("database"): opens instantly in a new window; the bar under the video; the timeline in every message
  delete store.subsCache;
  const first13 = await loadOn('http://localhost:8767/apitest?v=abc12345678');
  await yt.waitForTimeout(300);
  ok('the full subtitles are saved after the first download', !!(store.subsCache && store.subsCache.abc12345678 && store.subsCache.abc12345678.cues.length === 40), store.subsCache ? Object.keys(store.subsCache).join(',') : 'nothing saved');
  const second13 = await (async () => { await yt.goto('http://localhost:8767/panelok?v=abc12345678'); await injectYT(); await yt.waitForTimeout(400); return yt.evaluate(() => window.__ytcDebug.load()); })();
  ok('new window: the saved copy is used at once (no download)', /saved copy/.test(second13.source || '') && second13.lines === 40 && Math.round(second13.lastStart) === 585, JSON.stringify(second13).slice(0, 220));
  // the two on/off buttons under the video (green = on, red = off)
  await yt.goto('http://localhost:8767/watch?v=abc12345678'); await injectYT();
  await yt.evaluate(() => window.__ytcStorageChanged({ sendOn: false, target: 'chatgpt', replayOn: false, imageOn: true }));
  await yt.waitForTimeout(900);
  const btns = () => yt.evaluate(() => { const b = document.getElementById('yt2c-bar'); if (!b) return null; const col = (id) => { const e = document.getElementById(id); return { text: e.textContent, bg: getComputedStyle(e).backgroundColor }; }; const p = document.getElementById('movie_player'); return { parent: b.parentElement.id, below: !!(p.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), h: Math.round(b.getBoundingClientRect().height), gpt: col('yt2c-b-chatgpt'), claude: col('yt2c-b-claude'), status: document.getElementById('yt2c-b-status').textContent }; });
  const GREENC = 'rgb(30, 142, 62)', REDC = 'rgb(217, 48, 37)';
  const pauseAt = async (t, wait) => { await yt.evaluate(async (x) => { const v = document.querySelector('video'); v.muted = true; await v.play(); v.currentTime = x; }, t); await yt.waitForTimeout(300); await yt.evaluate(() => document.querySelector('video').pause()); await yt.waitForTimeout(wait || 2200); };
  let b0 = await btns();
  ok('two buttons right under the video: ChatGPT and Claude, both red (off) at the start', b0 && b0.parent === 'below' && b0.below && b0.h < 45 && /ChatGPT ○ off/.test(b0.gpt.text) && /Claude ○ off/.test(b0.claude.text) && b0.gpt.bg === REDC && b0.claude.bg === REDC, JSON.stringify(b0));
  await chat.goto('http://localhost:8768/'); await injectChat();
  await pauseAt(5);
  const foot0 = (await ov() || {}).foot || '';
  ok('both off: a pause still shows the subtitles but sends NOTHING', (await sent(chat)).length === 0 && /press ChatGPT or Claude under the video/.test(foot0), foot0);
  await yt.evaluate(() => document.getElementById('yt2c-b-chatgpt').click());
  await yt.waitForTimeout(2500);
  let b1 = await btns(); let m1 = await sent(chat);
  ok('press ChatGPT: it turns green, Claude stays red', b1.gpt.bg === GREENC && /on/.test(b1.gpt.text) && b1.claude.bg === REDC && store.sendOn === true && store.target === 'chatgpt', JSON.stringify(b1));
  ok('...and the link + FULL transcript go to ChatGPT once (as a file, general input)', m1.length === 1 && /Link:/.test(m1[0].text) && m1[0].files.length === 1 && /^transcript-/.test(m1[0].files[0]) && /full transcript sent to ChatGPT/.test(b1.status), JSON.stringify(m1).slice(0, 200) + ' | ' + b1.status);
  await pauseAt(9); await pauseAt(13);
  const m2 = await sent(chat);
  ok('then every pause sends ONLY that part (no transcript, no link), twice in a row', m2.length === 3 && m2.slice(1).every((x) => x.files.length === 0 && !/Link:|TRANSCRIPT/.test(x.text) && /English teacher/.test(x.text)), JSON.stringify(m2.slice(1).map((x) => [x.files.length, x.text.slice(0, 60)])));
  await yt.evaluate(() => document.getElementById('yt2c-b-chatgpt').click());
  await yt.waitForTimeout(400);
  const b2 = await btns();
  await pauseAt(6);
  ok('press ChatGPT again: red, and pauses are not sent any more', b2.gpt.bg === REDC && b2.claude.bg === REDC && store.sendOn === false && (await sent(chat)).length === 3, JSON.stringify(b2));
  await chat.goto('http://localhost:8765/'); await injectChat();
  await yt.evaluate(() => document.getElementById('yt2c-b-claude').click());
  await yt.waitForTimeout(2500);
  const b3 = await btns(); const c3 = await sent(chat);
  ok('press Claude: Claude green, ChatGPT red, full transcript sent to Claude once', b3.claude.bg === GREENC && b3.gpt.bg === REDC && store.target === 'claude' && c3.length === 1 && /Link:/.test(c3[0].text) && c3[0].files.length === 1, JSON.stringify(b3) + ' ' + c3.length);
  await pauseAt(9, 4800);
  const c4 = await sent(chat);
  ok('Claude pause: only that part (+ the picture), no transcript again', c4.length === 2 && c4[1].files.length === 0 && !/Link:/.test(c4[1].text) && c4[1].imgs.length === 1, JSON.stringify(c4[1] || {}).slice(0, 160));
  // back to ChatGPT (on) for the timeline check
  await chat.goto('http://localhost:8768/'); await injectChat();
  await yt.evaluate(() => document.getElementById('yt2c-b-chatgpt').click());
  await yt.waitForTimeout(2500);
  // timeline in the pause message
  await yt.evaluate(() => window.__ytcStorageChanged({ replayOn: false, target: 'chatgpt' }));
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.muted = true; await v.play(); v.currentTime = 9; });
  await yt.waitForTimeout(300);
  await yt.evaluate(() => document.querySelector('video').pause());
  await yt.waitForTimeout(2500);
  const t13 = await sent(chat);
  ok('every pause message carries the timeline (paused at, from-to)', /Paused at 0:0\d\. This part of the video runs from 0:00 to 0:\d\d \(find it in the transcript timeline\)\./.test(t13[t13.length - 1].text), t13[t13.length - 1].text.slice(0, 140));

  // 14) Claude voice mode (no text box): only a picture can go in, so it carries the sentences and the question
  await yt.goto('http://localhost:8767/watch?v=abc12345678'); await injectYT();
  await yt.evaluate(() => { Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { get: () => 640, configurable: true }); Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get: () => 360, configurable: true }); });
  await chat.goto('http://localhost:8765/voice'); await injectChat();
  await yt.evaluate(() => window.__ytcStorageChanged({ target: 'claude', sendOn: true, replayOn: false, imageOn: true }));
  await yt.waitForTimeout(3500);
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.muted = true; await v.play(); v.currentTime = 9; });
  await yt.waitForTimeout(300);
  await yt.evaluate(() => document.querySelector('video').pause());
  await yt.waitForTimeout(8500);
  const vs = await sent(chat);
  const vlast = store.last || '';
  ok('voice mode: exactly one picture goes in (the card with words + question)', vs.length === 1 && vs[0].imgs.length === 1 && /^question-\d+\.jpg:[1-9]\d+:image\/jpeg$/.test(vs[0].imgs[0]), JSON.stringify(vs));
  ok('voice mode: the status says why only a picture was sent', /voice mode/i.test(vlast), vlast.slice(0, 200));
  const card = await yt.evaluate(async () => {
    const seg = { start: 0, end: 13, pausedAt: 9, items: [{ text: 'Hello everyone, welcome to the show today.' }, { text: 'Today we are going to learn English together.' }] };
    const url = await (async () => window.__ytcDebug.card(seg))();
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const px = (x0, y0, w, h) => { const d = g.getImageData(x0, y0, w, h).data; let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 300) lit++; return lit; };
    return { w: img.width, h: img.height, header: px(40, 20, 1200, 40), footer: px(40, 640, 1200, 70), middle: px(40, 200, 1200, 300) };
  });
  ok('card picture: has a header (time), the sentences, and the question at the bottom', card.w === 1280 && card.header > 300 && card.footer > 300 && card.middle > 3000, JSON.stringify(card));
  console.log('native calls seen:', [...new Set(nativeLog)].join(', '));
  console.log('storage persisted to native:', JSON.stringify(store));
  await browser.close(); s1.close(); s2.close(); s3.close();
  console.log(failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
