// Line Trainer: a standalone web app (iPad / iPhone / desktop).
// Songs come from a Spotify link (played through YouTube's official player) or a song file.
// Synced lyrics come from LRCLIB. Lines loop N times / run the training ladder / practice ramp.
(function () {
  'use strict';
  const core = window.__SLT_CORE__;
  const $ = s => document.querySelector(s);
  const SPEEDS = core.SPEEDS, REPS = core.REPS;
  const LRCLIB = 'https://lrclib.net';
  const PIPED = ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de', 'https://api.piped.private.coffee', 'https://pipedapi.r4fo.com'];

  // ---------- storage ----------
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or blocked */ } };
  const DEFAULTS = {
    mode: 'repeat', reps: 5, speed: 1, trainingReps: 5, trainingSpeeds: [0.3, 0.5, 0.75, 1], startFrom: 'first', playFullAfter: true,
    practiceRamp: 10, practiceNormal: 10, practiceRest: 30, autoNextSong: false, fixOpen: false
  };
  const settings = Object.assign({}, DEFAULTS, load('lt-settings', {}));

  const db = (() => {
    let p = null;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('line-trainer', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'key' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction('songs', mode);
        const out = fn(t.objectStore('songs'));
        t.oncomplete = () => res(out && out.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      put: rec => tx('readwrite', s => s.put(rec)),
      get: key => tx('readonly', s => s.get(key)),
      all: () => tx('readonly', s => s.getAll()),
      del: key => tx('readwrite', s => s.delete(key))
    };
  })();
  async function library() {
    let list = [];
    try { list = (await db.all()) || []; } catch (e) { /* storage blocked */ }
    return list.sort((a, b) => a.added - b.added);
  }

  // ---------- players: one interface for a song file and for YouTube ----------
  const audio = $('#audio');
  const filePlayer = {
    kind: 'file',
    get t() { return audio.currentTime; },
    seek(t) { audio.currentTime = Math.max(0, t); },
    setRate(r) {
      audio.preservesPitch = true; audio.webkitPreservesPitch = true; audio.mozPreservesPitch = true;
      if (Math.abs(audio.playbackRate - r) > 0.001) audio.playbackRate = r;
      audio.defaultPlaybackRate = r;
    },
    get rate() { return audio.playbackRate; },
    play() { const p = audio.play(); if (p && p.catch) p.catch(() => {}); },
    pause() { audio.pause(); },
    get paused() { return audio.paused; },
    get ended() { return audio.ended; },
    get duration() { return audio.duration; },
    stop() { audio.pause(); }
  };

  let ytApi = null;
  function loadYouTubeApi() {
    if (ytApi) return ytApi;
    ytApi = new Promise((res, rej) => {
      if (window.YT && window.YT.Player) return res(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { ytApi = null; rej(new Error('YouTube could not be loaded')); };
      document.head.append(s);
    });
    return ytApi;
  }

  // YouTube's getCurrentTime only updates every so often; smooth it with the clock so loops end on time.
  const ytPlayer = {
    kind: 'yt', p: null, state: -1, base: 0, baseAt: 0, wantRate: 1, videoId: null,
    _raw() { try { return this.p.getCurrentTime() || 0; } catch (e) { return 0; } },
    get t() {
      const raw = this._raw();
      const now = performance.now();
      if (raw !== this.base) { this.base = raw; this.baseAt = now; }
      if (this.state !== 1) return raw;
      return Math.max(raw, this.base + (now - this.baseAt) / 1000 * this.rate);
    },
    seek(t) { t = Math.max(0, t); try { this.p.seekTo(t, true); } catch (e) { /* ignore */ } this.base = t; this.baseAt = performance.now(); },
    setRate(r) { this.wantRate = r; try { if (Math.abs(this.p.getPlaybackRate() - r) > 0.001) this.p.setPlaybackRate(r); } catch (e) { /* ignore */ } },
    get rate() { try { return this.p.getPlaybackRate() || 1; } catch (e) { return 1; } },
    play() { try { this.p.playVideo(); } catch (e) { /* ignore */ } },
    pause() { try { this.p.pauseVideo(); } catch (e) { /* ignore */ } },
    get paused() { return this.state !== 1 && this.state !== 3; },
    get ended() { return this.state === 0; },
    get duration() { try { return this.p.getDuration() || NaN; } catch (e) { return NaN; } },
    stop() { this.pause(); },
    async load(videoId) {
      const YT = await loadYouTubeApi();
      $('#ytwrap').hidden = false;
      this.videoId = videoId;
      if (this.p) {
        await new Promise(res => { this._onCue = res; this.p.cueVideoById(videoId); setTimeout(res, 4000); });
      } else {
        await new Promise((res, rej) => {
          this.p = new YT.Player('yt', {
            videoId, width: '100%', height: '100%',
            playerVars: { playsinline: 1, rel: 0, modestbranding: 1, controls: 1, disablekb: 1 },
            events: {
              onReady: () => res(),
              onStateChange: e => { this.state = e.data; this.base = this._raw(); this.baseAt = performance.now(); if (e.data === 5 && this._onCue) { this._onCue(); this._onCue = null; } },
              onError: e => rej(new Error('YouTube error ' + e.data))
            }
          });
          setTimeout(() => rej(new Error('YouTube player did not start')), 15000);
        });
      }
      for (let i = 0; i < 50 && !(this.duration > 0); i++) await sleep(100);
    }
  };

  let P = filePlayer;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- song + lyrics state ----------
  let song = null;       // { key, type, name, title, artist, duration, videoId? }
  let songBlob = null;
  let objectUrl = null;
  let baseLines = [];
  let adj = {};
  let lines = [];
  let lyrSource = '';
  let envelope = null;

  const E = { active: false, fullPlay: false, line: 0, stage: 0, rep: 0, rate: 1, plan: core.plan(settings), lastSeekAt: 0, message: '', restUntil: 0 };

  const fmt = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const fmtT = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(2).padStart(5, '0'); };
  const pct = v => Math.round(v * 100) + '%';
  const sgn = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(2).replace(/0$/, '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const round = v => Math.round(v * 100) / 100;

  // ---------- song metadata ----------
  function guessMeta(name) {
    let base = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ');
    base = base.replace(/\s*[([](official|lyrics?|audio|video|hd|hq|mv|visualizer|explicit)[^)\]]*[)\]]/gi, '').trim();
    base = base.replace(/^\d{1,3}\s*[-.)]\s*/, '').trim();
    const parts = base.split(/\s+[-–—]\s+/);
    return parts.length >= 2 ? { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() } : { artist: '', title: base };
  }

  async function readId3(blob) {
    const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
    if (String.fromCharCode(head[0], head[1], head[2]) !== 'ID3') return {};
    const ver = head[3];
    const size = ((head[6] & 127) << 21) | ((head[7] & 127) << 14) | ((head[8] & 127) << 7) | (head[9] & 127);
    const b = new Uint8Array(await blob.slice(10, 10 + Math.min(size, 2e6)).arrayBuffer());
    const out = {};
    let p = 0;
    while (p + 10 <= b.length) {
      const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const sz = ver === 4
        ? ((b[p + 4] & 127) << 21) | ((b[p + 5] & 127) << 14) | ((b[p + 6] & 127) << 7) | (b[p + 7] & 127)
        : (b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7];
      if (id === 'TIT2' || id === 'TPE1') {
        const d = b.slice(p + 11, p + 10 + sz), enc = b[p + 10];
        const label = enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : enc === 3 ? 'utf-8' : 'latin1';
        out[id === 'TIT2' ? 'title' : 'artist'] = new TextDecoder(label).decode(d).replace(/\u0000/g, '').trim();
      }
      if (sz <= 0) break;
      p += 10 + sz;
    }
    return out;
  }

  // ---------- LRC ----------
  function parseLrc(text) {
    const out = [];
    let offsetMs = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
      if (off) { offsetMs = Number(off[1]); continue; }
      const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
      if (!tags.length) continue;
      const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
      for (const t of tags) {
        const sec = Number(t[1]) * 60 + parseFloat(t[2].replace(':', '.'));
        out.push({ startTimeMs: String(Math.max(0, Math.round(sec * 1000 - offsetMs))), words });
      }
    }
    return { lyrics: { syncType: out.length ? 'LINE_SYNCED' : 'UNSYNCED', lines: out } };
  }

  // ---------- opening songs ----------
  // rec: { key, type: 'file' | 'yt', name, title?, artist?, blob?, videoId?, lrc?, lrcSource? }
  async function openSong(rec) {
    stopTraining();
    try { P.stop(); } catch (e) { /* ignore */ }
    envelope = null;
    baseLines = []; lines = []; lyrSource = '';
    song = { key: rec.key, type: rec.type, name: rec.name, title: rec.title, artist: rec.artist, videoId: rec.videoId };
    E.message = rec.type === 'yt' ? 'Loading the song from YouTube…' : '';
    renderAll();
    if (rec.type === 'yt') {
      P = ytPlayer;
      songBlob = null;
      audio.removeAttribute('src');
      try { await ytPlayer.load(rec.videoId); }
      catch (e) { E.message = 'Couldn\'t load the YouTube video (' + e.message + '). Try another result.'; renderAll(); return false; }
    } else {
      P = filePlayer;
      $('#ytwrap').hidden = true;
      try { if (ytPlayer.p) ytPlayer.pause(); } catch (e) { /* ignore */ }
      songBlob = rec.blob;
      if (!song.title) Object.assign(song, guessMeta(rec.name));
      try { const t = await readId3(rec.blob); if (t.title) song.title = t.title; if (t.artist) song.artist = t.artist; } catch (e) { /* not an mp3 with tags */ }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(rec.blob);
      audio.src = objectUrl;
      audio.load();
      await new Promise(res => {
        if (audio.readyState >= 1) return res();
        audio.addEventListener('loadedmetadata', res, { once: true });
        audio.addEventListener('error', res, { once: true });
      });
    }
    song.duration = P.duration;
    E.message = '';
    let old = null;
    try { old = await db.get(rec.key); } catch (e) { /* ignore */ }
    const stored = Object.assign({}, rec, { title: song.title, artist: song.artist, added: (old && old.added) || Date.now() });
    delete stored.lrc; delete stored.lrcSource;
    db.put(stored).catch(() => {});
    adj = load('lt-adj:' + rec.key, {});
    const saved = load('lt-lrc:' + rec.key, null);
    if (saved) setLyrics(saved.lrc, saved.source, false);
    else if (rec.lrc) await setLyrics(rec.lrc, rec.lrcSource, true);
    else await autoFindLyrics();
    renderAll();
    return true;
  }

  // returns true when lyrics were taken
  async function setLyrics(lrc, source, isNew) {
    const parsed = core.parseLyrics(parseLrc(lrc), song.duration);
    if (!parsed.synced) { E.message = 'Those lyrics have no timestamps, so lines can\'t be looped. Try another result.'; renderAll(); return false; }
    stopTraining();
    baseLines = parsed.lines;
    lyrSource = source || 'pasted';
    save('lt-lrc:' + song.key, { lrc, source: lyrSource });
    if (isNew) { adj = {}; save('lt-adj:' + song.key, adj); }
    rebuild();
    E.message = '';
    renderAll();
    if (isNew) await autoSync(true);
    return true;
  }

  function rebuild() {
    lines = core.applyAdjustments(baseLines, adj);
    if (E.line >= lines.length) E.line = Math.max(0, lines.length - 1);
  }

  // ---------- LRCLIB ----------
  async function lrclibSearch(q) {
    const r = await fetch(LRCLIB + '/api/search?q=' + encodeURIComponent(q));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = await r.json();
    return Array.isArray(list) ? list : [];
  }
  const simplify = s => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  function rank(results, want, dur) {
    want = simplify(want);
    return results.filter(r => r.syncedLyrics).map(r => {
      let score = 0;
      if (Number.isFinite(dur) && r.duration) score -= Math.min(30, Math.abs(r.duration - dur)) * 2;
      const t = simplify(r.trackName);
      if (want && t === want) score += 10; else if (want && (t.includes(want) || want.includes(t))) score += 5;
      return { r, score, dd: Number.isFinite(dur) && r.duration ? Math.abs(r.duration - dur) : null };
    }).sort((a, b) => b.score - a.score);
  }

  async function autoFindLyrics() {
    if (!song) return;
    $('#lyrStatus').textContent = '🔎 Finding lyrics…';
    const queries = [[song.title, song.artist].filter(Boolean).join(' '), song.title].filter((q, i, a) => q && a.indexOf(q) === i);
    let found = [];
    try {
      for (const q of queries) {
        found = rank(await lrclibSearch(q), song.title, song.duration);
        if (found.length) break;
      }
    } catch (e) {
      E.message = 'Couldn\'t reach the lyrics service. Check your internet, then tap 🔎 Lyrics.';
      renderAll();
      return;
    }
    const best = found[0];
    if (best && (best.dd == null || best.dd < 4)) {
      await setLyrics(best.r.syncedLyrics, `${best.r.trackName} — ${best.r.artistName}`, true);
    } else {
      renderAll();
      openFind(found.map(f => f.r));
    }
  }

  // ---------- Spotify link -> song -> YouTube ----------
  function spotifyTrackId(text) {
    const m = String(text || '').match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/) || String(text || '').match(/spotify:track:([A-Za-z0-9]{22})/);
    return m ? m[1] : null;
  }
  function youtubeId(text) {
    const m = String(text || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }
  async function spotifyTitle(id) {
    const r = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/track/' + id));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return { title: j.title || '', thumb: j.thumbnail_url || '' };
  }
  async function youtubeSearch(q) {
    let lastErr = null;
    for (const base of PIPED) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 6000);
        const r = await fetch(base + '/search?q=' + encodeURIComponent(q) + '&filter=music_songs', { signal: ctl.signal });
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const items = (j.items || []).map(it => ({ id: youtubeId('https://youtube.com' + (it.url || '')), title: it.title, by: it.uploaderName, duration: it.duration }))
          .filter(it => it.id);
        if (items.length) return items;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no results');
  }

  const spot = { step: 'input', title: '', results: [], picked: null, ytResults: [], note: '' };
  function openSpotify() {
    spot.step = 'input'; spot.note = ''; spot.results = []; spot.ytResults = []; spot.picked = null;
    $('#spotModal').hidden = false;
    renderSpot();
    setTimeout(() => { const i = $('#spotIn'); if (i) i.focus(); }, 50);
  }
  function renderSpot() {
    const box = $('#spotBody');
    let h = '';
    if (spot.step === 'input' || spot.step === 'pick') {
      h += `<div class="hint">In Spotify: tap <b>⋯</b> or <b>Share</b> on the song → <b>Copy Link</b>, then paste it here. Or just type the song name.</div>
        <div class="row" style="margin-top:8px"><input id="spotIn" class="input" placeholder="Spotify link or song name" data-testid="spot-in">
        <button class="btn" id="spotPaste" data-testid="spot-paste">📋</button><button class="btn primary" id="spotGo" data-testid="spot-go">Find</button></div>`;
    }
    if (spot.note) h += `<div class="hint" data-testid="spot-note">${esc(spot.note)}</div>`;
    if (spot.step === 'pick') {
      h += `<div class="label">Which song is it?</div><div class="results">` + spot.results.slice(0, 12).map((r, i) =>
        `<button class="res" data-pick="${i}"><span class="t">${esc(r.trackName)}<small>${esc(r.artistName)}${r.albumName ? ' · ' + esc(r.albumName) : ''} · ${fmt(r.duration)}</small></span><span class="tag ok">synced</span></button>`).join('') + `</div>`;
    }
    if (spot.step === 'yt') {
      const r = spot.picked;
      h += `<div class="hint">Song: <b>${esc(r.trackName)}</b> — ${esc(r.artistName)} (${fmt(r.duration)})</div>`;
      if (spot.ytResults.length) {
        h += `<div class="label">Play it from YouTube</div><div class="results">` + spot.ytResults.slice(0, 8).map((v, i) => {
          const dd = r.duration && v.duration ? Math.abs(v.duration - r.duration) : null;
          return `<button class="res" data-yt="${i}"><span class="t">${esc(v.title)}<small>${esc(v.by || '')} · ${fmt(v.duration)}</small></span>${dd != null && dd <= 2 ? '<span class="tag ok">same length ✓</span>' : ''}</button>`;
        }).join('') + `</div>`;
      }
      h += `<div class="label">Or paste a YouTube link</div>
        <div class="row"><input id="ytIn" class="input" placeholder="https://youtube.com/watch?v=…" data-testid="yt-in"><button class="btn primary" id="ytUse" data-testid="yt-use">Use</button></div>
        <div class="hint"><a href="https://www.youtube.com/results?search_query=${encodeURIComponent(r.artistName + ' ' + r.trackName + ' topic')}" target="_blank" rel="noopener" style="color:#1ed760">Search YouTube ↗</a> · pick the upload that says <b>“Provided to YouTube”</b> / <b>“– Topic”</b>: it's the same recording as Spotify, so the lyric timing matches.</div>`;
    }
    box.innerHTML = h;
    const go = $('#spotGo');
    if (go) go.onclick = () => spotFind($('#spotIn').value);
    const inp = $('#spotIn');
    if (inp) { inp.value = spot.input || ''; inp.onkeydown = e => { if (e.key === 'Enter') spotFind(inp.value); }; }
    const pb = $('#spotPaste');
    if (pb) pb.onclick = async () => { try { const t = await navigator.clipboard.readText(); $('#spotIn').value = t; spotFind(t); } catch (e) { spot.note = 'Paste with a long-press in the box instead.'; renderSpot(); } };
    box.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => spotPick(spot.results[Number(b.dataset.pick)]));
    box.querySelectorAll('[data-yt]').forEach(b => b.onclick = () => spotUse(spot.ytResults[Number(b.dataset.yt)].id));
    const yu = $('#ytUse');
    if (yu) yu.onclick = () => { const id = youtubeId($('#ytIn').value); if (id) spotUse(id); else { spot.note = 'That doesn\'t look like a YouTube link.'; renderSpot(); } };
  }

  async function spotFind(text) {
    text = String(text || '').trim();
    spot.input = text;
    if (!text) return;
    const directYt = youtubeId(text);
    let title = text;
    spot.note = 'Looking it up…'; renderSpot();
    const sid = spotifyTrackId(text);
    if (sid) {
      try { title = (await spotifyTitle(sid)).title; }
      catch (e) { spot.note = 'Couldn\'t read that Spotify link. Type the song name instead.'; spot.step = 'input'; renderSpot(); return; }
    } else if (/https?:\/\//.test(text) && !directYt) {
      spot.note = 'That link isn\'t a Spotify song link. In Spotify use Share → Copy Link on a song, or type the name.'; renderSpot(); return;
    }
    if (directYt) { spot.note = 'Type the song name too, so the lyrics can be found.'; renderSpot(); return; }
    let results = [];
    try { results = (await lrclibSearch(title)).filter(r => r.syncedLyrics); }
    catch (e) { spot.note = 'Couldn\'t reach the lyrics service. Check your internet.'; renderSpot(); return; }
    if (!results.length) { spot.note = `No synced lyrics found for “${title}”. Try adding the artist name.`; spot.step = 'input'; renderSpot(); return; }
    spot.results = rank(results, title, NaN).map(x => x.r);
    spot.note = sid ? `Spotify song: “${title}”` : '';
    spot.step = 'pick';
    renderSpot();
  }

  async function spotPick(r) {
    spot.picked = r;
    spot.step = 'yt';
    spot.ytResults = [];
    spot.note = 'Finding it on YouTube…';
    renderSpot();
    try {
      const items = await youtubeSearch(`${r.artistName} ${r.trackName}`);
      items.sort((a, b) => Math.abs((a.duration || 0) - r.duration) - Math.abs((b.duration || 0) - r.duration));
      spot.ytResults = items;
      const best = items[0];
      if (best && Math.abs(best.duration - r.duration) <= 2) { spot.note = ''; return spotUse(best.id); }
      spot.note = 'Pick the version that matches (same length = same recording as Spotify).';
    } catch (e) {
      spot.note = 'Couldn\'t search YouTube automatically. Paste a YouTube link below.';
    }
    renderSpot();
  }

  async function spotUse(videoId) {
    const r = spot.picked;
    $('#spotModal').hidden = true;
    await openSong({ key: 'yt:' + videoId, type: 'yt', name: r.trackName, title: r.trackName, artist: r.artistName, videoId, lrc: r.syncedLyrics, lrcSource: `${r.trackName} — ${r.artistName}` });
  }

  // ---------- follow Spotify live (via Last.fm "now playing") ----------
  const follow = Object.assign({ user: '', key: '', on: false }, load('lt-follow', {}));
  const F = { timer: null, lastSeen: '', pending: null, status: '' };

  async function lastfmNowPlaying() {
    const url = 'https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&limit=1&format=json'
      + '&user=' + encodeURIComponent(follow.user) + '&api_key=' + encodeURIComponent(follow.key) + '&_=' + Date.now();
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error(j.message || ('Last.fm error ' + j.error));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = j.recenttracks && [].concat(j.recenttracks.track || [])[0];
    if (!t || !(t['@attr'] && t['@attr'].nowplaying === 'true')) return null;
    return { name: t.name, artist: (t.artist && (t.artist['#text'] || t.artist.name)) || '', album: (t.album && t.album['#text']) || '' };
  }

  function renderNp() {
    const bar = $('#npbar');
    $('#btnFollow').classList.toggle('on', follow.on);
    $('#btnFollow').textContent = follow.on ? '● Following Spotify' : '🔗 Follow my Spotify';
    if (!follow.on) { bar.hidden = true; return; }
    bar.hidden = false;
    let h = `<span class="dot"></span><span class="grow">${F.status}</span>`;
    if (F.pending) h += `<button class="btn small primary" id="npSwitch" data-testid="np-switch">Switch to it</button>`;
    bar.innerHTML = h;
    const sw = $('#npSwitch');
    if (sw) sw.onclick = () => { const p = F.pending; F.pending = null; loadSpotifySong(p); };
  }

  async function pollSpotify() {
    if (!follow.on) return;
    let np;
    try { np = await lastfmNowPlaying(); }
    catch (e) { F.status = '⚠ Last.fm: ' + esc(e.message) + ' (check the username / API key)'; renderNp(); return; }
    if (!np) { if (!F.lastSeen) { F.status = 'Waiting for Spotify… play a song in Spotify.'; renderNp(); } return; }
    const id = (np.artist + ' — ' + np.name).toLowerCase();
    if (id === F.lastSeen) return;
    F.lastSeen = id;
    if (E.active || E.fullPlay) { // don't interrupt a session; offer the switch
      F.pending = np;
      F.status = `Spotify is now playing <b>${esc(np.name)}</b> — ${esc(np.artist)}`;
      renderNp();
      return;
    }
    loadSpotifySong(np);
  }

  // Spotify song -> synced lyrics (LRCLIB) -> the same recording on YouTube -> ready to train
  async function loadSpotifySong(np) {
    F.pending = null;
    F.status = `Spotify: <b>${esc(np.name)}</b> — ${esc(np.artist)} · finding lyrics…`;
    renderNp();
    let lyr = null;
    try {
      const want = simplify(np.name), wantArtist = simplify(np.artist);
      const list = (await lrclibSearch(np.artist + ' ' + np.name)).filter(r => r.syncedLyrics);
      const scored = list.map(r => {
        const t = simplify(r.trackName), a = simplify(r.artistName);
        let s = 0;
        if (t === want) s += 10; else if (t.includes(want) || want.includes(t)) s += 5;
        if (a === wantArtist) s += 8; else if (a.includes(wantArtist) || wantArtist.includes(a)) s += 4;
        if (np.album && simplify(r.albumName) === simplify(np.album)) s += 3;
        return { r, s };
      }).sort((x, y) => y.s - x.s);
      lyr = scored[0] && scored[0].s >= 9 ? scored[0].r : null;
    } catch (e) { /* handled below */ }
    if (!lyr) { F.status = `Spotify: <b>${esc(np.name)}</b> — ${esc(np.artist)} · no synced lyrics found for this song.`; renderNp(); return; }
    F.status = `Spotify: <b>${esc(np.name)}</b> — ${esc(np.artist)} · finding the audio…`;
    renderNp();
    let vid = null;
    try {
      const items = await youtubeSearch(`${lyr.artistName} ${lyr.trackName}`);
      items.sort((a, b) => Math.abs((a.duration || 0) - lyr.duration) - Math.abs((b.duration || 0) - lyr.duration));
      if (items[0] && Math.abs(items[0].duration - lyr.duration) <= 2) vid = items[0].id;
    } catch (e) { /* handled below */ }
    if (!vid) {
      F.status = `Spotify: <b>${esc(np.name)}</b> — ${esc(np.artist)} · couldn't find the audio automatically.`;
      renderNp();
      spot.picked = lyr; spot.step = 'yt'; spot.ytResults = []; spot.note = 'Paste a YouTube link for this song:';
      $('#spotModal').hidden = false; renderSpot();
      return;
    }
    const ok = await openSong({ key: 'yt:' + vid, type: 'yt', name: lyr.trackName, title: lyr.trackName, artist: lyr.artistName, videoId: vid, lrc: lyr.syncedLyrics, lrcSource: `${lyr.trackName} — ${lyr.artistName}` });
    F.status = ok ? `▶ From Spotify: <b>${esc(np.name)}</b> — ${esc(np.artist)} · ready. Pause Spotify and press ▶ Start.` : F.status;
    renderNp();
  }

  function startFollowing() {
    follow.on = true; save('lt-follow', follow);
    F.lastSeen = ''; F.status = 'Connecting to Last.fm…';
    clearInterval(F.timer);
    F.timer = setInterval(pollSpotify, 8000);
    renderNp();
    pollSpotify();
  }
  function stopFollowing() {
    follow.on = false; save('lt-follow', follow);
    clearInterval(F.timer); F.timer = null; F.pending = null;
    renderNp();
  }
  $('#btnFollow').addEventListener('click', () => {
    $('#followModal').hidden = false;
    $('#fmUser').value = follow.user; $('#fmKey').value = follow.key;
    $('#fmNote').textContent = follow.on ? 'Following now. New songs you play in Spotify show up here within a few seconds.' : '';
  });
  $('#fmStart').addEventListener('click', async () => {
    follow.user = $('#fmUser').value.trim(); follow.key = $('#fmKey').value.trim();
    if (!follow.user || !follow.key) { $('#fmNote').textContent = 'Fill in both boxes.'; return; }
    $('#fmNote').textContent = 'Checking…';
    try { await lastfmNowPlaying(); }
    catch (e) { $('#fmNote').textContent = '⚠ ' + e.message + '. Check the username and API key.'; return; }
    $('#followModal').hidden = true;
    startFollowing();
  });
  $('#fmStop').addEventListener('click', () => { stopFollowing(); $('#followModal').hidden = true; });

  // ---------- audio analysis (song files only) ----------
  async function analyze() {
    if (envelope) return envelope;
    if (!songBlob) throw new Error('only song files can be analyzed');
    const buf = await songBlob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const decoded = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(buf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
    try { ctx.close(); } catch (e) { /* ignore */ }
    const SR = 8000;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(1, Math.ceil(decoded.duration * SR), SR);
    const src = off.createBufferSource();
    src.buffer = decoded;
    const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 250;
    const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
    src.connect(hp); hp.connect(lp); lp.connect(off.destination);
    src.start();
    const rendered = await new Promise((res, rej) => {
      off.oncomplete = e => res(e.renderedBuffer);
      const p = off.startRendering();
      if (p && p.then) p.then(res, rej);
    });
    const x = rendered.getChannelData(0);
    const hop = 0.01, H = Math.round(SR * hop), W = H * 2;
    const n = Math.floor(x.length / H);
    const logE = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const a = i * H, b = Math.min(x.length, a + W);
      for (let j = a; j < b; j++) s += x[j] * x[j];
      logE[i] = Math.log10(s / (b - a || 1) + 1e-9);
    }
    const onset = new Float32Array(n);
    for (let i = 8; i < n; i++) {
      let m = 0;
      for (let k = 1; k <= 8; k++) m += logE[i - k];
      onset[i] = Math.max(0, logE[i] - m / 8);
    }
    envelope = { hop, onset };
    return envelope;
  }

  function bestOffset(env, starts, range) {
    const { hop, onset } = env;
    const W = 0.12;
    const peakNear = t => {
      let m = 0;
      const a = Math.round((t - W) / hop), b = Math.round((t + W) / hop);
      for (let i = Math.max(0, a); i <= b && i < onset.length; i++) {
        const v = onset[i] * (1 - Math.abs(i * hop - t) / (W + hop));
        if (v > m) m = v;
      }
      return m;
    };
    let best = 0, bestScore = -1;
    const scores = [];
    for (let o = -range; o <= range + 1e-9; o += 0.01) {
      let s = 0;
      for (const t of starts) s += peakNear(t + o);
      scores.push(s);
      if (s > bestScore + 1e-9 || (Math.abs(s - bestScore) < 1e-9 && Math.abs(o) < Math.abs(best))) { bestScore = s; best = o; }
    }
    const sorted = scores.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] || 1e-9;
    return { offset: round(best), confidence: bestScore / median };
  }

  async function autoSync(quiet) {
    if (!baseLines.length) return;
    if (!songBlob) { // YouTube: the audio can't be analyzed; the "same length" version already matches the lyric timing
      if (!quiet) E.message = 'For YouTube songs, play it and tap 🎯 at the first word to line the lyrics up.';
      renderAll();
      return;
    }
    E.message = '🎧 Listening to the song to sync the lyrics…'; renderAll();
    try {
      const env = await analyze();
      const r = bestOffset(env, baseLines.map(l => l.start), 3);
      if (r.confidence >= 1.35) {
        adj.offset = r.offset;
        commitAdj();
        E.message = Math.abs(r.offset) < 0.02 ? '🎯 Lyrics already match the audio.' : `🎯 Synced to the audio (${sgn(r.offset)}s).`;
      } else {
        E.message = quiet ? '' : 'Couldn\'t find a clear match in the audio, so timing was left as is. Use Fix timing if needed.';
      }
    } catch (e) {
      E.message = quiet ? '' : 'This file couldn\'t be analyzed (' + (e && e.message || 'decode error') + ').';
    }
    renderAll();
  }

  async function snapLines() {
    if (!baseLines.length) return;
    if (!songBlob) { E.message = 'Snapping needs a song file; for YouTube songs use 🎯 at the first word and the ± buttons.'; renderAll(); return; }
    E.message = '🎧 Listening for each line…'; renderAll();
    try {
      const env = await analyze();
      const { hop, onset } = env;
      const nz = Array.from(onset).filter(v => v > 0).sort((a, b) => a - b);
      const strong = nz[Math.floor(nz.length * 0.9)] || 0.1;
      let moved = 0;
      adj.lines = adj.lines || {};
      const shown = core.applyAdjustments(baseLines, Object.assign({}, adj, { lines: {} }));
      for (const ln of shown) {
        let bi = -1, bv = 0;
        const a = Math.round((ln.start - 0.35) / hop), b = Math.round((ln.start + 0.35) / hop);
        for (let i = Math.max(0, a); i <= b && i < onset.length; i++) if (onset[i] > bv) { bv = onset[i]; bi = i; }
        if (bi < 0 || bv < strong) continue;
        const ds = round(bi * hop - ln.start);
        const a2 = adj.lines[ln.id] = adj.lines[ln.id] || {};
        if (Math.abs(ds) >= 0.03) { a2.ds = ds; moved++; } else delete a2.ds;
        if (!a2.ds && !a2.de) delete adj.lines[ln.id];
      }
      commitAdj();
      E.message = moved ? `🎯 Moved ${moved} line start${moved > 1 ? 's' : ''} onto the voice.` : '🎯 Every line already starts on the voice.';
    } catch (e) {
      E.message = 'This file couldn\'t be analyzed.';
    }
    renderAll();
  }

  // tap at the first sung word: shifts the whole song so line 1 starts right there
  function tapFirstWord() {
    if (!baseLines.length) return;
    adj.offset = round(P.t - baseLines[0].start - 0.05);
    commitAdj();
    E.message = `🎯 Lined up: whole song ${sgn(adj.offset)}s.`;
    renderAll();
  }

  // ---------- playback engine ----------
  function seek(t) { E.lastSeekAt = performance.now(); P.seek(t); }

  function beginStep(allowContinue) {
    const ln = lines[E.line];
    if (!ln) return;
    E.rate = E.plan.stages[E.stage];
    P.setRate(E.rate);
    const target = Math.max(0, ln.start - core.LEAD_IN);
    const now = P.t;
    if (!(allowContinue && now >= target - 0.05 && now <= ln.start)) seek(target);
    renderAll();
  }

  function startTraining() {
    if (!lines.length) return;
    E.plan = core.plan(settings);
    E.active = true; E.fullPlay = false; E.message = ''; E.restUntil = 0;
    E.line = settings.startFrom === 'current' ? core.findLineAt(lines, P.t) : 0;
    E.stage = 0; E.rep = 0;
    beginStep(false);
    P.play(); // inside the tap, so iPad allows it
  }

  function stopTraining(msg) {
    E.active = false; E.fullPlay = false; E.restUntil = 0;
    E.rate = 1; try { P.setRate(1); } catch (e) { /* not ready */ }
    if (msg != null) E.message = msg;
    renderAll();
  }

  function finish() {
    P.setRate(1); E.rate = 1;
    if (settings.mode === 'training' && settings.playFullAfter) {
      E.active = false; E.fullPlay = true;
      E.message = 'Training done! Now playing the whole song at 100% 🎶';
      seek(0); P.play();
      renderAll();
      return;
    }
    songDone();
  }

  async function songDone(doneMsg) {
    E.active = false; E.fullPlay = false;
    if (!settings.autoNextSong) { stopTraining(doneMsg || 'Song finished! 🎉'); return; }
    const list = await library();
    const i = list.findIndex(s => s.key === (song && song.key));
    const next = list[i + 1];
    if (!next) { stopTraining('All songs in your library are done! 🎉'); return; }
    E.message = `Next song: ${next.title || next.name}…`;
    renderAll();
    if (await openSong(next) && lines.length) {
      startTraining();
      E.message = `▶ Now training: ${song.title || song.name}`;
      renderAll();
    }
  }

  function tick() {
    if (E.fullPlay) {
      P.setRate(1);
      if (P.ended || (P.duration && P.t >= P.duration - 0.3 && !P.paused)) { E.fullPlay = false; songDone('Training complete! 🎉'); }
      return;
    }
    if (!E.active) return;
    const ln = lines[E.line];
    if (!ln) return;
    if (E.restUntil) {
      if (performance.now() >= E.restUntil) {
        E.restUntil = 0; E.message = '';
        beginStep(false);
        P.play();
      }
      return;
    }
    P.setRate(E.rate);
    if (performance.now() - E.lastSeekAt < 150) return;
    if (P.ended || (!P.paused && P.t >= ln.end - core.TAIL)) {
      const next = core.advance({ line: E.line, stage: E.stage, rep: E.rep }, lines.length, E.plan);
      if (next.done) return finish();
      const sameLine = next.line === E.line;
      E.line = next.line; E.stage = next.stage; E.rep = next.rep;
      if (!sameLine && E.plan.rest > 0) { // practice: rest before the next line
        P.pause();
        E.restUntil = performance.now() + E.plan.rest * 1000;
        E.rate = E.plan.stages[0];
        renderAll();
        return;
      }
      beginStep(!sameLine && E.plan.stages[E.stage] === E.rate);
      if (P.paused) P.play();
    }
  }
  setInterval(tick, 20);

  function jump(i) {
    E.line = Math.max(0, Math.min(lines.length - 1, i));
    E.stage = 0; E.rep = 0;
    if (E.restUntil) { E.restUntil = 0; P.play(); }
    beginStep(false);
  }

  // ---------- timing fixes ----------
  function commitAdj() {
    const a = adj;
    const empty = !a.offset && !(a.joins && a.joins.length) && !Object.keys(a.lines || {}).length;
    save('lt-adj:' + song.key, empty ? {} : a);
    const keep = lines[E.line] ? lines[E.line].id : 0;
    rebuild();
    const idx = lines.findIndex(l => l.id <= keep && keep <= l.id + l.joined);
    if (idx >= 0) E.line = idx;
    if (E.active && !E.restUntil) beginStep(false); else renderAll();
  }

  function fix(type, field, delta) {
    const ln = lines[E.line];
    if (!ln) return;
    adj.lines = adj.lines || {};
    const a = adj.lines[ln.id] = adj.lines[ln.id] || {};
    if (type === 'nudge') {
      const k = field === 'start' ? 'ds' : 'de';
      a[k] = round((a[k] || 0) + delta);
    } else if (type === 'now') {
      const now = P.t;
      if (field === 'start') { if (now >= ln.end - 0.3) return; a.ds = round((a.ds || 0) + now - ln.start); }
      else { if (now <= ln.start + 0.3) return; a.de = round((a.de || 0) + now - ln.end); }
    } else if (type === 'offset') {
      adj.offset = round((adj.offset || 0) + delta);
    } else if (type === 'join') {
      if (E.line >= lines.length - 1) return;
      adj.joins = [...new Set([...(adj.joins || []), ln.id + ln.joined])];
      delete a.de;
    } else if (type === 'split') {
      adj.joins = (adj.joins || []).filter(j => j < ln.id || j >= ln.id + ln.joined);
    } else if (type === 'reset') {
      adj = {};
    }
    if (adj.lines && adj.lines[ln.id] && !adj.lines[ln.id].ds && !adj.lines[ln.id].de) delete adj.lines[ln.id];
    commitAdj();
    if (type === 'reset') autoSync(true);
  }

  // ---------- UI ----------
  function setSetting(patch) {
    Object.assign(settings, patch);
    save('lt-settings', settings);
    if (E.active) {
      const old = E.rate;
      E.plan = core.plan(settings);
      if (E.stage >= E.plan.stages.length) { E.stage = 0; E.rep = 0; }
      if (E.rep >= core.repsAt(E.plan, E.stage)) E.rep = core.repsAt(E.plan, E.stage) - 1;
      E.rate = E.plan.stages[E.stage];
      if (E.rate !== old && !E.restUntil) P.setRate(E.rate);
    }
    renderAll();
  }

  function chips(values, isSel, label, id) {
    return `<div class="chips">${values.map(v => `<button class="chip${isSel(v) ? ' sel' : ''}" data-act="${id}" data-v="${v}">${label(v)}</button>`).join('')}</div>`;
  }

  function renderPanel() {
    const mode = settings.mode;
    const has = lines.length > 0;
    let h = '';
    h += `<div class="label">Mode</div>` + chips(['repeat', 'training', 'practice'], v => mode === v, v => ({ repeat: '🔁 Repeat', training: '🏋️ Training', practice: '🎯 Practice' })[v], 'mode');
    if (mode === 'training') {
      h += `<div class="label">Times at each speed</div>` + chips(REPS, v => settings.trainingReps === v, v => v + '×', 'treps');
      h += `<div class="label">Speed ladder (tap to include / skip)</div>` + chips(SPEEDS, v => settings.trainingSpeeds.includes(v), pct, 'tspeed');
      h += `<div class="hint">Each line: ${settings.trainingSpeeds.map(pct).join(' → ')}, ${settings.trainingReps}× each, then the next line.</div>`;
      h += `<label class="check"><input type="checkbox" data-act="full" ${settings.playFullAfter ? 'checked' : ''}> At the end, play the whole song once at 100%</label>`;
    } else if (mode === 'practice') {
      h += `<div class="label">Speed-up plays (30% → 100%)</div>` + chips(core.RAMP, v => settings.practiceRamp === v, v => v + '×', 'pramp');
      h += `<div class="label">Then plays at 100%</div>` + chips(core.NORMAL, v => settings.practiceNormal === v, v => v + '×', 'pnorm');
      h += `<div class="label">Rest before the next line</div>` + chips(core.REST, v => settings.practiceRest === v, v => v ? v + 's' : 'none', 'prest');
      const p = core.plan(settings);
      h += `<div class="hint">Each line: ${settings.practiceRamp} plays getting faster (${p.stages.slice(0, -1).map(pct).join(', ')}), then ${settings.practiceNormal}× at 100% = ${core.playsPerLine(p)} plays${settings.practiceRest ? `, rest ${settings.practiceRest}s` : ''}, then the next line.</div>`;
    } else {
      h += `<div class="label">Repeat each line</div>` + chips(REPS, v => settings.reps === v, v => v + '×', 'reps');
      h += `<div class="label">Speed</div>` + chips(SPEEDS, v => settings.speed === v, pct, 'speed');
    }
    h += `<div class="label">Start from</div>` + chips(['first', 'current'], v => settings.startFrom === v, v => v === 'first' ? 'First line' : 'Current line', 'from');
    h += `<label class="check"><input type="checkbox" data-act="autonext" data-testid="autonext" ${settings.autoNextSong ? 'checked' : ''}> When the song is done, go to the next song in my Library</label>`;
    const busy = E.active || E.fullPlay;
    h += `<div class="controls">
      <button class="nav" data-act="prev" ${E.active ? '' : 'disabled'} title="Previous line">⏮</button>
      <button class="nav" data-act="restart" ${E.active ? '' : 'disabled'} title="Restart line">↻</button>
      ${busy ? `<button class="big stop" data-act="stop" data-testid="toggle">■ Stop</button>`
             : `<button class="big" data-act="start" data-testid="toggle" ${has ? '' : 'disabled'}>▶ Start</button>`}
      <button class="nav" data-act="next" ${E.active ? '' : 'disabled'} title="Next line">⏭</button></div>`;
    if (E.active) {
      const ln = lines[E.line];
      const total = core.playsPerLine(E.plan), idx = core.playIndex(E.plan, E);
      const actual = P.rate;
      const rateTxt = pct(E.rate) + (P.kind === 'yt' && Math.abs(actual - E.rate) > 0.011 ? ` (YouTube: ${pct(actual)})` : '');
      h += `<div class="status" data-testid="status">`;
      if (E.restUntil) {
        h += `<div class="meta" data-testid="rest">😮‍💨 Rest: <span id="restLeft">${Math.ceil((E.restUntil - performance.now()) / 1000)}</span>s · next: line ${E.line + 1}/${lines.length}</div>
          <div class="cur-lyric">${esc(ln ? ln.text : '')}</div><button class="btn small" data-act="skiprest" data-testid="skiprest" style="margin-top:6px">Skip rest ⏭</button>`;
      } else {
        h += `<div class="meta" data-testid="meta">Line ${E.line + 1}/${lines.length} · ${rateTxt} · play ${idx}/${total}</div>
          <div class="cur-lyric">${esc(ln ? ln.text : '')}</div>
          ${lines[E.line + 1] ? `<div class="next">Next: ${esc(lines[E.line + 1].text)}</div>` : ''}`;
      }
      if (settings.mode === 'training' && E.plan.stages.length > 1) h += `<div class="ladder">${E.plan.stages.map((v, i) => `<span class="${i < E.stage ? 'done' : i === E.stage ? 'cur' : ''}">${pct(v)}</span>`).join('')}</div>`;
      if (settings.mode === 'practice') h += `<div class="bar"><i style="width:${100 * idx / total}%"></i></div>`;
      h += `<div class="bar"><i style="width:${100 * (E.line + 1) / lines.length}%"></i></div></div>`;
    }
    if (E.message) h += `<div class="msg" data-testid="msg">${esc(E.message)}</div>`;
    if (has) {
      const ln = lines[E.line] || lines[0];
      h += `<div class="fix"><button class="fixhead" data-act="fixopen" data-testid="fixopen"><span>⏱ Fix timing${(adj.offset || (adj.joins || []).length || Object.keys(adj.lines || {}).length) ? ' •' : ''}</span><span>${settings.fixOpen ? '▾' : '▸'}</span></button>`;
      if (settings.fixOpen) {
        const row = (field, label, v) => `<div class="fixrow"><div class="fixlbl">${label}<b data-testid="${field}-time">${fmtT(v)}</b></div>${[-0.5, -0.1, 0.1, 0.5].map(d =>
          `<button class="mini" data-act="nudge" data-f="${field}" data-d="${d}" data-testid="${field}${d > 0 ? '+' : '-'}${Math.abs(d)}">${d > 0 ? '+' : '−'}${Math.abs(d)}</button>`).join('')}<button class="mini now" data-act="now" data-f="${field}" data-testid="${field}-now">⏺ now</button></div>`;
        h += `<div class="hint">Line ${E.line + 1}: ${esc(ln.text)}</div>`;
        h += row('start', 'Start', ln.start) + row('end', 'End', ln.end);
        h += `<div class="fixrow"><div class="fixlbl">Whole song<b data-testid="offset">${sgn(adj.offset || 0)}s</b></div>
          <button class="mini" data-act="offset" data-d="-0.1" data-testid="offset-0.1">earlier −0.1</button>
          <button class="mini" data-act="offset" data-d="0.1" data-testid="offset+0.1">later +0.1</button></div>
          <div class="fixbtns"><button class="mini accent" data-act="tapfirst" data-testid="tapfirst">🎯 Tap at the first word</button></div>
          <div class="fixbtns"><button class="mini accent" data-act="autosync" data-testid="autosync" ${songBlob ? '' : 'disabled'}>🎧 Auto-sync whole song</button>
          <button class="mini accent" data-act="snap" data-testid="snap" ${songBlob ? '' : 'disabled'}>🎧 Snap each line</button></div>
          <div class="fixbtns"><button class="mini" data-act="join" data-testid="join" ${E.line >= lines.length - 1 ? 'disabled' : ''}>🔗 Join next</button>
          <button class="mini" data-act="split" data-testid="split" ${ln.joined ? '' : 'disabled'}>✂️ Split</button>
          <button class="mini" data-act="reset" data-testid="reset">↺ Reset</button></div>
          <div class="hint">🎯 Tap at the first word: play the song from the start and tap the moment the singing begins. 🎧 buttons listen to song files and line lyrics up with the voice. Tap a lyric on the left to jump to it. Fixes are saved for this song.</div>`;
      }
      h += `</div>`;
    } else if (!song) {
      h += `<div class="empty-state"><b>How to start</b><br>• <b>🎵 From Spotify</b>: copy a song's link in Spotify (Share → Copy Link) and paste it. It plays through YouTube with synced lyrics.<br>• Or <b>📂 Open file</b>: pick an mp3 / m4a from Files.<br>Then press <b>▶ Start</b>.</div>`;
    }
    $('#panel').innerHTML = h;
  }

  let lyricsKey = '';
  function renderLyrics() {
    const key = lines.map(l => l.id + ':' + l.joined + ':' + l.text).join('|') + '#' + !!song;
    const box = $('#lyrics');
    if (key !== lyricsKey) {
      lyricsKey = key;
      box.innerHTML = lines.length
        ? lines.map((l, i) => `<div class="ly" data-i="${i}">${esc(l.text)}</div>`).join('')
        : `<div class="ly empty">${song ? 'No lyrics yet. Tap 🔎 Lyrics to search.' : 'Pick a song to see its lyrics here.'}</div>`;
    }
    highlight(true);
  }

  let lastHi = -2, lastLoop = -2;
  function highlight(force) {
    if (!lines.length) return;
    const cur = E.active ? E.line : core.findLineAt(lines, P.t + 0.05);
    const loop = E.active ? E.line : -1;
    if (!force && cur === lastHi && loop === lastLoop) return;
    lastHi = cur; lastLoop = loop;
    const els = $('#lyrics').children;
    for (let i = 0; i < els.length; i++) {
      els[i].classList.toggle('cur', i === cur);
      els[i].classList.toggle('past', i < cur);
      els[i].classList.toggle('loop', i === loop);
    }
    const el = els[cur];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
  }

  function renderTop() {
    $('#songinfo').innerHTML = song ? `<b>${esc(song.title || song.name)}</b>${song.artist ? ' — ' + esc(song.artist) : ''}${song.type === 'yt' ? ' <span class="tag">YouTube</span>' : ''}` : 'Pick a song to start';
    $('#lyrStatus').textContent = !song ? 'No song' : lines.length ? `Lyrics: ${lyrSource}` : 'No lyrics yet';
    $('#tDur').textContent = fmt(P.duration);
  }

  function renderAll() { renderTop(); renderPanel(); renderLyrics(); }

  // transport
  let dragging = false;
  setInterval(() => {
    const d = P.duration, t = P.t;
    if (!dragging && d) $('#seek').value = Math.round(1000 * t / d);
    $('#tCur').textContent = fmt(t);
    $('#tDur').textContent = fmt(d);
    $('#btnPlay').textContent = P.paused ? '▶' : '❚❚';
    const rl = $('#restLeft');
    if (rl && E.restUntil) rl.textContent = Math.max(0, Math.ceil((E.restUntil - performance.now()) / 1000));
    highlight(false);
  }, 100);
  $('#btnPlay').addEventListener('click', () => { if (!song) return; if (P.paused) P.play(); else P.pause(); });
  $('#seek').addEventListener('input', () => { dragging = true; $('#tCur').textContent = fmt(P.duration * $('#seek').value / 1000); });
  $('#seek').addEventListener('change', () => {
    dragging = false;
    if (!P.duration) return;
    const t = P.duration * $('#seek').value / 1000;
    if (E.active) jump(core.findLineAt(lines, t)); else seek(t);
  });

  $('#lyrics').addEventListener('click', e => {
    const el = e.target.closest('.ly[data-i]');
    if (!el) return;
    const i = Number(el.dataset.i);
    if (E.active) jump(i);
    else { seek(Math.max(0, lines[i].start - core.LEAD_IN)); P.play(); E.line = i; renderPanel(); }
  });

  $('#panel').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled || b.tagName === 'INPUT') return;
    const v = b.dataset.v, act = b.dataset.act;
    switch (act) {
      case 'mode': return setSetting({ mode: v });
      case 'reps': return setSetting({ reps: Number(v) });
      case 'speed': return setSetting({ speed: Number(v) });
      case 'treps': return setSetting({ trainingReps: Number(v) });
      case 'pramp': return setSetting({ practiceRamp: Number(v) });
      case 'pnorm': return setSetting({ practiceNormal: Number(v) });
      case 'prest': return setSetting({ practiceRest: Number(v) });
      case 'tspeed': {
        const n = Number(v);
        let list = settings.trainingSpeeds.includes(n) ? settings.trainingSpeeds.filter(x => x !== n) : settings.trainingSpeeds.concat(n);
        if (!list.length) list = [n];
        return setSetting({ trainingSpeeds: list.sort((a, b) => a - b) });
      }
      case 'from': return setSetting({ startFrom: v });
      case 'start': return startTraining();
      case 'stop': return stopTraining('Stopped.');
      case 'prev': return jump(E.line - 1);
      case 'next': return jump(E.line + 1);
      case 'restart': return jump(E.line);
      case 'skiprest': E.restUntil = performance.now(); return;
      case 'fixopen': return setSetting({ fixOpen: !settings.fixOpen });
      case 'nudge': return fix('nudge', b.dataset.f, Number(b.dataset.d));
      case 'now': return fix('now', b.dataset.f);
      case 'offset': return fix('offset', null, Number(b.dataset.d));
      case 'join': return fix('join');
      case 'split': return fix('split');
      case 'reset': return fix('reset');
      case 'autosync': return autoSync(false);
      case 'snap': return snapLines();
      case 'tapfirst': return tapFirstWord();
    }
  });
  $('#panel').addEventListener('change', e => {
    if (e.target.dataset.act === 'full') setSetting({ playFullAfter: e.target.checked });
    if (e.target.dataset.act === 'autonext') setSetting({ autoNextSong: e.target.checked });
  });

  $('#file').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) openSong({ key: f.name + '|' + f.size, type: 'file', name: f.name, blob: f });
    e.target.value = '';
  });
  $('#btnSpot').addEventListener('click', openSpotify);

  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => {
    if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
  }));
  function openFind(prefill) {
    if (!song) return;
    $('#findModal').hidden = false;
    $('#q').value = [song.title, song.artist].filter(Boolean).join(' ');
    if (prefill) showResults(prefill, prefill.length ? '' : 'No synced lyrics found automatically. Try a different search.');
  }
  function showResults(list, note) {
    const box = $('#results');
    const ranked = list.slice(0, 15);
    box.innerHTML = (note ? `<div class="hint">${esc(note)}</div>` : '') + ranked.map((r, i) => {
      const dd = song && Number.isFinite(song.duration) && r.duration ? Math.abs(r.duration - song.duration) : null;
      return `<button class="res" data-ri="${i}" ${r.syncedLyrics ? '' : 'disabled'}><span class="t">${esc(r.trackName)}<small>${esc(r.artistName)}${r.albumName ? ' · ' + esc(r.albumName) : ''} · ${fmt(r.duration)}</small></span>
        ${r.syncedLyrics ? '<span class="tag ok">synced</span>' : '<span class="tag">no timing</span>'}${dd != null && dd < 3 ? '<span class="tag ok">length ✓</span>' : ''}</button>`;
    }).join('');
    box.onclick = async e => {
      const b = e.target.closest('.res');
      if (!b || b.disabled) return;
      const r = ranked[Number(b.dataset.ri)];
      $('#findModal').hidden = true;
      if (!(await setLyrics(r.syncedLyrics, `${r.trackName} — ${r.artistName}`, true))) $('#findModal').hidden = false;
    };
  }
  $('#btnFind').addEventListener('click', () => openFind(null));
  async function doSearch() {
    const q = $('#q').value.trim();
    if (!q) return;
    $('#results').innerHTML = '<div class="hint">Searching…</div>';
    try {
      const list = await lrclibSearch(q);
      list.sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0));
      showResults(list, list.length ? '' : 'Nothing found. Try just the song name.');
    } catch (e) {
      $('#results').innerHTML = '<div class="hint">Couldn\'t reach the lyrics service. Check your internet connection.</div>';
    }
  }
  $('#btnSearch').addEventListener('click', doSearch);
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  $('#btnPaste').addEventListener('click', async () => {
    $('#findModal').hidden = true;
    if (!(await setLyrics($('#lrcText').value, 'pasted', true))) $('#findModal').hidden = false;
  });

  async function openLib() {
    $('#libModal').hidden = false;
    const box = $('#libList');
    const list = await library();
    box.innerHTML = list.length ? list.map((s, i) => `<div class="res" data-li="${i}"><span class="t">${i + 1}. ${esc(s.title || s.name)}<small>${esc(s.artist || '')}${s.type === 'yt' ? ' · YouTube' : ''}</small></span>
      <button class="btn small" data-del="${i}" title="Remove">🗑</button></div>`).join('')
      : '<div class="hint">Songs you open are saved here, in order. With “go to the next song” on, training continues down this list.</div>';
    box.onclick = async e => {
      const del = e.target.closest('[data-del]');
      if (del) { await db.del(list[Number(del.dataset.del)].key); return openLib(); }
      const row = e.target.closest('[data-li]');
      if (!row) return;
      $('#libModal').hidden = true;
      openSong(list[Number(row.dataset.li)]);
    };
  }
  $('#btnLib').addEventListener('click', openLib);

  renderAll();
  if (follow.on && follow.user && follow.key) startFollowing();
  window.__LT__ = {
    E, settings, get lines() { return lines; }, get baseLines() { return baseLines; }, get adj() { return adj; }, get P() { return P; },
    audio, ytPlayer, pollSpotify, parseLrc, bestOffset, analyze, openSong, guessMeta, spotifyTrackId, youtubeId, library
  };
})();
