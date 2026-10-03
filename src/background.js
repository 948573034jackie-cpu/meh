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
        files: ['src/core.js', 'src/panel-css.js', 'src/content.js'],
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

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-panel') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggle(tab);
});
