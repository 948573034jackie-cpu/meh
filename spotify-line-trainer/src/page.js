// Runs in the Spotify page itself (MAIN world): finds the audio element, reads the
// synced lyrics, and drives the line-by-line looping. The panel (ui.js) talks to it
// through 'slt-cmd' / 'slt-state' DOM events carrying JSON strings.
(function () {
  'use strict';
  if (window.__SLT_PAGE__) return;
  window.__SLT_PAGE__ = true;
  const core = window.__SLT_CORE__;

  // ---------- media element discovery ----------
  const mediaEls = new Set();
  const origCreate = Document.prototype.createElement;
  Document.prototype.createElement = function (tag) {
    const el = origCreate.apply(this, arguments);
    if (typeof tag === 'string' && /^(audio|video)$/i.test(tag)) mediaEls.add(el);
    return el;
  };
  // In case we were injected after Spotify made its player: an existing element is
  // picked up the next time Spotify calls play() on it.
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    mediaEls.add(this);
    return origPlay.apply(this, arguments);
  };

  // Watch every seek anyone makes (Spotify included). When Spotify jumps to a lyric line we
  // learn exactly which element is its music player and how its clock maps to song time.
  const seekLog = [];
  let ourSeek = false;
  const ctDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  if (ctDesc && ctDesc.set && ctDesc.configurable) {
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true, enumerable: ctDesc.enumerable,
      get() { return ctDesc.get.call(this); },
      set(v) {
        mediaEls.add(this);
        if (!ourSeek) { seekLog.push({ el: this, v: Number(v), at: performance.now() }); if (seekLog.length > 50) seekLog.shift(); }
        ctDesc.set.call(this, v);
      }
    });
  }

  // Spotify's own position / duration under the progress bar, in whole seconds.
  function parseClock(s) {
    const m = /(-?)(?:(\d+):)?(\d+):(\d{2})/.exec(String(s || ''));
    if (!m) return null;
    const v = (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]);
    return m[1] ? -v : v;
  }
  function spotifyClock() {
    const pe = document.querySelector('[data-testid="playback-position"]');
    const de = document.querySelector('[data-testid="playback-duration"]');
    const p = pe ? parseClock(pe.textContent) : null;
    let d = de ? parseClock(de.textContent) : null;
    if (d != null && d < 0 && p != null) d = p - d; // "remaining time" display
    return p == null && d == null ? null : { p, d };
  }

  // Pick Spotify's real music player, not the looping Canvas video or a muted preview.
  function scoreMedia(e, clock) {
    let s = 0;
    if (e === S.el) s += 60;
    if (!e.paused && !e.ended) s += 30;
    if (e.loop) s -= 100;
    if (e.muted) s -= 40;
    if (e.videoWidth > 0) s -= 50;
    if (e.isConnected) s -= 10;
    if (e.readyState > 0) s += 5;
    const dur = e.duration;
    if (Number.isFinite(dur)) {
      if (dur < 30) s -= 30;
      if (clock && clock.d > 0 && dur >= clock.d - 3) s += Math.abs(dur - clock.d) < 3 ? 40 : 20;
    }
    return s;
  }
  function getMedia() {
    const all = new Set(mediaEls);
    document.querySelectorAll('audio, video').forEach(e => all.add(e));
    const list = [...all].filter(e => e.currentSrc || e.src || e.srcObject);
    if (!list.length) return null;
    const clock = spotifyClock();
    let best = null, bestScore = -Infinity;
    for (const e of list) { const sc = scoreMedia(e, clock); if (sc > bestScore) { best = e; bestScore = sc; } }
    return bestScore > -60 ? best : null; // a looping muted clip is never the music
  }

  // ---------- auth + lyrics capture ----------
  const auth = { authorization: null, clientToken: null, host: 'https://spclient.wg.spotify.com' };
  const lyricsCache = new Map(); // trackId -> json | null (null = no lyrics)
  let lastLyricsTrack = null;
  const LYRICS_RE = /\/color-lyrics\/v2\/track\/([A-Za-z0-9]{22})/;

  function headerFrom(h, name) {
    if (!h) return null;
    try {
      if (typeof h.get === 'function') return h.get(name);
      if (Array.isArray(h)) { const p = h.find(x => String(x[0]).toLowerCase() === name); return p ? p[1] : null; }
      for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k];
    } catch (e) { /* ignore */ }
    return null;
  }
  function noteRequest(url, headers) {
    try {
      if (!/spotify\.com/.test(url)) return;
      const a = headerFrom(headers, 'authorization');
      if (a && /^Bearer\s+\S+/i.test(a)) auth.authorization = a;
      const c = headerFrom(headers, 'client-token');
      if (c) auth.clientToken = c;
      const u = new URL(url, location.href);
      if (/spclient/.test(u.hostname)) auth.host = u.origin;
    } catch (e) { /* ignore */ }
  }
  function storeLyrics(id, json) {
    if (!id) return;
    lyricsCache.set(id, json);
    lastLyricsTrack = id;
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || String(input);
      noteRequest(url, (init && init.headers) || (input && input.headers));
    } catch (e) { /* ignore */ }
    const p = origFetch.apply(this, arguments);
    const m = url.match(LYRICS_RE);
    if (m) {
      p.then(r => {
        if (r.ok) r.clone().json().then(j => storeLyrics(m[1], j)).catch(() => {});
        else if (r.status === 404) storeLyrics(m[1], null);
      }).catch(() => {});
    }
    return p;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__sltUrl = String(url);
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { noteRequest(this.__sltUrl || '', { [String(name).toLowerCase()]: value }); } catch (e) { /* ignore */ }
    return xhrSetHeader.apply(this, arguments);
  };

  function currentTrackId() {
    const sel = [
      '[data-testid="now-playing-widget"] a[href]',
      '[data-testid="context-item-link"]',
      '[data-testid="context-item-info-title"] a[href]',
      'footer a[href*="track"]'
    ].join(',');
    for (const a of document.querySelectorAll(sel)) {
      const href = decodeURIComponent(a.getAttribute('href') || '');
      const m = href.match(/track[:/]([A-Za-z0-9]{22})/);
      if (m) return m[1];
    }
    return null;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchLyrics(id) {
    if (lyricsCache.has(id)) return lyricsCache.get(id);
    if (auth.authorization) {
      try {
        const headers = { authorization: auth.authorization, accept: 'application/json', 'app-platform': 'WebPlayer' };
        if (auth.clientToken) headers['client-token'] = auth.clientToken;
        const r = await origFetch.call(window,
          `${auth.host}/color-lyrics/v2/track/${id}?format=json&vocalRemoval=false&market=from_token`,
          { headers, credentials: 'omit' });
        if (r.ok) { const j = await r.json(); storeLyrics(id, j); return j; }
        if (r.status === 404) { storeLyrics(id, null); return null; }
      } catch (e) { /* fall through to the lyrics-button fallback */ }
    }
    // Fallback: open Spotify's own lyrics view so the player fetches them for us.
    const btn = document.querySelector('[data-testid="lyrics-button"]');
    if (btn) {
      if (btn.getAttribute('data-active') !== 'true' && btn.getAttribute('aria-pressed') !== 'true') btn.click();
      for (let i = 0; i < 40 && !lyricsCache.has(id); i++) await sleep(150);
    }
    return lyricsCache.has(id) ? lyricsCache.get(id) : undefined; // undefined = couldn't reach
  }

  // ---------- engine ----------
  const S = {
    active: false, waitingNext: false, loading: false,
    settings: core.normalizeSettings({}), plan: core.plan({}),
    lines: [], trackId: null, line: 0, stage: 0, rep: 0,
    rate: 1, lastSeekAt: 0, timer: null, message: '', finished: false,
    fullPlay: false, // training done, now playing the whole song once at 100%
    baseLines: [], adj: {}, // lyrics as Spotify gave them + the user's timing fixes for this song
    el: null, offset: 0, sync: 'none', syncing: false, mismatch: 0, lastD: 0, lastCheck: 0, lastResync: 0 // song time = el.currentTime - offset
  };

  function emit() {
    const ln = S.lines[S.line];
    const el = getMedia();
    const state = {
      active: S.active, loading: S.loading, waitingNext: S.waitingNext, finished: S.finished, fullPlay: S.fullPlay,
      mode: S.settings.mode, message: S.message,
      line: S.line, lineCount: S.lines.length,
      stage: S.stage, stageCount: S.plan.stages.length,
      rep: S.rep, reps: S.plan.reps, rate: S.rate,
      text: ln ? ln.text : '', nextText: S.lines[S.line + 1] ? S.lines[S.line + 1].text : '',
      time: el ? trackTime(el) : 0, lineStart: ln ? ln.start : 0, lineEnd: ln ? ln.end : 0,
      joined: ln ? ln.joined : 0, offset: Number(S.adj.offset) || 0,
      sync: S.sync, syncing: S.syncing, clockOffset: S.offset,
      adjusted: !!(S.adj.offset || (S.adj.joins && S.adj.joins.length) || Object.keys(S.adj.lines || {}).length)
    };
    document.dispatchEvent(new CustomEvent('slt-state', { detail: JSON.stringify(state) }));
  }

  function applyRate(el, rate) {
    if (!el) return;
    try {
      if ('preservesPitch' in el) el.preservesPitch = true;
      if (Math.abs(el.playbackRate - rate) > 0.001) el.playbackRate = rate;
    } catch (e) { /* ignore */ }
  }

  const trackTime = el => el.currentTime - S.offset;
  function trackDuration(el) {
    const c = spotifyClock();
    if (c && c.d > 0) return c.d;
    return el && Number.isFinite(el.duration) ? el.duration - S.offset : NaN;
  }

  function seekViaProgressBar(t, el) {
    const input = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]');
    const dur = trackDuration(el);
    if (!input || !el || !dur) return;
    const max = Number(input.max) || dur;
    const v = Math.round(t * max / dur);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function seek(el, t) { // t = song time
    S.lastSeekAt = performance.now();
    ourSeek = true;
    try { el.currentTime = Math.max(0, t + S.offset); } catch (e) { /* ignore */ } finally { ourSeek = false; }
    setTimeout(() => {
      if ((S.active || S.fullPlay) && !S.syncing && Math.abs(trackTime(el) - t) > 1.5) seekViaProgressBar(t, el);
    }, 400);
  }

  function beginStep(allowContinue) {
    const el = getMedia();
    const ln = S.lines[S.line];
    if (!el || !ln) return;
    S.rate = S.plan.stages[S.stage];
    applyRate(el, S.rate);
    const target = Math.max(0, ln.start - core.LEAD_IN);
    // moving on to the next line at the same speed and we haven't passed its start yet: just keep playing
    const now = trackTime(el);
    if (!(allowContinue && now >= target - 0.05 && now <= ln.start)) seek(el, target);
    emit();
  }

  function ensurePlaying() {
    const el = getMedia();
    if (!el || !el.paused) return;
    const btn = document.querySelector('[data-testid="control-button-playpause"]');
    if (btn) btn.click(); else el.play().catch(() => {});
  }

  function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }

  function stop(message) {
    stopTimer();
    S.active = false; S.waitingNext = false; S.loading = false; S.fullPlay = false;
    S.rate = 1;
    applyRate(getMedia(), 1);
    S.message = message || '';
    emit();
  }

  function finish() {
    S.rate = 1;
    const el = getMedia();
    applyRate(el, 1);
    if (S.settings.mode === 'training' && S.settings.playFullAfter && el) {
      // Training finished: listen to the whole song once, start to end, at normal speed.
      S.active = false; S.fullPlay = true;
      S.message = 'Training done! Now playing the whole song at 100% 🎶';
      seek(el, 0);
      ensurePlaying();
      emit();
      return;
    }
    songDone();
  }

  function songDone() {
    S.fullPlay = false;
    S.finished = true;
    if (S.settings.autoNext) {
      S.active = false; S.waitingNext = true;
      S.message = 'Song finished! Waiting for the next song…';
      emit();
    } else {
      stop('Song finished! 🎉');
      S.finished = true;
      emit();
    }
  }

  let startToken = 0;
  async function start(settings, opts) {
    opts = opts || {};
    const token = ++startToken;
    stopTimer();
    S.settings = core.normalizeSettings(settings || S.settings);
    S.plan = core.plan(S.settings);
    S.active = false; S.waitingNext = false; S.finished = false; S.fullPlay = false;
    S.loading = true; S.message = 'Loading lyrics…';
    emit();

    let el = getMedia();
    for (let i = 0; i < 20 && !el; i++) { await sleep(150); el = getMedia(); }
    if (!el) {
      // Injected late (e.g. Safari userscript): toggle Spotify's play/pause so it calls play() and we catch its player.
      const btn = document.querySelector('[data-testid="control-button-playpause"]');
      for (let i = 0; i < 2 && !el && btn; i++) {
        btn.click();
        for (let j = 0; j < 10 && !el; j++) { await sleep(100); el = getMedia(); }
      }
      if (el && el.paused) ensurePlaying();
    }
    if (token !== startToken) return;
    if (!el) return stop('Start playing a song in Spotify first.');
    const id = currentTrackId() || lastLyricsTrack;
    if (!id) return stop('Could not find the current song. Start playing a song first.');
    const json = await fetchLyrics(id);
    if (token !== startToken) return;
    if (json === undefined) return stop('Could not load lyrics. Click the 🎤 lyrics button in Spotify once, then press Start again.');
    if (json === null) return stop('This song has no lyrics on Spotify.');
    if (S.trackId !== id) { S.el = null; S.offset = 0; S.sync = 'none'; }
    const parsed = core.parseLyrics(json, trackDuration(el));
    if (!parsed.synced) return stop('These lyrics are not time-synced, so lines can\'t be looped.');

    S.baseLines = parsed.lines;
    S.trackId = id;
    S.adj = loadAdj(id);
    S.lines = core.applyAdjustments(S.baseLines, S.adj);
    const fromCurrent = !opts.fromStart && S.settings.startFrom === 'current';
    const clk = spotifyClock();
    const posBefore = clk && clk.p != null ? clk.p : trackTime(el);
    const elTimeBefore = el.currentTime;

    // Line up with Spotify's own clock (the same one its lyric view uses).
    S.message = 'Syncing with Spotify…'; emit();
    await syncWithSpotify(fromCurrent ? core.findLineAt(S.baseLines, posBefore) : 0, el);
    if (token !== startToken) return;
    el = getMedia() || el;
    S.line = fromCurrent ? core.findLineAt(S.lines, (S.el === el ? elTimeBefore : el.currentTime) - S.offset) : 0;
    S.stage = 0; S.rep = 0;
    S.loading = false; S.active = true; S.message = '';
    beginStep(false);
    ensurePlaying();
    S.timer = setInterval(tick, 20);
  }

  function tick() {
    const id = currentTrackId();
    if (S.waitingNext) {
      if (id && id !== S.trackId) start(S.settings, { fromStart: true });
      return;
    }
    if (S.fullPlay) {
      const el = getMedia();
      if (id && S.trackId && id !== S.trackId) {
        // Spotify moved on to the next song when this one ended
        if (S.settings.autoNext) start(S.settings, { fromStart: true });
        else { stop('Training complete! 🎉'); S.finished = true; emit(); }
        return;
      }
      if (!el) return;
      applyRate(el, 1);
      const dur = trackDuration(el);
      if (el.ended || (dur && trackTime(el) >= dur - 0.25)) songDone();
      return;
    }
    if (!S.active || S.syncing) return;
    if (id && S.trackId && id !== S.trackId) {
      if (S.settings.autoNext) start(S.settings, { fromStart: true });
      else stop('Song changed — press Start to train this one.');
      return;
    }
    const el = getMedia();
    if (!el) return;
    applyRate(el, S.rate); // Spotify sometimes resets the speed
    if (el.paused) return;
    const t = trackTime(el);
    const ln = S.lines[S.line];
    const sinceSeek = performance.now() - S.lastSeekAt;
    if (sinceSeek < 250) return; // let our own seek settle
    if (driftCheck(el, t, sinceSeek)) return;

    // user dragged the progress bar somewhere else -> follow them
    if (sinceSeek > 800 && (t < ln.start - core.LEAD_IN - 1.0 || t > ln.end + 1.5)) {
      S.line = core.findLineAt(S.lines, t); S.stage = 0; S.rep = 0;
      beginStep(false);
      return;
    }
    if (t >= ln.end - core.TAIL || el.ended) {
      const next = core.advance({ line: S.line, stage: S.stage, rep: S.rep }, S.lines.length, S.plan);
      if (next.done) return finish();
      const sameLine = next.line === S.line;
      S.line = next.line; S.stage = next.stage; S.rep = next.rep;
      beginStep(!sameLine && S.plan.stages[S.stage] === S.rate);
      return;
    }
    if (Math.random() < 0.1) emit(); // keep the panel's progress bar moving
  }

  // ---------- sync with Spotify's clock ----------
  const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  function lyricsButtonActive(btn) {
    return btn && (btn.getAttribute('data-active') === 'true' || btn.getAttribute('aria-pressed') === 'true');
  }
  // Spotify's lyric line element for baseLines[idx] (handles repeated lines like a chorus).
  function findLyricNode(idx) {
    const line = S.baseLines[idx];
    const target = norm(line && line.text);
    if (!target || line.text.includes(' / ')) return null;
    const occurrence = S.baseLines.slice(0, idx).filter(l => norm(l.text) === target).length;
    const bad = n => n.closest('a, button, input, footer, nav, [data-testid="now-playing-widget"], #slt-root');
    let nodes = [...document.querySelectorAll('[data-testid="fullscreen-lyric"], [data-testid="lyrics-line"]')]
      .filter(n => norm(n.textContent) === target && !bad(n));
    if (!nodes.length) {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode());) {
        if (norm(n.data) === target && n.parentElement && !bad(n.parentElement)) nodes.push(n.parentElement);
      }
    }
    return nodes[Math.min(occurrence, nodes.length - 1)] || null;
  }

  // Tap a lyric line the way you would, and see exactly where Spotify jumps.
  async function syncViaLyricTap(preferIdx) {
    let attempts = 0;
    for (let pass = 0; pass < 2; pass++) {
      const order = [...S.baseLines.keys()].sort((a, b) => Math.abs(a - preferIdx) - Math.abs(b - preferIdx) || a - b);
      for (const i of order) {
        const node = findLyricNode(i);
        if (!node) continue;
        const t0 = performance.now();
        node.click();
        for (let k = 0; k < 30; k++) {
          await sleep(50);
          const hit = seekLog.find(x => x.at >= t0);
          if (hit) return { el: hit.el, offset: Math.round((hit.v - S.baseLines[i].start) * 1000) / 1000 };
        }
        if (++attempts >= 3) return null; // tapping lyrics doesn't seek here
      }
      if (pass === 0) { // open Spotify's lyrics view and try again
        const btn = document.querySelector('[data-testid="lyrics-button"]');
        if (!btn || lyricsButtonActive(btn)) return null;
        btn.click();
        for (let k = 0; k < 30 && !findLyricNode(preferIdx) && !findLyricNode(0); k++) await sleep(100);
      }
    }
    return null;
  }

  // Fallback: compare with the m:ss clock under Spotify's progress bar.
  async function syncViaClock(el) {
    if (!el || el.paused) return null;
    let c = spotifyClock();
    if (!c || c.p == null) return null;
    let last = c.p;
    const diffs = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 3300 && diffs.length < 3) {
      await sleep(15);
      c = spotifyClock();
      if (!c || c.p == null) return null;
      if (c.p !== last) { diffs.push(el.currentTime - c.p); last = c.p; }
    }
    if (!diffs.length) return null;
    const off = Math.min(...diffs); // the clock ticks over just after a whole second passes
    return Math.abs(off) < 0.75 ? 0 : Math.round(off * 1000) / 1000;
  }

  async function syncWithSpotify(preferIdx, el) {
    S.syncing = true; emit();
    try {
      const tap = await syncViaLyricTap(preferIdx);
      if (tap) { S.el = tap.el; S.offset = tap.offset; S.sync = 'spotify'; return; }
      const off = await syncViaClock(getMedia() || el);
      if (off != null) { S.el = getMedia(); S.offset = off; S.sync = 'clock'; return; }
      S.sync = 'none';
    } finally {
      S.syncing = false; S.mismatch = 0;
    }
  }

  async function resync() {
    if (!S.active || S.syncing) return;
    const ln = S.lines[S.line];
    await syncWithSpotify(ln ? ln.id : 0, getMedia());
    if (S.active) beginStep(false);
  }

  // While playing at 100%, keep checking against Spotify's clock; if they disagree, sync again.
  function driftCheck(el, t, sinceSeek) {
    const now = performance.now();
    if (now - S.lastCheck < 1000) return false;
    S.lastCheck = now;
    if (S.rate !== 1 || sinceSeek < 1500) return false;
    const c = spotifyClock();
    if (!c || c.p == null) return false;
    const d = t - c.p; // should be within [0, 1) plus a little UI lag
    if (d < -1.5 || d > 2.5) {
      // only a steady disagreement counts (a jumpy one is just the clock display lagging)
      S.mismatch = S.mismatch && Math.abs(d - S.lastD) < 1.2 ? S.mismatch + 1 : 1; // the m:ss clock only has whole seconds
      S.lastD = d;
    } else S.mismatch = 0;
    if (S.mismatch >= 3 && now - S.lastResync > 20000) {
      S.mismatch = 0; S.lastResync = now;
      resync();
      return true;
    }
    return false;
  }

  function diagnostics() {
    const clock = spotifyClock();
    const all = new Set(mediaEls);
    document.querySelectorAll('audio, video').forEach(e => all.add(e));
    const chosen = getMedia();
    return {
      version: '1.3.0', ua: navigator.userAgent, url: location.href, trackId: S.trackId, currentTrack: currentTrackId(),
      sync: S.sync, offset: S.offset, active: S.active, line: S.line, lines: S.lines.length,
      spotifyClock: clock, songTime: chosen ? +trackTime(chosen).toFixed(3) : null,
      media: [...all].map(e => ({
        chosen: e === chosen, locked: e === S.el, tag: e.tagName, inDom: e.isConnected, muted: e.muted, loop: e.loop,
        paused: e.paused, t: +e.currentTime.toFixed(3), dur: e.duration, rate: e.playbackRate, vw: e.videoWidth,
        src: String(e.currentSrc || e.src || (e.srcObject ? 'srcObject' : '')).slice(0, 40), score: scoreMedia(e, clock)
      })),
      seeks: seekLog.slice(-6).map(x => ({ v: +x.v.toFixed(3), ago: Math.round(performance.now() - x.at), chosen: x.el === chosen })),
      lyricNodes: document.querySelectorAll('[data-testid="fullscreen-lyric"], [data-testid="lyrics-line"]').length,
      firstLines: S.baseLines.slice(0, 3).map(l => [l.start, l.text]),
      lyricsButton: (b => b ? { active: lyricsButtonActive(b) } : null)(document.querySelector('[data-testid="lyrics-button"]'))
    };
  }

  // ---------- timing fixes ----------
  const adjKey = id => 'slt-adj:' + id;
  function loadAdj(id) {
    try { return JSON.parse(localStorage.getItem(adjKey(id)) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveAdj() {
    try {
      if (!S.trackId) return;
      const a = S.adj;
      const empty = !a.offset && !(a.joins && a.joins.length) && !Object.keys(a.lines || {}).length;
      if (empty) localStorage.removeItem(adjKey(S.trackId));
      else localStorage.setItem(adjKey(S.trackId), JSON.stringify(a));
    } catch (e) { /* ignore */ }
  }
  const round = v => Math.round(v * 100) / 100;

  // Rebuild the line list after a fix, stay on the same line, and replay it so the change is heard right away.
  function rebuild(keepId) {
    S.lines = core.applyAdjustments(S.baseLines, S.adj);
    let idx = S.lines.findIndex(l => l.id <= keepId && keepId <= l.id + l.joined);
    S.line = idx < 0 ? Math.min(S.line, S.lines.length - 1) : idx;
    saveAdj();
    beginStep(false);
  }

  function fixTiming(cmd) {
    if (!S.active || !S.lines.length) return;
    const ln = S.lines[S.line];
    const el = getMedia();
    S.adj.lines = S.adj.lines || {};
    const a = S.adj.lines[ln.id] = S.adj.lines[ln.id] || {};
    switch (cmd.type) {
      case 'nudge': { // move start or end by delta seconds
        const k = cmd.field === 'start' ? 'ds' : 'de';
        a[k] = round((a[k] || 0) + Number(cmd.delta || 0));
        break;
      }
      case 'setNow': { // set start or end to "right now" in the song
        if (!el) return;
        const now = trackTime(el);
        if (cmd.field === 'start') {
          if (now >= ln.end - 0.3) return;
          a.ds = round((a.ds || 0) + now - ln.start);
        } else {
          if (now <= ln.start + 0.3) return;
          a.de = round((a.de || 0) + now - ln.end);
        }
        break;
      }
      case 'offset':
        S.adj.offset = round((Number(S.adj.offset) || 0) + Number(cmd.delta || 0));
        break;
      case 'join': {
        if (S.line >= S.lines.length - 1) return;
        const last = ln.id + ln.joined; // last original line inside this one
        S.adj.joins = [...new Set([...(S.adj.joins || []), last])];
        delete a.de; // the end now comes from the joined line
        break;
      }
      case 'split':
        if (!ln.joined) return;
        S.adj.joins = (S.adj.joins || []).filter(j => j < ln.id || j >= ln.id + ln.joined);
        break;
      case 'resetSong':
        S.adj = {};
        break;
    }
    if (S.adj.lines && S.adj.lines[ln.id] && !S.adj.lines[ln.id].ds && !S.adj.lines[ln.id].de) delete S.adj.lines[ln.id];
    rebuild(ln.id);
  }

  function jumpLine(delta) {
    if (!S.active || !S.lines.length) return;
    S.line = Math.max(0, Math.min(S.lines.length - 1, S.line + delta));
    S.stage = 0; S.rep = 0;
    beginStep(false);
  }

  function updateSettings(settings) {
    S.settings = core.normalizeSettings(settings);
    if (!S.active) { S.plan = core.plan(S.settings); emit(); return; }
    const oldRate = S.rate;
    S.plan = core.plan(S.settings);
    if (S.stage >= S.plan.stages.length) S.stage = 0;
    if (S.rep >= S.plan.reps) S.rep = S.plan.reps - 1;
    S.rate = S.plan.stages[S.stage];
    if (S.rate !== oldRate) applyRate(getMedia(), S.rate);
    emit();
  }

  document.addEventListener('slt-cmd', ev => {
    let cmd;
    try { cmd = JSON.parse(ev.detail); } catch (e) { return; }
    switch (cmd.type) {
      case 'start': start(cmd.settings); break;
      case 'stop': startToken++; stop('Stopped.'); break;
      case 'prev': jumpLine(-1); break;
      case 'next': jumpLine(1); break;
      case 'restart': jumpLine(0); break;
      case 'settings': updateSettings(cmd.settings); break;
      case 'ping': emit(); break;
      case 'resync': resync(); break;
      case 'diag': document.dispatchEvent(new CustomEvent('slt-diag', { detail: JSON.stringify(diagnostics(), null, 1) })); break;
      case 'nudge': case 'setNow': case 'offset': case 'join': case 'split': case 'resetSong': fixTiming(cmd); break;
    }
  });

  // test hook (harmless in production)
  window.__SLT_DEBUG__ = { state: S, auth, lyricsCache, getMedia, currentTrackId, trackTime: () => { const e = getMedia(); return e ? trackTime(e) : NaN; }, diagnostics };
})();
