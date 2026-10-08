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
        files: ['src/core.js', 'src/panel-css.js', 'src/vendor/signalsmith-stretch.js', 'src/content.js'],
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

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-panel') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggle(tab);
});
