// Level Check on a REAL YouTube video with its real subtitles, in the real extension. The AI is a stand-in on localhost
// (no real key is needed or used): it answers the same way every time, so this checks what the extension does with a
// real page and real subtitles, not how good a real AI's answers are.
// Prints the test's chips, how many sentences would stop and the first stops. Run: CHROME=… node tests/real-level-check.js [video id]
const pw = require(process.env.PWMOD || 'playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const EXT = path.resolve(__dirname, '../youtube-to-claude');
const VIDEO = process.argv[2] || 'iG9CE55wbtY'; // a TED talk with typed English captions
let fails = 0;
const ok = (n, c, x) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  ' + String(x).slice(0, 500) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 15000, step = 200) { const end = Date.now() + ms; for (;;) { const v = await cond(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
setTimeout(() => { console.log('FAIL  stuck: stopping after 6 minutes'); process.exit(1); }, 6 * 60 * 1000).unref();

const said = [];
const calls = { analysis: 0, stop: 0 };
const sse = (res, text) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }); ev('message_stop', {}); res.end();
};
const api = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }); return res.end(); }
  const c = [];
  req.on('data', (d) => c.push(d));
  req.on('end', () => {
    let j = {}; try { j = JSON.parse(Buffer.concat(c).toString()); } catch (e) { /* none */ }
    const sys = JSON.stringify(j.system || ''), user = JSON.stringify(j.messages || '');
    if (/These rules are absolute/.test(sys) && /@@<its number>/.test(user)) { calls.analysis++; const n = [...user.matchAll(/\*(\d+)\. (.*?)(?:  \[hard|\\n)/g)]; said.push(...n.map((m) => m[2])); return sse(res, n.map((m) => `@@${m[1]}\nOK so "this part" is hard. It means something simple here. People say it when they feel strongly about it.`).join('\n')); }
    if (/These rules are absolute/.test(sys)) { calls.stop++; return sse(res, 'It means something simple here.'); }
    if (/well-punctuated sentences/.test(sys)) { const words = [...user.matchAll(/(\d+):(\S+?)(?= \d+:|\\n|"|$)/g)].map((m) => [Number(m[1]), m[2]]); const out = []; let cur = []; for (const [n, w] of words) { cur.push(w); if (/[.?!]$/.test(w)) { out.push(`${n}|${cur.join(' ')}`); cur = []; } } if (cur.length) out.push(`${words[words.length - 1][0]}|${cur.join(' ')}`); return sse(res, out.join('\n')); }
    if (/judge which spoken sentences/.test(sys)) return sse(res, '{"hard":[]}');
    if (/find the phrases in a text/.test(sys)) return sse(res, '{"items":[]}');
    if (/multi-word expressions/.test(sys)) return sse(res, '{"phrases":[]}');
    return sse(res, '{}');
  });
}).listen(8796);

(async () => {
  const ctx = await pw.chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'meh-real-')), {
    executablePath: process.env.CHROME || undefined, headless: false,
    args: ['--headless=new', '--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--autoplay-policy=no-user-gesture-required', '--lang=en-US'],
    locale: 'en-US', viewport: { width: 1280, height: 800 },
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({
    drKeys: { anthropic: 'sk-ant-test-key' }, voiceOn: false, drTestBaseUrls: { anthropic: 'http://localhost:8796' },
    drExtras: { tutorOn: true, fakeVoice: true, explainOnStop: false, panel: true, migrated: 1, zhLines: false, stageOn: false },
    drSettings: { learnerLevel: 'B2', ai: { hintsModel: 'claude-haiku-5-5' } },
  }));
  await until(async () => (await sw.evaluate(() => chrome.storage.local.get('drLevel').then((o) => o.drLevel)))?.seeded >= 1, 20000);
  const page = await ctx.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const gate = await until(() => page.evaluate(() => { const h = document.getElementById('dr-level-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=check]')); }), 40000);
  ok('Level Check appears on the real YouTube page', !!gate, await page.title());
  if (!gate) throw new Error('no gate');
  await page.evaluate(() => document.getElementById('dr-level-host').shadowRoot.querySelector('[data-a=check]').click());
  const chips = await until(async () => { const c = await page.evaluate(() => { const r = document.getElementById('dr-level-host')?.shadowRoot; return r ? { chips: [...r.querySelectorAll('.chip')].map((b) => ({ t: b.textContent, g: b.dataset.g })), text: r.textContent.slice(-120) } : null; }); return c && (c.chips.length || /could not be read|no new words/.test(c.text)) ? c : null; }, 60000);
  ok('the test is built from the real subtitles', chips && chips.chips.length >= 5, JSON.stringify(chips && chips.chips.map((c) => `${c.g}:${c.t}`)));
  const subtitles = await page.evaluate(() => [...document.getElementById('dr-panel-host').shadowRoot.querySelectorAll('.s')].map((s) => s.textContent).join(' ').toLowerCase());
  ok('every chip is in this video\'s subtitles', chips && chips.chips.every((c) => subtitles.includes(c.t.toLowerCase())), `${subtitles.length} characters of subtitles`);
  await page.evaluate(() => document.getElementById('dr-level-host').shadowRoot.querySelector('.done').click());
  await until(() => page.evaluate(() => !document.getElementById('dr-level-host')), 8000);
  const lv = async () => page.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug).level; } catch (e) { return null; } });
  const dbg = await until(async () => { const l = await lv(); return l && l.total > 0 ? l : null; }, 20000);
  ok('at most 50% of this video\'s sentences are chosen', dbg && dbg.chosen <= dbg.total / 2 && dbg.chosen > 0, JSON.stringify(dbg));
  console.log(`STOP PERCENTAGE ON THE REAL VIDEO: ${dbg && dbg.chosen} of ${dbg && dbg.total} sentences = ${dbg ? Math.round(100 * dbg.chosen / dbg.total) : 0}%`);
  // (the screen's Play is a click in real use: here the player gets one too, when it did not start)
  await sleep(4000);
  await page.evaluate(() => { const v = document.querySelector('video'); if (v && v.paused) { v.muted = true; const m = document.getElementById('movie_player'); if (m && m.playVideo) m.playVideo(); else document.querySelector('.ytp-play-button')?.click(); } });
  const state = () => page.evaluate(() => { const v = document.querySelector('video'); return { t: v && +v.currentTime.toFixed(1), paused: v && v.paused, duration: v && Math.round(v.duration), ad: !!document.querySelector('.ad-showing') }; });
  // (the talk's first words are at 0:27: past any ad and the music)
  const played = await until(async () => { const s = await state(); return s.t > 0.5 && !s.paused && !s.ad; }, 90000);
  console.log('video:', JSON.stringify(await state()));
  if (!played) console.log('player state:', JSON.stringify(await page.evaluate(() => { const m = document.getElementById('movie_player'); const v = document.querySelector('video'); return { error: document.querySelector('.ytp-error')?.textContent?.slice(0, 200) ?? null, state: m && m.getPlayerState ? m.getPlayerState() : null, ready: v && v.readyState, src: v && !!v.src, ad: !!document.querySelector('.ad-showing') }; })));
  // (YouTube pauses automated browsers by itself, also with no extension at all: a play, then a pause at once)
  const t1 = (await state()).t;
  await sleep(6000);
  const keepsPlaying = played && !(await state()).paused && (await state()).t > t1 + 2;
  console.log(keepsPlaying ? 'the video keeps playing in this test browser' : 'NOTE: YouTube does not let this automated browser play the video, so stops on the real video cannot be tested here');
  if (keepsPlaying) {
    const stop = await until(async () => { const l = await lv(); return l && l.stops >= 2 ? l : null; }, 150000, 500);
    ok('stops happen on the real video, counted', !!stop, JSON.stringify({ level: await lv(), video: await state() }).slice(0, 600));
    ok('no AI call at those stops: the analysis wrote them', calls.stop === 0 && calls.analysis >= 1, JSON.stringify(calls));
    console.log('sentences stopped at:', JSON.stringify(((await lv()) || { stoppedAt: [] }).stoppedAt.slice(0, 4)));
    console.log('counter:', await page.evaluate(() => document.getElementById('dr-stop-counter')?.textContent));
  }
  await ctx.close();
  api.close();
  console.log(fails ? `${fails} FAILED` : 'REAL VIDEO: ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.message || e); process.exit(1); });
