'use strict';
// One-time: makes the Chrome extension's fixed identity so the app can accept ONLY this extension.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const id = [...crypto.createHash('sha256').update(der).digest().subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
fs.writeFileSync(path.join(__dirname, '..', 'src', 'ext-id.js'),
  `'use strict';\n// Chrome extension ID derived from extension/manifest.json "key". The app only talks to this extension.\nmodule.exports = { EXT_ID: '${id}', EXT_KEY: '${der.toString('base64')}' };\n`);
console.log('extension id', id);
