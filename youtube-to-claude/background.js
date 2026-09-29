// Popup button → read the YouTube video (link + transcript) → type it into your claude.ai chat.

const YT_WATCH = 'https://www.youtube.com/watch';
const CLAUDE_URL = 'https://claude.ai/*';
const CLAUDE_NEW = 'https://claude.ai/new';

async function setLast(text) {
  await chrome.storage.local.set({ last: new Date().toLocaleTimeString() + ' — ' + text });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findVideoTab(tabId) {
  if (tabId) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function findOrOpenClaude() {
  const tabs = await chrome.tabs.query({ url: CLAUDE_URL });
  if (tabs.length) {
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return { tab: tabs[0], opened: false };
  }
  const tab = await chrome.tabs.create({ url: CLAUDE_NEW, active: false });
  return { tab, opened: true };
}

async function talkToClaude(tabId, msg) {
  // The page (or a freshly opened tab) may need a moment before the script answers.
  let lastErr;
  for (let i = 0; i < 40; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      lastErr = e;
      if (i === 3) {
        try { await chrome.scripting.executeScript({ target: { tabId }, files: ['claude.js'] }); } catch (_) {}
      }
      await sleep(500);
    }
  }
  throw lastErr;
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
    lines.push('The full transcript is attached (source: ' + info.source + '). Please read all of it and keep it as context. I will ask you questions about the video next.');
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
    const r = await chrome.tabs.sendMessage(tabId, { type: 'claude-ping' });
    return r && r.path;
  } catch (e) { return null; }
}

// Remembers, per claude.ai tab, which video's transcript that chat already has.
async function getSent() {
  const { sent = {} } = await chrome.storage.session.get('sent');
  return sent;
}

async function markSent(claudeTabId, videoId, oldPath) {
  // After the first message a new chat changes its address (/new → /chat/…): remember the final one.
  let path = oldPath;
  for (let i = 0; i < 12 && path === oldPath && oldPath && /^\/(new)?$/.test(oldPath); i++) {
    await sleep(500);
    path = (await claudePath(claudeTabId)) || path;
  }
  const sent = await getSent();
  sent[claudeTabId] = { videoId, path };
  await chrome.storage.session.set({ sent });
}

function passageText(title, seg) {
  const lines = seg.items.map((s, i) =>
    '[' + fmt(s.start) + '] ' + s.text + (i === seg.items.length - 1 ? '   ◀ I paused here' : ''));
  return [
    '📚 I paused "' + title + '" at ' + fmt(seg.pausedAt) + '. These are the sentences around where I stopped (' + fmt(seg.start) + ' – ' + fmt(seg.end) + '):',
    '',
    ...lines,
    '',
    'If I ask a question next, it is about these sentences. For now, just reply "OK".'
  ].join('\n');
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

// Sends `passage` (may be null). Adds the link + full transcript if this chat has not had this video yet.
async function sendToClaude({ videoTabId, videoId, passage, force }) {
  const { tab: claudeTab, opened } = await findOrOpenClaude();

  // wait for the claude.ai page to answer, and learn which chat it is showing
  let path = null;
  for (let i = 0; i < 40 && !path; i++) {
    path = await claudePath(claudeTab.id);
    if (!path) {
      if (i === 3) { try { await chrome.scripting.executeScript({ target: { tabId: claudeTab.id }, files: ['claude.js'] }); } catch (_) {} }
      await sleep(500);
    }
  }
  if (!path) return 'Could not reach the claude.ai tab. Refresh claude.ai and try again.';

  const sent = await getSent();
  const rec = sent[claudeTab.id];
  const needTranscript = force || !(rec && rec.videoId === videoId && rec.path === path);

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
  try {
    res = await chrome.tabs.sendMessage(claudeTab.id, { type: 'claude-send', text, file });
  } catch (e) {
    return 'Could not send to claude.ai: ' + e.message + '. Refresh claude.ai and try again.';
  }
  if (!res || !res.ok) {
    return 'Claude page problem: ' + ((res && res.error) || 'unknown') + ' ' + JSON.stringify((res && res.steps) || []);
  }
  if (needTranscript) await markSent(claudeTab.id, videoId, path);
  return 'Sent ' + summary + (opened ? ' (opened a new claude.ai tab)' : '') + '.';
}

async function sendVideo(tabId) {
  const tab = await findVideoTab(tabId);
  if (!tab || !(tab.url || '').startsWith(YT_WATCH)) {
    return 'Open a YouTube video page first (the address should start with youtube.com/watch), then click again.';
  }
  const videoId = new URL(tab.url).searchParams.get('v');
  return sendToClaude({ videoTabId: tab.id, videoId, passage: null, force: true });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'send') {
    (async () => {
      let result;
      try { result = await sendVideo(msg.tabId); } catch (e) { result = 'Unexpected error: ' + e.message; }
      await setLast(result);
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
          passage: passageText(msg.title, msg.seg), force: false
        });
      } catch (e) { result = 'Unexpected error: ' + e.message; }
      await setLast('Paused at ' + fmt(msg.seg.pausedAt) + ': ' + result);
      sendResponse({ result });
    })();
    return true;
  }
});
