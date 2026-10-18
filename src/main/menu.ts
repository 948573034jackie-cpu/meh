import { Menu, BrowserWindow, app, shell } from 'electron';

export function buildMenu(getWindow: () => BrowserWindow | null): Menu {
  const send = (action: string) => () => getWindow()?.webContents.send('menu:action', action);
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ label: app.name, submenu: [
      { role: 'about' as const }, { type: 'separator' as const },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
      { type: 'separator' as const }, { role: 'services' as const }, { type: 'separator' as const },
      { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const },
    ] }] : []),
    { label: 'File', submenu: [
      { label: 'Open Book…', accelerator: 'CmdOrCtrl+O', click: send('open') },
      { label: 'Paste Text…', accelerator: 'CmdOrCtrl+Shift+V', click: send('paste') },
      { label: 'Library', accelerator: 'CmdOrCtrl+L', click: send('library') },
      { type: 'separator' },
      ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') }, { role: 'quit' as const }]),
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Bigger Text', accelerator: 'CmdOrCtrl+=', click: send('fontUp') },
      { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: send('fontDown') },
      { label: 'Cycle Theme', accelerator: 'CmdOrCtrl+T', click: send('theme') },
      { label: 'Toggle Subtitle Band', accelerator: 'CmdOrCtrl+B', click: send('band') },
      { type: 'separator' },
      { label: 'Diagnostics', click: send('diagnostics') },
      { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }])] },
    { label: 'Help', submenu: [{ label: 'ReadAlong Help', click: () => shell.openExternal('https://github.com/948573034jackie-cpu/meh#readme') }] },
  ];
  return Menu.buildFromTemplate(template);
}
