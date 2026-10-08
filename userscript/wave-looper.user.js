// ==UserScript==
// @name         DJ Wave Looper for YouTube
// @namespace    https://github.com/948573034jackie-cpu/meh
// @version      1.8.0
// @description  Whole-song DJ waveform, click-click A-B loop, 50/75/100% speed and an auto speed-up trainer for practising music on YouTube.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://music.youtube.com/*
// @run-at       document-start
// @inject-into  auto
// @grant        none
// @noframes
// ==/UserScript==

/* Built from src/ by tools/build-userscript.js. Edit the files in src/, not this one. */

if (/(^|.)youtube.com$/.test(location.hostname)) {
// ---- page-world audio tap (src/inject.js): must run before YouTube's player ----
/*
 * DJ Wave Looper: page-world audio tap.
 *
 * Runs in the page's MAIN world at document_start, before YouTube's player
 * starts. It watches the audio bytes that YouTube hands to Media Source
 * Extensions (SourceBuffer.appendBuffer). For each audio chunk it decodes the
 * audio and turns it into small waveform "peaks", then posts them to the
 * extension's content script with window.postMessage.
 *
 * Rules this file must follow:
 * - It must never break playback. Every hook calls the original first or
 *   inside try/catch, and copies bytes before YouTube can reuse them.
 * - It only reads audio for the main player (#movie_player). Ads, hover
 *   previews and Shorts are skipped.
 */
(() => {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  if (G.__ytlWaveHook) return;
  G.__ytlWaveHook = true;

  const TAG = '__ytlooper__';
  const BIN_RATE = 50; // waveform bins per second (20 ms each)
  const DECODE_RATE = 16000; // decode sample rate; enough for 3-band colouring
  const MAX_PENDING_BYTES = 6 * 1024 * 1024;

  // ---------------------------------------------------------------------------
  // Byte helpers
  // ---------------------------------------------------------------------------
  function toU8Copy(data) {
    if (!data) return null;
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    return null;
  }

  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // WebM (EBML) parsing: only what we need
  // ---------------------------------------------------------------------------
  const EBML_ID = 0x1a45dfa3;
  const SEGMENT_ID = 0x18538067;
  const CLUSTER_ID = 0x1f43b675;
  const INFO_ID = 0x1549a966;
  const TIMECODE_SCALE_ID = 0x2ad7b1;
  const CLUSTER_TIMESTAMP_ID = 0xe7;

  function readId(u8, pos) {
    if (pos >= u8.length) return null;
    const b = u8[pos];
    let len = 0;
    if (b & 0x80) len = 1;
    else if (b & 0x40) len = 2;
    else if (b & 0x20) len = 3;
    else if (b & 0x10) len = 4;
    else return null;
    if (pos + len > u8.length) return null;
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + u8[pos + i];
    return { id, len };
  }

  function readSize(u8, pos) {
    if (pos >= u8.length) return null;
    const b = u8[pos];
    let len = 1;
    let mask = 0x80;
    while (len <= 8 && !(b & mask)) {
      len++;
      mask >>= 1;
    }
    if (len > 8 || pos + len > u8.length) return null;
    let value = b & (mask - 1);
    let allOnes = value === mask - 1;
    for (let i = 1; i < len; i++) {
      value = value * 256 + u8[pos + i];
      if (u8[pos + i] !== 0xff) allOnes = false;
    }
    return { value, len, unknown: allOnes };
  }

  function readUint(u8, pos, len) {
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + u8[pos + i];
    return v;
  }

  function webmStartsWith(u8, id) {
    const r = readId(u8, 0);
    return !!r && r.id === id;
  }

  /** Offset of the first Cluster, walking the top-level structure. -1 if none. */
  function webmFindCluster(u8) {
    let pos = 0;
    let guard = 0;
    while (pos < u8.length && guard++ < 10000) {
      const id = readId(u8, pos);
      if (!id) return -1;
      const size = readSize(u8, pos + id.len);
      if (!size) return -1;
      const dataStart = pos + id.len + size.len;
      if (id.id === CLUSTER_ID) return pos;
      if (id.id === SEGMENT_ID) {
        pos = dataStart; // descend into the segment
        continue;
      }
      if (size.unknown) return -1;
      pos = dataStart + size.value;
    }
    return -1;
  }

  /** TimecodeScale (ns per tick) from an init segment. Default 1 ms. */
  function webmTimecodeScale(u8) {
    let pos = 0;
    let guard = 0;
    while (pos < u8.length && guard++ < 10000) {
      const id = readId(u8, pos);
      if (!id) break;
      const size = readSize(u8, pos + id.len);
      if (!size) break;
      const dataStart = pos + id.len + size.len;
      if (id.id === SEGMENT_ID || id.id === INFO_ID) {
        pos = dataStart;
        continue;
      }
      if (id.id === TIMECODE_SCALE_ID) {
        const v = readUint(u8, dataStart, size.value);
        return v > 0 ? v : 1e6;
      }
      if (id.id === CLUSTER_ID || size.unknown) break;
      pos = dataStart + size.value;
    }
    return 1e6;
  }

  /** Cluster timestamp (in seconds) of a chunk that starts with a Cluster. */
  function webmClusterTime(u8, tcScale) {
    const id = readId(u8, 0);
    if (!id || id.id !== CLUSTER_ID) return null;
    const size = readSize(u8, id.len);
    if (!size) return null;
    let pos = id.len + size.len;
    const limit = Math.min(u8.length, pos + 256);
    while (pos < limit) {
      const cid = readId(u8, pos);
      if (!cid) return null;
      const csize = readSize(u8, pos + cid.len);
      if (!csize) return null;
      const dataStart = pos + cid.len + csize.len;
      if (cid.id === CLUSTER_TIMESTAMP_ID) {
        if (dataStart + csize.value > u8.length) return null;
        return (readUint(u8, dataStart, csize.value) * tcScale) / 1e9;
      }
      if (csize.unknown) return null;
      pos = dataStart + csize.value;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // MP4 (ISO BMFF) parsing: init metadata, fragment times, AAC to ADTS
  // ---------------------------------------------------------------------------
  function u32(u8, p) {
    return ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
  }

  function fourcc(u8, p) {
    return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
  }

  /** Iterate boxes in [start, end). Returns [{type, start, dataStart, end}] */
  function boxes(u8, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = u32(u8, p);
      const type = fourcc(u8, p + 4);
      let header = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = u32(u8, p + 8) * 4294967296 + u32(u8, p + 12);
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header || !/^[a-zA-Z0-9 ]{4}$/.test(type)) break;
      const boxEnd = Math.min(end, p + size);
      out.push({ type, start: p, dataStart: p + header, end: boxEnd, truncated: p + size > end });
      p += size;
    }
    return out;
  }

  function child(u8, box, type, skip = 0) {
    if (!box) return null;
    return boxes(u8, box.dataStart + skip, box.end).find((b) => b.type === type) || null;
  }

  const MP4_INIT_TYPES = new Set(['ftyp', 'moov']);
  const MP4_MEDIA_TYPES = new Set(['moof', 'styp', 'sidx', 'emsg', 'prft']);

  function mp4FirstType(u8) {
    if (u8.length < 8) return null;
    const type = fourcc(u8, 4);
    return /^[a-z]{4}$/.test(type) ? type : null;
  }

  function mp4FindMediaStart(u8) {
    for (const b of boxes(u8, 0, u8.length)) if (MP4_MEDIA_TYPES.has(b.type)) return b.start;
    return -1;
  }

  /** Timescale and AudioSpecificConfig from an mp4 init segment. */
  function mp4InitMeta(u8) {
    const meta = { timescale: 0, asc: null };
    const moov = boxes(u8, 0, u8.length).find((b) => b.type === 'moov');
    const trak = child(u8, moov, 'trak');
    const mdia = child(u8, trak, 'mdia');
    const mdhd = child(u8, mdia, 'mdhd');
    if (mdhd) {
      const v = u8[mdhd.dataStart];
      meta.timescale = u32(u8, mdhd.dataStart + (v === 1 ? 20 : 12));
    }
    const stbl = child(u8, child(u8, mdia, 'minf'), 'stbl');
    const stsd = child(u8, stbl, 'stsd');
    if (stsd) {
      const entry = boxes(u8, stsd.dataStart + 8, stsd.end)[0];
      if (entry && (entry.type === 'mp4a' || entry.type === 'enca')) {
        const esds = child(u8, entry, 'esds', 28);
        if (esds) meta.asc = parseEsds(u8, esds.dataStart + 4, esds.end);
      }
    }
    return meta;
  }

  function parseEsds(u8, p, end) {
    // Walk MPEG-4 descriptors: 0x03 ES -> 0x04 DecoderConfig -> 0x05 DecSpecificInfo
    function desc(pos) {
      if (pos + 2 > end) return null;
      const tag = u8[pos++];
      let len = 0;
      for (let i = 0; i < 4 && pos < end; i++) {
        const b = u8[pos++];
        len = (len << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return { tag, len, data: pos };
    }
    let d = desc(p);
    if (!d || d.tag !== 0x03) return null;
    let q = d.data + 2; // ES_ID
    const flags = u8[q++];
    if (flags & 0x80) q += 2;
    if (flags & 0x40) q += 1 + u8[q];
    if (flags & 0x20) q += 2;
    d = desc(q);
    if (!d || d.tag !== 0x04) return null;
    d = desc(d.data + 13);
    if (!d || d.tag !== 0x05 || d.data + d.len > end || d.len < 2) return null;
    const objType = u8[d.data] >> 3;
    const freqIndex = ((u8[d.data] & 0x07) << 1) | (u8[d.data + 1] >> 7);
    const channels = (u8[d.data + 1] >> 3) & 0x0f;
    return { objType, freqIndex, channels };
  }

  /** Walk moof/mdat pairs. Returns { time (sec|null), samples: [Uint8Array] } */
  function mp4Fragments(u8, timescale) {
    const result = { time: null, samples: [] };
    for (const moof of boxes(u8, 0, u8.length)) {
      if (moof.type !== 'moof') continue;
      for (const traf of boxes(u8, moof.dataStart, moof.end)) {
        if (traf.type !== 'traf') continue;
        const kids = boxes(u8, traf.dataStart, traf.end);
        const tfhd = kids.find((b) => b.type === 'tfhd');
        const tfdt = kids.find((b) => b.type === 'tfdt');
        if (tfdt && result.time === null && timescale > 0) {
          const v = u8[tfdt.dataStart];
          const t =
            v === 1
              ? u32(u8, tfdt.dataStart + 4) * 4294967296 + u32(u8, tfdt.dataStart + 8)
              : u32(u8, tfdt.dataStart + 4);
          result.time = t / timescale;
        }
        let base = moof.start;
        let defaultSize = 0;
        if (tfhd) {
          const f = u32(u8, tfhd.dataStart) & 0xffffff;
          let q = tfhd.dataStart + 8; // flags + track_ID
          if (f & 0x01) {
            base = u32(u8, q) * 4294967296 + u32(u8, q + 4);
            q += 8;
          }
          if (f & 0x02) q += 4;
          if (f & 0x08) q += 4;
          if (f & 0x10) defaultSize = u32(u8, q);
        }
        for (const trun of kids) {
          if (trun.type !== 'trun') continue;
          const f = u32(u8, trun.dataStart) & 0xffffff;
          const count = u32(u8, trun.dataStart + 4);
          let q = trun.dataStart + 8;
          let dataPos = base;
          if (f & 0x01) {
            dataPos = base + (u32(u8, q) | 0);
            q += 4;
          } else {
            const mdat = boxes(u8, moof.end, u8.length).find((b) => b.type === 'mdat');
            dataPos = mdat ? mdat.dataStart : moof.end + 8;
          }
          if (f & 0x04) q += 4;
          for (let i = 0; i < count && q <= trun.end; i++) {
            if (f & 0x100) q += 4;
            let size = defaultSize;
            if (f & 0x200) {
              size = u32(u8, q);
              q += 4;
            }
            if (f & 0x400) q += 4;
            if (f & 0x800) q += 4;
            if (size <= 0 || dataPos + size > u8.length) break;
            result.samples.push(u8.subarray(dataPos, dataPos + size));
            dataPos += size;
          }
        }
      }
    }
    return result;
  }

  /** Wrap raw AAC frames in ADTS headers so decodeAudioData can read them. */
  function toAdts(samples, asc) {
    if (!asc || !samples.length) return null;
    let objType = asc.objType;
    if (objType === 5 || objType === 29) objType = 2; // HE-AAC: core is LC
    const profile = Math.max(0, Math.min(3, objType - 1));
    const sfi = asc.freqIndex & 0x0f;
    const ch = asc.channels & 0x07;
    const parts = [];
    for (const s of samples) {
      const len = s.length + 7;
      const h = new Uint8Array(7);
      h[0] = 0xff;
      h[1] = 0xf1;
      h[2] = (profile << 6) | (sfi << 2) | ((ch >> 2) & 1);
      h[3] = ((ch & 3) << 6) | ((len >> 11) & 0x03);
      h[4] = (len >> 3) & 0xff;
      h[5] = ((len & 7) << 5) | 0x1f;
      h[6] = 0xfc;
      parts.push(h, s);
    }
    return concat(parts);
  }

  // ---------------------------------------------------------------------------
  // Peaks: decoded audio to 50 bins/s of peak + low/mid/high energy
  // ---------------------------------------------------------------------------
  function biquad(type, freq, sr) {
    const w = (2 * Math.PI * freq) / sr;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    let b0, b1, b2;
    if (type === 'lp') {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    } else {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
  }

  /**
   * channels: Float32Array[]; sr: sample rate; start: seconds of sample 0.
   * Returns { startBin, peak, low, mid, high } (Uint8Arrays).
   */
  function computePeaks(channels, sr, start) {
    const n = channels[0].length;
    if (!n) return null;
    const dur = n / sr;
    const firstBin = Math.max(0, Math.floor(start * BIN_RATE));
    const lastBin = Math.ceil((start + dur) * BIN_RATE) - 1;
    const count = lastBin - firstBin + 1;
    if (count <= 0) return null;
    const peak = new Uint8Array(count);
    const low = new Uint8Array(count);
    const mid = new Uint8Array(count);
    const high = new Uint8Array(count);
    const lp = biquad('lp', 250, sr);
    const hp = biquad('hp', 2500, sr);
    let lx1 = 0, lx2 = 0, ly1 = 0, ly2 = 0;
    let hx1 = 0, hx2 = 0, hy1 = 0, hy2 = 0;
    const nch = channels.length;
    let bin = 0;
    let binEnd = Math.min(n, Math.round(((firstBin + 1) / BIN_RATE - start) * sr));
    let pk = 0, sl = 0, sm = 0, sh = 0, cnt = 0;
    const flush = () => {
      if (cnt > 0 && bin < count) {
        peak[bin] = Math.min(255, Math.round(pk * 255));
        low[bin] = Math.min(255, Math.round(Math.sqrt(Math.sqrt(sl / cnt)) * 300));
        mid[bin] = Math.min(255, Math.round(Math.sqrt(Math.sqrt(sm / cnt)) * 300));
        high[bin] = Math.min(255, Math.round(Math.sqrt(Math.sqrt(sh / cnt)) * 300));
      }
      pk = sl = sm = sh = cnt = 0;
    };
    for (let i = 0; i < n; i++) {
      while (i >= binEnd && bin < count) {
        flush();
        bin++;
        binEnd = Math.min(n, Math.round(((firstBin + bin + 1) / BIN_RATE - start) * sr));
        if (binEnd <= i) binEnd = i + 1;
      }
      let x = 0;
      let a = 0;
      for (let c = 0; c < nch; c++) {
        const v = channels[c][i];
        x += v;
        const av = v < 0 ? -v : v;
        if (av > a) a = av;
      }
      x /= nch;
      const yl = lp.b0 * x + lp.b1 * lx1 + lp.b2 * lx2 - lp.a1 * ly1 - lp.a2 * ly2;
      lx2 = lx1; lx1 = x; ly2 = ly1; ly1 = yl;
      const yh = hp.b0 * x + hp.b1 * hx1 + hp.b2 * hx2 - hp.a1 * hy1 - hp.a2 * hy2;
      hx2 = hx1; hx1 = x; hy2 = hy1; hy1 = yh;
      const ym = x - yl - yh;
      if (a > pk) pk = a;
      sl += yl * yl;
      sm += ym * ym;
      sh += yh * yh;
      cnt++;
    }
    flush();
    return { startBin: firstBin, peak, low, mid, high };
  }

  // Test hook (only used by the Node unit tests, never set on YouTube).
  if (G.__YTL_TEST__) {
    G.__YTL_TEST__.parsers = {
      readId, readSize, webmFindCluster, webmTimecodeScale, webmClusterTime,
      boxes, mp4FindMediaStart, mp4InitMeta, mp4Fragments, toAdts, computePeaks, BIN_RATE,
    };
    if (G.__YTL_TEST__.parsersOnly) return;
  }

  if (typeof MediaSource === 'undefined' || typeof SourceBuffer === 'undefined') return;

  // ---------------------------------------------------------------------------
  // Player helpers
  // ---------------------------------------------------------------------------
  function player() {
    return document.getElementById('movie_player') || document.querySelector('#player-container-id .html5-video-player');
  }

  function mainVideo() {
    const p = player();
    return (p && p.querySelector('video')) || document.querySelector('#player-container-id video') || null;
  }

  function isAd() {
    const p = player();
    return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
  }

  function videoId() {
    try {
      const p = player();
      const d = p && typeof p.getVideoData === 'function' ? p.getVideoData() : null;
      if (d && d.video_id) return String(d.video_id);
    } catch (e) {
      /* ignore */
    }
    try {
      return new URL(location.href).searchParams.get('v');
    } catch (e) {
      return null;
    }
  }

  function post(msg) {
    msg[TAG] = true;
    try {
      G.postMessage(msg, location.origin);
    } catch (e) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------
  const msUrl = new WeakMap(); // MediaSource -> blob url
  const sbState = new WeakMap(); // audio SourceBuffer -> capture state

  const origCreateObjectURL = URL.createObjectURL;
  try {
    URL.createObjectURL = function createObjectURL(obj) {
      const url = origCreateObjectURL.apply(this, arguments);
      try {
        if (obj instanceof MediaSource) msUrl.set(obj, url);
      } catch (e) {
        /* ignore */
      }
      return url;
    };
  } catch (e) {
    /* ignore */
  }

  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function addSourceBuffer(mime) {
    const sb = origAddSourceBuffer.apply(this, arguments);
    try {
      const m = String(mime || '').toLowerCase();
      if (m.startsWith('audio/')) {
        sbState.set(sb, {
          ms: this,
          container: m.includes('mp4') ? 'mp4' : 'webm',
          init: null,
          tcScale: 1e6,
          mp4: null,
          pending: null,
          pendingBytes: 0,
          pendingStart: null,
          pendingVid: null,
          decodedBytes: 0,
          flushTimer: 0,
          retries: 0,
          seq: 0,
        });
      }
    } catch (e) {
      /* ignore */
    }
    return sb;
  };

  // YouTube may switch codec (WebM <-> MP4) on the same SourceBuffer.
  const origChangeType = SourceBuffer.prototype.changeType;
  if (origChangeType) {
    SourceBuffer.prototype.changeType = function changeType(mime) {
      try {
        const st = sbState.get(this);
        if (st) {
          finalize(st);
          st.container = String(mime || '').toLowerCase().includes('mp4') ? 'mp4' : 'webm';
          st.init = null;
        }
      } catch (e) {
        /* ignore */
      }
      return origChangeType.apply(this, arguments);
    };
  }

  const origAppendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function appendBuffer(data) {
    try {
      const st = sbState.get(this);
      if (st) capture(this, st, data);
    } catch (e) {
      /* never break playback */
    }
    return origAppendBuffer.apply(this, arguments);
  };

  function isMainSource(st) {
    const v = mainVideo();
    if (!v) return false;
    const url = msUrl.get(st.ms);
    if (!url) return true; // unknown attachment; accept
    return v.src === url || v.currentSrc === url;
  }

  function classify(st, u8) {
    if (st.container === 'webm') {
      if (webmStartsWith(u8, EBML_ID)) return 'init';
      if (webmStartsWith(u8, CLUSTER_ID)) return 'media';
      return 'cont';
    }
    const t = mp4FirstType(u8);
    if (t && MP4_INIT_TYPES.has(t)) return 'init';
    if (t && MP4_MEDIA_TYPES.has(t)) return 'media';
    return 'cont';
  }

  function capture(sb, st, data) {
    if (!isMainSource(st)) return;
    if (isAd()) {
      st.pending = null; // never mix ad audio into a song
      return;
    }
    const u8 = toU8Copy(data);
    if (!u8 || !u8.length) return;
    const kind = classify(st, u8);
    if (kind === 'init') {
      finalize(st);
      const split = st.container === 'webm' ? webmFindCluster(u8) : mp4FindMediaStart(u8);
      st.init = split > 0 ? u8.slice(0, split) : u8;
      if (st.container === 'webm') st.tcScale = webmTimecodeScale(st.init);
      else st.mp4 = mp4InitMeta(st.init);
      if (split > 0) startPending(sb, st, u8.subarray(split));
      return;
    }
    if (!st.init) return;
    if (kind === 'media') {
      finalize(st);
      startPending(sb, st, u8);
    } else if (st.pending) {
      st.pending.push(u8);
      st.pendingBytes += u8.length;
      if (st.pendingBytes > MAX_PENDING_BYTES) {
        finalize(st);
        return;
      }
    } else {
      return;
    }
    clearTimeout(st.flushTimer);
    st.flushTimer = setTimeout(() => flush(st, false), 250);
  }

  function startPending(sb, st, u8) {
    st.pending = [u8];
    st.pendingBytes = u8.length;
    st.decodedBytes = 0;
    st.retries = 0;
    st.pendingVid = videoId();
    st.seq++;
    let t = null;
    if (st.container === 'webm') t = webmClusterTime(u8, st.tcScale);
    else if (st.mp4) t = mp4Fragments(u8, st.mp4.timescale).time;
    if (t !== null && isFinite(t)) {
      let off = 0;
      try {
        off = sb.timestampOffset || 0;
      } catch (e) {
        /* ignore */
      }
      st.pendingStart = t + off;
    } else {
      // Fallback: learn the start from what the SourceBuffer added.
      st.pendingStart = null;
      const seq = st.seq;
      const before = ranges(sb);
      sb.addEventListener(
        'updateend',
        () => {
          if (st.seq !== seq || st.pendingStart !== null) return;
          const s = firstNewTime(before, ranges(sb));
          if (s !== null) st.pendingStart = s;
        },
        { once: true }
      );
    }
  }

  function ranges(sb) {
    const out = [];
    try {
      const r = sb.buffered;
      for (let i = 0; i < r.length; i++) out.push([r.start(i), r.end(i)]);
    } catch (e) {
      /* ignore */
    }
    return out;
  }

  function firstNewTime(before, after) {
    for (const [s, e] of after) {
      let t = s;
      for (const [bs, be] of before) if (t >= bs - 0.05 && t < be) t = be;
      if (t < e - 0.05) return t;
    }
    return null;
  }

  function finalize(st) {
    clearTimeout(st.flushTimer);
    if (st.pending) flush(st, true);
    st.pending = null;
    st.pendingBytes = 0;
  }

  function flush(st, final) {
    if (!st.pending || !st.init) return;
    if (st.pendingBytes === st.decodedBytes) return;
    if (st.pendingStart === null) {
      if (!final && ++st.retries < 20) {
        clearTimeout(st.flushTimer);
        st.flushTimer = setTimeout(() => flush(st, false), 400);
      }
      return;
    }
    if (isAd()) return;
    st.decodedBytes = st.pendingBytes;
    const media = concat(st.pending);
    enqueue({
      container: st.container,
      init: st.init,
      mp4: st.mp4,
      media,
      start: st.pendingStart,
      vid: st.pendingVid,
    });
  }

  // ---------------------------------------------------------------------------
  // Decode queue
  // ---------------------------------------------------------------------------
  let decodeCtx = null;
  let queue = Promise.resolve();
  let queued = 0;

  function ctx() {
    if (!decodeCtx) {
      const Ctor = G.OfflineAudioContext || G.webkitOfflineAudioContext;
      decodeCtx = new Ctor(1, 1, DECODE_RATE);
    }
    return decodeCtx;
  }

  function decode(bytes) {
    return new Promise((resolve, reject) => {
      try {
        const p = ctx().decodeAudioData(bytes.buffer, resolve, reject);
        if (p && p.catch) p.catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  function enqueue(job) {
    if (queued > 40) return; // avoid runaway memory if decoding stalls
    queued++;
    queue = queue
      .then(() => runJob(job))
      .catch(() => {})
      .then(() => {
        queued--;
      });
  }

  async function runJob(job) {
    let buf = null;
    if (job.container === 'webm') {
      buf = await decode(concat([job.init, job.media]));
    } else {
      const frags = job.mp4 ? mp4Fragments(job.media, job.mp4.timescale) : null;
      const adts = frags && job.mp4.asc ? toAdts(frags.samples, job.mp4.asc) : null;
      if (adts) {
        try {
          buf = await decode(adts);
        } catch (e) {
          buf = null;
        }
      }
      if (!buf) buf = await decode(concat([job.init, job.media]));
    }
    if (!buf || !buf.length) return;
    const chans = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(buf.getChannelData(c));
    const res = computePeaks(chans, buf.sampleRate, job.start);
    if (!res) return;
    post({
      type: 'peaks',
      vid: job.vid,
      binRate: BIN_RATE,
      startBin: res.startBin,
      peak: res.peak,
      low: res.low,
      mid: res.mid,
      high: res.high,
    });
  }

  // ---------------------------------------------------------------------------
  // Tell the content script which video the main player is on
  // ---------------------------------------------------------------------------
  let lastInfo = '';
  function postVideoInfo(force) {
    const v = mainVideo();
    const vid = videoId();
    let title = '';
    let author = '';
    try {
      const p = player();
      const d = p && typeof p.getVideoData === 'function' ? p.getVideoData() : null;
      if (d) {
        title = String(d.title || '');
        author = String(d.author || '');
      }
    } catch (e) {
      /* ignore */
    }
    const info = { type: 'video', vid: vid || null, ad: isAd(), hasVideo: !!v, title, author };
    const key = JSON.stringify(info);
    if (!force && key === lastInfo) return;
    lastInfo = key;
    post(info);
  }

  G.addEventListener('message', (e) => {
    if (e.source !== G || !e.data || e.data[TAG] !== 'cs') return;
    if (e.data.type === 'hello') postVideoInfo(true);
  });
  document.addEventListener('yt-navigate-finish', () => postVideoInfo(false), true);
  setInterval(() => postVideoInfo(false), 700);
})();


// ---- panel, loop engine, speed and trainer: start once the page has a body ----
(function () {
  'use strict';
  function start() {

globalThis.YTL_STORAGE = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('ytl-wave-looper', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const list = (k) => (Array.isArray(k) ? k : [k]);
  return {
    get(keys) {
      return open().then((db) => new Promise((resolve) => {
        const out = {};
        const t = db.transaction('kv', 'readonly');
        const st = t.objectStore('kv');
        for (const k of list(keys)) {
          const r = st.get(k);
          r.onsuccess = () => { if (r.result !== undefined) out[k] = r.result; };
        }
        t.oncomplete = () => resolve(out);
        t.onerror = t.onabort = () => resolve(out);
      })).catch(() => ({}));
    },
    set(obj) {
      open().then((db) => {
        const st = db.transaction('kv', 'readwrite').objectStore('kv');
        for (const [k, v] of Object.entries(obj)) st.put(v, k);
      }).catch(() => {});
    },
    remove(keys) {
      open().then((db) => {
        const st = db.transaction('kv', 'readwrite').objectStore('kv');
        for (const k of list(keys)) st.delete(k);
      }).catch(() => {});
    },
  };
})();

/*
 * DJ Wave Looper: pure logic with no DOM, shared by the content script and
 * the Node unit tests.
 */
(function (root) {
  'use strict';

  const SPEED_MIN = 0.25;
  const SPEED_MAX = 2;
  const END_GUARD = 0.3; // never let a loop touch the real end (YouTube would autoplay next)
  const MIN_LOOP = 0.1;

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function roundRate(r) {
    return Math.round(clamp(r, SPEED_MIN, SPEED_MAX) * 100) / 100;
  }

  /** 83.456 -> "1:23.45"; 3725.1 -> "1:02:05.10". `cs=false` drops hundredths. */
  function formatTime(sec, cs = true) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const totalCs = Math.floor(sec * 100 + 1e-6);
    const h = Math.floor(totalCs / 360000);
    const m = Math.floor((totalCs % 360000) / 6000);
    const s = Math.floor((totalCs % 6000) / 100);
    const c = totalCs % 100;
    const ss = String(s).padStart(2, '0');
    let out = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    if (cs) out += '.' + String(c).padStart(2, '0');
    return out;
  }

  /**
   * Speed for repetition `rep` (1-based) of the auto speed-up trainer.
   * Rep 1 plays at `start`, rep `reps` plays at `goal`, linear in between,
   * and every rep after that stays at `goal`.
   */
  function trainerRate(start, goal, reps, rep) {
    reps = Math.max(1, Math.round(reps));
    if (reps === 1 || rep >= reps) return roundRate(goal);
    const k = clamp((rep - 1) / (reps - 1), 0, 1);
    return roundRate(start + (goal - start) * k);
  }

  /**
   * Which repetition of the trainer plays at `rate` (the inverse of
   * trainerRate): used when you pick a slower speed mid-training, so the
   * trainer steps back and you get those loops again.
   */
  function trainerRepFor(start, goal, reps, rate) {
    reps = Math.max(1, Math.round(reps));
    if (reps === 1 || rate >= goal - 1e-6) return reps;
    if (rate <= start + 1e-6) return 1;
    return clamp(1 + Math.round(((rate - start) / (goal - start)) * (reps - 1)), 1, reps);
  }

  /** Effective loop end: before the guard zone at the end of the video. */
  function loopEnd(b, duration) {
    if (!isFinite(duration) || duration <= 0) return b;
    return Math.min(b, Math.max(0, duration - END_GUARD));
  }

  /** Orders, clamps and validates an A/B pair. Returns null if unusable. */
  function normalizeLoop(a, b, duration) {
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) return null;
    let lo = Math.min(a, b);
    let hi = Math.max(a, b);
    const max = isFinite(duration) && duration > 0 ? duration : Infinity;
    lo = clamp(lo, 0, max);
    hi = clamp(hi, 0, max);
    if (hi - lo < MIN_LOOP) return null;
    return { a: lo, b: hi };
  }

  // ---------------------------------------------------------------------------
  // PeakStore: the song's waveform, filled piece by piece
  // ---------------------------------------------------------------------------
  class PeakStore {
    constructor(binRate = 50) {
      this.binRate = binRate;
      this.n = 0;
      this.peak = new Uint8Array(0);
      this.low = new Uint8Array(0);
      this.mid = new Uint8Array(0);
      this.high = new Uint8Array(0);
      this.cov = new Uint8Array(0);
      this.version = 0;
      this.maxPeak = 0;
    }

    ensure(n) {
      if (n <= this.peak.length) {
        if (n > this.n) this.n = n;
        return;
      }
      const cap = Math.max(n, Math.ceil(this.peak.length * 1.5), 1024);
      for (const k of ['peak', 'low', 'mid', 'high', 'cov']) {
        const a = new Uint8Array(cap);
        a.set(this[k]);
        this[k] = a;
      }
      this.n = n;
    }

    setDuration(sec) {
      if (isFinite(sec) && sec > 0) this.ensure(Math.ceil(sec * this.binRate));
    }

    /** Merge a chunk of bins (max-merge, so repeated chunks are harmless). */
    add(startBin, peak, low, mid, high) {
      if (!peak || !peak.length || startBin < 0) return;
      const end = startBin + peak.length;
      this.ensure(end);
      for (let i = 0; i < peak.length; i++) {
        const j = startBin + i;
        if (peak[i] > this.peak[j]) this.peak[j] = peak[i];
        if (low && low[i] > this.low[j]) this.low[j] = low[i];
        if (mid && mid[i] > this.mid[j]) this.mid[j] = mid[i];
        if (high && high[i] > this.high[j]) this.high[j] = high[i];
        this.cov[j] = 1;
        if (this.peak[j] > this.maxPeak) this.maxPeak = this.peak[j];
      }
      this.version++;
    }

    /**
     * Time (s) where the sound really starts: the first stretch of at least
     * minRun seconds louder than `frac` of the loudest point. null if unknown.
     * For a cappella tracks this is where the singing starts.
     */
    firstSound(durationSec, frac = 0.12, minRun = 0.25) {
      if (!this.maxPeak) return null;
      const n = Math.min(this.n, Math.ceil(durationSec * this.binRate));
      const thr = this.maxPeak * frac;
      const need = Math.max(1, Math.round(minRun * this.binRate));
      let run = 0;
      for (let i = 0; i < n; i++) {
        if (!this.cov[i]) return null; // a gap before any sound: can't tell yet
        if (this.peak[i] > thr) {
          if (++run >= need) return (i - run + 1) / this.binRate;
        } else run = 0;
      }
      return null;
    }

    /** Merge another store's covered bins into this one. */
    merge(other) {
      if (!other || other.binRate !== this.binRate || !other.n) return;
      this.ensure(other.n);
      for (let j = 0; j < other.n; j++) {
        if (!other.cov[j]) continue;
        if (other.peak[j] > this.peak[j]) this.peak[j] = other.peak[j];
        if (other.low[j] > this.low[j]) this.low[j] = other.low[j];
        if (other.mid[j] > this.mid[j]) this.mid[j] = other.mid[j];
        if (other.high[j] > this.high[j]) this.high[j] = other.high[j];
        this.cov[j] = 1;
        if (this.peak[j] > this.maxPeak) this.maxPeak = this.peak[j];
      }
      this.version++;
    }

    /** Fraction (0..1) of [0, durationSec) that has waveform data. */
    coverage(durationSec) {
      const n = Math.ceil(durationSec * this.binRate);
      if (!(n > 0)) return 0;
      const m = Math.min(n, this.n);
      let c = 0;
      for (let i = 0; i < m; i++) c += this.cov[i];
      return c / n;
    }

    isCovered(sec) {
      const i = Math.floor(sec * this.binRate);
      return i >= 0 && i < this.n && this.cov[i] === 1;
    }

    /**
     * Gaps without data in [0, durationSec - tail), each longer than minGap
     * seconds: [{start, end}] in seconds.
     */
    gaps(durationSec, minGap = 0.4, tail = 0.6) {
      const out = [];
      const n = Math.floor(Math.max(0, durationSec - tail) * this.binRate);
      const minBins = Math.max(1, Math.round(minGap * this.binRate));
      let s = -1;
      for (let i = 0; i <= n; i++) {
        const empty = i < n && !(i < this.n && this.cov[i]);
        if (empty && s < 0) s = i;
        else if (!empty && s >= 0) {
          if (i - s >= minBins) out.push({ start: s / this.binRate, end: i / this.binRate });
          s = -1;
        }
      }
      return out;
    }

    /** Next gap that starts at or after `sec` (wrapping to the first). */
    nextGap(sec, durationSec) {
      const g = this.gaps(durationSec);
      if (!g.length) return null;
      return g.find((x) => x.end > sec + 0.05) || g[0];
    }

    serialize() {
      const n = this.n;
      const out = new Uint8Array(n * 5);
      out.set(this.peak.subarray(0, n), 0);
      out.set(this.low.subarray(0, n), n);
      out.set(this.mid.subarray(0, n), 2 * n);
      out.set(this.high.subarray(0, n), 3 * n);
      out.set(this.cov.subarray(0, n), 4 * n);
      return { binRate: this.binRate, n, data: bytesToBase64(out) };
    }

    static deserialize(obj) {
      const s = new PeakStore(obj.binRate || 50);
      const n = obj.n | 0;
      const raw = base64ToBytes(obj.data || '');
      if (raw.length !== n * 5) return s;
      s.ensure(n);
      s.peak.set(raw.subarray(0, n));
      s.low.set(raw.subarray(n, 2 * n));
      s.mid.set(raw.subarray(2 * n, 3 * n));
      s.high.set(raw.subarray(3 * n, 4 * n));
      s.cov.set(raw.subarray(4 * n, 5 * n));
      for (let i = 0; i < n; i++) if (s.peak[i] > s.maxPeak) s.maxPeak = s.peak[i];
      s.version++;
      return s;
    }
  }

  function bytesToBase64(u8) {
    if (typeof Buffer !== 'undefined' && typeof btoa === 'undefined') {
      return Buffer.from(u8).toString('base64');
    }
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }

  function base64ToBytes(b64) {
    if (typeof Buffer !== 'undefined' && typeof atob === 'undefined') {
      return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /**
   * DJ-style colour for a bin from its band energies (0..255 each):
   * bass leans red/orange, mids green, highs blue/cyan.
   */
  function bandColor(low, mid, high) {
    const l = low * 1.0;
    const m = mid * 1.25;
    const h = high * 1.9;
    const max = Math.max(l, m, h, 1);
    const r = Math.round(60 + 195 * (l / max));
    const g = Math.round(50 + 205 * (m / max) * 0.85 + 30 * (l / max) * 0.4);
    const b = Math.round(70 + 185 * (h / max));
    return [Math.min(255, r), Math.min(255, g), Math.min(255, b)];
  }

  // ---------------------------------------------------------------------------
  // Lyrics helpers
  // ---------------------------------------------------------------------------
  const TITLE_NOISE = /\b(official(\s+(music|lyrics?|audio|video|visuali[sz]er|mv))*|music\s+video|lyrics?\s+video|lyrics?|audio|video|hd|hq|4k|mv|m\/v|visuali[sz]er|a\s*cappella|acc?apella|vocals?\s+only|isolated\s+vocals?|instrumental|karaoke|backing\s+track|remaster(ed)?|full\s+song|with\s+lyrics)\b/gi;

  function cleanPart(x) {
    return String(x || '')
      .replace(TITLE_NOISE, ' ')
      .replace(/["“”]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—:|~·.,]+|[\s\-–—:|~·.,]+$/g, '')
      .trim();
  }

  /**
   * Best guess of { artist, track } from a YouTube title and channel name:
   * "Adele - Hello (Official Music Video)" -> { artist: 'Adele', track: 'Hello' }.
   */
  function parseSongTitle(title, author) {
    let t = String(title || '');
    t = t.replace(/[(\[{【「][^)\]}】」]*[)\]}】」]/g, ' '); // (Official Video), [Lyrics], 【MV】...
    t = t.split(/\s[|｜]\s|\s\/\/\s/)[0];
    t = t.replace(/\s(ft\.?|feat\.?|featuring)\s[^-–—]*/i, ' ');
    let artist = '';
    let track = '';
    const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/) || t.match(/^(.+?)\s*[-–—:]\s+(.+)$/);
    if (m) {
      artist = cleanPart(m[1]);
      track = cleanPart(m[2]);
    } else {
      track = cleanPart(t);
    }
    if (!artist && author) {
      artist = cleanPart(String(author).replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').replace(/\b(official|music|records|channel)\b/gi, ' '));
    }
    if (!track) track = cleanPart(title);
    return { artist, track };
  }

  /** "[01:02.50] words" lines -> [{ t: 62.5, text: 'words' }], sorted by time. */
  function parseLrc(lrc) {
    const out = [];
    for (const raw of String(lrc || '').split(/\r?\n/)) {
      const stamps = [];
      let rest = raw;
      let m;
      while ((m = rest.match(/^\s*\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/))) {
        stamps.push(Number(m[1]) * 60 + Number(m[2].replace(':', '.')));
        rest = rest.slice(m[0].length);
      }
      if (!stamps.length) continue;
      const text = rest.trim();
      for (const t of stamps) out.push({ t, text });
    }
    return out.sort((x, y) => x.t - y.t);
  }

  /** True for titles of vocal-only versions (a cappella, isolated vocals...). */
  function isVocalOnlyTitle(title) {
    return /a\s*cappella|acc?apella|vocals?\s+only|isolated\s+vocals?|voice\s+only|vocal\s+(track|stem)|只有人声|清唱/i.test(String(title || ''));
  }

  /** Index of the line playing at time t (-1 before the first line). */
  function lineAt(lines, t) {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  function words(x) {
    return String(x || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  /** 0..1: how much of `want` appears in `got` (word overlap). */
  function similarity(want, got) {
    const a = words(want);
    if (!a.length) return 0;
    const b = new Set(words(got));
    return a.filter((w) => b.has(w)).length / a.length;
  }

  /** Orders LRCLIB search results: best title/artist match, has lyrics, close length. */
  function rankLyrics(results, guess, duration) {
    return (results || [])
      .filter((r) => r && !r.instrumental && (r.syncedLyrics || r.plainLyrics))
      .map((r) => {
        // Titles are written "Artist - Song" or "Song - Artist": try both ways round.
        let score = Math.max(
          similarity(guess.track, r.trackName) * 3 + similarity(guess.artist, r.artistName) * 2,
          similarity(guess.artist, r.trackName) * 3 + similarity(guess.track, r.artistName) * 2
        );
        if (r.syncedLyrics) score += 0.5;
        if (duration > 0 && r.duration > 0) score -= Math.min(1, Math.abs(r.duration - duration) / 30);
        return { r, score };
      })
      .sort((x, y) => y.score - x.score)
      .map((x) => x.r);
  }

  const api = {
    SPEED_MIN, SPEED_MAX, END_GUARD, MIN_LOOP,
    clamp, roundRate, formatTime, trainerRate, trainerRepFor, loopEnd, normalizeLoop,
    PeakStore, bandColor, bytesToBase64, base64ToBytes,
    parseSongTitle, parseLrc, lineAt, similarity, rankLyrics, isVocalOnlyTitle,
  };
  root.YTLCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* Styles for the looper panel. They live inside a shadow root, so YouTube's
 * CSS can't reach them and they can't leak into YouTube. */
globalThis.YTL_PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.panel {
  --bg: #0b0e14;
  --bg2: #121722;
  --bg3: #1a2130;
  --line: #262f42;
  --text: #e8ecf4;
  --muted: #8b95a8;
  --accent: #19d3ff;
  --accent-ink: #001a22;
  --a: #3ddc84;
  --b: #ff6b4a;
  --gold: #ffcf3d;
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.25 Roboto, "YouTube Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  border-top: 1px solid var(--line);
  box-shadow: 0 -10px 30px rgba(0,0,0,.45);
  user-select: none;
  -webkit-user-select: none;
}
.resize {
  position: absolute; left: 0; right: 0; top: -8px; height: 16px;
  cursor: ns-resize; z-index: 3;
}
.resize::after {
  content: ""; position: absolute; left: 50%; top: 5px; width: 72px; height: 6px;
  margin-left: -36px; border-radius: 3px; background: #4a5670; transition: background .12s;
}
.resize:hover::after { background: var(--accent); }
.row {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 6px 10px; padding: 6px 10px;
}
.bar { background: var(--bg2); border-bottom: 1px solid var(--line); padding-top: 7px; }
.bar.transport { background: #10151f; padding-top: 6px; }
.group { display: flex; align-items: center; gap: 4px; }
.sep { width: 1px; height: 22px; background: var(--line); margin: 0 2px; }
.spacer { flex: 1 1 auto; }
.brand { display: flex; align-items: center; gap: 6px; font-weight: 700; letter-spacing: .2px; color: #fff; margin-right: 2px; }
.brand svg { width: 18px; height: 18px; fill: var(--accent); }
.brand small { font-weight: 500; color: var(--muted); }
.label { color: var(--muted); font-size: 12px; }
button {
  font: inherit; color: var(--text); background: var(--bg3);
  border: 1px solid var(--line); border-radius: 8px;
  height: 28px; min-width: 28px; padding: 0 9px;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  cursor: pointer; white-space: nowrap; transition: background .12s, border-color .12s, color .12s;
}
button:hover { background: #222b3d; border-color: #34405a; }
button:active { transform: translateY(1px); }
button:disabled { opacity: .4; cursor: default; transform: none; }
button.icon { padding: 0; width: 28px; }
button svg { width: 16px; height: 16px; fill: currentColor; flex: none; }
button.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 700; }
button.speed { min-width: 50px; font-weight: 600; }
button.play-btn { width: 44px; min-width: 44px; height: 32px; background: #1d3a46; border-color: #2b5666; color: #fff; }
button.play-btn svg { width: 22px; height: 22px; }
button.play-btn.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button.zoom-toggle { min-width: 112px; font-weight: 600; }
button.speed.on { background: var(--gold); border-color: var(--gold); color: #241b00; }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 700; }
button.danger { color: #ffb4a6; }
.mark {
  display: flex; align-items: center; height: 28px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--bg3); overflow: hidden;
}
.mark button { border: 0; border-radius: 0; height: 26px; background: transparent; min-width: 22px; padding: 0 5px; }
.mark button:hover { background: #222b3d; }
.mark .set { font-weight: 800; padding: 0 8px; }
.mark.a .set { color: var(--a); }
.mark.b .set { color: var(--b); }
.mark .time {
  font-variant-numeric: tabular-nums; min-width: 62px; text-align: center; color: var(--text);
  padding: 0 2px; font-size: 12.5px;
}
.mark.pending { border-color: var(--a); box-shadow: 0 0 0 1px var(--a) inset; }
.rate {
  font-variant-numeric: tabular-nums; min-width: 52px; text-align: center; font-weight: 700;
  font-size: 14px; color: var(--gold); cursor: pointer; border-radius: 6px; padding: 4px 2px;
}
.rate:hover { background: var(--bg3); }
select {
  font: inherit; color: var(--text); background: var(--bg3); border: 1px solid var(--line);
  border-radius: 8px; height: 28px; padding: 0 6px; cursor: pointer;
}
label.check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--text); }
label.check input { accent-color: var(--accent); width: 15px; height: 15px; margin: 0; }
.sub { background: #0f1420; border-bottom: 1px solid var(--line); }
.sub[hidden] { display: none; }
.progress { position: relative; width: 160px; height: 8px; border-radius: 4px; background: var(--bg3); overflow: hidden; }
.progress > i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: linear-gradient(90deg, var(--a), var(--gold)); transition: width .25s; }
.tstat { font-variant-numeric: tabular-nums; color: var(--text); min-width: 140px; }
.tstat b { color: var(--gold); }
.stage { position: relative; display: flex; flex: none; height: 140px; }
.wave-wrap { position: relative; flex: 1 1 auto; min-width: 0; }
.lyrics {
  flex: 0 0 34%; min-width: 240px; max-width: 480px; display: flex; flex-direction: column;
  border-left: 1px solid var(--line); background: #0d1119;
  min-height: 0; overflow: hidden; /* a long song must scroll inside, never grow the panel */
}
.lyr-head { display: flex; gap: 4px; padding: 5px 6px; border-bottom: 1px solid var(--line); }
.lyr-head input {
  flex: 1 1 auto; min-width: 0; height: 28px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--bg3); color: var(--text); padding: 0 8px; font: inherit; outline: none;
}
.lyr-head input:focus { border-color: var(--accent); }
.lyr-meta { padding: 3px 8px; color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 18px; }
.lyr-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 8px 60px; -webkit-overflow-scrolling: touch; user-select: text; -webkit-user-select: text; }
.lyr-body p { margin: 0; padding: .2em .4em; border-radius: 6px; color: #b4bccc; font-size: var(--lyr-font, 15px); line-height: 1.35; transition: color .15s, background .15s; }
button.lyr-size { font-weight: 800; font-size: 13px; }
.lyr-resize { display: none; }
/* Lyrics on top of the screen (default on iPad/iPhone): big, karaoke style. */
.lyrics.top {
  position: fixed; left: 0; right: 0; top: 0; z-index: 4;
  flex: none; width: auto; min-width: 0; max-width: none;
  border-left: 0; border-bottom: 1px solid #33405a;
  background: rgba(8, 11, 17, .97); box-shadow: 0 10px 30px rgba(0,0,0,.55);
  padding-top: env(safe-area-inset-top, 0px);
}
.lyrics.top .lyr-meta { text-align: center; }
.lyrics.top .lyr-body { text-align: center; padding: 8px 16px 40%; }
.lyrics.top .lyr-body p { line-height: 1.3; }
.lyrics.top .lyr-resize {
  display: block; position: absolute; left: 0; right: 0; bottom: 0; height: 22px; cursor: ns-resize; z-index: 5; touch-action: none;
  background: linear-gradient(transparent, rgba(8,11,17,.9));
}
.lyrics.top .lyr-resize::after {
  content: ""; position: absolute; left: 50%; top: 9px; width: 90px; height: 7px; margin-left: -45px; border-radius: 4px; background: #4a5670;
}
.lyrics.top .lyr-resize:hover::after { background: var(--accent); }
.lyr-body.synced p { cursor: pointer; position: relative; padding-left: 2.1em; padding-right: 2.1em; }
.lyr-loop {
  position: absolute; left: .25em; top: 50%; transform: translateY(-50%);
  width: 1.5em; height: 1.5em; min-width: 26px; min-height: 26px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  color: #5d6780; border: 1px solid #2a3348; background: rgba(255,255,255,.03);
}
.lyr-loop svg { width: 62%; height: 62%; fill: currentColor; }
.lyr-body p:hover .lyr-loop, .lyr-body p.now .lyr-loop { color: #b9a4ff; border-color: #4b3f78; }
.lyr-body p.looping { background: rgba(190,120,255,.22); color: #fff; font-weight: 700; }
.lyr-body p.looping .lyr-loop { color: #1a0b2e; background: #c084fc; border-color: #c084fc; }
.lyr-body.synced p:hover { background: rgba(255,255,255,.05); }
.lyr-body p.past { color: #6f788b; }
.lyr-body p.now { color: #fff; background: rgba(25,211,255,.16); font-weight: 700; }
.lyr-msg { color: var(--muted); padding: 10px 6px; line-height: 1.4; }
.lyr-sync { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 2px 6px 4px; }
.lyr-sync button { height: 24px; padding: 0 8px; font-size: 12px; border-radius: 12px; }
.lyr-off { color: var(--muted); font-size: 12px; min-width: 96px; text-align: center; font-variant-numeric: tabular-nums; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.overlay {
  position: absolute; left: 50%; top: 55%; transform: translate(-50%, -50%);
  display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 10px;
  background: rgba(10, 14, 22, .88); border: 1px solid var(--line); box-shadow: 0 6px 24px rgba(0,0,0,.5);
  font-size: 13px; white-space: nowrap; pointer-events: auto; z-index: 2;
}
.overlay[hidden] { display: none; }
.tip {
  position: absolute; top: 20px; padding: 2px 6px; border-radius: 4px; background: #000c;
  color: #fff; font-size: 11px; font-variant-numeric: tabular-nums; pointer-events: none;
  transform: translateX(-50%); white-space: nowrap; z-index: 2;
}
.tip[hidden] { display: none; }
.status { display: flex; align-items: center; gap: 10px; padding: 4px 10px; min-height: 30px; background: var(--bg2); border-top: 1px solid var(--line); }
.hint { color: var(--muted); flex: 1 1 auto; min-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hint b { color: var(--text); font-weight: 600; }
.chips { display: flex; align-items: center; gap: 5px; flex-wrap: nowrap; overflow-x: auto; max-width: 55%; scrollbar-width: thin; }
.chip {
  display: inline-flex; align-items: center; height: 22px; border-radius: 11px; border: 1px solid var(--line);
  background: var(--bg3); font-size: 12px; overflow: hidden; flex: none;
}
.chip button { height: 20px; border: 0; background: transparent; border-radius: 0; padding: 0 8px; font-size: 12px; min-width: 0; }
.chip button.x { padding: 0 6px 0 2px; color: var(--muted); }
.chip.active { border-color: var(--accent); }
.chip.add button { color: var(--accent); }
.count { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.count b { color: var(--text); }
.collapsed .stage, .collapsed .sub, .collapsed .status { display: none; }
.help {
  position: absolute; right: 10px; bottom: 36px; z-index: 5; width: min(520px, calc(100% - 20px));
  max-height: calc(100% - 50px); overflow: auto; padding: 14px 16px; border-radius: 12px;
  background: #0f1420; border: 1px solid #33405a; box-shadow: 0 12px 40px rgba(0,0,0,.6); line-height: 1.5;
}
.help[hidden] { display: none; }
.help h3 { margin: 0 0 6px; font-size: 15px; color: #fff; }
.help ol, .help ul { margin: 4px 0 10px; padding-left: 20px; }
.help kbd {
  display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 4px; border: 1px solid #3a4560;
  background: #1a2130; font: 600 11px/18px ui-monospace, Menlo, monospace; text-align: center; color: #fff;
}
.help .close { position: absolute; right: 8px; top: 8px; }
@media (max-width: 1400px) {
  .brand-name, .hide-narrow { display: none; }
  .row { gap: 6px 5px; }
  .lyrics-btn .txt { display: none; }
  .lyrics-btn { width: 28px; padding: 0; }
  button.speed { min-width: 46px; }
}
@media (max-width: 900px) {
  .chips { max-width: 40%; }
}
/* Fingers: bigger targets (iPad, iPhone, touch laptops). */
@media (any-pointer: coarse) {
  button { height: 38px; min-width: 38px; border-radius: 10px; font-size: 14px; }
  button.icon { width: 38px; }
  button svg { width: 20px; height: 20px; }
  .mark { height: 38px; }
  .mark button { height: 36px; min-width: 30px; }
  select { height: 38px; font-size: 14px; }
  .chip { height: 30px; border-radius: 15px; }
  .chip button { height: 28px; font-size: 13px; }
  .resize { top: -12px; height: 24px; }
  .lyr-head input { height: 38px; font-size: 16px; }
  .lyrics-btn { width: 38px; }
  .lyr-sync button { height: 32px; font-size: 13px; padding: 0 12px; border-radius: 16px; }
  button.play-btn { width: 60px; min-width: 60px; height: 44px; }
  button.play-btn svg { width: 28px; height: 28px; }

  .resize::after { top: 9px; width: 90px; margin-left: -45px; }
  .help { font-size: 14px; }
}
/* Phones: compact rows so the wave keeps most of the space. */
@media (max-width: 600px) {
  .brand, .sep, .label.hide-narrow, .size-btns, .hide-phone { display: none !important; }
  .row { padding: 5px 6px; gap: 5px; }
  .group { gap: 3px; }
  button { padding: 0 6px; gap: 4px; }
  button.icon { width: 36px; min-width: 36px; }
  select { padding: 0 2px; font-size: 13px; }
  .status { flex-wrap: wrap; gap: 4px 8px; padding: 4px 8px; }
  .hint { flex-basis: 100%; }
  .mark .time { min-width: 54px; font-size: 12px; }
  .mark .set { padding: 0 6px; }
  button.speed { min-width: 46px; }
  button.zoom-toggle { min-width: 0; }
  .rate { min-width: 42px; font-size: 13px; }
  .spacer { display: none; }
  .hint { font-size: 12px; white-space: normal; }
  .chips { max-width: none; flex: 1 1 auto; }
  .tstat { min-width: 0; flex-basis: 100%; }
  .progress { flex: 1 1 auto; width: auto; }
  .stage { flex-direction: column-reverse; }
  .lyrics { flex: 0 0 170px; min-width: 0; max-width: none; border-left: 0; border-bottom: 1px solid var(--line); }
  .wave-wrap { min-height: 80px; }
  .lyrics-btn { width: 36px; min-width: 36px; }
  button.play-btn { width: 52px; min-width: 52px; height: 44px; }
  .rate { display: none; } /* the lit speed button and the trainer row show the speed */
  button.speed { min-width: 41px; padding: 0 5px; }
  .bar { padding-left: 4px; padding-right: 4px; }
  .rate { min-width: 38px; font-size: 12.5px; }
}
`;

/*
 * Signalsmith Stretch 1.3.2 (JS/WASM release, npm "signalsmith-stretch").
 * MIT License, (c) Geraint Luff / Signalsmith Audio. https://signalsmith-audio.co.uk/code/stretch/
 * Used for the studio-quality slow-down (pitch correction of tape-slowed audio).
 */

var SignalsmithStretch = (() => {
  var _scriptName = typeof document != 'undefined' ? document.currentScript?.src : undefined;
  
  return (
function(moduleArg = {}) {
  var moduleRtn;

var Module=moduleArg;var readyPromiseResolve,readyPromiseReject;var readyPromise=new Promise((resolve,reject)=>{readyPromiseResolve=resolve;readyPromiseReject=reject});var ENVIRONMENT_IS_WEB=typeof window=="object";var ENVIRONMENT_IS_WORKER=typeof WorkerGlobalScope!="undefined";var ENVIRONMENT_IS_NODE=typeof process=="object"&&typeof process.versions=="object"&&typeof process.versions.node=="string"&&process.type!="renderer";var ENVIRONMENT_IS_SHELL=!ENVIRONMENT_IS_WEB&&!ENVIRONMENT_IS_NODE&&!ENVIRONMENT_IS_WORKER;var crypto=globalThis?.crypto||{getRandomValues:array=>{for(var i=0;i<array.length;i++)array[i]=Math.random()*256|0}};var performance=globalThis?.performance||{now:_=>Date.now()};var moduleOverrides=Object.assign({},Module);var arguments_=[];var quit_=(status,toThrow)=>{throw toThrow};var scriptDirectory="";var readAsync,readBinary;if(ENVIRONMENT_IS_SHELL){readBinary=f=>{if(typeof readbuffer=="function"){return new Uint8Array(readbuffer(f))}let data=read(f,"binary");assert(typeof data=="object");return data};readAsync=f=>new Promise((resolve,reject)=>{setTimeout(()=>resolve(readBinary(f)))});globalThis.clearTimeout??=id=>{};globalThis.setTimeout??=f=>f();arguments_=globalThis.arguments||globalThis.scriptArgs;if(typeof quit=="function"){quit_=(status,toThrow)=>{setTimeout(()=>{if(!(toThrow instanceof ExitStatus)){let toLog=toThrow;if(toThrow&&typeof toThrow=="object"&&toThrow.stack){toLog=[toThrow,toThrow.stack]}err(`exiting due to exception: ${toLog}`)}quit(status)});throw toThrow}}if(typeof print!="undefined"){globalThis.console??={};console.log=print;console.warn=console.error=globalThis.printErr??print}}else if(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER){if(ENVIRONMENT_IS_WORKER){scriptDirectory=self.location.href}else if(typeof document!="undefined"&&document.currentScript){scriptDirectory=document.currentScript.src}if(_scriptName){scriptDirectory=_scriptName}if(scriptDirectory.startsWith("blob:")){scriptDirectory=""}else{scriptDirectory=scriptDirectory.substr(0,scriptDirectory.replace(/[?#].*/,"").lastIndexOf("/")+1)}{if(ENVIRONMENT_IS_WORKER){readBinary=url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.responseType="arraybuffer";xhr.send(null);return new Uint8Array(xhr.response)}}readAsync=url=>fetch(url,{credentials:"same-origin"}).then(response=>{if(response.ok){return response.arrayBuffer()}return Promise.reject(new Error(response.status+" : "+response.url))})}}else{}var out=console.log.bind(console);var err=console.error.bind(console);Object.assign(Module,moduleOverrides);moduleOverrides=null;var wasmBinary;if(typeof atob=="undefined"){if(typeof global!="undefined"&&typeof globalThis=="undefined"){globalThis=global}globalThis.atob=function(input){var keyStr="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";var output="";var chr1,chr2,chr3;var enc1,enc2,enc3,enc4;var i=0;input=input.replace(/[^A-Za-z0-9\+\/\=]/g,"");do{enc1=keyStr.indexOf(input.charAt(i++));enc2=keyStr.indexOf(input.charAt(i++));enc3=keyStr.indexOf(input.charAt(i++));enc4=keyStr.indexOf(input.charAt(i++));chr1=enc1<<2|enc2>>4;chr2=(enc2&15)<<4|enc3>>2;chr3=(enc3&3)<<6|enc4;output=output+String.fromCharCode(chr1);if(enc3!==64){output=output+String.fromCharCode(chr2)}if(enc4!==64){output=output+String.fromCharCode(chr3)}}while(i<input.length);return output}}function intArrayFromBase64(s){var decoded=atob(s);var bytes=new Uint8Array(decoded.length);for(var i=0;i<decoded.length;++i){bytes[i]=decoded.charCodeAt(i)}return bytes}function tryParseAsDataURI(filename){if(!isDataURI(filename)){return}return intArrayFromBase64(filename.slice(dataURIPrefix.length))}var wasmMemory;var ABORT=false;var EXITSTATUS;var HEAP8,HEAPU8,HEAP16,HEAPU16,HEAP32,HEAPU32,HEAPF32,HEAPF64;function updateMemoryViews(){var b=wasmMemory.buffer;Module["HEAP8"]=HEAP8=new Int8Array(b);HEAP16=new Int16Array(b);HEAPU8=new Uint8Array(b);HEAPU16=new Uint16Array(b);HEAP32=new Int32Array(b);HEAPU32=new Uint32Array(b);HEAPF32=new Float32Array(b);HEAPF64=new Float64Array(b)}var __ATPRERUN__=[];var __ATINIT__=[];var __ATMAIN__=[];var __ATPOSTRUN__=[];var runtimeInitialized=false;function preRun(){callRuntimeCallbacks(__ATPRERUN__)}function initRuntime(){runtimeInitialized=true;callRuntimeCallbacks(__ATINIT__)}function preMain(){callRuntimeCallbacks(__ATMAIN__)}function postRun(){callRuntimeCallbacks(__ATPOSTRUN__)}function addOnInit(cb){__ATINIT__.unshift(cb)}var runDependencies=0;var runDependencyWatcher=null;var dependenciesFulfilled=null;function addRunDependency(id){runDependencies++}function removeRunDependency(id){runDependencies--;if(runDependencies==0){if(runDependencyWatcher!==null){clearInterval(runDependencyWatcher);runDependencyWatcher=null}if(dependenciesFulfilled){var callback=dependenciesFulfilled;dependenciesFulfilled=null;callback()}}}function abort(what){what="Aborted("+what+")";err(what);ABORT=true;what+=". Build with -sASSERTIONS for more info.";var e=new WebAssembly.RuntimeError(what);readyPromiseReject(e);throw e}var dataURIPrefix="data:application/octet-stream;base64,";var isDataURI=filename=>filename.startsWith(dataURIPrefix);function findWasmBinary(){var f="data:application/octet-stream;base64,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fyAAKAIIIQMgBCgCACEFAkACQCABQQRPBEAgAyAFckEDcQ0BA0AgAygCACAFKAIARw0CIAVBBGohBSADQQRqIQMgAUEEayIBQQNLDQALCyABRQ0BCwNAIAMtAAAiCSAFLQAAIgpGBEAgBUEBaiEFIANBAWohAyABQQFrIgENAQwCCwsgCSAKawwBC0EACyIBDQBBACEBIAAoAgwiAyAEKAIEIgVGDQBBf0EBIAMgBUkbIQELIAZBEGokACABRSEDCyAEQRBqJAAgAEEgaiQAIANFBEAjAEEQayIFJABBuggQHCEEAn8gAi0AC0EHdgRAIAIoAgQMAQsgAi0AC0H/AHELIQMCfwJ/IwBBEGsiByQAIAhBBGohASADIARqIgBB9////wdNBEACQCAAQQtJBEAgAUIANwIAIAFBADYCCCABIAEtAAtBgAFxIABB/wBxcjoACyABIAEtAAtB/wBxOgALDAELIABBC08EfyAAQQhqQXhxIgYgBkEBayIGIAZBC0YbBUEKC0EBaiIGEAchCCABIAEoAghBgICAgHhxIAZB/////wdxcjYCCCABIAEoAghBgICAgHhyNgIIIAEgCDYCACABIAA2AgQLIAdBEGokACABDAELEA0ACyIALQALQQd2BEAgACgCAAwBCyAACyIAQboIIAQQGyAAIARqIgACfyACLQALQQd2BEAgAigCAAwBCyACCyADEBsgACADaiECIwBBEGsiACQAIABBADoAD0EBIQQDQCAEBEAgAiAALQAPOgAAIARBAWshBCACQQFqIQIMAQsLIABBEGokACAFQRBqJAACfyABLQALQQd2BEAgASgCAAwBC0EACxoQDgALIAhBEGokACAHLAAPQQBIBEAgBygCBBAECyMAQRBrIgIkACMAQRBrIgEkACACQQxqQQQQACIABH9B3DQgADYCAEF/BUEACyABKAIMGiABQRBqJAAEQEHcNCgCABoQDgALIAIoAgwhASACQRBqJABBkDRBASABQf////8HcCICIAJBAU0bNgIAQZw0QgA3AgBBlDRCADcCAEGoNEIANwMAQbA0QgA3AwAgB0EQaiQAQbg0QgA3AgBBwDRBADYCAEHENEIANwIAQcw0QQA2AgBB0DRCADcCAEHYNEEANgIAC+gBAQR/IwBBEGsiBiQAIwBBIGsiAyQAIwBBEGsiBCQAIAQg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";return f}var wasmBinaryFile;function getBinarySync(file){if(file==wasmBinaryFile&&wasmBinary){return new Uint8Array(wasmBinary)}var binary=tryParseAsDataURI(file);if(binary){return binary}if(readBinary){return readBinary(file)}throw"both async and sync fetching of the wasm failed"}function getBinaryPromise(binaryFile){return Promise.resolve().then(()=>getBinarySync(binaryFile))}function instantiateArrayBuffer(binaryFile,imports,receiver){return getBinaryPromise(binaryFile).then(binary=>WebAssembly.instantiate(binary,imports)).then(receiver,reason=>{err(`failed to asynchronously prepare wasm: ${reason}`);abort(reason)})}function instantiateAsync(binary,binaryFile,imports,callback){return instantiateArrayBuffer(binaryFile,imports,callback)}function getWasmImports(){return{a:wasmImports}}function createWasm(){function receiveInstance(instance,module){wasmExports=instance.exports;wasmMemory=wasmExports["e"];updateMemoryViews();addOnInit(wasmExports["f"]);removeRunDependency("wasm-instantiate");return wasmExports}addRunDependency("wasm-instantiate");function receiveInstantiationResult(result){receiveInstance(result["instance"])}var info=getWasmImports();wasmBinaryFile??=findWasmBinary();instantiateAsync(wasmBinary,wasmBinaryFile,info,receiveInstantiationResult).catch(readyPromiseReject);return{}}class ExitStatus{name="ExitStatus";constructor(status){this.message=`Program terminated with exit(${status})`;this.status=status}}var callRuntimeCallbacks=callbacks=>{while(callbacks.length>0){callbacks.shift()(Module)}};var __abort_js=()=>abort("");var __emscripten_memcpy_js=(dest,src,num)=>HEAPU8.copyWithin(dest,src,src+num);var getHeapMax=()=>2147483648;var alignMemory=(size,alignment)=>Math.ceil(size/alignment)*alignment;var abortOnCannotGrowMemory=requestedSize=>{abort("OOM")};var growMemory=size=>{var b=wasmMemory.buffer;var pages=(size-b.byteLength+65535)/65536|0;try{wasmMemory.grow(pages);updateMemoryViews();return 1}catch(e){}};var _emscripten_resize_heap=requestedSize=>{var oldSize=HEAPU8.length;requestedSize>>>=0;var maxHeapSize=getHeapMax();if(requestedSize>maxHeapSize){abortOnCannotGrowMemory(requestedSize)}for(var cutDown=1;cutDown<=4;cutDown*=2){var overGrownHeapSize=oldSize*(1+.5/cutDown);overGrownHeapSize=Math.min(overGrownHeapSize,requestedSize+100663296);var newSize=Math.min(maxHeapSize,alignMemory(Math.max(requestedSize,overGrownHeapSize),65536));var replacement=growMemory(newSize);if(replacement){return true}}abortOnCannotGrowMemory(requestedSize)};var initRandomFill=()=>{if(typeof crypto=="object"&&typeof crypto["getRandomValues"]=="function"){return view=>crypto.getRandomValues(view)}else abort("initRandomDevice")};var randomFill=view=>(randomFill=initRandomFill())(view);var _random_get=(buffer,size)=>{randomFill(HEAPU8.subarray(buffer,buffer+size));return 0};var keepRuntimeAlive=()=>true;var _proc_exit=code=>{EXITSTATUS=code;if(!keepRuntimeAlive()){ABORT=true}quit_(code,new ExitStatus(code))};var exitJS=(status,implicit)=>{EXITSTATUS=status;_proc_exit(status)};var handleException=e=>{if(e instanceof ExitStatus||e=="unwind"){return EXITSTATUS}quit_(1,e)};var UTF8Decoder=typeof TextDecoder!="undefined"?new TextDecoder:undefined;var UTF8ArrayToString=(heapOrArray,idx=0,maxBytesToRead=NaN)=>{var endIdx=idx+maxBytesToRead;var endPtr=idx;while(heapOrArray[endPtr]&&!(endPtr>=endIdx))++endPtr;if(endPtr-idx>16&&heapOrArray.buffer&&UTF8Decoder){return UTF8Decoder.decode(heapOrArray.subarray(idx,endPtr))}var str="";while(idx<endPtr){var u0=heapOrArray[idx++];if(!(u0&128)){str+=String.fromCharCode(u0);continue}var u1=heapOrArray[idx++]&63;if((u0&224)==192){str+=String.fromCharCode((u0&31)<<6|u1);continue}var u2=heapOrArray[idx++]&63;if((u0&240)==224){u0=(u0&15)<<12|u1<<6|u2}else{u0=(u0&7)<<18|u1<<12|u2<<6|heapOrArray[idx++]&63}if(u0<65536){str+=String.fromCharCode(u0)}else{var ch=u0-65536;str+=String.fromCharCode(55296|ch>>10,56320|ch&1023)}}return str};var UTF8ToString=(ptr,maxBytesToRead)=>ptr?UTF8ArrayToString(HEAPU8,ptr,maxBytesToRead):"";var wasmImports={d:__abort_js,c:__emscripten_memcpy_js,b:_emscripten_resize_heap,a:_random_get};var wasmExports=createWasm();var ___wasm_call_ctors=()=>(___wasm_call_ctors=wasmExports["f"])();var _setBuffers=Module["_setBuffers"]=(a0,a1)=>(_setBuffers=Module["_setBuffers"]=wasmExports["h"])(a0,a1);var _blockSamples=Module["_blockSamples"]=()=>(_blockSamples=Module["_blockSamples"]=wasmExports["i"])();var _intervalSamples=Module["_intervalSamples"]=()=>(_intervalSamples=Module["_intervalSamples"]=wasmExports["j"])();var _inputLatency=Module["_inputLatency"]=()=>(_inputLatency=Module["_inputLatency"]=wasmExports["k"])();var _outputLatency=Module["_outputLatency"]=()=>(_outputLatency=Module["_outputLatency"]=wasmExports["l"])();var _reset=Module["_reset"]=()=>(_reset=Module["_reset"]=wasmExports["m"])();var _presetDefault=Module["_presetDefault"]=(a0,a1)=>(_presetDefault=Module["_presetDefault"]=wasmExports["n"])(a0,a1);var _presetCheaper=Module["_presetCheaper"]=(a0,a1)=>(_presetCheaper=Module["_presetCheaper"]=wasmExports["o"])(a0,a1);var _configure=Module["_configure"]=(a0,a1,a2,a3)=>(_configure=Module["_configure"]=wasmExports["p"])(a0,a1,a2,a3);var _setTransposeFactor=Module["_setTransposeFactor"]=(a0,a1)=>(_setTransposeFactor=Module["_setTransposeFactor"]=wasmExports["q"])(a0,a1);var _setTransposeSemitones=Module["_setTransposeSemitones"]=(a0,a1)=>(_setTransposeSemitones=Module["_setTransposeSemitones"]=wasmExports["r"])(a0,a1);var _setFormantFactor=Module["_setFormantFactor"]=(a0,a1)=>(_setFormantFactor=Module["_setFormantFactor"]=wasmExports["s"])(a0,a1);var _setFormantSemitones=Module["_setFormantSemitones"]=(a0,a1)=>(_setFormantSemitones=Module["_setFormantSemitones"]=wasmExports["t"])(a0,a1);var _setFormantBase=Module["_setFormantBase"]=a0=>(_setFormantBase=Module["_setFormantBase"]=wasmExports["u"])(a0);var _seek=Module["_seek"]=(a0,a1)=>(_seek=Module["_seek"]=wasmExports["v"])(a0,a1);var _process=Module["_process"]=(a0,a1)=>(_process=Module["_process"]=wasmExports["w"])(a0,a1);var _flush=Module["_flush"]=a0=>(_flush=Module["_flush"]=wasmExports["x"])(a0);var _main=Module["_main"]=(a0,a1)=>(_main=Module["_main"]=wasmExports["y"])(a0,a1);Module["UTF8ToString"]=UTF8ToString;var calledRun;dependenciesFulfilled=function runCaller(){if(!calledRun)run();if(!calledRun)dependenciesFulfilled=runCaller};function callMain(){var entryFunction=_main;var argc=0;var argv=0;try{var ret=entryFunction(argc,argv);exitJS(ret,true);return ret}catch(e){return handleException(e)}}function run(){if(runDependencies>0){return}preRun();if(runDependencies>0){return}function doRun(){if(calledRun)return;calledRun=true;Module["calledRun"]=true;if(ABORT)return;initRuntime();preMain();readyPromiseResolve(Module);if(shouldRunNow)callMain();postRun()}{doRun()}}var shouldRunNow=true;run();moduleRtn=readyPromise;


  return moduleRtn;
}
);
})();
if (typeof exports === 'object' && typeof module === 'object')
  module.exports = SignalsmithStretch;
else if (typeof define === 'function' && define['amd'])
  define([], () => SignalsmithStretch);
function registerWorkletProcessor(Module, audioNodeKey) {
	class WasmProcessor extends AudioWorkletProcessor {
		constructor(options) {
			super(options);
			this.wasmReady = false;
			this.wasmModule = null;
			this.channels = 0;
			this.buffersIn = [];
			this.buffersOut = [];
			
			this.audioBuffers = []; // list of (multi-channel) audio buffers
			this.audioBuffersStart = 0; // time-stamp for the first audio buffer
			this.audioBuffersEnd = 0; // just to be helpful
			
			this.timeIntervalSamples = sampleRate*0.1;
			this.timeIntervalCounter = 0;
			
			this.timeMap = [{
				active: false,
				input: 0,
				output: 0,
				rate: 1,
				semitones: 0,
				tonalityHz: 8000,
				formantSemitones: 0,
				formantCompensation: false,
				formantBaseHz: 0, /* 0 = attempt to detect */
				loopStart: 0,
				loopEnd: 0
			}];
			
			let remoteMethods = {
				configure: config => {
					Object.assign(this.config, config);
					this.configure();
				},
				latency: _ => {
					return this.inputLatencySeconds + this.outputLatencySeconds;
				},
				setUpdateInterval: seconds => {
					this.timeIntervalSamples = sampleRate*seconds;
				},
				stop: when => {
					if (typeof when !== 'number') when = currentTime;
					return remoteMethods.schedule({active: false, output: when});
				},
				start: (when, offset, duration, rate, semitones) => {
					if (typeof when === 'object') {
						if (!('active' in when)) when.active = true;
						return remoteMethods.schedule(when);
					}
					
					let obj = {active: true, input: 0, output: currentTime + this.outputLatencySeconds};
					if (typeof when === 'number') obj.output = when;
					if (typeof offset === 'number') obj.input = offset;
					if (typeof rate === 'number') obj.rate = rate;
					if (typeof semitones === 'number') obj.semitones = semitones;
					let result = remoteMethods.schedule(obj);
					if (typeof duration === 'number') {
						remoteMethods.stop(obj.output + duration);
						obj.output += duration;
						obj.active = false;
						remoteMethods.schedule(obj);
					}
					return result;
				},
				schedule: (objIn, adjustPrevious) => {
					let outputTime = ('outputTime' in objIn) ? objIn.outputTime : currentTime;

					let latestSegment = this.timeMap[this.timeMap.length - 1];
					while (this.timeMap.length && this.timeMap[this.timeMap.length - 1].output >= outputTime) {
						latestSegment = this.timeMap.pop();
					}

					let obj = Object.assign({}, latestSegment);
					Object.assign(obj, {
						input: null,
						output: outputTime,
					});
					Object.assign(obj, objIn);
					if (obj.input === null) {
						let rate = (latestSegment.active ? latestSegment.rate : 0);
						obj.input = latestSegment.input + (obj.output - latestSegment.output)*rate;
					}
					this.timeMap.push(obj);

					if (adjustPrevious && this.timeMap.length > 1) {
						let previous = this.timeMap[this.timeMap.length - 2];
						if (previous.output < currentTime) {
							let rate = (previous.active ? previous.rate : 0);
							previous.input += (currentTime - previous.output)*rate;
							previous.output = currentTime;
						}
						previous.rate = (obj.input - previous.input)/(obj.output - previous.output);
					}
	
					let currentMapSegment = this.timeMap[0];
					while (this.timeMap.length > 1 && this.timeMap[1].output <= outputTime) {
						this.timeMap.shift();
						currentMapSegment = this.timeMap[0];
					}
					let rate = (currentMapSegment.active ? currentMapSegment.rate : 0);
					let inputTime = currentMapSegment.input + (outputTime - currentMapSegment.output)*rate;
					this.timeIntervalCounter = this.timeIntervalSamples;
					this.port.postMessage(['time', inputTime]);
					
					return obj;
				},
				dropBuffers: toSeconds => {
					if (typeof toSeconds !== 'number') {
						let buffers = this.audioBuffers.flat(1).map(b => b.buffer);
						this.audioBuffers = [];
						this.audioBuffersStart = this.audioBuffersEnd = 0;
						return {
							value: {start: 0, end: 0},
							transfer: buffers
						};
					}
					let transfer = [];
					while (this.audioBuffers.length) {
						let first = this.audioBuffers[0];
						let length = first[0].length;
						let endSamples = this.audioBuffersStart + length;
						let endSeconds = endSamples/sampleRate;
						if (endSeconds > toSeconds) break;

						this.audioBuffers.shift().forEach(b => transfer.push(b.buffer));
						this.audioBuffersStart += length;
					}
					return {
						value: {
							start: this.audioBuffersStart/sampleRate,
							end: this.audioBuffersEnd/sampleRate
						},
						transfer: transfer
					};
				},
				addBuffers: sampleBuffers => {
					sampleBuffers = [].concat(sampleBuffers);
					this.audioBuffers.push(sampleBuffers);
					let length = sampleBuffers[0].length;
					this.audioBuffersEnd += length;
					return this.audioBuffersEnd/sampleRate;
				}
			};

			let pendingMessages = [];
			this.port.onmessage = event => pendingMessages.push(event);

			Module().then(wasmModule => {
				this.wasmModule = wasmModule;
				this.wasmReady = true;

				wasmModule._main();

				this.channels = options.numberOfOutputs ? options.outputChannelCount[0] : 2; // stereo by default
				this.configure();

				this.port.onmessage = event => {
					let data = event.data;
					let messageId = data.shift();
					let method = data.shift();
					let result = remoteMethods[method](...data);
					if (result?.transfer) {
						this.port.postMessage([messageId, result.value], result.transfer);
					} else {
						this.port.postMessage([messageId, result]);
					}
				};
				let methodArgCounts = {};
				for (let key in remoteMethods) {
					methodArgCounts[key] = remoteMethods[key].length;
				}
				this.port.postMessage(['ready', methodArgCounts]);
				pendingMessages.forEach(this.port.onmessage);
				pendingMessages = null;
			});
		}
		
		config = {
			preset: 'default'
		};
		configure() {
			if (this.config.blockMs) {
				let blockSamples = Math.round(this.config.blockMs/1000*sampleRate);
				let intervalSamples = Math.round((this.config.intervalMs || this.config.blockMs*0.25)/1000*sampleRate);
				let splitComputation = this.config.splitComputation;
				this.wasmModule._configure(this.channels, blockSamples, intervalSamples, splitComputation);
				this.wasmModule._reset();
			} else if (this.config.preset == 'cheaper') {
				this.wasmModule._presetCheaper(this.channels, sampleRate);
			} else {
				this.wasmModule._presetDefault(this.channels, sampleRate);
			}
			this.updateBuffers();
			this.inputLatencySeconds = this.wasmModule._inputLatency()/sampleRate;
			this.outputLatencySeconds = this.wasmModule._outputLatency()/sampleRate;
		}
		
		updateBuffers() {
			let wasmModule = this.wasmModule;
			// longer than one STFT block, so we can seek smoothly
			this.bufferLength = (wasmModule._inputLatency() + wasmModule._outputLatency());
			
			let lengthBytes = this.bufferLength*4;
			let bufferPointer = wasmModule._setBuffers(this.channels, this.bufferLength);
			this.buffersIn = [];
			this.buffersOut = [];
			for (let c = 0; c < this.channels; ++c) {
				this.buffersIn.push(bufferPointer + lengthBytes*c);
				this.buffersOut.push(bufferPointer + lengthBytes*(c + this.channels));
			}
		}

		process(inputList, outputList, parameters) {
			if (!this.wasmReady) {
				outputList.forEach(output => {
					output.forEach(channel => {
						channel.fill(0);
					});
				});
				return true;
			}
			if (!outputList[0]?.length) return false;

			let outputTime = currentTime + this.outputLatencySeconds;
			while (this.timeMap.length > 1 && this.timeMap[1].output <= outputTime) {
				this.timeMap.shift();
			}
			let currentMapSegment = this.timeMap[0];

			let wasmModule = this.wasmModule;
			wasmModule._setTransposeSemitones(currentMapSegment.semitones, currentMapSegment.tonalityHz/sampleRate);
			wasmModule._setFormantSemitones(currentMapSegment.formantSemitones, currentMapSegment.formantCompensation);
			wasmModule._setFormantBase(currentMapSegment.formantBaseHz/sampleRate);

			// Check the input/output channel counts
			if (outputList[0].length != this.channels) {
				this.channels = outputList[0]?.length || 0;
				configure();
			}
			let outputBlockSize = outputList[0][0].length;

			let memory = wasmModule.exports ? wasmModule.exports.memory.buffer : wasmModule.HEAP8.buffer;
			// Buffer list (one per channel)
			let inputs = inputList[0];
			if (!currentMapSegment.active) {
				outputList[0].forEach((_, c) => {
					let channelBuffer = inputs[c%inputs.length];
					let buffer = new Float32Array(memory, this.buffersIn[c], outputBlockSize);
					buffer.fill(0);
				});
				// Should detect silent input and skip processing
				wasmModule._process(outputBlockSize, outputBlockSize);
			} else if (inputs?.length) {
				// Live input
				outputList[0].forEach((_, c) => {
					let channelBuffer = inputs[c%inputs.length];
					let buffer = new Float32Array(memory, this.buffersIn[c], outputBlockSize);
					if (channelBuffer) {
						buffer.set(channelBuffer);
					} else {
						buffer.fill(0);
					}
				})
				wasmModule._process(outputBlockSize, outputBlockSize);
			} else {
				let inputTime = currentMapSegment.input + (outputTime - currentMapSegment.output)*currentMapSegment.rate;
				let loopLength = currentMapSegment.loopEnd - currentMapSegment.loopStart;
				if (loopLength > 0 && inputTime >= currentMapSegment.loopEnd) {
					currentMapSegment.input -= loopLength;
					inputTime -= loopLength;
				}
				
				inputTime += this.inputLatencySeconds;
				let inputSamplesEnd = Math.round(inputTime*sampleRate);

				// Fill the buffer with previous input
				let buffers = outputList[0].map((_, c) => new Float32Array(memory, this.buffersIn[c], this.bufferLength));

				let blockSamples = 0; // current write position in the temporary input buffer
				let audioBufferIndex = 0;
				let audioSamples = this.audioBuffersStart; // start of current audio buffer
				// zero-pad until the start of the audio data
				let inputSamples = inputSamplesEnd - this.bufferLength;
				if (inputSamples < audioSamples) {
					blockSamples = audioSamples - inputSamples;
					buffers.forEach(b => b.fill(0, 0, blockSamples));
					inputSamples = audioSamples;
				}
				while (audioBufferIndex < this.audioBuffers.length && audioSamples < inputSamplesEnd) {
					let audioBuffer = this.audioBuffers[audioBufferIndex];
					let startIndex = inputSamples - audioSamples; // start index within the audio buffer
					let bufferEnd = audioSamples + audioBuffer[0].length;
					// how many samples to copy: min(how many left in the buffer, how many more we need)
					let count = Math.min(audioBuffer[0].length - startIndex, inputSamplesEnd - inputSamples);
					if (count > 0) {
						buffers.forEach((buffer, c) => {
							let channelBuffer = audioBuffer[c%audioBuffer.length];
							buffer.subarray(blockSamples).set(channelBuffer.subarray(startIndex, startIndex + count));
						});
						audioSamples += count;
						blockSamples += count;
					} else { // we're already past this buffer - skip it
						audioSamples += audioBuffer[0].length;
					}
					++audioBufferIndex;
				}
				if (blockSamples < this.bufferLength) {
					buffers.forEach(buffer => buffer.subarray(blockSamples).fill(0));
				}

				// constantly seeking, so we don't have to worry about the input buffers needing to be a rate-dependent size
				wasmModule._seek(this.bufferLength, currentMapSegment.rate);
				wasmModule._process(0, outputBlockSize);

				this.timeIntervalCounter -= outputBlockSize;
				if (this.timeIntervalCounter <= 0) {
					this.timeIntervalCounter = this.timeIntervalSamples;
					this.port.postMessage(['time', inputTime]);
				}
			}
			
			// Re-fetch in case the memory changed (even though there *shouldn't* be any allocations)
			memory = wasmModule.exports ? wasmModule.exports.memory.buffer : wasmModule.HEAP8.buffer;
			outputList[0].forEach((channelBuffer, c) => {
				let buffer = new Float32Array(memory, this.buffersOut[c], outputBlockSize);
				channelBuffer.set(buffer);
			});
			
			return true;
		}
	}

	registerProcessor(audioNodeKey, WasmProcessor);
}

/**
	Creates a Stretch node
	@async
	@function SignalsmithStretch
	@param {AudioContext} audioContext
	@param {Object} options - channel configuration (as per [options]{@link https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode/AudioWorkletNode#options})
	@returns {Promise<StretchNode>}
*/
SignalsmithStretch = ((Module, audioNodeKey) => {
	if (typeof AudioWorkletProcessor === "function" && typeof registerProcessor === "function") {
		// AudioWorklet side
		registerWorkletProcessor(Module, audioNodeKey);
		return {};
	}
	let promiseKey = Symbol();
	let createNode = async function(audioContext, options) {
		/**
			@classdesc An `AudioWorkletNode` with Signalsmith Stretch extensions
			@name StretchNode
			@augments AudioWorkletNode
			@property {number} inputTime - the current playback (in seconds) within the input audio stored by the node
		 */
		let audioNode;
		options = options || {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2]
		};
		try {
			audioNode = new AudioWorkletNode(audioContext, audioNodeKey, options);
		} catch (e) {
			if (!audioContext[promiseKey]) {
				let moduleUrl = createNode.moduleUrl;
				if (!moduleUrl) {
					let moduleCode = `(${registerWorkletProcessor})((_scriptName=>${Module})(),${JSON.stringify(audioNodeKey)})`;
					moduleUrl = URL.createObjectURL(new Blob([moduleCode], {type: 'text/javascript'}));
				}
				audioContext[promiseKey] = audioContext.audioWorklet.addModule(moduleUrl);
			}
			await audioContext[promiseKey];
			audioNode = new AudioWorkletNode(audioContext, audioNodeKey, options);
		}

		// messages with Promise responses
		let requestMap = {};
		let idCounter = 0;
		let timeUpdateCallback = null;
		let post = (transfer, ...data) => {
			let id = idCounter++;
			return new Promise(resolve => {
				requestMap[id] = resolve;
				audioNode.port.postMessage([id].concat(data), transfer);
			});
		};
		audioNode.inputTime = 0;
		audioNode.port.onmessage = (event) => {
			let data = event.data;
			let id = data[0], value = data[1];
			if (id == 'time') {
				audioNode.inputTime = value;
				if (timeUpdateCallback) timeUpdateCallback(value);
			}
			if (id in requestMap) {
				requestMap[id](value);
				delete requestMap[id];
			}
		};
		
		return new Promise(resolve => {
			requestMap['ready'] = remoteMethodKeys => {
				Object.keys(remoteMethodKeys).forEach(key => {
					let argCount = remoteMethodKeys[key];
					audioNode[key] = (...args) => {
						let transfer = null;
						if (args.length > argCount) {
							transfer = args.pop();
						}
						return post(transfer, key, ...args);
					}
				});
				/** @lends StretchNode.prototype
					@method setUpdateInterval
				*/
				audioNode.setUpdateInterval = (seconds, callback) => {
					timeUpdateCallback = callback;
					return post(null, 'setUpdateInterval', seconds);
				}
				resolve(audioNode);
			}
		});
	};
	return createNode;
})(SignalsmithStretch, "signalsmith-stretch");
// register as a CommonJS/AMD module
if (typeof exports === 'object' && typeof module === 'object') {
	module.exports = SignalsmithStretch;
} else if (typeof define === 'function' && define['amd']) {
	define([], () => SignalsmithStretch);
}

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
  const BIN_RATE = 50;
  const SPEED_PRESETS = [0.3, 0.5, 0.75, 1];
  const TRAINER_STARTS = [30, 50, 75];
  const TRAINER_GOAL = 100;
  const TRAINER_REPS = [25, 50, 75];
  const TRAINER_DEFAULT_START = 30;
  const TRAINER_DEFAULT_REPS = 50;
  const TOUCH_LOOP_LEN = 3; // seconds: the A button on touch screens makes a loop this long
  const TOUCH_NUDGE = 1; // seconds: the ‹ › buttons beside A and B on touch screens
  const TAP_MS = 350; // a touch on the wave shorter than this (without sliding) is a tap
  const TRAINER_AFTER = 10; // plays at full speed before the trainer stops by itself
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
    trainerV: 3,
    lyrics: false,
    lyricsTop: null, // null = automatic: top of the screen on touch screens, beside the wave otherwise
    lyricsFont: 0, // 0 = automatic size
    lyricsH: 0, // height of the top lyrics area as a fraction of the screen; 0 = fill the space above the panel
    seenHelp: false,
    zoomFocus: false, // "Zoom in": the wave follows the playhead in a short window
    hqAudio: true, // studio-quality slow-down (Signalsmith Stretch)
    focusLen: 30,
  };
  function saveSettings() {
    storage.set({ 'ytl:settings': { ...settings } });
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const S = {
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
    if (!hasLoop && !S.saved.length && !S.rateOwned) {
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
    try {
      if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; // iPhone: ignore the silent switch, like video sound
    } catch (e) {
      /* ignore */
    }
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
      if (HQ.src && HQ.ctx.state !== 'running') HQ.ctx.resume().catch(() => flash('Tap the panel to bring the sound back.', 6000));
      updateHQ();
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
    if (S.loopOn && hasLoop()) return { a: S.a, b: S.b };
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
      if (ll.rep >= LINE_RAMP + LINE_FULL) {
        finishLinePractice();
        return;
      }
      ll.rep++;
      S.rate = C.trainerRate(LINE_START, 1, LINE_RAMP, ll.rep);
      applyRate();
    }
    if (S.trainer.running && !S.lineLoop) {
      const tr = S.trainer;
      // Rep `reps` is the first play at the goal speed. After `after` plays at
      // the goal speed, training is finished: stop at the loop start.
      if (tr.after > 0 && tr.rep >= tr.reps + tr.after - 1) {
        finishTrainer();
        return;
      }
      tr.rep++;
      if (tr.rep >= tr.reps && !tr.done) {
        tr.done = true;
        flash(tr.after > 0
          ? `Reached ${Math.round(tr.goal * 100)}%! Now ${tr.after} plays at this speed, then it stops.`
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
    const t = nowTime();
    if (TOUCH) {
      // Touch: A sets the start and makes a short loop right away; B sets the end.
      if (hasLoop() && t < S.b - C.MIN_LOOP) setLoop(t, S.b, { noSeek: true });
      else setLoop(t, t + TOUCH_LOOP_LEN, { noSeek: true, fresh: true });
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
    const t = nowTime();
    if (TOUCH) {
      if (hasLoop() && t > S.a + C.MIN_LOOP) setLoop(S.a, t);
      else setLoop(Math.max(0, t - TOUCH_LOOP_LEN), t, { fresh: true });
      return;
    }
    const a = S.pendingA != null ? S.pendingA : S.a;
    if (a == null) return flash('Set the start first: press [ or click the A button.');
    setLoop(a, t, { fresh: S.pendingA != null });
  }

  function nudge(which, delta) {
    if (!hasLoop()) return;
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
    tr.after = TRAINER_AFTER;
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
    tr.done = tr.rep >= tr.reps;
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
  const LYRICS_NUDGE = 0.2; // seconds per tap on ◀ ▶ (lyrics timing)
  // One-line practice (tap the left of a lyric line): speed up from 30% to
  // 100% over 20 plays, then 10 plays at 100%, then stop.
  const LINE_START = 0.3;
  const LINE_RAMP = 20;
  const LINE_FULL = 10;
  const L = { vid: null, token: 0, results: [], idx: 0, lines: null, synced: false, nowIdx: -2, userScrollAt: 0,
    offset: 0, offsetSet: false, autoPending: false, mismatch: false, savedQ: '' };

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
    ui.lyrSync = h('div', { class: 'lyr-sync', hidden: true },
      btn('◀ 0.2s', 'Lyrics are late: show them earlier', () => nudgeLyrics(-LYRICS_NUDGE), 'lyr-nudge'),
      ui.lyrOffset,
      btn('0.2s ▶', 'Lyrics are early: show them later', () => nudgeLyrics(LYRICS_NUDGE), 'lyr-nudge'),
      btn('Auto', 'Line the lyrics up again automatically', () => {
        L.offsetSet = false;
        L.offset = 0;
        L.autoPending = true;
        saveLyricsChoice();
        renderLyricsSync();
      }, 'lyr-nudge'));
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
      h('div', { class: 'lyr-head' }, ui.lyrInput, findBtn, ui.lyrNext, smaller, bigger, ui.lyrPlace, hide),
      ui.lyrMeta, ui.lyrSync, ui.lyrBody, grip);
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
          L.autoPending = !L.offsetSet && L.autoPending;
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
    add({ q: [guess.artist, guess.track].filter(Boolean).join(' ') });
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
      if (top && Math.max(C.similarity(guess.track, top.trackName), C.similarity(guess.artist, top.trackName)) >= 0.99) break;
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
    L.lines = lines && lines.length ? lines : null;
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
    ui.lyrBody.classList.toggle('synced', L.synced);
    const kids = [];
    if (L.lines) {
      L.lines.forEach((ln, k) => {
        const p = h('p', {}, L.synced ? h('span', { class: 'lyr-loop', title: 'Practise this line: 20 times from 30% to 100%, then 10 at 100% (tap again to stop)' }, icon('loop')) : null,
          h('span', { class: 'lyr-text', text: ln.text || '♪' }));
        if (L.synced) p.addEventListener('click', (e) => {
          // Left edge of a line (the ⟳ button): repeat just this line.
          const r = p.getBoundingClientRect();
          const onLoopBtn = e.target.closest && e.target.closest('.lyr-loop');
          const realPoint = e.clientX || e.clientY; // keyboard / scripted clicks have no position
          if (onLoopBtn || (realPoint && e.clientX - r.left < Math.min(72, r.width * 0.2))) {
            toggleLineLoop(k);
            return;
          }
          if (S.lineLoop) stopLineLoop(true);
          const at = Math.max(0, ln.t + L.offset);
          seek(at);
          L.userScrollAt = 0;
          if (S.loopOn && hasLoop() && (at < S.a || at >= effEnd())) {
            S.loopOn = false;
            flash('Loop paused because you jumped outside it. Press Loop to turn it back on.');
          }
          renderUI();
        });
        p.dataset.i = String(k);
        kids.push(p);
      });
    } else {
      for (const line of String(r.plainLyrics || '').split(/\r?\n/)) kids.push(h('p', { text: line || ' ' }));
    }
    stopLineLoop(true); // the lines changed
    ui.lyrBody.replaceChildren(...kids);
    ui.lyrBody.scrollTop = 0;
    if (save) saveLyricsChoice();
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

  function toggleLineLoop(k) {
    if (!L.lines || !L.lines[k]) return;
    if (S.lineLoop && S.lineLoop.idx === k) return stopLineLoop(false);
    const r = lineRange(k);
    // Remember the speed from before (a trainer keeps its place too) so it can
    // be put back exactly when the line practice ends.
    const saved = S.lineLoop ? S.lineLoop.saved : { rate: S.rate, rateOwned: S.rateOwned };
    S.lineLoop = { a: r.a, b: r.b, idx: k, rep: 1, saved };
    S.rate = C.trainerRate(LINE_START, 1, LINE_RAMP, 1);
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
    if (!S.lineLoop) return;
    restoreLineSpeed();
    S.lineLoop = null;
    markLoopingLine();
    S.dirty = true;
    if (!silent) {
      flash(S.loopOn && hasLoop() ? 'Line practice off. Back to your A–B loop.' : 'Line practice off. Playing on.');
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

  // All 20 plays done: stop on the line's start, speed back to what it was.
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
    seek(ll.a);
    flash(`Line practice done: ${LINE_RAMP + LINE_FULL} times, up to 100%. Press play to go on.`, 10000);
    S.dirty = true;
    renderUI();
  }

  function markLoopingLine() {
    if (!ui.lyrBody) return;
    const kids = ui.lyrBody.children;
    for (let k = 0; k < kids.length; k++) kids[k].classList.toggle('looping', !!S.lineLoop && S.lineLoop.idx === k);
  }

  function saveLyricsChoice() {
    const r = L.results[L.idx];
    if (!r || !S.vid) return;
    const slim = { id: r.id, trackName: r.trackName, artistName: r.artistName, duration: r.duration,
      syncedLyrics: r.syncedLyrics || '', plainLyrics: r.plainLyrics || '' };
    storage.set({ ['ytl:lyr:' + S.vid]: { r: slim, q: ui.lyrInput.value.trim(), offset: L.offset, offsetSet: L.offsetSet } });
  }

  function nudgeLyrics(delta) {
    L.offset = Math.round((L.offset + delta) * 10) / 10;
    if (S.lineLoop && !S.lineLoop.custom) Object.assign(S.lineLoop, lineRange(S.lineLoop.idx));
    L.offsetSet = true;
    L.autoPending = false;
    L.nowIdx = -2;
    saveLyricsChoice();
    renderLyricsSync();
  }

  function renderLyricsSync() {
    if (!ui.lyrSync) return;
    ui.lyrSync.hidden = !L.lines;
    const o = L.offset;
    const label = Math.abs(o) < 0.05 ? 'timing ±0' : `timing ${o > 0 ? '+' : '−'}${Math.abs(o).toFixed(1)}s`;
    ui.lyrOffset.textContent = L.autoPending ? 'lining up…' : L.offsetSet ? label : `${label} (auto)`;
    ui.lyrOffset.title = 'How much the lyrics are shifted to match this video';
  }

  // A cappella and other versions: line the first sung line up with the first
  // sound in the wave (singing starts where the a cappella stops being silent).
  function autoAlignLyrics() {
    if (!L.autoPending || !L.lines || L.offsetSet) return;
    const d = dur();
    if (!d || S.peaks.coverage(d) < 0.6) return; // wait for the wave
    const firstLine = L.lines.find((ln) => ln.text && ln.text.trim());
    const start = S.peaks.firstSound(d);
    L.autoPending = false;
    if (firstLine && start != null) {
      const off = Math.round((start - firstLine.t) * 10) / 10;
      if (Math.abs(off) <= 90) L.offset = off;
    }
    L.nowIdx = -2;
    saveLyricsChoice();
    renderLyricsSync();
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
    }, 1200);
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
    place: 'M4 4h16v6H4zm0 8h7v8H4zm9 0h7v8h-7z',
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
    ui.tReps = select(TRAINER_REPS, (v) => `${v} loops`, settings.trainerReps, trainerChoice('trainerReps'), 'How many loops to reach 100%');
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
    });
    ui.rescanBtn = btn('Read whole song now', 'Load the full waveform (plays muted at high speed for a few seconds)', () => startScan(), '', 'scan');
    ui.settingsRow = h('div', { class: 'row sub', hidden: true },
      h('span', { class: 'label', text: 'Pause between loops' }), ui.gapSel,
      h('label', { class: 'check', title: 'On: slowing down keeps the key (best for singing). Off: tape-style, pitch drops too (50% = one octave lower).' }, ui.pitchChk, 'Keep pitch when slowing down'),
      h('label', { class: 'check' }, ui.scanChk, 'Read the whole song automatically'),
      h('label', { class: 'check', title: 'Cleaner sound when slowed down (Signalsmith Stretch). Turn off if you ever hear a problem.' }, ui.hqChk, 'Studio-quality slow-down'),
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
      h('div', { class: 'group' }, ui.playBtn),
      h('div', { class: 'group' }, ui.aMark, ui.bMark),
      h('div', { class: 'group' }, ui.loopBtn, ui.undoBtn, ui.clearBtn));
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
          h('li', {}, h('b', { text: 'Move the song like a DJ: ' }), 'slide your finger on the wave and the song moves with it. A quick tap on the wave pauses / plays.'),
          h('li', {}, h('b', { text: 'Make a loop: ' }), `press A where the part starts: a ${TOUCH_LOOP_LEN}-second loop starts right away. Press B where it should end. The ‹ › buttons move A or B by ${TOUCH_NUDGE} second${TOUCH_NUDGE === 1 ? "" : "s"}; drag the green A / red B flags to fine-tune.`),
          h('li', {}, h('b', { text: 'Zoom: ' }), 'pinch the wave with two fingers, or press Zoom in / Whole song. Tap the small map under the wave to jump.'),
          h('li', {}, h('b', { text: 'Practise one line: ' }), 'tap ⟳ at the left of a lyric line: it plays 30 times (30% → 100% over 20, then 10 at 100%) and stops. Tap ⟳ again to stop early.'),
        ] : [
          h('li', {}, h('b', { text: 'Make a loop: ' }), 'click the wave where the part starts, then click where it ends. Or drag across it. It starts looping straight away.'),
          h('li', {}, h('b', { text: 'Fine-tune: ' }), 'drag the green A or red B flag. Use the ‹ › buttons to move them by 0.05s (Shift = 0.01s, Alt = 0.5s). Scroll on the wave to zoom in.'),
        ]),
        h('li', {}, h('b', { text: 'Slow down: ' }), 'press 30%, 50%, 75% or 100%, or use − / + for 5% steps. The key stays the same. While the Trainer runs, a slower speed steps it back so you get those loops again.'),
        h('li', {}, h('b', { text: 'Speed trainer: ' }), 'tap Trainer and it starts right away: slow (30%, 50% or 75%), a little faster every loop, up to 100% over 10–50 loops, then 10 times at 100% and it stops. Tap Trainer again to stop and go back to normal speed.'),
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
    ui.trainerBtn.title = S.trainer.running
      ? 'Stop the speed trainer (back to normal speed)'
      : 'Speed trainer: tap to start (slow, then faster every loop up to 100%); tap again to stop';
    ui.gearBtn.classList.toggle('on', !ui.settingsRow.hidden);

    // Trainer
    const tr = S.trainer;
    if (tr.running) {
      const total = tr.after > 0 ? tr.reps + tr.after - 1 : tr.reps;
      ui.tBar.style.width = `${Math.round((Math.min(tr.rep, total) / total) * 100)}%`;
      let label;
      if (tr.rep < tr.reps) label = `Speeding up: loop ${tr.rep} of ${tr.reps} at `;
      else if (tr.after > 0) label = `Full speed: ${tr.rep - tr.reps + 1} of ${tr.after} at `;
      else label = `Full speed: loop ${tr.rep - tr.reps + 1} at `;
      ui.tStat.replaceChildren(label, h('b', { text: `${Math.round(S.rate * 100)}%` }));
    } else {
      ui.tBar.style.width = '0%';
      const s = settings.trainerStart, g = TRAINER_GOAL, n = settings.trainerReps;
      const stepPct = n > 1 ? (g - s) / (n - 1) : 0;
      const a = TRAINER_AFTER;
      ui.tStat.textContent = `${s}% → ${g}% (+${Math.max(0, stepPct).toFixed(1)}% per loop)` +
        (a ? `, then ${a}× at ${g}% and stop` : '');
    }

    // Settings
    ui.rescanBtn.disabled = !!S.scan || !dur();

    // Hint line
    if (S.hintOverride && now() < S.hintUntil) {
      setHint([S.hintOverride]);
    } else if (S.lineLoop && L.lines && L.lines[S.lineLoop.idx]) {
      const ll = S.lineLoop;
      const stage = ll.rep <= LINE_RAMP ? `speeding up ${ll.rep}/${LINE_RAMP}` : `full speed ${ll.rep - LINE_RAMP}/${LINE_FULL}`;
      setHint([['Practising one line: '], `“${L.lines[ll.idx].text || '♪'}” · ${stage} at ${Math.round(S.rate * 100)}%. Tap ⟳ again to stop.`]);
    } else if (S.scan) {
      setHint(['Reading the whole song… it plays muted for a moment, then goes back to where you were.']);
    } else if (!dur()) {
      setHint(['Waiting for the video…']);
    } else if (pending) {
      setHint(TOUCH ? [['Now tap where the loop should END']] : [['Now click where the loop should END'], '  (Esc to cancel)']);
    } else if (hasLoop()) {
      const len = S.b - S.a;
      setHint([
        [S.loopOn ? 'Looping ' : 'Loop off: '],
        `${F(S.a)} → ${F(S.b)} (${len.toFixed(2)}s)`,
        TOUCH ? '. Press A or B again, or drag the flags. Pinch to zoom.' : '. Drag the A/B flags to adjust. Scroll to zoom.',
      ]);
    } else {
      setHint(TOUCH
        ? [['Tap the wave'], ' to pause / play, ', ['drag it'], ' to move the song. Press ', ['A'], ' to loop from here, ', ['B'], ' to set the end.']
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
  function focusFollow(force) {
    if (!settings.zoomFocus || !S.video || (drag && drag.mode !== 'scrub')) return;
    const d = dur();
    if (!d) return;
    const len = Math.min(focusLen(), d);
    if (len >= d) return;
    if (!force && now() - S.lastViewTouch < (TOUCH ? 600 : 2000)) return;
    const t = drag && drag.mode === 'scrub' && drag.t != null ? drag.t : S.video.currentTime;
    // Touch screens get a DJ deck: the playhead stays in the middle and the wave moves.
    if (!force && S.view && !TOUCH) {
      const { s, e } = viewRange();
      // While looping a part that fits on screen, hold still on it.
      if (S.loopOn && hasLoop() && S.a >= s && S.b <= e && S.b - S.a < len) return;
      if (S.video.paused && t >= s && t <= e) return;
    }
    const s0 = t - len * (TOUCH ? 0.5 : 0.25);
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
    const key = [W, H, s.toFixed(4), e.toFixed(4), S.peaks.version, S.peaks.n, g.miniH].join('|');
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
    for (let x = 0; x < W; x++) {
      const t0 = s + (x / W) * span;
      const t1 = s + ((x + 1) / W) * span;
      let b0 = Math.floor(t0 * br);
      let b1 = Math.max(b0 + 1, Math.floor(t1 * br));
      b1 = Math.min(b1, P.n);
      let pk = 0, lo = 0, mi = 0, hi = 0, c = 0;
      for (let b = b0; b < b1; b++) {
        if (!P.cov[b]) continue;
        if (P.peak[b] > pk) pk = P.peak[b];
        lo += P.low[b];
        mi += P.mid[b];
        hi += P.high[b];
        c++;
      }
      if (!c) {
        bctx.fillStyle = 'rgba(140,150,170,0.18)';
        bctx.fillRect(x, mid - dpr * 0.5, 1, dpr);
        dctx.fillStyle = 'rgba(140,150,170,0.12)';
        dctx.fillRect(x, mid - dpr * 0.5, 1, dpr);
        continue;
      }
      const v = Math.pow(pk * norm, 0.85);
      const hh = Math.max(dpr, v * amp);
      const [r, gg, bb] = C.bandColor(lo / c, mi / c, hi / c);
      bctx.fillStyle = `rgb(${r},${gg},${bb})`;
      bctx.fillRect(x, mid - hh, 1, hh * 2);
      dctx.fillStyle = `rgba(${r},${gg},${bb},0.62)`;
      dctx.fillRect(x, mid - hh, 1, hh * 2);
    }
    // Bright core line in the middle, like a DJ deck.
    bctx.fillStyle = 'rgba(255,255,255,0.10)';
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
    ctx.fillStyle = '#0b0e14';
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

    // Waveform: dim after the playhead, bright before it.
    ctx.drawImage(layers.dim, 0, top, g.w, wh);
    if (px > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, Math.min(g.w, px), wh);
      ctx.clip();
      ctx.drawImage(layers.bright, 0, top, g.w, wh);
      ctx.restore();
    }

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

    // Playhead
    if (px >= 0 && px <= g.w) {
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
        if (TOUCH && settings.zoomFocus) {
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
        } else if (hnd) {
          pushHistory();
          drag = { mode: 'handle', which: hnd };
        } else if (e.pointerType === 'touch') {
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
          setLoop(d.t0, timeAt(x, g), { play: true, fresh: true });
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
    } else if (drag.mode === 'handle') {
      let a = S.a;
      let b = S.b;
      if (drag.which === 'a') a = t;
      else b = t;
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
  function endScrub(sc, x, g) {
    const lifted = x != null && !!g; // finger lifted (not cancelled / pinch)
    if (sc.moved) {
      const t = lifted ? scrubTime(sc, x, g) : sc.t;
      if (t != null) seek(t);
    }
    const tap = lifted && !sc.moved && now() - sc.downAt < TAP_MS;
    if (tap) {
      if (!sc.wasPlaying) play(); // tap while stopped: play; tap while playing: stays paused
    } else if (sc.wasPlaying) {
      play();
    }
    S.dirty = true;
    renderUI();
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
      // Touch screens: lyrics on (at the top of the screen) unless turned off since.
      if (TOUCH && !settings.touchLyricsDefault) {
        settings.touchLyricsDefault = true;
        settings.lyrics = true;
        settings.height = 0; // use the new half-screen default
      }
      // New trainer choices (v2): start from 30% over 10 loops unless chosen since.
      if (settings.trainerV !== 3) {
        settings.trainerV = 3;
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

  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
}
