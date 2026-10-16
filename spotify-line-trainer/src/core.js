// Pure logic shared by the page engine and the tests (no DOM access here).
(function (root) {
  'use strict';

  const LEAD_IN = 0.1;   // seconds to start before a line so the first syllable isn't clipped
  const TAIL = -0.1;     // a repetition ends this long before the next line (negative = slightly after, so last words aren't clipped)
  const MIN_LINE = 0.6;  // shortest playable line
  const MAX_LINE = 15;   // cap so long instrumental gaps aren't looped

  function isLyricText(s) {
    s = (s || '').trim();
    return s.length > 0 && /[^\s♪♫♬♩….\-–—·*]/.test(s);
  }

  // Accepts Spotify's color-lyrics JSON ({lyrics:{syncType, lines:[{startTimeMs, words, endTimeMs}]}}).
  function parseLyrics(json, duration) {
    const lyr = json && (json.lyrics || json);
    if (!lyr || !Array.isArray(lyr.lines) || !lyr.lines.length) return { synced: false, lines: [] };
    if (lyr.syncType && !/SYNCED/.test(lyr.syncType) || lyr.syncType === 'UNSYNCED') {
      return { synced: false, lines: [] };
    }
    const dur = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
    const raw = lyr.lines
      .map(l => ({
        start: Number(l.startTimeMs) / 1000,
        endHint: Number(l.endTimeMs) / 1000,
        text: String(l.words || '').trim()
      }))
      .filter(l => Number.isFinite(l.start) && l.start >= 0 && l.start < dur)
      .sort((a, b) => a.start - b.start);
    if (!raw.some(l => l.start > 0)) return { synced: false, lines: [] };

    const lines = [];
    for (let i = 0; i < raw.length; i++) {
      const l = raw[i];
      if (!isLyricText(l.text)) continue;
      // next boundary = next raw line (♪ markers included) that starts later
      let next = Infinity;
      for (let j = i + 1; j < raw.length; j++) if (raw[j].start > l.start + 0.01) { next = raw[j].start; break; }
      let end = Math.min(next, l.start + MAX_LINE, dur);
      if (Number.isFinite(l.endHint) && l.endHint > l.start + MIN_LINE) end = Math.min(end, l.endHint);
      if (end - l.start < MIN_LINE) end = Math.min(l.start + MIN_LINE, dur);
      if (!Number.isFinite(end) || end <= l.start) continue;
      // merge exact duplicates in time
      const prev = lines[lines.length - 1];
      if (prev && Math.abs(prev.start - l.start) < 0.01) { prev.text += ' / ' + l.text; prev.end = Math.max(prev.end, end); continue; }
      lines.push({ start: l.start, end, text: l.text });
    }
    return { synced: lines.length > 0, lines };
  }

  const SPEEDS = [0.3, 0.5, 0.75, 1];
  const REPS = [3, 5, 7, 10];

  function normalizeSettings(s) {
    s = Object.assign({}, s || {});
    const out = {
      mode: s.mode === 'training' ? 'training' : 'repeat',
      reps: REPS.includes(+s.reps) ? +s.reps : 5,
      speed: SPEEDS.includes(+s.speed) ? +s.speed : 1,
      trainingReps: REPS.includes(+s.trainingReps) ? +s.trainingReps : 5,
      trainingSpeeds: Array.isArray(s.trainingSpeeds)
        ? [...new Set(s.trainingSpeeds.map(Number).filter(v => SPEEDS.includes(v)))].sort((a, b) => a - b)
        : SPEEDS.slice(),
      startFrom: s.startFrom === 'current' ? 'current' : 'first',
      autoNext: !!s.autoNext,
      playFullAfter: s.playFullAfter !== false
    };
    if (!out.trainingSpeeds.length) out.trainingSpeeds = SPEEDS.slice();
    return out;
  }

  function plan(settings) {
    const s = normalizeSettings(settings);
    return s.mode === 'training'
      ? { stages: s.trainingSpeeds, reps: s.trainingReps }
      : { stages: [s.speed], reps: s.reps };
  }

  // pos = {line, stage, rep}; returns next pos or {done:true}
  function advance(pos, lineCount, p) {
    if (pos.rep + 1 < p.reps) return { line: pos.line, stage: pos.stage, rep: pos.rep + 1 };
    if (pos.stage + 1 < p.stages.length) return { line: pos.line, stage: pos.stage + 1, rep: 0 };
    if (pos.line + 1 < lineCount) return { line: pos.line + 1, stage: 0, rep: 0 };
    return { done: true };
  }

  // Line that is playing at time t (last line whose start <= t), or 0 before the first line.
  function findLineAt(lines, t) {
    let idx = 0;
    for (let i = 0; i < lines.length; i++) { if (lines[i].start <= t + 0.05) idx = i; else break; }
    return idx;
  }

  // User timing fixes for one song (saved per track):
  //   adj = { offset: seconds for every line, joins: [i, ...] (line i is joined with line i+1),
  //           lines: { [id]: { ds, de } } (start / end nudges in seconds) }
  // Returned lines keep id = index of their first original line and joined = how many lines were merged in.
  function applyAdjustments(lines, adj) {
    adj = adj || {};
    const off = Number(adj.offset) || 0;
    const joins = new Set((adj.joins || []).map(Number));
    const per = adj.lines || {};
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = { id: i, start: lines[i].start, end: lines[i].end, text: lines[i].text, joined: 0 };
      while (joins.has(i) && i + 1 < lines.length) {
        i++;
        ln.end = Math.max(ln.end, lines[i].end);
        ln.text += ' ' + lines[i].text;
        ln.joined++;
      }
      const a = per[ln.id] || {};
      ln.start = Math.max(0, ln.start + off + (Number(a.ds) || 0));
      ln.end = ln.end + off + (Number(a.de) || 0);
      if (ln.end < ln.start + 0.3) ln.end = ln.start + 0.3;
      out.push(ln);
    }
    return out;
  }

  const api = { applyAdjustments, LEAD_IN, TAIL, MIN_LINE, MAX_LINE, SPEEDS, REPS, isLyricText, parseLyrics, normalizeSettings, plan, advance, findLineAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__SLT_CORE__ = api;
})(typeof window !== 'undefined' ? window : globalThis);
