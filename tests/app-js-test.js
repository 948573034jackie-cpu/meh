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
const ytHtml = `<!doctype html><title>English Lesson 1 - YouTube</title><h1 class="ytd-watch-metadata"><yt-formatted-string>English Lesson 1</yt-formatted-string></h1><div id="movie_player" style="position:relative;width:800px;height:450px;background:#246"><video muted playsinline src="/v.wav" class="html5-main-video" style="width:100%;height:100%"></video></div><script>var ytInitialPlayerResponse = ${pr};</script>`;
const chatHtml = (kind) => `<!doctype html><title>${kind}</title><div id="box" class="ProseMirror" contenteditable="true" style="min-height:40px;border:1px solid #999"></div><input type="file" accept="image/*" id="fimg"><input type="file" multiple id="f"><div id="slot"></div>
<script>window.__sent=[];const b=document.getElementById('box'),f=document.getElementById('f'),slot=document.getElementById('slot');
function upd(){ if(b.textContent.trim()){ if(!slot.firstChild){const x=document.createElement('button');x.setAttribute('aria-label','${kind==='claude'?'Send message':'Send prompt'}');${kind==='chatgpt'?"x.setAttribute('data-testid','send-button');":''}x.textContent='Send';x.onclick=()=>{window.__sent.push({text:b.textContent,files:[...f.files].map(y=>y.name),imgs:[...document.getElementById('fimg').files].map(y=>y.name+':'+y.size)});const fi=document.getElementById('fimg');fi.value='';b.textContent='';slot.innerHTML=''};slot.appendChild(x)} } else slot.innerHTML='' }
b.addEventListener('input',upd);</script>`;
// 40 s of silence as a WAV file (8 kHz, 8-bit mono) so the <video> element has something to play
const wav = (() => { const n = 8000 * 40, b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; })();
const serve = (port, fn) => http.createServer(fn).listen(port);
const s1 = serve(8767, (q, r) => {
  if (q.url.startsWith('/v.wav')) { const rg = q.headers.range; if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], e = m[2] ? +m[2] : wav.length - 1; r.writeHead(206, {'content-type':'audio/wav','accept-ranges':'bytes','content-range':`bytes ${a}-${e}/${wav.length}`,'content-length':e-a+1}); return r.end(wav.slice(a, e+1)); } r.writeHead(200, {'content-type':'audio/wav','accept-ranges':'bytes','content-length':wav.length}); return r.end(wav); }
  if (q.url.startsWith('/timedtext')) { r.setHeader('content-type','application/json'); return r.end(json3); }
  r.setHeader('content-type','text/html'); r.end(q.url.startsWith('/odd') ? oddYtHtml : ytHtml); });
const mobileHtml = `<!doctype html><title>mobile chat</title><textarea id="mobile-composer-prompt" style="width:300px;height:60px"></textarea><input type="file" accept="image/*"><input type="file" accept="image/avif,image/bmp,image/gif,image/jpeg,image/png"><div id="slot"></div>
<script>window.__sent=[];const t=document.getElementById('mobile-composer-prompt'),slot=document.getElementById('slot');
t.addEventListener('input',()=>{ if(t.value.trim()){ if(!slot.firstChild){const x=document.createElement('button');x.setAttribute('data-testid','send-button');x.textContent='Send';x.onclick=()=>{window.__sent.push({text:t.value,files:[...document.querySelectorAll('input[type=file]')].reduce((n,i)=>n+i.files.length,0)});t.value='';slot.innerHTML=''};slot.appendChild(x)} } else slot.innerHTML='' });</script>`;
const oddYtHtml = ytHtml.replace(/<div id="movie_player"[^>]*>/, '<div id="plain-wrapper" style="height:0">').replace('style="width:100%;height:100%"', 'style="width:600px;height:340px"');
const s2 = serve(8765, (q, r) => { r.setHeader('content-type','text/html'); r.end(chatHtml('claude')); });
const s3 = serve(8768, (q, r) => { r.setHeader('content-type','text/html'); r.end(q.url.startsWith('/mobile') ? mobileHtml : chatHtml('chatgpt')); });

(async () => {
  const browser = engine === 'webkit'
    ? await pw.webkit.launch()
    : await pw.chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  console.log('engine:', engine, browser.version());
  const ctx = await browser.newContext();
  const yt = await ctx.newPage(), chat = await ctx.newPage();
  for (const [n, p] of [['yt', yt], ['chat', chat]]) { p.on('pageerror', (e) => console.log('PAGE ERROR (' + n + '):', String(e.message || e).slice(0, 300), '|', String(e.stack || '').split('\n').slice(0, 3).join(' <- '))); }
  const store = { target: 'chatgpt', pauseOn: true, replayOn: true, sendTranscript: true, voiceOn: true, textLevel: 6, tapOn: true, badgeOn: true };
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
  ok('message has transcript file + no filler', got[0] && got[0].files.includes('transcript-English-Lesson-1.txt') && /explain this part to me like an English teacher/.test(got[0].text) && !/repeat this passage/.test(got[0].text));
  ok('picked the general file input, not the image one', got[0] && got[0].files.length === 1);
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
  const c5 = await sent(chat);
  ok('replay off: message sent at once, passage only, to Claude', c5.length === 2 && !/Link:/.test(c5[1].text), c5.length);
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
  await yt.waitForTimeout(2500);
  const cl = await sent(chat);
  const lastCl = cl[cl.length - 1];
  ok('Claude: pause sends the words AND a picture together', cl.length === 1 && lastCl && /English teacher/.test(lastCl.text) && lastCl.imgs.length === 1 && /^video-\d+\.jpg:[1-9]/.test(lastCl.imgs[0]), JSON.stringify(cl).slice(0, 200));
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
  console.log('native calls seen:', [...new Set(nativeLog)].join(', '));
  console.log('storage persisted to native:', JSON.stringify(store));
  await browser.close(); s1.close(); s2.close(); s3.close();
  console.log(failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
