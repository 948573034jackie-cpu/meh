// Pure helpers (no browser APIs) so they can be unit-tested in Node.
(function (root) {
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  // YouTube's timed-text "json3" format -> [{start (seconds), text}]
  function parseJson3(json) {
    const cues = [];
    for (const ev of (json && json.events) || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const start = (ev.tStartMs || 0) / 1000;
      cues.push({ start, end: ev.dDurationMs ? start + ev.dDurationMs / 1000 : null, text });
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

  // Merge small caption pieces into readable lines: "[1:05] Some full sentence."
  function formatTranscript(cues) {
    const lines = [];
    let cur = null;
    const flush = () => { if (cur) { lines.push('[' + fmtTime(cur.start) + '] ' + cur.text); cur = null; } };
    for (const c of cues) {
      if (!cur) cur = { start: c.start, text: c.text, last: c.start };
      else { cur.text += ' ' + c.text; cur.last = c.start; }
      const elapsed = c.start - cur.start;
      const endsSentence = /[.?!…]["')\]]*$/.test(c.text);
      if ((endsSentence && elapsed >= 4) || elapsed >= 12) flush();
    }
    flush();
    return lines.join('\n');
  }


  // Merge caption pieces into sentences: [{start, end, text}] (seconds).
  function buildSentences(cues, maxSpan) {
    maxSpan = maxSpan || 10;
    const out = [];
    let cur = null;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const next = cues[i + 1];
      let end = c.end || (next ? next.start : c.start + 4);
      if (next && next.start > c.start && end > next.start) end = next.start; // rolling auto-captions overlap
      if (!cur) cur = { start: c.start, end, text: c.text };
      else { cur.text += ' ' + c.text; cur.end = end; }
      const endsSentence = /[.?!…]["')\]]*$/.test(c.text);
      if (endsSentence || cur.end - cur.start >= maxSpan) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  // The sentence playing at time t plus up to 2 before it, never more than 30 s in total.
  function pickSegment(sentences, t, opts) {
    opts = opts || {};
    const maxSentences = opts.maxSentences || 3;
    const maxSpan = opts.maxSpan || 30;
    if (!sentences.length) return null;
    let cur = 0;
    for (let i = 0; i < sentences.length; i++) { if (sentences[i].start <= t) cur = i; else break; }
    let first = cur;
    while (first > 0 && cur - first < maxSentences - 1 &&
           sentences[cur].end - sentences[first - 1].start <= maxSpan) first--;
    const items = sentences.slice(first, cur + 1);
    return { start: items[0].start, end: items[items.length - 1].end, pausedAt: t, items };
  }

  const api = { fmtTime, parseJson3, extractPlayerResponse, pickTrack, formatTranscript, buildSentences, pickSegment };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YTC = api;
})(typeof window !== 'undefined' ? window : globalThis);
