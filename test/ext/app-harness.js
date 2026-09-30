'use strict';
// The real app (real microphone pipeline with a fake mic, real screen capture, real Chrome link),
// started the way the shipped app starts, for the full-chain test.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.MIC_WAV);
const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-full-')), 's.json');
require('../../src/app').start({ settingsFile, notify: false, manageLoginItem: false, allowMultiple: true,
  onEvent: (e) => { if (e.type !== 'level') console.log('APP', JSON.stringify(e).slice(0, 300)); } });
