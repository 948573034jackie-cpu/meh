// End-to-end: loads the REAL unpacked Chrome extension; fake youtube.com / chatgpt.com pages are served by routing.
const pw = require(process.env.PWMOD || 'playwright');
const path = require('path');
const EXT = path.resolve(__dirname, '../youtube-to-claude');
const json3 = JSON.stringify({ events: Array.from({ length: 15 }, (_, i) => ({ tStartMs: i * 4000, dDurationMs: 4000, segs: [{ utf8: i === 5 ? 'Hi bro, how are you doing today my friend?' : 'This is complete sentence number ' + (i + 1) + ' of the lesson.' }] })) });
const pr = JSON.stringify({ videoDetails: { videoId: 'abc12345678', title: 'English Lesson 1', lengthSeconds: '60' }, playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=abc12345678&lang=en', languageCode: 'en' }] } } });
const wav = (() => { const n = 8000 * 60, b = Buffer.alloc(44 + n, 128); for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(70 * Math.sin(2 * Math.PI * 440 * i / 8000)); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; })();
const ytHtml = `<!doctype html><title>English Lesson 1 - YouTube</title><body style="background:#fff"><div id="movie_player" class="html5-video-player" style="position:relative;width:800px;height:450px;background:#123"><video muted playsinline src="https://www.youtube.com/v.wav" class="html5-main-video" style="width:100%;height:100%"></video></div><div id="below"><h1 class="ytd-watch-metadata">English Lesson 1</h1></div><script>var ytInitialPlayerResponse = ${pr};</script></body>`;
const chatHtml = `<!doctype html><title>ChatGPT</title><textarea id="prompt-textarea" style="width:500px;height:80px"></textarea><input type="file" multiple id="f"><div id="slot"></div>
<script>window.__sent=[];const t=document.getElementById('prompt-textarea'),f=document.getElementById('f'),slot=document.getElementById('slot');
t.addEventListener('input',()=>{ if(t.value.trim()&&!slot.firstChild){const x=document.createElement('button');x.setAttribute('data-testid','send-button');x.textContent='Send';x.onclick=()=>{const q=t.value;window.__sent.push({text:q,files:[...f.files].map(y=>y.name)});t.value='';f.value='';slot.innerHTML='';setTimeout(()=>{const a=document.createElement('div');a.setAttribute('data-message-author-role','assistant');a.textContent='Answer number '+window.__sent.length+'. This part means the speaker is happy.';document.body.appendChild(a);},700)};slot.appendChild(x)} });</script>`;
const claudeCallHtml = `<!doctype html><title>Claude</title>
<div id="call"><div>Voice call in progress…</div><button id="end" aria-label="End voice mode">✕</button></div>
<div id="normal" style="display:none"><div id="box" class="ProseMirror" contenteditable="true" style="min-height:40px;border:1px solid #999"></div><button id="start" aria-label="Voice mode">🎙</button><div id="slot"></div></div>
<input type="file" id="files" multiple>
<script>window.__sent=[];window.__events=[];let n=0;
const call=document.getElementById('call'),normal=document.getElementById('normal'),b=document.getElementById('box'),slot=document.getElementById('slot'),files=document.getElementById('files');
document.getElementById('end').onclick=()=>{__events.push('end');call.style.display='none';normal.style.display='block';};
document.getElementById('start').onclick=()=>{__events.push('start');call.style.display='block';normal.style.display='none';};
files.addEventListener('change',()=>{ if(call.style.display!=='none'&&files.files.length) __events.push('picture'); });
navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true}}).then((mic)=>{ const ac=new AudioContext(); const an=ac.createAnalyser(); an.fftSize=2048; ac.createMediaStreamSource(mic).connect(an); window.__level=()=>{ const d=new Float32Array(2048); an.getFloatTimeDomainData(d); let m=0; for(const v of d) m=Math.max(m,Math.abs(v)); return m; }; }).catch((e)=>{ window.__micError=String(e); });
b.addEventListener('input',()=>{ if(b.textContent.trim()&&!slot.firstChild){const x=document.createElement('button');x.setAttribute('aria-label','Send message');x.textContent='Send';x.onclick=()=>{__events.push('sent');__sent.push({text:b.textContent,files:[...files.files].map(f=>f.name)});files.value='';b.textContent='';slot.innerHTML='';n++;const k=n;setTimeout(()=>{const a=document.createElement('div');a.className='font-claude-response';a.textContent='Claude explains part '+k+'. The speaker is talking about a dog.';document.body.appendChild(a);},700);};slot.appendChild(x);} });</script>`;
let fails = 0; const ok = (n, c, x) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  ' + x : '')); };
const micWav = (() => { const rate = 16000, n = rate * 5, b = Buffer.alloc(44 + n * 2, 0); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return b; })();
const micPath = require('os').tmpdir() + '/ytc-silent-mic.wav';
require('fs').writeFileSync(micPath, micWav);
(async () => {
  const ctx = await pw.chromium.launchPersistentContext(require('os').tmpdir() + '/ytc-profile-' + Date.now(), {
    executablePath: process.env.CHROME || undefined, headless: true,
    args: ['--headless=new', '--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + micPath] });
  await ctx.route('https://www.youtube.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/v.wav')) { const rg = route.request().headers()['range']; if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], e = m[2] ? +m[2] : wav.length - 1; return route.fulfill({ status: 206, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${e}/${wav.length}` }, body: wav.slice(a, e + 1) }); } return route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' }, body: wav }); }
    if (u.includes('/api/timedtext')) return route.fulfill({ status: 200, contentType: 'application/json', body: json3 });
    return route.fulfill({ status: 200, contentType: 'text/html', body: ytHtml });
  });
  await ctx.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: claudeCallHtml }));
  await ctx.route('https://chatgpt.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: chatHtml }));
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  console.log('extension loaded, id', extId, '| version', await sw.evaluate(() => chrome.runtime.getManifest().version));
  const chat = await ctx.newPage(); await chat.goto('https://chatgpt.com/');
  const yt = await ctx.newPage(); await yt.goto('https://www.youtube.com/watch?v=abc12345678');
  await yt.bringToFront();
  yt.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await yt.waitForSelector('#yt2c-bar', { timeout: 8000 }).catch(() => {});
  const state = () => yt.evaluate(() => { const g = document.getElementById('yt2c-b-chatgpt'), c = document.getElementById('yt2c-b-claude'); return g ? { gpt: g.textContent + ' ' + getComputedStyle(g).backgroundColor, claude: c.textContent + ' ' + getComputedStyle(c).backgroundColor, status: document.getElementById('yt2c-b-status').textContent, underVideo: document.getElementById('yt2c-bar').parentElement.id } : null; });
  const s0 = await state();
  ok('real extension: two red buttons under the video', s0 && s0.underVideo === 'below' && /off rgb\(217, 48, 37\)/.test(s0.gpt) && /off rgb\(217, 48, 37\)/.test(s0.claude), JSON.stringify(s0));
  const sent = () => chat.evaluate(() => window.__sent);
  const pauseAt = async (t) => { await yt.evaluate(async (x) => { const v = document.querySelector('video'); v.muted = true; await v.play(); v.currentTime = x; }, t); await yt.waitForTimeout(400); await yt.evaluate(() => document.querySelector('video').pause()); };
  await pauseAt(10); await yt.waitForTimeout(12000);
  ok('both off: a normal YouTube pause (no subtitle screen, no replay), sends nothing', (await sent()).length === 0 && !(await yt.$('#yt2c-overlay')) && await yt.evaluate(() => document.querySelector('video').paused), JSON.stringify(await sent()));
  await yt.evaluate(() => document.querySelector('video').play()); await yt.waitForTimeout(500);
  await yt.click('#yt2c-b-chatgpt'); await yt.waitForTimeout(6000);
  const s1 = await state(); const m1 = await sent();
  ok('press ChatGPT: green + full transcript sent ONCE', /on rgb\(30, 142, 62\)/.test(s1.gpt) && m1.length === 1 && /Link:/.test(m1[0].text) && m1[0].files.length === 1, JSON.stringify(s1) + ' ' + JSON.stringify(m1).slice(0, 160));
  for (const at of [38, 50]) { await pauseAt(at); await yt.waitForTimeout(36000); }
  const m2 = await sent();
  ok('two pauses: two short messages, no transcript, no link', m2.length === 3 && m2.slice(1).every((x) => x.files.length === 0 && !/Link:/.test(x.text) && /English teacher/.test(x.text)), JSON.stringify(m2.slice(1).map((x) => [x.files.length, x.text.slice(0, 70)])));
  const o = await yt.evaluate(() => { const b = document.getElementById('yt2c-body'); return b ? { blocks: b.children.length, text: b.innerText.replace(/\n+/g, ' | '), font: getComputedStyle(b).fontSize } : null; });
  console.log('   on screen:', JSON.stringify(o));
  const part = /runs from (\d+):(\d+) to (\d+):(\d+)/.exec(m2[2] ? m2[2].text : '') || [];
  const len = (+part[3] * 60 + +part[4]) - (+part[1] * 60 + +part[2]);
  ok('the part sent is about 30 s of complete sentences, one sentence per line on screen', len >= 26 && len <= 34 && o && o.blocks >= 6 && /sentence number 13 of the lesson\.$/.test(o.text.split(' | ').pop()), 'part ' + (part[0] || '?') + ' = ' + len + ' s, ' + (o && o.blocks) + ' lines on screen');
  await yt.click('#yt2c-b-chatgpt'); await yt.waitForTimeout(800);
  await pauseAt(6); await yt.waitForTimeout(12000);
  ok('press ChatGPT again: red, pauses not sent', /off rgb\(217, 48, 37\)/.test((await state()).gpt) && (await sent()).length === 3);

  // ---- voice commands + talk mode (the words below are what the microphone would hear) ----
  const hear = (text, final, key) => sw.evaluate(async ([t, f, k]) => { const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' }); await chrome.tabs.sendMessage(tab.id, { type: 'heard', text: t, final: f, key: k }); }, [text, final !== false, key || null]);
  const store = (k) => sw.evaluate((key) => chrome.storage.local.get(key).then((o) => o[key]), k);
  const chatMuted = () => sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'https://chatgpt.com/*' }); return t.mutedInfo.muted; });
  const vstate = () => yt.evaluate(() => { const v = document.querySelector('video'); return { t: +v.currentTime.toFixed(1), paused: v.paused, overlay: !!document.getElementById('yt2c-overlay') }; });
  await sw.evaluate(() => chrome.storage.local.set({ replayOn: false }));
  await yt.click('#yt2c-b-chatgpt'); await yt.waitForTimeout(5000);          // ChatGPT on (green) again
  let n = (await sent()).length;
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.muted = true; v.currentTime = 30; await v.play(); });
  await yt.waitForTimeout(1500);
  await hear('hi', false); await hear('hi bro', false); await hear('hi bro', true); // interim + final results
  await yt.waitForTimeout(3000);
  const v1 = await vstate(); const m3 = await sent();
  ok('"hi bro" (your voice): video stops, subtitles show, that part is sent ONCE (not 3 times)', v1.paused && v1.overlay && m3.length === n + 1 && /English teacher/.test(m3[m3.length - 1].text) && m3[m3.length - 1].files.length === 0, JSON.stringify(v1) + ' msgs +' + (m3.length - n));
  await yt.waitForTimeout(4000);
  const spoken1 = await store('lastSpoken');
  ok('talk mode: the AI answer is read aloud when it is complete', /^Answer number \d+\. This part means the speaker is happy\.$/.test(spoken1 || ''), spoken1);
  n = (await sent()).length;
  await hear('what does happy mean', false); await hear('what does happy mean', true);
  await yt.waitForTimeout(6000);
  const m4 = await sent(); const spoken2 = await store('lastSpoken');
  ok('talk mode: what you say while stopped goes to the chat as a question (once), answer read aloud', m4.length === n + 1 && /^what does happy mean/.test(m4[m4.length - 1].text) && /simple English/.test(m4[m4.length - 1].text) && spoken2 !== spoken1 && /^Answer number/.test(spoken2 || ''), JSON.stringify(m4[m4.length - 1]).slice(0, 120) + ' | ' + spoken2);
  const partStart = await yt.evaluate(() => { const m = /runs from (\d+):(\d+)/.exec(''); return null; });
  const lastMsg = (await sent()).filter((x) => /runs from/.test(x.text)).pop();
  const pm = /runs from (\d+):(\d+) to (\d+):(\d+)/.exec(lastMsg.text);
  const from = +pm[1] * 60 + +pm[2];
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.currentTime = 30; }); // (stopped deeper in the video)
  await yt.waitForTimeout(500);
  await hear('okay shut up', true);
  await yt.waitForTimeout(1500);
  const v2 = await vstate();
  ok('"shut up": back to the START of that part, plays it again and keeps going, subtitles gone', !v2.paused && !v2.overlay && v2.t >= from - 0.5 && v2.t <= from + 3, JSON.stringify(v2) + ' part starts at ' + from);
  ok('"shut up": the AI tab is muted (its voice is silent)', (await chatMuted()) === true);
  n = (await sent()).length;
  await hear('I think it is fun', true); await yt.waitForTimeout(1500);
  ok('after "shut up", talking while the video plays sends nothing', (await sent()).length === n);
  await hear('hi bro', true); await yt.waitForTimeout(2500);
  ok('"hi bro" again: the AI tab is un-muted, video stops, the new part is sent', (await chatMuted()) === false && (await vstate()).paused && (await sent()).length === n + 1);
  await hear('shut up', true); await yt.waitForTimeout(1000);
  // the VIDEO says "Hi bro" at 0:20-0:24: that must not stop it
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.currentTime = 21; await v.play(); });
  await yt.waitForTimeout(1200);
  n = (await sent()).length;
  await yt.evaluate(() => { window.__t = 0; }); await new Promise((r) => setTimeout(r, 4100)); // (the "hi bro" command waits 4 s before it can repeat)
  await hear('hi bro how are you', true); await yt.waitForTimeout(2000);
  const v3 = await vstate();
  ok('"hi bro" coming from the video itself (its subtitles say it) is ignored', !v3.paused && (await sent()).length === n, JSON.stringify(v3));


  // ---- BUG FIX: the recognizer keeps ONE growing sentence while the video talks ("shut up and then the video says ...").
  // Every update still contains "shut up" / "hi bro": it must act ONCE, not jump back every few seconds.
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.currentTime = 40; await v.play(); });
  await yt.waitForTimeout(1500);
  let nG = (await sent()).length;
  await hear('hi bro', false, 'g1:0');
  await yt.waitForTimeout(5000);
  await hear('hi bro what is this part about', false, 'g1:0');
  await yt.waitForTimeout(5000);
  await hear('hi bro what is this part about the dog', true, 'g1:0');
  await yt.waitForTimeout(1500);
  ok('growing sentence with "hi bro": stops and sends ONCE', (await sent()).length === nG + 1, '+' + ((await sent()).length - nG) + ' messages');
  const partMsg = (await sent()).filter((x) => /runs from/.test(x.text)).pop();
  const pm2 = /runs from (\d+):(\d+)/.exec(partMsg.text); const partFrom = +pm2[1] * 60 + +pm2[2];
  await yt.waitForTimeout(500);
  await hear('shut up', false, 'g2:0');
  const times = [];
  for (let k = 0; k < 22; k++) {
    await yt.waitForTimeout(500);
    if (k === 8) await hear('shut up and then the speaker keeps talking', false, 'g2:0');
    if (k === 16) await hear('shut up and then the speaker keeps talking about the dog', true, 'g2:0');
    times.push((await vstate()).t);
  }
  const backJumps = times.slice(1).filter((t, i) => t < times[i] - 0.3).length;
  ok('growing sentence with "shut up": jumps back to the start of the part ONCE, then plays forward to the end (no loop)', Math.abs(times[0] - partFrom) < 2 && backJumps === 0 && times[times.length - 1] > times[0] + 8 && !(await vstate()).paused, 'part starts ' + partFrom + ' | times ' + times.join(','));
  // pressing play instead of "shut up": also back to the start of the part once, then on
  await yt.evaluate(() => { document.querySelector('video').currentTime = 44; }); await yt.waitForTimeout(1500); // (away from the video's own "Hi bro" line)
  await hear('hi bro', true, 'g3:0'); await yt.waitForTimeout(2500);
  const partMsg3 = (await sent()).filter((x) => /runs from/.test(x.text)).pop();
  const from3 = +(/runs from (\d+):(\d+)/.exec(partMsg3.text)[1]) * 60 + +(/runs from (\d+):(\d+)/.exec(partMsg3.text)[2]);
  await yt.waitForTimeout(31000); // the replay ends and waits
  await yt.evaluate(() => document.querySelector('video').play());
  const t3 = [];
  for (let k = 0; k < 12; k++) { await yt.waitForTimeout(500); t3.push((await vstate()).t); }
  ok('press play after the part: back to its start once, then forward (no loop)', Math.abs(t3[0] - from3) < 2 && t3.slice(1).every((t, i) => t >= t3[i] - 0.3) && t3[11] > t3[0] + 4, 'from ' + from3 + ' | ' + t3.join(','));

  // ---- Claude VOICE CALL: step out for a moment, send the TEXT, read the answer, go back into the call ----
  await hear('shut up', true); await yt.waitForTimeout(800);
  const cl = await ctx.newPage(); await cl.goto('https://claude.ai/new');
  await yt.bringToFront();
  const clSent = () => cl.evaluate(() => window.__sent);
  const clEvents = () => cl.evaluate(() => window.__events);
  const inCall = () => cl.evaluate(() => document.getElementById('call').style.display !== 'none');
  ok('Claude page starts in a voice call (no text box visible)', await inCall());
  await yt.click('#yt2c-b-claude'); await yt.waitForTimeout(11000);     // Claude on: full transcript, once
  const c1 = await clSent(); const e1 = await clEvents();
  ok('turning Claude on during the call: transcript sent as TEXT, then back in the call', c1.length === 1 && /Link:/.test(c1[0].text) && e1.join(',') === 'end,sent,start' && await inCall(), JSON.stringify(e1) + ' ' + c1.length);
  // "hi bro" DURING the call: the call is NOT left; the replay's own sound goes INTO the call (Claude hears it)
  await sw.evaluate(() => chrome.storage.local.set({ replayOn: true }));
  const levelFor = async (ms) => { let m = 0; const end = Date.now() + ms; while (Date.now() < end) { m = Math.max(m, await cl.evaluate(() => window.__level ? window.__level() : -1)); await new Promise((r) => setTimeout(r, 150)); } return +m.toFixed(3); };
  const micInfo = await cl.evaluate(() => ({ mixed: window.__ytcMixedCount || 0, err: window.__micError || null }));
  ok('the call page\'s microphone goes through the mixer', micInfo.mixed >= 1 && !micInfo.err, JSON.stringify(micInfo));
  await yt.evaluate(async () => { const v = document.querySelector('video'); v.currentTime = 40; await v.play(); });
  await yt.waitForTimeout(3000);
  const before = await levelFor(1500);
  await hear('hi bro', true);
  await yt.waitForTimeout(2500);
  const during = await levelFor(4000);
  const e2 = await clEvents(); const c2 = await clSent();
  ok('the call hears silence before (only your microphone)', before < 0.02, 'level ' + before);
  ok('during the replay the call HEARS the video part (fed into its microphone line)', during > 0.1, 'level ' + during);
  ok('the call is NOT left this time; the picture goes in (after 1 s)', e2.join(',') === 'end,sent,start,picture' && c2.length === 1 && await inCall(), JSON.stringify(e2));
  await yt.waitForTimeout(30000); // the replay (~28 s) ends
  const after = await levelFor(1500);
  ok('after the replay the call hears only your microphone again', after < 0.02 && await yt.evaluate(() => document.querySelector('video').paused), 'level ' + after);
  await ctx.close();
  console.log(fails ? fails + ' FAILED' : 'REAL EXTENSION: ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
