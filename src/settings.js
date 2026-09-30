'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  enabled: true, // the on/off switch
  target: 'chrome', // where the picture goes: chrome | claude | chatgpt | clipboard
  sensitivity: 'normal', // low | normal | high
  allScreens: true, // capture every monitor, not just the one under the mouse
  intervalSec: 60, // wait between screenshots
  voiceOnly: false, // only react to my voice (needs "Learn my voice" first)
  voiceStrictness: 'normal', // relaxed | normal | strict
  launchAtLogin: true,
};

class Settings {
  constructor(file) {
    this.file = file;
    this.isNew = !fs.existsSync(file); // first ever launch
    this.data = { ...DEFAULTS };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const k of Object.keys(DEFAULTS)) {
        if (typeof saved[k] === typeof DEFAULTS[k]) this.data[k] = saved[k];
      }
    } catch (_) {
      /* first run or unreadable file: use defaults */
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`unknown setting: ${key}`);
    this.data[key] = value;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (_) {
      /* a read-only disk must not crash the app */
    }
  }
}

module.exports = { Settings, DEFAULTS };
