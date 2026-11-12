// "Find me a video" (wish 17) and the lyrics (wishes 14 + 13) in the iPhone app's YouTube window, tested in WebKit.
// The app's own scripts run on a fake m.youtube.com (as in tests/ios-webkit-test.js: tests/ios-harness.js is the
// stand-in for the app's Swift side). What is new here, all on localhost:
//  - YouTube's search (/results), any video's player data (/youtubei/v1/player), its subtitles and a 100-second video;
//  - the AI for the three requests of these features (the ranking of a search, the name of a song, the notes of a
//    song); every other AI request of the tutor goes to the harness's fake AI as usual;
//  - the two free lyrics services (LRCLIB and lyrics.ovh), reached through the app's native fetch like the real ones.
// Checks: a search = exactly ONE AI request and 10 ranked rows; "My level" / a level only re-order (no request);
// the list is kept (finder closed and opened, the page loaded again); a tap plays a video of the list, its end opens
// the next one, Back / Next; the tutor off = no AI at all; lyrics mode: the lyrics from LRCLIB, "About this song",
// the headings, the highlighted lines, a tap shows the note with no AI request; kept (no second request);
// plain lyrics timed with the captions ("timing guessed"); no lyrics anywhere -> the paste box.
// Run ios/sync-scripts.sh first. Ports: the harness's (IOS_TEST_PORT) and FIND_PORT (8825).
const http = require('http');
const H = require('./ios-harness');
const { pw, ok, until, sleep, source, ytScripts, stores, keychain, apiLog } = H;
H.watchdog(8);
const api = H.startServer();
const PORT = +process.env.FIND_PORT || 8825;
const MINE = 'http://localhost:' + PORT;

// ---------- the fake YouTube ----------
const DUR = 100;
const wav = H.makeWav(DUR, true);
const POOL = Array.from({ length: 20 }, (_, i) => ({ id: 'vid' + String(i).padStart(8, '0'), title: `Black holes, talk number ${i + 1}`, channel: `Space Channel ${i % 4}` }));
const JUNK = [
  { id: 'short000001', title: 'Black hole in 30 seconds', channel: 'Clips', len: '0:30' },
  { id: 'china000001', title: '黑洞是什么？三分钟科学解释', channel: '科学', len: '3:00' },
  { id: 'music000001', title: 'Muse - Supermassive Black Hole (Official Music Video)', channel: 'Muse', len: '3:30' },
];
const searches = [];
const renderer = (v) => ({ videoWithContextRenderer: { videoId: v.id, headline: { runs: [{ text: v.title }] }, shortBylineText: { runs: [{ text: v.channel }] }, lengthText: { runs: [{ text: v.len || '1:40' }] },
  shortViewCountText: { runs: [{ text: '12K views' }] }, publishedTimeText: { runs: [{ text: '2 years ago' }] } } });
const searchHtml = (q) => {
  if (!searches.includes(q)) searches.push(q);
  const k = searches.indexOf(q);
  const hits = [...POOL.slice((k % 6) * 2, (k % 6) * 2 + 8), JUNK[k % JUNK.length]];
  return `<!doctype html><title>${q} - YouTube</title><script>var ytInitialData = ${JSON.stringify({ contents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: hits.map(renderer) } }] } } })};</script>`;
};
const EASY = ['Hello and welcome to my day.', 'I get up at seven in the morning.', 'I eat some bread and I drink a cup of tea.', 'Then I go to work by bus.', 'I like my work because the people are nice.', 'At lunch I eat with my friends.',
  'We talk about our families and our plans.', 'In the evening I go home and I cook dinner.', 'After dinner I read a book or I watch a film.', 'I go to bed at ten.', 'It is a simple day but I am happy.', 'What do you do every day?'];
const HARD = ['The epistemological ramifications of quantum decoherence remain contentious among theoreticians.', 'Proponents of the many-worlds interpretation postulate that the wavefunction never collapses.',
  'Adherents of objective-collapse theories invoke stochastic nonlinear modifications to the equation.', 'Entanglement entropy quantifies correlations between subsystems.', 'Its asymptotic scaling distinguishes gapped phases from critical ones.',
  'Renormalization group techniques elucidate universality.', 'Nonperturbative phenomena such as confinement resist analytic treatment.', 'Lattice simulations constitute an indispensable methodology for interrogating strongly coupled regimes.'];
// the songs
const SONG1 = ['I walk along the river in the morning', 'The water sings a song I used to know', 'Carry me home, carry me home', 'Over the hills where the wild winds blow', 'I packed my bag and I left the city',
  'Nobody saw me, nobody cried', 'Carry me home, carry me home', 'Over the hills where the wild winds blow', 'Paper boats on a silver sea', 'Carry me home'];
const SONG3 = ['Down the river road I go', 'Counting every stone I know', 'The moon is high, the night is slow', 'And all my troubles melt like snow', 'River road, take me away', 'I will come back another day'];
const PASTED = ['Nowhere is a place I know', 'Every street has the same old name', 'I keep walking in the yellow rain', 'Nowhere is where I belong'];
const lineAt = (i, first, step) => first + i * step;
const lrcStamp = (t) => `[${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}]`;
const VIDEOS = {
  song0000001: { title: 'The Testers - Paper Boats (Official Video) [4K]', author: 'TheTestersVEVO', lines: SONG1.map((t) => t.toLowerCase().replace(/,/g, '')), first: 10, step: 8 },
  song0000002: { title: 'Unknown Band - Nowhere Song', author: 'Unknown Band', lines: PASTED.map((t) => t.toLowerCase()), first: 20, step: 12 },
  song0000003: { title: 'Solo Singer - River Road (Lyrics)', author: 'Lyrics Lover', lines: SONG3.map((t) => t.toLowerCase().replace(/,/g, '')), first: 12, step: 9 },
};
const infoOf = (id) => VIDEOS[id] || { title: (POOL.find((v) => v.id === id) || {}).title || 'Dream Lesson', author: 'Space Channel', lines: null };
const json3Of = (id) => {
  const v = VIDEOS[id];
  if (v) return JSON.stringify({ events: v.lines.map((t, i) => ({ tStartMs: lineAt(i, v.first, v.step) * 1000, dDurationMs: 4000, segs: [{ utf8: t }] })) });
  const n = /^vid(\d+)$/.exec(id);
  const lines = n ? (Number(n[1]) % 2 === 0 ? EASY : HARD) : H.LINES;
  return JSON.stringify({ events: lines.map((t, i) => ({ tStartMs: i * 4000, dDurationMs: 4000, segs: [{ utf8: t }] })) });
};
const prOf = (id) => ({ videoDetails: { videoId: id, title: infoOf(id).title, author: infoOf(id).author, lengthSeconds: String(DUR), shortDescription: 'A video for the tests.' }, playabilityStatus: { status: 'OK' },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: H.tracksOf(id) } } });
const watchHtml = (id) => H.makeYtHtml(JSON.stringify(prOf(id))).replace(/Dream Lesson/g, infoOf(id).title.replace(/[<&]/g, ' ')) + '<script>var ytcfg_test = {"INNERTUBE_API_KEY":"test-innertube-key","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20260101.00.00"};</script>';
const idIn = (u) => (/[?&]v=([\w-]{11})/.exec(u) || [])[1] || '';

// ---------- the fake AI (the three requests of these features) and the two lyrics services ----------
const aiLog = [];   // { kind: 'rank' | 'songname' | 'song', user }
const lyrLog = [];  // the addresses asked of the lyrics services
const kindOfMine = (sys) => (/choose the best YouTube videos/.test(sys) ? 'rank' : /name the song in a YouTube video/.test(sys) ? 'songname' : /explain a song's lyrics and their meaning/.test(sys) ? 'song' : null);
let rankFails = false;
const answerFor = (kind, user) => {
  if (kind === 'rank') {
    if (rankFails) return 'Sorry, I cannot rank these.';
    // the last ten candidates, the last one first (so the order is clearly the AI's own, not YouTube's)
    const nums = [...user.matchAll(/(?:^|\n)(\d+)\. /g)].map((m) => Number(m[1]));
    return '```json\n' + JSON.stringify({ videos: nums.slice(-10).reverse().map((n) => ({ n, why: `Reason for video ${n}: it is clear and about your topic.`, level: 50 })) }) + '\n```';
  }
  if (kind === 'songname') return '{"artist":"","song":""}';
  const n = [...user.matchAll(/(?:^|\n)(\d+)\. /g)].length;
  const sections = [[1, 2, 'Verse 1'], [3, 4, 'Chorus'], [5, 6, 'Verse 2'], [7, 8, 'Chorus'], [9, n, 'Outro']].filter((s) => s[0] <= n).map(([from, to, name]) => ({ from, to: Math.min(to, n), name }));
  const notes = [[2, 'The river is like an old friend. Its sound brings back a song from when the singer was a child.'], [3, 'This is the heart of the song: the singer asks to be taken home, like a tired child.'],
    [6, 'Nobody noticed when they left. It shows how alone they felt in the city.'], [9, 'Paper boats are small and weak, like the hopes of the singer on a big sea.']].filter((x) => x[0] <= n).map(([line, note]) => ({ line, note }));
  return JSON.stringify({ about: 'This song is about going back home after a long time in the city. The singer feels small and tired, and the river and the hills are the places of their childhood.', sections, notes });
};
const sse = (res, text) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_find', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 300, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (const part of text.match(/[\s\S]{1,200}/g) || ['']) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 200 } });
  ev('message_stop', {});
  res.end();
};
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const mine = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, MINE);
    if (u.pathname === '/ai') {
      let j = {};
      try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not json */ }
      const sys = JSON.stringify(j.system || ''), user = (j.messages && j.messages[0] && typeof j.messages[0].content === 'string') ? j.messages[0].content : JSON.stringify(j.messages || '');
      const kind = kindOfMine(sys);
      aiLog.push({ kind, user, model: j.model });
      return sse(res, answerFor(kind, user));
    }
    lyrLog.push(u.pathname + u.search);
    if (u.pathname === '/lrclib/api/get') {
      if (u.searchParams.get('artist_name') === 'The Testers' && u.searchParams.get('track_name') === 'Paper Boats') {
        return json(res, 200, { id: 42, trackName: 'Paper Boats', artistName: 'The Testers', albumName: 'Rivers', duration: 100, instrumental: false, plainLyrics: SONG1.join('\n'), syncedLyrics: SONG1.map((t, i) => `${lrcStamp(lineAt(i, 10, 8))} ${t}`).join('\n') });
      }
      return json(res, 404, { code: 404, name: 'TrackNotFound', message: 'Failed to find specified track' });
    }
    if (u.pathname === '/lrclib/api/search') return json(res, 200, []);
    if (u.pathname === '/ovh/v1/Solo%20Singer/River%20Road' || decodeURIComponent(u.pathname) === '/ovh/v1/Solo Singer/River Road') return json(res, 200, { lyrics: `Paroles de la chanson River Road par Solo Singer\r\n${SONG3.slice(0, 4).join('\r\n')}\r\n\r\n${SONG3.slice(4).join('\r\n')}` });
    return json(res, 404, { error: 'No lyrics found' });
  });
}).listen(PORT);

// the app's native fetch for these tests: the lyrics services and the three AI requests go to the server above,
// everything else to the harness's stand-in (in the app all of them go through NativeFetch.swift)
const nativeUrls = [];
const aborts = {};
async function findNative(page, b) {
  nativeUrls.push(b.url);
  let target;
  const u = new URL(b.url);
  if (u.hostname === 'lrclib.net') target = `${MINE}/lrclib${u.pathname}${u.search}`;
  else if (u.hostname === 'api.lyrics.ovh') target = `${MINE}/ovh${u.pathname}${u.search}`;
  else if (u.hostname === 'api.anthropic.com') {
    let sys = '';
    try { sys = JSON.stringify(JSON.parse(Buffer.from(b.body || '', 'base64').toString('utf8')).system || ''); } catch (e) { /* not json */ }
    target = kindOfMine(sys) ? `${MINE}/ai` : H.FAKE + u.pathname + u.search;
  } else throw new Error('host not allowed: ' + u.hostname); // (as NativeFetch.swift says for any other address)
  const ctrl = new AbortController();
  aborts[b.id] = ctrl;
  const res = await fetch(target, { method: b.method, headers: b.headers, body: b.body ? Buffer.from(b.body, 'base64') : undefined, signal: ctrl.signal });
  const headers = {};
  res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/.test(k)) headers[k] = v; });
  (async () => {
    try {
      for await (const chunk of res.body) await page.evaluate(([id, s]) => window.__ytcFetchChunk(id, s), [b.id, Buffer.from(chunk).toString('base64')]);
      await page.evaluate((id) => window.__ytcFetchEnd(id), b.id);
    } catch (e) { await page.evaluate(([id, m]) => window.__ytcFetchEnd(id, m), [b.id, String(e.message || e)]).catch(() => {}); }
    delete aborts[b.id];
  })();
  return { status: res.status, statusText: res.statusText, headers };
}
const wrapNative = () => {
  const h = window.webkit.messageHandlers.ytc, orig = h.postMessage.bind(h);
  h.postMessage = (o) => (o && o.kind === 'nativeFetch' && /^https:\/\/(lrclib\.net|api\.lyrics\.ovh|api\.anthropic\.com)\//.test(o.url)
    ? window.__findNative(JSON.stringify(o)).then((r) => JSON.parse(r)) : orig(o));
};

(async () => {
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());
  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  await ctx.exposeBinding('__findNative', async ({ page }, j) => JSON.stringify(await findNative(page, JSON.parse(j))));
  await ctx.addInitScript(wrapNative);
  // (routes added later win over the harness's)
  await ctx.route('https://m.youtube.com/**', (route) => {
    const req = route.request(), u = req.url();
    if (u.includes('/v.wav')) {
      const rg = req.headers().range;
      if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], e = m[2] ? +m[2] : wav.length - 1; return route.fulfill({ status: 206, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${e}/${wav.length}` }, body: wav.slice(a, e + 1) }); }
      return route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' }, body: wav });
    }
    if (u.includes('/results?')) return route.fulfill({ status: 200, contentType: 'text/html', body: searchHtml(new URL(u).searchParams.get('search_query') || '') });
    if (u.includes('/youtubei/v1/player')) { let id = ''; try { id = JSON.parse(req.postData() || '{}').videoId || ''; } catch (e) { /* none */ } return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(prOf(id)) }); }
    if (u.includes('/api/timedtext')) return route.fulfill({ status: 200, contentType: 'application/json', body: json3Of(idIn(u)) });
    return route.fulfill({ status: 200, contentType: 'text/html', body: watchHtml(idIn(u) || 'vid00000019') });
  });

  const extras = (more = {}) => ({ phoneSet: true, view: 'listening', levelAsk: false, levelMode: false, tutorOn: true, fakeVoice: true, explainOnStop: true, panel: true, band: 'auto', talkAfterExplain: false, migrated: 9,
    stopGapSec: -1, capWords: 0, stopPhrasesOn: false, capPhrases: 0, capSentences: 0, stopSentences: false, stopItemsOn: false, stopHardOn: false, callEngine: 'claude', talkSilenceSec: 0, myLevel: 30, aiSentences: false, zhLines: false, ...more });
  Object.assign(stores.local, {
    barOn: true,
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 },
    drExtras: extras(),
    drSettings: { learnerLevel: 'B2', appearance: { showHints: false }, listen: { commandWindowMs: 1500, pauseAfterExplainMs: 500, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: false, autoExplainPhrases: false, lastSecondsWindow: 20 } },
  });
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });

  const yt = await ctx.newPage();
  yt.on('pageerror', (e) => console.log('PAGE ERROR', String(e.message || e).slice(0, 300)));
  // the app's scripts on every page it loads (= the app's WKUserScript at document end)
  yt.on('domcontentloaded', () => { yt.addScriptTag({ content: source(ytScripts) }).catch(() => {}); });
  const ev = async (fn, arg) => { try { return await yt.evaluate(fn, arg); } catch (e) { return null; } };
  const ready = () => until(() => ev(() => !!(window.__ytcDream && window.__ytcApi && window.__ytcApi.searchVideos)), 20000);
  const dbg = () => ev(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const act = (id) => ev((x) => window.__ytcDream.action(x), id);
  const here = () => idIn(yt.url());
  // FIND_SHOTS=<folder>: pictures of the screens on the way (to look at them)
  const shot = async (name) => { if (process.env.FIND_SHOTS) await yt.screenshot({ path: require('path').join(process.env.FIND_SHOTS, name + '.png') }).catch(() => {}); };
  // the tutor's own AI requests are over (nothing new for a moment)
  const quiet = async (ms = 1500) => { let n = -1, at = Date.now(); for (;;) { const now = apiLog.length + aiLog.length; if (now !== n) { n = now; at = Date.now(); } else if (Date.now() - at >= ms) return; await sleep(150); } };
  const aiTotal = () => apiLog.filter((r) => !/^azure/.test(r.kind)).length + aiLog.length;
  const count = (kind) => aiLog.filter((r) => r.kind === kind).length;
  // the finder (its own shadow DOM)
  const finder = (fn, arg) => ev(([f, a]) => { const h = document.getElementById('dr-finder-host'); return h ? (new Function('r', 'a', `return (${f})(r, a)`))(h.shadowRoot, a) : null; }, [fn.toString(), arg]);
  const rows = () => finder((r) => [...r.querySelectorAll('.list .vid')].map((b) => ({ id: b.dataset.id, rank: b.querySelector('.rk').textContent, title: b.querySelector('.t').textContent, why: b.querySelector('.why').textContent, lv: b.querySelector('.lv').textContent,
    now: b.classList.contains('now'), h: Math.round(b.getBoundingClientRect().height) })));
  const status = () => finder((r) => r.querySelector('.status').textContent);
  const search = async (text) => {
    await finder((r, t) => { const box = r.querySelector('textarea'); if (r.querySelector('.askbox').hidden) r.querySelector('[data-a=new]').click(); box.value = t; r.querySelector('[data-a=find]').click(); }, text);
  };

  // =====================================================================================================
  // A. Find me a video
  // =====================================================================================================
  if (process.env.FIND_ONLY !== 'lyrics') { // (FIND_ONLY=lyrics: only the lyrics part, for a quick look)
  await yt.goto('https://m.youtube.com/watch?v=vid00000019');
  ok('the app\'s page is ready (the tutor, the page API with YouTube search)', !!(await ready()));
  await until(async () => { const d = await dbg(); return d && d.sentences > 0; }, 20000);
  await quiet();
  ok('"Find" opens the finder: nothing kept yet, so it asks what you want', await act('find') === true && await finder((r) => !r.querySelector('.askbox').hidden && r.querySelector('[data-a=new]').hidden && r.querySelectorAll('.vid').length === 0) === true);

  const ai0 = aiTotal();
  await search('Please find me some videos about black holes.');
  const ten = await until(async () => { const x = await rows(); return x && x.length === 10 ? x : null; }, 20000);
  ok('a search shows 10 ranked rows (1 to 10)', !!ten && ten.map((x) => x.rank).join() === '1,2,3,4,5,6,7,8,9,10', JSON.stringify(ten && ten.map((x) => x.rank)));
  ok('the search made exactly ONE AI request (the one that picks and ranks)', aiTotal() - ai0 === 1 && count('rank') === 1, `all=${aiTotal() - ai0} rank=${count('rank')}`);
  ok('4 to 6 YouTube searches from the words, by fixed patterns (no AI): the topic, + explained, + …', searches.length >= 4 && searches.length <= 6 && searches[0] === 'black holes' && searches.includes('black holes explained'), JSON.stringify(searches));
  const prompt = aiLog.find((r) => r.kind === 'rank').user;
  const cands = [...prompt.matchAll(/(?:^|\n)(\d+)\. ([^|\n]+) \|/g)].map((m) => ({ n: Number(m[1]), title: m[2].trim() }));
  ok('the AI got the learner\'s words, the numbered candidates (18 here; no Short, no other language, no music video) and the level 0-100 with its 3 anchors',
    /black holes/.test(prompt) && cands.length === 18 && !/30 seconds|黑洞|Supermassive/.test(prompt) && /level is 30 on a line from 0/.test(prompt) && /20 = slow, simple talk; 55 = normal, clear talk; 85 = fast and dense/.test(prompt) && /12K views \| 2 years ago/.test(prompt), `candidates=${cands.length}`);
  const wantOrder = cands.slice(-10).reverse().map((c) => c.title);
  ok('the rows are in the AI\'s order (the best first), each with its reason', !!ten && ten.map((x) => x.title).join('|') === wantOrder.join('|') && ten.every((x, i) => x.why === `Reason for video ${cands.length - i}: it is clear and about your topic.`), JSON.stringify(ten && ten.slice(0, 2)));
  ok('every row is a big button (60 pt or more)', !!ten && ten.every((x) => x.h >= 60), JSON.stringify(ten && ten.map((x) => x.h)));
  ok('the level starts as the AI\'s guess ("Level about 50")', !!ten && ten.some((x) => /Level about 50/.test(x.lv)) || (await rows()).every((x) => /^Level \d+/.test(x.lv)), JSON.stringify(ten && ten[0].lv));
  // the levels are measured from the subtitles (no AI): even videos are easy talk, odd ones dense talk
  const measured = await until(async () => { const x = await rows(); return x && x.every((v) => /^Level \d+/.test(v.lv) && !/about/.test(v.lv)) && !/Checking/.test(await status()) ? x : null; }, 30000);
  const lvOf = (x) => Number((/Level (\d+)/.exec(x.lv) || [])[1]);
  const isEven = (x) => Number(x.id.slice(3)) % 2 === 0;
  ok('then each video\'s level is measured from its subtitles: a number 0-100 with "fits you" / "hard for you"', !!measured && measured.filter(isEven).every((x) => lvOf(x) <= 40 && /fits you|easy for you/.test(x.lv)) && measured.filter((x) => !isEven(x)).every((x) => lvOf(x) >= 65 && /hard for you/.test(x.lv)),
    JSON.stringify(measured && measured.map((x) => x.lv)));
  await shot('1-finder-list');
  ok('measuring the levels asked the AI nothing', aiTotal() - ai0 === 1, String(aiTotal() - ai0));
  ok('no A1-C2 chips any more; the order control is there (Best, My level, a level 0-100)', await finder((r) => !r.querySelector('.levels') && r.querySelectorAll('.ob').length === 2 && !!r.querySelector('.pick input[type=range]') && r.querySelector('.ob[data-o=best]').getAttribute('aria-pressed') === 'true') === true);

  // ---- the order: only an order ----
  const nSearch = searches.length;
  await finder((r) => r.querySelector('.ob[data-o=mine]').click());
  const mineOrder = await rows();
  const nEasy = measured ? measured.filter(isEven).length : 0;
  const byRank = (list) => list.map((x) => +x.rank).join() === list.map((x) => +x.rank).sort((a, b) => a - b).join();
  ok('"My level" (30) re-orders the same list: the videos that fit come first, by rank', !!mineOrder && nEasy >= 2 && nEasy <= 8 && mineOrder.slice(0, nEasy).every(isEven) && mineOrder.slice(nEasy).every((x) => !isEven(x)) && byRank(mineOrder.slice(0, nEasy)) && byRank(mineOrder.slice(nEasy))
    && mineOrder.map((x) => x.id).sort().join() === measured.map((x) => x.id).sort().join(), JSON.stringify(mineOrder && mineOrder.map((x) => x.rank + ':' + lvOf(x))));
  for (let i = 0; i < 12; i++) await finder((r) => r.querySelector('[data-o=up]').click()); // + twelve times: level 90
  const hardOrder = await rows();
  await shot('2-finder-level-90');
  ok('a chosen level (+ … 90) orders for that level: the dense videos first', !!hardOrder && hardOrder.slice(0, 10 - nEasy).every((x) => !isEven(x)) && hardOrder.slice(10 - nEasy).every(isEven) && await finder((r) => r.querySelector('.pick output').textContent) === 'Level 90', JSON.stringify(hardOrder && hardOrder.map((x) => lvOf(x))));
  await finder((r) => r.querySelector('.ob[data-o=best]').click());
  ok('"Best" brings back the first ranking', (await rows()).map((x) => x.title).join('|') === wantOrder.join('|'));
  ok('re-ordering made no AI request and no new search', aiTotal() - ai0 === 1 && searches.length === nSearch, `ai=${aiTotal() - ai0} searches=${searches.length - nSearch}`);

  // ---- the list is kept ----
  await finder((r) => r.querySelector('.ob[data-o=mine]').click());
  await finder((r) => r.querySelector('[data-a=close]').click());
  ok('the finder closes only when you close it', await ev(() => !document.getElementById('dr-finder-host')) === true);
  await act('find');
  const again = await until(async () => { const x = await rows(); return x && x.length === 10 ? x : null; }, 8000);
  ok('opened again: the same list, in the order you left ("My level"), with "New search" at the top', !!again && again.map((x) => x.id).join() === mineOrder.map((x) => x.id).join() && await finder((r) => !r.querySelector('[data-a=new]').hidden && r.querySelector('.askbox').hidden && /black holes/.test(r.querySelector('.newrow .q').textContent)) === true);
  await finder((r) => r.querySelector('.ob[data-o=best]').click());
  await until(() => stores.local.drFinderList && stores.local.drFinderList.order === 'best', 5000);
  const kept = stores.local.drFinderList;
  ok('it is in the app\'s storage: the words, when, the 10 videos with rank, why and level', !!kept && /black holes/.test(kept.query) && kept.at > 0 && kept.videos.length === 10 && kept.videos.every((v) => v.rank >= 1 && v.why && typeof v.level === 'number' && v.levelFrom === 'subs'), JSON.stringify(kept && kept.videos[0]));
  await yt.goto('https://m.youtube.com/watch?v=vid00000019'); // (the app closed and opened again: a new page, the same storage)
  await ready();
  await quiet();
  await act('find');
  const afterLoad = await until(async () => { const x = await rows(); return x && x.length === 10 ? x : null; }, 8000);
  ok('after the page (the app) was loaded again: still the same list, nothing asked', !!afterLoad && afterLoad.map((x) => x.title).join('|') === wantOrder.join('|') && aiTotal() - ai0 === 1 && searches.length === nSearch && afterLoad.every((x) => /^Level \d+/.test(x.lv)));

  // ---- the playlist ----
  const second = afterLoad[1], third = afterLoad[2], first = afterLoad[0];
  await finder((r, id) => r.querySelector(`.vid[data-id="${id}"]`).click(), second.id);
  await until(() => here() === second.id, 10000);
  await ready();
  ok('a tap on a row plays that video (the page goes to it)', here() === second.id && stores.local.drFinderList.playing === second.id, here());
  await quiet();
  await act('find');
  const marked = await until(async () => { const x = await rows(); return x && x.length === 10 ? x : null; }, 8000);
  ok('in the list the playing one is marked, with Back and Next', !!marked && marked.filter((x) => x.now).map((x) => x.id).join() === second.id && await finder((r) => !r.querySelector('.pl').hidden && !r.querySelector('[data-a=prev]').disabled && !r.querySelector('[data-a=next]').disabled && r.querySelector('.vid.now .nowtag').textContent.includes('Playing')) === true);
  await shot('3-finder-playing');
  await finder((r) => r.querySelector('[data-a=close]').click());
  // the video ends (really: the last half second plays out)
  const aiBeforeEnd = aiTotal();
  await ev(() => { const v = document.querySelector('video'); v.currentTime = v.duration - 0.4; v.play(); });
  let endedHow = 'the video played to its end';
  if (!(await until(() => here() === third.id, 9000))) { endedHow = 'an "ended" event was sent (the test video did not end by itself)'; await ev(() => document.querySelector('video').dispatchEvent(new Event('ended'))); await until(() => here() === third.id, 8000); }
  ok(`the video ended: the next one of the list opens by itself (${endedHow})`, here() === third.id, here());
  await ready();
  await until(async () => { const d = await dbg(); return d && d.sentences > 0; }, 20000);
  ok('the next video has the tutor running as usual, and the list knows it plays', ((await dbg()) || {}).mode === 'tutor' && stores.local.drFinderList.playing === third.id, JSON.stringify({ mode: ((await dbg()) || {}).mode, playing: stores.local.drFinderList.playing }));
  ok('going to the next video asked the AI nothing for the list', count('rank') === 1 && aiTotal() - aiBeforeEnd === aiLog.length + apiLog.filter((r) => !/^azure/.test(r.kind)).length - aiBeforeEnd);
  ok('the bar\'s "findPrev" goes back to the video before', await act('findPrev') === true && !!(await until(() => here() === second.id, 10000)), here());
  await ready();
  ok('the bar\'s "findNext" goes on to the next', await act('findNext') === true && !!(await until(() => here() === third.id, 10000)), here());
  await ready();
  // a video that is not from the list ends: YouTube's own business
  await yt.goto('https://m.youtube.com/watch?v=vid00000019');
  await ready();
  await ev(() => document.querySelector('video').dispatchEvent(new Event('ended')));
  await sleep(1200);
  ok('a video that was not opened from the list ends: nothing happens', here() === 'vid00000019', here());
  void first;

  // ---- the AI fails / the tutor is off ----
  await quiet();
  rankFails = true;
  const ai1 = aiTotal();
  await act('find');
  await until(async () => (await rows() || []).length === 10, 8000);
  await search('volcanoes');
  const fb = await until(async () => { const x = await rows(); return x && x.length === 10 && /could not rank/.test(await status() || '') ? x : null; }, 20000);
  ok('the AI\'s answer cannot be used: the first 10 in YouTube\'s order, said in one line; still only one request', !!fb && /The AI could not rank them now: this is YouTube's own order/.test(await status()) && aiTotal() - ai1 === 1 && fb.every((x) => x.why === ''), `${await status()} ai=${aiTotal() - ai1} fb=${JSON.stringify(fb && fb.map((x) => x.why))}`);
  ok('a new search replaced the kept list', /volcanoes/.test((stores.local.drFinderList || {}).query || '') && stores.local.drFinderList.ranked === 'search');
  rankFails = false;
  await finder((r) => r.querySelector('[data-a=close]').click());
  stores.local.drExtras = extras({ tutorOn: false });
  await yt.goto('https://m.youtube.com/watch?v=vid00000019');
  await ready();
  await quiet();
  const ai2 = aiTotal();
  await act('find');
  await until(async () => (await rows() || []).length === 10, 8000);
  await search('the history of tea');
  const off = await until(async () => { const x = await rows(); return x && x.length === 10 && /no AI/.test(await status() || '') ? x : null; }, 20000);
  await until(async () => !/Checking/.test(await status() || ''), 20000);
  ok('My tutor off: no AI at all, the first 10 by YouTube\'s order (levels still measured from the subtitles)', !!off && aiTotal() - ai2 === 0 && /My tutor is off/.test(await status()) && (await rows()).every((x) => /^Level \d+/.test(x.lv)), `ai=${aiTotal() - ai2} ${await status()}`);
  await finder((r) => r.querySelector('[data-a=close]').click());
  }

  // =====================================================================================================
  // B + C. The lyrics
  // =====================================================================================================
  const stage = (fn, arg) => ev(([f, a]) => { const h = document.getElementById('dr-stage-host'); return h ? (new Function('r', 'a', `return (${f})(r, a)`))(h.shadowRoot, a) : null; }, [fn.toString(), arg]);
  const lyricsOn = () => until(() => stage((r) => { const s = r.querySelector('.stage'); return s && s.dataset.lyrics === '1' && r.querySelectorAll('.page .s').length > 0; }), 25000);
  const dismissIntro = async () => { await until(() => stage((r) => { const b = r.querySelector('.songbox [data-act=play]'); if (b && r.querySelector('.songbox .songtext').textContent.length > 20) { b.click(); return true; } return !r.querySelector('.songbox') && null; }), 12000); };
  stores.local.drExtras = extras({ view: 'lyrics', tutorOn: true });
  const api3 = apiLog.length;
  await yt.goto('https://m.youtube.com/watch?v=song0000001');
  await ready();
  ok('lyrics mode: the page is the song\'s lyrics (10 lines)', !!(await lyricsOn()) && await stage((r) => r.querySelectorAll('.page .s').length) === 10);
  ok('found with LRCLIB\'s "get" by the cleaned title: artist "The Testers", song "Paper Boats", the video\'s length; one request, through the app\'s native fetch',
    lyrLog.length === 1 && /^\/lrclib\/api\/get\?artist_name=The(%20|\+)Testers&track_name=Paper(%20|\+)Boats&duration=100$/.test(lyrLog[0]) && nativeUrls.some((u) => u.startsWith('https://lrclib.net/api/get?')), JSON.stringify(lyrLog));
  const notesIn = await until(() => stage((r) => r.querySelectorAll('.page .lyr-h').length >= 5 && r.querySelectorAll('.page .s.lyr-noted').length > 0), 20000);
  // (the tutor's usual one-time jobs for any video, its hard words, phrases and sentences, are not this feature's; an explanation would be)
  const others = apiLog.slice(api3).filter((r) => !/^azure/.test(r.kind)).map((r) => r.kind);
  ok('ONE AI request for the song (its story, its parts, the notes); the title was clear, so no request for its name; no other request about the song', !!notesIn && count('song') === 1 && count('songname') === 0 && others.every((k) => ['hints', 'phrases', 'hard', 'split', 'zhlines'].includes(k)), `song=${count('song')} name=${count('songname')} the tutor's own jobs: ${others.join()}`);
  const songPrompt = aiLog.find((r) => r.kind === 'song').user;
  ok('the request has the numbered lyrics and asks for own words (no published annotations, a few quoted words at most)', /1\. I walk along the river in the morning/.test(songPrompt) && /10\. Carry me home/.test(songPrompt) && /Do not reproduce annotations/.test(songPrompt) && /"Paper Boats" by The Testers/.test(songPrompt));
  const intro = await until(() => stage((r) => { const b = r.querySelector('.songbox .songtext'); return b && b.textContent.length > 20 ? b.textContent : null; }), 8000);
  ok('before the song plays the tutor tells what it is about (the "about" text of that one request, said aloud)', !!intro && /going back home/.test(intro) && !!(await until(async () => ((await dbg()) || {}).spoken && (await dbg()).spoken.some((s) => /going back home/.test(s)), 8000)), intro);
  await dismissIntro();
  const page = await stage((r) => ({
    about: (r.querySelector('.page .lyr-about-t') || {}).textContent, aboutFirst: r.querySelector('.page .doc-inner').firstElementChild.className, aboutOpen: (r.querySelector('.page .lyr-about') || { dataset: {} }).dataset.open,
    heads: [...r.querySelectorAll('.page .lyr-h')].map((h) => h.textContent), noted: [...r.querySelectorAll('.page .s.lyr-noted')].map((s) => Number(s.dataset.lyrLine)),
    order: [...r.querySelectorAll('.page .lyr-h, .page .s')].map((e) => (e.classList.contains('lyr-h') ? e.textContent : 's')).join(' '), src: r.querySelector('.page .lyr-src').textContent,
    bg: getComputedStyle(r.querySelector('.page .s.lyr-noted')).backgroundColor, plainBg: getComputedStyle(r.querySelector('.page .s:not(.lyr-noted):not(.cur)')).backgroundColor,
    block: getComputedStyle(r.querySelector('.page .s')).display, aboutPx: parseFloat(getComputedStyle(r.querySelector('.page .lyr-about-t')).fontSize), pagePx: parseFloat(getComputedStyle(r.querySelector('.page')).fontSize),
  }));
  ok('"About this song" is at the top of the page, open, its text as big as the page lets it be', !!page && page.aboutFirst === 'lyr-about' && page.aboutOpen === '1' && /going back home/.test(page.about) && page.aboutPx >= page.pagePx * 0.75, JSON.stringify(page && { px: page.aboutPx, page: page.pagePx }));
  ok('the parts have their headings between the lines: [Verse 1] [Chorus] [Verse 2] [Chorus] [Outro]', !!page && page.heads.join(' ') === '[Verse 1] [Chorus] [Verse 2] [Chorus] [Outro]' && page.order === '[Verse 1] s s [Chorus] s s [Verse 2] s s [Chorus] s s [Outro] s s', page && page.order);
  ok('the lines with a note are highlighted (a soft background); the chorus that comes back is highlighted each time', !!page && page.noted.join() === '1,2,5,6,8' && page.bg !== page.plainBg && page.bg !== 'rgba(0, 0, 0, 0)' && page.block === 'block', JSON.stringify(page && { noted: page.noted, bg: page.bg, plain: page.plainBg }));
  ok('the bar says where the lyrics come from', !!page && /Paper Boats — The Testers · lyrics from LRCLIB$/.test(page.src), page && page.src);
  await shot('4-lyrics-page');
  // "About this song" closes and opens
  await sleep(700); // (a tap in the first 600 ms after the page appears is not taken: it may be the tap that opened it)
  await stage((r) => r.querySelector('.page [data-lyr=about]').click());
  ok('"About this song" closes with a tap', await stage((r) => getComputedStyle(r.querySelector('.page .lyr-about-t')).display) === 'none');
  await stage((r) => r.querySelector('.page [data-lyr=about]').click());
  // a tap on a highlighted line
  await quiet(1200);
  const ai4 = aiTotal();
  const spokenBefore = (((await dbg()) || {}).spoken || []).length;
  await stage((r) => { const s = r.querySelector('.page .s[data-lyr-line="5"]'); (s.querySelector('.w[data-lemma]') || s).click(); });
  const note = await until(() => stage((r) => { const n = r.querySelector('.page .lyr-note'); return n ? { text: n.textContent, after: n.previousElementSibling && n.previousElementSibling.dataset.lyrLine, open: !!r.querySelector('.page .s.lyr-open') } : null; }), 5000);
  await shot('5-lyrics-note');
  ok('a tap on a highlighted line opens its note right under the line', !!note && /Nobody noticed when they left/.test(note.text) && note.after === '5' && note.open, JSON.stringify(note));
  const said = await until(async () => { const d = await dbg(); return d && d.spoken && d.spoken.slice(spokenBefore).some((s) => /Nobody noticed when they left/.test(s)); }, 6000);
  ok('the tutor\'s voice reads the note', !!said, JSON.stringify(((await dbg()) || {}).spoken && (await dbg()).spoken.slice(spokenBefore)));
  await sleep(700);
  ok('the tap made NO AI request (the notes were written once for the whole song)', aiTotal() - ai4 === 0, String(aiTotal() - ai4));
  await stage((r) => { const s = r.querySelector('.page .s[data-lyr-line="5"]'); (s.querySelector('.w[data-lemma]') || s).click(); });
  ok('a second tap closes it', !!(await until(() => stage((r) => !r.querySelector('.page .lyr-note') && !r.querySelector('.page .s.lyr-open')), 4000)));
  // the chorus the second time has the note of the first time
  await stage((r) => r.querySelector('.page .s[data-lyr-line="6"]').click());
  ok('the chorus that comes back shows the same note (no request)', /heart of the song/.test((await until(() => stage((r) => (r.querySelector('.page .lyr-note') || {}).textContent), 4000)) || '') && aiTotal() - ai4 === 0);
  await stage((r) => r.querySelector('.page .lyr-note').click());
  // "Explain this sentence" (the E button of a line, the same request an automatic stop for a whole line makes):
  // a line that has a note is explained by its note, read by the tutor, with no AI request
  await quiet(1000);
  const apiE = apiLog.length, spokenE = (((await dbg()) || {}).spoken || []).length;
  await stage((r) => r.querySelector('.page .s[data-lyr-line="8"] .sx').click());
  const noteSaid = await until(async () => { const d = await dbg(); return d && d.spoken && d.spoken.slice(spokenE).some((x) => /Paper boats are small and weak/.test(x)); }, 20000);
  await until(async () => ((await dbg()) || {}).state !== 'explaining', 15000);
  await sleep(600);
  ok('explaining a whole line that has a note = the tutor reads the note (no AI request for it)', !!noteSaid && apiLog.slice(apiE).filter((r) => r.kind === 'explain').length === 0 && aiTotal() - ai4 === 0, `explain requests=${apiLog.slice(apiE).filter((r) => r.kind === 'explain').length} said=${!!noteSaid}`);
  // a line without a note: a tap on a word is the word's tap as before (the card)
  // (the explanation above plays the line again and shows the page anew: a tap in that moment is not taken, so it is tried again)
  let cardUp = null;
  for (let i = 0; i < 5 && !cardUp; i++) {
    await sleep(900);
    await stage((r) => { const s = r.querySelector('.page .s:not(.lyr-noted)'); s.querySelector('.w[data-lemma]').click(); });
    cardUp = await until(() => stage((r) => { const c = r.querySelector('.stage > .card'); return c && !c.hidden; }), 1500);
  }
  ok('a tap on a word of a line without a note still opens the word\'s card, as before', !!cardUp);
  await quiet();
  // kept: the page loaded again
  const ai5 = aiTotal(), lyr5 = lyrLog.length;
  await yt.goto('https://m.youtube.com/watch?v=song0000001');
  await ready();
  await lyricsOn();
  const keptNotes = await until(() => stage((r) => r.querySelectorAll('.page .lyr-h').length === 5 && r.querySelectorAll('.page .s.lyr-noted').length === 5 && !!r.querySelector('.page .lyr-about-t')), 15000);
  await dismissIntro();
  await quiet();
  ok('the same song again: the lyrics and the notes are kept (no lyrics request, no AI request for the song)', !!keptNotes && lyrLog.length === lyr5 && count('song') === 1 && aiLog.length === aiLog.filter((r) => r.kind).length && aiTotal() - ai5 === apiLog.filter((r) => !/^azure/.test(r.kind)).length - (ai5 - aiLog.length),
    `lyrics=${lyrLog.length - lyr5} song=${count('song')}`);

  // ---- plain lyrics from the second source, timed with the captions ----
  const lyr6 = lyrLog.length;
  await yt.goto('https://m.youtube.com/watch?v=song0000003');
  await ready();
  ok('a song LRCLIB does not have: lyrics.ovh gives its lyrics (6 lines)', !!(await lyricsOn()) && await stage((r) => r.querySelectorAll('.page .s').length) === 6 && lyrLog.slice(lyr6).some((u) => u.startsWith('/lrclib/api/search')) && /^\/ovh\/v1\/Solo%20Singer\/River%20Road$/.test(lyrLog[lyrLog.length - 1]), JSON.stringify(lyrLog.slice(lyr6)));
  ok('only the two free services were asked (never a lyrics website)', nativeUrls.filter((u) => !/^https:\/\/api\.anthropic\.com\//.test(u)).every((u) => /^https:\/\/(lrclib\.net\/api|api\.lyrics\.ovh\/v1)\//.test(u)), JSON.stringify([...new Set(nativeUrls.map((u) => new URL(u).hostname))]));
  const rec3 = await until(() => stores.local['drLyr:song0000003'], 5000);
  const starts3 = rec3 && rec3.lyrics ? rec3.lyrics.lines.map((l) => Math.round(l.start)) : [];
  ok('they have no times: each line is put where the captions hear it; the bar and the status say "timing guessed"', !!rec3 && rec3.lyrics.source === 'lyrics.ovh' && rec3.lyrics.timing === 'captions' && starts3.every((s, i) => Math.abs(s - (12 + i * 9)) <= 3)
    && /lyrics from lyrics\.ovh, timing guessed \(from the captions\)$/.test(await stage((r) => r.querySelector('.page .lyr-src').textContent)), JSON.stringify(starts3));
  await until(() => count('song') === 2, 10000);
  await dismissIntro();
  await quiet();

  // ---- no lyrics anywhere: the paste box ----
  const names0 = count('songname');
  await yt.goto('https://m.youtube.com/watch?v=song0000002');
  await ready();
  const none = await until(() => stage((r) => { const s = r.querySelector('.page .lyr-src.none'); return s ? { text: s.textContent, btn: r.querySelector('.page [data-lyr=paste]').textContent, h: r.querySelector('.page [data-lyr=paste]').getBoundingClientRect().height, lyrics: r.querySelector('.stage').dataset.lyrics } : null; }), 25000);
  ok('no lyrics anywhere: the page says so (the subtitles are shown) and offers "Paste the lyrics" (44 pt or more)', !!none && /No lyrics were found for this song/.test(none.text) && none.btn === 'Paste the lyrics' && none.h >= 44 && none.lyrics === '0', JSON.stringify(none));
  await shot('6-no-lyrics');
  ok('with the tutor on the AI was asked ONCE for the song\'s name (it knew none)', count('songname') - names0 === 1, String(count('songname') - names0));
  await sleep(700);
  await stage((r) => r.querySelector('.page [data-lyr=paste]').click());
  const box = (fn, arg) => ev(([f, a]) => { const h = document.getElementById('dr-lyrics-paste-host'); return h ? (new Function('r', 'a', `return (${f})(r, a)`))(h.shadowRoot, a) : null; }, [fn.toString(), arg]);
  const boxUp = await until(() => box((r) => ({ title: r.querySelector('h2').textContent, area: r.querySelector('textarea').getBoundingClientRect().height, use: r.querySelector('[data-a=use]').getBoundingClientRect().height, label: r.querySelector('[data-a=use]').textContent })), 5000);
  await shot('7-paste-box');
  ok('the paste box: a big text box and "Use these lyrics" (60 pt)', !!boxUp && boxUp.title === 'Paste the lyrics' && boxUp.area >= 150 && boxUp.use >= 60 && boxUp.label === 'Use these lyrics', JSON.stringify(boxUp));
  await box((r) => r.querySelector('[data-a=use]').click());
  ok('an empty box is not used', /Paste or type the lyrics first/.test(await box((r) => r.querySelector('.status').textContent) || ''));
  await box((r, t) => { r.querySelector('textarea').value = t; r.querySelector('[data-a=use]').click(); }, `[Verse 1]\n${PASTED.slice(0, 2).join('\n')}\n\n${PASTED.slice(2).join('\n')}`);
  const pastedOn = await until(() => stage((r) => { const s = r.querySelector('.stage'); return s && s.dataset.lyrics === '1' && r.querySelectorAll('.page .s').length === 4 ? r.querySelector('.page .lyr-src').textContent : null; }), 20000);
  ok('pasted lyrics are the page now (4 lines), timed like found ones, and the box is gone', !!pastedOn && /your own lyrics, timing guessed/.test(pastedOn) && await ev(() => !document.getElementById('dr-lyrics-paste-host')) === true, pastedOn);
  const rec2 = stores.local['drLyr:song0000002'];
  ok('they are kept for this video', !!rec2 && rec2.lyrics && rec2.lyrics.source === 'pasted' && rec2.lyrics.lines.length === 4 && rec2.aiName === null, JSON.stringify(rec2 && { src: rec2.lyrics && rec2.lyrics.source, aiName: rec2.aiName }));
  await until(() => count('song') === 3, 10000);
  await dismissIntro();
  await quiet();
  const names1 = count('songname'), lyr7 = lyrLog.length;
  await yt.goto('https://m.youtube.com/watch?v=song0000002');
  await ready();
  await lyricsOn();
  await quiet();
  ok('the same video again: your lyrics are used, nothing is searched and the song\'s name is not asked again', await stage((r) => r.querySelectorAll('.page .s').length) === 4 && count('songname') === names1 && lyrLog.length === lyr7 && count('song') === 3, `names=${count('songname') - names1} lyrics=${lyrLog.length - lyr7} song=${count('song')}`);

  ok('the page itself never asked the AI or the lyrics services (everything went through the app\'s native fetch)', ctx.pageHits.filter((u) => !/localhost/.test(u)).length === 0 && ctx.pageHits.length === 0, JSON.stringify(ctx.pageHits.slice(0, 3)));

  await browser.close();
  api.close();
  mine.close();
  console.log(H.fails() ? `\n${H.fails()} FAILED` : '\nALL PASSED');
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  the test itself broke: ' + (e && e.stack || e)); process.exit(1); });
