// ==UserScript==
// @name         DJ Wave Looper for YouTube
// @namespace    https://github.com/948573034jackie-cpu/meh
// @version      1.1.0
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
    const info = { type: 'video', vid: vid || null, ad: isAd(), hasVideo: !!v };
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

  const api = {
    SPEED_MIN, SPEED_MAX, END_GUARD, MIN_LOOP,
    clamp, roundRate, formatTime, trainerRate, loopEnd, normalizeLoop,
    PeakStore, bandColor, bytesToBase64, base64ToBytes,
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
.wave-wrap { position: relative; flex: none; height: 140px; }
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
.collapsed .wave-wrap, .collapsed .sub, .collapsed .status { display: none; }
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
  .row { gap: 6px 7px; }
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
}
`;

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
  const SPEED_PRESETS = [0.5, 0.75, 1];
  const TRAINER_STARTS = [30, 40, 50, 60, 70, 80, 90];
  const TRAINER_GOALS = [70, 80, 90, 100, 110, 120];
  const TRAINER_REPS = [15, 30, 50];
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
    trainerStart: 50,
    trainerGoal: 100,
    trainerReps: 15,
    seenHelp: false,
    zoomFocus: false, // "Zoom in": the wave follows the playhead in a short window
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
      if (v.preservesPitch !== settings.keepPitch) v.preservesPitch = settings.keepPitch;
      if ('webkitPreservesPitch' in v && v.webkitPreservesPitch !== settings.keepPitch) v.webkitPreservesPitch = settings.keepPitch;
      if (Math.abs(v.playbackRate - S.rate) > 0.001) v.playbackRate = S.rate;
    } catch (e) {
      /* ignore */
    }
  }

  function setRate(r, fromTrainer) {
    S.rate = C.roundRate(r);
    S.rateOwned = true;
    if (!fromTrainer && S.trainer.running) {
      stopTrainer();
      flash('Speed trainer stopped because you picked a speed.');
    }
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

  function loopActive() {
    return settings.open && S.loopOn && hasLoop() && !!S.video && !S.scan && !isAd();
  }

  function effEnd() {
    return C.loopEnd(S.b, dur());
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
    if (t >= end - 0.004 && t > S.a) {
      wrap();
      return;
    }
    // Fire a precise timer just before B instead of waiting for the next frame.
    const remain = (end - t) / Math.max(0.05, v.playbackRate);
    if (remain > 0 && remain < 0.12 && !S.wrapTimer) {
      S.wrapTimer = setTimeout(() => {
        S.wrapTimer = 0;
        if (loopActive() && !S.wrapping && !v.paused && v.currentTime >= effEnd() - 0.03 && v.currentTime > S.a) wrap();
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
    if (S.trainer.running) {
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
      seek(S.a);
      clearTimeout(S.gapTimer);
      S.gapTimer = setTimeout(() => {
        S.wrapping = false;
        if (S.video === v) play();
      }, gap * 1000);
    } else {
      seek(S.a);
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

  function onPlay() {
    if (S.wrapping) {
      // The user pressed play during the breath pause: just go.
      clearTimeout(S.gapTimer);
      S.wrapping = false;
    }
    applyRate();
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
    if (S.b != null && t < S.b - C.MIN_LOOP) setLoop(t, S.b, { noSeek: true });
    else {
      S.pendingA = t;
      S.dirty = true;
      renderUI();
    }
  }

  function markB() {
    const t = nowTime();
    const a = S.pendingA != null ? S.pendingA : S.a;
    if (a == null) return flash('Set the start first: press [ or click the A button.');
    setLoop(a, t, { fresh: S.pendingA != null });
  }

  function nudge(which, delta) {
    if (!hasLoop()) return;
    const a = which === 'a' ? S.a + delta : S.a;
    const b = which === 'b' ? S.b + delta : S.b;
    if (b - a < C.MIN_LOOP) return;
    setLoop(a, b, { noSeek: which === 'b' });
    if (which === 'a' && S.video && S.loopOn) seek(S.a); // hear the new start right away
  }

  // ---------------------------------------------------------------------------
  // Auto speed-up trainer
  // ---------------------------------------------------------------------------
  function startTrainer() {
    if (!S.video || !dur()) return flash('Start a video first.');
    if (!hasLoop()) {
      // No loop yet: practise the whole song.
      S.a = 0;
      S.b = dur();
      S.pendingA = null;
    }
    const tr = S.trainer;
    tr.start = settings.trainerStart / 100;
    tr.goal = settings.trainerGoal / 100;
    tr.reps = settings.trainerReps;
    tr.after = TRAINER_AFTER;
    tr.rep = 1;
    tr.done = false;
    tr.running = true;
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

  function stopTrainer(silent) {
    if (!S.trainer.running) return;
    S.trainer.running = false;
    if (!silent) renderUI();
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
    return h('button', { class: cls, title, 'aria-label': title, onclick }, iconName ? icon(iconName) : null, label || null);
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
    for (const ev of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'wheel', 'touchstart']) {
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
      btn(null, 'Move start earlier (Shift = fine, Alt = big)', (e) => nudge('a', -step(e)), 'icon', 'left'),
      ui.aTime,
      btn(null, 'Move start later (Shift = fine, Alt = big)', (e) => nudge('a', step(e)), 'icon', 'right'));
    ui.bMark = h('div', { class: 'mark b' },
      btn('B', 'Set loop END at the current time  ]', markB, 'set'),
      btn(null, 'Move end earlier (Shift = fine, Alt = big)', (e) => nudge('b', -step(e)), 'icon', 'left'),
      ui.bTime,
      btn(null, 'Move end later (Shift = fine, Alt = big)', (e) => nudge('b', step(e)), 'icon', 'right'));
    ui.loopBtn = btn('Loop', 'Loop on/off  \\', toggleLoop, '', 'loop');
    ui.clearBtn = btn(null, 'Clear the loop', clearLoop, 'icon danger', 'close');
    ui.undoBtn = btn(null, 'Undo the last loop change', undo, 'icon hide-phone', 'undo');

    ui.speedBtns = SPEED_PRESETS.map((r) =>
      btn(`${Math.round(r * 100)}%`, `Play at ${Math.round(r * 100)}% speed`, () => setRate(r), 'speed'));
    ui.rate = h('span', { class: 'rate', title: 'Current speed (click for 100%)', text: '100%' });
    ui.rate.addEventListener('click', () => setRate(1));
    const slower = btn(null, 'Slower by 5%', () => setRate(Math.round((S.rate - 0.05) * 100) / 100), 'icon hide-phone', 'minus');
    const faster = btn(null, 'Faster by 5%', () => setRate(Math.round((S.rate + 0.05) * 100) / 100), 'icon hide-phone', 'plus');
    ui.trainerBtn = btn('Trainer', 'Auto speed-up: start slow and reach full speed over N loops', () => toggleSub('trainer'), '', 'bolt');

    ui.zoomLoopBtn = btn(null, 'Zoom to the loop', zoomToLoop, 'icon hide-phone', 'zoom');
    ui.zoomBtn = btn('Zoom in', ZOOM_IN_TITLE, toggleZoom, 'zoom-toggle', 'zoom');
    ui.biggerBtn = btn(null, 'Make the wave bigger (or drag the top edge of the panel)', () => resizeWave(Math.round(window.innerHeight * 0.1)), 'icon', 'taller');
    ui.smallerBtn = btn(null, 'Make the wave smaller', () => resizeWave(-Math.round(window.innerHeight * 0.1)), 'icon', 'shorter');
    ui.gearBtn = btn(null, 'Settings', () => toggleSub('settings'), 'icon', 'gear');
    ui.helpBtn = btn(null, 'How to use', () => toggleHelp(), 'icon', 'help');
    ui.collapseBtn = btn(null, 'Minimise', toggleCollapse, 'icon hide-phone', 'down');
    const closeBtn = btn(null, 'Close the looper (turns loop and speed off)', closePanel, 'icon', 'close');

    const bar = h('div', { class: 'row bar' },
      h('div', { class: 'brand', title: 'DJ Wave Looper' }, icon('wave'), h('span', { class: 'brand-name', text: 'Wave Looper' })),
      h('div', { class: 'group' }, ui.aMark, ui.bMark),
      h('div', { class: 'group' }, ui.loopBtn, ui.undoBtn, ui.clearBtn),
      h('div', { class: 'sep' }),
      h('div', { class: 'group' }, h('span', { class: 'label hide-narrow', text: 'Speed' }), ...ui.speedBtns, slower, ui.rate, faster),
      h('div', { class: 'sep' }),
      ui.trainerBtn,
      h('div', { class: 'spacer' }),
      h('div', { class: 'group size-btns' }, ui.smallerBtn, ui.biggerBtn),
      ui.zoomBtn,
      h('div', { class: 'group' }, ui.zoomLoopBtn, ui.gearBtn, ui.helpBtn, ui.collapseBtn, closeBtn));

    // --- trainer row ---
    const pct = (v) => `${v}%`;
    ui.tStart = select(TRAINER_STARTS, pct, settings.trainerStart, (v) => { settings.trainerStart = v; saveSettings(); renderUI(); }, 'Starting speed');
    ui.tGoal = select(TRAINER_GOALS, pct, settings.trainerGoal, (v) => { settings.trainerGoal = v; saveSettings(); renderUI(); }, 'Goal speed');
    ui.tReps = select(TRAINER_REPS, (v) => `${v} loops`, settings.trainerReps, (v) => { settings.trainerReps = v; saveSettings(); renderUI(); }, 'How many loops to reach the goal');
    ui.tGo = btn('Start', 'Start the speed trainer', () => (S.trainer.running ? stopTrainer() : startTrainer()), 'primary', 'play');
    ui.tBar = h('i');
    ui.tStat = h('span', { class: 'tstat' });
    ui.trainerRow = h('div', { class: 'row sub', hidden: true },
      h('span', { class: 'label hide-phone', text: 'Auto speed-up' }),
      h('span', { class: 'label', text: 'from' }), ui.tStart,
      h('span', { class: 'label', text: 'to' }), ui.tGoal,
      h('span', { class: 'label', text: 'over' }), ui.tReps,
      ui.tGo,
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
    ui.rescanBtn = btn('Read whole song now', 'Load the full waveform (plays muted at high speed for a few seconds)', () => startScan(), '', 'scan');
    ui.settingsRow = h('div', { class: 'row sub', hidden: true },
      h('span', { class: 'label', text: 'Pause between loops' }), ui.gapSel,
      h('label', { class: 'check', title: 'On: slowing down keeps the key (best for singing). Off: tape-style, pitch drops too (50% = one octave lower).' }, ui.pitchChk, 'Keep pitch when slowing down'),
      h('label', { class: 'check' }, ui.scanChk, 'Read the whole song automatically'),
      ui.rescanBtn);

    // --- waveform ---
    ui.canvas = h('canvas');
    ui.tip = h('div', { class: 'tip', hidden: true });
    ui.scanText = h('span');
    ui.scanBtn = btn('Read whole song', 'Load the full waveform', () => startScan(), 'primary', 'scan');
    ui.cancelBtn = btn('Cancel', 'Stop reading the song', () => endScan('cancel'));
    ui.overlay = h('div', { class: 'overlay', hidden: true }, ui.scanText, ui.scanBtn, ui.cancelBtn);
    ui.waveWrap = h('div', { class: 'wave-wrap' }, ui.canvas, ui.tip, ui.overlay);

    // --- status ---
    ui.hint = h('div', { class: 'hint' });
    ui.chips = h('div', { class: 'chips' });
    ui.count = h('div', { class: 'count' });
    const status = h('div', { class: 'status' }, ui.hint, ui.chips, ui.count);

    ui.help = buildHelp();
    const resize = h('div', { class: 'resize', title: 'Drag up or down to make the wave bigger or smaller' });
    ui.panel = h('div', { class: 'panel' }, resize, bar, ui.trainerRow, ui.settingsRow, ui.waveWrap, status, ui.help);
    shadow.appendChild(ui.panel);

    setupResize(resize);
    setupCanvas();
    (document.body || document.documentElement).appendChild(hostEl);
    new ResizeObserver(() => (S.dirty = true)).observe(ui.waveWrap);
    new ResizeObserver(updateBodyPad).observe(hostEl);
  }

  function step(e) {
    return e && e.shiftKey ? 0.01 : e && e.altKey ? 0.5 : 0.05;
  }

  function buildHelp() {
    const k = (t) => h('kbd', { text: t });
    return h('div', { class: 'help', hidden: true },
      btn(null, 'Close help', () => toggleHelp(false), 'icon close', 'close'),
      h('h3', { text: 'How to use Wave Looper' }),
      h('ol', {},
        h('li', {}, h('b', { text: 'Make a loop: ' }), 'click the wave where the part starts, then click where it ends. Or drag across it. It starts looping straight away.'),
        h('li', {}, h('b', { text: 'Fine-tune: ' }), 'drag the green A or red B flag. Use the ‹ › buttons to move them by 0.05s (Shift = 0.01s, Alt = 0.5s). Scroll on the wave to zoom in.'),
        h('li', {}, h('b', { text: 'Slow down: ' }), 'press 50%, 75% or 100%, or use − / + for 5% steps. The key stays the same.'),
        h('li', {}, h('b', { text: 'Speed trainer: ' }), 'pick a start speed (e.g. 50%), a goal (100%), how many loops to get there (15, 30 or 50), and Every loop gets a little faster. At full speed it plays 10 more times, then stops by itself.'),
        h('li', {}, h('b', { text: 'Jump around: ' }), 'click the time ruler at the top of the wave.'),
        h('li', {}, h('b', { text: 'Bigger wave: ' }), 'press the ↕ buttons, or drag the top edge of the panel up.')),
      h('ul', {},
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
    const def = Math.round(window.innerHeight * (window.innerWidth < 600 || window.innerHeight < 900 ? 0.22 : 0.3));
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
    ui.waveWrap.style.height = waveHeight() + 'px';
    hostEl.style.bottom = bottomOffset() + 'px';
    ui.collapseBtn.replaceChildren(icon(settings.collapsed ? 'up' : 'down'));
    ui.collapseBtn.title = settings.collapsed ? 'Expand' : 'Minimise';
    updateBodyPad();
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
    ui.trainerBtn.classList.toggle('on', !ui.trainerRow.hidden || S.trainer.running);
    ui.gearBtn.classList.toggle('on', !ui.settingsRow.hidden);

    // Trainer
    const tr = S.trainer;
    ui.tGo.replaceChildren(icon(tr.running ? 'stop' : 'play'), tr.running ? 'Stop' : 'Start');
    ui.tGo.title = tr.running ? 'Stop the speed trainer' : 'Start the speed trainer';
    for (const s of [ui.tStart, ui.tGoal, ui.tReps]) s.disabled = tr.running;
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
      const s = settings.trainerStart, g = settings.trainerGoal, n = settings.trainerReps;
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
        TOUCH ? '. Drag the A/B flags to adjust. Pinch to zoom.' : '. Drag the A/B flags to adjust. Scroll to zoom.',
      ]);
    } else {
      setHint(TOUCH
        ? [['Tap the wave at the loop START'], ', then tap the END. Tap the time ruler to jump.']
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
    if (!settings.zoomFocus || !S.video || drag) return;
    const d = dur();
    if (!d) return;
    const len = Math.min(focusLen(), d);
    if (len >= d) return;
    if (!force && now() - S.lastViewTouch < 2000) return;
    const t = S.video.currentTime;
    if (!force && S.view) {
      const { s, e } = viewRange();
      // While looping a part that fits on screen, hold still on it.
      if (S.loopOn && hasLoop() && S.a >= s && S.b <= e && S.b - S.a < len) return;
      if (S.video.paused && t >= s && t <= e) return;
    }
    const s0 = t - len * 0.25;
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
    const t = v ? v.currentTime : 0;
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
        drag = { mode: 'mini' };
        panMiniTo(x, g);
      } else {
        const hnd = handleAt(x, g, e.pointerType === 'touch');
        if (hnd) {
          pushHistory();
          drag = { mode: 'handle', which: hnd };
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
      if (d.mode === 'select') {
        if (d.moved) {
          setLoop(d.t0, timeAt(x, g), { play: true, fresh: true });
        } else {
          waveClick(d.t0);
        }
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

  function handleAt(x, g, touch) {
    if (!hasLoop() || S.pendingA != null) return null;
    const da = Math.abs(x - xAt(S.a, g));
    const db = Math.abs(x - xAt(S.b, g));
    if (Math.min(da, db) > (touch ? 22 : HANDLE_PX)) return null;
    return da <= db ? 'a' : 'b';
  }

  function onDragMove(e, g, x) {
    const t = timeAt(x, g);
    if (drag.mode === 'seek') {
      userSeek(t);
    } else if (drag.mode === 'mini') {
      panMiniTo(x, g);
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
      // Older versions had other loop counts: snap to the closest one we offer.
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
