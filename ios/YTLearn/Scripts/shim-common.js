// Makes the Chrome-extension code run inside the iOS app.
// It provides the small part of the `chrome.*` API the extension uses, and talks to the Swift side through
// window.webkit.messageHandlers.ytc (which answers with a Promise).
(function () {
  if (window.__ytcShim) return;
  window.__ytcShim = true;

  const post = (obj) => window.webkit.messageHandlers.ytc.postMessage(obj);
  const listeners = [];
  const changeListeners = [];
  const stores = { local: Object.assign({}, window.__ytcStorageInit || {}), sync: {}, session: {} };

  // the saved values come from Swift (JSON files in the app's Documents folder); every read waits for them once.
  // The values cross the bridge as JSON text, so numbers, true/false and null stay exactly what they were.
  const loaded = {};
  function ready(name) {
    if (name === 'session') return Promise.resolve();
    if (!loaded[name]) {
      loaded[name] = post({ kind: 'storageAll', area: name })
        .then((text) => { const saved = text ? JSON.parse(text) : {}; stores[name] = Object.assign(saved, stores[name]); })
        .catch(() => undefined);
    }
    return loaded[name];
  }

  function pick(store, keys) {
    if (keys === null || keys === undefined) return Object.assign({}, store);
    const out = {};
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) { keys.forEach((k) => { if (k in store) out[k] = store[k]; }); return out; }
    Object.keys(keys).forEach((k) => { out[k] = k in store ? store[k] : keys[k]; });
    return out;
  }
  function fire(changes, name) {
    if (!Object.keys(changes).length) return;
    changeListeners.slice().forEach((fn) => { try { fn(changes, name || 'local'); } catch (e) { console.warn(e); } });
  }
  window.__ytcFireChanged = fire;

  function area(name) {
    const persist = name !== 'session';
    return {
      get: async (keys, cb) => { await ready(name); const r = pick(stores[name], keys); if (typeof cb === 'function') cb(r); return r; },
      set: async (obj, cb) => {
        await ready(name);
        const store = stores[name];
        const ch = {};
        Object.keys(obj).forEach((k) => { ch[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = obj[k]; });
        if (persist) post({ kind: 'storageSet', area: name, json: JSON.stringify(obj) }).catch(() => {});
        fire(ch, name);
        if (typeof cb === 'function') cb();
      },
      remove: async (keys, cb) => {
        await ready(name);
        const store = stores[name];
        const ch = {};
        [].concat(keys).forEach((k) => { if (k in store) { ch[k] = { oldValue: store[k] }; delete store[k]; } });
        if (persist) post({ kind: 'storageRemove', area: name, keys: [].concat(keys) }).catch(() => {});
        fire(ch, name);
        if (typeof cb === 'function') cb();
      }
    };
  }

  // Swift changed a setting, or another window of the app saved something (the settings page, the old-mode switches)
  window.__ytcStorageChanged = (obj, name) => {
    name = name || 'local';
    const store = stores[name];
    const ch = {};
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      ch[k] = { oldValue: store[k], newValue: v === null ? undefined : v };
      if (v === null) delete store[k]; else store[k] = v;
    });
    fire(ch, name);
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

  // page errors -> Swift (helps find problems on real sites)
  ['error', 'warn'].forEach((level) => {
    const orig = console[level];
    console[level] = function () {
      try { post({ kind: 'log', text: level + ': ' + Array.prototype.slice.call(arguments).map(String).join(' ') }).catch(() => {}); } catch (e) { /* ignore */ }
      return orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', (e) => { try { post({ kind: 'log', text: 'uncaught: ' + e.message + ' @' + (e.filename || '') + ':' + e.lineno + ':' + e.colno + ' | ' + String(e.error && e.error.stack || '').split('\n').slice(0, 4).join(' <- ') }).catch(() => {}); } catch (x) { /* ignore */ } });

  window.chrome = window.chrome || {};
  window.chrome.__ytc = true;
  window.chrome.storage = { local: area('local'), sync: area('sync'), session: area('session'), onChanged: { addListener: (fn) => changeListeners.push(fn) } };
  window.chrome.runtime = {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: (msg) => dispatch(msg, window.__ytcSender ? window.__ytcSender() : {}),
    getContexts: () => Promise.resolve([])
  };
})();
