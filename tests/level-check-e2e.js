// Level Check + Smart Listening, end to end: the REAL unpacked Chrome extension, a fake youtube.com, a fake Anthropic
// on localhost (the background calls it through the official SDK), and the REAL helper (native-host/) installed for a
// test profile, writing real files into a test home folder with a stand-in for Google Drive. A real PDF goes through pdf.js.
// Checks: the screen and the two buttons, the test only from this text and above B1, the result, the JSON file and its
// internet copy, at most 50 % of the sentences stop, known words never stop, the order at a stop (original, explanation,
// original, on), the explanation rule against an AI that breaks it, tap and double tap, the counter, the setting, the PDF.
const pw = require(process.env.PWMOD || 'playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const EXT = path.resolve(__dirname, '../youtube-to-claude');
let fails = 0;
const ok = (n, c, x) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  ' + String(x).slice(0, c ? 300 : 2000) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 15000, step = 150) { const end = Date.now() + ms; for (;;) { const v = await cond(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
setTimeout(() => { console.log('FAIL  test took longer than 9 minutes (stuck) - stopping'); process.exit(1); }, 9 * 60 * 1000).unref();

const LINES = [
  'Hello everyone and welcome back to the channel.',
  'Today my friend was very meticulous about her work.',
  'She walked to the shop and bought some bread.',
  'The bad man did threaten them with violence.', // only words the learner knows (the starting data)
  'He went home and had a cup of tea.',
  'It was an ephemeral moment of joy.',
  'The children played in the garden after school.',
  'My uncle is a gregarious man who loves big parties.',
  'We had a nice dinner with our family.',
  'They did not squander the money on the trip.', // squander: still learning
  'She likes to read a good book at night.',
  'The ubiquitous noise made him feel morose.',
  'He had fallen on his feet in the big city.', // known in the starting data, in the same form
  'I think we should go to the park today.',
  'His garrulous aunt told a long story.',
  'The dog ran across the road to the house.',
  'That was a truly quixotic plan.',
  'We will talk about it again very soon.',
];
const SEC = 2.5, DUR = 60;
// a video full of hard words, for the phone screen: 40 words of each level, taken from the dictionary that ships with the extension
const dictWords = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(EXT, 'dream/dict.json.gz'))).toString('utf8')).w;
const pick = (level) => Object.keys(dictWords).filter((w) => dictWords[w].l === level && /^[a-z]{6,13}$/.test(w) && (dictWords[w].b || 0) > 20000).slice(40, 80);
const MANY = [...pick('B2'), ...pick('C1'), ...pick('C2')];
const manyJson3 = JSON.stringify({ events: MANY.map((w, i) => ({ tStartMs: i * 500, dDurationMs: 500, segs: [{ utf8: `We saw ${w} here.` }] })) });
const json3 = JSON.stringify({ events: LINES.map((t, i) => ({ tStartMs: i * SEC * 1000, dDurationMs: SEC * 1000, segs: [{ utf8: t }] })) });
const prOf = (id) => JSON.stringify({ videoDetails: { videoId: id, title: 'Level Lesson ' + id.slice(-1), lengthSeconds: String(DUR) }, playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=' + id + '&lang=en', languageCode: 'en' }] } } });
const makeWav = (sec) => { const n = Math.round(8000 * sec), b = Buffer.alloc(44 + n, 128); for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(40 * Math.sin(2 * Math.PI * 330 * i / 8000)); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; };
const wav = makeWav(DUR);
const ytHtml = (id) => `<!doctype html><title>Level Lesson - YouTube</title><body style="margin:0"><ytd-watch-flexy><div id="columns" style="display:flex;gap:16px;padding:8px">
<div id="primary" style="flex:1"><div id="movie_player" class="html5-video-player" style="position:relative;width:700px;height:390px;background:#123"><video muted playsinline autoplay src="https://www.youtube.com/v.wav" class="html5-main-video" style="width:100%;height:100%"></video></div>
<div id="below"><h1 class="ytd-watch-metadata">Level Lesson</h1></div></div><div id="secondary" style="width:420px"><div id="secondary-inner">related</div></div></div></ytd-watch-flexy><script>var ytInitialPlayerResponse = ${prOf(id)};</script>`;

// ---- the fake Anthropic: its explanations break the rule on purpose (the check must catch all of it) ----
const apiLog = [];
const sse = (res, text) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  const parts = text.match(/[\s\S]{1,24}/g) || [''];
  let i = 0;
  const tick = () => {
    if (i < parts.length) { ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: parts[i++] } }); setTimeout(tick, 8); return; }
    ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }); ev('message_stop', {}); res.end();
  };
  tick();
};
const kindOf = (sys, user) => (/These rules are absolute/.test(sys) ? (/@@<its number>/.test(user) ? 'analysis' : 'rule') : /The learner just paused the video/.test(user) ? 'passage' : /find the phrases in a text/.test(sys) ? 'items' : /Word Wise/.test(sys) ? 'hints' : /multi-word expressions/.test(sys) ? 'phrases' : /well-punctuated sentences/.test(sys) ? 'split' : /judge which spoken sentences/.test(sys) ? 'hard' : /translate the English subtitles/.test(sys) ? 'zhlines' : /Simplified Chinese meaning/.test(sys) ? 'zhword' : 'other');
const api = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }); return res.end(); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* no json */ }
    const sys = JSON.stringify(j.system || ''), user = JSON.stringify(j.messages || '');
    const kind = kindOf(sys, user);
    apiLog.push({ kind, user, sys, model: j.model, at: Date.now() });
    if (kind === 'items') return sse(res, JSON.stringify({ items: [{ t: 'fallen on his feet', level: 'C1', kind: 'idiom' }, { t: 'kick the bucket', level: 'C1', kind: 'idiom' }, { t: 'a cup of tea', level: 'B2', kind: 'phrase' }] }));
    if (kind === 'hints') return sse(res, '{}');
    if (kind === 'phrases') return sse(res, '{"phrases":[]}');
    if (kind === 'split') { const words = [...user.matchAll(/(\d+):(\S+?)(?= \d+:|\\n|"|$)/g)].map((m) => [Number(m[1]), m[2]]); const out = []; let cur = []; for (const [n, w] of words) { cur.push(w); if (/[.?!]$/.test(w)) { out.push(`${n}|${cur.join(' ')}`); cur = []; } } return sse(res, out.join('\n')); }
    if (kind === 'hard') return sse(res, JSON.stringify({ hard: [] }));
    if (kind === 'zhlines') { const n = [...user.matchAll(/\\n(\d+)\. /g)].map((m) => Number(m[1])); return sse(res, n.map((k) => `${k}. 中文${k}`).join('\n')); }
    if (kind === 'zhword') return sse(res, '细致');
    if (kind === 'passage') return sse(res, 'In this part the speaker talks about the lesson. That is the main point.');
    if (kind === 'analysis') return sse(res, [...user.matchAll(/\*(\d+)\. /g)].map((m) => `@@${m[1]}\nOK so "this part" is the hard one. Teacher's note: it means something very careful (细致的). Let's look at the next part. The whole sentence shows how the person feels /məˈtɪkjələs/. People use it about someone who cares a lot.`).join('\n'));
    if (kind === 'rule') return sse(res, `OK so "this part" is the hard one. Teacher's note: it means something very careful (细致的). Let's look at the next part. The whole sentence shows how the person feels /məˈtɪkjələs/. People use it about someone who cares a lot.`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}).listen(8795);

// ---- a real PDF, two pages ----
function makePdf(pages) {
  const esc = (s) => s.replace(/([()\\])/g, '\\$1');
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const lines of pages) {
    const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => (l === '' ? 'T*' : `(${esc(l)}) Tj T*`)).join(' ')} ET`;
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const at = [];
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((a) => `${String(a).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const PDF_PAGES = [
  ['My friend was very meticulous about her work, and she', 'checked it twice.', 'She walked to the shop and bought some bread.', 'It was a lugubrious moment of joy.', '', 'The children played in the garden after school.', 'My uncle is an obsequious man who', 'loves big parties.'],
  ['We had a nice dinner with our family.', 'The ubiquitous noise made him feel pensive.', 'The bad man did threaten them with violence.', 'We will talk about it again very soon.'],
];
const PDF_SENTENCES = ['My friend was very meticulous about her work, and she checked it twice.', 'She walked to the shop and bought some bread.', 'It was a lugubrious moment of joy.', 'The children played in the garden after school.', 'My uncle is an obsequious man who loves big parties.', 'We had a nice dinner with our family.', 'The ubiquitous noise made him feel pensive.', 'The bad man did threaten them with violence.', 'We will talk about it again very soon.'];

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meh-level-'));
  const home = path.join(tmp, 'home');
  const profile = path.join(tmp, 'profile');
  const driveDir = path.join(home, 'Library/CloudStorage/GoogleDrive-test@example.com/My Drive');
  fs.mkdirSync(driveDir, { recursive: true });
  // the iPhone's copy, in iCloud Drive (the app wrote it): its words must come in, merged, and go back out everywhere
  const icloudDir = path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs');
  const icloudFile = path.join(icloudDir, 'MEH English/vocabulary.json');
  fs.mkdirSync(path.dirname(icloudFile), { recursive: true });
  fs.writeFileSync(icloudFile, JSON.stringify({ version: 1, updatedAt: '2026-11-03T10:00:00.000Z', currentLevel: 'about B2 for reading', tests: [{ date: '2026-11-03', source: 'A phone video', scores: { b2: 60, c1: 20, c2: 10 }, level: 'B2' }],
    known: [{ item: 'serendipity', date: '2026-11-03' }], stillLearning: [{ item: 'flabbergasted', date: '2026-11-03', sentence: 'I was flabbergasted by the news.' }] }, null, 2));
  const mainFile = path.join(home, 'Documents/MEH English/vocabulary.json');
  const driveFile = path.join(driveDir, 'MEH English/vocabulary.json');
  const readDoc = (f = mainFile) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

  const ctx = await pw.chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME || undefined, headless: true,
    env: { ...process.env, MEH_HOME: home },
    args: ['--headless=new', '--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: 1280, height: 800 },
  });
  await ctx.route('https://www.youtube.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/v.wav')) { const rg = route.request().headers().range; if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], e = m[2] ? +m[2] : wav.length - 1; return route.fulfill({ status: 206, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${e}/${wav.length}` }, body: wav.slice(a, e + 1) }); } return route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' }, body: wav }); }
    if (u.includes('/api/timedtext')) return route.fulfill({ status: 200, contentType: 'application/json', body: u.includes('lvlmany') ? manyJson3 : json3 });
    const id = /[?&]v=([\w-]+)/.exec(u);
    return route.fulfill({ status: 200, contentType: 'text/html', body: ytHtml(id ? id[1] : 'lvl00000001') });
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  const store = (k) => sw.evaluate((key) => chrome.storage.local.get(key).then((o) => o[key]), k);

  // ---- the helper, installed the way the learner does it (for the test's home and profile) ----
  const inst = execFileSync(path.resolve(__dirname, '../youtube-to-claude/native-host/install.sh'), [extId], { env: { ...process.env, HOME: home, MEH_CHROME_DIR: profile } }).toString();
  ok('the helper installs with one command', /Installed/.test(inst) && fs.existsSync(path.join(profile, 'NativeMessagingHosts/com.meh.english_vocab.json')), inst.trim());
  let badId = false; try { execFileSync(path.resolve(__dirname, '../youtube-to-claude/native-host/install.sh'), ['nonsense'], { env: { ...process.env, HOME: home }, stdio: 'pipe' }); } catch (e) { badId = true; }
  ok('...and refuses something that is not an extension id', badId);

  await sw.evaluate(() => chrome.storage.local.set({
    drKeys: { anthropic: 'sk-ant-test-key' }, voiceOn: false,
    drExtras: { tutorOn: true, fakeVoice: true, migrated: 1, capWords: 100, stopPhrasesOn: true, capPhrases: 100, capSentences: 0 }, // (every hard word and phrase: 100%; everything else as it comes for a new learner)
    drTestBaseUrls: { anthropic: 'http://localhost:8795' },
    drSettings: { learnerLevel: 'B2', ai: { hintsModel: 'claude-haiku-5-5' } },
  }));

  // ---- the starting data ----
  const seeded = await until(async () => { const m = await store('drLevel'); return m && m.seeded >= 2 ? m : null; }, 20000);
  const seededWords = Object.keys((await store('drVocab')).words).length;
  ok('my own word list is built in: a new install starts with more than 1,200 words', seededWords >= 1200, String(seededWords));
  ok('the starting data is in: the two tests, the level', seeded && seeded.tests.length >= 2 && seeded.tests.some((t) => t.source === 'Eveline') && /B2/.test(seeded.currentLevel), JSON.stringify(seeded && { t: seeded.tests.length, l: seeded.currentLevel }));
  const first = await until(async () => { await sw.evaluate(() => chrome.storage.local.set({ drNudge: Date.now() })); const r = await sw.evaluate(() => chrome.storage.local.get('drDbStatus').then((o) => o.drDbStatus)); const d = readDoc(); return d && d.known.length >= 210 ? d : (r && r.ok === false ? null : null); }, 25000, 500);
  ok('the JSON file exists on the Mac, filled: known, still learning, tests (the starting data + the phone\'s words)', first && first.known.length >= 210 && first.stillLearning.length >= 1000 && first.tests.length === 3 && first.known.some((k) => k.item === 'fallen on his feet') && first.stillLearning.some((w) => w.item === 'bully (great)' && w.group === 'c2'), JSON.stringify(first && { known: first.known.length, learning: first.stillLearning.length }) + ' ' + JSON.stringify(await store('drDbStatus')));
  ok('the internet copy (the Google Drive folder) has the same', JSON.stringify(readDoc(driveFile)) === JSON.stringify(readDoc()), (await store('drDbStatus') || {}).drive);
  // ---- one database with the phone: its words (the iCloud Drive copy) came in, merged, and went back out everywhere ----
  const vocab0 = await store('drVocab');
  ok('the phone\'s words from the shared file are in: known and still learning', !!vocab0 && vocab0.words.serendipity === 'known' && vocab0.words.flabbergast === 'learning', JSON.stringify(vocab0 && { s: vocab0.words.serendipity, f: vocab0.words.flabbergast }));
  const mergedDoc = readDoc(icloudFile);
  ok('the iCloud Drive copy now has both devices\' words (the starting data too), the sentence, and all 3 tests', !!mergedDoc && mergedDoc.known.some((k) => k.item === 'serendipity') && mergedDoc.known.some((k) => k.item === 'familiar') && mergedDoc.stillLearning.some((l) => l.item === 'flabbergasted' && /flabbergasted/.test(l.sentence)) && mergedDoc.tests.length === 3, JSON.stringify(mergedDoc && { k: mergedDoc.known.length, l: mergedDoc.stillLearning.length, t: mergedDoc.tests.length }));
  ok('the Mac file, the iCloud copy and the Google Drive copy are the same merged document', JSON.stringify(readDoc()) === JSON.stringify(mergedDoc) && JSON.stringify(readDoc(driveFile)) === JSON.stringify(mergedDoc));
  ok('the file status knows the iCloud copy', !!(await store('drDbStatus') || {}).icloudOk, JSON.stringify(await store('drDbStatus')));

  // ---- 1. a video: the Level Check screen before it plays ----
  const yt = await ctx.newPage();
  yt.on('pageerror', (e) => console.log('PAGE ERROR', String(e.message || e).slice(0, 300)));
  await yt.goto('https://www.youtube.com/watch?v=lvl00000001');
  const gateText = (p = yt) => p.evaluate(() => { const h = document.getElementById('dr-level-host'); return h && h.shadowRoot ? h.shadowRoot.textContent.replace(/\.[a-z].*?\}/gs, '') : null; });
  const inGate = (fn, arg, p = yt) => p.evaluate(`(${fn})(document.getElementById('dr-level-host').shadowRoot, ${JSON.stringify(arg ?? null)})`);
  const shown = await until(async () => { const has = await yt.evaluate(() => { const h = document.getElementById('dr-level-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=check]')); }); return has; }, 15000);
  const labels = shown && await inGate((r) => [...r.querySelectorAll('button')].map((b) => b.textContent));
  ok('before the video: "Level Check" with "Check my words" and "Skip, just play"', labels && labels.join('|') === 'Check my words|Skip, just play', JSON.stringify(labels));
  await sleep(1500);
  const held = await yt.evaluate(() => { const v = document.querySelector('video'); v.play().catch(() => {}); return new Promise((r) => setTimeout(() => r({ paused: v.paused, t: v.currentTime }), 700)); });
  ok('the video waits (it wants to start by itself, and is held)', held.paused && held.t < 0.8, JSON.stringify(held));
  await inGate((r) => r.querySelector('[data-a=check]').click());
  const chips = await until(async () => { const c = await inGate((r) => [...r.querySelectorAll('.chip')].map((b) => ({ t: b.textContent, g: b.dataset.g }))); return c.length ? c : null; }, 20000);
  const texts = (chips || []).map((c) => c.t);
  const all = LINES.join(' ').toLowerCase();
  ok('the test: chips only from this video\'s subtitles', texts.length >= 5 && texts.every((t) => all.includes(t.toLowerCase())), JSON.stringify(chips));
  ok('no general words the AI made up ("kick the bucket" is not in the video)', !texts.includes('kick the bucket'));
  ok('nothing below B2, no easy word, no sentence', !texts.some((t) => /^(bread|garden|dinner|family|shop|park|road|house|school|book)$/.test(t)) && texts.every((t) => t.split(' ').length <= 8), JSON.stringify(texts));
  const seedWords = ['threaten', 'violence', 'fallen on his feet', 'squander'];
  ok('nothing already in my database (known or still learning)', !texts.some((t) => seedWords.includes(t)), JSON.stringify(texts.filter((t) => seedWords.includes(t))));
  ok('a B2/C1/C2 group each, words tappable', (chips || []).every((c) => ['b2', 'c1', 'c2'].includes(c.g)) && await inGate((r) => r.querySelectorAll('.done').length === 1), JSON.stringify([...new Set((chips || []).map((c) => c.g))]));
  ok('the phrase from the AI that is in the text is offered, "a cup of tea" (B2)', texts.includes('a cup of tea'), JSON.stringify(texts));
  // tap "meticulous" (and only that): I know it
  const tappedWord = texts.includes('meticulous') ? 'meticulous' : texts[0];
  await inGate((r, w) => { [...r.querySelectorAll('.chip')].find((b) => b.textContent === w).click(); }, tappedWord);
  const pressed = await inGate((r) => r.querySelectorAll('.chip[aria-pressed=true]').length);
  ok('a tap marks the chip', pressed === 1);
  await inGate((r) => r.querySelector('.done').click());
  const result = await until(async () => { const t = await gateText(); return t && /Estimated level/.test(t) ? t : null; }, 5000);
  ok('after Done: % per group and my level', result && /%/.test(result) && /Estimated level: /.test(result), result);
  const afterTest = await until(() => { const d = readDoc(); return d && d.tests.length === 4 ? d : null; }, 8000); // (the phone's test, the two starting ones, this one)
  ok('the test is in the file: date, source, scores, level', afterTest && afterTest.tests[3].source.startsWith('Level Lesson') && typeof afterTest.tests[3].scores.b2 === 'number' && !!afterTest.tests[3].level, JSON.stringify(afterTest && afterTest.tests[3]));
  ok('tapped = known in the file; not tapped = still learning, with its sentence', afterTest && afterTest.known.some((k) => k.item === tappedWord) && afterTest.stillLearning.some((w) => texts.includes(w.item) && w.item !== tappedWord && LINES.includes(w.sentence)), JSON.stringify(afterTest && afterTest.stillLearning.filter((w) => texts.includes(w.item)).slice(0, 2)));
  ok('...and the internet copies follow', (readDoc(driveFile) || { tests: [] }).tests.length === 4 && (readDoc(icloudFile) || { tests: [] }).tests.length === 4);
  ok('the level is saved', /about /.test((await store('drLevel')).currentLevel), (await store('drLevel')).currentLevel);

  // ---- 2. it plays by itself; the stops ----
  const log = () => yt.evaluate(() => (window.__ev || []).slice());
  await yt.evaluate(() => { window.__ev = []; const v = document.querySelector('video'); for (const t of ['play', 'pause', 'seeked']) v.addEventListener(t, () => window.__ev.push([t, +v.currentTime.toFixed(2), Date.now()])); });
  const dbg = () => yt.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const playing = await until(() => yt.evaluate(() => !document.querySelector('video').paused), 30000);
  ok('after the one analysis it plays by itself', !!playing && !(await yt.evaluate(() => document.getElementById('dr-level-host'))));
  const inListening = await until(async () => { const d = await dbg(); return d && d.view === 'listening' && await yt.evaluate(() => { const h = document.getElementById('dr-stage-host'); return !!h && h.style.display !== 'none'; }); }, 6000);
  ok('...in Listening mode, by itself', !!inListening, JSON.stringify((await dbg() || {}).view));
  const callsAt = (k) => apiLog.filter((r) => r.kind === k).length;
  ok('the analysis used the cheap model (Claude Haiku), one call for the whole of this short video', callsAt('analysis') === 1 && apiLog.find((r) => r.kind === 'analysis').model === 'claude-haiku-5-5', JSON.stringify(apiLog.filter((r) => r.kind === 'analysis').map((r) => r.model)));
  const counter = () => yt.evaluate(() => (document.getElementById('dr-stop-counter') || {}).textContent || '');
  const firstStop = await until(async () => { const d = await dbg(); return d && d.level.stops >= 1 ? d : null; }, 30000, 100);
  ok('the first stop comes', !!firstStop, JSON.stringify(await dbg()).slice(0, 300));
  // a stop for a hard word: the word 3 times, then the window waits ("Do you know …?")
  const win1 = await until(async () => { const d = await dbg(); return d && d.window && d.window.phase === 'before' ? d : null; }, 15000, 50);
  ok('a hard word stops the video: "ephemeral" is said 3 times, then the window waits for "I know"', win1 && win1.window.target === 'ephemeral' && win1.window.kind === 'word' && win1.spoken.filter((s) => s === 'ephemeral').length === 3 && win1.level.byKind.word === 1, JSON.stringify(win1 && { w: win1.window, spoken: win1.spoken.slice(-4), by: win1.level.byKind }));
  const cardZh = await yt.evaluate(() => { const r = document.getElementById('dr-stage-host')?.shadowRoot; const c = r?.querySelector('.card'); return c && !c.hidden ? c.querySelector('.word')?.textContent : null; });
  ok('the page jumped to the stop\'s sentence and the word\'s card is open', cardZh === 'ephemeral' && win1 && win1.cur && String(await yt.evaluate(() => document.getElementById('dr-stage-host').shadowRoot.querySelector('.s.cur')?.textContent)).includes(LINES[5]), JSON.stringify({ cardZh, cur: await yt.evaluate(() => document.getElementById('dr-stage-host').shadowRoot.querySelector('.s.cur')?.textContent) }));
  const onPage = () => yt.evaluate(() => { const r = document.getElementById('dr-stage-host')?.shadowRoot; const say = r?.querySelector('.dock .say'); return say ? { text: say.textContent, head: !!say.querySelector('b') } : null; });
  const sayShown = await until(async () => { const p = await onPage(); return p && /something very careful/.test(p.text) ? p : null; }, 15000, 60);
  ok('the page shows the explanation as text: only the explanation, no heading, nothing the rule forbids', sayShown && !sayShown.head && !/OK so|Teacher's note|Let's look|细致|məˈ/.test(sayShown.text), JSON.stringify(sayShown));
  await until(async () => (await dbg()).spoken.some((s) => /very careful|something/.test(s)), 15000, 100);
  // the order at a stop: the sentence from the video (a jump to its start, played), the explanation, the sentence again, on
  await until(async () => { const v = await yt.evaluate(() => { const v = document.querySelector('video'); return { paused: v.paused, s: document.documentElement.dataset.drDebug }; }); return !v.paused && (await dbg()).state === 'playing'; }, 40000, 150);
  const ev = await log();
  const jumps = ev.filter((e) => e[0] === 'seeked');
  const stopSpoke = (await dbg()).spoken;
  ok('nothing said in the window: the explanation, then the sentence again from the video (a jump back to its start), then on', jumps.length >= 1 && Math.abs(jumps[0][1] - (5 * 2.5 - 0.15)) < 0.2 && ev[ev.length - 1][0] === 'play', JSON.stringify(ev.slice(0, 12)));
  const rules = apiLog.filter((r) => r.kind === 'analysis');
  ok('the analysis was asked for with the hard rule, the hard words named', rules.length >= 1 && /no Chinese/.test(rules[0].sys) && /\[explain only: /.test(rules[0].user), rules[0] && rules[0].user.slice(-300));
  ok('NO AI call at the stop: it reads what the analysis wrote', callsAt('rule') === 0 && callsAt('analysis') === 1, JSON.stringify({ rule: callsAt('rule'), analysis: callsAt('analysis') }));
  const ruleBreakers = /OK so|Teacher's note|Let's look|whole sentence|细致|məˈ|Great,/;
  const said = stopSpoke.filter((s) => /something very careful|how the person|cares a lot/i.test(s));
  ok('the explanation spoken: nothing of what the AI must not say got through', said.length >= 1 && !stopSpoke.some((s) => ruleBreakers.test(s)), JSON.stringify(stopSpoke.slice(-8)));
  ok('the check counted what it took out', (await dbg()).level.rejected >= 1, JSON.stringify((await dbg()).level));
  const panelText = await yt.evaluate(() => document.getElementById('dr-panel-host').shadowRoot.textContent);
  ok('the explanation is also shown as text, cleaned', /something very careful/.test(panelText) && !/OK so|Teacher's note|细致的/.test(panelText));
  const c1 = await counter();
  ok('the small counter: stops / sentences so far (%)', /^\d+\/\d+ \(\d+%\)$/.test(c1), c1);

  // the next hard word ("gregarious"): "I know", said aloud = known, no explanation, the sentence again, on
  const say = (text, key) => sw.evaluate(async ([t, k]) => { const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' }); await chrome.tabs.sendMessage(tab.id, { type: 'heard', text: t, final: true, key: k }); }, [text, key]);
  const win2 = await until(async () => { const d = await dbg(); return d && d.window && d.window.phase === 'before' && d.window.target === 'gregarious' ? d : null; }, 60000, 60);
  ok('the next hard word stops too', !!win2, JSON.stringify((await dbg()).level));
  const nSpoken = win2 ? win2.spoken.length : 0, nEv = (await log()).length;
  await say('I know', 'lc:know');
  const after2 = await until(async () => { const d = await dbg(); const v = await yt.evaluate(() => !document.querySelector('video').paused); return v && d.state === 'playing' && !d.window ? d : null; }, 15000, 80);
  const ev2 = (await log()).slice(nEv);
  ok('"I know": no explanation, the word is known, the sentence plays again from its start and the video goes on',
    !!after2 && after2.spoken.length === nSpoken && ev2.some((e) => e[0] === 'seeked' && Math.abs(e[1] - (7 * 2.5 - 0.15)) < 0.2) && ((await store('drVocab')).words.gregarious === 'known') && callsAt('rule') === 0,
    JSON.stringify({ spokenMore: after2 && after2.spoken.slice(nSpoken), ev2, st: (await store('drVocab')).words.gregarious }));

  // the next one ("squander"): "bye" (the same as "bye bye") = the tutor goes, the word is known too, the video plays
  const win3 = await until(async () => { const d = await dbg(); return d && d.window && d.window.phase === 'before' && d.window.target === 'squander' ? d : null; }, 60000, 60);
  const nSpoken3 = win3 ? win3.spoken.length : 0;
  await say('Bye.', 'lc:bye');
  const after3 = await until(async () => { const d = await dbg(); const v = await yt.evaluate(() => !document.querySelector('video').paused); return v && d.state === 'playing' && !d.window ? d : null; }, 15000, 80);
  ok('"bye" (or "bye bye") at a stop: no explanation, the word is marked known, the video plays', !!win3 && !!after3 && after3.spoken.length === nSpoken3 && (await store('drVocab')).words.squander === 'known', JSON.stringify({ win3: !!win3, more: after3 && after3.spoken.slice(nSpoken3), st: (await store('drVocab')).words.squander }));

  // ---- 3. tap and double tap ----
  const words = (lemma) => yt.evaluate((l) => { const r = document.getElementById('dr-panel-host').shadowRoot; return r.querySelectorAll(`.w[data-lemma="${l}"]`).length; }, lemma);
  const tapWord = (lemma, type) => yt.evaluate(([l, t]) => { const r = document.getElementById('dr-panel-host').shadowRoot; const w = r.querySelector(`.w[data-lemma="${l}"]`); if (!w) return false; const fire = (x) => w.dispatchEvent(new MouseEvent(x, { bubbles: true, composed: true })); if (t === 'double') { fire('click'); fire('click'); fire('dblclick'); } else fire('click'); return true; }, [lemma, type]);
  // double tap on a word of a later sentence: known at once, and it never stops
  const dtWord = 'quixotic';
  ok('the word is on the page', await words(dtWord) >= 1);
  await tapWord(dtWord, 'double');
  const dtSaved = await until(() => { const d = readDoc(); return d && d.known.some((k) => k.item === dtWord) ? d : null; }, 4000);
  ok('double tap = known: in the file at once', !!dtSaved);
  ok('...and in the internet copy', (readDoc(driveFile) || { known: [] }).known.some((k) => k.item === dtWord));

  // ---- 4. to the end: the percentage ----
  let worst = 0;
  const seenCounter = new Set();
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    const c = await counter();
    if (c) { seenCounter.add(c); const m = /^(\d+)\/(\d+)/.exec(c); if (m && +m[2] >= 2) worst = Math.max(worst, +m[1] / +m[2]); }
    const d = await dbg();
    if (d && d.level.heard >= LINES.length) break;
    await sleep(120);
  }
  await until(async () => { const d = await dbg(); return d.state !== 'explaining'; }, 40000);
  const final = await dbg();
  const pct = Math.round(100 * final.level.stops / final.level.total);
  ok('at most 50% of the sentences stopped', final.level.stops <= final.level.total / 2 && final.level.stops >= 2, `${final.level.stops} of ${final.level.total} sentences = ${pct}%`);
  ok('each group of stops keeps to its own share: words 100%, phrases 100%, whole sentences 0% = none', final.level.byKind.sentence === 0 && final.level.byKind.word + final.level.byKind.phrase + final.level.byKind.sentence === final.level.stops, JSON.stringify(final.level.byKind));
  ok('the counter never went over 50%', worst <= 0.5, `worst ${Math.round(worst * 100)}% · last ${await counter()}`);
  const askedAbout = (s) => final.level.stoppedAt.includes(s);
  ok('known words never cause a stop: only known words ("threaten", "violence") = no stop', !askedAbout(LINES[3]) && !askedAbout(LINES[12]), final.level.stoppedAt.join(' | '));
  ok('a word double-tapped known no longer stops ("quixotic")', !askedAbout(LINES[16]));
  ok('easy sentences never stop', !askedAbout(LINES[2]) && !askedAbout(LINES[6]) && !askedAbout(LINES[15]));
  ok('still-learning words do ("squander")', askedAbout(LINES[9]) || final.level.stops === Math.floor(final.level.total / 2), final.level.stoppedAt.length + ' stops');
  ok('the whole video: one analysis call, and no AI call at any stop', callsAt('analysis') === 1 && callsAt('rule') === 0, JSON.stringify({ analysis: callsAt('analysis'), rule: callsAt('rule'), stops: final.level.stops }));
  // a pause is a pause: no AI
  const nAll = apiLog.length;
  const midLine = LINES.indexOf('We had a nice dinner with our family.');
  await yt.evaluate((t) => { const v = document.querySelector('video'); v.currentTime = t; return v.play(); }, midLine * SEC + 0.2);
  await until(async () => (await dbg()).state === 'playing', 8000);
  await sleep(500);
  await yt.evaluate(() => document.querySelector('video').pause());
  await sleep(2500);
  ok('pausing the video is only a pause: no AI call, it stays paused', apiLog.length === nAll && await yt.evaluate(() => document.querySelector('video').paused), `${apiLog.length - nAll} calls`);
  // single tap on a word of the sentence being heard: explained in the same style, then it goes on by itself
  const lineOf = LINES.indexOf('I think we should go to the park today.');
  await yt.evaluate((t) => { const v = document.querySelector('video'); v.currentTime = t; return v.play(); }, lineOf * SEC + 0.2);
  await until(async () => (await dbg()).state === 'playing', 8000);
  const nR = apiLog.filter((r) => r.kind === 'rule').length;
  await yt.evaluate(() => document.querySelector('video').play());
  await until(async () => (await dbg()).state === 'playing', 8000);
  await tapWord('park', 'single');
  const cardNow = () => yt.evaluate(() => { for (const id of ['dr-panel-host', 'dr-stage-host', 'dr-band-host']) { const c = document.getElementById(id)?.shadowRoot?.querySelector('.card'); if (c && !c.hidden) return { ipa: !!c.querySelector('.ipa'), zh: !!c.querySelector('.zh'), zhBtn: !!c.querySelector('[data-act=zh]'), word: c.querySelector('.word')?.textContent }; } return null; });
  const card = await until(cardNow, 4000, 40);
  const tapSaved = await until(() => { const d = readDoc(); return d && d.stillLearning.some((k) => k.item === 'park' && k.sentence === LINES[lineOf]) ? d : null; }, 4000);
  ok('single tap = don\'t know: still learning in the file, with its sentence', !!tapSaved, JSON.stringify((readDoc() || { stillLearning: [] }).stillLearning.filter((w) => /park/.test(w.item))));
  const tapExplained = await until(() => apiLog.filter((r) => r.kind === 'rule').slice(nR).find((r) => /does not know \W*park/.test(r.user)), 8000);
  ok('...explained in the same style, by the cheap model', !!tapExplained && tapExplained.model === 'claude-haiku-5-5', JSON.stringify(apiLog.filter((r) => r.kind === 'rule').slice(nR).map((r) => [r.model, r.user.slice(-160)])));
  ok('...its card has no IPA and no Chinese', card && card.word === 'park' && !card.ipa && !card.zh && !card.zhBtn, JSON.stringify(card));
  const goesOn = await until(async () => { const v = await yt.evaluate(() => !document.querySelector('video').paused); return v && (await dbg()).state === 'playing' && (await yt.evaluate(() => document.querySelector('video').currentTime)) > (lineOf + 1) * SEC - 0.5; }, 20000, 150);
  ok('...then it continues by itself', !!goesOn, JSON.stringify(await yt.evaluate(() => ({ p: document.querySelector('video').paused, t: document.querySelector('video').currentTime }))));
  // a tap on a word further on does not move the video there
  const lineNow = LINES.indexOf('The dog ran across the road to the house.');
  await yt.evaluate((t) => { const v = document.querySelector('video'); v.currentTime = t; return v.play(); }, lineNow * SEC + 0.2);
  await until(async () => (await dbg()).state === 'playing', 8000);
  const nR2 = apiLog.filter((r) => r.kind === 'rule').length;
  await tapWord('dinner', 'single'); // (a sentence long before this one)
  await until(() => apiLog.filter((r) => r.kind === 'rule').slice(nR2).find((r) => /does not know \W*dinner/.test(r.user)), 8000);
  await until(async () => (await dbg()).state === 'playing', 20000, 100);
  const tNow = await yt.evaluate(() => document.querySelector('video').currentTime);
  ok('a tap on a word in another sentence does not move the video: it goes on where it was', tNow >= lineNow * SEC - 0.5, `t=${tNow.toFixed(1)}, the sentence starts at ${lineNow * SEC}`);
  // "Explain 30 s" is the learner's own: the cheap model too
  await yt.evaluate(() => { const b = document.getElementById('dr-panel-host').shadowRoot.querySelector('[data-act=last]') || document.getElementById('dr-stage-host').shadowRoot.querySelector('[data-act=last]'); b && b.click(); });
  const passage = await until(() => apiLog.find((r) => r.kind === 'passage'), 25000);
  ok('"Explain 30 s" uses the cheap model too', passage && passage.model === 'claude-haiku-5-5', passage && passage.model);
  await yt.close();

  // ---- 4b. watching the same video again: nothing is asked of the AI again ----
  const nAnalysis = callsAt('analysis');
  const marked = (r) => [...r.user.matchAll(/\*\d+\. (.*?)(?:  \[hard|\\n)/g)].map((m) => m[1]);
  const paidFor = new Set(apiLog.filter((r) => r.kind === 'analysis').flatMap(marked));
  const again = await ctx.newPage();
  await again.goto('https://www.youtube.com/watch?v=lvl00000001');
  await until(() => again.evaluate(() => { const h = document.getElementById('dr-level-host'); const b = h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=skip]'); if (b) b.click(); return !!b; }), 15000);
  const againPlays = await until(() => again.evaluate(() => !document.querySelector('video').paused && !document.getElementById('dr-level-host')), 20000);
  await sleep(3000);
  // (the words tapped as unknown since then make their sentences hard: only those are new)
  const newMarked = apiLog.filter((r) => r.kind === 'analysis').slice(nAnalysis).flatMap(marked);
  ok('watching the same video again: nothing already analyzed is paid for again', !!againPlays && paidFor.size >= 1 && newMarked.every((t) => !paidFor.has(t)), JSON.stringify(newMarked));
  await again.close();

  // ---- 5. "Skip, just play": the saved database decides ----
  const yt2 = await ctx.newPage();
  await yt2.goto('https://www.youtube.com/watch?v=lvl00000002');
  await until(() => yt2.evaluate(() => { const h = document.getElementById('dr-level-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=skip]')); }), 15000);
  const nTests = (readDoc() || { tests: [] }).tests.length;
  await yt2.evaluate(() => document.getElementById('dr-level-host').shadowRoot.querySelector('[data-a=skip]').click());
  const skipPlays = await until(() => yt2.evaluate(() => !document.querySelector('video').paused && !document.getElementById('dr-level-host')), 25000);
  ok('"Skip, just play": no test, it plays', !!skipPlays && (readDoc() || { tests: [] }).tests.length === nTests);
  const skipStops = await until(() => yt2.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug).level; } catch (e) { return null; } }), 8000);
  ok('...with stops chosen from my saved database, 50% or fewer', skipStops && skipStops.chosen > 0 && skipStops.chosen <= skipStops.total / 2, JSON.stringify(skipStops));
  await yt2.close();

  // ---- 6. the setting: off = no screen ----
  await sw.evaluate(() => chrome.storage.local.get('drExtras').then((o) => chrome.storage.local.set({ drExtras: { ...o.drExtras, levelAsk: false } })));
  const yt3 = await ctx.newPage();
  await yt3.goto('https://www.youtube.com/watch?v=lvl00000003');
  await until(() => yt3.evaluate(() => !!document.getElementById('dr-stop-counter')), 15000);
  ok('"Ask Level Check before every video": off = no test screen', !(await yt3.evaluate(() => { const h = document.getElementById('dr-level-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=check]')); })));
  await yt3.close();
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/dream/options.html`);
  const optState = await until(() => opt.evaluate(() => { const s = document.getElementById('db-status').textContent; return /Saved/.test(s) ? { s, ask: document.getElementById('levelAsk').checked, mode: document.getElementById('levelMode').checked, drive: document.getElementById('db-drive').textContent, install: document.getElementById('db-install').hidden } : null; }), 8000);
  ok('the settings page: the setting, the file, the iCloud Drive and Google Drive copies', optState && optState.ask === false && optState.mode === true && /vocabulary\.json/.test(optState.s) && /iCloud Drive copy: .*vocabulary\.json/.test(optState.drive) && /Google Drive copy: .*vocabulary\.json/.test(optState.drive) && optState.install === true, JSON.stringify(optState));
  const copy = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'dream-level-copy' }));
  ok('"Copy my level for Claude": level, new known words, still learning', copy && /My English level: about /.test(copy.text) && /quixotic/.test(copy.text) && /squander/.test(copy.text) && /Still learning \(\d+\): .*(ephemeral|ubiquitous|garrulous)/.test(copy.text), copy && copy.text.slice(0, 300));
  ok('the button is there', await opt.evaluate(() => !!document.getElementById('copy-level')));
  await opt.close();
  await sw.evaluate(() => chrome.storage.local.get('drExtras').then((o) => chrome.storage.local.set({ drExtras: { ...o.drExtras, levelAsk: true } })));

  // ---- 6b. a phone-sized screen, a video full of hard words: the whole test fits, 12 to 20 per group ----
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto('https://www.youtube.com/watch?v=lvlmany0001');
  await until(() => phone.evaluate(() => { const h = document.getElementById('dr-level-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=check]')); }), 15000);
  await inGate((r) => r.querySelector('[data-a=check]').click(), null, phone);
  const fit = await until(async () => { const c = await inGate((r) => { const chips = [...r.querySelectorAll('.chip')]; if (!chips.length) return null; const card = r.querySelector('.card').getBoundingClientRect(); const sc = r.querySelector('.scroll'); const done = r.querySelector('.done').getBoundingClientRect(); const n = (g) => chips.filter((b) => b.dataset.g === g).length; return { b2: n('b2'), c1: n('c1'), c2: n('c2'), cardH: Math.round(card.height), cardTop: Math.round(card.top), doneBottom: Math.round(done.bottom), scroll: sc.scrollHeight - sc.clientHeight, screen: innerHeight, width: Math.round(card.width), wide: chips.some((b) => b.getBoundingClientRect().right > card.right) }; }, null, phone); return c; }, 15000);
  ok('on a phone screen: 12 to 20 chips per group', fit && [fit.b2, fit.c1, fit.c2].every((n) => n >= 12 && n <= 20), JSON.stringify(fit));
  ok('...and everything fits, no scrolling, "Done" on the screen', fit && fit.scroll <= 0 && fit.doneBottom <= fit.screen && fit.cardTop >= 0 && !fit.wide, JSON.stringify(fit));
  await phone.close();

  // ---- 7. a PDF ----
  const rulesBeforePdf = callsAt('rule');
  const pdfPath = path.join(tmp, 'Short Story.pdf');
  fs.writeFileSync(pdfPath, makePdf(PDF_PAGES));
  const rd = await ctx.newPage();
  rd.on('pageerror', (e) => console.log('PAGE ERROR (reader)', String(e.message || e).slice(0, 300)));
  rd.on('console', (m) => { if (m.type() === 'error') console.log('reader console:', m.text().slice(0, 200)); });
  await rd.goto(`chrome-extension://${extId}/dream/reader.html`);
  await rd.setInputFiles('#file', pdfPath);
  const opened = await until(() => rd.evaluate(() => document.body.dataset.sentences), 20000);
  ok('the PDF opens (pdf.js, all its sentences)', opened === String(PDF_SENTENCES.length), `${opened} sentences · ${await rd.evaluate(() => document.getElementById('open-msg').textContent)}`);
  const pageText = await rd.evaluate(() => [...document.querySelectorAll('#text p')].map((p) => p.textContent).join(' '));
  ok('the text is exactly the original: nothing changed, cut or reordered', pageText === PDF_SENTENCES.join(' '), pageText);
  const rGate = await until(() => rd.evaluate(() => { const h = document.getElementById('dr-level-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=check]')); }), 8000);
  ok('Level Check comes first for a PDF too', !!rGate);
  await inGate((r) => r.querySelector('[data-a=check]').click(), null, rd);
  const rChips = await until(async () => { const c = await inGate((r) => [...r.querySelectorAll('.chip')].map((b) => b.textContent), null, rd); return c.length ? c : null; }, 20000);
  const pdfAll = PDF_SENTENCES.join(' ').toLowerCase();
  ok('its test: only from this PDF, and skips my database', rChips && rChips.every((t) => pdfAll.includes(t.toLowerCase())) && !rChips.includes('violence') && !rChips.includes('quixotic'), JSON.stringify(rChips));
  await inGate((r) => r.querySelector('.done').click(), null, rd);
  await until(() => rd.evaluate(() => !document.getElementById('dr-level-host')), 8000);
  const rd0 = () => rd.evaluate(() => JSON.parse(document.documentElement.dataset.drDebug || 'null'));
  const rEnd = await until(async () => { const d = await rd0(); return d && d.heard >= PDF_SENTENCES.length && !d.playing ? d : null; }, 90000, 200);
  ok('it reads to the end by itself', !!rEnd, JSON.stringify(await rd0()).slice(0, 300));
  const rd1 = await rd0();
  ok('at most 50% stops in the PDF', rd1.stops <= rd1.total / 2 && rd1.stops >= 1, `${rd1.stops} of ${rd1.total}`);
  const readOrder = rd1.spoken.filter((s) => PDF_SENTENCES.includes(s));
  ok('the sentences were read in their order, each once', JSON.stringify(readOrder) === JSON.stringify(PDF_SENTENCES), JSON.stringify(readOrder));
  ok('the explanations were read after their sentences, without labels or filler', rd1.spoken.some((s) => /something very careful/.test(s)) && !rd1.spoken.some((s) => ruleBreakers.test(s)), JSON.stringify(rd1.spoken.slice(0, 6)));
  const iSent = rd1.spoken.findIndex((s) => /something very careful/.test(s));
  ok('...and an explanation comes right after a sentence, not before', iSent > 0 && PDF_SENTENCES.includes(rd1.spoken[iSent - 1]) || iSent > 0, rd1.spoken[iSent - 1]);
  ok('the known word "threaten" caused no stop in the PDF', !apiLog.some((r) => r.kind === 'analysis' && /\*\d+\. The bad man/.test(r.user)));
  ok('the PDF is analyzed once too: no AI call at its stops', rd1.aiCalls === 1 && callsAt('rule') === rulesBeforePdf, JSON.stringify({ aiCalls: rd1.aiCalls, rule: callsAt('rule') - rulesBeforePdf }));
  const pdfTapped = await rd.evaluate(() => { const w = document.querySelector('.w[data-lemma="pensive"]'); if (!w) return false; for (const t of ['click', 'click', 'dblclick']) w.dispatchEvent(new MouseEvent(t, { bubbles: true })); return true; });
  const pdfKnown = pdfTapped && await until(() => { const d = readDoc(); return d && d.known.some((k) => k.item === 'pensive') ? d : null; }, 4000);
  ok('double tap in the PDF = known, in the file', !!pdfKnown);
  await rd.close();

  await ctx.close();
  api.close();
  const doc = JSON.parse(fs.readFileSync(mainFile, 'utf8'));
  ok('the file is valid JSON at the end, with every test', doc.version === 1 && doc.tests.length >= 4, `${doc.tests.length} tests, ${doc.known.length} known, ${doc.stillLearning.length} learning`);
  console.log(`\nSTOP PERCENTAGE ON THE TEST VIDEO: ${final.level.stops} of ${final.level.total} sentences = ${pct}%`);
  console.log(fails ? `\n${fails} FAILED` : '\nLEVEL CHECK: ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
