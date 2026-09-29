// Runs on youtube.com. Reads the video info + transcript when the service worker asks.

if (!window.__ytToClaudeLoaded) {
  window.__ytToClaudeLoaded = true;
  const { parseJson3, extractPlayerResponse, pickTrack, formatTranscript, buildSentences, pickSegment, fmtTime } = window.YTC;

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

  // Method 1: the caption track the player itself uses (fetched with your normal YouTube session).
  async function fromCaptionTrack() {
    const html = await (await fetch(location.href, { credentials: 'include' })).text();
    const pr = extractPlayerResponse(html);
    const tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
      pr.captions.playerCaptionsTracklistRenderer.captionTracks;
    const track = pickTrack(tracks);
    if (!track) throw new Error('this video has no captions');
    const url = track.baseUrl + (track.baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    const res = await fetch(url, { credentials: 'include' });
    const body = await res.text();
    if (!body) throw new Error('YouTube returned an empty caption file');
    const cues = parseJson3(JSON.parse(body));
    if (!cues.length) throw new Error('caption file had no text');
    return { cues, source: 'captions (' + (track.languageCode || '?') + (track.kind === 'asr' ? ', auto-generated' : '') + ')' };
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
      const text = ((s.querySelector('.segment-text') || {}).textContent || '').replace(/\s+/g, ' ').trim();
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

  // ---- settings (set in the popup) ----
  const settings = { pauseOn: true, replayOn: true };
  chrome.storage.local.get(['pauseOn', 'replayOn']).then((s) => {
    settings.pauseOn = s.pauseOn !== false;
    settings.replayOn = s.replayOn !== false;
  });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.pauseOn) settings.pauseOn = ch.pauseOn.newValue !== false;
    if (ch.replayOn) settings.replayOn = ch.replayOn.newValue !== false;
  });

  // ---- big sentences on the video ----
  const OVERLAY_ID = 'yt2c-overlay';

  function hideOverlay() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.remove();
  }

  function setActive(index) {
    const el = document.getElementById(OVERLAY_ID);
    if (!el) return;
    el.querySelectorAll('[data-i]').forEach((n) => {
      const on = Number(n.dataset.i) === index;
      n.style.opacity = on ? '1' : '0.55';
      n.style.color = on ? '#ffd60a' : '#ffffff';
    });
  }

  function showOverlay({ note, seg, activeIndex }) {
    const host = document.querySelector('#movie_player') || (video && video.parentElement) || document.body;
    hideOverlay();
    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    // pointer-events:none → clicking the video still pauses/plays as normal
    el.style.cssText = 'position:absolute;inset:0;z-index:2000;display:flex;flex-direction:column;justify-content:center;' +
      'align-items:center;padding:4% 6%;background:rgba(0,0,0,.84);color:#fff;font-family:system-ui,Arial,sans-serif;' +
      'text-align:center;pointer-events:none;box-sizing:border-box;overflow:hidden';
    const head = document.createElement('div');
    head.style.cssText = 'font-size:16px;opacity:.7;margin-bottom:2%';
    head.textContent = note || '';
    el.appendChild(head);
    const body = document.createElement('div');
    body.style.cssText = 'line-height:1.35;font-weight:600';
    if (seg) {
      seg.items.forEach((s, i) => {
        const p = document.createElement('div');
        p.dataset.i = String(i);
        p.style.cssText = 'margin:0 0 .5em;transition:opacity .15s';
        p.textContent = s.text;
        body.appendChild(p);
      });
    }
    el.appendChild(body);
    host.appendChild(el);
    if (seg) {
      // make the text as big as fits
      let size = Math.max(22, Math.min(72, el.clientWidth / 18));
      body.style.fontSize = size + 'px';
      while (size > 18 && el.scrollHeight > el.clientHeight * 0.98) {
        size -= 2;
        body.style.fontSize = size + 'px';
      }
      setActive(activeIndex === undefined ? seg.items.length - 1 : activeIndex);
    }
  }

  // ---- pause → show, send to Claude, replay ----
  let video = null;
  let replaying = null;   // { seg, timer }
  let ourPause = false;   // true while WE pause the video, so it does not count as "you paused"
  let handling = false;

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

  function onPlay() {
    if (!replaying) hideOverlay();
  }

  function onPause() {
    if (ourPause) { ourPause = false; return; }
    if (replaying) { cancelReplay(); return; } // you paused during the replay: leave it there
    if (!settings.pauseOn) return;
    const v = video;
    // wait a moment: ignore pauses caused by seeking, the video ending, or ads
    setTimeout(() => {
      if (v.paused && !v.ended && !v.seeking && !isAd() && !handling) handlePause();
    }, 250);
  }

  function cancelReplay() {
    if (replaying) { clearInterval(replaying.timer); replaying = null; }
  }

  function startReplay(seg) {
    cancelReplay();
    const timer = setInterval(() => {
      const ct = video.currentTime;
      let idx = 0;
      seg.items.forEach((s, i) => { if (ct >= s.start - 0.1) idx = i; });
      setActive(idx);
      if (ct >= seg.end - 0.05) {
        cancelReplay();
        ourPause = true;
        video.pause();
        setActive(seg.items.length - 1);
        showOverlay({ note: '⏸ ' + fmtTime(seg.pausedAt) + '  ·  press Space to continue', seg });
      }
    }, 50);
    replaying = { seg, timer };
    video.currentTime = Math.max(0, seg.start - 0.2);
    video.play().catch(() => cancelReplay());
  }

  async function handlePause() {
    handling = true;
    try {
      const t = video.currentTime;
      showOverlay({ note: '⏸ ' + fmtTime(t) + '  ·  loading transcript…' });
      const d = await loadTranscript();
      if (!video.paused) { hideOverlay(); return; } // you pressed play again meanwhile
      if (!d.sentences.length) {
        showOverlay({ note: 'No transcript found for this video (' + (d.errors[0] || '') + ')' });
        return;
      }
      const seg = pickSegment(d.sentences, t);
      showOverlay({
        note: '⏸ ' + fmtTime(t) + '  ·  ' + fmtTime(seg.start) + ' – ' + fmtTime(seg.end),
        seg
      });
      try {
        chrome.runtime.sendMessage({ type: 'pause-send', videoId: videoId(), title: d.title, url: d.url, seg });
      } catch (e) { /* extension was reloaded: refresh the page */ }
      if (settings.replayOn) startReplay(seg);
    } finally {
      handling = false;
    }
  }
}
