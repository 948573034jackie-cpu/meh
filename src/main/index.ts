import { app, BrowserWindow, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import { registerAppScheme, installAppProtocol, APP_SCHEME } from './protocol';
import { registerIpc } from './ipc';
import { registerSttIpc } from './stt/ipc';
import { checkSecrets } from './secrets';
import { rendererDir, preloadPath, migrateLegacyUserData } from './paths';
import { buildMenu } from './menu';
import { flushStoresSync } from './storage';

// Tests and CI point userData at a scratch directory.
if (process.env.READALONG_USER_DATA) app.setPath('userData', process.env.READALONG_USER_DATA);
app.setName('Dream Read');
// First start after the rename from ReadAlong: bring the old data folder along (settings, books, vocabulary, keys).
if (!process.env.READALONG_USER_DATA) migrateLegacyUserData();

registerAppScheme();

let win: BrowserWindow | null = null;

function createWindow(): void {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: 'Dream Read',
    backgroundColor: '#15171c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void win.loadURL(`${APP_SCHEME}://-/index.html${process.env.READALONG_E2E ? '?e2e=1' : ''}`);
}

app.whenReady().then(() => {
  installAppProtocol(path.resolve(rendererDir()));
  registerIpc(() => win);
  registerSttIpc();
  // Decrypt every saved API key once so a key that was lost (old Keychain record after a re-sign) is reported in Settings.
  try { checkSecrets(); } catch (e) { console.error('secrets: startup check failed', e); }
  Menu.setApplicationMenu(buildMenu(() => win));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Settings, library, vocabulary and usage are written in the background (storage.ts JsonStore): whatever is not on disk
// yet is written synchronously when the app quits. Again at will-quit and exit, for changes the closing windows sent
// after before-quit (the last reading position).
app.on('before-quit', flushStoresSync);
app.on('will-quit', flushStoresSync);
process.on('exit', flushStoresSync);
