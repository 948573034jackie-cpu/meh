// YouTube side of the adapter: fake "tabs" (tab 1 = this YouTube page, tab 2 = the chat web view),
// speech recognition through iOS, and the pieces of chrome.* that do not exist here.
(function () {
  if (window.__ytcShimYT) return;
  window.__ytcShimYT = true;

  const post = (obj) => window.webkit.messageHandlers.ytc.postMessage(obj);
  const dispatch = window.__ytcDispatch;

  const ytTab = () => ({ id: 1, windowId: 1, active: true, url: location.href, title: document.title, lastAccessed: Date.now() });
  async function chatTab() {
    const info = await post({ kind: 'chatInfo' });
    if (!info || !info.url) return null;
    return { id: 2, windowId: 2, active: false, url: info.url, title: '', lastAccessed: Date.now() - 1 };
  }
  const globMatch = (pattern, url) =>
    new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(url);

  window.__ytcSender = () => ({ tab: ytTab() });

  window.chrome.tabs = {
    query: async (q) => {
      q = q || {};
      const out = [];
      for (const t of [ytTab(), await chatTab()]) {
        if (!t) continue;
        if (q.url && !globMatch(q.url, t.url)) continue;
        if (q.active && !t.active) continue;
        out.push(t);
      }
      return out;
    },
    get: async (id) => (id === 1 ? ytTab() : chatTab()),
    create: async (opts) => { await post({ kind: 'navigateChat', url: opts.url }); return { id: 2, windowId: 2, url: opts.url, active: false }; },
    sendMessage: (id, msg) => (id === 1 ? dispatch(msg, { tab: ytTab() }) : post({ kind: 'tabsSend', tab: id, msg }))
  };
  window.chrome.scripting = { executeScript: () => Promise.resolve([]) };
  window.chrome.debugger = {
    attach: () => Promise.reject(new Error('not available on iOS')),
    sendCommand: () => Promise.reject(new Error('not available on iOS')),
    detach: () => Promise.resolve()
  };

  // ---- speech: iOS does the listening (SFSpeechRecognizer), we look like webkitSpeechRecognition ----
  class NativeSpeechRecognition {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = 'en-US'; this.onresult = null; this.onerror = null; this.onend = null; }
    start() { window.__ytcActiveSR = this; post({ kind: 'speech', op: 'start' }).catch(() => {}); }
    abort() { if (window.__ytcActiveSR === this) window.__ytcActiveSR = null; post({ kind: 'speech', op: 'stop' }).catch(() => {}); }
    stop() { this.abort(); }
  }
  window.__ytcSpeech = (ev) => {
    const r = window.__ytcActiveSR;
    if (!r) return;
    if (ev.type === 'result' && r.onresult) r.onresult({ resultIndex: 0, results: [[{ transcript: ev.text }]] });
    if (ev.type === 'error' && r.onerror) r.onerror({ error: ev.error });
    if (ev.type === 'end') { window.__ytcActiveSR = null; if (r.onend) r.onend(); }
  };
  window.SpeechRecognition = NativeSpeechRecognition;
  window.webkitSpeechRecognition = NativeSpeechRecognition;
})();
