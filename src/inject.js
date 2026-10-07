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
