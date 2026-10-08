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
