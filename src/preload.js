'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('eyes', {
  onCommand: (cb) => ipcRenderer.on('command', (_e, cmd) => cb(cmd)),
  level: (db) => ipcRenderer.send('level', db),
  status: (state, message) => ipcRenderer.send('mic-status', { state, message }),
});
