// My tutor in the iPhone / iPad app (YT Learn), tested in WebKit (the iPhone's engine) without Xcode.
// A fake m.youtube.com page gets exactly the scripts the app puts into its YouTube window (the same files, in the same
// order: read from AppModel.swift), and a stand-in for the app's Swift side (window.webkit.messageHandlers.ytc) answers
// from Node like Bridge.swift does: the JSON store, the Keychain, URLSession fetches streamed back in pieces
// (NativeFetch.swift), the app's own files (ytlearn://app/…), the iOS voice (AVSpeechSynthesizer) and the microphone.
// The AI and Microsoft are a fake server on localhost; the tutor itself calls the real addresses (api.anthropic.com, …),
// which only the stand-in for Swift sends to the fake server.
// Checks: subtitles -> complete sentences (AI), the dictionary, the panel under the player, a stop with "I don't know"
// from the app's button, the explanation streamed and spoken, the pause flow, a Claude call through the iOS microphone,
// "let's go", the keys only in the Keychain, the iOS voice, the Microsoft voice request, the settings page in the sheet.
// Run ios/sync-scripts.sh first (the CI does).
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
setTimeout(() => { console.log('FAIL  test took longer than 6 minutes (stuck) - stopping'); process.exit(1); }, 6 * 60 * 1000).unref();

// ---- the scripts of the app's windows, in the app's order ----
const swift = fs.readFileSync(path.join(IOS, 'AppModel.swift'), 'utf8');
const listOf = (name) => JSON.parse(new RegExp(`static let ${name} = (\\[[^\\]]*\\])`).exec(swift)[1]);
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
const pr = JSON.stringify({ videoDetails: { videoId: 'ios00000001', title: 'Dream Lesson', lengthSeconds: String(DUR) }, playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://m.youtube.com/api/timedtext?v=ios00000001&lang=en', languageCode: 'en' }] } } });
const makeWav = (sec, tone) => { const n = Math.round(8000 * sec), b = Buffer.alloc(44 + n, 128); if (tone) for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(50 * Math.sin(2 * Math.PI * 330 * i / 8000)); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; };
const wav = makeWav(DUR, true);
const ttsWav = makeWav(0.25, false);
// the phone page: no right column; the player on top, the video's details and related videos under it
const ytHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dream Lesson - YouTube</title></head><body style="margin:0;background:#fff">
<ytm-app><ytm-watch><div id="player-container-id" class="player-container" style="position:relative;width:100%;height:220px;background:#123">
  <div id="movie_player" class="html5-video-player" style="width:100%;height:100%"><video muted playsinline src="https://m.youtube.com/v.wav" class="html5-main-video" style="width:100%;height:100%"></video></div></div>
<ytm-single-column-watch-next-results-renderer><div id="below"><h2 class="slim-video-metadata-title">Dream Lesson</h2></div><ytm-item-section-renderer>related videos</ytm-item-section-renderer></ytm-single-column-watch-next-results-renderer>
</ytm-watch></ytm-app><script>var ytInitialPlayerResponse = ${pr};</script></body></html>`;

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
}).listen(8791);
const FAKE = 'http://localhost:8791';

// ---- the stand-in for the app's Swift side (Bridge.swift) ----
const stores = { local: {}, sync: {} };
const keychain = {};
const nativeLog = [];
const fetchLog = [];
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
    case 'chatInfo': return { url: '' };
    default: return null; // speakStop, speakPause, speakResume, speech, openPage, audioSession, log, voice …
  }
}
// what the Swift side is made of, in the page: the message handler (answers as a promise)
const fakeWebkit = () => {
  const handler = { postMessage: (o) => window.__ytcNative(JSON.stringify(o)).then((r) => (r === undefined || r === null ? r : JSON.parse(r))) };
  Object.defineProperty(window, 'webkit', { value: { messageHandlers: { ytc: handler } }, configurable: true });
};

(async () => {
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());
  ok('the app has the newest tutor (ios/sync-scripts.sh copied the built files)', ['dream-yt.js'].every((f) => fs.readFileSync(path.join(IOS, 'Scripts', f), 'utf8') === fs.readFileSync(path.join(BUILT, f), 'utf8'))
    && fs.readFileSync(path.join(IOS, 'Scripts', 'dream-bg.js'), 'utf8').includes(fs.readFileSync(path.join(BUILT, 'dream-bg.js'), 'utf8'))
    && fs.existsSync(path.join(IOS, 'Web/dream/dict.json.gz')), JSON.stringify(ytScripts));

  const ctx = await browser.newContext({ ...pw.devices['iPhone 13'] });
  await ctx.exposeBinding('__ytcNative', async ({ page }, json) => { const r = await native(page, JSON.parse(json)); return r === null || r === undefined ? null : JSON.stringify(r); });
  await ctx.addInitScript(fakeWebkit);
  const pageHits = []; // the page asking the services itself (it must not: CORS and the page's limits)
  ctx.on('request', (r) => { if (/api\.anthropic\.com|api\.openai\.com|tts\.speech\.microsoft\.com|localhost:8791/.test(r.url())) pageHits.push(r.url()); });
  await ctx.route('https://m.youtube.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/v.wav')) { const rg = route.request().headers().range; if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], e = m[2] ? +m[2] : wav.length - 1; return route.fulfill({ status: 206, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${e}/${wav.length}` }, body: wav.slice(a, e + 1) }); } return route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' }, body: wav }); }
    if (u.includes('/api/timedtext')) return route.fulfill({ status: 200, contentType: 'application/json', body: json3 });
    return route.fulfill({ status: 200, contentType: 'text/html', body: ytHtml });
  });

  // what the app has saved before (the tutor on, test-friendly timings); the Claude key is in the Keychain
  Object.assign(stores.local, {
    voiceOn: true, sendOn: false, target: 'claude', barOn: true,
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 1 }, // (no starting data: these tests have their own words)
    drExtras: { levelAsk: false, levelMode: false, tutorOn: true, fakeVoice: true, explainOnStop: true, panel: true, band: 'auto', talkAfterExplain: false, migrated: 1, stopGapSec: 0, callEngine: 'claude', talkSilenceSec: 0, stopSentences: false },
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 20 } },
  });
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });

  const yt = await ctx.newPage();
  yt.on('pageerror', (e) => console.log('PAGE ERROR', String(e.message || e).slice(0, 300)));
  await yt.goto('https://m.youtube.com/watch?v=ios00000001');
  await yt.addScriptTag({ content: source(ytScripts) }); // = the app's WKUserScript at document end
  const dbg = () => yt.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const vstate = () => yt.evaluate(() => { const v = document.querySelector('video'); return { t: +v.currentTime.toFixed(2), paused: v.paused }; });
  const spoken = () => dbg().then((d) => (d && d.spoken) || []);
  const act = (id) => yt.evaluate((x) => window.__ytcDream.action(x), id);
  // what Swift sends when SFSpeechRecognizer heard something: the words so far, then the closed sentence, then the end
  // (only while the page's listener has the microphone, as on the phone)
  const hear = async (text) => {
    const has = await until(() => yt.evaluate(() => !!window.__ytcActiveSR), 8000, 100);
    await yt.evaluate((t) => { window.__ytcSpeech({ type: 'result', text: t.split(' ').slice(0, 2).join(' '), final: false }); window.__ytcSpeech({ type: 'result', text: t, final: true }); window.__ytcSpeech({ type: 'end' }); }, text);
    return has;
  };

  const shim = await yt.evaluate(() => ({ id: chrome.runtime.id, update: chrome.runtime.getManifest().update_url, url: chrome.runtime.getURL('dream/dict.json.gz'), dream: !!window.__ytcDream, action: typeof (window.__ytcDream && window.__ytcDream.action) }));
  ok('the shims: the tutor runs, its files come from ytlearn://app/, no self-update, the app\'s buttons can drive it', shim.dream && shim.id && shim.update === 'ios' && shim.url === 'ytlearn://app/dream/dict.json.gz' && shim.action === 'function', JSON.stringify(shim));

  // ---- 1. the AI reads the video: complete sentences, through Swift's fetch, streamed ----
  const ready = await until(async () => { const d = await dbg(); return d && d.sentences === 10 && d.split === 'ai' ? d : null; }, 30000);
  ok('the AI rebuilt the subtitles into 10 complete sentences', !!ready, JSON.stringify(await dbg()).slice(0, 400));
  const msg = fetchLog.find((f) => f.url === 'https://api.anthropic.com/v1/messages');
  ok('the AI was asked by Swift (URLSession) at api.anthropic.com, with the key from the Keychain, the answer streamed in pieces',
    msg && msg.headers['x-api-key'] === 'sk-ant-test-key' && fetchLog.some((f) => f.chunks > 1), JSON.stringify(fetchLog.slice(0, 3).map((f) => ({ url: f.url, chunks: f.chunks }))));
  ok('the page itself fetched nothing from the AI services (every request went through Swift)', fetchLog.length >= 2 && !pageHits.length, JSON.stringify(pageHits.slice(0, 3)));
  const look = await yt.evaluate(() => { const host = document.getElementById('dr-panel-host'); const r = host && host.shadowRoot; const w = r && r.querySelector('.w[data-lemma="meticulous"]'); return host ? { after: host.previousElementSibling && host.previousElementSibling.id, h: host.getBoundingClientRect().height, lines: r.querySelectorAll('.s').length, hard: !!(w && w.classList.contains('hl-unknown')), text: r.textContent.includes('She checked every small detail, twice.') } : null; });
  ok('the panel sits under the player (the phone page has no right column), the AI\'s sentences in it', look && look.after === 'player-container-id' && look.h > 250 && look.lines === 10 && look.text, JSON.stringify(look));
  ok('the dictionary came from the app (ytlearn://app/dream/dict.json.gz): "meticulous" is above B2', look && look.hard && nativeLog.some((l) => l.kind === 'resource' && l.path === 'dream/dict.json.gz'), JSON.stringify(nativeLog.filter((l) => l.kind === 'resource')));
  const hint = await until(() => yt.evaluate(() => { const w = document.getElementById('dr-panel-host').shadowRoot.querySelector('.w[data-lemma="gregarious"]'); return w && w.dataset.hint === '爱交际的' ? w.dataset.hint : null; }), 10000);
  ok('the AI\'s Chinese meaning of a hard word is written under it', hint === '爱交际的', hint);

  // ---- 2. a stop at "meticulous"; the app's "I don't know" button: explained (streamed, spoken), the sentence again, on ----
  await yt.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 0; return v.play(); });
  const win = await until(async () => { const d = await dbg(); return d && d.window && d.window.target === 'meticulous' ? d : null; }, 20000);
  const v1 = await vstate();
  ok('the video stopped at "meticulous", the word said, the page shows the part', win && v1.paused && v1.t > 5 && v1.t < 8 && win.spoken.includes('meticulous') && win.stage.shown, JSON.stringify({ v1, spoken: win && win.spoken, stage: win && win.stage }));
  ok('the app\'s "I don\'t know" button works', await act('dontKnow') === true);
  const exp = await until(async () => (await spoken()).some((x) => /very careful/.test(x)), 12000);
  ok('the explanation was streamed and spoken', !!exp, JSON.stringify((await spoken()).slice(-4)));
  const on = await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && v.t > 8 && !d.window && !d.flow ? v : null; }, 20000, 100);
  ok('then the video goes on', !!on, JSON.stringify(await vstate()));
  const entry = await until(() => { const e = stores.local.drEntries; return e && e.meticulous ? e.meticulous : null; }, 8000);
  ok('"meticulous" is in My Vocabulary, saved in the app\'s JSON store', entry && /very careful/.test(entry.explanation), JSON.stringify(entry).slice(0, 160));
  await until(async () => (await dbg()).window, 15000); // the next stop ("ephemeral")
  await act('know');
  await until(async () => !(await vstate()).paused, 6000);

  // ---- 3. you pause: the part plays again, then it is explained (the whole part), back to its start ----
  await until(async () => (await vstate()).t > 17, 20000, 100);
  const nP = apiLog.length;
  await yt.evaluate(() => document.querySelector('video').pause());
  const part = await until(async () => { const d = await dbg(); return d && d.flow === 'part' && d.stage.shown ? d : null; }, 8000);
  ok('pausing: the page shows the last 20 s in complete sentences', part && part.stage.view === 'part' && part.stage.visibleLines >= 4, JSON.stringify(part && part.stage));
  const passage = await until(() => apiLog.slice(nP).find((r) => r.kind === 'explain' && /The learner just paused the video/.test(r.user)), 25000);
  ok('after the replay the teacher explains the part (your rules)', !!passage);
  const spokePart = await until(async () => (await spoken()).some((x) => /counts the sentences/.test(x)), 12000);
  ok('the part\'s explanation is spoken', !!spokePart);
  await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && !d.flow; }, 20000, 100);

  // ---- 4. 📞 the Claude call through the iOS microphone; "let's go" ----
  await yt.evaluate(() => document.querySelector('video').pause());
  await sleep(500);
  await act('goOn');
  await sleep(500);
  await until(async () => !(await dbg()).flow, 8000);
  const nC = apiLog.length;
  const micBefore = nativeLog.filter((l) => l.kind === 'speech' && l.op === 'start').length;
  ok('the app\'s 📞 button opens the call', await act('talk') === true);
  const greeted = await until(async () => { const d = await dbg(); return d && d.talk && d.talk.chat && d.talk.log.some((l) => /^tutor: /.test(l)) ? d : null; }, 10000);
  ok('the tutor greets you', !!greeted, JSON.stringify((await dbg()).talk));
  const listening = await until(async () => (await dbg()).talk?.chat === 'listening' && nativeLog.filter((l) => l.kind === 'speech' && l.op === 'start').length > micBefore, 10000);
  ok('the iOS microphone (SFSpeechRecognizer) was turned on for the call', !!listening, JSON.stringify(nativeLog.filter((l) => l.kind === 'speech').slice(-4)));
  await sleep(1200); // (the first moment after the tutor spoke is not taken as an answer: its own echo)
  const micOpen = await hear('what does gregarious mean');
  const chatReq = await until(() => apiLog.slice(nC).find((r) => r.kind === 'chat' && /gregarious/.test(r.user)), 10000);
  ok('what iOS heard went to Claude', micOpen && !!chatReq, JSON.stringify({ micOpen, talk: (await dbg()).talk }));
  const answered = await until(async () => { const d = await dbg(); return (d.spoken || []).some((x) => /Gregarious means friendly/.test(x)); }, 12000);
  ok('Claude\'s answer is spoken', !!answered);
  await until(async () => { const ev = (await dbg()).talk?.events || []; return ev.length && /said \(ended\)/.test(ev[ev.length - 1]); }, 15000);
  await sleep(1200);
  await until(async () => nativeLog.filter((l) => l.kind === 'speech' && l.op === 'start').length > micBefore + 1 || (await dbg()).talk?.chat === 'listening', 8000);
  await sleep(1200);
  await hear('ok let\'s go');
  const back = await until(async () => { const d = await dbg(); const v = await vstate(); return !d.talk && !v.paused ? v : null; }, 10000);
  ok('"let\'s go": the call ends and the video plays on', !!back, JSON.stringify({ talk: (await dbg()).talk, v: await vstate() }));

  // ---- 5. the keys: only in the Keychain; a new key saved in ⚙ goes there too ----
  await yt.evaluate(() => chrome.storage.local.get('drKeys').then((o) => chrome.storage.local.set({ drKeys: { ...o.drKeys, azure: 'azure-test-key-1234' } })));
  const kc = JSON.parse(keychain.drKeys || '{}');
  ok('the API keys are only in the Keychain, never in the app\'s JSON store', kc.anthropic === 'sk-ant-test-key' && kc.azure === 'azure-test-key-1234' && !('drKeys' in stores.local) && !JSON.stringify(stores).includes('sk-ant-test-key'), JSON.stringify(Object.keys(stores.local)));

  // ---- 6. the Microsoft voice: the request is right and the sound comes back whole ----
  const nA = apiLog.length;
  const tts = await yt.evaluate(() => chrome.runtime.sendMessage({ type: 'dream-tts', engine: 'azure', text: 'Hello there, my friend.', voice: 'en-GB-AdaMultilingualNeural', lang: 'en' }));
  const az = apiLog.slice(nA).find((r) => r.kind === 'azure');
  const azf = fetchLog.find((f) => /tts\.speech\.microsoft\.com\/cognitiveservices\/v1$/.test(f.url));
  ok('Microsoft (Azure) voice: SSML with the chosen voice, the key header, mp3 asked; the sound came back through Swift',
    az && /<voice name="en-GB-AdaMultilingualNeural">/.test(az.ssml) && azf && azf.headers['ocp-apim-subscription-key'] === 'azure-test-key-1234' && /mp3/.test(azf.headers['x-microsoft-outputformat'] || '') && tts && tts.b64 && Buffer.from(tts.b64, 'base64').length === ttsWav.length,
    JSON.stringify({ url: azf && azf.url, headers: azf && azf.headers, got: tts && (tts.error || (tts.b64 || '').length) }));

  // ---- 7. the app's other buttons: My Vocabulary opens in the app's sheet; ⚙ quick settings ----
  await act('vocab');
  ok('📒 opens My Vocabulary in the app (ytlearn://app/dream/vocab.html)', !!(await until(() => nativeLog.find((l) => l.kind === 'openPage' && /ytlearn:\/\/app\/dream\/vocab\.html/.test(l.url)), 3000)));
  ok('⚙ opens the quick settings', await act('quick') === true && await yt.evaluate(() => { const q = document.getElementById('dr-panel-host').shadowRoot.querySelector('.panel > .quick'); return !!q && !q.hidden; }));
  await act('quick');

  // ---- 8. the iOS voice (no fake voice): AVSpeechSynthesizer says the explanation, its events drive the tutor ----
  stores.local.drExtras = { ...stores.local.drExtras, fakeVoice: false };
  const kc2 = JSON.parse(keychain.drKeys); delete kc2.azure; keychain.drKeys = JSON.stringify(kc2); // 'auto' = the system voice now
  const yt2 = await ctx.newPage();
  yt2.on('pageerror', (e) => console.log('PAGE ERROR (2)', String(e.message || e).slice(0, 300)));
  await yt.close();
  await yt2.goto('https://m.youtube.com/watch?v=ios00000001');
  await yt2.addScriptTag({ content: source(ytScripts) });
  const probe = await yt2.evaluate(() => new Promise((res) => { const u = new SpeechSynthesisUtterance('Testing the voice.'); const ev = []; u.onstart = () => ev.push('start'); u.onboundary = () => ev.push('word'); u.onend = () => { ev.push('end'); res(ev); }; speechSynthesis.speak(u); setTimeout(() => res(ev), 4000); }));
  ok('speechSynthesis is the iOS voice: start, every word, end', probe[0] === 'start' && probe.includes('word') && probe[probe.length - 1] === 'end', JSON.stringify(probe));
  await until(() => yt2.evaluate(() => { const h = document.getElementById('dr-panel-host'); return h && h.shadowRoot.querySelectorAll('.s').length === 10; }), 30000);
  await yt2.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 4.5; return v.play(); });
  await until(() => nativeLog.some((l) => l.kind === 'speak' && l.text === 'meticulous'), 20000);
  await yt2.evaluate(() => window.__ytcDream.action('dontKnow'));
  const said = await until(() => nativeLog.find((l) => l.kind === 'speak' && /very careful/.test(l.text || '')), 15000);
  ok('the explanation was said by the iOS voice (a Premium British voice by default)', said && said.voice === 'com.apple.voice.premium.en-GB.Malcolm', JSON.stringify(said || nativeLog.filter((l) => l.kind === 'speak').slice(-3)));
  const goes = await until(() => yt2.evaluate(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime > 8; }), 30000, 150);
  ok('when the iOS voice says it is done, the tutor plays the video on', !!goes, JSON.stringify(await yt2.evaluate(() => document.querySelector('video').currentTime)));
  await yt2.close();

  // ---- 9. the settings page in the app's sheet (its own window: the shims + the tutor's background, at document start) ----
  const pages = http.createServer((q, r) => { const f = path.join(IOS, 'Web/dream', path.basename(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f)); }).listen(8792);
  const sheet = await ctx.newPage();
  sheet.on('pageerror', (e) => console.log('PAGE ERROR (settings)', String(e.message || e).slice(0, 300)));
  await sheet.addInitScript({ content: source(sheetScripts) });
  await sheet.goto('http://localhost:8792/options.html');
  const shown = await until(() => sheet.evaluate(() => { const m = document.body.innerText; return /saved|…/i.test(m) && document.getElementById('learnerLevel') && document.getElementById('learnerLevel').value; }), 8000);
  ok('the settings page works in the sheet: it shows your level and the saved Claude key (only its end)', shown === 'B2' && !(await sheet.evaluate(() => document.body.innerText.includes('sk-ant-test-key'))), String(shown));
  await sheet.fill('#key-anthropic', 'sk-ant-new-key-5678');
  await sheet.click('[data-save="anthropic"]');
  const saved = await until(() => JSON.parse(keychain.drKeys || '{}').anthropic === 'sk-ant-new-key-5678', 5000);
  ok('a key saved on the settings page goes to the Keychain', !!saved && !JSON.stringify(stores).includes('sk-ant-new-key'), keychain.drKeys && JSON.stringify(Object.keys(JSON.parse(keychain.drKeys))));

  // ---- 10. the reading mode in the app's sheet: paste a text, Level Check, it reads, stops at 50 % or under ----
  stores.local.drExtras = { ...stores.local.drExtras, fakeVoice: true, levelAsk: true, levelMode: true };
  const READ = ['My friend was very meticulous about her work.', 'She walked to the shop and bought some bread.', 'It was a lugubrious moment of joy.', 'The children played in the garden after school.', 'We will talk about it again very soon.', 'My uncle is an obsequious man.'];
  const reader = await ctx.newPage();
  reader.on('pageerror', (e) => console.log('PAGE ERROR (reader)', String(e.message || e).slice(0, 300)));
  await reader.addInitScript({ content: source(sheetScripts) });
  await reader.goto('http://localhost:8792/reader.html');
  await reader.fill('#paste', READ.join(' '));
  await reader.click('#paste-go');
  const rOpen = await until(() => reader.evaluate(() => document.body.dataset.sentences), 15000);
  ok('the reading mode opens in the app\'s sheet: a pasted text, all its sentences, exactly as it was', rOpen === String(READ.length) && (await reader.evaluate(() => document.getElementById('text').textContent)) === READ.join(' '), `${rOpen} · ${await reader.evaluate(() => document.getElementById('open-msg').textContent)}`);
  const rSkip = await until(() => reader.evaluate(() => { const h = document.getElementById('dr-level-host'); const b = h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=skip]'); if (b) b.click(); return !!b; }), 8000);
  ok('...Level Check first ("Skip, just play" here)', !!rSkip);
  const rEnd = await until(() => reader.evaluate(() => { const d = JSON.parse(document.documentElement.dataset.drDebug || 'null'); return d && d.heard >= d.total && !d.playing ? d : null; }), 60000, 200);
  ok('...it reads to the end by itself with the iOS bridge, stops at 50% or under', rEnd && rEnd.stops >= 1 && rEnd.stops <= rEnd.total / 2, JSON.stringify(rEnd && { stops: rEnd.stops, total: rEnd.total }));
  await reader.close();
  pages.close();

  // ---- 11. Level Check in the app: the screen, the test, a stop in the new order, the counter, the copy for Claude ----
  const lv = await ctx.newPage();
  lv.on('pageerror', (e) => console.log('PAGE ERROR (level)', String(e.message || e).slice(0, 300)));
  await lv.goto('https://m.youtube.com/watch?v=ios00000002');
  await lv.addScriptTag({ content: source(ytScripts) });
  const inG = (fn) => lv.evaluate(`(${fn})(document.getElementById('dr-level-host').shadowRoot)`);
  const gate = await until(() => lv.evaluate(() => { const h = document.getElementById('dr-level-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=check]')); }), 15000);
  ok('Level Check: the screen comes before the video, in the app', !!gate);
  await lv.evaluate(() => document.querySelector('video').play().catch(() => {}));
  await sleep(600);
  ok('...the video waits', await lv.evaluate(() => document.querySelector('video').paused));
  await inG((r) => r.querySelector('[data-a=check]').click());
  const chips = await until(() => inG((r) => { const n = r.querySelectorAll('.chip').length; return n ? [...r.querySelectorAll('.chip')].map((b) => b.textContent) : /no new words/.test(r.textContent) ? [] : null; }), 20000);
  ok('...the test comes from this video', Array.isArray(chips) && chips.every((c) => LINES.join(' ').toLowerCase().includes(c.toLowerCase())), JSON.stringify(chips));
  const fit = await inG((r) => { const d = r.querySelector('.done') || r.querySelector('button'); return { bottom: d.getBoundingClientRect().bottom, screen: innerHeight }; });
  ok('...it fits the phone screen', fit.bottom <= fit.screen, JSON.stringify(fit));
  await inG((r) => (r.querySelector('.done') || r.querySelector('[data-a=skip]')).click());
  const plays = await until(() => lv.evaluate(() => !document.getElementById('dr-level-host') && !document.querySelector('video').paused), 10000);
  ok('...after it the video plays by itself', !!plays);
  const lvDbg = () => lv.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const nRule = apiLog.filter((r) => /These rules are absolute/.test(r.sys)).length;
  const stop = await until(async () => { const d = await lvDbg(); return d && d.level.stops >= 1 ? d : null; }, 30000, 150);
  ok('a stop comes, counted', !!stop, JSON.stringify(await lvDbg()).slice(0, 300));
  ok('...its explanation is asked for with the hard rule', !!(await until(() => apiLog.filter((r) => /These rules are absolute/.test(r.sys)).slice(nRule)[0], 10000)));
  const goesOn = await until(async () => { const d = await lvDbg(); return d && d.state === 'playing' && !(await lv.evaluate(() => document.querySelector('video').paused)); }, 30000, 150);
  ok('...and the video goes on by itself', !!goesOn, JSON.stringify(await lvDbg()).slice(0, 200));
  const count = await lv.evaluate(() => document.getElementById('dr-stop-counter')?.textContent || '');
  ok('the small counter shows, at 50% or under', /^\d+\/\d+ \((\d+)%\)$/.test(count) && +/\((\d+)%/.exec(count)[1] <= 50, count);
  const copy = await lv.evaluate(() => chrome.runtime.sendMessage({ type: 'dream-level-copy' }));
  ok('"Copy my level for Claude" has my level and words', copy && /My English level/.test(copy.text) && /Still learning/.test(copy.text), copy && copy.text.slice(0, 200));
  ok('the keys stay out of it', copy && !copy.text.includes('sk-ant'));
  await lv.close();

  await browser.close();
  api.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
