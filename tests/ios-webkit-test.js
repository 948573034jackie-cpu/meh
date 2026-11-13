// My tutor in the iPhone / iPad app (YT Learn), tested in WebKit (the iPhone's engine) without Xcode.
// A fake m.youtube.com page gets exactly the scripts the app puts into its YouTube window (the same files, in the same
// order: read from AppModel.swift), and a stand-in for the app's Swift side (window.webkit.messageHandlers.ytc) answers
// from Node like Bridge.swift does: the JSON store, the Keychain, URLSession fetches streamed back in pieces
// (NativeFetch.swift), the app's own files (ytlearn://app/…), the iOS voice (AVSpeechSynthesizer) and the microphone.
// The AI and Microsoft are a fake server on localhost; the tutor itself calls the real addresses (api.anthropic.com, …),
// which only the stand-in for Swift sends to the fake server.
// Checks: subtitles -> complete sentences (AI), the dictionary, the panel under the player, a stop with "I don't know"
// from the app's button, the explanation streamed and spoken, the pause flow, a Claude call through the iOS microphone,
// "let's go", the keys only in the Keychain, the iOS voice, the Microsoft voice request, the settings page in the sheet.
// Run ios/sync-scripts.sh first (the CI does).
// The fake video, the fake AI, the stand-in for Swift and the app's window are in tests/ios-harness.js.
const path = require('path');
const fs = require('fs');
const http = require('http');
const PAGES_PORT = (+process.env.IOS_TEST_PORT || 8791) + 1;
const H = require('./ios-harness');
const { pw, IOS, BUILT, MIME, ok, until, sleep, source, ytScripts, sheetScripts, LINES, ttsWav, apiLog, nativeLog, fetchLog, stores, keychain, vocabWrites } = H;
H.watchdog(6);
const api = H.startServer();

(async () => {
  const browser = await pw.webkit.launch();
  console.log('engine: webkit', browser.version());
  ok('the app has the newest tutor (ios/sync-scripts.sh copied the built files)', ['dream-yt.js'].every((f) => fs.readFileSync(path.join(IOS, 'Scripts', f), 'utf8') === fs.readFileSync(path.join(BUILT, f), 'utf8'))
    && fs.readFileSync(path.join(IOS, 'Scripts', 'dream-bg.js'), 'utf8').includes(fs.readFileSync(path.join(BUILT, 'dream-bg.js'), 'utf8'))
    && fs.existsSync(path.join(IOS, 'Web/dream/dict.json.gz')), JSON.stringify(ytScripts));
  ok('the app tells the page its device (iPhone or iPad: window.__ytcDevice, at document start)', /window\.__ytcDevice=/.test(H.swift) && /userInterfaceIdiom == \.pad/.test(H.swift));

  const ctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone' });
  const pageHits = ctx.pageHits; // (the page asking the services itself: it must not)

  // what the app has saved before (the tutor on, test-friendly timings); the Claude key is in the Keychain
  Object.assign(stores.local, {
    barOn: true,
    drLevel: { tests: [], currentLevel: '', log: {}, seeded: 99 }, // (no starting data: these tests have their own words)
    drExtras: { capWords: 100, stopPhrasesOn: true, capPhrases: 100, capSentences: 0, phoneSet: true, view: 'listening', levelAsk: false, levelMode: false, tutorOn: true, fakeVoice: true, explainOnStop: true, panel: true, band: 'auto', talkAfterExplain: false, migrated: 1, stopGapSec: 0, callEngine: 'claude', talkSilenceSec: 0, stopSentences: false },
    drSettings: { learnerLevel: 'B2', listen: { commandWindowMs: 2500, pauseAfterExplainMs: 800, wordRepeats: 1, repeatWindowWords: 500, autoExplainWords: true, autoExplainPhrases: true, lastSecondsWindow: 20 } },
  });
  keychain.drKeys = JSON.stringify({ anthropic: 'sk-ant-test-key' });

  const yt = await ctx.newPage();
  yt.on('pageerror', (e) => console.log('PAGE ERROR', String(e.message || e).slice(0, 300)));
  await yt.goto('https://m.youtube.com/watch?v=ios00000001');
  await yt.addScriptTag({ content: source(ytScripts) }); // = the app's WKUserScript at document end
  const dbg = () => yt.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const vstate = () => yt.evaluate(() => { const v = document.querySelector('video'); return { t: +v.currentTime.toFixed(2), paused: v.paused }; });
  const spoken = () => dbg().then((d) => (d && d.spoken) || []);
  const act = (id) => yt.evaluate((x) => window.__ytcDream.action(x), id);
  // what Swift sends when SFSpeechRecognizer heard something: the words so far, then the closed sentence, then the end
  // (only while the page's listener has the microphone, as on the phone)
  const hear = async (text) => {
    const has = await until(() => yt.evaluate(() => !!window.__ytcActiveSR), 8000, 100);
    await yt.evaluate((t) => { window.__ytcSpeech({ type: 'result', text: t.split(' ').slice(0, 2).join(' '), final: false }); window.__ytcSpeech({ type: 'result', text: t, final: true }); window.__ytcSpeech({ type: 'end' }); }, text);
    return has;
  };

  const shim = await yt.evaluate(() => ({ id: chrome.runtime.id, update: chrome.runtime.getManifest().update_url, url: chrome.runtime.getURL('dream/dict.json.gz'), dream: !!window.__ytcDream, action: typeof (window.__ytcDream && window.__ytcDream.action) }));
  ok('the shims: the tutor runs, its files come from ytlearn://app/, no self-update, the app\'s buttons can drive it', shim.dream && shim.id && shim.update === 'ios' && shim.url === 'ytlearn://app/dream/dict.json.gz' && shim.action === 'function', JSON.stringify(shim));

  // ---- 1. the AI reads the video: complete sentences, through Swift's fetch, streamed ----
  const ready = await until(async () => { const d = await dbg(); return d && d.sentences === 10 && d.split === 'ai' ? d : null; }, 30000);
  ok('the AI rebuilt the subtitles into 10 complete sentences', !!ready, JSON.stringify(await dbg()).slice(0, 400));
  const msg = fetchLog.find((f) => f.url === 'https://api.anthropic.com/v1/messages');
  ok('the AI was asked by Swift (URLSession) at api.anthropic.com, with the key from the Keychain, the answer streamed in pieces',
    msg && msg.headers['x-api-key'] === 'sk-ant-test-key' && fetchLog.some((f) => f.chunks > 1), JSON.stringify(fetchLog.slice(0, 3).map((f) => ({ url: f.url, chunks: f.chunks }))));
  ok('the page itself fetched nothing from the AI services (every request went through Swift)', fetchLog.length >= 2 && !pageHits.length, JSON.stringify(pageHits.slice(0, 3)));
  const look = await yt.evaluate(() => { const host = document.getElementById('dr-panel-host'); const r = host && host.shadowRoot; const w = r && r.querySelector('.w[data-lemma="meticulous"]'); return host ? { after: host.previousElementSibling && host.previousElementSibling.id, h: host.getBoundingClientRect().height, lines: r.querySelectorAll('.s').length, hard: !!(w && w.classList.contains('hl-unknown')), text: r.textContent.includes('She checked every small detail, twice.') } : null; });
  ok('the panel sits under the player (the phone page has no right column), the AI\'s sentences in it', look && look.after === 'player-container-id' && look.h > 250 && look.lines === 10 && look.text, JSON.stringify(look));
  ok('the dictionary came from the app (ytlearn://app/dream/dict.json.gz): "meticulous" is above B2', look && look.hard && nativeLog.some((l) => l.kind === 'resource' && l.path === 'dream/dict.json.gz'), JSON.stringify(nativeLog.filter((l) => l.kind === 'resource')));
  const hint = await until(() => yt.evaluate(() => { const w = document.getElementById('dr-panel-host').shadowRoot.querySelector('.w[data-lemma="gregarious"]'); return w && w.dataset.hint === '爱交际的' ? w.dataset.hint : null; }), 10000);
  ok('the AI\'s Chinese meaning of a hard word is written under it', hint === '爱交际的', hint);

  // ---- 2. a stop at "meticulous"; the app's "I don't know" button: explained (streamed, spoken), the sentence again, on ----
  await yt.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 0; return v.play(); });
  const win = await until(async () => { const d = await dbg(); return d && d.window && d.window.target === 'meticulous' ? d : null; }, 20000);
  const v1 = await vstate();
  ok('the video stopped at "meticulous", the word said, the page shows the part', win && v1.paused && v1.t > 5 && v1.t < 8 && win.spoken.includes('meticulous') && win.stage.shown, JSON.stringify({ v1, spoken: win && win.spoken, stage: win && win.stage }));
  ok('the app\'s "I don\'t know" button works', await act('dontKnow') === true);
  const exp = await until(async () => (await spoken()).some((x) => /very careful/.test(x)), 12000);
  ok('the explanation was streamed and spoken', !!exp, JSON.stringify((await spoken()).slice(-4)));
  const on = await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && v.t > 8 && !d.window && !d.flow ? v : null; }, 20000, 100);
  ok('then the video goes on', !!on, JSON.stringify(await vstate()));
  const entry = await until(() => { const e = stores.local.drEntries; return e && e.meticulous ? e.meticulous : null; }, 8000);
  ok('"meticulous" is in My Vocabulary, saved in the app\'s JSON store', entry && /very careful/.test(entry.explanation), JSON.stringify(entry).slice(0, 160));
  // the next stop ("ephemeral"; not the short window after "meticulous", which can still open as the video goes on)
  await until(async () => { const d = await dbg(); return d.window && d.window.target !== 'meticulous'; }, 15000);
  await act('know');
  await until(async () => !(await vstate()).paused, 6000);

  // ---- 2b. one vocabulary database with the Mac: the shared file's words came in, the app's words go out ----
  const sharedIn = await until(() => { const w = stores.local.drVocab && stores.local.drVocab.words; return w && w.serendipity === 'known' && w.flabbergast === 'learning' ? w : null; }, 8000);
  ok('the Mac\'s words from the shared file are in the app: known and still learning (merged, nothing lost)', !!sharedIn, JSON.stringify(stores.local.drVocab && { s: stores.local.drVocab.words.serendipity, f: stores.local.drVocab.words.flabbergast }));
  const written = await until(() => vocabWrites.find((d) => d && d.known.some((k) => k.item === 'serendipity') && d.stillLearning.some((l) => l.item === 'meticulous')), 8000, 200);
  ok('the app writes the merged file back to the shared folder: the Mac\'s words and "meticulous" from this video, both tests', !!written && written.tests.length === 1 && written.stillLearning.some((l) => l.item === 'flabbergasted' && /flabbergasted/.test(l.sentence)), JSON.stringify(written && { k: written.known.length, l: written.stillLearning.length, t: written.tests.length }));
  const dbSt = await until(() => { const s = stores.local.drDbStatus; return s && s.ok && s.phone && s.shared ? s : null; }, 5000);
  ok('the file status says: saved in the shared folder "MEH English"', !!dbSt && dbSt.folder === 'MEH English' && dbSt.sharedOk === true, JSON.stringify(dbSt));

  // a word ignored here stays ignored (the file still has it), and goes out of the shared file
  await yt.evaluate(() => chrome.storage.local.get('drVocab').then((o) => chrome.storage.local.set({ drVocab: { ...o.drVocab, words: { ...o.drVocab.words, flabbergast: 'ignored' } } })));
  const ignoredOut = await until(() => (H.vocabShared.removed || []).some((r) => r.item === 'flabbergasted') && !H.vocabShared.stillLearning.some((l) => l.item === 'flabbergasted'), 8000, 200);
  await sleep(600);
  ok('a word ignored in the app stays ignored after the next merge, and the shared file drops it (the Mac is told)', !!ignoredOut && stores.local.drVocab.words.flabbergast === 'ignored', JSON.stringify({ st: stores.local.drVocab.words.flabbergast, removed: H.vocabShared.removed }));
  const writesNow = vocabWrites.length;
  await sleep(1500);
  ok('...and the merge settles (no endless writing)', vocabWrites.length === writesNow, `${vocabWrites.length - writesNow} more writes`);

  // ---- 3. you pause: the part plays again, then it is explained (the whole part), back to its start ----
  await until(async () => (await vstate()).t > 17, 20000, 100);
  const nP = apiLog.length;
  // (a pause right after a stop, or right after the microphone went on or off, is not "you paused": wait for a quiet moment)
  await until(async () => { const d = await dbg(); if (!d || d.window || d.state !== 'playing') return false; await sleep(2000); const e = await dbg(); return !e.window && e.state === 'playing'; }, 40000, 100);
  await yt.evaluate(() => document.querySelector('video').pause());
  const part = await until(async () => { const d = await dbg(); return d && d.flow === 'part' && d.stage.shown ? d : null; }, 8000);
  ok('pausing: the book stays (all the subtitles, one text size), the last 20 s marked as the part', part && part.stage.view === 'all' && part.stage.part >= 4 && part.stage.visibleLines === 10 && part.stage.size === '21px', JSON.stringify(part && part.stage));
  const passage = await until(() => apiLog.slice(nP).find((r) => r.kind === 'explain' && /The learner just paused the video/.test(r.user)), 25000);
  ok('after the replay the teacher explains the part (your rules)', !!passage);
  const spokePart = await until(async () => (await spoken()).some((x) => /counts the sentences/.test(x)), 12000);
  ok('the part\'s explanation is spoken', !!spokePart);
  await until(async () => { const v = await vstate(); const d = await dbg(); return !v.paused && !d.flow; }, 20000, 100);

  // ---- 4. 📞 the Claude call through the iOS microphone; "let's go" ----
  await yt.evaluate(() => document.querySelector('video').pause());
  await sleep(500);
  await act('goOn');
  await sleep(500);
  await until(async () => !(await dbg()).flow, 8000);
  const nC = apiLog.length;
  const micBefore = nativeLog.filter((l) => l.kind === 'speech' && l.op === 'start').length;
  ok('the app\'s 📞 button opens the call', await act('talk') === true);
  const greeted = await until(async () => { const d = await dbg(); return d && d.talk && d.talk.chat && d.talk.log.some((l) => /^tutor: /.test(l)) ? d : null; }, 10000);
  ok('the tutor greets you', !!greeted, JSON.stringify((await dbg()).talk));
  const listening = await until(async () => (await dbg()).talk?.chat === 'listening' && nativeLog.filter((l) => l.kind === 'speech' && l.op === 'start').length > micBefore, 10000);
  ok('the iOS microphone (SFSpeechRecognizer) was turned on for the call', !!listening, JSON.stringify(nativeLog.filter((l) => l.kind === 'speech').slice(-4)));
  await sleep(1200); // (the first moment after the tutor spoke is not taken as an answer: its own echo)
  const micOpen = await hear('what does gregarious mean');
  const chatReq = await until(() => apiLog.slice(nC).find((r) => r.kind === 'chat' && /gregarious/.test(r.user)), 10000);
  ok('what iOS heard went to Claude', micOpen && !!chatReq, JSON.stringify({ micOpen, talk: (await dbg()).talk }));
  const answered = await until(async () => { const d = await dbg(); return (d.spoken || []).some((x) => /Gregarious means friendly/.test(x)); }, 12000);
  ok('Claude\'s answer is spoken', !!answered);
  await until(async () => { const ev = (await dbg()).talk?.events || []; return ev.length && /said \(ended\)/.test(ev[ev.length - 1]); }, 15000);
  await sleep(1200);
  await until(async () => nativeLog.filter((l) => l.kind === 'speech' && l.op === 'start').length > micBefore + 1 || (await dbg()).talk?.chat === 'listening', 8000);
  await sleep(1200);
  await hear('ok let\'s go');
  const back = await until(async () => { const d = await dbg(); const v = await vstate(); return !d.talk && !v.paused ? v : null; }, 10000);
  ok('"let\'s go": the call ends and the video plays on', !!back, JSON.stringify({ talk: (await dbg()).talk, v: await vstate() }));

  // ---- 4b. a call turns the microphone on (the tutor listens only while it waits for you), and off again after ----
  const talkBar = () => yt.evaluate(() => { const b = document.getElementById('dr-panel-host').shadowRoot.querySelector('.talk .tstate'); return b ? b.textContent : ''; });
  await until(() => yt.evaluate(() => !window.__ytcActiveSR), 5000, 100);
  const micOff = nativeLog.filter((l) => l.kind === 'speech' && l.op === 'start').length;
  await act('talk');
  const callMic = await until(async () => (await dbg()).callOpen === true && nativeLog.filter((l) => l.kind === 'speech' && l.op === 'start').length > micOff, 8000);
  ok('📞: the call turns the iOS microphone on', !!callMic, JSON.stringify(nativeLog.filter((l) => l.kind === 'speech').slice(-3)));
  const endBtn = () => yt.evaluate(() => { const b = document.getElementById('dr-end-call'); return b ? b.textContent : ''; });
  const yourTurn = await until(async () => /End call/.test(await endBtn()), 12000);
  ok('...and only one button is shown: "End call"', !!yourTurn, await endBtn());
  await sleep(1200);
  await hear('ok let\'s go');
  await until(async () => { const d = await dbg(); const v = await vstate(); return !d.talk && !v.paused; }, 10000);
  const micShut = await until(() => yt.evaluate(() => !window.__ytcActiveSR), 5000, 100);
  ok('the call is over: the microphone is off again', !!micShut);

  // ---- 5. the keys: only in the Keychain; a new key saved in ⚙ goes there too ----
  await yt.evaluate(() => chrome.storage.local.get('drKeys').then((o) => chrome.storage.local.set({ drKeys: { ...o.drKeys, azure: 'azure-test-key-1234' } })));
  const kc = JSON.parse(keychain.drKeys || '{}');
  ok('the API keys are only in the Keychain, never in the app\'s JSON store', kc.anthropic === 'sk-ant-test-key' && kc.azure === 'azure-test-key-1234' && !('drKeys' in stores.local) && !JSON.stringify(stores).includes('sk-ant-test-key'), JSON.stringify(Object.keys(stores.local)));

  // ---- 6. the Microsoft voice: the request is right and the sound comes back whole ----
  const nA = apiLog.length;
  const tts = await yt.evaluate(() => chrome.runtime.sendMessage({ type: 'dream-tts', engine: 'azure', text: 'Hello there, my friend.', voice: 'en-GB-AdaMultilingualNeural', lang: 'en' }));
  const az = apiLog.slice(nA).find((r) => r.kind === 'azure');
  const azf = fetchLog.find((f) => /tts\.speech\.microsoft\.com\/cognitiveservices\/v1$/.test(f.url));
  ok('Microsoft (Azure) voice: SSML with the chosen voice, the key header, mp3 asked; the sound came back through Swift',
    az && /<voice name="en-GB-AdaMultilingualNeural">/.test(az.ssml) && azf && azf.headers['ocp-apim-subscription-key'] === 'azure-test-key-1234' && /mp3/.test(azf.headers['x-microsoft-outputformat'] || '') && tts && tts.b64 && Buffer.from(tts.b64, 'base64').length === ttsWav.length,
    JSON.stringify({ url: azf && azf.url, headers: azf && azf.headers, got: tts && (tts.error || (tts.b64 || '').length) }));

  // a busy Microsoft server: tried again by itself, the good voice goes on
  H.failAzure(1);
  const nB = apiLog.length;
  const busy = await yt.evaluate(() => chrome.runtime.sendMessage({ type: 'dream-tts', engine: 'azure', text: 'Another sentence for the voice.', voice: 'en-GB-AdaMultilingualNeural', lang: 'en' }));
  const tries = apiLog.slice(nB).filter((r) => r.kind === 'azure');
  ok('a busy Microsoft server (one failed answer) is tried again: the sound comes back', tries.length === 2 && tries[0].failed && busy && busy.b64 && !busy.error, JSON.stringify({ tries: tries.length, got: busy && (busy.error || (busy.b64 || '').length) }));

  // ---- 7. the app's other buttons: My Vocabulary opens in the app's sheet; ⚙ quick settings ----
  await act('vocab');
  ok('📒 opens My Vocabulary in the app (ytlearn://app/dream/vocab.html)', !!(await until(() => nativeLog.find((l) => l.kind === 'openPage' && /ytlearn:\/\/app\/dream\/vocab\.html/.test(l.url)), 3000)));
  const quick = await act('quick') === true && await yt.evaluate(() => {
    const q = document.getElementById('dr-stage-host').shadowRoot.querySelector('.stage > .quick');
    if (!q || q.hidden) return null;
    const first = q.querySelector('section.first'), adv = q.querySelector('details.adv'), lv = q.querySelector('input[data-name="myLevel"]');
    const r = lv.getBoundingClientRect(), b = q.querySelector('.q-body').getBoundingClientRect();
    return { first: first.textContent, adv: adv.textContent, advOpen: adv.open, level: { min: lv.min, max: lv.max, value: lv.value, wide: r.width >= b.width * 0.85, h: r.height }, switches: ['stopItemsOn', 'stopPhrasesOn', 'stopHardOn'].map((n) => !!first.querySelector(`.seg[data-name="${n}"]`)), oldShares: q.querySelectorAll('[data-name="capWords"], [data-name="capPhrases"], [data-name="capSentences"], .seg[data-name="level"]').length };
  });
  ok('⚙ opens the settings over the book: the first page is short: the tutor\'s volume, ONE text size, ONE long level slider 0 to 100, the three switches (Words, Phrases, Sentences), Explain 10 / 20 / 30 s, the mode, the voice',
    !!quick && /Tutor volume/.test(quick.first) && /Text size/.test(quick.first) && /My level/.test(quick.first) && /0 = easiest · 100 = hardest/.test(quick.first) && quick.level.min === '0' && quick.level.max === '100' && quick.level.value === '50' && quick.level.wide && quick.level.h >= 44
    && quick.switches.every(Boolean) && /Words/.test(quick.first) && /Phrases/.test(quick.first) && /Sentences/.test(quick.first) && /10 s/.test(quick.first) && /30 s/.test(quick.first) && /Mode/.test(quick.first) && /Tutor's voice/.test(quick.first) && quick.oldShares === 0, JSON.stringify(quick && { level: quick.level, sw: quick.switches, old: quick.oldShares, first: quick.first.slice(0, 200) }));
  ok('...everything else is under "Advanced" (closed at first): explanations, letters, the play line, the sleep timer, the microphone, the keys',
    !!quick && quick.advOpen === false && /Explanations/.test(quick.adv) && /Mid/.test(quick.adv) && /Letters/.test(quick.adv) && /Play line/.test(quick.adv) && /Sleep timer/.test(quick.adv) && /Low/.test(quick.adv) && /High/.test(quick.adv) && /Show what the tutor says as text/.test(quick.adv) && /Word test before each video/.test(quick.adv) && /API keys/.test(quick.adv), String(quick && quick.adv).slice(0, 200));
  // the level slider moved: saved at once, and the school level the prompts use follows it
  await yt.evaluate(() => { const lv = document.getElementById('dr-stage-host').shadowRoot.querySelector('.stage > .quick input[data-name="myLevel"]'); lv.value = '80'; lv.dispatchEvent(new Event('input', { bubbles: true })); });
  const lvSaved = await until(() => stores.local.drExtras && stores.local.drExtras.myLevel === 80 && stores.local.drSettings && stores.local.drSettings.learnerLevel === 'C1', 4000);
  ok('...the level slider moved to 80: saved at once (my level 80; the prompts speak to a C1 learner)', !!lvSaved, JSON.stringify({ my: stores.local.drExtras && stores.local.drExtras.myLevel, cefr: stores.local.drSettings && stores.local.drSettings.learnerLevel }));
  await yt.evaluate(() => { const lv = document.getElementById('dr-stage-host').shadowRoot.querySelector('.stage > .quick input[data-name="myLevel"]'); lv.value = '50'; lv.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(() => stores.local.drExtras.myLevel === 50 && stores.local.drSettings.learnerLevel === 'B2', 4000);
  // sentences off: saved at once
  await yt.evaluate(() => { const q = document.getElementById('dr-stage-host').shadowRoot.querySelector('.stage > .quick'); q.querySelector('.seg[data-name="stopHardOn"] button[data-v="off"]').click(); });
  ok('...whole sentences can be turned off', !!(await until(() => stores.local.drExtras && stores.local.drExtras.stopHardOn === false, 4000)), JSON.stringify(stores.local.drExtras && stores.local.drExtras.stopHardOn));
  await yt.evaluate(() => { const q = document.getElementById('dr-stage-host').shadowRoot.querySelector('.stage > .quick'); q.querySelector('.seg[data-name="stopHardOn"] button[data-v="on"]').click(); });
  await until(() => stores.local.drExtras.stopHardOn === true, 4000);
  await act('quick');
  await act('quick');

  // iOS refuses the microphone: the talk bar says so and where to allow it (this page is not used after this)
  await act('talk');
  await until(() => yt.evaluate(() => !!window.__ytcActiveSR), 8000, 100);
  await yt.evaluate(() => { window.__ytcSpeech({ type: 'error', error: 'not-allowed' }); window.__ytcSpeech({ type: 'end' }); });
  const toastText = () => yt.evaluate(() => { const t = document.getElementById('dr-stage-host')?.shadowRoot?.querySelector('.toast'); return t && !t.hidden ? t.textContent : ''; });
  const refused = await until(async () => /microphone is blocked/i.test(await toastText()), 5000);
  ok('iOS refuses the microphone: a message says so and where to allow it', !!refused, (await toastText()) + ' | ' + (await talkBar()));
  await act('goOn');
  await sleep(300);

  // ---- 8. the iOS voice (no fake voice): AVSpeechSynthesizer says the explanation, its events drive the tutor ----
  stores.local.drExtras = { ...stores.local.drExtras, fakeVoice: false };
  const kc2 = JSON.parse(keychain.drKeys); delete kc2.azure; keychain.drKeys = JSON.stringify(kc2); // 'auto' = the system voice now
  const yt2 = await ctx.newPage();
  yt2.on('pageerror', (e) => console.log('PAGE ERROR (2)', String(e.message || e).slice(0, 300)));
  await yt.close();
  await yt2.goto('https://m.youtube.com/watch?v=ios00000001');
  await yt2.addScriptTag({ content: source(ytScripts) });
  const probe = await yt2.evaluate(() => new Promise((res) => { const u = new SpeechSynthesisUtterance('Testing the voice.'); const ev = []; u.onstart = () => ev.push('start'); u.onboundary = () => ev.push('word'); u.onend = () => { ev.push('end'); res(ev); }; speechSynthesis.speak(u); setTimeout(() => res(ev), 4000); }));
  ok('speechSynthesis is the iOS voice: start, every word, end', probe[0] === 'start' && probe.includes('word') && probe[probe.length - 1] === 'end', JSON.stringify(probe));
  await until(() => yt2.evaluate(() => { const h = document.getElementById('dr-panel-host'); return h && h.shadowRoot.querySelectorAll('.s').length === 10; }), 30000);
  await yt2.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 4.5; return v.play(); });
  await until(() => nativeLog.some((l) => l.kind === 'speak' && l.text === 'meticulous'), 20000);
  await yt2.evaluate(() => window.__ytcDream.action('dontKnow'));
  const said = await until(() => nativeLog.find((l) => l.kind === 'speak' && /very careful/.test(l.text || '')), 15000);
  ok('the explanation was said by the iOS voice (a Premium British voice by default)', said && said.voice === 'com.apple.voice.premium.en-GB.Malcolm', JSON.stringify(said || nativeLog.filter((l) => l.kind === 'speak').slice(-3)));
  const goes = await until(() => yt2.evaluate(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime > 8; }), 30000, 150);
  ok('when the iOS voice says it is done, the tutor plays the video on', !!goes, JSON.stringify(await yt2.evaluate(() => document.querySelector('video').currentTime)));
  await yt2.close();

  // ---- 9. the settings page in the app's sheet (its own window: the shims + the tutor's background, at document start) ----
  const pages = http.createServer((q, r) => { const f = path.join(IOS, 'Web/dream', path.basename(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f)); }).listen(PAGES_PORT);
  const sheet = await ctx.newPage();
  sheet.on('pageerror', (e) => console.log('PAGE ERROR (settings)', String(e.message || e).slice(0, 300)));
  await sheet.addInitScript({ content: source(sheetScripts) });
  await sheet.goto(`http://localhost:${PAGES_PORT}/options.html`);
  const shown = await until(() => sheet.evaluate(() => { const m = document.body.innerText; const l = document.getElementById('myLevel'); return /saved|…/i.test(m) && l && l.type === 'range' && l.max === '100' && Number(l.value) > 0 ? l.value : null; }), 12000);
  ok('the settings page works in the sheet: it shows your level (one slider, 0 to 100; B2 starts at 50) and the saved Claude key (only its end)', shown === '50' && !(await sheet.evaluate(() => document.body.innerText.includes('sk-ant-test-key'))), String(shown));
  await sheet.fill('#key-anthropic', 'sk-ant-new-key-5678');
  await sheet.click('[data-save="anthropic"]');
  const saved = await until(() => JSON.parse(keychain.drKeys || '{}').anthropic === 'sk-ant-new-key-5678', 5000);
  ok('a key saved on the settings page goes to the Keychain', !!saved && !JSON.stringify(stores).includes('sk-ant-new-key'), keychain.drKeys && JSON.stringify(Object.keys(JSON.parse(keychain.drKeys))));

  // ---- 10. the reading mode in the app's sheet: paste a text, Level Check, it reads, stops at 50 % or under ----
  stores.local.drExtras = { ...stores.local.drExtras, fakeVoice: true, levelAsk: true, levelMode: true, phoneSet: false }; // (from here: a phone seen for the first time)
  const READ = ['My friend was very meticulous about her work.', 'She walked to the shop and bought some bread.', 'It was a lugubrious moment of joy.', 'The children played in the garden after school.', 'We will talk about it again very soon.', 'My uncle is an obsequious man.'];
  const reader = await ctx.newPage();
  reader.on('pageerror', (e) => console.log('PAGE ERROR (reader)', String(e.message || e).slice(0, 300)));
  await reader.addInitScript({ content: source(sheetScripts) });
  await reader.goto(`http://localhost:${PAGES_PORT}/reader.html`);
  await reader.fill('#paste', READ.join(' '));
  await reader.click('#paste-go');
  const rOpen = await until(() => reader.evaluate(() => document.body.dataset.sentences), 15000);
  ok('the reading mode opens in the app\'s sheet: a pasted text, all its sentences, exactly as it was', rOpen === String(READ.length) && (await reader.evaluate(() => document.getElementById('text').textContent)) === READ.join(' '), `${rOpen} · ${await reader.evaluate(() => document.getElementById('open-msg').textContent)}`);
  const rSkip = await until(() => reader.evaluate(() => { const h = document.getElementById('dr-level-host'); const b = h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=skip]'); if (b) b.click(); return !!b; }), 8000);
  ok('...Level Check first ("Skip, just play" here)', !!rSkip);
  const rEnd = await until(() => reader.evaluate(() => { const d = JSON.parse(document.documentElement.dataset.drDebug || 'null'); return d && d.heard >= d.total && !d.playing ? d : null; }), 60000, 200);
  ok('...it reads to the end by itself with the iOS bridge, stops at 50% or under', rEnd && rEnd.stops >= 1 && rEnd.stops <= rEnd.total / 2, JSON.stringify(rEnd && { stops: rEnd.stops, total: rEnd.total }));
  await reader.close();
  pages.close();

  // ---- 11. Level Check in the app: the screen, the test, a stop in the new order, the counter, the copy for Claude ----
  // a phone seen for the first time: no word test before the video (Settings turns it on); the video starts by itself
  const fp = await ctx.newPage();
  await fp.goto('https://m.youtube.com/watch?v=ios00000003');
  await fp.addScriptTag({ content: source(ytScripts) });
  const firstSet = await until(() => stores.local.drExtras.phoneSet === true, 10000);
  ok('a phone\'s first settings: the word test before a video is off', !!firstSet && stores.local.drExtras.levelAsk === false, JSON.stringify({ set: stores.local.drExtras.phoneSet, ask: stores.local.drExtras.levelAsk }));
  const noTest = await until(() => fp.evaluate(() => !document.querySelector('video').paused), 30000);
  ok('...the video starts by itself after the one analysis, no test screen', !!noTest && !(await fp.evaluate(() => { const h = document.getElementById('dr-level-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=check]')); })));
  await fp.close();
  // the switch in Settings is turned on: the test comes before the video
  stores.local.drExtras = { ...stores.local.drExtras, levelAsk: true };
  // (a word the learner is still learning stops whatever its number: "soon" is easy, but it is on their own list.
  // It gives this video a second stop near its end.)
  stores.local.drVocab = { ...(stores.local.drVocab || {}), words: { ...((stores.local.drVocab || {}).words || {}), soon: 'learning' } };
  const lv = await ctx.newPage();
  lv.on('pageerror', (e) => console.log('PAGE ERROR (level)', String(e.message || e).slice(0, 300)));
  await lv.goto('https://m.youtube.com/watch?v=ios00000002');
  await lv.addScriptTag({ content: source(ytScripts) });
  const inG = (fn) => lv.evaluate(`(${fn})(document.getElementById('dr-level-host').shadowRoot)`);
  const gate = await until(() => lv.evaluate(() => { const h = document.getElementById('dr-level-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('[data-a=check]')); }), 15000);
  ok('Level Check: the screen comes before the video, in the app', !!gate);
  await lv.evaluate(() => document.querySelector('video').play().catch(() => {}));
  await sleep(600);
  ok('...the video waits', await lv.evaluate(() => document.querySelector('video').paused));
  const nRule = apiLog.filter((r) => /These rules are absolute/.test(r.sys)).length;
  await inG((r) => r.querySelector('[data-a=check]').click());
  const chips = await until(() => inG((r) => { const n = r.querySelectorAll('.chip').length; return n ? [...r.querySelectorAll('.chip')].map((b) => b.textContent) : /no new words/.test(r.textContent) ? [] : null; }), 20000);
  ok('...the test comes from this video', Array.isArray(chips) && chips.every((c) => LINES.join(' ').toLowerCase().includes(c.toLowerCase())), JSON.stringify(chips));
  const fit = await inG((r) => { const d = r.querySelector('.done') || r.querySelector('button'); return { bottom: d.getBoundingClientRect().bottom, screen: innerHeight }; });
  ok('...it fits the phone screen', fit.bottom <= fit.screen, JSON.stringify(fit));
  await inG((r) => (r.querySelector('.done') || r.querySelector('[data-a=skip]')).click());
  const plays = await until(() => lv.evaluate(() => !document.getElementById('dr-level-host') && !document.querySelector('video').paused), 30000);
  ok('...after it the video plays by itself', !!plays);
  const lvDbg = () => lv.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const stop = await until(async () => { const d = await lvDbg(); return d && d.level.stops >= 1 ? d : null; }, 30000, 150);
  ok('a stop comes, counted', !!stop, JSON.stringify(await lvDbg()).slice(0, 300));
  // ---- the phone's screen: a book of subtitles, the play line, only what is needed at the bottom ----
  const book = await lv.evaluate(() => {
    const host = document.getElementById('dr-stage-host'), r = host.shadowRoot;
    const shown = (sel) => { const e = r.querySelector(sel); return !!e && e.offsetParent !== null && getComputedStyle(e).display !== 'none'; };
    const page = r.querySelector('.page'), cur = r.querySelector('.s.cur');
    const pr = page.getBoundingClientRect(), cr = cur ? cur.getBoundingClientRect() : null;
    return { phone: host.dataset.phone, say: host.dataset.say, view: r.querySelector('.stage').dataset.view, top: shown('.top'), pills: shown('.page .sx'), sayText: shown('.dock .say'), ask: shown('form.ask input'), send: (r.querySelector('form.ask button[type=submit]') || {}).textContent,
      size: getComputedStyle(page).fontSize, line: cr ? (cr.top + cr.height / 2 - pr.top) / pr.height : null, fills: host.getBoundingClientRect().height >= innerHeight - 1 };
  });
  ok('the phone: the whole screen is the book of subtitles: no toolbar, no "▶ Explain" pills, one normal text size', book.phone === '1' && book.view === 'all' && !book.top && !book.pills && book.size === '21px' && book.fills, JSON.stringify(book));
  ok('...what the tutor says is not shown as text; no box to ask (just talk or call)', book.say === '0' && !book.sayText && !book.ask, JSON.stringify(book));
  const lineNow = () => lv.evaluate(() => { const r = document.getElementById('dr-stage-host').shadowRoot; const page = r.querySelector('.page'), cur = r.querySelector('.s.cur'); if (!cur) return null; const pr = page.getBoundingClientRect(), cr = cur.getBoundingClientRect(); return (cr.top + cr.height / 2 - pr.top) / pr.height; });
  const onLine = await until(async () => { const l = await lineNow(); return l !== null && l > 0.48 && l < 0.72 ? l : null; }, 4000, 80);
  ok('...the stop\'s sentence is on the play line (40 of 100 from the bottom)', !!onLine, String(await lineNow()));
  const first = stores.local.drExtras;
  ok('...a phone\'s first settings: just talk is on, no Chinese under every line', first.phoneSet === true && first.voiceMode === true && first.zhLines === false, JSON.stringify({ v: first.voiceMode, zh: first.zhLines, s: stores.local.drSettings.listen.lastSecondsWindow }));
  const winL = await until(async () => { const d = await lvDbg(); return d && d.window && d.window.phase === 'before' ? d : null; }, 15000, 60);
  const cardL = await lv.evaluate(() => { const c = document.getElementById('dr-stage-host').shadowRoot.querySelector('.card'); if (!c || c.hidden) return null; const r = c.getBoundingClientRect();
    return { word: (c.querySelector('.word') || {}).textContent, zh: !!c.querySelector('.zh') && /[\u4e00-\u9fff]/.test(c.textContent), ipa: !!c.querySelector('.ipa'), en: !!c.querySelector('.en'), buttons: c.querySelectorAll('button').length, parts: c.children.length,
      full: c.classList.contains('full') && r.left <= 0.5 && r.top <= 0.5 && r.width >= innerWidth - 1 && r.height >= innerHeight - 1 }; });
  ok('a hard word: the window "Do you know …?" waits, the full-screen card shows only the word, its pronunciation and its Chinese (no English, no buttons)', winL && winL.window.kind !== 'sentence' && cardL && cardL.full && cardL.word === winL.window.target && cardL.zh && cardL.ipa && !cardL.en && cardL.buttons === 0 && cardL.parts === 3, JSON.stringify({ w: winL && winL.window, cardL }));
  const micOn = await lv.evaluate(() => ({ wants: window.__ytcDream.wantsMic(), level: window.__ytcDream.micLevel() }));
  ok('the microphone listens (just talk), at the highest of its 3 levels at first', micOn.wants === true && micOn.level === 3, JSON.stringify(micOn));
  ok('...its explanation is asked for with the hard rule', !!(await until(() => apiLog.filter((r) => /These rules are absolute/.test(r.sys)).slice(nRule)[0], 10000)));
  const goesOn = await until(async () => { const d = await lvDbg(); return d && d.state === 'playing' && !(await lv.evaluate(() => document.querySelector('video').paused)); }, 30000, 150);
  const lvEnd = await lvDbg();
  ok('the analysis was one call, nothing asked of the AI at the stop', lvEnd.level.aiCalls === 1 && apiLog.filter((r) => /These rules are absolute/.test(r.sys)).slice(nRule).length === 1, JSON.stringify({ calls: lvEnd.level.aiCalls }));
  ok('...and the video goes on by itself', !!goesOn, JSON.stringify(await lvDbg()).slice(0, 200));
  const count = await lv.evaluate(() => document.getElementById('dr-stop-counter')?.textContent || '');
  ok('the small counter shows, at 50% or under', /^\d+\/\d+ \((\d+)%\)$/.test(count) && +/\((\d+)%/.exec(count)[1] <= 50, count);
  // the next stop: "bye bye" = the tutor goes, the word is known, the video plays
  const win2L = await until(async () => { const d = await lvDbg(); return d && d.window && d.window.phase === 'before' && d.level.stops >= 2 ? d : null; }, 40000, 80);
  if (win2L) {
    const lemma = win2L.card ? win2L.card.lemma : null;
    await lv.evaluate(() => window.__ytcDream.heard('bye bye', true, 't:bye'));
    const on2 = await until(async () => { const d = await lvDbg(); return d && d.state === 'playing' && !d.window && !(await lv.evaluate(() => document.querySelector('video').paused)); }, 15000, 100);
    ok('"bye bye" at a stop: marked known, the video plays, the microphone stays on', !!on2 && !!lemma && stores.local.drVocab.words[lemma] === 'known' && stores.local.drExtras.voiceMode === true, JSON.stringify({ lemma, st: lemma && stores.local.drVocab.words[lemma] }));
  } else ok('a second stop comes', false, JSON.stringify((await lvDbg()).level));
  // the sleep timer: 30 minutes, 60 minutes, off
  const sl = [];
  for (let i = 0; i < 3; i++) { const before = (await lvDbg()).sleep; await lv.evaluate(() => window.__ytcDream.action('sleep')); await until(async () => (await lvDbg()).sleep !== before, 3000, 60); sl.push((await lvDbg()).sleep); }
  ok('the Sleep button: 30 minutes, then 60, then off', sl[0] === 30 && sl[1] === 60 && sl[2] === 0, JSON.stringify(sl));
  // 🩺 Check from the app's bar: the report over the book, with what the tutor is set to
  await lv.evaluate(() => window.__ytcDream.action('check'));
  const rep = await until(() => lv.evaluate(() => { const p = document.getElementById('yt2c-report-text'); return p && !/^Checking/.test(p.textContent) ? p.textContent : null; }), 8000);
  ok('the Check button shows the report: the app, just talk, the microphone, my level and the three switches', rep && /I Know app/.test(rep) && /justTalk/.test(rep) && /microphone/.test(rep) && /my level 50 of 100 · words on · phrases on · sentences on/.test(rep), (String(rep).match(/.stops.{0,140}/) || [String(rep).slice(0, 300)])[0]);
  await lv.evaluate(() => { const p = document.getElementById('yt2c-report'); if (p) p.remove(); });
  // ---- Reading mode: pages like an e-reader (big letters, so this short video makes two pages or more) ----
  await lv.evaluate(() => chrome.storage.local.get('drExtras').then((o) => chrome.storage.local.set({ drExtras: { ...o.drExtras, phoneSizePx: 40 } })));
  await lv.evaluate(() => window.__ytcDream.action('mode'));
  const rd = await until(async () => { const d = await lvDbg(); return d && d.stage.view === 'read' && d.stage.pages >= 2 ? d : null; }, 6000);
  const readLook = async () => lv.evaluate(() => {
    const r = document.getElementById('dr-stage-host').shadowRoot, page = r.querySelector('.page'), inner = page.querySelector('.doc-inner');
    const pr = page.getBoundingClientRect();
    const w = r.querySelector('.page .w.cur-w') || r.querySelector('.page .s.cur');
    const wr = w ? (w.getClientRects()[0] || w.getBoundingClientRect()) : null;
    return { scrolls: getComputedStyle(page).overflowY, size: getComputedStyle(page).fontSize, pg: (r.querySelector('.pager .pg') || {}).textContent, pager: getComputedStyle(r.querySelector('.pager')).display,
      onPage: wr ? wr.left >= pr.left - 1 && wr.right <= pr.right + 1 : null, tx: inner.style.transform, bg: getComputedStyle(r.querySelector('.stage')).backgroundColor, scrollTop: page.scrollTop };
  });
  // (the pages are laid out again for the new size a moment after the mode changes: the page with the sentence follows)
  const r1 = (await until(async () => { const x = await readLook(); return x.onPage === true ? x : null; }, 2500, 100)) || await readLook();
  ok('the Mode button: Reading mode, pages like a book: the text does not scroll, a light page, "page / pages" under it', !!rd && r1.scrolls === 'hidden' && r1.pager !== 'none' && new RegExp('^\\d+ / ' + rd.stage.pages + '$').test(r1.pg) && r1.bg === 'rgb(246, 241, 229)', JSON.stringify({ r1, st: rd && rd.stage }));
  ok('...the sentence being read is on the page shown', r1.onPage === true, JSON.stringify(r1));
  // (› on the last page cannot turn: then ‹)
  const turnBy = /^(\d+) \/ \1$/.test(r1.pg) ? 'prev' : 'next';
  await lv.evaluate((a) => document.getElementById('dr-stage-host').shadowRoot.querySelector(`.pager [data-act="${a}"]`).click(), turnBy);
  await sleep(400);
  const r2 = await readLook();
  ok('...› turns to the next page (‹ back)', r2.tx !== r1.tx && r2.pg !== r1.pg, JSON.stringify({ a: r1.pg, b: r2.pg }));
  await lv.evaluate((a) => document.getElementById('dr-stage-host').shadowRoot.querySelector(`.pager [data-act="${a}"]`).click(), turnBy === 'next' ? 'prev' : 'next');
  // ONE text size for every mode: the size set in Reading is the size of Listening too
  await lv.evaluate(() => chrome.storage.local.get('drExtras').then((o) => chrome.storage.local.set({ drExtras: { ...o.drExtras, phoneSizePx: 30 } })));
  const r3 = await until(async () => { const x = await readLook(); return x.size === '30px' ? x : null; }, 4000);
  // (back to Listening: the Mode button goes Listening → Reading → Lyrics → Video)
  await lv.evaluate(() => chrome.storage.local.get('drExtras').then((o) => chrome.storage.local.set({ drExtras: { ...o.drExtras, view: 'listening' } })));
  const backL = await until(async () => { const d = await lvDbg(); return d && d.stage.view === 'all' && d.stage.shown ? d : null; }, 6000);
  ok('...ONE text size: 30 in Reading is 30 in Listening too (no size per mode any more)', !!r3 && !!backL && backL.stage.size === '30px' && stores.local.drExtras.view === 'listening', JSON.stringify({ r3: r3 && r3.size, back: backL && backL.stage }));
  await lv.evaluate(() => chrome.storage.local.get('drExtras').then((o) => chrome.storage.local.set({ drExtras: { ...o.drExtras, phoneSizePx: 21 } })));
  await until(async () => { const d = await lvDbg(); return d && d.stage.size === '21px'; }, 4000);
  // a double tap on a word of the book (two taps: a touch screen sends no double-click of its own) = I know
  await sleep(800); // (the page that just appeared does not take a tap for a moment)
  const dbl = await lv.evaluate(() => {
    const r = document.getElementById('dr-stage-host').shadowRoot;
    const w = [...r.querySelectorAll('.page .w[data-lemma][data-level]')].find((x) => !/known/.test(x.className)) || r.querySelector('.page .w[data-lemma]');
    if (!w) return null;
    for (let i = 0; i < 2; i++) w.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    return w.dataset.lemma;
  });
  const dblKnown = await until(() => dbl && stores.local.drVocab.words[dbl] === 'known', 4000);
  ok('a double tap on a word = I know (marked known at once)', !!dblKnown, JSON.stringify({ dbl, st: dbl && stores.local.drVocab.words[dbl] }));
  const copy = await lv.evaluate(() => chrome.runtime.sendMessage({ type: 'dream-level-copy' }));
  ok('"Copy my level for Claude" has my level and words', copy && /My English level/.test(copy.text) && /Still learning/.test(copy.text), copy && copy.text.slice(0, 200));
  ok('the keys stay out of it', copy && !copy.text.includes('sk-ant'));
  await lv.close();

  // ---- 12. the learner's own word list is built into the app: an install with the older starting data gets it,
  //          and what the phone already has always wins ----
  const wordsBefore = Object.keys(stores.local.drVocab.words).length;
  stores.local.drLevel = { ...stores.local.drLevel, seeded: 1, tests: [{ date: '2026-11-04', source: 'Eveline', scores: { b2: 45, c1: 5, c2: 13 }, level: 'lower B2' }, ...(stores.local.drLevel.tests || [])] };
  // (the list knows "threaten" and is still learning "squander", "ubiquitous" and "invade"; "invade" was taken out
  // on this phone since the shared file began: it is in the last merged copy and no longer here)
  const vw = { ...stores.local.drVocab.words, threaten: 'learning', squander: 'known', ubiquitous: 'ignored' };
  delete vw.invade;
  stores.local.drVocab = { ...stores.local.drVocab, words: vw };
  stores.local.drDbBase = { ...(stores.local.drDbBase || { version: 1, updatedAt: '2026-11-05T00:00:00.000Z', currentLevel: '', tests: [], known: [] }), stillLearning: [...((stores.local.drDbBase || {}).stillLearning || []).filter((l) => l.item !== 'invade'), { item: 'invade', date: '2026-11-04', sentence: '' }] };
  stores.local.drSettings = { ...stores.local.drSettings, learnerLevel: 'C1' };
  stores.local.drExtras = { ...stores.local.drExtras, myLevel: 70 }; // (the level slider at 70 = a C1 learner for the prompts)
  const sd = await ctx.newPage();
  sd.on('pageerror', (e) => console.log('PAGE ERROR (seed)', String(e.message || e).slice(0, 300)));
  await sd.goto('https://m.youtube.com/watch?v=ios00000004');
  await sd.addScriptTag({ content: source(ytScripts) });
  const seededNow = await until(() => stores.local.drLevel && stores.local.drLevel.seeded >= 2 ? stores.local.drLevel : null, 20000);
  const w = stores.local.drVocab.words;
  const nWords = Object.keys(w).length;
  ok('my own word list is built into the app: more than 1,200 words are there after the first start', !!seededNow && nWords >= 1200 && nWords > wordsBefore + 1000 && w.familiar === 'known' && w['keep nix'] === 'learning', JSON.stringify({ seeded: seededNow && seededNow.seeded, nWords, wordsBefore }));
  ok('...what the phone already has wins: known stays known, ignored stays ignored, still learning stays still learning, a word taken out does not come back', w.squander === 'known' && w.ubiquitous === 'ignored' && w.threaten === 'learning' && !w.invade, JSON.stringify({ squander: w.squander, ubiquitous: w.ubiquitous, threaten: w.threaten, invade: w.invade }));
  ok('...no test twice, the level I chose stays, no example sentence comes with the list', seededNow && seededNow.tests.filter((t) => t.source === 'Eveline').length === 1 && seededNow.tests.some((t) => t.source === 'After Twenty Years') && stores.local.drSettings.learnerLevel === 'C1' && stores.local.drExtras.myLevel === 70 && !(seededNow.log['keep nix'] || {}).sentence && (seededNow.log['keep nix'] || {}).group === 'c2', JSON.stringify(seededNow && { tests: seededNow.tests.map((t) => t.source), lvl: stores.local.drSettings.learnerLevel, log: seededNow.log['keep nix'] }));
  // a second start changes nothing more
  const snap = JSON.stringify(stores.local.drVocab.words);
  await sd.goto('https://m.youtube.com/watch?v=ios00000004');
  await sd.addScriptTag({ content: source(ytScripts) });
  await sleep(2500);
  ok('...and it goes in only once', JSON.stringify(stores.local.drVocab.words) === snap && stores.local.drLevel.tests.filter((t) => t.source === 'Eveline').length === 1);
  await sd.close();

  // ---- 13. official subtitles made by people (a .en track next to the auto one): used as they are, no AI split ----
  const plainJson3 = JSON.stringify({ events: LINES.map((t, i) => ({ tStartMs: i * H.SEC * 1000, dDurationMs: H.SEC * 1000, segs: [{ utf8: t.toLowerCase().replace(/[.,?!]/g, '') }] })) });
  const hid = 'ios00000005';
  const hctx = await H.newAppContext(browser, 'iPhone 13', { device: 'phone', video: { id: hid, tracks: [
    { baseUrl: `https://m.youtube.com/api/timedtext?v=${hid}&lang=en&kind=asr`, languageCode: 'en', kind: 'asr', vssId: 'a.en' },
    { baseUrl: `https://m.youtube.com/api/timedtext?v=${hid}&lang=en&name=Official`, languageCode: 'en', vssId: '.en' }], json3ByUrl: { 'kind=asr': plainJson3 } } });
  const nHum = apiLog.length;
  const hp = await hctx.newPage();
  hp.on('pageerror', (e) => console.log('PAGE ERROR (official subtitles)', String(e.message || e).slice(0, 300)));
  await hp.goto(`https://m.youtube.com/watch?v=${hid}`);
  await hp.addScriptTag({ content: source(ytScripts) });
  const hdbg = () => hp.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const human = await until(async () => { const d = await hdbg(); return d && d.sentences === 10 && d.split === 'human' ? d : null; }, 30000);
  await until(() => apiLog.slice(nHum).some((r) => r.kind === 'hints'), 15000); // (a split request would have come before this)
  ok('official subtitles made by people: used as they are on the phone too (10 sentences, no AI split)', !!human && !apiLog.slice(nHum).some((r) => r.kind === 'split'), JSON.stringify(human ? { split: human.split, n: human.sentences } : (await hdbg() || {}).split));
  await hctx.close();

  // ---- 14. Video mode: the two switches of the bar (subtitles on / off, the big page on / off) ----
  const cv = fs.readFileSync(path.join(IOS, 'ContentView.swift'), 'utf8');
  ok('the bar has the two Video mode switches (subtitles, the big page), shown only in Video mode', /if model\.videoMode \{[\s\S]{0,200}tutorButton\("band"[\s\S]{0,200}tutorButton\("pageAuto"/.test(cv)
    && /@Published var bandOn/.test(H.swift) && /@Published var pageOn/.test(H.swift) && /@Published var videoMode/.test(H.swift) && /videoSwitches\(extras\)/.test(H.swift));
  stores.local.drExtras = { ...stores.local.drExtras, view: 'normal', band: 'auto', stageOn: true, hideYtCaptions: true, levelAsk: false, levelMode: false, oneButton: false, voiceMode: false };
  stores.local.drVocab = { ...stores.local.drVocab, words: { ...stores.local.drVocab.words, meticulous: 'learning', gregarious: 'learning' } };
  const vm = await ctx.newPage();
  vm.on('pageerror', (e) => console.log('PAGE ERROR (video mode)', String(e.message || e).slice(0, 300)));
  await vm.goto('https://m.youtube.com/watch?v=ios00000006');
  await vm.addScriptTag({ content: source(ytScripts) });
  const vdbg = () => vm.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const vact = (id) => vm.evaluate((x) => window.__ytcDream.action(x), id);
  // what is seen: the band over the video, YouTube's own captions (a stand-in in the player), the class on <html>
  const seen = () => vm.evaluate(() => {
    const b = document.getElementById('dr-band-host'), cc = document.querySelector('.ytp-caption-window-container');
    return { band: !!b && b.style.display !== 'none', cc: !!cc && getComputedStyle(cc).display !== 'none', hideCc: document.documentElement.classList.contains('dr-hide-cc') };
  });
  const vready = await until(async () => { const d = await vdbg(); return d && d.sentences === 10 && (await vm.evaluate(() => !!document.getElementById('dr-band-host'))) ? d : null; }, 30000);
  // the video stands still while the switches are tried (no stop comes); it starts paused here, so ⏸ only if it plays
  await until(async () => { const d = await vdbg(); return d && !d.window && !d.flow; }, 15000, 60);
  const vpaused = () => vm.evaluate(() => document.querySelector('video').paused);
  if (!(await vpaused())) await vact('stop');
  await until(vpaused, 5000);
  await sleep(300);
  if ((await vdbg()).stage.shown) await vact('page');
  await vm.evaluate(() => { const c = document.createElement('div'); c.className = 'ytp-caption-window-container'; c.textContent = 'YouTube CC'; document.getElementById('movie_player').appendChild(c); });
  const s0 = await until(async () => { const s = await seen(); return s.band && !s.cc ? s : null; }, 5000);
  ok('Video mode: the subtitles are on the video, YouTube\'s own captions hidden under them', !!vready && !!s0, JSON.stringify({ s: await seen(), view: vready && vready.view }));
  await vact('band');
  const s1 = await until(async () => { const s = await seen(); return stores.local.drExtras.band === 'off' && !s.band && s.hideCc && !s.cc ? s : null; }, 5000);
  ok('"Subtitles off": the band is gone and YouTube\'s own captions stay hidden (no subtitles at all)', !!s1, JSON.stringify({ band: stores.local.drExtras.band, s: await seen() }));
  await vact('band');
  const s2 = await until(async () => { const s = await seen(); return stores.local.drExtras.band === 'on' && s.band && !s.cc ? s : null; }, 5000);
  ok('..."Subtitles on" again: the band is back', !!s2, JSON.stringify({ band: stores.local.drExtras.band, s: await seen() }));
  // the switch while the page is up (the band is hidden then): it still turns the subtitles off
  await vact('page');
  const up = await until(async () => { const d = await vdbg(); return d.stage.shown && !(await seen()).band; }, 5000);
  await vact('band');
  const s3 = await until(() => stores.local.drExtras.band === 'off', 5000);
  await vact('page');
  const s4 = await until(async () => { const d = await vdbg(); const s = await seen(); return !d.stage.shown && !s.band && !s.cc ? s : null; }, 5000);
  ok('..."Subtitles off" pressed while the page is up: off (not on again), still off when the page goes', !!up && !!s3 && !!s4, JSON.stringify({ up, band: stores.local.drExtras.band, s: await seen() }));
  await vact('band');
  await until(async () => stores.local.drExtras.band === 'on' && (await seen()).band, 5000);
  // "Page off": a stop in Video mode keeps the video (no page), the subtitles stay on it
  await vact('pageAuto');
  const pOff = await until(() => stores.local.drExtras.stageOn === false, 5000);
  if (await vpaused()) await vact('stop');
  await until(async () => !(await vpaused()), 5000);
  await vm.evaluate(() => { document.querySelector('video').currentTime = 0; });
  const vwin = await until(async () => { const d = await vdbg(); return d && d.window ? d : null; }, 30000, 80);
  // (the full card shows anyway: it covers the whole screen, so no page is seen; it goes with the card)
  const vcard = await vm.evaluate(() => { const c = document.getElementById('dr-stage-host').shadowRoot.querySelector('.card.full'); if (!c || c.hidden) return null; const r = c.getBoundingClientRect(); return { word: c.querySelector('.word').textContent, covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1 }; });
  ok('"Page off": a stop in Video mode still shows the full-screen card (over the whole screen, no page seen)', !!pOff && !!vwin && !!vcard && vcard.covers && vcard.word === vwin.window.target && vwin.card && vwin.card.forcedStage, JSON.stringify({ w: vwin && vwin.window, card: vcard, forced: vwin && vwin.card && vwin.card.forcedStage }));
  await vact('know');
  const vback = await until(async () => { const d = await vdbg(); const s = await seen(); return d && !d.window && !d.card && d.state === 'playing' && !d.stage.shown && s.band ? d : null; }, 10000, 100);
  ok('..."I know": the card goes and the page with it, the video is back with its subtitles', !!vback, JSON.stringify({ d: (await vdbg() || {}).stage, s: await seen() }));
  // both switches back as they were
  await vact('pageAuto');
  const restored = await until(() => stores.local.drExtras.stageOn === true && stores.local.drExtras.band === 'on', 5000);
  ok('...both switches back on (the page at stops, the subtitles)', !!restored, JSON.stringify({ stageOn: stores.local.drExtras.stageOn, band: stores.local.drExtras.band }));
  await vm.close();

  // ---- 15. the full-screen stop card: only the word (or the sentence) and its Chinese; one tap anywhere = "I know";
  // no tap = "I don't know": explained, the card stays during the explanation and goes before the video plays again ----
  H.setHard([5]); // (the AI finds sentence 5 hard: a sentence stop)
  stores.local.drExtras = { ...stores.local.drExtras, view: 'listening', band: 'auto', stageOn: true, levelAsk: false, levelMode: false, oneButton: false, voiceMode: false, zhLines: true, stopSentences: true, stopHardOn: true, capSentences: 100, capWords: 100, talkAfterExplain: false };
  stores.local.drVocab = { ...stores.local.drVocab, words: { ...stores.local.drVocab.words, meticulous: 'learning', ephemeral: 'learning', gregarious: 'learning' } };
  const fc = await ctx.newPage();
  fc.on('pageerror', (e) => console.log('PAGE ERROR (full card)', String(e.message || e).slice(0, 300)));
  await fc.goto('https://m.youtube.com/watch?v=ios00000008');
  await fc.addScriptTag({ content: source(ytScripts) });
  const fdbg = () => fc.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const fready = await until(async () => { const d = await fdbg(); return d && d.sentences === 10 && d.hardSentences.length === 1 ? d : null; }, 30000);
  // (what is on the screen, every 40 ms, from here to the end: the card, the video, the tutor's state, what was said)
  await fc.evaluate(() => {
    const r = document.getElementById('dr-stage-host').shadowRoot;
    window.__fcLog = [];
    window.__fcEarly = null;
    setInterval(() => {
      const c = r.querySelector('.card'), d = window.__drDebug && window.__drDebug();
      const shown = !!c && !c.hidden && c.classList.contains('full');
      // (a tap at once, in the card's first 450 ms: that tap was meant for what was there before, it is not "I know")
      if (shown && !window.__fcEarly) { window.__fcEarly = { at: Date.now(), lemma: d && d.card && d.card.lemma }; c.click(); }
      const rr = shown ? c.getBoundingClientRect() : null;
      window.__fcLog.push({ at: Date.now(), card: shown ? { sentence: c.classList.contains('sentence'), word: (c.querySelector('.word') || {}).textContent, zh: (c.querySelector('.zh') || {}).textContent || '', parts: c.children.length, buttons: c.querySelectorAll('button').length,
        covers: rr.width >= innerWidth - 1 && rr.height >= innerHeight - 1, fits: c.scrollHeight <= c.clientHeight + 1 } : null,
        playing: !document.querySelector('video').paused, state: d && d.state, win: d && d.window ? d.window.phase + ':' + d.window.kind : '', said: d ? d.spoken.join(' | ') : '' });
    }, 40);
  });
  const fvol = (w) => (stores.local.drVocab.words || {})[w];
  await fc.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 0; return v.play(); });
  const fwin = await until(async () => { const d = await fdbg(); return d && d.window && d.window.phase === 'before' && d.window.target === 'meticulous' && d.card ? d : null; }, 30000, 60);
  const early = await fc.evaluate(() => window.__fcEarly);
  ok('the full card: a tap in its first 450 ms does nothing (the window still waits, the word not known)', !!fready && !!fwin && !!early && early.lemma === 'meticulous' && fwin.card.full && fvol('meticulous') === 'learning', JSON.stringify({ early, w: fwin && fwin.window, st: fvol('meticulous') }));
  await sleep(Math.max(0, 520 - (Date.now() - fwin.card.openedAt)));
  const nTap = apiLog.length;
  const said0 = (await fdbg()).spoken.length;
  const vp = fc.viewportSize();
  await fc.touchscreen.tap(Math.round(vp.width * 0.2), Math.round(vp.height * 0.8));
  const tapped = await until(async () => { const d = await fdbg(); return d && !d.card && !d.window && d.state === 'playing' && fvol('meticulous') === 'known' && !(await fc.evaluate(() => document.querySelector('video').paused)) ? d : null; }, 8000, 80);
  ok('one tap anywhere on the full card = "I know": known, the card goes, nothing explained, the video plays on', !!tapped && !apiLog.slice(nTap).some((r) => r.kind === 'explain') && !tapped.spoken.slice(said0).some((x) => /Meticulous means/.test(x)),
    JSON.stringify({ st: fvol('meticulous'), d: tapped ? null : await fdbg().then((d) => d && { card: d.card, w: d.window, state: d.state }), asked: apiLog.slice(nTap).map((r) => r.kind) }));
  // "ephemeral": nothing tapped, the window runs out = "I don't know"
  const ewin = await until(async () => { const d = await fdbg(); return d && d.window && d.window.target === 'ephemeral' ? d : null; }, 20000, 60);
  const eFrom = Date.now();
  const eDone = await until(async () => { const d = await fdbg(); return d && d.spoken.some((x) => /^It means something simple/.test(x)) && d.state === 'playing' && !(await fc.evaluate(() => document.querySelector('video').paused)) ? d : null; }, 30000, 100);
  const eLog = (await fc.evaluate(() => window.__fcLog)).filter((s) => s.at >= eFrom && s.at <= Date.now());
  const eExpl = eLog.filter((s) => s.state === 'explaining' && /It means something simple/.test(s.said));
  ok('no tap: the window runs out, the tutor explains, the full card stays on the screen during the explanation', !!ewin && !!eDone && eExpl.length > 0 && eExpl.some((s) => s.card && s.card.word === 'ephemeral'),
    JSON.stringify({ n: eExpl.length, first: eExpl[0], st: fvol('ephemeral') }));
  ok('...and it is gone before the video plays again', !!eDone && eLog.filter((s) => s.playing).every((s) => !s.card), JSON.stringify(eLog.filter((s) => s.playing && s.card).slice(0, 2)));
  // the hard sentence (5): after it was played, the sentence big and its translation under it, fitted to the screen
  const sFrom = Date.now();
  const swin = await until(async () => { const d = await fdbg(); return d && d.window && d.window.phase === 'before' && d.window.kind === 'sentence' ? d : null; }, 30000, 60);
  await sleep(200);
  const sNow = (await fc.evaluate(() => window.__fcLog.slice(-1)[0])).card;
  ok('a hard sentence: the full card shows the sentence and its translation (nothing else), fitted to the screen', !!swin && !!sNow && sNow.sentence && sNow.word === LINES[4] && /中文第\d+句/.test(sNow.zh) && sNow.parts === 2 && sNow.buttons === 0 && sNow.covers && sNow.fits,
    JSON.stringify({ w: swin && swin.window, card: sNow }));
  const sDone = await until(async () => { const d = await fdbg(); return d && d.state === 'playing' && !d.window && (await fc.evaluate(() => document.querySelector('video').currentTime)) > 21 ? d : null; }, 40000, 100);
  const sLog = (await fc.evaluate(() => window.__fcLog)).filter((s) => s.at >= sFrom);
  const sExpl = sLog.filter((s) => s.state === 'explaining' && s.card && s.card.sentence && !/^before/.test(s.win));
  ok('...no tap: explained with the sentence card still there, gone when the sentence plays again', !!sDone && sExpl.length > 0 && sLog.filter((s) => s.playing).every((s) => !s.card),
    JSON.stringify({ n: sExpl.length, playingWithCard: sLog.filter((s) => s.playing && s.card).slice(0, 2), st: sDone && sDone.state }));
  await fc.close();
  H.setHard([]);

  // ---- 16. back where you stopped: the app opens the last page again (the same video, at its minute), and the tutor
  // keeps the minute at once when the video stops or the app goes away ----
  ok('the app keeps its last YouTube page (its address watched) and opens it again at the same minute (&t=), else the home page',
    /appLastPage/.test(H.swift) && /observe\(\\\.url/.test(H.swift) && /&t=/.test(H.swift) && /willResignActiveNotification[^\n]*leaving\(\)/.test(H.swift) && /beginBackgroundTask/.test(H.swift)
    && /withTimeInterval: 15, repeats: true/.test(H.swift) && /func start\(\)[\s\S]{0,900}lastPage\([\s\S]{0,300}goHome\(\)/.test(H.swift));
  stores.local.drExtras = { ...stores.local.drExtras, view: 'listening', stopItemsOn: false, stopPhrasesOn: false, stopHardOn: false, stopSentences: false, explainOnStop: false, oneButton: false, voiceMode: false };
  const sid = 'ios00000009';
  const rs = await ctx.newPage();
  rs.on('pageerror', (e) => console.log('PAGE ERROR (where you stopped)', String(e.message || e).slice(0, 300)));
  await rs.goto(`https://m.youtube.com/watch?v=${sid}`);
  await rs.addScriptTag({ content: source(ytScripts) });
  const rdbg = () => rs.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.drDebug || 'null'); } catch (e) { return null; } });
  const rv = () => rs.evaluate(() => { const v = document.querySelector('video'); return { t: v.currentTime, paused: v.paused }; });
  await until(async () => { const d = await rdbg(); return d && d.sentences === 10; }, 30000);
  // (from 33 s for about 2.5 s: the 5 s save while it plays came at about 33 s; the pause is kept at its own minute)
  await rs.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 33; return v.play(); });
  await until(async () => { const v = await rv(); return !v.paused && v.t > 35.3; }, 10000, 40);
  const pausedAt = await rs.evaluate(() => { const v = document.querySelector('video'); v.pause(); return v.currentTime; });
  const spotP = await until(() => { const s = (stores.local.drSpots || {})[sid]; return s && Math.abs(s.t - pausedAt) < 0.3 ? s : null; }, 3000, 50);
  ok('the video paused at about 35 s: its minute is kept at once (drSpots), not only every 5 s while it plays', !!spotP && pausedAt > 35 && spotP.d > 0, JSON.stringify({ pausedAt, spot: (stores.local.drSpots || {})[sid] }));
  // the app goes to the background (the page is hidden): the minute is kept then too
  await rs.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 42; return v.play(); });
  await until(async () => { const v = await rv(); return !v.paused && v.t > 44.3; }, 10000, 40);
  const hiddenAt = await rs.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); return document.querySelector('video').currentTime; });
  const spotH = await until(() => { const s = (stores.local.drSpots || {})[sid]; return s && Math.abs(s.t - hiddenAt) < 0.3 ? s : null; }, 3000, 50);
  ok('...the app going to the background (the page hidden): the minute is kept then too', !!spotH && hiddenAt > 44, JSON.stringify({ hiddenAt, spot: (stores.local.drSpots || {})[sid] }));
  await rs.close();

  await browser.close();
  api.close();
  console.log(H.fails() ? `\n${H.fails()} FAILED` : '\nALL PASSED');
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack || e); process.exit(1); });
