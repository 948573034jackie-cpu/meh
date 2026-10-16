/*
 * DJ Wave Looper: content script (the panel, loop engine, speed and trainer).
 *
 * Pieces:
 *   - Video tracking: finds YouTube's main <video> and the current video id.
 *   - Waveform: peaks arrive from src/inject.js (page world) and go into a
 *     PeakStore. "Scan" plays the song muted at high speed so YouTube downloads
 *     every part, then puts you back where you were.
 *   - Loop engine: jumps from B back to A, with an optional breath pause.
 *   - Speed: 50/75/100% presets, fine +/- and the auto speed-up trainer.
 *   - Panel UI: built with DOM calls only, because YouTube enforces Trusted
 *     Types and innerHTML would throw.
 */
(() => {
  'use strict';
  if (window.__ytlContent) return;
  window.__ytlContent = true;
  // The Chrome extension and the userscript build must not both run on a page.
  if (document.documentElement.hasAttribute('data-ytl-looper')) return;
  document.documentElement.setAttribute('data-ytl-looper', '1');

  const C = globalThis.YTLCore;
  const TAG = '__ytlooper__';
  const IS_MUSIC = location.hostname === 'music.youtube.com';
  const IS_MOBILE_SITE = location.hostname === 'm.youtube.com';
  const TOUCH = !!(window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches) || IS_MOBILE_SITE;
  // iPhone / iPad (iPadOS Safari says "Macintosh" but has a touch screen).
  const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const BIN_RATE = 50;
  const SPEED_PRESETS = [0.3, 0.5, 0.75, 1];
  const TRAINER_STARTS = [30, 50, 75];
  const TRAINER_GOAL = 100;
  const TRAINER_REPS = [10, 30, 50]; // plays from slow up to 100%...
  const TRAINER_DEFAULT_START = 30;
  const TRAINER_DEFAULT_REPS = 10;
  const TOUCH_NUDGE = 1; // seconds: the ‹ › buttons beside A and B on touch screens
  const TAP_MS = 350; // a touch on the wave shorter than this (without sliding) is a tap
  const DOUBLE_TAP_MS = 330; // two taps this close together = double tap (sets A, then B)
  const DOUBLE_TAP_PX = 40;
  // ...then this many more at 100% before it stops: 10 → 5, 30 → 10, 50 → 10.
  const trainerAfter = (reps) => (reps <= 10 ? 5 : 10);
  const GAPS = [0, 0.5, 1, 2, 3];
  const SCAN_RATE = 16;
  const WAVE_CACHE_MAX = 80;

  // ---------------------------------------------------------------------------
  // Storage (chrome.storage.local, safe after the extension reloads)
  // ---------------------------------------------------------------------------
  function alive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }
  const storage = globalThis.YTL_STORAGE || {
    get(keys) {
      return new Promise((resolve) => {
        if (!alive()) return resolve({});
        try {
          chrome.storage.local.get(keys, (r) => resolve(r || {}));
        } catch (e) {
          resolve({});
        }
      });
    },
    set(obj) {
      if (!alive()) return;
      try {
        chrome.storage.local.set(obj, () => void chrome.runtime.lastError);
      } catch (e) {
        /* ignore */
      }
    },
    remove(keys) {
      if (!alive()) return;
      try {
        chrome.storage.local.remove(keys, () => void chrome.runtime.lastError);
      } catch (e) {
        /* ignore */
      }
    },
  };

  const settings = {
    open: false,
    collapsed: false,
    height: 0,
    autoScan: true,
    keepPitch: true,
    gap: 0,
    trainerStart: 30,
    trainerReps: TRAINER_DEFAULT_REPS,
    trainerV: 4,
    lyrics: false,
    lyricsTop: null, // null = automatic: top of the screen on touch screens, beside the wave otherwise
    lyricsFont: 0, // 0 = automatic size
    lyricsH: 0, // height of the top lyrics area as a fraction of the screen; 0 = fill the space above the panel
    seenHelp: false,
    zoomFocus: false, // "Zoom in": the wave follows the playhead in a short window
    hqAudio: !IS_IOS, // studio-quality slow-down (Signalsmith Stretch); off on iPhone/iPad, where Safari can freeze it
    hqV: 1,
    tapVideo: true, // touch screens: a tap on the video pauses / plays
    lineRest: 0, // Practice: seconds of rest between parts
    quantize: false, // Q: A and B snap to the beat
    mouseDJ: true, // computer: drag the wave like a record, click = play/pause, double-click = A then B
    waveStyle: TOUCH ? 'color' : 'drums', // 'drums': kick / snare / hi-hats stand out (3 bands)
    mixCalls: IS_IOS, // iPhone/iPad: keep playing during a voice call (Claude voice mode, FaceTime...)
    focusLen: 30,
  };
  function saveSettings() {
    storage.set({ 'ytl:settings': { ...settings } });
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const S = {
    gridBase: null, // beats found in this video's wave: { vid, g, hits }
    grid: null, // the beat grid in use (after ½ / 2× / move-the-1)
    gridAdj: { scale: 1, shift: 0 },
    cues: [null, null, null, null], // hot cues 1-4 (seconds)
    gridTried: 0,
    vid: null,
    mainVid: null,
    video: null,
    peaks: new C.PeakStore(BIN_RATE),
    orphan: null, // peaks that arrived for a video we haven't switched to yet
    a: null,
    b: null,
    pendingA: null, // first click done, waiting for the end click
    loopOn: false,
    reps: 0,
    rate: 1,
    rateOwned: false, // true once the user picked a speed in our panel
    trainer: { running: false, rep: 1, reps: 10, after: 10, start: 0.5, goal: 1, done: false },
    saved: [],
    history: [],
    scan: null,
    scannedVids: new Set(),
    noHook: false,
    live: null,
    view: null, // {s, e} in seconds while zoomed, null = whole song
    lastViewTouch: 0,
    lastYTUserAction: 0,
    gapTimer: 0,
    wrapTimer: 0,
    wrapping: false,
    lastWrapAt: 0,
    adWas: false,
    lineLoop: null, // { a, b, idx }: one lyric line repeating
    meta: { vid: null, title: '', author: '' },
    hintOverride: null,
    hintUntil: 0,
    dirty: true,
    loadToken: 0,
  };

  // ---------------------------------------------------------------------------
  // Video and player helpers
  // ---------------------------------------------------------------------------
  function player() {
    return document.getElementById('movie_player') || document.querySelector('#player-container-id .html5-video-player');
  }

  function findVideo() {
    const p = player();
    return (p && p.querySelector('video')) || document.querySelector('#player-container-id video') || null;
  }

  function isAd() {
    const p = player();
    return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
  }

  function urlVid() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v');
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function currentVid() {
    return S.mainVid || urlVid();
  }

  function dur() {
    const v = S.video;
    return v && isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  }

  function now() {
    return performance.now();
  }

  function miniplayerActive() {
    const app = document.querySelector('ytd-app');
    return !!app && (app.hasAttribute('miniplayer-is-active') || app.hasAttribute('miniplayer-active'));
  }

  function onWatchSurface() {
    return IS_MUSIC || location.pathname === '/watch' || miniplayerActive();
  }

  function attachVideo(v) {
    if (S.video === v) return;
    if (S.video) {
      for (const [ev, fn] of videoListeners) S.video.removeEventListener(ev, fn);
    }
    S.video = v;
    if (v) {
      for (const [ev, fn] of videoListeners) v.addEventListener(ev, fn);
      S.peaks.setDuration(dur());
      applyRate();
    }
    S.dirty = true;
  }

  const videoListeners = [
    ['ratechange', onRateChange],
    ['ratechange', () => updateHQ()],
    ['ended', onEnded],
    ['play', onPlay],
    ['play', () => {
      if (HQ.src) hqCheckSound();
    }],
    ['durationchange', () => {
      S.peaks.setDuration(dur());
      S.dirty = true;
      renderUI();
    }],
    ['loadedmetadata', () => {
      applyRate();
      S.peaks.setDuration(dur());
      S.dirty = true;
      renderUI();
    }],
    ['playing', () => applyRate()],
    ['pause', () => renderUI()],
    ['seeked', () => (S.dirty = true)],
  ];

  // ---------------------------------------------------------------------------
  // Messages from the page-world tap (src/inject.js)
  // ---------------------------------------------------------------------------
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== true) return;
    const m = e.data;
    if (m.type === 'video') {
      S.mainVid = m.vid || null;
      S.meta = { vid: m.vid || null, title: m.title || '', author: m.author || '' };
      syncVideo();
    } else if (m.type === 'peaks') {
      onPeaks(m);
    }
  });

  function postToPage(msg) {
    msg[TAG] = 'cs';
    try {
      window.postMessage(msg, location.origin);
    } catch (e) {
      /* opaque origin (about:blank etc.): nothing to talk to */
    }
  }

  function onPeaks(m) {
    if (!m.vid || !(m.peak instanceof Uint8Array)) return;
    if (m.vid !== S.vid) {
      if (!S.orphan || S.orphan.vid !== m.vid) S.orphan = { vid: m.vid, list: [] };
      if (S.orphan.list.length < 400) S.orphan.list.push(m);
      return;
    }
    S.peaks.add(m.startBin, m.peak, m.low, m.mid, m.high);
    S.dirty = true;
    saveWaveSoon();
  }

  // ---------------------------------------------------------------------------
  // Switching videos
  // ---------------------------------------------------------------------------
  function syncVideo() {
    const v = findVideo();
    if (v !== S.video) attachVideo(v);
    const vid = currentVid();
    if (vid !== S.vid) switchVideo(vid);
    const ad = isAd();
    if (S.adWas && !ad) applyRate(); // ad finished: put the user's speed back
    S.adWas = ad;
    updateVisibility();
    maybeAutoScan();
    maybeLoadLyrics();
  }

  function switchVideo(vid) {
    if (S.scan) endScan('switched');
    saveVideoStateNow();
    saveWaveNow();
    stopTrainer(true);
    clearTimeout(S.gapTimer);
    clearTimeout(S.wrapTimer);
    S.wrapping = false;
    stopLive();

    S.vid = vid;
    S.peaks = new C.PeakStore(BIN_RATE);
    S.peaks.setDuration(dur());
    S.a = S.b = S.pendingA = null;
    S.loopOn = false;
    S.reps = 0;
    S.saved = [];
    S.history = [];
    S.view = null;
    S.hintOverride = null;
    if (S.noHook) setTimeout(startLive, 1000);
    if (S.rateOwned || S.rate !== 1) {
      S.rate = 1;
      S.rateOwned = false;
      applyRate();
    }
    if (S.orphan && S.orphan.vid === vid) {
      for (const m of S.orphan.list) S.peaks.add(m.startBin, m.peak, m.low, m.mid, m.high);
    }
    S.orphan = null;
    resetLyrics();
    S.gridBase = null;
    S.grid = null;
    S.gridAdj = { scale: 1, shift: 0 };
    S.gridTried = 0;
    S.cues = [null, null, null, null];
    S.dirty = true;
    renderUI();
    if (vid) loadVideoData(vid);
  }

  async function loadVideoData(vid) {
    const token = ++S.loadToken;
    const r = await storage.get(['ytl:v:' + vid, 'ytl:w:' + vid]);
    if (token !== S.loadToken || S.vid !== vid) return;
    const w = r['ytl:w:' + vid];
    if (w && w.data) {
      try {
        S.peaks.merge(C.PeakStore.deserialize(w));
      } catch (e) {
        /* bad cache entry: ignore */
      }
    }
    const st = r['ytl:v:' + vid];
    if (st) {
      const num = Number.isFinite;
      if (Array.isArray(st.cues)) S.cues = [0, 1, 2, 3].map((i) => (Number.isFinite(st.cues[i]) ? st.cues[i] : null));
      if (st.gridAdj && [0.5, 1, 2].includes(st.gridAdj.scale)) {
        S.gridAdj = { scale: st.gridAdj.scale, shift: ((st.gridAdj.shift | 0) % 4 + 4) % 4 };
        applyGridAdj();
      }
      if (Array.isArray(st.saved)) S.saved = st.saved.filter((x) => x && num(x.a) && num(x.b) && x.b > x.a).slice(0, 30);
      if (num(st.a) && num(st.b) && st.b > st.a) {
        S.a = st.a;
        S.b = st.b;
        // A closed looper is "off": remember the loop but don't run it.
        S.loopOn = !!st.loopOn && settings.open;
      }
      if (settings.open && st.rateOwned && num(st.rate)) {
        S.rate = C.roundRate(st.rate);
        S.rateOwned = true;
        applyRate();
      }
    }
    S.dirty = true;
    renderUI();
    maybeAutoScan();
  }

  let videoStateTimer = 0;
  function saveVideoStateSoon() {
    clearTimeout(videoStateTimer);
    videoStateTimer = setTimeout(saveVideoStateNow, 600);
  }
  function saveVideoStateNow() {
    clearTimeout(videoStateTimer);
    if (!S.vid) return;
    const hasLoop = S.a != null && S.b != null;
    if (!hasLoop && !S.saved.length && !S.rateOwned && S.gridAdj.scale === 1 && !S.gridAdj.shift && !S.cues.some((c) => c != null)) {
      storage.remove('ytl:v:' + S.vid);
      return;
    }
    storage.set({
      ['ytl:v:' + S.vid]: {
        a: hasLoop ? S.a : null,
        b: hasLoop ? S.b : null,
        loopOn: S.loopOn,
        rate: S.rate,
        rateOwned: S.rateOwned,
        saved: S.saved,
        gridAdj: S.gridAdj.scale !== 1 || S.gridAdj.shift ? S.gridAdj : undefined,
        cues: S.cues.some((c) => c != null) ? S.cues : undefined,
        t: Date.now(),
      },
    });
  }

  let waveTimer = 0;
  let waveSaved = { peaks: null, version: -1 };
  function saveWaveSoon() {
    if (waveTimer) return;
    waveTimer = setTimeout(saveWaveNow, 4000);
  }
  async function saveWaveNow() {
    clearTimeout(waveTimer);
    waveTimer = 0;
    const vid = S.vid;
    const peaks = S.peaks;
    if (!vid || !peaks.n || (waveSaved.peaks === peaks && waveSaved.version === peaks.version)) return;
    if (peaks.coverage(dur() || peaks.n / BIN_RATE) < 0.02) return;
    waveSaved = { peaks, version: peaks.version };
    const key = 'ytl:w:' + vid;
    storage.set({ [key]: peaks.serialize() });
    const r = await storage.get('ytl:widx');
    const idx = r['ytl:widx'] || {};
    idx[vid] = Date.now();
    const ids = Object.keys(idx).sort((x, y) => idx[y] - idx[x]);
    const drop = ids.slice(WAVE_CACHE_MAX);
    for (const id of drop) delete idx[id];
    if (drop.length) storage.remove(drop.map((id) => 'ytl:w:' + id));
    storage.set({ 'ytl:widx': idx });
  }

  // ---------------------------------------------------------------------------
  // Speed
  // ---------------------------------------------------------------------------
  function applyRate() {
    const v = S.video;
    if (!v || S.scan || isAd()) return;
    try {
      if (Math.abs(v.playbackRate - S.rate) > 0.001) v.playbackRate = S.rate;
    } catch (e) {
      /* ignore */
    }
    updateHQ();
  }

  // ---------------------------------------------------------------------------
  // Studio-quality slow-down. The browser's own "keep pitch" stretch gets
  // grainy at 30-50%. Instead the video plays like a slowed-down tape (clean,
  // just lower), and Signalsmith Stretch (a professional time-stretch/pitch
  // engine, the same family of tech as DAW warping) shifts the pitch back up.
  // At 100% speed the audio goes straight through, untouched.
  // ---------------------------------------------------------------------------
  const HQ = { ctx: null, node: null, src: null, video: null, mode: 'off', semis: null, failed: false, loading: false, lag: 0, analyser: null };

  function setPitchFlag(v, keep) {
    try {
      if (v.preservesPitch !== keep) v.preservesPitch = keep;
      if ('webkitPreservesPitch' in v && v.webkitPreservesPitch !== keep) v.webkitPreservesPitch = keep;
    } catch (e) {
      /* ignore */
    }
  }

  // Called from taps/clicks in the panel: audio may only start after one.
  function hqGesture() {
    if (!settings.hqAudio || HQ.failed) return;
    if (HQ.ctx) {
      if (HQ.ctx.state !== 'running') HQ.ctx.resume().catch(() => {});
      return;
    }
    if (typeof SignalsmithStretch !== 'function' || !window.AudioContext || !window.AudioWorkletNode) {
      HQ.failed = true;
      return;
    }
    try {
      HQ.ctx = new AudioContext({ latencyHint: 'playback' });
    } catch (e) {
      HQ.failed = true;
      return;
    }
    HQ.ctx.addEventListener('statechange', () => {
      if (HQ.src && HQ.ctx.state !== 'running' && S.video && !S.video.paused) hqCheckSound();
      updateHQ();
    });
    // Any tap on the page counts as a gesture that may wake the sound up.
    for (const ev of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(ev, hqWake, true);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) hqWake();
    });
    HQ.loading = true;
    // eslint-disable-next-line no-undef
    SignalsmithStretch(HQ.ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
      .then(async (node) => {
        HQ.node = node;
        HQ.loading = false;
        await node.start();
        try {
          HQ.lag = (await node.latency()) || 0;
        } catch (e) {
          HQ.lag = 0;
        }
        HQ.analyser = HQ.ctx.createAnalyser();
        HQ.analyser.fftSize = 8192;
        node.connect(HQ.analyser);
        updateHQ();
      })
      .catch(() => {
        HQ.failed = true; // nothing was routed yet: the normal sound is untouched
        HQ.loading = false;
        updateHQ();
      });
  }

  // Once the video's sound runs through our engine it is silent while the
  // engine is suspended (Safari does that on pause, app switch, phone calls,
  // the microphone...). Wake it up whenever we can; a tap always can.
  function hqWake() {
    if (!HQ.ctx || !HQ.src || HQ.ctx.state === 'running' || HQ.ctx.state === 'closed') return;
    HQ.ctx.resume().catch(() => {});
  }

  function hqCheckSound() {
    hqWake();
    setTimeout(() => {
      const v = S.video;
      if (HQ.ctx && HQ.src && HQ.video === v && v && !v.paused && HQ.ctx.state !== 'running') {
        flash('No sound? Tap anywhere on the page to bring it back.', 6000);
      }
    }, 800);
  }

  function hqWanted(v) {
    const r = v.playbackRate;
    return settings.hqAudio && settings.keepPitch && !HQ.failed && !S.scan && !isAd() &&
      Math.abs(r - 1) > 0.001 && r >= 0.2 && r <= 2.5 && /^blob:/.test(v.currentSrc || v.src || '');
  }

  // Routes the video's sound: straight through, or through the stretch engine.
  function updateHQ() {
    const v = S.video;
    if (!v) return;
    const want = !!HQ.node && HQ.ctx.state === 'running' && hqWanted(v);
    if (want && HQ.video !== v) {
      try {
        const src = HQ.ctx.createMediaElementSource(v); // from now on this video's sound flows through our graph
        if (HQ.src) {
          try {
            HQ.src.disconnect(); // an old, replaced video element
            HQ.node.disconnect(HQ.ctx.destination);
          } catch (e) {
            /* not connected */
          }
        }
        HQ.src = src;
        HQ.video = v;
        HQ.mode = 'off'; // nothing is wired for this element yet
      } catch (e) {
        HQ.failed = true;
      }
    }
    const routed = !!HQ.src && HQ.video === v;
    const mode = routed ? (want && !HQ.failed ? 'stretch' : 'bypass') : 'off';
    if (routed && mode !== HQ.mode) {
      try {
        HQ.src.disconnect();
        HQ.node.disconnect(HQ.ctx.destination);
      } catch (e) {
        /* not connected yet */
      }
      if (mode === 'stretch') {
        HQ.src.connect(HQ.node);
        HQ.node.connect(HQ.ctx.destination);
      } else {
        HQ.src.connect(HQ.ctx.destination);
      }
    }
    HQ.mode = mode;
    if (mode === 'stretch') {
      const semis = Math.round(-12 * Math.log2(v.playbackRate) * 1000) / 1000;
      if (semis !== HQ.semis) {
        HQ.semis = semis;
        HQ.node.schedule({ semitones: semis, formantCompensation: false });
      }
      setPitchFlag(v, false); // tape-style input; the engine restores the pitch
    } else {
      HQ.semis = null;
      setPitchFlag(v, settings.keepPitch);
    }
    if (hostEl) {
      hostEl.dataset.hq = HQ.failed ? 'failed' : HQ.mode;
      if (document.documentElement.dataset.ytlDebug === '1') hostEl.dataset.hqHz = String(hqPeakHz());
    }
  }

  // Test/debug helper: the loudest frequency coming out of the engine.
  function hqPeakHz() {
    if (!HQ.analyser || HQ.mode !== 'stretch') return 0;
    const bins = new Float32Array(HQ.analyser.frequencyBinCount);
    HQ.analyser.getFloatFrequencyData(bins);
    let best = 0;
    for (let i = 1; i < bins.length; i++) if (bins[i] > bins[best]) best = i;
    return Math.round((best * HQ.ctx.sampleRate) / HQ.analyser.fftSize);
  }

  // How far the sound runs behind the playhead (seconds of song time).
  function audioLag() {
    return HQ.mode === 'stretch' && S.video ? HQ.lag * S.video.playbackRate : 0;
  }

  function setRate(r, fromTrainer) {
    if (!fromTrainer && S.lineLoop) {
      S.lineLoop.saved = null; // keep the speed you just picked
      stopLineLoop(true);
    }
    if (!fromTrainer && S.trainer.running) return trainerJumpTo(C.roundRate(r));
    S.rate = C.roundRate(r);
    S.rateOwned = true;
    applyRate();
    renderUI();
    saveVideoStateSoon();
  }

  function onRateChange() {
    const v = S.video;
    if (!v || S.scan || isAd()) return;
    const r = v.playbackRate;
    if (Math.abs(r - S.rate) < 0.001) return;
    const userChangedInYouTube = now() - S.lastYTUserAction < 1500;
    if (S.trainer.running || (S.rateOwned && !userChangedInYouTube)) {
      // YouTube reset the speed by itself; put ours back.
      setTimeout(applyRate, 0);
      return;
    }
    S.rate = C.roundRate(r);
    if (userChangedInYouTube) S.rateOwned = false;
    renderUI();
  }

  const YT_MENU_CLASSES = ['ytp-settings-menu', 'ytp-popup', 'ytp-panel', 'ytp-menuitem', 'ytp-speedslider'];
  // Remember when the user touches YouTube's own controls so we follow their
  // speed choice there instead of fighting it.
  document.addEventListener(
    'click',
    (e) => {
      for (const el of e.composedPath()) {
        if (el === hostEl) return;
        const cls = el && el.classList;
        if (cls && YT_MENU_CLASSES.some((c) => cls.contains(c))) {
          S.lastYTUserAction = now();
          return;
        }
        if (el && el.tagName === 'YTMUSIC-PLAYER-BAR') {
          S.lastYTUserAction = now();
          return;
        }
      }
    },
    true
  );

  // ---------------------------------------------------------------------------
  // Loop engine
  // ---------------------------------------------------------------------------
  function hasLoop() {
    return S.a != null && S.b != null;
  }

  // What is looping right now: a single lyric line (tapped ⟳) wins over the
  // A-B loop, which keeps waiting behind it.
  function loopRegion() {
    if (S.lineLoop) return S.lineLoop;
    if (S.loopOn && hasLoop() && S.pendingA == null) return { a: S.a, b: S.b };
    return null;
  }

  function loopActive() {
    return settings.open && !!loopRegion() && !!S.video && !S.scan && !isAd();
  }

  function effEnd() {
    const r = loopRegion();
    return C.loopEnd(r ? r.b : S.b, dur());
  }

  function loopStart() {
    const r = loopRegion();
    return r ? r.a : S.a;
  }

  function seek(t) {
    const v = S.video;
    if (!v) return;
    try {
      v.currentTime = Math.max(0, t);
    } catch (e) {
      /* ignore */
    }
    S.dirty = true;
  }

  function play() {
    const v = S.video;
    if (!v) return;
    try {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  function engineTick() {
    if (!loopActive() || S.wrapping) return;
    const v = S.video;
    if (v.paused || v.seeking) return;
    const t = v.currentTime;
    const end = effEnd();
    if (t >= end - 0.004 && t > loopStart()) {
      wrap();
      return;
    }
    // Fire a precise timer just before B instead of waiting for the next frame.
    const remain = (end - t) / Math.max(0.05, v.playbackRate);
    if (remain > 0 && remain < 0.12 && !S.wrapTimer) {
      S.wrapTimer = setTimeout(() => {
        S.wrapTimer = 0;
        if (loopActive() && !S.wrapping && !v.paused && v.currentTime >= effEnd() - 0.03 && v.currentTime > loopStart()) wrap();
      }, Math.max(0, remain * 1000 - 3));
    }
  }

  function wrap() {
    const v = S.video;
    clearTimeout(S.wrapTimer);
    S.wrapTimer = 0;
    if (now() - S.lastWrapAt < 60) return; // already wrapping this pass
    S.lastWrapAt = now();
    S.reps++;
    if (S.lineLoop) {
      const ll = S.lineLoop;
      if (ll.rep >= ll.ramp + ll.full) {
        finishLinePractice();
        return;
      }
      ll.rep++;
      S.rate = C.trainerRate(LINE_START, 1, ll.ramp, ll.rep);
      applyRate();
    }
    if (S.trainer.running && !S.lineLoop) {
      const tr = S.trainer;
      // Plays 1..reps speed up (the last one is at the goal speed), then
      // `after` more plays at the goal speed, then it stops at the loop start.
      if (tr.after > 0 && tr.rep >= tr.reps + tr.after) {
        finishTrainer();
        return;
      }
      tr.rep++;
      if (tr.rep > tr.reps && !tr.done) {
        tr.done = true;
        flash(tr.after > 0
          ? `Reached ${Math.round(tr.goal * 100)}%! Now ${tr.after} plays at full speed, then it stops.`
          : `Reached ${Math.round(tr.goal * 100)}%! Keeps looping at this speed.`, 6000);
      }
      S.rate = C.trainerRate(tr.start, tr.goal, tr.reps, tr.rep);
      applyRate();
    }
    const gap = settings.gap;
    if (gap > 0) {
      S.wrapping = true;
      try {
        v.pause();
      } catch (e) {
        /* ignore */
      }
      seek(loopStart());
      clearTimeout(S.gapTimer);
      S.gapTimer = setTimeout(() => {
        S.wrapping = false;
        if (S.video === v) play();
      }, gap * 1000);
    } else {
      seek(loopStart());
    }
    renderUI();
  }

  function onEnded() {
    // Backup: the loop ran to the very end (should be rare thanks to END_GUARD).
    if (loopActive()) {
      wrap();
      if (!settings.gap) play();
    }
  }

  // ---- Tap the video to pause / play (touch screens) ----
  // YouTube's own buttons, progress bar, menus and end cards keep working.
  const VIDEO_TAP_SKIP = 'button, a, input, select, textarea, [role="button"], [role="slider"], [role="menu"], ' +
    '.ytp-chrome-bottom, .ytp-chrome-top, .ytp-settings-menu, .ytp-popup, .ytp-ce-element, .ytp-ad-module, ' +
    '.ytp-cards-teaser, ytm-progress-bar, [class*="progress-bar"], .ytl-fab';
  const VT = { down: null, suppressClickUntil: 0 };

  function isVideoTap(e) {
    const v = S.video;
    if (!TOUCH || !settings.tapVideo || !settings.open || !v || S.scan || isAd() || e.pointerType === 'mouse') return false;
    const path = e.composedPath ? e.composedPath() : [];
    if (hostEl && path.includes(hostEl)) return false;
    for (const el of path) {
      if (el === document.body) break;
      if (el instanceof Element && el.matches(VIDEO_TAP_SKIP)) return false;
    }
    const r = v.getBoundingClientRect();
    return r.width > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  document.addEventListener('pointerdown', (e) => {
    VT.down = isVideoTap(e) ? { x: e.clientX, y: e.clientY, at: now(), id: e.pointerId } : null;
  }, true);
  document.addEventListener('pointercancel', () => (VT.down = null), true);
  document.addEventListener('pointerup', (e) => {
    const d = VT.down;
    VT.down = null;
    if (!d || e.pointerId !== d.id || now() - d.at > 450 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12 || !isVideoTap(e)) return;
    const v = S.video;
    const wantPaused = !v.paused;
    VT.suppressClickUntil = now() + 700;
    togglePlay();
    // If YouTube's own tap handling flipped it straight back, put it right.
    setTimeout(() => {
      if (S.video === v && v.paused !== wantPaused) {
        if (wantPaused) v.pause();
        else play();
      }
    }, 350);
  }, true);
  // The click that follows the tap belongs to us, not to YouTube's player.
  document.addEventListener('click', (e) => {
    if (now() < VT.suppressClickUntil && !(hostEl && e.composedPath().includes(hostEl))) {
      VT.suppressClickUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // ↺ 5s: hear the last few seconds again (plays). 5s ↻: skip ahead.
  const JUMP_SEC = 5;
  function jump(sec) {
    const v = S.video;
    if (!v || S.scan || !dur()) return;
    const from = v.currentTime;
    let t = C.clamp(from + sec, 0, Math.max(0, dur() - 0.1));
    const r = loopRegion();
    if (r && sec < 0 && from >= r.a - 0.01 && t < r.a) t = r.a; // inside a loop: back to its start, not out of it
    if (sec < 0) {
      if (S.wrapping) {
        clearTimeout(S.gapTimer);
        S.wrapping = false;
      }
      seek(t);
      play();
    } else userSeek(t);
    focusFollow(true);
    renderUI();
  }

  function togglePlay() {
    const v = S.video;
    if (!v || S.scan) return;
    if (v.paused) {
      if (S.wrapping) {
        clearTimeout(S.gapTimer);
        S.wrapping = false;
      }
      play();
    } else {
      try {
        v.pause();
      } catch (e) {
        /* ignore */
      }
    }
    renderUI();
  }

  function onPlay() {
    if (PR.on && PR.restUntil) {
      startPart(PR.pos); // pressed play during the rest: go now
      return;
    }
    if (S.wrapping) {
      // The user pressed play during the breath pause: just go.
      clearTimeout(S.gapTimer);
      S.wrapping = false;
    }
    applyRate();
    renderUI();
  }

  function pushHistory() {
    S.history.push({ a: S.a, b: S.b, loopOn: S.loopOn });
    if (S.history.length > 40) S.history.shift();
  }

  function setLoop(a, b, opts = {}) {
    const n = C.normalizeLoop(a, b, dur());
    if (!n) {
      flash('That loop is too short. Pick two points further apart.');
      return false;
    }
    if (!opts.noHistory) pushHistory();
    const isNew = !hasLoop() || opts.fresh;
    S.a = n.a;
    S.b = n.b;
    S.pendingA = null;
    S.loopOn = true;
    if (isNew) S.reps = 0;
    const v = S.video;
    if (v && !opts.noSeek) {
      const t = v.currentTime;
      if (t < S.a - 0.01 || t >= effEnd()) seek(S.a);
      if (opts.play && v.paused) play();
    }
    S.dirty = true;
    renderUI();
    saveVideoStateSoon();
    return true;
  }

  function clearLoop() {
    if (!hasLoop() && S.pendingA == null) return;
    pushHistory();
    S.a = S.b = S.pendingA = null;
    S.loopOn = false;
    S.reps = 0;
    stopTrainer();
    S.dirty = true;
    renderUI();
    saveVideoStateSoon();
  }

  function undo() {
    const h = S.history.pop();
    if (!h) return flash('Nothing to undo.');
    S.a = h.a;
    S.b = h.b;
    S.loopOn = h.loopOn;
    S.pendingA = null;
    S.dirty = true;
    renderUI();
    saveVideoStateSoon();
  }

  function toggleLoop() {
    if (!hasLoop()) return flash(`Set a loop first: ${TOUCH ? 'tap' : 'click'} the start and the end on the wave.`);
    S.loopOn = !S.loopOn;
    if (S.loopOn && S.video) {
      const t = S.video.currentTime;
      if (t < S.a - 0.01 || t >= effEnd()) seek(S.a);
    }
    S.dirty = true;
    renderUI();
    saveVideoStateSoon();
  }

  function nowTime() {
    return S.video ? S.video.currentTime : 0;
  }

  function markA() {
    const t = qT(nowTime());
    if (TOUCH) {
      // Touch, like a DJ app's loop in / loop out: A marks the start where the
      // playhead is, B marks the end. Stop, drag the wave to the spot, tap A;
      // drag on, tap B.
      if (hasLoop() && S.pendingA == null && t < S.b - C.MIN_LOOP) {
        setLoop(t, S.b, { play: true }); // A and B both set: play the loop
        return;
      }
      pushHistory();
      S.pendingA = t;
      S.dirty = true;
      renderUI();
      return;
    }
    if (S.b != null && t < S.b - C.MIN_LOOP) setLoop(t, S.b, { noSeek: true });
    else {
      S.pendingA = t;
      S.dirty = true;
      renderUI();
    }
  }

  function markB() {
    const t = qT(nowTime());
    if (TOUCH) {
      const a = S.pendingA != null ? S.pendingA : S.a;
      if (a == null) return flash('Tap A first, where the loop should start.');
      if (Math.abs(t - a) < C.MIN_LOOP) return flash('Move further from A, then tap B.');
      setLoop(a, t, { fresh: S.pendingA != null, noHistory: S.pendingA != null, play: true }); // loop chosen: play it from A
      return;
    }
    const a = S.pendingA != null ? S.pendingA : S.a;
    if (a == null) return flash('Set the start first: press [ or click the A button.');
    setLoop(a, t, { fresh: S.pendingA != null });
  }

  // ---------------------------------------------------------------------------
  // Beats: the grid (1 2 3 4), quantize, DJ beat loops
  // ---------------------------------------------------------------------------
  const BEAT_LOOPS = [1, 2, 4, 8, 16];

  // Works out the beats once the whole wave has been read.
  function maybeComputeGrid() {
    const d = dur();
    if (!S.vid || !d || (S.gridBase && S.gridBase.vid === S.vid) || S.scan) return;
    if (S.peaks.coverage(d) < 0.9 || now() - S.gridTried < 3000) return;
    S.gridTried = now();
    let g = null;
    let hits = [];
    try {
      g = C.beatGrid(S.peaks, d);
      hits = C.drumHits(S.peaks, d);
    } catch (e) {
      g = null;
    }
    S.gridBase = { vid: S.vid, g, hits };
    applyGridAdj();
    if (settings.quantize && hasLoop() && S.pendingA == null && S.grid) setLoop(qT(S.a), qT(S.b), { noHistory: true, noSeek: true });
    layers.key = '';
    S.dirty = true;
    renderUI();
  }

  // ½ / 2× tempo and "move the 1" on top of what was found.
  function applyGridAdj() {
    const base = S.gridBase && S.gridBase.g;
    if (!base) {
      S.grid = null;
      return;
    }
    let beats = base.beats.slice();
    let first = base.first;
    const sc = S.gridAdj.scale;
    if (sc === 2) {
      const out = [];
      beats.forEach((b, i) => {
        out.push(b);
        if (i + 1 < beats.length) out.push((b + beats[i + 1]) / 2);
      });
      beats = out;
      first *= 2;
    } else if (sc === 0.5) {
      const start = first % 2;
      beats = beats.filter((_, i) => i % 2 === start);
      first = (first - start) / 2;
    }
    first = (first + S.gridAdj.shift) % 4;
    S.grid = { bpm: Math.round(base.bpm * sc * 10) / 10, beats, first };
  }

  function adjustGrid(kind) {
    if (!S.gridBase || !S.gridBase.g) return flash(gridMissingText());
    const a = S.gridAdj;
    if (kind === 'half') a.scale = a.scale === 2 ? 1 : 0.5;
    else if (kind === 'double') a.scale = a.scale === 0.5 ? 1 : 2;
    else if (kind === 'shift') a.shift = (a.shift + 1) % 4;
    applyGridAdj();
    if (settings.quantize && hasLoop() && S.pendingA == null) setLoop(qT(S.a), qT(S.b), { noHistory: true, noSeek: true });
    S.dirty = true;
    renderUI();
    saveVideoStateSoon();
    if (kind === 'shift') flash('The "1" moved one beat later.', 2500);
    else flash(`Tempo: ${S.grid.bpm} BPM.`, 2500);
  }

  function gridMissingText() {
    if (!dur() || S.peaks.coverage(dur()) < 0.9) return 'Reading the beats… (the whole song needs to be read first)';
    return 'No steady beat found in this song.';
  }

  // Quantize: a time moved onto the nearest beat (when Q is on).
  function qT(t) {
    if (!settings.quantize || !S.grid || t == null) return t;
    const B = S.grid.beats;
    const k = C.nearestBeatIndex(B, t);
    // Before the first / after the last beat the grid goes on at the same tempo.
    const per = 60 / S.grid.bpm;
    if (t < B[0] - per / 2) return Math.max(0, C.beatTime(B, Math.round((t - B[0]) / per)));
    if (t > B[B.length - 1] + per / 2) return Math.min(dur(), C.beatTime(B, B.length - 1 + Math.round((t - B[B.length - 1]) / per)));
    return B[k];
  }

  function toggleQuantize() {
    settings.quantize = !settings.quantize;
    saveSettings();
    if (settings.quantize && !S.grid) flash(gridMissingText(), 4000);
    else if (settings.quantize && hasLoop() && S.pendingA == null) setLoop(qT(S.a), qT(S.b), { noHistory: true, noSeek: true });
    else if (settings.quantize && S.pendingA != null) S.pendingA = qT(S.pendingA);
    S.dirty = true;
    renderUI();
  }

  // DJ beat loop: n beats from the beat you are on. With a loop already
  // running on the grid, it keeps the start and changes the length.
  function beatLoop(n) {
    const G = S.grid;
    const v = S.video;
    if (!G || !v) return flash(gridMissingText());
    const B = G.beats;
    let ia;
    const onGrid = (x) => Math.abs(B[C.nearestBeatIndex(B, x)] - x) < 0.03;
    const keep = hasLoop() && S.loopOn && S.pendingA == null && onGrid(S.a);
    if (keep) ia = C.nearestBeatIndex(B, S.a);
    else {
      const t = v.currentTime;
      ia = C.nearestBeatIndex(B, t);
      if (B[ia] > t + 0.05) ia--; // the beat you are on, not the next one
      ia = Math.max(0, ia);
    }
    const a = C.beatTime(B, ia);
    const b = Math.min(dur(), C.beatTime(B, ia + n));
    if (stopLineIfAny()) {
      /* line practice gives way to the beat loop */
    }
    if (setLoop(a, b, { play: true, fresh: !keep })) flash(`Loop: ${n} beat${n > 1 ? 's' : ''}.`, 1500);
  }

  function stopLineIfAny() {
    if (S.lineLoop || PR.on) {
      stopLineLoop(true);
      return true;
    }
    return false;
  }

  // Beats in the current loop (when it sits on the grid), for the buttons.
  function loopBeats() {
    const G = S.grid;
    if (!G || !hasLoop() || S.pendingA != null) return 0;
    const B = G.beats;
    const ia = C.nearestBeatIndex(B, S.a);
    const ib = C.nearestBeatIndex(B, S.b);
    const ok = (x, i) => Math.abs(C.beatTime(B, i) - x) < 0.03;
    if (ok(S.a, ia) && ok(S.b, ib)) return ib - ia;
    // B past the last beat: count on at the same tempo.
    const per = 60 / G.bpm;
    const n = Math.round((S.b - S.a) / per);
    return ok(S.a, ia) && Math.abs(C.beatTime(B, ia + n) - S.b) < 0.03 ? n : 0;
  }

  // Hot cues 1-4, like a DJ controller: click an empty pad to mark the spot
  // (on the beat with Q), click it again to jump there and play.
  // Shift-click or right-click clears it.
  const CUE_COLORS = ['#ff4d6d', '#ffb000', '#3ddc84', '#4da3ff'];
  function cueTap(i, e) {
    const v = S.video;
    if (!v || !dur()) return;
    if (e && (e.shiftKey || e.type === 'contextmenu')) {
      if (e.type === 'contextmenu') e.preventDefault();
      S.cues[i] = null;
      flash(`Cue ${i + 1} cleared.`, 1500);
    } else if (S.cues[i] == null) {
      S.cues[i] = qT(v.currentTime);
      flash(`Cue ${i + 1} set at ${C.formatTime(S.cues[i])}. Click it to jump back here.`, 2500);
    } else {
      userSeek(S.cues[i]);
      play();
    }
    S.dirty = true;
    renderUI();
    saveVideoStateSoon();
  }

  function toggleDrumView() {
    settings.waveStyle = settings.waveStyle === 'drums' ? 'color' : 'drums';
    saveSettings();
    layers.key = '';
    S.dirty = true;
    renderUI();
  }

  function nudge(which, delta) {
    if (!hasLoop()) return;
    if (settings.quantize && S.grid) {
      // With Q on, ‹ › move by one beat.
      const B = S.grid.beats;
      const cur = which === 'a' ? S.a : S.b;
      const i = C.nearestBeatIndex(B, cur) + (delta > 0 ? 1 : -1);
      delta = C.beatTime(B, i) - cur;
    }
    const a = which === 'a' ? S.a + delta : S.a;
    const b = which === 'b' ? S.b + delta : S.b;
    if (b - a < C.MIN_LOOP) return flash(`Can't move it that far: A would pass B. Move the other point first.`);
    setLoop(a, b, { noSeek: which === 'b' });
    if (which === 'a' && S.video && S.loopOn) seek(S.a); // hear the new start right away
  }

  // ---------------------------------------------------------------------------
  // Auto speed-up trainer
  // ---------------------------------------------------------------------------
  // fromChoice: restarted because a choice changed. Otherwise (the Trainer
  // button) every start begins at 30% over 50 loops.
  function startTrainer(fromChoice) {
    if (!S.video || !dur()) return flash('Start a video first.');
    if (!fromChoice) {
      settings.trainerStart = TRAINER_DEFAULT_START;
      settings.trainerReps = TRAINER_DEFAULT_REPS;
      ui.tStart.value = String(settings.trainerStart);
      ui.tReps.value = String(settings.trainerReps);
      saveSettings();
    }
    if (!hasLoop()) {
      // No loop yet: practise the whole song.
      S.a = 0;
      S.b = dur();
      S.pendingA = null;
    }
    const tr = S.trainer;
    tr.start = settings.trainerStart / 100;
    tr.goal = TRAINER_GOAL / 100;
    tr.reps = settings.trainerReps;
    tr.after = trainerAfter(tr.reps);
    tr.rep = 1;
    tr.done = false;
    tr.running = true;
    ui.trainerRow.hidden = false;
    applyLayout();
    S.loopOn = true;
    S.reps = 0;
    S.rate = C.trainerRate(tr.start, tr.goal, tr.reps, 1);
    S.rateOwned = true;
    applyRate();
    seek(S.a);
    play();
    S.dirty = true;
    renderUI();
  }

  function finishTrainer() {
    const tr = S.trainer;
    tr.running = false;
    try {
      S.video.pause();
    } catch (e) {
      /* ignore */
    }
    seek(S.a);
    flash(`Training done! ${tr.after} times at ${Math.round(tr.goal * 100)}%. Press play to go again.`, 10000);
    renderUI();
  }

  // Picking a speed while training moves the trainer to the loop that plays
  // at that speed, so a slower pick gives you those loops again:
  //   loop for speed r = 1 + (r - start) / (100% - start) × (loops - 1)
  // e.g. 30% → 100% over 50 loops: 50% is loop 15 (36 loops to go), 75% is
  // loop 33. Slower than the start (e.g. 30% when it began at 50%) starts the
  // climb again from that speed with all the loops.
  function trainerJumpTo(r) {
    const tr = S.trainer;
    if (r < tr.start - 0.001) {
      tr.start = r;
      tr.rep = 1;
      const pct = Math.round(r * 100);
      if (TRAINER_STARTS.includes(pct)) {
        // Keep the box and the setting in step, so changing "loops" later keeps this start.
        settings.trainerStart = pct;
        ui.tStart.value = String(pct);
        saveSettings();
      }
    } else {
      tr.rep = C.trainerRepFor(tr.start, tr.goal, tr.reps, r);
    }
    tr.done = tr.rep > tr.reps;
    S.rate = C.trainerRate(tr.start, tr.goal, tr.reps, tr.rep);
    S.rateOwned = true;
    applyRate();
    const toGoal = tr.reps - tr.rep;
    flash(toGoal > 0
      ? `Trainer at ${Math.round(S.rate * 100)}%: ${toGoal} more loop${toGoal === 1 ? '' : 's'} to 100%, then ${tr.after} at 100%.`
      : `Trainer at 100%: ${tr.after} plays at full speed, then it stops.`, 5000);
    renderUI();
    saveVideoStateSoon();
  }

  // The Trainer button: one tap starts it, the next tap stops it and puts the
  // song back to normal speed.
  function toggleTrainer() {
    if (S.trainer.running) {
      stopTrainer(true);
      S.rate = 1;
      S.rateOwned = false;
      applyRate();
      ui.trainerRow.hidden = true;
      applyLayout();
      saveVideoStateSoon();
      flash('Trainer off. Back to normal speed.');
      renderUI();
    } else {
      startTrainer(false);
    }
  }

  function stopTrainer(silent) {
    if (!S.trainer.running) return;
    S.trainer.running = false;
    if (!silent) renderUI();
  }

  // ---------------------------------------------------------------------------
  // Lyrics: looked up by song name on LRCLIB (a free, open lyrics database) and
  // shown next to the wave. Time-stamped lyrics follow the song, and tapping a
  // line jumps there.
  // ---------------------------------------------------------------------------
  const LYRICS_API = 'https://lrclib.net/api/search';
  const LYRICS_PHONE_H = 170;
  const LYRICS_NUDGE = 0.1; // seconds per tap on ◀ ▶ (lyrics timing)
  // One-line practice (tap the left of a lyric line) and Practice (every part
  // of the song): speed up from 30% to 100% with the Trainer's counts
  // (10 / 30 / 50 plays), then 5 or 10 plays at 100%.
  const LINE_START = 0.3;
  const PART_RESTS = [0, 10, 20, 30, 40]; // Practice: rest between parts (s)
  const L = { vid: null, token: 0, results: [], idx: 0, lines: null, raw: null, fine: null, plain: null, synced: false, nowIdx: -2, userScrollAt: 0,
    offset: 0, offsetSet: false, autoPending: false, mismatch: false, savedQ: '', abStart: null, abKey: '', secNames: [], sections: [] };
  // Chords for the current video: the pasted sheet, how it sits on the lyric
  // lines, and the transpose amount.
  const CH = { vid: null, text: '', map: null, sheetOnly: null, transpose: 0, flats: false, all: [] };

  function songMeta() {
    const fromTap = S.meta && S.meta.vid === S.vid ? S.meta : null;
    const title = (fromTap && fromTap.title) || document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube( Music)?$/, '');
    let author = (fromTap && fromTap.author) || '';
    if (!author) {
      const el = document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a, .slim-owner-channel-name');
      author = el ? el.textContent.trim() : '';
    }
    return { title: title.trim(), author };
  }

  function buildLyrics() {
    ui.lyrInput = h('input', { type: 'search', placeholder: 'Song name – artist', 'aria-label': 'Search lyrics', enterkeyhint: 'search' });
    ui.lyrInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = ui.lyrInput.value.trim();
        if (q) findLyrics(q);
        ui.lyrInput.blur();
      }
    });
    ui.lyrNext = btn(null, 'Wrong song? Show the next match', nextLyrics, 'icon', 'next');
    const findBtn = btn(null, 'Search lyrics', () => {
      const q = ui.lyrInput.value.trim();
      findLyrics(q || null);
    }, 'icon', 'search');
    ui.lyrMeta = h('div', { class: 'lyr-meta' });
    ui.lyrOffset = h('span', { class: 'lyr-off' });
    ui.keyLabel = h('span', { class: 'lyr-off key-label' });
    ui.keyBox = h('span', { class: 'key-box', hidden: true },
      btn('♭', 'Transpose the chords down a semitone', () => transposeChords(-1), 'lyr-nudge'),
      ui.keyLabel,
      btn('♯', 'Transpose the chords up a semitone', () => transposeChords(1), 'lyr-nudge'));
    ui.lyrSync = h('div', { class: 'lyr-sync', hidden: true },
      btn('◀ 0.1s', 'Lyrics are late: show them earlier', () => nudgeLyrics(-LYRICS_NUDGE), 'lyr-nudge'),
      ui.lyrOffset,
      btn('0.1s ▶', 'Lyrics are early: show them later', () => nudgeLyrics(LYRICS_NUDGE), 'lyr-nudge'),
      btn('Auto', 'Line the lyrics up again automatically', () => {
        L.offsetSet = false;
        L.offset = 0;
        resetFine();
        L.autoPending = true;
        saveLyricsChoice();
        renderLyricsSync();
      }, 'lyr-nudge'),
      ui.keyBox);
    // Chords: find them on Ultimate Guitar, copy, come back and paste.
    ui.chordText = h('textarea', { class: 'chord-text', rows: '5', placeholder: 'Paste the chords here (copied from Ultimate Guitar or any chord site, or ChordPro like [Am]words)', 'aria-label': 'Chords' });
    ui.chordPanel = h('div', { class: 'chord-panel', hidden: true },
      h('div', { class: 'chord-title', text: 'Chords' }),
      h('div', { class: 'chord-steps', text: '1. Find the song on Ultimate Guitar  2. Select all, Copy  3. Come back and tap Paste' }),
      h('div', { class: 'chord-btns' },
        btn('Find on Ultimate Guitar', 'Open the chords search for this song in a new tab', findChordsOnline, 'primary', 'search'),
        btn('Paste', 'Paste the chords you copied', pasteChords, '', 'paste'),
        btn('Use these', 'Put these chords on the lyrics', () => applyChords(ui.chordText.value, { save: true }), ''),
        btn('Remove', 'Remove the chords from this song', removeChords, 'danger'),
        // Close sits away from where the Chords button was, so the tap that
        // opened the panel can never land on it.
        btn('Close', 'Close the chords panel', toggleChordPanel, '')),
      ui.chordText);
    ui.chordBtn = btn('Chords', 'Chords over the lyrics (from Ultimate Guitar or any chord site)', toggleChordPanel, 'chord-btn');
    ui.practiceBtn = btn('Practice', 'Practise the whole song part by part (verse, chorus…): each part from 30% up to 100%, then at full speed, then the next part; at the end the whole song once. Tap again to stop.', togglePractice, 'practice-btn', 'bolt');
    ui.lyrBody = h('div', { class: 'lyr-body' });
    const touched = () => (L.userScrollAt = now());
    ui.lyrBody.addEventListener('wheel', touched, { passive: true });
    ui.lyrBody.addEventListener('touchmove', touched, { passive: true });
    const smaller = btn('A−', 'Smaller lyrics text', () => setLyricsFont(-1), 'icon lyr-size');
    const bigger = btn('A+', 'Bigger lyrics text', () => setLyricsFont(1), 'icon lyr-size');
    ui.lyrPlace = btn(null, 'Move the lyrics to the top of the screen', () => {
      settings.lyricsTop = !lyricsOnTop();
      saveSettings();
      applyLayout();
      renderUI();
    }, 'icon', 'place');
    const hide = btn(null, 'Hide the lyrics', toggleLyrics, 'icon', 'close');
    const grip = h('div', { class: 'lyr-resize', title: 'Drag to make the lyrics area taller or shorter' });
    setupLyricsResize(grip);
    return h('div', { class: 'lyrics', hidden: true },
      h('div', { class: 'lyr-head' }, ui.lyrInput, findBtn, ui.lyrNext, ui.chordBtn, smaller, bigger, ui.lyrPlace, hide, ui.practiceBtn),
      ui.lyrMeta, ui.lyrSync, ui.chordPanel, ui.lyrBody, grip);
  }

  function lyricsOnTop() {
    return settings.lyricsTop == null ? TOUCH : !!settings.lyricsTop;
  }

  function lyricsFontPx() {
    if (settings.lyricsFont) return settings.lyricsFont;
    if (lyricsOnTop()) return window.innerWidth < 600 ? 24 : 32;
    return TOUCH ? 17 : 15;
  }

  function setLyricsFont(dir) {
    settings.lyricsFont = Math.round(C.clamp(lyricsFontPx() + dir * (lyricsFontPx() >= 30 ? 4 : 2), 12, 72));
    saveSettings();
    layoutLyrics();
    L.nowIdx = -2; // re-centre the current line at the new size
  }

  // Sizes the lyrics: text size everywhere, and on top of the screen a tall
  // area (45% by default) that never runs into the panel at the bottom.
  function layoutLyrics() {
    if (!ui.lyrics) return;
    const top = settings.lyrics && lyricsOnTop();
    ui.lyrics.classList.toggle('top', top);
    ui.lyrBody.style.setProperty('--lyr-font', lyricsFontPx() + 'px');
    ui.lyrPlace.title = top ? 'Put the lyrics beside the wave' : 'Move the lyrics to the top of the screen';
    if (top) {
      const vh = window.innerHeight;
      const room = vh - (hostVisible() ? panelHeight() : 0);
      // Default: fill everything above the panel (about half the screen).
      const want = settings.lyricsH ? vh * settings.lyricsH : room;
      ui.lyrics.style.height = Math.round(Math.max(120, Math.min(want, room))) + 'px';
    } else {
      ui.lyrics.style.height = '';
    }
  }

  function setupLyricsResize(grip) {
    let startY = 0;
    let startH = 0;
    grip.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      startH = ui.lyrics.getBoundingClientRect().height;
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return;
      settings.lyricsH = C.clamp((startH + (e.clientY - startY)) / window.innerHeight, 0.15, 0.85);
      layoutLyrics();
    });
    grip.addEventListener('pointerup', (e) => {
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      saveSettings();
    });
  }

  function toggleLyrics() {
    settings.lyrics = !settings.lyrics;
    saveSettings();
    if (settings.collapsed && settings.lyrics) toggleCollapse();
    applyLayout();
    renderUI();
    maybeLoadLyrics();
  }

  function resetLyrics() {
    stopLineLoop(true);
    L.token++;
    L.vid = null;
    L.results = [];
    L.idx = 0;
    L.lines = null;
    L.synced = false;
    L.nowIdx = -2;
    L.offset = 0;
    L.offsetSet = false;
    L.autoPending = false;
    if (ui.lyrBody) {
      renderLyricsSync();
      ui.lyrBody.replaceChildren();
      ui.lyrMeta.textContent = '';
      ui.lyrInput.value = '';
    }
  }

  // Load lyrics for the current video once the pane is open and we know the title.
  function maybeLoadLyrics() {
    if (!settings.lyrics || !S.vid || L.vid === S.vid || !hostVisible()) return;
    const meta = songMeta();
    if (!meta.title) return;
    L.vid = S.vid;
    const vid = S.vid;
    const token = ++L.token;
    storage.get('ytl:lyr:' + vid).then((r) => {
      if (token !== L.token || S.vid !== vid) return;
      const saved = r['ytl:lyr:' + vid];
      if (saved && saved.r) {
        L.results = [saved.r];
        L.idx = 0;
        ui.lyrInput.value = saved.q || '';
        showLyrics(0, false);
        if (Number.isFinite(saved.offset)) {
          L.offset = saved.offset;
          L.offsetSet = !!saved.offsetSet;
          L.autoPending = !L.offsetSet && L.autoPending && !saved.fine;
          if (saved.fine) setFine(saved.fine);
          renderLyricsSync();
        }
      } else {
        findLyrics(null);
      }
    });
  }

  function lyricsMessage(text) {
    ui.lyrMeta.textContent = '';
    ui.lyrBody.classList.remove('synced');
    ui.lyrBody.replaceChildren(h('div', { class: 'lyr-msg', text }));
  }

  async function lyricsFetch(params) {
    const url = LYRICS_API + '?' + new URLSearchParams(params).toString();
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      // Chrome extension: the background worker can fetch without page limits.
      if (!alive()) throw e;
      return new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage({ type: 'ytl-fetch-json', url }, (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok) reject(new Error('fetch failed'));
            else resolve(resp.data);
          });
        } catch (err) {
          reject(err);
        }
      });
    }
  }

  async function findLyrics(manual) {
    const vid = S.vid;
    if (!vid) return;
    L.vid = vid;
    const token = ++L.token;
    lyricsMessage('Looking for the lyrics…');
    const meta = songMeta();
    const guess = manual ? C.parseSongTitle(manual, '') : C.parseSongTitle(meta.title, meta.author);
    const tries = [];
    const add = (p) => {
      const key = JSON.stringify(p);
      if (Object.values(p).every(Boolean) && !tries.some((t) => JSON.stringify(t) === key)) tries.push(p);
    };
    if (manual) add({ q: manual });
    if (guess.artist && guess.track) {
      add({ track_name: guess.track, artist_name: guess.artist });
      add({ track_name: guess.artist, artist_name: guess.track });
    }
    for (const alt of guess.alts || []) add({ track_name: alt.track, artist_name: alt.artist });
    add({ q: [guess.artist, guess.track].filter(Boolean).join(' ') });
    for (const alt of guess.alts || []) add({ q: `${alt.artist} ${alt.track}` });
    if (!manual) add({ q: meta.title.replace(/[(\[【][^)\]】]*[)\]】]/g, ' ').replace(/\s+/g, ' ').trim() });
    const found = new Map();
    let failures = 0;
    let ranked = [];
    for (const p of tries) {
      try {
        const res = await lyricsFetch(p);
        if (token !== L.token) return;
        for (const r of Array.isArray(res) ? res : []) if (r && r.id != null && !found.has(r.id)) found.set(r.id, r);
      } catch (e) {
        if (token !== L.token) return;
        failures++;
      }
      ranked = C.rankLyrics([...found.values()], guess, dur());
      const top = ranked[0];
      const names = [guess, ...(guess.alts || [])];
      if (top && names.some((g) => Math.max(C.similarity(g.track, top.trackName), C.similarity(g.artist, top.trackName)) >= 0.99)) break;
    }
    if (token !== L.token) return;
    L.results = ranked;
    L.idx = 0;
    if (!ranked.length) {
      lyricsMessage(failures === tries.length
        ? 'Could not reach the lyrics service. Check your internet and press the search button.'
        : 'No lyrics found. Type the song name and artist above and press Enter.');
      return;
    }
    if (manual) ui.lyrInput.value = manual;
    showLyrics(0, true);
  }

  function nextLyrics() {
    if (L.results.length < 2) {
      if (!L.results.length) return findLyrics(ui.lyrInput.value.trim() || null);
      return flash('No other matches. Type the song name and artist in the box above the lyrics.');
    }
    showLyrics((L.idx + 1) % L.results.length, true);
  }

  function showLyrics(i, save) {
    const r = L.results[i];
    if (!r) return;
    L.idx = i;
    const lines = r.syncedLyrics ? C.parseLrc(r.syncedLyrics) : null;
    L.raw = lines && lines.length ? lines : null;
    L.lines = L.raw;
    L.fine = null;
    L.plain = L.raw ? null : String(r.plainLyrics || '').split(/\r?\n/);
    const d = dur();
    // Time-stamped lyrics always follow the song. Versions that differ from the
    // original (a cappella uploads, edits) are lined up by an offset: found
    // automatically from where the singing starts, or nudged with ◀ ▶.
    L.synced = !!L.lines;
    L.mismatch = !!L.lines && !!d && !!r.duration && Math.abs(r.duration - d) > 3;
    L.offset = 0;
    L.offsetSet = false;
    L.autoPending = !!L.lines && (C.isVocalOnlyTitle(songMeta().title) || L.mismatch);
    L.nowIdx = -2;
    const more = L.results.length > 1 ? ` · match ${i + 1} of ${L.results.length}` : '';
    const how = L.lines ? ' · follows the song' : ' · no timings for these lyrics';
    ui.lyrMeta.textContent = `${r.trackName || '?'} — ${r.artistName || '?'}${how}${more}`;
    ui.lyrMeta.title = ui.lyrMeta.textContent;
    renderLyricsSync();
    renderLyricLines();
    stopLineLoop(true); // the lines changed
    ui.lyrBody.scrollTop = 0;
    if (save) saveLyricsChoice();
    loadChordsFor(S.vid);
  }

  // Lyric times with the per-line fine-tune (a cappella: each line starts
  // where the singing starts).
  function resetFine() {
    L.fine = null;
    L.lines = L.raw;
  }

  function setFine(fine) {
    if (!L.raw || !fine || fine.length !== L.raw.length) return resetFine();
    L.fine = fine;
    L.lines = L.raw.map((ln, k) => ({ t: ln.t + (fine[k] || 0), text: ln.text }));
  }

  function lyricTexts() {
    return L.lines ? L.lines.map((x) => x.text || '') : L.plain || [];
  }

  // Builds the lyric lines: section name (VERSE 1, CHORUS…) above the first
  // line of each part, chord-only rows (intros), and chords over the words.
  function renderLyricLines() {
    const texts = lyricTexts();
    const synced = L.synced && !!L.lines;
    computeSections();
    ui.lyrBody.classList.toggle('synced', synced);
    ui.lyrBody.classList.toggle('with-chords', !!CH.map || !!CH.sheetOnly);
    const kids = [];
    if (CH.sheetOnly && !texts.length) {
      // No lyrics found, but chords pasted: show the sheet itself.
      for (const it of CH.sheetOnly) {
        if (it.type === 'sec') kids.push(h('p', { class: 'sec-only' }, h('span', { class: 'sec-tag', text: it.name })));
        else if (it.type === 'chords') kids.push(h('p', {}, chordRow(it.chords)));
        else kids.push(h('p', {}, h('div', { class: 'lrow' }, lyricText(it.text, it.chords))));
      }
      ui.lyrBody.replaceChildren(...kids);
      L.abKey = '';
      return;
    }
    texts.forEach((text, k) => {
      const m = CH.map && CH.map[k];
      const parts = [];
      const sec = L.secNames[k];
      if (m && m.pre) {
        for (const row of m.pre) {
          if (row.sec) parts.push(h('span', { class: 'sec-tag', text: row.sec }));
          parts.push(chordRow(row.chords));
        }
      }
      if (sec) parts.unshift(h('span', { class: 'sec-tag', text: sec }));
      const row = h('div', { class: 'lrow' },
        synced ? h('span', { class: 'lyr-loop', title: 'Practise this line: from 30% up to 100%, then at full speed (tap again to stop)' }, icon('loop')) : null,
        lyricText(text || (synced ? '♪' : ' '), m ? m.chords : null),
        synced ? h('span', { class: 'lyr-ab', title: 'Loop from this line: tap here on the first line, then on the last line', text: 'A' }) : null);
      const p = h('p', { class: sec ? 'sec-start' : '' }, ...parts, row);
      if (synced) p.addEventListener('click', (e) => lineClick(e, p, row, k));
      p.dataset.i = String(k);
      kids.push(p);
    });
    L.abStart = null;
    L.abKey = '';
    ui.lyrBody.replaceChildren(...kids);
    L.nowIdx = -2;
    markLoopingLine();
  }

  function lineClick(e, p, row, k) {
    // Left edge of a line (the ⟳ button): repeat just this line.
    // Right edge (the A / B button): loop from one line to another.
    const r = row.getBoundingClientRect();
    const onLoopBtn = e.target.closest && e.target.closest('.lyr-loop');
    const onAB = e.target.closest && e.target.closest('.lyr-ab');
    const realPoint = e.clientX || e.clientY; // keyboard / scripted clicks have no position
    if (onAB || (realPoint && !onLoopBtn && r.right - e.clientX < Math.min(72, r.width * 0.2))) {
      lyricsABTap(k);
      return;
    }
    if (onLoopBtn || (realPoint && e.clientX - r.left < Math.min(72, r.width * 0.2))) {
      toggleLineLoop(k);
      return;
    }
    if (S.lineLoop || PR.on) stopLineLoop(true);
    const at = Math.max(0, L.lines[k].t + L.offset);
    seek(at);
    L.userScrollAt = 0;
    if (S.loopOn && hasLoop() && (at < S.a || at >= effEnd())) {
      S.loopOn = false;
      flash('Loop paused because you jumped outside it. Press Loop to turn it back on.');
    }
    renderUI();
  }

  function shownChord(c) {
    return CH.transpose ? C.transposeChord(c, CH.transpose, CH.flats) : c;
  }

  function chordRow(chords) {
    return h('div', { class: 'ch-row' }, ...chords.map((c) => h('span', { class: 'ch', text: shownChord(c) })));
  }

  // The words with chords sitting right above the syllable they start on.
  function lyricText(text, chords) {
    if (!chords || !chords.length) return h('span', { class: 'lyr-text', text });
    const el = h('span', { class: 'lyr-text has-ch' });
    const byAt = new Map();
    for (const c of chords) {
      const at = Math.max(0, Math.min(text.length, c.at));
      byAt.set(at, (byAt.has(at) ? byAt.get(at) + ' ' : '') + shownChord(c.c));
    }
    const cuts = [...byAt.keys()].sort((a, b) => a - b);
    if (cuts[0] > 0) el.appendChild(document.createTextNode(text.slice(0, cuts[0])));
    cuts.forEach((at, n) => {
      const end = n + 1 < cuts.length ? cuts[n + 1] : text.length;
      const name = byAt.get(at);
      let piece = text.slice(at, end);
      // Room for the chord name, so neighbouring chords never overlap.
      const need = Math.ceil(name.length * 0.8) + 1;
      if (piece.length < need && n + 1 < cuts.length) piece += '\u00a0'.repeat(need - piece.length);
      el.appendChild(h('span', { class: 'seg' }, h('span', { class: 'ch', text: name }), piece || '\u00a0'));
    });
    return el;
  }

  // Song parts: names from the chord sheet when it has them ([Verse 1],
  // [Chorus]…), otherwise worked out from the lyrics (repeats = chorus…).
  function computeSections() {
    const n = lyricTexts().length;
    let names = new Array(n).fill(null);
    let fromSheet = 0;
    if (CH.map) CH.map.forEach((m, k) => {
      if (m && m.sec) {
        names[k] = m.sec;
        fromSheet++;
      }
    });
    if (fromSheet < 2 && L.lines) names = C.detectSections(L.lines).names;
    L.secNames = names;
    const sections = [];
    const sung = (k) => !!String(lyricTexts()[k] || '').replace(/[♪♫\s]/g, '');
    let cur = null;
    for (let k = 0; k < n; k++) {
      if (names[k]) {
        if (cur && cur.i1 >= cur.i0) sections.push(cur);
        cur = { name: names[k], i0: k, i1: k - 1 };
      }
      if (!cur && sung(k)) cur = { name: 'Intro', i0: k, i1: k - 1 };
      if (cur && sung(k)) cur.i1 = k;
    }
    if (cur && cur.i1 >= cur.i0) sections.push(cur);
    L.sections = L.lines ? sections : [];
  }

  // ---- Chords ----
  function toggleChordPanel() {
    ui.chordPanel.hidden = !ui.chordPanel.hidden;
    ui.chordBtn.classList.toggle('on', !ui.chordPanel.hidden);
    if (!ui.chordPanel.hidden && !ui.chordText.value && CH.text) ui.chordText.value = CH.text;
  }

  function findChordsOnline() {
    const meta = songMeta();
    const g = C.parseSongTitle(meta.title, meta.author);
    const r = L.results[L.idx];
    const q = r ? `${r.artistName || ''} ${r.trackName || ''}`.trim() : `${g.artist} ${g.track}`.trim();
    const url = `https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(q)}`;
    window.open(url, '_blank', 'noopener');
    flash('On the chords page: select all, Copy, then come back and tap Paste.', 8000);
  }

  async function pasteChords() {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      text = '';
    }
    if (!text.trim()) {
      ui.chordText.focus();
      flash('Long-press the box and choose Paste, then tap “Use these”.', 6000);
      return;
    }
    ui.chordText.value = text;
    applyChords(text, { save: true });
  }

  function applyChords(text, opts = {}) {
    text = String(text || '');
    if (!text.trim()) return flash('Paste the chords first.');
    const items = C.parseChordSheet(text);
    const chordsIn = items.reduce((n, it) => n + (it.type === 'chords' ? it.chords.length : it.type === 'line' ? it.chords.length : 0), 0);
    if (!chordsIn) {
      if (!opts.quiet) flash('No chords found in that text. Copy the chords page itself (with the chord names over the words).', 7000);
      return false;
    }
    const texts = lyricTexts();
    CH.vid = S.vid;
    CH.text = text;
    CH.all = items.flatMap((it) => (it.type === 'chords' ? it.chords : it.type === 'line' ? it.chords.map((x) => x.c) : []));
    CH.flats = C.prefersFlats(CH.all, CH.transpose);
    if (texts.length) {
      const r = C.alignChordSheet(items, texts);
      if (r.matched < Math.min(2, r.sheetLines)) {
        if (!opts.quiet) flash('These chords do not match these lyrics. Is it the same song?', 7000);
        CH.map = null;
        CH.sheetOnly = null;
        renderLyricLines();
        return false;
      }
      CH.map = r.lines;
      CH.sheetOnly = null;
      if (!opts.quiet) flash(`Chords placed on ${r.lines.filter((x) => x.chords.length).length} lines.`, 3000);
    } else {
      CH.map = null;
      CH.sheetOnly = items;
    }
    if (opts.save && S.vid) storage.set({ ['ytl:chords:' + S.vid]: { text, transpose: CH.transpose } });
    ui.chordPanel.hidden = true;
    ui.chordBtn.classList.remove('on');
    ui.chordBtn.classList.add('has');
    renderLyricLines();
    renderLyricsSync();
    renderUI();
    return true;
  }

  function removeChords() {
    CH.text = '';
    CH.map = null;
    CH.sheetOnly = null;
    CH.transpose = 0;
    ui.chordText.value = '';
    ui.chordBtn.classList.remove('has');
    if (S.vid) storage.remove(['ytl:chords:' + S.vid]);
    renderLyricLines();
    renderLyricsSync();
  }

  function transposeChords(n) {
    if (!CH.map && !CH.sheetOnly) return;
    CH.transpose = ((CH.transpose + n + 18) % 12) - 6 || 0; // -5 .. +6
    CH.flats = C.prefersFlats(CH.all || [], CH.transpose);
    if (S.vid) storage.set({ ['ytl:chords:' + S.vid]: { text: CH.text, transpose: CH.transpose } });
    renderLyricLines();
    renderLyricsSync();
  }

  function loadChordsFor(vid) {
    if (!vid) return;
    if (CH.vid !== vid) {
      CH.vid = vid;
      CH.text = '';
      CH.map = null;
      CH.sheetOnly = null;
      CH.transpose = 0;
      ui.chordText.value = '';
      ui.chordBtn.classList.remove('has');
    }
    storage.get('ytl:chords:' + vid).then((r) => {
      const saved = r['ytl:chords:' + vid];
      if (!saved || S.vid !== vid || !saved.text) {
        if (CH.text) applyChords(CH.text, { quiet: true });
        return;
      }
      CH.transpose = saved.transpose || 0;
      ui.chordText.value = saved.text;
      applyChords(saved.text, { quiet: true });
    });
  }

  // ---- A–B loop from the lyrics ----
  // The A / B button at the right of each line: tap it on the first line of
  // the part (A = where that line starts), then on the last line (B = where
  // that line ends). Those lines loop, like A / B on the wave.
  function lyricsABTap(k) {
    if (!L.lines || !L.lines[k]) return;
    const r = lineRange(k);
    if (L.abStart == null || S.pendingA == null) {
      pushHistory();
      L.abStart = k;
      S.pendingA = r.a;
      S.dirty = true;
      flash(`A: “${L.lines[k].text || '♪'}”. Now tap B on the last line of the part (or B here for just this line).`, 5000);
    } else {
      const lo = Math.min(L.abStart, k);
      const hi = Math.max(L.abStart, k);
      L.abStart = null;
      if (S.lineLoop) stopLineLoop(true);
      S.pendingA = null;
      if (PR.on) stopLineLoop(true);
      if (setLoop(lineRange(lo).a, lineRange(hi).b, { fresh: true, noHistory: true, play: true })) {
        L.userScrollAt = 0;
        // Chosen from the lyrics: straight into the trainer (your counts).
        startTrainer(true);
        flash(`${lo === hi ? 'This line' : `${hi - lo + 1} lines`}: Trainer from ${settings.trainerStart}% to 100% (${settings.trainerReps}×), then ${trainerAfter(settings.trainerReps)}× at 100%.`, 4000);
      }
    }
    renderUI();
  }

  // Shows A / B on the buttons and marks the lines inside the A–B loop.
  function markLyricsAB() {
    if (!ui.lyrBody || !L.lines || !L.synced) return;
    if (L.abStart != null && S.pendingA == null) L.abStart = null; // cancelled elsewhere
    const loop = hasLoop() && S.pendingA == null;
    const key = `${L.abStart}|${loop ? `${S.a},${S.b}` : ''}|${L.offset}|${L.lines.length}`;
    if (key === L.abKey) return;
    L.abKey = key;
    ui.lyrBody.classList.toggle('ab-wait', L.abStart != null);
    const kids = ui.lyrBody.children;
    for (let k = 0; k < kids.length && k < L.lines.length; k++) {
      const p = kids[k];
      const ab = p.querySelector('.lyr-ab');
      let inside = false;
      if (loop) {
        const r = lineRange(k);
        inside = r.a >= S.a - 0.05 && r.a < S.b - 0.1;
      }
      p.classList.toggle('in-ab', inside);
      p.classList.toggle('ab-start', L.abStart === k);
      if (ab) ab.textContent = L.abStart != null ? (L.abStart === k ? 'A✓' : 'B') : 'A';
    }
  }

  // ---- one-line loop ----
  function lineRange(k) {
    const d = dur();
    const ln = L.lines[k];
    let end = null;
    for (let j = k + 1; j < L.lines.length; j++) {
      if (L.lines[j].t > ln.t + 0.05) {
        end = L.lines[j].t;
        break;
      }
    }
    if (end == null) end = ln.t + 6; // last line: about 6 s
    let a = ln.t + L.offset;
    let b = end + L.offset;
    if (d) b = Math.min(b, d);
    a = Math.max(0, a);
    if (b - a < 0.5) b = a + 0.5;
    return { a, b };
  }

  // Lines k0..k1 as one loop (a single line, or a whole verse / chorus).
  function linesRange(k0, k1) {
    return { a: lineRange(k0).a, b: lineRange(k1).b };
  }

  function toggleLineLoop(k, fromRun, k1) {
    if (!L.lines || !L.lines[k]) return;
    if (S.lineLoop && S.lineLoop.idx === k && !fromRun) return stopLineLoop(false);
    if (!fromRun && PR.on) endPractice(); // practising a line by hand ends Practice
    const k2 = k1 == null ? k : k1;
    const r = linesRange(k, k2);
    // Remember the speed from before (a trainer keeps its place too) so it can
    // be put back exactly when the line practice ends.
    const saved = S.lineLoop ? S.lineLoop.saved : { rate: S.rate, rateOwned: S.rateOwned };
    const ramp = TRAINER_REPS.includes(settings.trainerReps) ? settings.trainerReps : TRAINER_DEFAULT_REPS; // same counts as the Trainer
    S.lineLoop = { a: r.a, b: r.b, idx: k, idx2: k2, rep: 1, ramp, full: trainerAfter(ramp), saved };
    S.rate = C.trainerRate(LINE_START, 1, ramp, 1);
    S.rateOwned = true;
    applyRate();
    clearTimeout(S.wrapTimer);
    S.wrapTimer = 0;
    seek(r.a);
    play();
    L.userScrollAt = 0;
    markLoopingLine();
    S.dirty = true;
    renderUI();
  }

  // Stops repeating the line. The song just carries on into the next line,
  // and the A-B loop (if any) takes over again.
  function stopLineLoop(silent) {
    const wasRun = PR.on;
    endPractice();
    if (!S.lineLoop) {
      if (wasRun && !silent) {
        flash('Practice off.');
        renderUI();
      }
      return;
    }
    restoreLineSpeed();
    S.lineLoop = null;
    markLoopingLine();
    S.dirty = true;
    if (!silent) {
      flash(wasRun ? 'Practice off.' : S.loopOn && hasLoop() ? 'Line practice off. Back to your A–B loop.' : 'Line practice off. Playing on.');
      renderUI();
    }
  }

  function restoreLineSpeed() {
    const sv = S.lineLoop && S.lineLoop.saved;
    if (!sv) return;
    S.rate = sv.rate;
    S.rateOwned = sv.rateOwned;
    applyRate();
  }

  // All plays done: stop on the line's start, speed back to what it was.
  // Pressing play goes on as before (A-B loop / trainer / normal playing).
  function finishLinePractice() {
    const ll = S.lineLoop;
    restoreLineSpeed();
    S.lineLoop = null;
    markLoopingLine();
    try {
      S.video.pause();
    } catch (e) {
      /* ignore */
    }
    if (PR.on) {
      if (PR.pos + 1 < PR.parts.length) restBeforePart(PR.pos + 1);
      else startFinalPlay();
      S.dirty = true;
      renderUI();
      return;
    }
    seek(ll.a);
    flash(`Line practice done: ${ll.ramp + ll.full} times, up to 100%. Press play to go on.`, 10000);
    S.dirty = true;
    renderUI();
  }

  // ---- Practice: the whole song, part by part, by itself ----
  // Each part (verse, chorus, bridge…) loops from 30% up to 100% with the
  // Trainer's counts, then plays at full speed; then the next part. After the
  // last part the whole song plays once from the start at 100%, and it stops.
  // The loop edges are the lyric timings (+ the timing shift), so the words
  // and the sound stay together.
  const PR = { on: false, parts: [], pos: 0, timer: 0, tick: 0, restUntil: 0, final: false, loopWas: false };

  function startPractice() {
    if (!L.lines || !L.synced) return flash('Practice needs lyrics with timings. Try ⏭ for another match.');
    computeSections();
    const parts = L.sections.filter((p) => p.i1 >= p.i0);
    if (!parts.length) return flash('No sung parts found in these lyrics.');
    stopTrainer(true);
    if (S.lineLoop) stopLineLoop(true);
    const v = S.video;
    const t = v ? v.currentTime : 0;
    // Start with the part playing now (from the top if nothing is playing yet).
    let pos = parts.findIndex((p) => linesRange(p.i0, p.i1).b > t + 0.3);
    if (pos < 0 || t < 0.5) pos = 0;
    PR.on = true;
    PR.parts = parts;
    PR.final = false;
    PR.loopWas = S.loopOn;
    startPart(pos);
    const n = settings.trainerReps;
    flash(`Practice: ${parts.length} parts. Each one ${settings.trainerStart}% → 100% (${n}×), then ${trainerAfter(n)}× at 100%. Then the whole song once.`, 6000);
  }

  function startPart(pos) {
    clearTimeout(PR.timer);
    clearInterval(PR.tick);
    PR.restUntil = 0;
    PR.pos = pos;
    const p = PR.parts[pos];
    toggleLineLoop(p.i0, true, p.i1);
  }

  function restBeforePart(pos) {
    const rest = settings.lineRest || 0;
    const p = PR.parts[pos];
    PR.pos = pos;
    seek(linesRange(p.i0, p.i1).a); // the next part waits on the playhead
    if (!rest) return startPart(pos);
    PR.restUntil = now() + rest * 1000;
    clearTimeout(PR.timer);
    clearInterval(PR.tick);
    PR.timer = setTimeout(() => startPart(pos), rest * 1000);
    PR.tick = setInterval(renderUI, 500);
  }

  function startFinalPlay() {
    clearTimeout(PR.timer);
    clearInterval(PR.tick);
    PR.restUntil = 0;
    PR.final = true;
    S.loopOn = false; // nothing pulls the playhead back
    S.rate = 1;
    S.rateOwned = true;
    applyRate();
    seek(0);
    play();
    flash('Every part done! Now the whole song once at 100%.', 5000);
    PR.tick = setInterval(() => {
      const v = S.video;
      if (!PR.on || !PR.final || !v) return;
      if (v.ended || v.currentTime >= dur() - 0.4) {
        try {
          v.pause();
        } catch (e) {
          /* ignore */
        }
        endPractice();
        flash('Practice finished! 🎉', 8000);
        renderUI();
      } else renderUI();
    }, 200);
  }

  function endPractice() {
    if (!PR.on) return;
    PR.on = false;
    clearTimeout(PR.timer);
    clearInterval(PR.tick);
    PR.restUntil = 0;
    if (PR.final) S.loopOn = PR.loopWas;
    PR.final = false;
    if (ui.practiceBtn) ui.practiceBtn.classList.remove('on');
  }

  function togglePractice() {
    if (PR.on) stopLineLoop(false);
    else startPractice();
    renderUI();
  }

  function markLoopingLine() {
    if (!ui.lyrBody) return;
    const kids = ui.lyrBody.children;
    const ll = S.lineLoop;
    for (let k = 0; k < kids.length; k++) kids[k].classList.toggle('looping', !!ll && k >= ll.idx && k <= (ll.idx2 == null ? ll.idx : ll.idx2));
  }

  function saveLyricsChoice() {
    const r = L.results[L.idx];
    if (!r || !S.vid) return;
    const slim = { id: r.id, trackName: r.trackName, artistName: r.artistName, duration: r.duration,
      syncedLyrics: r.syncedLyrics || '', plainLyrics: r.plainLyrics || '' };
    storage.set({ ['ytl:lyr:' + S.vid]: { r: slim, q: ui.lyrInput.value.trim(), offset: L.offset, offsetSet: L.offsetSet, fine: L.fine || null } });
  }

  function nudgeLyrics(delta) {
    L.offset = Math.round((L.offset + delta) * 100) / 100;
    if (S.lineLoop && !S.lineLoop.custom) Object.assign(S.lineLoop, linesRange(S.lineLoop.idx, S.lineLoop.idx2 == null ? S.lineLoop.idx : S.lineLoop.idx2));
    L.offsetSet = true;
    L.autoPending = false;
    L.nowIdx = -2;
    saveLyricsChoice();
    renderLyricsSync();
  }

  function renderLyricsSync() {
    if (!ui.lyrSync) return;
    ui.lyrSync.hidden = !L.lines && !CH.map;
    const o = L.offset;
    const label = Math.abs(o) < 0.05 ? 'timing ±0' : `timing ${o > 0 ? '+' : '−'}${Math.abs(o).toFixed(Math.abs(o * 10 - Math.round(o * 10)) > 0.01 ? 2 : 1)}s`;
    const fined = L.fine ? L.fine.filter((x) => x).length : 0;
    ui.lyrOffset.textContent = L.autoPending ? 'lining up…' : (L.offsetSet ? label : `${label} (auto)`) + (fined ? ` · ${fined} lines fine-tuned` : '');
    if (ui.keyBox) {
      ui.keyBox.hidden = !CH.map;
      const t = CH.transpose;
      ui.keyLabel.textContent = `key ${t > 0 ? '+' : t < 0 ? '−' : '±'}${Math.abs(t)}`;
    }
    ui.lyrOffset.title = 'How much the lyrics are shifted to match this video';
  }

  // A cappella: line the first sung line up with the first sound in the wave
  // (singing starts where the a cappella stops being silent). Other versions
  // whose length differs (a music video with silence or a skit before the
  // song): the first sound there is the band, not the voice, so only the
  // silence before the song is skipped, never more than the extra length.
  function autoAlignLyrics() {
    if (!L.autoPending || !L.lines || L.offsetSet) return;
    const d = dur();
    if (!d || S.peaks.coverage(d) < 0.6) return; // wait for the wave
    const firstLine = L.lines.find((ln) => ln.text && ln.text.trim());
    const start = S.peaks.firstSound(d);
    L.autoPending = false;
    if (firstLine && start != null) {
      if (C.isVocalOnlyTitle(songMeta().title)) {
        // A cappella: every line starts where the singing starts after a
        // breath. Line the lyrics up with all those starts (not just the
        // first), then move each line onto its own start.
        const guess = start - firstLine.t;
        const n = Math.min(S.peaks.n, Math.ceil(d * S.peaks.binRate));
        const onsets = C.findOnsets(S.peaks.peak, S.peaks.binRate, n);
        const raw = L.raw || L.lines;
        const sungIdx = raw.map((ln, k) => (ln.text && ln.text.replace(/[♪♫\s]/g, '') ? k : -1)).filter((k) => k >= 0);
        const fit = C.alignToOnsets(sungIdx.map((k) => raw[k].t), onsets, guess);
        const off = Math.abs(fit.offset - guess) <= 1.5 && fit.score >= 0.35 ? fit.offset : Math.round(guess * 100) / 100;
        if (Math.abs(off) <= 90) {
          L.offset = Math.round(off * 100) / 100;
          if (fit.score >= 0.5) {
            const snap = C.snapToOnsets(sungIdx.map((k) => raw[k].t), onsets, L.offset);
            const fine = raw.map(() => 0);
            sungIdx.forEach((k, a) => (fine[k] = snap[a]));
            setFine(fine);
          }
        }
      } else {
        const r = L.results[L.idx];
        const extra = r && r.duration ? d - r.duration : 0;
        const off = Math.round(Math.min(start - 0.2, extra + 0.5) * 10) / 10;
        if (off >= 0.3) L.offset = off;
      }
    }
    L.nowIdx = -2;
    saveLyricsChoice();
    renderLyricsSync();
  }

  // ---------------------------------------------------------------------------
  // iPhone/iPad: let the video's sound mix with a voice call instead of being
  // cut off by it.
  // ---------------------------------------------------------------------------
  function applyAudioSession() {
    try {
      if (!navigator.audioSession) return;
      const want = settings.mixCalls ? 'ambient' : 'auto';
      if (navigator.audioSession.type !== want) navigator.audioSession.type = want;
    } catch (e) {
      /* not supported */
    }
  }

  function lyricsTick() {
    if (!settings.lyrics || !L.synced || !L.lines || !S.video || ui.lyrics.hidden) return;
    if (L.autoPending) autoAlignLyrics();
    const i = C.lineAt(L.lines, S.video.currentTime + 0.15 - L.offset - audioLag());
    if (i === L.nowIdx) return;
    const kids = ui.lyrBody.children;
    for (let k = Math.max(0, Math.min(L.nowIdx, i) - 1); k < kids.length && k <= Math.max(L.nowIdx, i) + 1; k++) {
      kids[k].classList.toggle('now', k === i);
      kids[k].classList.toggle('past', k < i);
    }
    if (Math.abs(i - L.nowIdx) > 2) for (let k = 0; k < kids.length; k++) {
      kids[k].classList.toggle('now', k === i);
      kids[k].classList.toggle('past', k < i);
    }
    L.nowIdx = i;
    const el = kids[Math.max(0, i)];
    if (el && now() - L.userScrollAt > 3000) {
      const top = el.offsetTop - ui.lyrBody.clientHeight * (ui.lyrics.classList.contains('top') ? 0.4 : 0.35);
      ui.lyrBody.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  // ---------------------------------------------------------------------------
  // Whole-song scan
  // ---------------------------------------------------------------------------
  let autoScanTimer = 0;
  function autoScanWanted() {
    return settings.autoScan && settings.open && !!S.vid && !S.scan && !S.noHook && !S.scannedVids.has(S.vid) &&
      !isAd() && dur() > 0 && isFinite(S.video.duration) && S.video.readyState >= 2 && hostVisible() &&
      S.peaks.coverage(dur()) <= 0.985;
  }
  // Called often (every sync tick); it only acts once the player has settled.
  function maybeAutoScan() {
    if (autoScanTimer || !autoScanWanted()) return;
    const vid = S.vid;
    // Wait for the player to settle (ads, autoplay) before taking over.
    autoScanTimer = setTimeout(() => {
      autoScanTimer = 0;
      if (S.vid === vid && autoScanWanted()) startScan();
    }, 500);
  }

  function startScan() {
    const v = S.video;
    const d = dur();
    if (!v || !d || S.scan || isAd()) return;
    if (!isFinite(v.duration)) return flash('Live streams have no full waveform.');
    clearTimeout(S.gapTimer);
    clearTimeout(S.wrapTimer);
    S.wrapping = false;
    S.scannedVids.add(S.vid);
    S.scan = {
      vid: S.vid,
      video: v,
      t0: v.currentTime,
      paused: v.paused,
      muted: v.muted,
      startedAt: now(),
      lastCov: S.peaks.coverage(d),
      lastProgressAt: now(),
      lastJumpAt: 0,
      skip: [],
      timer: 0,
      everGotData: S.peaks.coverage(d) > 0,
    };
    try {
      v.muted = true;
      v.playbackRate = SCAN_RATE;
    } catch (e) {
      try {
        v.playbackRate = 4;
      } catch (e2) {
        /* ignore */
      }
    }
    const g = S.peaks.nextGap(v.currentTime, d);
    if (g) seek(g.start);
    play();
    S.scan.timer = setInterval(scanTick, 100);
    renderUI();
  }

  function scanTick() {
    const sc = S.scan;
    const v = S.video;
    if (!sc) return;
    if (S.vid !== sc.vid || v !== sc.video) return endScan('switched');
    if (isAd()) return endScan('ad');
    const d = dur();
    const cov = S.peaks.coverage(d);
    if (cov > sc.lastCov + 0.0005) {
      sc.lastCov = cov;
      sc.lastProgressAt = now();
      sc.everGotData = true;
    }
    const gaps = S.peaks.gaps(d).filter((g) => !sc.skip.some((s) => Math.abs(s - g.start) < 0.5));
    if (!gaps.length) return endScan('done');
    if (now() - sc.startedAt > Math.max(90000, (d / SCAN_RATE) * 4000 + 30000)) return endScan('timeout');
    if (!sc.everGotData && now() - sc.startedAt > 7000) return endScan('nohook');
    try {
      if (v.playbackRate < SCAN_RATE - 0.5) v.playbackRate = SCAN_RATE;
      if (!v.muted) v.muted = true;
    } catch (e) {
      /* ignore */
    }
    const t = v.currentTime;
    // Never let YouTube reach the end (it would autoplay the next video).
    if (t > d - 2.5 && !v.paused) v.pause();
    const inGap = gaps.find((g) => t >= g.start - 0.05 && t < g.end);
    const stuck = now() - sc.lastProgressAt > 6000;
    if (stuck && inGap) {
      sc.skip.push(inGap.start); // this part won't load; don't wait forever
      sc.lastProgressAt = now();
    }
    const nearEnd = t > d - 2.5;
    if (!inGap || nearEnd || stuck) {
      if (now() - sc.lastJumpAt > 900 || !inGap) {
        const ahead = gaps.find((g) => g.end > t + 0.1 && !(inGap && g.start === inGap.start)) || gaps[0];
        if (ahead) {
          sc.lastJumpAt = now();
          seek(ahead.start);
        }
      }
    }
    if (v.paused && v.currentTime < d - 2.5) play();
    S.dirty = true;
    renderScanOverlay();
  }

  function endScan(reason) {
    const sc = S.scan;
    if (!sc) return;
    clearInterval(sc.timer);
    S.scan = null;
    const v = sc.video;
    if (v && reason !== 'switched') {
      try {
        v.playbackRate = S.rate;
        v.muted = sc.muted;
        v.currentTime = sc.t0;
        if (sc.paused) v.pause();
        else play();
      } catch (e) {
        /* ignore */
      }
    } else if (v) {
      try {
        v.muted = sc.muted;
      } catch (e) {
        /* ignore */
      }
    }
    if (reason === 'nohook') {
      S.noHook = true;
      flash('Could not read the audio directly. The wave will draw itself while the song plays.', 7000);
      startLive();
    } else if (reason === 'timeout') {
      flash('Some parts of the song did not load. The wave fills in as they play.', 5000);
    } else if (reason === 'cancel') {
      flash('Scan cancelled. The wave keeps filling in while you listen.');
    }
    saveWaveNow();
    S.dirty = true;
    renderUI();
  }

  // ---------------------------------------------------------------------------
  // Live fallback: draw the wave from what is playing
  // ---------------------------------------------------------------------------
  function startLive() {
    const v = S.video;
    if (!v || S.live) return;
    try {
      const stream = v.captureStream ? v.captureStream() : null;
      if (!stream || !stream.getAudioTracks().length) return;
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0;
      src.connect(an);
      ctx.resume().catch(() => {});
      S.live = { ctx, an, td: new Float32Array(an.fftSize), fd: new Uint8Array(an.frequencyBinCount), lastT: null };
    } catch (e) {
      S.live = null;
    }
  }

  function stopLive() {
    if (!S.live) return;
    try {
      S.live.ctx.close();
    } catch (e) {
      /* ignore */
    }
    S.live = null;
  }

  function liveTick() {
    const L = S.live;
    const v = S.video;
    if (!L || !v || v.paused || v.seeking || isAd()) {
      if (L) L.lastT = null;
      return;
    }
    const t = v.currentTime;
    if (L.lastT == null || t < L.lastT || t - L.lastT > 0.5) {
      L.lastT = t;
      return;
    }
    L.an.getFloatTimeDomainData(L.td);
    let pk = 0;
    for (let i = 0; i < L.td.length; i++) {
      const a = Math.abs(L.td[i]);
      if (a > pk) pk = a;
    }
    L.an.getByteFrequencyData(L.fd);
    const hz = L.ctx.sampleRate / L.an.fftSize;
    let lo = 0, mi = 0, hi = 0, nl = 0, nm = 0, nh = 0;
    for (let i = 1; i < L.fd.length; i++) {
      const f = i * hz;
      if (f < 250) { lo += L.fd[i]; nl++; } else if (f < 2500) { mi += L.fd[i]; nm++; } else if (f < 8000) { hi += L.fd[i]; nh++; }
    }
    const b0 = Math.floor(L.lastT * BIN_RATE);
    const b1 = Math.max(b0 + 1, Math.floor(t * BIN_RATE));
    const n = b1 - b0;
    const fill = (x) => new Uint8Array(n).fill(Math.max(0, Math.min(255, Math.round(x))));
    S.peaks.add(b0, fill(pk * 255), fill(nl ? lo / nl : 0), fill(nm ? mi / nm : 0), fill(nh ? hi / nh : 0));
    L.lastT = t;
    S.dirty = true;
    saveWaveSoon();
  }

  // ---------------------------------------------------------------------------
  // UI building helpers
  // ---------------------------------------------------------------------------
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    wave: 'M3 10h2v4H3zM7 6h2v12H7zM11 3h2v18h-2zM15 7h2v10h-2zM19 10h2v4h-2z',
    loop: 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z',
    bolt: 'M7 2v11h3v9l7-12h-4l4-8z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    gear: 'M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.47.47 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
    undo: 'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z',
    zoom: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM12 10h-2v2H9v-2H7V9h2V7h1v2h2z',
    fit: 'M3 12l4-4v3h10V8l4 4-4 4v-3H7v3z',
    taller: 'M12 2 7 7h3.5v10H7l5 5 5-5h-3.5V7H17z',
    shorter: 'M7 2l5 5 5-5zM7 22l5-5 5 5zM3 11h18v2H3z',
    down: 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z',
    up: 'M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z',
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    note: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z',
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    paste: 'M19 2h-4.18C14.4.84 13.3 0 12 0S9.6.84 9.18 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z',
    place: 'M4 4h16v6H4zm0 8h7v8H4zm9 0h7v8h-7z',
    back5: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
    fwd5: 'M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z',
    stop: 'M6 6h12v12H6z',
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    minus: 'M19 13H5v-2h14z',
    left: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
    right: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    help: 'M11 18h2v-2h-2v2zm1-16a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm0-14a4 4 0 0 0-4 4h2a2 2 0 1 1 4 0c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5a4 4 0 0 0-4-4z',
    scan: 'M3 5v4h2V5h4V3H5a2 2 0 0 0-2 2zm2 10H3v4a2 2 0 0 0 2 2h4v-2H5v-4zm14 4h-4v2h4a2 2 0 0 0 2-2v-4h-2v4zm0-16h-4v2h4v4h2V5a2 2 0 0 0-2-2zM7 11h2v2H7zm4-3h2v8h-2zm4 2h2v4h-2z',
  };

  function icon(name) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', ICONS[name]);
    svg.appendChild(p);
    return svg;
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'hidden') el.hidden = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    if (tag === 'button') {
      el.type = 'button';
      el.tabIndex = -1;
      // Keep focus on the page so Space still means play/pause in YouTube.
      el.addEventListener('mousedown', (e) => e.preventDefault());
    }
    return el;
  }

  function btn(label, title, onclick, cls = '', iconName = null) {
    return h('button', { class: cls, title, 'aria-label': title, onclick }, iconName ? icon(iconName) : null,
      label ? h('span', { class: 'txt', text: label }) : null);
  }

  function select(values, fmt, value, onchange, title) {
    const el = h('select', { title, 'aria-label': title });
    for (const v of values) {
      const o = h('option', { value: String(v), text: fmt(v) });
      if (v === value) o.selected = true;
      el.appendChild(o);
    }
    el.addEventListener('change', () => {
      onchange(Number(el.value));
      el.blur();
    });
    return el;
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------
  let hostEl = null;
  let shadow = null;
  const ui = {};

  // Beats: Q (quantize), DJ beat loops, tempo and the drum view.
  function buildBeatGroup() {
    ui.qBtn = btn('Q', 'Quantize (Q): A and B always land on a beat (1 2 3 4). ‹ › move by one beat.', toggleQuantize, 'q-btn');
    ui.beatBtns = BEAT_LOOPS.map((n) => {
      const b = btn(String(n), `Loop ${n} beat${n > 1 ? 's' : ''} from the beat you are on`, () => beatLoop(n), 'beat-btn');
      b.dataset.n = String(n);
      return b;
    });
    ui.bpm = h('span', { class: 'bpm', title: 'Tempo found in the song (beats per minute)', text: '— BPM' });
    ui.cueBtns = [0, 1, 2, 3].map((i) => {
      const b = btn(`C${i + 1}`, `Hot cue ${i + 1}: click to mark this spot (on the beat with Q), click again to jump here. Shift-click or right-click clears it.`, (e) => cueTap(i, e), 'cue-btn');
      b.style.setProperty('--cue', CUE_COLORS[i]);
      b.addEventListener('contextmenu', (e) => cueTap(i, e));
      return b;
    });
    ui.drumBtn = btn('Drums', 'Drum view: kick (red), snare (amber) and hi-hats (white) stand out, with drum lanes under the wave', toggleDrumView, 'drum-btn');
    return h('div', { class: 'group beats hide-phone' },
      ui.qBtn,
      h('span', { class: 'beat-loops' }, ...ui.beatBtns),
      ui.bpm,
      h('span', { class: 'cues' }, ...ui.cueBtns),
      btn('½', 'Half the tempo (the grid has twice too many beats)', () => adjustGrid('half'), 'grid-btn'),
      btn('2×', 'Double the tempo (the grid has half the beats)', () => adjustGrid('double'), 'grid-btn'),
      btn('1▸', 'Move the "1" (start of the bar) one beat later', () => adjustGrid('shift'), 'grid-btn'),
      ui.drumBtn);
  }

  function renderBeats() {
    if (!ui.qBtn) return;
    const G = S.grid;
    ui.qBtn.classList.toggle('on', !!settings.quantize);
    ui.drumBtn.classList.toggle('on', settings.waveStyle === 'drums');
    ui.bpm.textContent = G ? `${G.bpm.toFixed(1)} BPM` : S.gridBase && S.gridBase.vid === S.vid ? 'no beat' : S.scan || (dur() && S.peaks.coverage(dur()) < 0.9) ? 'analyzing…' : '— BPM';
    ui.bpm.title = G ? 'Tempo found in the song (beats per minute)' : gridMissingText();
    ui.cueBtns.forEach((b, i) => b.classList.toggle('set', S.cues[i] != null));
    const n = loopBeats();
    for (const b of ui.beatBtns) {
      b.classList.toggle('on', !!n && S.loopOn && Number(b.dataset.n) === n);
      b.disabled = !G;
    }
  }

  function buildPanel() {
    hostEl = document.createElement('div');
    hostEl.id = 'ytl-wave-looper';
    hostEl.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:2147482000;display:none;';
    shadow = hostEl.attachShadow({ mode: 'open' });
    hostEl.addEventListener('pointerdown', () => hqGesture(), true);
    // Typing in the lyrics search box must not trigger YouTube's shortcuts (k, f, m, j, l...).
    for (const ev of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'wheel', 'touchstart', 'keydown', 'keyup', 'keypress']) {
      hostEl.addEventListener(ev, (e) => e.stopPropagation());
    }
    const style = document.createElement('style');
    style.textContent = globalThis.YTL_PANEL_CSS || '';
    shadow.appendChild(style);

    // --- toolbar ---
    ui.aTime = h('span', { class: 'time', text: '--:--.--' });
    ui.bTime = h('span', { class: 'time', text: '--:--.--' });
    ui.aMark = h('div', { class: 'mark a' },
      btn('A', 'Set loop START at the current time  [', markA, 'set'),
      btn(null, TOUCH ? 'Move start earlier by 1 second' : 'Move start earlier (Shift = fine, Alt = big)', (e) => nudge('a', -step(e)), 'icon', 'left'),
      ui.aTime,
      btn(null, TOUCH ? 'Move start later by 1 second' : 'Move start later (Shift = fine, Alt = big)', (e) => nudge('a', step(e)), 'icon', 'right'));
    ui.bMark = h('div', { class: 'mark b' },
      btn('B', 'Set loop END at the current time  ]', markB, 'set'),
      btn(null, TOUCH ? 'Move end earlier by 1 second' : 'Move end earlier (Shift = fine, Alt = big)', (e) => nudge('b', -step(e)), 'icon', 'left'),
      ui.bTime,
      btn(null, TOUCH ? 'Move end later by 1 second' : 'Move end later (Shift = fine, Alt = big)', (e) => nudge('b', step(e)), 'icon', 'right'));
    ui.playBtn = btn(null, 'Play', togglePlay, 'icon play-btn', 'play');
    ui.backBtn = btn('5s', `Back ${JUMP_SEC} seconds and play`, () => jump(-JUMP_SEC), 'jump', 'back5');
    ui.fwdBtn = btn('5s', `Forward ${JUMP_SEC} seconds`, () => jump(JUMP_SEC), 'jump', 'fwd5');
    ui.loopBtn = btn('Loop', 'Loop on/off  \\', toggleLoop, '', 'loop');
    ui.clearBtn = btn(null, 'Clear the loop', clearLoop, 'icon danger', 'close');
    ui.undoBtn = btn(null, 'Undo the last loop change', undo, 'icon hide-phone', 'undo');

    ui.speedBtns = SPEED_PRESETS.map((r) =>
      btn(`${Math.round(r * 100)}%`, `Play at ${Math.round(r * 100)}% speed`, () => setRate(r), 'speed'));
    ui.rate = h('span', { class: 'rate', title: 'Current speed (click for 100%)', text: '100%' });
    ui.rate.addEventListener('click', () => setRate(1));
    const slower = btn(null, 'Slower by 5%', () => setRate(Math.round((S.rate - 0.05) * 100) / 100), 'icon hide-phone', 'minus');
    const faster = btn(null, 'Faster by 5%', () => setRate(Math.round((S.rate + 0.05) * 100) / 100), 'icon hide-phone', 'plus');
    ui.trainerBtn = btn('Trainer', 'Speed trainer: tap to start (slow, then faster every loop up to 100%); tap again to stop', toggleTrainer, '', 'bolt');

    ui.zoomLoopBtn = btn(null, 'Zoom to the loop', zoomToLoop, 'icon hide-phone', 'zoom');
    ui.zoomBtn = btn('Zoom in', ZOOM_IN_TITLE, toggleZoom, 'zoom-toggle', 'zoom');
    ui.biggerBtn = btn(null, 'Make the wave bigger (or drag the top edge of the panel)', () => resizeWave(Math.round(window.innerHeight * 0.1)), 'icon', 'taller');
    ui.smallerBtn = btn(null, 'Make the wave smaller', () => resizeWave(-Math.round(window.innerHeight * 0.1)), 'icon', 'shorter');
    ui.gearBtn = btn(null, 'Settings', () => toggleSub('settings'), 'icon', 'gear');
    ui.helpBtn = btn(null, 'How to use', () => toggleHelp(), 'icon hide-phone', 'help');
    ui.lyricsBtn = btn('Lyrics', 'Show the lyrics next to the wave (found automatically from the song name)', toggleLyrics, 'lyrics-btn', 'note');
    ui.collapseBtn = btn(null, 'Minimise', toggleCollapse, 'icon hide-phone', 'down');
    const closeBtn = btn(null, 'Close the looper (turns loop and speed off)', closePanel, 'icon', 'close');

    // Top row: speed, trainer and view options.
    const bar = h('div', { class: 'row bar' },
      h('div', { class: 'brand', title: 'DJ Wave Looper' }, icon('wave'), h('span', { class: 'brand-name', text: 'Wave Looper' })),
      h('div', { class: 'group' }, h('span', { class: 'label hide-narrow', text: 'Speed' }), ...ui.speedBtns, slower, ui.rate, faster),
      h('div', { class: 'sep' }),
      ui.trainerBtn,
      h('div', { class: 'spacer' }),
      h('div', { class: 'group size-btns' }, ui.smallerBtn, ui.biggerBtn),
      ui.zoomBtn,
      ui.lyricsBtn,
      h('div', { class: 'group' }, ui.zoomLoopBtn, ui.gearBtn, ui.helpBtn, ui.collapseBtn, closeBtn));

    // --- trainer row ---
    const pct = (v) => `${v}%`;
    // Changing a choice while training restarts the training with it.
    const trainerChoice = (key) => (v) => {
      settings[key] = v;
      saveSettings();
      if (S.trainer.running) startTrainer(true);
      else renderUI();
    };
    ui.tStart = select(TRAINER_STARTS, pct, settings.trainerStart, trainerChoice('trainerStart'), 'Starting speed');
    ui.tReps = select(TRAINER_REPS, (v) => `${v}× up + ${trainerAfter(v)}× at 100%`, settings.trainerReps, trainerChoice('trainerReps'), 'How many loops to reach 100%');
    ui.tBar = h('i');
    ui.tStat = h('span', { class: 'tstat' });
    ui.trainerRow = h('div', { class: 'row sub', hidden: true },
      h('span', { class: 'label hide-phone', text: 'Speed trainer' }),
      h('span', { class: 'label', text: 'from' }), ui.tStart,
      h('span', { class: 'label', text: 'to 100% over' }), ui.tReps,
      h('div', { class: 'progress' }, ui.tBar),
      ui.tStat);

    // --- settings row ---
    ui.gapSel = select(GAPS, (v) => (v ? `${v}s` : 'none'), settings.gap, (v) => { settings.gap = v; saveSettings(); }, 'Pause before each repeat (time to breathe)');
    ui.pitchChk = h('input', { type: 'checkbox' });
    ui.pitchChk.checked = settings.keepPitch;
    ui.pitchChk.addEventListener('change', () => { settings.keepPitch = ui.pitchChk.checked; saveSettings(); applyRate(); ui.pitchChk.blur(); });
    ui.scanChk = h('input', { type: 'checkbox' });
    ui.scanChk.checked = settings.autoScan;
    ui.scanChk.addEventListener('change', () => { settings.autoScan = ui.scanChk.checked; saveSettings(); ui.scanChk.blur(); if (settings.autoScan) maybeAutoScan(); });
    ui.hqChk = h('input', { type: 'checkbox' });
    ui.hqChk.checked = settings.hqAudio;
    ui.hqChk.addEventListener('change', () => {
      settings.hqAudio = ui.hqChk.checked;
      saveSettings();
      ui.hqChk.blur();
      if (settings.hqAudio) hqGesture();
      updateHQ();
      if (settings.hqAudio && IS_IOS) flash('On iPhone/iPad Safari may stop this sound when you pause or switch apps. If it goes quiet, tap the page, or turn this off.', 7000);
      else if (!settings.hqAudio && HQ.src) flash('Off. Reload the page if the sound ever stays quiet.', 4000);
    });
    ui.tapChk = h('input', { type: 'checkbox' });
    ui.tapChk.checked = settings.tapVideo;
    ui.tapChk.addEventListener('change', () => { settings.tapVideo = ui.tapChk.checked; saveSettings(); ui.tapChk.blur(); });
    ui.mixChk = h('input', { type: 'checkbox' });
    ui.mixChk.checked = settings.mixCalls;
    ui.mixChk.addEventListener('change', () => {
      settings.mixCalls = ui.mixChk.checked;
      saveSettings();
      applyAudioSession();
      ui.mixChk.blur();
      if (settings.mixCalls) flash('Plays along with voice calls. If you hear nothing, check the silent switch / silent mode is off.', 6000);
    });
    ui.djMouseChk = h('input', { type: 'checkbox' });
    ui.djMouseChk.checked = settings.mouseDJ;
    ui.djMouseChk.addEventListener('change', () => {
      settings.mouseDJ = ui.djMouseChk.checked;
      saveSettings();
      ui.djMouseChk.blur();
      S.dirty = true;
      renderUI();
    });
    ui.restSel = select(PART_RESTS, (v) => (v ? `${v}s` : 'none'), settings.lineRest, (v) => { settings.lineRest = v; saveSettings(); }, 'Practice: rest between the parts of the song');
    ui.rescanBtn = btn('Read whole song now', 'Load the full waveform (plays muted at high speed for a few seconds)', () => startScan(), '', 'scan');
    ui.settingsRow = h('div', { class: 'row sub', hidden: true },
      h('span', { class: 'label', text: 'Pause between loops' }), ui.gapSel,
      h('span', { class: 'label', text: 'Rest between Practice parts' }), ui.restSel,
      h('label', { class: 'check', title: 'On: slowing down keeps the key (best for singing). Off: tape-style, pitch drops too (50% = one octave lower).' }, ui.pitchChk, 'Keep pitch when slowing down'),
      h('label', { class: 'check' }, ui.scanChk, 'Read the whole song automatically'),
      h('label', { class: 'check', title: 'Cleaner sound when slowed down (Signalsmith Stretch). Turn off if you ever hear a problem.' }, ui.hqChk,
        IS_IOS ? 'Studio-quality slow-down (may go quiet after switching apps)' : 'Studio-quality slow-down'),
      TOUCH ? h('label', { class: 'check' }, ui.tapChk, 'Tap the video to pause / play') : null,
      TOUCH ? null : h('label', { class: 'check', title: 'On: drag the wave like a record, click = play / pause, double-click = A then B (Shift+drag draws a loop). Off: click the start, then the end.' }, ui.djMouseChk, 'DJ mouse (drag the wave)'),
      'audioSession' in navigator ? h('label', { class: 'check', title: 'Keep the video sound during a voice call (Claude voice mode, FaceTime…). The silent switch / silent mode mutes it.' }, ui.mixChk,
        'Play along with voice calls') : null,
      ui.rescanBtn,
      btn('How to use', 'Show the help', () => toggleHelp(true), '', 'help'));

    // --- waveform ---
    ui.canvas = h('canvas');
    ui.tip = h('div', { class: 'tip', hidden: true });
    ui.scanText = h('span');
    ui.scanBtn = btn('Read whole song', 'Load the full waveform', () => startScan(), 'primary', 'scan');
    ui.cancelBtn = btn('Cancel', 'Stop reading the song', () => endScan('cancel'));
    ui.overlay = h('div', { class: 'overlay', hidden: true }, ui.scanText, ui.scanBtn, ui.cancelBtn);
    ui.waveWrap = h('div', { class: 'wave-wrap' }, ui.canvas, ui.tip, ui.overlay);
    ui.lyrics = buildLyrics();
    ui.stage = h('div', { class: 'stage' }, ui.waveWrap, ui.lyrics);

    // --- status ---
    ui.hint = h('div', { class: 'hint' });
    ui.chips = h('div', { class: 'chips' });
    ui.count = h('div', { class: 'count' });
    const status = h('div', { class: 'status' }, ui.hint, ui.chips, ui.count);

    ui.help = buildHelp();
    const resize = h('div', { class: 'resize', title: 'Drag up or down to make the wave bigger or smaller' });
    // Right above the wave: play, A / B and the loop buttons, close to your hand.
    const transport = h('div', { class: 'row bar transport' },
      h('div', { class: 'group' }, ui.backBtn, ui.playBtn, ui.fwdBtn),
      h('div', { class: 'group' }, ui.loopBtn, ui.undoBtn, ui.clearBtn),
      h('div', { class: 'group' }, ui.aMark, ui.bMark),
      buildBeatGroup());
    ui.panel = h('div', { class: 'panel' }, resize, bar, ui.trainerRow, ui.settingsRow, transport, ui.stage, status, ui.help);
    shadow.appendChild(ui.panel);

    setupResize(resize);
    setupCanvas();
    (document.body || document.documentElement).appendChild(hostEl);
    new ResizeObserver(() => (S.dirty = true)).observe(ui.waveWrap);
    new ResizeObserver(() => {
      updateBodyPad();
      layoutLyrics();
    }).observe(hostEl);
  }

  function step(e) {
    if (TOUCH) return TOUCH_NUDGE;
    return e && e.shiftKey ? 0.01 : e && e.altKey ? 0.5 : 0.05;
  }

  function buildHelp() {
    const k = (t) => h('kbd', { text: t });
    return h('div', { class: 'help', hidden: true },
      btn(null, 'Close help', () => toggleHelp(false), 'icon close', 'close'),
      h('h3', { text: 'How to use Wave Looper' }),
      h('ol', {},
        ...(TOUCH ? [
          h('li', {}, h('b', { text: 'Move the song like a DJ: ' }), 'slide your finger on the wave and the song moves with it. A quick tap on the wave pauses / plays. Double-tap the wave to set A there, double-tap again to set B.'),
          h('li', {}, h('b', { text: 'Make a loop: ' }), `like a DJ app: tap the wave to stop, drag the wave to where the part starts and tap A, drag on to where it ends and tap B. It loops. (Or double-tap the wave at the start, then at the end.) Drag the green A / red B flags anywhere, or use ‹ › to move them by ${TOUCH_NUDGE} second${TOUCH_NUDGE === 1 ? "" : "s"}. ↺ 5s plays the last 5 seconds again.`),
          h('li', {}, h('b', { text: 'Zoom: ' }), 'pinch the wave with two fingers, or press Zoom in / Whole song. Tap the small map under the wave to jump.'),
          h('li', {}, h('b', { text: 'Practise one line: ' }), 'tap ⟳ at the left of a lyric line: it speeds up from 30% to 100% with the Trainer counts (10, 30 or 50 plays), then 5 or 10 at 100%, and stops. Tap ⟳ again to stop early.'),
          h('li', {}, h('b', { text: 'Practice the whole song: ' }), 'tap Practice (top right of the lyrics): each part (verse, chorus, bridge…) speeds up from 30% to 100%, then plays at full speed, then the next part. At the end the whole song plays once, then it stops. ▶ during a rest starts the next part now.'),
          h('li', {}, h('b', { text: 'Loop from the lyrics: ' }), 'tap A at the right of the first line, then B on the last line: those lines loop and the Trainer starts.'),
          h('li', {}, h('b', { text: 'Chords: ' }), 'tap Chords, then Find on Ultimate Guitar. On the chords page select all and Copy, come back and tap Paste. The chords sit over the right words; ♭ ♯ transpose. Timing: ◀ ▶ move the lyrics by 0.1 s.'),
        ] : [
          h('li', {}, h('b', { text: 'Like a DJ deck: ' }), 'drag the wave and the song moves with it; a click stops / plays. Double-click for A, double-click again for B: it loops. Shift+drag draws a loop. (Turn off "DJ mouse" in ⚙ to click the start and the end instead.)'),
          h('li', {}, h('b', { text: 'Beats: ' }), 'the tempo (BPM) and every beat are found by themselves: 1 2 3 4 on the wave. Q snaps A and B to the beat; 1 2 4 8 16 loop that many beats; C1–C4 are hot cues (click to set, click to jump, Shift-click to clear). Drums shows kick, snare and hi-hats.'),
          h('li', {}, h('b', { text: 'Fine-tune: ' }), 'drag the green A or red B flag. Use the ‹ › buttons to move them by 0.05s (Shift = 0.01s, Alt = 0.5s). Scroll on the wave to zoom in.'),
        ]),
        h('li', {}, h('b', { text: 'Slow down: ' }), 'press 30%, 50%, 75% or 100%, or use − / + for 5% steps. The key stays the same. While the Trainer runs, a slower speed steps it back so you get those loops again.'),
        h('li', {}, h('b', { text: 'Speed trainer: ' }), 'tap Trainer and it starts right away: slow (30%, 50% or 75%), a little faster every loop, up to 100% over 10, 30 or 50 loops, then 5 or 10 times at 100% and it stops. Tap Trainer again to stop and go back to normal speed.'),
        h('li', {}, h('b', { text: 'Jump around: ' }), 'click the time ruler at the top of the wave.'),
        h('li', {}, h('b', { text: 'Bigger wave: ' }), 'press the ↕ buttons, or drag the top edge of the panel up.')),
      TOUCH ? null : h('ul', {},
        h('li', {}, k('['), ' set start here   ', k(']'), ' set end here   ', k('\\'), ' loop on/off   ', k('Esc'), ' cancel a half-made loop'),
        h('li', {}, k('Alt'), '+', k('L'), ' open or close the looper. Space and the arrow keys still control YouTube.'),
        h('li', {}, 'Your loops and speed are saved for each video. "Pause between loops" in ⚙ gives you time to breathe.')));
  }

  function toggleHelp(force) {
    const show = force != null ? force : ui.help.hidden;
    ui.help.hidden = !show;
    if (show && !settings.seenHelp) {
      settings.seenHelp = true;
      saveSettings();
    }
  }

  function toggleSub(which) {
    const row = which === 'trainer' ? ui.trainerRow : ui.settingsRow;
    row.hidden = !row.hidden;
    if (settings.collapsed && !row.hidden) toggleCollapse();
    applyLayout();
    renderUI();
    S.dirty = true;
  }

  function toggleCollapse() {
    settings.collapsed = !settings.collapsed;
    saveSettings();
    applyLayout();
    renderUI();
  }

  // settings.height is the height of the wave area; the rows around it add to it.
  function maxWaveHeight() {
    return Math.max(160, window.innerHeight * 0.75);
  }

  function waveHeight() {
    const vh = window.innerHeight;
    // Touch screens: the whole panel takes the bottom half of the screen
    // (lyrics fill the top half). Elsewhere a smaller wave.
    const def = TOUCH
      ? Math.round(vh * 0.5 - (S.chromeH || 200))
      : Math.round(vh * (window.innerWidth < 600 || vh < 900 ? 0.22 : 0.3));
    const want = settings.height || def;
    return Math.round(C.clamp(want, 90, maxWaveHeight()));
  }

  function resizeWave(delta) {
    settings.height = Math.round(C.clamp(waveHeight() + delta, 90, maxWaveHeight()));
    saveSettings();
    if (settings.collapsed) toggleCollapse();
    else applyLayout();
    renderUI();
  }

  function panelHeight() {
    return hostEl && hostEl.style.display !== 'none' ? Math.ceil(hostEl.getBoundingClientRect().height) : 0;
  }

  function bottomOffset() {
    if (!IS_MUSIC) return 0;
    const bar = document.querySelector('ytmusic-player-bar');
    if (!bar) return 0;
    const r = bar.getBoundingClientRect();
    return r.height > 0 && r.top < window.innerHeight ? Math.max(0, window.innerHeight - r.top) : 0;
  }

  function applyLayout() {
    if (!hostEl) return;
    ui.panel.classList.toggle('collapsed', settings.collapsed);
    ui.lyrics.hidden = !settings.lyrics;
    const besideOnPhone = settings.lyrics && !lyricsOnTop() && window.innerWidth < 600;
    ui.stage.style.height = waveHeight() + (besideOnPhone ? LYRICS_PHONE_H : 0) + 'px';
    // Measure the rows around the wave so the touch default really is half the screen.
    if (hostVisible() && !settings.collapsed) {
      const chrome = Math.round(hostEl.getBoundingClientRect().height - ui.stage.getBoundingClientRect().height);
      if (chrome > 0 && Math.abs(chrome - (S.chromeH || 0)) > 2) {
        S.chromeH = chrome;
        ui.stage.style.height = waveHeight() + (besideOnPhone ? LYRICS_PHONE_H : 0) + 'px';
      }
    }
    hostEl.style.bottom = bottomOffset() + 'px';
    ui.collapseBtn.replaceChildren(icon(settings.collapsed ? 'up' : 'down'));
    ui.collapseBtn.title = settings.collapsed ? 'Expand' : 'Minimise';
    updateBodyPad();
    layoutLyrics();
    S.dirty = true;
  }

  // Let the page scroll above the panel so nothing on YouTube is hidden under it.
  function updateBodyPad() {
    if (IS_MUSIC || !document.body || !hostEl) return;
    const visible = hostEl.style.display !== 'none' && !document.fullscreenElement;
    const want = visible ? panelHeight() + 'px' : '';
    if (document.body.style.paddingBottom !== want) document.body.style.paddingBottom = want;
  }

  function setupResize(handle) {
    let startY = 0;
    let startH = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (settings.collapsed) return;
      startY = e.clientY;
      startH = waveHeight();
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      settings.height = Math.round(C.clamp(startH + (startY - e.clientY), 90, maxWaveHeight()));
      applyLayout();
    });
    handle.addEventListener('pointerup', (e) => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      saveSettings();
    });
  }

  function hostVisible() {
    return !!hostEl && hostEl.style.display !== 'none';
  }

  function updateVisibility() {
    if (!hostEl) return;
    const show = settings.open && !!S.vid && onWatchSurface();
    const was = hostEl.style.display !== 'none';
    if (show !== was) {
      hostEl.style.display = show ? 'block' : 'none';
      applyLayout();
      if (show) {
        S.dirty = true;
        renderUI();
        maybeAutoScan();
      }
    } else if (show) {
      const off = bottomOffset() + 'px';
      if (hostEl.style.bottom !== off) hostEl.style.bottom = off;
    }
    // Keep the panel visible in fullscreen by moving it into the fullscreen element.
    const fs = document.fullscreenElement;
    const parent = fs && fs !== document.documentElement ? fs : document.body || document.documentElement;
    if (hostEl.parentNode !== parent) {
      parent.appendChild(hostEl);
      applyLayout();
    }
    updateYTButton();
  }

  function openPanel() {
    settings.open = true;
    saveSettings();
    if (!hostEl) buildPanel();
    updateVisibility();
    if (!settings.seenHelp && S.vid) toggleHelp(true);
  }

  function closePanel() {
    settings.open = false;
    saveSettings();
    stopLineLoop(true);
    if (S.scan) endScan('cancel');
    stopTrainer(true);
    clearTimeout(S.gapTimer);
    S.wrapping = false;
    S.loopOn = false;
    S.pendingA = null;
    if (S.rate !== 1 || S.rateOwned) {
      S.rate = 1;
      S.rateOwned = false;
      applyRate();
    }
    saveVideoStateNow();
    updateVisibility();
    renderUI();
  }

  function togglePanel() {
    if (settings.open && hostEl && hostEl.style.display !== 'none') closePanel();
    else openPanel();
  }

  // ---------------------------------------------------------------------------
  // YouTube player button
  // ---------------------------------------------------------------------------
  function updateYTButton() {
    updatePlayerButton();
    updateBelowVideoButton();
    updateFloatingButton();
  }

  // Phones and tablets: a round floating button, since YouTube's mobile site
  // has no control bar we can add to.
  let fab = null;
  function updateFloatingButton() {
    const want = TOUCH && !!S.vid && onWatchSurface() && !hostVisible();
    if (!want) {
      if (fab) fab.style.display = 'none';
      return;
    }
    if (!fab) {
      fab = document.createElement('button');
      fab.className = 'ytl-fab';
      fab.type = 'button';
      fab.title = 'Wave Looper';
      fab.setAttribute('aria-label', 'Open Wave Looper');
      fab.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:calc(84px + env(safe-area-inset-bottom, 0px))', 'z-index:2147481999',
        'width:56px', 'height:56px', 'border-radius:28px', 'border:2px solid #19d3ff', 'padding:0',
        'background:#0b0e14', 'box-shadow:0 6px 20px rgba(0,0,0,.5)', 'display:flex', 'align-items:center',
        'justify-content:center', 'cursor:pointer', '-webkit-tap-highlight-color:transparent',
      ].join(';');
      const svg = icon('wave');
      svg.setAttribute('width', '28');
      svg.setAttribute('height', '28');
      svg.style.fill = '#19d3ff';
      fab.appendChild(svg);
      fab.addEventListener('click', (e) => {
        e.stopPropagation();
        openPanel();
      });
    }
    if (fab.parentNode !== document.body && document.body) document.body.appendChild(fab);
    fab.style.display = 'flex';
  }

  // A labelled pill under the video, next to Like / Share (www.youtube.com).
  function updateBelowVideoButton() {
    if (IS_MUSIC) return;
    const row = document.querySelector('ytd-watch-metadata #actions-inner') ||
      document.querySelector('ytd-watch-metadata #actions') ||
      document.querySelector('#info #menu-container');
    if (!row) return;
    let b = row.querySelector(':scope > .ytl-below-btn');
    if (!b) {
      b = document.createElement('button');
      b.className = 'ytl-below-btn';
      b.type = 'button';
      b.title = 'Open the Wave Looper: DJ waveform, A-B loop and speed (Alt+L)';
      b.style.cssText = [
        'display:inline-flex', 'align-items:center', 'gap:6px', 'flex:none',
        'height:36px', 'padding:0 16px 0 12px', 'margin-right:8px', 'border-radius:18px', 'border:0',
        'cursor:pointer', 'font:500 14px/36px Roboto, Arial, sans-serif', 'white-space:nowrap',
        'background:var(--yt-spec-badge-chip-background, rgba(255,255,255,0.1))',
        'color:var(--yt-spec-text-primary, #f1f1f1)',
      ].join(';');
      const svg = icon('wave');
      svg.setAttribute('width', '22');
      svg.setAttribute('height', '22');
      b.append(svg, document.createTextNode('Wave Looper'));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel();
      });
      row.insertBefore(b, row.firstChild);
    }
    const on = settings.open && hostVisible();
    const svg = b.querySelector('svg');
    if (svg) svg.style.fill = on ? '#19d3ff' : 'currentColor';
    b.style.boxShadow = on ? 'inset 0 0 0 2px #19d3ff' : 'none';
  }

  function updatePlayerButton() {
    const ctr = document.querySelector('#movie_player .ytp-right-controls') ||
      (IS_MUSIC ? document.querySelector('ytmusic-player-bar .right-controls-buttons') : null);
    if (!ctr) return;
    let b = ctr.querySelector('.ytl-yt-btn');
    if (!b) {
      b = document.createElement('button');
      b.className = IS_MUSIC ? 'ytl-yt-btn' : 'ytp-button ytl-yt-btn';
      b.type = 'button';
      b.title = 'Wave Looper (Alt+L)';
      b.setAttribute('aria-label', 'Wave Looper');
      b.style.cssText = IS_MUSIC
        ? 'background:none;border:0;cursor:pointer;width:40px;height:40px;padding:8px;color:#fff;'
        : 'display:inline-flex;align-items:center;justify-content:center;vertical-align:top;';
      const svg = icon('wave');
      svg.setAttribute('width', IS_MUSIC ? '24' : '60%');
      svg.setAttribute('height', IS_MUSIC ? '24' : '60%');
      svg.style.fill = '#fff';
      b.appendChild(svg);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel();
      });
      ctr.insertBefore(b, ctr.firstChild);
    }
    const on = settings.open;
    const svg = b.querySelector('svg');
    if (svg) svg.style.fill = on ? '#19d3ff' : '#fff';
  }

  // ---------------------------------------------------------------------------
  // Rendering the controls
  // ---------------------------------------------------------------------------
  function flash(msg, ms = 3500) {
    S.hintOverride = msg;
    S.hintUntil = now() + ms;
    renderUI();
  }

  function setHint(parts) {
    ui.hint.replaceChildren(...parts.map((p) => (Array.isArray(p) ? h('b', { text: p[0] }) : document.createTextNode(p))));
  }

  function renderUI() {
    if (!hostEl) return;
    const F = C.formatTime;
    const pending = S.pendingA != null;
    ui.aTime.textContent = pending ? F(S.pendingA) : S.a != null ? F(S.a) : '--:--.--';
    ui.bTime.textContent = !pending && S.b != null ? F(S.b) : '--:--.--';
    ui.aMark.classList.toggle('pending', pending);
    ui.loopBtn.classList.toggle('on', S.loopOn && hasLoop());
    ui.loopBtn.disabled = !hasLoop();
    ui.clearBtn.disabled = !hasLoop() && !pending;
    ui.undoBtn.disabled = !S.history.length;
    ui.zoomLoopBtn.disabled = !hasLoop();
    const zoomed = !!S.view;
    ui.zoomBtn.classList.toggle('on', zoomed);
    ui.zoomBtn.replaceChildren(icon(zoomed ? 'fit' : 'zoom'), zoomed ? 'Whole song' : 'Zoom in');
    ui.zoomBtn.title = zoomed ? 'Show the whole song' : ZOOM_IN_TITLE;
    ui.zoomBtn.disabled = !dur();
    if (ui.biggerBtn) {
      const wh = waveHeight();
      ui.biggerBtn.disabled = !settings.collapsed && wh >= maxWaveHeight() - 1;
      ui.smallerBtn.disabled = settings.collapsed || wh <= 91;
    }
    for (const [i, r] of SPEED_PRESETS.entries()) ui.speedBtns[i].classList.toggle('on', Math.abs(S.rate - r) < 0.001);
    ui.rate.textContent = `${Math.round(S.rate * 100)}%`;
    const playing = !!S.video && !S.video.paused && !S.scan;
    for (const b of [ui.playBtn]) {
      b.replaceChildren(icon(playing ? 'pause' : 'play'));
      b.title = playing ? 'Pause' : 'Play';
      b.classList.toggle('on', playing);
      b.disabled = !S.video || !!S.scan;
    }
    ui.lyricsBtn.classList.toggle('on', settings.lyrics);
    ui.trainerBtn.classList.toggle('on', S.trainer.running);
    if (ui.practiceBtn) ui.practiceBtn.classList.toggle('on', PR.on);
    ui.trainerBtn.title = S.trainer.running
      ? 'Stop the speed trainer (back to normal speed)'
      : 'Speed trainer: tap to start (slow, then faster every loop up to 100%); tap again to stop';
    ui.gearBtn.classList.toggle('on', !ui.settingsRow.hidden);

    // Trainer
    const tr = S.trainer;
    if (tr.running) {
      const total = tr.reps + tr.after;
      ui.tBar.style.width = `${Math.round((Math.min(tr.rep, total) / total) * 100)}%`;
      let label;
      if (tr.rep <= tr.reps) label = `Speeding up: ${tr.rep} of ${tr.reps} at `;
      else label = `Full speed: ${tr.rep - tr.reps} of ${tr.after} at `;
      ui.tStat.replaceChildren(label, h('b', { text: `${Math.round(S.rate * 100)}%` }));
    } else {
      ui.tBar.style.width = '0%';
      const s = settings.trainerStart, g = TRAINER_GOAL, n = settings.trainerReps;
      const stepPct = n > 1 ? (g - s) / (n - 1) : 0;
      const a = trainerAfter(n);
      ui.tStat.textContent = `${s}% → ${g}% (+${Math.max(0, stepPct).toFixed(1)}% per loop)` +
        (a ? `, then ${a}× at ${g}% and stop` : '');
    }

    // Settings
    ui.rescanBtn.disabled = !!S.scan || !dur();

    // Hint line
    if (S.hintOverride && now() < S.hintUntil) {
      setHint([S.hintOverride]);
    } else if (PR.on && PR.final) {
      setHint([['Practice: '], 'the whole song once at 100%, then it stops. Tap Practice to stop now.']);
    } else if (PR.on && PR.restUntil && PR.parts[PR.pos]) {
      const left = Math.max(0, Math.ceil((PR.restUntil - now()) / 1000));
      setHint([['Practice · rest '], `${left} s. Next: ${PR.parts[PR.pos].name}. Press ▶ to start now.`]);
    } else if (S.lineLoop && L.lines && L.lines[S.lineLoop.idx]) {
      const ll = S.lineLoop;
      const stage = ll.rep <= ll.ramp ? `speeding up ${ll.rep}/${ll.ramp}` : `full speed ${ll.rep - ll.ramp}/${ll.full}`;
      const what = PR.on && PR.parts[PR.pos] ? `${PR.parts[PR.pos].name} (part ${PR.pos + 1} of ${PR.parts.length})` : `“${L.lines[ll.idx].text || '♪'}”`;
      setHint([[PR.on ? 'Practice: ' : 'Practising one line: '], `${what} · ${stage} at ${Math.round(S.rate * 100)}%. ${PR.on ? 'Tap Practice to stop.' : 'Tap ⟳ again to stop.'}`]);
    } else if (S.scan) {
      setHint(['Reading the whole song… it plays muted for a moment, then goes back to where you were.']);
    } else if (!dur()) {
      setHint(['Waiting for the video…']);
    } else if (pending) {
      setHint(TOUCH ? [['A is set. Move to where the loop ends and tap B'], ' (or double-tap the wave there).']
        : settings.mouseDJ ? [['A is set. Double-click where the loop should END'], ' (or press B / ]). Esc cancels.'] : [['Now click where the loop should END'], '  (Esc to cancel)']);
    } else if (hasLoop()) {
      const len = S.b - S.a;
      setHint([
        [S.loopOn ? 'Looping ' : 'Loop off: '],
        `${F(S.a)} → ${F(S.b)} (${len.toFixed(2)}s)`,
        TOUCH ? '. Drag the flags, press A / B, or double-tap for a new loop. Pinch to zoom.' : '. Drag the A/B flags to adjust. Scroll to zoom.',
      ]);
    } else {
      setHint(TOUCH
        ? [['Tap the wave'], ' to stop / play, ', ['drag it'], ' to move the song. Tap ', ['A'], ' where the loop starts, ', ['B'], ' where it ends.']
        : settings.mouseDJ ? [['Click the wave'], ' to stop / play, ', ['drag it'], ' to move the song, ', ['double-click'], ' for A, then B. Shift+drag draws a loop. ', ['Q'], ' snaps to the beat.']
        : [['Click the wave to set the loop START'], ', then click the END. Or drag across a part. Click the time ruler to jump.']);
    }

    // Saved loops
    renderChips();
    ui.count.replaceChildren(hasLoop() ? 'Repeats ' : '', hasLoop() ? h('b', { text: String(S.reps) }) : '');

    renderScanOverlay();

    // Test and debug hooks: plain data on the host element.
    const d = hostEl.dataset;
    d.vid = S.vid || '';
    d.a = S.a != null ? S.a.toFixed(3) : '';
    d.b = S.b != null ? S.b.toFixed(3) : '';
    d.pending = pending ? S.pendingA.toFixed(3) : '';
    d.loop = String(S.loopOn && hasLoop());
    d.rate = String(S.rate);
    d.reps = String(S.reps);
    d.trainer = tr.running ? `${tr.rep}/${tr.reps}` : '';
    d.scanning = String(!!S.scan);
    d.cov = dur() ? S.peaks.coverage(dur()).toFixed(3) : '0';
    d.zoom = S.view ? (S.view.e - S.view.s).toFixed(2) : '';
    d.lineLoop = S.lineLoop ? `${S.lineLoop.a.toFixed(2)},${S.lineLoop.b.toFixed(2)}` : '';
    d.lineRep = S.lineLoop ? String(S.lineLoop.rep) : '';
    markLyricsAB();
    d.abStart = L.abStart == null ? '' : String(L.abStart);
    renderBeats();
    d.bpm = S.grid ? String(S.grid.bpm) : '';
    // Debug only: the wave's band data, to tune the drum analysis.
    if (document.documentElement.dataset.ytlDebug === '1' && S.gridBase && !document.documentElement.dataset.ytlPeaks) {
      const P = S.peaks;
      document.documentElement.dataset.ytlPeaks = JSON.stringify({ n: P.n, peak: Array.from(P.peak.subarray(0, P.n)), low: Array.from(P.low.subarray(0, P.n)), mid: Array.from(P.mid.subarray(0, P.n)), high: Array.from(P.high.subarray(0, P.n)), cov: Array.from(P.cov.subarray(0, P.n)) });
    }
    d.beats = S.grid ? String(S.grid.beats.length) : '';
    d.bar1 = S.grid ? C.beatTime(S.grid.beats, S.grid.first).toFixed(3) : '';
    d.quant = settings.quantize ? 'on' : '';
    d.cues = S.cues.map((c) => (c == null ? '' : c.toFixed(3))).join(',');
    d.mouse = settings.mouseDJ ? 'dj' : 'classic';
    d.waveStyle = settings.waveStyle;
    d.hits = S.gridBase && S.gridBase.hits ? ['kick', 'snare', 'hat'].map((k) => S.gridBase.hits.filter((x) => x.kind === k).length).join(',') : '';
    d.practice = !PR.on ? '' : PR.final ? 'final' : PR.restUntil ? `rest:${PR.pos}` : `part:${PR.pos}`;
    d.sections = L.sections.map((x) => `${x.name}@${x.i0}`).join('|');
    d.chords = CH.map ? String(CH.map.filter((x) => x.chords.length).length) : '';
    d.hq = HQ.failed ? 'failed' : HQ.mode;
    if (document.documentElement.dataset.ytlDebug === '1') d.hqHz = String(hqPeakHz());
    d.view = S.view ? `${S.view.s.toFixed(3)},${S.view.e.toFixed(3)}` : '';
  }

  let chipsKey = '';
  function renderChips() {
    const key = JSON.stringify([S.saved, hasLoop() && [S.a, S.b]]);
    if (key === chipsKey) return;
    chipsKey = key;
    const kids = S.saved.map((s, i) => {
      const active = hasLoop() && Math.abs(s.a - S.a) < 0.005 && Math.abs(s.b - S.b) < 0.005;
      const name = h('button', {
        title: `${C.formatTime(s.a)} → ${C.formatTime(s.b)}. Click to loop, double-click to rename.`,
        text: s.name,
        onclick: () => setLoop(s.a, s.b, { play: true, fresh: true }),
        ondblclick: () => {
          const n = window.prompt('Name this loop', s.name);
          if (n && n.trim()) {
            s.name = n.trim().slice(0, 30);
            chipsKey = '';
            saveVideoStateSoon();
            renderUI();
          }
        },
      });
      const x = h('button', {
        class: 'x', title: 'Delete this saved loop', text: '×',
        onclick: () => { S.saved.splice(i, 1); saveVideoStateSoon(); renderUI(); },
      });
      return h('span', { class: 'chip' + (active ? ' active' : '') }, name, x);
    });
    if (hasLoop()) {
      kids.push(h('span', { class: 'chip add' }, h('button', {
        title: 'Save this loop so you can come back to it (e.g. Verse, Chorus)',
        text: '+ Save loop',
        onclick: () => {
          S.saved.push({ name: `Part ${S.saved.length + 1}`, a: S.a, b: S.b });
          saveVideoStateSoon();
          renderUI();
        },
      })));
    }
    ui.chips.replaceChildren(...kids);
  }

  function renderScanOverlay() {
    if (!hostEl) return;
    const d = dur();
    const cov = d ? S.peaks.coverage(d) : 0;
    if (S.scan) {
      ui.overlay.hidden = false;
      ui.scanText.textContent = `Reading the whole song… ${Math.floor(cov * 100)}%`;
      ui.scanBtn.hidden = true;
      ui.cancelBtn.hidden = false;
    } else if (d && cov < 0.9 && !S.noHook && !isAd()) {
      ui.overlay.hidden = false;
      ui.scanText.textContent = cov > 0 ? `Wave ${Math.floor(cov * 100)}% loaded` : 'No wave yet';
      ui.scanBtn.hidden = false;
      ui.cancelBtn.hidden = true;
    } else if (d && S.noHook && cov < 0.05) {
      ui.overlay.hidden = false;
      ui.scanText.textContent = 'Play the song and the wave draws itself';
      ui.scanBtn.hidden = true;
      ui.cancelBtn.hidden = true;
    } else {
      ui.overlay.hidden = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Waveform canvas
  // ---------------------------------------------------------------------------
  const RULER = 18;
  const MINI = 12;
  const HANDLE_PX = 8;
  const layers = { key: '', bright: null, dim: null, mini: null };
  const pointer = { x: -1, y: -1, inside: false };
  let drag = null;

  function geom() {
    const r = ui.canvas.getBoundingClientRect();
    const zoomed = !!S.view;
    const miniH = zoomed ? MINI : 0;
    return { w: r.width, h: r.height, left: r.left, top: r.top, waveTop: RULER, waveH: Math.max(10, r.height - RULER - miniH), miniH, zoomed };
  }

  function viewRange() {
    const d = dur();
    if (S.view && d) return { s: S.view.s, e: Math.min(S.view.e, d) };
    return { s: 0, e: d || 1 };
  }

  function timeAt(x, g) {
    const { s, e } = viewRange();
    return C.clamp(s + (x / g.w) * (e - s), 0, dur() || 0);
  }

  function xAt(t, g) {
    const { s, e } = viewRange();
    return ((t - s) / (e - s)) * g.w;
  }

  function setView(s, e, quiet) {
    const d = dur();
    if (!d) return;
    let len = C.clamp(e - s, Math.min(1, d), d);
    if (len >= d - 1e-6) {
      S.view = null;
    } else {
      s = C.clamp(s, 0, d - len);
      S.view = { s, e: s + len };
    }
    S.dirty = true;
    if (!quiet) renderUI();
  }

  function fitView() {
    S.view = null;
    if (settings.zoomFocus) {
      settings.zoomFocus = false;
      saveSettings();
    }
    S.dirty = true;
    renderUI();
  }

  const ZOOM_IN_TITLE = 'Zoom in: show only the part that is playing now (about 30 s); the wave scrolls with the song';

  // The "Zoom in" window: 30 s, or half the song if it is short.
  function focusLen() {
    const d = dur();
    return Math.max(2, Math.min(settings.focusLen || 30, d >= 60 ? d : d * 0.5));
  }

  function toggleZoom() {
    if (S.view) return fitView();
    const d = dur();
    if (!d) return;
    settings.zoomFocus = true;
    settings.focusLen = 30;
    saveSettings();
    S.lastViewTouch = 0;
    focusFollow(true);
    renderUI();
  }

  // Keeps the playhead about a quarter of the way in, so you see what's coming.
  // The DJ deck feel (wave slides under a fixed playhead, drag moves the song):
  // always on touch screens, and on a computer with the DJ mouse on.
  function djDeck() {
    return TOUCH || !!settings.mouseDJ;
  }

  function focusFollow(force) {
    if (!settings.zoomFocus || !S.video || (drag && drag.mode !== 'scrub')) return;
    const d = dur();
    if (!d) return;
    const len = Math.min(focusLen(), d);
    if (len >= d) return;
    if (!force && now() - S.lastViewTouch < (djDeck() ? 600 : 2000)) return;
    const t = drag && drag.mode === 'scrub' && drag.t != null ? drag.t : S.video.currentTime;
    // DJ deck: the playhead stays in the middle and the wave moves.
    if (!force && S.view && !djDeck()) {
      const { s, e } = viewRange();
      // While looping a part that fits on screen, hold still on it.
      if (S.loopOn && hasLoop() && S.a >= s && S.b <= e && S.b - S.a < len) return;
      if (S.video.paused && t >= s && t <= e) return;
    }
    const s0 = t - len * (djDeck() ? 0.5 : 0.25);
    const was = S.view;
    setView(s0, s0 + len, true);
    if (!was !== !S.view) renderUI();
  }

  function zoomToLoop() {
    if (!hasLoop()) return;
    const len = S.b - S.a;
    const pad = Math.max(0.25, len * 0.12);
    setView(S.a - pad, S.b + pad);
  }

  function drawLayers(g, dpr) {
    const W = Math.max(1, Math.round(g.w * dpr));
    const H = Math.max(1, Math.round(g.waveH * dpr));
    const { s, e } = viewRange();
    const key = [W, H, s.toFixed(4), e.toFixed(4), S.peaks.version, S.peaks.n, g.miniH, settings.waveStyle].join('|');
    if (key === layers.key) return;
    layers.key = key;
    for (const k of ['bright', 'dim']) {
      if (!layers[k]) layers[k] = document.createElement('canvas');
      layers[k].width = W;
      layers[k].height = H;
    }
    const P = S.peaks;
    const br = P.binRate;
    const norm = P.maxPeak > 0 ? 1 / P.maxPeak : 0;
    const mid = H / 2;
    const amp = mid - 2 * dpr;
    const bctx = layers.bright.getContext('2d');
    const dctx = layers.dim.getContext('2d');
    bctx.clearRect(0, 0, W, H);
    dctx.clearRect(0, 0, W, H);
    const span = e - s;
    // Per column: peak (outer shape), body (average loudness) and colour.
    // Zoomed in, a bin covers several pixels: interpolate so the outline is
    // smooth instead of blocky.
    const pkA = new Float32Array(W);
    const avA = new Float32Array(W);
    const col = new Array(W);
    const binAt = (arr, f) => {
      const b = Math.floor(f);
      const fr = f - b;
      const a0 = P.cov[b] ? arr[b] : 0;
      const a1 = b + 1 < P.n && P.cov[b + 1] ? arr[b + 1] : a0;
      return a0 + (a1 - a0) * fr;
    };
    const perCol = (span * br) / W;
    for (let x = 0; x < W; x++) {
      const t0 = s + (x / W) * span;
      const t1 = s + ((x + 1) / W) * span;
      if (perCol < 1) {
        const f = Math.max(0, Math.min(P.n - 1, (t0 + t1) * 0.5 * br - 0.5));
        if (!P.cov[Math.floor(f)]) {
          col[x] = null;
          continue;
        }
        const pk = binAt(P.peak, f);
        pkA[x] = pk;
        avA[x] = pk * 0.62;
        col[x] = C.bandColor(binAt(P.low, f), binAt(P.mid, f), binAt(P.high, f));
        continue;
      }
      const b0 = Math.floor(t0 * br);
      const b1 = Math.min(P.n, Math.max(b0 + 1, Math.floor(t1 * br)));
      let pk = 0, sum = 0, lo = 0, mi = 0, hi = 0, c = 0;
      for (let b = b0; b < b1; b++) {
        if (!P.cov[b]) continue;
        const v = P.peak[b];
        if (v > pk) pk = v;
        sum += v;
        lo += P.low[b];
        mi += P.mid[b];
        hi += P.high[b];
        c++;
      }
      if (!c) {
        col[x] = null;
        continue;
      }
      pkA[x] = pk;
      avA[x] = (sum / c) * 0.8;
      col[x] = C.bandColor(lo / c, mi / c, hi / c);
    }
    const shape = (v) => Math.max(dpr * 0.75, Math.pow(v * norm, 0.8) * amp);
    if (settings.waveStyle === 'drums') drawDrumColumns(bctx, dctx, W, H, s, span, dpr);
    else for (let x = 0; x < W; x++) {
      const cc = col[x];
      if (!cc) {
        bctx.fillStyle = 'rgba(140,150,170,0.16)';
        bctx.fillRect(x, mid - dpr * 0.5, 1, dpr);
        dctx.fillStyle = 'rgba(140,150,170,0.10)';
        dctx.fillRect(x, mid - dpr * 0.5, 1, dpr);
        continue;
      }
      const [r, gg, bb] = cc;
      const ho = shape(pkA[x]);
      const hi2 = Math.min(ho, shape(avA[x]));
      // Coming up: full colour, a soft outer peak and a bright body.
      bctx.fillStyle = `rgba(${r},${gg},${bb},0.5)`;
      bctx.fillRect(x, mid - ho, 1, ho * 2);
      bctx.fillStyle = `rgb(${Math.min(255, r + 28)},${Math.min(255, gg + 28)},${Math.min(255, bb + 28)})`;
      bctx.fillRect(x, mid - hi2, 1, hi2 * 2);
      // Already played: greyed, like a DJ deck.
      const gr = Math.round((r + gg + bb) / 3);
      const mix = (c) => Math.round(c * 0.45 + gr * 0.55);
      dctx.fillStyle = `rgba(${mix(r)},${mix(gg)},${mix(bb)},0.30)`;
      dctx.fillRect(x, mid - ho, 1, ho * 2);
      dctx.fillStyle = `rgba(${mix(r)},${mix(gg)},${mix(bb)},0.55)`;
      dctx.fillRect(x, mid - hi2, 1, hi2 * 2);
    }
    // Light in the middle, fading to the edges: gives the wave depth.
    for (const ctx2 of [bctx, dctx]) {
      ctx2.globalCompositeOperation = 'source-atop';
      const gr = ctx2.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, 'rgba(0,0,0,0.45)');
      gr.addColorStop(0.42, 'rgba(255,255,255,0.06)');
      gr.addColorStop(0.5, 'rgba(255,255,255,0.12)');
      gr.addColorStop(0.58, 'rgba(255,255,255,0.06)');
      gr.addColorStop(1, 'rgba(0,0,0,0.45)');
      ctx2.fillStyle = gr;
      ctx2.fillRect(0, 0, W, H);
      ctx2.globalCompositeOperation = 'source-over';
    }
    bctx.fillStyle = 'rgba(255,255,255,0.08)';
    bctx.fillRect(0, mid - dpr * 0.5, W, dpr);

    // Mini map of the whole song when zoomed.
    if (g.miniH) {
      const MW = W;
      const MH = Math.max(1, Math.round(g.miniH * dpr));
      if (!layers.mini) layers.mini = document.createElement('canvas');
      layers.mini.width = MW;
      layers.mini.height = MH;
      const m = layers.mini.getContext('2d');
      m.clearRect(0, 0, MW, MH);
      const d = dur();
      for (let x = 0; x < MW; x++) {
        const b0 = Math.floor(((x / MW) * d) * br);
        const b1 = Math.min(P.n, Math.max(b0 + 1, Math.floor((((x + 1) / MW) * d) * br)));
        let pk = 0;
        for (let b = b0; b < b1; b++) if (P.cov[b] && P.peak[b] > pk) pk = P.peak[b];
        const hh = Math.max(1, pk * norm * (MH - 2));
        m.fillStyle = 'rgba(160,175,200,0.55)';
        m.fillRect(x, MH - hh, 1, hh);
      }
    }
  }

  // Drum view: the three bands drawn on top of each other, like a DJ deck's
  // 3-band wave. Kick and bass (low) in red, the middle in amber, snare and
  // hi-hats (high) in ice white, each scaled to its own loudest moment, so a
  // quiet hi-hat still shows next to a loud kick.
  function drawDrumColumns(bctx, dctx, W, H, s, span, dpr) {
    const P = S.peaks;
    const br = P.binRate;
    if (layers.bandMaxVer !== P.version) {
      let ml = 1;
      let mm = 1;
      let mh = 1;
      for (let i = 0; i < P.n; i++) {
        if (!P.cov[i]) continue;
        if (P.low[i] > ml) ml = P.low[i];
        if (P.mid[i] > mm) mm = P.mid[i];
        if (P.high[i] > mh) mh = P.high[i];
      }
      layers.bandMax = [ml, mm, mh];
      layers.bandMaxVer = P.version;
    }
    const [ml, mm, mh] = layers.bandMax;
    const mid = H / 2;
    const amp = mid - 2 * dpr;
    // Below the quiet floor of each band nothing is drawn, so hits stand out.
    const lift = (v, m) => Math.max(0, (v / m - 0.12) / 0.88);
    const bands = [
      { arr: P.low, m: ml, col: [255, 84, 54], a: 0.95, k: 1.0 },
      { arr: P.mid, m: mm, col: [255, 183, 77], a: 0.6, k: 0.78 },
      { arr: P.high, m: mh, col: [205, 240, 255], a: 0.95, k: 0.62 },
    ];
    for (let x = 0; x < W; x++) {
      const t0 = s + (x / W) * span;
      const t1 = s + ((x + 1) / W) * span;
      const b0 = Math.floor(t0 * br);
      const b1 = Math.min(P.n, Math.max(b0 + 1, Math.floor(t1 * br)));
      let covered = false;
      const vals = [0, 0, 0];
      for (let b = b0; b < b1; b++) {
        if (!P.cov[b]) continue;
        covered = true;
        if (P.low[b] > vals[0]) vals[0] = P.low[b];
        if (P.mid[b] > vals[1]) vals[1] = P.mid[b];
        if (P.high[b] > vals[2]) vals[2] = P.high[b];
      }
      if (!covered) {
        bctx.fillStyle = 'rgba(140,150,170,0.16)';
        bctx.fillRect(x, mid - dpr * 0.5, 1, dpr);
        continue;
      }
      bands.forEach((bd, j) => {
        // The bands are stored compressed; expand them so hits stand out from the rest.
        const h = Math.pow(lift(vals[j], bd.m), 2.2) * amp * bd.k;
        if (h < dpr * 0.5) return;
        const [r, g2, b2] = bd.col;
        bctx.fillStyle = `rgba(${r},${g2},${b2},${bd.a})`;
        bctx.fillRect(x, mid - h, 1, h * 2);
        const gr = Math.round((r + g2 + b2) / 3);
        dctx.fillStyle = `rgba(${Math.round(r * 0.4 + gr * 0.6)},${Math.round(g2 * 0.4 + gr * 0.6)},${Math.round(b2 * 0.4 + gr * 0.6)},${bd.a * 0.45})`;
        dctx.fillRect(x, mid - h, 1, h * 2);
      });
    }
  }

  // Beat grid: bar lines with the bar number, beat lines, and 1 2 3 4 when
  // zoomed in far enough to read them.
  function drawGrid(ctx, g, top, wh) {
    const G = S.grid;
    if (!G) return;
    const { s, e } = viewRange();
    const pxBeat = ((60 / G.bpm) / (e - s)) * g.w;
    if (pxBeat < 2.5) return;
    const B = G.beats;
    ctx.font = '600 10.5px Roboto, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = Math.max(0, C.nearestBeatIndex(B, s) - 1); i < B.length && B[i] <= e + 0.01; i++) {
      const x = Math.round(xAt(B[i], g));
      if (x < -1 || x > g.w + 1) continue;
      const pos = (((i - G.first) % 4) + 4) % 4;
      const bar = Math.floor((i - G.first) / 4) + 1;
      if (pos === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.34)';
        ctx.fillRect(x, top, 1, wh);
        if (pxBeat * 4 >= 22 && bar >= 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.fillText(pxBeat >= 26 ? `${bar}.1` : String(bar), x + 3, top + 3);
        }
      } else if (pxBeat >= 6) {
        ctx.fillStyle = 'rgba(255,255,255,0.11)';
        ctx.fillRect(x, top, 1, wh);
        if (pxBeat >= 26) {
          ctx.fillStyle = 'rgba(255,255,255,0.38)';
          ctx.fillText(String(pos + 1), x + 3, top + 3);
        }
      }
    }
  }

  // Drum lanes under the wave: kick, snare and hi-hat hits, like a drum chart.
  function drawLanes(ctx, g, top, wh) {
    const hits = S.gridBase && S.gridBase.vid === S.vid ? S.gridBase.hits : null;
    if (!hits || !hits.length || settings.waveStyle !== 'drums') return;
    const { s, e } = viewRange();
    const laneH = 7;
    const y0 = top + wh - laneH * 3 - 4;
    ctx.fillStyle = 'rgba(5,7,11,0.55)';
    ctx.fillRect(0, y0 - 2, g.w, laneH * 3 + 6);
    const rows = { hat: 0, snare: 1, kick: 2 };
    const cols = { kick: '#ff5436', snare: '#ffb74d', hat: '#cdf0ff' };
    const wpx = Math.max(2, Math.min(5, (0.04 / (e - s)) * g.w));
    let i = 0;
    while (i < hits.length && hits[i].t < s) i++;
    for (; i < hits.length && hits[i].t <= e; i++) {
      const h = hits[i];
      ctx.globalAlpha = 0.45 + 0.55 * h.v;
      ctx.fillStyle = cols[h.kind];
      ctx.fillRect(xAt(h.t, g) - wpx / 2, y0 + rows[h.kind] * laneH, wpx, laneH - 2);
    }
    ctx.globalAlpha = 1;
    if (g.w > 300) {
      ctx.font = '600 8.5px Roboto, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText('HH', 3, y0 - 1);
      ctx.fillText('SN', 3, y0 + laneH - 1);
      ctx.fillText('KK', 3, y0 + laneH * 2 - 1);
    }
  }

  function draw() {
    const g = geom();
    if (g.w < 2 || g.h < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const cv = ui.canvas;
    const W = Math.round(g.w * dpr);
    const H = Math.round(g.h * dpr);
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!layers.bg || layers.bgH !== H) {
      layers.bg = ctx.createLinearGradient(0, 0, 0, H);
      layers.bg.addColorStop(0, '#0a0c11');
      layers.bg.addColorStop(0.5, '#0e1118');
      layers.bg.addColorStop(1, '#090b10');
      layers.bgH = H;
    }
    ctx.fillStyle = layers.bg;
    ctx.fillRect(0, 0, W, H);
    const d = dur();
    if (!d) return;
    drawLayers(g, dpr);
    ctx.scale(dpr, dpr);

    const v = S.video;
    const t = drag && drag.mode === 'scrub' && drag.t != null ? drag.t : v ? v.currentTime : 0;
    const px = xAt(t, g);
    const top = g.waveTop;
    const wh = g.waveH;

    // Waveform: greyed where it has played, full colour from the playhead on.
    ctx.drawImage(layers.bright, 0, top, g.w, wh);
    if (px > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, Math.min(g.w, px), wh);
      ctx.clip();
      ctx.fillStyle = '#0c0f15';
      ctx.fillRect(0, top, Math.min(g.w, px), wh);
      ctx.drawImage(layers.dim, 0, top, g.w, wh);
      ctx.restore();
    }

    drawGrid(ctx, g, top, wh);
    drawLanes(ctx, g, top, wh);
    // Hot cue markers.
    S.cues.forEach((c, i) => {
      if (c == null) return;
      const x = xAt(c, g);
      if (x < -8 || x > g.w + 8) return;
      ctx.fillStyle = CUE_COLORS[i];
      ctx.fillRect(Math.round(x), top, 1, wh);
      ctx.beginPath();
      ctx.moveTo(x, top + wh);
      ctx.lineTo(x + 9, top + wh);
      ctx.lineTo(x, top + wh - 11);
      ctx.closePath();
      ctx.fill();
    });

    // Loop region
    const showA = S.pendingA != null ? S.pendingA : S.a;
    if (hasLoop() && S.pendingA == null) {
      const xa = xAt(S.a, g);
      const xb = xAt(S.b, g);
      ctx.fillStyle = S.loopOn ? 'rgba(5,8,14,0.45)' : 'rgba(5,8,14,0.2)';
      if (xa > 0) ctx.fillRect(0, top, Math.min(g.w, xa), wh);
      if (xb < g.w) ctx.fillRect(Math.max(0, xb), top, g.w - Math.max(0, xb), wh);
      ctx.fillStyle = S.loopOn ? 'rgba(25,211,255,0.10)' : 'rgba(255,255,255,0.05)';
      ctx.fillRect(xa, top, xb - xa, wh);
      drawFlag(ctx, xa, top, wh, '#3ddc84', 'A', false);
      drawFlag(ctx, xb, top, wh, '#ff6b4a', 'B', true);
    } else if (showA != null) {
      const xa = xAt(showA, g);
      if (pointer.inside && pointer.y > top && !drag) {
        const xh = pointer.x;
        ctx.fillStyle = 'rgba(61,220,132,0.12)';
        ctx.fillRect(Math.min(xa, xh), top, Math.abs(xh - xa), wh);
      }
      drawFlag(ctx, xa, top, wh, '#3ddc84', 'A', false);
    }
    if (S.lineLoop) {
      const xa = xAt(S.lineLoop.a, g);
      const xb = xAt(S.lineLoop.b, g);
      ctx.fillStyle = 'rgba(190,120,255,0.22)';
      ctx.fillRect(xa, top, xb - xa, wh);
      drawFlag(ctx, xa, top, wh, '#c084fc', '[', false);
      drawFlag(ctx, xb, top, wh, '#c084fc', ']', true);
    }
    if (drag && drag.mode === 'select' && drag.moved) {
      const x0 = xAt(drag.t0, g);
      const x1 = xAt(drag.t1, g);
      ctx.fillStyle = 'rgba(25,211,255,0.18)';
      ctx.fillRect(Math.min(x0, x1), top, Math.abs(x1 - x0), wh);
    }

    // Ruler
    ctx.fillStyle = '#121722';
    ctx.fillRect(0, 0, g.w, RULER);
    ctx.fillStyle = '#262f42';
    ctx.fillRect(0, RULER - 1, g.w, 1);
    drawRuler(ctx, g);

    // Playhead: a bright line with a soft glow.
    if (px >= 0 && px <= g.w) {
      const glow = ctx.createLinearGradient(px - 10, 0, px + 10, 0);
      glow.addColorStop(0, 'rgba(255,255,255,0)');
      glow.addColorStop(0.5, 'rgba(255,255,255,0.16)');
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(px - 10, top, 20, wh);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(px) - 1, 0, 2, top + wh);
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 7);
      ctx.closePath();
      ctx.fill();
    }

    // Hover line
    if (pointer.inside && !drag) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(Math.round(pointer.x), pointer.y < RULER ? 0 : top, 1, pointer.y < RULER ? RULER : wh);
    }

    // Mini map
    if (g.miniH && layers.mini) {
      const my = top + wh;
      ctx.fillStyle = '#0f1420';
      ctx.fillRect(0, my, g.w, g.miniH);
      ctx.drawImage(layers.mini, 0, my, g.w, g.miniH);
      const { s, e } = viewRange();
      ctx.strokeStyle = '#19d3ff';
      ctx.lineWidth = 1;
      ctx.strokeRect((s / d) * g.w + 0.5, my + 0.5, Math.max(3, ((e - s) / d) * g.w) - 1, g.miniH - 1);
      ctx.fillStyle = '#fff';
      ctx.fillRect((t / d) * g.w, my, 1, g.miniH);
    }
  }

  function drawFlag(ctx, x, top, wh, color, label, right) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x) - 1, top, 2, wh);
    const fw = 16;
    const fh = 15;
    const fx = right ? x - fw : x;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(fx, top, fw, fh, right ? [4, 0, 0, 4] : [0, 4, 4, 0]) : ctx.rect(fx, top, fw, fh);
    ctx.fill();
    ctx.fillStyle = '#05140b';
    ctx.font = 'bold 11px Roboto, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, fx + fw / 2, top + fh / 2 + 0.5);
  }

  function drawRuler(ctx, g) {
    const { s, e } = viewRange();
    const span = e - s;
    const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const minPx = 64;
    let st = steps[steps.length - 1];
    for (const x of steps) {
      if ((x / span) * g.w >= minPx) {
        st = x;
        break;
      }
    }
    ctx.font = '10.5px Roboto, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const first = Math.ceil(s / st) * st;
    for (let tt = first; tt <= e + 1e-9; tt += st) {
      const x = xAt(tt, g);
      ctx.fillStyle = '#3a4560';
      ctx.fillRect(Math.round(x), RULER - 6, 1, 5);
      ctx.fillStyle = '#8b95a8';
      let label = C.formatTime(tt, false);
      if (st < 1) label = C.formatTime(tt, true).replace(/(\.\d)\d$/, '$1');
      ctx.fillText(label, x + 3, RULER / 2 - 1);
    }
    // Loop markers on the ruler too.
    if (hasLoop() && S.pendingA == null) {
      ctx.fillStyle = S.loopOn ? 'rgba(25,211,255,0.55)' : 'rgba(255,255,255,0.25)';
      const xa = xAt(S.a, g);
      const xb = xAt(S.b, g);
      ctx.fillRect(xa, RULER - 3, xb - xa, 3);
    }
  }

  function setupCanvas() {
    const cv = ui.canvas;
    const local = (e) => {
      const g = geom();
      return { g, x: e.clientX - g.left, y: e.clientY - g.top };
    };

    // Two fingers on the wave: pinch to zoom, like a photo.
    const fingers = new Map();
    let pinch = null;
    const pinchState = (g) => {
      const xs = [...fingers.values()];
      return { dist: Math.max(20, Math.abs(xs[0] - xs[1])), mid: (xs[0] + xs[1]) / 2 };
    };

    cv.addEventListener('pointermove', (e) => {
      const { g, x, y } = local(e);
      if (fingers.has(e.pointerId)) fingers.set(e.pointerId, x);
      if (pinch && fingers.size >= 2) {
        const p = pinchState(g);
        const d = dur();
        const span = C.clamp((pinch.e - pinch.s) * (pinch.dist / p.dist), Math.min(1, d), d);
        setView(pinch.tMid - (p.mid / g.w) * span, pinch.tMid + (1 - p.mid / g.w) * span);
        if (settings.zoomFocus) {
          if (!S.view) settings.zoomFocus = false;
          else settings.focusLen = S.view.e - S.view.s;
        }
        S.lastViewTouch = now();
        return;
      }
      pointer.x = x;
      pointer.y = y;
      pointer.inside = true;
      S.dirty = true;
      if (drag) return onDragMove(e, g, x, y);
      // Cursor + tooltip
      const t = timeAt(x, g);
      let cursor = y < RULER ? 'pointer' : 'crosshair';
      if (y >= g.waveTop + g.waveH && g.miniH) cursor = 'grab';
      else if (y >= RULER && handleAt(x, g)) cursor = 'ew-resize';
      cv.style.cursor = cursor;
      ui.tip.hidden = false;
      ui.tip.textContent = y < RULER ? `Jump to ${C.formatTime(t)}` : C.formatTime(t);
      ui.tip.style.left = `${C.clamp(x, 30, g.w - 30)}px`;
    });
    cv.addEventListener('pointerleave', () => {
      pointer.inside = false;
      ui.tip.hidden = true;
      S.dirty = true;
    });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !dur()) return;
      const { g, x, y } = local(e);
      cv.setPointerCapture(e.pointerId);
      e.preventDefault();
      S.lastViewTouch = now();
      if (e.pointerType === 'touch') {
        fingers.set(e.pointerId, x);
        if (fingers.size === 2) {
          // Second finger: cancel the tap/drag the first finger started and pinch instead.
          if (drag && drag.mode === 'handle') S.history.pop();
          if (drag && drag.mode === 'scrub') endScrub(drag);
          drag = null;
          const p = pinchState(g);
          const { s, e: en } = viewRange();
          pinch = { dist: p.dist, s, e: en, tMid: s + (p.mid / g.w) * (en - s) };
          S.dirty = true;
          return;
        }
        if (fingers.size > 2) return;
      }
      const t = timeAt(x, g);
      if (y < RULER) {
        drag = { mode: 'seek' };
        userSeek(t);
      } else if (g.miniH && y >= g.waveTop + g.waveH) {
        if (djDeck() && settings.zoomFocus) {
          // DJ view: the little whole-song map jumps the song there.
          drag = { mode: 'miniSeek' };
          userSeek((x / g.w) * dur());
          focusFollow(true);
        } else {
          drag = { mode: 'mini' };
          panMiniTo(x, g);
        }
      } else {
        const hnd = handleAt(x, g, e.pointerType === 'touch');
        if (hnd === 'la' || hnd === 'lb') {
          drag = { mode: 'lhandle', which: hnd };
        } else if (hnd === 'pa') {
          drag = { mode: 'pending' };
        } else if (hnd) {
          pushHistory();
          drag = { mode: 'handle', which: hnd };
        } else if (e.pointerType === 'touch' || (settings.mouseDJ && !e.shiftKey)) {
          // Like a record: hold to stop, drag to move the song, click to
          // play/pause, double-click for A then B. (Shift+drag draws a loop.)
          drag = startScrub(x, g);
        } else {
          drag = { mode: 'select', x0: x, t0: t, t1: t, moved: false };
        }
      }
      S.dirty = true;
    });
    const fingerUp = (e) => {
      fingers.delete(e.pointerId);
      if (pinch && fingers.size < 2) {
        pinch = null;
        if (settings.zoomFocus) saveSettings();
        renderUI();
      }
    };
    cv.addEventListener('pointerup', (e) => {
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      const wasPinching = !!pinch || fingers.size > 1;
      fingerUp(e);
      if (wasPinching) {
        drag = null;
        return;
      }
      if (!drag) return;
      const d = drag;
      drag = null;
      const { g, x } = local(e);
      if (d.mode === 'scrub') {
        endScrub(d, x, g);
      } else if (d.mode === 'select') {
        if (d.moved) {
          setLoop(qT(d.t0), qT(timeAt(x, g)), { play: true, fresh: true });
        } else {
          waveClick(d.t0);
        }
      } else if (d.mode === 'lhandle') {
        const v = S.video;
        if (v && S.lineLoop && (v.currentTime < S.lineLoop.a - 0.01 || v.currentTime >= effEnd())) seek(S.lineLoop.a);
        renderUI();
      } else if (d.mode === 'handle') {
        const v = S.video;
        if (v && S.loopOn && (v.currentTime < S.a - 0.01 || v.currentTime >= effEnd())) seek(S.a);
        renderUI();
        saveVideoStateSoon();
      }
      S.dirty = true;
    });
    cv.addEventListener('pointercancel', (e) => {
      fingerUp(e);
      if (drag && drag.mode === 'scrub') endScrub(drag);
      drag = null;
      S.dirty = true;
    });
    cv.addEventListener(
      'wheel',
      (e) => {
        const d = dur();
        if (!d) return;
        e.preventDefault();
        S.lastViewTouch = now();
        const { g, x } = local(e);
        const { s, e: en } = viewRange();
        const span = en - s;
        const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
        if (horiz) {
          const delta = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) || 0;
          setView(s + (delta / g.w) * span, en + (delta / g.w) * span);
          return;
        }
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
        const factor = Math.pow(1.0018, e.deltaY * unit);
        const tAt = s + (x / g.w) * span;
        const ns = Math.max(Math.min(1, d), span * factor);
        setView(tAt - (x / g.w) * ns, tAt + (1 - x / g.w) * ns);
        if (settings.zoomFocus) {
          if (!S.view) settings.zoomFocus = false;
          else settings.focusLen = S.view.e - S.view.s;
          saveSettings();
        }
      },
      { passive: false }
    );
  }

  // Which edge is under the pointer: the practised line's start/end ('la'/'lb',
  // checked first) or the A/B flags.
  function handleAt(x, g, touch) {
    const cands = [];
    if (S.lineLoop) cands.push(['la', S.lineLoop.a], ['lb', S.lineLoop.b]);
    if (hasLoop() && S.pendingA == null) cands.push(['a', S.a], ['b', S.b]);
    if (S.pendingA != null) cands.push(['pa', S.pendingA]);
    let best = null;
    let bestD = Infinity;
    for (const [k, t] of cands) {
      const d = Math.abs(x - xAt(t, g));
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return bestD <= (touch ? 22 : HANDLE_PX) ? best : null;
  }

  function onDragMove(e, g, x) {
    const t = timeAt(x, g);
    if (drag.mode === 'scrub') {
      moveScrub(drag, x, g);
    } else if (drag.mode === 'miniSeek') {
      userSeek((x / g.w) * dur());
      focusFollow(true);
    } else if (drag.mode === 'seek') {
      userSeek(t);
    } else if (drag.mode === 'mini') {
      panMiniTo(x, g);
    } else if (drag.mode === 'lhandle' && S.lineLoop) {
      // Move the practised line's start or end freely.
      const ll = S.lineLoop;
      let a = ll.a;
      let b = ll.b;
      if (drag.which === 'la') a = t;
      else b = t;
      if (a > b) {
        [a, b] = [b, a];
        drag.which = drag.which === 'la' ? 'lb' : 'la';
      }
      if (b - a >= 0.3) {
        ll.a = a;
        ll.b = b;
        ll.custom = true;
        renderUI();
      }
    } else if (drag.mode === 'pending') {
      if (S.pendingA != null) {
        S.pendingA = qT(C.clamp(t, 0, Math.max(0, dur() - C.MIN_LOOP)));
        renderUI();
      }
    } else if (drag.mode === 'handle') {
      let a = S.a;
      let b = S.b;
      if (drag.which === 'a') a = qT(t);
      else b = qT(t);
      if (a > b) {
        [a, b] = [b, a];
        drag.which = drag.which === 'a' ? 'b' : 'a';
      }
      if (b - a >= C.MIN_LOOP) {
        S.a = a;
        S.b = b;
        renderUI();
      }
    } else if (drag.mode === 'select') {
      if (Math.abs(x - drag.x0) > 4) drag.moved = true;
      drag.t1 = t;
    }
    S.lastViewTouch = now();
    S.dirty = true;
  }

  // ---- DJ scrubbing (touch) ----
  // Finger down holds the song (pauses). Moving the finger moves the song with
  // it: in the zoomed DJ view the wave slides under the finger like a record;
  // in the whole-song view the playhead follows the finger. Lifting the finger
  // plays on if it was playing.
  function startScrub(x, g) {
    const v = S.video;
    const { s, e } = viewRange();
    const sc = { mode: 'scrub', x0: x, t0: v ? v.currentTime : 0, span: e - s, zoomed: !!S.view,
      wasPlaying: !!v && !v.paused, moved: false, lastSeek: 0, t: null, downAt: now() };
    if (v && !v.paused) {
      clearTimeout(S.gapTimer);
      S.wrapping = false;
      try {
        v.pause();
      } catch (err) {
        /* ignore */
      }
    }
    return sc;
  }

  function scrubTime(sc, x, g) {
    const d = dur();
    const t = sc.zoomed ? sc.t0 - ((x - sc.x0) / g.w) * sc.span : timeAt(x, g);
    return C.clamp(t, 0, Math.max(0, d - 0.05));
  }

  function moveScrub(sc, x, g) {
    if (Math.abs(x - sc.x0) > 3) sc.moved = true;
    if (!sc.moved) return;
    sc.t = scrubTime(sc, x, g);
    if (now() - sc.lastSeek > 40) {
      sc.lastSeek = now();
      seek(sc.t);
    }
    focusFollowAt(sc.t);
  }

  // A quick tap (no sliding) is play/pause. Sliding moves the song, and a
  // long hold just holds it; both play on afterwards if it was playing.
  // A double tap sets a loop point where the finger is: the first double tap
  // sets A, the next one sets B and the loop starts.
  function endScrub(sc, x, g) {
    const lifted = x != null && !!g; // finger lifted (not cancelled / pinch)
    if (sc.moved) {
      const t = lifted ? scrubTime(sc, x, g) : sc.t;
      if (t != null) seek(t);
    }
    const tap = lifted && !sc.moved && now() - sc.downAt < TAP_MS;
    const prev = S.lastTap;
    S.lastTap = null;
    if (tap && prev && sc.downAt - prev.at < DOUBLE_TAP_MS && Math.abs(x - prev.x) < DOUBLE_TAP_PX) {
      doubleTapAt(timeAt(x, g), prev.wasPlaying);
    } else if (tap) {
      S.lastTap = { at: now(), x, wasPlaying: sc.wasPlaying };
      if (!sc.wasPlaying) play(); // tap while stopped: play; tap while playing: stays paused
    } else if (sc.wasPlaying) {
      play();
    }
    S.dirty = true;
    renderUI();
  }

  function doubleTapAt(t, wasPlaying) {
    const d = dur();
    if (!d) return;
    t = C.clamp(t, 0, Math.max(0, d - 0.05));
    // Undo the play/pause of the first tap: a double tap only sets a point.
    if (wasPlaying) play();
    else if (S.video && !S.video.paused) {
      try {
        S.video.pause();
      } catch (e) {
        /* ignore */
      }
    }
    const F = C.formatTime;
    if (S.pendingA == null) {
      waveClick(t);
      flash(`A set at ${F(t)}. Double-tap where the loop should end (B).`, 4000);
    } else if (Math.abs(t - S.pendingA) < C.MIN_LOOP) {
      flash('Double-tap a bit further away to set B.');
    } else {
      waveClick(t);
      if (hasLoop()) flash(`Loop ${F(S.a)} → ${F(S.b)}.`, 2500);
    }
  }

  // Centre the DJ view on a time (used while the finger moves the song).
  function focusFollowAt(t) {
    if (!settings.zoomFocus) return;
    const d = dur();
    const len = Math.min(focusLen(), d);
    if (!d || len >= d) return;
    setView(t - len * 0.5, t + len * 0.5, true);
  }

  function panMiniTo(x, g) {
    const d = dur();
    const { s, e } = viewRange();
    const len = e - s;
    const c = (x / g.w) * d;
    setView(c - len / 2, c + len / 2);
  }

  function waveClick(t) {
    t = qT(t);
    if (S.pendingA == null) {
      pushHistory();
      S.pendingA = t;
      S.dirty = true;
      renderUI();
    } else {
      const a = S.pendingA;
      if (Math.abs(t - a) < C.MIN_LOOP) {
        flash(`${TOUCH ? 'Tap' : 'Click'} a bit further away to set the END.`);
        return;
      }
      setLoop(a, t, { play: true, fresh: true, noHistory: true });
    }
  }

  function userSeek(t) {
    if (S.loopOn && hasLoop() && t >= effEnd()) {
      S.loopOn = false;
      flash('Loop paused because you jumped past it. Press Loop to turn it back on.', 4500);
    }
    seek(t);
    renderUI();
  }

  function followPlayhead() {
    if (settings.zoomFocus) return focusFollow(false);
    if (!S.view || !S.video || S.video.paused || drag) return;
    if (now() - S.lastViewTouch < 2000) return;
    const t = S.video.currentTime;
    const { s, e } = viewRange();
    const len = e - s;
    if (t > e - len * 0.02 || t < s) {
      // When looping inside the view, don't page away from it.
      if (S.loopOn && hasLoop() && S.a >= s && S.b <= e) return;
      setView(t - len * 0.1, t + len * 0.9);
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  window.addEventListener(
    'keydown',
    (e) => {
      if (!settings.open || !S.vid || !hostEl || hostEl.style.display === 'none') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      for (const el of e.composedPath()) {
        if (!el || !el.tagName) continue;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return;
      }
      let handled = true;
      if (e.key === '[') markA();
      else if (e.key === ']') markB();
      else if (e.key === '\\') toggleLoop();
      else if (e.key === 'q' || e.key === 'Q') toggleQuantize();
      else if (e.key === 'Escape' && (S.pendingA != null || !ui.help.hidden)) {
        if (!ui.help.hidden) toggleHelp(false);
        else {
          S.pendingA = null;
          S.dirty = true;
          renderUI();
        }
      } else if (e.key === '<' || e.key === '>') {
        S.lastYTUserAction = now(); // YouTube's own speed keys
        handled = false;
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );

  // ---------------------------------------------------------------------------
  // Main loops
  // ---------------------------------------------------------------------------
  let lastUIRefresh = 0;
  function frame() {
    try {
      engineTick();
      liveTick();
      maybeComputeGrid();
      if (hostEl && hostEl.style.display !== 'none') {
        followPlayhead();
        lyricsTick();
        const playing = S.video && !S.video.paused;
        if (S.dirty || playing || drag) {
          S.dirty = false;
          draw();
        }
        if (now() - lastUIRefresh > 500) {
          lastUIRefresh = now();
          if (S.hintOverride && now() >= S.hintUntil) S.hintOverride = null;
          renderUI();
        }
      }
    } catch (err) {
      console.debug('[Wave Looper]', err);
    }
    requestAnimationFrame(frame);
  }

  function init() {
    storage.get('ytl:settings').then((r) => {
      Object.assign(settings, r['ytl:settings'] || {});
      // Touch screens start in the DJ view (zoomed, wave scrolls under a fixed playhead).
      if (TOUCH && !settings.djDefault) {
        settings.djDefault = true;
        settings.zoomFocus = true;
      }
      // Computers get the DJ deck view too (wave slides under the playhead).
      if (!TOUCH && !settings.djDesk) {
        settings.djDesk = true;
        settings.zoomFocus = true;
      }
      // Touch screens: lyrics on (at the top of the screen) unless turned off since.
      if (TOUCH && !settings.touchLyricsDefault) {
        settings.touchLyricsDefault = true;
        settings.lyrics = true;
        settings.height = 0; // use the new half-screen default
      }
      // iPhone/iPad: Safari freezes the studio sound engine when you pause, switch
      // apps or use the microphone, and the video went silent. Off by default there.
      if (settings.hqV !== 1) {
        settings.hqV = 1;
        if (IS_IOS) settings.hqAudio = false;
      }
      // New trainer choices (v2): start from 30% over 10 loops unless chosen since.
      if (settings.trainerV !== 4) {
        settings.trainerV = 4;
        settings.trainerStart = TRAINER_DEFAULT_START;
        settings.trainerReps = TRAINER_DEFAULT_REPS;
      }
      if (!TRAINER_STARTS.includes(settings.trainerStart)) settings.trainerStart = 30;
      // Snap anything else to the closest loop count we offer.
      if (!TRAINER_REPS.includes(settings.trainerReps)) {
        settings.trainerReps = TRAINER_REPS.reduce((best, n) =>
          Math.abs(n - settings.trainerReps) < Math.abs(best - settings.trainerReps) ? n : best);
      }
      buildPanel();
      applyAudioSession();
      postToPage({ type: 'hello' });
      syncVideo();
      requestAnimationFrame(frame);
      // Backup ticker: rAF stops in background tabs, timers keep running for
      // tabs that play audio.
      setInterval(() => {
        try {
          engineTick();
        } catch (e) {
          /* ignore */
        }
      }, 20);
      setInterval(syncVideo, 500);
      window.addEventListener('resize', applyLayout);
      document.addEventListener('fullscreenchange', updateVisibility);
      document.addEventListener('yt-navigate-finish', syncVideo, true);
    });
  }

  if (alive()) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === 'ytl-toggle') {
        togglePanel();
        sendResponse({ ok: true, open: settings.open });
      }
    });
  }

  init();
})();
