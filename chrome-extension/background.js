// ClaudeSnap Voice — service worker.
// The offscreen page listens to the microphone and reports "speech" here.
// On speech we screenshot the page you are reading and hand it to the claude.ai tab.

const CLAUDE_URL = 'https://claude.ai/*';
const COOLDOWN_MS = 4000;      // minimum time between two screenshots
const NEW_UTTERANCE_MS = 1000; // silence this long = the next speech is a new sentence

let lastPing = 0;
let lastCapture = 0;
let utteranceDone = false;

// ---------- listening on / off ----------

async function isListening() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

async function start() {
  if (await isListening()) return;
  await chrome.storage.local.remove('error');
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Listen for your voice so a screenshot can be taken when you speak.'
  });
  setBadge('ON', '#188038');
}

async function stop() {
  if (await isListening()) await chrome.offscreen.closeDocument();
  setBadge('', '#188038');
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function flash(text, color) {
  setBadge(text, color);
  setTimeout(async () => {
    if (await isListening()) setBadge('ON', '#188038');
    else setBadge('', '#188038');
  }, 1500);
}

// ---------- speech → screenshot → claude.ai ----------

async function claudeIsSpeaking() {
  // Chrome marks a tab "audible" while it plays sound, so Claude's own voice never triggers us.
  const tabs = await chrome.tabs.query({ url: CLAUDE_URL, audible: true });
  return tabs.length > 0;
}

async function onSpeech() {
  const now = Date.now();
  if (now - lastPing > NEW_UTTERANCE_MS) utteranceDone = false;
  lastPing = now;
  if (utteranceDone) return;
  if (await claudeIsSpeaking()) return;
  if (now - lastCapture < COOLDOWN_MS) return;
  utteranceDone = true;
  lastCapture = now;
  await capture();
}

async function pickTargetTab(claudeTabs) {
  // The tab you are reading: the visible tab of a Chrome window that is not claude.ai.
  const claudeIds = new Set(claudeTabs.map((t) => t.id));
  const wins = await chrome.windows.getAll({ populate: true });
  const cands = [];
  for (const w of wins) {
    if (w.type !== 'normal' || w.state === 'minimized') continue;
    const tab = (w.tabs || []).find((t) => t.active);
    if (!tab || claudeIds.has(tab.id)) continue;
    if (!/^(https?|file):/.test(tab.url || '')) continue;
    cands.push({ w, tab });
  }
  if (!cands.length) return null;
  return (cands.find((c) => c.w.focused) || cands[0]).tab;
}

async function deliver(tabId, dataUrl) {
  const msg = { type: 'claudesnap-attach', dataUrl };
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    // Tab was open before the extension was installed: inject the script, then retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-claude.js'] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function capture() {
  try {
    const claudeTabs = await chrome.tabs.query({ url: CLAUDE_URL });
    if (!claudeTabs.length) return flash('!', '#d93025'); // no Claude tab open
    const target = await pickTargetTab(claudeTabs);
    if (!target) return flash('!', '#d93025');            // nothing to screenshot

    const dataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: 'jpeg', quality: 90 });

    claudeTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const res = await deliver(claudeTabs[0].id, dataUrl);
    if (res && res.ok) flash('OK', '#188038');
    else flash('!', '#d93025');
  } catch (e) {
    console.warn('ClaudeSnap capture failed:', e);
    flash('!', '#d93025');
  }
}

// ---------- messages from popup / offscreen ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'start':
        await start();
        sendResponse({ ok: true });
        break;
      case 'stop':
        await stop();
        sendResponse({ ok: true });
        break;
      case 'status': {
        const { error } = await chrome.storage.local.get('error');
        sendResponse({ listening: await isListening(), error: error || null });
        break;
      }
      case 'speech':
        await onSpeech();
        sendResponse({ ok: true });
        break;
      case 'mic-error':
        await chrome.storage.local.set({ error: msg.message || 'Microphone error' });
        await stop();
        flash('!', '#d93025');
        sendResponse({ ok: true });
        break;
      default:
        sendResponse(null);
    }
  })();
  return true; // async response
});
