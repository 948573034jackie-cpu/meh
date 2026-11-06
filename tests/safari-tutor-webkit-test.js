// My tutor in the SAFARI extension (safari/Extension, the YT Safari app for iPhone / iPad), tested in WebKit, Safari's
// engine, without Xcode. A fake m.youtube.com page on a phone gets the extension's content scripts (read from its
// manifest, in its order); the extension's background (background.js, which loads dream/dream-bg.js) runs in a page of
// its own, as Safari's background does; between them a stand-in for Safari's "browser" API carries messages, ports
// and storage like Safari does (Node is the middle). Only the background reaches the AI and Microsoft (a fake server).
// Checks: the manifest, the AI's sentences (asked by the background), the dictionary from the extension, the panel
// under the player, a stop + "I don't know", the explanation streamed and spoken, the pause flow, a Claude call
// through Safari's speech recognition (voice commands off, as on every iPhone), "let's go", the touch bar's buttons,
// the keys only in the extension's storage, the Microsoft voice request, the settings page.
// Run safari/make-extension.sh first (the CI does).
const pw = require(process.env.PWMOD || 'playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const EXT = path.resolve(__dirname, '../safari/Extension');
const BASE = 'https://safari-ext.test/'; // where Safari serves the extension's own files (safari-web-extension://…)
let fails = 0;
const ok = (n, c, x) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  ' + String(x).slice(0, c ? 300 : 2000) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 15000, step = 150) { const end = Date.now() + ms; for (;;) { const v = await cond(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
setTimeout(() => { console.log('FAIL  test took longer than 6 minutes (stuck) - stopping'); process.exit(1); }, 6 * 60 * 1000).unref();

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const ytScripts = manifest.content_scripts.find((c) => c.matches.includes('https://m.youtube.com/*'));

// ---- the video: 10 sentences, 4 s each (the same as tests/ios-webkit-test.js) ----
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
const pr = JSON.stringify({ videoDetails: { videoId: 'saf00000001', title: 'Dream Lesson', lengthSeconds: String(DUR) }, playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://m.youtube.com/api/timedtext?v=saf00000001&lang=en', languageCode: 'en' }] } } });
const makeWav = (sec, tone) => { const n = Math.round(8000 * sec), b = Buffer.alloc(44 + n, 128); if (tone) for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(50 * Math.sin(2 * Math.PI * 330 * i / 8000)); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; };
const wav = makeWav(DUR, true);
const ttsWav = makeWav(0.25, false);
const ytHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dream Lesson - YouTube</title></head><body style="margin:0;background:#fff">
<ytm-app><ytm-watch><div id="player-container-id" class="player-container" style="position:relative;width:100%;height:220px;background:#123">
  <div id="movie_player" class="html5-video-player" style="width:100%;height:100%"><video muted playsinline src="https://m.youtube.com/v.wav" class="html5-main-video" style="width:100%;height:100%"></video></div></div>
<ytm-single-column-watch-next-results-renderer><div id="below"><h2 class="slim-video-metadata-title">Dream Lesson</h2></div><ytm-item-section-renderer>related videos</ytm-item-section-renderer></ytm-single-column-watch-next-results-renderer>
</ytm-watch></ytm-app><script>var ytInitialPlayerResponse = ${pr};</script></body></html>`;

// ---- the fake Anthropic + Microsoft (the same answers as tests/ios-webkit-test.js) ----
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
const kindOf = (sys, url) => (url.includes('/azure/') ? (url.includes('/voices/list') ? 'azure-list' : 'azure') : /Word Wise/.test(sys) ? 'hints' : /multi-word expressions/.test(sys) ? 'phrases' : /well-punctuated sentences/.test(sys) ? 'split' : /judge which spoken sentences/.test(sys) ? 'hard' : /translate the English subtitles/.test(sys) ? 'zhlines' : /Simplified Chinese meaning of an English word/.test(sys) ? 'zhword' : /This call works through text/.test(sys) ? 'chat' : 'explain');
const api = http.createServer((req, res) => {
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
    if (kind === 'hard') return sse(res, JSON.stringify({ hard: [] }));
    if (kind === 'zhlines') { const n = [...user.matchAll(/\\n(\d+)\. /g)].map((m) => Number(m[1])); return sse(res, n.map((k) => `${k}. 中文第${k}句`).join('\n')); }
    if (kind === 'zhword') return sse(res, '细致的；仔细的');
    if (kind === 'chat') return sse(res, /gregarious/i.test(user) ? 'Gregarious means friendly. A gregarious man loves parties and people.' : 'Hi! Ask me anything about this part.');
    const cur = (/The sentence being read now:\\n(.*?)(?:\\n|")/.exec(user) || [])[1] || '';
    if (/The learner just paused the video/.test(user)) return sse(res, 'In this part the speaker counts the sentences of the lesson. That is the main point.');
    return sse(res, /meticulous/.test(cur) ? 'Meticulous means very careful about every small detail. Your friend checks her work again and again.' : /gregarious/.test(cur) ? 'Gregarious means a person who loves being with other people.' : 'It means something simple.');
  });
}).listen(8794);
const FAKE = 'http://localhost:8794';
function realToFake(url) {
  const u = new URL(url);
  const az = /^([a-z0-9-]+)\.tts\.speech\.microsoft\.com$/.exec(u.hostname);
  if (az) return `${FAKE}/azure/${az[1]}${u.pathname}${u.search}`;
  return FAKE + u.pathname + u.search;
}

// ---- Safari's "browser" API, in every page (the YouTube tab, the background, the extension's own pages) ----
// Everything returns a promise, as in Safari. Node carries messages, ports and storage between the pages.
const fakeBrowser = ({ base, manifest }) => {
  const call = (op, o) => window.__ext(JSON.stringify({ op, ...o })).then((r) => (r == null ? undefined : JSON.parse(r)));
  const ev = () => { const fs = []; return { addListener: (f) => { fs.push(f); }, removeListener: (f) => { const i = fs.indexOf(f); if (i >= 0) fs.splice(i, 1); }, hasListener: (f) => fs.includes(f), _fs: fs }; };
  const onMessage = ev(), onConnect = ev(), onChanged = ev();
  const area = (name) => ({
    get: (k) => call('sget', { area: name, keys: k === undefined ? null : k }),
    set: (items) => call('sset', { area: name, items }),
    remove: (k) => call('sremove', { area: name, keys: [].concat(k) }),
    clear: () => call('sclear', { area: name }),
    getBytesInUse: () => Promise.resolve(0),
    onChanged: ev(),
  });
  const ports = {};
  const makePort = (id, name, sender) => {
    const p = { name, sender, onMessage: ev(), onDisconnect: ev(), _open: true,
      postMessage: (m) => { if (!p._open) throw new Error('Attempting to use a disconnected port object'); call('pmsg', { id, m }); },
      disconnect: () => { if (!p._open) return; p._open = false; delete ports[id]; call('pdisc', { id }); } };
    ports[id] = p;
    return p;
  };
  window.__portIn = (id, m) => { const p = ports[id]; if (p) for (const f of p.onMessage._fs.slice()) f(m, p); };
  window.__portGone = (id) => { const p = ports[id]; if (!p) return; p._open = false; delete ports[id]; for (const f of p.onDisconnect._fs.slice()) f(p); };
  window.__connIn = (id, name, sender) => { const p = makePort(id, name, sender); for (const f of onConnect._fs.slice()) f(p); };
  window.__msgIn = (rid, msg, sender) => {
    let done = false, wait = false;
    const send = (v) => { if (done) return; done = true; call('reply', { rid, value: v === undefined ? null : v }); };
    for (const f of onMessage._fs.slice()) {
      try { const r = f(msg, sender, send); if (r === true) wait = true; else if (r && typeof r.then === 'function') { wait = true; r.then(send, () => send(undefined)); } } catch (e) { console.error(e); }
    }
    if (!wait) send(undefined);
  };
  window.__changedIn = (changes, name) => { for (const f of onChanged._fs.slice()) f(changes, name); };
  window.browser = {
    runtime: {
      id: 'safari-ext', getURL: (p) => base + String(p).replace(/^\//, ''), getManifest: () => manifest,
      sendMessage: (msg) => call('send', { msg }), onMessage, onConnect, onInstalled: ev(), onStartup: ev(),
      connect: (info) => { const id = Math.random().toString(36).slice(2); const p = makePort(id, (info && info.name) || ''); call('connect', { id, name: p.name }); return p; },
      getPlatformInfo: () => Promise.resolve({ os: 'ios', arch: 'arm' }), reload: () => { call('log', { what: 'reload' }); },
    },
    storage: { local: area('local'), sync: area('sync'), session: area('session'), onChanged },
    tabs: {
      query: (q) => call('tabsQuery', { q: q || {} }), get: (id) => call('tabsGet', { id }),
      sendMessage: (tabId, msg) => call('tabSend', { tabId, msg }), create: (o) => call('tabsCreate', { url: o.url }),
      update: () => Promise.resolve({}), reload: (id) => call('log', { what: 'tabsReload', id }), onUpdated: ev(), onRemoved: ev(), onActivated: ev(),
    },
    scripting: { executeScript: () => Promise.resolve([]) },
    action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve(), setTitle: () => Promise.resolve() },
  };
  // the YouTube tab: Safari's speech recognition (the test says what was heard, while the page listens)
  if (location.hostname === 'm.youtube.com') {
    window.__recStarts = 0;
    window.webkitSpeechRecognition = class {
      constructor() { this.continuous = false; this.interimResults = false; this.lang = 'en-US'; }
      start() { window.__recStarts++; window.__activeSR = this; }
      stop() { if (window.__activeSR !== this) return; window.__activeSR = null; setTimeout(() => this.onend && this.onend(), 10); }
      abort() { this.stop(); }
    };
  }
  // the background: Safari's service worker loads dream/dream-bg.js with importScripts (here: one after the other)
  if (location.pathname === '/_bg.html') window.importScripts = (...urls) => { for (const u of urls) { const src = (window.__importSrc || {})[u]; if (src == null) throw new Error('importScripts: no ' + u); window.__imported = (window.__imported || []).concat(u); (0, eval)(src); } };
};

// ---- Node: the middle of Safari (pages, storage, messages, ports) ----
const stores = { local: {}, sync: {}, session: {} };
const tabs = new Map(); // tab id -> page
const tabIdOf = new Map(); // page -> tab id
let bg = null;
const created = [];
const replies = new Map();
const portEnds = new Map();
let rid = 0;
const queues = new Map();
function toPage(page, fn, arg) { // in order, one after the other, per page
  const q = (queues.get(page) || Promise.resolve()).then(() => page.evaluate(fn, arg)).catch(() => undefined);
  queues.set(page, q);
  return q;
}
const senderOf = (page) => (tabIdOf.has(page) ? { id: 'safari-ext', url: page.url(), tab: { id: tabIdOf.get(page), url: page.url() } } : { id: 'safari-ext', url: page.url() });
function ask(target, msg, from) {
  const id = ++rid;
  const p = new Promise((res) => { replies.set(id, res); setTimeout(() => { if (replies.delete(id)) res(undefined); }, 30000); });
  toPage(target, ([i, m, s]) => window.__msgIn(i, m, s), [id, msg, senderOf(from)]);
  return p;
}
function pick(obj, keys) {
  if (keys == null) return { ...obj };
  if (typeof keys === 'string') keys = [keys];
  if (Array.isArray(keys)) { const o = {}; for (const k of keys) if (k in obj) o[k] = obj[k]; return o; }
  const o = {}; for (const k of Object.keys(keys)) o[k] = k in obj ? obj[k] : keys[k]; return o;
}
function changed(ch, name) { if (!Object.keys(ch).length) return; for (const p of [bg, ...tabs.values(), ...extPages]) if (p && !p.isClosed()) toPage(p, ([c, n]) => window.__changedIn(c, n), [ch, name]); }
const extPages = new Set();
async function hub(page, o) {
  const s = stores[o.area];
  switch (o.op) {
    case 'sget': return JSON.parse(JSON.stringify(pick(s, o.keys)));
    case 'sset': { const ch = {}; for (const [k, v] of Object.entries(o.items)) { ch[k] = { newValue: v, oldValue: s[k] }; s[k] = v; } changed(ch, o.area); return null; }
    case 'sremove': { const ch = {}; for (const k of o.keys) if (k in s) { ch[k] = { oldValue: s[k] }; delete s[k]; } changed(ch, o.area); return null; }
    case 'sclear': { const ch = {}; for (const k of Object.keys(s)) { ch[k] = { oldValue: s[k] }; delete s[k]; } changed(ch, o.area); return null; }
    case 'send': return page === bg ? null : ask(bg, o.msg, page);
    case 'reply': { const r = replies.get(o.rid); if (r) { replies.delete(o.rid); r(o.value === null ? undefined : o.value); } return null; }
    case 'tabSend': { const t = tabs.get(o.tabId); return t ? ask(t, o.msg, page) : null; }
    case 'tabsQuery': return [...tabs.entries()].map(([id, p]) => ({ id, url: p.url(), active: true, windowId: 1 })).filter((t) => !o.q.url || [].concat(o.q.url).some((g) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(t.url)));
    case 'tabsGet': { const p = tabs.get(o.id); return p ? { id: o.id, url: p.url() } : null; }
    case 'tabsCreate': created.push(o.url); return { id: 900 + created.length, url: o.url };
    case 'connect': portEnds.set(o.id, [page, bg]); toPage(bg, ([i, n, sd]) => window.__connIn(i, n, sd), [o.id, o.name, senderOf(page)]); return null;
    case 'pmsg': { const e = portEnds.get(o.id); if (!e) return null; const other = e[0] === page ? e[1] : e[0]; toPage(other, ([i, m]) => window.__portIn(i, m), [o.id, o.m]); return null; }
    case 'pdisc': { const e = portEnds.get(o.id); if (!e) return null; portEnds.delete(o.id); const other = e[0] === page ? e[1] : e[0]; toPage(other, (i) => window.__portGone(i), o.id); return null; }
    default: return null;
  }
}

(async () => {
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version(), '| Safari extension version', manifest.version);
  const exists = (f) => fs.existsSync(path.join(EXT, f));
  ok('Safari manifest: My tutor on www and m.youtube.com, after youtube.js, its touch bar last; the AI hosts allowed; the dictionary readable by the page',
    ytScripts && ytScripts.js.join() === 'browser-shim.js,lib.js,youtube.js,dream/dream-yt.js,tutor-bar.js' && ytScripts.matches.includes('https://www.youtube.com/*')
    && ['api.anthropic.com', 'api.openai.com', 'api.elevenlabs.io', 'tts.speech.microsoft.com'].every((h) => manifest.host_permissions.some((x) => x.includes(h)))
    && manifest.web_accessible_resources[0].resources.includes('dream/dict.json.gz') && manifest.web_accessible_resources[0].matches.includes('https://m.youtube.com/*')
    && !manifest.permissions.includes('tts') && !manifest.permissions.includes('debugger') && manifest.options_page === 'dream/options.html'
    && ['dream/dream-yt.js', 'dream/dream-bg.js', 'dream/dict.json.gz', 'dream/options.html', 'dream/options.js', 'dream/vocab.html', 'tutor-bar.js'].every(exists)
    && /importScripts\('dream\/dream-bg\.js'\)/.test(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8')),
    JSON.stringify({ js: ytScripts && ytScripts.js, hosts: manifest.host_permissions }));

  const ctx = await browser.newContext({ ...pw.devices['iPhone 13'] });
  await ctx.exposeBinding('__ext', async ({ page }, json) => { const r = await hub(page, JSON.parse(json)); return r === null || r === undefined ? null : JSON.stringify(r); });
  await ctx.addInitScript(fakeBrowser, { base: BASE, manifest });
  // the extension's own files (Safari: safari-web-extension://…), readable by YouTube where the manifest allows it
  const MIME = { '.gz': 'application/gzip', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain', '.json': 'application/json', '.png': 'image/png' };
  await ctx.route(BASE + '**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/_bg.html') { // (the files importScripts may load, in the page: a test page cannot load them synchronously)
      const src = JSON.stringify({ 'dream/dream-bg.js': fs.readFileSync(path.join(EXT, 'dream/dream-bg.js'), 'utf8') }).replace(/</g, '\\u003c');
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><title>background</title><script>window.__importSrc = ${src};</script><script src="/background.js"></script>` });
    }
    const f = path.join(EXT, path.normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, ''));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'access-control-allow-origin': '*' }, body: fs.readFileSync(f) });
  });
  // the AI and voice services: the real addresses, answered by the fake server; who asked is written down
  const svc = [];
  await ctx.route(/^https:\/\/(api\.anthropic\.com|api\.openai\.com|api\.elevenlabs\.io|[a-z0-9-]+\.tts\.speech\.microsoft\.com)\//, async (route) => {
    const q = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (q.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    let fromBg = false;
    try { fromBg = q.frame().page() === bg; } catch (e) { /* a worker */ }
    const headers = q.headers();
    svc.push({ url: q.url(), method: q.method(), headers, fromBg });
    const r = await fetch(realToFake(q.url()), { method: q.method(), headers: { 'content-type': headers['content-type'] || 'application/json' }, body: q.postDataBuffer() || undefined });
    const out = { ...cors };
    r.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/.test(k)) out[k] = v; });
    return route.fulfill({ status: r.status, headers: out, body: Buffer.from(await r.arrayBuffer()) });
  });
  await ctx.route('https://m.youtube.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/v.wav')) { const rg = route.request().headers().range; if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], e = m[2] ? +m[2] : wav.length - 1; return route.fulfill({ status: 206, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${e}/${wav.length}` }, body: wav.slice(a, e + 1) }); } return route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' }, body: wav }); }
    if (u.includes('/api/timedtext')) return route.fulfill({ status: 200, contentType: 'application/json', body: json3 });
    return route.fulfill({ status: 200, contentType: 'text/html', body: ytHtml });
  });

  // what was saved before: the tutor on, test-friendly timings; the Claude key in the extension's storage.
  // (No "voiceOn": on an iPhone voice commands are off, the tutor still gets the microphone for its questions.)
  Object.assign(stores.local, {
    barOn: true,
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 }, // (no starting data: these tests have their own words)
    drExtras: { levelAsk: false, levelMode: false, tutorOn: true, fakeVoice: true, explainOnStop: true, panel: true, band: 'auto', talkAfterExplain: false, migrated: 1, stopGapSec: 0, callEngine: 'claude', talkSilenceSec: 0, stopSentences: false },
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 20 } },
    drKeys: { anthropic: 'sk-ant-test-key' },
  });

  // the background (Safari starts it first)
  bg = await ctx.newPage();
  bg.on('pageerror', (e) => console.log('PAGE ERROR (background)', String(e.message || e).slice(0, 300)));
  bg.on('console', (m) => { if (m.type() === 'error') console.log('background console:', m.text().slice(0, 300)); });
  await bg.goto(BASE + '_bg.html');
  const bgUp = await bg.evaluate(() => ({ safari: self.__ytcSafari === true, chromeIsBrowser: self.chrome === self.browser, connect: self.browser.runtime.onConnect._fs.length, msg: self.browser.runtime.onMessage._fs.length }));
  ok('the background runs on Safari\'s API and loaded My tutor\'s background (dream-bg.js: its port for the AI)', bgUp.safari && bgUp.chromeIsBrowser && bgUp.connect >= 1 && bgUp.msg >= 2, JSON.stringify(bgUp));

  const yt = await ctx.newPage();
  yt.on('pageerror', (e) => console.log('PAGE ERROR', String(e.message || e).slice(0, 300)));
  const pageHits = []; // the YouTube page asking the services itself (it must not: Safari's content scripts follow the page's CORS)
  yt.on('request', (r) => { if (/api\.anthropic\.com|api\.openai\.com|api\.elevenlabs\.io|tts\.speech\.microsoft\.com/.test(r.url())) pageHits.push(r.url()); });
  await yt.goto('https://m.youtube.com/watch?v=saf00000001');
  tabs.set(1, yt); tabIdOf.set(yt, 1);
  for (const f of ytScripts.js) await yt.addScriptTag({ content: fs.readFileSync(path.join(EXT, f), 'utf8') }); // = Safari's content scripts at document end
  const dbg = () => yt.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const vstate = () => yt.evaluate(() => { const v = document.querySelector('video'); return { t: +v.currentTime.toFixed(2), paused: v.paused }; });
  const spoken = () => dbg().then((d) => (d && d.spoken) || []);
  const tap = (act) => yt.evaluate((a) => { const b = document.querySelector(a === 'tutor' ? '#yt2c-tb-tutor' : `#yt2c-tutor-bar [data-act="${a}"]`); if (!b || b.offsetParent === null) return false; b.click(); return true; }, act);
  // what Safari's speech recognition heard: the words so far, then the closed sentence, then the end (only while the page listens)
  const hear = async (text) => {
    const has = await until(() => yt.evaluate(() => !!window.__activeSR), 8000, 100);
    await yt.evaluate((t) => { const r = window.__activeSR; if (!r) return; const res = (x, fin) => { const a = [{ transcript: x }]; a.isFinal = fin; return { resultIndex: 0, results: [a] }; }; r.onresult(res(t.split(' ').slice(0, 2).join(' '), false)); r.onresult(res(t, true)); window.__activeSR = null; r.onend && r.onend(); }, text);
    return has;
  };

  const shim = await yt.evaluate(() => ({ safari: window.__ytcSafari === true, dream: !!window.__ytcDream, url: chrome.runtime.getURL('dream/dict.json.gz'), bar: !!document.getElementById('yt2c-tutor-bar') }));
  ok('on the iPhone\'s YouTube: Safari\'s API, the tutor runs, its touch bar is at the bottom', shim.safari && shim.dream && shim.url === BASE + 'dream/dict.json.gz' && shim.bar, JSON.stringify(shim));

  // ---- 1. the AI reads the video: complete sentences, asked by the background ----
  const ready = await until(async () => { const d = await dbg(); return d && d.sentences === 10 && d.split === 'ai' ? d : null; }, 30000);
  ok('the AI rebuilt the subtitles into 10 complete sentences', !!ready, JSON.stringify(await dbg()).slice(0, 400));
  const msg = svc.find((f) => f.url === 'https://api.anthropic.com/v1/messages');
  ok('the AI was asked by the extension\'s background at api.anthropic.com, with the saved key', msg && msg.fromBg && msg.headers['x-api-key'] === 'sk-ant-test-key', JSON.stringify(svc.slice(0, 3).map((f) => ({ url: f.url, fromBg: f.fromBg }))));
  ok('the YouTube page itself fetched nothing from the AI services (all through the background)', svc.length >= 2 && svc.every((f) => f.fromBg) && !pageHits.length, JSON.stringify(pageHits.slice(0, 3)));
  const look = await yt.evaluate(() => { const host = document.getElementById('dr-panel-host'); const r = host && host.shadowRoot; const w = r && r.querySelector('.w[data-lemma="meticulous"]'); return host ? { after: host.previousElementSibling && host.previousElementSibling.id, h: host.getBoundingClientRect().height, lines: r.querySelectorAll('.s').length, hard: !!(w && w.classList.contains('hl-unknown')), text: r.textContent.includes('She checked every small detail, twice.') } : null; });
  ok('the panel sits under the player (the phone page has no right column), the AI\'s sentences in it', look && look.after === 'player-container-id' && look.h > 250 && look.lines === 10 && look.text, JSON.stringify(look));
  ok('the dictionary came from the extension (web-accessible dream/dict.json.gz): "meticulous" is above B2', look && look.hard);
  const hint = await until(() => yt.evaluate(() => { const w = document.getElementById('dr-panel-host').shadowRoot.querySelector('.w[data-lemma="gregarious"]'); return w && w.dataset.hint === '爱交际的' ? w.dataset.hint : null; }), 10000);
  ok('the AI\'s Chinese meaning of a hard word is written under it', hint === '爱交际的', hint);

  // ---- 2. a stop at "meticulous"; its "I don't know" button: explained (streamed, spoken), then on ----
  await yt.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 0; return v.play(); });
  const win = await until(async () => { const d = await dbg(); return d && d.window && d.window.target === 'meticulous' ? d : null; }, 20000);
  const v1 = await vstate();
  ok('the video stopped at "meticulous", the word said, the page shows the part', win && v1.paused && v1.t > 5 && v1.t < 8 && win.spoken.includes('meticulous') && win.stage.shown, JSON.stringify({ v1, spoken: win && win.spoken, stage: win && win.stage }));
  const mic = await until(() => yt.evaluate(() => window.__recStarts > 0), 4000);
  ok('the tutor listens for your answer (Safari\'s microphone, though voice commands are off on the iPhone)', !!mic, 'starts ' + await yt.evaluate(() => window.__recStarts));
  const tapped = await yt.evaluate(() => { const st = document.getElementById('dr-stage-host'); const roots = [document, st && st.shadowRoot, document.getElementById('dr-panel-host').shadowRoot].filter(Boolean); for (const r of roots) { const b = r.querySelector('[data-act="dont"]'); if (b) { b.click(); return true; } } return false; });
  ok('the stop\'s own "I don\'t know" button can be tapped', tapped);
  const exp = await until(async () => (await spoken()).some((x) => /very careful/.test(x)), 12000);
  ok('the explanation was streamed and spoken', !!exp, JSON.stringify((await spoken()).slice(-4)));
  const on = await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && v.t > 8 && !d.window && !d.flow ? v : null; }, 20000, 100);
  ok('then the video goes on', !!on, JSON.stringify(await vstate()));
  const entry = await until(() => { const e = stores.local.drEntries; return e && e.meticulous ? e.meticulous : null; }, 8000);
  ok('"meticulous" is in My Vocabulary, in the extension\'s storage', entry && /very careful/.test(entry.explanation), JSON.stringify(entry).slice(0, 160));
  await until(async () => (await dbg()).window, 15000); // the next stop ("ephemeral")
  await yt.evaluate(() => window.__ytcDream.action('know'));
  await until(async () => !(await vstate()).paused, 6000);

  // ---- 3. you pause: the part plays again, then it is explained, back to its start ----
  await until(async () => (await vstate()).t > 17, 20000, 100);
  const nP = apiLog.length;
  await yt.evaluate(() => document.querySelector('video').pause());
  const part = await until(async () => { const d = await dbg(); return d && d.flow === 'part' && d.stage.shown ? d : null; }, 8000);
  ok('pausing: the page shows the last 20 s in complete sentences', part && part.stage.view === 'part' && part.stage.visibleLines >= 4, JSON.stringify(part && part.stage));
  const passage = await until(() => apiLog.slice(nP).find((r) => r.kind === 'explain' && /The learner just paused the video/.test(r.user)), 25000);
  ok('after the replay the teacher explains the part', !!passage);
  const spokePart = await until(async () => (await spoken()).some((x) => /counts the sentences/.test(x)), 12000);
  ok('the part\'s explanation is spoken', !!spokePart);
  await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && !d.flow; }, 20000, 100);

  // ---- 4. the touch bar's 📞: a Claude call through Safari's speech recognition; "let's go" ----
  await yt.evaluate(() => document.querySelector('video').pause());
  await sleep(500);
  await yt.evaluate(() => window.__ytcDream.action('goOn'));
  await sleep(500);
  await until(async () => !(await dbg()).flow, 8000);
  const nC = apiLog.length;
  ok('the touch bar\'s 📞 Talk opens the call', await tap('talk'));
  const greeted = await until(async () => { const d = await dbg(); return d && d.talk && d.talk.chat && d.talk.log.some((l) => /^tutor: /.test(l)) ? d : null; }, 10000);
  ok('the tutor greets you', !!greeted, JSON.stringify((await dbg()).talk));
  await until(async () => (await dbg()).talk?.chat === 'listening', 10000);
  await sleep(1200); // (the first moment after the tutor spoke is not taken as an answer: its own echo)
  const micOpen = await hear('what does gregarious mean');
  const chatReq = await until(() => apiLog.slice(nC).find((r) => r.kind === 'chat' && /gregarious/.test(r.user)), 10000);
  ok('what Safari heard went to Claude', micOpen && !!chatReq, JSON.stringify({ micOpen, talk: (await dbg()).talk }));
  const answered = await until(async () => { const d = await dbg(); return (d.spoken || []).some((x) => /Gregarious means friendly/.test(x)); }, 12000);
  ok('Claude\'s answer is spoken', !!answered);
  await until(async () => { const ev = (await dbg()).talk?.events || []; return ev.length && /said \(ended\)/.test(ev[ev.length - 1]); }, 15000);
  await sleep(2400);
  await hear('ok let\'s go');
  const back = await until(async () => { const d = await dbg(); const v = await vstate(); return !d.talk && !v.paused ? v : null; }, 10000);
  ok('"let\'s go": the call ends and the video plays on', !!back, JSON.stringify({ talk: (await dbg()).talk, v: await vstate() }));

  // ---- 5. the touch bar's other buttons ----
  const nE = apiLog.length;
  ok('💬 Explain 30 s', await tap('explainLast') && !!(await until(() => apiLog.slice(nE).find((r) => r.kind === 'explain'), 25000)));
  await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && !d.flow; }, 30000, 150);
  await tap('vocab');
  ok('📒 Words opens My Vocabulary in a new Safari tab', !!(await until(() => created.find((u) => u === BASE + 'dream/vocab.html'), 3000)), JSON.stringify(created));
  ok('⚙ Settings opens the quick settings', await tap('quick') && await yt.evaluate(() => { const q = document.getElementById('dr-panel-host').shadowRoot.querySelector('.panel > .quick'); return !!q && !q.hidden; }));
  await tap('quick');
  await tap('tutor');
  const off = await until(async () => { const e = stores.local.drExtras; const shown = await yt.evaluate(() => ({ text: document.getElementById('yt2c-tb-tutor').textContent, btns: [...document.querySelectorAll('#yt2c-tutor-bar [data-act]')].filter((b) => b.style.display !== 'none').length })); return e && e.tutorOn === false && /off/.test(shown.text) && shown.btns === 0 ? shown : null; }, 5000);
  ok('"My tutor" on the bar turns the tutor off (saved; the other buttons hide)', !!off, JSON.stringify(off));
  await tap('tutor');
  const onAgain = await until(() => stores.local.drExtras.tutorOn === true && yt.evaluate(() => /on/.test(document.getElementById('yt2c-tb-tutor').textContent)), 5000);
  ok('...and on again', !!onAgain);

  // ---- 6. the keys: only in the extension's storage, never in YouTube's page storage ----
  const ls = await yt.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
  ok('the API key is in the extension\'s storage only (YouTube\'s page storage has the backup without keys)', stores.local.drKeys.anthropic === 'sk-ant-test-key' && !ls.includes('sk-ant-test-key'), ls.slice(0, 120));

  // ---- 7. the Microsoft voice: asked by the background, the request is right, the sound comes back whole ----
  await yt.evaluate(() => chrome.storage.local.get('drKeys').then((o) => chrome.storage.local.set({ drKeys: { ...o.drKeys, azure: 'azure-test-key-1234' } })));
  const nA = apiLog.length;
  const tts = await yt.evaluate(() => chrome.runtime.sendMessage({ type: 'dream-tts', engine: 'azure', text: 'Hello there, my friend.', voice: 'en-GB-AdaMultilingualNeural', lang: 'en' }));
  const az = apiLog.slice(nA).find((r) => r.kind === 'azure');
  const azf = svc.find((f) => /tts\.speech\.microsoft\.com\/cognitiveservices\/v1$/.test(f.url));
  ok('Microsoft (Azure) voice: SSML with the chosen voice, the key header, mp3; asked by the background, the sound came back',
    az && /<voice name="en-GB-AdaMultilingualNeural">/.test(az.ssml) && azf && azf.fromBg && azf.headers['ocp-apim-subscription-key'] === 'azure-test-key-1234' && /mp3/.test(azf.headers['x-microsoft-outputformat'] || '') && tts && tts.b64 && Buffer.from(tts.b64, 'base64').length === ttsWav.length,
    JSON.stringify({ url: azf && azf.url, got: tts && (tts.error || (tts.b64 || '').length) }));

  // ---- 8. the 🩺 Check report on Safari tells about My tutor too ----
  const dg = await yt.evaluate(() => chrome.runtime.sendMessage({ type: 'diagnose' }));
  ok('🩺 Check report (Safari) shows My tutor (on, which keys are saved, never the keys themselves)', dg && /My tutor/.test(dg.report) && /anthropic/.test(dg.report) && !/sk-ant-test-key|azure-test-key/.test(dg.report) && /\(Safari\)/.test(dg.report), (dg && dg.report || '').slice(0, 300));

  // ---- 9. the settings page (an extension page in a Safari tab) ----
  const opt = await ctx.newPage();
  extPages.add(opt);
  opt.on('pageerror', (e) => console.log('PAGE ERROR (settings)', String(e.message || e).slice(0, 300)));
  await opt.goto(BASE + 'dream/options.html');
  const shown = await until(() => opt.evaluate(() => { const l = document.getElementById('learnerLevel'); return l && l.value === 'B2' && document.getElementById('key-anthropic').placeholder === 'saved (…-key)' ? l.value : null; }), 8000)
    || await opt.evaluate(() => document.getElementById('learnerLevel').value + ' / ' + document.getElementById('key-anthropic').placeholder);
  ok('the settings page works on Safari: your level, the saved Claude key (only its end)', shown === 'B2' && !(await opt.evaluate(() => document.body.innerText.includes('sk-ant-test-key'))), String(shown));
  await opt.fill('#key-anthropic', 'sk-ant-new-key-5678');
  await opt.click('[data-save="anthropic"]');
  const saved = await until(() => stores.local.drKeys && stores.local.drKeys.anthropic === 'sk-ant-new-key-5678', 5000);
  ok('a key saved there is in the extension\'s storage, and the tutor on YouTube gets it', !!saved);
  const nT = svc.length;
  const test = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'dream-test-key', provider: 'anthropic' }));
  ok('its Test button reaches Claude through the background', test && test.ok && svc.slice(nT).some((f) => f.fromBg && f.headers['x-api-key'] === 'sk-ant-new-key-5678'), JSON.stringify(test));

  // ---- 10. Level Check in WebKit on the phone: the screen, the test, a stop in the new order, the counter ----
  stores.local.drExtras = { ...stores.local.drExtras, levelAsk: true, levelMode: true };
  const lv = await ctx.newPage();
  lv.on('pageerror', (e) => console.log('PAGE ERROR (level)', String(e.message || e).slice(0, 300)));
  await lv.goto('https://m.youtube.com/watch?v=saf00000002');
  tabs.set(2, lv); tabIdOf.set(lv, 2);
  for (const f of ytScripts.js) await lv.addScriptTag({ content: fs.readFileSync(path.join(EXT, f), 'utf8') });
  const inG = (fn) => lv.evaluate(`(${fn})(document.getElementById('dr-level-host').shadowRoot)`);
  const lvGate = await until(() => lv.evaluate(() => { const h = document.getElementById('dr-level-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=check]')); }), 15000);
  ok('Level Check: the screen comes before the video, in WebKit on the phone', !!lvGate);
  await lv.evaluate(() => document.querySelector('video').play().catch(() => {}));
  await sleep(600);
  ok('...the video waits', await lv.evaluate(() => document.querySelector('video').paused));
  const nRule = apiLog.filter((r) => /These rules are absolute/.test(r.sys)).length;
  await inG((r) => r.querySelector('[data-a=check]').click());
  const lvChips = await until(async () => { const c = await inG((r) => { const n = r.querySelectorAll('.chip').length; const t = r.textContent; return n ? [...r.querySelectorAll('.chip')].map((b) => b.textContent) : /no new words/.test(t) ? [] : null; }); return c; }, 20000);
  ok('...the test is built from this video', Array.isArray(lvChips), JSON.stringify(lvChips));
  const lvFit = await inG((r) => { const d = r.querySelector('.done') || r.querySelector('button'); const c = r.querySelector('.card').getBoundingClientRect(); return { doneBottom: d.getBoundingClientRect().bottom, screen: innerHeight, top: c.top }; });
  ok('...it fits the phone screen', lvFit.doneBottom <= lvFit.screen && lvFit.top >= 0, JSON.stringify(lvFit));
  await inG((r) => (r.querySelector('.done') || r.querySelector('[data-a=skip]')).click());
  const lvPlays = await until(() => lv.evaluate(() => !document.getElementById('dr-level-host') && !document.querySelector('video').paused), 30000);
  ok('...after it the video plays by itself', !!lvPlays);
  const lvDbg = () => lv.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const lvStop = await until(async () => { const d = await lvDbg(); return d && d.level.stops >= 1 ? d : null; }, 30000, 150);
  ok('a stop comes, counted', !!lvStop, JSON.stringify(await lvDbg()).slice(0, 300));
  const lvRule = await until(() => apiLog.filter((r) => /These rules are absolute/.test(r.sys)).slice(nRule)[0], 10000);
  ok('...its explanation is asked for with the hard rule', !!lvRule);
  const lvOn = await until(async () => { const d = await lvDbg(); return d && d.state === 'playing' && !(await lv.evaluate(() => document.querySelector('video').paused)); }, 30000, 150);
  const lvEnd = await lvDbg();
  ok('the analysis was one call, nothing asked of the AI at the stop', lvEnd.level.aiCalls === 1 && apiLog.filter((r) => /These rules are absolute/.test(r.sys)).slice(nRule).length === 1, JSON.stringify({ calls: lvEnd.level.aiCalls }));
  ok('...and the video goes on by itself', !!lvOn, JSON.stringify(await lvDbg()).slice(0, 200));
  const lvCount = await lv.evaluate(() => document.getElementById('dr-stop-counter')?.textContent || '');
  ok('the small counter shows, at 50% or under', /^\d+\/\d+ \((\d+)%\)$/.test(lvCount) && +/\((\d+)%/.exec(lvCount)[1] <= 50, lvCount);
  await lv.close();

  // ---- 11. the reading mode in WebKit: a real PDF through pdf.js ----
  const esc = (t) => t.replace(/([()\\])/g, '\\$1');
  const SENT = ['My friend was very meticulous about her work.', 'She walked to the shop and bought some bread.', 'It was a lugubrious moment of joy.', 'The children played in the garden after school.', 'We will talk about it again very soon.', 'My uncle is an obsequious man.'];
  const content = `BT /F1 12 Tf 72 720 Td 14 TL ${SENT.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n'; const at = [];
  objs.forEach((o, i) => { at.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((a) => `${String(a).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const rd = await ctx.newPage();
  extPages.add(rd);
  rd.on('pageerror', (e) => console.log('PAGE ERROR (reader)', String(e.message || e).slice(0, 300)));
  await rd.goto(BASE + 'dream/reader.html');
  await rd.setInputFiles('#file', { name: 'Story.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf, 'latin1') });
  const rOpen = await until(() => rd.evaluate(() => document.body.dataset.sentences), 25000);
  ok('reading mode in WebKit: a PDF opens, all its sentences, exactly the original text', rOpen === String(SENT.length) && (await rd.evaluate(() => document.getElementById('text').textContent.replace(/\s+/g, ' ').trim())) === SENT.join(' '), `${rOpen} · ${await rd.evaluate(() => document.getElementById('open-msg').textContent)}`);
  await until(() => rd.evaluate(() => { const h = document.getElementById('dr-level-host'); const b = h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=skip]'); if (b) b.click(); return !!b; }), 8000);
  const rEnd = await until(() => rd.evaluate(() => { const d = JSON.parse(document.documentElement.dataset.drDebug || 'null'); return d && d.heard >= d.total && !d.playing ? d : null; }), 60000, 200);
  ok('...it reads to the end by itself, stops at 50% or under', rEnd && rEnd.stops >= 1 && rEnd.stops <= rEnd.total / 2, JSON.stringify(rEnd && { stops: rEnd.stops, total: rEnd.total }));
  await rd.close();

  await browser.close();
  api.close();
  console.log(fails ? `\n${fails} FAILED` : '\nSAFARI MY TUTOR: ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
