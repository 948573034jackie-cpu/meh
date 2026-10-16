// Line Trainer: a standalone web app (iPad / iPhone / desktop). Plays a song file you open,
// finds synced lyrics (LRCLIB), and loops every line N times / runs the slow-to-fast training ladder.
(function () {
  'use strict';
  const core = window.__SLT_CORE__;
  const $ = s => document.querySelector(s);
  const SPEEDS = core.SPEEDS, REPS = core.REPS;
  const LRCLIB = 'https://lrclib.net';

  // ---------- storage ----------
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or blocked */ } };
  const DEFAULTS = { mode: 'repeat', reps: 5, speed: 1, trainingReps: 5, trainingSpeeds: [0.3, 0.5, 0.75, 1], startFrom: 'first', playFullAfter: true, fixOpen: false };
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

  // ---------- song + lyrics state ----------
  const audio = $('#audio');
  let song = null;       // { key, name, title, artist, duration }
  let songBlob = null;
  let objectUrl = null;
  let baseLines = [];    // lyrics as found
  let adj = {};          // timing fixes for this song
  let lines = [];        // baseLines + fixes
  let lyrSource = '';
  let envelope = null;   // audio analysis cache for this song

  const E = { active: false, fullPlay: false, line: 0, stage: 0, rep: 0, rate: 1, plan: core.plan(settings), lastSeekAt: 0, message: '' };

  const fmt = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const fmtT = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(2).padStart(5, '0'); };
  const pct = v => Math.round(v * 100) + '%';
  const sgn = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(2).replace(/0$/, '');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
  async function openSong(blob, name, key) {
    stopTraining();
    key = key || (name + '|' + blob.size);
    songBlob = blob;
    envelope = null;
    song = Object.assign({ key, name }, guessMeta(name));
    try { const t = await readId3(blob); if (t.title) song.title = t.title; if (t.artist) song.artist = t.artist; } catch (e) { /* not an mp3 with tags */ }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    audio.src = objectUrl;
    audio.load();
    await new Promise(res => {
      if (audio.readyState >= 1) return res();
      audio.addEventListener('loadedmetadata', res, { once: true });
      audio.addEventListener('error', res, { once: true });
    });
    song.duration = audio.duration;
    const prev = load('lt-meta:' + key, null);
    if (prev) Object.assign(song, prev);
    db.put({ key, name, title: song.title, artist: song.artist, blob, added: Date.now() }).catch(() => {});
    adj = load('lt-adj:' + key, {});
    const saved = load('lt-lrc:' + key, null);
    baseLines = []; lines = []; lyrSource = '';
    renderAll();
    if (saved) setLyrics(saved.lrc, saved.source, false);
    else autoFindLyrics();
  }

  function setLyrics(lrc, source, isNew) {
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
    if (isNew) autoSync(true);
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
  function rank(results) {
    const dur = song && song.duration;
    const want = simplify(song && song.title);
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
        found = rank(await lrclibSearch(q));
        if (found.length) break;
      }
    } catch (e) {
      E.message = 'Couldn\'t reach the lyrics service. Check your internet, then tap 🔎 Lyrics.';
      renderAll();
      return;
    }
    const best = found[0];
    if (best && (best.dd == null || best.dd < 4)) {
      setLyrics(best.r.syncedLyrics, `${best.r.trackName} — ${best.r.artistName}`, true);
    } else {
      renderAll();
      openFind(found.map(f => f.r));
    }
  }

  // ---------- audio analysis ("listen" to the song) ----------
  async function analyze() {
    if (envelope) return envelope;
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
    // keep the "voice" band, drop bass and cymbals
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
    const onset = new Float32Array(n); // how sharply sound rises right here
    for (let i = 8; i < n; i++) {
      let m = 0;
      for (let k = 1; k <= 8; k++) m += logE[i - k];
      onset[i] = Math.max(0, logE[i] - m / 8);
    }
    envelope = { hop, onset };
    return envelope;
  }

  // Slide all line starts together and find where they best line up with sound starting.
  function bestOffset(env, starts, range) {
    const { hop, onset } = env;
    // strongest sound-start near t, counting less the further it is from t
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

  // whole-song sync: shift every line so lines start when the voice starts
  async function autoSync(quiet) {
    if (!baseLines.length || !songBlob) return;
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

  // per-line: snap each line's start to the nearest clear voice start (±0.35 s)
  async function snapLines() {
    if (!baseLines.length || !songBlob) return;
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

  // ---------- playback engine ----------
  function setRate(r) {
    audio.preservesPitch = true; audio.webkitPreservesPitch = true; audio.mozPreservesPitch = true;
    if (Math.abs(audio.playbackRate - r) > 0.001) audio.playbackRate = r;
    audio.defaultPlaybackRate = r;
  }
  function seek(t) { E.lastSeekAt = performance.now(); audio.currentTime = Math.max(0, t); }
  function play() { const p = audio.play(); if (p && p.catch) p.catch(() => {}); }

  function beginStep(allowContinue) {
    const ln = lines[E.line];
    if (!ln) return;
    E.rate = E.plan.stages[E.stage];
    setRate(E.rate);
    const target = Math.max(0, ln.start - core.LEAD_IN);
    const now = audio.currentTime;
    if (!(allowContinue && now >= target - 0.05 && now <= ln.start)) seek(target);
    renderAll();
  }

  function startTraining() {
    if (!lines.length) return;
    E.plan = core.plan(settings);
    E.active = true; E.fullPlay = false; E.message = '';
    E.line = settings.startFrom === 'current' ? core.findLineAt(lines, audio.currentTime) : 0;
    E.stage = 0; E.rep = 0;
    beginStep(false);
    play(); // inside the tap, so iPad allows it
  }

  function stopTraining(msg) {
    E.active = false; E.fullPlay = false;
    E.rate = 1; setRate(1);
    if (msg != null) E.message = msg;
    renderAll();
  }

  function finish() {
    setRate(1); E.rate = 1;
    if (settings.mode === 'training' && settings.playFullAfter) {
      E.active = false; E.fullPlay = true;
      E.message = 'Training done! Now playing the whole song at 100% 🎶';
      seek(0); play();
      renderAll();
      return;
    }
    stopTraining('Song finished! 🎉');
  }

  function tick() {
    if (E.fullPlay) {
      setRate(1);
      if (audio.ended) { E.fullPlay = false; E.message = 'Training complete! 🎉'; renderAll(); }
      return;
    }
    if (!E.active) return;
    const ln = lines[E.line];
    if (!ln) return;
    setRate(E.rate);
    if (performance.now() - E.lastSeekAt < 150) return;
    if (audio.ended || (!audio.paused && audio.currentTime >= ln.end - core.TAIL)) {
      const next = core.advance({ line: E.line, stage: E.stage, rep: E.rep }, lines.length, E.plan);
      if (next.done) return finish();
      const sameLine = next.line === E.line;
      E.line = next.line; E.stage = next.stage; E.rep = next.rep;
      beginStep(!sameLine && E.plan.stages[E.stage] === E.rate);
      if (audio.paused) play();
    }
  }
  setInterval(tick, 20);

  function jump(i) {
    E.line = Math.max(0, Math.min(lines.length - 1, i));
    E.stage = 0; E.rep = 0;
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
    if (E.active) beginStep(false); else renderAll();
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
      const now = audio.currentTime;
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
    if (type === 'reset') autoSync(true); // back to the audio-synced timing, not the raw timestamps
  }

  // ---------- UI ----------
  function setSetting(patch) {
    Object.assign(settings, patch);
    save('lt-settings', settings);
    if (E.active) {
      const old = E.rate;
      E.plan = core.plan(settings);
      if (E.stage >= E.plan.stages.length) E.stage = 0;
      if (E.rep >= E.plan.reps) E.rep = E.plan.reps - 1;
      E.rate = E.plan.stages[E.stage];
      if (E.rate !== old) setRate(E.rate);
    }
    renderAll();
  }

  function chips(values, isSel, onPick, label, id) {
    return `<div class="chips">${values.map(v => `<button class="chip${isSel(v) ? ' sel' : ''}" data-act="${id}" data-v="${v}">${label(v)}</button>`).join('')}</div>`;
  }

  function renderPanel() {
    const training = settings.mode === 'training';
    const has = lines.length > 0;
    let h = '';
    h += `<div class="label">Mode</div>` + chips(['repeat', 'training'], v => settings.mode === v, null, v => v === 'repeat' ? '🔁 Repeat' : '🏋️ Training', 'mode');
    if (training) {
      h += `<div class="label">Times at each speed</div>` + chips(REPS, v => settings.trainingReps === v, null, v => v + '×', 'treps');
      h += `<div class="label">Speed ladder (tap to include / skip)</div>` + chips(SPEEDS, v => settings.trainingSpeeds.includes(v), null, pct, 'tspeed');
      h += `<div class="hint">Each line: ${settings.trainingSpeeds.map(pct).join(' → ')}, ${settings.trainingReps}× each, then the next line.</div>`;
      h += `<label class="check"><input type="checkbox" data-act="full" ${settings.playFullAfter ? 'checked' : ''}> At the end, play the whole song once at 100%</label>`;
    } else {
      h += `<div class="label">Repeat each line</div>` + chips(REPS, v => settings.reps === v, null, v => v + '×', 'reps');
      h += `<div class="label">Speed</div>` + chips(SPEEDS, v => settings.speed === v, null, pct, 'speed');
    }
    h += `<div class="label">Start from</div>` + chips(['first', 'current'], v => settings.startFrom === v, null, v => v === 'first' ? 'First line' : 'Current line', 'from');
    const busy = E.active || E.fullPlay;
    h += `<div class="controls">
      <button class="nav" data-act="prev" ${E.active ? '' : 'disabled'} title="Previous line">⏮</button>
      <button class="nav" data-act="restart" ${E.active ? '' : 'disabled'} title="Restart line">↻</button>
      ${busy ? `<button class="big stop" data-act="stop" data-testid="toggle">■ Stop</button>`
             : `<button class="big" data-act="start" data-testid="toggle" ${has ? '' : 'disabled'}>▶ Start</button>`}
      <button class="nav" data-act="next" ${E.active ? '' : 'disabled'} title="Next line">⏭</button></div>`;
    if (E.active) {
      const ln = lines[E.line];
      h += `<div class="status" data-testid="status"><div class="meta" data-testid="meta">Line ${E.line + 1}/${lines.length} · ${pct(E.rate)} · play ${E.rep + 1}/${E.plan.reps}</div>
        <div class="cur-lyric">${esc(ln ? ln.text : '')}</div>
        ${lines[E.line + 1] ? `<div class="next">Next: ${esc(lines[E.line + 1].text)}</div>` : ''}
        ${E.plan.stages.length > 1 ? `<div class="ladder">${E.plan.stages.map((v, i) => `<span class="${i < E.stage ? 'done' : i === E.stage ? 'cur' : ''}">${pct(v)}</span>`).join('')}</div>` : ''}
        <div class="bar"><i style="width:${100 * (E.line + 1) / lines.length}%"></i></div></div>`;
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
          <div class="fixbtns"><button class="mini accent" data-act="autosync" data-testid="autosync">🎯 Auto-sync whole song</button>
          <button class="mini accent" data-act="snap" data-testid="snap">🎯 Snap each line</button></div>
          <div class="fixbtns"><button class="mini" data-act="join" data-testid="join" ${E.line >= lines.length - 1 ? 'disabled' : ''}>🔗 Join next</button>
          <button class="mini" data-act="split" data-testid="split" ${ln.joined ? '' : 'disabled'}>✂️ Split</button>
          <button class="mini" data-act="reset" data-testid="reset">↺ Reset</button></div>
          <div class="hint">🎯 buttons listen to the song and line the lyrics up with the voice. Tap a lyric on the left to jump to it. Fixes are saved for this song.</div>`;
      }
      h += `</div>`;
    } else if (!song) {
      h += `<div class="empty-state"><b>How to start</b><br>1. Tap <b>📂 Open song</b> and pick a song file (mp3 / m4a) from Files.<br>2. Lyrics are found automatically.<br>3. Press <b>▶ Start</b>.</div>`;
    }
    $('#panel').innerHTML = h;
  }

  let lyricsKey = '';
  function renderLyrics() {
    const key = lines.map(l => l.id + ':' + l.joined + ':' + l.text).join('|');
    const box = $('#lyrics');
    if (key !== lyricsKey) {
      lyricsKey = key;
      box.innerHTML = lines.length
        ? lines.map((l, i) => `<div class="ly" data-i="${i}">${esc(l.text)}</div>`).join('')
        : `<div class="ly empty">${song ? 'No lyrics yet. Tap 🔎 Lyrics to search.' : 'Open a song to see its lyrics here.'}</div>`;
    }
    highlight(true);
  }

  let lastHi = -2, lastLoop = -2;
  function highlight(force) {
    if (!lines.length) return;
    const cur = E.active ? E.line : core.findLineAt(lines, audio.currentTime + 0.05);
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
    $('#songinfo').innerHTML = song ? `<b>${esc(song.title || song.name)}</b>${song.artist ? ' — ' + esc(song.artist) : ''}` : 'Open a song to start';
    $('#lyrStatus').textContent = !song ? 'No song' : lines.length ? `Lyrics: ${lyrSource}` : 'No lyrics yet';
    $('#tDur').textContent = fmt(audio.duration);
  }

  function renderAll() { renderTop(); renderPanel(); renderLyrics(); }

  // transport
  let dragging = false;
  setInterval(() => {
    if (!dragging && audio.duration) $('#seek').value = Math.round(1000 * audio.currentTime / audio.duration);
    $('#tCur').textContent = fmt(audio.currentTime);
    $('#btnPlay').textContent = audio.paused ? '▶' : '❚❚';
    highlight(false);
  }, 100);
  $('#btnPlay').addEventListener('click', () => { if (!song) return; if (audio.paused) play(); else audio.pause(); });
  $('#seek').addEventListener('input', () => { dragging = true; $('#tCur').textContent = fmt(audio.duration * $('#seek').value / 1000); });
  $('#seek').addEventListener('change', () => {
    dragging = false;
    if (!audio.duration) return;
    const t = audio.duration * $('#seek').value / 1000;
    if (E.active) jump(core.findLineAt(lines, t)); else seek(t);
  });

  // lyrics: tap a line to jump there (like Spotify)
  $('#lyrics').addEventListener('click', e => {
    const el = e.target.closest('.ly[data-i]');
    if (!el) return;
    const i = Number(el.dataset.i);
    if (E.active) jump(i);
    else { seek(Math.max(0, lines[i].start - core.LEAD_IN)); play(); E.line = i; renderPanel(); }
  });

  // panel buttons
  $('#panel').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const v = b.dataset.v, act = b.dataset.act;
    switch (act) {
      case 'mode': return setSetting({ mode: v });
      case 'reps': return setSetting({ reps: Number(v) });
      case 'speed': return setSetting({ speed: Number(v) });
      case 'treps': return setSetting({ trainingReps: Number(v) });
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
      case 'fixopen': return setSetting({ fixOpen: !settings.fixOpen });
      case 'nudge': return fix('nudge', b.dataset.f, Number(b.dataset.d));
      case 'now': return fix('now', b.dataset.f);
      case 'offset': return fix('offset', null, Number(b.dataset.d));
      case 'join': return fix('join');
      case 'split': return fix('split');
      case 'reset': return fix('reset');
      case 'autosync': return autoSync(false);
      case 'snap': return snapLines();
    }
  });
  $('#panel').addEventListener('change', e => { if (e.target.dataset.act === 'full') setSetting({ playFullAfter: e.target.checked }); });

  // file open
  $('#file').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) openSong(f, f.name);
    e.target.value = '';
  });

  // modals
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
    box.onclick = e => {
      const b = e.target.closest('.res');
      if (!b || b.disabled) return;
      const r = ranked[Number(b.dataset.ri)];
      if (setLyrics(r.syncedLyrics, `${r.trackName} — ${r.artistName}`, true)) $('#findModal').hidden = true;
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
  $('#btnPaste').addEventListener('click', () => {
    if (setLyrics($('#lrcText').value, 'pasted', true)) $('#findModal').hidden = true;
  });

  // library
  async function openLib() {
    $('#libModal').hidden = false;
    const box = $('#libList');
    let list = [];
    try { list = (await db.all()) || []; } catch (e) { /* storage blocked */ }
    list.sort((a, b) => b.added - a.added);
    box.innerHTML = list.length ? list.map((s, i) => `<div class="res" data-li="${i}"><span class="t">${esc(s.title || s.name)}<small>${esc(s.artist || '')}</small></span>
      <button class="btn small" data-del="${i}" title="Remove">🗑</button></div>`).join('')
      : '<div class="hint">Songs you open are saved here, so next time you don\'t need to pick the file again.</div>';
    box.onclick = async e => {
      const del = e.target.closest('[data-del]');
      if (del) { await db.del(list[Number(del.dataset.del)].key); return openLib(); }
      const row = e.target.closest('[data-li]');
      if (!row) return;
      const s = list[Number(row.dataset.li)];
      $('#libModal').hidden = true;
      openSong(s.blob, s.name, s.key);
    };
  }
  $('#btnLib').addEventListener('click', openLib);

  renderAll();
  window.__LT__ = { E, settings, get lines() { return lines; }, get baseLines() { return baseLines; }, get adj() { return adj; }, audio, parseLrc, bestOffset, analyze, openSong, guessMeta };
})();
