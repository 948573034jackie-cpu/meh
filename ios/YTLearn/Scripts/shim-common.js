// Makes the Chrome-extension code run inside the iOS app.
// It provides the small part of the `chrome.*` API the extension uses, and talks to the Swift side through
// window.webkit.messageHandlers.ytc (which answers with a Promise).
(function () {
  if (window.__ytcShim) return;
  window.__ytcShim = true;

  const post = (obj) => window.webkit.messageHandlers.ytc.postMessage(obj);
  const listeners = [];
  const changeListeners = [];
  const local = Object.assign({}, window.__ytcStorageInit || {});
  const session = {};

  function pick(store, keys) {
    if (keys === null || keys === undefined) return Object.assign({}, store);
    const out = {};
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) { keys.forEach((k) => { if (k in store) out[k] = store[k]; }); return out; }
    Object.keys(keys).forEach((k) => { out[k] = k in store ? store[k] : keys[k]; });
    return out;
  }
  function fire(changes) { changeListeners.slice().forEach((fn) => { try { fn(changes, 'local'); } catch (e) { console.warn(e); } }); }

  function area(store, persist) {
    return {
      get: (keys) => Promise.resolve(pick(store, keys)),
      set: (obj) => {
        const ch = {};
        Object.keys(obj).forEach((k) => { ch[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = obj[k]; });
        if (persist) { post({ kind: 'storageSet', obj }).catch(() => {}); fire(ch); }
        return Promise.resolve();
      },
      remove: (keys) => {
        [].concat(keys).forEach((k) => { delete store[k]; });
        return Promise.resolve();
      }
    };
  }

  // Swift changed a setting (or is telling us the starting values)
  window.__ytcStorageChanged = (obj) => {
    const ch = {};
    Object.keys(obj).forEach((k) => { ch[k] = { oldValue: local[k], newValue: obj[k] }; local[k] = obj[k]; });
    fire(ch);
  };

  // deliver a message to every listener; the first sendResponse() wins (like chrome.runtime)
  function dispatch(msg, sender) {
    return new Promise((resolve) => {
      let answered = false, holds = 0;
      const respond = (r) => { if (!answered) { answered = true; resolve(r); } };
      listeners.slice().forEach((fn) => {
        let ret;
        try { ret = fn(JSON.parse(JSON.stringify(msg)), sender || {}, respond); } catch (e) { console.warn(e); }
        if (ret === true) holds++;
      });
      if (!holds) setTimeout(() => respond(undefined), 0);
      else setTimeout(() => respond(undefined), 120000);
    });
  }
  window.__ytcDispatch = dispatch;

  window.chrome = window.chrome || {};
  window.chrome.__ytc = true;
  window.chrome.storage = { local: area(local, true), session: area(session, false), onChanged: { addListener: (fn) => changeListeners.push(fn) } };
  window.chrome.runtime = {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: (msg) => dispatch(msg, window.__ytcSender ? window.__ytcSender() : {}),
    getContexts: () => Promise.resolve([])
  };
})();
