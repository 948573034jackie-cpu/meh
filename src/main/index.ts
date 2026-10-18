import { app, BrowserWindow, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import { registerAppScheme, installAppProtocol, APP_SCHEME } from './protocol';
import { registerIpc } from './ipc';
import { rendererDir, preloadPath } from './paths';
import { buildMenu } from './menu';

// Tests and CI point userData at a scratch directory.
if (process.env.READALONG_USER_DATA) app.setPath('userData', process.env.READALONG_USER_DATA);
app.setName('ReadAlong');

registerAppScheme();

let win: BrowserWindow | null = null;

function createWindow(): void {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: 'ReadAlong',
    backgroundColor: '#121212',
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
  void win.loadURL(`${APP_SCHEME}://-/index.html`);
}

app.whenReady().then(() => {
  installAppProtocol(path.resolve(rendererDir()));
  registerIpc(() => win);
  Menu.setApplicationMenu(buildMenu(() => win));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
