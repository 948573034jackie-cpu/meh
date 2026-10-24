/* DJ Wave Looper: background service worker.
 * The toolbar button and the Alt+L shortcut open or close the panel in the
 * current YouTube tab. */

const YT = /^https:\/\/(www|m|music)\.youtube\.com\//;

async function toggle(tab) {
  if (!tab || !tab.id || !YT.test(tab.url || '')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'ytl-toggle' });
  } catch (e) {
    // The tab was open before the extension was installed or updated: add the
    // scripts now. (The waveform tap catches the next video loaded in the tab.)
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/inject.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/core.js', 'src/stems.js', 'src/panel-css.js', 'src/vendor/signalsmith-stretch.js', 'src/content.js'],
      });
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { type: 'ytl-toggle' }).catch(() => {});
      }, 400);
    } catch (e2) {
      /* not allowed on this page */
    }
  }
}

chrome.action.onClicked.addListener(toggle);

// Lyrics lookups for the content script (only the LRCLIB lyrics API).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ytl-fetch-json' || !/^https:\/\/lrclib\.net\/api\//.test(msg.url || '')) return false;
  fetch(msg.url, { credentials: 'omit' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
    .then((data) => sendResponse({ ok: true, data }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});

// Stem separation runs in an offscreen page (ONNX Runtime, wasm): the content
// script sends it the loop's audio through here, and the results come back
// the same way. Every message carries the tab id, so a restart of this
// worker loses nothing.
let offscreenReady = null;
async function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
      if (!has) {
        await chrome.offscreen.createDocument({
          url: 'src/offscreen.html',
          reasons: ['WORKERS'],
          justification: 'Separates the song into vocals, drums and bass with an AI model (heavy computation, off the page).',
        });
      }
    })().catch((e) => {
      offscreenReady = null;
      throw e;
    });
  }
  return offscreenReady;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'ytl-stems' && sender.tab && sender.tab.id != null) {
    const tabId = sender.tab.id;
    console.debug('stems job', msg.job && msg.job.op, msg.job && msg.job.id, 'from tab', tabId);
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: 'ytl-stems-job', tabId, job: msg.job }))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.debug('stems job failed', String((e && e.message) || e));
        sendResponse({ ok: false, why: String((e && e.message) || e) });
      });
    return true;
  }
  if (msg.type === 'ytl-stems-out' && msg.tabId != null) {
    console.debug('stems out', msg.stage, msg.stem || msg.what || '', 'to tab', msg.tabId);
    if (msg.tabId < 0) return false; // the offscreen page's own notes
    chrome.tabs.sendMessage(msg.tabId, msg).catch((e) => console.debug('stems out not delivered', String((e && e.message) || e)));
    return false;
  }
  return false;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-panel') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggle(tab);
});
