// Pure helpers (no browser APIs) so they can be unit-tested in Node.
(function (root) {
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  // YouTube's timed-text "json3" format -> cues [{start, end|null, text, words|null}] (seconds).
  // Auto-generated captions carry a start time for every word; typed captions only per line.
  function parseJson3(json) {
    const cues = [];
    const seen = new Set();
    for (const ev of (json && json.events) || []) {
      if (!ev.segs) continue;
      const base = ev.tStartMs || 0;
      const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const timed = ev.segs.some((s) => (s.tOffsetMs || 0) > 0);
      let words = null;
      if (timed) {
        words = [];
        for (const s of ev.segs) {
          const t = (base + (s.tOffsetMs || 0)) / 1000;
          for (const w of (s.utf8 || '').split(/\s+/)) {
            if (!w) continue;
            const key = t.toFixed(2) + '|' + w;
            if (seen.has(key)) continue; // rolling auto-captions repeat words
            seen.add(key);
            words.push({ t, w });
          }
        }
        if (!words.length) continue;
      }
      const start = base / 1000;
      cues.push({ start, end: ev.dDurationMs ? start + ev.dDurationMs / 1000 : null, text, words });
    }
    return cues;
  }

  // Cut the JSON object that follows "ytInitialPlayerResponse =" out of a page's HTML.
  function extractPlayerResponse(html) {
    const marker = html.indexOf('ytInitialPlayerResponse');
    if (marker < 0) return null;
    const start = html.indexOf('{', marker);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  // English first (typed captions before auto-generated), then anything.
  function pickTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    const isEn = (t) => (t.languageCode || '').toLowerCase().startsWith('en');
    const manual = (t) => t.kind !== 'asr';
    return (
      tracks.find((t) => isEn(t) && manual(t)) ||
      tracks.find((t) => isEn(t)) ||
      tracks.find(manual) ||
      tracks[0]
    );
  }

  // ---------- complete sentences ----------
  // Words that (almost) never end a sentence: cutting after them would leave it hanging.
  const DANGLING = new Set(('and or but so because that which who whom whose the a an to of in on at for with from by as if when ' +
    'while than then is are was were be been my your his our their this these those i we they he she not very can will would ' +
    'could should have has had do does did just also about into onto over under between through after before until since ' +
    'what where how why its').split(' '));
  const ABBREV = /^(mr|mrs|ms|dr|prof|sr|jr|st|vs|e\.g|i\.e)\.$/i;

  function bare(w) { return w.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''); }
  function isDangling(w) { const b = bare(w); return DANGLING.has(b) || /'(s|m|re|ll|ve|d)$/.test(b); }
  function endsSentence(w) {
    return /[.?!…]["'”’)\]]*$/.test(w) && !ABBREV.test(w) && !/^\d+\.$/.test(w);
  }

  // One list of words with start (t) and end (e) times, from cues with or without per-word timing.
  function toWords(cues) {
    const words = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const next = cues[i + 1];
      let list;
      if (c.words) {
        list = c.words.map((x) => ({ t: x.t, w: x.w, e: null }));
        list.forEach((x, k) => { x.e = k + 1 < list.length ? Math.min(list[k + 1].t, x.t + 1.2) : x.t + 0.6; });
      } else {
        const toks = c.text.split(/\s+/).filter(Boolean);
        let end = c.end || (next ? next.start : c.start + 4);
        if (next && next.start > c.start && end > next.start) end = next.start;
        if (end <= c.start) end = c.start + 2;
        const step = (end - c.start) / toks.length;
        list = toks.map((w, k) => ({ t: c.start + k * step, w, e: c.start + (k + 1) * step }));
      }
      for (const x of list) if (!/^\[[^\]]*\]$/.test(x.w)) words.push(x); // drop [Music], [Applause]
    }
    words.sort((a, b) => a.t - b.t);
    return words;
  }

  function tidy(ws) {
    let text = ws.map((x) => x.w).join(' ').replace(/\s+([,.!?;:])/g, '$1');
    text = text.replace(/\bi\b/g, 'I').replace(/\bi'(m|ll|ve|d)\b/g, "I'$1");
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (!/[.?!…]["'”’)\]]*$/.test(text)) text += '.';
    return text;
  }

  // Cues -> complete sentences [{start, end, text}]. Uses punctuation when the captions have it,
  // otherwise pauses between words, and never cuts after a word like "the", "and", "to", "because".
  function buildSentences(cues) {
    const words = toWords(cues);
    if (!words.length) return [];
    const punct = words.filter((x) => endsSentence(x.w)).length / words.length > 0.02;
    const out = [];
    let cur = [];
    const push = (ws) => { if (ws.length) out.push({ start: ws[0].t, end: ws[ws.length - 1].e, text: tidy(ws) }); };

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const next = words[i + 1];
      cur.push(w);
      const gap = next ? next.t - w.e : Infinity;
      const dangling = isDangling(w.w);
      let brk = false;
      if (!next) brk = true;
      else if (punct) brk = endsSentence(w.w);
      else if (endsSentence(w.w)) brk = true;
      else if (gap >= 0.8 && !dangling) brk = true;
      else if (gap >= 0.4 && cur.length >= 10 && !dangling) brk = true;
      if (brk) { push(cur); cur = []; continue; }

      // too long without a natural break: cut at the biggest pause among the last words
      if (cur.length >= 30 || w.e - cur[0].t >= 14) {
        let best = -1, bestGap = -1;
        for (let k = Math.max(3, cur.length - 12); k < cur.length; k++) {
          const g = (cur[k + 1] ? cur[k + 1].t : next.t) - cur[k].e;
          if (!isDangling(cur[k].w) && g > bestGap) { bestGap = g; best = k; }
        }
        if (best < 0) best = cur.length - 1;
        push(cur.slice(0, best + 1));
        cur = cur.slice(best + 1);
      }
    }
    return out;
  }

  // Readable transcript lines: "[1:05] A complete sentence."
  function formatTranscript(cues) {
    return buildSentences(cues).map((s) => '[' + fmtTime(s.start) + '] ' + s.text).join('\n');
  }

  // The sentence playing at time t plus the ones before it, filling about 30 seconds.
  function pickSegment(sentences, t, opts) {
    opts = opts || {};
    const target = opts.target || 30;
    const maxSentences = opts.maxSentences || 12;
    if (!sentences.length) return null;
    let cur = 0;
    for (let i = 0; i < sentences.length; i++) { if (sentences[i].start <= t) cur = i; else break; }
    let first = cur;
    while (first > 0 && cur - first < maxSentences - 1) {
      const now = sentences[cur].end - sentences[first].start;
      const cand = sentences[cur].end - sentences[first - 1].start;
      if (cand <= target || (cand <= target + 6 && Math.abs(cand - target) < Math.abs(now - target))) first--;
      else break;
    }
    const items = sentences.slice(first, cur + 1);
    return { start: items[0].start, end: items[items.length - 1].end, pausedAt: t, items };
  }

  const api = { fmtTime, parseJson3, extractPlayerResponse, pickTrack, formatTranscript, buildSentences, pickSegment };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YTC = api;
})(typeof window !== 'undefined' ? window : globalThis);
