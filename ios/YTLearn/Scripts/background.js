(function () {
// Popup button → read the YouTube video (link + transcript) → type it into your claude.ai chat.

const YT_WATCH = 'https://www.youtube.com/watch';
const TARGETS = {
  claude:  { name: 'Claude',  url: 'https://claude.ai/*',   newUrl: 'https://claude.ai/new' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/*', newUrl: 'https://chatgpt.com/' }
};

async function getTarget(id) {
  if (id && TARGETS[id]) return TARGETS[id];
  const { target } = await chrome.storage.local.get('target');
  return TARGETS[target] || TARGETS.claude;
}

async function setLast(text) {
  await chrome.storage.local.set({ last: new Date().toLocaleTimeString() + ' — ' + text });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findVideoTab(tabId) {
  if (tabId) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function findOrOpenClaude(T) {
  const tabs = await chrome.tabs.query({ url: T.url });
  if (tabs.length) {
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return { tab: tabs[0], opened: false };
  }
  const tab = await chrome.tabs.create({ url: T.newUrl, active: false });
  return { tab, opened: true };
}

// Last resort: a REAL Enter key press (pages can ignore the software-made one). Chrome shows a
// "started debugging this browser" bar for a moment while this runs.
async function trustedEnter(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'chat-focus' }).catch(() => {});
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, text: '\r' });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'char', ...key, text: '\r' });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    await sleep(600);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

function buildMessage(info, hasFile, askReady) {
  const lines = [
    "📺 I'm watching this YouTube video and I want to talk about it with you.",
    '',
    'Title: ' + info.title,
  ];
  if (info.channel) lines.push('Channel: ' + info.channel);
  lines.push('Link: ' + info.url);
  lines.push('');
  if (hasFile) {
    lines.push('The full transcript is attached (source: ' + info.source + '). Read it silently and keep it as background context. Do not summarize the whole video.');
  } else {
    lines.push('(I could not get a transcript automatically, so please use the title and link as context.)');
  }
  lines.push('When I pause the video, I will send you the part I paused at (as text, as a picture, or by playing it to you in our voice call). Then explain that part to me like an English teacher, and repeat its sentences once.');
  if (askReady) lines.push('For now, just reply "Ready".');
  return lines.join('\n').replace(/\n+$/, '');
}

function slug(s) {
  return (s || 'video').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'video';
}

async function claudePath(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'chat-ping' });
    return r && r.path;
  } catch (e) { return null; }
}

// Remembers, per claude.ai tab, which video's transcript that chat already has.
async function getSent() {
  const { sent = {} } = await chrome.storage.session.get('sent');
  return sent;
}

const isFreshPath = (p) => /^\/(new)?$/.test(p || '');

async function saveSent(claudeTabId, videoId, path) {
  const sent = await getSent();
  sent[claudeTabId] = { videoId, path };
  await chrome.storage.session.set({ sent });
}

// Remember at once that this chat has the transcript, then learn its final address in the background
// (a new chat changes from /new or / to /chat/… after the first message).
function markSent(claudeTabId, videoId, oldPath) {
  saveSent(claudeTabId, videoId, oldPath);
  (async () => {
    for (let i = 0; i < 16 && isFreshPath(oldPath); i++) {
      await sleep(500);
      const p = await claudePath(claudeTabId);
      if (p && p !== oldPath) { await saveSent(claudeTabId, videoId, p); return; }
    }
  })().catch(() => {});
}

// Just the text that was on screen, then one plain instruction (no headings, no extra words).
function passageText(lines, seg) {
  const when = seg && seg.start !== undefined
    ? ['Paused at ' + fmt(seg.pausedAt !== undefined ? seg.pausedAt : seg.end) + '. This part of the video runs from ' + fmt(seg.start) + ' to ' + fmt(seg.end) + ' (find it in the transcript timeline).', '']
    : [];
  return [
    ...when,
    lines.join('\n'),
    '',
    'Using the context of this video, explain this part to me like an English teacher: what is happening, what they are talking about, and the important idea, so I really understand it. Then write the sentences above again as complete, correctly punctuated sentences, one sentence per line (they come from automatic subtitles, so fix only the sentence breaks, punctuation and capital letters; keep the words). Start directly with the explanation. No greeting, no title, no headings, no bullet points, no bold, no labels, no extra words, and do not ask me anything or offer anything at the end.'
  ].join('\n');
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

// Sends `passage` (may be null). Adds the link + full transcript if this chat has not had this video yet.
async function sendToClaude({ videoTabId, videoId, passage, force, targetId, noTranscript, image, card, readAloud, inCall }) {
  const started = Date.now();
  const T = await getTarget(targetId);
  const { tab: claudeTab, opened } = await findOrOpenClaude(T);

  // wait for the claude.ai page to answer, and learn which chat it is showing
  let path = null;
  for (let i = 0; i < 40 && !path; i++) {
    path = await claudePath(claudeTab.id);
    if (!path) {
      if (i === 3) { try { await chrome.scripting.executeScript({ target: { tabId: claudeTab.id }, files: ['chat.js'] }); } catch (_) {} }
      await sleep(500);
    }
  }
  if (!path) return self.__ytcSafari
    ? 'Could not reach ' + T.name + '. Open ' + T.name + ' in a second Safari window NEXT to YouTube (Split View, both on screen), allow the extension there, then try again.'
    : 'Could not reach the ' + T.name + ' tab. Refresh it and try again.';

  const sent = await getSent();
  const rec = sent[claudeTab.id];
  const sameChat = rec && rec.videoId === videoId && (rec.path === path || (isFreshPath(rec.path) && !isFreshPath(path)));
  // The link + full transcript go ONLY when you press the ChatGPT / Claude button under the video (force).
  // A pause sends just the part you paused at, never the whole transcript again.
  const needTranscript = !!force && !noTranscript;
  if (sameChat && rec.path !== path) await saveSent(claudeTab.id, videoId, path);

  let text = passage || '';
  let file = null;
  let summary = 'passage only';
  if (needTranscript) {
    let info;
    try { info = await chrome.tabs.sendMessage(videoTabId, { type: 'yt-get' }); }
    catch (e) { return 'Refresh the YouTube page (Cmd+R) and try again. (' + e.message + ')'; }
    if (!info) return 'YouTube page did not answer. Refresh it and try again.';
    if (info.transcript) {
      file = { name: 'transcript-' + slug(info.title) + '.txt',
               text: 'Title: ' + info.title + '\nLink: ' + info.url + '\n\n' + info.transcript };
      summary = 'link + transcript (' + info.lines + ' lines, ' + info.source + ')' + (passage ? ' + passage' : '');
    } else {
      summary = 'link only, NO transcript (' + (info.errors || []).join(' | ') + ')' + (passage ? ' + passage' : '');
    }
    text = buildMessage(info, !!file, !passage) + (passage ? '\n\n' + passage : '');
  }

  let res;
  const before = await chrome.tabs.sendMessage(claudeTab.id, { type: 'chat-reply' }).catch(() => null);
  try {
    const sendImage = image && T.name === 'Claude' ? { name: 'video-' + Date.now() + '.jpg', dataUrl: image } : null; // ChatGPT gets words only
    const sendCard = card && T.name === 'Claude' ? { name: 'question-' + Date.now() + '.jpg', dataUrl: card } : null; // for voice mode: the words are inside the picture
    const { voiceBridge } = await chrome.storage.local.get('voiceBridge');
    res = await chrome.tabs.sendMessage(claudeTab.id, { type: 'chat-send', text, file, image: sendImage, card: sendCard, voiceBridge: voiceBridge !== false && !inCall });
  } catch (e) {
    return 'Could not send to ' + T.name + ': ' + e.message + '. Refresh the ' + T.name + ' tab and try again.';
  }
  if (res && !res.ok && res.needsTrustedEnter) {
    try {
      await trustedEnter(claudeTab.id);
      for (let i = 0; i < 10; i++) {
        const st = await chrome.tabs.sendMessage(claudeTab.id, { type: 'chat-state' }).catch(() => null);
        if (st && st.boxText === 0) { res = { ok: true, steps: (res.steps || []).concat('real Enter key press') }; break; }
        await sleep(300);
      }
    } catch (e) {
      res.steps = (res.steps || []).concat('real Enter failed: ' + e.message);
    }
  }
  if (!res || !res.ok) {
    return T.name + ' page problem: ' + ((res && res.error) || 'unknown') + ' | steps: ' + JSON.stringify((res && res.steps) || []) + ' | page: ' + JSON.stringify((res && res.info) || {});
  }
  if (res && res.ok && res.bridged) {
    // we stepped out of the voice call to send the text: go straight back into the call, Claude answers in its OWN voice
    // (never Chrome's voice here)
    pendingRestart = claudeTab.id;
    setTimeout(() => restartVoice(), 1500);
  } else if (res && res.ok && !res.voiceMode && readAloud) followAnswer(claudeTab.id, videoTabId, before ? before.count : 0);
  if (needTranscript) markSent(claudeTab.id, videoId, path);
  if (res && res.bridged) summary += ' (voice call: stepped out for a moment, sent the text, going back in)';
  if (inCall && res && res.voiceMode) summary = 'voice call: the part is played into the call (Claude hears it) + the picture was sent';
  else if (res && res.voiceMode) summary = 'voice mode: Claude has no text box there, so the picture with the sentences and the question was sent';
  else if (image && T.name === 'Claude') summary += ' + picture';
  return 'Sent to ' + T.name + ' in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s: ' + summary + (opened ? ' (opened a new ' + T.name + ' tab)' : '') + '.';
}

async function sendVideo(tabId, targetId) {
  const tab = await findVideoTab(tabId);
  if (!tab || !(tab.url || '').startsWith(YT_WATCH)) {
    return 'Open a YouTube video page first (the address should start with youtube.com/watch), then click again.';
  }
  const videoId = new URL(tab.url).searchParams.get('v');
  return sendToClaude({ videoTabId: tab.id, videoId, passage: null, force: true, targetId });
}


// ---- talk mode: read the AI's answer aloud (Chrome's own voice), "shut up" silences everything ----
async function talkOn() {
  if (typeof window !== 'undefined' && window.__ytcShimYT) return false; // iPhone / iPad app: the app reads answers itself
  const { talkOn } = await chrome.storage.local.get('talkOn');
  return talkOn === true; // off unless you turn it on in the extension window
}
async function chatInCall(tabId) { // is this chat tab in a voice call right now? (then the AI speaks with its own voice)
  const r = await chrome.tabs.sendMessage(tabId, { type: 'call-state' }).catch(() => null);
  return !!(r && r.inCall);
}
async function anyCall(targetId) {
  const T = await getTarget(targetId);
  for (const t of await chrome.tabs.query({ url: T.url })) if (await chatInCall(t.id)) return true;
  return false;
}
let followToken = 0;
let feedTab = null; // the chat tab whose voice call hears the replay
let pendingRestart = null; // the chat tab whose voice call we left for a moment
async function restartVoice() {
  const id = pendingRestart;
  pendingRestart = null;
  if (!id) return;
  const r = await chrome.tabs.sendMessage(id, { type: 'voice-restart' }).catch(() => null);
  await chrome.storage.local.set({ lastVoiceRestart: r && r.ok ? 'back in the voice call (' + r.label + ')' : 'could not find the voice button: ' + JSON.stringify((r && r.info && r.info.buttons) || []) });
}
function tellVideo(tabId, speaking) {
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'tts-state', speaking }).catch(() => {});
}
function speak(text, videoTabId, done) {
  const clean = String(text || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[*_#`>~]/g, '').replace(/\n{2,}/g, '\n').trim();
  if (!clean) { if (done) done(); return; }
  chrome.storage.local.set({ lastSpoken: clean.slice(0, 500) }); // for the tests / the status
  if (!chrome.tts) { if (done) done(); return; }
  if (done) setTimeout(() => { if (done) { const d = done; done = null; d(); } }, Math.min(180000, 6000 + clean.length * 90)); // never wait forever
  try {
    chrome.tts.stop();
    chrome.tts.speak(clean, {
      lang: 'en-US', rate: 0.95,
      onEvent: (e) => {
        if (e.type === 'start') tellVideo(videoTabId, true);
        if (['end', 'interrupted', 'cancelled', 'error'].includes(e.type)) { tellVideo(videoTabId, false); if (done) { const d = done; done = null; d(); } }
      }
    });
  } catch (e) { if (done) done(); } // no voice available
}
// wait until the new answer is complete (it stopped growing), then read it
async function followAnswer(chatTabId, videoTabId, baseline, thenRestart) {
  const token = ++followToken;
  let lastText = '', stable = 0;
  for (let i = 0; i < 150; i++) { // about 3 minutes
    await sleep(1000);
    if (token !== followToken) return; // "shut up" or a newer message
    const st = await chrome.tabs.sendMessage(chatTabId, { type: 'chat-reply' }).catch(() => null);
    if (!st || st.count <= baseline || !st.text) continue;
    if (st.text === lastText) stable++; else { stable = 0; lastText = st.text; }
    if ((!st.busy && stable >= 2) || stable >= 5) {
      if (token !== followToken) return;
      if (await chatInCall(chatTabId)) { await chrome.storage.local.set({ lastSkippedSpeak: Date.now() }); if (thenRestart) restartVoice(); return; } // the AI's own voice is talking: stay quiet
      speak(lastText, videoTabId, thenRestart ? restartVoice : null); return;
    }
  }
  if (thenRestart) restartVoice(); // no answer came: go back into the call anyway
}
async function chatTabs() {
  const out = [];
  for (const T of Object.values(TARGETS)) out.push(...await chrome.tabs.query({ url: T.url }));
  return out;
}
async function setChatMuted(muted) {
  for (const t of await chatTabs()) { try { await chrome.tabs.update(t.id, { muted }); } catch (e) { /* ignore */ } }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'send') {
    (async () => {
      let result;
      try { result = await sendVideo(msg.tabId || (sender && sender.tab && sender.tab.id), msg.target); } catch (e) { result = 'Unexpected error: ' + e.message; }
      await setLast(result);
      sendResponse({ result });
    })();
    return true;
  }
  if (msg.type === 'shut-up') { // stop reading, forget the answer we were waiting for, mute the AI tabs (its voice mode too)
    followToken++;
    try { if (chrome.tts) chrome.tts.stop(); } catch (e) { /* ignore */ }
    if (sender.tab) tellVideo(sender.tab.id, false);
    restartVoice();
    setChatMuted(true).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'voice-wake') { // "hi bro": the AI may talk again
    setChatMuted(false).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'call-state') { // is the chosen chat in a voice call? (then the replay is played into the call)
    (async () => {
      const { feedOn } = await chrome.storage.local.get('feedOn');
      if (feedOn === false || self.__ytcSafari) return sendResponse({ inCall: false }); // Safari on iPhone/iPad cannot play the video into the call
      const T = await getTarget(msg.target);
      const tabs = await chrome.tabs.query({ url: T.url });
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      for (const t of tabs) {
        const r = await chrome.tabs.sendMessage(t.id, { type: 'call-state' }).catch(() => null);
        if (r && r.inCall) { feedTab = t.id; return sendResponse({ inCall: true }); }
      }
      sendResponse({ inCall: false });
    })();
    return true;
  }
  if (msg.type === 'feed') { // live sound chunks from the video -> the chat tab's microphone line
    if (feedTab) chrome.tabs.sendMessage(feedTab, msg).catch(() => {});
    return;
  }
  if (msg.type === 'capture' && sender.tab) { // real screenshot of the YouTube tab (only if you are looking at it)
    (async () => {
      try {
        if (!chrome.tabs.captureVisibleTab) return sendResponse({ dataUrl: null });
        const tab = await chrome.tabs.get(sender.tab.id);
        if (!tab.active) return sendResponse({ dataUrl: null });
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
        sendResponse({ dataUrl });
      } catch (e) { sendResponse({ dataUrl: null, error: String(e && e.message || e) }); }
    })();
    return true;
  }
  if (msg.type === 'ask' && sender.tab) { // a question you said out loud (iPhone / iPad app): goes into the same chat
    (async () => {
      let result;
      if (await anyCall(msg.target)) { // in a voice call Claude already hears you: do not type it into the chat too
        sendResponse({ result: 'skipped: in a voice call' });
        return;
      }
      try {
        const videoId = new URL(sender.tab.url).searchParams.get('v');
        result = await sendToClaude({
          videoTabId: sender.tab.id, videoId,
          passage: String(msg.text || '').trim() + '\n\n(Answer in simple English, in short plain sentences, as if you are speaking to me. No headings, no bullet points, no bold.)',
          force: false, targetId: msg.target, noTranscript: true, readAloud: await talkOn() // just the question
        });
      } catch (e) { result = 'Unexpected error: ' + e.message; }
      await setLast('Question: ' + result);
      sendResponse({ result });
    })();
    return true;
  }
  if (msg.type === 'pause-send' && sender.tab) {
    (async () => {
      await setChatMuted(false).catch(() => {});
      let result;
      try {
        result = await sendToClaude({
          videoTabId: sender.tab.id, videoId: msg.videoId,
          passage: passageText(msg.lines || msg.seg.items.map((s) => s.text), msg.seg), force: false, noTranscript: true, readAloud: await talkOn(), image: msg.image || null, card: msg.card || null, inCall: !!msg.inCall
        });
      } catch (e) { result = 'Unexpected error: ' + e.message; }
      await setLast('Paused at ' + fmt(msg.seg.pausedAt) + ': ' + result);
      sendResponse({ result });
    })();
    return true;
  }
});
})();
