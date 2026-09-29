// Runs on youtube.com. Reads the video info + transcript when the service worker asks.

(function () {
  'use strict';
  if (window.__ytToClaudeLoaded) return;
  window.__ytToClaudeLoaded = true;
  const { parseJson3, extractPlayerResponse, pickTrack, formatTranscript, buildSentences, pickSegment, groupSentences, fmtTime } = window.YTC;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout, step = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  const trackList = (p) => (p && p.captions && p.captions.playerCaptionsTracklistRenderer &&
    p.captions.playerCaptionsTracklistRenderer.captionTracks) || [];

  // The video's player data: first from the page itself, then by asking YouTube's own API the way the page does.
  async function getPlayerResponse() {
    const html = await (await fetch(location.href, { credentials: 'include' })).text();
    const fromPage = extractPlayerResponse(html);
    if (trackList(fromPage).length) return { pr: fromPage, via: 'page' };
    let fromApi = null, apiNote = '';
    try {
      const key = (html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/) || [])[1];
      const version = (html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":\s*"([^"]+)"/) || [])[1] || '2.20240101.00.00';
      if (!key) apiNote = 'no API key in page';
      else {
        const res = await fetch('/youtubei/v1/player?key=' + encodeURIComponent(key) + '&prettyPrint=false', {
          method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            context: { client: { clientName: location.hostname.startsWith('m.') ? 'MWEB' : 'WEB', clientVersion: version, hl: 'en' } },
            videoId: videoId(), contentCheckOk: true, racyCheckOk: true
          })
        });
        fromApi = await res.json();
        if (trackList(fromApi).length) return { pr: fromApi, via: 'api' };
      }
    } catch (e) { apiNote = 'api: ' + e.message; }
    const pr = fromPage || fromApi;
    const ps = pr && pr.playabilityStatus;
    return { pr, via: 'none', note: 'page ' + html.length + ' bytes, ' + (fromPage ? 'player data found' : 'no player data') +
      (ps ? ', playability ' + ps.status + (ps.reason ? ' (' + ps.reason + ')' : '') : '') + (apiNote ? ', ' + apiNote : '') };
  }

  // Method 1: the caption track the player itself uses (fetched with your normal YouTube session).
  async function fromCaptionTrack() {
    const { pr, via, note } = await getPlayerResponse();
    const track = pickTrack(trackList(pr));
    if (!track) throw new Error('this video has no captions [' + note + ']');
    const url = track.baseUrl + (track.baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    const res = await fetch(url, { credentials: 'include' });
    const body = await res.text();
    if (!body) throw new Error('YouTube returned an empty caption file (status ' + res.status + ', list from the ' + via + ')');
    const cues = parseJson3(JSON.parse(body));
    if (!cues.length) throw new Error('caption file had no text');
    return { cues, source: 'captions (' + (track.languageCode || '?') + (track.kind === 'asr' ? ', auto-generated' : '') + ', via ' + via + ')' };
  }

  // Method 2: open YouTube's own "Show transcript" panel and read it.
  async function fromTranscriptPanel() {
    const expand = document.querySelector('#description-inline-expander #expand, ytd-text-inline-expander #expand');
    if (expand) expand.click();
    const btn = await waitFor(() => {
      const b = document.querySelector('ytd-video-description-transcript-section-renderer button');
      return b || Array.from(document.querySelectorAll('button')).find((x) => /show transcript/i.test(x.textContent || x.getAttribute('aria-label') || ''));
    }, 3000);
    if (!btn) throw new Error('no "Show transcript" button on this page');
    btn.click();
    const segs = await waitFor(() => {
      const s = document.querySelectorAll('ytd-transcript-segment-renderer');
      return s.length ? s : null;
    }, 6000);
    if (!segs) throw new Error('transcript panel did not load');
    const cues = [];
    segs.forEach((s) => {
      const ts = (s.querySelector('.segment-timestamp') || {}).textContent || '';
      const el = s.querySelector('.segment-text');
      const text = String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim(); // innerText: hidden copies are left out
      const parts = ts.trim().split(':').map(Number);
      const start = parts.reduce((a, n) => a * 60 + (n || 0), 0);
      if (text) cues.push({ start, text });
    });
    if (!cues.length) throw new Error('transcript panel was empty');
    return { cues, source: 'YouTube transcript panel' };
  }

  async function getInfo() {
    const title = (document.querySelector('h1.ytd-watch-metadata, h1 yt-formatted-string') || {}).textContent ||
      document.title.replace(/ - YouTube$/, '');
    const channel = (document.querySelector('ytd-channel-name a, #owner #channel-name a') || {}).textContent || '';
    const v = videoId();
    const url = v ? 'https://www.youtube.com/watch?v=' + v : location.href;
    return { title: title.trim(), channel: channel.trim(), url };
  }

  function videoId() { return new URL(location.href).searchParams.get('v'); }

  // ---- transcript, loaded once per video and cached ----
  let cache = { id: null, promise: null };

  function loadTranscript() {
    const id = videoId();
    if (cache.id === id && cache.promise) return cache.promise;
    cache.id = id;
    cache.promise = (async () => {
      const info = await getInfo();
      const errors = [];
      for (const method of [fromCaptionTrack, fromTranscriptPanel]) {
        try {
          const { cues, source } = await method();
          return { ...info, cues, sentences: buildSentences(cues), transcript: formatTranscript(cues), source, lines: cues.length, errors };
        } catch (e) {
          errors.push(method.name + ': ' + e.message);
        }
      }
      cache.promise = null; // nothing found: try again next time
      return { ...info, cues: [], sentences: [], transcript: null, source: null, lines: 0, errors };
    })();
    return cache.promise;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'yt-get') return;
    loadTranscript().then((d) => sendResponse({
      title: d.title, channel: d.channel, url: d.url, transcript: d.transcript,
      source: d.source, lines: d.lines, errors: d.errors
    }));
    return true;
  });

  window.__ytcDebug = {
    load: () => loadTranscript().then((d) => ({ title: d.title, lines: d.lines, sentences: d.sentences.length, source: d.source, errors: d.errors, first: d.sentences[0] && d.sentences[0].text }))
  };

  // ---- settings (set in the popup) ----
  const settings = { pauseOn: true, replayOn: true, textLevel: 6, voiceOn: true, target: 'claude', tapOn: false, badgeOn: false, imageOn: true };
  function readSettings(s) {
    if ('pauseOn' in s) settings.pauseOn = s.pauseOn !== false;
    if ('voiceOn' in s) settings.voiceOn = s.voiceOn !== false;
    if ('replayOn' in s) settings.replayOn = s.replayOn !== false;
    if ('textLevel' in s) settings.textLevel = Math.min(10, Math.max(1, Number(s.textLevel) || 6)); // 1..10, in steps of 0.25
    if ('target' in s) settings.target = s.target === 'chatgpt' ? 'chatgpt' : 'claude';
    if ('tapOn' in s) settings.tapOn = s.tapOn === true;     // touch the video = pause / play (phone + iPad app)
    if ('badgeOn' in s) settings.badgeOn = s.badgeOn === true; // small status label on the video
    if ('imageOn' in s) settings.imageOn = s.imageOn !== false; // Claude only: also send a picture of the paused video
  }
  chrome.storage.local.get(['pauseOn', 'replayOn', 'voiceOn', 'textLevel', 'target', 'tapOn', 'badgeOn', 'imageOn']).then(readSettings);
  chrome.storage.onChanged.addListener((ch) => {
    const s = {};
    for (const k of Object.keys(ch)) s[k] = ch[k].newValue;
    readSettings(s);
    if (ch.textLevel) rerender();
  });
  const targetName = () => (settings.target === 'chatgpt' ? 'ChatGPT' : 'Claude');

  window.addEventListener('resize', () => { try { rerender(); } catch (e) { /* ignore */ } });

  // ---- the sentences, shown as ONE tight paragraph over the video ----
  const OVERLAY_ID = 'yt2c-overlay';
  // Text size: level 1..10 in small steps (10 = the biggest). Font size = share of the player height.
  // level 6 = medium (6.75 %), level 10 = 8.95 %.
  const levelShare = (lv) => 0.04 + (lv - 1) * 0.0055;
  // Size is written in CSS "container" units (cqh = 1% of the player's height, cqw = 1% of its width), so the
  // browser recalculates it whenever the player changes size (fullscreen, theater mode, window resize).
  // Nothing is measured in JavaScript, so it cannot come out random. Hard limits: never below 14px or above 120px.
  const fontSizeCss = (lv) => {
    const share = levelShare(lv);
    return 'clamp(14px, min(' + (share * 100 * 1.097).toFixed(3) + 'cqh, ' + (share * 190).toFixed(3) + 'cqw), 120px)';
  };
  let lastShown = null;

  let placeTimer = null;

  function hideOverlay() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.remove();
    if (placeTimer) { clearInterval(placeTimer); placeTimer = null; }
    lastShown = null;
  }

  // used when the page has no usable player box (some mobile layouts): cover exactly the video
  function placeFixed(el) {
    const r = video ? video.getBoundingClientRect() : null;
    const ok = r && r.width > 80 && r.height > 60;
    el.style.left = (ok ? r.left : 0) + 'px';
    el.style.top = (ok ? r.top : 0) + 'px';
    el.style.width = (ok ? r.width : window.innerWidth) + 'px';
    el.style.height = (ok ? r.height : window.innerHeight) + 'px';
  }

  function setActive(index) {
    const el = document.getElementById(OVERLAY_ID);
    if (!el) return;
    if (lastShown) lastShown.activeIndex = index;
    let activeEl = null;
    el.querySelectorAll('[data-i]').forEach((n) => {
      const on = Number(n.dataset.i) === index;
      n.style.color = on ? '#ffd60a' : '#ffffff';
      if (on) activeEl = n;
    });
    const wrap = document.getElementById('yt2c-wrap');
    if (wrap && activeEl && wrap.scrollHeight > wrap.clientHeight + 1) {
      // long text at a big size: keep the sentence you paused in in view
      const w = wrap.getBoundingClientRect(), a = activeEl.getBoundingClientRect();
      wrap.scrollTop += (a.top + a.height / 2) - (w.top + w.height / 2);
    }
  }

  function rerender() {
    if (!lastShown || !document.getElementById(OVERLAY_ID)) return;
    const keep = {};
    for (const id of ['yt2c-foot', 'yt2c-hint']) {
      const n = document.getElementById(id);
      keep[id] = n ? { text: n.textContent, color: n.style.color } : null;
    }
    showOverlay(lastShown);
    for (const id of Object.keys(keep)) {
      const n = document.getElementById(id);
      if (n && keep[id]) { n.textContent = keep[id].text; n.style.color = keep[id].color; }
    }
  }

  function showOverlay(args) {
    const { note, seg, activeIndex } = args;
    lastShown = { note, seg, activeIndex };
    let host = (video && video.closest('#movie_player, .html5-video-player')) || document.querySelector('#movie_player') || (video && video.parentElement);
    const usable = (h) => !!h && h.clientWidth > 80 && h.clientHeight > 60;
    const fixed = !usable(host);
    if (fixed) host = document.documentElement;
    const old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();
    if (placeTimer) { clearInterval(placeTimer); placeTimer = null; }
    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    // pointer-events:none → clicking the video still pauses/plays as normal
    el.style.cssText = (fixed ? 'position:fixed;z-index:2147483647;' : 'position:absolute;inset:0;z-index:2000;') +
      'display:flex;flex-direction:column;container-type:size;' +
      'padding:2.5% 4%;background:rgba(0,0,0,.95);color:#fff;font-family:system-ui,Arial,sans-serif;' +
      'pointer-events:none;box-sizing:border-box;overflow:hidden';
    const mk = (id, css, text) => {
      const d = document.createElement('div');
      d.id = id; d.style.cssText = css; d.textContent = text || '';
      return d;
    };
    el.appendChild(mk('yt2c-head', 'font-size:20px;color:#cfcfcf;flex:none;text-align:center', note));
    const wrap = mk('yt2c-wrap', 'flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-direction:column');
    const body = mk('yt2c-body', 'margin:auto 0;line-height:1.35;font-weight:600;text-align:left;text-shadow:0 2px 6px #000');
    if (seg) {
      // every full sentence gets its own block; tiny phrases stay with a neighbouring sentence
      groupSentences(seg.items).forEach((g) => {
        const block = document.createElement('div');
        block.style.cssText = 'margin:0 0 .45em';
        g.idx.forEach((i) => {
          const sp = document.createElement('span');
          sp.dataset.i = String(i);
          sp.textContent = seg.items[i].text + ' ';
          block.appendChild(sp);
        });
        body.appendChild(block);
      });
    }
    wrap.appendChild(body);
    el.appendChild(wrap);
    el.appendChild(mk('yt2c-foot', 'font-size:15px;color:#ff8a80;margin-top:1%;flex:none;text-align:center'));  // only shows if something goes wrong
    el.appendChild(mk('yt2c-hint', 'display:none'));
    host.appendChild(el);
    if (fixed) { placeFixed(el); placeTimer = setInterval(() => placeFixed(el), 300); }
    if (seg) {
      if (window.CSS && CSS.supports && CSS.supports('width', '1cqh')) {
        body.style.fontSize = fontSizeCss(settings.textLevel);
      } else { // older browsers (iOS 15): measure once; it is refreshed on resize
        body.style.fontSize = Math.min(120, Math.max(14, el.clientHeight * levelShare(settings.textLevel))) + 'px';
      }
      setActive(activeIndex === undefined ? seg.items.length - 1 : activeIndex);
    }
  }

  // Only problems are written on the video; success shows nothing (you only want to see the subtitles).
  function setFoot(text, ok) {
    const f = document.getElementById('yt2c-foot');
    if (f) f.textContent = ok ? '' : text;
  }
  function setHint(text) {
    if (text && /blocked/i.test(text)) setFoot(text, false);
  }

  // ---- pause → show the sentences + send them; "let's go" / Space / play → back to the start of that part, then keep playing ----
  let video = null;
  let handling = false;
  let pending = null;     // the passage waiting for "let's go" / Space / Enter
  let replaying = null;   // { seg, timer } while the passage is being played again
  let ourPause = false;   // true while WE pause the video, so it does not count as "you paused"
  let deferredSend = null; // the message to Claude/ChatGPT, sent when the replay has stopped

  function runDeferredSend() {
    const f = deferredSend;
    deferredSend = null;
    if (f) f();
  }
  function cancelReplay() {
    if (replaying) { clearInterval(replaying.timer); replaying = null; }
  }

  function isAd() {
    const p = document.querySelector('#movie_player');
    return !!(p && p.classList.contains('ad-showing'));
  }

  function bind() {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (v && v !== video) {
      video = v;
      v.addEventListener('pause', onPause);
      v.addEventListener('play', onPlay);
    }
  }
  setInterval(bind, 1000);
  bind();

  // Fetch the subtitles as soon as a video page is open, so the first pause is instant.
  let preloadedFor = null;
  setInterval(() => {
    const id = location.pathname === '/watch' ? videoId() : null;
    if (id && id !== preloadedFor) {
      preloadedFor = id;
      subState = 'loading…';
      setTimeout(() => {
        if (videoId() !== id) return;
        loadTranscript().then((d) => { if (videoId() === id) subState = describeSubs(d); }).catch((e) => { subState = 'error: ' + e.message; });
      }, 1500);
    }
  }, 1000);

  // ---- status label + "touch the video" layer (used by the iPhone / iPad app) ----
  let subState = 'no video yet';
  let lastSend = '';
  let tapLayer = null;
  let badge = null;

  function describeSubs(d) {
    if (d.sentences.length) return d.sentences.length + ' sentences';
    const why = (d.errors.join(' ').match(/playability ([A-Z_]+)(?: \(([^)]*)\))?/) || []);
    return 'none' + (why[1] && why[1] !== 'OK' ? ' (' + (why[2] || why[1]) + ')' : '');
  }

  function onTap(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!video) return;
    if (pending) { continueFromStart(); return; } // touching a paused video = "let's go"
    if (video.paused) { video.play().catch(() => {}); return; }
    video.pause();                                // touching a playing video = pause -> show + send the sentences
  }

  function updateTapLayer() {
    const r = video ? video.getBoundingClientRect() : null;
    const ok = !!r && r.width > 80 && r.height > 60 && location.pathname === '/watch';
    // the touch area: the middle of the picture (the buttons on the edges keep working)
    if (settings.tapOn && ok) {
      if (!tapLayer) {
        tapLayer = document.createElement('div');
        tapLayer.id = 'yt2c-tap';
        tapLayer.style.cssText = 'position:fixed;z-index:2147483000;background:transparent;-webkit-tap-highlight-color:transparent;touch-action:manipulation';
        tapLayer.addEventListener('click', onTap, true);
        document.documentElement.appendChild(tapLayer);
      }
      tapLayer.style.left = Math.round(r.left + r.width * 0.12) + 'px';
      tapLayer.style.top = Math.round(r.top + r.height * 0.14) + 'px';
      tapLayer.style.width = Math.round(r.width * 0.76) + 'px';
      tapLayer.style.height = Math.round(r.height * 0.62) + 'px';
    } else if (tapLayer) { tapLayer.remove(); tapLayer = null; }

    if (settings.badgeOn) {
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'yt2c-badge';
        badge.style.cssText = 'position:fixed;z-index:2147483001;pointer-events:none;font:11px/1.3 system-ui,Arial,sans-serif;' +
          'color:#fff;background:rgba(0,0,0,.6);padding:2px 6px;border-radius:0 0 6px 0;max-width:90vw';
        document.documentElement.appendChild(badge);
      }
      badge.style.left = (r && r.width > 80 ? Math.round(r.left) : 0) + 'px';
      badge.style.top = (r && r.height > 60 ? Math.round(r.top) : 0) + 'px';
      badge.textContent = 'YT Learn · ' + (video ? 'video ✓' : 'no video') + ' · subtitles: ' + subState + (lastSend ? ' · ' + lastSend : '');
    } else if (badge) { badge.remove(); badge = null; }
  }
  setInterval(updateTapLayer, 300);
  window.addEventListener('scroll', updateTapLayer, true);

  function onPlay() {
    if (replaying) return;
    if (pending) { continueFromStart(); return; } // Space, the play arrow or a click on the video = "let's go"
    endWaiting();
    hideOverlay();
  }

  function onPause() {
    if (ourPause) { ourPause = false; return; }
    if (replaying) { // you paused during the replay: leave it there and send now
      const seg = replaying.seg;
      cancelReplay();
      beginWaiting(seg);
      runDeferredSend();
      return;
    }
    if (!settings.pauseOn) return;
    const v = video;
    // wait a moment: ignore pauses caused by seeking, the video ending, or ads
    setTimeout(() => {
      if (v.paused && !v.ended && !v.seeking && !isAd() && !handling) handlePause();
    }, 250);
  }

  // ---- waiting for "let's go" ----
  let rec = null;
  let recWanted = false;

  function beginWaiting(seg) {
    pending = seg;
    if (settings.voiceOn) startListening();
  }

  function endWaiting() {
    pending = null;
    stopListening();
  }

  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || rec) return;
    recWanted = true;
    try {
      rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'en-US';
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) onHeard(e.results[i][0].transcript);
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          recWanted = false;
          setHint('Microphone is blocked for youtube.com. Click the lock icon in the address bar → allow Microphone. (Enter still works.)');
        }
      };
      rec.onend = () => { rec = null; if (recWanted && pending) setTimeout(startListening, 300); }; // Chrome stops after silence
      rec.start();
    } catch (e) { rec = null; }
  }

  function stopListening() {
    recWanted = false;
    if (rec) { try { rec.abort(); } catch (e) { /* ignore */ } rec = null; }
  }

  function onHeard(text) {
    if (!pending) return;
    if (/\blet'?s\s+go\b|\blet\s+us\s+go\b/i.test(text || '')) continueFromStart();
  }

  // back to the start of the passage, then keep playing through the rest of the video
  function continueFromStart() {
    const seg = pending;
    if (!seg || !video) return;
    endWaiting();
    hideOverlay();
    video.currentTime = Math.max(0, seg.start - 0.3);
    video.play().catch(() => {});
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !pending) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    continueFromStart();
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'heard') onHeard(msg.text); // used by tests / other parts of the extension
  });

  // play the passage once at normal speed, then stop
  function startReplay(seg) {
    cancelReplay();
    const timer = setInterval(() => {
      const ct = video.currentTime;
      let idx = 0;
      seg.items.forEach((s, i) => { if (ct >= s.start - 0.1) idx = i; });
      setActive(idx);
      if (deferredSend && ct >= seg.end - 1.0) runDeferredSend(); // the last second of the replay: send now
      if (ct >= seg.end + 0.15) {
        cancelReplay();
        ourPause = true;
        video.pause();
        setActive(seg.items.length - 1);
        beginWaiting(seg);
        runDeferredSend(); // (only if it was not sent already)
      }
    }, 50);
    replaying = { seg, timer };
    video.currentTime = Math.max(0, seg.start - 0.3);
    video.play().catch(() => { cancelReplay(); beginWaiting(seg); runDeferredSend(); });
  }

  // ---- the picture for Claude: the subtitle screen, taken 3 seconds after you stop the video ----
  // 1) Chrome: a real screenshot of the tab, cut down to the subtitle area (no description, no comments).
  // 2) Anywhere else (iPhone / iPad app, or if Chrome refuses): the same screen drawn again from the text.
  function cropTo(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const k = img.naturalWidth / window.innerWidth; // screenshot pixels per page pixel
          const x = Math.max(0, Math.round(rect.left * k)), y = Math.max(0, Math.round(rect.top * k));
          const w = Math.min(img.naturalWidth - x, Math.round(rect.width * k)), h = Math.min(img.naturalHeight - y, Math.round(rect.height * k));
          if (w < 100 || h < 60) return resolve(null);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.85));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  function renderSubtitlePicture(seg) {
    try {
      const W = 1280, H = 720, pad = 48;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      const groups = groupSentences(seg.items).map((x) => x.text);
      let fs = Math.min(70, Math.max(24, H * levelShare(settings.textLevel) * 1.15));
      let blocks;
      for (;;) {
        g.font = '600 ' + fs + 'px system-ui, Arial, sans-serif';
        blocks = groups.map((t) => {
          const lines = [];
          let line = '';
          for (const word of t.split(/\s+/)) {
            const test = line ? line + ' ' + word : word;
            if (line && g.measureText(test).width > W - pad * 2) { lines.push(line); line = word; } else line = test;
          }
          if (line) lines.push(line);
          return lines;
        });
        const total = blocks.reduce((n, l) => n + l.length * fs * 1.35 + fs * 0.45, 0);
        if (total <= H - pad * 2 || fs <= 18) break;
        fs -= 2;
      }
      const total = blocks.reduce((n, l) => n + l.length * fs * 1.35 + fs * 0.45, 0);
      let y = Math.max(pad, (H - total) / 2) + fs;
      g.textBaseline = 'alphabetic';
      blocks.forEach((lines, bi) => {
        g.fillStyle = bi === blocks.length - 1 ? '#ffd60a' : '#ffffff'; // the sentence you stopped at is yellow
        lines.forEach((ln) => { g.fillText(ln, pad, y); y += fs * 1.35; });
        y += fs * 0.45;
      });
      return c.toDataURL('image/jpeg', 0.88);
    } catch (e) { return null; }
  }

  async function capturePicture(seg) {
    try {
      const el = document.getElementById(OVERLAY_ID);
      const r = await chrome.runtime.sendMessage({ type: 'capture' });
      if (r && r.dataUrl && el) {
        const cropped = await cropTo(r.dataUrl, el.getBoundingClientRect());
        if (cropped) return cropped;
      }
    } catch (e) { /* use the drawn picture */ }
    return renderSubtitlePicture(seg);
  }
  window.__ytcDebug.picture = (seg) => capturePicture(seg || (lastShown && lastShown.seg));

  async function handlePause() {
    handling = true;
    try {
      const t = video.currentTime;
      endWaiting();
      deferredSend = null;
      showOverlay({ note: '…' });
      const d = await loadTranscript();
      if (!video.paused) { hideOverlay(); return; } // you pressed play again meanwhile
      if (!d.sentences.length) {
        const why = (d.errors.join(' ').match(/playability ([A-Z_]+)(?: \(([^)]*)\))?/) || []);
        showOverlay({ note: 'No subtitles could be read for this video.' + (why[1] && why[1] !== 'OK' ? ' YouTube says: ' + (why[2] || why[1]) + '.' : '') });
        return;
      }
      const seg = pickSegment(d.sentences, t);
      showOverlay({ seg });
      // Claude only: 3 seconds after you stopped (the big subtitles are on screen by then) take the picture
      const wantPicture = settings.target === 'claude' && settings.imageOn;
      const pictureReady = wantPicture ? new Promise((resolve) => setTimeout(() => capturePicture(seg).then(resolve, () => resolve(null)), 3000)) : Promise.resolve(null);
      deferredSend = null;
      const sendNow = async () => {
        lastSend = 'sending…';
        const image = await pictureReady; // (already done long before the end of the replay; only waits when replay is off)
        try {
          chrome.runtime.sendMessage({ type: 'pause-send', videoId: videoId(), title: d.title, url: d.url, seg, image, lines: groupSentences(seg.items).map((g) => g.text) })
            .then((r) => {
              const ok = !!(r && /^Sent /.test(r.result));
              lastSend = ok ? 'sent to ' + targetName() + ' ✓' : 'NOT sent: ' + ((r && r.result) || 'no answer');
              setFoot('Not sent to ' + targetName() + ': ' + ((r && r.result) || 'no answer'), ok);
            })
            .catch(() => { lastSend = 'NOT sent (reload the page)'; setFoot('Not sent: refresh this YouTube page (Cmd+R)', false); });
        } catch (e) { lastSend = 'NOT sent (reload the page)'; setFoot('Not sent: refresh this YouTube page (Cmd+R)', false); }
      };
      if (settings.replayOn) {
        deferredSend = sendNow;
        
        startReplay(seg);
      } else {
        beginWaiting(seg);
        sendNow();
      }
    } finally {
      handling = false;
    }
  }
})();
