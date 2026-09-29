// Runs on youtube.com. Reads the video info + transcript when the service worker asks.

(function () {
  'use strict';
  if (window.__ytToClaudeLoaded) return;
  window.__ytToClaudeLoaded = true;
  const { parseJson3, parseSubtitleFile, parseClock, parseTranscriptResponse, judgeCues, extractPlayerResponse, pickTrack, formatTranscript, buildSentences, pickSegment, groupSentences, fmtTime } = window.YTC;

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

  // The page of the video we are on, fetched once per video (it holds the player data and the transcript address).
  let htmlCache = { id: null, promise: null };
  function getPageHtml() {
    const id = videoId();
    if (htmlCache.id !== id || !htmlCache.promise) {
      const promise = fetch(location.href, { credentials: 'include' }).then((r) => r.text());
      promise.catch(() => { if (htmlCache.promise === promise) htmlCache = { id: null, promise: null }; });
      htmlCache = { id, promise };
    }
    return htmlCache.promise;
  }

  // what we learn about the video on the way: its length (to check the transcript) and its real title
  let meta = { id: null, length: 0, title: '', author: '' };
  function noteMeta(pr) {
    const d = pr && pr.videoDetails;
    if (!d || (d.videoId && d.videoId !== videoId())) return;
    meta = { id: videoId(), length: Number(d.lengthSeconds) || meta.length || 0, title: d.title || meta.title, author: d.author || meta.author };
  }
  function videoLength() {
    if (meta.id === videoId() && meta.length) return meta.length;
    return video && isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  }

  // The video's player data: first from the page itself, then by asking YouTube's own API the way the page does.
  async function getPlayerResponse() {
    const html = await getPageHtml();
    const fromPage = extractPlayerResponse(html);
    noteMeta(fromPage);
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
        noteMeta(fromApi);
        if (trackList(fromApi).length) return { pr: fromApi, via: 'api' };
      }
    } catch (e) { apiNote = 'api: ' + e.message; }
    const pr = fromPage || fromApi;
    const ps = pr && pr.playabilityStatus;
    return { pr, via: 'none', note: 'page ' + html.length + ' bytes, ' + (fromPage ? 'player data found' : 'no player data') +
      (ps ? ', playability ' + ps.status + (ps.reason ? ' (' + ps.reason + ')' : '') : '') + (apiNote ? ', ' + apiNote : '') };
  }

  // download one caption track (timed text) and turn it into cues
  async function cuesFromTrack(track, via) {
    const url = track.baseUrl + (track.baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    const res = await fetch(url, { credentials: 'include' });
    const body = await res.text();
    if (!body) throw new Error('YouTube returned an empty caption file (status ' + res.status + ', list from the ' + via + ')');
    let json;
    try { json = JSON.parse(body); } catch (e) { throw new Error('the caption file was not readable (status ' + res.status + ')'); }
    const cues = parseJson3(json);
    if (!cues.length) throw new Error('caption file had no text');
    return { cues, source: 'captions (' + (track.languageCode || '?') + (track.kind === 'asr' ? ', auto-generated' : '') + ', via ' + via + ')' };
  }

  // Method 1: the caption track the player itself uses (fetched with your normal YouTube session).
  async function fromCaptionTrack() {
    const { pr, via, note } = await getPlayerResponse();
    const track = pickTrack(trackList(pr));
    if (!track) throw new Error('this video has no captions [' + note + ']');
    return cuesFromTrack(track, via);
  }

  // Method 2: the same captions, asked the way YouTube's phone app asks (its caption addresses need no extra key).
  async function fromAndroidTrack() {
    const html = await getPageHtml();
    const key = (html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/) || [])[1];
    if (!key) throw new Error('no API key in the page');
    const res = await fetch('/youtubei/v1/player?key=' + encodeURIComponent(key) + '&prettyPrint=false', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en', gl: 'US' } },
        videoId: videoId(), contentCheckOk: true, racyCheckOk: true
      })
    });
    let pr;
    try { pr = await res.json(); } catch (e) { throw new Error('the phone-app answer was not readable (status ' + res.status + ')'); }
    noteMeta(pr);
    const track = pickTrack(trackList(pr));
    if (!track) throw new Error('no captions in the phone-app answer (' + ((pr.playabilityStatus || {}).status || 'no status') + ')');
    return cuesFromTrack(track, 'phone-app list');
  }

  // Method 3: YouTube's own transcript service (what the "Show transcript" button uses), asked directly:
  // every line comes with its exact start time, nothing depends on what is drawn on the page.
  async function fromTranscriptApi() {
    const html = await getPageHtml();
    const raw = (html.match(/"getTranscriptEndpoint":\s*\{\s*"params":\s*"([^"]+)"/) || [])[1];
    if (!raw) throw new Error('this page has no transcript address');
    let params = raw;
    try { params = JSON.parse('"' + raw + '"'); } catch (e) { /* keep as is */ }
    const key = (html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/) || [])[1];
    const version = (html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":\s*"([^"]+)"/) || [])[1] || '2.20240101.00.00';
    if (!key) throw new Error('no API key in the page');
    const res = await fetch('/youtubei/v1/get_transcript?key=' + encodeURIComponent(key) + '&prettyPrint=false', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: version, hl: 'en' } }, params })
    });
    let json;
    try { json = await res.json(); } catch (e) { throw new Error('the transcript service answer was not readable (status ' + res.status + ')'); }
    const cues = parseTranscriptResponse(json);
    if (!cues.length) throw new Error('the transcript service returned no lines (status ' + res.status + ')');
    return { cues, source: 'YouTube transcript service' };
  }

  // Method 0: a subtitle file you loaded for this video in the extension window (.srt / .vtt / .txt)
  async function fromManualFile() {
    const { manualSubs } = await chrome.storage.local.get('manualSubs');
    const mine = manualSubs && manualSubs[videoId()];
    if (!mine || !mine.length) throw new Error('no subtitle file was loaded for this video');
    return { cues: mine, source: 'the subtitle file you loaded (' + mine.length + ' lines)', trusted: true };
  }

  // Method 0b: the copy of this video's subtitles saved the last time (opens instantly, also in a new window)
  async function fromSavedCopy() {
    const { subsCache } = await chrome.storage.local.get('subsCache');
    const mine = subsCache && subsCache[videoId()];
    if (!mine || !mine.cues || !mine.cues.length) throw new Error('nothing saved for this video yet');
    return { cues: mine.cues, source: mine.source + ' — saved copy', fromSaved: true, length: mine.length || 0 };
  }
  async function saveCopy(cues, source) {
    try {
      const size = JSON.stringify(cues).length;
      if (size > 6000000) return; // absurdly big: skip
      const { subsCache = {} } = await chrome.storage.local.get('subsCache');
      subsCache[videoId()] = { cues, source, length: videoLength(), savedAt: Date.now() };
      const ids = Object.keys(subsCache).sort((a, b) => subsCache[a].savedAt - subsCache[b].savedAt);
      while (ids.length > 25) delete subsCache[ids.shift()]; // keep the newest 25 videos
      await chrome.storage.local.set({ subsCache });
    } catch (e) { /* saving is a bonus */ }
  }

  // Method 4: the subtitles the PLAYER itself downloads. Switch the CC button on for a moment, find the
  // address the player used (it carries the player's own permission), and read that file. It holds the
  // whole video, also a 3-hour one.
  async function fromPlayerCaptions() {
    const id = videoId();
    const find = () => {
      const list = performance.getEntriesByType('resource').filter((e) => /\/api\/timedtext\?/.test(e.name) && e.name.includes('v=' + id));
      const ok = list.filter((e) => !/[?&]tlang=/.test(e.name)); // not YouTube's auto-translation
      const pool = ok.length ? ok : list;
      return pool.filter((e) => /[?&]lang=en/.test(e.name)).pop() || pool.pop() || null;
    };
    let entry = find();
    const btn = document.querySelector('.ytp-subtitles-button');
    let switchedOn = false;
    try {
      if (!entry) {
        if (!btn) throw new Error('no CC button on this page');
        if (btn.getAttribute('aria-pressed') !== 'true') { btn.click(); switchedOn = true; }
        entry = await waitFor(find, 7000);
        if (!entry) throw new Error('the player did not download subtitles (does this video have any?)');
      }
      const u = new URL(entry.name, location.href);
      u.searchParams.set('fmt', 'json3');
      const res = await fetch(u.href, { credentials: 'include' });
      const body = await res.text();
      if (!body) throw new Error('the player subtitle file was empty (status ' + res.status + ')');
      let json;
      try { json = JSON.parse(body); } catch (e) { throw new Error('the player subtitle file was not readable'); }
      const cues = parseJson3(json);
      if (!cues.length) throw new Error('the player subtitle file had no text');
      return { cues, source: 'the subtitles the player loaded (' + (u.searchParams.get('lang') || '?') + ')' };
    } finally {
      if (switchedOn && btn && btn.getAttribute('aria-pressed') === 'true') btn.click(); // put it back like it was
    }
  }

  // Method 5: open YouTube's own "Show transcript" panel and read it.
  async function fromTranscriptPanel() {
    const expand = document.querySelector('#description-inline-expander #expand, ytd-text-inline-expander #expand');
    if (expand) expand.click();
    const btn = await waitFor(() => {
      const b = document.querySelector('ytd-video-description-transcript-section-renderer button');
      return b || Array.from(document.querySelectorAll('button')).find((x) => /show transcript/i.test(x.textContent || x.getAttribute('aria-label') || ''));
    }, 3000);
    if (!btn) throw new Error('no "Show transcript" button on this page');
    btn.click();
    // YouTube has two page designs for the panel lines; read both
    const SEG = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
    const first = await waitFor(() => document.querySelectorAll(SEG).length || null, 8000);
    if (!first) throw new Error('transcript panel did not load');
    // A long video fills the panel piece by piece: wait until it stops growing.
    let count = document.querySelectorAll(SEG).length, lastChange = Date.now();
    const end = Date.now() + 15000;
    while (Date.now() < end && Date.now() - lastChange < 1500) {
      await sleep(250);
      const n = document.querySelectorAll(SEG).length;
      if (n !== count) { count = n; lastChange = Date.now(); }
    }
    const cues = [];
    document.querySelectorAll(SEG).forEach((seg) => {
      const tsEl = seg.querySelector('.segment-timestamp, [class*="Timestamp"]');
      const el = seg.querySelector('.segment-text, [class*="AttributedString"]');
      // innerText: hidden copies are left out; only the "1:05" clock counts, not "1 minute, 5 seconds"
      let start = parseClock(String((tsEl && (tsEl.innerText || tsEl.textContent)) || ''));
      let text = String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
      if (start === null || !text) { // unknown design: the line is "clock, then the words"
        const lines = String(seg.innerText || seg.textContent || '').split('\n').map((x) => x.trim()).filter(Boolean);
        const i = lines.findIndex((x) => /^\d+:\d{2}/.test(x));
        if (i >= 0) {
          start = parseClock(lines[i]);
          text = lines.filter((x, k) => k !== i && !/^\d+ (hours?|minutes?|seconds?)/i.test(x)).join(' ').replace(/\s+/g, ' ').trim();
        }
      }
      if (text && start !== null) cues.push({ start, text });
    });
    if (!cues.length) throw new Error('transcript panel was empty');
    return { cues, source: 'YouTube transcript panel (' + cues.length + ' lines)' };
  }

  async function getInfo() {
    try { await getPlayerResponse(); } catch (e) { /* the title falls back to the page */ }
    const title = (document.querySelector('h1.ytd-watch-metadata, h1 yt-formatted-string') || {}).textContent ||
      document.title.replace(/ - YouTube$/, '');
    const channel = (document.querySelector('ytd-channel-name a, #owner #channel-name a') || {}).textContent || '';
    const v = videoId();
    const url = v ? 'https://www.youtube.com/watch?v=' + v : location.href;
    const known = meta.id === v; // the player data of THIS video (the page text can still show the last video)
    return { title: ((known && meta.title) || title).trim(), channel: ((known && meta.author) || channel).trim(), url };
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
      let best = null;
      for (const method of [fromManualFile, fromSavedCopy, fromCaptionTrack, fromAndroidTrack, fromTranscriptApi, fromPlayerCaptions, fromTranscriptPanel]) {
        try {
          const r = await method();
          if (r.trusted) { best = r; break; } // a file you loaded yourself: always used
          const j = judgeCues(r.cues, videoLength() || r.length || 0);
          if (j.tooLate) { errors.push(method.name + ': ' + j.reason); continue; } // another video's transcript: never use
          r.coverage = j.coverage;
          if (j.ok) { best = r; if (!r.fromSaved) saveCopy(r.cues, r.source); break; }
          errors.push(method.name + ': ' + j.reason + ' (kept as a backup)');
          if (!best || r.coverage > best.coverage) best = r;
        } catch (e) {
          if (method !== fromManualFile && method !== fromSavedCopy) errors.push(method.name + ': ' + e.message);
        }
      }
      if (best) {
        const cues = best.cues;
        return { ...info, cues, sentences: buildSentences(cues), transcript: formatTranscript(cues), source: best.source, lines: cues.length, errors };
      }
      cache.promise = null; // nothing found: try again next time
      return { ...info, cues: [], sentences: [], transcript: null, source: null, lines: 0, errors };
    })();
    return cache.promise;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'reload-subs') { // you loaded a subtitle file: read this video again
      cache = { id: null, promise: null };
      preloadedFor = null;
      loadTranscript().then((d) => sendResponse({ lines: d.lines, source: d.source, errors: d.errors }));
      return true;
    }
    if (!msg || msg.type !== 'yt-get') return;
    loadTranscript().then((d) => sendResponse({
      title: d.title, channel: d.channel, url: d.url, transcript: d.transcript,
      source: d.source, lines: d.lines, errors: d.errors
    }));
    return true;
  });

  window.__ytcDebug = {
    load: () => loadTranscript().then((d) => ({ title: d.title, lines: d.lines, sentences: d.sentences.length, source: d.source, errors: d.errors, first: d.sentences[0] && d.sentences[0].text, lastStart: d.cues.reduce((m, c) => Math.max(m, c.start), 0) }))
  };

  // ---- settings (set in the popup) ----
  const settings = { pauseOn: true, replayOn: true, textLevel: 6, voiceOn: true, target: 'claude', tapOn: false, badgeOn: false, imageOn: true, barOn: true };
  function readSettings(s) {
    if ('pauseOn' in s) settings.pauseOn = s.pauseOn !== false;
    if ('voiceOn' in s) settings.voiceOn = s.voiceOn !== false;
    if ('replayOn' in s) settings.replayOn = s.replayOn !== false;
    if ('textLevel' in s) settings.textLevel = Math.min(10, Math.max(1, Number(s.textLevel) || 6)); // 1..10, in steps of 0.25
    if ('target' in s) settings.target = s.target === 'chatgpt' ? 'chatgpt' : 'claude';
    if ('tapOn' in s) settings.tapOn = s.tapOn === true;     // touch the video = pause / play (phone + iPad app)
    if ('badgeOn' in s) settings.badgeOn = s.badgeOn === true; // small status label on the video
    if ('barOn' in s) settings.barOn = s.barOn !== false;       // small Claude | ChatGPT | Send bar under the video
    if ('imageOn' in s) settings.imageOn = s.imageOn !== false; // Claude only: also send a picture of the paused video
  }
  chrome.storage.local.get(['pauseOn', 'replayOn', 'voiceOn', 'textLevel', 'target', 'tapOn', 'badgeOn', 'imageOn', 'barOn']).then(readSettings);
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

  // ---- small bar just under the video: Claude | ChatGPT | Send video ----
  let bar = null;
  function updateBar(r) {
    const want = settings.barOn && location.pathname === '/watch';
    if (!want) { if (bar) { bar.remove(); bar = null; } return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'yt2c-bar';
      bar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 0;font:600 12px/1 system-ui,Arial,sans-serif;z-index:2147483000';
      const mk = (id, text, extra) => { const b = document.createElement('button'); b.id = id; b.textContent = text; b.style.cssText = 'border:1px solid #888;border-radius:14px;padding:5px 11px;font:inherit;cursor:pointer;background:transparent;color:inherit;' + (extra || ''); return b; };
      const claude = mk('yt2c-b-claude', 'Claude'), gpt = mk('yt2c-b-chatgpt', 'ChatGPT'), send = mk('yt2c-b-send', 'Send video ▸', 'margin-left:4px');
      const status = document.createElement('span');
      status.id = 'yt2c-b-status';
      status.style.cssText = 'font-weight:400;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45vw';
      const pick = (t) => { settings.target = t; chrome.storage.local.set({ target: t }); updateBar(); };
      claude.onclick = () => pick('claude');
      gpt.onclick = () => pick('chatgpt');
      send.onclick = async () => {
        status.textContent = 'Sending…';
        try {
          const res = await chrome.runtime.sendMessage({ type: 'send', target: settings.target });
          const text = (res && res.result) || 'no answer';
          status.textContent = /^Sent /.test(text) ? 'Sent to ' + targetName() + ' ✓' : text.slice(0, 120);
        } catch (e) { status.textContent = 'Not sent: reload this YouTube page'; }
      };
      bar.append(claude, gpt, send, status);
    }
    const on = settings.target === 'chatgpt' ? 'chatgpt' : 'claude';
    for (const id of ['claude', 'chatgpt']) {
      const b = bar.querySelector('#yt2c-b-' + id);
      const active = id === on;
      b.style.background = active ? (id === 'claude' ? '#d97757' : '#10a37f') : 'transparent';
      b.style.color = active ? '#fff' : 'inherit';
      b.style.borderColor = active ? 'transparent' : '#888';
    }
    const below = document.querySelector('#below');   // desktop YouTube: right under the player, above the title
    if (below) {
      if (bar.parentElement !== below || below.firstChild !== bar) { bar.style.position = ''; below.insertBefore(bar, below.firstChild); }
    } else {                                           // other layouts: float just under the video
      if (bar.parentElement !== document.documentElement) document.documentElement.appendChild(bar);
      bar.style.position = 'fixed';
      bar.style.left = (r && r.width > 80 ? Math.round(r.left) : 8) + 'px';
      bar.style.top = (r && r.height > 60 ? Math.round(r.bottom + 2) : 8) + 'px';
      bar.style.background = 'rgba(0,0,0,.55)';
      bar.style.color = '#fff';
      bar.style.borderRadius = '16px';
      bar.style.padding = '4px 8px';
    }
  }

  function updateTapLayer() {
    const r = video ? video.getBoundingClientRect() : null;
    const ok = !!r && r.width > 80 && r.height > 60 && location.pathname === '/watch';
    try { updateBar(r); } catch (e) { /* ignore */ }
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

  function renderSubtitlePicture(seg, withCard) {
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
        if (total <= H - pad * 2 - (withCard ? 150 : 0) || fs <= 18) break;
        fs -= 2;
      }
      const total = blocks.reduce((n, l) => n + l.length * fs * 1.35 + fs * 0.45, 0);
      const top = withCard ? 62 : 0;
      let y = Math.max(pad + top, top + (H - top - (withCard ? 88 : 0) - total) / 2) + fs;
      g.textBaseline = 'alphabetic';
      if (withCard) { // for Claude's voice mode, where nothing can be typed: the picture carries the question too
        g.fillStyle = '#8ab4f8';
        g.font = '600 26px system-ui, Arial, sans-serif';
        g.fillText('Paused at ' + fmtTime(seg.pausedAt !== undefined ? seg.pausedAt : seg.end) + '  ·  this part of the video: ' + fmtTime(seg.start) + ' – ' + fmtTime(seg.end), pad, 44);
        g.font = '600 ' + fs + 'px system-ui, Arial, sans-serif';
      }
      blocks.forEach((lines, bi) => {
        g.fillStyle = bi === blocks.length - 1 ? '#ffd60a' : '#ffffff'; // the sentence you stopped at is yellow
        lines.forEach((ln) => { g.fillText(ln, pad, y); y += fs * 1.35; });
        y += fs * 0.45;
      });
      if (withCard) {
        g.fillStyle = '#8ab4f8';
        g.font = '600 24px system-ui, Arial, sans-serif';
        const ask = ['Please explain this part to me like an English teacher: what is happening and the important idea.', 'Then say the sentences above once more. Answer by voice, with no greeting and no lists.'];
        ask.forEach((ln, i) => g.fillText(ln, pad, H - 58 + i * 32));
      }
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
  window.__ytcDebug.card = (seg) => renderSubtitlePicture(seg || (lastShown && lastShown.seg), true);

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
        showOverlay({ note: 'No subtitles could be read for this video.' + (why[1] && why[1] !== 'OK' ? ' YouTube says: ' + (why[2] || why[1]) + '.' : '') + ' Tip: turn on CC in the player, or load a subtitle file (.srt / .vtt) in the extension window.' });
        return;
      }
      const seg = pickSegment(d.sentences, t);
      showOverlay({ seg });
      // Claude only: 3 seconds after you stopped (the big subtitles are on screen by then) take the picture
      const wantPicture = settings.target === 'claude' && settings.imageOn;
      const pictureReady = wantPicture ? new Promise((resolve) => setTimeout(() => capturePicture(seg).then((shot) => resolve({ shot, card: renderSubtitlePicture(seg, true) }), () => resolve(null)), 3000)) : Promise.resolve(null);
      deferredSend = null;
      const sendNow = async () => {
        lastSend = 'sending…';
        const pics = await pictureReady; // (already done long before the end of the replay; only waits when replay is off)
        const image = pics && pics.shot, card = pics && pics.card;
        try {
          chrome.runtime.sendMessage({ type: 'pause-send', videoId: videoId(), title: d.title, url: d.url, seg, image, card, lines: groupSentences(seg.items).map((g) => g.text) })
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
