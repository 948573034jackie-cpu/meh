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
function passageText(lines) {
  return [
    lines.join('\n'),
    '',
    'Using the context of this video, explain this part to me like an English teacher: what is happening, what they are talking about, and the important idea, so I really understand it. Then repeat the sentences above once more, exactly as written. Start directly with the explanation. No greeting, no title, no headings, no bullet points, no bold, no labels, no extra words, and do not ask me anything or offer anything at the end.'
  ].join('\n');
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

// Sends `passage` (may be null). Adds the link + full transcript if this chat has not had this video yet.
async function sendToClaude({ videoTabId, videoId, passage, force, targetId }) {
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
  if (!path) return 'Could not reach the ' + T.name + ' tab. Refresh it and try again.';

  const sent = await getSent();
  const rec = sent[claudeTab.id];
  const sameChat = rec && rec.videoId === videoId && (rec.path === path || (isFreshPath(rec.path) && !isFreshPath(path)));
  const needTranscript = force || !sameChat;
  if (sameChat && rec.path !== path) await saveSent(claudeTab.id, videoId, path);

  const { sendTranscript } = await chrome.storage.local.get('sendTranscript');
  let text = passage || '';
  let file = null;
  let summary = 'passage only';
  if (needTranscript && (force || sendTranscript !== false)) {
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
  try {
    res = await chrome.tabs.sendMessage(claudeTab.id, { type: 'chat-send', text, file });
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
  if (needTranscript && (force || sendTranscript !== false)) markSent(claudeTab.id, videoId, path);
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'send') {
    (async () => {
      let result;
      try { result = await sendVideo(msg.tabId, msg.target); } catch (e) { result = 'Unexpected error: ' + e.message; }
      await setLast(result);
      sendResponse({ result });
    })();
    return true;
  }
  if (msg.type === 'ask' && sender.tab) { // a question you said out loud (iPhone / iPad app): goes into the same chat
    (async () => {
      let result;
      try {
        const videoId = new URL(sender.tab.url).searchParams.get('v');
        result = await sendToClaude({
          videoTabId: sender.tab.id, videoId,
          passage: String(msg.text || '').trim() + '\n\n(Answer in simple English, in short plain sentences, as if you are speaking to me. No headings, no bullet points, no bold.)',
          force: false, targetId: msg.target
        });
      } catch (e) { result = 'Unexpected error: ' + e.message; }
      await setLast('Question: ' + result);
      sendResponse({ result });
    })();
    return true;
  }
  if (msg.type === 'pause-send' && sender.tab) {
    (async () => {
      let result;
      try {
        result = await sendToClaude({
          videoTabId: sender.tab.id, videoId: msg.videoId,
          passage: passageText(msg.lines || msg.seg.items.map((s) => s.text)), force: false
        });
      } catch (e) { result = 'Unexpected error: ' + e.message; }
      await setLast('Paused at ' + fmt(msg.seg.pausedAt) + ': ' + result);
      sendResponse({ result });
    })();
    return true;
  }
});
