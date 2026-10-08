// Runs INSIDE claude.ai / chatgpt.com (page world, before their own code). When the voice call opens the
// microphone, it gets your microphone MIXED with a second line that the extension can play sound into:
// the replay of the video part. The mixing happens after Chrome's echo cancellation, so it is not removed.
(function () {
  'use strict';
  if (window.__ytcMicMix) return;
  window.__ytcMicMix = true;
  try { document.documentElement.dataset.ytcMicMix = '1'; } catch (e) { /* ignore */ }
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const original = md.getUserMedia.bind(md);
  let ctx = null, feedIn = null;

  function audio() {
    if (!ctx) { ctx = new AudioContext(); feedIn = ctx.createGain(); feedIn.gain.value = 1; }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  md.getUserMedia = async function (constraints) {
    const stream = await original(constraints);
    try {
      if (!constraints || !constraints.audio || !stream.getAudioTracks().length) return stream;
      const c = audio();
      const dest = c.createMediaStreamDestination();
      c.createMediaStreamSource(stream).connect(dest);   // your voice
      feedIn.connect(dest);                                // + the video part, when it plays
      const real = stream.getAudioTracks()[0];
      const mixed = dest.stream.getAudioTracks()[0];
      const stop = mixed.stop.bind(mixed);
      mixed.stop = () => { try { real.stop(); } catch (e) { /* ignore */ } stop(); }; // hanging up still frees the microphone
      window.__ytcMixedCount = (window.__ytcMixedCount || 0) + 1;
      return new MediaStream([mixed, ...stream.getVideoTracks()]);
    } catch (e) { return stream; }
  };

  // ---- the sound from the video arrives in small pieces (webm/opus) and is played into the mix ----
  let el = null, ms = null, sb = null, pending = {}, nextSeq = 0, ending = false;
  function pump() {
    if (!sb || sb.updating) return;
    const piece = pending[nextSeq];
    if (piece) {
      delete pending[nextSeq]; nextSeq++;
      try { sb.appendBuffer(piece); } catch (e) { /* skip a bad piece */ pump(); }
      return;
    }
    if (ending && ms && ms.readyState === 'open' && !Object.keys(pending).length) { try { ms.endOfStream(); } catch (e) { /* ignore */ } }
  }
  function start(mime) {
    stopNow();
    const c = audio();
    el = new Audio();
    ms = new MediaSource();
    el.src = URL.createObjectURL(ms);
    pending = {}; nextSeq = 0; ending = false;
    ms.addEventListener('sourceopen', () => {
      try { sb = ms.addSourceBuffer(mime || 'audio/webm;codecs=opus'); sb.mode = 'sequence'; sb.addEventListener('updateend', pump); pump(); } catch (e) { /* unsupported */ }
    });
    c.createMediaElementSource(el).connect(feedIn); // into the call only (not to the speakers)
    el.play().catch(() => {});
    window.__ytcFeeding = true;
  }
  function stopNow() {
    if (el) { try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) { /* ignore */ } }
    el = null; ms = null; sb = null; pending = {}; window.__ytcFeeding = false;
  }
  // 16-bit mono pieces from the iPhone / iPad app (its voice reading the ~30 s part), played into the call only
  let pcmAt = 0;
  window.__ytcFeedPCM = (b64, rate) => {
    try {
      const c = audio();
      const bin = atob(b64 || '');
      const n = bin.length >> 1;
      if (!n) return;
      const buf = c.createBuffer(1, n, rate || 22050);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; ch[i] = v / 32768; }
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(feedIn);
      pcmAt = Math.max(pcmAt, c.currentTime + 0.05);
      src.start(pcmAt);
      pcmAt += buf.duration;
      window.__ytcFeeding = true;
    } catch (e) { /* ignore */ }
  };

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.__ytcFeed || e.source !== window) return;
    if (d.__ytcFeed === 'start') start(d.mime);
    else if (d.__ytcFeed === 'chunk' && ms) {
      const bin = atob(d.data || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      pending[d.seq] = bytes;
      if (el && el.paused) el.play().catch(() => {});
      pump();
    } else if (d.__ytcFeed === 'stop') {
      ending = true; pump();
      const mine = el;
      if (mine) mine.addEventListener('ended', () => { if (el === mine) stopNow(); }, { once: true });
      setTimeout(() => { if (el === mine) stopNow(); }, 8000);
    }
  });
})();
