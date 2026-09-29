'use strict';
const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, session, systemPreferences,
  powerMonitor, Notification, shell, clipboard, ipcMain,
} = require('electron');
const { Vad, SENSITIVITY } = require('./vad');
const { Settings } = require('./settings');
const { renderIcon } = require('./icons');
const { captureScreen } = require('./screenshot');
const { pasteIntoApp } = require('./deliver');

const RETRY_MS = 5000;
const STALL_MS = 4000;

// `overrides` lets the automated tests swap pieces (capture, paste, settings file...).
function start(overrides = {}) {
  const o = {
    capture: captureScreen,
    paste: pasteIntoApp,
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

  const icons = {
    on: nativeImage.createFromBuffer(renderIcon('on', 44), { scaleFactor: 2 }),
    off: nativeImage.createFromBuffer(renderIcon('off', 44), { scaleFactor: 2 }),
  };

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
    tray.setImage(isWorking() ? icons.on : icons.off);
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
        label: `Paste into ${settings.get('targetApp')} app automatically`,
        type: 'checkbox', checked: settings.get('paste'),
        click: (mi) => { settings.set('paste', mi.checked); refreshTray(); },
      },
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
      { type: 'separator' },
      { label: 'Send a test screenshot now', click: () => sendScreenshot('test') },
      {
        label: 'Start when I log in',
        type: 'checkbox', checked: settings.get('launchAtLogin'),
        click: (mi) => { settings.set('launchAtLogin', mi.checked); applyLoginItem(); refreshTray(); },
      },
      { type: 'separator' },
      { label: lastSent ? `Last screenshot: ${lastSent}` : 'No screenshot sent yet', enabled: false },
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
      const image = await o.capture(); // grab the screen FIRST, before anything else moves
      const tCaptured = Date.now();
      const before = { text: clipboard.readText(), image: clipboard.readImage() };
      clipboard.writeImage(image);
      let pasted = null;
      if (settings.get('paste')) {
        pasted = await o.paste({ appName: settings.get('targetApp') });
        if (!pasted.ok) handlePasteProblem(pasted);
        // put back whatever was on the clipboard before (best effort, text/image only)
        setTimeout(() => {
          if (!before.image.isEmpty()) clipboard.writeImage(before.image);
          else if (before.text) clipboard.writeText(before.text);
        }, 300);
      }
      lastSent = new Date().toLocaleTimeString();
      o.onEvent({ type: 'sent', reason, captureMs: tCaptured - t0, totalMs: Date.now() - t0, pasted, size: image.getSize() });
    } catch (e) {
      handleCaptureProblem(e);
      o.onEvent({ type: 'error', reason, error: String(e.message || e) });
    } finally {
      busy = false;
      refreshTray();
    }
  }

  let lastComplaint = 0;
  function complain(title, body) {
    if (Date.now() - lastComplaint < 60000) return; // don't nag on every sentence
    lastComplaint = Date.now();
    notify(title, body);
  }

  function handlePasteProblem(r) {
    const app_ = settings.get('targetApp');
    if (r.reason === 'not-running') complain('Claude Eyes', `The ${app_} app isn't open, so the screenshot is only on your clipboard.`);
    else if (r.reason === 'no-accessibility') {
      complain('Claude Eyes needs permission', 'Allow Claude Eyes under System Settings > Privacy & Security > Accessibility so it can paste.');
      if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    } else complain('Claude Eyes', `Couldn't paste into ${app_} (${r.reason}). The screenshot is on your clipboard.`);
  }

  function handleCaptureProblem(e) {
    complain('Claude Eyes can\'t see the screen', 'Allow Claude Eyes under System Settings > Privacy & Security > Screen Recording, then restart it.');
    if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }

  // ---------- boot ----------
  app.whenReady().then(async () => {
    tray = new Tray(isWorking() ? icons.on : icons.off);
    if (process.platform !== 'darwin') tray.on('click', () => tray.popUpContextMenu());
    refreshTray();
    applyLoginItem();

    // Ask for screen access right away (macOS prompts on first capture) rather than mid-call.
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      o.capture().catch(() => {});
    }
    if (settings.get('enabled')) await startListening(); else await createListener();

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
  app.on('before-quit', () => { clearInterval(watchdog); clearTimeout(retryTimer); });

  return { settings, vad, setEnabled, sendScreenshot, getState: () => ({ micState, micMessage, working: isWorking(), lastSent }) };
}

module.exports = { start };
