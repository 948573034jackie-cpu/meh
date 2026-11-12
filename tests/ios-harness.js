// The shared parts of the tests of the iPhone / iPad app (YT Learn) in WebKit: tests/ios-webkit-test.js and the
// tests that come after it use them.
// What is here: the small helpers (ok, until, sleep), the scripts of the app's windows (read from AppModel.swift),
// the fake video (10 sentences, 4 s each), the fake AI and Microsoft on localhost, the stand-in for the app's Swift
// side (Bridge.swift: the JSON store, the Keychain, URLSession, the app's files, the iOS voice, the microphone) and
// newAppContext(), a browser context that is the app's YouTube window on a phone or an iPad.
const pw = require(process.env.PWMOD || 'playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const IOS = path.resolve(__dirname, '../ios/YTLearn');
const BUILT = path.resolve(__dirname, '../youtube-to-claude/dream');
let fails = 0;
const ok = (n, c, x) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  ' + String(x).slice(0, c ? 300 : 2000) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 15000, step = 150) { const end = Date.now() + ms; for (;;) { const v = await cond(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
// a test that hangs is stopped (each test file says how long it may take)
const watchdog = (min) => setTimeout(() => { console.log(`FAIL  test took longer than ${min} minutes (stuck) - stopping`); process.exit(1); }, min * 60 * 1000).unref();

// ---- the scripts of the app's windows, in the app's order ----
const swift = fs.readFileSync(path.join(IOS, 'AppModel.swift'), 'utf8');
// (a list the app does not have: an error, or null when it may be missing)
const listOf = (name, optional) => { const m = new RegExp(`static let ${name} = (\\[[^\\]]*\\])`).exec(swift); if (!m && optional) return null; return JSON.parse(m[1]); };
const source = (names) => names.map((n) => fs.readFileSync(path.join(IOS, 'Scripts', n + '.js'), 'utf8')).join('\n;\n');
const ytScripts = listOf('youtubeScripts');
const sheetScripts = listOf('sheetScripts');

// ---- the video: 10 sentences, 4 s each ----
const LINES = [
  'Hello everyone and welcome back to the channel.',
  'Today my friend was very meticulous about her work.',
  'She checked every small detail twice.',
  'It was an ephemeral moment of joy.',
  'This is complete sentence number five of the lesson.',
  'This is complete sentence number six of the lesson.',
  'My uncle is a gregarious man who loves big parties.',
  'This is complete sentence number eight of the lesson.',
  'This is complete sentence number nine of the lesson.',
  'We will talk about it again very soon.',
];
const SEC = 4, DUR = 60;
const json3 = JSON.stringify({ events: LINES.map((t, i) => ({ tStartMs: i * SEC * 1000, dDurationMs: SEC * 1000, segs: [{ utf8: t }] })) });
// the video's subtitle tracks (one English track, made by YouTube's speech recognition); makePr() gives the player response the page has
const tracksOf = (id) => [{ baseUrl: `https://m.youtube.com/api/timedtext?v=${id}&lang=en`, languageCode: 'en', kind: 'asr', vssId: 'a.en' }];
const TRACKS = tracksOf('ios00000001');
const makePr = (id = 'ios00000001', tracks = tracksOf(id)) => JSON.stringify({ videoDetails: { videoId: id, title: 'Dream Lesson', lengthSeconds: String(DUR) }, playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } });
const pr = makePr();
const makeWav = (sec, tone) => { const n = Math.round(8000 * sec), b = Buffer.alloc(44 + n, 128); if (tone) for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(50 * Math.sin(2 * Math.PI * 330 * i / 8000)); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; };
const wav = makeWav(DUR, true);
const ttsWav = makeWav(0.25, false);
// the phone page: no right column; the player on top, the video's details and related videos under it
const makeYtHtml = (pr) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dream Lesson - YouTube</title></head><body style="margin:0;background:#fff">
<ytm-app><ytm-watch><div id="player-container-id" class="player-container" style="position:relative;width:100%;height:220px;background:#123">
  <div id="movie_player" class="html5-video-player" style="width:100%;height:100%"><video muted playsinline src="https://m.youtube.com/v.wav" class="html5-main-video" style="width:100%;height:100%"></video>
  <button class="ytp-fullscreen-button" aria-label="Full screen" style="position:absolute;right:0;bottom:0;width:48px;height:48px;z-index:5" onclick="window.__nativeFs=(window.__nativeFs||0)+1;var v=document.querySelector('video');if(v.webkitEnterFullscreen)v.webkitEnterFullscreen();"></button></div></div>
<ytm-single-column-watch-next-results-renderer><div id="below"><h2 class="slim-video-metadata-title">Dream Lesson</h2></div><ytm-item-section-renderer>related videos</ytm-item-section-renderer></ytm-single-column-watch-next-results-renderer>
</ytm-watch></ytm-app><script>var ytInitialPlayerResponse = ${pr};</script></body></html>`;
const ytHtml = makeYtHtml(pr);

// ---- the fake Anthropic + Microsoft (the same answers as tests/dream-e2e.js) ----
const apiLog = [];
const sse = (res, text) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
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
let failNextAzure = 0; // (a test sets it with failAzure(n): the next n Microsoft answers are "busy")
let hardReply = []; // (the AI's hard sentences, 1-based; a test sets them with setHard([...]); none by default)
const kindOf = (sys, url) => (url.includes('/azure/') ? (url.includes('/voices/list') ? 'azure-list' : 'azure') : /Word Wise/.test(sys) ? 'hints' : /multi-word expressions/.test(sys) ? 'phrases' : /well-punctuated sentences/.test(sys) ? 'split' : /judge which spoken sentences/.test(sys) ? 'hard' : /translate the English subtitles/.test(sys) ? 'zhlines' : /Simplified Chinese meaning of an English word/.test(sys) ? 'zhword' : /This call works through text/.test(sys) ? 'chat' : 'explain');
const apiHandler = (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let j = {};
    try { j = JSON.parse(body); } catch (e) { /* not json */ }
    const sys = JSON.stringify(j.system || '');
    const user = JSON.stringify(j.messages || '');
    const kind = kindOf(sys, req.url);
    apiLog.push({ path: req.url, kind, model: j.model, user, sys, ssml: kind === 'azure' ? body : undefined, at: Date.now() });
    if (kind === 'azure' && failNextAzure > 0) { failNextAzure--; apiLog[apiLog.length - 1].failed = true; res.writeHead(503, { 'content-type': 'text/plain' }); res.end('busy'); return; }
    if (kind === 'azure') { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(ttsWav); return; }
    if (kind === 'azure-list') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify([{ ShortName: 'en-GB-AdaMultilingualNeural' }])); return; }
    if (/These rules are absolute/.test(sys) && /@@<its number>/.test(user)) return sse(res, [...user.matchAll(/\*(\d+)\. /g)].map((m) => `@@${m[1]}\nThis part is the hard one. It means something simple here, and it shows how the person feels.`).join('\n'));
    if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } })); return; }
    if (kind === 'hints') return sse(res, JSON.stringify({ meticulous: ['一丝不苟的', '细致的'], ephemeral: ['短暂的', '转瞬即逝的'], gregarious: ['爱交际的', '合群的'] }));
    if (kind === 'phrases') return sse(res, '{"phrases":[]}');
    if (kind === 'split') {
      const words = [...user.matchAll(/(\d+):(\S+?)(?= \d+:|\\n|"|$)/g)].map((m) => [Number(m[1]), m[2]]);
      const out = []; let cur = [];
      for (const [n, w] of words) { cur.push(w); if (/[.?!]$/.test(w)) { let t = cur.join(' '); if (/twice\.$/.test(t)) t = t.replace(' twice.', ', twice.'); out.push(`${n}|${t}`); cur = []; } }
      return sse(res, out.join('\n'));
    }
    if (kind === 'hard') return sse(res, JSON.stringify({ hard: hardReply }));
    if (kind === 'zhlines') { const n = [...user.matchAll(/\\n(\d+)\. /g)].map((m) => Number(m[1])); return sse(res, n.map((k) => `${k}. 中文第${k}句`).join('\n')); }
    if (kind === 'zhword') return sse(res, '细致的；仔细的');
    if (kind === 'chat') return sse(res, /gregarious/i.test(user) ? 'Gregarious means friendly. A gregarious man loves parties and people.' : 'Hi! Ask me anything about this part.');
    const cur = (/The sentence being read now:\\n(.*?)(?:\\n|")/.exec(user) || [])[1] || '';
    if (/The learner just paused the video/.test(user)) return sse(res, 'In this part the speaker counts the sentences of the lesson. That is the main point.');
    return sse(res, /meticulous/.test(cur) ? 'Meticulous means very careful about every small detail. Your friend checks her work again and again.' : /gregarious/.test(cur) ? 'Gregarious means a person who loves being with other people.' : 'It means something simple.');
  });
};
const PORT = +process.env.IOS_TEST_PORT || 8791;   // (another port: two runs side by side)
const FAKE = 'http://localhost:' + PORT;
// the fake server is started by the test (startServer() once; close() it at the end)
const startServer = () => http.createServer(apiHandler).listen(PORT);

// ---- the stand-in for the app's Swift side (Bridge.swift) ----
const stores = { local: {}, sync: {} };
const keychain = {};
const nativeLog = [];
// the shared vocabulary file (iCloud Drive ▸ MEH English, written by the Mac): the app must merge it in and write it back
let vocabShared = { version: 1, updatedAt: '2026-11-03T10:00:00.000Z', currentLevel: 'about B2 for reading', tests: [{ date: '2026-11-03', source: 'A Mac video', scores: { b2: 60, c1: 20, c2: 10 }, level: 'B2' }],
  known: [{ item: 'serendipity', date: '2026-11-03' }], stillLearning: [{ item: 'flabbergasted', date: '2026-11-03', sentence: 'I was flabbergasted by the news.' }] };
const vocabWrites = [];
// Apple's Translation (Translator.swift): what it answers for a sentence; a test sets it with setTranslate(text or Error)
let translateReply = '这是测试译文';
const fetchLog = [];
const layoutLog = [];
const aborts = {};
const MIME = { '.gz': 'application/gzip', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain' };
function realToFake(url) { // what URLSession would reach: the real services, here the fake server
  const u = new URL(url);
  const az = /^([a-z0-9-]+)\.tts\.speech\.microsoft\.com$/.exec(u.hostname);
  if (az) return `${FAKE}/azure/${az[1]}${u.pathname}${u.search}`;
  if (u.hostname === 'api.anthropic.com' || u.hostname === 'api.openai.com') return FAKE + u.pathname + u.search;
  throw new Error('host not allowed: ' + u.hostname);
}
async function native(page, b) {
  const area = b.area || 'local';
  nativeLog.push({ kind: b.kind, op: b.op, path: b.path, url: b.url, text: b.text, voice: b.voice, at: Date.now() });
  switch (b.kind) {
    case 'storageAll': return JSON.stringify(stores[area] || {});
    case 'storageSet': Object.assign(stores[area], JSON.parse(b.json)); return null;
    case 'storageRemove': for (const k of b.keys || []) delete stores[area][k]; return null;
    case 'keychainGet': return keychain[b.name] ?? null;
    case 'vocabFile': {
      const m = b.msg || {};
      const base = { ok: true, path: '/app/Documents/vocabulary.json', phone: true, shared: true, folder: 'MEH English' };
      if (m.type === 'read') return { ...base, docs: [vocabShared] };
      if (m.type === 'write') { vocabWrites.push(m.doc); vocabShared = m.doc; return { ...base, sharedOk: true }; }
      return base;
    }
    case 'keychainSet': if (b.value == null) delete keychain[b.name]; else keychain[b.name] = b.value; return null;
    case 'resource': {
      const f = path.join(IOS, 'Web', path.normalize(b.path).replace(/^(\.\.[/\\])+/, ''));
      if (!fs.existsSync(f)) return null;
      return { b64: fs.readFileSync(f).toString('base64'), mime: MIME[path.extname(f)] || 'application/octet-stream' };
    }
    case 'nativeFetch': {
      const ctrl = new AbortController();
      aborts[b.id] = ctrl;
      const res = await fetch(realToFake(b.url), { method: b.method, headers: b.headers, body: b.body ? Buffer.from(b.body, 'base64') : undefined, signal: ctrl.signal });
      const headers = {};
      res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/.test(k)) headers[k] = v; });
      const entry = { url: b.url, method: b.method, headers: b.headers, status: res.status, chunks: 0 };
      fetchLog.push(entry);
      (async () => { // the body follows in pieces, like URLSession's didReceive data
        try {
          for await (const chunk of res.body) { entry.chunks++; await page.evaluate(([id, s]) => window.__ytcFetchChunk(id, s), [b.id, Buffer.from(chunk).toString('base64')]); }
          await page.evaluate((id) => window.__ytcFetchEnd(id), b.id);
        } catch (e) { await page.evaluate(([id, m]) => window.__ytcFetchEnd(id, m), [b.id, String(e.message || e)]).catch(() => {}); }
        delete aborts[b.id];
      })();
      return { status: res.status, statusText: res.statusText, headers };
    }
    case 'nativeFetchCancel': if (aborts[b.id]) aborts[b.id].abort(); return null;
    case 'voices': return [{ id: 'com.apple.voice.premium.en-GB.Malcolm', name: 'Malcolm (Premium)', lang: 'en-GB' }, { id: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', lang: 'en-US' }, { id: 'com.apple.voice.compact.zh-CN.Tingting', name: 'Tingting', lang: 'zh-CN' }];
    case 'speak': { // AVSpeechSynthesizer: start, the words, then the end
      const id = b.id, text = String(b.text || '');
      setTimeout(async () => {
        try {
          await page.evaluate((i) => window.__ytcTts({ id: i, event: 'start' }), id);
          for (const m of text.matchAll(/\S+/g)) { await page.evaluate(([i, c, l]) => window.__ytcTts({ id: i, event: 'word', charIndex: c, charLength: l }), [id, m.index, m[0].length]); await sleep(4); }
          await page.evaluate((i) => window.__ytcTts({ id: i, event: 'end' }), id);
        } catch (e) { /* page gone */ }
      }, 20);
      return null;
    }
    case 'translate': { // (on the device: free, no AI) an Error = Swift's reply(nil, "…"): the page's promise fails
      await sleep(30);
      if (translateReply instanceof Error) throw translateReply;
      return translateReply;
    }
    case 'chatInfo': return { url: '' };
    case 'layout': layoutLog.push({ full: !!b.full, lay: b.lay }); return null; // the page tells the app: full screen or not
    default: return null; // speakStop, speakPause, speakResume, speech, openPage, audioSession, log, voice …
  }
}
// what the Swift side is made of, in the page: the message handler (answers as a promise)
const fakeWebkit = () => {
  const handler = { postMessage: (o) => window.__ytcNative(JSON.stringify(o)).then((r) => (r === undefined || r === null ? r : JSON.parse(r))) };
  Object.defineProperty(window, 'webkit', { value: { messageHandlers: { ytc: handler } }, configurable: true });
};
// the app's YouTube window as a browser context: the device (a Playwright name; viewport = another size), the Swift
// side, the device the app tells the page (window.__ytcDevice = 'phone' or 'pad'), the app's scripts for the page's own
// world (AppModel.pageScripts, when the app has them), and m.youtube.com answered from here.
// video (optional): { id, tracks, json3ByUrl } = another player response; json3ByUrl gives the subtitles for an address
// (a function, or { 'part of the address': json3 }); without it every video is the 10 sentences above.
// ctx.pageHits: what the page asked of the AI services itself (it must not: everything goes through Swift)
async function newAppContext(browser, deviceName = 'iPhone 13', { device = 'phone', viewport, video } = {}) {
  const ctx = await browser.newContext({ ...pw.devices[deviceName], ...(viewport ? { viewport } : {}) });
  await ctx.exposeBinding('__ytcNative', async ({ page }, json) => { const r = await native(page, JSON.parse(json)); return r === null || r === undefined ? null : JSON.stringify(r); });
  await ctx.addInitScript(fakeWebkit);
  await ctx.addInitScript(`window.__ytcDevice=${JSON.stringify(device)}`);
  const pageScripts = listOf('pageScripts', true);
  if (pageScripts) await ctx.addInitScript({ content: source(pageScripts) });
  const pageHits = [];
  ctx.pageHits = pageHits;
  ctx.on('request', (r) => { if (/api\.anthropic\.com|api\.openai\.com|tts\.speech\.microsoft\.com|localhost:\d+/.test(r.url())) pageHits.push(r.url()); });
  const html = video ? makeYtHtml(makePr(video.id, video.tracks)) : ytHtml;
  const subsFor = (u) => {
    const by = video && video.json3ByUrl;
    if (typeof by === 'function') return by(u) ?? json3;
    const k = by && Object.keys(by).find((x) => u.includes(x));
    return k ? by[k] : json3;
  };
  await ctx.route('https://m.youtube.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/v.wav')) { const rg = route.request().headers().range; if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], e = m[2] ? +m[2] : wav.length - 1; return route.fulfill({ status: 206, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${e}/${wav.length}` }, body: wav.slice(a, e + 1) }); } return route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' }, body: wav }); }
    if (u.includes('/api/timedtext')) return route.fulfill({ status: 200, contentType: 'application/json', body: subsFor(u) });
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  return ctx;
}

module.exports = {
  layoutLog,
  pw, IOS, BUILT, MIME, FAKE,
  ok, until, sleep, watchdog, fails: () => fails,
  swift, listOf, source, ytScripts, sheetScripts,
  LINES, SEC, DUR, json3, TRACKS, tracksOf, makePr, pr, makeWav, wav, ttsWav, makeYtHtml, ytHtml,
  apiLog, nativeLog, fetchLog, stores, keychain, vocabWrites,
  get vocabShared() { return vocabShared; }, // (the stand-in replaces it on every write)
  failAzure: (n) => { failNextAzure = n; },
  setHard: (list) => { hardReply = list; },
  setTranslate: (r) => { translateReply = r; },
  native, fakeWebkit, startServer, newAppContext,
};
