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

  function getMedia() {
    const all = new Set(mediaEls);
    document.querySelectorAll('audio, video').forEach(e => all.add(e));
    const list = [...all].filter(e => e.currentSrc || e.src || e.srcObject);
    return list.find(e => !e.paused && !e.ended)
      || list.filter(e => e.readyState > 0).sort((a, b) => b.currentTime - a.currentTime)[0]
      || list[list.length - 1] || null;
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
    fullPlay: false // training done, now playing the whole song once at 100%
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
      time: el ? el.currentTime : 0, lineStart: ln ? ln.start : 0, lineEnd: ln ? ln.end : 0
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

  function seekViaProgressBar(t, el) {
    const input = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]');
    if (!input || !el || !el.duration) return;
    const max = Number(input.max) || el.duration;
    const v = Math.round(t * max / el.duration);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function seek(el, t) {
    S.lastSeekAt = performance.now();
    try { el.currentTime = t; } catch (e) { /* ignore */ }
    setTimeout(() => {
      if ((S.active || S.fullPlay) && Math.abs(el.currentTime - t) > 1.5) seekViaProgressBar(t, el);
    }, 400);
  }

  function beginStep(allowContinue) {
    const el = getMedia();
    const ln = S.lines[S.line];
    if (!el || !ln) return;
    S.rate = S.plan.stages[S.stage];
    applyRate(el, S.rate);
    const target = Math.max(0, ln.start - core.LEAD_IN);
    // moving on to the next line at the same speed: we're already there, don't stutter
    if (!(allowContinue && el.currentTime >= target - 0.05 && el.currentTime < ln.start + 0.25)) seek(el, target);
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
    const parsed = core.parseLyrics(json, el.duration);
    if (!parsed.synced) return stop('These lyrics are not time-synced, so lines can\'t be looped.');

    S.lines = parsed.lines;
    S.trackId = id;
    S.line = (opts.fromStart || S.settings.startFrom !== 'current') ? 0 : core.findLineAt(S.lines, el.currentTime);
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
      if (el.ended || (el.duration && el.currentTime >= el.duration - 0.25)) songDone();
      return;
    }
    if (!S.active) return;
    if (id && S.trackId && id !== S.trackId) {
      if (S.settings.autoNext) start(S.settings, { fromStart: true });
      else stop('Song changed — press Start to train this one.');
      return;
    }
    const el = getMedia();
    if (!el) return;
    applyRate(el, S.rate); // Spotify sometimes resets the speed
    if (el.paused) return;
    const t = el.currentTime;
    const ln = S.lines[S.line];
    const sinceSeek = performance.now() - S.lastSeekAt;
    if (sinceSeek < 250) return; // let our own seek settle

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
    }
  });

  // test hook (harmless in production)
  window.__SLT_DEBUG__ = { state: S, auth, lyricsCache, getMedia, currentTrackId };
})();
