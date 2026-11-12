// My tutor inside the iOS app: the parts of chrome.* the Dream Tutor needs on top of shim-common.js.
//  - ports (chrome.runtime.connect <-> onConnect): the tutor and its "background" (dream-bg.js) run in this same page
//  - getURL / getManifest / id: the app's own files come from ytlearn://app/… (no self-update: update_url is set)
//  - the API keys live in the iOS Keychain, never in the JSON store
//  - the AI and voice services are fetched by Swift (URLSession), streamed back here (no CORS, no page limits)
//  - the system voice: iOS's own AVSpeechSynthesizer behind the Web Speech interface
// Loaded after shim-common.js (and shim-youtube.js in the YouTube window), before lib.js / dream-bg.js / dream-yt.js.
(function () {
  if (window.__ytcShimDream) return;
  window.__ytcShimDream = true;
  window.__ytcIOS = true;

  const post = (obj) => window.webkit.messageHandlers.ytc.postMessage(obj);
  const chrome = window.chrome;
  const rt = chrome.runtime;

  // ---- ports: two ends in this page; a message is a copy and arrives a moment later, like in Chrome ----
  const connectListeners = [];
  function makePorts(name) {
    const ends = [{ msg: [], dis: [], open: true }, { msg: [], dis: [], open: true }];
    const make = (me, other) => ({
      name,
      sender: window.__ytcSender ? window.__ytcSender() : {},
      onMessage: { addListener: (f) => ends[me].msg.push(f), removeListener: (f) => { ends[me].msg = ends[me].msg.filter((x) => x !== f); } },
      onDisconnect: { addListener: (f) => ends[me].dis.push(f), removeListener: (f) => { ends[me].dis = ends[me].dis.filter((x) => x !== f); } },
      postMessage: (m) => {
        if (!ends[me].open) throw new Error('Attempting to use a disconnected port object');
        const copy = JSON.parse(JSON.stringify(m === undefined ? null : m));
        setTimeout(() => { if (ends[other].open) ends[other].msg.slice().forEach((f) => { try { f(copy, ports[other]); } catch (e) { console.warn(e); } }); }, 0);
      },
      disconnect: () => {
        if (!ends[me].open) return;
        ends[me].open = false;
        setTimeout(() => {
          if (!ends[other].open) return;
          ends[other].open = false;
          ends[other].dis.slice().forEach((f) => { try { f(ports[other]); } catch (e) { console.warn(e); } });
        }, 0);
      }
    });
    const ports = [make(0, 1), make(1, 0)];
    return ports;
  }
  rt.connect = (info) => {
    const [client, server] = makePorts((info && info.name) || '');
    setTimeout(() => connectListeners.slice().forEach((f) => { try { f(server); } catch (e) { console.warn(e); } }), 0);
    return client;
  };
  rt.onConnect = { addListener: (f) => connectListeners.push(f) };
  rt.id = 'ytlearn-ios';
  rt.getURL = (p) => 'ytlearn://app/' + String(p).replace(/^\/+/, '');
  rt.getManifest = () => ({ manifest_version: 3, version: '3.8', name: 'I Know', update_url: 'ios' });
  // the vocabulary file: the Mac helper's messages (ping / read / write), answered by the app (VocabFile.swift)
  rt.sendNativeMessage = (host, msg) => post({ kind: 'vocabFile', host, msg });
  rt.reload = () => {};
  rt.getPlatformInfo = () => Promise.resolve({ os: 'ios', arch: 'arm' });

  // the settings page and My Vocabulary open in a sheet of the app (not in the chat window)
  const tabs = chrome.tabs || (chrome.tabs = { query: () => Promise.resolve([]), get: () => Promise.resolve(null), sendMessage: () => Promise.resolve(undefined) });
  const createTab = tabs.create;
  tabs.create = (opts) => {
    const url = (opts && opts.url) || '';
    if (/^ytlearn:/.test(url) || !createTab) return post({ kind: 'openPage', url }).then(() => ({ id: 3, url, active: true }));
    return createTab(opts);
  };
  tabs.reload = () => Promise.resolve();

  // ---- the API keys: the Keychain ----
  const KEYS = 'drKeys';
  const local = chrome.storage.local;
  const origGet = local.get, origSet = local.set, origRemove = local.remove;
  const wantsKeys = (keys) => keys == null || keys === KEYS || (Array.isArray(keys) ? keys.includes(KEYS) : typeof keys === 'object' && KEYS in keys);
  async function readKeys() {
    try { const t = await post({ kind: 'keychainGet', name: KEYS }); return t ? JSON.parse(t) : {}; } catch (e) { return {}; }
  }
  local.get = async (keys, cb) => {
    const r = await origGet(keys);
    delete r[KEYS];
    if (wantsKeys(keys)) {
      const k = await readKeys();
      if (Object.keys(k).length) r[KEYS] = k;
      else if (keys && typeof keys === 'object' && !Array.isArray(keys) && keys[KEYS] !== undefined) r[KEYS] = keys[KEYS];
    }
    if (typeof cb === 'function') cb(r);
    return r;
  };
  local.set = async (obj, cb) => {
    if (obj && KEYS in obj) {
      const old = await readKeys();
      await post({ kind: 'keychainSet', name: KEYS, value: JSON.stringify(obj[KEYS] || {}) });
      const rest = Object.assign({}, obj);
      delete rest[KEYS];
      window.__ytcFireChanged({ [KEYS]: { oldValue: old, newValue: obj[KEYS] } }, 'local');
      if (Object.keys(rest).length) await origSet(rest);
    } else await origSet(obj);
    if (typeof cb === 'function') cb();
  };
  local.remove = async (keys, cb) => {
    const list = [].concat(keys);
    if (list.includes(KEYS)) {
      const old = await readKeys();
      await post({ kind: 'keychainSet', name: KEYS, value: null });
      window.__ytcFireChanged({ [KEYS]: { oldValue: old } }, 'local');
    }
    const rest = list.filter((k) => k !== KEYS);
    if (rest.length) await origRemove(rest);
    if (typeof cb === 'function') cb();
  };

  // ---- fetch: the AI / voice services and the app's own files go through Swift ----
  const API = /^https:\/\/(api\.anthropic\.com|api\.openai\.com|api\.elevenlabs\.io|lrclib\.net|api\.github\.com|gist\.githubusercontent\.com|[a-z0-9-]+\.tts\.speech\.microsoft\.com)\//i;
  const APP = /^ytlearn:\/\/app\/(.*)$/;
  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(b64 || '');
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const streams = {};
  let nextId = 0;
  window.__ytcFetchChunk = (id, b64) => { const s = streams[id]; if (s) s.push(fromB64(b64)); };
  window.__ytcFetchEnd = (id, error) => { const s = streams[id]; if (s) { delete streams[id]; s.end(error); } };
  const abortError = () => { try { return new DOMException('The operation was aborted.', 'AbortError'); } catch (e) { const x = new Error('The operation was aborted.'); x.name = 'AbortError'; return x; } };

  async function nativeFetch(req, signal) {
    if (signal && signal.aborted) throw abortError();
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer());
    const headers = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const id = ++nextId;
    let ctrl = null;
    const early = [];
    let ended;
    const stream = new ReadableStream({
      start(c) { ctrl = c; early.forEach((b) => c.enqueue(b)); if (ended !== undefined) finish(ended); },
      cancel() { delete streams[id]; post({ kind: 'nativeFetchCancel', id }).catch(() => {}); }
    });
    function finish(error) { try { if (error) ctrl.error(new TypeError(String(error))); else ctrl.close(); } catch (e) { /* closed already */ } }
    streams[id] = {
      push: (b) => { if (ctrl) { try { ctrl.enqueue(b); } catch (e) { /* closed */ } } else early.push(b); },
      end: (error) => { if (ctrl) finish(error); else ended = error || null; }
    };
    if (signal) signal.addEventListener('abort', () => { post({ kind: 'nativeFetchCancel', id }).catch(() => {}); window.__ytcFetchEnd(id, 'aborted'); }, { once: true });
    let head;
    try { head = await post({ kind: 'nativeFetch', id, url: req.url, method: req.method, headers, body: body ? toB64(body) : null }); }
    catch (e) { delete streams[id]; if (signal && signal.aborted) throw abortError(); throw new TypeError('Failed to fetch (' + String((e && e.message) || e) + ')'); }
    if (!head || !(head.status >= 200 && head.status <= 599)) { delete streams[id]; throw new TypeError('Failed to fetch'); }
    const empty = [204, 205, 304].includes(head.status) || req.method === 'HEAD';
    return new Response(empty ? null : stream, { status: head.status, statusText: head.statusText || '', headers: head.headers || {} });
  }

  async function appFile(path) {
    const r = await post({ kind: 'resource', path: decodeURIComponent(path.split(/[?#]/)[0]) });
    if (!r || typeof r.b64 !== 'string') return new Response('not found: ' + path, { status: 404 });
    return new Response(fromB64(r.b64), { status: 200, headers: { 'content-type': r.mime || 'application/octet-stream' } });
  }

  const pageFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = String(input instanceof Request ? input.url : input);
    const app = APP.exec(url);
    if (app) return appFile(app[1]);
    if (!API.test(url)) return pageFetch(input, init);
    let req;
    try { req = new Request(input, init); } catch (e) { return Promise.reject(e); }
    return nativeFetch(req, (init && init.signal) || (input instanceof Request ? input.signal : null));
  };

  // ---- the system voice: AVSpeechSynthesizer (better voices and steadier events than WebKit's speechSynthesis) ----
  const voices = [];
  const voicesListeners = [];
  let current = null;
  let currentId = 0;
  const queue = [];
  function SpeechSynthesisUtteranceIOS(text) {
    this.text = text == null ? '' : String(text);
    this.lang = '';
    this.voice = null;
    this.rate = 1; this.pitch = 1; this.volume = 1;
    this.onstart = this.onend = this.onerror = this.onboundary = this.onpause = this.onresume = this.onmark = null;
  }
  SpeechSynthesisUtteranceIOS.prototype.addEventListener = function (type, f) { const k = 'on' + type; const prev = this[k]; this[k] = prev ? (e) => { prev(e); f(e); } : f; };
  const call = (u, name, ev) => { try { if (u && typeof u[name] === 'function') u[name](Object.assign({ utterance: u, charIndex: 0, elapsedTime: 0, name: '' }, ev || {})); } catch (e) { console.warn(e); } };
  const synth = {
    speaking: false, pending: false, paused: false, onvoiceschanged: null,
    getVoices: () => voices.slice(),
    addEventListener: (type, f) => { if (type === 'voiceschanged') voicesListeners.push(f); },
    removeEventListener: (type, f) => { const i = voicesListeners.indexOf(f); if (i >= 0) voicesListeners.splice(i, 1); },
    speak(u) { queue.push(u); synth.pending = !!current || queue.length > 1; next(); },
    cancel() {
      const gone = (current ? [current] : []).concat(queue.splice(0));
      current = null;
      synth.speaking = synth.pending = synth.paused = false;
      post({ kind: 'speakStop' }).catch(() => {});
      gone.forEach((u, i) => setTimeout(() => call(u, 'onerror', { error: i === 0 ? 'interrupted' : 'canceled' }), 0));
    },
    pause() { if (current && !synth.paused) { synth.paused = true; post({ kind: 'speakPause' }).catch(() => {}); } },
    resume() { if (synth.paused) { synth.paused = false; post({ kind: 'speakResume' }).catch(() => {}); } }
  };
  function next() {
    if (current || !queue.length) return;
    current = queue.shift();
    const id = ++currentId;
    synth.speaking = true;
    synth.pending = queue.length > 0;
    const u = current;
    post({ kind: 'speak', id, text: u.text, voice: (u.voice && u.voice.voiceURI) || '', lang: u.lang || (u.voice && u.voice.lang) || 'en-GB', rate: u.rate, pitch: u.pitch, volume: u.volume })
      .catch((e) => { if (current === u) { current = null; synth.speaking = false; call(u, 'onerror', { error: 'synthesis-failed' }); next(); } });
  }
  // events from Swift: { id, event: 'start' | 'word' | 'end' | 'cancel', charIndex, charLength }
  window.__ytcTts = (ev) => {
    if (!ev || ev.id !== currentId || !current) return;
    const u = current;
    if (ev.event === 'start') call(u, 'onstart');
    else if (ev.event === 'word') call(u, 'onboundary', { name: 'word', charIndex: ev.charIndex || 0, charLength: ev.charLength || 0 });
    else if (ev.event === 'end' || ev.event === 'cancel') {
      current = null;
      synth.speaking = false;
      synth.paused = false;
      if (ev.event === 'end') call(u, 'onend'); else call(u, 'onerror', { error: 'interrupted' });
      next();
    }
  };
  post({ kind: 'voices' }).then((list) => {
    (list || []).forEach((v) => voices.push({ voiceURI: v.id, name: v.name, lang: v.lang, localService: true, default: !!v.default }));
    voicesListeners.slice().forEach((f) => { try { f({ type: 'voiceschanged' }); } catch (e) { console.warn(e); } });
    if (typeof synth.onvoiceschanged === 'function') synth.onvoiceschanged({ type: 'voiceschanged' });
  }).catch(() => {});
  try { Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true }); } catch (e) { /* keep WebKit's own */ }
  window.SpeechSynthesisUtterance = SpeechSynthesisUtteranceIOS;
})();
