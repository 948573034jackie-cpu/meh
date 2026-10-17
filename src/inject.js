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

  /** Offset of the last Cluster in a chunk that starts with Clusters. -1 if none. */
  function webmLastCluster(u8) {
    let pos = 0;
    let last = -1;
    let guard = 0;
    while (pos < u8.length && guard++ < 10000) {
      const id = readId(u8, pos);
      if (!id || id.id !== CLUSTER_ID) break;
      last = pos;
      const size = readSize(u8, pos + id.len);
      if (!size || size.unknown) break;
      pos += id.len + size.len + size.value;
    }
    return last;
  }

  /**
   * Every complete Cluster in a chunk of media that starts with Clusters:
   * [{ time, end (seconds), bytes }]. end = the last block's time plus one
   * frame. The smallest pieces of audio with their own time, so pieces
   * fetched twice, or cut up differently, can be put back together.
   */
  function webmClusters(u8, tcScale) {
    const out = [];
    let pos = 0;
    let guard = 0;
    const sc = tcScale / 1e9;
    while (pos < u8.length && guard++ < 100000) {
      const id = readId(u8, pos);
      if (!id || id.id !== CLUSTER_ID) break;
      const size = readSize(u8, pos + id.len);
      if (!size || size.unknown) break;
      const dataStart = pos + id.len + size.len;
      const end = dataStart + size.value;
      if (end > u8.length) break; // cut off: not complete
      let time = null;
      const rel = [];
      let p = dataStart;
      let g = 0;
      while (p < end && g++ < 100000) {
        const cid = readId(u8, p);
        if (!cid) break;
        const cs = readSize(u8, p + cid.len);
        if (!cs || cs.unknown) break;
        const ds = p + cid.len + cs.len;
        if (cid.id === CLUSTER_TIMESTAMP_ID) time = readUint(u8, ds, cs.value);
        else if (cid.id === 0xa3 || cid.id === 0xa0) {
          // SimpleBlock, or a BlockGroup holding a Block
          let b = ds;
          if (cid.id === 0xa0) {
            const bid = readId(u8, ds);
            const bs = bid && readSize(u8, ds + bid.len);
            b = bid && bid.id === 0xa1 && bs ? ds + bid.len + bs.len : -1;
          }
          const tn = b >= 0 ? readSize(u8, b) : null;
          if (tn && b + tn.len + 2 <= u8.length) {
            let v = (u8[b + tn.len] << 8) | u8[b + tn.len + 1];
            if (v & 0x8000) v -= 0x10000;
            rel.push(v);
          }
        }
        p = ds + cs.value;
      }
      if (time !== null && rel.length) {
        // one frame after the last block (the usual gap between blocks)
        let frame = 20e6 / tcScale;
        if (rel.length > 1) {
          const d = [];
          for (let i = 1; i < rel.length; i++) d.push(rel[i] - rel[i - 1]);
          d.sort((x, y) => x - y);
          frame = d[d.length >> 1] || frame;
        }
        out.push({ time: time * sc, end: (time + Math.max(...rel) + frame) * sc, bytes: u8.subarray(pos, end) });
      }
      pos = end;
    }
    return out;
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
   * Returns { startBin, peak, low, mid, high, att, atv } (Uint8Arrays).
   * att / atv: the sharpest attack inside each bin, found in 1 ms frames, so
   * beats can be placed far finer than one 20 ms bin. att = 1 + its position
   * in the bin in 0.1 ms (0 = none), atv = how sharp it is.
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
    const att = new Uint8Array(count);
    const atv = new Uint8Array(count);
    // Extra bands to tell the drums apart: sub (< 100 Hz: the kick's boom),
    // low-mid (100 - 400 Hz: toms, the snare's body), air (> 5 kHz: hi-hats, cymbals).
    const sub = new Uint8Array(count);
    const lmid = new Uint8Array(count);
    const air = new Uint8Array(count);
    const lpS = biquad('lp', 100, sr);
    const lpT = biquad('lp', 400, sr);
    const hpA = biquad('hp', Math.min(5000, sr * 0.4), sr);
    let sx1 = 0, sx2 = 0, sy1 = 0, sy2 = 0;
    let tx1 = 0, tx2 = 0, ty1 = 0, ty2 = 0;
    let ax1 = 0, ax2 = 0, ay1 = 0, ay2 = 0;
    let ss = 0, st = 0, sa = 0;
    const lp = biquad('lp', 250, sr);
    const hp = biquad('hp', 2500, sr);
    let lx1 = 0, lx2 = 0, ly1 = 0, ly2 = 0;
    let hx1 = 0, hx2 = 0, hy1 = 0, hy2 = 0;
    const nch = channels.length;
    let bin = 0;
    let binEnd = Math.min(n, Math.round(((firstBin + 1) / BIN_RATE - start) * sr));
    let pk = 0, sl = 0, sm = 0, sh = 0, cnt = 0;
    // Attacks: a fast envelope of everything above the bass (clicks, snares,
    // hats) and a slower one of the bass (808s, kicks), compared frame by frame.
    const fs = Math.max(1, Math.round(sr / 1000));
    const relHi = Math.exp(-1 / (0.008 * sr));
    const relLo = Math.exp(-1 / (0.04 * sr));
    const warm = 3 * fs; // filters start cold: no attacks in the first 3 ms
    let eHi = 0, eLo = 0, pHi = 0, pLo = 0;
    const flush = () => {
      if (cnt > 0 && bin < count) {
        peak[bin] = Math.min(255, Math.round(pk * 255));
        low[bin] = Math.min(255, Math.round(Math.sqrt(Math.sqrt(sl / cnt)) * 300));
        mid[bin] = Math.min(255, Math.round(Math.sqrt(Math.sqrt(sm / cnt)) * 300));
        high[bin] = Math.min(255, Math.round(Math.sqrt(Math.sqrt(sh / cnt)) * 300));
        sub[bin] = Math.min(255, Math.round(Math.sqrt(Math.sqrt(ss / cnt)) * 300));
        lmid[bin] = Math.min(255, Math.round(Math.sqrt(Math.sqrt(st / cnt)) * 300));
        air[bin] = Math.min(255, Math.round(Math.sqrt(Math.sqrt(sa / cnt)) * 300));
      }
      pk = sl = sm = sh = cnt = 0;
      ss = st = sa = 0;
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
      const ys = lpS.b0 * x + lpS.b1 * sx1 + lpS.b2 * sx2 - lpS.a1 * sy1 - lpS.a2 * sy2;
      sx2 = sx1; sx1 = x; sy2 = sy1; sy1 = ys;
      const yt = lpT.b0 * x + lpT.b1 * tx1 + lpT.b2 * tx2 - lpT.a1 * ty1 - lpT.a2 * ty2;
      tx2 = tx1; tx1 = x; ty2 = ty1; ty1 = yt;
      const ya = hpA.b0 * x + hpA.b1 * ax1 + hpA.b2 * ax2 - hpA.a1 * ay1 - hpA.a2 * ay2;
      ax2 = ax1; ax1 = x; ay2 = ay1; ay1 = ya;
      ss += ys * ys;
      st += (yt - ys) * (yt - ys);
      sa += ya * ya;
      if (a > pk) pk = a;
      const ah = x - yl < 0 ? yl - x : x - yl;
      eHi = ah > eHi ? ah : eHi * relHi;
      const al = yl < 0 ? -yl : yl;
      eLo = al > eLo ? al : eLo * relLo;
      if ((i + 1) % fs === 0) {
        if (i >= warm) {
          const o = Math.max(0, Math.log((eHi + 2e-3) / (pHi + 2e-3))) + Math.max(0, Math.log((eLo + 2e-3) / (pLo + 2e-3)));
          const tMid = start + (i + 1 - fs / 2) / sr;
          const b = Math.floor(tMid * BIN_RATE) - firstBin;
          const v = Math.min(255, Math.round(o * 40));
          if (b >= 0 && b < count && v > atv[b]) {
            atv[b] = v;
            att[b] = 1 + Math.min(199, Math.max(0, Math.round((tMid * BIN_RATE - (b + firstBin)) * 200)));
          }
        }
        pHi = eHi;
        pLo = eLo;
      }
      sl += yl * yl;
      sm += ym * ym;
      sh += yh * yh;
      cnt++;
    }
    flush();
    return { startBin: firstBin, peak, low, mid, high, att, atv, sub, lmid, air };
  }

  // Test hook (only used by the Node unit tests, never set on YouTube).
  if (G.__YTL_TEST__) {
    G.__YTL_TEST__.parsers = {
      readId, readSize, webmFindCluster, webmTimecodeScale, webmClusterTime,
      boxes, mp4FindMediaStart, mp4InitMeta, mp4Fragments, toAdts, computePeaks, BIN_RATE, webmClusters,
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
      st,
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
    let skip = 0; // seconds of run-up at the start of the decoded audio
    if (job.container === 'webm') {
      // Opus needs a run-up: a chunk decoded on its own comes out wrong (too
      // loud) for its first moments. When this chunk follows the last one,
      // decode the end of the last one in front of it and drop that part.
      const st = job.st;
      const pre = st && st.tail && st.tail.vid === job.vid && Math.abs(st.tail.end - job.start) < 0.1 && job.start > st.tail.start ? st.tail : null;
      if (pre) {
        try {
          buf = await decode(concat([job.init, pre.bytes, job.media]));
          skip = job.start - pre.start;
        } catch (e) {
          buf = null;
        }
      }
      if (!buf) {
        skip = 0;
        buf = await decode(concat([job.init, job.media]));
      }
      if (st && buf) {
        const last = webmLastCluster(job.media);
        const first = webmClusterTime(job.media, st.tcScale);
        const lastT = last >= 0 ? webmClusterTime(job.media.subarray(last), st.tcScale) : null;
        if (last >= 0 && first !== null && lastT !== null) {
          st.tail = { vid: job.vid, bytes: job.media.subarray(last), start: job.start + (lastT - first), end: job.start + Math.max(0, buf.duration - skip) };
        }
      }
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
    keepChunk(job, Math.max(0, buf.duration - skip));
    const chans = [];
    const from = Math.max(0, Math.min(buf.length, Math.round(skip * buf.sampleRate)));
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(buf.getChannelData(c).subarray(from));
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
      att: res.att,
      atv: res.atv,
      sub: res.sub,
      lmid: res.lmid,
      air: res.air,
    });
  }

  // ---------------------------------------------------------------------------
  // Seamless loops: the audio of the loop, decoded at full quality, so the
  // looper can play it from memory with no gap at all between B and A.
  // The audio chunks of the current video are kept (a few MB per song).
  // ---------------------------------------------------------------------------
  // Per video: the audio as Clusters (WebM), each kept once by its time, in
  // groups by header (a new quality is a new group); MP4 as whole chunks.
  const kept = new Map(); // vid -> { groups: [{ key, init, tc, clusters: Map(ms -> {time, end, bytes}) }], mp4: [chunk] }
  let keptBytes = 0;
  const KEEP_MAX = 96 * 1024 * 1024;

  // A short fingerprint of a header, so the same header sent again counts as the same.
  function bytesKey(u8) {
    let h = 2166136261;
    for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 16777619);
    return `${u8.length}:${h >>> 0}`;
  }

  function keepChunk(job, durSec) {
    if (!job.vid || !durSec) return;
    let k = kept.get(job.vid);
    if (!k) {
      // Only the newest video's audio is kept.
      kept.clear();
      keptBytes = 0;
      k = { groups: [], mp4: [] };
      kept.set(job.vid, k);
    }
    if (job.container === 'webm') {
      const tc = (job.st && job.st.tcScale) || 1e6;
      const cl = webmClusters(job.media, tc);
      if (!cl.length) return;
      const shift = job.start - cl[0].time; // the SourceBuffer's timestampOffset
      const key = bytesKey(job.init);
      let g = k.groups.find((x) => x.key === key);
      if (!g) {
        g = { key, init: job.init, tc, clusters: new Map() };
        k.groups.push(g);
      }
      for (const c of cl) {
        const time = c.time + shift;
        const id = Math.round(time * 1000);
        const old = g.clusters.get(id);
        if (old && old.bytes.length >= c.bytes.length) continue;
        if (keptBytes + c.bytes.length - (old ? old.bytes.length : 0) > KEEP_MAX) return;
        keptBytes += c.bytes.length - (old ? old.bytes.length : 0);
        g.clusters.set(id, { time, end: c.end + shift, bytes: c.bytes.slice() });
      }
      g.sorted = null;
      return;
    }
    const list = k.mp4;
    const end = job.start + durSec;
    const key = bytesKey(job.init);
    // The same chunk decoded again (it grew): keep the bigger one.
    const i = list.findIndex((c) => Math.abs(c.start - job.start) < 0.02 && c.key === key);
    if (i >= 0) {
      if (list[i].media.length >= job.media.length) return;
      keptBytes -= list[i].media.length;
      list.splice(i, 1);
    }
    if (keptBytes + job.media.length > KEEP_MAX) return;
    list.push({ start: job.start, end, media: job.media, init: job.init, key, container: job.container, mp4: job.mp4 });
    keptBytes += job.media.length;
    list.sort((a, b) => a.start - b.start);
  }

  function sortedClusters(g) {
    if (!g.sorted) g.sorted = [...g.clusters.values()].sort((a, b) => a.time - b.time);
    return g.sorted;
  }

  /**
   * The audio covering [a, b] as one piece to decode: { init, media, start,
   * container, mp4 } (with one piece before it as an Opus run-up), or null.
   */
  function chunksFor(vid, a, b) {
    const k = kept.get(vid);
    if (!k) return null;
    for (const g of k.groups) {
      const L = sortedClusters(g);
      let i = -1;
      for (let j = 0; j < L.length; j++) if (L[j].time <= a + 0.001 && L[j].end > a + 0.001) i = j;
      if (i < 0) continue;
      const touch = (x, y) => Math.abs(y.time - x.end) < 0.08;
      if (i > 0 && touch(L[i - 1], L[i])) i--; // run-up
      const out = [L[i]];
      let ok = true;
      while (out[out.length - 1].end < b - 0.001) {
        const prev = out[out.length - 1];
        const next = L[L.indexOf(prev) + 1];
        if (!next || !touch(prev, next)) {
          ok = false;
          break;
        }
        out.push(next);
      }
      if (ok) return { init: g.init, media: concat(out.map((c) => c.bytes)), start: out[0].time, container: 'webm' };
    }
    const list = k.mp4;
    let i = list.findIndex((c) => c.end > a + 0.001 && c.start <= a + 0.001);
    if (i < 0) return null;
    if (i > 0 && Math.abs(list[i - 1].end - list[i].start) < 0.1 && list[i - 1].key === list[i].key) i--; // run-up
    const out = [list[i]];
    while (out[out.length - 1].end < b - 0.001) {
      const prev = out[out.length - 1];
      const next = list.find((c) => c.key === prev.key && c.start > prev.start + 0.01 && c.start <= prev.end + 0.1 && c.end > prev.end);
      if (!next || Math.abs(next.start - prev.end) > 0.1) return null;
      out.push(next);
    }
    return { init: out[0].init, media: concat(out.map((c) => c.media)), start: out[0].start, container: 'mp4', mp4: out[0].mp4 };
  }

  let fullCtx = null;
  async function loopAudio(req) {
    const reply = (extra) => post({ type: 'loopAudio', id: req.id, vid: req.vid, ...extra });
    try {
      const sr = req.sr > 0 ? req.sr : 48000;
      const piece = chunksFor(req.vid, req.a, req.b);
      if (!piece) return reply({ ok: false, why: 'not loaded' });
      const media = piece.media;
      if (!fullCtx || fullCtx.sampleRate !== sr) {
        const Ctor = G.OfflineAudioContext || G.webkitOfflineAudioContext;
        fullCtx = new Ctor(2, 1, sr);
      }
      const dec = (bytes) => new Promise((resolve, reject) => {
        const p = fullCtx.decodeAudioData(bytes.buffer, resolve, reject);
        if (p && p.catch) p.catch(reject);
      });
      let buf = null;
      if (piece.container === 'mp4' && piece.mp4 && piece.mp4.asc) {
        try {
          const frags = mp4Fragments(media, piece.mp4.timescale);
          if (frags) buf = await dec(toAdts(frags.samples, piece.mp4.asc));
        } catch (e) {
          buf = null;
        }
      }
      if (!buf) buf = await dec(concat([piece.init, media]));
      const from = Math.round((req.a - piece.start) * buf.sampleRate);
      const to = Math.round((req.b - piece.start) * buf.sampleRate);
      if (from < 0 || to > buf.length || to - from < buf.sampleRate * 0.2) return reply({ ok: false, why: 'short' });
      const ch0 = buf.getChannelData(0).slice(from, to);
      const ch1 = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice(from, to);
      reply({ ok: true, sr: buf.sampleRate, a: req.a, b: req.b, ch0, ch1 });
    } catch (e) {
      reply({ ok: false, why: String((e && e.message) || e) });
    }
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

  // ---------------------------------------------------------------------------
  // Download the song's audio (for practice): the whole song or the loop as
  // WAV (plays everywhere), or the whole song as the original file. Made from
  // the audio this page already received, so the whole song must have been
  // read once.
  // ---------------------------------------------------------------------------
  function wavFile(buf, from, to) {
    const ch = Math.min(2, buf.numberOfChannels);
    const n = Math.max(0, to - from);
    const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF');
    out.setUint32(4, 36 + n * ch * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, ch, true);
    out.setUint32(24, buf.sampleRate, true);
    out.setUint32(28, buf.sampleRate * ch * 2, true);
    out.setUint16(32, ch * 2, true);
    out.setUint16(34, 16, true);
    str(36, 'data');
    out.setUint32(40, n * ch * 2, true);
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    let o = 44;
    for (let i = from; i < to; i++) {
      for (let c = 0; c < ch; c++) {
        const v = Math.max(-1, Math.min(1, data[c][i]));
        out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  // The parts of [a, b] whose audio this page has not received (yet).
  function missingAudio(vid, a, b) {
    const k = kept.get(vid);
    const have = [];
    if (k) {
      for (const g of k.groups) for (const c of sortedClusters(g)) have.push([c.time, c.end]);
      for (const c of k.mp4) have.push([c.start, c.end]);
    }
    have.sort((x, y) => x[0] - y[0]);
    const out = [];
    let t = a;
    for (const [s0, e0] of have) {
      if (e0 <= t + 0.05) continue;
      if (s0 > t + 0.1) out.push([t, Math.min(b, s0)]);
      t = Math.max(t, e0);
      if (t >= b) break;
    }
    if (t < b - 0.1) out.push([t, b]);
    return out.filter(([x, y]) => y - x > 0.05);
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function download(req) {
    const reply = (extra) => post({ type: 'download', id: req.id, vid: req.vid, ...extra });
    try {
      const end = req.what === 'loop' ? req.b : Math.max(0.5, req.duration - 0.6);
      const start = req.what === 'loop' ? req.a : 0;
      // (the first piece of audio starts a hair after 0)
      const piece = chunksFor(req.vid, req.what === 'loop' ? Math.max(0, start) : 0.05, end);
      if (!piece) return reply({ ok: false, why: 'not loaded', missing: missingAudio(req.vid, Math.max(0, start), end) });
      const base = (req.name || 'audio').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'audio';
      if (req.fmt === 'orig') {
        // the whole song, as it came (no decoding, no loss)
        const ext = piece.container === 'mp4' ? 'm4a' : 'webm';
        saveBlob(new Blob([piece.init, piece.media], { type: piece.container === 'mp4' ? 'audio/mp4' : 'audio/webm' }), `${base}.${ext}`);
        return reply({ ok: true, name: `${base}.${ext}` });
      }
      const Ctor = G.OfflineAudioContext || G.webkitOfflineAudioContext;
      const ctx = new Ctor(2, 1, 48000);
      const bytes = concat([piece.init, piece.media]);
      let buf = null;
      if (piece.container === 'mp4' && piece.mp4 && piece.mp4.asc) {
        try {
          const frags = mp4Fragments(piece.media, piece.mp4.timescale);
          if (frags) buf = await ctx.decodeAudioData(toAdts(frags.samples, piece.mp4.asc).buffer);
        } catch (e) {
          buf = null;
        }
      }
      if (!buf) buf = await ctx.decodeAudioData(bytes.buffer);
      const sr = buf.sampleRate;
      const from = req.what === 'loop' ? Math.max(0, Math.round((start - piece.start) * sr)) : 0;
      const to = req.what === 'loop' ? Math.min(buf.length, Math.round((end - piece.start) * sr)) : buf.length;
      const name = req.what === 'loop' ? `${base} (loop ${req.label || ''}).wav`.replace(' ()', '') : `${base}.wav`;
      saveBlob(wavFile(buf, from, to), name);
      reply({ ok: true, name, seconds: (to - from) / sr });
    } catch (e) {
      reply({ ok: false, why: String((e && e.message) || e) });
    }
  }

  G.addEventListener('message', (e) => {
    if (e.source !== G || !e.data || e.data[TAG] !== 'cs') return;
    if (e.data.type === 'hello') postVideoInfo(true);
    else if (e.data.type === 'loopAudio') loopAudio(e.data);
    else if (e.data.type === 'download') download(e.data);
  });
  document.addEventListener('yt-navigate-finish', () => postVideoInfo(false), true);
  setInterval(() => postVideoInfo(false), 700);
})();
