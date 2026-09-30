'use strict';
const fs = require('fs');
const { chromium } = require('playwright-core');
let bin = process.env.CHROME_BIN;
if (!bin && fs.existsSync('/opt/pw-browsers')) {
  const d = fs.readdirSync('/opt/pw-browsers').filter((x) => /^chromium-\d+$/.test(x))[0];
  if (d) bin = `/opt/pw-browsers/${d}/chrome-linux/chrome`;
}
module.exports = bin || chromium.executablePath();
