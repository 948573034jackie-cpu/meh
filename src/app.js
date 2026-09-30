'use strict';
const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, session, systemPreferences,
  powerMonitor, Notification, shell, clipboard, ipcMain, dialog,
} = require('electron');
const { Vad, SENSITIVITY } = require('./vad');
const { Settings } = require('./settings');
const { renderIcon } = require('./icons');
const { captureScreen, screenAccess } = require('./screenshot');
const { screenGranted } = require('./layout');
const { pasteIntoApp } = require('./deliver');
const { Bridge } = require('./bridge');
const fs = require('fs');
const { execFile } = require('child_process');

const TARGETS = [
  ['chrome', 'Chrome: claude.ai / chatgpt.com (in the background)'],
  ['claude', 'Claude desktop app'],
  ['chatgpt', 'ChatGPT desktop app'],
  ['clipboard', "Only copy it (I'll paste myself)"],
];
const DESKTOP_APPS = { claude: 'Claude', chatgpt: 'ChatGPT' };
const RETRY_MS = 5000;
const STALL_MS = 4000;

// `overrides` lets the automated tests swap pieces (capture, paste, settings file...).
function start(overrides = {}) {
  const o = {
    capture: captureScreen,
    screenAccess,
    platform: process.platform, // tests may pretend to be macOS
    paste: pasteIntoApp,
    bridge: undefined, // undefined = create the real Chrome link; false = none; or pass a Bridge (tests)
    settingsFile: path.join(app.getPath('userData'), 'settings.json'),
    manageLoginItem: app.isPackaged,
    notify: true,
    onEvent: () => {},
    ...overrides,
  };

  if (!o.allowMultiple && !app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }
  // The hidden listener must be allowed to open the mic without a user gesture.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const settings = new Settings(o.settingsFile);
  const vad = new Vad({}, onVad);
  vad.setSensitivity(settings.get('sensitivity'));
  vad.setMinInterval(settings.get('intervalSec') * 1000);

  let tray = null;
  let listener = null;
  let micState = 'stopped'; // stopped | starting | listening | error
  let micMessage = '';
  let lastLevelTs = 0;
  let lastSent = null;
  let busy = false;
  let retryTimer = null;
  let watchdog = null;
  let lastResult = '';
  let chromeUp = false;
  let bridge = null;

  const icons = {
    on: nativeImage.createFromBuffer(renderIcon('on', 44), { scaleFactor: 2 }),
    off: nativeImage.createFromBuffer(renderIcon('off', 44), { scaleFactor: 2 }),
    sent: nativeImage.createFromBuffer(renderIcon('sent', 44), { scaleFactor: 2 }),
  };
  let flashUntil = 0;

  const isWorking = () => settings.get('enabled') && micState === 'listening';

  function notify(title, body) {
    o.onEvent({ type: 'notice', title, body });
    if (o.notify && Notification.isSupported()) new Notification({ title, body, silent: true }).show();
  }

  // ---------- tray ----------
  function statusText() {
    if (!settings.get('enabled')) return 'Stopped';
    if (micState === 'listening') return 'Working: listening to your microphone';
    if (micState === 'error') return `Microphone problem: ${micMessage}`;
    return 'Starting…';
  }

  function refreshTray() {
    if (!tray) return;
    tray.setImage(Date.now() < flashUntil ? icons.sent : isWorking() ? icons.on : icons.off);
    tray.setToolTip(`Claude Eyes: ${statusText()}`);
    tray.setContextMenu(buildMenu());
  }

  function buildMenu() {
    const enabled = settings.get('enabled');
    const items = [
      { label: statusText(), enabled: false },
      { type: 'separator' },
      {
        label: enabled ? 'Screenshot when I speak: ON' : 'Screenshot when I speak: OFF',
        type: 'checkbox', checked: enabled,
        click: () => setEnabled(!settings.get('enabled')),
      },
      {
        label: 'Send the picture to',
        submenu: TARGETS.map(([id, label]) => ({
          label, type: 'radio', checked: settings.get('target') === id,
          click: () => { settings.set('target', id); refreshTray(); },
        })),
      },
      { label: chromeUp ? 'Chrome extension: connected ✓' : 'Chrome extension: not connected', enabled: false },
      { label: chromeUp ? 'Chrome extension setup…' : 'Set up the Chrome extension…', click: () => installExtension() },
      {
        label: 'Microphone sensitivity',
        submenu: Object.keys(SENSITIVITY).map((name) => ({
          label: name[0].toUpperCase() + name.slice(1),
          type: 'radio', checked: settings.get('sensitivity') === name,
          click: () => { settings.set('sensitivity', name); vad.setSensitivity(name); refreshTray(); },
        })),
      },
      {
        label: 'Wait between screenshots',
        submenu: [30, 60, 120, 300].map((sec) => ({
          label: sec < 60 ? `${sec} seconds` : `${sec / 60} minute${sec > 60 ? 's' : ''}`,
          type: 'radio', checked: settings.get('intervalSec') === sec,
          click: () => { settings.set('intervalSec', sec); vad.setMinInterval(sec * 1000); refreshTray(); },
        })),
      },
      {
        label: 'Capture all screens',
        type: 'checkbox', checked: settings.get('allScreens'),
        click: (mi) => { settings.set('allScreens', mi.checked); refreshTray(); },
      },
      { type: 'separator' },
      { label: 'Send a test screenshot now', click: () => sendScreenshot('test') },
      {
        label: 'Start when I log in',
        type: 'checkbox', checked: settings.get('launchAtLogin'),
        click: (mi) => { settings.set('launchAtLogin', mi.checked); applyLoginItem(); refreshTray(); },
      },
      { type: 'separator' },
      ...(process.platform === 'darwin' ? [{ label: 'Check permissions…', click: () => showPermissions() }] : []),
      { label: lastResult || 'No screenshot sent yet', enabled: false },
    ];
    if (micState === 'error' && /NotAllowed|denied|Permission/i.test(micMessage)) {
      items.splice(2, 0, { label: 'Fix: allow microphone access…', click: openMicSettings });
    }
    items.push({ label: 'Quit Claude Eyes', role: 'quit' });
    return Menu.buildFromTemplate(items);
  }

  function openMicSettings() {
    if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    else if (process.platform === 'win32') shell.openExternal('ms-settings:privacy-microphone');
  }

  function applyLoginItem() {
    if (!o.manageLoginItem) return;
    app.setLoginItemSettings({ openAtLogin: settings.get('launchAtLogin'), openAsHidden: true });
  }

  // ---------- microphone listener ----------
  function createListener() {
    listener = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        backgroundThrottling: false, // hidden page must keep listening at full speed
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === 'media' && listener && wc === listener.webContents);
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      return permission === 'media' && !!listener && !!wc && wc === listener.webContents;
    });
    listener.loadFile(path.join(__dirname, 'listener.html'));
    return new Promise((resolve) => listener.webContents.once('did-finish-load', resolve));
  }

  ipcMain.on('level', (e, db) => {
    if (!listener || e.sender !== listener.webContents) return;
    lastLevelTs = Date.now();
    if (settings.get('enabled')) vad.process(db, lastLevelTs);
    o.onEvent({ type: 'level', db });
  });

  ipcMain.on('mic-status', (e, { state, message }) => {
    if (!listener || e.sender !== listener.webContents) return;
    o.onEvent({ type: 'mic', state, message });
    if (state === 'listening') {
      micState = 'listening'; micMessage = ''; lastLevelTs = Date.now();
    } else if (state === 'error') {
      micState = 'error'; micMessage = message || 'unknown';
      scheduleRetry();
    } else if (state === 'stopped') {
      micState = 'stopped';
    }
    refreshTray();
  });

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (!settings.get('enabled')) return;
    retryTimer = setTimeout(() => { if (settings.get('enabled')) startListening(); }, RETRY_MS);
  }

  async function startListening() {
    clearTimeout(retryTimer);
    if (!listener) await createListener();
    if (process.platform === 'darwin') {
      const ok = await systemPreferences.askForMediaAccess('microphone');
      if (!ok) {
        micState = 'error'; micMessage = 'NotAllowedError: macOS blocked the microphone';
        refreshTray(); scheduleRetry();
        return;
      }
    }
    micState = 'starting';
    vad.reset();
    refreshTray();
    listener.webContents.send('command', 'start');
  }

  function stopListening() {
    clearTimeout(retryTimer);
    if (listener) listener.webContents.send('command', 'stop');
    micState = 'stopped';
    refreshTray();
  }

  function setEnabled(on) {
    settings.set('enabled', on);
    o.onEvent({ type: 'enabled', value: on });
    if (on) startListening(); else stopListening();
    refreshTray();
  }

  // ---------- the actual job: screenshot -> Claude ----------
  function onVad(ev) {
    o.onEvent({ type: `vad-${ev.type}`, ts: ev.ts, db: ev.db });
    if (ev.type === 'start') sendScreenshot('speech');
  }

  async function sendScreenshot(reason) {
    if (busy) return;
    busy = true;
    const t0 = Date.now();
    try {
      const access = o.screenAccess();
      if (!screenGranted(o.platform, access)) {
        // Without Screen Recording permission macOS only returns the wallpaper. Never send that.
        if (access === 'not-determined') o.capture({ all: false }).catch(() => {}); // makes macOS show its permission prompt
        handleScreenDenied(access);
        setResult('not sent: Screen Recording is not allowed yet');
        o.onEvent({ type: 'blocked', reason: 'screen-permission', access });
        return;
      }
      let image;
      try {
        image = await o.capture({ all: settings.get('allScreens') }); // grab the screen FIRST, before anything else moves
      } catch (e) {
        handleCaptureProblem(e);
        setResult('not sent: could not capture the screen');
        o.onEvent({ type: 'error', reason, error: String(e.message || e) });
        return;
      }
      const tCaptured = Date.now();
      const res = await deliver(image);
      report(res);
      o.onEvent({ type: 'sent', reason, captureMs: tCaptured - t0, totalMs: Date.now() - t0, route: res.route, ok: res.ok, where: res.where, pasted: res.pasted, chrome: res.chrome, size: image.getSize() });
    } catch (e) {
      setResult('not sent: ' + String(e.message || e));
      o.onEvent({ type: 'error', reason, error: String(e.message || e) });
    } finally {
      busy = false;
      refreshTray();
    }
  }

  // Desktop app route: picture -> clipboard -> paste into the app -> straight back to your page.
  async function pasteDesktop(image, appName) {
    const before = { text: clipboard.readText(), image: clipboard.readImage() };
    clipboard.writeImage(image);
    let r;
    try { r = await o.paste({ appName }); } catch (e) { r = { ok: false, reason: 'failed', detail: String(e.message || e) }; }
    // give the user's old clipboard back, but ONLY if the paste worked (otherwise the picture stays for a manual paste)
    if (r.ok) {
      setTimeout(() => {
        if (!before.image.isEmpty()) clipboard.writeImage(before.image);
        else if (before.text) clipboard.writeText(before.text);
      }, 300);
    }
    return r;
  }

  // -> { ok, route: 'chrome'|'claude'|'chatgpt'|'clipboard'|null, where?, chrome?, pasted?, note? }
  async function deliver(image) {
    const target = settings.get('target');
    const res = { ok: false, route: null };
    if (target === 'clipboard') {
      clipboard.writeImage(image);
      return { ok: true, route: 'clipboard' };
    }
    if (target === 'chrome') {
      if (bridge && bridge.connected) {
        res.chrome = await bridge.send({ mime: 'image/jpeg', data: image.toJPEG(85).toString('base64'), name: 'screenshot.jpg' });
        if (res.chrome.ok) return { ...res, ok: true, route: 'chrome', where: res.chrome.where };
      } else {
        res.chrome = { ok: false, error: 'not-connected' };
      }
      // Chrome could not take it: fall back to whichever desktop app is open
      for (const name of Object.values(DESKTOP_APPS)) {
        const r = await pasteDesktop(image, name);
        res.pasted = r;
        if (r.ok) return { ...res, ok: true, route: name.toLowerCase(), where: name, viaFallback: true };
        if (r.reason !== 'not-running') break;
      }
      clipboard.writeImage(image); // nothing worked: leave the picture on the clipboard
      return res;
    }
    const name = DESKTOP_APPS[target] || 'Claude';
    const r = await pasteDesktop(image, name);
    res.pasted = r;
    if (r.ok) return { ...res, ok: true, route: target, where: name };
    return res;
  }

  function setResult(text) {
    lastResult = `${new Date().toLocaleTimeString()}  ${text}`;
    lastSent = lastResult;
  }

  function report(res) {
    if (res.ok) {
      flashUntil = Date.now() + 1500;
      setTimeout(refreshTray, 1600);
      if (res.route === 'chrome') setResult(`sent to ${res.where} in Chrome ✓`);
      else if (res.route === 'clipboard') setResult('copied to your clipboard ✓');
      else setResult(`sent to the ${res.where} app ✓${res.viaFallback ? ' (Chrome was not available)' : ''}`);
      if (res.pasted && res.pasted.ok && !res.pasted.focusRestored) complain('Claude Eyes', "The screenshot was sent, but I couldn't switch you back to your page automatically. Click your page to continue.");
      if (res.viaFallback) complain('Claude Eyes', `Chrome wasn't available (${chromeReason(res.chrome)}), so I used the ${res.where} app.`);
      return;
    }
    const why = res.chrome && !res.chrome.ok ? chromeReason(res.chrome) : pasteReason(res.pasted || {});
    setResult(`not sent: ${why}`);
    if (res.chrome && !res.chrome.ok) complain('Claude Eyes', `The picture was not sent: ${chromeReason(res.chrome)}. It is on your clipboard.`);
    else if (res.pasted) handlePasteProblem(res.pasted, settings.get('target'));
  }

  function chromeReason(c) {
    const e = c && c.error;
    if (e === 'no-tab') return 'open claude.ai or chatgpt.com in Chrome';
    if (e === 'not-connected') return "the Chrome extension isn't connected (menu: Set up the Chrome extension)";
    if (e === 'no-message-box') return "couldn't find the message box on the page";
    if (e === 'timeout') return 'Chrome did not answer in time';
    return e || 'unknown problem';
  }
  function pasteReason(r) {
    if (r.reason === 'not-running') return 'the desktop app is not open';
    if (r.reason === 'wrong-window') return "the desktop app didn't come forward in time";
    if (r.reason === 'no-accessibility') return 'Accessibility permission is missing';
    return r.reason || 'unknown problem';
  }

  let lastComplaint = 0;
  let lastPaneOpen = 0;
  function complain(title, body) {
    if (Date.now() - lastComplaint < 20000) return; // don't nag on every sentence
    lastComplaint = Date.now();
    notify(title, body);
  }

  function handlePasteProblem(r, target) {
    const app_ = DESKTOP_APPS[target] || 'Claude';
    if (r.reason === 'wrong-window') complain('Claude Eyes', `The ${app_} app didn't come forward in time, so nothing was pasted (your page was left alone). The screenshot is on your clipboard.`);
    else if (r.reason === 'not-running') complain('Claude Eyes', `The ${app_} app isn't open, so the screenshot is only on your clipboard.`);
    else if (r.reason === 'no-accessibility') {
      complain('Claude Eyes needs permission', 'Allow Claude Eyes under System Settings > Privacy & Security > Accessibility so it can paste.');
      if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    } else complain('Claude Eyes', `Couldn't paste into ${app_} (${r.reason}). The screenshot is on your clipboard.`);
  }

  // ---------- Chrome extension ----------
  function extensionSource() {
    return app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', 'extension');
  }
  function extensionFolder() {
    return path.join(app.getPath('home'), 'Claude Eyes Chrome Extension');
  }
  function syncExtension() {
    try { fs.cpSync(extensionSource(), extensionFolder(), { recursive: true, force: true }); return true; } catch (_) { return false; }
  }
  async function installExtension() {
    if (!syncExtension()) { notify('Claude Eyes', "Couldn't prepare the Chrome extension folder."); return; }
    shell.showItemInFolder(path.join(extensionFolder(), 'manifest.json'));
    const open = process.platform === 'darwin' ? ['open', ['-a', 'Google Chrome', 'chrome://extensions']]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', 'chrome', 'chrome://extensions']] : null;
    if (open) execFile(open[0], open[1], () => {});
    if (o.notify) {
      await dialog.showMessageBox({
        type: 'info', title: 'Chrome extension', message: 'Add the extension to Chrome (one time, 3 clicks)',
        detail: '1. In the Chrome page that just opened, turn on "Developer mode" (top right).\n' +
          '2. Click "Load unpacked".\n' +
          '3. Choose the folder "Claude Eyes Chrome Extension" (it is open in Finder for you).\n\n' +
          'A green "ON" badge appears on the extension when it is connected. After that, screenshots go into your claude.ai / chatgpt.com tab without leaving your page.',
        buttons: ['Done'],
      });
    }
  }

  const PANE = (name) => `x-apple.systempreferences:com.apple.preference.security?Privacy_${name}`;

  function handleScreenDenied(access) {
    complain('Claude Eyes can\'t see your screen yet', 'Turn on Claude Eyes under System Settings > Privacy & Security > Screen Recording, then quit and reopen it. No screenshot was sent.');
    if (process.platform === 'darwin' && Date.now() - lastPaneOpen > 60000) { lastPaneOpen = Date.now(); shell.openExternal(PANE('ScreenCapture')); }
  }

  function handleCaptureProblem(e) {
    complain('Claude Eyes can\'t see the screen', 'Allow Claude Eyes under System Settings > Privacy & Security > Screen Recording, then restart it.');
    if (process.platform === 'darwin') shell.openExternal(PANE('ScreenCapture'));
  }

  // macOS: one place to see and fix every permission the app needs.
  async function showPermissions() {
    const mark = (ok) => (ok ? '✅' : '❌');
    const mic = systemPreferences.getMediaAccessStatus('microphone');
    const scr = o.screenAccess();
    const acc = systemPreferences.isTrustedAccessibilityClient(false);
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Claude Eyes permissions',
      message: 'Claude Eyes needs three permissions',
      detail:
        `${mark(mic === 'granted')}  Microphone: hears when you start speaking\n` +
        `${mark(scr === 'granted')}  Screen Recording: lets it see every app, folder and screen\n` +
        `${mark(acc)}  Accessibility: lets it paste the picture into Claude\n\n` +
        'After turning on Screen Recording, quit and reopen Claude Eyes once.',
      buttons: ['Screen Recording…', 'Microphone…', 'Accessibility…', 'Close'],
      defaultId: scr === 'granted' ? 3 : 0,
      cancelId: 3,
    });
    if (response === 0) { o.capture({ all: false }).catch(() => {}); shell.openExternal(PANE('ScreenCapture')); }
    else if (response === 1) { await systemPreferences.askForMediaAccess('microphone').catch(() => {}); shell.openExternal(PANE('Microphone')); }
    else if (response === 2) { systemPreferences.isTrustedAccessibilityClient(true); shell.openExternal(PANE('Accessibility')); }
  }

  // ---------- boot ----------
  app.whenReady().then(async () => {
    // link to the Chrome extension (127.0.0.1 only)
    if (o.bridge !== false) {
      const onChange = (up) => { chromeUp = up; o.onEvent({ type: 'chrome', connected: up }); refreshTray(); };
      if (o.bridge) { bridge = o.bridge; bridge.onChange = onChange; chromeUp = bridge.connected; }
      else {
        bridge = new Bridge({ onChange });
        bridge.start().catch((e) => o.onEvent({ type: 'bridge-error', error: String(e.message || e) }));
      }
    }
    if (fs.existsSync(extensionFolder())) syncExtension(); // keep an installed extension folder up to date
    tray = new Tray(isWorking() ? icons.on : icons.off);
    if (process.platform !== 'darwin') tray.on('click', () => tray.popUpContextMenu());
    refreshTray();
    applyLoginItem();

    if (settings.get('enabled')) await startListening(); else await createListener();
    if (process.platform === 'darwin' && o.showFirstRun !== false && (settings.isNew || o.screenAccess() !== 'granted')) {
      // First launch (or still missing screen access): walk through the permissions BEFORE the first call.
      if (settings.isNew) settings.set('launchAtLogin', settings.get('launchAtLogin')); // creates settings.json so this shows once
      showPermissions().catch(() => {});
    }

    watchdog = setInterval(() => {
      // Audio stopped flowing (device glitch, sleep/wake)? Restart the listener.
      if (settings.get('enabled') && micState === 'listening' && Date.now() - lastLevelTs > STALL_MS) {
        o.onEvent({ type: 'watchdog-restart' });
        listener.webContents.send('command', 'stop');
        setTimeout(startListening, 300);
      }
    }, 2000);
    powerMonitor.on('resume', () => { if (settings.get('enabled')) setTimeout(startListening, 1500); });
    o.onEvent({ type: 'ready' });
  });

  app.on('window-all-closed', (e) => e.preventDefault()); // tray app: never quit when windows close
  app.on('before-quit', () => { clearInterval(watchdog); clearTimeout(retryTimer); if (bridge && !o.bridge) bridge.close(); });

  return { settings, vad, setEnabled, sendScreenshot, showPermissions, deliver, getState: () => ({ micState, micMessage, working: isWorking(), lastSent }) };
}

module.exports = { start };
