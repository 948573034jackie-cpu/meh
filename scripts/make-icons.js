'use strict';
const fs = require('fs');
const path = require('path');
const { renderIcon } = require('../src/icons');
fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), renderIcon('on', 1024));
console.log('wrote build/icon.png');
