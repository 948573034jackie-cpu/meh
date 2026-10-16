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

  const REMASTER = /\b(\d{4}\s+)?(digital(ly)?\s+)?remaster(ed)?(\s+(version|edition|\d{4}))*\b|\b\d{4}\s+(version|mix)\b/gi;

  function cleanPart(x) {
    return String(x || '')
      .replace(REMASTER, ' ')
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
  const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

  function parseSongTitle(title, author) {
    const raw = String(title || '');
    // East-Asian style: the song name is in 《》『』「」 (or a 【】 that is
    // not just "Official MV"): 周杰倫【告白氣球】, 鄧紫棋《光年之外》.
    const quoted = raw.match(/[《『「]([^》』」]+)[》』」]/) || raw.match(/【([^】]+)】/);
    if (quoted && cleanPart(quoted[1]) && !/\s[-–—]\s/.test(raw.replace(quoted[0], ' '))) {
      const track = cleanPart(quoted[1]);
      const artist = cleanPart(raw.replace(quoted[0], ' ').replace(/[(\[{【《『「][^)\]}】》』」]*[)\]}】》』」]/g, ' ')) ||
        cleanAuthor(author);
      return withAlt({ artist, track });
    }
    let t = raw.replace(/[(\[{【「《『][^)\]}】」》』]*[)\]}】」》』]/g, ' '); // (Official Video), [Lyrics], 【MV】...
    const bars = t.split(/\s*[|｜]\s*|\s\/\/\s/).map((x) => x.trim()).filter(Boolean);
    t = bars[0] || t;
    // K-pop style: BTS 'Dynamite' Official MV
    const q = !/\s[-–—]\s/.test(t) && t.match(/^(.+?)\s+['‘’"“”]([^'‘’"“”]+)['‘’"“”]/);
    if (q && cleanPart(q[1]) && cleanPart(q[2])) return withAlt({ artist: cleanPart(q[1]), track: cleanPart(q[2]) });
    t = t.replace(/\s(ft\.?|feat\.?|featuring)\s[^-–—]*/i, ' ');
    let artist = '';
    let track = '';
    const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/) || t.match(/^(.+?)\s*[-–—:]\s+(.+)$/);
    if (m) {
      artist = cleanPart(m[1]);
      track = cleanPart(m[2]);
    } else {
      track = cleanPart(t);
      // "Song | Artist | Lyrics"
      if (bars.length > 1 && cleanPart(bars[1])) artist = cleanPart(bars[1]);
    }
    if (!artist && author) artist = cleanAuthor(author);
    if (!track) track = cleanPart(title);
    return withAlt({ artist, track });
  }

  function cleanAuthor(author) {
    return cleanPart(String(author || '').replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').replace(/\b(official|music|records|channel)\b/gi, ' '));
  }

  // "告白氣球 Love Confession": also try just the Chinese/Japanese/Korean part
  // (and just the Latin part), since the lyrics database uses one name.
  function withAlt(g) {
    const split = (x) => {
      if (!CJK.test(x) || !/[A-Za-z]{2}/.test(x)) return null;
      const asian = x.split(/\s+/).filter((w) => CJK.test(w)).join(' ');
      const latin = x.split(/\s+/).filter((w) => !CJK.test(w)).join(' ');
      return asian && latin ? [asian, latin] : null;
    };
    const ts = split(g.track);
    const as = split(g.artist);
    if (ts || as) g.alts = [
      { track: ts ? ts[0] : g.track, artist: as ? as[0] : g.artist },
      { track: ts ? ts[1] : g.track, artist: as ? as[1] : g.artist },
    ];
    return g;
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

  // ---------------------------------------------------------------------------
  // Chords (Ultimate Guitar style "chords over lyrics", or ChordPro [Am]words)
  // ---------------------------------------------------------------------------
  const NOTES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const NOTES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const CHORD_RE = /^[A-G](?:#|b|♯|♭)?(?:maj|min|mi|ma|m|M|dim|aug|sus|add|alt|°|ø|\+|-|Δ|\d{1,2}|b\d{1,2}|#\d{1,2}|♭\d{1,2}|♯\d{1,2}|no\d|omit\d|\((?:[^()]{1,12})\))*(?:\/[A-G](?:#|b|♯|♭)?)?$/;
  const BAR_TOKEN = /^(?:\|+|\/+|-+|%|\*+|\.+|:?\|\|?:?|x\d+|\d+x|\(x\d+\)|\(\d+x\)|N\.?C\.?|n\.?c\.?|\(|\))$/;
  const SECTION_WORDS = 'intro|verse|pre[- ]?chorus|chorus|post[- ]?chorus|bridge|outro|hook|pre[- ]?hook|refrain|interlude|instrumental|solo|break|breakdown|tag|coda|ending|drop';
  const SECTION_LINE = new RegExp(`^\\s*(?:\\[\\s*)?((?:${SECTION_WORDS})(?:\\s*\\d+)?(?:\\s*[:\\-–]?\\s*(?:x\\s*\\d+|\\d+\\s*x))?)\\s*(?:\\]\\s*)?:?\\s*$`, 'i');

  function unwrap(tok) {
    const t = String(tok || '');
    return /^\(.*\)$/.test(t) && !/^\([^()]*\)[^()]/.test(t) ? t.slice(1, -1) : t; // "(Am)" -> "Am", but keep "E7(#9)"
  }

  function isChord(tok) {
    const t = unwrap(tok);
    return !!t && CHORD_RE.test(t);
  }

  /** A line made only of chords (and bar marks like | or x2). Returns [{col, c}] or null. */
  function chordLine(line) {
    const out = [];
    const re = /\S+/g;
    let m;
    let any = false;
    while ((m = re.exec(line))) {
      const tok = m[0];
      if (isChord(tok)) {
        out.push({ col: m.index, c: unwrap(tok) });
        any = true;
      } else if (!BAR_TOKEN.test(tok)) return null;
    }
    return any ? out : null;
  }

  function sectionName(line) {
    const m = String(line).match(SECTION_LINE);
    if (!m) return null;
    return m[1].replace(/\s+/g, ' ').replace(/\s*[:\-–]?\s*(x\s*\d+|\d+\s*x)$/i, '').trim()
      .replace(/^./, (c) => c.toUpperCase());
  }

  /**
   * Reads a chord sheet (pasted from Ultimate Guitar or similar, or ChordPro)
   * into items: {type:'sec', name} | {type:'line', text, chords:[{at, c}]} |
   * {type:'chords', chords:[c...]}. Page junk comes through as plain lines;
   * matching against the synced lyrics drops it later.
   */
  function parseChordSheet(text) {
    let src = String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    src = src.replace(/\[\/?(?:ch|tab)\]/g, ''); // Ultimate Guitar's raw markup
    const raw = src.split('\n');
    const items = [];
    let pending = null; // chord line waiting for its lyric line
    const flush = () => {
      if (pending) items.push({ type: 'chords', chords: pending.map((x) => x.c) });
      pending = null;
    };
    for (const lineRaw of raw) {
      const line = lineRaw.replace(/\s+$/, '');
      if (!line.trim()) {
        flush();
        continue;
      }
      // ChordPro directives {start_of_chorus} {c: Verse 2} {title: ...}
      const dir = line.match(/^\s*\{\s*([a-z_]+)\s*(?::\s*([^}]*))?\}\s*$/i);
      if (dir) {
        flush();
        const k = dir[1].toLowerCase();
        const v = (dir[2] || '').trim();
        if (k === 'soc' || k === 'start_of_chorus') items.push({ type: 'sec', name: v || 'Chorus' });
        else if (k === 'sov' || k === 'start_of_verse') items.push({ type: 'sec', name: v || 'Verse' });
        else if (k === 'sob' || k === 'start_of_bridge') items.push({ type: 'sec', name: v || 'Bridge' });
        else if ((k === 'c' || k === 'comment' || k === 'ci') && sectionName(v)) items.push({ type: 'sec', name: sectionName(v) });
        continue;
      }
      const sec = sectionName(line);
      if (sec) {
        flush();
        items.push({ type: 'sec', name: sec });
        continue;
      }
      const cl = chordLine(line);
      if (cl) {
        flush();
        pending = cl;
        continue;
      }
      // Tab lines (e|---3---|) are not lyrics.
      if (/^[eBGDAE]\|[-\d|hpbr/\\~x ]+$/.test(line.trim())) {
        flush();
        continue;
      }
      // ChordPro inline chords: [Am]Hello [F]world
      if (/\[[A-G][^\]\s]{0,10}\]/.test(line)) {
        const chords = [];
        let textOut = '';
        let last = 0;
        const re = /\[([^\]\s]{1,12})\]/g;
        let m;
        let ok = false;
        while ((m = re.exec(line))) {
          textOut += line.slice(last, m.index);
          last = m.index + m[0].length;
          if (isChord(m[1])) {
            chords.push({ at: textOut.length, c: m[1] });
            ok = true;
          } else textOut += m[0];
        }
        textOut += line.slice(last);
        if (ok) {
          flush();
          const t = textOut.replace(/\s+$/, '');
          const lead = t.length - t.trimStart().length;
          if (t.trim()) items.push({ type: 'line', text: t.trim(), chords: chords.map((x) => ({ at: Math.max(0, x.at - lead), c: x.c })) });
          else items.push({ type: 'chords', chords: chords.map((x) => x.c) });
          continue;
        }
      }
      // A lyric line, with the chord line above it (if any).
      const lead = line.length - line.trimStart().length;
      const t = line.trim();
      const chords = pending ? pending.map((x) => ({ at: Math.max(0, x.col - lead), c: x.c })) : [];
      pending = null;
      items.push({ type: 'line', text: t, chords });
    }
    flush();
    return items;
  }

  function normWords(x) {
    return String(x || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[’'`]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  function lineSim(a, b) {
    return lineMatch(a, b).sim;
  }

  // Word overlap of two lines: { sim (0..1), common, total }
  function lineMatch(a, b) {
    const A = normWords(a);
    const B = normWords(b);
    if (!A.length || !B.length) return { sim: 0, common: 0, total: A.length + B.length };
    const bag = new Map();
    for (const w of B) bag.set(w, (bag.get(w) || 0) + 1);
    let common = 0;
    for (const w of A) {
      const n = bag.get(w);
      if (n) {
        common++;
        bag.set(w, n - 1);
      }
    }
    return { sim: (2 * common) / (A.length + B.length), common, total: A.length + B.length };
  }

  // Word positions in a line: [{w, start, end}]
  function wordSpans(text) {
    const out = [];
    const re = /[\p{L}\p{N}’'`]+/gu;
    let m;
    while ((m = re.exec(text))) out.push({ w: m[0].toLowerCase().replace(/[’'`]/g, ''), start: m.index, end: m.index + m[0].length });
    return out;
  }

  // Longest common subsequence of words: map from a-index to b-index.
  function lcsMap(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const map = new Map();
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        map.set(i, j);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return map;
  }

  /** Moves chord positions from the sheet's text onto the (slightly different) lyric text. */
  function mapChordsToText(sheetText, chords, target) {
    const A = wordSpans(sheetText);
    const B = wordSpans(target);
    if (!B.length) return chords.map((x) => ({ at: 0, c: x.c }));
    const map = lcsMap(A.map((x) => x.w), B.map((x) => x.w));
    const out = [];
    for (const ch of chords) {
      if (!A.length || ch.at <= A[0].start) {
        out.push({ at: 0, c: ch.c });
        continue;
      }
      if (ch.at >= A[A.length - 1].end) {
        out.push({ at: target.length, c: ch.c, after: true });
        continue;
      }
      let w = A.length - 1;
      for (let k = 0; k < A.length; k++) {
        if (ch.at < A[k].end) {
          w = k;
          break;
        }
      }
      const inWord = Math.max(0, ch.at - A[w].start);
      let wb = map.get(w);
      if (wb == null) {
        // Nearest matched word before (or after), shifted by the word distance.
        let k = w - 1;
        while (k >= 0 && map.get(k) == null) k--;
        if (k >= 0) wb = map.get(k) + (w - k);
        else {
          k = w + 1;
          while (k < A.length && map.get(k) == null) k++;
          wb = k < A.length ? map.get(k) - (k - w) : Math.round((w / A.length) * B.length);
        }
        wb = Math.max(0, Math.min(B.length - 1, wb));
      }
      const tw = B[wb];
      out.push({ at: tw.start + Math.min(inWord, Math.max(0, tw.end - tw.start - 1)), c: ch.c });
    }
    return out.sort((x, y) => x.at - y.at);
  }

  /**
   * Puts a parsed chord sheet onto the synced lyric lines.
   * Returns { lines: for each lyric line { chords:[{at,c}], sec, pre:[{sec, chords}] }, matched }.
   * Lines are matched in order by their words, so page junk and small lyric
   * differences don't matter. A sheet line may cover two lyric lines (or the
   * other way round). Choruses written only once in the sheet get their
   * chords copied to the repeats.
   */
  function alignChordSheet(items, lyricTexts) {
    const SL = [];
    let sec = null;
    let pre = [];
    for (const it of items) {
      if (it.type === 'sec') sec = it.name;
      else if (it.type === 'chords') {
        pre.push({ sec, chords: it.chords });
        sec = null; // the section's name goes with its chords (an intro of chords only)
      } else if (it.type === 'line') {
        SL.push({ text: it.text, chords: it.chords, sec, pre });
        sec = null;
        pre = [];
      }
    }
    const n = SL.length;
    const m = lyricTexts.length;
    const out = lyricTexts.map(() => ({ chords: [], sec: null, pre: [] }));
    if (!n || !m) return { lines: out, matched: 0 };
    const MIN = 0.5;
    const cache = new Map();
    // Value of matching two texts: words in common, minus a little for words left over.
    const S = (a, b) => {
      const k = a + '\u0001' + b;
      if (!cache.has(k)) {
        const r = lineMatch(a, b);
        cache.set(k, { sim: r.sim, v: 2 * r.common - 0.5 * (r.total - 2 * r.common) });
      }
      return cache.get(k);
    };
    // Candidate moves at (i, j): 1 sheet line : 1 lyric line, 1 : 2, 2 : 1.
    const moves = (i, j) => {
      const r = [];
      if (i < n && j < m) r.push({ di: 1, dj: 1, s: S(SL[i].text, lyricTexts[j]) });
      if (i < n && j + 1 < m) r.push({ di: 1, dj: 2, s: S(SL[i].text, lyricTexts[j] + ' ' + lyricTexts[j + 1]) });
      if (i + 1 < n && j < m) r.push({ di: 2, dj: 1, s: S(SL[i].text + ' ' + SL[i + 1].text, lyricTexts[j]) });
      return r.filter((x) => x.s.sim >= MIN && x.s.v > 0);
    };
    const dp = Array.from({ length: n + 2 }, () => new Float32Array(m + 2));
    const how = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        let best = Math.max(dp[i + 1][j], dp[i][j + 1]);
        let mv = null;
        for (const x of moves(i, j)) {
          const v = x.s.v + dp[i + x.di][j + x.dj];
          if (v > best + 1e-6) {
            best = v;
            mv = x;
          }
        }
        dp[i][j] = best;
        how[i][j] = mv;
      }
    }
    let i = 0;
    let j = 0;
    let matched = 0;
    const got = new Array(m).fill(false);
    const put = (k, chords, from) => {
      out[k].chords = chords;
      if (from) {
        out[k].sec = from.sec;
        out[k].pre = from.pre;
      }
      got[k] = true;
    };
    while (i < n && j < m) {
      const mv = how[i][j];
      if (mv) {
        if (mv.di === 1 && mv.dj === 1) put(j, mapChordsToText(SL[i].text, SL[i].chords, lyricTexts[j]), SL[i]);
        else if (mv.dj === 2) {
          const a = lyricTexts[j];
          const all = mapChordsToText(SL[i].text, SL[i].chords, a + ' ' + lyricTexts[j + 1]);
          put(j, all.filter((c) => c.at < a.length + 1 && !(c.at === a.length + 1)).map((c) => ({ ...c, at: Math.min(c.at, a.length) })), SL[i]);
          put(j + 1, all.filter((c) => c.at >= a.length + 1).map((c) => ({ ...c, at: c.at - a.length - 1 })), null);
        } else {
          const a = SL[i].text;
          const chords = SL[i].chords.concat(SL[i + 1].chords.map((c) => ({ ...c, at: c.at + a.length + 1 })));
          put(j, mapChordsToText(a + ' ' + SL[i + 1].text, chords, lyricTexts[j]), SL[i]);
        }
        matched++;
        i += mv.di;
        j += mv.dj;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    // Repeats the sheet didn't write out again: same words, same chords.
    const byText = new Map();
    for (let k = 0; k < m; k++) if (got[k] && out[k].chords.length) byText.set(normWords(lyricTexts[k]).join(' '), out[k].chords);
    for (let k = 0; k < m; k++) {
      if (got[k]) continue;
      const c = byText.get(normWords(lyricTexts[k]).join(' '));
      if (c) out[k].chords = c.map((x) => ({ ...x }));
    }
    return { lines: out, matched, sheetLines: n };
  }

  function chordParts(c) {
    const m = String(c).match(/^([A-G])(#|b|♯|♭)?(.*?)(?:\/([A-G])(#|b|♯|♭)?)?$/);
    if (!m) return null;
    const acc = (a) => (a === '#' || a === '♯' ? 1 : a === 'b' || a === '♭' ? -1 : 0);
    return { root: (NOTE_INDEX[m[1]] + acc(m[2]) + 12) % 12, qual: m[3] || '', bass: m[4] ? (NOTE_INDEX[m[4]] + acc(m[5]) + 12) % 12 : null };
  }

  /** Transposes a chord by n semitones: transposeChord('F#m7/C#', 2) -> 'G#m7/D#'. */
  function transposeChord(c, n, flats) {
    const p = chordParts(c);
    if (!p || !n) return c;
    const names = flats ? NOTES_FLAT : NOTES_SHARP;
    const r = names[(p.root + n + 120) % 12];
    return r + p.qual + (p.bass != null ? '/' + names[(p.bass + n + 120) % 12] : '');
  }

  /**
   * Should these chords (moved by n semitones) be spelled with flats (Bb)
   * rather than sharps (A#)? Decided by the key you end up in, like a
   * musician writes it: F Bb Eb Ab Db Gb keys use flats, G D A E B use sharps;
   * C keeps the sheet's own habit. The key is guessed from the first chord
   * (a minor first chord means its relative major).
   */
  function prefersFlats(chords, n = 0) {
    let flat = 0;
    let sharp = 0;
    for (const c of chords) {
      if (/^[A-G](b|♭)/.test(c)) flat++;
      else if (/^[A-G](#|♯)/.test(c)) sharp++;
    }
    const first = chords.length ? chordParts(chords[0]) : null;
    if (first) {
      const minor = /^(m(?!aj)|min|-)/.test(first.qual);
      const key = (first.root + (minor ? 3 : 0) + n + 120) % 12;
      if ([5, 10, 3, 8, 1, 6].includes(key)) return true;
      if ([7, 2, 9, 4, 11].includes(key)) return false;
    }
    return flat > sharp;
  }

  // ---------------------------------------------------------------------------
  // Song sections from the lyrics alone (no chord sheet): repeated blocks are
  // the chorus, a repeated block right before every chorus is the pre-chorus,
  // a one-off block late in the song is the bridge.
  // ---------------------------------------------------------------------------
  function detectSections(lines) {
    const sung = (k) => !!lines[k] && !!String(lines[k].text || '').replace(/[♪♫\s]/g, '');
    const idx = [];
    for (let k = 0; k < lines.length; k++) if (sung(k)) idx.push(k);
    const names = new Array(lines.length).fill(null);
    if (idx.length < 2) return { names, sections: idx.length ? [{ name: 'Verse 1', i0: idx[0], i1: idx[0] }] : [] };
    const gaps = [];
    for (let a = 1; a < idx.length; a++) gaps.push(lines[idx[a]].t - lines[idx[a - 1]].t);
    const sorted = gaps.slice().sort((x, y) => x - y);
    const med = sorted[Math.floor(sorted.length / 2)] || 3;
    const bigGap = Math.max(5.5, med * 2.2);
    // 1) Blocks: split at instrumental breaks (empty lines or long gaps).
    let blocks = [];
    let cur = [idx[0]];
    for (let a = 1; a < idx.length; a++) {
      const k = idx[a];
      const prev = idx[a - 1];
      let breakHere = lines[k].t - lines[prev].t > bigGap;
      for (let e = prev + 1; e < k; e++) if (!sung(e)) breakHere = true;
      if (breakHere) {
        blocks.push(cur);
        cur = [];
      }
      cur.push(k);
    }
    blocks.push(cur);
    // 2) Long blocks: also split where a run of lines that repeats elsewhere starts.
    const key = (k) => normWords(lines[k].text).join(' ');
    const count = new Map();
    for (const k of idx) count.set(key(k), (count.get(key(k)) || 0) + 1);
    // Where else (how many lines away) each line's words come back: lines of
    // one section repeat together, at the same distances.
    const pos = new Map(idx.map((k, a) => [k, a]));
    const shifts = new Map();
    for (const k of idx) {
      const set = new Set();
      for (const k2 of idx) if (k2 !== k && key(k2) === key(k)) set.add(pos.get(k2) - pos.get(k));
      shifts.set(k, set);
    }
    const jac = (x, y) => {
      let c = 0;
      for (const v of x) if (y.has(v)) c++;
      return c / (x.size + y.size - c || 1);
    };
    const refined = [];
    for (const b of blocks) {
      if (b.length < 5) {
        refined.push(b);
        continue;
      }
      let part = [b[0]];
      for (let a = 1; a < b.length; a++) {
        const A = shifts.get(b[a - 1]);
        const B = shifts.get(b[a]);
        const change = (A.size > 0) !== (B.size > 0) || (A.size > 0 && B.size > 0 && jac(A, B) < 0.3);
        if (change && part.length >= 2 && b.length - a >= 2) {
          refined.push(part);
          part = [];
        }
        part.push(b[a]);
      }
      refined.push(part);
    }
    blocks = refined;
    // 3) Group blocks that are (mostly) the same words.
    const text = blocks.map((b) => b.map(key));
    const blockSim = (x, y) => {
      const A = text[x];
      const B = text[y];
      let s = 0;
      for (const l of A) s += Math.max(...B.map((m) => (m === l ? 1 : lineSim(l, m))));
      return s / Math.max(A.length, B.length);
    };
    const group = blocks.map((_, x) => x);
    for (let x = 0; x < blocks.length; x++) {
      for (let y = 0; y < x; y++) {
        if (group[y] === y && blockSim(x, y) >= 0.6) {
          group[x] = y;
          break;
        }
      }
    }
    const members = new Map();
    group.forEach((g, x) => members.set(g, [...(members.get(g) || []), x]));
    // Chorus: the repeated group with the most sung lines in total.
    let chorus = -1;
    let best = 0;
    for (const [g, xs] of members) {
      if (xs.length < 2) continue;
      const w = xs.reduce((s, x) => s + blocks[x].length, 0);
      if (w > best) {
        best = w;
        chorus = g;
      }
    }
    const label = new Array(blocks.length).fill(null);
    if (chorus >= 0) for (const x of members.get(chorus)) label[x] = 'Chorus';
    // Pre-chorus: another repeated group whose blocks sit right before choruses.
    for (const [g, xs] of members) {
      if (g === chorus || xs.length < 2) continue;
      if (xs.every((x) => label[x + 1] === 'Chorus')) for (const x of xs) label[x] = 'Pre-Chorus';
    }
    const firstChorus = label.indexOf('Chorus');
    const lastChorus = label.lastIndexOf('Chorus');
    const chorusCount = label.filter((l) => l === 'Chorus').length;
    let verse = 0;
    const verseOf = new Map(); // repeated verse-like groups keep one number
    for (let x = 0; x < blocks.length; x++) {
      if (label[x]) continue;
      const single = members.get(group[x]).length === 1;
      const seenChoruses = label.slice(0, x).filter((l) => l === 'Chorus').length;
      if (single && chorusCount >= 2 && x > firstChorus && seenChoruses >= 2 && x < lastChorus) label[x] = 'Bridge';
      else if (single && chorusCount >= 1 && x > lastChorus && x === blocks.length - 1) label[x] = 'Outro';
      else if (!single && verseOf.has(group[x])) label[x] = verseOf.get(group[x]);
      else {
        label[x] = `Verse ${++verse}`;
        if (!single) verseOf.set(group[x], label[x]);
      }
    }
    if (verse === 1) for (let x = 0; x < label.length; x++) if (label[x] === 'Verse 1') label[x] = 'Verse';
    const sections = blocks.map((b, x) => ({ name: label[x], i0: b[0], i1: b[b.length - 1] }));
    for (const s of sections) names[s.i0] = s.name;
    return { names, sections };
  }

  // ---------------------------------------------------------------------------
  // Timing: where singing (or any sound) starts after a quiet moment.
  // For a cappella these are the line starts, so the lyrics can be lined up
  // with them exactly.
  // ---------------------------------------------------------------------------
  function findOnsets(peak, binRate, n, opts = {}) {
    const len = Math.min(n, peak.length);
    if (!len) return [];
    const hist = Array.from(peak.subarray ? peak.subarray(0, len) : peak.slice(0, len)).filter((x) => x > 0).sort((x, y) => x - y);
    if (!hist.length) return [];
    const p90 = hist[Math.floor(hist.length * 0.9)];
    const thr = Math.max(2, p90 * (opts.frac || 0.18));
    const quiet = Math.round((opts.quiet || 0.16) * binRate);
    const out = [];
    let below = quiet;
    for (let i = 0; i < len; i++) {
      if (peak[i] <= thr) below++;
      else {
        if (below >= quiet) out.push(i / binRate);
        below = 0;
      }
    }
    return out;
  }

  function nearest(sorted, x) {
    let lo = 0;
    let hi = sorted.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    const a = sorted[lo];
    const b = lo > 0 ? sorted[lo - 1] : a;
    return Math.abs(a - x) < Math.abs(b - x) ? a : b;
  }

  /**
   * Best shift of the lyric line times onto the sound onsets, searched around
   * a first guess: { offset, score } (score 0..1 = share of lines that land on
   * a sound start).
   */
  function alignToOnsets(times, onsets, guess = 0, range = 1.5, step = 0.02, tol = 0.25) {
    if (!times.length || !onsets.length) return { offset: guess, score: 0 };
    let best = { offset: guess, score: -1 };
    for (let o = guess - range; o <= guess + range + 1e-9; o += step) {
      let s = 0;
      for (const t of times) {
        const nb = nearest(onsets, t + o);
        const d = Math.abs(nb - (t + o));
        if (d < tol) s += 1 - d / tol;
      }
      if (s > best.score + 1e-9 || (Math.abs(s - best.score) < 1e-9 && Math.abs(o - guess) < Math.abs(best.offset - guess))) best = { offset: o, score: s };
    }
    return { offset: Math.round(best.offset * 100) / 100, score: best.score / times.length };
  }

  /** Per-line fine-tune: each line start moves onto the sound start right next to it (within maxShift s). */
  function snapToOnsets(times, onsets, offset, maxShift = 0.3) {
    const out = times.map(() => 0);
    let prev = -Infinity;
    times.forEach((t, k) => {
      const x = t + offset;
      const nb = nearest(onsets, x);
      if (nb != null && Math.abs(nb - x) <= maxShift && nb > prev + 0.1) {
        out[k] = Math.round((nb - x) * 100) / 100;
        prev = nb;
      } else prev = x;
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Beats: tempo, every beat (following small tempo changes), bar "1"s, and
  // the drum hits (kick / snare / hi-hat) from the low / mid / high bands.
  // ---------------------------------------------------------------------------

  /** Onset strength per bin: how much each band jumps up (drum hits). */
  function drumFlux(P, n) {
    const len = Math.min(n, P.n);
    const kick = new Float32Array(len);
    const snare = new Float32Array(len);
    const hat = new Float32Array(len);
    const env = new Float32Array(len);
    for (let i = 1; i < len; i++) {
      if (!P.cov[i] || !P.cov[i - 1]) continue;
      const dl = Math.max(0, P.low[i] - P.low[i - 1]);
      const dm = Math.max(0, P.mid[i] - P.mid[i - 1]);
      const dh = Math.max(0, P.high[i] - P.high[i - 1]);
      kick[i] = dl;
      snare[i] = Math.min(dm, dh * 1.5) + 0.25 * dm; // noise burst across mids and highs
      hat[i] = dh;
      env[i] = dl + 0.6 * dm + 0.8 * dh;
    }
    return { kick, snare, hat, env };
  }

  function normalize(a) {
    let s = 0;
    let s2 = 0;
    for (const v of a) {
      s += v;
      s2 += v * v;
    }
    const mean = s / (a.length || 1);
    const sd = Math.sqrt(Math.max(1e-9, s2 / (a.length || 1) - mean * mean));
    return Float32Array.from(a, (v) => (v - mean) / sd);
  }

  /** Tempo from the onset envelope: { period (bins), bpm, confidence 0..1 }. */
  function estimateTempo(env, binRate, minBpm = 60, maxBpm = 200) {
    const e = normalize(env);
    const n = e.length;
    const lo = Math.floor((60 * binRate) / maxBpm);
    const hi = Math.ceil((60 * binRate) / minBpm);
    const ac = new Float32Array(hi + 2);
    for (let L = lo - 1; L <= hi + 1; L++) {
      let s = 0;
      for (let i = L; i < n; i++) s += e[i] * e[i - L];
      ac[L] = s / (n - L);
    }
    // Prefer common tempos (around 120 BPM), as people tap along.
    let best = -1;
    let bestScore = -Infinity;
    for (let L = lo; L <= hi; L++) {
      const bpm = (60 * binRate) / L;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      const sc = ac[L] * w;
      if (sc > bestScore && ac[L] >= ac[L - 1] && ac[L] >= ac[L + 1]) {
        bestScore = sc;
        best = L;
      }
    }
    if (best < 0) return { period: 0, bpm: 0, confidence: 0 };
    // Sub-bin period: parabola through the peak.
    const y0 = ac[best - 1];
    const y1 = ac[best];
    const y2 = ac[best + 1];
    const den = y0 - 2 * y1 + y2;
    const p = best + (den < 0 ? (0.5 * (y0 - y2)) / den : 0);
    return { period: p, bpm: (60 * binRate) / p, confidence: Math.max(0, Math.min(1, y1)) };
  }

  /**
   * Beat tracking by dynamic programming (Ellis 2007): every beat lands on a
   * strong onset while the gaps stay close to the tempo, so it follows a
   * drummer who speeds up or slows down a little. Returns beat times in bins
   * (fractional).
   */
  function trackBeatBins(env, period, tightness = 300) {
    const n = env.length;
    const e = normalize(env);
    const score = new Float32Array(n);
    const back = new Int32Array(n).fill(-1);
    const pMin = Math.round(period / 2);
    const pMax = Math.round(period * 2);
    for (let t = 0; t < n; t++) {
      let best = -Infinity;
      let arg = -1;
      for (let tau = t - pMax; tau <= t - pMin; tau++) {
        if (tau < 0) continue;
        const d = Math.log((t - tau) / period);
        const v = score[tau] - tightness * d * d;
        if (v > best) {
          best = v;
          arg = tau;
        }
      }
      score[t] = e[t] + (arg >= 0 ? Math.max(0, best) : 0);
      back[t] = arg >= 0 && best > 0 ? arg : -1;
    }
    // Best end point in the last period, then follow the links back.
    let t = n - 1;
    let bestEnd = -Infinity;
    for (let k = Math.max(0, n - Math.round(period)); k < n; k++) {
      if (score[k] > bestEnd) {
        bestEnd = score[k];
        t = k;
      }
    }
    const beats = [];
    while (t >= 0) {
      beats.push(t);
      t = back[t];
    }
    beats.reverse();
    // Sub-bin position: parabola through the local onset peak.
    return beats.map((b) => {
      let k = b;
      for (let j = Math.max(1, b - 2); j <= Math.min(n - 2, b + 2); j++) if (env[j] > env[k]) k = j;
      const y0 = env[k - 1] || 0;
      const y1 = env[k] || 0;
      const y2 = env[k + 1] || 0;
      const den = y0 - 2 * y1 + y2;
      return k + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0);
    });
  }

  /**
   * The whole beat grid for a song: { bpm, beats: [seconds], first: index of
   * the first bar's "1", confidence } or null when there is no steady beat
   * (e.g. a cappella).
   */
  function beatGrid(P, durationSec) {
    const br = P.binRate;
    const n = Math.min(P.n, Math.ceil(durationSec * br));
    if (n < br * 4) return null;
    const f = drumFlux(P, n);
    // Light smoothing so a hit spread over two bins counts once.
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) env[i] = f.env[i] + 0.5 * ((f.env[i - 1] || 0) + (f.env[i + 1] || 0));
    const tempo = estimateTempo(env, br);
    if (!tempo.period || tempo.confidence < 0.08) return null;
    let bins = trackBeatBins(env, tempo.period);
    // No beats in the silence before the music starts or after it ends.
    let firstSound = 0;
    while (firstSound < n && !(P.cov[firstSound] && P.peak[firstSound] > P.maxPeak * 0.08)) firstSound++;
    let lastSound = n - 1;
    while (lastSound > 0 && !(P.cov[lastSound] && P.peak[lastSound] > P.maxPeak * 0.08)) lastSound--;
    bins = bins.filter((b) => b >= firstSound - tempo.period * 0.25 && b <= lastSound + tempo.period * 0.25);
    if (bins.length < 8) return null;
    // Bar "1": kick on 1 and 3, snare on 2 and 4 (4/4); ties go to the first
    // beat of the music being a "1".
    const near = (a, b) => {
      let m = 0;
      const k = Math.round(b);
      for (let j = Math.max(0, k - 1); j <= Math.min(a.length - 1, k + 1); j++) if (a[j] > m) m = a[j];
      return m;
    };
    const K = bins.map((b) => near(f.kick, b));
    const S = bins.map((b) => near(f.snare, b));
    const meanK = K.reduce((s, v) => s + v, 0) / K.length || 1;
    let first = 0;
    let bestSc = -Infinity;
    for (let ph = 0; ph < 4; ph++) {
      let sc = 0;
      bins.forEach((_, i) => {
        const pos = (((i - ph) % 4) + 4) % 4;
        if (pos === 0) sc += K[i] * 1.15;
        else if (pos === 2) sc += K[i];
        else sc += S[i] * 0.9;
      });
      if (ph === 0) sc += meanK * 2; // the music usually starts on a "1"
      if (sc > bestSc) {
        bestSc = sc;
        first = ph;
      }
    }
    const beats = bins.map((b) => b / br);
    // Average tempo over the whole song (a single gap is only 20 ms exact).
    const avg = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
    return { bpm: Math.round(600 / avg) / 10, beats, first, confidence: tempo.confidence };
  }

  /** Drum hits for the drum lanes: [{t, kind: 'kick'|'snare'|'hat', v}] */
  function drumHits(P, durationSec) {
    const br = P.binRate;
    const n = Math.min(P.n, Math.ceil(durationSec * br));
    const f = drumFlux(P, n);
    const pick = (a, kind, pct) => {
      const vals = Array.from(a).filter((v) => v > 0).sort((x, y) => x - y);
      if (vals.length < 10) return [];
      // Above the background (noise makes many small jumps), relative to the loudest hits.
      const thr = Math.max(6, vals[Math.floor(vals.length * pct)], vals[Math.floor(vals.length * 0.995)] * 0.35);
      const out = [];
      for (let i = 1; i < a.length - 1; i++) {
        if (a[i] > thr && a[i] >= a[i - 1] && a[i] > a[i + 1]) {
          if (out.length && i / br - out[out.length - 1].t < 0.06) continue; // one hit, not two
          out.push({ t: i / br, kind, v: Math.min(1, a[i] / (thr * 3)) });
        }
      }
      return out;
    };
    return [...pick(f.kick, 'kick', 0.8), ...pick(f.snare, 'snare', 0.85), ...pick(f.hat, 'hat', 0.8)].sort((x, y) => x.t - y.t);
  }

  /** Index of the beat nearest to t (beats sorted). */
  function nearestBeatIndex(beats, t) {
    let lo = 0;
    let hi = beats.length - 1;
    if (hi < 0) return -1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && Math.abs(beats[lo - 1] - t) <= Math.abs(beats[lo] - t) ? lo - 1 : lo;
  }

  /** Time of beat i, also before the first / after the last beat (same tempo). */
  function beatTime(beats, i) {
    if (!beats.length) return 0;
    if (i >= 0 && i < beats.length) return beats[i];
    const k = Math.min(8, beats.length - 1);
    if (i < 0) return beats[0] + i * ((beats[k] - beats[0]) / k);
    const L = beats.length - 1;
    return beats[L] + (i - L) * ((beats[L] - beats[L - k]) / k);
  }

  const api = {
    SPEED_MIN, SPEED_MAX, END_GUARD, MIN_LOOP,
    clamp, roundRate, formatTime, trainerRate, trainerRepFor, loopEnd, normalizeLoop,
    PeakStore, bandColor, bytesToBase64, base64ToBytes,
    parseSongTitle, parseLrc, lineAt, similarity, rankLyrics, isVocalOnlyTitle,
    isChord, chordLine, parseChordSheet, alignChordSheet, mapChordsToText, lineSim, transposeChord, prefersFlats,
    detectSections, findOnsets, alignToOnsets, snapToOnsets,
    drumFlux, estimateTempo, trackBeatBins, beatGrid, drumHits, nearestBeatIndex, beatTime,
  };
  root.YTLCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
