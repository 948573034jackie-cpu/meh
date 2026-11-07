// Runs on youtube.com. Reads the video and its subtitles for My tutor (dream/dream-yt.js, the same isolated world),
// listens to the microphone while the tutor waits for you, and keeps the small bar under the video (My tutor on / off,
// 🩺 Check, the tutor's status). The extension does nothing else on the page: the tutor does the teaching.

(function () {
  'use strict';
  if (window.__ytToClaudeLoaded) return;
  window.__ytToClaudeLoaded = true;
  const { parseJson3, parseClock, parseTranscriptResponse, judgeCues, extractPlayerResponse, pickTrack, isAsr, isHumanEnglish, judgeHuman, buildSentences } = window.YTC;

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
  // (tracks: the video's whole list; human = good English subtitles made by people, used as they are)
  async function cuesFromTrack(track, via, tracks) {
    // (set, not added: the phone-app list's address already asks for fmt=srv3, and YouTube follows the first one)
    const u0 = new URL(track.baseUrl, location.href);
    u0.searchParams.set('fmt', 'json3');
    const url = u0.href;
    const res = await fetch(url, { credentials: 'include' });
    const body = await res.text();
    if (!body) throw new Error('YouTube returned an empty caption file (status ' + res.status + ', list from the ' + via + ')');
    let json;
    try { json = JSON.parse(body); } catch (e) { throw new Error('the caption file was not readable (status ' + res.status + ')'); }
    const cues = parseJson3(json);
    if (!cues.length) throw new Error('caption file had no text');
    const human = isHumanEnglish(track, tracks) && judgeHuman(cues).ok;
    return { cues, human, source: 'captions (' + (track.languageCode || '?') + (isAsr(track) ? ', auto-generated' : human ? ', made by people' : '') + ', via ' + via + ')' };
  }

  // Method 1: the caption track the player itself uses (fetched with your normal YouTube session).
  async function fromCaptionTrack() {
    const { pr, via, note } = await getPlayerResponse();
    const tracks = trackList(pr);
    const track = pickTrack(tracks);
    if (!track) throw new Error('this video has no captions [' + note + ']');
    return cuesFromTrack(track, via, tracks);
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
    const tracks = trackList(pr);
    const track = pickTrack(tracks);
    if (!track) throw new Error('no captions in the phone-app answer (' + ((pr.playabilityStatus || {}).status || 'no status') + ')');
    return cuesFromTrack(track, 'phone-app list', tracks);
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
    // (a copy saved by 3.7 has no "human": a caption track that was not auto-generated was made by people)
    const human = typeof mine.human === 'boolean' ? mine.human : /^captions \(en[^,)]*, via/.test(mine.source || '') && judgeHuman(mine.cues).ok;
    return { cues: mine.cues, human, source: mine.source + ' — saved copy', fromSaved: true, length: mine.length || 0 };
  }
  async function saveCopy(cues, source, human) {
    try {
      const size = JSON.stringify(cues).length;
      if (size > 6000000) return; // absurdly big: skip
      const { subsCache = {} } = await chrome.storage.local.get('subsCache');
      subsCache[videoId()] = { cues, source, human: !!human, length: videoLength(), savedAt: Date.now() };
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
      // (an auto-generated file's address says kind=asr; a translated one says tlang)
      const human = !u.searchParams.get('kind') && !u.searchParams.get('tlang') && /^en/.test(u.searchParams.get('lang') || '') && judgeHuman(cues).ok;
      return { cues, human, source: 'the subtitles the player loaded (' + (u.searchParams.get('lang') || '?') + (human ? ', made by people' : '') + ')' };
    } finally {
      if (switchedOn && btn && btn.getAttribute('aria-pressed') === 'true') btn.click(); // put it back like it was
    }
  }

  // Method 5: open YouTube's own "Show transcript" panel and read it.
  async function fromTranscriptPanel() {
    // the description (with its "Show transcript" button) is drawn late on a fresh page: wait for it
    const expand = await waitFor(() => document.querySelector('#description-inline-expander #expand, ytd-text-inline-expander #expand'), 8000);
    if (expand) expand.click();
    const btn = await waitFor(() => {
      const b = document.querySelector('ytd-video-description-transcript-section-renderer button');
      return b || Array.from(document.querySelectorAll('button')).find((x) => /show transcript/i.test(x.textContent || x.getAttribute('aria-label') || ''));
    }, 10000);
    if (!btn) throw new Error('no "Show transcript" button on this page');
    btn.click();
    // YouTube has two page designs for the panel lines; read both
    const SEG = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
    const first = await waitFor(() => document.querySelectorAll(SEG).length || null, 12000);
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
  let lastLoaded = null;

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
          if (j.ok) { best = r; if (!r.fromSaved) saveCopy(r.cues, r.source, !!r.human); break; }
          errors.push(method.name + ': ' + j.reason + ' (kept as a backup)');
          if (!best || r.coverage > best.coverage) best = r;
        } catch (e) {
          if (method !== fromManualFile && method !== fromSavedCopy) errors.push(method.name + ': ' + e.message);
        }
      }
      if (best) {
        const cues = best.cues;
        lastLoaded = { cues };
        return { ...info, cues, human: !!best.human, sentences: buildSentences(cues, { human: !!best.human }), source: best.source, lines: cues.length, errors };
      }
      cache.promise = null; // nothing found: try again next time
      return { ...info, cues: [], sentences: [], source: null, lines: 0, errors };
    })();
    return cache.promise;
  }

  // ---- the video finder (dream-ext/src/finder.ts): YouTube search and any video's subtitles ----
  // FINDER-PURE-START (no outside names: dream-ext/test/finder.test.ts runs this part on its own)
  // The search page's data (ytInitialData) from its HTML: "ytInitialData = {...}" (www) or "ytInitialData = '\x7b...'" (m.)
  function finderInitialData(html) {
    html = String(html || '');
    const objectAt = (s, at) => { // a JSON object from s[at] === '{' (string-aware bracket matching)
      let depth = 0, inStr = false, esc = false;
      for (let i = at; i < s.length; i++) {
        const c = s[i];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { try { return JSON.parse(s.slice(at, i + 1)); } catch (e) { return null; } }
      }
      return null;
    };
    const stringAt = (s, at) => { // a quoted JavaScript string holding JSON, its escapes undone
      const q = s[at];
      let i = at + 1;
      for (; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === q) break; }
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
      const text = s.slice(at + 1, i).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (m, g) =>
        (g[0] === 'x' && g.length === 3) || (g[0] === 'u' && g.length === 5) ? String.fromCharCode(parseInt(g.slice(1), 16)) : (map[g] !== undefined ? map[g] : g));
      try { return JSON.parse(text); } catch (e) { return null; }
    };
    let from = 0;
    for (;;) {
      const at = html.indexOf('ytInitialData', from);
      if (at < 0) return null;
      from = at + 13;
      const m = /^["'\]]*\s*[:=]\s*(\{|JSON\.parse\(\s*["']|["'])/.exec(html.slice(from, from + 40));
      if (!m) continue;
      const valueAt = from + m[0].length - 1;
      const obj = m[1] === '{' ? objectAt(html, valueAt) : stringAt(html, valueAt);
      if (obj && typeof obj === 'object') return obj;
    }
  }
  // Every video in a search answer (WEB, MWEB or newer shapes): [{ id, title, channel, lengthSeconds?, thumb? }]
  function finderVideos(data, max) {
    max = max || 12;
    const out = [], seen = new Set();
    const text = (t) => !t ? '' : typeof t === 'string' ? t : t.simpleText || t.content || (Array.isArray(t.runs) ? t.runs.map((r) => r.text || '').join('') : '');
    const clock = (s) => { const m = /(?:(\d+):)?(\d+):(\d{2})/.exec(String(s || '')); return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) : undefined; };
    const thumbOf = (list) => { const t = Array.isArray(list) && list.length ? list[list.length - 1].url : ''; return t ? (t.startsWith('//') ? 'https:' + t : t) : undefined; };
    const add = (v) => {
      if (!v.id || !/^[\w-]{11}$/.test(v.id) || seen.has(v.id) || out.length >= max) return;
      seen.add(v.id);
      out.push({ id: v.id, title: (v.title || '').trim(), channel: (v.channel || '').trim(),
        lengthSeconds: v.lengthSeconds, thumb: v.thumb || 'https://i.ytimg.com/vi/' + v.id + '/mqdefault.jpg' });
    };
    const isLive = (r) => /"(LIVE|BADGE_STYLE_TYPE_LIVE_NOW|UPCOMING)"/.test(JSON.stringify([r.badges || [], r.thumbnailOverlays || [], r.upcomingEventData ? 'UPCOMING' : ''])) && !r.lengthText;
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 60 || out.length >= max) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      const r = o.videoRenderer || o.videoWithContextRenderer || o.compactVideoRenderer || o.gridVideoRenderer;
      if (r && r.videoId) {
        if (!isLive(r)) add({ id: r.videoId, title: text(r.title) || text(r.headline), channel: text(r.ownerText) || text(r.shortBylineText) || text(r.longBylineText),
          lengthSeconds: clock(text(r.lengthText)), thumb: thumbOf(r.thumbnail && r.thumbnail.thumbnails) });
        return;
      }
      const l = o.lockupViewModel;
      if (l && l.contentId && /VIDEO/.test(String(l.contentType || ''))) {
        const md = (l.metadata && l.metadata.lockupMetadataViewModel) || {};
        const rows = (((md.metadata || {}).contentMetadataViewModel || {}).metadataRows) || [];
        const parts = rows.length && rows[0].metadataParts ? rows[0].metadataParts : [];
        const img = (((l.contentImage || {}).thumbnailViewModel || {}).image || {}).sources;
        const s = JSON.stringify(l.contentImage || {});
        const len = /"text":"((?:\d+:)?\d+:\d{2})"/.exec(s);
        add({ id: l.contentId, title: text(md.title), channel: parts.length ? text(parts[0].text) : '', lengthSeconds: len ? clock(len[1]) : undefined, thumb: thumbOf(img) });
        return;
      }
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    })(data, 0);
    return out;
  }
  // FINDER-PURE-END

  // YouTube search, same origin (www or m.youtube.com): videos with subtitles first, then any video. Never throws.
  async function searchVideos(query) {
    try {
      const q = String(query || '').trim().slice(0, 150);
      if (!q) return [];
      for (const sp of ['&sp=EgIoAQ%3D%3D', '']) { // EgIoAQ== = the "Subtitles/CC" filter
        try {
          const res = await fetch('/results?search_query=' + encodeURIComponent(q) + sp, { credentials: 'include' });
          const hits = finderVideos(finderInitialData(await res.text()), 12);
          if (hits.length) return hits;
        } catch (e) { /* try without the filter */ }
      }
    } catch (e) { /* nothing */ }
    return [];
  }

  // The subtitles (cues) of ANY video, the cheap way (the phone-app player list, as fromAndroidTrack). [] = none / failed.
  async function cuesFor(id) {
    try {
      if (!/^[\w-]{11}$/.test(String(id || ''))) return [];
      const html = await getPageHtml();
      const key = (html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/) || [])[1];
      if (!key) return [];
      const res = await fetch('/youtubei/v1/player?key=' + encodeURIComponent(key) + '&prettyPrint=false', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en', gl: 'US' } },
          videoId: id, contentCheckOk: true, racyCheckOk: true
        })
      });
      const pr = await res.json();
      const track = pickTrack(trackList(pr));
      if (!track) return [];
      return (await cuesFromTrack(track, 'finder')).cues;
    } catch (e) { return []; }
  }

  // My tutor (dream/dream-yt.js, the same isolated world) reads the video and its subtitles through this
  window.__ytcApi = {
    loadTranscript, videoId, isAd: () => isAd(), video: () => video || document.querySelector('video'),
    // "voiceOn": the browser can hear you (the tutor then says "just talk" in a call)
    settings: () => ({ voiceOn: !!(window.SpeechRecognition || window.webkitSpeechRecognition) }),
    buildSentences: (cues, o) => buildSentences(cues, { words: true, human: !!(o && o.human) }),
    setBarStatus: (text, bad) => setBarStatus(text, bad),
    // what the microphone hears now is closed (Chrome gives it as final), then it listens again
    finishSpeech: () => { const r = rec; if (!r) return; try { r.stop(); } catch (e) { /* ignore */ } },
    micBlocked: () => recWanted === 'blocked',
    micState: () => ({ listening: !!rec, blocked: recWanted === 'blocked', lastError: micError, failsInARow: micFails }),
    micChangedAt: () => micAt,
    // 🩺 Check: the report over the page, with a Copy button (the app's bar has a button for it)
    showReport: () => showReport(),
    // the video finder: search YouTube (same origin) -> [{ id, title, channel, lengthSeconds?, thumb? }], and any video's cues
    searchVideos: (q) => searchVideos(q),
    cuesFor: (id) => cuesFor(id),
    videosFromInitialData: (data, max) => { try { return finderVideos(data, max); } catch (e) { return []; } },
  };

  window.__ytcDebug = {
    load: () => loadTranscript().then((d) => ({ title: d.title, lines: d.lines, sentences: d.sentences.length, source: d.source, errors: d.errors, first: d.sentences[0] && d.sentences[0].text, lastStart: d.cues.length ? d.cues[d.cues.length - 1].start : null })),
  };

  // ---- settings ----
  const settings = { barOn: true }; // the small bar under the video (the iPhone app has its own buttons: it sets barOn false)
  function readSettings(s) {
    if ('barOn' in s && window.__ytcShimYT) settings.barOn = s.barOn !== false; // (only the app hides it: it has its own buttons)
  }
  chrome.storage.local.get(['barOn']).then(readSettings);
  chrome.storage.onChanged.addListener((ch) => {
    const s = {};
    for (const k of Object.keys(ch)) s[k] = ch[k].newValue;
    readSettings(s);
    if (ch.barOn) { try { updateBar(); } catch (e) { /* ignore */ } }
  });

  // ---- the video ----
  let video = null;
  function isAd() {
    const p = document.querySelector('#movie_player');
    return !!(p && p.classList.contains('ad-showing'));
  }
  function bind() {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (v && v !== video) video = v;
  }
  setInterval(bind, 1000);
  bind();

  // Fetch the subtitles as soon as a video page is open, so the tutor starts at once.
  let preloadedFor = null;
  let subState = 'no video yet';
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

  function describeSubs(d) {
    if (d.sentences.length) return d.sentences.length + ' sentences';
    const why = (d.errors.join(' ').match(/playability ([A-Z_]+)(?: \(([^)]*)\))?/) || []);
    return 'none' + (why[1] && why[1] !== 'OK' ? ' (' + (why[2] || why[1]) + ')' : '');
  }

  // ---- the small bar just under the video: My tutor on / off (dream-yt.js adds that button), 🩺 Check, the status ----
  let bar = null;
  function updateBar(r) {
    const want = settings.barOn && location.pathname === '/watch';
    if (!want) { if (bar) { bar.remove(); bar = null; } return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'yt2c-bar';
      bar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 0;font:600 12px/1 system-ui,Arial,sans-serif;z-index:2147483000';
      const status = document.createElement('span');
      status.id = 'yt2c-b-status';
      status.style.cssText = 'font-weight:400;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45vw';
      const check = document.createElement('button');
      check.id = 'yt2c-b-check';
      check.textContent = '🩺 Check';
      check.title = 'Find out what is not working (you can copy the report)';
      check.style.cssText = 'border:1px solid #888;border-radius:14px;padding:6px 10px;font:inherit;cursor:pointer;color:inherit;background:transparent;min-width:40px';
      check.onclick = () => showReport();
      bar.append(check, status);
      try { if (window.__ytcDream) window.__ytcDream.decorateBar(bar); } catch (e) { /* ignore */ }
    }
    const below = document.querySelector('#below');   // desktop YouTube: right under the player, above the title
    if (below) {
      if (bar.parentElement !== below || below.firstChild !== bar) { bar.style.position = ''; below.insertBefore(bar, below.firstChild); }
    } else {                                           // other layouts (the phone's site): float just under the video
      if (bar.parentElement !== document.documentElement) document.documentElement.appendChild(bar);
      if (!r) { const v = video; r = v ? v.getBoundingClientRect() : null; }
      bar.style.position = 'fixed';
      bar.style.zIndex = '2147481000'; // (under the tutor's reading page)
      bar.style.left = (r && r.width > 80 ? Math.round(r.left) : 8) + 'px';
      bar.style.top = (r && r.height > 60 ? Math.round(r.bottom + 2) : 8) + 'px';
      bar.style.background = 'rgba(0,0,0,.55)';
      bar.style.color = '#fff';
      bar.style.borderRadius = '16px';
      bar.style.padding = '4px 8px';
    }
  }
  function placeBar() {
    const r = video ? video.getBoundingClientRect() : null;
    try { updateBar(r); } catch (e) { /* ignore */ }
  }
  setInterval(placeBar, 300);
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => setTimeout(placeBar, 50));
  window.addEventListener('scroll', placeBar, true);

  function setBarStatus(text, bad) {
    const st = document.getElementById('yt2c-b-status');
    if (!st) return;
    st.textContent = text;
    st.style.color = bad ? '#ff6b5e' : '';
    st.style.whiteSpace = bad ? 'normal' : 'nowrap';
  }

  // ---- 🩺 Check on the page (the phone has no extension window): the report, with a Copy button ----
  async function showReport() {
    let panel = document.getElementById('yt2c-report');
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'yt2c-report';
    panel.style.cssText = 'position:fixed;left:3%;right:3%;top:6%;bottom:6%;z-index:2147483647;background:#111;color:#eee;border:2px solid #555;border-radius:14px;' +
      'display:flex;flex-direction:column;font:14px/1.4 system-ui,Arial,sans-serif;box-shadow:0 10px 40px #000';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;gap:8px;align-items:center;padding:10px;border-bottom:1px solid #333';
    const title = document.createElement('b'); title.textContent = '🩺 Check'; title.style.flex = '1';
    const btn = (t, f) => { const b = document.createElement('button'); b.textContent = t; b.style.cssText = 'border:0;border-radius:12px;padding:10px 16px;font:600 15px system-ui;background:#2b6de8;color:#fff'; b.onclick = f; return b; };
    const pre = document.createElement('pre');
    pre.id = 'yt2c-report-text';
    pre.style.cssText = 'flex:1;overflow:auto;margin:0;padding:12px;white-space:pre-wrap;word-break:break-word;-webkit-user-select:text;user-select:text';
    pre.textContent = 'Checking…';
    const copy = btn('Copy report', async () => {
      try { await navigator.clipboard.writeText(pre.textContent); copy.textContent = 'Copied ✓'; }
      catch (e) { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); copy.textContent = 'Selected: tap Copy'; }
    });
    top.append(title, copy, btn('Close', () => panel.remove()));
    panel.append(top, pre);
    (document.fullscreenElement || document.webkitFullscreenElement || document.documentElement).appendChild(panel);
    try {
      const r = await chrome.runtime.sendMessage({ type: 'diagnose' });
      pre.textContent = (r && r.report) || 'No answer from the extension. Close Safari fully (swipe it away), open it again, and press Check again. If it still says this: Settings → Apps → Safari → Extensions → the extension must be on, and allowed on youtube.com.';
    } catch (e) { pre.textContent = 'The extension did not answer (' + e.message + '). Reload this page and press Check again.'; }
  }

  // ---- the microphone: only while the tutor waits for you (I know / I don't know, a question, a call, voice mode) ----
  // (a microphone in use with echo cancelling makes all other sound quieter and muffled on a Mac: so never otherwise)
  let rec = null;
  let recWanted = false;
  /** the microphone's last error and how often in a row it failed (for 🩺 Check) */
  let micError = '', micErrorAt = 0, micFails = 0, micRetryAt = 0;
  let recSession = 0;
  // when the microphone last went on or off (a phone may stop the video's sound for a moment then)
  let micAt = 0;
  function dreamOwns() { try { return !!(window.__ytcDream && window.__ytcDream.owns()); } catch (e) { return false; } }
  function dreamWantsMic() { try { const d = window.__ytcDream; return !!(d && (!d.wantsMic || d.wantsMic())); } catch (e) { return false; } }
  // a voice call with the tutor listens whatever else is going on
  function dreamCallOpen() { try { const d = window.__ytcDream; return !!(d && d.callOpen && d.callOpen()); } catch (e) { return false; } }
  setInterval(() => {
    const want = ((dreamOwns() && dreamWantsMic()) || dreamCallOpen()) && location.pathname === '/watch' && !!video;
    if (want && !rec && recWanted !== 'blocked' && Date.now() >= micRetryAt) startListening();
    if (!want && rec) stopListening();
  }, 500);

  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || rec || recWanted === 'blocked') return;
    recWanted = true;
    try {
      const r = new SR();
      rec = r;
      r.continuous = true;
      r.interimResults = true;
      r.lang = 'en-US';
      const session = ++recSession;
      r.onresult = (e) => {
        if (rec !== r) return; // an old listener
        // the tutor gets each closed sentence, then everything still being heard as ONE line (Chrome sends the
        // unfinished words in two or more pieces)
        let tail = '', tailKey = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) onHeard(e.results[i][0].transcript, true, session + ':' + i);
          else { if (!tailKey) tailKey = session + ':' + i; tail += ' ' + e.results[i][0].transcript; }
        }
        if (tailKey) onHeard(tail.replace(/\s+/g, ' ').trim(), false, tailKey);
      };
      r.onerror = (e) => {
        micError = String(e.error || 'error'); micErrorAt = Date.now();
        // (the iPhone app says "service-not-allowed" only when the microphone or speech recognition is really refused;
        // "unavailable" / recognizer errors: not blocked, it tries again a little later)
        if (e.error === 'not-allowed' || (e.error === 'service-not-allowed' && !window.__ytcShimYT)) {
          recWanted = 'blocked';
          setBarStatus(window.__ytcSafari || navigator.maxTouchPoints > 1
            ? 'The microphone is blocked. iPhone Settings → this app → allow the Microphone and Speech Recognition. (You can type.)'
            : 'The microphone is blocked for youtube.com. Click the lock icon in the address bar → allow Microphone. (You can type.)', true);
        }
      };
      r.onend = () => { // Chrome stops after silence: listen again (a late "end" of an OLD listener changes nothing)
        if (rec !== r) return;
        rec = null;
        micAt = Date.now();
        // (failing again and again: wait longer each time, up to 5 s, so the phone is not busy restarting)
        const failing = Date.now() - micErrorAt < 1500;
        micFails = failing ? micFails + 1 : 0;
        const wait = failing ? Math.min(5000, 300 * 2 ** micFails) : 300;
        micRetryAt = Date.now() + wait;
        if (recWanted === true) setTimeout(startListening, wait);
      };
      micAt = Date.now();
      r.start();
    } catch (e) { rec = null; }
  }

  // back on the page (perhaps from the Settings, where the microphone was allowed): try the microphone again
  document.addEventListener('visibilitychange', () => { if (!document.hidden && recWanted === 'blocked') recWanted = false; });
  // (a new video: the microphone may be tried again)
  document.addEventListener('yt-navigate-finish', () => { if (recWanted === 'blocked') recWanted = false; });

  function stopListening() {
    if (recWanted !== 'blocked') recWanted = false;
    if (rec) { micAt = Date.now(); try { rec.abort(); } catch (e) { /* ignore */ } rec = null; }
  }

  // What the video itself is saying right now: if its own subtitles say "bro", that "hi bro" was not you.
  const HI_BRO = /\b(hi|hey|high|hai|hay|yo)[\s,.!]*(bro|bruh|brah|bra|brother|bros)\b/i;
  function videoIsSaying(re) {
    try {
      const d = cache.promise && cache.id === videoId() ? lastLoaded : null;
      if (!d || !video) return false;
      const t = video.currentTime;
      return d.cues.some((c) => c.start <= t + 1 && (c.end || c.start + 5) >= t - 6 && re.test(c.text));
    } catch (e) { return false; }
  }

  // what was heard goes to the tutor (I know / I don't know / go on, hi bro, shut up, a question)
  function onHeard(text, isFinal, key) {
    text = String(text || '');
    if (!dreamOwns()) return;
    if (HI_BRO.test(text) && videoIsSaying(/\bbro\b|\bbruh\b/i)) return;
    try { window.__ytcDream.heard(text, isFinal, key); } catch (e) { /* ignore */ }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'reload-subs') { // you loaded a subtitle file: read this video again
      cache = { id: null, promise: null };
      preloadedFor = null;
      loadTranscript().then((d) => {
        sendResponse({ lines: d.lines, source: d.source, errors: d.errors });
        try { if (window.__ytcDream && window.__ytcDream.reload) window.__ytcDream.reload(); } catch (e) { /* ignore */ } // the tutor reads the video again
      });
      return true;
    }
    if (msg && msg.type === 'yt-diag') { // for the 🩺 check
      const r = video ? video.getBoundingClientRect() : null;
      sendResponse({ url: location.href.slice(0, 80), visible: document.visibilityState, video: !!video,
        videoSize: r ? Math.round(r.width) + 'x' + Math.round(r.height) : null, paused: video ? video.paused : null, muted: video ? video.muted : null,
        volume: video ? video.volume : null, time: video ? +video.currentTime.toFixed(1) : null, subtitles: subState, bar: !!bar,
        microphone: recWanted === 'blocked' ? 'blocked' : rec ? 'listening' : 'off',
        safari: !!window.__ytcSafari, touch: navigator.maxTouchPoints > 0, tutor: window.__ytcDream && window.__ytcDream.diag ? window.__ytcDream.diag() : null });
      return;
    }
    if (msg && msg.type === 'heard') onHeard(msg.text, msg.final !== false, msg.key); // used by the tests
  });
})();
